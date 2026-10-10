# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

There was no changelog before this file, and the project was not under version
control until it was added — so for `1.0.0` and everything before it, treat the
"Security" and "Fixed" entries below as a summary of what the code always
claimed to do, not as a list of regressions that were shipped and later patched.

## [Unreleased]

### Added

- **English and German.** Settings → Language switches the whole hall at once,
  because the setting travels in the ordinary settings delta: one tap on the host
  and every phone, tablet and projector repaints. Each device can also pick its own
  language without writing to the host, so one phone cannot change the language
  everybody else is reading. German is the point rather than a courtesy: the age
  classes are `U11`..`ELITE`, the presets are named after BDR championships, the
  clubs are `RV <Ort> I/II`, and "Feld" is not the word a sports hall uses for a
  playing surface. Brand terms stay untranslated. See `docs/ARCHITECTURE.md` §6.

- **A manual schedule format: pick the teams, then write the matches yourself.**
  Format → *Manual schedule* keeps step 3 exactly as it is for a knockout — one
  roster per field — and replaces the draw step with a schedule builder: one card
  per fixture, two team dropdowns, a round name and an optional playing field.
  There is no power of two, no byes and no rounds you did not ask for, so three
  teams can play three matches and the same pairing can meet twice. Matches that
  share a round name sit together on the board. The roster is the pool: only the
  teams you pick actually play, and the step tells you who is still unplayed.
  The schedule stays editable while the event runs — the host dashboard gets a
  schedule panel with *Add match*, and each fixture can be re-teamed, renamed,
  re-pinned or taken back off the list. Nothing advances by itself and nothing
  crowns a champion: finishing the last fixture is not the same as ending the
  event, so the host ends it deliberately. `tests/manual-schedule.test.ts`
  holds that line, because the one thing this format must never do is invent a
  result — a side emptied by a roster edit leaves the fixture waiting rather
  than handing the other team a walkover.
- **The team library is now reachable from every roster step.** The picker above
  the roster box was Radball-only, so a manual schedule — the one format whose
  whole premise is picking squads off your own shelf — was the one place you had
  to retype them. It now appears wherever the roster is a list of participants,
  writing `name, club` into the box the same way it always wrote
  `team, player 1, player 2` for Radball. A squad's crest now survives the copy
  into a knockout as well, which it could not before: the generic roster had no
  column to put it in, so the crest column is new and the two- and three-column
  hand-typed form is byte for byte what it was.
- **Creating a match is now two dropdowns and one button.** Each fixture used to
  arrive as a blank card carrying four controls — a round name, both teams, a
  field — so adding a match meant filling in things the format does not need. The
  schedule step now opens with a single strip: pick Team A, pick Team B, press
  *Add match*, and the pair is committed and the strip clears ready for the next
  one, with focus back on the first dropdown so a whole fixture list can be typed
  without touching the mouse. Round and field are still there, one disclosure away
  on the card they belong to, and both default to something workable — a fixture
  added with neither becomes a real match. The pickers sit on one line with a
  "vs" between them instead of stacked, which halves the height of every card.
- **The schedule is a list, not a grid.** The fixture cards were laid out in a
  multi-column grid, so on a normal desk two matches sat side by side and read as
  two independent things rather than as an order. They now run one per row, full
  width, each row carrying its number, the pairing and the move/remove controls
  on a single line — so scrolling the list is scrolling the running order, and the
  ↑ ↓ buttons sort something you can actually see. The quick-add strip is capped
  to the same measure as the list, so the strip and the fixtures it adds line up.
  Below 720px the row stacks again rather than squeezing three buttons and two
  dropdowns onto a phone.

### Changed

- **README §3 opens with the one-command Windows start.** `Start-Scoreboard.bat` was the
  fastest way to a running scoreboard and the manual never mentioned it, so a Windows user
  downloading the repository had to find the file, guess what it would do and learn from
  the source. Section 3.1 now says exactly what the starter checks, installs, builds and
  opens, that the first start needs one internet connection, and which flags it accepts;
  the manual route and the desktop build follow it as 3.2 to 3.4.

