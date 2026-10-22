/**
 * Results and standings.
 *
 * A Radball competition is ranked group by group, so its standings are the
 * official tables -- the generic participant statistics would flatten groups
 * that never meet each other. That leaves exactly one thing worth putting on
 * this tab: every game the competition has. The tables those games produced
 * answer a different question and are on the Standings tab; everything else that
 * used to sit here -- participant statistics, the bracket tree, the
 * final-ranking list, the export buttons -- answers a question that belongs to
 * another page, and carrying it is what buried those two answers under a
 * screenful of controls.
 *
 * Every other format falls through to the generic report below, which is
 * derived from the live bracket and therefore already correct mid-tournament.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { Match, TournamentState } from '../../shared/types';
import { fieldName, isRealMatch, logoOf, nameOf } from '../../shared/matchUtils';
import { computeResults } from '../../shared/stats';
import { resultsCsv } from '../../shared/exports';
import { useLive } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { competitionFixtures, competitionProgress, gamesForResults, roundNameLabel } from '../lib/radball';
import { live } from '../lib/live';
import { navigate } from '../lib/router';
import { downloadBlob, formatDateTime, formatTime } from '../lib/util';
import { Badge, Button, Empty, MatchStateBadge, PageHeader, Panel, Switch } from '../components/primitives';
import { BracketView } from '../components/BracketView';
import { CrestWithName } from '../components/TeamCrest';
import { IconDownload } from '../components/icons';

type SortKey = 'place' | 'wins' | 'pointsFor' | 'winRate' | 'name';

export function ResultsPage() {
  const snapshot = useLive();
  const { locale, t } = useI18n();
  const state = snapshot.state;
  const [sort, setSort] = useState<SortKey>('place');
  const [showStats, setShowStats] = useState(true);
  const [showBracket, setShowBracket] = useState(false);
  const [filter, setFilter] = useState('');

  const results = useMemo(() => (state ? computeResults(state) : null), [state]);
  // The same progress definition the Competition tab uses, so the two headers
  // can never show different numbers for the same tournament.
  const progress = useMemo(() => (state ? competitionProgress(state) : { finished: 0, total: 0 }), [state]);
  // Every game of the competition, in the order the list reads them: the games
  // on a field right now, then the games still waiting to be played, then the
  // games that have been played.
  //
  // `competitionFixtures` itself stays in playing order -- "what do we call
  // next" is answered from it, and that answer has to stay oldest-first or
  // the queue would run backwards.
  const games = useMemo(() => (state ? gamesForResults(state) : []), [state]);

  const history = useMemo(() => {
    if (!state) return [];
    return Object.values(state.matches)
      .filter((match) => match.state === 'FINISHED' && isRealMatch(match))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }, [state]);

  const rows = useMemo(() => {
    if (!results) return [];
    const list = [...results.rows];
    if (filter.trim()) {
      const needle = filter.trim().toLowerCase();
      return list.filter(
        (row) => row.name.toLowerCase().includes(needle) || (row.team ?? '').toLowerCase().includes(needle),
      );
    }
    list.sort((a, b) => {
      switch (sort) {
        case 'wins':
          return b.wins - a.wins || b.pointDifference - a.pointDifference;
        case 'pointsFor':
          return b.pointsFor - a.pointsFor;
        case 'winRate':
          return b.winRate - a.winRate;
        case 'name':
          return a.name.localeCompare(b.name);
        default:
          return (a.place ?? 999) - (b.place ?? 999);
      }
    });
    return list;
  }, [results, sort, filter]);

  if (!state || !results) return <Empty>{t('conn.connecting')}…</Empty>;

  if (!state.tournament) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('results.noneYet')}</p>
        <Button tone="primary" onClick={() => navigate('/setup')}>
          {t('nav.setup')}
        </Button>
      </div>
    );
  }

  const outright = results.status === 'COMPLETED' && results.champion;

  // A Radball competition is only ever ranked group by group. The generic
  // report would merge teams into one ranking that the rules never produce --
  // and it is not what this tab is for either. So this tab is the games.
  //
  // The group tables that used to sit below them are on the Standings tab now.
  // They are a different question ("where does everyone stand", not "what has
  // been played"), and holding both meant a page you had to scroll to find
  // either -- on the one screen a hall reads between games.
  if (state.radball) {
    return (
      <div className="scroll stack g4">
        <PageHeader
          title={results.tournamentName}
          chips={
            <Badge tone={outright ? 'done' : 'live'} dot={!outright}>
              {outright ? t('match.finished') : t('match.running')}
            </Badge>
          }
          progress={{ done: progress.finished, total: progress.total, label: t('results.played') }}
        />

        <Panel title={`${t('results.title')} (${games.length})`} flush>
          <GamesTable state={state} games={games} />
        </Panel>
      </div>
    );
  }

  return (
    <div className="scroll">
      <PageHeader
        title={results.tournamentName}
        chips={
          <Badge tone={outright ? 'done' : 'live'} dot={!outright}>
            {outright ? t('match.finished') : t('match.running')}
          </Badge>
        }
        progress={{ done: progress.finished, total: progress.total, label: t('results.played') }}
        actions={
          <>
            <Switch checked={showStats} onChange={setShowStats} label={t('results.statistics')} />
            <Switch checked={showBracket} onChange={setShowBracket} label={t('nav.bracket')} />
            <Button
              size="sm"
              tone="ghost"
              onClick={() => window.open('/print/results', '_blank', 'noopener')}
              title={t('export.printResults')}
            >
              <IconDownload size={13} /> PDF
            </Button>
            <Button size="sm" tone="ghost" onClick={() => downloadBlob(resultsCsv(state), 'results.csv', 'text/csv;charset=utf-8')}>
              <IconDownload size={13} /> CSV
            </Button>
            <Button size="sm" tone="ghost" onClick={liveRefresh}>
              {t('action.refresh')}
            </Button>
          </>
        }
        facts={[
          { label: t('results.for'), value: <span className="tnum">{results.totalPoints}</span> },
          {
            label: t('setup.step.participants'),
            value: <span className="tnum">{Object.keys(state.participants).length}</span>,
          },
          {
            label: t('results.won'),
            value: <span className="tnum">{results.rows.filter((row) => row.wins > 0).length}</span>,
          },
          { label: t('results.generated'), value: formatDateTime(results.generatedAt, locale) },
        ]}
      />

      <div className="stack g4">
        {showStats ? (
          <Panel
            title={t('results.participantStats')}
            flush
            actions={
              <>
                <input
                  className="input input--sm"
                  style={{ width: 180 }}
                  placeholder={t('ph.search')}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  aria-label={t('ph.search')}
                />
                <select
                  className="select"
                  style={{ width: 160 }}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                  aria-label={t('results.sortAria')}
                >
                  <option value="place">{t('results.sortPlace')}</option>
                  <option value="wins">{t('results.sortWins')}</option>
                  <option value="pointsFor">{t('results.sortPoints')}</option>
                  <option value="winRate">{t('results.sortWinRate')}</option>
                  <option value="name">{t('results.sortName')}</option>
                </select>
              </>
            }
          >
            <div className="scroll" style={{ maxHeight: '46vh' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('results.participant')}</th>
                    <th>{t('results.team')}</th>
                    <th className="num">{t('results.played')}</th>
                    <th className="num">{t('results.won')}</th>
                    <th className="num">{t('results.lost')}</th>
                    <th className="num">{t('results.drawn')}</th>
                    <th className="num">{t('results.for')}</th>
                    <th className="num">{t('results.against')}</th>
                    <th className="num">{t('results.diff')}</th>
                    <th className="num">{t('results.winPct')}</th>
                    <th>{t('results.out')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.participantId}>
                      <td className="num">{row.place}</td>
                      <td>
                        <CrestWithName logo={logoOf(state, row.participantId)} name={row.name} />
                      </td>
                      <td className="dim">{row.team ?? '—'}</td>
                      <td className="num">{row.played}</td>
                      <td className="num">{row.wins}</td>
                      <td className="num">{row.losses}</td>
                      <td className="num">{row.draws}</td>
                      <td className="num">{row.pointsFor}</td>
                      <td className="num">{row.pointsAgainst}</td>
                      <td className="num">{row.pointDifference > 0 ? `+${row.pointDifference}` : row.pointDifference}</td>
                      <td className="num">{row.winRate}%</td>
                      <td className="dim small">{row.place === 1 ? t('results.champion') : (row.eliminatedInRoundName ?? '—')}</td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="empty">
                        No participant matches that filter.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        {showBracket ? (
          <Panel title={t('nav.bracket')} flush>
            <div style={{ height: '58vh' }}>
              <BracketView state={state} showToolbar />
            </div>
          </Panel>
        ) : null}

        <Panel title={t('results.matchHistory', { n: history.length })} flush>
          {history.length === 0 ? (
            <Empty>{t('results.noMatches')}</Empty>
          ) : (
            <div className="scroll" style={{ maxHeight: '46vh' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('results.time')}</th>
                    <th>{t('round.round')}</th>
                    <th>{t('results.field')}</th>
                    <th>{t('results.match')}</th>
                    <th className="num">{t('a11y.score')}</th>
                    <th>{t('score.winner')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((match) => (
                    <tr key={match.id}>
                      <td className="mono small">{formatTime(match.finishedAt ?? 0, locale)}</td>
                      <td className="small">
                        {roundNameLabel(match.roundName, asTranslate(t))}
                        {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
                      </td>
                      <td className="small dim">{match.fieldId ? fieldName(state, match.fieldId) : '—'}</td>
                      <td>
                        {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                        {nameOf(state, match.participantBId)}
                      </td>
                      <td className="num tnum">
                        {match.scoreA} : {match.scoreB}
                        {match.halftimeScore ? (
                          <span className="results__half" title={t('results.halftimeScore')}>
                            {' '}
                            ({match.halftimeScore.a} : {match.halftimeScore.b})
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {match.winnerId ? (
                          <strong>{nameOf(state, match.winnerId)}</strong>
                        ) : (
                          <span className="dim">{t('score.draw')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The games                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every game the competition has, newest round first.
 *
 * "Available" is taken literally. A fixture that has not been kicked off is a
 * game too, and a list of finished matches only would leave a reader unable to
 * tell a tournament that is half over from one that has stalled -- so the
 * unplayed rows stay in and say so instead of being hidden or collapsed behind
 * a toggle.
 *
 * The score and the live state live inside the fixture cell rather than in
 * columns of their own. A results table stretched across a projector gives every
 * pixel of slack to its widest column, so a separate score column drifted half a
 * screen away from the two teams it belonged to, and a separate state column
 * spent its width on a dash for every row that had actually been played. Held
 * together in one cell they stay welded to their fixture at any width, and the
 * row reduces to what a score sheet has: who played, what the score was, and
 * when it finished.
 */
