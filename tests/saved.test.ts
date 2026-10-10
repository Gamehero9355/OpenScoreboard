/**
 * The saved-setup shelf: filing a setup, loading it back, and the two ways a
 * shelf can rot -- a hand-edited file and a duplicate label.
 *
 * The frontend half is pure and lives in `src/frontend/lib/saved.ts`, so the
 * round trip between the wizard and the shelf is checked here too rather than
 * only by clicking through the page.
 */
import { describe, expect, it } from 'vitest';
import {
  emptySavedTournamentLibrary,
  emptySavedTournamentSetup,
  orderedSavedTournaments,
  type SavedTournamentSetup,
  type TournamentState,
} from '../src/shared/types';
import {
  MAX_SAVED_TOURNAMENTS,
  removeTournamentSetup,
  renameTournamentSetup,
  sanitiseSavedTournamentLibrary,
  sanitiseSavedTournamentSetup,
  saveTournamentSetup,
} from '../src/backend/tournament/saved';
import { EXAMPLE_SETUPS, findExampleSetup } from '../src/shared/examples';
import { COMMANDS } from '../src/shared/commands';
import { createTournament } from '../src/backend/tournament/engine';
import { createEmptyState } from '../src/backend/tournament/defaults';
import { createIdGenerator } from '../src/backend/util/ids';
import { createMutation, type Ctx, type Mutation } from '../src/backend/tournament/state';
import { EngineError } from '../src/backend/util/errors';
import { draftToSetup, savedSetupFacts, savedSetupLabel, savedSetups, setupToDraft } from '../src/frontend/lib/saved';
import { TournamentStore } from '../src/backend/store/store';
import {
  buildEffectiveSetup,
  createDraft,
  mergeRoster,
  normaliseDraft,
  parseRadballTeams,
  rosterIssues,
} from '../src/frontend/pages/SetupPage';
import { createTestStore, adminCtx } from './helpers';

const newId = createIdGenerator();

function ctx(now = 1_700_000_000_000): Ctx {
  return { now, actor: 'Host', role: 'admin', fieldScope: null, newId };
}

function state(): TournamentState {
  return createEmptyState();
}

function apply(fn: (s: TournamentState, c: Ctx, m: Mutation) => void, now?: number): Mutation {
  const s = state();
  const mut = createMutation();
  fn(s, ctx(now), mut);
  return mut;
}

