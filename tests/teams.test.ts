import { describe, expect, it, afterEach } from 'vitest';
import { COMMANDS, type LibraryTeamInput } from '../src/shared/commands';
import { RADBALL_AGE_CATEGORIES, type RadballAgeCategory } from '../src/shared/types';
import { EngineError } from '../src/backend/util/errors';
import { createTournament } from '../src/backend/tournament/engine';
import {
  MAX_LIBRARY_TEAMS,
  addLibraryTeam,
  importLibraryTeams,
  populatedAgeCategories,
  removeLibraryTeam,
  reorderLibraryTeams,
  sanitiseTeamLibrary,
  updateLibraryTeam,
  type LibraryTeamInput as EngineTeamInput,
} from '../src/backend/tournament/teams';
import {
  ageGroupCounts,
  ageGroupLabel,
  libraryIssueSummary,
  libraryParticipantLines,
  libraryRosterLines,
  libraryTeamIssues,
  libraryTeams,
  parseLibraryTeams,
  teamsInAgeGroup,
} from '../src/frontend/lib/teams';
import { parseParticipants, parseRadballTeams } from '../src/frontend/pages/SetupPage';
import { adminCtx, createTestStore, run, type TestStore } from './helpers';

const openStores: TestStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) await openStores.pop()?.dispose();
});

async function makeStore(label: string): Promise<TestStore> {
  const harness = await createTestStore(label);
  openStores.push(harness);
  return harness;
}

function squad(name: string, age: RadballAgeCategory = 'U15', club: string | null = null): EngineTeamInput {
  return {
    name,
    club,
    players: [`${name} A`, `${name} B`],
    ageCategory: age,
  };
}

function add(harness: TestStore, name: string, age: RadballAgeCategory = 'U15', club: string | null = null): string {
  const ctx = adminCtx(harness.store);
  let id = '';
  run(harness.store, ctx, (state, c, mut) => {
    id = addLibraryTeam(state, squad(name, age, club), c, mut).id;
  });
  return id;
}

