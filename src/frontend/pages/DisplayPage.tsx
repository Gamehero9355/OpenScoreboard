/**
 * Spectator display.
 *
 * Opened on a TV, a projector or a second monitor. No controls, no navigation,
 * no scrolling: the numbers are as large as the screen allows and the clock
 * ticks locally from the server's anchor so a hundred screens cost one message,
 * not a hundred.
 */
import { fieldIds, isRealMatch, nameOf } from '../../shared/matchUtils';
import { useFullscreen, useLive, useLocalStorage, useWakeLock } from '../lib/hooks';
import { formatTime, type MessageKey } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';
import { cx } from '../lib/util';
import { Badge, Button, ConnectionBadge, useMatchStateLabel, useTournamentStatusLabel } from '../components/primitives';
import { clockCaption, DisplayArena, DisplayRows, MatchClock } from '../components/scoreboard';
import { DisplayScreenView } from '../components/displayScreens';
import { IconCollapse, IconContrast, IconExpand, IconEye } from '../components/icons';

export function DisplayPage({ view }: { view: string }) {
  const snapshot = useLive();
  const { locale, t } = useI18n();
  const stateLabel = useMatchStateLabel();
  const statusLabel = useTournamentStatusLabel();
  const state = snapshot.state;
  const fullscreen = useFullscreen();
  const [invert, setInvert] = useLocalStorage('tsb.disp.invert', false);
  useWakeLock(true);

  const available = state ? fieldIds(state) : [];
  const fields = view === 'both' ? available : available.includes(view) ? [view] : [view];
  /**
   * Which screen is up. `scores` is the board this page has always drawn; any
   * other value replaces it with a hall-wide screen. The host and the field
   * operators switch it from their dashboards, and it arrives here as ordinary
   * settings state, so a projector that reconnects lands on the right screen.
   * An older snapshot without the field reads as the score board.
   */
  const screen = state?.settings.displayScreen ?? 'scores';
  const boardVisible = screen === 'scores';

  return (
    <div
      className={cx(
        'disp',
        view !== 'both' && 'disp--single',
        invert && 'disp--invert',
        !state?.tournament && 'disp--idle',
      )}
    >
      <header className="disp__top">
        <span className="disp__title">{state?.tournament?.name ?? state?.settings.tournamentName ?? t('app.name')}</span>
        <span className="row g3">
          <span className="disp__hint">
            {state?.tournament
              ? `${t(`format.${state.tournament.format}` as MessageKey)} · ${statusLabel(state.tournament.status)}`
              : t('err.noTournament')}
          </span>
          <ConnectionBadge />
        </span>
      </header>

      {!boardVisible ? (
        <div className="disp__stage">
          {state ? (
            <DisplayScreenView screen={screen} state={state} />
          ) : (
            <div className="disp-idle">{t('disp.waiting')}</div>
          )}
        </div>
      ) : (
      <div
        className={cx(
          'disp__grid',
          view !== 'both' && 'disp__grid--single',
          view === 'both' && fields.length <= 1 && 'disp__grid--two',
          fields.length === 2 && 'disp__grid--split',
          fields.length > 2 && 'disp__grid--many',
        )}
      >
        {fields.map((fieldId) => {
          const field = state?.fields[fieldId];
          const match = field?.matchId ? state?.matches[field.matchId] ?? null : null;
          return (
            <section className="disp-board" key={fieldId} aria-label={field?.name ?? t('field.label', { n: fieldId })}>
              <header className="disp-board__head">
                <span className="disp-board__field">{field?.name ?? t('field.label', { n: fieldId })}</span>
                <span className="disp-board__meta">
                  {match ? (
                    <>
                      <span className="disp-board__round">
                        {match.roundName} · {t('dialog.matchLabel', { n: match.position + 1 })}
                        {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
                      </span>
                      <span className={cx('disp-state', `disp-state--${match.state}`)}>{stateLabel(match.state)}</span>
                    </>
                  ) : (
                    <span className="disp-state disp-state--WAITING">{t('disp.noMatch')}</span>
                  )}
                </span>
              </header>

              {state && match ? (
                view === 'both' ? (
                  <>
                    <DisplayRows state={state} match={match} />
                    <div className="disp-clock">
                      <span className="disp-clock__label">{clockCaption(match, t)}</span>
                      <MatchClock match={match} className="disp-clock__value" />
                      {match.state === 'FINISHED' ? (
                        <span className="disp-clock__label">
                          {t('score.winner')} {match.winnerId ? nameOf(state, match.winnerId) : t('score.draw')}
                        </span>
                      ) : null}
                      {match.state === 'FINISHED' && !isRealMatch(match) ? (
                        <span className="disp-clock__label">{t('disp.noScore')}</span>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <DisplayArena state={state} match={match} />
                )
              ) : (
                <div className="disp-idle">{t('disp.waiting')}</div>
              )}
            </section>
          );
        })}
      </div>
      )}

      <footer className="disp__foot">
        <span>
          {snapshot.connection === 'live'
            ? snapshot.reconnects === 0
              ? t('conn.live')
              : `${t('conn.live')} · ${snapshot.reconnects} ${t('diag.reconnects')}`
            : snapshot.connection === 'connecting'
              ? t('conn.connecting')
              : snapshot.connection === 'reconnecting'
                ? t('conn.reconnecting')
                : t('conn.offline')}
        </span>
        <span>{formatTime(locale, Date.now())}</span>
        {/* Every control lives in this one cluster. They used to sit in the board
            header and in a fixed corner button, which collided with the field
            switcher at 720p and made a narrow header wrap its own field name. */}
        <span className="row g2 disp__foot-controls">
          {/* The field switcher is only meaningful on the score board. On a
              hall-wide screen it would be a control that visibly does nothing,
              so the footer names the screen instead. */}
          {boardVisible ? (
            <span className="row g2 no-print">
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  window.location.href = '/display';
                }}
              >
                {t('disp.allFields')}
              </Button>
              {available.map((fieldId) => (
                <Button
                  key={fieldId}
                  size="sm"
                  tone="ghost"
                  onClick={() => {
                    window.location.href = `/display/${fieldId}`;
                  }}
                >
                  {state?.fields[fieldId]?.name ?? t('field.label', { n: fieldId })}
                </Button>
              ))}
            </span>
          ) : (
            <Badge tone="accent">{t(`display.screen.${screen}` as MessageKey)}</Badge>
          )}
          <span className="row g2 no-print">
            <Button
              className="disp-tool"
              size="sm"
              tone="ghost"
              onClick={() => setInvert(!invert)}
              title={t('settings.invert')}
            >
              <IconContrast size={14} />
              <span className="disp-tool__label">{invert ? t('settings.themeDark') : t('settings.themeLight')}</span>
            </Button>
            {fullscreen.supported ? (
              <Button
                className="disp-tool"
                size="sm"
                tone="ghost"
                onClick={fullscreen.toggle}
                title={fullscreen.active ? t('disp.exitFullscreen') : t('disp.enterFullscreen')}
              >
                {fullscreen.active ? <IconCollapse size={14} /> : <IconExpand size={14} />}
                <span className="disp-tool__label">
                  {fullscreen.active ? t('disp.exit') : t('a11y.fullscreen')}
                </span>
              </Button>
            ) : null}
          </span>
          <Badge tone="neutral">
            <IconEye size={11} /> {t('role.spectator')}
          </Badge>
        </span>
      </footer>
    </div>
  );
}
