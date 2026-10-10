/**
 * 4-meter shootout panel.
 *
 * A shootout is its own competition element, so it looks nothing like a normal
 * match: attempt dots (hit = filled ●, miss = ○), alternating sides, sudden
 * death marking and an explicit winner line. Referee input is two large
 * buttons per attempt; the server validates the alternating order (§12, §35).
 */
import type { Match, ShootoutState, TournamentState } from '../../shared/types';
import { cx } from '../lib/util';
import { useI18n } from '../lib/useI18n';
import { Badge, Button } from './primitives';

interface AttemptDotProps {
  hit: boolean;
  suddenDeath: boolean;
  index: number;
}

function AttemptDot({ hit, suddenDeath, index }: AttemptDotProps) {
  const { t } = useI18n();
  const outcome = suddenDeath
    ? ` · ${t('radball.suddenDeathLabel')}`
    : hit
      ? ` · ${t('radball.goal')}`
      : ` · ${t('radball.miss')}`;
  const attempt = `${t('radball.shootout')} ${index + 1}`;
  const result = hit ? t('radball.goal') : t('radball.miss');
  return (
    <span
      className={cx('rb-dot', hit ? 'rb-dot--hit' : 'rb-dot--miss', suddenDeath && 'rb-dot--sd')}
      title={`${attempt}${outcome}`}
      aria-label={
        suddenDeath
          ? `${attempt}, ${t('radball.suddenDeathLabel')}, ${result}`
          : `${attempt}, ${result}`
      }
    >
      {hit ? '●' : '○'}
    </span>
  );
}

function SideRow({
  label,
  teamName,
  attempts,
  expectedTotal,
  active,
}: {
  label: 'A' | 'B';
  teamName: string;
  attempts: { hit: boolean; suddenDeath: boolean }[];
  expectedTotal: number;
  active: boolean;
}) {
  const { t } = useI18n();
  const hits = attempts.filter((attempt) => attempt.hit).length;
  return (
    <div className={cx('rb-shootout__side', active && 'rb-shootout__side--active')}>
      <div className="rb-shootout__team">
        {/* "Team A" names a side rather than a squad, and `score.side` is the
            phrase that reads correctly in both languages. */}
        <span className="tiny faint">{t('score.side', { side: label })}</span>
        <strong>{teamName}</strong>
      </div>
      <div
        className="rb-shootout__dots"
        role="img"
        aria-label={t('radball.shootoutSideAria', {
          team: teamName,
          hits,
          total: attempts.length,
        })}
      >
        {attempts.map((attempt, index) => (
          <AttemptDot key={index} hit={attempt.hit} suddenDeath={attempt.suddenDeath} index={index} />
        ))}
        {Array.from({ length: Math.max(0, expectedTotal - attempts.length) }, (_, index) => (
          <span
            key={`pending-${index}`}
            className="rb-dot rb-dot--pending"
            aria-label={t('radball.upcomingAttempt')}
          >
            ·
          </span>
          ))}
      </div>
      <span
        className="rb-shootout__tally tnum"
        aria-label={t('radball.shootoutTallyAria', { hits, total: attempts.length })}
      >
        {hits}/{attempts.length}
    </span>
    </div>
  );
}

/**
 * Interactive shootout board. `onRecord`/`onReset` are optional so the same
 * panel can render read-only on displays and print views.
 */
export function ShootoutPanel({
  state,
  match,
  shootout,
  onRecord,
  onReset,
}: {
  state: TournamentState;
  match: Match;
  shootout: ShootoutState | null;
  onRecord?: (side: 'A' | 'B', shooter: number, hit: boolean) => void;
  onReset?: () => void;
}) {
  const { t } = useI18n();
  const attemptsPerTeam = shootout?.attemptsPerTeam ?? state.radball?.config.shootoutAttempts ?? 4;
  const attempts = shootout?.attempts ?? [];
  const nextSide: 'A' | 'B' = attempts.length % 2 === 0 ? 'A' : 'B';
  const nextShooter = Math.floor(attempts.length / 2) % 2;
  const suddenDeath = attempts.length >= attemptsPerTeam * 2;
  const nameOf = (id: string | null) => (id ? (state.participants[id]?.name ?? 'Unknown') : 'Unknown');
  const teamA = nameOf(match.participantAId);
  const teamB = nameOf(match.participantBId);
  const decided = shootout?.decided ?? false;
  const winner = shootout?.winnerId ? nameOf(shootout.winnerId) : null;

  const perSide = (side: 'A' | 'B') =>
    attempts.filter((attempt) => attempt.side === side).map((attempt) => ({ hit: attempt.hit, suddenDeath: attempt.suddenDeath }));

  return (
    <div className={cx('rb-shootout', suddenDeath && 'rb-shootout--suddendeath')}>
      <header className="rb-shootout__head">
        <Badge tone={suddenDeath ? 'danger' : 'accent'}>
          {suddenDeath ? t('radball.suddenDeath') : t('radball.shootout').toUpperCase()}
        </Badge>
        <span className="tiny dim">
          {t('radball.shootoutOrder', {
            attempts: attemptsPerTeam,
            player: nextShooter === 0 ? t('radball.firstPlayer') : t('radball.secondPlayer'),
          })}
        </span>
        {onReset && !decided ? (
          <Button size="sm" tone="ghost" className="push-right" onClick={onReset}>
            {t('action.reset')}
          </Button>
        ) : null}
      </header>

      <SideRow label="A" teamName={teamA} attempts={perSide('A')} expectedTotal={attemptsPerTeam} active={nextSide === 'A' && !decided} />
      <SideRow label="B" teamName={teamB} attempts={perSide('B')} expectedTotal={attemptsPerTeam} active={nextSide === 'B' && !decided} />

      {decided && winner ? (
        <p className="rb-shootout__winner">
          {t('score.winner')}: <strong>{winner}</strong>
        </p>
      ) : null}

      {onRecord && !decided ? (
        <div className="rb-shootout__input" role="group" aria-label={`${t('radball.shootout')}: ${t('score.side', { side: nextSide })}`}>
          <span className="tiny dim nowrap">
            {t('action.next')}: <strong>{nextSide === 'A' ? teamA : teamB}</strong> ·{' '}
            {nextShooter === 0 ? t('team.player1') : t('team.player2')}
          </span>
          <Button size="sm" tone="primary" onClick={() => onRecord(nextSide, nextShooter, true)} disabled={!onRecord}>
            {t('radball.goal')}
          </Button>
          <Button size="sm" onClick={() => onRecord(nextSide, nextShooter, false)}>
            {t('radball.miss')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