describe('team library engine', () => {
  it('files a team under an age group and keeps the host order', async () => {
    const harness = await makeStore('library');
    add(harness, 'RV Nord I', 'U15');
    add(harness, 'RV Sued I', 'U19');
    add(harness, 'RV Ost I', 'U15');

    expect(libraryTeams(harness.store.state.teamLibrary).map((t) => t.name)).toEqual([
      'RV Nord I',
      'RV Sued I',
      'RV Ost I',
    ]);
    expect(teamsInAgeGroup(harness.store.state.teamLibrary, 'U15').map((t) => t.name)).toEqual([
      'RV Nord I',
      'RV Ost I',
    ]);
    expect(teamsInAgeGroup(harness.store.state.teamLibrary, 'U19')).toHaveLength(1);
  });

  it('records the club, the two players and both timestamps', async () => {
    const harness = await makeStore('library');
    const id = add(harness, 'RV West I', 'U13', 'RV West');
    const entry = harness.store.state.teamLibrary.teams[id];
    expect(entry.club).toBe('RV West');
    expect(entry.players).toEqual(['RV West I A', 'RV West I B']);
    expect(entry.createdAt).toBe(entry.updatedAt);
  });

  it('rejects a duplicate team name regardless of case or age group', async () => {
    const harness = await makeStore('library');
    add(harness, 'RV Nord I', 'U15');
    const ctx = adminCtx(harness.store);
    expect(() =>
      run(harness.store, ctx, (state, c, mut) => {
        addLibraryTeam(state, squad('rv nord i', 'U17'), c, mut);
      }),
    ).toThrow(/already holds/i);
    // Nothing was filed.
    expect(libraryTeams(harness.store.state.teamLibrary)).toHaveLength(1);
  });

  it('rejects a squad that is not two different people', async () => {
    const harness = await makeStore('library');
    const ctx = adminCtx(harness.store);
    const bad: EngineTeamInput[] = [
      { name: 'Blank', club: null, players: ['', 'B'], ageCategory: 'U15' },
      { name: 'Same', club: null, players: ['Alex', 'alex'], ageCategory: 'U15' },
      { name: '', club: null, players: ['A', 'B'], ageCategory: 'U15' },
      { name: 'Long', club: null, players: ['A'.repeat(61), 'B'], ageCategory: 'U15' },
    ];
    for (const input of bad) {
      expect(() =>
        run(harness.store, ctx, (state, c, mut) => {
          addLibraryTeam(state, input, c, mut);
        }),
      ).toThrow(EngineError);
    }
    expect(libraryTeams(harness.store.state.teamLibrary)).toHaveLength(0);
  });

  it('re-files a team into another age group without touching the rest', async () => {
    const harness = await makeStore('library');
    const id = add(harness, 'RV Nord I', 'U15');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, c, mut) => {
      updateLibraryTeam(state, id, { ageCategory: 'U19' }, c, mut);
    });
    const entry = harness.store.state.teamLibrary.teams[id];
    expect(entry.ageCategory).toBe('U19');
    expect(entry.name).toBe('RV Nord I');
    expect(teamsInAgeGroup(harness.store.state.teamLibrary, 'U15')).toHaveLength(0);
    expect(teamsInAgeGroup(harness.store.state.teamLibrary, 'U19')).toHaveLength(1);
  });

  it('lets a team keep its own name while editing, but not collide with another', async () => {
    const harness = await makeStore('library');
    const first = add(harness, 'RV Nord I');
    const second = add(harness, 'RV Sued I');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, c, mut) => {
      updateLibraryTeam(state, first, { name: 'RV Nord I', players: ['Anna', 'Ben'] }, c, mut);
    });
    expect(harness.store.state.teamLibrary.teams[first].players).toEqual(['Anna', 'Ben']);
    expect(() =>
      run(harness.store, ctx, (state, c, mut) => {
        updateLibraryTeam(state, second, { name: 'RV Nord I' }, c, mut);
      }),
    ).toThrow(/already holds/i);
  });

  it('refuses to edit a team that is no longer on file', async () => {
    const harness = await makeStore('library');
    const ctx = adminCtx(harness.store);
    expect(() =>
      run(harness.store, ctx, (state, c, mut) => {
        updateLibraryTeam(state, 'nope', { name: 'Ghost' }, c, mut);
      }),
    ).toThrow(/no longer in the library/i);
  });

  it('removes a team from the roster and the order', async () => {
    const harness = await makeStore('library');
    const keep = add(harness, 'RV Nord I');
    const drop = add(harness, 'RV Sued I');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, _c, mut) => {
      removeLibraryTeam(state, drop, mut);
    });
    const library = harness.store.state.teamLibrary;
    expect(library.teams[drop]).toBeUndefined();
    expect(library.order).toEqual([keep]);
  });

  it('reorders the library and keeps teams the host did not send', async () => {
    const harness = await makeStore('library');
    const a = add(harness, 'A');
    const b = add(harness, 'B');
    const c = add(harness, 'C');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, _c, mut) => {
      reorderLibraryTeams(state, [c, a], mut);
    });
    // 'b' was not in the list and keeps its relative place at the end.
    expect(harness.store.state.teamLibrary.order).toEqual([c, a, b]);
  });

  it('appends an import and skips the rows that clash', async () => {
    const harness = await makeStore('library');
    add(harness, 'RV Nord I', 'U15');
    const ctx = adminCtx(harness.store);
    let outcome = { added: 0, skipped: [] as string[] };
    run(harness.store, ctx, (state, c, mut) => {
      outcome = importLibraryTeams(
        state,
        [squad('RV Nord I', 'U15'), squad('RV Sued I', 'U15'), squad('', 'U15')],
        'append',
        c,
        mut,
      );
    });
    expect(outcome.added).toBe(1);
    expect(outcome.skipped).toHaveLength(2);
    expect(libraryTeams(harness.store.state.teamLibrary).map((t) => t.name)).toEqual(['RV Nord I', 'RV Sued I']);
  });

  it('replaces the whole library on request', async () => {
    const harness = await makeStore('library');
    add(harness, 'Old I');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, c, mut) => {
      importLibraryTeams(state, [squad('New I'), squad('New II')], 'replace', c, mut);
    });
    expect(libraryTeams(harness.store.state.teamLibrary).map((t) => t.name)).toEqual(['New I', 'New II']);
  });

  it('stops importing at the library ceiling and says so', async () => {
    const harness = await makeStore('library');
    const ctx = adminCtx(harness.store);
    const rows = Array.from({ length: MAX_LIBRARY_TEAMS + 5 }, (_, index) => squad(`Team ${index}`));
    let outcome = { added: 0, skipped: [] as string[] };
    run(harness.store, ctx, (state, c, mut) => {
      outcome = importLibraryTeams(state, rows, 'append', c, mut);
    });
    expect(outcome.added).toBe(MAX_LIBRARY_TEAMS);
    expect(outcome.skipped).toHaveLength(1);
    expect(harness.store.state.teamLibrary.order).toHaveLength(MAX_LIBRARY_TEAMS);
  });

  it('refuses to grow past the ceiling one team at a time', async () => {
    const harness = await makeStore('library');
    const ctx = adminCtx(harness.store);
    run(harness.store, ctx, (state, c, mut) => {
      for (let index = 0; index < MAX_LIBRARY_TEAMS; index += 1) addLibraryTeam(state, squad(`T${index}`), c, mut);
    });
    expect(() =>
      run(harness.store, ctx, (state, c, mut) => {
        addLibraryTeam(state, squad('One too many'), c, mut);
      }),
    ).toThrow(/at most/i);
  });

  it('broadcasts the whole library slice on every change', async () => {
    const harness = await makeStore('library');
    const deltas: unknown[] = [];
    harness.store.subscribe((delta) => deltas.push(delta));
    add(harness, 'RV Nord I');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { teamLibrary?: unknown }).teamLibrary).toEqual(harness.store.state.teamLibrary);
  });

  it('marks the library dirty so the change is written straight away', async () => {
    const harness = await makeStore('library');
    const ctx = adminCtx(harness.store);
    const mut = run(harness.store, ctx, (state, c, m) => {
      addLibraryTeam(state, squad('RV Nord I'), c, m);
    });
    expect(mut.teamLibrary).toBe(true);
    expect(mut.urgency).toBe('immediate');
  });
});

