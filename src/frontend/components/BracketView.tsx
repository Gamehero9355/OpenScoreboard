/**
 * The tournament tree.
 *
 * One surface, three shapes, because a knockout, a free-form league and the
 * ten-team Radball format are three different things and one layout cannot
 * honestly draw all of them -- but a spectator should not have to learn a second
 * visual language to follow the competition.
 *
 * - A **knockout** is a wall bracket: rounds as columns, every later round
 *   centred on the feeders that decide it, elbow connectors showing the path a
 *   winner travels.
 * - A **league** is a progression tree: phases as bands, groups as lanes inside
 *   them, a lane's qualified teams as chips its wires leave from, and the
 *   champion on a plate at the far right. A league has no elimination *inside* a
 *   round, so a lane is a stack of round rows rather than a branching subtree --
 *   but the way a team leaves its group and arrives at the final is a real
 *   path, and it is drawn as one.
 * - The **ten-team Radball format** is neither: its preliminary round is two
 *   tables, not a bracket, and its final phase is a fixed ladder of cross-group
 *   matches. It gets its own component (`Radball10Tree`) behind the same route,
 *   because a bracket cannot show a group position honestly.
 *
 * The first two are the same `Poster`, rendered by the same component, so the
 * match card, the wires, the band headers, the scaling and the fullscreen
 * affordance are literally shared code. The whole competition is on screen at all
 * times and scales itself to whatever frame it is given, so nobody has to hunt
 * for their match with a zoom control in a dark hall.
 */
import { useMemo, useRef } from 'react';
import type { Match, TournamentState } from '../../shared/types';
import { bracketRounds, fieldDisplayName, isRealMatch, logoOf, nameOf } from '../../shared/matchUtils';
import { Button } from './primitives';
import { CrestWithName } from './TeamCrest';
import { IconCollapse, IconExpand } from './icons';
import { Radball10Tree } from './Radball10Tree';
import { useElementSize, useFullscreen, type FullscreenControls } from '../lib/hooks';
import { decisionReasonLabel, shootoutScore, type Translate } from '../lib/radball';
import { asTranslate, useI18n } from '../lib/useI18n';
import type { MessageKey } from '../lib/i18n';
import { groupSizeOfState, isTenTeamFormat } from '../lib/radball10';
import { radball10FinalStructure } from '../../shared/radball10Structure';
import {
  progressionTree,
  type Poster,
  type PosterCard,
  type PosterLane,
  type PosterWire,
} from '../lib/progression';

/* ------------------------------------------------------------------ */
/* Centered-tree layout (data driven, no DOM measuring)                */
/* ------------------------------------------------------------------ */

const COL_W = 244;
const CARD_H = 84;
const STEP_Y = 106;
const MIN_GAP = CARD_H + 12;
const COL_GAP = 76;
const TITLE_H = 44;
const PAD = 20;

interface Placed {
  match: Match;
  x: number;
  y: number;
}

interface LayoutColumn {
  key: string;
  title: string;
  x: number;
  nodes: Placed[];
}

interface Connector {
  key: string;
  d: string;
  kind: 'win' | 'lose';
  decided: boolean;
  live: boolean;
}

export interface TreeLayout {
  columns: LayoutColumn[];
  byId: Map<string, { x: number; y: number }>;
  connectors: Connector[];
  width: number;
  height: number;
}

function feederIds(match: Match): (string | null)[] {
  const out: (string | null)[] = [];
  for (const slot of [match.slotA, match.slotB]) {
    if (slot.kind === 'winner-of' || slot.kind === 'loser-of') out.push(slot.matchId);
    else out.push(null);
  }
  return out;
}

