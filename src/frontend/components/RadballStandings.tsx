/**
 * The official Radball standings.
 *
 * These tables live on the Results tab only: the competition page answers
 * "who plays next", this one answers "where does everyone stand". Every number
 * is server state (`competition.tables`) -- nothing here recomputes points,
 * ranks or qualification.
 */
import type { StandingRow, TournamentState } from '../../shared/types';
import { logoOf, nameOf } from '../../shared/matchUtils';
import { groupNameLabel, phaseNameLabel, phaseViews, standingStatusLabel } from '../lib/radball';
import { asTranslate, useI18n } from '../lib/useI18n';
import { Empty, Panel } from './primitives';
import { CrestWithName } from './TeamCrest';

/**
 * One table per group, grouped under the phase they belong to.
 *
 * Renders nothing when the tournament carries no Radball competition, so the
 * results page can call it unconditionally.
 *
 * The group and phase names are server data -- the host typed them into the setup
 * wizard -- so they are printed as they are. Only this component's own words go
 * through the catalogue: the header line, the column headers and the status
 * column.
 */
export function RadballStandings({ state }: { state: TournamentState }) {
  const { t } = useI18n();
  const competition = state.radball;
  if (!competition) return null;
  const views = phaseViews(competition).filter((view) => view.groups.length > 0);
  if (views.length === 0) return <Empty>{t('radball.noGroups')}</Empty>;
  return (
    <>
      {views.map(({ phase, groups }) => (
        <Panel
          key={phase.id}
          title={phaseNameLabel(phase, asTranslate(t))}
          flush
        >
          <div className="rb-phase">
            {groups.map((group) => (
              <section className="rb-group" key={group.id}>
                <header className="between">
                  <h3 className="rb-group__title">{groupNameLabel(group.name, asTranslate(t))}</h3>
                  <span className="tiny faint">
                    {/* A pinned field is not decoration: in the 10-team format it
                        is what lets the two groups run in parallel, so a reader
                        checking the schedule can see it stated. */}
                    {group.fieldId
                      ? `${state.fields[group.fieldId]?.name ?? t('field.label', { n: group.fieldId })} · `
                      : null}
                    {group.qualifies > 0
                      ? t('radball.topAdvance', { n: group.qualifies })
                      : t('radball.finalTable')}{' '}
                    ·{' '}
                    {group.doubleRoundRobin
                      ? t('tree.doubleRoundRobin')
                      : t('tree.singleRoundRobin')}
                  </span>
                </header>
                <StandingsTable
                  state={state}
                  rows={competition.tables[group.id] ?? []}
                  cut={group.qualifies}
                />
              </section>
            ))}
          </div>
        </Panel>
      ))}
    </>
  );
}

/**
 * The official table. Qualification positions are highlighted, ties carry an
 * explicit label, and the status is always readable as text, never colour
 * alone (§26).
 */
export function StandingsTable({
  state,
  rows,
  cut,
}: {
  state: TournamentState;
  rows: StandingRow[];
  cut: number;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return <Empty>{t('results.noMatches')}</Empty>;
  return (
    <div className="rb-tablewrap">
      <table className="table rb-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>{t('results.team')}</th>
            <th className="num" title={t('results.played')}>
              MP
            </th>
            <th className="num" title={t('results.won')}>
              W
            </th>
            <th className="num" title={t('results.drawn')}>
              D
            </th>
            <th className="num" title={t('results.lost')}>
              L
            </th>
            <th className="num" title={t('results.for')}>
              GF
            </th>
            <th className="num" title={t('results.against')}>
              GA
            </th>
            <th className="num" title={t('results.diff')}>
              GD
            </th>
            <th className="num" title={t('results.pts')}>
              PTS
            </th>
            <th>{t('radball.statusColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cls =
              row.status === 'tied'
                ? 'rb-row rb-row--tied'
                : row.rank <= cut && cut > 0
                  ? 'rb-row rb-row--qualified'
                  : row.status === 'eliminated'
                    ? 'rb-row rb-row--out'
                    : 'rb-row';
            return (
              <tr key={row.teamId} className={cls}>
                <td className="num tnum">{row.rank}</td>
                <td>
                  <CrestWithName
                    logo={logoOf(state, row.teamId)}
                    name={<strong>{nameOf(state, row.teamId)}</strong>}
                  />
                </td>
                <td className="num tnum">{row.played}</td>
                <td className="num tnum">{row.won}</td>
                <td className="num tnum">{row.drawn}</td>
                <td className="num tnum">{row.lost}</td>
                <td className="num tnum">{row.goalsFor}</td>
                <td className="num tnum">{row.goalsAgainst}</td>
                <td className="num tnum">{row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}</td>
                <td className="num tnum rb-pts">{row.points}</td>
                <td className="rb-status">{row.note ?? standingStatusLabel(row, asTranslate(t))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
