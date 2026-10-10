/**
 * The 10-team Radball tournament tree.
 *
 * This replaces the generic bracket for the ten-team format, and the reason is
 * not styling. A knockout tree is a branching structure, and the ten-team format
 * is not one: twenty group fixtures produce no branch at all, they produce two
 * *round robins*. Forcing that through a bracket drawer turns five rows of
 * standings into a column of match cards and hides the only thing that matters --
 * where the five squads stand and what is happening on each ring right now.
 *
 * So one card per playing field, and as little in it as will still answer the
 * question:
 *
 *   Preliminary round  -- 7 of 20 played
 *   [ Field 1 . Group A ]
 *     A1 Team B   6
 *     A2 Team C   3   (five rows)
 *     ...
 *     Now   Team A v Team D
 *     Next  Team E v Team C
 *   [ Field 2 . Group B ]
 *     B1 Team F   3
 *     B2 Team H   3   (five rows)
 *     ...
 *     Now   Team G v Team H
 *     Next  Team F v Team I
 *   Final phase
 *     9/10   Group A #5  v  Group B #5
 *     ...
 *
 * The twenty results are *not* listed. The tree is a glance panel: the count says
 * how far along the round is, the Results tab and the completed list beside the
 * dashboard carry every result, and printing all twenty here only pushed the two
 * matches actually in play off the bottom of the screen.
 *
 * Every position is labelled by where it came from ("Group A #3", "Winner . 
 * Semifinal 1"), never by an index, and once a group is frozen it is labelled by
 * the squad itself. A hall reads a position; "Winner Match 4" means nothing to
 * them and would hide a wrong answer rather than reveal one.
 *
 * Nothing here computes. The fixtures come from the matches, the standings from
 * `competition.tables`, the positions from `competition.ten.rankings`, the places
 * from `competition.ten.ranking`. If the tree and the engine ever disagreed, the
 * tree would be the one that is wrong -- and it has no arithmetic to be wrong with.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TournamentState } from '../../shared/types';
import { logoOf, nameOf } from '../../shared/matchUtils';
import {
  finalPhaseRows,
  groupFixtureDigest,
  groupSlots,
  preliminaryProgress,
  type FinalPhaseSpec,
  type FinalPhaseRow,
  type GroupSlot,
} from '../lib/radball10';
import { cx } from '../lib/util';
import { asTranslate, useI18n } from '../lib/useI18n';
import { groupNameLabel } from '../lib/radball';
import { CrestWithName } from './TeamCrest';
import { Empty } from './primitives';

export function Radball10Tree({
  state,
  structure,
  className,
}: {
  state: TournamentState;
  structure: FinalPhaseSpec[];
  className?: string;
}) {
  const { t } = useI18n();
  const groups = useMemo(() => groupSlots(state, asTranslate(t)), [state, t]);
  const rows = useMemo(() => finalPhaseRows(state, structure, asTranslate(t)), [state, structure, t]);
  const progress = preliminaryProgress(groups);
  const finalGenerated = state.radball?.ten?.final.status === 'GENERATED';
  const feeds = useSlotFeeds(rows);

  return (
    <div className={cx('rbt', className)}>
      <SlotFeeds wires={feeds} />
      {/*
       * The two rounds read left to right, the way the competition actually
       * runs: the groups feed the final phase, so the final phase sits beside
       * them rather than underneath. Stacked, the dependency had to be explained
       * in prose on the rules panel below; side by side, with the position wires
       * drawn across the gutter, it is the shape of the page.
       */}
      <div className="rbt__flow">
        {/* -------------------------------------------- preliminary round -- */}
        <section
          className="rbt__section rbt__section--groups"
          aria-label={t('radball10.preliminaryRound')}
        >
          <header className="rbt__section-head">
            <h3 className="rbt__section-title">{t('radball10.preliminaryRound')}</h3>
            <span className="rbt__progress">
              <span className="rbt__progress-label tnum">{progress.label}</span>
              <span className="rbt__progress-track" aria-hidden="true">
                <span
                  className="rbt__progress-fill"
                  style={{ transform: `scaleX(${progress.total ? progress.played / progress.total : 0})` }}
                />
              </span>
            </span>
          </header>

          <div className="rbt__groups">
            {groups.map((group) => (
              <GroupCard key={group.groupId} state={state} group={group} />
            ))}
          </div>
        </section>

        {/* -------------------------------------------------- final phase -- */}
        <section
          className="rbt__section rbt__section--final"
          aria-label={t('setup.reviewFinalPhase')}
        >
          <header className="rbt__section-head">
            <h3 className="rbt__section-title">{t('setup.reviewFinalPhase')}</h3>
            <span className="tiny dim">
              {finalGenerated ? t('radball10.fromPositions') : t('radball10.afterGroups')}
            </span>
          </header>
          <FinalPhaseList state={state} rows={rows} />
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One playing field                                                  */
/* ------------------------------------------------------------------ */