function GamesTable({ state, games }: { state: TournamentState; games: Match[] }) {
  const { locale, t } = useI18n();
  if (games.length === 0) return <Empty>{t('results.noMatches')}</Empty>;
  return (
    <div className="scroll" style={{ maxHeight: '46vh' }}>
      <table className="table rb-games">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>{t('round.round')}</th>
            <th>{t('results.game')}</th>
            <th className="num">{t('results.time')}</th>
          </tr>
        </thead>
        <tbody>
          {games.map((match) => {
            // A game that was played has a result, even a goalless one: a
            // finished 0:0 is a draw that happened, while an unplayed
            // fixture says so with its state badge -- printing 0 : 0 for it
            // would read as a goalless draw that never happened.
            const started = match.scoreA > 0 || match.scoreB > 0 || match.state === 'FINISHED';
            // The score the teams had when the half ended, for a game that got
            // that far. It sits beside the final one, the way a result is
            // reported: "5 : 3 (2 : 1)".
            const halftime = match.halftimeScore;
            // The game's number in the order it is played, not its row on this
            // screen: the list is ordered by when things happened, and a game
            // keeps the number it was given when the draw was made. A row
            // index would read "1" on the first game played and "20" on the
            // last one, as if the last game were the first.
            const number = competitionFixtures(state).findIndex((m) => m.id === match.id) + 1;
            return (
              <tr key={match.id}>
                <td className="num faint tnum">{number}</td>
                {/* The round name carries the group ("Group A · Round 2"), which is
                    what ties a row to the table it feeds further down. */}
                <td className="small dim nowrap">
                  {roundNameLabel(match.roundName, asTranslate(t))}
                </td>
                <td>
                  <span className="rb-games__fixture">
                    {fixtureSide(state, match, match.participantAId)}
                    <span className="rb-games__vs">vs</span>
                    {fixtureSide(state, match, match.participantBId)}
                  </span>
                  <span className="rb-games__score">
                    {started ? (
                      <>
                        {match.scoreA} : {match.scoreB}
                        {halftime ? (
                          <span className="rb-games__half" title={t('results.halftimeScore')}>
                            {' '}
                            ({halftime.a} : {halftime.b})
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                  {match.state === 'FINISHED' ? null : <MatchStateBadge state={match.state} />}
                  {match.radball?.kind === 'decision' ? <span className="rb-tag">{t('round.decision')}</span> : null}
                  {match.radball?.shootout ? <span className="rb-tag rb-tag--shootout">{t('radball.shootout')}</span> : null}
                </td>
                <td className="num mono small faint nowrap">{match.finishedAt ? formatTime(match.finishedAt, locale) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One side of a fixture. The winner is the only name that gets weight. */
function fixtureSide(state: TournamentState, match: Match, id: string | null): ReactNode {
  const name = nameOf(state, id);
  return (
    <CrestWithName
      logo={logoOf(state, id)}
      name={match.winnerId !== null && match.winnerId === id ? <strong>{name}</strong> : name}
    />
  );
}

function liveRefresh(): void {
  live.resync();
}
