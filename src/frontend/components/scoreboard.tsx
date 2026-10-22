/**
 * The scoreboard itself. One component family, three sizes: the host dashboard,
 * the operator's phone and the projector. Rendering the same markup everywhere
 * keeps the numbers identical on every screen.
 */
import type { FieldId, Match, TournamentState } from '../../shared/types';
import { fieldDisplayName, isRealMatch, logoOf, nameOf, teamOf, waitingReason } from '../../shared/matchUtils';
import { useMatchClock } from '../lib/hooks';
import type { MessageKey } from '../lib/i18n';
import { asTranslate, useI18n } from '../lib/useI18n';
import { cx, formatClock } from '../lib/util';
import { Badge, MatchStateBadge } from './primitives';
import { TeamCrest } from './TeamCrest';

/** The two words `t()` hands to a module-level helper. */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface ScoreSide {
  participantId: string | null;
  name: string;
  team: string | null;
  /** Crest file name from the host's logos folder, or null for the default. */
  logo: string | null;
  points: number;
}

export function sidesOf(state: TournamentState, match: Match): [ScoreSide, ScoreSide] {
  return [
    {
      participantId: match.participantAId,
      name: nameOf(state, match.participantAId),
      team: teamOf(state, match.participantAId),
      logo: logoOf(state, match.participantAId),
      points: match.scoreA,
    },
    {
      participantId: match.participantBId,
      name: nameOf(state, match.participantBId),
      team: teamOf(state, match.participantBId),
      logo: logoOf(state, match.participantBId),
      points: match.scoreB,
    },
  ];
}

export function leaderOf(match: Match): 'A' | 'B' | null {
  if (match.state === 'FINISHED' && match.winnerId) {
    return match.winnerId === match.participantAId ? 'A' : 'B';
  }
  if (match.scoreA > match.scoreB) return 'A';
  if (match.scoreB > match.scoreA) return 'B';
  return null;
}

export function MatchClock({
  match,
  className,
  label,
  format = formatClock,
}: {
  match: Match;
  className?: string;
  label?: string;
  format?: (ms: number) => string;
}) {
  const { ms, over, atBreak } = useMatchClock(match);
  const { t } = useI18n();
  return (
    <span className={cx('row g2', className)}>
      {label ? <span className="disp-clock__label">{label}</span> : null}
      <span
        className={cx(
          'tnum',
          over && 'disp-clock__value--over',
          (match.state === 'PAUSED' || match.state === 'HALFTIME') && 'disp-clock__value--paused',
        )}
        title={t(atBreak ? 'break.label' : match.timer.mode === 'down' ? 'clock.down' : 'clock.up')}
      >
        {format(ms)}
      </span>
    </span>
  );
}

/**
 * The caption under a clock: which half is running and which way it counts.
 *
 * Takes the caller's `t()` rather than calling the hook itself, because
 * `DisplayPage` calls it while rendering a list of fields.
 */
export function clockCaption(match: Match, t: Translate): string {
  const period = match.timer.periodCount > 1 ? `${t('match.halftime')} ${match.timer.period}/2 · ` : '';
  return `${period}${t(match.timer.mode === 'down' ? 'clock.down' : 'clock.up')}`;
}

/** Compact score block for the host dashboard and the operator screen. */
export function ScoreBlock({
  state,
  match,
  size = 'md',
  showClock = true,
}: {
  state: TournamentState;
  match: Match;
  size?: 'sm' | 'md';
  showClock?: boolean;
}) {
  const [a, b] = sidesOf(state, match);
  const leader = leaderOf(match);
  const { t } = useI18n();
  return (
    <div className={cx('score', size === 'sm' && 'score--sm')}>
      <div className={cx('score__side', 'score__side--a', leader === 'A' && 'score__side--leading')}>
        <TeamCrest logo={a.logo} size="sm" />
        <span className="score__name">{a.name}</span>
        {a.team ? <span className="score__team">{a.team}</span> : null}
        <span className="score__points tnum">{a.points}</span>
      </div>
      <div className="score__mid">
        {showClock ? (
          <MatchClock match={match} className="score__clock" />
        ) : (
          <span className="score__sep">vs</span>
        )}
        <span className="tiny faint score__caption">{clockCaption(match, t)}</span>
      </div>
      <div className={cx('score__side', 'score__side--b', leader === 'B' && 'score__side--leading')}>
        <TeamCrest logo={b.logo} size="sm" />
        <span className="score__name">{b.name}</span>
        {b.team ? <span className="score__team">{b.team}</span> : null}
        <span className="score__points tnum">{b.points}</span>
      </div>
    </div>
  );
}

const digitSegments: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
};

const segmentNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

function DigitalReadout({
  value,
  label,
  className,
  animate = false,
}: {
  value: string;
  label: string;
  className?: string;
  animate?: boolean;
}) {
  return (
    <span className={cx('digital', className)}>
      <span className="sr-only">{label}</span>
      <span
        key={value}
        aria-hidden="true"
        className={cx('digital__glyphs', animate && 'digital__glyphs--changed')}
      >
        {Array.from(value).map((character, index) =>
          character === ':' ? (
            <span className="digital__colon" key={`${character}-${index}`}>
              <span />
              <span />
            </span>
          ) : (
            <span
              className={cx('digital__digit', character === '1' && 'digital__digit--one')}
              key={`${character}-${index}`}
            >
              {segmentNames.map((segment) => (
                <span
                  key={segment}
                  className={cx(
                    'digital__segment',
                    `digital__segment--${segment}`,
                    digitSegments[character]?.includes(segment) && 'digital__segment--on',
                  )}
                />
              ))}
            </span>
          ),
        )}
      </span>
    </span>
  );
}

