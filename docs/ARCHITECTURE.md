# Architecture

One process on the host PC owns the tournament; every other device is a thin client that
renders what the host says and sends commands the host validates.

```
 Electron shell / npm start
        │
        ▼
 startServer()  ─────────────────────────────────────────────────────────────┐
   ├── AccessControl          data/access.json  (tokens, PIN hash)           │
   ├── TournamentStore        data/tournament.sqlite | state.json + events   │
   │     └── engine · bracket · scoring · matchops   (pure functions)        │
   ├── WsHub                  /ws  → deltas, acks, presence, timer anchors   │
   ├── HTTP (express)         /api/* + static client + SPA fallback          │
   └── LAN discovery          IPv4 detection, QR rendering, mDNS (optional)  │
                                                                             │
        Browser clients: host dashboard · operator · display · bracket       │
```

## 1. Layers

| Layer | Files | Rules |
| --- | --- | --- |
| Domain | `src/shared/types.ts` | Plain interfaces shared by server and client. No runtime imports. |
| Validation | `src/shared/protocol.ts`, `src/shared/commands.ts` | Every inbound field is parsed and range-checked; each command declares its permission. |
| Engines | `src/backend/tournament/*` | Pure functions over `TournamentState` plus a `Mutation` describing what changed. No I/O, no sockets, no HTTP. |
| Store | `src/backend/store/store.ts` | Owns the single state object, applies mutations atomically, creates deltas, schedules persistence. |
| Persistence | `src/backend/database/*` | One adapter interface; SQLite driver with a crash-safe JSON fallback. |
| Network | `src/backend/network/*` | WebSocket hub and the command dispatcher — the only bridge between a browser and the engines. |
| HTTP | `src/backend/http/server.ts` | REST for exports, backup/restore, QR, diagnostics and the static client. |
| UI | `src/frontend/*` | React components reading an external-store snapshot; never mutates domain objects. |
| Desktop | `electron/main.js` | Starts the same server, opens windows, places them on monitors. |

The engines are UI-free and testable in isolation, which is why the bracket and scoring rules
have direct unit tests.

## 2. State, mutations, deltas

```ts
// A handler never assigns to the state directly.
store.apply((state, ctx, mut) => {
  updateScore(state, match, 'A', 2, ctx, mut);   // marks mut.matches, pushes events
}, store.createContext(actor, role, fieldId));
```

1. `store.apply` runs the operation on the live state inside a serialised task queue.
2. The `Mutation` records which matches, participants, fields, settings and ordering changed.
3. The store turns that into a `Delta` (`{ seq, updatedAt, matches: [...], fields: [...] }`)
   and hands it to the hub.
4. The hub broadcasts the delta to every greeted client — one small JSON message, no full
   state, no polling.
5. Persistence runs on an urgency ladder: `immediate` for results and settings, a short
   debounce for score changes, and a periodic snapshot as a backstop. The UI shows
   *All changes saved* from the store's own status.

Timers are **not** ticked server-side. The server stores an anchor (`anchorAt`, `elapsedMs`,
`running`) and re-broadcasts it every 15 s; each browser interpolates locally at 5 Hz. A
hundred spectator screens therefore cost the same as one.

## 3. Command flow (why nothing can be spoofed)

```
browser ── { t:'cmd', requestId, action, payload } ──▶ WsHub
  1. rate limit (token bucket) and de-duplicate by requestId
  2. COMMANDS[action].validate(payload)        → shape + ranges
  3. permission check against the session scope (admin / operator:field / spectator)
  4. field-scope check: an operator may only touch its own field's matches
  5. engine call → EngineError(code, message) becomes a readable ack
  ◀── { t:'ack', requestId, ok, code?, error? } + broadcast deltas
```

`requestId` de-duplication makes double taps on a slow phone idempotent: the second tap
returns the cached answer instead of scoring twice.

## 4. Roles and tokens

