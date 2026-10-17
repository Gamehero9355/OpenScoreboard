/**
 * The hall-wide display screens.
 *
 * `DisplayPage` draws the score boards; this file draws the *other* things the
 * same projector has to be able to show — the pause notice between games, the
 * club crest, the wall clock, the tables and the running order. They are
 * separate from the boards because they are not scoreboards: they have no
 * per-field split, they are read rather than watched, and the only state they
 * own is the one line the host typed for the pause screen.
 *
 * Every screen here is a function of server state alone. Nothing fetches, and
 * nothing but the clock screen ticks locally — the projector must keep working
 * when the WLAN drops, which is the whole promise of the app.
 */
import { useMemo } from 'react';
import type { Match, TournamentState } from '../../shared/types';
import { fieldDisplayName, logoOf, nameOf } from '../../shared/matchUtils';
import { computeResults } from '../../shared/stats';
import { useNow } from '../lib/hooks';
import { intlTag } from '../lib/i18n';
import { asTranslate, useI18n } from '../lib/useI18n';
import { competitionFixtures, competitionProgress, roundNameLabel } from '../lib/radball';
import { cx, formatTime } from '../lib/util';
import { Empty, MatchStateBadge } from './primitives';
import { MatchClock } from './scoreboard';
import { TeamCrest, CrestWithName } from './TeamCrest';
import { RadballStandings } from './RadballStandings';

/** The screens this file knows how to draw. `scores` is drawn by `DisplayPage`. */
export function DisplayScreenView({
  screen,
  state,
  message,
}: {
  screen: string;
  state: TournamentState;
  message?: string | null;
}) {
  const resolved = message !== undefined ? message : (state.settings.displayMessage ?? null);
  switch (screen) {
    case 'pause':
      return <PauseScreen state={state} message={resolved} />;
    case 'logo':
      return <LogoScreen state={state} message={resolved} />;
    case 'clock':
      return <ClockScreen state={state} />;
    case 'standings':
      return <StandingsScreen state={state} />;
    case 'results':
      return <ResultsScreen state={state} />;
    default:
      return null;
  }
}

/** The tournament name a screen falls back to before one exists. */
function tournamentName(state: TournamentState): string {
  return state.tournament?.name ?? state.settings.tournamentName;
}

function PauseScreen({ state, message }: { state: TournamentState; message?: string | null }) {
  const { t } = useI18n();
  const text = (message ?? state.settings.displayMessage ?? '').trim();
  return (
    <div className="dsp dsp--pause">
      <span className="dsp__headline">{t('display.pause')}</span>
      <span className="dsp__subject">{tournamentName(state)}</span>
      {text ? <p className="dsp__message">{text}</p> : null}
    </div>
  );
}

function LogoScreen({ state, message }: { state: TournamentState; message?: string | null }) {
  const { t } = useI18n();
  const text = (message ?? state.settings.displayMessage ?? '').trim();
  return (
    <div className="dsp dsp--logo">
      {/* The host's uploaded crest, or the app's own mark. Never a remote
          asset: the venue WLAN is the only network there is. */}
      <img className="dsp__logo" src={state.settings.logoDataUrl ?? '/favicon.svg'} alt="" />
      <span className="dsp__logo-name">{tournamentName(state) || t('app.name')}</span>
      {text ? <p className="dsp__message">{text}</p> : null}
    </div>
  );
}

/**
 * The hall clock, with the match clocks under it.
 *
 * The wall clock answers "when do we restart"; the match clocks answer "how
 * long is left". Both belong on one screen, so this is both rather than a
 * bigger version of the time already printed in the display's footer.
 */