describe('team library persistence', () => {
  it('survives creating a tournament, which clears every other slice', async () => {
    const harness = await makeStore('library-survive');
    add(harness, 'RV Nord I', 'U15');
    add(harness, 'RV Sued I', 'U19');
    const ctx = adminCtx(harness.store);

    run(harness.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Saturday Cup',
          format: 'radball',
          participants: [
            { name: 'A', team: null, seed: null, checkedIn: true, fieldId: '1', players: ['A1', 'A2'] },
            { name: 'B', team: null, seed: null, checkedIn: true, fieldId: '1', players: ['B1', 'B2'] },
            { name: 'C', team: null, seed: null, checkedIn: true, fieldId: '1', players: ['C1', 'C2'] },
          ],
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          radball: { ageCategory: 'U15' },
        },
        c,
        mut,
      );
    });

    // The live tournament was rebuilt from scratch...
    expect(harness.store.state.tournament?.name).toBe('Saturday Cup');
    // ...but the host's own address book is untouched.
    expect(libraryTeams(harness.store.state.teamLibrary).map((t) => t.name)).toEqual(['RV Nord I', 'RV Sued I']);
  });

  it('comes back after a restart', async () => {
    const harness = await makeStore('library-restart');
    add(harness, 'RV Nord I', 'U15', 'RV Nord');
    await harness.store.flush();
    await harness.store.adapter.close();

    const { TournamentStore } = await import('../src/backend/store/store');
    const reopened = await TournamentStore.open(harness.dir);
    const entry = libraryTeams(reopened.state.teamLibrary)[0];
    expect(entry.name).toBe('RV Nord I');
    expect(entry.club).toBe('RV Nord');
    expect(entry.ageCategory).toBe('U15');
    expect(entry.players).toEqual(['RV Nord I A', 'RV Nord I B']);
    await reopened.adapter.close();
  });

  it('loads a snapshot written before the library existed', () => {
    const library = sanitiseTeamLibrary(undefined);
    expect(library).toEqual({ teams: {}, order: [] });
  });

  it('drops malformed rows instead of refusing to start', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        good: { id: 'good', name: 'RV Nord I', club: null, players: ['A', 'B'], ageCategory: 'U15' },
        noPair: { id: 'noPair', name: 'RV Sued I', players: ['A'], ageCategory: 'U15' },
        blank: { id: 'blank', name: '  ', players: ['A', 'B'], ageCategory: 'U15' },
        oddAge: { id: 'oddAge', name: 'RV Ost I', players: ['A', 'B'], ageCategory: 'U99' },
        notAnObject: 'nonsense',
      },
      order: ['good', 'noPair', 'missing'],
    });
    expect(Object.keys(library.teams).sort()).toEqual(['good', 'oddAge']);
    // An unknown age group falls back to a real one rather than breaking the UI.
    expect(library.teams.oddAge.ageCategory).toBe('ELITE');
    // The order keeps only ids that still exist, then appends the rest.
    expect(library.order).toEqual(['good', 'oddAge']);
  });

  it('keeps one entry per team name when a file has a duplicate', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        first: { id: 'first', name: 'RV Nord I', players: ['A', 'B'], ageCategory: 'U15' },
        second: { id: 'second', name: 'rv nord i', players: ['C', 'D'], ageCategory: 'U15' },
      },
    });
    expect(Object.keys(library.teams)).toEqual(['first']);
  });
});

