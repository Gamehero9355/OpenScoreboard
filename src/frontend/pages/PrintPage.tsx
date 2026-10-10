/**
 * Printable report.
 *
 * "Export PDF" is the browser's own print dialog pointed at a purpose-built
 * page: no server-side PDF library, nothing to download, and it works with the
 * machine offline. Three report kinds share one layout so the printed pack for
 * an event always looks the same.
 */
import { useEffect, useMemo } from 'react';
import type { TournamentFormat } from '../../shared/types';
import { isRealMatch, nameOf } from '../../shared/matchUtils';
import { computeResults } from '../../shared/stats';
import { useDocumentTitle, useLive } from '../lib/hooks';
import { useI18n } from '../lib/useI18n';
import type { MessageKey } from '../lib/i18n';
import { formatDateTime, formatTime } from '../lib/util';
import { Button, Empty } from '../components/primitives';
import { BracketView } from '../components/BracketView';

export type PrintKind = 'results' | 'bracket' | 'history';

/**
 * The report headings, keyed by report kind.
 *
 * A map of keys rather than of strings, for the same reason as every other label
 * table in this app: this runs before a component exists, so it stores the
 * catalogue key and the heading is looked up in the render.
 */
const TITLES: Record<PrintKind, MessageKey> = {
  results: 'results.title',
  bracket: 'nav.bracket',
  history: 'export.printHistory',
};

/**
 * The format's own name, for the report's subtitle.
 *
 * A map rather than a chain of ternaries because a printed pack outlives the
 * hall that produced it: a format nobody remembered to add here would print as
 * "Single elimination" for a Radball World Cup, which is a lie on paper.
 */
const FORMAT_NAMES: Record<TournamentFormat, MessageKey> = {
  'single-elimination': 'format.single-elimination',
  'double-elimination': 'format.double-elimination',
  radball: 'format.radball',
  'manual-schedule': 'format.manual-schedule',
};

export function PrintPage({ kind }: { kind: PrintKind }) {
  const snapshot = useLive();
  const { locale, t } = useI18n();
  const state = snapshot.state;
  const results = useMemo(() => (state ? computeResults(state) : null), [state]);

  useDocumentTitle(`${t(TITLES[kind])} · ${state?.tournament?.name ?? t('app.name')}`);

  const history = useMemo(() => {
    if (!state) return [];
    return Object.values(state.matches)
      .filter((match) => match.state === 'FINISHED' && isRealMatch(match))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  }, [state]);

  // Printing is an explicit click: a report that fires the dialog on load
  // cannot be proof-read first.
  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);

  if (!state || !results) return <Empty>{t('conn.connecting')}…</Empty>;

  return (
    <div className="report">
      <header className="report__head">
        <div className="stack g2">
          <h1 className="report__title">{state.tournament?.name ?? state.settings.tournamentName}</h1>
          <span className="tiny dim">
            {t(TITLES[kind])} · {t(FORMAT_NAMES[state.tournament?.format ?? 'single-elimination'])}
          </span>
        </div>
        <div className="stack g1">
          <span className="report__meta">
            {t('print.summary', {
              participants: Object.keys(state.participants).length,
              matches: results.finishedMatches,
            })}
          </span>
          <span className="report__meta">{`${t('action.print')} ${formatDateTime(Date.now(), locale)}`}</span>
        </div>
      </header>

      <div className="btn-row no-print">
        <Button tone="primary" onClick={() => window.print()}>
          {t('action.print')}
        </Button>
        <Button tone="ghost" onClick={() => window.close()}>
          {t('action.close')}
        </Button>
      </div>

      {kind === 'results' ? (
        <>
          <div className="report__podium">
            <div className="podium podium--1">
              <span className="podium__place">{t('results.champion')}</span>
              <span className="podium__name">{results.champion?.name ?? '—'}</span>
              <span className="hint">{results.champion?.team ?? ''}</span>
            </div>
            <div className="podium podium--2">
              <span className="podium__place">{t('print.runnerUp')}</span>
              <span className="podium__name">{results.runnerUp?.name ?? '—'}</span>
              <span className="hint">{results.runnerUp?.team ?? ''}</span>
            </div>
            <div className="podium podium--3">
              <span className="podium__place">{t('round.thirdPlace')}</span>
              <span className="podium__name">{results.thirdPlace?.name ?? '—'}</span>
              <span className="hint">{results.thirdPlace?.team ?? ''}</span>
            </div>
          </div>

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
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={row.participantId}>
                  <td className="num">{row.place}</td>
                  <td>{row.name}</td>
                  <td>{row.team ?? ''}</td>
                  <td className="num">{row.played}</td>
                  <td className="num">{row.wins}</td>
                  <td className="num">{row.losses}</td>
                  <td className="num">{row.draws}</td>
                  <td className="num">{row.pointsFor}</td>
                  <td className="num">{row.pointsAgainst}</td>
                  <td className="num">{row.pointDifference}</td>
                  <td className="num">{row.winRate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {kind === 'bracket' ? (
        <div style={{ height: '70vh' }}>
          <BracketView state={state} showToolbar={false} />
        </div>
      ) : null}

      {kind === 'history' ? (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('round.round')}</th>
              <th>{t('results.field')}</th>
              <th>{t('match.finished')}</th>
              <th>{t('results.match')}</th>
              <th className="num">{t('a11y.score')}</th>
              <th>{t('score.winner')}</th>
            </tr>
          </thead>
          <tbody>
            {history.map((match, index) => (
              <tr key={match.id}>
                <td className="num">{index + 1}</td>
                <td>
                  {match.roundName}
                  {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
                </td>
                <td>{match.fieldId ? state.fields[match.fieldId].name : ''}</td>
                <td className="mono small">{formatTime(match.finishedAt ?? 0, locale)}</td>
                <td>
                  {nameOf(state, match.participantAId)} vs {nameOf(state, match.participantBId)}
                </td>
                <td className="num">
                  {match.scoreA} : {match.scoreB}
                </td>
                <td>{match.winnerId ? nameOf(state, match.winnerId) : t('score.draw')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <footer className="small dim">
        Scores recorded on {state.settings.fieldNames.join(' and ')} · every change is kept in the local event log
        ({state.events.length} recent entries shown in the app, full history exportable as CSV).
      </footer>
    </div>
  );
}