function DisplayTeam({ side, data, leading }: { side: 'A' | 'B'; data: ScoreSide; leading: boolean }) {
  const { t } = useI18n();
  return (
    <section
      className={cx(
        'arena__team',
        `arena__team--${side.toLowerCase()}`,
        leading && 'arena__team--leading',
      )}
    >
      <div className="arena__identity">
        {/* The crest sits above the name rather than beside it: on a projector
            the name is set in a centred column, and a mark to its left would
            shift the name off the centre line it is aligned to the score with. */}
        <TeamCrest logo={data.logo} size="xl" />
        <span className="arena__name">{data.name}</span>
        {data.team ? <span className="arena__team-name">{data.team}</span> : null}
      </div>
      {/* No zero padding. A scoreboard that shows 0 as "00" is showing a
          placeholder nobody asked for, and the padded digit also made a single
          digit sit in a two-digit box -- the number looked narrower than its own
          cell and drifted off the centre line. A clock still needs its leading
          zero, but a point count does not. */}
      <DigitalReadout
        className="arena__score"
        value={String(data.points)}
        label={t('a11y.points', { name: data.name, points: data.points })}
        animate
      />
      {/* Only the leader is captioned. A "Score" line under both readouts said
          nothing at 10 metres, and printing it under a tie was a label for the
          absence of a lead. The live ring on the panel is the mark; this is the
          label that keeps it from being colour alone. */}
      {leading ? <span className="arena__standing">{t('score.leading')}</span> : null}
    </section>
  );
}

function DisplayClock({ match }: { match: Match }) {
  const { ms, over } = useMatchClock(match);
  const { t } = useI18n();
  const value = formatClock(ms);
  return (
    <DigitalReadout
      className={cx(
        'arena__clock',
        'digital--clock',
        over && 'disp-clock__value--over',
        (match.state === 'PAUSED' || match.state === 'HALFTIME') && 'disp-clock__value--paused',
      )}
      value={value}
      label={`${t(match.timer.mode === 'down' ? 'clock.down' : 'clock.up')}: ${value}`}
    />
  );
}

export function DisplayArena({ state, match }: { state: TournamentState; match: Match }) {
  const [a, b] = sidesOf(state, match);
  const leader = leaderOf(match);
  const { t } = useI18n();
  return (
    <div className="arena">
      <DisplayTeam side="A" data={a} leading={leader === 'A'} />
      <div className="arena__center">
        <span className="arena__clock-label">{clockCaption(match, t)}</span>
        <DisplayClock match={match} />
        {match.state === 'FINISHED' ? (
          <span className="arena__result">
            {t('score.winner')} {match.winnerId ? nameOf(state, match.winnerId) : t('score.draw')}
          </span>
        ) : null}
        {match.state === 'FINISHED' && !isRealMatch(match) ? (
          <span className="arena__result">{t('disp.noScore')}</span>
        ) : null}
      </div>
      <DisplayTeam side="B" data={b} leading={leader === 'B'} />
    </div>
  );
}

/** Full-width row pair used by the projector display. */
export function DisplayRows({ state, match }: { state: TournamentState; match: Match }) {
  const [a, b] = sidesOf(state, match);
  const leader = leaderOf(match);
  const { t } = useI18n();
  return (
    <div className="disp-board__body">
      {[
        { side: 'A' as const, data: a },
        { side: 'B' as const, data: b },
      ].map(({ side, data }) => (
        <div key={side} className={cx('disp-row', leader === side && 'disp-row--leading')}>
          <span className="disp-row__name">
            <TeamCrest logo={data.logo} size="lg" className="disp-row__crest" />
            <span className="disp-row__label">
              {data.name}
              {data.team ? <span className="disp-row__team"> · {data.team}</span> : null}
            </span>
          </span>
          <span className="disp-row__points tnum" aria-label={t('score.points', { n: data.points })}>
            {data.points}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FieldTitleBar({
  state,
  fieldId,
  match,
  right,
}: {
  state: TournamentState;
  fieldId: FieldId;
  match: Match | null;
  right?: React.ReactNode;
}) {
  const field = state.fields[fieldId];
  const { t } = useI18n();
  return (
    <header className="field__head">
      <div className="row g3" style={{ minWidth: 0 }}>
        <span className="field__name">{fieldDisplayName(field.name, fieldId, asTranslate(t))}</span>
        {match ? (
          <span className="field__meta">
            {match.roundName} · {t('dialog.matchLabel', { n: match.position + 1 })}
            {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
          </span>
        ) : (
          <span className="field__meta">{t('op.noMatchAssigned')}</span>
        )}
      </div>
      <div className="row g2">
        {match ? <MatchStateBadge state={match.state} /> : <Badge>{t('field.free')}</Badge>}
        {right}
      </div>
    </header>
  );
}

export function WaitingHint({ state, match }: { state: TournamentState; match: Match }) {
  const { t } = useI18n();
  const reason = waitingReason(state, match, asTranslate(t));
  if (!reason) return null;
  return <p className="hint">{reason}</p>;
}

export function WinnerLine({ state, match }: { state: TournamentState; match: Match }) {
  const { t } = useI18n();
  if (match.state !== 'FINISHED') return null;
  if (!match.winnerId) {
    return <p className="small dim">{t('score.endedAsDraw')}</p>;
  }
  return (
    <p className="small">
      {t('score.winner')}: <strong>{nameOf(state, match.winnerId)}</strong>
      {match.loserId ? (
        <span className="faint"> · {t('score.eliminated', { name: nameOf(state, match.loserId) })}</span>
      ) : null}
    </p>
  );
}
