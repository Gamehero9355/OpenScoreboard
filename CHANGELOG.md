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

- **The pause notice on a field's screen shows that field's game.** "PAUSE" on its
  own told the hall that the game stopped and nothing else — and a hall waiting
  for the teams to come back is exactly the moment the people in it want to know
  where the game stands. The pause screen now shows **the game that is being
  played**: the two teams, the live score between them, and each team's place in
  the table it belongs to, with its record underneath. It is the game on *that
  display's* field, because two fields run two groups in parallel and the other
  group's race is not the race the people in front of this screen are watching.
  Not the whole table either: a break lasts a couple of minutes, and the other
  teams in the group are not what the room is asking about. The standing is the
  server's own ranking, recomputed after every result — nothing is counted on
  the projector. A knockout has no groups, so the tournament table stands in
  for them. The notice, the countdown and the game are one centred picture
  rather than a notice at the top of the wall and a game floating in the middle
  of it, and the sizes answer to the screen's height as well as its width — a
  projector is wide and short, and a picture scaled to the width alone leaves
  the wall half empty.

- **The results list no longer puts a finished game between two running ones.**
  The list was sorted by one timestamp, but the two kinds of game carry
  different ones: a finished game is dated by when it *ended* and a running one
  by when it *started*. A game that started before another ended therefore sank
  below it, and a game that ended between two running ones landed between
  them — so the games on a field were scattered through the list instead of
  being together at the top of it, which is where the page has always meant to
  put them. The list is now ordered by what each game *is*: **the games being
  played right now at the top, then the games waiting to be played, and the
  games that have been played at the bottom** — the sheet read from the live
  end of the tournament back to where it started.

- **Each game shows the score it had at the break, beside its final one.** A
  result is reported as its two halves as well as its final whistle, so the
  results tab now prints "5 : 3 (2 : 1)" — the bracket is the score at
  half-time, in the dimmer weight, so the final one stays the headline. The
  half-time score is kept by the engine when the match reaches its break, by
  whichever way it got there (the clock running out or the host calling it), so
  a game that was called early reports the score it really stood at rather than
  a number derived from a clock that never ran out. A game that finished 0 : 0
  also shows its result now: a goalless draw that happened is not the same as
  a fixture that was never played, and the results tab used to leave the first
  one blank.

- **The break between the two halves counts itself down.** A match in two halves
  stops at its break, and until now the pause had no clock of its own: the match
  clock was stopped at zero and the hall saw a "PAUSE" notice with nothing on
  it. The break now starts a countdown of two minutes — the length the host
  sets in *Settings → Scoring → Clock*, so a hall can make it one minute or
  five — and it runs on the wall under the PAUSE headline, on the host's field
  card and on the operator's phone, which is where the people waiting for the
  teams to come back are looking. The countdown **stops at zero** rather than
  starting the second half by itself: the teams have to be back on their feet
  first, and that is the host's call — the same rule the app already follows
  when a match clock runs out. Ending the pause early is the *Start second
  half* press, which is there and now has a clock to cut short. The countdown
  is an anchor like every other clock in the app: the server publishes the
  moment the break ends and each screen counts down on its own.

- **A field's screen says PAUSE while its match is at the break.** A match in two
  halves stops at its break — by the clock running out, or by the host calling
  it — and the hall has to be told that the game stopped, so the field's own
  screen puts the pause notice up for the duration of the break. The score
  board comes back by itself when the second half starts, because the screen
  was never changed: only what is drawn on it, so the rule cannot leave a field
  stuck on the pause notice — a match that is cancelled, finished or taken off
  the field is no longer at the break. A screen the host put there on purpose
  — the wall clock, the club crest, the tables — keeps that picture: the break
  does not take over a screen the host chose. The combined display shows every
  field at once and therefore never takes one field's break onto the whole
  wall, because the other field may still be playing. The host's console says
  the same thing at the same moment: the lit tile and the "now shows" line name
  the picture that is on the wall, not the setting behind it, so the switch is
  visible from the desk without looking at the projector. The break never
  writes to the setting, so it cannot leave a field on the pause notice — and
  a message typed during the break is saved against the screen the field is
  *set* to, so the board still comes back when the second half starts.

