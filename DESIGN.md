---
name: Tournament Scoreboard
description: Offline-first local tournament control — scorer's-table visual system for hall, phone, and projector.
colors:
  primary: "#2f6fe4"
  live: "#3ddc84"
  amber: "#f5b83d"
  info: "#62b2ff"
  danger: "#ff7070"
  table-night: "#0e1216"
  table-elevated: "#141b22"
  sheet: "#172027"
  sheet-deep: "#1d2832"
  court-line: "#2b3644"
  court-edge: "#566b83"
  ink: "#f2f5f8"
  ink-dim: "#a9b4c4"
  ink-faint: "#8d99ac"
typography:
  display:
    fontFamily: "system-ui, 'Segoe UI Variable Display', 'Segoe UI', sans-serif"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
  body:
    fontFamily: "system-ui, 'Segoe UI Variable Text', 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 750
    letterSpacing: "0.08em"
  numeral:
    fontFamily: "system-ui, 'Segoe UI Variable Display', 'Segoe UI', sans-serif"
    fontWeight: 800
    fontFeature: "'tnum' 1, 'lnum' 1"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "34px"
  badge-live:
    backgroundColor: "{colors.sheet-deep}"
    textColor: "{colors.live}"
    rounded: "999px"
    padding: "2px 12px"
---

# Design System: Tournament Scoreboard

## Overview

**Creative North Star: "The Scorer's Table"**

A volunteer sits at the scorer's table in a dim sports hall: laptop under gym lights, projector on the far wall, referees' phones in hand. The interface is the table itself — dark slate sheets with court-line borders, paper-white ink, and signal colors reserved for what is live, expiring, or wrong. Nothing decorates; everything is positioned to be read at 2 metres on a laptop and 10 metres on a projector while holding a clipboard.

Density is professional but calm: two field sheets side by side, a start-list queue rail, a wall-poster bracket below, and a table-edge statusbar. Motion is a single authored moment — scores and clocks update with weight, buttons answer with depth — never scattered entrances. The system is offline by law: system faces only, no webfonts, every asset bundled.

**Key Characteristics:**
- Dark slate first, paper scorebook light second — chosen from the hall, not the category.
- State is always mark plus label, never hue alone.
- Tabular measurement numerals for every score, clock, and timestamp.
- Table zones with full borders and offset-plus-blur depth — no edge-only accents.
- System type stacks; mono only for measurement.

## Colors

Restrained hall palette: slate neutrals carry the surface, one live green and one clock amber carry meaning, blue carries brand and information.

