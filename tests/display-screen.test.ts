/**
 * The display screen switcher, at the validation boundary.
 *
 * The hall-wide screens (pause, logo, clock, standings, schedule) are switched
 * by writing one settings value, so the risk this guards is a bad or unknown
 * value reaching a projector that then renders nothing. Both doors are checked:
 * the dedicated command the two dashboards send, and the settings patch the
 * settings page would send.
 *
 * The end-to-end permission story -- a field operator allowed, a spectator
 * refused -- lives in `tests/access.test.ts`, where a real server is running.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/shared/commands';
import { validateSettingsPatch } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/backend/tournament/defaults';
import {
  DISPLAY_SCREENS,
  isDisplayScreen,
  type DisplayScreen,
} from '../src/shared/types';

describe('the display screen value', () => {
  it('lists every screen, in the order a switcher shows them', () => {
    expect(DISPLAY_SCREENS).toEqual(['scores', 'pause', 'logo', 'clock', 'standings', 'results']);
  });

  it('recognises its own values and nothing else', () => {
    for (const screen of DISPLAY_SCREENS) expect(isDisplayScreen(screen)).toBe(true);
    for (const bad of ['', 'SCORES', 'score', 'tv', null, 7, {}, []]) {
      expect(isDisplayScreen(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('defaults to the score board, so an untouched hall is unchanged', () => {
    expect(DEFAULT_SETTINGS.displayScreen).toBe('scores');
    expect(DEFAULT_SETTINGS.displayMessage).toBeNull();
  });
});

describe('the display.setScreen command', () => {
  it('is an operator command, not an admin one', () => {
    // The person who can see the match has paused is the operator at the field.
    expect(COMMANDS['display.setScreen'].permission).toBe('operator');
    // One projector for the hall, so no field scope to satisfy.
    expect(COMMANDS['display.setScreen'].fieldScoped).toBe(false);
  });

  it('accepts every screen', () => {
    for (const screen of DISPLAY_SCREENS) {
      const result = COMMANDS['display.setScreen'].validate({ screen });
      expect(result.ok, screen).toBe(true);
    }
  });

  it('refuses a screen it does not know', () => {
    for (const bad of [undefined, null, '', 'score', 'SCORES', 7, {}]) {
      const result = COMMANDS['display.setScreen'].validate({ screen: bad });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('carries an optional message and treats blank as clearing it', () => {
    const withMessage = COMMANDS['display.setScreen'].validate({ screen: 'pause', message: 'Halbzeit' });
    expect(withMessage.ok && withMessage.value.message).toBe('Halbzeit');

    const cleared = COMMANDS['display.setScreen'].validate({ screen: 'pause', message: '' });
    expect(cleared.ok && cleared.value.message).toBeNull();

    const removed = COMMANDS['display.setScreen'].validate({ screen: 'pause', message: null });
    expect(removed.ok && removed.value.message).toBeNull();

    // Omitted stays omitted: switching screens must not reset the text.
    const omitted = COMMANDS['display.setScreen'].validate({ screen: 'pause' });
    expect(omitted.ok && 'message' in omitted.value).toBe(false);

    const tooLong = COMMANDS['display.setScreen'].validate({ screen: 'pause', message: 'x'.repeat(161) });
    expect(tooLong.ok).toBe(false);
  });
});

describe('the settings patch door', () => {
  it('accepts a screen and a message as ordinary settings', () => {
    const screen = validateSettingsPatch({ displayScreen: 'standings' }, DEFAULT_SETTINGS);
    expect(screen.ok && screen.value.displayScreen).toBe('standings');

    const message = validateSettingsPatch({ displayMessage: 'Nächste Spiele um 14:00' }, DEFAULT_SETTINGS);
    expect(message.ok && message.value.displayMessage).toBe('Nächste Spiele um 14:00');

    const cleared = validateSettingsPatch({ displayMessage: null }, DEFAULT_SETTINGS);
    expect(cleared.ok && cleared.value.displayMessage).toBeNull();
  });

  it('refuses an unknown screen server-side', () => {
    for (const bad of ['nope', 'SCORES', 7]) {
      const result = validateSettingsPatch({ displayScreen: bad } as never, DEFAULT_SETTINGS);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts a new screen against a state saved before the setting existed', () => {
    // A backup from an older build has no displayScreen; the patch must still go
    // through rather than tripping over the missing key.
    const legacy = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
    delete legacy.displayScreen;
    delete legacy.displayMessage;
    const result = validateSettingsPatch({ displayScreen: 'clock' }, legacy as typeof DEFAULT_SETTINGS);
    expect(result.ok && (result.value.displayScreen as DisplayScreen)).toBe('clock');
  });
});
