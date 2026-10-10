# Tournament Scoreboard

A local tournament control system for Windows: **one host PC runs everything**, every other
device (phone, tablet, laptop, TV) just opens a browser on the local Wi-Fi. No internet,
no cloud, no accounts, no app installation on client devices.

Designed for school tournaments, club events, sports days and fighting-game brackets —
anywhere you have two playing surfaces running at the same time and a hall full of people
who want to see the scores.

```
        Host PC (Windows)                      Venue WLAN
  ┌──────────────────────────────┐
  │  Tournament Scoreboard       │      ┌──────────────┐
  │  ├── local HTTP + WebSocket  │◀────▶│ Phone: Field 1│  score a match
  │  ├── tournament + bracket    │      ├──────────────┤
  │  ├── embedded SQLite         │◀────▶│ Tablet: Field 2│ score a match
  │  └── QR join links           │      ├──────────────┤
  └──────────────────────────────┘      │ TV: live board│  read-only
                                        └──────────────┘
```

---

## 1. What it does

| Area | What you get |
| --- | --- |
| Two playing fields | Field 1 and Field 2 with independent participants, score, clock, state, operator and history — plus a one-click swap |
| Bracket engine | Single or double elimination, byes, seeded or random draw, third-place match, automatic winner advancement |
| Live sync | WebSocket deltas: a score change appears on every connected screen in well under a second, no polling, no reload |
| Roles | Host (full control), field operator (one field only, optional PIN), spectator (read-only, cannot send a single command) |
| Joining | QR codes for the board, the bracket, the results page and each field control link; typing an IP address is optional |
| Offline first | All frontend assets are bundled and served locally, all data is stored locally, nothing is requested from the internet |
| Storage | SQLite when available, a crash-safe JSON log/database as a fallback; every important change is persisted immediately |
| Exports | CSV (results, match history, participants, event log), JSON backup/restore, printable PDF reports |
| Display modes | Combined board for a projector, per-field boards, a pannable/zoomable bracket view, a printable pack |
| Desktop app | Electron shell with a Start-menu entry, desktop shortcut, multi-monitor window placement and a Windows installer |

---

## 2. Requirements

* **Windows 10 or 11** (the app also runs on macOS and Linux for development)
* **Node.js 22.12 or newer** for running from source (`node --version`) — Node 22.5 to 22.11
  ship an npm that fails the install without saying so (see troubleshooting)
* A WLAN/router that allows devices to talk to each other (no client isolation)
* No internet connection required at any point

---

## 3. Install and start

### 3.1 The easy start (Windows: double-click)

Download the repository and double-click **`Start-Scoreboard.bat`** in the folder. It checks
Node.js, installs the dependencies on the first run, builds the web interface when it is
missing or older than the source, then starts the server and opens the dashboard in your
browser. The window prints the address for the phones and stays open while you play;
`Ctrl+C` stops the server. It takes the same flags as the manual start:

```bash
Start-Scoreboard.bat --demo --port 3200
```

The very first start needs an internet connection for `npm install`; after that the
scoreboard works entirely inside your own WLAN. The data lives in `data/` next to this file,
exactly as it does for the manual start below.

### 3.2 From source (development, also how the desktop build is produced)

```bash
npm install
npm run dev          # backend on :3000, Vite dev server on :5273
```

Open `http://127.0.0.1:3000` (or the Vite URL while developing) on the host PC.

### 3.3 Production start (host PC only)

```bash
npm run build        # builds the web interface into dist/client and the server into dist/server
npm start            # starts the local server, prints the LAN address and the QR hint
```

Useful flags:

```bash
node dist/server/backend/index.js --port 3200     # different port
node dist/server/backend/index.js --demo --open   # demo tournament + open the dashboard
node dist/server/backend/index.js --data-dir D:\Events\Scoreboard
node dist/server/backend/index.js --help
```

### 3.4 Desktop application

```bash
npm run desktop      # build + launch the Electron shell
npm run dist:win     # build the Windows installer: release/TournamentScoreboard-Setup-1.0.0.exe
```

The installer creates a Start-menu entry (**Tournament Scoreboard**) and an optional desktop
shortcut. Launching the app starts the local server automatically — there is no terminal
window to manage.

The released installer is built from the tag rather than here: **Releases** carries
`TournamentScoreboard-Setup-<version>.exe` for every tagged version (see §12.1). The two
commands above are for building one yourself, which needs the source tree and Node.js.

---

## 4. Connect phones and tablets

1. Start the app on the host PC. The dashboard header shows the **local network address**,
   for example `http://192.168.178.50:3000`.
