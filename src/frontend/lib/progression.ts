/**
 * The progression tree.
 *
 * A knockout and a league are two different things, and the previous answer --
 * rounds as columns for one, a teams-by-rounds grid for the other -- meant the
 * league never showed the one thing a hall actually asks about: *where is this
 * going?* A grid of every team's every result answers "how did it go", not
 * "who is through", and in a Radball competition the answer to the second
 * question is a genuine tree that the grid drew as more grid.
 *
 * So the league gets a real tree, and it is the tree the data already is:
 *
 *     group stage  ->  qualification  ->  final round  ->  champion
 *
 * - **Phases are bands**, left to right, in the order they are played.
 * - **Groups are lanes** inside a band, stacked. A round robin is not a
 *   branching structure, so a lane is honest: its fixtures sit in round rows,
 *   each row ticked with the round it belongs to.
 * - **A lane's output is its qualification** -- one chip per advancing team.
 *   Those chips are the tree's leaves: every wire in the competition leaves a
 *   chip and arrives at a card, so "Group A second place plays in the 3rd place
 *   match" is a thing you can *see*, not a thing you have to infer.
 * - **The crown** is the champion plate at the far right, fed by whatever
 *   actually decided the title: the final, or the leader of the last table.
 *
 * The whole thing is one `Poster`: absolute coordinates, no DOM measuring, one
 * source of truth for geometry. The knockout layout produces the same `Poster`
 * (see `BracketView.tsx`), so both competition shapes are drawn by one renderer
 * and read as one surface.
 */
import type {
  Match,
  RadballGroup,
  RadballPhase,
  StandingRow,
  TournamentState,
} from '../../shared/types';
import { isRealMatch } from '../../shared/matchUtils';
import { phaseViews, standingStatusLabel, type Translate } from './radball';
import { tr } from './i18n';

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** League match card. Fixed width, so every wire endpoint is exact. */
export const LEAGUE_CARD_W = 196;
export const LEAGUE_CARD_H = 68;
/** A lane's title strip. Exported so the stylesheet cannot drift from it. */
export const LEAGUE_LANE_HEAD_H = 34;

/** Gap between two fixtures of one round. */
const CARD_GAP_X = 10;
/** Gap between two round rows of a lane. */
const ROW_GAP_Y = 14;
/** Left gutter of a lane, where the round ticks live. */
const TICK_W = 46;
/** Gap between a round tick and the fixtures it labels. */
const TICK_GAP_X = 6;
const LANE_HEAD_H = LEAGUE_LANE_HEAD_H;
const LANE_PAD_X = 12;
const LANE_PAD_Y = 12;
const LANE_GAP_Y = 20;
/** A qualification chip: the leaf a wire leaves from. */
const OUT_H = 30;
const OUT_GAP_Y = 6;
/** Phase band header, and the gap the qualification wires need to breathe. */
const BAND_HEAD_H = 34;
const STAGE_GAP = 112;
const PAD = 20;
const GHOST_W = 330;
const GHOST_H = 104;
const CROWN_W = 250;
const CROWN_H = 96;

/* ------------------------------------------------------------------ */
/* Poster model (shared with the knockout layout)                      */
/* ------------------------------------------------------------------ */

export type BandTone = 'round' | 'stage' | 'final';

export interface PosterBand {
  key: string;
  title: string;
  meta: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: BandTone;
}

/** A round tick in a lane's left gutter. `y` is the row's vertical centre. */
export interface PosterTick {
  key: string;
  /** The tick's left edge, relative to the lane it belongs to. */
  x: number;
  /** The tick's width. */
  width: number;
  y: number;
  title: string;
  /** The round's own name, for the tooltip when the tick has to be shortened. */
  fullTitle: string;
}

export type OutputRole = 'qualified' | 'lead' | 'undecided';

/** A lane's output: who leaves this lane, and for where. */
export interface PosterOutput {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  teamId: string | null;
  rank: number | null;
  name: string;
  points: number | null;
  role: OutputRole;
  note: string | null;
}

export interface PosterLane {
  key: string;
  title: string;
  meta: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  ticks: PosterTick[];
  /**
   * The fixtures this lane holds, in poster coordinates.
   *
   * They are *also* listed on the poster, because a wire has to be told where a
   * card's edge is. Owning them here as well is what lets a lane render its own
   * fixtures as its children instead of leaving them floating beside it, which
   * is the difference between a tree and a grid of orphans -- and it is what
   * makes the printed tree read in order instead of printing every lane and
   * then every card.
   */
  cardKeys: string[];
  outputs: PosterOutput[];
}