function validSetup(overrides: Partial<SavedTournamentSetup> = {}): SavedTournamentSetup {
  return {
    ...emptySavedTournamentSetup(),
    name: 'City Open 2026',
    fieldNames: ['Hall', 'Side'],
    fieldBulk: ['Anna,Bulls\nBen,Bulls', 'Cara,Cobras\nDan,Cobras'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Filing and shelf management                                        */
/* ------------------------------------------------------------------ */

describe('saving a tournament setup', () => {
  it('files a setup and records one event', () => {
    const s = state();
    const mut = createMutation();
    const entry = saveTournamentSetup(s, { name: 'City Open 2026', setup: validSetup() }, ctx(), mut);
    expect(entry.name).toBe('City Open 2026');
    expect(entry.setup.name).toBe('City Open 2026');
    expect(mut.savedTournaments).toBe(true);
    // The shelf is the host's own, so a change to it is worth an immediate write.
    expect(mut.urgency).toBe('immediate');
    expect(mut.events.map((event) => event.type)).toEqual(['SETUP_SAVED']);
  });

  it('keeps the shelf when a tournament is created, replaced or reset', () => {
    const s = state();
    const saved = saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(), createMutation());

    createTournament(
      s,
      {
        name: 'Live event',
        format: 'single-elimination',
        participants: [
          { name: 'Anna', team: null, seed: null, checkedIn: true },
          { name: 'Ben', team: null, seed: null, checkedIn: true },
        ],
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracketNow: true,
      },
      ctx(),
      createMutation(),
    );

    // This is the whole reason the shelf exists: the next event of the same kind
    // must still be there after the current one is built.
    expect(orderedSavedTournaments(s.savedTournaments).map((entry) => entry.name)).toEqual(['City Open']);
    expect(saved.name).toBe('City Open');
  });

  it('overwrites in place, keeping the id and the creation date', () => {
    const s = state();
    const original = saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(1000), createMutation());
    const updated = saveTournamentSetup(
      s,
      { id: original.id, name: 'City Open', setup: validSetup({ name: 'City Open 2027' }) },
      ctx(2000),
      createMutation(),
    );
    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.updatedAt).toBe(2000);
    expect(updated.setup.name).toBe('City Open 2027');
    // One card, not two: the shelf keeps one entry per label.
    expect(Object.keys(s.savedTournaments.entries)).toHaveLength(1);
  });

  it('refuses a second setup with the same label, case-insensitively', () => {
    const s = state();
    saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(), createMutation());
    expect(() =>
      saveTournamentSetup(s, { name: 'city open', setup: validSetup({ name: 'Other' }) }, ctx(), createMutation()),
    ).toThrow(/already holds a setup called "City Open"/);
    // Re-saving the same label onto itself is the update path, not a clash.
    expect(() =>
      saveTournamentSetup(
        s,
        { id: orderedSavedTournaments(s.savedTournaments)[0].id, name: 'City Open', setup: validSetup() },
        ctx(),
        createMutation(),
      ),
    ).not.toThrow();
  });

  it('refuses a setup the wizard could never create', () => {
    expect(() =>
      apply((s, c, m) => saveTournamentSetup(s, { name: 'Empty', setup: validSetup({ fieldBulk: ['', ''] }) }, c, m)),
    ).toThrow(/at least 2 participants/);
    // A blank label falls back to the event name, so a shelf entry can never end
    // up nameless -- but it still needs an event to be named after.
    expect(() =>
      apply((s, c, m) => saveTournamentSetup(s, { name: '  ', setup: validSetup({ name: '  ' }) }, c, m)),
    ).toThrow(/Give this setup a name/);
    // The World Cup shape plays one group per field, on the shelf exactly as in
    // the wizard: two field rosters that cannot be two equal groups are refused.
    const roster = (count: number) =>
      Array.from({ length: count }, (_, index) => `t${index},x${index},y${index}`).join('\n');
    const worldCup = (
      s: TournamentState,
      c: Ctx,
      m: Mutation,
      bulk: string[],
      fieldNames = ['Hall', 'Side'],
    ) =>
      saveTournamentSetup(
        s,
        { name: 'World Cup', setup: validSetup({ format: 'radball', setupMode: 'ten-team', fieldNames, radballBulk: bulk }) },
        c,
        m,
      );
    expect(() => apply((s, c, m) => worldCup(s, c, m, [roster(5), roster(4)]))).toThrow(
      /same number of teams in both groups/i,
    );
    // A team on a third field has no group at all, because the third field has no
    // group to play in.
    expect(() =>
      apply((s, c, m) => worldCup(s, c, m, [roster(5), roster(3), roster(2)], ['Hall', 'Side', 'Third'])),
    ).toThrow(/one group per field/i);
    // One field cannot hold two groups, whatever the roster says.
    expect(() => apply((s, c, m) => worldCup(s, c, m, [roster(5)], ['Hall']))).toThrow(
      /needs two playing fields/i,
    );
  });

  it('stops the shelf growing past its cap', () => {
    const s = state();
    for (let index = 0; index < MAX_SAVED_TOURNAMENTS; index += 1) {
      saveTournamentSetup(
        s,
        { name: `Event ${index}`, setup: validSetup({ name: `Event ${index}` }) },
        ctx(index),
        createMutation(),
      );
    }
    expect(() =>
      saveTournamentSetup(s, { name: 'One too many', setup: validSetup({ name: 'One too many' }) }, ctx(), createMutation()),
    ).toThrow(/at most/);
  });

  it('renames without touching the setup it points at', () => {
    const s = state();
    const entry = saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(1), createMutation());
    const renamed = renameTournamentSetup(s, entry.id, '  City Open 2027 ', ctx(2), createMutation());
    expect(renamed.name).toBe('City Open 2027');
    expect(renamed.setup).toEqual(entry.setup);
    expect(renamed.updatedAt).toBe(2);
  });

  it('rejects an empty or duplicate rename', () => {
    const s = state();
    const entry = saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(), createMutation());
    saveTournamentSetup(s, { name: 'School Cup', setup: validSetup({ name: 'School Cup' }) }, ctx(), createMutation());
    expect(() => renameTournamentSetup(s, entry.id, '   ', ctx(), createMutation())).toThrow(/Give this setup a name/);
    expect(() => renameTournamentSetup(s, entry.id, 'school cup', ctx(), createMutation())).toThrow(/already holds/);
  });

  it('removes a setup and forgets its id', () => {
    const s = state();
    const entry = saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, ctx(), createMutation());
    const mut = createMutation();
    removeTournamentSetup(s, entry.id, mut);
    expect(s.savedTournaments.entries[entry.id]).toBeUndefined();
    expect(s.savedTournaments.order).toEqual([]);
    expect(mut.events.map((event) => event.type)).toEqual(['SETUP_REMOVED']);
    expect(() => removeTournamentSetup(s, entry.id, createMutation())).toThrow(EngineError);
  });

  it('reports a stale id rather than silently filing a new entry', () => {
    expect(() =>
      apply((s, c, m) => saveTournamentSetup(s, { id: 'gone', name: 'City Open', setup: validSetup() }, c, m)),
    ).toThrow(/no longer on the shelf/);
  });

  it('falls back to the event name when no label is given', () => {
    const mut = apply((s, c, m) => saveTournamentSetup(s, { setup: validSetup() }, c, m));
    expect(mut.events[0].message).toContain('City Open 2026');
    // A blank box is the same as no box, so it must not become a nameless entry.
    const blank = apply((s, c, m) => saveTournamentSetup(s, { name: '   ', setup: validSetup() }, c, m));
    expect(blank.events[0].message).toContain('City Open 2026');
  });
});

