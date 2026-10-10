import { describe, expect, it } from 'vitest';
import { dealKeysIntoPairs, reconcileSlots, shuffleKeys } from '../src/frontend/lib/draw';
import {
  exampleRosterFill,
  normaliseDraft,
  parseParticipants,
  parseRadballTeams,
  rosterIssues,
} from '../src/frontend/pages/SetupPage';

function empty(size: number): (string | null)[] {
  return Array.from({ length: size }, () => null);
}

function matchOf(slots: (string | null)[], slot: number): string {
  const pair = Math.floor(slot / 2) * 2;
  return [slots[pair] ?? '-', slots[pair + 1] ?? '-'].sort().join(' vs ');
}

describe('dealKeysIntoPairs', () => {
  it('deals two even rosters into separate matches', () => {
    let slots = empty(8);
    slots = dealKeysIntoPairs(slots, ['A1', 'A2', 'A3', 'A4']);
    slots = dealKeysIntoPairs(slots, ['B1', 'B2', 'B3', 'B4']);
    expect(slots.slice(0, 4).every((key) => key?.startsWith('A'))).toBe(true);
    expect(slots.slice(4).every((key) => key?.startsWith('B'))).toBe(true);
  });

  it('keeps uneven rosters apart with byes instead of sharing matches', () => {
    let slots = empty(8);
    slots = dealKeysIntoPairs(slots, ['A1', 'A2', 'A3']);
    slots = dealKeysIntoPairs(slots, ['B1', 'B2', 'B3']);
    // Match 2 must be A3 vs bye, match 4 B3 vs bye — never A vs B.
    expect(matchOf(slots, 2)).toBe('- vs A3');
    expect(matchOf(slots, 6)).toBe('- vs B3');
    expect(slots.filter(Boolean)).toHaveLength(6);
  });

  it('re-dealing a field keeps its block and never touches others', () => {
    let slots = empty(8);
    slots = dealKeysIntoPairs(slots, ['A1', 'A2', 'A3', 'A4']);
    slots = dealKeysIntoPairs(slots, ['B1', 'B2', 'B3', 'B4']);
    const before = [...slots];
    slots = dealKeysIntoPairs(slots, shuffleKeys(['A1', 'A2', 'A3', 'A4']));
    expect(slots.slice(4)).toEqual(before.slice(4));
    expect([...slots.slice(0, 4)].sort()).toEqual(['A1', 'A2', 'A3', 'A4']);
  });

  it('places only into empty slots when filling a partial roster', () => {
    // A1 already placed manually in slot 7; the rest must not move it.
    let slots: (string | null)[] = [null, null, null, null, null, null, null, 'A1'];
    slots = dealKeysIntoPairs(slots, ['A2', 'A3']);
    expect(slots[7]).toBe('A1');
    expect(slots.slice(0, 2)).toEqual(['A2', 'A3']);
  });

  it('never duplicates or loses keys', () => {
    const slots = dealKeysIntoPairs(['X1', null, 'Y1', null, null, null, null, null], ['X1', 'X2', 'X3']);
    const placed = slots.filter((key): key is string => key !== null);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toContain('Y1');
    expect(['X1', 'X2', 'X3'].every((key) => placed.includes(key))).toBe(true);
  });
});

describe('reconcileSlots', () => {
  it('keeps valid placements untouched', () => {
    const previous = ['A', null, 'B', null];
    expect(reconcileSlots(previous, 4, new Set(['A', 'B']))).toEqual(previous);
  });

  it('drops placements whose participant was renamed or removed', () => {
    // "A" was renamed to "A2" with the same head count: the stale key must
    // become a bye instead of rendering a phantom name in the picker.
    expect(reconcileSlots(['A', null, 'B', null], 4, new Set(['A2', 'B']))).toEqual([
      null,
      null,
      'B',
      null,
    ]);
  });

  it('resizes while preserving what still exists', () => {
    expect(reconcileSlots(['A', 'B'], 4, new Set(['A', 'B', 'C']))).toEqual(['A', 'B', null, null]);
    expect(reconcileSlots(['A', 'B', 'C', 'D'], 2, new Set(['A', 'B']))).toEqual(['A', 'B']);
  });
});

