# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: sports-day organizer — typically a teacher, club volunteer, or event lead running a school tournament, club event, or sports day in a sports hall. Non-technical, clipboard in hand, managing rapid match turnover across two parallel playing fields from a Windows host laptop.

Secondary:
- Field operators: one volunteer per field on a phone/tablet (`/field/1`, `/field/2`), scoring one field only while holding the device in one hand.
- Spectators: hall audience on TV/projector/second monitor (`/display`, `/display/1`, `/display/2`, `/bracket`, `/results`), read-only.

## Product Purpose

Local tournament control where one host PC runs everything and every other device just opens a browser on the venue WLAN. Run two fields at once with independent participants, score, clock, state, operator, and history, drive a single/double-elimination bracket to completion, and keep every screen in sync in well under a second. Success is a full sports-day event completed without internet, accounts, installs on client devices, polling, or reloads.

## Positioning

100% offline-first LAN operation with no cloud, no accounts, and no app installs on client devices, combined with two parallel live fields and QR joining. A score change appears on every connected screen via WebSocket deltas; control links carry a fragment token plus optional PIN, and spectator routes are read-only server-side and cannot send a command.

## Operating Context

Sports hall / venue WLAN with no internet required; host is Windows 10/11 PC (dev also on macOS/Linux); clients are phones, tablets, laptops, TVs/projectors on the same Wi-Fi. Hall realities: bad lighting, 2m–10m viewing distance, unstable WLAN with reconnect/backoff, Windows Firewall private-network prompt, multiple NICs/VPNs requiring manual address selection in Settings → Network. Rituals: create tournament → generate bracket → assign queue to fields → score/start/pause/undo/redo/reset/end → auto-assign next → correct score / manual override when needed → CSV/JSON/PDF export and backup/restore.

## Capabilities and Constraints

Confirmed functionality (must keep working, visuals-only change):
- Two playing fields with independent state plus one-click swap and auto-assign next two.
- Bracket engine: single or double elimination, byes, seeded/random draw, third-place match, automatic winner advancement, manual override, correct-score repair.
- Live sync: WebSocket deltas, presence/conflict handling, full resync on reconnect.
- Roles: admin (full), operator (one field, optional PIN, field claim/takeover), spectator (read-only, server-enforced).
- Joining: QR codes for `/`, `/display`, `/display/1`, `/display/2`, `/bracket`, `/results`, `/field/1`, `/field/2`, `/host`; control tokens in URL fragment, stored on device, rotatable in Settings → Security; field operator tokens are renewed on every tournament creation and field QR codes are shown only on their own dashboard field tab; tokens in `data/access.json` outside tournament data.
- Storage: SQLite when available plus crash-safe JSON log/database fallback; immediate persist, autosave, timestamped backups, JSON backup/restore with safety copy.
- Exports: CSV (results, history, participants, event log), JSON, printable PDF via `/print/results`, `/print/bracket`, `/print/history` using browser print.
- Display modes: combined board, per-field boards, pannable/zoomable bracket, printable pack; invert/high-contrast light board, fullscreen, wake-lock, local clock tick from server anchor.
- Host dashboard: both fields side-by-side, queue, completed, activity, bracket preview, machine health statusbar, QR gallery, dialogs (assign, end, correct, override, unassign).
- Operator: big touch targets, big clock, +1/+2/+3, undo/redo, end match; keyboard `Space/1/2/U/R/E/?/Esc`.
- Setup: name, format, draw, `name,team` entry/paste/CSV import with duplicate flags, field names, duration, increments, auto-load next, deterministic bracket, Demo 8-team tournament.
- Saved setups (New tournament → Load): whole tournament setups filed under a unique shelf label on the host — name, format, fields, rosters, draw, duration, scoring buttons and Radball rules — then loaded back into the wizard for review and a fresh run; rename, update in place under the same label, remove; survives tournament create/replace/reset, restart and restore; kept on the host like the team library.
- Built-in examples (New tournament → Load → Try it out): ready-made setups that ship with the app so a fresh install has something to load — the Radball World Cup with 10 teams on two fields (Group A on Field 1, Group B on Field 2, 20 group fixtures then a final phase deciding places 1–10, 27 matches). Not on the shelf, so not renameable or removable; loading one fills the wizard like any saved setup.
- Team library (`/teams`): reusable 2er squads filed into the Radball age groups (U11..Elite); add one at a time or paste/import `team, club, player 1, player 2, age group`; re-file a squad between age groups from its row; kept on the host so it survives tournament create/replace/reset, restart and restore; the Radball setup step can copy picked squads onto a field roster.
- Settings: theme (dark/light/system), primary/accent custom colors (`--brand`/`--accent`), language (English/German), network address pick, security, backup, developer diagnostics (WebSocket, reconnects, clients, RTT, log ring).
- Language: English and German, chosen in Settings `→` Language. The host setting travels in the ordinary settings delta, so one switch repaints every connected screen at once; each device may also override it locally without writing to the host. Brand terms (Radball, `RV <Ort>`, `U11`..`ELITE`, BDR, `4m`) stay untranslated, and a key German is missing falls back to the English sentence rather than to a raw key. Tests in `tests/i18n.test.ts` guard completeness, placeholder agreement and umlaut integrity.
- Desktop: Electron shell, Start-menu/desktop shortcut, multi-monitor placement, Windows installer; PWA manifest + icons in `public/`.

Technical constraints: React + TypeScript, no UI framework, all frontend assets bundled/served locally, nothing requested from internet; strict TS (`npm run typecheck`), lint (`npm run lint`), an automated test suite (`npm test`, all of it also run by `npm run check` and by CI); routes/terminology preserved exactly (`/`, `/host`, `/field/1`, `/field/2`, `/display`, `/display/1`, `/display/2`, `/bracket`, `/radball`, `/results`, `/setup`, `/teams`, `/settings`, `/print/*`); dark default preserved with light/invert option; print CSS preserved; Settings custom brand/accent colors preserved; 44px minimum touch targets preserved.

Explicitly undecided: none blocking a visuals-only redesign.

## Brand Commitments

Name: Tournament Scoreboard (`local.tournament.scoreboard`). Voice: plain, functional, volunteer-direct. Assets: `public/favicon.svg`, `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`, `public/manifest.webmanifest`; Electron `build/icon.ico`. No binding visual style volunteered; no testimonials, pricing, or external claims to preserve.

## Evidence on Hand

Real sources: `README.md` (full operator manual), `docs/ARCHITECTURE.md` (data flow, event/delta protocol, extension points), `src/frontend/` pages/components/styles as incumbent behavior, demo tournament via `system.demo` (8 teams, two live matches), `tests/` engine/bracket/concurrency/persistence/protocol/access coverage. Absences future work must not fabricate: no customer testimonials, case studies, press, benchmarks, or commercial claims.

## Product Principles

1. Glanceable under pressure: hall distance, bad light, and a clipboard decide hierarchy, not decoration.
2. Offline truth: host holds state; every change persists immediately and resyncs after any cut.
3. Two fields at once: parallel play is the normal case, not an edge.
4. Volunteer-proof: demo, auto-assign, undo/redo, explicit winner resolution, and printable QR keep non-technical crews moving.
5. Trustworthy control: server validates every command; read-only is enforced server-side, not in the UI.

## Accessibility & Inclusion

Far-distance legibility (2m control, 10m projector), high-contrast dark default plus light/invert board, minimum 44px touch targets (60px large), keyboard-operable operator screen, `prefers-reduced-motion` support, visible focus, wake-lock for live boards. No formal WCAG conformance claim established; do not regress these behaviors.