/* ------------------------------------------------------------------ */
/* Normalisation                                                      */
/* ------------------------------------------------------------------ */

describe('normalising a saved setup', () => {
  it('keeps a well-formed setup intact', () => {
    const setup = validSetup({ format: 'radball' });
    expect(sanitiseSavedTournamentSetup(setup).format).toBe('radball');
  });

  it('replaces nonsense with the documented default rather than failing', () => {
    const setup = sanitiseSavedTournamentSetup({
      version: 1,
      name: 'Broken',
      format: 'round-robin-ish',
      fieldNames: ['  Hall  ', '', 'Court', 42, 'Pad', 'Ring', 'Track', 'Green', 'Blue'],
      thirdPlace: 'yes',
      seeded: null,
      drawMode: 'sideways',
      manualSlots: ['a', 7, null],
      durationSec: 999999,
      scoringIncrements: [1, 1, 0, 2.5],
      ageCategory: 'U99',
      groupCount: 42,
      finalMode: 'knockout',
      setupMode: 'chaos',
    });
    expect(setup.format).toBe('single-elimination');
    // Blank and non-string field names are dropped, and the cap holds at eight.
    expect(setup.fieldNames).toEqual(['Hall', 'Court', 'Pad', 'Ring', 'Track', 'Green', 'Blue']);
    expect(setup.thirdPlace).toBe(true);
    expect(setup.seeded).toBe(true);
    expect(setup.drawMode).toBe('auto');
    expect(setup.manualSlots).toEqual(['a', null, null]);
    // Eleven days is not a duration, so it falls back like every other
    // out-of-range number rather than being silently clamped to two hours.
    expect(setup.durationSec).toBe(600);
    // One bad button throws the whole list away, exactly as the wizard does, so
    // a shelf entry never carries a bracket the host cannot score.
    expect(setup.scoringIncrements).toEqual([1, 2, 3]);
    expect(sanitiseSavedTournamentSetup({ scoringIncrements: [1, 2, 3] }).scoringIncrements).toEqual([1, 2, 3]);
    expect(sanitiseSavedTournamentSetup({ scoringIncrements: [2, -1, 1] }).scoringIncrements).toEqual([2, -1, 1]);
    expect(setup.ageCategory).toBe('ELITE');
    expect(setup.groupCount).toBe(1);
    expect(setup.finalMode).toBe('none');
    expect(setup.setupMode).toBe('standard');
  });

  it('trims roster text to the fields the setup actually has', () => {
    const setup = sanitiseSavedTournamentSetup({
      fieldNames: ['Only field'],
      fieldBulk: ['Anna', 'Ben', 'Cara'],
      radballBulk: ['A,x,y', 'B,z,w'],
    });
    expect(setup.fieldBulk).toEqual(['Anna']);
    expect(setup.radballBulk).toEqual(['A,x,y']);
  });

  it('falls back to the default fields when the list is unusable', () => {
    expect(sanitiseSavedTournamentSetup({ fieldNames: [] }).fieldNames).toEqual(['Field 1', 'Field 2']);
    expect(sanitiseSavedTournamentSetup('nonsense').fieldNames).toEqual(['Field 1', 'Field 2']);
  });

  it('drops shelf entries that could never create anything', () => {
    const library = sanitiseSavedTournamentLibrary({
      entries: {
        good: { name: 'City Open', setup: validSetup(), createdAt: 1, updatedAt: 5 },
        noRoster: { name: 'Empty', setup: validSetup({ fieldBulk: ['', ''] }) },
        radballTooSmall: { name: 'Two teams', setup: validSetup({ format: 'radball', radballBulk: ['A,x,y'] }) },
        noName: { setup: validSetup() },
        junk: 'not an object',
      },
      order: ['good', 'missing', 'noRoster'],
    });
    expect(orderedSavedTournaments(library).map((entry) => entry.name)).toEqual(['City Open']);
    // Unknown and dropped ids are pruned from the order rather than left dangling.
    expect(library.order).toEqual(['good']);
  });

  it('keeps the first of two entries with the same label', () => {
    const library = sanitiseSavedTournamentLibrary({
      entries: {
        first: { name: 'City Open', setup: validSetup(), createdAt: 1, updatedAt: 1 },
        second: { name: 'city open', setup: validSetup(), createdAt: 2, updatedAt: 2 },
      },
      order: [],
    });
    expect(Object.keys(library.entries)).toEqual(['first']);
  });

  it('survives a corrupt snapshot rather than refusing to start', () => {
    expect(sanitiseSavedTournamentLibrary(null)).toEqual(emptySavedTournamentLibrary());
    expect(sanitiseSavedTournamentLibrary({ entries: 'nope' })).toEqual(emptySavedTournamentLibrary());
  });

  it('lists the most recently updated setup first', () => {
    const library = sanitiseSavedTournamentLibrary({
      entries: {
        a: { name: 'Older', setup: validSetup(), createdAt: 1, updatedAt: 10 },
        b: { name: 'Newest', setup: validSetup(), createdAt: 3, updatedAt: 30 },
        c: { name: 'Middle', setup: validSetup(), createdAt: 2, updatedAt: 20 },
      },
      order: ['a', 'b', 'c'],
    });
    expect(orderedSavedTournaments(library).map((entry) => entry.name)).toEqual(['Newest', 'Middle', 'Older']);
  });
});