describe('team library view helpers', () => {
  it('counts teams per tab for the rail', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        a: { id: 'a', name: 'A', players: ['a1', 'a2'], ageCategory: 'U15' },
        b: { id: 'b', name: 'B', players: ['b1', 'b2'], ageCategory: 'U15' },
        c: { id: 'c', name: 'C', players: ['c1', 'c2'], ageCategory: 'U19' },
      },
    });
    const counts = ageGroupCounts(library);
    expect(counts.all).toBe(3);
    expect(counts.U15).toBe(2);
    expect(counts.U19).toBe(1);
    expect(counts.U11).toBe(0);
    expect(populatedAgeCategories(library)).toEqual(['U15', 'U19']);
  });

  it('labels every age group, including the open one', () => {
    for (const age of RADBALL_AGE_CATEGORIES) {
      expect(ageGroupLabel(age).length).toBeGreaterThan(2);
    }
    expect(ageGroupLabel('ELITE')).toMatch(/no age limit/i);
    expect(ageGroupLabel('U13')).toMatch(/under 13/i);
  });
});

describe('team library bulk parsing', () => {
  it('reads the three column form', () => {
    const parsed = parseLibraryTeams('RV Nord I,Anna,Ben', 'U15');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: 'RV Nord I', club: null, players: ['Anna', 'Ben'], ageCategory: 'U15' });
  });

  it('reads the four column form with a club', () => {
    const [team] = parseLibraryTeams('RV Nord I,RV Nord,Anna,Ben', 'U15');
    expect(team.club).toBe('RV Nord');
    expect(team.players).toEqual(['Anna', 'Ben']);
  });

  it('reads a trailing age group and falls back to the active tab', () => {
    const parsed = parseLibraryTeams('RV Nord I,RV Nord,Anna,Ben,U19\nRV Sued I,RV Sued,Cal,Dan', 'U15');
    expect(parsed[0].ageCategory).toBe('U19');
    expect(parsed[1].ageCategory).toBe('U15');
  });

  it('accepts U-13 and a bare 13 for the age column', () => {
    const parsed = parseLibraryTeams('A,x,P1,P2,u-13\nB,x,P3,P4,13', 'U15');
    expect(parsed[0].ageCategory).toBe('U13');
    expect(parsed[1].ageCategory).toBe('U13');
  });

  it('falls back to the default group for an unreadable age column or none at all', () => {
    // Five columns, the last one unreadable: the row is still read as a squad.
    const unreadable = parseLibraryTeams('C,x,P5,P6,99', 'U15');
    expect(unreadable[0]).toMatchObject({ name: 'C', club: 'x', players: ['P5', 'P6'], ageCategory: 'U15' });
    // No fallback supplied at all: the parser still files under a real group.
    expect(parseLibraryTeams('D,x,P7,P8')[0].ageCategory).toBe('ELITE');
  });

  it('ignores a header row but keeps a squad that happens to be called U13', () => {
    const parsed = parseLibraryTeams('team,club,player 1,player 2,age group\nU13,RV Nord,Anna,Ben,U13');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('U13');
  });

  it('skips blank lines and handles semicolon separated sheets', () => {
    const parsed = parseLibraryTeams('\nRV Nord I;Anna;Ben\n\nRV Sued I;Cal;Dan\n', 'U15');
    expect(parsed.map((t) => t.name)).toEqual(['RV Nord I', 'RV Sued I']);
  });

  it('flags a missing player, a doubled player and a repeated name', () => {
    const issues = libraryTeamIssues(
      parseLibraryTeams('RV Nord I,Anna,\nRV Sued I,Cal,Cal\nRV Nord I,Dan,Eve', 'U15'),
    );
    const messages = issues.map((issue) => issue.message).join(' | ');
    expect(messages).toMatch(/both player names/i);
    expect(messages).toMatch(/different people/i);
    expect(messages).toMatch(/one entry per team name/i);
    expect(libraryIssueSummary(issues)).toMatch(/^Line \d+:/);
  });

  it('reports no issues for a clean list', () => {
    expect(libraryTeamIssues(parseLibraryTeams('A,Anna,Ben\nB,Cal,Dan', 'U15'))).toEqual([]);
    expect(libraryIssueSummary([])).toBe('');
  });
});

