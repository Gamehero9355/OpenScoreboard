/**
 * Radball competition schedule -- the dedicated page for the 2er-Radball
 * tournament mode. It answers exactly one question: which matches are on,
 * which come next and which are done.
 *
 *   PHASE -> GROUP/ROUND -> MATCH -> (played) -> TABLE -> QUALIFICATION
 *
 * The tables themselves live on the Results tab; this page never shows a
 * standing, only fixtures. Everything shown is server state (`state.radball`);
 * the page computes nothing official. Spectator-safe: mutating buttons render
 * only for admins.
 */
import { useMemo, useState } from 'react';
import type { Match, TournamentState } from '../../shared/types';
import { radballDecisionSec, radballMatchSec } from '../../shared/types';
import { fieldDisplayName, nameOf } from '../../shared/matchUtils';
import {
  competitionProgress,
  decisionReasonLabel,
  fixtureRole,
  fixturesForDisplay,
  matchKindLabel,
  nextFixtureToCall,
  openDecisionMatches,
  phaseViews,
  readableAgeClass,
  readableRuleset,
  roundNameLabel,
  type FixtureRole,
} from '../lib/radball';
import { live } from '../lib/live';
import { useLive } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { tr } from '../lib/i18n';
import { navigate } from '../lib/router';
import { cx, formatTime } from '../lib/util';
import {
  Badge,
  Button,
  ConnectionBadge,
  Empty,
  MatchStateBadge,
  PageHeader,
  Panel,
} from '../components/primitives';
import { IconAlert, IconTrophy } from '../components/icons';
import { ShootoutPanel } from '../components/ShootoutPanel';