/* ------------------------------------------------------------------ */
/* The wizard <-> shelf round trip                                    */
/* ------------------------------------------------------------------ */

describe('the shelf and the wizard agree', () => {
  it('shelves exactly what the wizard holds and gives it back unchanged', () => {
    const draft = normaliseDraft({
      ...createDraft(),
      name: 'City Open 2026',
      format: 'radball',
      fieldNames: ['Hall', 'Side'],
      radballBulk: ['RV Nord I,Anna Weber,Ben Otto', '', 'RV Süd I,Cara Mert,Dana Wolf'],
      ageCategory: 'U15',
      reducedTime: true,
      minRestInput: '20',
      radballSetupMode: 'advanced',
      groupCount: 2,
      doubleLeg: true,
      rbFinalMode: 'ranking-matches',
      durationInput: '07:30',
      incrementsInput: '1,2',
      savedAt: 1,
    });
    expect(draft).not.toBeNull();
    const setup = draftToSetup(draft!);
    expect(setup.durationSec).toBe(450);
    expect(setup.scoringIncrements).toEqual([1, 2]);
    expect(setup.minRestMinutes).toBe(20);
    expect(setup.setupMode).toBe('advanced');
    expect(setup.finalMode).toBe('ranking-matches');

    const back = setupToDraft(setup, createDraft());
    expect({ ...back, version: undefined, step: undefined, savedAt: undefined }).toEqual({
      ...draft,
      version: undefined,
      step: undefined,
      savedAt: undefined,
    });
  });

  it('shelves an unreadable duration and increments box as the default, not as a failure', () => {
    const draft = normaliseDraft({ ...createDraft(), durationInput: 'later', incrementsInput: '', savedAt: 1 })!;
    const setup = draftToSetup(draft);
    expect(setup.durationSec).toBe(600);
    expect(setup.scoringIncrements).toEqual([1, 2, 3]);
  });

  it('keeps the host\'s own field names when a saved setup does not bring its own', () => {
    const base = normaliseDraft({ ...createDraft(), fieldNames: ['Gym', 'Annex'] })!;
    const setup = sanitiseSavedTournamentSetup({ fieldNames: ['Only'] });
    expect(setupToDraft(setup, base).fieldNames).toEqual(['Only']);
  });
});