describe('library teams into a tournament roster', () => {
  it('writes lines the setup roster parser reads back unchanged', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        withClub: { id: 'withClub', name: 'RV Nord I', club: 'RV Nord', players: ['Anna', 'Ben'], ageCategory: 'U15' },
        noClub: { id: 'noClub', name: 'RV Sued I', players: ['Cal', 'Dan'], ageCategory: 'U15' },
      },
      order: ['withClub', 'noClub'],
    });
    const text = libraryRosterLines(libraryTeams(library)).join('\n');
    const parsed = parseRadballTeams(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: 'RV Nord I', club: 'RV Nord', players: ['Anna', 'Ben'] });
    expect(parsed[1]).toMatchObject({ name: 'RV Sued I', club: null, players: ['Cal', 'Dan'] });
  });

  it('carries a crest through the roster text and back', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        crest: {
          id: 'crest',
          name: 'RV Nord I',
          club: 'RV Nord',
          players: ['Anna', 'Ben'],
          ageCategory: 'U15',
          logo: 'nord.png',
        },
        plain: { id: 'plain', name: 'RV Sued I', players: ['Cal', 'Dan'], ageCategory: 'U15' },
      },
      order: ['crest', 'plain'],
    });
    const parsed = parseRadballTeams(libraryRosterLines(libraryTeams(library)).join('\n'));
    // The crest has to survive this round trip, because this text is the
    // roster: it is what the wizard draft holds, what a saved setup stores and
    // what tournament create is built from.
    expect(parsed[0]).toMatchObject({ name: 'RV Nord I', logo: 'nord.png' });
    // A squad with no crest of its own writes no fifth column at all, so a
    // hand-typed roster and an old saved setup keep parsing as before.
    expect(parsed[1]).toMatchObject({ name: 'RV Sued I', logo: null });
  });

  it('reads a crest from a roster line but never from a column it cannot own', () => {
    // The three-column form is the historical one and carries no crest.
    expect(parseRadballTeams('RV Nord I,Anna,Ben')).toMatchObject([{ name: 'RV Nord I', logo: null }]);
    // Five columns, empty last: the default crest, not an empty file name.
    expect(parseRadballTeams('RV Nord I,RV Nord,Anna,Ben,')).toMatchObject([{ logo: null }]);
    expect(parseRadballTeams('RV Nord I,RV Nord,Anna,Ben,nord.png')).toMatchObject([{ logo: 'nord.png' }]);
  });

  it('quotes a name that would otherwise break the column split', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        a: { id: 'a', name: 'Gärt, Max', club: null, players: ['Mu,ster', 'Muster;land'], ageCategory: 'U15' },
      },
    });
    const [parsed] = parseRadballTeams(libraryRosterLines(libraryTeams(library)).join('\n'));
    expect(parsed.name).toBe('Gärt, Max');
    expect(parsed.players).toEqual(['Mu,ster', 'Muster;land']);
  });

  it('writes participant lines for a generic roster, club in the team column', () => {
    // A knockout or a manual schedule reads `name, team`: the squad name is the
    // participant and the affiliation is all a generic roster has for it.
    const library = sanitiseTeamLibrary({
      teams: {
        withClub: { id: 'withClub', name: 'Alpha Crew', club: 'AC Nord', players: ['Anna', 'Ben'], ageCategory: 'U15' },
        noClub: { id: 'noClub', name: 'Beta Crew', players: ['Cal', 'Dan'], ageCategory: 'U15' },
      },
      order: ['withClub', 'noClub'],
    });
    const text = libraryParticipantLines(libraryTeams(library)).join('\n');
    expect(parseParticipants(text)).toMatchObject([
      { name: 'Alpha Crew', team: 'AC Nord', seed: null },
      { name: 'Beta Crew', team: null, seed: null },
    ]);
  });

  it('carries a crest through the participant roster text and back', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        crest: {
          id: 'crest',
          name: 'Alpha Crew',
          club: 'AC Nord',
          players: ['Anna', 'Ben'],
          ageCategory: 'U15',
          logo: 'nord.png',
        },
      },
    });
    const [parsed] = parseParticipants(libraryParticipantLines(libraryTeams(library)).join('\n'));
    // Same reason the Radball form carries one: this text *is* the roster.
    expect(parsed).toMatchObject({ name: 'Alpha Crew', team: 'AC Nord', logo: 'nord.png' });
  });

  it('leaves a hand-typed participant roster exactly as it was', () => {
    // The two- and three-column forms predate the crest column and must not grow
    // one, or an old saved setup would change meaning.
    expect(parseParticipants('Alpha,AC Nord')).toMatchObject([{ name: 'Alpha', team: 'AC Nord', logo: null }]);
    expect(parseParticipants('Alpha')).toMatchObject([{ name: 'Alpha', team: null, logo: null }]);
    expect(parseParticipants('Alpha,AC Nord,3')).toMatchObject([{ name: 'Alpha', team: 'AC Nord', seed: 3, logo: null }]);
    // A crest is only ever read from the last column, and only when it is a real
    // file name -- never from a team or a seed.
    expect(parseParticipants('Alpha,AC Nord,3,nord.png')).toMatchObject([{ logo: 'nord.png', seed: 3 }]);
    expect(parseParticipants('Alpha,AC Nord,3,')).toMatchObject([{ logo: null, seed: 3 }]);
    expect(parseParticipants('Alpha,AC Nord,3,../../access.json')).toMatchObject([{ logo: null }]);
  });
});

