/**
 * The 10-team Radball competition page.
 *
 * The generic Radball page is one long list of fixtures, because a free-form
 * league really is one long list. This format is not: it has a preliminary round
 * that ends in two frozen tables and a final phase that only exists once the
 * host has confirmed it. Splitting the page along that line is not decoration --
 * it is the only way the "generate the final phase?" question can be asked at the
 * moment it becomes answerable, and the only way a placement match can avoid
 * being filed as an ordinary group fixture.
 *
 * What the page *does* is present:
 *
 *   - the state machine as a trail, so "where are we?" is answerable at a glance
 *   - the tournament tree: both groups and the final phase, with the wires
 *     between a group position and the match it feeds
 *   - the format itself, generated from the same structure table the engine uses
 *
 * What it never does is compute a point, a rank or a place. Everything numeric
 * comes from the server, and the admin-only buttons are the only things here that
 * change anything.
 */
import { useMemo, useState } from 'react';
import type { TournamentState } from '../../shared/types';
import { radball10FinalStructure } from '../../shared/radball10Structure';
import { radballDecisionSec, radballMatchSec } from '../../shared/types';
import { Radball10Tree } from '../components/Radball10Tree';
import { Badge, Button, ConnectionBadge, PageHeader, Panel } from '../components/primitives';
import { IconAlert, IconTrophy } from '../components/icons';
import { live } from '../lib/live';
import { useLive } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { navigate } from '../lib/router';
import {
  competitionProgress,
  nextFixtureToCall,
  fixturesForDisplay,
  readableAgeClass,
  roundNameLabel,
} from '../lib/radball';
import { groupSizeOfState } from '../lib/radball10';
import { formatDocumentation, stageLabel, stageTrail, validationIssues } from '../lib/radball10';
import { cx } from '../lib/util';

