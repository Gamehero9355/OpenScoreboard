# AGENTS.md

Tournament Scoreboard — offline-first, single-host Windows app. One Node process on the host
PC owns everything (HTTP + WebSocket on `:3000`); phones/tablets/TVs are read-mostly browser
clients on the venue WLAN. No internet, no cloud, no accounts.

## House docs (read before designing or changing behaviour)

| File | What it answers |
| --- | --- |
| `README.md` | The operator manual + project layout. §12 has the dev commands and release steps. |
| `docs/ARCHITECTURE.md` | Data flow, layers, event/delta protocol, and the **checklists in §13 for adding a command or a state slice**. |
| `docs/LINTING.md` | Why there is no formatter, and which oxlint rules are deliberately off. |
| `CHANGELOG.md` | `## [Unreleased]` documents what is in flight; release notes are cut from here. |
| `PRODUCT.md`, `DESIGN.md` | Product/design brief. The vendored `impeccable` skill (`.opencode/skills/impeccable/`) loads them — do not contradict them in UI work. |

## Commands

```bash
npm run check            # typecheck + lint + tests — exactly what CI runs; run this before saying "done"
npm test -- tests/bracket.test.ts   # single test file (same as npx vitest run <file>)
npm run typecheck        # tsc over tsconfig.json AND tsconfig.server.json
npm run lint             # oxlint (read-only); npm run lint:fix to autofix
npm run dev              # tsx watch backend on :3000 + Vite on :5273 (proxies /api, /logos, /ws to the backend)
npm run build            # vite build -> dist/client, then tsc -p tsconfig.server.json -> dist/server
npm start                # node dist/server/backend/index.js (built code, not src)
node dist/server/backend/index.js --demo --open      # seeded 8-team tournament
node dist/server/backend/index.js --demo-kind radball10 --open
node dist/server/backend/index.js --port 3200 --data-dir D:\Events\Scoreboard
npm run icons            # regenerate public/icon-*.png and build/icon.ico
npm run dist:win         # Windows installer into release/
```

Verification order that matters: `typecheck -> lint -> test` (that is what `npm run check` and both
workflows run). CI also builds and greps the built bundle for remote references.

## Things that break silently

- **Never add a formatter (Prettier or similar).** `tests/hooks.test.ts` and `tests/routing.test.ts`
  scan *source text* and would start passing vacuously. `.editorconfig` (2 spaces, LF, final
  newline) is the entire formatting policy — see `docs/LINTING.md`.
- **The app runs out of `dist/`.** A source-only fix is invisible until `npm run build`;
  `node scripts/needs-build.mjs` exits non-zero when the bundle is stale (that is what
  `Start-Scoreboard.bat` uses). `npm run dev` is the only path that serves from source.
- **Server code must stay CommonJS.** `electron/main.js` `require()`s
  `dist/server/backend/index.js`; `tsconfig.server.json` emits CJS for that reason. Top-level
  `await`, ESM-only imports or `.ts`-extension imports break the desktop app even when `npm run dev`
  is fine.
- **No DOM in tests.** `vitest.config.ts` runs in the `node` environment — no jsdom, no Testing
  Library, no component rendering. Only pure helpers under `lib/` are executed; do not write a test
  that needs a document.
- **No remote references in the client bundle** (CI greps for them). No webfonts, no CDN, no
  runtime deps beyond `express`, `ws`, `qrcode` on the server. System font stacks only.
- **Two tsconfigs, different strictness.** `tsconfig.server.json` sets `noUncheckedIndexedAccess`;
  `tsconfig.json` (frontend/shared/tests) does not — so `state.matches[id]` style indexing is only
  checked on the server side. (`docs/LINTING.md` claims neither has it; that note is stale.)
- **Runtime state and credentials are gitignored, not committed.** `data/` (sqlite, snapshots,
  backups), `access.json` (+ `.bak`, `access.unreadable-*.json`, the operator/admin tokens and PIN
  hash), `*.sqlite*`, `dist/`, `release/`. Tests must use temp dirs (`tests/helpers.ts` does).
- `Start-Scoreboard.bat` must stay CRLF (`.gitattributes` marks `*.bat -text`) and avoid literal
  parentheses inside its blocks — cmd.exe treats them as end-of-block.
- Node **>= 22.12** is required; npm bundled with 22.5–22.11 fails `npm install` and still exits 0.
  CI uses Node 24 on `windows-latest` (Node 22.5 cannot install this project at all).

## Architecture in one minute

