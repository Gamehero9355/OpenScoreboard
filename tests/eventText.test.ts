/**
 * The activity feed, in German.
 *
 * The engine writes every log line and every toast, and it used to build them as
 * English template strings at the call site. German labels above and beside an
 * English feed is exactly the "always still English" complaint, so the fix moved
 * the wording into one table (`src/shared/eventMessages.ts`) and left the German
 * in the catalogue.
 *
 * What this file holds together is that arrangement:
 *
 *  - every sentence the engine can write has German that is genuinely different,
 *  - the English the server stores is unchanged (a database that changes language
 *    mid-tournament is not an audit record),
 *  - the values inside a sentence -- round names, group names, decision reasons,
 *    score action kinds -- are translated too, because "Runde 3 auf Field 1
 *    gestartet" with the English name still in it is not translated at all,
 *  - and a real engine run really does carry the key, rather than only the
 *    hand-built objects in this file doing so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_TEXT_KEYS,
  EVENT_TEXTS,
  renderEventText,
  sentenceMessage,
  type EventText,
} from '../src/shared/eventMessages';
import { MESSAGES, setActiveLocale, translate } from '../src/frontend/lib/i18n';
import { eventLine, sentenceLine } from '../src/frontend/lib/eventText';
import { roundNameLabel } from '../src/frontend/lib/radball';
import type { AppEvent } from '../src/shared/types';
import type { TournamentStore } from '../src/backend/store/store';
import { createTournament } from '../src/backend/tournament/engine';
import { startMatch } from '../src/backend/tournament/matchops';
import { adminCtx, createTestStore, playableMatches, run, type TestStore } from './helpers';

/** Build the event shape the engine pushes, for the renderer tests. */
function event(text: EventText, message: string): AppEvent {
  return {
    seq: 1,
    ts: 0,
    type: 'SYSTEM',
    fieldId: null,
    matchId: null,
    actor: 'Host',
    message,
    text,
  };
}

afterEach(() => {
  setActiveLocale('en');
});

describe('the engine sentence table', () => {
  it('has German for every sentence, and none of it is the English copy', () => {
    for (const key of EVENT_TEXT_KEYS) {
      const german = MESSAGES.de[key];
      expect(german, `${key} has no German`).toBeTruthy();
      expect(MESSAGES.de[key], `${key} is the English string`).not.toBe(EVENT_TEXTS[key]);
    }
  });

  it('keeps the placeholder names German needs', () => {
    // The catalogue test compares the two languages against each other; this
    // compares German against the table the server renders from, which is the
    // pair that has to agree for a value to arrive at all.
    const names = (template: string) => [...(template.match(/\{(\w+)\}/g) ?? [])].sort();
    for (const key of EVENT_TEXT_KEYS) {
      expect(names(MESSAGES.de[key]), `${key} (de)`).toEqual(names(EVENT_TEXTS[key]));
    }
  });

  it('renders the English the server stores', () => {
    expect(renderEventText('event.matchStarted', { round: 'Round 3', field: 'Field 1' })).toBe(
      'Round 3 started on Field 1.',
    );
    expect(
      renderEventText('event.matchFinished', { round: 'Semifinals', winner: 'RV A', a: 5, b: 3 }),
    ).toBe('Semifinals finished - RV A wins 5:3.');
    expect(renderEventText('event.teamsImportedOne')).toBe('Imported 1 team into the library.');
    expect(renderEventText('event.teamsImported', { n: 4 })).toBe('Imported 4 teams into the library.');
  });

  it('leaves a value nobody passed visible rather than blank', () => {
    expect(renderEventText('event.matchStarted', { round: 'Round 3' })).toBe('Round 3 started on {field}.');
  });

  it('passes free text through untouched', () => {
    // The validator's own output is not a sentence the table knows, and guessing
    // at one would be worse than leaving it as the engine wrote it.
    expect(sentenceMessage('Group A: places 1-2 are decided by a tie.')).toBe(
      'Group A: places 1-2 are decided by a tie.',
    );
  });
});