export function RadballPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const state = snapshot.state;
  const isAdmin = snapshot.role === 'admin';
  const [busy, setBusy] = useState(false);

  const competition = state?.radball ?? null;
  const views = useMemo(() => (state && competition ? phaseViews(competition) : []), [state, competition]);
  // The competition as one list: matches on a field first, then the rest in
  // playing order. Both are derived, never stored.
  const fixtures = useMemo(() => (state ? fixturesForDisplay(state) : []), [state]);
  const callId = useMemo(() => (state ? nextFixtureToCall(state, fixtures) : null), [state, fixtures]);
  const progress = useMemo(() => (state ? competitionProgress(state) : { finished: 0, total: 0 }), [state]);
  // Phase name per match, so a fixture row says which part of the competition
  // it belongs to even though the lists are flat.
  const phaseNames = useMemo(() => {
    const map = new Map<string, string>();
    if (!competition) return map;
    for (const id of competition.phaseOrder) {
      const phase = competition.phases[id];
      if (phase) map.set(phase.id, phase.name);
    }
    return map;
  }, [competition]);

  if (!state || !state.tournament) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('err.noTournament')}</p>
        <Button tone="primary" onClick={() => navigate('/setup')}>
          {t('nav.setup')}
        </Button>
      </div>
    );
  }
  if (!competition) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('radball.notRadball')}</p>
        <p className="hint">
          {t('radball.notRadballBefore')}{' '}
          <a href="/bracket">{t('nav.bracket')}</a> {t('radball.notRadballAfter')}
        </p>
        <Button tone="primary" onClick={() => navigate('/setup')}>
          {t('nav.setup')}
        </Button>
      </div>
    );
  }

  const openDecisions = openDecisionMatches(state);
  const config = competition.config;
  const matchSeconds = radballMatchSec(config);
  const decisionSeconds = radballDecisionSec(config);
  const champion = competition.championId ? state.participants[competition.championId] : null;

  const runQualify = async () => {
    setBusy(true);
    const result = await live.command('radball.qualify', {});
    setBusy(false);
    if (result.ok) live.pushToast('success', tr('radball.finalCreated'));
    else live.pushToast('warn', result.error ?? t('err.generic'));
  };

  // The final round has not been drawn yet and every entry phase is under way,
  // so the qualified teams can be carried over now.
  const qualificationReady = Boolean(
    competition.pendingFinal && views.every((view) => view.phase.status === 'RUNNING' && view.phase.kind !== 'final-round'),
  );

  const finished = state.tournament.status === 'COMPLETED';
  const matchMinutes = Math.round(matchSeconds / 120);
  const decisionMinutes = Math.round(decisionSeconds / 60);

  return (
    <div className="scroll stack g4">
      <PageHeader
        title={state.tournament.name}
        chips={
          <>
            <Badge tone={finished ? 'done' : 'live'} dot={!finished}>
              {finished ? t('match.finished') : t('match.running')}
            </Badge>
            <ConnectionBadge />
          </>
        }
        progress={{ done: progress.finished, total: progress.total, label: t('results.played') }}
        facts={[
          { label: t('radball.ruleset'), value: readableRuleset(config.rulesetVersion) },
          { label: t('radball.ageCategory'), value: readableAgeClass(config.ageCategory) },
          {
            label: t('results.match'),
            value: config.reducedTime
              ? `2 × 5 min · ${t('radball.reducedTime')}`
              : `2 × ${matchMinutes} min`,
          },
          { label: t('radball.decisionLabel'), value: `1 × ${decisionMinutes} min` },
        ]}
      />

      {openDecisions.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <IconAlert size={15} />
          <span className="grow">
            <strong>{t('radball.tieDetected')}</strong>{' '}
            {decisionReasonLabel(openDecisions[0].radball?.decisionReason, asTranslate(t))}:{' '}
            {openDecisions.map((match) => `${nameOf(state, match.participantAId)} vs ${nameOf(state, match.participantBId)}`).join(', ')}
          </span>
          <Button
            size="sm"
            onClick={() =>
              document.getElementById(`decision-${openDecisions[0].id}`)?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            {t('round.decision')}
          </Button>
        </div>
      ) : null}

      {champion ? (
        <div className="banner banner--info" role="status">
          <IconTrophy size={15} />
          <span className="grow">
            <strong>{t('results.champion')}: {champion.name}</strong>
            {champion.team ? <span className="dim"> · {champion.team}</span> : null}
          </span>
        </div>
      ) : null}

      {/* Qualification used to hang off the phase-flow graph. It cannot live in
          the schedule at all: the final round's matches do not exist yet, so
          there is no fixture to list -- only a pending action. */}
      {qualificationReady ? (
        <div className="banner banner--warn" role="status">
          <span className="grow">
            <strong>{t('radball.qualificationReady')}</strong> {t('radball.qualificationReadyHint')}
          </span>
          {isAdmin ? (
            <Button size="sm" onClick={runQualify} busy={busy} disabled={openDecisions.length > 0}>
              {t('radball.runQualification')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------- the list --
          One list, first fixture to last. The two rows that need attention are
          marked in place -- green for the field being played, blue for the match
          to call -- so the running of the whole competition reads top to bottom
          without splitting it into panels that hide each other. */}
      <FixtureListPanel
        state={state}
        fixtures={fixtures}
        callId={callId}
        phaseNames={phaseNames}
        isAdmin={isAdmin}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The one list                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every fixture of the competition, in the order it is played.
 *
 * The list is deliberately not split by status. An organiser asks two questions
 * -- what is on, and what is left -- and the answer to both is "read down this
 * column". Splitting it into panels meant the next match was in one panel while
 * the match being played was in another, and the two had to be read together.
 *
 * Rows carry their own state, and the open decision matches expand into the
 * full shootout card in the position they fall, so the one list stays the only
 * place anything has to be looked at.
 */
function FixtureListPanel({
  state,
  fixtures,
  callId,
  phaseNames,
  isAdmin,
}: {
  state: TournamentState;
  fixtures: Match[];
  callId: string | null;
  phaseNames: Map<string, string>;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const onNow = fixtures.filter((match) => fixtureRole(state, match, callId) === 'live').length;
  return (
    <Panel
      title={t('radball.matchesCount', { n: fixtures.length })}
      flush
      actions={
        fixtures.length > 0 ? (
          <span className="tiny faint nowrap">
            {onNow > 0 ? `${t('radball.onNow', { n: onNow })} · ` : ''}
            {callId ? t('radball.firstUnplayed') : t('radball.allPlayed')}
          </span>
        ) : null
      }
    >
      {fixtures.length === 0 ? (
        <Empty>{t('results.noMatches')}</Empty>
      ) : (
        <div className="compact-list rb-schedule">
          {fixtures.map((match) => {
            const role = fixtureRole(state, match, callId);
            // Only a decision match has anything to expand into: the 4-meter
            // board is the only control on this page that a one-line row cannot
            // carry. A group match stays a row whatever its role.
            if (match.radball?.kind === 'decision' && role !== 'done') {
              return <DecisionCard key={match.id} state={state} match={match} isAdmin={isAdmin} />;
            }
            return (
              <ScheduleRow
                key={match.id}
                state={state}
                match={match}
                phase={phaseNames.get(match.radball?.phaseId ?? '') ?? null}
                variant={role}
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/**
 * One fixture in the list.
 *
 * The variant is the role from `fixtureRole`, so the row and the list can never
 * disagree about what a match is doing. `done` and `waiting` get no colour: a
 * finished match is history and a match missing a side is not actionable, so
 * neither should compete for attention with the two rows that are.
 */
function ScheduleRow({
  state,
  match,
  phase,
  variant,
}: {
  state: TournamentState;
  match: Match;
  phase: string | null;
  variant: FixtureRole;
}) {
  const meta = match.radball;
  const { locale, t } = useI18n();
  const level = match.state === 'FINISHED' && match.scoreA === match.scoreB;
  return (
    <div
      className={cx(
        'compact-list__row',
        variant === 'live' && 'rb-schedule__row--live',
        variant === 'call' && 'rb-schedule__row--call',
      )}
    >
      {/* The round, not the phase. Within a group stage every row shares one
          phase name, so labelling rows by phase printed the same word six times
          and left the order looking arbitrary. The round is what actually
          changes from row to row and explains the sequence. */}
      <span
        className="tiny faint nowrap"
        title={phase ? `${phase} · ${roundNameLabel(match.roundName, asTranslate(t))}` : roundNameLabel(match.roundName, asTranslate(t))}
      >
        {roundNameLabel(match.roundName, asTranslate(t))}
      </span>
      <span className={cx('grow nowrap', variant === 'call' && 'rb-schedule__teams')}>
        {nameOf(state, match.participantAId)} <span className="faint">vs</span> {nameOf(state, match.participantBId)}
        {variant === 'call' ? (
          <span className="rb-tag rb-tag--next">{t('radball.callThis')}</span>
        ) : null}
        {meta?.kind === 'decision' ? <span className="rb-tag">{t('round.decision')}</span> : null}
        {meta?.shootout ? <span className="rb-tag rb-tag--shootout">{t('radball.shootout')}</span> : null}
      </span>
      {match.fieldId ? (
        <span className="tiny faint nowrap">
          {fieldDisplayName(state.fields[match.fieldId]?.name, match.fieldId, asTranslate(t))}
        </span>
      ) : null}
      {match.state === 'FINISHED' ? (
        <>
          <span className="small tnum nowrap">
            <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
          </span>
          <span className="small nowrap" style={{ minWidth: '7rem' }}>
            {match.winnerId ? (
              <strong className="rb-win">{nameOf(state, match.winnerId)}</strong>
            ) : level ? (
              <span className="faint">{t('score.draw')}</span>
            ) : null}
          </span>
          <span className="tiny faint nowrap mono">{formatTime(match.finishedAt ?? 0, locale)}</span>
        </>
      ) : (
        <>
          <span className="small tnum nowrap">
            {match.scoreA > 0 || match.scoreB > 0 ? (
              <>
                <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
              </>
            ) : (
              <span className="faint">—</span>
            )}
          </span>
          <span style={{ minWidth: '7rem' }}>
            <MatchStateBadge state={match.state} />
          </span>
        </>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Decision matches incl. shootout                                     */
/* ------------------------------------------------------------------ */

function DecisionCard({ state, match, isAdmin }: { state: TournamentState; match: Match; isAdmin: boolean }) {
  const meta = match.radball;
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const shootout = meta?.shootout ?? null;
  // An unplayed match is 0:0, which is level by arithmetic and level by
  // nothing else -- announcing a shootout for a match that has not been kicked
  // off is nonsense. Level only means something once the match has actually
  // been played.
  const played = match.state === 'FINISHED' || match.history.length > 0 || shootout !== null;
  const level = played && match.scoreA === match.scoreB;
  const decided = shootout?.decided && shootout.winnerId;
  const config = state.radball?.config;
  const seconds = config ? radballDecisionSec(config) : 300;

  const record = async (side: 'A' | 'B', shooter: number, hit: boolean) => {
    setBusy(true);
    const result = await live.command('radball.shootoutRecord', { matchId: match.id, side, shooter, hit });
    setBusy(false);
    if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
  };

  const resetShootoutState = async () => {
    setBusy(true);
    const result = await live.command('radball.shootoutReset', { matchId: match.id });
    setBusy(false);
    if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
  };

  const confirmWinner = async () => {
    setBusy(true);
    const result = await live.command('match.finish', { matchId: match.id, force: true });
    setBusy(false);
    if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
  };

  return (
    <div className={cx('rb-decision', shootout ? 'rb-decision--shootout' : undefined)} id={`decision-${match.id}`}>
      <header className="between">
        <div className="stack g1">
          <span className="tiny dim">
            {matchKindLabel(meta?.kind, asTranslate(t))} · {decisionReasonLabel(meta?.decisionReason, asTranslate(t))} · 1×{Math.round(seconds / 60)} min · no side change
          </span>
          <strong className="rb-decision__title">
            {nameOf(state, match.participantAId)} <span className="faint">vs</span> {nameOf(state, match.participantBId)}
          </strong>
        </div>
        {level && !decided ? (
          <Badge tone="warn">
            <IconAlert size={11} /> {t('results.tied')} — {t('radball.shootout')}
          </Badge>
        ) : decided ? (
          <Badge tone="live" dot>
            {t('radball.shootout')} · {t('match.finished')}
          </Badge>
        ) : (
          <Badge tone="info">{t('match.ready')}</Badge>
        )}
      </header>

      <div className="rb-decision__score tnum">
        <span>{match.scoreA}</span>
        <span className="faint">:</span>
        <span>{match.scoreB}</span>
      </div>

      {level && !decided ? (
        <ShootoutPanel state={state} match={match} shootout={shootout} onRecord={record} onReset={isAdmin ? resetShootoutState : undefined} />
      ) : null}

      {decided ? (
        <div className="stack g2">
          <p className="small">
            {t('score.winner')}: <strong>{nameOf(state, shootout?.winnerId ?? null)}</strong>
          </p>
          {isAdmin && match.state !== 'FINISHED' ? (
            <Button tone="primary" onClick={confirmWinner} busy={busy}>
              {t('action.finish')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