2. Connect the other device to the **same Wi-Fi network**.
3. Either open that address in the browser, or simply scan a QR code.
4. Windows Firewall may ask once — allow the app on **private networks**. The app never
   changes firewall rules on its own.

If the address is wrong (a PC often has several network cards), open
**Settings → Network** and pick the address devices should use, or set it manually.

### QR codes

Each link has its own QR code and its own permissions:

| QR code | Opens | Rights |
| --- | --- | --- |
| Join the event | `/` | Spectator — board, bracket, results |
| Combined display | `/display` | Spectator — for the projector |
| Field 1 / Field 2 display | `/display/1`, `/display/2` | Spectator — one field, fullscreen |
| Bracket display | `/bracket` | Spectator |
| Results | `/results` | Spectator |
| Field 1 / Field 2 control | `/field/1`, `/field/2` | **Operator** — only that field, optionally PIN-protected |
| Host dashboard | `/host` | **Admin** — keep this one private |

Control links carry a token in the URL fragment (`#t=…`), which browsers never send to a
server and which the app strips from the address bar after storing it on that device.
Spectator QR codes are generated from read-only routes, so a scanned spectator link
literally has no way to send a score command.

---

## 5. Create a tournament

1. **New tournament** in the top bar.
2. Name the event.
3. Pick the format: single elimination (with optional third-place match) or double elimination.
4. Pick how many playing fields run at the same time (1–8) and name them
   (`Field 1 → Court A`).
5. Enter the participants **per field** — one per line as `name,team`, pasted from a
   spreadsheet or **Import CSV** into any field's roster. Duplicate names are flagged.
6. Draw the opening round: generate it automatically (seeded with a seed value or *Re-draw*,
   or purely random) or assign every player to a bracket slot yourself — the roster shows
   who registered on which field. An automatic draw keeps each field's players in their own
   half of the tree, so a roster entered per field opens against itself and only meets the
   other field later on. Then set match duration, score-button increments, and whether the
   next match should load automatically.
7. **Generate bracket & open dashboard.** Byes are placed automatically when the participant
   count is not a power of two (each field's byes go to its own best seeds), the opening
   matches are put on the field they belong to, and the bracket is deterministic — reloading
   a page never re-draws it.

You can also press **Demo** anywhere to build an eight-team tournament with two live matches —
the roster is dealt across both fields, so each field gets its own half of the bracket and its own
queue. It is the fastest way to try everything.

### 5.1 The team library (2er Radball)

Clubs and players only have to be typed once. **Teams** in the top bar is a library of 2er squads
sorted into the Radball age groups (U11, U13, U15, U17, U19, U23, Elite):

* Add a squad in the form at the top of the page, or **paste a list** —
  `team name, club, player 1, player 2, age group` per line. Club and age group are optional, a
  header row is ignored, and a CSV file works too. **CSV template** downloads the column layout.
* The rail on the left filters by age group; the count on each tab says how many squads are filed
  there. The **Age group** cell in the table re-files a squad in one click — handy between seasons,
  when the same club moves from U15 to U19.
* The library lives on the host. It survives creating, replacing and resetting a tournament, a
  restart, and a restore.

During **New tournament → Radball teams**, step 4 starts from the library: choose an age group,
tick the squads taking part, and **Add … to Field 1** copies them into that field's roster as
roster lines. Anything already on the field is marked and left out, so you can add in two passes
without creating duplicates. The pasted lines stay fully editable — the library is a shortcut, not
a lock.

The age group in the library is a filing label. It does not change the age category a competition
plays under; that is still set in step 5, **Radball rules**.

Radball rosters are per field, and in the **World Cup** preset the field *is* the group: the teams
on Field 1 are Group A and the teams on Field 2 are Group B (that is what the field tabs are
badged with). There is no separate group assignment to make — the split is the roster you paste,
so both fields need the same number of teams. The rules step shows the two groups back before
anything is created; to move a team between groups, move its line to the other field's roster.

---

## 6. Running the event: two fields at once

* **Host dashboard** — one tab per playing field with score buttons, clock, start/pause,
  undo/redo, reset and end match. Each tab shows the live score at a glance. Under the tab
  sits **that field's queue and nothing else**: its own matches first (the matches whose
  players registered on it), then — under the *Shared · either field* heading — the pairings
  that mix both fields, such as the final and the bronze match, which either field may play.
  Another field's matches are never listed there, so you always know which queue you are
  looking at. Use **Swap** to exchange the matches of two fields and **Auto-assign next** to
  give every free field its next own match.