export interface PosterCard {
  key: string;
  match: Match;
  x: number;
  y: number;
  /** Points this fixture awarded each side. League cards only. */
  points: [number | null, number | null] | null;
  league: boolean;
}

export interface PosterGhost {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  sub: string;
}

export interface PosterCrown {
  x: number;
  y: number;
  width: number;
  height: number;
  teamId: string;
  name: string;
}

export type WireTone = 'win' | 'lose' | 'qualify' | 'champion' | 'pending';

export interface PosterWire {
  key: string;
  d: string;
  tone: WireTone;
  /** The match or the table that produced this path is decided. */
  settled: boolean;
  /** The path arrives at the match the host has open. */
  live: boolean;
}

export interface Poster {
  width: number;
  height: number;
  cardWidth: number;
  cardHeight: number;
  /** Height of a lane's title strip. Zero when the poster has no lanes. */
  laneHead: number;
  bands: PosterBand[];
  lanes: PosterLane[];
  /** Every card on the poster, in poster coordinates. */
  cards: PosterCard[];
  /** `cards` by id, so a lane can render its own without a second copy. */
  cardsById: Map<string, PosterCard>;
  ghosts: PosterGhost[];
  crown: PosterCrown | null;
  wires: PosterWire[];
}

/* ------------------------------------------------------------------ */
/* Wires                                                               */
/* ------------------------------------------------------------------ */

type Port = { x: number; y: number };

type Box = { x: number; y: number; width: number; height: number };

/** Right edge of a box, at its vertical centre. */
function rightPort(box: Box): Port {
  return { x: box.x + box.width, y: box.y + box.height / 2 };
}

/** Left edge of a box, at its vertical centre. */
function leftPort(box: Box): Port {
  return { x: box.x, y: box.y + box.height / 2 };
}

/**
 * A cubic elbow from one box's right edge to the next box's left edge, the same
 * curve the knockout uses. Both ends are measured to a real edge, so a wire can
 * never float off the thing it is meant to join.
 */