- **The host can call the break without ending the match.** A match in two halves
  reaches its break by itself — the clock runs out, the board says *Halftime*, and
  the second half starts on the next press. But a hall decides when the break
  comes: the coach waves the teams over early, the second half has to start
  before the first one has run its full length, or the hall simply wants the
  break now. **End 1st half** sits next to *End match* on the host dashboard and on
  the operator's phone, and does only that: the match goes to the break, the clock
  on the wall reads zero — exactly as it does when the clock runs out on its own —
  the score is kept, and the match is **not** over: *Start second half* puts the
  second half on with a full clock of its own. The
  button exists only while the first half is under way. A match in one half has no
  break to go to, and the second half is the last period of the match, so ending
  it is ending the match — which *End match* does, with the winner still to be
  decided. Nothing about the automatic break changed: the clock reaching the end
  of a period still stops the clock and puts the match at halftime on its own.

- **The clock on the field operator panel can be set by typing, not only by
  the minute.** −1m and +1m reach the lengths a hall plans for, but not the ones
  it decides on mid-event — a shortened half because the next group is already
  warming up, a longer one because a decision has to be settled. While the time
  is stopped the clock itself is the button: tap it and the number becomes a box
  (`6` for six minutes, `6:30` for six and a half), Enter saves, Escape cancels.
  The box holds the time the field **still has**, so it opens on exactly the
  number already on the wall — retype 8:56 and it stays 8:56, type 4:00 and the
  clock reads 4:00 — and never turns a half-way clock into a full one the moment
  it is touched. (An earlier pass prefilled the length of the half, which made
  the box jump from 8:56 to a full 9:00 on open: the first thing the control did
  was contradict what it had just shown.) A number that cannot be read leaves the
  box open and flagged instead of closing on a length nobody meant, and the box
  closes by itself if the match on the field is swapped or the time starts
  again, so a draft typed for one game can never land on the next. Once the time
  runs the clock is plain text again, so nothing can move the ground under a
  running game. The two stepper tooltips now say "half" too, which is what they
  have always moved.

- **Each field display can now show something different.** Every playing field
  owns its TV page (`/display/1`, `/display/2`, ...), and the host dashboard
  carries a console for them: the console edits the screen of the field the
  host has open, so a tap cannot land on the wrong field and the other field's
  TV is no longer out of reach, and a field operator's display dialog switches
  their own field's TV (switching another field's is refused). Per-field choices
  fall back to the combined value until set, survive restarts and backups, and a
  TV that reconnects lands on the right screen.

- **The projector can be switched between the scores and five other hall
  screens, from either dashboard.** The display has always drawn one thing: a
  flip-score board per field. Between games a hall needs the projector to say
  something else — that the event is paused, whose crest this is, what the clock
  says, where everyone stands, and what is being played next — and the only way
  to get that was to point a laptop at it. The host's side rail and the field
  operator's header now carry a six-way switcher (Scores, Pause, Logo, Clock,
  Standings, Schedule), and the pause and logo screens carry one optional line
  the host types. The choice is an ordinary settings value, not a second
  channel: every screen follows it, and a projector that reconnects lands on the
  right screen. Operators are allowed to switch it, because the person who can
  see the match has gone to half-time is the operator at the field and walking
  to the desk to put "Pause" on the wall is the friction this removes;
  `display.setScreen` is an operator command that writes the settings slice.
  The score board is the default, so a hall that never touches the switcher sees
  exactly what it always saw.

  **The switcher itself was rebuilt, because the names were not enough.** It was
  a native dropdown in the host's side rail: closed by default, so all six
  possibilities sat behind one click, and the six words — "Tabellen",
  "Spielplan", "Spielstand" — are the sort of thing a volunteer cannot tell
  apart before they have seen the projector. The field that was about to change
  was named in faint 12px capitals above the dropdown, and only the field whose
  tab was open could be reached at all. The console now shows the pictures: one
  tile per screen, each carrying a wireframe of what that screen looks like on
  the wall — two score panels and a clock for the board, a wide slab for the
  pause notice, the club crest, the clock face, the table with its header band,
  the running list with its result boxes — beside the screen's name, so the
  choice is made by recognising the screen rather than by trusting a word.

  **The console answers two questions, and it keeps them apart.** "Which field?"
  and "which screen?" were the same kind of square button in the same
  three-column grid, so a two-field hall showed three chips above six tiles and
  the whole panel read as a 3 × 3 box of buttons: the host could not tell at a
  glance which row changed the field and which changed the picture on the wall.
  The field is now a row of round pills under a *Field* label, the screen a grid
  of picture tiles under a *Screen* label, and a line between the two says what
  is on the wall right now — *Field 1 now shows Pause* — so "what is up there"
  and "what I am about to put there" can never be mistaken for one another.

  **The console edits the field the host is on, and says which one that is.**
  The dashboard already answers the field question: the tab at the top of the
  page is the field the host is working on. So the console does not ask it a
  second time — it offers that field and, as the only other choice, *All
  fields*, which puts every TV on the same picture in a single tap (the move a
  host makes when the hall pauses for the presentation and again when it
  starts). The field row follows the tab, and *All fields* does not follow the
  host to the next field: a tap on a screen tile has to change the field the
  host is on, or a tile meant for one field would quietly change both. Fields
  that disagree say so and name each field's picture instead of lighting a tile
  that means nothing. A refused command is now said out loud rather than dropped
  in silence, so a screen that did not move says why. The field operator gets the
  same tiles with bigger pictures and labels, because there is one field to
  choose and the phone is the only thing in the hand.

