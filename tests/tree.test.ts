/**
 * The 10-team tournament tree's own arithmetic -- which it does not do.
 *
 * The tree is presentational, but everything it prints comes out of these view
 * helpers, and two of the things a hall relies on are decided here: what a
 * final-phase slot is *called* before its match exists, and when it becomes the
 * name of a squad instead of a position. Getting either wrong is invisible in a
 * screenshot and very visible to a volunteer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TournamentState } from '../src/shared/types';
import { RADBALL10_FINAL_STRUCTURE } from '../src/shared/radball10Structure';
import { buildRadball10Demo, RADBALL10_DEMO_TEAMS } from '../src/backend/tournament/demo';
import { generateFinalPhase, finalPhaseMatches, groupIdOfKey, preliminaryMatches } from '../src/backend/tournament/radball10';
import { assignMatchToField, finishMatch, startMatch } from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';
import { createTestStore, adminCtx, run, type TestStore } from './helpers';
import {
  finalMatchId,
  finalPhaseRows,
  groupFixtureDigest,
  groupFixtures,
  groupSlots,
  ordinal,
  preliminaryProgress,
  slotRefLabel,
  type FinalPhaseSpec,
} from '../src/frontend/lib/radball10';

const openStores: TestStore[] = [];
afterEach(async () => {
  while (openStores.length > 0) await openStores.pop()?.dispose();
});

async function makeStore(label: string): Promise<TestStore> {
  const store = await createTestStore(label);
  openStores.push(store);
  return store;
}

/** The ten-team demo: Group A = A-E on field 1, Group B = F-J on field 2. */
async function createDemo(label: string): Promise<TestStore> {
  const store = await makeStore(label);
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    buildRadball10Demo(state, ctx, mut);
  });
  return store;
}

const SPEC: FinalPhaseSpec[] = RADBALL10_FINAL_STRUCTURE;

/** Assign, start, score and finish one match. Mirrors the radball10 fixtures. */
function playMatch(store: TestStore, matchId: string, scoreA: number, scoreB: number, field: string): void {
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    if (!state.matches[matchId].fieldId) assignMatchToField(state, matchId, field, ctx, mut);
    startMatch(state, matchId, field, ctx, mut);
    updateScore(state, state.matches[matchId], 'A', scoreA, ctx, mut);
    updateScore(state, state.matches[matchId], 'B', scoreB, ctx, mut);
    finishMatch(state, { matchId, winner: null, force: false }, ctx, mut);
  });
}

/** Play every preliminary fixture with a deterministic, never-tied result. */
function playPreliminary(store: TestStore): void {
  preliminaryMatches(store.store.state).forEach((match, index) => {
    const groupId = match.radball?.groupId ?? '';
    const field = store.store.state.radball?.groups[groupId]?.fieldId ?? '1';
    playMatch(store, match.id, 5 + (index % 3), 2, field);
  });
}

/* ------------------------------------------------------------------ */