- **The manual schedule's match creation is its own step.** It used to share the
  *Spielplan* panel with the clock, the scoring buttons and the auto-assign
  switches, so the host picked their fixtures underneath a wall of unrelated
  controls. The format's wizard is now seven steps rather than six: *Veranstaltung,
  Format, Plätze, Teilnehmer, Spielplan, Match, Übersicht* — the fixtures on their
  own step, and the duration, scoring and next-match behaviour on the one after.
  Every other format keeps its six steps and is untouched. `lastStepOf(format)` is
  the one place the count lives, and everything else reads the ceiling from it,
  so a format gaining a step is one change rather than seven.

### Fixed

- **The launcher could skip the build it needed.** `scripts/needs-build.mjs` answered
  "stale" with exit code 0 and "up to date" with 1 — the code a crash exits with — so a
  check that could not run was read as "nothing to do" and `Start-Scoreboard.bat` started
  a server whose `dist/` did not exist. Exit code 0 now means up to date and anything else
  means rebuild. The script also resolves its own directory with `fileURLToPath` instead of
  `import.meta.dirname`, which does not exist before Node 20.11 and made the check itself
  the thing that crashed there. `tests/needs-build.test.ts` pins both directions.
- **The launcher's dependency check could be fooled.** It only looked for `express`, so an
  install without the build tools (`npm install --omit=dev`, or a first start interrupted
  halfway) passed the check and failed later inside `npm run build`. It now requires
  `express`, `vite` and `typescript`, and it compares `node --version` against the
  documented 22.5 minimum, naming the version it found rather than letting an older runtime
  fail somewhere the reason is invisible.
- **The launcher's first run read like a failed install.** `npm install` front-loaded 28
  vulnerabilities, ten deprecation notices and the "install scripts not covered" warnings
  before the build even started. The audit summary and the funding notice concern the build
  tooling, never the scoreboard — the server runs on `express`, `qrcode` and `ws`, and
  `npm audit --omit=dev` is clean — so the starter installs with
  `--no-audit --no-fund --loglevel=error`. Errors still print, and a hand-typed
  `npm install` still shows everything.
- **Vite loads its config as ESM.** `vite.config.ts` went through Vite's deprecated
  CJS API, so every build printed "The CJS build of Vite's Node API is deprecated" —
  one more line a first-time user reads as a failure. As `vite.config.mts` the config
  loads as ESM, the notice is gone, and the build output is only the build. The
  staleness check and `tests/build-stamp.test.ts` follow the new name.
- **Batch files now arrive on Windows as batch files.** `Start-Scoreboard.bat` was committed
  with LF endings and the repository had no `.gitattributes`; a GitHub ZIP download hands
  out the committed bytes without checkout conversion, so the one file a Windows user
  double-clicks was the one file with the wrong endings for Windows. It is committed with
  CRLF and marked `-text` so nothing converts it back, over a `* text=auto` default for the
  rest of the tree.

- **The schedule step's refusal was a red banner over the panel.** "Add at least
  one match to the schedule" was set as a full-width banner above the wizard —
  shadow, padding, red background — which pushed the schedule builder, the
  duration and the scoring buttons down and separated the host from the one
  button that lifts it. The empty schedule was also a faint hint, so a host
  arriving on the step saw nothing that said what to do. It is now a dashed panel
  with the instruction in it, and the refusal is one red line directly under
  *Add match*, naming that button. The roster step's banner gets the same
  treatment, so neither displaces the list it is about.
- **A step's complaint stayed on screen after it was fixed.** Any edit now retires
  it, so a host who corrects the offending row is not still being nagged about it
  on the next press of *Next*.
