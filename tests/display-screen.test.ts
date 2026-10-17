/**
 * The display screen switcher, at the validation boundary.
 *
 * Each field display (`/display/1`, ...) is switched independently between
 * game, clock, standings and the other screens, with the combined display
 * (`/display`) as the hall-wide fallback. The risk this guards is a bad or
 * unknown value reaching a TV that then renders nothing. Both doors are
 * checked: the dedicated command the dashboards send, and the settings patch
 * the settings page would send.
 *
 * The end-to-end permission story -- a field operator allowed on their own
 * display, refused on another field's, a spectator refused -- lives in
 * `tests/access.test.ts`, where a real server is running.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/shared/commands';
import { validateSettingsPatch } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/backend/tournament/defaults';
import {
  DISPLAY_SCREENS,
  displayMessageFor,
  displayScreenFor,
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
    // Per-field targets are enforced in dispatch against the session scope, so
    // no static field scope to satisfy here.
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

  it('targets one field display or the combined display', () => {
    for (const target of [undefined, null, '', 'both', 'all', 'combined']) {
      const result = COMMANDS['display.setScreen'].validate({ screen: 'clock', target });
      expect(result.ok, JSON.stringify(target)).toBe(true);
      if (result.ok) expect('target' in result.value).toBe(false);
    }
    for (const target of ['1', '2', '8']) {
      const result = COMMANDS['display.setScreen'].validate({ screen: 'clock', target });
      expect(result.ok, target).toBe(true);
      if (result.ok) expect(result.value.target).toBe(target);
    }
    for (const bad of ['0', '9', 'field-1', 7, {}]) {
      const result = COMMANDS['display.setScreen'].validate({ screen: 'clock', target: bad });
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

describe('per-field resolution', () => {
  it('falls back to the combined screen until a field picks its own', () => {
    const settings = { ...DEFAULT_SETTINGS, displayScreen: 'scores' as DisplayScreen };
    expect(displayScreenFor(settings, '1')).toBe('scores');
    expect(displayScreenFor(settings, 'both')).toBe('scores');
    const perField = {
      ...settings,
      displayScreens: { '1': 'clock' as DisplayScreen, '2': 'standings' as DisplayScreen },
    };
    expect(displayScreenFor(perField, '1')).toBe('clock');
    expect(displayScreenFor(perField, '2')).toBe('standings');
    // The combined display is unaffected by per-field picks.
    expect(displayScreenFor(perField, 'both')).toBe('scores');
    // Unknown values read as the fallback, never as nothing.
    expect(displayScreenFor({ displayScreen: 'nope' }, '1')).toBe('scores');
    expect(displayScreenFor({ displayScreen: 'clock', displayScreens: { '1': 'nope' } }, '1')).toBe('clock');
  });

  it('resolves the pause/logo caption per field', () => {
    const settings = { ...DEFAULT_SETTINGS, displayScreen: 'pause' as DisplayScreen, displayMessage: 'Halbzeit' };
    expect(displayMessageFor(settings, '1')).toBe('Halbzeit');
    const perField = { ...settings, displayMessages: { '1': 'Pause auf Feld 1' } };
    expect(displayMessageFor(perField, '1')).toBe('Pause auf Feld 1');
    expect(displayMessageFor(perField, '2')).toBe('Halbzeit');
    expect(displayMessageFor(perField, 'both')).toBe('Halbzeit');
  });
});
