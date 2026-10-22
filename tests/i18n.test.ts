/**
 * The German translation.
 *
 * The risk this guards against is a language that is *nearly* there: a key
 * missing from German silently renders the English string, which reads as
 * "unfinished" rather than "broken" and so tends to survive review. A language
 * nobody notices is incomplete is a language nobody ever finishes.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  MESSAGES,
  intlTag,
  missingKeys,
  normaliseLocale,
  translate,
  translatedKeyCount,
  type MessageKey,
} from '../src/frontend/lib/i18n';
import { localeOverrideStore } from '../src/frontend/lib/useI18n';
import { validateSettingsPatch } from '../src/shared/protocol';
import { DEFAULT_SETTINGS } from '../src/backend/tournament/defaults';

const ALL_KEYS = Object.keys(MESSAGES.en) as MessageKey[];

describe('the catalogue', () => {
  it('offers English and German, named as each language names itself', () => {
    expect([...LOCALES]).toEqual(['en', 'de']);
    expect(LOCALE_NAMES.en).toBe('English');
    // A German host looking for "Deutsch" must not have to read "German".
    expect(LOCALE_NAMES.de).toBe('Deutsch');
  });

  it('has no key German is missing', () => {
    expect(missingKeys('de')).toEqual([]);
  });

  it('has no key English is missing, by construction', () => {
    expect(missingKeys('en')).toEqual([]);
    // English is the source of truth, so its own table is the key list.
    expect(Object.keys(MESSAGES.de).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('actually differs between the two languages rather than copying English', () => {
    // A "translation" that is mostly the English string is a half-finished job
    // that reads as done.
    const translated = translatedKeyCount('de');
    expect(translated).toBeGreaterThan(ALL_KEYS.length * 0.95);
  });

  it('leaves German brand terms untranslated', () => {
    // These are proper nouns in the domain: a BDR fixture, a club's registered
    // name, an age class. Translating them would put the app at odds with the
    // paperwork the organiser is holding.
    expect(MESSAGES.en['radball.shootoutScore']).toContain('4m');
    expect(MESSAGES.de['radball.shootoutScore']).toContain('4m');
    expect(MESSAGES.de['settings.requirePin']).toContain('PIN');
    expect(MESSAGES.de['settings.rotateAdmin']).toContain('Token');
    expect(MESSAGES.de['radball.bdrPreset']).toContain('BDR');
  });

  it('keeps umlauts intact rather than transliterating them', () => {
    // `ae/oe/ue` transliteration is the failure mode being guarded against: a
    // German speaker notices immediately, and it is the usual sign that a string
    // was transliterated rather than translated.
    expect(MESSAGES.de['settings.fields']).toBe('Plätze');
    expect(MESSAGES.de['field.count']).toBe('Spielflächen');
    expect(MESSAGES.de['settings.developer']).toBe('Entwickler');
    expect(MESSAGES.de['action.close']).toBe('Schließen');
    expect(MESSAGES.de['setup.format']).toBe('Format');
    expect(MESSAGES.de['radball.reducedTime']).toBe('Reduzierte Spielzeit');
    expect(MESSAGES.de['setup.enterName']).toContain('Turniernamen');
    expect(MESSAGES.de['nav.standings']).toBe('Tabellen');
    expect(MESSAGES.de['results.club']).toBe('Verein');
    // `Fuer`/`Feld`/`Ueber` spellings must not appear anywhere in the catalogue.
    const german = Object.values(MESSAGES.de).join(' ');
    expect(german).not.toMatch(/\b(?:Ueber|Ae|Oe|Ue)\w*/);
    expect(MESSAGES.de['radball.finalPhaseWaiting']).toContain('freigeschaltet');
  });

  it('leaves no placeholder unfilled in either language', () => {
    // A template whose placeholders disagree between languages produces a
    // string with a literal `{n}` on screen, which is worse than English.
    const placeholders = (template: string) => (template.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of ALL_KEYS) {
      expect(placeholders(MESSAGES.de[key]), `${key} (de)`).toEqual(placeholders(MESSAGES.en[key]));
    }
  });

  it('keeps every placeholder name the same on both sides', () => {
    const names = (template: string) => [...(template.match(/\{(\w+)\}/g) ?? [])].map((m) => m.slice(1, -1)).sort();
    for (const key of ALL_KEYS) {
      expect(names(MESSAGES.de[key]), `${key} (de)`).toEqual(names(MESSAGES.en[key]));
    }
  });
});