Single process: `src/backend/index.ts` → `startServer()` (AccessControl, TournamentStore, WsHub,
express, LAN discovery). Same function for `npm start` and the Electron shell.

| Layer | Where | Rule |
| --- | --- | --- |
| Domain / protocol | `src/shared/` | `types.ts`, `commands.ts`, `protocol.ts`; no runtime deps, imported by both sides. Store business tables that the UI and engine both read here (`radball10Structure.ts`). |
| Engines | `src/backend/tournament/` | Pure functions over `TournamentState` that record a `Mutation`. No I/O, sockets or HTTP. |
| Store | `src/backend/store/store.ts` | Owns the single state object, applies mutations atomically, rolls back on throw, builds deltas, schedules persistence. |
| Network | `src/backend/network/` | WS hub + command dispatcher — the only bridge from a browser to the engines. |
| Frontend | `src/frontend/` | React, no UI library; reads a `LiveClient` snapshot via `useSyncExternalStore`. Vite root is `src/frontend`, `public/` is copied verbatim to `dist/client`. |

Non-obvious wiring:

- **State only changes through `store.apply((state, ctx, mut) => {...}, store.createContext(...))`.**
  Never assign to `store.state` directly; the store needs the `Mutation` to build deltas, and the
  rollback path depends on that copy.
- **Wire protocol** (root `seed.mjs` speaks an obsolete shape — ignore it): client sends
  `{ t: 'cmd', requestId, action, payload }`; server replies `{ t: 'ack', requestId, ok, code? }`
  plus broadcast `{ t: 'delta' }`, and `hello` / `state` / `notify` / `pong` / `timer`.
  `requestId` makes double taps idempotent.
- **Clocks are anchors, not ticks.** The server stores `anchorAt`/`elapsedMs`/`running` and
  re-broadcasts it every 15 s; each browser interpolates locally. Do not add server-side timers.
- **Permissions are enforced server-side** in `src/shared/commands.ts` (validator + scope) and the
  field-scope check in dispatch. A spectator route must not be able to send a command, whatever
  the UI allows.
- **Persistence is one adapter** (`src/backend/database/`): `node:sqlite` when available, crash-safe
  JSON fallback otherwise. `SCHEMA_VERSION` stays 1 — new state fields are handled by
  `sanitiseState`, not by migrations.

Adding a command: engine function → `src/shared/commands.ts` → `src/backend/network/dispatch.ts` →
`live.command('action', payload)` in the UI → test at engine level, or `tests/server.test.ts` style
across the network. Adding a state slice: the five-file list in `docs/ARCHITECTURE.md` §13
(`types.ts`, `createMutation`, `createEmptyState`, `buildDelta`/`restore` + `sanitiseState`,
`applyDelta`).

## Domain conventions

- **Domain language is German.** Radball, `RV <Ort>`, age classes `U11`..`ELITE`, BDR presets,
  `4m` line. Keep those terms untranslated everywhere.
- **i18n: English is the source of truth.** `src/frontend/lib/i18n.ts` holds one flat record per
  language; `MessageKey` is derived from the English catalogue, so a German-only key is a compile
  error. Missing German falls back to the English sentence, never to the raw key. `src/shared`
  must not import the frontend catalogue.
- **`src/shared/radball10Structure.ts` is the single copy** of the 10-team World Cup shape — engine,
  bracket drawer and docs page all import it. Edit it, never fork it.
- **A match's home field is derived, never stored** (`homeFieldOf` in `src/shared/matchUtils.ts`):
  by roster registration first, then by section of the draw.
- Manual-schedule format stores its fixtures instead of deriving them; nothing advances, nothing
  auto-completes, and `generateBracketForTournament` refuses it (docs/ARCHITECTURE.md §12).

## Release

`git tag v<version> && git push origin v<version>` runs `release.yml`, which re-runs the checks,
refuses a tag that does not equal `package.json` `version`, refuses when `CHANGELOG.md` has no
section for that version (`scripts/changelog-section.mjs`), then publishes the installer. `ci.yml`
watches branches only. `v1.0.0-rc.1`-style suffixes are published as pre-releases.

## Note

There is no `AGENTS.md`, `CLAUDE.md`, `.cursorrules` or repo-local `opencode.json` in this tree;
`.opencode/`, `.impeccable/`, `.freebuff/`, `.review-data/` are vendored tooling and gitignored.
Root `seed.mjs` and `shot.cjs` are stale throwaway harnesses — for a protocol-level check use
`node scripts/smoke-radball10.mjs <ws-url> <admin-token>` or `node scripts/queue-check.mjs <http-url>`
against a running server.