- **A tagged version publishes its own Windows installer.** Until now the installer only
existed as a build artifact attached to a workflow run, which expires after 30 days and is
only reachable from the Actions tab; getting one meant a source tree, Node.js and
`npm run dist:win`. Pushing a tag (`git tag v1.0.0 && git push origin v1.0.0`, README §12.1)
now builds it and publishes it as a GitHub Release. The workflow runs the same checks CI
runs, because `ci.yml` watches branches and a tag commit would otherwise never be tested,
and it refuses to go on unless the tag names the version in `package.json` — a release
labelled `v1.2.0` that contains a 1.1.0 installer is worse than no release, and the filename
cannot show it. The release notes are the changelog section for that version, extracted by
`scripts/changelog-section.mjs`; a missing or empty section stops the release instead of
publishing a download page with nothing to read, which is what tagging with the entries still
under `## [Unreleased]` used to produce. A suffixed tag such as `v1.0.0-rc.1` is marked as a
pre-release so it never becomes *Latest*. Publishing uses the runner's own `gh`, so no
third-party action is trusted with a token that can write to the repository.

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

- **The two group tables in the 10-team tournament tree are league tables now,
  not two columns of numbers in a wide box.** The card that holds a group is as
  wide as the panel it sits in, and five rows of names stretched across it left a
  void the eye read as a mistake: the goal difference and the points sat in the
  far corner, and the strip above them named only those two, so the table looked
  like a layout that had given up halfway across. The width now carries the
  group's own figures — **played, won, drawn, lost, goal difference and points**,
  the same columns, in the same short labels (MP, W, D, L, GD, PTS) and with the
  same tooltips, as the official table on the Standings page, so the two read as
  one table at two sizes. The header strip names every column across the whole
  width, the position is a plain label in the table's own index column instead of
  a filled chip that read as a button, and the two squads that go through carry
  the mark on the position *and* on the points — the position is what a volunteer
  is told, the points are what they check. The table keeps the width its labels
  need and the card scrolls it sideways on a phone, the way the official table
  does; on the hall screen and the host's laptop there is nothing to scroll.
  Nothing else about the tree moved: same panels, same cards, same final-phase
  ladder, same position wires, same data.

- **The Platz-Bedienung is a referee slate that fits the device in your hand, not a
  stretched phone screenshot on a PC.** The old layout was one centred 860px
  column whose player cards flexed to fill whatever height the window offered, so
  the same empty rectangle sat inside each card on every screen — a phone had a
  void between the score and the +1/+2/+3 row, a laptop had two enormous blank
  boxes, and a phone held sideways cut the transport off below the fold. Bands are
  now sized by their content and centred, so leftover height becomes breathing
  rhythm. A wide screen (from 1180px) grows the main column and adds a right rail —
  the same side, and the same width class, as the host dashboard's — carrying the
  keyboard legend permanently instead of behind a toggle, plus the next ready
  match; the rail collapses behind the existing toggle on narrow screens. A short
  landscape becomes a two-column compact slate (cards left, clock and transport
  right, 46px keys), and short portrait windows tighten instead of scrolling. The
  field name and round clip instead of wrapping mid-word, the header keeps its
  badge cluster on one line, and **Undo/Redo are real buttons now** — the operator
  spec always listed them, but they existed only as the U and R hotkeys, which a
  phone in one hand cannot press. Nothing else moved: same routes, same commands,
  same 44px floor, same dark/light themes, same mark-plus-label states.