- **The roster step's refusal was a count with nothing under it.** "Please fix 5
  problems in the list" appeared as a banner above the whole wizard — pushing the
  step down and reading as an application failure — while the roster panel it
  pointed at listed nothing at all, because it was showing one field's rows while
  the check ran over every field. A row on Field 4 while you were looking at
  Field 1 therefore produced a number and no way to act on it. The panel now
  lists every problem in the whole roster, each one named by the field and line it
  lives in; a duplicate now says where the first copy was entered rather than
  "line 1" with nothing to compare it to; the message moved inside the roster
  panel, directly above the rows it is about; and the list scrolls in place rather
  than growing the step, so a wall of errors cannot push the roster box off the
  screen.

- **The language switch did nothing.** The per-device override was held in a
  `useState` inside `useI18n`, so every component that called the hook got its
  own independent copy: tapping "Deutsch" re-rendered the two buttons and nothing
  else, while the rest of the app kept reading its own empty value and falling
  back to English. From the user's side that is indistinguishable from a
  translation that does not work. The override is now a module-level store read
  through `useSyncExternalStore` — the shape `live` and `useLive` already use — so
  one setter reaches every caller and they re-render together. The store is
  exported so the test can assert that property directly, because a test which
  only exercised the catalogue would have passed against broken wiring.
- **The settings page showed two language controls**, a hall-wide switch stacked
  above a per-device one, neither labelled as to which was which — which is why
  one of them appeared dead. There is now one row of buttons: the host's choice
  writes the setting and repaints every screen, anybody else sets it for their own
  device only, and an override shows a single button to drop back to the host's
  language so it is never a trap.

- **HTTP rate limiting.** Every endpoint was reachable from any device on the
  venue WLAN with nothing stopping a flood, and Express and `ws` share one event
  loop with the heartbeat, the timer anchors and the snapshot writes — so one
  laptop looping on `/api/network` could stop scoring for the entire hall. A token
  bucket now sits in front of everything, keyed by remote address and mounted
  *before* the body parser so an oversized request is refused on its headers.
  Sized for a real event, not for the internet.
- **`noUncheckedIndexedAccess` for the server.** Both tsconfigs are now on it for
  `src/backend` and `src/shared`, which surfaced two real latent crashes (below)
  and made ~90 previously-invisible index lookups explicit.

- **Every match on a knockout bracket was drawn twice**, at identical coordinates
  and with duplicate React keys: the lane-guarded placement was kept *and* an
  unconditional `poster.cards.map` was left further down the same parent. League
  brackets were worse — `TreeLane` had already placed each card, so the stray map
  drew every match a second time on top of the first. Only the layout data was
  ever tested, and it was correct; the duplication lived purely in the JSX.
- **A control link for a field the tournament does not have crashed the WebSocket
  hub.** Operator tokens live in `access.json`, deliberately outside tournament
  data, and their per-field entries are never pruned — so a printed `/field/5#t=…`
  QR code from an eight-field event still resolved after the host ran a two-field
  one, and restoring an older backup did the same. `greet()` read
  `state.fields[fieldId].controlledBy` unguarded, on a path that had already
  greeted the client: the phone believed it was connected, the field was never
  claimed, and nothing was logged. Such a link is now downgraded to spectator with
  a notice naming the real reason.
- **A match naming a deleted field failed the whole CSV export.** `matchesCsv`
  dereferenced `state.fields[match.fieldId].name` with no guard — while
  `participantsCsv` in the same file already did it defensively — and the export
  route is unauthenticated, so one stale `fieldId` returned a 500 for every
  spectator who asked for the file.
- **A fatal fault no longer leaves the server running.** Registering an
  `uncaughtException` handler overrides Node's default of printing and exiting, so
  the previous handler — which only logged — turned a crash into a server that
  kept broadcasting from `store.state` in an unknown state. It now flushes and
  exits. On an event that is the honest outcome: the host sees a closed window and
  restarts onto the last valid snapshot, instead of a wedged process losing the
  rest of the event.
- **`store.apply()` no longer deep-clones the event log.** The rollback pre-image
  grew for the whole tournament as `events` filled toward `MAX_EVENTS`, on every
  score tap. The engine never mutates an event in place and events are appended
  only after the operation returns, so the log is now held by reference; measured
  30–61% off the command path on a realistic mid-event state.
