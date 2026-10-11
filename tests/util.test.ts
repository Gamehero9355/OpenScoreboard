/**
 * Relative time -- the ages the host reads at a glance.
 *
 * `Intl.RelativeTimeFormat` counts *up into the future*, so a timestamp in the
 * past has to reach it as a negative value. The sign used to be the wrong way
 * round and every age in the app read as an upcoming one: the host statusbar
 * claimed the state was "updated in 40 minutes" when it had been updated 40
 * minutes ago, the settings diagnostics showed the same for the last message,
 * and the home page greeted the operator with a last update somewhere in the
 * future. These tests pin the direction in both languages.
 */
import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/frontend/lib/util';

const NOW = 1_700_000_000_000;

describe('relativeTime', () => {
  it('reads a past timestamp as an age, not as an upcoming one', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('20 seconds ago');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 hours ago');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
  });

  it('reads a future timestamp as upcoming', () => {
    expect(relativeTime(NOW + 10 * 60_000, NOW)).toBe('in 10 minutes');
  });

  it('speaks German when the locale says so', () => {
    const german = relativeTime(NOW - 5 * 60_000, NOW, 'de');
    expect(german).toContain('Minute');
    expect(german).toContain('vor');
  });
});