/**
 * One field, in one card: the five positions, then the match on the ring and the
 * one after it.
 *
 * These two used to be separate cards, a fixture list and a standings table, which
 * meant a volunteer read past one to reach the other. Merged, the standings are
 * the backdrop and the two live lines are the foreground -- and the twenty
 * finished results are a count rather than twenty rows.
 */
function GroupCard({ state, group }: { state: TournamentState; group: GroupSlot }) {
  const { t } = useI18n();
  const table = state.radball?.tables[group.groupId] ?? [];
  const digest = groupFixtureDigest(state, group.groupId);
  return (
    <article className={cx('rbt__card', group.complete && 'rbt__card--complete')}>
      <header className="rbt__card-head">
        <span className="rbt__card-title">{groupNameLabel(group.name, asTranslate(t))}</span>
        {/* Mark plus label. The dot says this ring is in hand right now, the name
            says which one; a bare "Field 1" in dim type carries neither at the back
            of a hall, where this card is read fastest. */}
        <span className="rbt__card-field">
          {digest.live ? <span className="dot dot--live" aria-hidden="true" /> : null}
          {group.fieldName}
        </span>
      </header>

      {table.length === 0 ? (
        <Empty>{t('results.noMatches')}</Empty>
      ) : (
        <table className="table rbt__standing-table">
          <caption className="sr-only">
            {groupNameLabel(group.name, asTranslate(t))} {t('results.standings')}:{' '}
            {t('results.rank')}, {t('results.team')},{' '}
            {t('results.diff')}, {t('results.pts')}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{t('results.rank')}</span>
              </th>
              <th scope="col">
                <span className="sr-only">{t('results.team')}</span>
              </th>
              <th scope="col" className="rbt__num">
                GD
              </th>
              <th scope="col" className="rbt__num">
                {t('results.pts')}
              </th>
            </tr>
          </thead>
          <tbody>
            {table.map((row) => (
              <tr key={row.teamId} className={row.rank <= 2 ? 'rbt__row--semifinalist' : undefined}>
                {/* `data-slot` lets the connector find this position's row without the
                    tree having to know the DOM order of the two tables. */}
                <td className="tnum rbt__pos" data-slot={`${group.letter}${row.rank}`}>
                  {group.letter}
                  {row.rank}
                </td>
                {/* The squad is this row's header, so it is a `th`: a screen reader
                    announces "Team A, 3" rather than reading the cells in order. The
                    crest is the same one every other match row in the app carries, and
                    it disappears on its own for a squad with no logo on file. */}
                <th scope="row" className="rbt__team">
                  <CrestWithName
                    logo={logoOf(state, row.teamId)}
                    name={nameOf(state, row.teamId)}
                    size="xs"
                  />
                </th>
                <td className="tnum rbt__num">
                  {row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}
                </td>
                <td className="tnum rbt__pts rbt__num">{row.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The two matches this field is about. Absent rather than dashed: an empty
          slot would be a third state nobody asked for. */}
      <div className="rbt__now">
        {digest.live ? (
          <p className="rbt__now-row rbt__now-row--live">
            <span className="rbt__now-key">{t('radball10.now')}</span>
            <span className="grow">
              {digest.live.nameA} <span className="dim">v</span> {digest.live.nameB}
            </span>
          </p>
        ) : null}
        {digest.next ? (
          <p className="rbt__now-row">
            <span className="rbt__now-key">{t('action.next')}</span>
            <span className="grow">
              {digest.next.nameA} <span className="dim">v</span> {digest.next.nameB}
            </span>
          </p>
        ) : null}
        {!digest.live && !digest.next ? (
          <p className="rbt__now-row rbt__now-row--idle tiny dim">
            {group.complete
              ? t('radball10.allFixturesPlayed')
              : digest.waiting > 0
                ? `${t('radball10.nothingReady')} · ${t('radball10.waitingOnResults', { n: digest.waiting })}`
                : t('radball10.nothingReady')}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* The wires between a position and the match it plays in              */
/* ------------------------------------------------------------------ */

interface SlotWire {
  from: string;
  to: string;
}

/**
 * Measure where each published position sits and which match it feeds, so the
 * tree can draw the line between them.
 *
 * This is measured rather than computed because the two columns are laid out by
 * the content: a group table's rows are as tall as its five teams need, and the
 * ladder's rows are as tall as theirs. Any formula for "the line from A1" would
 * be a guess that goes stale the moment a name wraps.
 *
 * Every dependency that can move a box is in the effect -- the tournament state,
 * the final-phase structure, and the viewport -- because a stale measurement is
 * worse than no line: it would point a position at the wrong match.
 */
function useSlotFeeds(rows: FinalPhaseRow[]): SlotWire[] {
  // The set of published positions that some final-phase match actually uses.
  // A position nothing depends on -- in a format with fewer qualifiers than
  // groups, for instance -- gets no wire, because there is nothing to connect it
  // to and a line to nowhere is worse than no line.
  return useMemo(() => {
    const wanted = new Set<string>();
    for (const row of rows) {
      if (row.slotAKey) wanted.add(row.slotAKey);
      if (row.slotBKey) wanted.add(row.slotBKey);
    }
    return [...wanted].map((key) => ({ from: key, to: key }));
  }, [rows]);
}

/**
 * The wires themselves.
 *
 * Drawn as SVG over the tree rather than as CSS borders, because a position and
 * the match it feeds are rarely on the same line: A1 feeds a semifinal, and A5
 * feeds the 9th/10th-place match, so each line has to travel and turn.
 */
function SlotFeeds({ wires }: { wires: SlotWire[] }) {
  const box = useRef<SVGSVGElement>(null);
  const [paths, setPaths] = useState<{ d: string; key: string }[]>([]);

  useEffect(() => {
    const draw = () => {
      const svg = box.current;
      const root = svg?.closest('.rbt');
      if (!svg || !root) return;
      const base = root.getBoundingClientRect();
      const out: { d: string; key: string }[] = [];
      if (base.width === 0) return;

      // The wire leaves the *panel edge*, not the position cell.
      //
      // Anchoring on the cell itself drew every Group A line straight down the
      // panel alongside the Group B card on its way out, because A's rows sit in
      // the upper half of the panel. Starting at the panel's right border keeps
      // every line in the gutter between the two panels, where it can be
      // followed.
      const panel = root.querySelector<HTMLElement>('.rbt__section--groups');
      if (!panel) {
        setPaths([]);
        return;
      }
      const panelRect = panel.getBoundingClientRect();
      const gate = panelRect.right - base.left;
      // The wire stops at the final phase panel's *border*, not at the side text.
      // The side is inset inside the panel, so aiming at it drove the last few
      // pixels across the panel edge -- the line appeared to enter the card it
      // was meant to sit outside of.
      const landing = root.querySelector<HTMLElement>('.rbt__section--final');
      if (!landing) {
        setPaths([]);
        return;
      }
      const landingEdge = landing.getBoundingClientRect().left - base.left;

      for (const wire of wires) {
        const from = root.querySelector<HTMLElement>(`.rbt__pos[data-slot="${CSS.escape(wire.from)}"]`);
        const to = root.querySelector<HTMLElement>(`.rbt__side[data-slot="${CSS.escape(wire.to)}"]`);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const y1 = a.top + a.height / 2 - base.top;
        const y2 = b.top + b.height / 2 - base.top;
        // A stub clear of the groups panel, a curve across the gutter, then a
        // short stub to the final phase's border. The two elbows are what make
        // it read as "this feeds that" rather than as a decorative squiggle.
        //
        // The stub has to fit in the gutter, so it is capped at half the run
        // between the two panels. A flat 10px each end inverted itself once the
        // gap was narrower than 20px: `gate + 10` ended up *right* of
        // `landing - 10`, so the curve ran backwards and the whole wire
        // collapsed into a few pixels of noise against the panel border.
        const stub = Math.max(0, Math.min(10, (landingEdge - gate) / 2));
        const out1 = gate + stub;
        const in1 = landingEdge - stub;
        const x2 = landingEdge;
        const mid = (out1 + in1) / 2;
        out.push({
          key: wire.from,
          d: `M ${gate} ${y1} L ${out1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${in1} ${y2} L ${x2} ${y2}`,
        });
      }
      setPaths(out);
    };

    draw();
    const observer = new ResizeObserver(draw);
    const root = box.current?.closest('.rbt');
    if (root) observer.observe(root);
    window.addEventListener('resize', draw);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [wires]);

  // The overlay is always in the DOM, even with nothing to draw, because it is
  // the element the measurement reads its box from. Rendering it conditionally
  // meant the first pass had no element to measure and drew nothing, forever.
  return (
    <svg className="rbt__wires" ref={box} aria-hidden="true" focusable="false">
      {paths.map((path) => (
        <path key={path.key} className="rbt__wire" d={path.d} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The seven final-phase matches                                       */
/* ------------------------------------------------------------------ */

/**
 * The final phase as seven rows of one shape, whether or not the host has
 * generated it yet.
 *
 * The row *is* the match: a leading label of what it decides, the two sides, and a
 * status cell that only appears when it has something to say. Before generation
 * the sides read as dependencies ("Group A #3"); afterwards they are team names,
 * scores and a field. Same seven rows either way, so there is nothing to learn a
 * second time when the phase is confirmed.
 */
function FinalPhaseList({ state, rows }: { state: TournamentState; rows: FinalPhaseRow[] }) {
  const { t } = useI18n();
  return (
    <ol className="rbt__ladder">
      {rows.map((row) => {
        const done = row.state === 'FINISHED';
        const winnerA = done && row.match?.winnerId === row.match?.participantAId && row.match?.winnerId !== null;
        const winnerB = done && row.match?.winnerId === row.match?.participantBId && row.match?.winnerId !== null;
        return (
          <li
            key={row.key}
            className={cx('rbt__row', done && 'rbt__row--done', winnerA || winnerB ? 'rbt__row--decided' : undefined)}
          >
            <span className="rbt__row-label" title={row.purpose}>
              {row.shortLabel}
            </span>
            <span className="rbt__row-sides">
              {/* `data-slot` is the hook the connector measures against, so the
                  line from A1 lands on the row A1 actually plays in. */}
              <span className={cx('rbt__side', winnerA && 'rbt__side--winner')} data-slot={row.slotAKey ?? undefined}>
                {row.sideA}
              </span>
              <span className="rbt__row-score tnum" aria-hidden="true">
                {done && (row.scoreA !== null || row.scoreB !== null) ? `${row.scoreA ?? 0}:${row.scoreB ?? 0}` : '·'}
              </span>
              <span className={cx('rbt__side', winnerB && 'rbt__side--winner')} data-slot={row.slotBKey ?? undefined}>
                {row.sideB}
              </span>
            </span>
            <span className="rbt__row-status">
              {row.blockedBy ? (
                <span className="rbt__row-blocked tiny">waiting: {row.blockedBy}</span>
              ) : row.fieldId ? (
                <span className="tiny dim">{state.fields[row.fieldId]?.name ?? t('field.label', { n: row.fieldId })}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Places 1-10                                                         */
/* ------------------------------------------------------------------ */

/*
 * The places-1-10 list used to live here and was removed from the Competition
 * tab. `finalRankingRows` in `lib/radball10` still builds it -- it is what the
 * engine's ranking is read through, and `tests/tree.test.ts` pins its output --
 * so putting it back is a component over an existing, tested function rather
 * than a rewrite.
 */