describe('team library commands', () => {
  it('only lets the host change the library', () => {
    for (const name of ['team.add', 'team.update', 'team.remove', 'team.reorder', 'team.import'] as const) {
      expect(COMMANDS[name].permission).toBe('admin');
      expect(COMMANDS[name].fieldScoped).toBe(false);
    }
  });

  it('validates a new team payload', () => {
    const good: LibraryTeamInput = {
      name: 'RV Nord I',
      club: null,
      players: ['Anna', 'Ben'],
      ageCategory: 'U15',
      logo: null,
    };
    expect(COMMANDS['team.add'].validate(good)).toEqual({ ok: true, value: good });

    expect(COMMANDS['team.add'].validate({ ...good, name: '' }).ok).toBe(false);
    expect(COMMANDS['team.add'].validate({ ...good, players: ['Anna'] }).ok).toBe(false);
    expect(COMMANDS['team.add'].validate({ ...good, players: ['Anna', 'anna'] }).ok).toBe(false);
    expect(COMMANDS['team.add'].validate({ ...good, ageCategory: 'U99' }).ok).toBe(false);
    expect(COMMANDS['team.add'].validate({ ...good, ageCategory: undefined }).ok).toBe(false);
  });

  it('trims the payload on the way in', () => {
    const result = COMMANDS['team.add'].validate({
      name: '  RV Nord I  ',
      club: '   ',
      players: [' Anna ', 'Ben'],
      ageCategory: 'U15',
    });
    expect(result).toEqual({
      ok: true,
      value: { name: 'RV Nord I', club: null, players: ['Anna', 'Ben'], ageCategory: 'U15', logo: null },
    });
  });

  it('requires an id and a whole squad on update', () => {
    const team = { name: 'RV Nord I', club: null, players: ['Anna', 'Ben'], ageCategory: 'U15' };
    expect(COMMANDS['team.update'].validate({ id: 'abc', team }).ok).toBe(true);
    expect(COMMANDS['team.update'].validate({ team }).ok).toBe(false);
    expect(COMMANDS['team.update'].validate({ id: 'abc' }).ok).toBe(false);
    expect(COMMANDS['team.update'].validate({ id: 'abc', team: { ...team, players: ['Anna'] } }).ok).toBe(false);
  });

  it('validates removal, reorder and import', () => {
    expect(COMMANDS['team.remove'].validate({ id: 'abc' })).toEqual({ ok: true, value: { id: 'abc' } });
    expect(COMMANDS['team.remove'].validate({})).toEqual({ ok: false, error: 'id is required' });
    expect(COMMANDS['team.reorder'].validate({ ids: ['a', 'b'] }).ok).toBe(true);
    expect(COMMANDS['team.reorder'].validate({ ids: ['a', 'a'] }).ok).toBe(false);
    expect(COMMANDS['team.reorder'].validate({ ids: 'a' }).ok).toBe(false);
    expect(COMMANDS['team.import'].validate({ teams: [] }).ok).toBe(false);
    expect(
      COMMANDS['team.import'].validate({
        teams: [{ name: 'A', club: null, players: ['a1', 'a2'], ageCategory: 'U15' }],
        mode: 'replace',
      }),
    ).toEqual({
      ok: true,
      value: {
        mode: 'replace',
        teams: [{ name: 'A', club: null, players: ['a1', 'a2'], ageCategory: 'U15', logo: null }],
      },
    });
  });

  it('takes a crest as a bare file name and refuses anything path-like', () => {
    const base = { name: 'RV Nord I', club: null, players: ['Anna', 'Ben'], ageCategory: 'U15' };
    // A logo is a name in the host's own folder, never a path: the logo route
    // serves whatever it can read, so a stored traversal would be a stored
    // read of the host's access token.
    for (const logo of ['../access.json', 'sub/dir.png', '..', '.', 'C:\\windows\\win.ini', '/etc/passwd']) {
      const result = COMMANDS['team.add'].validate({ ...base, logo });
      expect(result, `logo ${logo} must not be accepted`).toEqual({ ok: true, value: { ...base, logo: null } });
    }
    // An extension the logo route will not serve is refused at the door rather
    // than becoming a broken image on the projector.
    expect(COMMANDS['team.add'].validate({ ...base, logo: 'crest.exe' })).toEqual({
      ok: true,
      value: { ...base, logo: null },
    });
    expect(COMMANDS['team.add'].validate({ ...base, logo: 'nord.png' })).toEqual({
      ok: true,
      value: { ...base, logo: 'nord.png' },
    });
    expect(COMMANDS['team.add'].validate({ ...base, logo: '  nord.SVG  ' })).toEqual({
      ok: true,
      value: { ...base, logo: 'nord.SVG' },
    });
  });
});