export function Radball10Page() {
  const snapshot = useLive();
  const { t } = useI18n();
  const state = snapshot.state;
  const isAdmin = snapshot.role === 'admin';
  const [busy, setBusy] = useState(false);

  const ten = state?.radball?.ten ?? null;
  const competition = state?.radball ?? null;
  // The final phase follows the competition's own group count, so a twelve-team
  // tournament draws four placement matches instead of the ten-team three.
  const groupSize = state ? groupSizeOfState(state) : 5;
  const structure = useMemo(() => radball10FinalStructure(groupSize), [groupSize]);
  /** Both groups added up, so the header never claims "10 teams" for a 12-team event. */
  const teamCount = groupSize * 2;

  const progress = useMemo(
    () => (state ? competitionProgress(state) : { finished: 0, total: 0 }),
    [state],
  );
  const fixtures = useMemo(() => (state ? fixturesForDisplay(state) : []), [state]);
  const callId = useMemo(() => (state ? nextFixtureToCall(state, fixtures) : null), [state, fixtures]);
  const trail = useMemo(() => (state ? stageTrail(state, asTranslate(t)) : []), [state, t]);
  const issues = useMemo(() => (state ? validationIssues(state) : []), [state]);
  const docs = useMemo(
    () => (state ? formatDocumentation(state, structure, asTranslate(t)) : []),
    [state, structure, t],
  );

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
  if (!competition || !ten) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('radball10.notTenTeam')}</p>
        <Button tone="primary" onClick={() => navigate('/setup')}>
          {t('nav.setup')}
        </Button>
      </div>
    );
  }

  const config = competition.config;
  const current = trail.find((step) => step.current);
  const finished = state.tournament.status === 'COMPLETED';
  const champion = competition.championId ? state.participants[competition.championId] : null;
  const readiness = finalPhaseReadinessView(state);
  const generated = ten.final.status === 'GENERATED';

  const generateFinalPhase = async () => {
    setBusy(true);
    const result = await live.command('radball.finalPhase', { confirm: true });
    setBusy(false);
    if (result.ok) live.pushToast('success', t('radball.finalPhase'));
    else live.pushToast('warn', result.error ?? t('err.generic'));
  };

  return (
    <div className="scroll stack g4">
      <PageHeader
        title={state.tournament.name}
        chips={
          <>
            <Badge tone={finished ? 'done' : 'live'} dot={!finished}>
              {finished ? t('match.finished') : t('match.running')}
            </Badge>
            <Badge tone="info">{current?.label ?? stageLabel('SETUP', asTranslate(t))}</Badge>
            <ConnectionBadge />
          </>
        }
        progress={{ done: progress.finished, total: progress.total, label: t('results.played') }}
        facts={[
          {
            label: t('setup.step.format'),
            value: t('radball10.formatValue', { teams: teamCount, size: groupSize }),
          },
          { label: t('radball.ageCategory'), value: readableAgeClass(config.ageCategory) },
          {
            label: t('results.match'),
            value: `2 × ${Math.round(radballMatchSec(config) / 120)} min`,
          },
          {
            label: t('radball.decisionLabel'),
            value: `1 × ${Math.round(radballDecisionSec(config) / 60)} min`,
          },
        ]}
      />

      {/* ------------------------------------------------- the state machine --
          Nine states, derived from the results. Showing the trail rather than
          the single current state is the point: an organiser who cannot see what
          comes next cannot tell "waiting" from "stuck". */}
      <Panel
        title={t('radball10.stateTitle')}
        actions={<span className="tiny dim">{current?.label}</span>}
      >
        <ol className="rbt10-trail">
          {trail.map((step) => (
            <li
              key={step.stage}
              className={cx(
                'rbt10-trail__step',
                step.reached && 'rbt10-trail__step--reached',
                step.current && 'rbt10-trail__step--current',
              )}
            >
              <span className="rbt10-trail__label">{step.label}</span>
            </li>
          ))}
        </ol>
        {current ? <p className="hint">{current.hint}</p> : null}
      </Panel>

      {/* Only fires once nothing is left to play. The server reports an issue when
          a place has no team *and* no remaining fixture can fill it, so this is
          a fault rather than a fixture still waiting on a result -- which is why
          the heading says it cannot be completed rather than that it is not
          complete yet. */}
      {issues.length > 0 ? (
        <div className="banner banner--error" role="alert">
          <IconAlert size={15} />
          <span className="grow">
            <strong>{t('radball10.rankingIncomplete')}</strong>
            <ul className="rbt10-issues">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {champion ? (
        <div className="banner banner--info" role="status">
          <IconTrophy size={15} />
          <span className="grow">
            <strong>{t('results.champion')}: {champion.name}</strong>
            {champion.team ? <span className="dim"> · {champion.team}</span> : null}
            {/* "all ten places assigned" has no catalogue entry. */}
            <span className="dim"> · all ten places assigned</span>
          </span>
        </div>
      ) : null}

      {/* ------------------------------------ §24: the confirmation prompt --
          The final phase is not created automatically. It is offered, with the
          counts that justify it, and only accepted when the host says yes --
          because "generate" is the moment the ranking stops being provisional. */}
      {!generated && readiness.ready ? (
        <div className="banner banner--warn" role="status">
          <span className="grow">
            <strong>{t('radball10.preliminaryComplete')}</strong>{' '}
            {readiness.groups
              .map((entry) => `${entry.name} ${t('radball10.matchesRatio', { played: entry.played, total: entry.total })}`)
              .join(' · ')}
            <span className="dim"> · {t('radball10.generateFinalPhaseQuestion')}</span>
          </span>
          {isAdmin ? (
            <Button size="sm" tone="primary" onClick={generateFinalPhase} busy={busy}>
              {t('radball.finalPhase')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ the competition --
          Group tables on top, final phase below. The tree names every side by
          the position it came from, so a hall can read "Group A #3 vs Group B
          #3" and know exactly who has to walk on. */}
      <Panel title={t('nav.bracket')} flush>
        <Radball10Tree state={state} structure={radball10FinalStructure(groupSize)} />
      </Panel>

      {/* --------------------------------------------- what to call next ---
          One line, because during an event the only question is "what is on
          now". The list itself lives on the schedule tab. */}
      {callId && state.matches[callId] ? (
        <div className="banner banner--info" role="status">
          <span className="grow">
            <strong>{t('radball10.nextToCall')}</strong>{' '}
            {roundNameLabel(state.matches[callId].roundName, asTranslate(t))} —{' '}
            <span className="nowrap">
              {state.participants[state.matches[callId].participantAId ?? '']?.name ?? t('radball10.tbd')}
              {' vs '}
              {state.participants[state.matches[callId].participantBId ?? '']?.name ?? t('radball10.tbd')}
            </span>
          </span>
          <Button size="sm" onClick={() => navigate('/radball')}>
            {t('nav.radball')}
          </Button>
        </div>
      ) : null}

      {/* ------------------------------------------------ the format -------
          Printed from the same table the engine builds its matches from, so the
          page and the competition cannot drift apart. */}
      <Panel
        title={t('radball10.rulesFormatTitle')}
        actions={
          <span className="tiny dim">
            {t('radball10.teamCountCup', { n: teamCount })}
          </span>
        }
      >
        <dl className="kv">
          {docs.map((line) => (
            <div key={line.label} className="kv__row">
              <dt>{line.label}</dt>
              <dd>{line.text}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">
          {t('radball10.positionsHint', { n: groupSize })}{' '}
          <a href="/docs/ARCHITECTURE.md">{t('radball10.architectureNotes')}</a>{' '}
          {t('radball10.dependencyChain')}
        </p>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Readiness readout                                                  */
/* ------------------------------------------------------------------ */

interface GroupReadiness {
  name: string;
  played: number;
  total: number;
}

/**
 * How far each group is, read straight off the fixtures.
 *
 * The *decision* is the server's: `groupFrozen` is set by the engine when all ten
 * of a group's fixtures are decided, so this only has to read it. Recounting the
 * fixtures here would be a second implementation of the same rule, and a second
 * implementation is exactly how a banner and a refusal end up disagreeing.
 */
function finalPhaseReadinessView(state: TournamentState): { ready: boolean; groups: GroupReadiness[] } {
  const competition = state.radball;
  if (!competition) return { ready: false, groups: [] };
  const groups = competition.groupOrder.slice(0, 2).map((groupId) => {
    const fixtures = Object.values(state.matches).filter(
      (match) => match.radball?.groupId === groupId && match.radball?.matchType === 'GROUP_MATCH',
    );
    return {
      name: competition.groups[groupId]?.name ?? groupId,
      played: fixtures.filter((match) => match.state === 'FINISHED').length,
      total: fixtures.length,
    };
  });
  const frozen = competition.groupOrder.slice(0, 2).map(
    (groupId) => competition.ten?.groupFrozen[groupId] === true,
  );
  return { ready: frozen.length === 2 && frozen.every(Boolean), groups };
}