describe('the preliminary fixture list', () => {
  const groupA = (state: TournamentState) => {
    const id = groupIdOfKey(state, 'GROUP_A');
    if (!id) throw new Error('no Group A');
    return id;
  };

  it('lists one group\'s ten fixtures in the order they are played', async () => {
    const store = await createDemo('fixtures-order');
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    expect(fixtures).toHaveLength(10);
    // Round then position, so the printed schedule never moves when the host
    // rearranges the queue.
    expect(fixtures.map((f) => f.round)).toEqual([...fixtures.map((f) => f.round)].sort((a, b) => a - b));
    // Both groups together are the twenty the format promises.
    const groupB = groupIdOfKey(store.store.state, 'GROUP_B');
    expect(groupB ? groupFixtures(store.store.state, groupB).length : 0).toBe(10);
  });

  it('names both squads on every fixture before anything is played', async () => {
    const store = await createDemo('fixtures-squads');
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    expect(fixtures.every((f) => f.nameA && f.nameA !== 'TBD')).toBe(true);
    expect(fixtures.every((f) => f.nameB && f.nameB !== 'TBD')).toBe(true);
    // Group A's ten fixtures only ever contain Group A's five squads.
    const teams = new Set(fixtures.flatMap((f) => [f.nameA, f.nameB]));
    expect([...teams].sort()).toEqual(['Team A', 'Team B', 'Team C', 'Team D', 'Team E']);
  });

  it('calls every fixture ready, except the two the demo put on a field', async () => {
    const store = await createDemo('fixtures-statuses');
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    // A round robin has no feeders: both squads are known from the start, so every
    // one of the ten is playable the moment the group opens. The demo assigns the
    // opening fixture of each group to a field, and those two are live.
    expect(fixtures.filter((f) => f.status === 'live')).toHaveLength(1);
    expect(fixtures.filter((f) => f.status === 'next')).toHaveLength(9);
    expect(fixtures.some((f) => f.status === 'waiting')).toBe(false);
    expect(fixtures.filter((f) => f.status === 'next').every((f) => f.statusLabel === 'Ready')).toBe(true);
    expect(fixtures.find((f) => f.status === 'live')?.statusLabel).toBe('On field');
    // Nothing is waiting, so nothing claims to be.
    expect(fixtures.every((f) => f.blockedBy === null)).toBe(true);
  });

  it('numbers the rounds the way the hall does, from one', async () => {
    const store = await createDemo('fixtures-rounds');
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    // The engine stores rounds from zero; a printed schedule must not start at R0.
    expect(fixtures.map((f) => f.round)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it('records a result once the match is played', async () => {
    const store = await createDemo('fixtures-played');
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    const target = fixtures[0];
    playMatch(store, target.id, 7, 3, '1');
    const after = groupFixtures(store.store.state, groupA(store.store.state)).find((f) => f.id === target.id);
    expect(after?.status).toBe('played');
    expect(after?.statusLabel).toBe('Played');
    expect([after?.scoreA, after?.scoreB]).toEqual([7, 3]);
  });

  it('marks the match on a field as the one being played now', async () => {
    const store = await createDemo('fixtures-live');
    const state = store.store.state;
    const fixtures = groupFixtures(state, groupA(state));
    const target = fixtures[0];
    // Assigned but not started: it owns a ring, so it is the live fixture.
    run(store.store, adminCtx(store.store), (s, ctx, mut) => {
      assignMatchToField(s, target.id, '1', ctx, mut);
    });
    const assigned = groupFixtures(store.store.state, groupA(store.store.state)).find((f) => f.id === target.id);
    expect(assigned?.status).toBe('live');
    // Assigned but not started: it owns a ring, so it reads as On field, not Live.
    expect(assigned?.statusLabel).toBe('On field');

    run(store.store, adminCtx(store.store), (s, ctx, mut) => {
      startMatch(s, target.id, '1', ctx, mut);
    });
    expect(groupFixtures(store.store.state, groupA(store.store.state)).find((f) => f.id === target.id)?.statusLabel).toBe(
      'Live',
    );
  });

  it('reduces a group to what a host needs mid-event', async () => {
    const store = await createDemo('fixtures-digest');
    const digest = groupFixtureDigest(store.store.state, groupA(store.store.state));
    // Fresh: nothing played, the assigned opening fixture is live, one is next.
    expect(digest.played).toEqual([]);
    expect(digest.live?.status).toBe('live');
    expect(digest.next?.status).toBe('next');
    expect(digest.next?.nameA).not.toBe(digest.live?.nameA);
    expect(digest.waiting).toBe(0);

    playPreliminary(store);
    const after = groupFixtureDigest(store.store.state, groupA(store.store.state));
    // Finished: ten results as one line's worth of text, nothing left to play.
    expect(after.played).toHaveLength(10);
    expect(after.played[0]).toMatch(/^Team . \d+:\d+ Team /);
    expect(after.live).toBeNull();
    expect(after.next).toBeNull();
  });

  it('follows the whole round from ready through to played', async () => {
    const store = await createDemo('fixtures-lifecycle');
    playPreliminary(store);
    const fixtures = groupFixtures(store.store.state, groupA(store.store.state));
    // Every preliminary fixture in a finished group is a recorded result.
    expect(fixtures.every((f) => f.status === 'played')).toBe(true);
    expect(fixtures.every((f) => f.blockedBy === null)).toBe(true);
    expect(fixtures.every((f) => f.scoreA !== f.scoreB)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('ordinal', () => {
  it('spells the place out, number included', () => {
    // The suffix-only version this replaced rendered the Results tab's places as
    // bare "st" / "nd" / "th" and the tree's purpose line as "Play for th / th".
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '5th',
      '6th',
      '7th',
      '8th',
      '9th',
      '10th',
    ]);
    expect([11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
    ]);
  });
});

describe('the final-phase ladder', () => {
  it('is seven rows, each labelled by what it decides', async () => {
    const rows = finalPhaseRows((await createDemo('ladder-labels')).store.state, SPEC);
    expect(rows.map((row) => row.shortLabel)).toEqual([
      '9/10',
      '7/8',
      '5/6',
      'SF 1',
      'SF 2',
      '3/4',
      '1/2',
    ]);
    // Every row still knows what it is for, in words.
    expect(rows[0].purpose).toBe('Play for 9th / 10th');
    expect(rows[3].purpose).toBe('Qualifies for the final and the 3rd-place match');
  });

  it('names the two dependencies before either group has finished', async () => {
    const store = await createDemo('ladder-undecided');
    const rows = finalPhaseRows(store.store.state, SPEC);
    expect(rows[3].sideA).toBe('Group A #1');
    expect(rows[3].sideB).toBe('Group B #2');
    expect(rows[6].sideA).toBe('Winner · Semifinal 1');
    expect(rows[5].sideB).toBe('Loser · Semifinal 2');
    expect(rows.every((row) => row.state === 'NOT_CREATED')).toBe(true);
  });

  it('swaps the cross-group pairings exactly as the rules say', async () => {
    const store = await createDemo('ladder-pairings');
    const rows = finalPhaseRows(store.store.state, SPEC);
    // Group A #1 v B #2, and B #1 v A #2 -- the format's only asymmetry.
    expect([rows[3].sideA, rows[3].sideB]).toEqual(['Group A #1', 'Group B #2']);
    expect([rows[4].sideA, rows[4].sideB]).toEqual(['Group B #1', 'Group A #2']);
    // The placement matches run the other way down the table.
    expect([rows[0].sideA, rows[0].sideB]).toEqual(['Group A #5', 'Group B #5']);
  });

  it('replaces a position with the squad holding it once the group is frozen', async () => {
    const store = await createDemo('ladder-frozen');
    playPreliminary(store);
    const state = store.store.state;
    const groupA = groupIdOfKey(state, 'GROUP_A');
    if (!groupA) throw new Error('missing Group A');
    expect(state.radball?.ten?.groupFrozen[groupA]).toBe(true);

    const rows = finalPhaseRows(state, SPEC);
    const winnerOf = state.radball?.ten?.rankings[groupA]?.[0];
    // A1 is a real team, so the semifinal names the team rather than "Group A #1".
    expect(rows[3].sideA).toBe(winnerOf ? state.participants[winnerOf]?.name : null);
    expect(rows[3].sideA).not.toBe('Group A #1');
    // Every group slot resolves the same way; only the semifinal-fed rows do not.
    const bySquad = rows.filter((row) => !row.title.startsWith('Semifinal') && row.key !== 'FINAL' && row.key !== 'THIRD_PLACE');
    expect(bySquad.every((row) => !/Group [AB] #\d/.test(row.sideA) && !/Group [AB] #\d/.test(row.sideB))).toBe(true);
  });

  it('carries a score and a winner once a match is decided', async () => {
    const store = await createDemo('ladder-decided');
    playPreliminary(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    expect(finalPhaseMatches(state)).toHaveLength(7);

    // The server refuses to start the final before both semifinals are finished,
    // so the ladder's last row genuinely waits on the two above it.
    const finalId = finalMatchId(state, 'FINAL');
    expect(() => playMatch(store, finalId, 7, 4, '1')).toThrow(/cannot start before/);

    playMatch(store, finalMatchId(state, 'SEMIFINAL_1'), 5, 3, '1');
    playMatch(store, finalMatchId(state, 'SEMIFINAL_2'), 4, 2, '2');
    playMatch(store, finalId, 7, 4, '1');

    const row = finalPhaseRows(state, SPEC).find((entry) => entry.key === 'FINAL');
    expect(row?.state).toBe('FINISHED');
    expect(row?.scoreA).toBe(7);
    expect(row?.scoreB).toBe(4);
    // Both sides are real squads by now, not positions.
    expect(row?.sideA).not.toMatch(/Group [AB] #\d/);
    expect(row?.winnerId).not.toBeNull();
  });

  it('says which semifinal a waiting row needs', async () => {
    const store = await createDemo('ladder-blocked');
    playPreliminary(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const rows = finalPhaseRows(store.store.state, SPEC);
    // Nothing played yet: the final and the bronze match both wait on both semis.
    const blocked = rows.filter((row) => row.blockedBy !== null);
    expect(blocked.map((row) => row.key).sort()).toEqual(['FINAL', 'THIRD_PLACE']);
    expect(blocked[0].blockedBy).toContain('Semifinal 1');
    expect(blocked[0].blockedBy).toContain('Semifinal 2');
    // The semifinals themselves only need the groups, which are done.
    expect(rows.find((row) => row.key === 'SEMIFINAL_1')?.blockedBy).toBeNull();
  });
});

describe('the preliminary round', () => {
  it('counts both groups together, because both are played at once', async () => {
    const store = await createDemo('progress');
    const fresh = preliminaryProgress(groupSlots(store.store.state));
    expect(fresh).toMatchObject({ played: 0, total: 20, complete: false });
    expect(fresh.label).toBe('0 of 20 played');

    playPreliminary(store);
    const done = preliminaryProgress(groupSlots(store.store.state));
    expect(done).toMatchObject({ played: 20, total: 20, complete: true });
    expect(done.label).toBe('all 20 played');
  });

  it('reads as half done partway through', async () => {
    const store = await createDemo('progress-half');
    const groupA = groupIdOfKey(store.store.state, 'GROUP_A');
    if (!groupA) throw new Error('missing Group A');
    preliminaryMatches(store.store.state, groupA)
      .slice(0, 5)
      .forEach((match, index) => playMatch(store, match.id, 5, 2 + index, '1'));
    expect(preliminaryProgress(groupSlots(store.store.state)).label).toBe('5 of 20 played');
  });

  it('shows one group per playing field', async () => {
    const store = await createDemo('progress-fields');
    const groups = groupSlots(store.store.state);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => [group.letter, group.fieldName, group.teams.length])).toEqual([
      ['A', 'Field 1', 5],
      ['B', 'Field 2', 5],
    ]);
  });
});

describe('the final ranking places', () => {
  it('spells place numbers out, so an undecided place reads as undecided', async () => {
    const store = await createDemo('ranking-places');
    // Every place is open, and every one of them is labelled with a real ordinal.
    const ranking = store.store.state.radball?.ten?.ranking ?? [];
    expect(ranking.map((entry) => entry.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { finalRankingRows } = await import('../src/frontend/lib/radball10');
    expect(finalRankingRows(store.store.state).map((row) => row.ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '5th',
      '6th',
      '7th',
      '8th',
      '9th',
      '10th',
    ]);
    expect(finalRankingRows(store.store.state).every((row) => !row.decided)).toBe(true);
  });
});

describe('the shared slot label', () => {
  it('still names the group position when nothing else is known', async () => {
    const store = await createDemo('slot-label');
    const state: TournamentState = store.store.state;
    expect(slotRefLabel(state, { source: 'GROUP_A', rank: 3 })).toBe('Group A #3');
    expect(slotRefLabel(state, { source: 'GROUP_B', rank: 1 })).toBe('Group B #1');
    expect(slotRefLabel(state, { source: 'SEMIFINAL', number: 2, place: 'loser' })).toBe('Loser · Semifinal 2');
    // Ten teams, and the demo names them.
    expect(RADBALL10_DEMO_TEAMS).toHaveLength(10);
  });
});