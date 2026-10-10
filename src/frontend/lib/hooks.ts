import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { Match, TimerState } from '../../shared/types';
import { timerMs } from '../../shared/matchUtils';
import { live, type LiveSnapshot } from './live';
import { isTypingTarget } from './util';

/** Subscribe to the live client. The snapshot identity changes on every update. */
export function useLive(): LiveSnapshot {
  return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot);
}

/**
 * Clock value for a match timer.
 *
 * The server sends an anchor, the browser interpolates: one timer tick per
 * visible board instead of one WebSocket message per tick per client. At 100
 * spectators that is the difference between a quiet Wi-Fi channel and a busy
 * one.
 */
export function useClockValue(timer: TimerState | null | undefined): number {
  const [value, setValue] = useState(() => (timer ? timerMs(timer, Date.now()) : 0));
  const timerRef = useRef(timer);
  timerRef.current = timer;

  const running = Boolean(timer?.running);
  const anchorAt = timer?.anchorAt ?? null;
  const elapsed = timer?.elapsedMs ?? 0;
  const mode = timer?.mode ?? 'down';
  const duration = timer?.durationSec ?? 0;
  const periodCount = timer?.periodCount ?? 2;
  const period = timer?.period ?? 1;
  const periodDuration = timer?.periodDurationSec ?? duration / (periodCount === 1 ? 1 : 2);
  const periodStart = timer?.periodStartElapsedMs ?? 0;

  useEffect(() => {
    const current = timerRef.current;
    setValue(current ? timerMs(current, Date.now()) : 0);
    if (!running) return;
    const id = window.setInterval(() => {
      const live2 = timerRef.current;
      if (!live2) return;
      setValue(timerMs(live2, Date.now()));
    }, 200);
    return () => window.clearInterval(id);
    // Re-anchor whenever the authoritative timer changes.
  }, [running, anchorAt, elapsed, mode, duration, periodCount, period, periodDuration, periodStart]);

  return value;
}

export function useMatchClock(match: Match | null | undefined): { ms: number; over: boolean } {
  const timer = match?.timer ?? null;
  const ms = useClockValue(timer);
  const over = Boolean(timer && timer.mode === 'down' && ms <= 0);
  return { ms, over };
}

/** A ticking timestamp, for "saved 3s ago" style indicators. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface FullscreenControls {
  supported: boolean;
  active: boolean;
  toggle: () => void;
}

export function useFullscreen(): FullscreenControls {
  const [active, setActive] = useState(() => Boolean(document.fullscreenElement));
  const supported = typeof document.documentElement.requestFullscreen === 'function';

  useEffect(() => {
    const onChange = () => setActive(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  }, [supported]);

  return { supported, active, toggle };
}

/** Keep the screen awake on a tablet that is acting as a scoreboard. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    interface WakeLockSentinel {
      release: () => Promise<void>;
      addEventListener: (type: string, listener: () => void) => void;
    }
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
    };
    if (!nav.wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = () => {
      nav
        .wakeLock!.request('screen')
        .then((lock) => {
          if (cancelled) {
            void lock.release();
            return;
          }
          sentinel = lock;
          lock.addEventListener('release', () => {
            sentinel = null;
          });
        })
        .catch(() => undefined);
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [enabled]);
}

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

/**
 * Keyboard shortcuts for the operator. Ignored while the user is typing, and
 * always additive: every shortcut also exists as a visible button.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const handler = mapRef.current[key];
      if (!handler) return;
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}

/** Interval that reschedules itself, used for the "suggest next match" poll. */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (delayMs === null) return;
    const id = window.setInterval(() => ref.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useStable<T>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}

/**
 * Live content-box size of an element.
 *
 * For a layout that has to fit itself to the space it is given -- the wall
 * poster scales itself to its frame instead of asking the reader to zoom. A
 * ResizeObserver rather than a window resize listener, so it also follows a
 * panel that changes size without the window doing so.
 */
export function useElementSize(ref: RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Sub-pixel churn from a scrollbar appearing would otherwise re-render on
    // every frame, so only a real change is published.
    const measure = (width: number, height: number): void => {
      setSize((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
    };
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) measure(box.width, box.height);
    });
    observer.observe(element);
    const box = element.getBoundingClientRect();
    measure(box.width, box.height);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