/* ------------------------------------------------------------------ */
/* What the load list shows                                           */
/* ------------------------------------------------------------------ */

describe('the load list', () => {
  function entryWith(overrides: Partial<SavedTournamentSetup>, name = 'City Open') {
    return sanitiseSavedTournamentLibrary({
      entries: { s1: { name, setup: validSetup(overrides), createdAt: 1, updatedAt: 1 } },
      order: ['s1'],
    }).entries.s1;
  }

  it('says how many people and fields a setup has', () => {
    const facts = savedSetupFacts(entryWith({}), 1_700_000_000_000);
    expect(facts.format).toBe('Single elimination');
    expect(facts.roster).toBe('4 participants');
    expect(facts.fields).toBe(2);
    // A 10-person roster on two fields, not four: blank field tabs do not count.
    expect(savedSetupFacts(entryWith({ fieldBulk: ['a\nb\nc', 'd\ne', 'x', 'y'] })).roster).toBe('5 participants');
  });

  it('calls out the one rule that differs, and only that one', () => {
    expect(savedSetupFacts(entryWith({})).rule).toBe('seeded draw · bronze match');
    expect(savedSetupFacts(entryWith({ thirdPlace: false })).rule).toBe('seeded draw');
    expect(savedSetupFacts(entryWith({ seeded: false })).rule).toBe('random draw');
    expect(savedSetupFacts(entryWith({ drawMode: 'manual' })).rule).toBe('draw placed by hand');
    expect(
      savedSetupFacts(entryWith({ format: 'radball', radballBulk: ['a,x,y\nb,z,w\nc,p,q'] })).roster,
    ).toBe('3 teams');
    expect(savedSetupFacts(entryWith({ format: 'radball', radballBulk: ['a,x,y\nb,z,w\nc,p,q'] })).rule).toBe(
      'ELITE · one group',
    );
    expect(
      savedSetupFacts(
        entryWith({
          format: 'radball',
          setupMode: 'ten-team',
          radballBulk: [Array.from({ length: 10 }, (_, index) => `t${index},x${index},y${index}`).join('\n'), ''],
        }),
      ).rule,
    ).toBe('10-team World Cup');
  });

  it('describes when a setup was last touched in the host\'s own words', () => {
    const now = 1_700_000_000_000;
    const day = 86_400_000;
    const savedOn = (updatedAt: number) => ({ ...entryWith({}), updatedAt });
    expect(savedSetupFacts(savedOn(now), now).updated).toBe('saved today');
    expect(savedSetupFacts(savedOn(now - day), now).updated).toBe('saved yesterday');
    expect(savedSetupFacts(savedOn(now - 5 * day), now).updated).toBe('saved 5 days ago');
    expect(savedSetupFacts(savedOn(now - 60 * day), now).updated).toMatch(/^saved \d/);
    expect(savedSetupFacts(savedOn(0), now).updated).toBe('date unknown');
  });

  it('falls back to the event name when a shelf label is somehow blank', () => {
    expect(savedSetupLabel({ ...entryWith({}), name: '' })).toBe('City Open 2026');
  });

  it('is empty for a host who has never saved anything', () => {
    expect(savedSetups(null)).toEqual([]);
    expect(savedSetups(emptySavedTournamentLibrary())).toEqual([]);
  });
});