- **The rules-of-hooks scan now sees a one-line early return.** It only recognised
  `if (...) {` followed by a `return` on the next line, so the ~120 single-line
  guards in the tree were invisible — including the case it was written for. It
  also could not see a line that was nothing but a hook call, and it wrongly
  reported `something.useThing()`.

### Added (1.0.0)

- **A World Cup preset for any even roster of 4 or more 2er squads**, not just
  ten. The shape is unchanged and now derived from the group size: two equal
  groups, one per playing field, each a single round robin so every position is
  decided by a result; ranks 1–2 of each group into cross-group semifinals; the
  third-place match; the Radball Final; and one placement match for every other
  pair of positions. Two groups of N therefore have N−2 placement matches and
  decide all 2N places — twelve teams play 30 preliminaries and 8 final-phase
  matches, 38 in all, with places 1–12. The ten-team World Cup is the N=5 case
  and is unchanged. Covered by a full twelve-team walk-through: preliminary
  counts, the rules panel, and a final ranking with twelve places each awarded
  by a match.
- **Operator PIN throttling.** Wrong PIN attempts are counted per remote address
  with an escalating lockout, instead of being checked only when a socket sends
  its `hello` — which the command rate limiter never saw. Previously a single
  connection could try the whole four-digit space at line rate, and reconnecting
  reset the allowance.
- **Linting** via `oxlint`, with `npm run lint` / `npm run lint:fix`. `npm run
  check` now runs typecheck + lint + tests.
- **Continuous integration** (`.github/workflows/ci.yml`) on `windows-latest`,
  including a check that the built client bundle contains no remote references —
  the offline-first promise is now verified rather than assumed.
- **`.editorconfig`** and [`docs/LINTING.md`](docs/LINTING.md).
- **Security headers** on every response: Content-Security-Policy (no inline
  script, no framing), `X-Content-Type-Options`, `Referrer-Policy` and
  `Permissions-Policy`. The theme bootstrap moved out of `index.html` into
  `public/theme-boot.js` so the policy does not need `unsafe-inline`.
- **A changelog.** This file.
- **`tests/build-stamp.test.ts`**, pinning the build fingerprint that drives the
  service worker cache invalidation.

### Security

- **The operator PIN is hashed with scrypt** and a per-install random salt,
  replacing a single unsalted SHA-256 round with a hard-coded prefix. Identical
  PINs previously hashed identically across every install, making the entire
  four-digit space enumerable offline in milliseconds. Hashes written by earlier
  versions are still accepted and are upgraded transparently on first use.
- **`access.json` is written atomically** (temp file, `fsync`, rename) through a
  serialised write queue, and a shadow copy `access.json.bak` is kept. The file
  holds the only copy of the operator tokens, so a power cut mid-write used to be
  indistinguishable from "no credentials configured" — which silently rotated
  every control link halfway through an event.
- **A damaged `access.json` is no longer overwritten.** It is moved aside as
  `access.unreadable-<timestamp>.json` before fresh credentials are issued, so the
  original can still be recovered by hand.
- **Cross-site request defence on every mutating `/api` route.** Requests are
  rejected when `Sec-Fetch-Site` says cross-site, when the `Origin` does not match
  the `Host` actually reached, or when a JSON content type is absent. Without
  this, any page open in a browser on the host PC could reach admin-only
  endpoints (including the log prune and the backup writer) with a plain HTML
  form, because loopback connections are granted admin without a token.
- **PIN generation now uses a CSPRNG** (`randomInt`) instead of `Math.random`.

### Fixed