function ClockScreen({ state }: { state: TournamentState }) {
  const { locale, t } = useI18n();
  const now = useNow(1000);
  const running = useMemo(
    () =>
      Object.values(state.fields)
        .map((field) => (field.matchId ? state.matches[field.matchId] ?? null : null))
        .filter(
          (match): match is Match =>
            match !== null && match.state !== 'FINISHED' && match.state !== 'CANCELLED',
        ),
    [state],
  );
  const date = new Intl.DateTimeFormat(intlTag(locale, 'date'), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return (
    <div className="dsp dsp--clock">
      <time className="dsp__clock tnum" dateTime={new Date(now).toISOString()}>
        {formatTime(now, locale)}
      </time>
      <span className="dsp__clock-date">{date}</span>
      {running.length > 0 ? (
        <ul className="dsp__clocks">
          {running.map((match) => (
            <li className="dsp__clocks-row" key={match.id}>
              <span className="dsp__clocks-field">
                {match.fieldId ? fieldDisplayName(state.fields[match.fieldId]?.name, match.fieldId, asTranslate(t)) : ''}
              </span>
              <span className="dsp__clocks-match">
                {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                {nameOf(state, match.participantBId)}
              </span>
              <MatchClock match={match} className="dsp__clocks-time" />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StandingsScreen({ state }: { state: TournamentState }) {
  const { t } = useI18n();
  // A Radball competition is ranked group by group and the server already
  // publishes those tables, so the display prints them as they are.
  if (state.radball) {
    return (
      <div className="dsp dsp--standings">
        <h2 className="dsp__title">{t('nav.standings')}</h2>
        <div className="dsp__tables">
          <RadballStandings state={state} />
        </div>
      </div>
    );
  }
  return <GenericStandings state={state} />;
}

/** The ranked table for a knockout, derived from the live bracket. */
function GenericStandings({ state }: { state: TournamentState }) {
  const { t } = useI18n();
  const rows = useMemo(
    () =>
      computeResults(state)
        .rows.filter((row) => row.played > 0)
        .sort((a, b) => (a.place ?? 999) - (b.place ?? 999)),
    [state],
  );
  return (
    <div className="dsp dsp--standings">
      <h2 className="dsp__title">{t('nav.standings')}</h2>
      {rows.length === 0 ? (
        <Empty>{t('results.noMatches')}</Empty>
      ) : (
        <table className="table dsp-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>{t('results.participant')}</th>
              <th className="num">{t('results.played')}</th>
              <th className="num">{t('results.won')}</th>
              <th className="num">{t('results.drawn')}</th>
              <th className="num">{t('results.lost')}</th>
              <th className="num">{t('results.for')}</th>
              <th className="num">{t('results.against')}</th>
              <th className="num">{t('results.diff')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.participantId}>
                <td className="num faint tnum">{row.place ?? '—'}</td>
                <td>
                  <CrestWithName logo={logoOf(state, row.participantId)} name={row.name} />
                </td>
                <td className="num tnum">{row.played}</td>
                <td className="num tnum">{row.wins}</td>
                <td className="num tnum">{row.draws}</td>
                <td className="num tnum">{row.losses}</td>
                <td className="num tnum">{row.pointsFor}</td>
                <td className="num tnum">{row.pointsAgainst}</td>
                <td className="num tnum">{row.pointDifference > 0 ? `+${row.pointDifference}` : row.pointDifference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The running order: every fixture and what happened to it.
 *
 * A Radball competition already has a server-defined playing order
 * (`competitionFixtures`), so the list uses it. Every other format falls back
 * to the queue order the engine drew, which is the same order the host's Queue
 * panel calls matches from.
 */
function ResultsScreen({ state }: { state: TournamentState }) {
  const { t } = useI18n();
  const say = asTranslate(t);
  const progress = useMemo(() => competitionProgress(state), [state]);
  const fixtures = useMemo(() => fixtureList(state), [state]);
  return (
    <div className="dsp dsp--results">
      <div className="dsp__results-head">
        <h2 className="dsp__title">{t('display.spielplan')}</h2>
        <span className="dsp__subject">
          {t('a11y.progress', { done: progress.finished, total: progress.total, label: t('results.played') })}
        </span>
      </div>
      {fixtures.length === 0 ? (
        <Empty>{t('results.noMatches')}</Empty>
      ) : (
        <table className="table dsp-table dsp-table--fixtures">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>{t('round.round')}</th>
              <th>{t('results.match')}</th>
              <th className="num">{t('a11y.score')}</th>
              <th>{t('results.field')}</th>
            </tr>
          </thead>
          <tbody>
            {fixtures.map((match, index) => {
              const started = match.scoreA > 0 || match.scoreB > 0;
              return (
                <tr key={match.id}>
                  <td className="num faint tnum">{index + 1}</td>
                  <td className="dim nowrap">{roundNameLabel(match.roundName, say)}</td>
                  <td>
                    <span className="dsp-fixture">
                      <TeamCrest logo={logoOf(state, match.participantAId)} size="sm" />
                      <span className={cx(match.winnerId && match.winnerId === match.participantAId && 'dsp-fixture__winner')}>
                        {nameOf(state, match.participantAId)}
                      </span>
                      <span className="faint">vs</span>
                      <span className={cx(match.winnerId && match.winnerId === match.participantBId && 'dsp-fixture__winner')}>
                        {nameOf(state, match.participantBId)}
                      </span>
                      <TeamCrest logo={logoOf(state, match.participantBId)} size="sm" />
                    </span>
                  </td>
                  <td className="num tnum">
                    {started ? `${match.scoreA} : ${match.scoreB}` : <MatchStateBadge state={match.state} />}
                  </td>
                  <td className="dim nowrap">
                    {match.fieldId
                      ? fieldDisplayName(state.fields[match.fieldId]?.name, match.fieldId, asTranslate(t))
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Every fixture to list, in playing order, dropping nothing but cancelled ones. */
function fixtureList(state: TournamentState): Match[] {
  if (state.radball) return competitionFixtures(state);
  return state.matchOrder
    .map((id) => state.matches[id])
    .filter((match): match is Match => Boolean(match) && match.state !== 'CANCELLED');
}