export function computeLayout(
  buckets: { round: number; name: string; matches: Match[] }[],
  currentMatchId?: string | null,
  /** Optional, so the tests keep the English column titles they assert on. */
  t?: Translate,
): TreeLayout {
  const winners = buckets.filter((b) => b.matches[0]?.bracket === 'winners');
  const losers = buckets.filter((b) => b.matches[0]?.bracket === 'losers');
  const finalsMatches = buckets
    .filter((b) => {
      const side = b.matches[0]?.bracket;
      return side === 'final' || side === 'reset' || side === 'third-place';
    })
    .flatMap((b) => b.matches)
    .sort((a, b) => {
      const rank = (m: Match) => (m.bracket === 'final' ? 0 : m.bracket === 'reset' ? 1 : 2);
      return rank(a) - rank(b) || a.position - b.position;
    });

  const columns: LayoutColumn[] = [];
  for (const bucket of [...winners, ...losers]) {
    const first = bucket.matches[0];
    columns.push({
      key: `${first?.bracket ?? 'round'}:${bucket.round}:${bucket.name}`,
      title: bucket.name,
      x: 0,
      nodes: [],
    });
  }
  const bucketLists: Match[][] = [
    ...[...winners, ...losers].map((b) => [...b.matches].sort((a, b2) => a.position - b2.position)),
  ];
  if (finalsMatches.length > 0) {
    const hasGrandFinal = finalsMatches.some((m) => m.bracket === 'final' || m.bracket === 'reset');
    columns.push({
      key: `finals:${finalsMatches.map((m) => m.id).join(',')}`,
      title: hasGrandFinal ? (t ? t('round.final') : 'Final') : t ? t('round.thirdPlace') : '3rd Place Match',
      x: 0,
      nodes: [],
    });
    bucketLists.push(finalsMatches);
  }

  const byId = new Map<string, { x: number; y: number }>();
  const idToMatch = new Map<string, Match>();
  for (const list of bucketLists) for (const m of list) idToMatch.set(m.id, m);

  let maxY = 0;
  columns.forEach((column, colIndex) => {
    const x = PAD + colIndex * (COL_W + COL_GAP);
    column.x = x;
    const list = bucketLists[colIndex] ?? [];
    const placed: Placed[] = list.map((match, idx) => {
      const feeders = feederIds(match).filter((id): id is string => id !== null && byId.has(id));
      let y: number;
      if (feeders.length > 0) {
        y = feeders.reduce((sum, id) => sum + (byId.get(id)?.y ?? 0), 0) / feeders.length;
      } else if (colIndex === 0) {
        y = idx * STEP_Y;
      } else if (list.length <= 1) {
        y = maxY / 2;
      } else {
        const natural = (list.length - 1) * STEP_Y;
        const total = Math.max(natural, maxY);
        y = (total - natural) / 2 + idx * STEP_Y;
      }
      return { match, x, y };
    });
    // Keep the feeder-centering, but never let cards overlap: push down.
    placed.sort((a, b) => a.y - b.y || a.match.position - b.match.position);
    for (let i = 1; i < placed.length; i += 1) {
      const prev = placed[i - 1];
      const node = placed[i];
      if (node.y < prev.y + MIN_GAP) node.y = prev.y + MIN_GAP;
    }
    column.nodes = placed;
    for (const node of placed) {
      byId.set(node.match.id, { x: node.x, y: node.y });
      maxY = Math.max(maxY, node.y);
    }
  });

  // Connectors run from each feeder's right edge to the match's left edge. The
  // PAD belongs in the offset: a card is drawn at PAD + TITLE_H + y, so a wire
  // that leaves it out floats above the cards it is meant to join.
  const connectors: Connector[] = [];
  const dx = Math.max(24, COL_GAP / 2);
  for (const column of columns) {
    for (const node of column.nodes) {
      const toX = node.x;
      const toY = PAD + TITLE_H + node.y + CARD_H / 2;
      for (const slot of [node.match.slotA, node.match.slotB]) {
        if (slot.kind !== 'winner-of' && slot.kind !== 'loser-of') continue;
        const feeder = byId.get(slot.matchId);
        const feederMatch = idToMatch.get(slot.matchId);
        if (!feeder || !feederMatch) continue;
        const fromX = feeder.x + COL_W;
        const fromY = PAD + TITLE_H + feeder.y + CARD_H / 2;
        const d =
          `M ${fromX} ${fromY} ` +
          `C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
        connectors.push({
          key: `${slot.matchId}->${node.match.id}:${slot.kind === 'loser-of' ? 'L' : 'W'}`,
          d,
          kind: slot.kind === 'loser-of' ? 'lose' : 'win',
          decided: feederMatch.state === 'FINISHED',
          live: node.match.id === currentMatchId,
        });
      }
    }
  }

  const width = PAD * 2 + columns.length * COL_W + Math.max(0, columns.length - 1) * COL_GAP;
  const height = PAD * 2 + TITLE_H + maxY + CARD_H;
  return { columns, byId, connectors, width, height };
}

/**
 * The knockout layout, restated as a poster.
 *
 * The wire paths and the column origins are already in poster coordinates --
 * `computeLayout` bakes `PAD + TITLE_H` into both -- so this only has to move the
 * cards onto the same origin the wires are drawn against.
 */
function knockoutPoster(layout: TreeLayout): Poster {
  const cards = layout.columns.flatMap<PosterCard>((column) =>
    column.nodes.map((node) => ({
      key: node.match.id,
      match: node.match,
      x: node.x,
      y: PAD + TITLE_H + node.y,
      points: null,
      league: false,
    })),
  );
  return {
    width: layout.width,
    height: layout.height,
    cardWidth: COL_W,
    cardHeight: CARD_H,
    laneHead: 0,
    bands: layout.columns.map((column) => ({
      key: `band:${column.key}`,
      title: column.title,
      meta: null,
      x: column.x,
      y: PAD,
      width: COL_W,
      height: TITLE_H,
      tone: 'round' as const,
    })),
    lanes: [],
    cards,
    cardsById: new Map(cards.map((card) => [card.key, card])),
    ghosts: [],
    crown: null,
    wires: layout.connectors.map<PosterWire>((wire) => ({
      key: wire.key,
      d: wire.d,
      tone: wire.kind === 'lose' ? 'lose' : 'win',
      settled: wire.decided,
      live: wire.live,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Which shape is this competition?                                    */
/* ------------------------------------------------------------------ */

/**
 * True when nothing in this tree feeds anything else.
 *
 * A Radball competition is a league: `makeRadballMatch` only ever fills a slot
 * with a participant or a bye, so a knockout layout would find no feeders, drop
 * every connector and then centre each round on nothing. Detecting that up
 * front is what keeps the two shapes apart.
 */
export function isLeagueTree(state: TournamentState): boolean {
  let count = 0;
  for (const match of Object.values(state.matches)) {
    count += 1;
    for (const slot of [match.slotA, match.slotB]) {
      if (slot.kind === 'winner-of' || slot.kind === 'loser-of') return false;
    }
  }
  return count > 0;
}

/* ------------------------------------------------------------------ */
/* Match card                                                          */
/* ------------------------------------------------------------------ */

/** "+3" for a win, "+1" for a draw, a flat "0" for a loss. */
function pointsLabel(points: number | null, t?: (key: MessageKey) => string): string | null {
  if (points === null) return null;
  return points > 0 ? `+${points}` : t ? t('score.zero') : '0';
}

function MatchCard({
  state,
  match,
  isCurrent,
  points,
}: {
  state: TournamentState;
  match: Match;
  isCurrent: boolean;
  points: [number | null, number | null] | null;
}) {
  const { t } = useI18n();
  const league = points !== null;
  const meta = match.radball ?? null;
  const sides = [
    { id: match.participantAId, score: match.scoreA, slot: match.slotA, won: points?.[0] ?? null },
    { id: match.participantBId, score: match.scoreB, slot: match.slotB, won: points?.[1] ?? null },
  ];
  const field = match.fieldId ? state.fields[match.fieldId] : null;
  const shootout = meta?.shootout ? shootoutScore(meta.shootout) : null;
  const shootoutDone = meta?.shootout?.decided === true;

  // A league match's own round name already labels its row in the lane gutter,
  // so the card header spends its space on what a row cannot say: why a play-off
  // was ordered, whether a level match went to the 4-meter line, and where it
  // plays. A knockout card has no gutter, so it keeps its slot number.
  const reason = league && meta ? decisionReasonLabel(meta.decisionReason, asTranslate(t)) : '';

  return (
    <article
      className={cx(
        'bm',
        league && 'bm--league',
        `bm--${match.state.toLowerCase()}`,
        match.isThirdPlace && 'bm--third',
        isCurrent && 'bm--current',
      )}
    >
      <header className="bm__head">
        {league ? (
          <>
            {reason ? <span className="bm__tag">{reason}</span> : null}
            {shootout && shootoutDone ? (
              <span className="bm__tag tnum">{t('radball.shootoutScore', { a: shootout.a.hits, b: shootout.b.hits })}</span>
            ) : null}
            {meta?.requiresWinner ? <span className="bm__tag">{t('radball.oneWinner')}</span> : null}
          </>
        ) : (
          <span>#{match.position + 1}</span>
        )}
        {field && match.fieldId ? (
          <span className="bm__field">{fieldDisplayName(field.name, match.fieldId, asTranslate(t))}</span>
        ) : null}
      </header>
      {sides.map((side, index) => {
        const isWinner = match.winnerId !== null && match.winnerId === side.id;
        const isLoser = match.state === 'FINISHED' && match.loserId === side.id;
        return (
          <div
            key={index}
            className={cx('bm__side', isWinner && 'bm__side--winner', isLoser && 'bm__side--loser')}
          >
            <span className="bm__name">
              {side.slot.kind === 'bye' && !side.id ? (
                <span className="faint">{t('match.bye')}</span>
              ) : (
                <CrestWithName logo={logoOf(state, side.id)} name={nameOf(state, side.id)} size="xs" />
              )}
            </span>
            <span className="bm__score tnum">{isRealMatch(match) ? side.score : ''}</span>
            {league ? (
              <span className="bm__pts tnum">{pointsLabel(side.won, t) ?? ''}</span>
            ) : null}
          </div>
        );
      })}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Poster                                                              */
/* ------------------------------------------------------------------ */

/** Breathing room between the poster and the frame that holds it. */
const POSTER_GUTTER = 28;
/**
 * Below this the names stop being readable across a hall, so the poster stops
 * shrinking and the frame scrolls instead. A bracket you cannot read is worse
 * than one you have to move.
 */
const POSTER_MIN_SCALE = 0.62;

export function BracketView({
  state,
  currentMatchId,
  showToolbar = true,
}: {
  state: TournamentState;
  currentMatchId?: string | null;
  showToolbar?: boolean;
}) {
  const { t } = useI18n();
  // The 10-team Radball format is not a bracket at all: twenty group fixtures
  // produce no branch, they produce two tables, and the final phase is a fixed
  // ladder of cross-group matches. Its own component draws that shape honestly;
  // routing it through a poster here would flatten the standings into a column
  // of cards and hide the one thing a hall reads -- the group position.
  const tenTeam = useMemo(() => isTenTeamFormat(state), [state]);
  const league = useMemo(() => isLeagueTree(state), [state]);
  const rounds = useMemo(() => bracketRounds(state), [state]);
  const layout = useMemo(
    () => (league ? null : computeLayout(rounds, currentMatchId, asTranslate(t))),
    [league, rounds, currentMatchId, t],
  );
  // The ten-team shape scales with the group count, so the tree is built from
  // this competition's own groups rather than the ten-team specialisation.
  const tenStructure = useMemo(
    () => (tenTeam && state ? radball10FinalStructure(groupSizeOfState(state)) : null),
    [tenTeam, state],
  );
  const poster = useMemo(
    () => (layout ? knockoutPoster(layout) : progressionTree(state, currentMatchId, asTranslate(t))),
    [layout, state, currentMatchId, t],
  );

  const frameRef = useRef<HTMLDivElement>(null);
  const frame = useElementSize(frameRef);
  const fullscreen = useFullscreen();

  const scale = useMemo(() => {
    if (poster.width <= 0 || poster.height <= 0) return 1;
    if (frame.width <= 0 || frame.height <= 0) return 1;
    const fit = Math.min(
      1,
      (frame.width - POSTER_GUTTER) / poster.width,
      (frame.height - POSTER_GUTTER) / poster.height,
    );
    return Math.max(POSTER_MIN_SCALE, fit);
  }, [frame, poster]);

  const empty = poster.bands.length === 0;

  return (
    <div className="stack grow" style={{ minHeight: 0 }}>
      {showToolbar ? <TreeLegend league={league} fullscreen={fullscreen} /> : null}

      {tenTeam ? (
        <div className="bracket bracket--ten" role="region" aria-label={t('bracket.tenTeamAria')}>
          <Radball10Tree state={state} structure={tenStructure ?? []} />
        </div>
      ) : (
        <div className="bracket" ref={frameRef} role="region" aria-label={t('nav.bracket')}>
          {empty ? (
            <p className="empty">{t('bracket.noTree')}</p>
          ) : (
            <div
              className="bracket__fit"
              style={{ width: poster.width * scale, height: poster.height * scale }}
            >
              <div
                className="bracket__poster"
                style={
                  {
                    width: poster.width,
                    height: poster.height,
                    transform: `scale(${scale})`,
                    '--card-w': `${poster.cardWidth}px`,
                    '--card-h': `${poster.cardHeight}px`,
                    '--lane-head': `${poster.laneHead}px`,
                  } as React.CSSProperties
                }
              >
                <svg
                  className="bracket__wires"
                  width={poster.width}
                  height={poster.height}
                  viewBox={`0 0 ${poster.width} ${poster.height}`}
                  aria-hidden="true"
                >
                  {poster.wires.map((wire) => (
                    <path key={wire.key} d={wire.d} className={wireClass(wire)} />
                  ))}
                </svg>

              {poster.bands.map((band) => (
                <div
                  key={band.key}
                  className={cx('band', band.tone === 'round' && 'band--round', band.tone === 'final' && 'band--final')}
                  style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
                >
                  <span className="band__title">{band.title}</span>
                  {band.meta ? <span className="band__meta tnum">{band.meta}</span> : null}
                </div>
              ))}

              {poster.lanes.map((lane) => (
                <TreeLane
                  key={lane.key}
                  lane={lane}
                  cards={poster.cardsById}
                  currentMatchId={currentMatchId}
                  state={state}
                />
              ))}

              {/* Where the cards are placed depends on the shape, and exactly one
                  of these two paths may run:

                  - A league card belongs to a lane, and `TreeLane` above already
                    placed it at `card.x - lane.x` so the wire it leaves from lines
                    up with the gutter tick.
                  - A knockout card has no lane to live in: it is placed against
                    the poster, and its column is the band above it.

                  An earlier version of this rendered the knockout cards here
                  *and* kept an unconditional `poster.cards.map` further down, so
                  every knockout match was drawn twice at identical coordinates
                  with duplicate React keys -- and a league match was drawn once
                  inside its lane and once on top of it. Only the knockout half
                  belongs here. */}
              {poster.lanes.length === 0
                ? poster.cards.map((card) => (
                    <div
                      key={card.key}
                      className="bracket__node"
                      style={{ left: card.x, top: card.y }}
                    >
                      <MatchCard
                        state={state}
                        match={card.match}
                        isCurrent={currentMatchId === card.match.id}
                        points={card.points}
                      />
                    </div>
                  ))
                : null}

              {poster.ghosts.map((ghost) => (
                <div
                  key={ghost.key}
                  className="ghost"
                  style={{ left: ghost.x, top: ghost.y, width: ghost.width, height: ghost.height }}
                >
                  <span className="ghost__title">{ghost.title}</span>
                  <span className="ghost__sub">{ghost.sub}</span>
                </div>
              ))}

              {poster.crown ? (
                <div
                  className="crown"
                  style={{
                    left: poster.crown.x,
                    top: poster.crown.y,
                    width: poster.crown.width,
                    height: poster.crown.height,
                  }}
                >
                  <span className="crown__label">{t('results.champion')}</span>
                  <span className="crown__name">{poster.crown.name}</span>
                </div>
              ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function wireClass(wire: PosterWire): string {
  return cx(
    'conn',
    `conn--${wire.tone}`,
    wire.settled && 'conn--settled',
    wire.live && 'conn--live',
  );
}

/* ------------------------------------------------------------------ */
/* Lane, chips, legend                                                 */
/* ------------------------------------------------------------------ */

/**
 * A lane: a title strip, the round ticks in its gutter, and the chips its
 * qualification wires leave from.
 *
 * Every child is placed from the layout's own coordinates, so the tick that
 * labels a round sits on the exact centre line of the fixtures it labels and a
 * chip's right edge is exactly where its wire starts.
 */
function TreeLane({
  lane,
  cards,
  currentMatchId,
  state,
}: {
  lane: PosterLane;
  cards: Map<string, PosterCard>;
  currentMatchId?: string | null;
  state: TournamentState;
}) {
  const { t } = useI18n();
  return (
    <section
      className="lane"
      style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height }}
      aria-label={lane.title}
    >
      <header className="lane__head">
        <h3 className="lane__title">{lane.title}</h3>
        {lane.meta ? <span className="lane__meta tnum">{lane.meta}</span> : null}
      </header>
      {lane.ticks.map((tick) => (
        <span
          key={tick.key}
          className="lane__tick"
          style={{ left: tick.x, width: tick.width, top: tick.y - lane.y }}
          title={tick.fullTitle}
        >
          {tick.title}
        </span>
      ))}
      {lane.cardKeys.map((key) => {
        const card = cards.get(key);
        if (!card) return null;
        return (
          <div
            key={key}
            className="bracket__node"
            style={{ left: card.x - lane.x, top: card.y - lane.y }}
          >
            <MatchCard
              state={state}
              match={card.match}
              isCurrent={currentMatchId === card.match.id}
              points={card.points}
            />
          </div>
        );
      })}
      {lane.outputs.map((output) => (
        <div
          key={output.key}
          className={cx('out', `out--${output.role}`)}
          style={{
            left: output.x - lane.x,
            top: output.y - lane.y,
            width: output.width,
            height: output.height,
          }}
          aria-label={outputLabel(lane, output, asTranslate(t))}
        >
          <span className="out__rank tnum">{output.rank ?? '–'}</span>
          <span className="out__name">{output.name}</span>
          {output.points !== null ? (
            <span className="out__pts tnum">{t('score.points', { n: output.points })}</span>
          ) : null}
          {output.note ? <span className="out__note">{output.note}</span> : null}
        </div>
      ))}
    </section>
  );
}

/**
 * The chip's full sentence, for anyone not reading it off the poster.
 *
 * A chip shows a rank, a name and a figure; what it *means* is only in the
 * wiring around it, so the accessible name spells the wiring out. The catalogue
 * carries that whole sentence as `a11y.rank`, with `{points}`, `{role}` and
 * `{note}` assembled here because their emptiness is what makes the sentence
 * read correctly.
 */
function outputLabel(lane: PosterLane, output: PosterLane['outputs'][number], t: Translate): string {
  if (output.role === 'undecided') return `${lane.title}: ${output.name}`;
  const points = output.points === null ? '' : `, ${t('score.points', { n: output.points })}`;
  const note = output.note ? `, ${output.note}` : '';
  const role = output.role === 'lead' ? t('results.leader') : t('results.advances');
  return t('a11y.rank', {
    rank: output.rank ?? '',
    name: output.name,
    points,
    role,
    group: lane.title,
    note,
  });
}

function TreeLegend({
  league,
  fullscreen,
}: {
  league: boolean;
  fullscreen: FullscreenControls;
}) {
  const { t } = useI18n();
  return (
    <div className="bracket__legend">
      <span className="bracket__legend-item">
        <span className="bracket__swatch bracket__swatch--running" /> {t('match.running')}
      </span>
      <span className="bracket__legend-item">
        <span className="bracket__swatch bracket__swatch--ready" /> {t('match.ready')}
      </span>
      <span className="bracket__legend-item">
        <span className="bracket__swatch bracket__swatch--finished" /> {t('match.finished')}
      </span>
      <span className="bracket__legend-item">
        <span className="bracket__swatch bracket__swatch--current" /> {t('bracket.legendCurrent')}
      </span>
      {league ? (
        <span className="bracket__legend-item">
          <span className="bracket__swatch bracket__swatch--qualified" />{' '}
          {t('bracket.legendThrough')}
        </span>
      ) : null}
      <span className="grow" />
      {fullscreen.supported ? (
        <Button
          size="sm"
          tone="ghost"
          onClick={fullscreen.toggle}
          aria-label={t('a11y.fullscreen')}
          title={t('a11y.fullscreen')}
        >
          {fullscreen.active ? <IconCollapse size={13} /> : <IconExpand size={13} />}
        </Button>
      ) : null}
    </div>
  );
}

function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