describe('reading a server sentence in German', () => {
  beforeEach(() => setActiveLocale('de'));

  it('translates the sentence and the round name inside it', () => {
    expect(sentenceLine({ key: 'event.matchStarted', params: { round: 'Round 3', field: 'Field 1' } }, 'x')).toBe(
      'Runde 3 auf Field 1 gestartet.',
    );
    expect(
      sentenceLine({ key: 'event.matchFinished', params: { round: 'Semifinals', winner: 'RV A', a: 5, b: 3 } }, 'x'),
    ).toBe('Halbfinals beendet - RV A gewinnt 5:3.');
  });

  it('translates a whole schedule of round names', () => {
    expect(sentenceLine({ key: 'event.finalPhaseOrder', params: { rounds: 'Semifinals → Final' } }, 'x')).toBe(
      'Reihenfolge der Finalrunde geändert: Halbfinals → Finale.',
    );
  });

  it('translates group names and decision reasons', () => {
    expect(sentenceLine({ key: 'event.groupComplete', params: { group: 'Group A', ranking: 'A1 RV A, A2 RV B' } }, 'x')).toBe(
      'Gruppe A abgeschlossen: A1 RV A, A2 RV B.',
    );
    expect(
      sentenceLine({ key: 'event.decisionMatchCreated', params: { a: 'RV A', b: 'RV B', reason: 'CHAMPIONSHIP_TIE' } }, 'x'),
    ).toBe('Entscheidungsspiel: RV A gegen RV B (Entscheidung um Platz 1).');
  });

  it('names the score action that was undone', () => {
    // No full stop: the engine's line never had one, and adding one here would
    // be this file rewriting the audit record.
    expect(
      sentenceLine({ key: 'event.scoreUndone', params: { action: 'score', actor: 'Host', a: 3, b: 2 } }, 'x'),
    ).toBe('Rückgängig: Punkt durch Host (zurück auf 3:2)');
    expect(sentenceLine({ key: 'event.scoreRedone', params: { action: 'reset', a: 3, b: 2 } }, 'x')).toBe(
      'Wiederholen: Zurücksetzen (weiter auf 3:2)',
    );
  });

  it('capitalises a match label German needs, while English lower-cases it', () => {
    // One name, two shapes: the engine sends both, and the language picks.
    const params = { winner: 'RV A', label: 'decision match', labelTitle: 'Decision match', a: 3, b: 2 };
    expect(sentenceLine({ key: 'notify.matchDecided', params }, 'x')).toBe('RV A gewinnt Entscheidungsspiel (3:2).');

    setActiveLocale('en');
    expect(sentenceLine({ key: 'notify.matchDecided', params }, 'x')).toBe('RV A wins decision match (3:2).');
    // The stored English is what the toast said before this existed.
    expect(renderEventText('notify.matchDecided', params)).toBe('RV A wins decision match (3:2).');
  });

  it('leaves the field name alone', () => {
    // Field names are the organiser's words, in whatever language they typed.
    expect(sentenceLine({ key: 'event.matchAssigned', params: { round: 'Round 1', field: 'Platz Süd' } }, 'x')).toBe(
      'Runde 1 auf Platz Süd gelegt.',
    );
  });
});

describe('falling back to the stored wording', () => {
  it('renders a line with no key exactly as it was written', () => {
    const bare = event(undefined as never, 'Participant added: Anna');
    delete (bare as { text?: unknown }).text;
    setActiveLocale('de');
    expect(eventLine(bare)).toBe('Participant added: Anna');
  });

  it('falls back when the key belongs to a build this one does not know', () => {
    setActiveLocale('de');
    expect(sentenceLine({ key: 'event.fromTheFuture' } as unknown as EventText, 'Something happened.')).toBe(
      'Something happened.',
    );
  });

  it('shows English on an English device, key or no key', () => {
    const started = event(
      { key: 'event.matchStarted', params: { round: 'Round 3', field: 'Field 1' } },
      'Round 3 started on Field 1.',
    );
    expect(eventLine(started)).toBe('Round 3 started on Field 1.');
  });
});

describe('the engine pushes a translatable line', () => {
  let env: TestStore;
  let store: TournamentStore;

  beforeEach(async () => {
    env = await createTestStore('event-text');
    store = env.store;
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('carries the key and its values alongside the English wording', () => {
    const ctx = adminCtx(store);
    run(store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Test Cup',
          format: 'single-elimination',
          participants: ['Anna', 'Ben', 'Cara', 'Dan'].map((name, index) => ({
            name,
            team: null,
            seed: index + 1,
            checkedIn: true,
            fieldId: null,
          })),
          thirdPlaceMatch: true,
          seeded: true,
          seedValue: 7,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['Field 1', 'Field 2'],
        },
        c,
        mut,
      );
    });

    // The bracket pre-loads the free fields, so the first playable match is not
    // necessarily the opening round; the expectation is derived from whichever
    // one this run actually started.
    const match = playableMatches(store)[0];
    run(store, adminCtx(store), (state, c, mut) => {
      startMatch(state, match.id, '1', c, mut);
    });

    const started = store.state.events.find((e) => e.type === 'MATCH_STARTED');
    expect(started).toBeTruthy();
    expect(started?.message).toBe(`${match.roundName} started on Field 1.`);
    expect(started?.text).toEqual({
      key: 'event.matchStarted',
      params: { round: match.roundName, field: 'Field 1' },
    });

    // And the line a German device would read, from the event the engine built:
    // the sentence translated, the round name inside it translated with it.
    setActiveLocale('de');
    // The name mapping itself is asserted literally above; this asserts the
    // wiring: the key reached the state, and the renderer put the translated
    // name and the sentence together without the engine knowing any German.
    expect(eventLine(started as AppEvent)).toBe(`${roundNameLabel(match.roundName)} auf Field 1 gestartet.`);
    expect(eventLine(started as AppEvent)).toMatch(/gestartet\.$/);
  });

  it('keeps the score line as free text, because it reads the same in both', () => {
    // "RV A +1 (2:1)" is a name, a signed number and a score: there is no
    // sentence to translate, so the engine does not pretend there is one.
    expect(translate('de', 'eventAction.score')).toBe('Punkt');
    expect(EVENT_TEXT_KEYS).not.toContain('event.scoreUpdated');
  });
});