function wire(from: Port, to: Port): string {
  const reach = Math.max(18, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
}

/* ------------------------------------------------------------------ */
/* Points                                                              */
/* ------------------------------------------------------------------ */

/**
 * The points a fixture awarded one side, or null while it is unplayed.
 *
 * Read from the server's ruleset rather than hard-coded: a level Radball match
 * is a legal draw worth a point to each side, and `config.drawPoints` is where
 * that lives. Printing the figure on the card is what lets the tree carry the
 * points story at all -- the full table stays on the Results tab.
 */
function awardedPoints(state: TournamentState, match: Match, side: 'A' | 'B'): number | null {
  if (match.state !== 'FINISHED' || !isRealMatch(match)) return null;
  const config = state.radball?.config;
  const win = config?.winPoints ?? 3;
  const draw = config?.drawPoints ?? 1;
  const mine = side === 'A' ? match.scoreA : match.scoreB;
  const theirs = side === 'A' ? match.scoreB : match.scoreA;
  if (mine > theirs) return win;
  if (mine < theirs) return 0;
  return draw;
}

/* ------------------------------------------------------------------ */
/* Drafts: what the tree is made of, before it has a place             */
/* ------------------------------------------------------------------ */

interface LaneDraft {
  key: string;
  title: string;
  meta: string | null;
  rows: { key: string; title: string; fullTitle: string; matches: Match[] }[];
  standings: StandingRow[];
  qualifies: number;
  /**
   * The lane's own header already says what its single round says.
   *
   * Such a lane draws no round tick: saying the same thing twice within one
   * line of sight is noise, not emphasis. It also gives the gutter back, so
   * the lane is exactly as wide as the fixtures it holds.
   */
  tickRepeats: boolean;
}

interface StageDraft {
  key: string;
  title: string;
  meta: string | null;
  lanes: LaneDraft[];
  /** The last band of the competition: drawn with the accent edge. */
  final: boolean;
}

/**
 * Fixtures grouped into round rows.
 *
 * The round *number* is the identity and the round *name* only titles the row,
 * because one round can carry several names at once: the final phase's ranking
 * matches all share round 900, and lumping them under one tick would file the
 * 3rd place match under a label that belongs to the 5th.
 */
function roundRows(matches: Match[], groupName: string | null): LaneDraft['rows'] {
  const rows = new Map<
    string,
    { key: string; title: string; fullTitle: string; matches: Match[] }
  >();
  for (const match of matches) {
    const key = `${match.round}::${match.roundName}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        title: shortRoundTitle(match.roundName, groupName),
        fullTitle: match.roundName,
        matches: [],
      };
      rows.set(key, row);
    }
    row.matches.push(match);
  }
  for (const row of rows.values()) row.matches.sort((a, b) => a.position - b.position);
  return [...rows.values()];
}

/** Fixtures in the order a hall plays them: round first, then the host's order. */
function sortFixtures(matches: Match[], state: TournamentState): Match[] {
  const created = new Map(state.matchOrder.map((id, index) => [id, index]));
  return [...matches].sort(
    (a, b) =>
      a.round - b.round ||
      a.position - b.position ||
      (created.get(a.id) ?? 0) - (created.get(b.id) ?? 0),
  );
}

function playedOf(matches: Match[]): number {
  return matches.filter((match) => match.state === 'FINISHED').length;
}

/**
 * A round tick has ~40px of gutter, so it cannot carry a full round name.
 *
 * Inside a group the round names are prefixed with the group ("Group A · Round
 * 2") and the lane header two centimetres above already says "Group A", so the
 * prefix is the one part of the string that repeats itself on screen. The full
 * name stays on the card and in the tick's title for anyone who hovers.
 */
function shortRoundTitle(roundName: string, groupName: string | null): string {
  if (!groupName || !roundName.startsWith(groupName)) return roundName;
  const rest = roundName.slice(groupName.length).replace(/^[\s·—–-]+/, '');
  return rest || roundName;
}

/** Played of total, the one progress figure every masthead shares. */
function stageMeta(matches: Match[]): string {
  const total = matches.filter((match) => match.state !== 'CANCELLED').length;
  return tr(total === 1 ? 'tree.stageMetaOne' : 'tree.stageMetaMany', {
    total,
    played: playedOf(matches),
  });
}

function groupMeta(group: RadballGroup, matches: Match[]): string {
  const cut =
    group.qualifies > 0
      ? tr('tree.topAdvance', { n: group.qualifies })
      : tr('tree.decidesTitle');
  const legs = tr(group.doubleRoundRobin ? 'tree.doubleRoundRobin' : 'tree.singleRoundRobin');
  return tr('tree.groupMeta', {
    teams: group.teamIds.length,
    legs,
    cut,
    played: playedOf(matches),
    total: matches.filter((match) => match.state !== 'CANCELLED').length,
  });
}

/**
 * Which lane a phase-level match belongs to.
 *
 * A phase holds matches that belong to no group: the final of a ranking-matches
 * final round is created with `groupId: null` so it is part of no table, and so
 * are the decision matches a tie creates. Without a lane of their own they would
 * fall off the tree, and they are the matches a hall cares most about.
 *
 * The three names are the lane's own title, so they are translated here rather
 * than on the poster; anything else falls back to the phase's own name, which is
 * server data the host typed.
 */
function orphanLaneTitle(matches: Match[], phase: RadballPhase, t?: Translate): string {
  const kinds = new Set(matches.map((match) => match.radball?.kind));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    const say = t ?? tr;
    if (only === 'final') return say('round.final');
    if (only === 'decision') return say('tree.playoffs');
    if (only === 'placement') return say('tree.placementMatches');
  }
  return phase.name;
}

/**
 * The one kind of match a phase-level lane holds, or null when it holds more.
 *
 * The final is the one kind whose lane is named after the match itself, so it
 * is the one kind whose lane header says what its round tick would say.
 */
function orphanLaneKind(matches: Match[]): string | null {
  const kinds = new Set(matches.map((match) => match.radball?.kind));
  if (kinds.size !== 1) return null;
  return [...kinds][0] ?? null;
}

/**
 * Whether a lane's own header already says what its round tick would say.
 *
 * The comparison is on the meaning rather than on the two strings: the engine
 * writes its round names in English ("Final") and the catalogue's name for the
 * final is translated ("Finale"), so a plain string comparison only ever
 * caught the English case and the Final lane kept a gutter that said "Final"
 * next to a header that already said "Finale".
 */
function tickRepeatsTitle(
  title: string,
  rows: LaneDraft['rows'],
  kind: string | null,
): boolean {
  if (rows.length !== 1) return false;
  const round = rows[0]?.title;
  if (!round) return false;
  if (round.toLowerCase() === title.toLowerCase()) return true;
  return kind === 'final';
}

/**
 * Every lane of the competition, grouped into one stage per phase.
 *
 * A tournament with no Radball model still has to draw something, so it gets one
 * stage and one lane of round rows. There is no qualification to wire in that
 * case, and the tree says so by having no wires.
 *
 * `t` is threaded from the component rather than read from context: this runs
 * before any JSX exists, and the band and lane titles are strings the poster
 * carries rather than renders.
 */
function collectStages(state: TournamentState, t?: Translate): StageDraft[] {
  const competition = state.radball;
  const all = sortFixtures(Object.values(state.matches), state);
  // A tournament with no matches has no tree. Without this the fallback below
  // would answer an empty state with an empty "Fixtures" band, so the two
  // builders would disagree about when there is nothing to draw.
  if (all.length === 0) return [];

  if (!competition) {
    const rows = roundRows(all, null);
    return [
      {
        key: 'fixtures',
        title: tr('tree.fixtures'),
        meta: stageMeta(all),
        final: false,
        lanes: [
          {
            key: 'fixtures:all',
            title: tr('tree.allFixtures'),
            meta: null,
            rows,
            standings: [],
            qualifies: 0,
            tickRepeats: tickRepeatsTitle(tr('tree.allFixtures'), rows, null),
          },
        ],
      },
    ];
  }

  const stages: StageDraft[] = phaseViews(competition).map(({ phase }) => {
    const stageMatches = all.filter((match) => match.radball?.phaseId === phase.id);
    const lanes: LaneDraft[] = [];

    for (const groupId of phase.groupIds) {
      const group = competition.groups[groupId];
      if (!group) continue;
      const matches = stageMatches.filter((match) => match.radball?.groupId === group.id);
      if (matches.length === 0) continue;
      const rows = roundRows(matches, group.name);
      lanes.push({
        key: `group:${group.id}`,
        title: group.name,
        meta: groupMeta(group, matches),
        rows,
        standings: competition.tables[group.id] ?? [],
        qualifies: group.qualifies,
        tickRepeats: tickRepeatsTitle(group.name, rows, 'group'),
      });
    }

    const orphans = stageMatches.filter((match) => !match.radball?.groupId);
    if (orphans.length > 0) {
      const title = orphanLaneTitle(orphans, phase, t);
      const rows = roundRows(orphans, null);
      lanes.push({
        key: `phase:${phase.id}`,
        title,
        meta: stageMeta(orphans),
        rows,
        standings: [],
        qualifies: 0,
        tickRepeats: tickRepeatsTitle(title, rows, orphanLaneKind(orphans)),
      });
    }

    return {
      key: `phase:${phase.id}`,
      title: phase.name,
      meta: stageMeta(stageMatches),
      lanes,
      final: phase.kind === 'final-round',
    };
  });

  return stages.filter((stage) => stage.lanes.length > 0);
}

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/**
 * A lane is as wide as its widest round, and every round in it is centred in
 * that width. Card width is fixed, so a wire can be told exactly where a card's
 * edge is without measuring anything in the DOM.
 */
function laneWidth(lane: LaneDraft): number {
  const widest = lane.rows.reduce(
    (max, row) =>
      Math.max(max, row.matches.length * LEAGUE_CARD_W + (row.matches.length - 1) * CARD_GAP_X),
    LEAGUE_CARD_W,
  );
  // Only a lane that draws a tick pays for the gutter. A lane whose header
  // already says what its round says draws none, and reserving the space
  // anyway left an empty margin beside its fixtures.
  return (lane.tickRepeats ? 0 : TICK_W) + widest + LANE_PAD_X * 2;
}

/** Height of a lane's round rows, gaps included. */
function rowsHeight(lane: LaneDraft): number {
  return (
    lane.rows.length * LEAGUE_CARD_H + Math.max(0, lane.rows.length - 1) * ROW_GAP_Y
  );
}

/**
 * How many outputs a lane has.
 *
 * A group that qualifies nobody still has a leader, and that leader is the last
 * thing between the fixtures and the title, so its table contributes one output
 * too. A group with no results at all contributes a single "not decided" plate
 * rather than nothing, so a wire has somewhere honest to point.
 */
function outputCount(lane: LaneDraft): number {
  if (lane.standings.length === 0 && lane.qualifies > 0) return 1;
  if (lane.qualifies > 0) return Math.min(lane.qualifies, lane.standings.length);
  return lane.standings.length > 0 ? 1 : 0;
}

function outputsHeight(lane: LaneDraft): number {
  const count = outputCount(lane);
  return count > 0 ? OUT_GAP_Y + count * OUT_H + (count - 1) * OUT_GAP_Y : 0;
}

function laneHeight(lane: LaneDraft): number {
  return LANE_HEAD_H + rowsHeight(lane) + outputsHeight(lane) + LANE_PAD_Y * 2;
}

/**
 * How wide a phase band is.
 *
 * The groups of a phase are lanes that *stack*, one under the other, so the
 * band is as wide as the widest of them. Adding their widths up instead made
 * the band twice as wide as everything under it: the phase's header stretched
 * over empty space, and the next phase was pushed a whole band's worth of
 * nothing to the right.
 */
function stageWidth(stage: StageDraft): number {
  // The pending final round has no lanes, so its band would measure zero and
  // collapse to nothing. It is sized by the plate it holds instead.
  if (stage.lanes.length === 0) return GHOST_W;
  return stage.lanes.reduce((max, lane) => Math.max(max, laneWidth(lane)), 0);
}

function stageHeight(stage: StageDraft): number {
  return (
    stage.lanes.reduce((sum, lane) => sum + laneHeight(lane), 0) +
    Math.max(0, stage.lanes.length - 1) * LANE_GAP_Y
  );
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

export function progressionTree(
  state: TournamentState,
  currentMatchId?: string | null,
  t?: Translate,
): Poster {
  const competition = state.radball ?? null;
  const collected = collectStages(state, t);

  // A competition that plans a final round but has not earned it yet has no
  // final-round fixtures to wire into. Rather than draw a tree that stops dead
  // one band short of the end, the last band is the plate the qualified teams
  // are heading for: the shape of the competition is legible before it is played.
  const hasFinal = collected.some((stage) => stage.final);
  const pendingFinal: StageDraft[] =
    competition?.pendingFinal && !hasFinal && collected.length > 0
      ? [
          {
            key: 'phase:pending-final',
            title: (t ?? tr)('tree.finalRound'),
            // The plate itself carries this line. Repeating it in the band above
            // would say the same thing twice within three centimetres.
            meta: null,
            lanes: [],
            final: true,
          },
        ]
      : [];
  const stages = [...collected, ...pendingFinal];

  const bodyTop = PAD + BAND_HEAD_H;
  const bodyHeight = stages.reduce((max, stage) => Math.max(max, stageHeight(stage)), 0);

  const bands: PosterBand[] = [];
  const lanes: PosterLane[] = [];
  const cards: PosterCard[] = [];
  const ghosts: PosterGhost[] = [];
  const wires: PosterWire[] = [];
  /** teamId -> the output it left, and the stage it left from. */
  const origins = new Map<string, { port: Port; stage: number }>();

  let cursorX = PAD;
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    const width = stageWidth(stage);

    bands.push({
      key: `band:${stage.key}`,
      title: stage.title,
      meta: stage.meta,
      x: cursorX,
      y: PAD,
      width,
      height: BAND_HEAD_H,
      tone: stage.final ? 'final' : 'stage',
    });

    if (stage.lanes.length === 0) {
      ghosts.push({
        key: `ghost:${stage.key}`,
        x: cursorX + Math.max(0, (width - GHOST_W) / 2),
        y: bodyTop + Math.max(0, (bodyHeight - GHOST_H) / 2),
        width: GHOST_W,
        height: GHOST_H,
        title: stage.title,
        sub: stage.meta ?? '',
      });
      cursorX += width + STAGE_GAP;
      continue;
    }

    // Lanes stack, and each stage's stack is centred against the tallest stage.
    // A single-lane final round therefore sits in the middle of the group stage
    // that feeds it, which is what a tree does and what a table never could.
    let cursorY = bodyTop + Math.max(0, (bodyHeight - stageHeight(stage)) / 2);
    for (const lane of stage.lanes) {
      const w = laneWidth(lane);
      const h = laneHeight(lane);
      // A lane narrower than the band it sits in is centred in it, so a group
      // with fewer fixtures does not hang off the band's left edge.
      const laneX = cursorX + Math.max(0, (width - w) / 2);
      const contentX = laneX + LANE_PAD_X;
      const contentW = w - LANE_PAD_X * 2;
      const ticks: PosterTick[] = [];
      const cardKeys: string[] = [];

      // Round rows: a tick in the gutter, the fixtures centred beside it. A lane
      // whose header already says what its single round says -- the Final lane
      // is both -- gets no tick: saying it twice in one line of sight is noise,
      // not emphasis.
      const hasTick = !lane.tickRepeats;
      // Without a tick the row centres in the whole lane rather than in what is
      // left of it beside the gutter, so the card sits in the middle of its box.
      const gutter = hasTick ? TICK_W : 0;
      let rowY = cursorY + LANE_HEAD_H + LANE_PAD_Y;
      for (const row of lane.rows) {
        const rowW = row.matches.length * LEAGUE_CARD_W + (row.matches.length - 1) * CARD_GAP_X;
        let cardX = contentX + gutter + (contentW - gutter - rowW) / 2;
        if (hasTick) {
          ticks.push({
            key: `tick:${lane.key}:${row.key}`,
            // The tick sits in the gutter, clear of the lane's own edge and of
            // the fixtures it labels.
            x: LANE_PAD_X,
            width: TICK_W - TICK_GAP_X,
            y: rowY + LEAGUE_CARD_H / 2,
            title: row.title,
            fullTitle: row.fullTitle,
          });
        }
        for (const match of row.matches) {
          cards.push({
            key: match.id,
            match,
            x: cardX,
            y: rowY,
            points: [awardedPoints(state, match, 'A'), awardedPoints(state, match, 'B')],
            league: true,
          });
          cardKeys.push(match.id);
          cardX += LEAGUE_CARD_W + CARD_GAP_X;
        }
        rowY += LEAGUE_CARD_H + ROW_GAP_Y;
      }

      // The lane's output. These are the tree's leaves, and every wire in the
      // competition leaves one. They are as wide as the fixtures they come from
      // and start where those start: a chip that reached into the gutter would
      // say the group reached further than it did.
      const outY = cursorY + LANE_HEAD_H + LANE_PAD_Y + rowsHeight(lane) + OUT_GAP_Y;
      const outputs = buildOutputs(state, lane, contentX + gutter, outY, contentW - gutter, t);
      for (const output of outputs) {
        if (!output.teamId) continue;
        origins.set(output.teamId, { port: rightPort(output), stage: stageIndex });
      }

      lanes.push({
        key: lane.key,
        title: lane.title,
        meta: lane.meta,
        x: laneX,
        y: cursorY,
        width: w,
        height: h,
        ticks,
        cardKeys,
        outputs,
      });

      cursorY += h + LANE_GAP_Y;
    }

    cursorX += width + STAGE_GAP;
  }

  /* -- qualification wires ------------------------------------------- */

  const stageOfCard = new Map<string, number>();
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    for (const lane of stages[stageIndex].lanes) {
      for (const row of lane.rows) {
        for (const match of row.matches) stageOfCard.set(match.id, stageIndex);
      }
    }
  }

  for (const card of cards) {
    const targetStage = stageOfCard.get(card.key) ?? 0;
    for (const side of ['A', 'B'] as const) {
      const teamId = side === 'A' ? card.match.participantAId : card.match.participantBId;
      if (!teamId) continue;
      const origin = origins.get(teamId);
      // A wire only ever runs forward. Inside one stage a team can appear in a
      // group lane and in the final lane, and drawing that as a wire would
      // promise a match that does not exist.
      if (!origin || origin.stage >= targetStage) continue;
      wires.push({
        key: `qualify:${card.key}:${side}`,
        d: wire(
          origin.port,
          leftPort({ x: card.x, y: card.y, width: LEAGUE_CARD_W, height: LEAGUE_CARD_H }),
        ),
        tone: 'qualify',
        settled: card.match.state === 'FINISHED',
        live: card.key === currentMatchId,
      });
    }
  }

  for (const ghost of ghosts) {
    for (const [teamId, origin] of origins) {
      wires.push({
        key: `pending:${ghost.key}:${teamId}`,
        d: wire(origin.port, leftPort(ghost)),
        tone: 'pending',
        settled: false,
        live: false,
      });
    }
  }

  /* -- the crown ----------------------------------------------------- */

  const championId = competition?.championId ?? null;
  let crown: PosterCrown | null = null;
  if (championId && state.participants[championId]) {
    // `cursorX` already carries the gap after the last band.
    crown = {
      x: cursorX,
      y: bodyTop + Math.max(0, (bodyHeight - CROWN_H) / 2),
      width: CROWN_W,
      height: CROWN_H,
      teamId: championId,
      name: state.participants[championId].name,
    };

    // The crown is fed by whatever actually decided the title: the final if it
    // was played, otherwise the table that put the champion on top. Guessing
    // here would be the one wire in the poster that could be wrong.
    const created = new Map(state.matchOrder.map((id, index) => [id, index]));
    const finalMatch = Object.values(state.matches)
      .filter((match) => match.radball?.kind === 'final' && match.state === 'FINISHED')
      .sort((a, b) => (created.get(a.id) ?? 0) - (created.get(b.id) ?? 0))
      .find((match) => match.winnerId === championId);
    const finalCard = finalMatch ? cards.find((card) => card.key === finalMatch.id) : undefined;

    if (finalCard) {
      wires.push({
        key: 'crown:final',
        d: wire(
          rightPort({
            x: finalCard.x,
            y: finalCard.y,
            width: LEAGUE_CARD_W,
            height: LEAGUE_CARD_H,
          }),
          leftPort(crown),
        ),
        tone: 'champion',
        settled: true,
        live: false,
      });
    } else {
      const origin = origins.get(championId);
      if (origin) {
        wires.push({
          key: 'crown:table',
          d: wire(origin.port, leftPort(crown)),
          tone: 'champion',
          settled: true,
          live: false,
        });
      }
    }
  }

  // The crown is the last thing on the poster, so it keeps the same margin the
  // rest of it has. Without the padding it sat flush against the right edge,
  // while every other element had a gutter of its own.
  const width = Math.max(PAD * 2, cursorX + (crown ? crown.width : 0) + PAD);
  const height = PAD * 2 + BAND_HEAD_H + bodyHeight;

  return {
    width,
    height,
    cardWidth: LEAGUE_CARD_W,
    cardHeight: LEAGUE_CARD_H,
    laneHead: LANE_HEAD_H,
    bands,
    lanes,
    cards,
    cardsById: new Map(cards.map((card) => [card.key, card])),
    ghosts,
    crown,
    wires,
  };
}

/** A lane's outputs, stacked below its fixtures. */
function buildOutputs(
  state: TournamentState,
  lane: LaneDraft,
  x: number,
  y: number,
  width: number,
  t?: Translate,
): PosterOutput[] {
  const name = (teamId: string): string => state.participants[teamId]?.name ?? tr('tree.unknownName');

  if (lane.standings.length === 0 && lane.qualifies > 0) {
    return [
      {
        key: `out:${lane.key}:undecided`,
        x,
        y,
        width,
        height: OUT_H,
        teamId: null,
        rank: null,
        name: tr('tree.tableUndecided'),
        points: null,
        role: 'undecided',
        note: null,
      },
    ];
  }

  if (lane.qualifies > 0) {
    return lane.standings.slice(0, lane.qualifies).map((row, index) => ({
      key: `out:${lane.key}:${row.teamId}`,
      x,
      y: y + index * (OUT_H + OUT_GAP_Y),
      width,
      height: OUT_H,
      teamId: row.teamId,
      rank: row.rank,
      name: name(row.teamId),
      points: row.points,
      role: 'qualified' as const,
      note: row.status === 'tied' ? (row.note ?? tr('tree.playoffNeeded')) : null,
    }));
  }

  if (lane.standings.length > 0) {
    const row = lane.standings[0];
    return [
      {
        key: `out:${lane.key}:lead`,
        x,
        y,
        width,
        height: OUT_H,
        teamId: row.teamId,
        rank: row.rank,
        name: name(row.teamId),
        points: row.points,
        role: 'lead' as const,
        note: standingStatusLabel(row, t) || null,
      },
    ];
  }

  return [];
}

