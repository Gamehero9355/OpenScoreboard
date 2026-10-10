/**
 * Bracket display.
 *
 * The tree is derived from live state, so a finished match moves its winner
 * forward on every screen without anybody pressing reload. Zoom, pan and
 * fullscreen make it usable both in a browser tab at the desk and on a wall
 * projector.
 */
import { useMemo } from 'react';
import { fieldIds, firstFieldMatchId, isRealMatch, nameOf } from '../../shared/matchUtils';
import { computeResults } from '../../shared/stats';
import { useLive, useWakeLock } from '../lib/hooks';
import { useI18n } from '../lib/useI18n';
import { tr } from '../lib/i18n';
import { live } from '../lib/live';
import { navigate } from '../lib/router';
import { Badge, Button, ConnectionBadge, Empty, PageHeader } from '../components/primitives';
import { BracketView } from '../components/BracketView';
import { IconDownload, IconExpand, IconRefresh } from '../components/icons';
import { downloadBlob } from '../lib/util';
import { resultsCsv } from '../../shared/exports';

export function BracketPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const state = snapshot.state;
  const isAdmin = snapshot.role === 'admin';
  useWakeLock(true);

  const currentMatchId = state ? firstFieldMatchId(state) : null;

  const summary = useMemo(() => {
    if (!state) return null;
    const results = computeResults(state);
    const onFields = fieldIds(state)
      .map((fieldId) => {
        const id = state.fields[fieldId].matchId;
        const match = id ? state.matches[id] : null;
        if (!match) return null;
        return `${state.fields[fieldId].name}: ${nameOf(state, match.participantAId)} vs ${nameOf(state, match.participantBId)}`;
      })
      .filter((entry): entry is string => Boolean(entry));
    return { results, onFields };
  }, [state]);

  // §40: a Radball competition is a progression tree, not a knockout bracket --
  // groups, qualification, a final round and a champion. It used to be punted to
  // the phase overview, which meant the one screen a hall is pointed at to answer
  // "where has my team got to" never showed a tree at all. It renders here now,
  // and the overview keeps the job it is better at: who plays next.
  //
  // The check has to stay below every hook: returning early while the state is
  // still arriving and not afterwards changes the hook count between renders,
  // which unmounts the whole app.
  const isRadball = Boolean(state?.radball && state.tournament?.format === 'radball');

  if (!state) {
    return <Empty>{t('conn.connecting')}…</Empty>;
  }

  const finishedCount = Object.values(state.matches).filter((match) => match.state === 'FINISHED' && isRealMatch(match)).length;

  return (
    <>
      <PageHeader
        title={state.tournament?.name ?? t('err.noTournament')}
        chips={
          <>
            <Badge tone={state.tournament?.status === 'COMPLETED' ? 'done' : 'live'} dot={state.tournament?.status !== 'COMPLETED'}>
              {state.tournament?.status === 'COMPLETED' ? t('match.finished') : t('match.running')}
            </Badge>
            <ConnectionBadge />
            {summary?.results.champion ? (
              <Badge tone="live">
                {t('results.champion')}: {summary.results.champion.name}
              </Badge>
            ) : null}
          </>
        }
        progress={{ done: finishedCount, total: Object.keys(state.matches).length, label: t('results.played') }}
        actions={
          <>
            <Button size="sm" tone="ghost" onClick={() => navigate('/display')} title={t('bracket.openDisplayTitle')}>
              <IconExpand size={13} /> {t('nav.display')}
            </Button>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => window.open('/print/bracket', '_blank', 'noopener')}
              title={t('export.printBracket')}
            >
              {t('action.print')}
            </Button>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => downloadBlob(resultsCsv(state), 'results.csv', 'text/csv;charset=utf-8')}
            >
              <IconDownload size={13} /> CSV
            </Button>
            {isAdmin ? (
              <Button size="sm" tone="ghost" onClick={() => liveRefresh()} title={t('bracket.refreshTitle')}>
                <IconRefresh size={13} /> {t('action.refresh')}
              </Button>
            ) : null}
          </>
        }
      />

      {summary && summary.onFields.length > 0 ? (
        <p className="banner banner--info" style={{ borderBottom: 0 }}>
          <span className="tiny">{t('bracket.onFields')}</span>
          <span className="grow small">{summary.onFields.join('   ·   ')}</span>
        </p>
      ) : null}

      <BracketView state={state} currentMatchId={currentMatchId} />

      {/* The status line says what this screen actually is. A knockout advances
          by itself; a league advances when its tables are cut, and saying
          otherwise on a Radball tree is the kind of small lie that makes a
          hall stop trusting the wall. */}
      <div className="statusbar">
        {isRadball ? (
          <>
            <span className="statusbar__item tiny">
              {t('bracket.matchesPhases', {
                n: Object.keys(state.matches).length,
                m: state.radball?.phaseOrder.length ?? 0,
              })}
            </span>
            <span className="statusbar__item tiny faint">
              {t('bracket.cutNote', { n: maxQualifies(state) })}
            </span>
            <span className="grow" />
            <span className="statusbar__item tiny faint">{t('bracket.finalRoundNote')}</span>
          </>
        ) : (
          <>
            <span className="statusbar__item tiny">
              {t('bracket.matchesRounds', {
                n: Object.keys(state.matches).length,
                m: roundCount(state),
              })}
            </span>
            <span className="statusbar__item tiny faint">
              {state.tournament?.seeded
                ? t('bracket.seededBracket', {
                    n: state.tournament.seedValue ?? t('bracket.auto'),
                  })
                : t('bracket.manualBracket')}
            </span>
            <span className="grow" />
            <span className="statusbar__item tiny faint">{t('bracket.roundNote')}</span>
          </>
        )}
      </div>
    </>
  );
}

/** The widest qualification cut in the competition, for the status line. */
function maxQualifies(state: NonNullable<ReturnType<typeof useLive>['state']>): number {
  let widest = 0;
  for (const groupId of state.radball?.groupOrder ?? []) {
    widest = Math.max(widest, state.radball?.groups[groupId]?.qualifies ?? 0);
  }
  return widest;
}

function roundCount(state: NonNullable<ReturnType<typeof useLive>['state']>): number {
  return new Set(Object.values(state.matches).map((match) => `${match.bracket}:${match.round}`)).size;
}

/** Forces a full snapshot from the host; used when a screen was suspended. */
function liveRefresh(): void {
  live.resync();
  live.pushToast('info', tr('bracket.refreshToast'));
}