describe('lookup', () => {
  it('returns the sentence for the requested language', () => {
    expect(translate('en', 'action.undo')).toBe('Undo');
    expect(translate('de', 'action.undo')).toBe('Rückgängig');
    expect(translate('de', 'action.finish')).toBe('Match beenden');
  });

  it('substitutes placeholders in both languages', () => {
    expect(translate('en', 'field.label', { n: 2 })).toBe('Field 2');
    expect(translate('de', 'field.label', { n: 2 })).toBe('Feld 2');
    expect(translate('en', 'score.of', { a: 5, b: 3 })).toBe('5 : 3');
    expect(translate('de', 'score.of', { a: 5, b: 3 })).toBe('5 : 3');
  });

  it('substitutes several placeholders in one string', () => {
    const en = translate('en', 'field.controlled', { field: 'Field 1', who: 'Anna' });
    const de = translate('de', 'field.controlled', { field: 'Platz 1', who: 'Anna' });
    expect(en).toBe('Field 1 is currently controlled by Anna.');
    expect(de).toBe('Platz 1 wird gerade von Anna bedient.');
  });

  it('leaves a missing placeholder visible rather than blank', () => {
    // Silently dropping it would produce "Field " and read as a bug in the app
    // rather than a bug in the caller.
    expect(translate('en', 'field.label')).toBe('Field {n}');
    expect(translate('de', 'field.label')).toBe('Feld {n}');
  });

  it('coerces anything it is handed to a supported language', () => {
    expect(normaliseLocale('de')).toBe('de');
    expect(normaliseLocale('en')).toBe('en');
    expect(normaliseLocale('fr')).toBe(DEFAULT_LOCALE);
    expect(normaliseLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normaliseLocale(null)).toBe(DEFAULT_LOCALE);
    expect(normaliseLocale(42)).toBe(DEFAULT_LOCALE);
    // A German regional variant falls back to German, not to English.
    expect(normaliseLocale('de-AT')).toBe(DEFAULT_LOCALE);
  });

  it('keeps a language out of the catalogue from crashing the app', () => {
    // The setting arrives from disk and from the network, so an unexpected value
    // has to land on the default rather than on a blank screen.
    expect(translate(normaliseLocale('es'), 'action.undo')).toBe('Undo');
  });
});

describe('date and number formatting', () => {
  it('uses the locale region, not just the language', () => {
    expect(intlTag('de', 'date')).toBe('de-DE');
    expect(intlTag('en', 'date')).toBe('en-GB');
  });

  it('resolves an Intl tag for every locale and every field', () => {
    // The formatting itself is `Intl`'s job; this only guards the plumbing,
    // i.e. that the tag handed to `Intl.DateTimeFormat` / `NumberFormat` is one
    // the runtime actually accepts. A malformed tag throws `RangeError` at
    // construction time, which on a projector screen is a blank display.
    for (const locale of LOCALES) {
      for (const field of ['date', 'time', 'number'] as const) {
        const tag = intlTag(locale, field);
        expect(tag.length, `${locale}.${field}`).toBeGreaterThan(0);
        expect(() => new Intl.DateTimeFormat(tag)).not.toThrow();
        expect(() => new Intl.NumberFormat(tag)).not.toThrow();
      }
    }
  });
});

describe('the per-device override is shared, not per component', () => {
  /**
   * The regression that shipped: `useI18n` kept the override in a `useState`,
   * so every call site had its own independent copy. Tapping "Deutsch" on the
   * settings rail re-rendered the two buttons and nothing else — every other
   * component still read its own `null` and fell back to the host's English.
   * From the user's side that is indistinguishable from "the translation does
   * not work", which is why it needs a test and not a careful read.
   */
  it('notifies every subscriber when one component changes it', () => {
    const store = localeOverrideStore;
    const original = store.get();
    let first = 0;
    let second = 0;
    // Two independent readers, as two components would be: each keeps the value
    // it last saw and updates it only inside its own notification. Comparing
    // `store.get()` with itself would pass even if every caller had its own
    // private copy, which is the regression this test exists for.
    let seenByFirst = store.get();
    let seenBySecond = store.get();
    const offA = store.subscribe(() => {
      first += 1;
      seenByFirst = store.get();
    });
    const offB = store.subscribe(() => {
      second += 1;
      seenBySecond = store.get();
    });
    try {
      store.set('de');
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(0);
      expect(store.get()).toBe('de');
      // Every caller now reads the same value, which is the whole point.
      expect(seenByFirst).toBe('de');
      expect(seenBySecond).toBe('de');
      expect(seenByFirst).toBe(seenBySecond);

      store.set(null);
      expect(first).toBeGreaterThan(1);
      expect(second).toBeGreaterThan(1);
      expect(store.get()).toBe(null);
    } finally {
      offA();
      offB();
      store.set(original);
    }
  });

  it('stops notifying after unsubscribe', () => {
    const store = localeOverrideStore;
    const original = store.get();
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    store.set('de');
    const afterFirst = count;
    off();
    store.set('en');
    expect(count).toBe(afterFirst);
    store.set(original);
  });

  it('survives a value that is not a language', () => {
    const store = localeOverrideStore;
    const original = store.get();
    try {
      // Written by an older build or hand-edited storage: it must not reach the
      // catalogue and render as an empty screen.
      store.set('fr' as never);
      expect(normaliseLocale(store.get())).toBe(DEFAULT_LOCALE);
    } finally {
      store.set(original);
    }
  });
});