| Scope | Source | Notes |
| --- | --- | --- |
| `admin` | Loopback request, or the host token | Loopback is trusted so the host PC never has to type a secret. |
| `operator:<field>` | Field control token | Plus an optional PIN, checked during `hello` before any command is accepted. |
| `spectator` | No token, or `?readonly=1` | Display pages send the read-only hint themselves; commands are refused by the server. |

Join links are built per scope: `publicLinks()` never contains a token, `adminLinks()` does,
and only an authenticated admin response includes the latter. Tokens live in
`data/access.json`, deliberately outside the tournament data so a shared tournament backup can
never leak credentials. That file holds the only copy of the operator tokens, so it is written
atomically (temp file, `fsync`, rename) through a serialised write queue, and a shadow copy
`access.json.bak` is kept; a file that cannot be parsed is moved aside as
`access.unreadable-<timestamp>.json` rather than being treated as "no credentials configured",
which would silently rotate every control link mid-event. Rotation re-issues a token and resyncs
every client immediately.

The operator PIN is a genuine second factor, so it is hashed with **scrypt** and a per-install
random salt. Hashes written by earlier versions (a single unsalted SHA-256 round with a
hard-coded prefix, which made the whole four-digit space enumerable offline) are still accepted
and are upgraded in place on first success. Because the PIN is verified during `hello` — the one
message type that arrives before the command rate limiter exists — wrong attempts are counted per
remote address and trigger an escalating lockout. Counting per address rather than per socket is
deliberate: reconnecting must not hand out a fresh allowance.

### Loopback trust and cross-site requests

Loopback is granted `admin` without a token so the host PC never has to type a secret. That makes
any page open in a browser on the host PC the interesting attacker, and an HTML form is the
interesting vector because a form post is a "simple" request needing no preflight. Three
independent checks therefore apply to every mutating `/api` route:

1. `Sec-Fetch-Site` must be `same-origin` or `none` when present.
2. A present `Origin` (or, failing that, `Referer`) must match the `Host` the request actually
   reached. Comparing against the real `Host` covers the loopback URL, the LAN IP and the mDNS
   hostname without maintaining an allowlist of all three.
3. The `Content-Type` must be `application/json`, which a form cannot set without a preflight.