- **Generating the 10-team final phase no longer reports itself as a failure.**
  Clicking *Generate final phase* creates seven unplayed matches, and that
  immediately raised a red "the final ranking is not complete" banner listing six
  problems — every place undecided because nothing had been played yet, so the
  host read a successful generation as a broken one. An issue now means the
  ranking cannot be *completed*: an unplayed match counts only once nothing is
  left to play and a place still has no team. A squad in two places, or a match
  the structure needs that does not exist, were and still are faults. The
  `VALIDATION_FAILED` activity event no longer fires on a normal tournament
  either. The tournament is still never marked complete over a place that cannot
  be filled (§36), which is now pinned by a test that *cancels* the 9th/10th
  match instead of relying on an unplayed one.
- **The World Cup preset no longer refuses a roster that is not ten teams.** The
  engine, the command validator, the setup wizard and the format page all read
  the group size off the competition instead of comparing against a literal, so
  a twelve-team event is described as twelve teams — "2 groups × 6 teams", "30
  preliminary + 8 final-phase = 38 matches", "places 1–12" — rather than
  reciting the ten-team case. The final phase is generated from the group count,
  so a twelfth place is decided by a real 11th/12th placement match.
- **Rebuilds now reach the screens that are already connected.** The service
  worker's cache name was a literal in `public/sw.js`, and `public/` is copied
  verbatim, so nothing knew a rebuild had happened: `activate` never ran for it
  and every browser kept rendering the previous bundle out of the cache,
  including assets the host had stopped serving. The symptom was a host that
  changed something in the interface while every phone silently kept showing the
  old version, with no error anywhere. The cache name is now stamped with the
  build's own fingerprint, and a worker that takes over tells open screens to
  reload. One hard refresh was previously the only cure.
- **Every command is now atomic.** `TournamentStore.apply()` snapshots the live
  state and rolls it back if the engine throws. Previously an operation that
  failed part-way left the server's state half-mutated, broadcast no delta and
  wrote nothing to disk — so the host, every connected screen and the saved file
  silently disagreed. `store.state` keeps its identity on both the success and
  the failure path, so cached references stay live.
- **Automatic backups are pruned.** The scheduled writer created a file every
  interval and never rotated the directory, so `data/backups/` grew without
  bound — a long-running event would eventually fill the disk. One development
  checkout had accumulated 185 backups against a documented limit of 20.
- **Backups are pruned by write time, not file name.** The three filename
  prefixes sort lexicographically into separate blocks, so the previous order
  deleted the automatic safety-net backups first and kept stale manual ones.
- **A corrupt SQLite snapshot no longer becomes an empty tournament.** The
  previous snapshot is kept in a `snapshot_shadow` table and used as a fallback.
  Previously a single unreadable blob was reported as "nothing stored", and the
  next save overwrote the only copy of the event with an empty state.
- **Restoring a backup no longer rewinds the event sequence.** The audit log is
  keyed by `seq`, so restoring a typical older backup re-used sequence numbers
  and silently overwrote newer audit rows. Clearing the tournament had the same
  problem.
- **Async Express routes forward their rejections.** Express 4 does not catch a
  rejected promise from an async handler, so a failure in `/api/history`,
  `/api/qr`, `/api/backup`, `/api/restore` or `/api/access/rotate` became an
  unhandled rejection instead of an error response.
- **Three light-theme contrast failures in the 10-team tree.** The position tags
  (A1–A5) were `--brand-ink` on `--surface-3`, which is white ink on a light grey
  fill and measured **1.23:1**; the top-two points figures were the same white
  ink on a white card at **1:1**, so the two numbers that decide who goes
  through were the two you could not see; and the "Now" key was live green on a
  green-tinted well at **4.19:1**, under the 4.5 floor. `--brand-ink` is ink for
  the brand colour and does not change between themes, so all three now use
  tokens that invert. All 20 audited tree colours pass in both themes.
- The Now/Next rows inherited the global `p { max-width: 70ch }` reading-measure
  cap, clamping them to 483px inside a 553px card so the live well stopped
  short of the card edge.

### Removed

