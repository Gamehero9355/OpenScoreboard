/**
 * The display screen switcher, one per display.
 *
 * Each playing field owns its TV page (`/display/1`, ...), and each one gets
 * its own picker: Field 1 can show the game while Field 2 shows the clock or
 * the standings. `target` names the display -- a field id for that field's TV,
 * or 'both' for the combined `/display` page. The value arrives as ordinary
 * settings state, so a TV that reconnects lands on the right screen.
 */
import { useEffect, useId, useState } from 'react';
import type { DisplayScreen } from '../../shared/types';
import { DISPLAY_SCREENS, displayMessageFor, displayScreenFor } from '../../shared/types';
import { fieldDisplayName } from '../../shared/matchUtils';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import { asTranslate, useI18n } from '../lib/useI18n';
import type { MessageKey } from '../lib/i18n';
import { Button, Segmented } from './primitives';

export const DISPLAY_SCREEN_KEY: Record<DisplayScreen, MessageKey> = {
  scores: 'display.screen.scores',
  pause: 'display.screen.pause',
  logo: 'display.screen.logo',
  clock: 'display.screen.clock',
  standings: 'display.screen.standings',
  results: 'display.screen.results',
};

const MESSAGE_SCREENS: DisplayScreen[] = ['pause', 'logo'];

export function DisplayScreenPicker({
  compact = false,
  target = 'both',
  variant = 'segmented',
}: {
  compact?: boolean;
  target?: string;
  /**
   * `segmented` shows all six screens as one-tap buttons (wrapping to two
   * rows in narrow panels). `select` renders one labeled dropdown row per
   * display instead: it can never overflow or push a neighbouring control out,
   * so the host rail uses it to keep every field's selector visible at once.
   */
  variant?: 'segmented' | 'select';
}) {
  const snapshot = useLive();
  const { t } = useI18n();
  const settings = snapshot.state?.settings;
  const screen: DisplayScreen = settings ? displayScreenFor(settings, target) : 'scores';
  const canControl = snapshot.role === 'admin' || snapshot.role === 'operator';
  const isCombined = !target || target === 'both' || target === 'all' || target === 'combined';
  const fieldName = !isCombined
    ? fieldDisplayName(snapshot.state?.fields[target]?.name, target, asTranslate(t))
    : null;
  const label = isCombined ? t('display.combined') : (fieldName ?? target);
  const selectId = useId();
  const [message, setMessage] = useState(settings ? (displayMessageFor(settings, target) ?? '') : '');

  useEffect(() => {
    setMessage(settings ? (displayMessageFor(settings, target) ?? '') : '');
  }, [settings, target]);

  const chooseScreen = (next: DisplayScreen) => {
    if (!canControl) return;
    void live.command('display.setScreen', { screen: next, target });
  };

  const saveMessage = () => {
    if (!canControl) return;
    const trimmed = message.trim();
    void live.command('display.setScreen', { screen, target, message: trimmed || null });
  };

  const hint = isCombined ? t('display.hint') : t('display.hintField', { field: fieldName ?? target });

  return (
    <div className={compact ? 'stack g2' : 'stack g3'}>
      {variant === 'select' ? (
        <div className="stack g1">
          <label className="tiny faint" htmlFor={selectId}>
            {label}
          </label>
          <select
            id={selectId}
            className="select"
            value={screen}
            disabled={!canControl}
            aria-label={t('display.title')}
            onChange={(event) => {
              const next = event.target.value as DisplayScreen;
              chooseScreen(next);
            }}
          >
            {DISPLAY_SCREENS.map((value) => (
              <option key={value} value={value}>
                {t(DISPLAY_SCREEN_KEY[value])}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <Segmented
          value={screen}
          ariaLabel={t('display.title')}
          onChange={chooseScreen}
          className="segmented--wrap"
          options={DISPLAY_SCREENS.map((value) => ({ value, label: t(DISPLAY_SCREEN_KEY[value]) }))}
        />
      )}
      <p className="hint">{hint}</p>

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