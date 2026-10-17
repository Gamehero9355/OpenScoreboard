/**
 * Relative time -- the ages the host reads at a glance -- and the small
 * formatting helpers the operator screens type into.
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
import { durationForTimeLeft, MATCH_MAX_SEC, MATCH_MIN_SEC, relativeTime } from '../src/frontend/lib/util';

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

/**
 * The clock editor on the operator panel.
 *
 * The operator is shown the time the field still has and types that number back,
 * so the function has to read it the same way: the typed time left, not the
 * length of the half. Getting that backwards is the bug that made the box jump
 * from 8:56 to a full 9:00 the moment it was opened -- and the elapsed part of
 * the half has to come back into the total, because it has already been played
 * and cannot be un-played.
 */
describe('durationForTimeLeft', () => {
  it('reads the typed number as the time left, not as the half length', () => {
    // Four minutes left on a two-half match: eight minutes of match, so the
    // clock counts down to 4:00 exactly as typed.
    expect(durationForTimeLeft(240, 2, 0)).toBe(480);
    expect(durationForTimeLeft(240, 1, 0)).toBe(240);
  });

  it('keeps the part of the half that has already run', () => {
    // 4:00 left with 35 seconds played in this half is a 8:35 match.
    expect(durationForTimeLeft(240, 2, 35)).toBe(515);
  });

  it('never produces a number the command would refuse', () => {
    expect(durationForTimeLeft(99 * 60 * 60, 2, 0)).toBeLessThanOrEqual(MATCH_MAX_SEC);
    expect(durationForTimeLeft(99 * 60 * 60, 1, 0)).toBeLessThanOrEqual(MATCH_MAX_SEC);
    expect(durationForTimeLeft(0, 2, 0)).toBeGreaterThanOrEqual(MATCH_MIN_SEC);
    expect(durationForTimeLeft(0, 2, 0)).toBe(1);
  });

  it('rounds to whole seconds -- the box only has seconds', () => {
    expect(durationForTimeLeft(240.6, 1, 0)).toBe(241);
  });

  it('rounds up, so the board lands on the second that was typed', () => {
    // 39 ms of the half already played: the match has to be a shade longer than
    // 8:00, or the clock truncates to 3:59 after someone asked for 4:00.
    expect(durationForTimeLeft(240, 2, 0.039)).toBe(481);
    expect(durationForTimeLeft(240, 2, 0)).toBe(480);
  });
});