- **On a PC the Platz-Bedienung now fills the screen instead of floating in it.**
  The first pass left the wide layout as a centred island: the bands stopped at
  roughly two thirds of the window height, the rail panels floated in the void
  beside them, and a 1920px monitor showed two thirds empty screen. The console now
  takes the viewport. The clock band grows to absorb the height the cards do not
  need — a tall bordered well with the largest numerals on the screen and −1m/+1m
  centred beside them — and the rail gains a third panel with the match's own
  scoring log (time, player, delta, running score, newest first), the same rows the
  host's field card already shows for the same match, so the desk operator can see
  what was scored and when without leaving the operator screen. The panel absorbs
  the rail's leftover height and scrolls internally; below 1180px the rail stays
  behind the existing toggle and carries all three panels with it. Tall phones
  (701–860px) compress only their rhythm so a hint line can never push a control
  off the screen, the lock and read-only panels flow inline instead of stacking in
  a short landscape, and read-only sessions sit on one screen in both orientations.

- **The documented Node floor is 22.12, up from 22.5.** The floor is set by npm, not by
  the app: Node 22.5 to 22.11 bundle an npm that cannot install this project (below), so
  the version the README asks for, `engines.node` and the launcher's own check all say
  22.12 now, and `Start-Scoreboard.bat` says why when it finds something older. 22.12 is
  also the oldest release `oxlint` accepts, which is what the install warning on 22.5 was
  about.

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

- **The links under the QR codes on the start page were folded over five and nine
  lines.** A URL is one long word, so a browser breaks it wherever it runs out of
  room — through a hostname, through a token — and the address under each QR code
  in the gallery came out as a wall of fragments: a link with the host's token in
  it took **nine** lines, and the tile it sat in grew taller than the screen it
  was on. Three things changed. The address now breaks at the places a person
  would break it — after the scheme, after each path segment, before the
  fragment — and never mid-word. The gallery asks for tiles twenty rem wide and
  takes as many as fit, so the narrow rail gets one roomy column instead of two
  crushed ones, and the address has the tile's whole width with the *Copy link*
  hint underneath it rather than stealing a fifth of the row. And the address in
  a tile is one or two lines: the host's own link, the longest of them, is two.
  The side rail is no longer than it was — the tiles lost more height to the
  shorter addresses than the single column cost. The same component is used for
  the QR dialog on the host dashboard and for each field's operator code, and
  both are fixed by the same change.

- **The league's tournament tree was laid out around a phase band that was twice
  as wide as the groups under it.** A phase's groups are lanes that *stack*, one
  under the other, but the band's width was the **sum** of their widths: with two
  groups the "Group stage" header stretched over twice the space the groups
  occupied, and the next phase — the final round — stood a whole band's worth of
  nothing further to the right. The band is now as wide as its widest lane, the
  lanes are centred in it, and the tree closes up: a two-group Radball league is
  a third narrower on the poster than it was, and the final round sits where it
  belongs, next to the group stage it is fed by. A group with fewer fixtures
  than its neighbour no longer hangs off the band's left edge.

- **The qualification chips did not line up with the fixtures they came from.**
  A chip is the leaf a team's path leaves the tree by, and it was drawn across
  the lane's whole width — 46px further left than the fixtures above it, reaching
  into the round gutter the labels live in. A chip now starts and ends where the
  fixtures it qualifies from start and end, so "these teams are through" is
  read off the same column as "these are the games".

- **The round tick in a lane's gutter was glued to the lane's own border.** The
  gutter is 46px wide and the tick was drawn at the lane's very edge, 18px from
  the fixtures it labels, while the lane's header sat 12px in. The tick's box
  now comes from the layout, like everything else on the poster, and sits in the
  gutter where the layout says the gutter is.

- **The Final lane said "Final" twice.** A lane whose header already names its
  single round — the Final lane is both — drew a round tick that repeated the
  header's own word, and kept a 46px gutter for it. The comparison now ignores
  case and works on the meaning rather than on the two strings, because the
  engine writes its round names in English ("Final") and the catalogue's name
  for the final is translated ("Finale") — so the German tree said "Finale" over
  a gutter that said "Final". Such a lane now draws no tick, and is exactly as
  wide as the match it holds.

- **The champion plate sat flush against the right edge of the poster.** Every
  other element on the poster keeps a margin; the crown, being last, had none.
  It keeps the poster's own padding now.