describe('shuffleKeys', () => {
  it('returns a permutation without mutating the input', () => {
    const input = ['A', 'B', 'C', 'D'];
    const out = shuffleKeys(input);
    expect(input).toEqual(['A', 'B', 'C', 'D']);
    expect([...out].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('setup roster parsing', () => {
  it('keeps duplicate and overlong Radball rows visible for validation', () => {
    const longName = 'T'.repeat(65);
    const rows = parseRadballTeams(`\uFEFFteam name,player 1,player 2\nAlpha,A1,B1\nalpha,A2,B2\n${longName},A3,B3`);
    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe('Alpha');
    expect(rows[1].name).toBe('alpha');
    expect(rows[2].name).toHaveLength(65);
  });

  it('uses the team name once followed by the two player names', () => {
    const rows = parseRadballTeams('Team Alpha,Anna,Lena\nTeam Beta,Marie,Clara');
    expect(rows.map((row) => row.name)).toEqual(['Team Alpha', 'Team Beta']);
    expect(rows.map((row) => row.players)).toEqual([
      ['Anna', 'Lena'],
      ['Marie', 'Clara'],
    ]);
  });

  it('allows repeated names across fields but rejects duplicates within a field', () => {
    const fieldOne = parseRadballTeams('Team A,Anna,Lena\nTeam B,Marie,Clara\nTeam C,David,Eva').map((row) => ({ ...row, fieldId: '1' }));
    const fieldTwo = parseRadballTeams('Team A,Anna,Lena\nTeam B,Marie,Clara\nTeam C,David,Eva').map((row) => ({ ...row, fieldId: '2' }));
    const fieldNames = ['Field 1', 'Field 2'];
    expect(rosterIssues([...fieldOne, ...fieldTwo], fieldNames)).toHaveLength(0);

    const duplicateTeam = rosterIssues([...fieldOne, { ...fieldOne[0], line: 4 }, ...fieldTwo], fieldNames);
    expect(duplicateTeam.some((issue) => issue.message.includes('Team "Team A"'))).toBe(true);

    const duplicatePlayer = rosterIssues(
      [
        fieldOne[0],
        { ...fieldOne[0], name: 'Team B', players: ['Anna', 'Clara'] as [string, string], line: 4 },
        ...fieldTwo,
      ],
      fieldNames,
    );
    expect(duplicatePlayer.some((issue) => issue.message.includes('Player "Anna"'))).toBe(true);
  });

  it('accepts three teams in one field roster', () => {
    const rows = parseRadballTeams('a,b,s\nv,c,d\nd,d,f');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.players)).toEqual([
      ['b', 's'],
      ['c', 'd'],
      ['d', 'f'],
    ]);
  });

  it('accepts European separators and keeps missing riders', () => {
    const rows = parseRadballTeams('Alpha;Anna;Lena\nBeta;Marie;');
    expect(rows[0].players).toEqual(['Anna', 'Lena']);
    expect(rows[1].players).toEqual(['Marie', '']);
  });

  it('still reads four-column Radball drafts without requiring a new club entry', () => {
    const rows = parseRadballTeams('team,club,player 1,player 2\nAlpha,Club Alpha,Anna,Lena');
    expect(rows[0].club).toBe('Club Alpha');
    expect(rows[0].players).toEqual(['Anna', 'Lena']);
  });

  it('parses participant seeds without dropping duplicate rows', () => {
    const rows = parseParticipants('name,team,seed\nAlpha,A,2\nAlpha,A,2\nBeta,B,1');
    expect(rows.map((row) => row.seed)).toEqual([2, 2, 1]);
  });
});

describe('the example roster fill', () => {
  it('deals the World Cup example across two equal field rosters', () => {
    const fill = exampleRosterFill({ format: 'radball', radballSetupMode: 'ten-team' }, 2);
    const fieldOne = parseRadballTeams(fill[0]);
    const fieldTwo = parseRadballTeams(fill[1]);
    expect(fieldOne).toHaveLength(5);
    expect(fieldTwo).toHaveLength(5);
    // Disjoint: ten different squads, so the two groups are two real groups.
    const names = [...fieldOne, ...fieldTwo].map((team) => team.name);
    expect(new Set(names).size).toBe(10);
    expect(rosterIssues([...fieldOne.map((t) => ({ ...t, fieldId: '1' })), ...fieldTwo.map((t) => ({ ...t, fieldId: '2' }))])).toEqual(
      [],
    );
  });

  it('leaves the round-robin deal alone for every other format', () => {
    // Five Radball squads across two fields alternate, as they always have.
    const radball = exampleRosterFill({ format: 'radball', radballSetupMode: 'standard' }, 2);
    expect(parseRadballTeams(radball[0])).toHaveLength(3);
    expect(parseRadballTeams(radball[1])).toHaveLength(2);
    // And a World Cup on one field cannot be split in two, so it keeps the same deal.
    const singleField = exampleRosterFill({ format: 'radball', radballSetupMode: 'ten-team' }, 1);
    expect(parseRadballTeams(singleField[0]).length).toBeGreaterThan(0);
    expect(singleField[1]).toBe('');
    const knockout = exampleRosterFill({ format: 'single-elimination', radballSetupMode: 'standard' }, 2);
    expect(parseParticipants(knockout[0])).toHaveLength(2);
    expect(parseParticipants(knockout[1])).toHaveLength(2);
  });
});

describe('setup draft normalisation', () => {
  it('restores a versioned draft and rejects unknown versions', () => {
    const draft = normaliseDraft({
      version: 1,
      step: 4,
      name: 'Radball Cup',
      format: 'radball',
      fieldNames: ['Matte A', 'Matte B'],
      radballBulk: ['Alpha,A1,B1', '', 'Beta,A2,B2'],
      savedAt: 123,
    });
    expect(draft?.step).toBe(4);
    expect(draft?.format).toBe('radball');
    expect(draft?.radballBulk[0]).toContain('Alpha');
    expect(normaliseDraft({ version: 2, step: 4 })).toBeNull();
  });
});

