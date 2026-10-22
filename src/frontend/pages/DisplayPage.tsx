/**
 * Spectator display.
 *
 * Opened on a TV, a projector or a second monitor. No controls, no navigation,
 * no scrolling: the numbers are as large as the screen allows and the clock
 * ticks locally from the server's anchor so a hundred screens cost one message,
 * not a hundred.
 */
import { fieldDisplayName, fieldIds, isRealMatch, nameOf } from '../../shared/matchUtils';
import { displayMessageFor, displayScreenFor, screenAtBreak } from '../../shared/types';
import { useFullscreen, useLive, useLocalStorage, useWakeLock } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { cx } from '../lib/util';
import { Button, useMatchStateLabel } from '../components/primitives';
import { clockCaption, DisplayArena, DisplayRows, MatchClock } from '../components/scoreboard';
import { DisplayScreenView } from '../components/displayScreens';
import { IconCollapse, IconContrast, IconExpand } from '../components/icons';

export function DisplayPage({ view }: { view: string }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const stateLabel = useMatchStateLabel();
  const state = snapshot.state;
  const fullscreen = useFullscreen();
  const [invert, setInvert] = useLocalStorage('tsb.disp.invert', false);
  useWakeLock(true);

  const available = state ? fieldIds(state) : [];
  const fields = view === 'both' ? available : available.includes(view) ? [view] : [view];
  /**
   * Which screen is up. Each field display (`/display/1`, ...) follows its own
   * per-field value and falls back to the hall-wide one, so Field 1 can show
   * the game while Field 2 shows the clock or the standings. The combined
   * display (`/display`) follows the hall-wide value. The host and the field
   * operators switch them from their dashboards, and they arrive here as
   * ordinary settings state, so a projector that reconnects lands on the right
   * screen. An older snapshot without the field reads as the score board.
   */
  const target = view === 'both' ? 'both' : view;
  const screen = state?.settings ? displayScreenFor(state.settings, target) : 'scores';
  const screenMessage = state?.settings ? displayMessageFor(state.settings, target) : null;

  /**
   * The break puts the pause notice on the field's own screen.
   *
   * A match in two halves stops at its break -- by the clock running out, or
   * by the host calling it -- and the hall has to be told that the game
   * stopped, so the field's screen says PAUSE while the break lasts. Only
   * while it is showing the score board, though: a screen the host put there
   * on purpose (the wall clock, the crest, the tables) keeps that picture.
   *
   * The board comes back by itself when the second half starts, because the
   * screen was never changed -- only what is drawn on it.
   *
   * The combined display shows every field at once and therefore never takes
   * one field's break onto the whole wall: the other field may still be
   * playing.
   */
  const fieldMatch =
    view === 'both' || !state
      ? null
      : (state.fields[view]?.matchId ? (state.matches[state.fields[view].matchId] ?? null) : null);
  const shownScreen = view === 'both' ? screen : screenAtBreak(screen, fieldMatch?.state);
  const boardVisible = shownScreen === 'scores';

  return (
    <div
      className={cx(
        'disp',
        view !== 'both' && 'disp--single',
        invert && 'disp--invert',
        !state?.tournament && 'disp--idle',
      )}
    >
      {!boardVisible ? (
        <div className="disp__stage">
          {state ? (
            <DisplayScreenView
              screen={shownScreen}
              state={state}
              message={screenMessage}
              // The pause screen prints the table of the game that is stopping:
              // this display's own field, or every field on the combined one.
              fieldIds={fields}
            />
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
            <section className="disp-board" key={fieldId} aria-label={fieldDisplayName(field?.name, fieldId, asTranslate(t))}>
              <header className="disp-board__head">
                <span className="disp-board__field">{fieldDisplayName(field?.name, fieldId, asTranslate(t))}</span>
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

      {/* No status bar: the board gets the full height. The three tools a TV
          actually needs -- field switcher, lights, fullscreen -- live in one
          dimmed cluster that turns solid on hover or focus. */}
      <div className="disp-tools no-print">
        <span className="row g2 wrap">
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
              {fieldDisplayName(state?.fields[fieldId]?.name, fieldId, asTranslate(t))}
            </Button>
          ))}
        </span>
        <span className="row g2">
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
      </div>
    </div>
  );
}