* **Which match belongs to which field** has two answers, and you never have to configure them.
  If you entered a roster per field (Setup → step 4 has one box per field), each field owns the
  matches played by *its* players. If a tournament has no field rosters — a quick draw or an
  imported list — each field runs a **section of the draw** instead: Field 1 the top half of the
  bracket and the semifinal it feeds, Field 2 the bottom half. A pairing that mixes the two (the
  final, the bronze match) shows up in both queues under *Shared · either field* and may be played
  on whichever field is free.
* **Field operator** — open `/field/1` (or the field-1 QR code) on the phone of the person
  running that field. Big touch targets, a big clock, `+1/+2/+3`, undo, and *End match*.
  The first device to open a field claims it; a second device is told
  *"Field 1 is currently controlled"* and can take over deliberately.
* **Any screen** can be a display: `/display` for both fields, `/display/1`, `/display/2`,
  `/bracket`, `/results`. They are read-only and update themselves.

Keyboard shortcuts on the operator screen: `Space` start/pause, `1` / `2` score, `U` undo,
`R` redo, `E` end match, `?` shortcut list, `Esc` close dialog.

---

## 7. How bracket advancement works

```
Quarterfinal 1  (Field 1)  A 5 : 3 B   →  Winner A advances
Quarterfinal 2  (Field 2)  C 4 : 2 D   →  Winner C advances
                    ↓ automatic
Semifinal 1                A  vs  C
```

* Ending a match writes the result, marks it finished, frees the field and pushes the winner
  into the correct slot of the next match — recursively, all the way to the final.
* A level score must be resolved by an explicit winner (or "record a draw" when draws are
  enabled), so the tree can never stall.
* **Manual override** (host dashboard → *Manual override*) forces participants into a match
  and pauses automatic propagation for that match.
* **Correct score** re-opens a finished match and repairs the result, as long as the next
  round has not started.
* If *Auto-assign the next match* is enabled (Settings → Fields), the field that just finished
  takes **its own** next match — Field 1's queue is never played on Field 2, even when a field
  is free. If a field has nothing of its own left, a shared match (the final, the bronze match)
  follows instead; the operator screen then shows it without anyone tapping.

---

## 8. Backup and restore

* **Settings → Backup → Download backup file** — a single JSON file with the tournament,
  bracket, every score action and the settings. This is the portable format.
* **Write backup to disk** — stores a timestamped file in `backups/` next to the database.
* **Restore** — pick a backup file, confirm, and the running tournament is replaced. A
  safety backup of the current state is written first, so a mistake is recoverable.
* Automatic backups run every 15 minutes by default (Settings → Backup), and
  rotate: the newest 20 files in `backups/` are kept, oldest first, chosen by
  write time rather than by file name.
* The host also keeps the live state in SQLite (`tournament.sqlite`) plus an append-only event
  log, so a crash or power cut restores the last valid state on the next start. The previous
  snapshot is kept alongside it as a fallback: if the newest one ever comes back unreadable,
  the tournament is recovered rather than silently reset to empty.

Data locations:

* Desktop app: `%APPDATA%\Tournament Scoreboard\data`
* From source: `./data` (override with `--data-dir` or `TOURNAMENT_DATA_DIR`)

---

## 9. Export

* Results, match history, participants and the event log as CSV.
* The full tournament as JSON (same format as a backup).
* Printable reports: **PDF** buttons open `/print/results`, `/print/bracket` or
  `/print/history` and use the browser's *Print → Save as PDF* — no server-side PDF library,
  no internet.

---

## 10. Security model

| Role | How you get it | What you can do |
| --- | --- | --- |
| Admin | Local access on the host PC, or the host QR link | Everything |
| Operator | The field-1/field-2 control link (optional PIN) | Score, start, pause, end — only on that field |
| Spectator | Any public URL, or no token at all | Read only; commands are rejected server-side |

* The server validates **every** command: name, payload shape, permission and field ownership.
* Control tokens live in `data/access.json`, deliberately outside the tournament data, so a
  shared tournament backup can never leak credentials.
* Tokens can be rotated individually (Settings → Security) when a tablet changes hands or a
  printed code goes missing; the old link stops working at once.
* Set an operator PIN for a real second factor: the link alone is then not enough to score.
* **Language**: English or German, chosen in **Settings → Language**. The host's choice follows to every phone, tablet and projector at once; and each device can pick its own without changing the hall.
* A spectator page cannot be turned into a controller from the browser — the read-only
  downgrade is applied on the server, not in the UI.

---

## 11. Troubleshooting

**Phones cannot open the address**

1. Same Wi-Fi? Guest networks and "client isolation"/"AP isolation" block device-to-device
   traffic — turn that off or use another access point.
2. Check the address in the dashboard against the list in **Settings → Network**; a PC with
   VPN or several adapters can advertise the wrong one.
