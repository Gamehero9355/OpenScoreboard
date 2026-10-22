/**
 * The clock arithmetic the browser and the engine share.
 *
 * `timerMs` is what every board draws, and the two helpers beside it are what
 * the operator panel's clock editor asks about the same half: how much of it has
 * been played, and how much is left. The editor's whole promise is that opening
 * the box shows the number already on the wall, so `periodLeftSec` agreeing with
 * `timerMs` is not a detail -- it is the feature, and it is the thing that broke
 * when the box was prefilled with the length of the half instead: a clock
 * reading 8:56 turned into a full 9:00 the moment it was touched.
 */
import { describe, expect, it } from 'vitest';
import type { TimerState } from '../src/shared/types';
import { periodElapsedSec, periodLeftSec, timerMs } from '../src/shared/matchUtils';

const NOW = 1_700_000_000_000;

function timer(over: Partial<TimerState> = {}): TimerState {
  return {
    mode: 'down',
    durationSec: 600,
    periodCount: 2,
    period: 1,
    periodDurationSec: 300,
    periodStartElapsedMs: 0,
    elapsedMs: 0,
    running: false,
    anchorAt: null,
    expired: false,
    breakEndsAt: null,
    ...over,
  };
}

describe('timerMs', () => {
  it('counts the half down, so a paused clock shows what is left of it', () => {
    expect(timerMs(timer({ elapsedMs: 64_000 }), NOW) / 1000).toBe(236);
  });

  it('follows the anchor while the clock runs', () => {
    const running = timer({ elapsedMs: 60_000, running: true, anchorAt: NOW - 10_000 });
    expect(timerMs(running, NOW) / 1000).toBe(230);
  });

  it('counts the whole match up when the clock counts up', () => {
    // Second half: the offset of the first half is not time off this one.
    const second = timer({ mode: 'up', elapsedMs: 320_000, periodStartElapsedMs: 300_000, period: 2 });
    expect(timerMs(second, NOW) / 1000).toBe(320);
  });

  it('falls back to the match length for a timer without a half length', () => {
    const legacy = timer({ periodDurationSec: Number.NaN, durationSec: 420 });
    expect(timerMs(legacy, NOW) / 1000).toBe(210);
  });
});

describe('periodLeftSec', () => {
  it('is the number the countdown already shows', () => {
    for (const elapsed of [0, 4_000, 64_000, 299_500]) {
      const t = timer({ elapsedMs: elapsed });
      expect(periodLeftSec(t, NOW)).toBeCloseTo(timerMs(t, NOW) / 1000, 6);
    }
  });

  it('is the time the half still has to run when the clock counts up', () => {
    // A count-up board has already spent 20s of a 300s half; 280 is left to run.
    const up = timer({ mode: 'up', elapsedMs: 20_000 });
    expect(periodLeftSec(up, NOW)).toBe(280);
    expect(timerMs(up, NOW) / 1000).toBe(20);
  });

  it('starts the next half from the full length again', () => {
    const second = timer({ period: 2, elapsedMs: 300_000, periodStartElapsedMs: 300_000 });
    expect(periodLeftSec(second, NOW)).toBe(300);
  });

  it('never goes negative when a half has overrun', () => {
    expect(periodLeftSec(timer({ elapsedMs: 400_000 }), NOW)).toBe(0);
  });
});

describe('periodElapsedSec', () => {
  it('is the same number whichever way the clock counts', () => {
    const down = timer({ elapsedMs: 64_000 });
    const up = timer({ mode: 'up', elapsedMs: 64_000 });
    expect(periodElapsedSec(down, NOW)).toBe(64);
    expect(periodElapsedSec(up, NOW)).toBe(64);
  });

  it('counts only this half once the second one starts', () => {
    const second = timer({ period: 2, elapsedMs: 320_000, periodStartElapsedMs: 300_000 });
    expect(periodElapsedSec(second, NOW)).toBe(20);
  });
});