/** The draft Load builds internally before it creates anything. */
function draftFor(setup: SavedTournamentSetup) {
  return { version: 1 as const, ...setupToDraft(setup, createDraft()), step: 0, savedAt: 1 };
}
/* ------------------------------------------------------------------ */
/* The example that ships with the app                                */
/* ------------------------------------------------------------------ */

describe('the built-in Radball 10-team example', () => {
  const example = findExampleSetup('example:radball-10-team');
  const teams = mergeRoster(example!.setup.radballBulk, parseRadballTeams);

  it('is offered to every host, not filed on the shelf', () => {
    expect(example).not.toBeNull();
    expect(EXAMPLE_SETUPS.length).toBeGreaterThan(0);
    expect(findExampleSetup('nope')).toBeNull();
    // It is a plain setup, not a shelf entry: nothing to rename or delete.
    expect(Object.keys(example!)).toEqual(['id', 'name', 'description', 'setup']);
  });

  it('is a Radball 10-team setup on exactly two playing fields', () => {
    const setup = example!.setup;
    expect(setup.format).toBe('radball');
    expect(setup.setupMode).toBe('ten-team');
    // The 10-team format pins Group A to field 1 and Group B to field 2.
    expect(setup.fieldNames).toHaveLength(2);
    expect(setup.radballBulk).toHaveLength(2);
  });

  it('carries ten 2er teams, five per field, with two riders each', () => {
    expect(teams).toHaveLength(10);
    expect(new Set(teams.map((team) => team.name)).size).toBe(10);
    expect(teams.filter((team) => team.fieldId === '1')).toHaveLength(5);
    expect(teams.filter((team) => team.fieldId === '2')).toHaveLength(5);
    for (const team of teams) {
      expect(team.players[0]).toBeTruthy();
      expect(team.players[1]).toBeTruthy();
    }
    // No duplicate squad, player or half-filled row, so the roster step is clean.
    expect(rosterIssues(teams, example!.setup.fieldNames)).toEqual([]);
  });

  it('splits the groups by home field, because the field is the group', () => {
    // Nothing is stated twice: the five teams entered on Field 1 are Group A and
    // the five on Field 2 are Group B.
    const groupA = teams.filter((team) => team.fieldId === '1');
    const groupB = teams.filter((team) => team.fieldId === '2');
    expect(groupA.map((team) => team.name)).toEqual(['Team A', 'Team B', 'Team C', 'Team D', 'Team E']);
    expect(groupB.map((team) => team.name)).toEqual(['Team F', 'Team G', 'Team H', 'Team I', 'Team J']);
  });

  it('survives the server\'s own normalisation unchanged', () => {
    const clean = sanitiseSavedTournamentSetup(example!.setup);
    expect(clean).toEqual(example!.setup);
  });

  it('passes the same check as a filed setup, so loading it can create a tournament', () => {
    const s = state();
    const entry = saveTournamentSetup(s, { name: example!.name, setup: example!.setup }, ctx(), createMutation());
    expect(entry.setup.radballBulk).toHaveLength(2);
  });

  it('loads into the wizard with both rosters in place', () => {
    const draft = setupToDraft(example!.setup, createDraft());
    expect(draft.format).toBe('radball');
    expect(draft.radballSetupMode).toBe('ten-team');
    expect(draft.radballBulk.slice(0, 2)).toEqual(example!.setup.radballBulk);
    expect(draft.fieldNames).toEqual(['Field 1', 'Field 2']);
    expect(draft.name).toBe('Radball World Cup \u2014 10 teams');
  });

  /**
   * The contract the one-click Load mechanic rests on: a setup must produce a
   * create payload the server accepts, with no wizard steps walked in between.
   *
   * Checked against the real command validator rather than a payload shape, so a
   * rule that tightened would fail here instead of on a host's screen.
   */
  it('creates a tournament from the example without walking a single step', () => {
    const effective = buildEffectiveSetup(draftFor(example!.setup));
    if (!('payload' in effective)) {
      throw new Error(`example would not create: ${effective.error} (step ${effective.step})`);
    }
    expect(effective.payload.name).toBe('Radball World Cup \u2014 10 teams');
    expect(effective.payload.format).toBe('radball');
    expect(effective.payload.participants).toHaveLength(10);
    expect(effective.trimmedFields).toHaveLength(2);

    const verdict = COMMANDS['tournament.create'].validate({
      ...effective.payload,
      settings: effective.settings,
      confirmReplace: false,
      expectedTournamentId: null,
    });
    expect(verdict.ok, 'the server must accept a loaded setup').toBe(true);

    // The split travels as the home fields themselves: Group A is the five
    // field-1 teams, Group B the five on field 2, and nothing else says so.
    expect(effective.payload.participants.slice(0, 5).every((p) => p.fieldId === '1')).toBe(true);
    expect(effective.payload.participants.slice(5).every((p) => p.fieldId === '2')).toBe(true);
    expect(effective.payload.radball).not.toHaveProperty('manualGroupOrder');
  });

  it('falls back to the wizard with a reason when a setup can no longer create', () => {
    // What Load does when validation fails: a step and a sentence, not a crash.
    const broken = sanitiseSavedTournamentSetup({
      ...example!.setup,
      radballBulk: ['Team A,Anna,Ben'],
      setupMode: 'ten-team',
    });
    const effective = buildEffectiveSetup(draftFor(broken));
    expect('payload' in effective).toBe(false);
    if ('payload' in effective) return;
    expect(typeof effective.error).toBe('string');
    expect(effective.error.length).toBeGreaterThan(0);
    // The host lands on a real step they can act on.
    expect(effective.step).toBeGreaterThanOrEqual(0);
    expect(effective.step).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

describe('the shelf survives a restart', () => {
  it('comes back from disk, and travels with a backup and a restore', async () => {
    const { store, dispose } = await createTestStore('saved-setup');
    try {
      store.apply((s, c, m) => {
        saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, c, m);
      }, adminCtx(store));
      await store.flush();

      const reopened = await TournamentStore.open(store.dataDir);
      try {
        expect(orderedSavedTournaments(reopened.state.savedTournaments).map((e) => e.name)).toEqual(['City Open']);
      } finally {
        await reopened.adapter.close();
      }

      const backup = store.createBackup();
      expect(Object.keys(backup.state.savedTournaments.entries)).toHaveLength(1);
      const parsed = TournamentStore.parseBackup(JSON.parse(JSON.stringify(backup)));
      expect(orderedSavedTournaments(parsed.savedTournaments).map((e) => e.name)).toEqual(['City Open']);
    } finally {
      await dispose();
    }
  });

  it('broadcasts the shelf so every screen agrees without a reload', async () => {
    const { store, dispose } = await createTestStore('saved-delta');
    try {
      const seen: boolean[] = [];
      const off = store.subscribe((delta) => seen.push(delta.savedTournaments !== undefined));
      store.apply((s, c, m) => {
        saveTournamentSetup(s, { name: 'City Open', setup: validSetup() }, c, m);
      }, adminCtx(store));
      off();
      expect(seen).toEqual([true]);
    } finally {
      await dispose();
    }
  });
});