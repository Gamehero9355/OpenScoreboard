/**
 * Standings.
 *
 * A Radball competition is ranked group by group, so its standings are the
 * official tables -- there is no single table that ranks ten teams, because five
 * of them never play the other five. That is why this needed its own page rather
 * than a panel: it is not a summary of Results, it is the answer to a different
 * question, and it is the one thing on this screen a hall reads between games.
 *
 * It was previously a panel on the Results tab. It outgrew that when the
 * 10-team format landed: Results carried a twenty-row fixture list and two
 * standings tables in one scroll, so neither was findable, and the page that
 * exists to be glanced at was the one you had to scroll.
 *
 * Nothing here computes. Every number is server state (`competition.tables`),
 * including the rank, the points and the qualification cut -- see
 * `RadballStandings`, which draws the tables this page hosts.
 */
import { useMemo } from 'react';
import { computeResults } from '../../shared/stats';
import { useLive } from '../lib/hooks';
import { useI18n } from '../lib/useI18n';
import { competitionProgress } from '../lib/radball';
import { navigate } from '../lib/router';
import { Badge, Button, Empty, PageHeader } from '../components/primitives';
import { RadballStandings } from '../components/RadballStandings';

export function StandingsPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const state = snapshot.state;

  // The same progress definition the Results and Competition tabs use, so no two
  // headers can show different numbers for the same tournament.
  const progress = useMemo(
    () => (state ? competitionProgress(state) : { finished: 0, total: 0 }),
    [state],
  );
  const tournamentName = useMemo(
    () => (state ? computeResults(state).tournamentName : null),
    [state],
  );

  if (!state) return <Empty>{t('conn.connecting')}…</Empty>;

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

  // Reached by URL on a format that has no groups. The nav only offers this tab
  // for Radball, so this is the "typed the address" case rather than a state the
  // UI can walk a user into -- but it still needs to say why it is empty.
  if (!state.radball) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>
          {state.tournament.name} has no groups, so it has no standings. A
          knockout is ranked by the bracket instead.
        </p>
        <Button tone="primary" onClick={() => navigate('/bracket')}>
          {t('nav.bracket')}
        </Button>
      </div>
    );
  }

  const finished = state.tournament.status === 'COMPLETED';

  return (
    <div className="scroll stack g4">
      <PageHeader
        title={tournamentName ?? state.tournament.name}
        chips={
          <Badge tone={finished ? 'done' : 'live'} dot={!finished}>
            {finished ? t('match.finished') : t('match.running')}
          </Badge>
        }
        progress={{ done: progress.finished, total: progress.total, label: t('results.played') }}
      />

      <div className="stack g4">
        <RadballStandings state={state} />
      </div>
    </div>
  );
}