- **Panels in the side rail were cut off at the bottom instead of scrolling.** The
  rail is a flex column with a height limit and its own scrollbar, and its
  children were free to shrink — so when the column was taller than the rail,
  the panels were squeezed to fit instead of the rail scrolling, and a panel
  hides its own overflow: the bottom rows of the field list, the completed
  results and the activity feed were simply gone, with nothing to say so. On the
  home page the join card and the QR gallery were cut the same way. The rail's
  panels now keep their height and the rail scrolls, which is what its
  scrollbar was always for: a panel the host has to scroll to is a panel they
  can read whole.

- **The two team cards on a wide field operator panel sat in the left half of
  the screen.** The cards carry `flex: 0 0 auto`, which is what a stacked phone
  layout wants — each card then fills the column. Once the layout put them side
  by side on a landscape screen the same rule shrank both of them to whatever
  their own content needed, so a pair of name-width cards huddled at the left
  edge while the clock panel underneath spanned the full width and the right
  half of the top band stayed empty. The two cards now share the row, each
  taking half of it, so the pair is exactly as wide as the panel below and the
  +1/+2/+3/− keys grow from a name's width to the room they were given. A long
  club name wraps inside its half rather than pushing the row wider than the
  panel it is meant to match. Nothing moves on a phone, where the cards are
  stacked and already filled the width.

- **The projector's seven-segment numbers stood open at every corner.** The
  single-field board draws its score and clock as authored segment geometry, and
  the segment offsets were still the ones for a 0.5em-wide digit with a 0.16em
  stroke. The digit box has since grown to 0.58em with a 0.1em stroke, so the
  horizontal bars stopped about two thirds of a stroke short of the verticals and
  left a 17px diagonal gap at each corner of a 0 or an 8: at projector scale the
  outer strokes of a number floated free of its top and bottom bars, which reads
  as a broken glyph rather than a seven-segment digit. Every edge is now derived
  from `--segment-thickness` — a bar's pointed end reaches the centre line of the
  bar it meets and each taper is half a stroke long, so the two 45-degree edges
  fall on one straight line and the mitre closes — which holds at any digit size
  or stroke weight. The digit box, the stroke weight and the segment style are
  unchanged. Closing the corners also puts ink on the digit box's own edges, so
  the gap between glyphs became the entire clearance between two numbers and
  neighbouring digits read as one run of bars; that gap goes from 0.08em to
  0.12em, and the clock's column (which exists to hold a five-glyph readout at
  its own display size) follows from 460px to 480px so the wider clock keeps its
  margin instead of ending up 5px off the column rules at 1920x1080. That left
  each number as one unbroken run of bars — how a solid glyph reads, not how a seven-segment
  one does. Every bar therefore retracts `--segment-gap` (`--segment-thickness /
  10`) at both ends, along its own axis, which splits each shared mitre line into
  two parallel edges with 0.014em of background between them — about 3px on a
  1080p score and 1px on its clock — while the digit box, the stroke weight, the
  digits' outer ink bounds and the chamfered outline stay exactly where they
  were.

  Verified by
  measuring the rendered segments and reading back the corner pixels in a
  headless browser at 1920x1080, 1600x900, 1366x768, 1280x720, 1024x768 and
  390x844, with both a single-digit and a two-digit score, and by reading the
  luminance profile across all six joints of a fully lit 8 — no background at any
  lit joint before the hairline, a 3px dip after it.

- **Hurried −1m taps silently shortened both halves, with no way back.** The
  operator's −1m/+1m steppers moved the *whole* match, so each tap shortened
  the half on screen by only thirty seconds -- inviting repeat taps until a
  2x7min ELITE match played 4:30 halves -- and Reset kept the drifted lengths
  while zeroing everything else, so the shortened halves resurfaced as a full
  clock. The steppers now move the half on screen by a full minute, and Reset
  puts a Radball match back on its configured length (age class / reduced
  time; decision matches get their single half back). Generic knockout matches
  keep their durations, which a host may have customized deliberately.
  `tests/radball-timers.test.ts` pins all three behaviours.