- **The World Cup's group assignment is gone: the group is the field a team was
  registered on.** Teams entered on Field 1 are Group A and teams entered on
  Field 2 are Group B, which the format already pinned them to, so the two-column
  drag-and-arrow editor, the seeded/random group draw and the `manualGroupOrder`
  payload that carried it (with the `seeded`/`seedValue` knobs that fed the
  draw) were a second answer to a question the home field had answered — and the
  two could disagree, with a team listed in one group and playing its fixtures in
  the other. The wizard now shows the two groups read-only, the
  rosters step marks each field tab with the group it is, and the roster itself
  is the split. `tenTeamGroups` is gone from saved setups and the built-in
  example (which already put five teams on each field), and the engine refuses a
  team with no home field or on a third field instead of placing it somewhere the
  host did not ask for. A saved setup that cannot form two equal groups is still
  refused at save time, in the host's own terms: "Hall has 6 and Side has 4".
- **The "Final ranking 1–10" panel is gone from the Competition tab.** Places
  1–10 are no longer listed anywhere in the interface. The panel was the only
  place showing them, so if you want them back they now need a home — the
  Standings tab is the natural one. `finalRankingRows` still derives them and is
  covered by tests, so restoring the list is a component over an existing
  function.

### Changed

- **The Results tab lists games newest round first**, so the fixture on a field
  right now is at the top of the list rather than at the bottom of a 46vh scroll
  box, and the list reads the same way as the match history below it. The `#`
  column is still the game's number in playing order, so game 20 at the top
  reads "20". `competitionFixtures` itself is unchanged — "what do we call next"
  is answered from it and still comes from the front of the queue.
- **A standalone `/standings` page, tabbed beside Competition and Results.** The
  official group tables moved off the Results tab onto their own route and nav
  item, because they answer a different question ("where does everyone stand",
  not "what has been played") and sharing a page with a twenty-row fixture list
  meant neither was findable. Radball only — a knockout is ranked by its
  bracket, so the tab is hidden for that format and typing the address explains
  why it is empty. Results is back to being just the games.
- The 10-team tournament tree, visually: the standings are column-sized rather
  than auto-laid-out (the squad name took 40% of the row and the two figures 37%,
  neither labelled), the goal-difference and points columns now carry labels, the
  final-phase ladder no longer stretches a panel around ~300px of nothing, the
  field each group plays on is a label with a live dot instead of loose dim text,
  and the Now/Next rows fill their card.
- The gutter between the two 10-team tree panels is wide enough to show the
  position wires again. Removing the dashed connector had left the panels one
  step apart, and the wires are painted behind both opaque panels, so the only
  place they can be seen is that gap. At the old width the wire's two 10px end
  stubs overlapped and the line collapsed into a few pixels against the border.
  The stubs are now capped at half the available run, so the path cannot invert
  however narrow the gutter gets.
- The dashed **"Group positions"** connector between the preliminary round and
  the final phase in the 10-team Radball tree is gone. It was the one part of the
  tree drawing a dependency the position wires above it already draw, and once
  the two group cards stacked it was a rule running down the full height of an
  otherwise empty gutter. The dependency is still stated by the wires and by each
  ladder row's own "waiting:" note.
- The two group cards in the 10-team Radball tree now **stack one above the
  other** instead of sitting side by side. Sharing the panel width squeezed both
  name columns down to a column of initials; stacked, each card gets the full
  width and the two groups read down the page in the order they are played.
- The assign button in a field queue row is now labelled **"Add to Field 1"**
  (with the field's configured name) instead of showing the bare field number,
  so the action is readable without hovering. Its tooltip names the match too.
- Internal dependencies of `TournamentStore.apply()` now include a structured
  clone of the tournament state per command. Scoring is human-paced, so the cost
  is not observable, and the exchange buys atomicity for every current and future
  command.

## [1.0.0]

- First release. Two playing fields with independent participants, score, clock
  and operator; single and double elimination with byes and a third-place match;
  live WebSocket delta sync; host / operator / spectator roles with QR joining;
  SQLite storage with a crash-safe JSON fallback; CSV, JSON and printable
  report exports; a Windows desktop build via Electron.
