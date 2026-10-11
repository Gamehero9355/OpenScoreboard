/**
 * The display screen switcher.
 *
 * One component, two homes: the host dashboard's side rail and the field
 * operator's screen (behind the Display button). Both write the same settings
 * value, so whichever dashboard is pressed the projector follows — there is no
 * second channel to keep in sync.
 *
 * The operator is allowed to use it by design: the person who can see the match
 * has gone to half-time is the operator at the field, and making them walk to
 * the desk to put "Pause" on the wall is the friction this removes.
 */
import { useEffect, useState } from 'react';
import type { DisplayScreen } from '../../shared/types';
import { DISPLAY_SCREENS } from '../../shared/types';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import type { MessageKey } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';
import { Button, Segmented } from './primitives';

/** The catalogue key naming each screen. */
export const DISPLAY_SCREEN_KEY: Record<DisplayScreen, MessageKey> = {
  scores: 'display.screen.scores',
  pause: 'display.screen.pause',
  logo: 'display.screen.logo',
  clock: 'display.screen.clock',
  standings: 'display.screen.standings',
  results: 'display.screen.results',
};

/** The screens whose body carries the host's optional message. */
const MESSAGE_SCREENS: DisplayScreen[] = ['pause', 'logo'];

export function DisplayScreenPicker({ compact = false }: { compact?: boolean }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const settings = snapshot.state?.settings;
  const screen: DisplayScreen = settings?.displayScreen ?? 'scores';
  const canControl = snapshot.role === 'admin' || snapshot.role === 'operator';
  const [message, setMessage] = useState(settings?.displayMessage ?? '');

  // Another dashboard may be the one editing the text, so the box follows the
  // server rather than holding its own copy of a value it does not own.
  useEffect(() => {
    setMessage(settings?.displayMessage ?? '');
  }, [settings?.displayMessage]);

  const chooseScreen = (next: DisplayScreen) => {
    if (!canControl) return;
    void live.command('display.setScreen', { screen: next });
  };

  const saveMessage = () => {
    if (!canControl) return;
    const trimmed = message.trim();
    void live.command('display.setScreen', { screen, message: trimmed || null });
  };

  return (
    <div className={compact ? 'stack g2' : 'stack g3'}>
      <Segmented
        value={screen}
        ariaLabel={t('display.title')}
        onChange={chooseScreen}
        options={DISPLAY_SCREENS.map((value) => ({ value, label: t(DISPLAY_SCREEN_KEY[value]) }))}
      />
      <p className="hint">{t('display.hint')}</p>

      {MESSAGE_SCREENS.includes(screen) ? (
        <form
          className="row g2"
          onSubmit={(event) => {
            event.preventDefault();
            saveMessage();
          }}
        >
          <input
            className="input input--sm grow"
            value={message}
            maxLength={160}
            disabled={!canControl}
            placeholder={t('display.messagePlaceholder')}
            aria-label={t('display.messageLabel')}
            onChange={(event) => setMessage(event.target.value)}
            onBlur={saveMessage}
          />
          <Button size="sm" tone="ghost" type="submit" disabled={!canControl}>
            {t('display.setMessage')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