3. Allow the app through Windows Firewall on **private** networks (Settings → Network has a
   reminder). Do not disable the firewall completely.
4. Test from the host PC first: `http://127.0.0.1:<port>` must always work.

**A phone shows "Reconnecting"**

That is expected on a flaky WLAN. The app retries with backoff and resyncs the full state the
moment the link is back; nothing is lost because all state lives on the host.

**"Field 1 is currently controlled"**

Another device holds the field. Finish on that device, release it (host dashboard → Fields →
*Swap/Release*), or deliberately take over on the newer device.

**The score was entered wrong**

Type the correction on the operator screen (**Undo**), or use **Correct score** on the host
dashboard to set both numbers directly. Every change is in the scoring log and the event log.

**The tournament looks empty after a restart**

The host restores the last valid state automatically. If the database was damaged, restore the
newest file from `data/backups/` via **Settings → Backup → Restore**.

**"The web interface has not been built yet"**

Run `npm run build` (or `npm run dev` while developing) and reload.

**The install claims to be finished but `vite`/`tsc` "is not recognized"**

The npm bundled with Node 22.5 to 22.11 dies part way through `npm install` — it prints
`Exit handler never called!` — and still reports success, so `node_modules` ends up without
`node_modules/.bin` and the next command finds no build tools. Update Node.js to 22.12 or
newer (`node --version`), delete `node_modules`, and run the starter again. `npm install`
is the step that fails, not the build.

**`npm run dist:win` stops at "Cannot create symbolic link"**

electron-builder's helper archive holds macOS symbolic links, and the 7-Zip it bundles cannot
create them without an elevated process, so the whole extraction fails over two `.dylib` files a
Windows build never uses. It is the tool cache, not the project: copy one of the numbered folders
it left behind (`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<number>`) to
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` and run the command again.

**Port already in use**

The server automatically tries the next free port and prints the one it bound to. Pin a port
with `--port 3200` if you need a fixed address for a printed QR code.

**The first start prints npm warnings**

The starter installs with `--no-audit --no-fund` on purpose: that report is about the build
tooling (Electron, `electron-builder`, Vitest), never about the scoreboard. The server runs
on `express`, `qrcode` and `ws`, and `npm audit --omit=dev` reports no vulnerabilities.
Typing `npm install` by hand still shows everything.

**Diagnostics**

**Settings → Developer** shows the WebSocket state, reconnect count, clients per screen, the
round-trip of the last update and the host's log ring buffer — everything needed to diagnose
an event on the spot, without a terminal.

---

## 12. Project layout and development

```
src/shared/      types, protocol validation, command catalogue, stats, exports (no runtime deps)
src/backend/
  tournament/    bracket engine, tournament engine, scoring, match/field lifecycle,
                 team library, demo
  store/         state projection, autosave, event log, deltas to the WebSocket hub
  database/      SQLite driver + crash-safe JSON fallback behind one adapter
  network/       WebSocket hub, command dispatch, presence and conflict handling
  net/           LAN interface detection, QR generation, join links, mDNS
  auth/          tokens, scopes and the optional operator PIN
  http/          REST API, exports, backup/restore, static client
src/frontend/    React + TypeScript (no UI framework): pages, components, live client
electron/        desktop shell (server bootstrap, menus, multi-monitor windows)
tests/           engine, bracket, concurrency, persistence, protocol, access and team tests
```

```bash
npm run typecheck    # strict TS for client and server
npm run lint         # oxlint
npm test             # the full suite
npm run check        # typecheck + lint + tests (what CI runs)
npm run icons        # regenerate PWA icons and build/icon.ico
npm run dist:win     # Windows installer
```

### 12.1 Cutting a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The [release workflow](.github/workflows/release.yml) takes over from there: it runs the same
checks CI runs (`ci.yml` watches branches only, so the tag commit is verified here), refuses to
build unless the tag names the version in `package.json`, builds the installer and publishes it
with the changelog section for that version as the release notes. Those notes come from
[`scripts/changelog-section.mjs`](scripts/changelog-section.mjs), which stops the release when
this version has no section of its own — usually because the entries are still under
`## [Unreleased]` — rather than publishing a download page with nothing on it. A tag with a
suffix, such as `v1.0.0-rc.1`, is published as a pre-release so it never becomes *Latest*. To
retry a run that failed half way, use **Re-run all jobs** on the workflow run: it re-uses the
same tag instead of creating a second release.

See [docs/LINTING.md](docs/LINTING.md) for the lint rules and why no whole-file
formatter is used, and [CHANGELOG.md](CHANGELOG.md) for what changed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow, the event/delta protocol
and the extension points.

---

## License

MIT.