### Primary
- **Table Blue** (#2f6fe4): Brand and primary actions. Its dark-theme white-ink contrast clears 4.5:1. Host "Assign", "Auto-assign", active nav and segmented selections. Overridable via Settings custom brand color.
- **Live Green** (#3ddc84): What is running or leading. Field markers, leading score sides, display rows, RUNNING states, save confirmation. Light theme: #0e7a48.
- **Clock Amber** (#f5b83d): Attention and time. Paused clocks, warnings, accent badges, current-bracket outline. Light theme: #8a5600.

### Secondary
- **Signal Blue** (#62b2ff): Information and readiness. READY states, field assignment links, focus rings with text. Light theme: #0b63ce.
- **Fault Red** (#ff7070): Danger and overtime. Finish actions, destructive buttons, expired clocks, errors. Light theme: #b42323.

### Neutral
- **Table Night** (#0e1216): App ground, dark default.
- **Table Elevated** (#141b22): Topbar, modals, toasts, operator clock.
- **Sheet** (#172027): Panels, field cards, bracket matches.
- **Sheet Deep** (#1d2832): Wells, rails, secondary surfaces.
- **Court Line** (#2b3644): Hairline borders and dividers.
- **Court Edge** (#566b83 dark, #8292a6 light): Strong borders for sheets and inputs with at least 3:1 non-text contrast.
- **Paper Ink** (#f2f5f8): Primary text.
- **Dim Ink** (#a9b4c4): Secondary text.
- **Faint Ink** (#8d99ac): Labels, timestamps, meta.

### Named Rules
**The Mark-Plus-Label Rule.** No state is carried by hue alone; every live, paused, ready, or finished mark pairs a dot or edge with an uppercase label.
**The Two-Signal Rule.** Green means live or leading, amber means time or attention. Nothing else borrows them for decoration.

## Typography

**Display Font:** system-ui, Segoe UI Variable Display (with system-ui fallback)
**Body Font:** system-ui, Segoe UI Variable Text (with system-ui fallback)
**Label/Mono Font:** Cascadia Mono, Consolas, ui-monospace (measurement only)

**Character:** Workhorse system grotesks with tight, heavy numerals. Headings are compact and uppercase where they label zones; scores and clocks are extra-bold tabular figures with negative tracking, except the single-field board's authored seven-segment readouts.

### Hierarchy
- **Display** (800, clamp(2.8rem, 9vw, 7.5rem), 0.9): Combined projector score numerals; single-field boards use segment readouts up to 11rem.
- **Headline** (800, clamp(1.1rem, 2.6vw, 2.2rem), 1.05): Field names on boards and cards, uppercase.
- **Title** (750, 0.875rem, 1.2, +0.08em uppercase): Panel and zone labels.
- **Body** (400–650, 0.875rem, 1.45): Controls, queue rows, dialogs. Reading passages cap at 70ch.
- **Label** (750, 0.75rem, +0.08em, uppercase): Meta, timestamps, badges, table headers.
- **Numeral** (800, tabular lining figures, tnum+lnum): Every score, clock, and count; single-field score and clock readouts use semantic values inside seven-segment geometry.

### Named Rules
**The Tabular Numeral Rule.** Scores, clocks, queue indices, and timestamps set tabular lining figures; proportional figures never appear in measurement. The single-field score and clock are the explicit exception, using authored seven-segment geometry with accessible semantic values.
**The Mono-for-Measurement Rule.** Monospace is reserved for timestamps, IDs, URLs, and start-list indices — never as a technical costume.

## Layout

Fixed table zones that never move between states: enamel topbar plaque (60px, sticky, blurred), centred page column (max 1720px, 16px gutters), host grid of two field sheets plus 360px sticky side rail (queue, completed, activity), bracket poster filling remaining height, table-edge statusbar. Display boards are full-viewport flip-score sheets with padded grids. Single-field boards use a three-zone arena: Team A left, clock centre, Team B right; the combined display retains its stacked row layout. Operator is a centred 860px referee slate. Spacing rhythm is 4/8/12/16/24/32/48; groups stay tight (8–12px), zones separate generously (16–24px), and headings carry more space above than below. Breakpoints: side rail stacks below 1180px, fields stack below 860px, display split stacks below 900px, single-field boards stack vertically below 760px, operator players rowize in landscape above 720px.

## Elevation & Depth

Hybrid: tonal layering for rest, offset-plus-blur shadows for lift. Sheets sit on court-line borders with a close offset shadow plus a soft ambient blur; hover lifts with a deeper blur; modals and toasts use the pop shadow.

### Shadow Vocabulary
- **Sheet Rest** (`0 1px 2px rgba(0, 0, 0, 0.45), 0 8px 24px rgba(0, 0, 0, 0.28)`): Panels, field cards, bracket matches, banners, statusbar.
- **Lift** (`0 2px 4px rgba(0, 0, 0, 0.4), 0 10px 24px rgba(0, 0, 0, 0.22)`): Button and card hover.
- **Pop** (`0 2px 6px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.35)`): Modals, toasts, win panel.
- **Well** (`inset 0 1px 3px rgba(0, 0, 0, 0.3)`): Clocks, inputs, nav rail, score clock pills.

### Named Rules
**The Offset-Plus-Blur Rule.** Every shadow carries an offset and a soft blur; zero-offset halos and zero-blur block shadows never appear.

## Shapes

Chunky table geometry: 6px for small controls, 10px for buttons/inputs/cards, 14–18px for sheets/field cards/operator cards/win panel, 999px for badges/state pills/switches. Borders are full 1px court lines (2px for field headers and display board headers); dashed borders mark idle or third-place states only. No edge-only accents, no hard offset block shadows, no decorative geometric masks; seven-segment glyphs are functional display geometry.

## Components

### Buttons
Table switches with depth. **Shape:** gently rounded (10px, 12–14px large). **Primary:** Table Blue gradient, white ink, 36px height. **Hover:** lifts 1px with deeper blur; active presses 1px down. **Ghost:** transparent, dim ink, no shadow; hover fills surface. **Danger:** transparent with red edge. Touch floors: 36px default, 44px large, 60px operator keys.

### Badges and Connection States
- **Style:** pill (999px), 1px full border, surface fill, dot plus uppercase label.
- **State:** live/warn/info/danger/accent/done map to signal colors; live dot pulses. Connection badge always pairs icon with Live/Connecting/Reconnecting/Offline text.

### Cards / Containers
Field sheets, panels, bracket matches, queue items, display rows. **Corner Style:** rounded 10–18px. **Background:** sheet gradients with surface-2 wells. **Shadow Strategy:** sheet rest, lift on hover. **Border:** full 1px court edge; leading/live states tint the full border with a soft glow, never a single-edge bar. **Internal Padding:** 16px panels, 16–24px field bodies, clamp-based display padding.

### Inputs / Fields
- **Style:** elevated dark wells, 1px strong edge, 10px radius, inset well shadow.
- **Focus:** info edge with 3px info halo; caret follows brand.
- **Error / Disabled:** red edge for errors; 45% opacity and no shadow when disabled. Placeholders meet contrast in faint ink at full opacity.

### Navigation
Topbar plaque with segmented rail: rail is a bordered well, items are 34px rounded tabs, active item fills sheet-deep with strong edge and rest shadow. Display view switchers are ghost buttons; operator transport uses 60px uppercase keys.

### Score and Clock
The signature component. Host, operator, and combined-projector scores set extra-bold tabular figures (up to 3.75rem host, 7.5rem combined projector) in score ink; leading sides gain a full live-tinted border with glow. Single-field boards replace the score glyphs and clock face with authored seven-segment readouts, a 2-digit minimum score, and the same score-ink/clock-amber signal colors. Combined-display clocks sit in bordered pills with inset wells; overtime turns red, paused turns amber, each with matching edge. Operator points reach 4.5rem with −0.04em tracking.

## Do's and Don'ts

### Do:
- **Do** keep every route, term, and feature working identically; this system is visuals-only.
- **Do** pair every color state with a label, dot, or edge so halls and projectors read it without hue.
- **Do** set scores, clocks, and timestamps tabular (tnum/lnum) at 700–800 weight, except the single-field board's seven-segment score and clock readouts.
- **Do** use full 1px borders with offset-plus-blur shadows for depth.
- **Do** honor Settings custom brand/accent colors and both dark and light/invert themes.
- **Do** keep 44px minimum targets (60px scoring keys) and visible focus rings.

### Don't:
- **Don't** use gradient text, glass decoration, edge-only accent bars above 1px, or hard block shadows.
- **Don't** use monospace or system display faces as a display voice; combined-display numerals come from the UI stack, while single-field readouts use authored seven-segment geometry.
- **Don't** add kickers/eyebrows above headings, section numbers, or cards of icon-plus-heading-plus-text as page structure.
- **Don't** invent testimonials, customers, benchmarks, pricing, or commercial claims.
- **Don't** fetch webfonts or remote assets; the venue WLAN is the only network.