Requests carrying neither `Origin` nor `Referer` are allowed through: they cannot have come from a
browser page, so scripted administration keeps working. Responses also carry a
Content-Security-Policy without `unsafe-inline` for scripts (the theme bootstrap lives in
`public/theme-boot.js`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`.

### Rate limiting, and why HTTP needs its own

The WebSocket command path runs a token bucket (`RATE_CAPACITY`/`RATE_REFILL_PER_SEC` in
`hub.ts`), but that only ever covered `cmd` frames — `hello`, `ping` and `resync` were unmetered,
and no HTTP route was limited at all. Every endpoint is reachable from any device on the venue
WLAN, and Express and `ws` share **one** event loop with the heartbeat, the 15-second timer
anchors and the synchronous `JSON.stringify` of every snapshot save. Measured on the host
machine: `/api/network` costs 2.9 ms a call and `/api/qr` up to 10 ms, so a single laptop
looping on one cheap GET saturates the only core and stops scoring for the entire hall.

`src/backend/http/ratelimit.ts` therefore puts a token bucket in front of everything, keyed by
remote address (normalised the same way as the PIN lockout, so reconnecting from a
re-spelled address buys no fresh allowance). Two things make it cheap rather than punitive:

* It is mounted **before** `express.json`, so an oversized or flooded body is refused on its
  headers instead of being read into memory and parsed.
* A global bucket is spent first, then a per-class one, because a client must not be able to
  dodge the overall ceiling by spreading requests over endpoints. `X-RateLimit-Remaining` is
  sent on every response and `Retry-After` on a 429.

The limits are sized for the real audience, not the internet: a host browser polling
`/api/system`, a handful of phones, and a projector. Nothing legitimate comes near them.

### Failing loudly instead of staying up

Registering an `uncaughtException` handler overrides Node's default of printing and exiting, so
the original capture handler — which only logged — quietly turned a fatal fault into a server
that kept running in an unknown state, still broadcasting from `store.state`. It now flushes the
store and exits. On an event that is the honest outcome: the host sees a closed window and
restarts onto the last valid snapshot, losing at most the seconds since the last write, instead
of a wedged process losing the rest of the event. `unhandledRejection` stays non-fatal, because
several call sites handle their own rejections and one of those must not end a half-finished
tournament.

### Cost of a command

`store.apply()` deep-clones the state for its rollback, so the copy was growing for the whole
event as `events` filled toward `MAX_EVENTS`. The engine never mutates an event in place — the
only two writes are whole-array replacements — and events are appended only after the operation
returns, so the log is now held **by reference** in the pre-image. Everything else is still
deep-cloned, because rules do edit matches, participants, fields and settings in place.

## 5. Persistence and recovery

* **SQLite** via Node's built-in `node:sqlite` (no native build step, no prebuilt binary): a
  snapshot table, a shadow copy of the previous snapshot, and an append-only event table.
* **JSON fallback** when the runtime provides no SQLite (older Node, some Electron builds):
  `state.json` written through a unique temporary file and an atomic rename, serialised by a write
  queue so bursts of score changes cannot collide, plus `events.ndjson`.
* On boot the latest snapshot is validated and loaded. A snapshot whose blob cannot be parsed is
  never reported as "nothing stored" — that would let the next save overwrite the only copy of the
  event with an empty state — so the previous snapshot is tried instead, and only a genuine
  first run yields an empty tournament.
* The event table is keyed by `seq`. The counter is therefore never allowed to travel backwards:
  restoring a backup or clearing the tournament steps it above whatever is already on disk, so the
  audit log stays monotonic and older rows are never overwritten.
* Every command is atomic. `TournamentStore.apply()` snapshots the live state, runs the engine
  operation, and writes the copy back over the state if the operation throws — so a rule that
  refuses half way through leaves the host, every screen and the database in agreement. The
  rollback is written back in place rather than swapped in, so `store.state` stays the same object
  on both paths and cached references never go stale.
* `POST /api/restore` always writes a `pre-restore` backup first; automatic backups go through the
  same writer as manual ones and rotate to the newest 20 files, chosen by write time rather than by
  file name (the three filename prefixes sort into separate blocks, so name order would prune the
  automatic safety net before the manual snapshots it protects).

## 6. Language

English and German, chosen in **Settings → Language**. German is not a courtesy
translation: the domain is German, the age classes are `U11`..`ELITE`, the
presets are named after BDR championships, and the clubs are `RV <Ort> I/II`.

* **`src/frontend/lib/i18n.ts`** is the whole catalogue: one flat record per
  language, dotted-path keys, `{placeholder}` substitution. English is the source
  of truth and `MessageKey` is derived from it, so a key that exists only in
  German is a compile error rather than a blank on a projector. No runtime
  framework and nothing fetched — an i18n library that pulls a locale file over
  the network would break the offline-first promise outright.
* **`src/frontend/lib/useI18n.ts`** resolves the active language and hands out
  `t()`. Precedence is **this device's own choice → the host's setting →
  English**. The host setting travels in the ordinary settings delta, so one
  switch repaints every connected screen at once; the per-device override is
  stored in `localStorage` and never writes to the host, so one phone cannot
  change the language of the whole hall.
* **`Settings.language`** is one more field on the settings slice — no dedicated
  command, no new delta — and `validateSettingsPatch` rejects anything but `en` or
  `de` server-side. It is optional on the wire and in old backups, so a snapshot
  written before the setting existed loads unchanged and `sanitiseState` treats an
  unrecognised value as English.
* **Brand terms stay put.** `Radball`, `RV <Ort>`, `U11`..`ELITE`, `BDR`, `4m` and
  the ruleset ids are proper nouns; translating them would put the app at odds
  with the paperwork the organiser is holding.
* **Fallbacks are chosen for a hall, not for a test.** A key missing from German
  renders the English string rather than the raw key — a half-translated screen is
  understandable, a wall of `settings.backupHint` is not. A placeholder the caller
  forgot is left visible (`Platz {n}`) so the bug is in the string rather than
  hidden in it.
* **`shared/matchUtils.waitingReason`** takes an optional translator. `src/shared`
  cannot import the frontend catalogue (the server bundle pulls from there too),
  so it declares the loosest signature it needs and keeps an exhaustive English
  fallback — which is what every engine-level caller and test still gets.
* **`tests/i18n.test.ts`** guards the things a language drifts on: no key missing
  from German, identical placeholder sets on both sides, no `ae/oe/ue`
  transliteration, and a set of spot checks on the sentences a host reads
  mid-event. Those last ones exist because a plausible-looking translation can be
  *wrong* rather than merely unusual.

## 7. Frontend

* No UI framework or component library: one design-token stylesheet plus small primitives. The
  client ships about 140 kB gzipped end to end, of which roughly 80 kB is application code and
  the rest is React. Nothing is fetched from the internet — CI asserts that no remote reference
  ever appears in the built bundle.
* `LiveClient` (`src/frontend/lib/live.ts`) is an external store read through
  `useSyncExternalStore`: one WebSocket per device, deltas applied **copy-on-write** (every
  delta publishes a new state object, so `useMemo(..., [state])` selectors such as the bracket
  and the per-field queues can never render a finished match), exponential backoff reconnect,
  `revive()` on tab focus or network return, and a promise-based `command()` that resolves when
  the host acknowledges.
* Routing is a 30-line history router; every page is a component that reads the snapshot.
* Theme and branding come from settings and are applied as CSS custom properties, so a colour
  change on the host repaints every connected screen.
* The service worker only caches the shell; `/api/*` and `/ws` are never served from cache, so
  a score can never come from anything but the host.

## 8. Testing

| File | Covers |
| --- | --- |
| `tests/bracket.test.ts` | Seeding, byes, round names, slot wiring, third place, double elimination |
| `tests/engine.test.ts` | Create/import/remove participants, scoring, undo/redo, correction, finish, advancement, reset rules |
| `tests/concurrency.test.ts` | Both fields finishing, field-swap conflicts, simultaneous completions, duplicate results |
| `tests/fields.test.ts` | 1..8 fields, field naming/removal, home-field queues, pre-loading, mixed matches |
| `tests/persistence.test.ts` | Restart recovery, atomic snapshot writes, concurrent saves, corrupt file handling |
| `tests/server.test.ts` | HTTP + WebSocket end-to-end: deltas, reconnect, resync, idempotent request ids, operator scoping |
| `tests/access.test.ts` | Link exposure per role, operator PIN, token rotation, restore endpoint |
| `tests/regressions.test.ts` | One test per defect found reviewing the tree: the bracket double-render, a stale field token, a dangling field in a CSV export, the rollback clone, HTTP rate limiting |
| `tests/i18n.test.ts` | Catalogue completeness, placeholder agreement, umlaut integrity, the German wording of the sentences read mid-event |
| `tests/hooks.test.ts`, `tests/routing.test.ts` | Source-text scans: rules of hooks, and a `useMemo` dependency array |

```bash
npm test
```

### What is not covered

No component is ever rendered. `vitest.config.ts` runs in the `node` environment
and there is no DOM, no Testing Library and no browser runner, so the ~12,000
lines of `.tsx` have no *behavioural* coverage — only the pure helpers extracted
into `lib/` are executed. Two tests compensate by reading the source as text, and
both are correspondingly brittle: `hooks.test.ts` depends on two-space
indentation and `routing.test.ts` on an exact `useMemo` call shape. A reflow makes
them pass vacuously rather than fail, which `docs/LINTING.md` spells out.

The gap is real and it is why one defect in this table — the bracket drawing every
card twice — survived a green suite: the layout data was correct, only the JSX
was not. `tests/regressions.test.ts` now guards that one by counting placement
sites in the source, which is a workaround, not a fix. Adding jsdom plus a
component test for the host dashboard, the operator screen and the display board
is the single highest-value thing left to do to this suite.

## 9. Performance notes

* Deltas only; a score change is a few hundred bytes regardless of bracket size.
* Match lists are small and indexed by id; the bracket render is memoised per round.
* The frontend splits vendor and app code and lazy-loads nothing that is needed on first paint.
* The hub reaps dead sockets, caps clients (`MAX_CLIENTS = 200`), refuses payloads over 256 kB
  and rate-limits commands per connection — comfortable for 100+ spectators on a laptop's Wi-Fi.

## 10. Home fields and the queue model

A match's **home field** is derived, never stored (`homeFieldOf` in `src/shared/matchUtils.ts`),
and the app has two ways of working it out:

1. **By registration.** A participant may carry a `fieldId`: the field whose roster they were
   entered on. A match belongs to a field when every player who can still turn up in it
   registered there. The walk follows the bracket's slots, so a semifinal fed by two
   quarterfinals of one field already belongs to that field before anyone has played.
2. **By section of the draw.** A tournament with no field rosters at all (a quick draw, an
   import, or data created before rosters existed) has no registration to go by, so the opening
   round is cut into one contiguous block of matches per field — Field 1 the top block, Field 2
   the next — and a later match belongs to the block that feeds it.

Either way, a match can come back *either field*: a pairing that mixes two rosters, one fed by
two different sections (the final, the bronze match, most losers-bracket rounds), or a draw so
small that it has only one match.

Consequences the rest of the app relies on:

* `getNextAvailableMatch(state, fieldId)` prefers the field's own matches, then the shared ones,
  and never returns another field's. `autoAssign` walks all fields, so a free field with nothing
  of its own does not block a later field from taking its own match.
* The bracket is drawn with each roster inside its own block of the tree
  (`seedSlotsByField`), so the queues are populated the moment the tournament is created. With no
  home fields the draw is the classic seeded one, byte for byte.
* The host dashboard renders exactly one queue panel: the open field's own matches, then the
  shared ones under their own heading. Nothing from another field is ever listed there, and the
  assign button in a row only ever sends the match to the field whose queue you are reading.
* Either rule gives every tournament two usable queues, so a rosterless draw does not leave a
  field standing idle; the panel says which rule is in force.

## 11. The 10-team Radball format

The dedicated World Cup shape: **ten teams, two groups of five, then a fixed
cross-group final phase that assigns every place from 1 to 10.**

```
10 teams -> 2 x 5 round robin -> group rankings -> cross-group placements
         -> cross-group semifinals -> 3rd-place match -> final -> places 1-10
```

27 matches in total: 20 preliminary, 7 final-phase. (The final phase is seven,
not six — three placement matches, *two* semifinals, the third-place match and
the final. The two semifinals are what turn four group positions into a title,
and dropping one of them would leave four teams with nowhere to go.)

It lives in `src/backend/tournament/radball10.ts` and is reached through the
existing `radball` format with the preset `radball-10-team`. It does not replace
the free-form Radball competition, the BDR five-team preset or the two
knockout formats; all of them keep working unchanged.

The groups are the rosters: teams entered on Field 1 are Group A, teams entered on
Field 2 are Group B (see *The two fields*, below). Nothing else assigns a team to
a group, so a cached split cannot disagree with the fixtures that get played.

### The one dependency chain

Everything in this format is derived, in one direction, in one function
(`syncRadball10`):

```
group results -> group tables -> group rankings (A1-A5 / B1-B5)
               -> final-phase matches -> winners/losers -> places 1-10
```

Nothing is copied forward. That is enforced by the data model rather than by
convention:

* A final-phase slot stores a **reference**, never a team:
  `{ kind: 'group-rank', groupId, rank }` for a group position, and the existing
  `winner-of` / `loser-of` for a semifinal's outcome. `resolveSlot` in
  `src/backend/tournament/state.ts` re-reads them on every resolve, so a corrected
  result rolls every dependent match forward by itself.
* A dependent match is created **unlocked**. `resolveSlot` short-circuits on a
  locked slot, so locking one of these would freeze its occupants -- the stale
  bracket the references exist to prevent. Group fixtures stay locked: their
  teams never move.
* A place stores the **match that decided it** (`RadballFinalPlacement.source`,
  `.matchId`), so places 1-10 are an assignment list, not a sorted table. The
  validation (§36) is part of that computation: a place with no occupant, or a
  team in two places, becomes an entry in `radball.ten.issues` and the tournament
  is **not** marked complete.
* A group ranking is published only when all ten of its fixtures are decided. A
  provisional order would put teams into the semifinals while their group is
  still being played, and a later result would rename the finalists.

The structure itself is one table, `RADBALL10_FINAL_STRUCTURE` in
`src/shared/radball10Structure.ts`, imported by the engine, the UI and the
documentation page. It is in `shared/` precisely so the bracket drawer and the
match generator cannot hold two copies of the rules.

### The two fields

Group A is field 1 and Group B is field 2, and that is the *split* as well as the
pinning: the group a team plays in is the field it was registered on
(`Participant.fieldId`), so there is no separate group assignment anywhere —
not in the wizard, not on the shelf, not in the command payload. `buildRadballSetup`
fills Group A from the participants whose home field is field 1 and Group B from
field 2, and refuses a team with no home field or on a third field rather than
putting it somewhere the host did not ask for. Two equal groups is then a
requirement rather than a draw result, and the wizard, the shelf and the command
validator all state it in the host's own terms ("Hall has 6 and Side has 4").

The pinning itself is `RadballGroup.fieldId`. `homeFieldOf` checks a pinned group
*before* the registration and section rules, so the whole group's fixture list
belongs to one field's queue and the auto-assigner naturally puts one A match and
one B match on at the same time. The existing double-booking guard already
refuses to put a team on both fields at once, server-side on every assignment.

### Locking and tie resolution

* The final phase cannot be generated until all twenty preliminary fixtures are
  decided (`finalPhaseReadiness`). Once generated it cannot be generated again.
* Neither can it be *played* early: `assertFinalPhaseDependency` runs on every
  field assignment and every start, and refuses the final or the third-place
  match while a semifinal is unfinished — whatever the host's queue order says.
  Reordering the final phase changes the queue and nothing else.
* A level score in a final-phase match is settled at the 4-metre line, decided by
  the ruleset (`RadballConfig.tieResolution` / `.placementTieResolution`), not by
  the UI. A level *group* fixture stays a legal draw worth a point to each team.
* The generic tie machinery — championship decision matches — is switched off
  for this format. It would answer a tied group position by *spawning matches*,
  adding fixtures outside the documented 27 and being able to rename a
  semifinal's participants after the semifinal was played.

### Where it lives

| Concern | File |
| --- | --- |
| Structure table (shared by engine, UI, docs) | `src/shared/radball10Structure.ts` |
| Engine: construction, final phase, ranking, stage machine | `src/backend/tournament/radball10.ts` |
| Standings, 3/1/0, shootout (reused) | `src/backend/tournament/radball.ts` |
| Slot resolution for `group-rank` | `src/backend/tournament/state.ts` |
| Hybrid tournament tree | `src/frontend/components/Radball10Tree.tsx` |
| View helpers and format documentation | `src/frontend/lib/radball10.ts` |
| Competition page | `src/frontend/pages/Radball10Page.tsx` |
| The two groups, as the field rosters | `src/frontend/components/WorldCupGroups.tsx` (read-only) |
| Acceptance tests (the 20 numbered cases) | `tests/radball10.test.ts` |

Try it with `npm run build && node dist/server/backend/index.js --demo-kind radball10`.

## 12. The manual schedule format

The one format whose fixtures are **stored rather than derived**, and the one that exists because a
club's actual fixture list is rarely the shape a draw produces: three teams can play three matches,
the same pairing can meet twice, and "Group stage / Group stage / Final" is a schedule rather than a
bracket depth.

```
roster (any number of fields) -> the host's fixture list -> matches, exactly as typed
```

What it does *not* do is the point of the section:

* **Nothing feeds anything.** Every slot is `{ kind: 'participant' }`, so `isLeagueTree` is true and
  the poster draws it as a fixtures band, and `resolveSlot` never has to wait for a feeder.
* **Nothing auto-completes.** An empty slot is a roster edit, not a walkover: `resolveBracket` skips
  the advance-and-cancel branch for this format, so a fixture whose team was removed simply waits.
* **Nothing crowns a champion.** `decidingMatchIds` (engine) and `decidingMatch` (`shared/stats.ts`,
  used by the results report and the print pack) both answer with nothing for it, and
  `finaliseTournament` returns early as it does for Radball. The host ends the event deliberately,
  with `tournament.complete`; the two functions must agree or the report would name a champion the
  tournament refuses to.
* **The bracket is not re-rollable.** `generateBracketForTournament` refuses it, because a draw over
  a hand-typed schedule would throw away every fixture.

Editing is live, because a schedule is a list rather than a consequence:

| Command | Engine function | Refused when |
| --- | --- | --- |
| `match.add` | `addManualMatch` | the format derives its fixtures, or the two sides match |
| `match.remove` | `removeManualMatch` | the fixture is running, or the format is derived |
| `match.setRoundName` | `setManualMatchRoundName` | the fixture is running, or the format is derived |

`match.add` locks its match (`locked: true`) so `resolveBracket` can never re-derive its sides. It
also uses `preloadManualSchedule` rather than `autoAssign`: the same team may legitimately be in two
fixtures, and `autoAssign` would refuse the second one outright — so the pre-load walks the host's
own queue and takes the first fixture that fits, the way `nextSchedulableMatch` already does for
Radball. A field it leaves empty means every remaining fixture needs a team that is already playing.

| Concern | File |
| --- | --- |
| Fixture list to matches (pure) | `src/backend/tournament/bracket.ts` — `generateManualSchedule` |
| Creation and the three live edits | `src/backend/tournament/engine.ts` |
| "nothing advances / nothing completes" guards | `src/backend/tournament/resolve.ts` |
| The schedule builder (wizard) | `src/frontend/pages/SetupPage.tsx` — `ScheduleBuilder` |
| The schedule panel (dashboard) | `src/frontend/pages/HostPage.tsx` — `SchedulePanel` |
| Add / edit / remove dialog | `src/frontend/components/dialogs.tsx` — `ManualScheduleDialog` |
| Acceptance tests | `tests/manual-schedule.test.ts` |

## 13. Adding a feature

1. Add the domain change to the engines (`src/backend/tournament/*`) as a pure function that
   records a `Mutation`.
2. Declare the command in `src/shared/commands.ts` with its permission and validator.
3. Wire it in `src/backend/network/dispatch.ts`.
4. Call it from the UI through `live.command('your.action', payload)` and report the ack.
5. Add a test — engine level for rules, `tests/server.test.ts` style for anything that crosses
   the network.

### Adding a new state slice

Most features only touch slices that already exist. A genuinely new one (as `teamLibrary` was)
also needs:

- the interface and its empty constructor in `src/shared/types.ts`, plus a field on
  `TournamentState` and an optional field on `Delta`;
- a flag on `Mutation` and its default in `createMutation()` (`src/backend/tournament/state.ts`);
- the slice in `createEmptyState()` (`src/backend/tournament/defaults.ts`);
- the flag in `buildDelta()` and the full slice in the `restore()` delta
  (`src/backend/store/store.ts`), plus a `sanitise…` call in `sanitiseState()` so a snapshot
  written before the slice existed still loads;
- the slice in `applyDelta()` in `src/frontend/lib/live.ts`.

`SCHEMA_VERSION` stays at 1: the snapshot is the whole state, so an added field is a backwards
compatible change handled entirely by `sanitiseState`.

`teamLibrary` is the one slice that `clearLiveState` deliberately leaves alone — the host's squads
are their own address book, not state belonging to one competition.
