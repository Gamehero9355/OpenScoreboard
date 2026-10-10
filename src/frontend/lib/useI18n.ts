/**
 * The active language.
 *
 * Precedence, most specific first:
 *
 *  1. **This device's own choice**, remembered in `localStorage`. A field
 *     operator running a German club's tournament while the host has left the
 *     language on English should not have to ask the host to change it.
 *  2. **The host's setting**, which travels in the settings delta so switching on
 *     the host repaints every screen at once -- the behaviour the projector and
 *     the queue tablets rely on.
 *  3. **English**, so a device that has connected to nothing yet still renders.
 *
 * ## Why this is a module-level store
 *
 * The override is a *global* value, so it has to be held globally. An earlier
 * version kept it in a `useState` inside this hook, which looks right because
 * every component calls `useI18n()` -- and silently does nothing: each call site
 * gets its own independent state, so tapping "Deutsch" on the settings rail
 * re-rendered the two buttons and nothing else. Every other component still read
 * its own `null` and fell back to the host's English, which looks exactly like a
 * broken translation.
 *
 * `useSyncExternalStore` over a module-level emitter is the same shape `live` and
 * `useLive` already use (`hooks.ts`), so one value is shared by every caller and
 * they all re-render together.
 *
 * ## Why the store is also exported
 *
 * `setLocale` used to hold its own copy of the value while the store kept
 * another, so a test that drove only the store passed against code that was
 * broken. `localeOverrideStore.set` *is* the function the hook now calls, and
 * `tests/i18n.test.ts` asserts that one setter reaches every subscriber -- which
 * is the property that was missing and the one that makes the switch work.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  DEFAULT_LOCALE,
  normaliseLocale,
  setActiveLocale,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from './i18n';
import type { Translate } from '../../shared/matchUtils';
import { useLive } from './hooks';

const STORAGE_KEY = 'tsb.locale';

export interface I18n {
  /** The language actually in use. */
  locale: Locale;
  /** Look up a message in that language. */
  t: (key: MessageKey, params?: MessageParams) => string;
  /**
   * Switch language on this device only.
   *
   * Deliberately local: the host's own setting is a separate control, and a
   * phone that quietly overrode the whole hall's language because someone
   * tapped it would be worse than useless.
   */
  setLocale: (locale: Locale) => void;
  /** Forget this device's choice and follow the host again. */
  followHost: () => void;
  /** True when this device is overriding the host. */
  isOverridden: boolean;
}

/* ------------------------------------------------------------------ */
/* The shared override store                                          */
/* ------------------------------------------------------------------ */

/**
 * `null` means "no choice on this device", which is why it is not just a
 * `Locale`: the difference between English and not-yet-decided is the whole
 * precedence rule.
 *
 * Seeded once at module load. Reading `localStorage` per render would be both
 * wrong (it is not reactive) and slow; reading it per *component* is how the
 * per-component-state bug above happened.
 */
let override: Locale | null = readStored();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readStored(): Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'en' || raw === 'de' ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(locale: Locale | null): void {
  try {
    if (locale === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private browsing; the app still works, it just forgets the choice */
  }
}

/** `<html lang>` wants a full tag, for hyphenation and screen-reader voices. */
function langAttribute(locale: Locale): string {
  return locale === 'de' ? 'de-DE' : 'en-GB';
}

/**
 * The one place the override is written.
 *
 * Both `setLocale` and `followHost` in the hook below go through here, so the
 * store stays the single mutation point and a test can drive it without React.
 * That matters: an earlier version had `setLocale` hold its own copy of the value
 * while the store kept another, so a test that only exercised the store passed
 * against code that was broken.
 */
function setOverride(next: Locale | null): void {
  writeStored(next);
  override = next;
  emit();
}

/**
 * The active language and a `t()` bound to it.
 *
 * Reads the host's settings through `useLive`, so it re-renders when the host
 * changes the language, and reads this device's override from the shared store,
 * so it re-renders when *any* component changes it.
 */
export function useI18n(): I18n {
  const snapshot = useLive();
  const hostLocale = normaliseLocale(snapshot.state?.settings?.language);
  const deviceOverride = useSyncExternalStore(subscribe, getOverride, getOverride);

  const locale = deviceOverride ?? hostLocale ?? DEFAULT_LOCALE;

  // Published for module-level code on the *same* render that produces it. In an
  // effect it would be one render behind, and the round titles a builder computes
  // during render would be written in the previous language -- a half-translated
  // bracket, which is exactly the bug this whole exercise is about.
  setActiveLocale(locale);

  // The document language drives hyphenation, `Intl` defaults and the voice a
  // screen reader picks, so it has to follow the same value the text does.
  useEffect(() => {
    document.documentElement.setAttribute('lang', langAttribute(locale));
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setOverride(normaliseLocale(next));
  }, []);

  const followHost = useCallback(() => {
    setOverride(null);
  }, []);

  return useMemo<I18n>(
    () => ({
      locale,
      t: (key, params) => translate(locale, key, params),
      setLocale,
      followHost,
      isOverridden: deviceOverride !== null,
    }),
    [locale, deviceOverride, setLocale, followHost],
  );
}

/** The store snapshot. Identity only changes when the override does. */
function getOverride(): Locale | null {
  return override;
}

/**
 * Test-only view of the override store.
 *
 * Exported so `tests/i18n.test.ts` can assert the property that actually broke:
 * that one setter notifies *every* subscriber. With the value in per-component
 * `useState` there was one state per caller, so tapping the switch re-rendered
 * the buttons and nothing else -- which looks exactly like a translation that
 * does not work, and is why this needs a test rather than a code read.
 */
export const localeOverrideStore = {
  subscribe,
  get: getOverride,
  /** The same function `setLocale` and `followHost` use. */
  set: setOverride,
};

/**
 * The same lookup for a component that cannot call a hook.
 *
 * Only for module-level helpers such as label tables and accessibility strings;
 * anything rendered should use `useI18n().t`.
 */
export function translateFor(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  return translate(locale, key, params);
}

/**
 * Adapt `t` for `src/shared` helpers, which take a looser signature.
 *
 * `shared/matchUtils.waitingReason` and friends cannot import the catalogue, so
 * their key is a plain `string` and the strictly typed `t` is not directly
 * assignable to it. This is the single place that bridges the two. The cast is
 * sound in the direction it matters: `shared` only ever passes keys that exist in
 * the catalogue (enforced by its own `englishWaiting` switch), and anything it
 * does not recognise falls back to English rather than reaching the catalogue.
 */
export function asTranslate(t: I18n['t']): Translate {
  return t as unknown as Translate;
}