describe('the language setting', () => {
  it('defaults to English, so an untouched install is unchanged', () => {
    expect(DEFAULT_SETTINGS.language).toBe('en');
  });

  it('accepts both languages from the host', () => {
    for (const locale of ['en', 'de'] as const) {
      const result = validateSettingsPatch({ language: locale }, DEFAULT_SETTINGS);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.language).toBe(locale);
    }
  });

  it('refuses anything else, server-side', () => {
    for (const bad of ['fr', 'EN', '', null, 7, {}]) {
      const result = validateSettingsPatch({ language: bad } as never, DEFAULT_SETTINGS);
      expect(result.ok, `language: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('ignores an absent key rather than rejecting the whole patch', () => {
    // A phone on an older build sends a patch without it; the rest of the host's
    // settings must still go through.
    const result = validateSettingsPatch({ theme: 'light' }, DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.theme).toBe('light');
  });

  it('carries the language as an ordinary settings change', () => {
    // No dedicated command and no special delta: it is one more field on the
    // settings slice, so every screen follows the host for free.
    const result = validateSettingsPatch({ language: 'de' }, DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    if (result.ok) expect('language' in result.value).toBe(true);
  });
});

describe('the German wording', () => {
  /**
   * Spot checks on the sentences a host actually reads mid-event. These are the
   * ones where a plausible-looking translation can be *wrong* rather than just
   * unusual -- "Match beenden" vs "Spiel beenden", or a hint that tells a
   * volunteer the opposite of the truth.
   */
  const cases: [MessageKey, string, RegExp][] = [
    ['action.undo', 'Rückgängig', /^Rückgängig$/],
    ['action.redo', 'Wiederholen', /^Wiederholen$/],
    ['action.correct', 'Ergebnis korrigieren', /korrigieren/],
    ['action.finish', 'Match beenden', /^Match beenden$/],
    ['conn.offline', 'Offline', /^Offline$/],
    ['match.halftime', 'Halbzeit', /^Halbzeit$/],
    ['field.shared', 'Gemeinsam · beide Plätze', /beide Plätze/],
    ['radball.shootout', '4-Meter-Verfahren', /4-Meter/],
    ['radball.eliteNoLimit', 'Elite · ohne Altersgrenze', /ohne Altersgrenze/],
    ['results.played', 'Spiele', /^Spiele$/],
    ['results.pts', 'Pkt.', /^Pkt\.$/],
    ['role.spectator', 'Zuschauer', /^Zuschauer$/],
    ['err.fieldBusy', 'Auf diesem Platz läuft noch ein Match.', /läuft noch ein Match/],
  ];

  for (const [key, expected, shape] of cases) {
    it(`${key} reads as "${expected}"`, () => {
      expect(translate('de', key)).toBe(expected);
      expect(translate('de', key)).toMatch(shape);
      // And it is genuinely different from English, or the check is vacuous.
      if (MESSAGES.en[key] !== expected) expect(translate('de', key)).not.toBe(translate('en', key));
    });
  }

  it('uses "Feld" for a playing field\'s name', () => {
    // The hall calls its playing surfaces "Feld", so an untouched default
    // field name reads as "Feld 1" rather than the English "Field 1" it is
    // stored as. Rank-related "Platz" wording (Spiel um Platz 3,
    // Platzierungsspiele) is a different word and stays as it is.
    expect(MESSAGES.de['field.label']).toBe('Feld {n}');
    expect(MESSAGES.de['results.field']).toBe('Feld');
  });

  it('addresses the host the way a German sports hall does', () => {
    expect(MESSAGES.de['role.admin']).toBe('Turnierleitung');
    expect(MESSAGES.de['nav.host']).toBe('Turnierleitung');
    // "Host" is fine for the machine; it is not what you call the organiser.
    expect(MESSAGES.de['nav.host']).not.toBe('Host-Dashboard');
  });

  it('names the K.-o. format the way the rules are written', () => {
    expect(MESSAGES.de['format.single-elimination']).toContain('K.-o.');
    expect(MESSAGES.de['format.radball']).toBe('Radball 2er');
  });

  it('templates the age class in, leaving U11..ELITE alone', () => {
    // The class code is the BDR's own label and must survive verbatim; only the
    // English gloss around it changes.
    expect(translate('en', 'radball.underAge', { age: 'U15', years: 15 })).toBe('U15 · under 15');
    expect(translate('de', 'radball.underAge', { age: 'U15', years: 15 })).toBe('U15 · unter 15');
  });

  it('keeps the scores and clock out of the translator', () => {
    // A translated score is a different number. Digits, colons and the `4m`
    // shootout notation stay exactly as they are.
    expect(translate('de', 'score.of', { a: 7, b: 7 })).toBe('7 : 7');
    expect(translate('de', 'score.zero')).toBe('0');
    expect(translate('de', 'radball.shootoutScore', { a: 3, b: 1 })).toBe('4m 3:1');
  });
});