- **The Turnierleitung hid things, cut things off and lied about time.** Six
  defects, all found by driving the real dashboard through a headless browser at
  five viewports and reading the boxes back: the topbar's nav strip shrank below
  its items and silently clipped them — on a phone five of the nine destinations
  (Bracket, Results, New tournament, Teams, Settings) were unreachable without
  knowing to scroll an unmarked strip; the side rail's rows let their short
  labels shrink first, so field names read `FIEL...` and activity timestamps
  `15:46:...`; the queue squeezed "Team Charlie vs Team Alpha" into 70 pixels on
  a phone, mid-word; the copyable LAN address trailed off into an ellipsis
  instead of showing what the host has to read out loud; the statusbar wrapped
  with `state #` and the update age stranded at the *left* edge under a right-
  hand row; and `relativeTime` passed its age to `Intl.RelativeTimeFormat` with
  the wrong sign, so every age in the app read as a *future* time — the status
  bar reported "updated in 40 minutes" for a state last changed 40 minutes ago,
  in both languages. The nav now drops to its own full-width row below 1180px
  and becomes the icon strip on a phone (every destination one tap away, the
  name kept as label and tooltip), compact rows let only the flexible middle
  shrink, the queue's actions take their own line under the match on a phone,
  addresses wrap in full, the status bar travels as two groups so a wrapped line
  lands on the right, and the sign is pinned by `tests/util.test.ts`. A seventh,
  dev-only defect: the dev client never proxied `/logos`, so every crest came
  back as the SPA's HTML and drew a broken image in front of every score.

- **A copied Platz-Bedienung link was a read-only session, while the QR code
  next to it was not.** Scanning the QR landed on `/field/<n>#t=…` and granted
  operator rights; copying the link beside it silently dropped the fragment, so
  the pasted URL opened `/field/<n>` as a spectator and every score button was
  gone. The copy button and the print dialog's "Open" button now hand over the
  exact URL the QR encodes, token included — one link, one permission, whatever
  device it reaches. The token still travels only in the fragment, which no
  browser sends to a server, and the app still strips it from the address bar
  after storing it on that device; spectator links never carry one at all. If the
  operator PIN is set, the copied link asks for it exactly like the QR does.

- **CI failed on every push because the install silently did nothing.** Node 22.5 bundles
  npm 10.8.2, and that npm dies part way through `npm ci` — "Error: Exit handler never
  called!" — yet exits 0, having never written `node_modules/.bin`. The install step stayed
  green while the next step failed with `tsc` "is not recognized", which names the one part
  of the toolchain that was fine. The workflow now runs Node 24, which completes the same
  install with 132 links, and a new step fails by name if `node_modules/.bin` ever comes up
  empty again. Node 24 also provides `node:sqlite` without a flag, so CI exercises the
  storage driver the app actually ships instead of the JSON fallback.
- **`flush()` could return before the audit log was on disk.** Event appends are fired
  without being awaited so that a score change never waits for a disk write, and with
  SQLite the write happens synchronously inside that call — which is exactly why the gap
  was invisible. The JSON driver queues the write instead, so `flush()` returned with the
  last `MATCH_STARTED`, `SCORE_UPDATED` and `MATCH_FINISHED` entries still in flight: the
  persistence test read eight events where twelve existed, and the quit path's "flushed"
  backup could miss the tail of the audit log. `flush()` now awaits the append queue too.
- **The SQLite driver test failed on a runtime the app supports.**
  `uses SQLite when the runtime provides it` asserted SQLite unconditionally, but Node 22.5
  to 22.12 keep `node:sqlite` behind `--experimental-sqlite`, and there the app deliberately
  falls back to the JSON driver. The check now skips on those runtimes, the way the
  durability tests already did, instead of failing a supported configuration.
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
  documented minimum, naming the version it found rather than letting an older runtime
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

- **A queue row's coloured ring lost a piece of its outline when the browser was
  zoomed below 100%.** At 90% and 80% a CSS pixel is smaller than a device pixel,
  and the 1px `border-color` ring that marks a READY or on-field match is snapped
  onto a grid it cannot fill: measured at 0.8 device pixels, the *bottom* run of
  the ring rounded away to roughly a quarter of its ink on the unlucky rows while
  the left and right runs kept most of theirs, so the outline read as broken at
  exactly the corner where the eye checks it. The ring is now drawn twice — the
  border, plus a `box-shadow` ring one pixel inside — but only under
  `@media (max-resolution: 0.99dppx)`: the second band snaps from a different
  phase and holds wherever the first one faded, taking the bottom run from 27% of
  its ink back to 75% at 80% zoom (and from 23% to 74% at 67%), on the software
  raster and on ANGLE alike. At 100% and above the query is false and the row's
  paint is byte-for-byte what it was.

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
