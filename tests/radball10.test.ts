/**
 * The 10-team Radball format (UCI World Cup shape).
 *
 * Twenty acceptance cases, numbered as in the requirement:
 *
 *   1-7    the preliminary round: two groups of five, twenty fixtures, every
 *          pairing exactly once, and never a cross-group game
 *   8-12   the final phase is generated from the *positions*, not from names:
 *          A5/B5, A4/B4, A3/B3 for the placements, A1/B2 and B1/A2 for the
 *          semifinals
 *   13-16  the dependency chain: semifinal winners reach the final, losers reach
 *          the third-place match, and all ten places land exactly once
 *   17     correcting a group result re-derives every dependent match
 *   18-19  two fields, parallel matches, never one team on both
 *   20     the whole thing survives a restart
 *
 * Everything runs through the real engine (`createTournament`, `finishMatch`,
 * `recordShootoutAttempt`) rather than by hand-editing state, because the claim
 * under test is that the *engine* derives the competition from its results.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FieldId,
  Match,
  RadballFinalKey,
  StandingRow,
  TournamentState,
} from '../src/shared/types';
import { TournamentStore } from '../src/backend/store/store';
import { adminCtx, createTestStore, run, type TestStore } from './helpers';
import { RADBALL10_DEMO_TEAMS, buildRadball10Demo } from '../src/backend/tournament/demo';
import { resetTournament } from '../src/backend/tournament/engine';
import { createTournament } from '../src/backend/tournament/engine';
import { homeFieldOf, isPlayable } from '../src/shared/matchUtils';
import type { ParticipantInput } from '../src/shared/commands';
import {
  RADBALL10_FINAL_STRUCTURE,
  radball10FinalStructure,
} from '../src/shared/radball10Structure';
import {
  RADBALL10_FINAL_MATCHES,
  RADBALL10_GROUP_MATCHES,
  RADBALL10_PRELIMINARY_MATCHES,
  RADBALL10_TOTAL_MATCHES,
  assertFinalPhaseDependency,
  finalPhaseMatches,
  finalPhaseReadiness,
  generateFinalPhase,
  groupIdOfKey,
  matchOfKey,
  preliminaryMatches,
  radball10FinalMatchId,
  setFinalPhaseOrder,
  slotSpecLabel,
} from '../src/backend/tournament/radball10';
import {
  assignMatchToField,
  autoAssign,
  finishMatch,
  startMatch,
  unassignField,
} from '../src/backend/tournament/matchops';
import { correctScore, updateScore } from '../src/backend/tournament/scoring';
import { recordShootoutAttempt, teamBusyOnOtherField } from '../src/backend/tournament/radball';
import { rebuild } from '../src/backend/tournament/resolve';

/* ------------------------------------------------------------------ */
/* Fixture plumbing                                                     */
/* ------------------------------------------------------------------ */

const openStores: TestStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    await store?.dispose();
  }
});

async function makeStore(label: string): Promise<TestStore> {
  const store = await createTestStore(label);
  openStores.push(store);
  return store;
}

/** The ten-team demo: Team A-J, Group A = A-E, Group B = F-J. */
async function createDemo(label: string): Promise<TestStore> {
  const store = await makeStore(label);
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    buildRadball10Demo(state, ctx, mut);
  });
  return store;
}

function groupId(state: TournamentState, key: 'GROUP_A' | 'GROUP_B'): string {
  const id = groupIdOfKey(state, key);
  if (!id) throw new Error(`No ${key}`);
  return id;
}

function groupTeams(state: TournamentState, key: 'GROUP_A' | 'GROUP_B'): string[] {
  return [...(state.radball?.groups[groupId(state, key)]?.teamIds ?? [])];
}

function tableOf(state: TournamentState, groupIdValue: string): StandingRow[] {
  return state.radball?.tables[groupIdValue] ?? [];
}

/** Put a match on a field, run it, and finish it with a clear result. */
function playMatch(store: TestStore, matchId: string, scoreA: number, scoreB: number, field: FieldId = '1'): void {
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    if (!state.matches[matchId].fieldId) {
      assignMatchToField(state, matchId, field, ctx, mut);
    }
    startMatch(state, matchId, field, ctx, mut);
    updateScore(state, state.matches[matchId], 'A', scoreA, ctx, mut);
    updateScore(state, state.matches[matchId], 'B', scoreB, ctx, mut);
    finishMatch(state, { matchId, winner: null, force: false }, ctx, mut);
  });
}

/**
 * Play every preliminary fixture with a deterministic result that never ties and
 * never repeats: fixture i gets a score of `2 + (i % 3)` against
 * `i % 4` re-based so the two sides differ. The point is only that every result
 * exists and is unambiguous; the resulting ranking is whatever it is.
 */
function playPreliminary(
  store: TestStore,
  pick: (fixtureIndex: number, teamA: string, teamB: string) => [number, number],
): void {
  const fixtures = preliminaryMatches(store.store.state);
  fixtures.forEach((match, index) => {
    const [a, b] = pick(index, match.participantAId ?? '', match.participantBId ?? '');
    playMatch(store, match.id, a, b, fieldOfGroupMatch(store, match));
  });
}

/** Group A plays Field 1, Group B Field 2 (§3). */
function fieldOfGroupMatch(store: TestStore, match: Match): FieldId {
  const fieldId = store.store.state.radball?.groups[match.radball?.groupId ?? '']?.fieldId ?? '1';
  return fieldId === '2' ? '2' : '1';
}

/** Play the whole preliminary round with the first-listed side winning. */
function playPreliminaryForDemo(store: TestStore): void {
  playPreliminary(store, (index) => (index % 2 === 0 ? [3, 1] : [1, 3]));
}

/**
 * Reopen a finished match the way the host does: correct the score, put it back
 * on its field and confirm the new result. `winnerId` decides which side gets the
 * winning score, so the test never has to care which slot a team sits in.
 */
function replayWith(
  store: TestStore,
  matchId: string,
  winnerId: string,
  winnerScore: number,
  loserScore: number,
  note: string,
): void {
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    const match = state.matches[matchId];
    const winnerOnA = match.participantAId === winnerId;
    const scoreA = winnerOnA ? winnerScore : loserScore;
    const scoreB = winnerOnA ? loserScore : winnerScore;
    correctScore(state, match, scoreA, scoreB, ctx, mut, note);
    startMatch(state, matchId, match.fieldId ?? '1', ctx, mut);
    updateScore(state, state.matches[matchId], 'A', scoreA, ctx, mut);
    updateScore(state, state.matches[matchId], 'B', scoreB, ctx, mut);
    finishMatch(state, { matchId, winner: null, force: false }, ctx, mut);
  });
}

/** Play the preliminary round, generate the final phase and play all six matches. */
function runWholeTournament(store: TestStore): void {
  playPreliminaryForDemo(store);
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    generateFinalPhase(state, ctx, mut, { confirm: true });
  });
  for (const entry of RADBALL10_FINAL_STRUCTURE) {
    const match = matchOfKey(store.store.state, entry.key);
    if (!match) throw new Error(`No ${entry.key}`);
    playMatch(store, match.id, 4, 2, '1');
  }
}

function finalRanking(state: TournamentState) {
  return state.radball?.ten?.ranking ?? [];
}

/** Every match still to play, in queue order -- what the dashboard lists. */
function openOf(state: TournamentState): Match[] {
  return Object.values(state.matches)
    .filter((match) => match.state !== 'FINISHED' && match.state !== 'CANCELLED')
    .sort((a, b) => a.round - b.round || a.position - b.position);
}

/* ------------------------------------------------------------------ */
/* TEST 1-4: the preliminary round                                      */
/* ------------------------------------------------------------------ */

describe('10-team preliminary round', () => {
  it('TEST 1: the World Cup shape takes two equal groups, and refuses a roster that cannot form them', async () => {
    const store = await createDemo('ten-count');
    expect(store.store.state.participantOrder).toHaveLength(10);
    expect(store.store.state.radball?.system).toBe('radball-10-team');
    expect(store.store.state.radball?.ten?.stage).toBe('GROUP_PHASE');

    // Nine teams spread five on field 1 and four on field 2: the groups are the
    // field rosters, and the final phase pairs A-rank r with B-rank r, so unequal
    // groups have a position with nobody to meet. The refusal must leave the
    // loaded competition untouched, because `createTournament` validates on a
    // clone.
    const before = structuredClone(store.store.state);
    expect(() =>
      run(store.store, adminCtx(store.store), (state, ctx, mut) => {
        createTournament(
          state,
          {
            name: 'Nine teams',
            format: 'radball',
            participants: RADBALL10_DEMO_TEAMS.slice(0, 9).map((team, index) => ({
              name: team.name,
              team: null,
              seed: null,
              checkedIn: true,
              players: [team.players[0], team.players[1]],
              fieldId: index < 5 ? '1' : '2',
            })),
            thirdPlaceMatch: false,
            seeded: true,
            seedValue: null,
            settings: null,
            generateBracketNow: true,
            radball: { ageCategory: 'ELITE', preset: 'radball-10-team' },
          },
          ctx,
          mut,
        );
      }),
    ).toThrow(/same number of teams in both groups/i);
    expect(store.store.state.tournament?.id).toBe(before.tournament?.id);
    expect(store.store.state.radball?.ten).not.toBeNull();
  });

  it('scales past ten teams: the shape follows the group count, not a literal', async () => {
    // Two groups of six: 15 preliminary fixtures per group, and a final phase of
    // four placement matches plus the same four knockout matches. Six squads are
    // registered on each field, because the field roster is the group.
    const teams: ParticipantInput[] = Array.from({ length: 12 }, (_, index) => ({
      name: `Squad ${index + 1}`,
      team: null,
      seed: null,
      checkedIn: true,
      players: [`P${index + 1}a`, `P${index + 1}b`],
      fieldId: index < 6 ? '1' : '2',
    }));
    const store = await makeStore('twelve-teams');
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      createTournament(
        state,
        {
          name: 'Twelve teams',
          format: 'radball',
          participants: teams,
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: { fieldNames: ['Field 1', 'Field 2'] },
          generateBracketNow: true,
          radball: { ageCategory: 'ELITE', preset: 'radball-10-team' },
        },
        ctx,
        mut,
      );
    });
    const state = store.store.state;
    expect(state.participantOrder).toHaveLength(12);
    expect(state.radball?.groupOrder).toHaveLength(2);
    expect(groupTeams(state, 'GROUP_A')).toHaveLength(6);
    expect(groupTeams(state, 'GROUP_B')).toHaveLength(6);
    // A single round robin of six is 6 * 5 / 2 = 15 per group, 30 in all.
    expect(preliminaryMatches(state)).toHaveLength(30);

    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (s, c, m) => {
      generateFinalPhase(s, c, m, { confirm: true });
    });

    // Four placement matches (11/12, 9/10, 7/8, 5/6) and the four knockout ones.
    const keys = finalPhaseMatches(store.store.state).map((match) => match.radball?.finalKey);
    expect(keys).toContain('PLACEMENT_11_12');
    expect(keys).toContain('PLACEMENT_5_6');
    expect(keys).toHaveLength(8);

    // Twelve places, each decided by a match. Played in dependency order: the
    // four placement matches, then both semifinals, then the two matches that
    // need them -- which is the same refusal a host would meet.
    expect(finalRanking(store.store.state)).toHaveLength(12);
    const twelve = radball10FinalStructure(6);
    const play = (key: string) => {
      const match = matchOfKey(store.store.state, key as RadballFinalKey);
      if (match) playMatch(store, match.id, 4, 2, '1');
    };
    // Only the placement matches hang off the group tables; the third-place
    // match and the final need the semifinals, so they come last.
    twelve
      .filter((entry) => entry.places && entry.key !== 'THIRD_PLACE' && entry.key !== 'FINAL')
      .forEach((entry) => play(entry.key));
    play('SEMIFINAL_1');
    play('SEMIFINAL_2');
    play('THIRD_PLACE');
    play('FINAL');
    const ranking = finalRanking(store.store.state);
    expect(ranking.map((entry) => entry.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(ranking.every((entry) => entry.teamId !== null)).toBe(true);
    expect(new Set(ranking.map((entry) => entry.teamId)).size).toBe(12);
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(store.store.state.tournament?.status).toBe('COMPLETED');
  });

  it('TEST 2: exactly five teams enter each group, and each is pinned to its field', async () => {
    const store = await createDemo('ten-groups');
    const state = store.store.state;
    expect(state.radball?.groupOrder).toHaveLength(2);
    const a = groupTeams(state, 'GROUP_A');
    const b = groupTeams(state, 'GROUP_B');
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    // Every team plays somewhere, exactly once.
    expect(new Set([...a, ...b]).size).toBe(10);
    // §3: Field 1 = Group A, Field 2 = Group B.
    expect(state.radball?.groups[groupId(state, 'GROUP_A')].fieldId).toBe('1');
    expect(state.radball?.groups[groupId(state, 'GROUP_B')].fieldId).toBe('2');
  });

  it('TEST 3: each group produces exactly ten matches', async () => {
    const store = await createDemo('ten-per-group');
    const state = store.store.state;
    for (const key of ['GROUP_A', 'GROUP_B'] as const) {
      expect(preliminaryMatches(state, groupId(state, key))).toHaveLength(RADBALL10_GROUP_MATCHES);
    }
  });

  it('TEST 4: exactly twenty preliminary matches are generated, no byes', async () => {
    const store = await createDemo('ten-total');
    const state = store.store.state;
    const fixtures = preliminaryMatches(state);
    expect(fixtures).toHaveLength(RADBALL10_PRELIMINARY_MATCHES);
    // 20 preliminary + 3 placement + 2 semifinal + third place + final = 27.
    expect(RADBALL10_FINAL_MATCHES).toBe(7);
    expect(RADBALL10_TOTAL_MATCHES).toBe(27);
    // A bye is never an actual match (§5).
    for (const match of fixtures) {
      expect(match.slotA.kind).toBe('participant');
      expect(match.slotB.kind).toBe('participant');
      expect(match.participantAId).toBeTruthy();
      expect(match.participantBId).toBeTruthy();
      expect(match.radball?.matchType).toBe('GROUP_MATCH');
    }
  });
});

/* ------------------------------------------------------------------ */
/* TEST 5-7: the round robin itself                                     */
/* ------------------------------------------------------------------ */

describe('10-team round robin completeness', () => {
  it('TEST 5: every team plays four group matches', async () => {
    const store = await createDemo('ten-four-matches');
    const state = store.store.state;
    for (const teamId of state.participantOrder) {
      const own = preliminaryMatches(state).filter(
        (match) => match.participantAId === teamId || match.participantBId === teamId,
      );
      expect(own).toHaveLength(4);
    }
  });

  it('TEST 6: every team meets every other team of its group exactly once', async () => {
    const store = await createDemo('ten-once');
    const state = store.store.state;
    for (const key of ['GROUP_A', 'GROUP_B'] as const) {
      const teams = groupTeams(state, key);
      const seen = new Map<string, number>();
      for (const match of preliminaryMatches(state, groupId(state, key))) {
        const pair = [match.participantAId, match.participantBId].sort().join('|');
        seen.set(pair, (seen.get(pair) ?? 0) + 1);
        // No team plays itself.
        expect(match.participantAId).not.toBe(match.participantBId);
      }
      // 5 * 4 / 2 = 10 pairings, each once.
      expect(seen.size).toBe(10);
      for (const count of seen.values()) expect(count).toBe(1);
      // Every ordered pair of teams occurs.
      for (let i = 0; i < teams.length; i += 1) {
        for (let j = i + 1; j < teams.length; j += 1) {
          expect(seen.has([teams[i], teams[j]].sort().join('|'))).toBe(true);
        }
      }
    }
  });

  it('TEST 7: nobody plays across groups during the preliminary phase', async () => {
    const store = await createDemo('ten-no-cross');
    const state = store.store.state;
    const a = new Set(groupTeams(state, 'GROUP_A'));
    const b = new Set(groupTeams(state, 'GROUP_B'));
    for (const match of preliminaryMatches(state)) {
      const x = match.participantAId as string;
      const y = match.participantBId as string;
      // Both sides are in the same group, and that is the only group they are in.
      expect(a.has(x)).toBe(a.has(y));
      expect(b.has(x)).toBe(b.has(y));
      expect(a.has(x) !== b.has(x)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* TEST 8-12: the final phase comes from the positions                  */
/* ------------------------------------------------------------------ */

describe('final phase generation', () => {
  it('TEST 8/9/10: A5-B5, A4-B4 and A3-B3 decide 9/10, 7/8 and 5/6', async () => {
    const store = await createDemo('ten-placements');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    for (const [key, rank] of [
      ['PLACEMENT_9_10', 5],
      ['PLACEMENT_7_8', 4],
      ['PLACEMENT_5_6', 3],
    ] as [RadballFinalKey, number][]) {
      const match = matchOfKey(state, key)!;
      expect(match.radball?.finalKey).toBe(key);
      const expectedA = state.radball?.ten?.rankings[groupId(state, 'GROUP_A')]?.[rank - 1];
      const expectedB = state.radball?.ten?.rankings[groupId(state, 'GROUP_B')]?.[rank - 1];
      expect(match.participantAId).toBe(expectedA);
      expect(match.participantBId).toBe(expectedB);
      expect(match.participantAId).not.toBe(match.participantBId);
      // Both sides come from a different group -- that is what makes it a
      // cross-group placement match rather than an ordinary group fixture.
      expect(groupId(state, 'GROUP_A')).not.toBe(groupId(state, 'GROUP_B'));
    }
  });

  it('TEST 11/12: A1 vs B2 is semifinal 1 and B1 vs A2 is semifinal 2', async () => {
    const store = await createDemo('ten-semis');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    const sf1 = matchOfKey(state, 'SEMIFINAL_1')!;
    const sf2 = matchOfKey(state, 'SEMIFINAL_2')!;
    const a = state.radball?.ten?.rankings[groupId(state, 'GROUP_A')] ?? [];
    const b = state.radball?.ten?.rankings[groupId(state, 'GROUP_B')] ?? [];
    expect(sf1.participantAId).toBe(a[0]);
    expect(sf1.participantBId).toBe(b[1]);
    expect(sf2.participantAId).toBe(b[0]);
    expect(sf2.participantBId).toBe(a[1]);
    // Two distinct semifinals, not one match seen twice.
    expect(sf1.id).not.toBe(sf2.id);
    expect(sf1.radball?.semiNumber).toBe(1);
    expect(sf2.radball?.semiNumber).toBe(2);
  });

  it('names the dependency instead of the team, and shows it in the UI label', async () => {
    const store = await createDemo('ten-refs');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (s, c, m) => {
      generateFinalPhase(s, c, m, { confirm: true });
    });
    const after = store.store.state;
    const tournamentId = after.tournament!.id;
    const finalMatch = matchOfKey(after, 'FINAL')!;
    expect(finalMatch.slotA).toEqual({
      kind: 'winner-of',
      matchId: radball10FinalMatchId(tournamentId, 'SEMIFINAL_1'),
    });
    expect(finalMatch.slotB).toEqual({
      kind: 'winner-of',
      matchId: radball10FinalMatchId(tournamentId, 'SEMIFINAL_2'),
    });
    const bronze = matchOfKey(after, 'THIRD_PLACE')!;
    expect(bronze.slotA.kind).toBe('loser-of');
    expect(bronze.slotB.kind).toBe('loser-of');
    const nine = matchOfKey(after, 'PLACEMENT_9_10')!;
    expect(nine.slotA).toMatchObject({ kind: 'group-rank', rank: 5 });
    // A dependent match never caches its teams: they must re-read the ranking.
    expect(nine.locked).toBe(false);
    expect(finalMatch.locked).toBe(false);
    // Labels read as positions, never as "winner of match 7".
    expect(slotSpecLabel(after, { source: 'GROUP_A', rank: 5 })).toBe('Group A #5');
    expect(slotSpecLabel(after, { source: 'SEMIFINAL', number: 1, place: 'winner' })).toContain('Winner');
  });

  it('refuses to generate before both groups are complete (§24)', async () => {
    const store = await createDemo('ten-lock');
    const state = store.store.state;
    const first = preliminaryMatches(state)[0];
    playMatch(store, first.id, 2, 1, '1');
    const readiness = finalPhaseReadiness(store.store.state);
    expect(readiness.ready).toBe(false);
    expect(readiness.groups.map((entry) => `${entry.name} ${entry.played}/${entry.total}`)).toEqual([
      'Group A 1/10',
      'Group B 0/10',
    ]);
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        generateFinalPhase(s, c, m, { confirm: true });
      }),
    ).toThrow(/preliminary/i);
    expect(finalPhaseMatches(store.store.state)).toHaveLength(0);
  });

  it('generates exactly six final-phase matches, once', async () => {
    const store = await createDemo('ten-six');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    expect(finalPhaseMatches(state)).toHaveLength(RADBALL10_FINAL_MATCHES);
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        generateFinalPhase(s, c, m, { confirm: true });
      }),
    ).toThrow(/already/i);
  });

  it('stays quiet until the structure exists, and still quiet while it is played', async () => {
    const store = await createDemo('ten-issues');
    // A fresh competition has ten empty places, which is the expected state of a
    // preliminary round -- not a validation failure worth shouting about.
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(finalRanking(store.store.state).every((entry) => entry.teamId === null)).toBe(true);

    playPreliminaryForDemo(store);
    // Still quiet: the final phase is offered but not created.
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(store.store.state.radball?.ten?.stage).toBe('GROUP_PHASE_COMPLETE');

    // Generated: seven unplayed matches, ten empty places, and still no issue.
    // This is the state that used to raise a red "the final ranking is not
    // complete" banner naming six problems, so the host read a successful
    // generation as a failed one.
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    expect(store.store.state.radball?.ten?.final.status).toBe('GENERATED');
    expect(store.store.state.radball?.ten?.issues).toEqual([]);

    // Play the three placement matches only. Semifinals, third place and the final
    // are still open, so the tournament is mid-final-phase -- and still quiet.
    for (const entry of RADBALL10_FINAL_STRUCTURE) {
      if (!entry.matchType.startsWith('PLACEMENT_')) continue;
      playMatch(store, matchOfKey(store.store.state, entry.key)!.id, 4, 2, '1');
    }
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(store.store.state.radball?.ten?.stage).toBe('SEMIFINALS');

    // Played through: every place filled by a match, nothing to complain about,
    // and the tournament is genuinely complete.
    for (const entry of RADBALL10_FINAL_STRUCTURE) {
      if (entry.matchType.startsWith('PLACEMENT_')) continue;
      playMatch(store, matchOfKey(store.store.state, entry.key)!.id, 4, 2, '1');
    }
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(store.store.state.radball?.ten?.stage).toBe('COMPLETED');
    expect(store.store.state.tournament?.status).toBe('COMPLETED');
  });

  it('reports a place that cannot be filled once nothing is left to play', async () => {
    const store = await createDemo('ten-issues-cancelled');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    // Withdraw the match that decides places 9/10, then play every other one.
    // Nothing can now award 9th or 10th, which is a real hole.
    run(store.store, adminCtx(store.store), (state) => {
      state.matches[matchOfKey(state, 'PLACEMENT_9_10')!.id].state = 'CANCELLED';
    });
    for (const entry of RADBALL10_FINAL_STRUCTURE) {
      if (entry.key === 'PLACEMENT_9_10') continue;
      playMatch(store, matchOfKey(store.store.state, entry.key)!.id, 4, 2, '1');
    }
    const issues = store.store.state.radball?.ten?.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.length > 10)).toBe(true);
    expect(issues.join(' ')).toMatch(/9th\/10th|9th \/ 10th|9 \/ 10/);
    // And the tournament is not claimed complete over the hole.
    expect(store.store.state.tournament?.status).not.toBe('COMPLETED');
  });
});

/* ------------------------------------------------------------------ */
/* TEST 13-16: the dependency chain end to end                           */
/* ------------------------------------------------------------------ */

describe('places 1-10 come out of the matches', () => {
  it('TEST 13: semifinal winners enter the final', async () => {
    const store = await createDemo('ten-final-feed');
    runWholeTournament(store);
    const state = store.store.state;
    const semis = [matchOfKey(state, 'SEMIFINAL_1')!, matchOfKey(state, 'SEMIFINAL_2')!];
    const final = matchOfKey(state, 'FINAL')!;
    expect([final.participantAId, final.participantBId].sort()).toEqual(
      semis.map((match) => match.winnerId).sort(),
    );
  });

  it('TEST 14: semifinal losers enter the third-place match', async () => {
    const store = await createDemo('ten-bronze-feed');
    runWholeTournament(store);
    const state = store.store.state;
    const semis = [matchOfKey(state, 'SEMIFINAL_1')!, matchOfKey(state, 'SEMIFINAL_2')!];
    const bronze = matchOfKey(state, 'THIRD_PLACE')!;
    expect([bronze.participantAId, bronze.participantBId].sort()).toEqual(
      semis.map((match) => match.loserId).sort(),
    );
  });

  it('TEST 15/16: all ten places are assigned exactly once, no team twice', async () => {
    const store = await createDemo('ten-ranking');
    runWholeTournament(store);
    const state = store.store.state;
    const ranking = finalRanking(state);
    expect(ranking).toHaveLength(10);
    // Every place is occupied.
    expect(ranking.every((entry) => entry.teamId !== null)).toBe(true);
    expect(ranking.map((entry) => entry.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Every team occurs exactly once.
    const ids = ranking.map((entry) => entry.teamId);
    expect(new Set(ids).size).toBe(10);
    expect(new Set(ids)).toEqual(new Set(state.participantOrder));
    // No validation issue is left, so the tournament really is complete.
    expect(state.radball?.ten?.issues).toEqual([]);
    expect(state.radball?.ten?.stage).toBe('COMPLETED');
    expect(state.tournament?.status).toBe('COMPLETED');
    // 1st is the winner of the final, 10th the loser of the 9/10 match.
    const final = matchOfKey(state, 'FINAL')!;
    const nine = matchOfKey(state, 'PLACEMENT_9_10')!;
    expect(ranking[0].teamId).toBe(final.winnerId);
    expect(ranking[9].teamId).toBe(nine.loserId);
    // The places reference matches, not a sorted table.
    expect(ranking[4].matchId).toBe(matchOfKey(state, 'PLACEMENT_5_6')!.id);
    expect(ranking[4].source).toBe('PLACEMENT_5_6');
    expect(state.radball?.championId).toBe(ranking[0].teamId);
  });

  it('never marks the tournament complete while a place is missing (§36)', async () => {
    const store = await createDemo('ten-validation');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    // Seven fixtures are created unplayed, so the tournament is mid-final-phase.
    // It is plainly not complete, and it is plainly not broken either: there is an
    // issue to report only once no remaining fixture can award the empty places.
    expect(state.radball?.ten?.stage).not.toBe('COMPLETED');
    expect(state.tournament?.status).not.toBe('COMPLETED');
    expect(state.radball?.ten?.ranking.some((entry) => entry.teamId === null)).toBe(true);
    expect(state.radball?.ten?.issues).toEqual([]);

    // Play everything except the match that decides 9th and 10th.
    run(store.store, adminCtx(store.store), (s) => {
      s.matches[matchOfKey(s, 'PLACEMENT_9_10')!.id].state = 'CANCELLED';
    });
    for (const entry of RADBALL10_FINAL_STRUCTURE) {
      if (entry.key === 'PLACEMENT_9_10') continue;
      playMatch(store, matchOfKey(store.store.state, entry.key)!.id, 4, 2, '1');
    }
    const finished = store.store.state;
    // Nothing is left to play and 9th/10th still have no team: now it is a fault,
    // and the tournament is still not claimed complete.
    expect(finished.radball?.ten?.stage).toBe('COMPLETED');
    expect(finished.radball?.ten?.issues.length).toBeGreaterThan(0);
    expect(finished.tournament?.status).not.toBe('COMPLETED');
  });

  it('a level placement score is settled at the 4-metre line, never a tie (§27)', async () => {
    const store = await createDemo('ten-shootout');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    const nine = matchOfKey(state, 'PLACEMENT_9_10')!;
    run(store.store, adminCtx(store.store), (s, c, m) => {
      assignMatchToField(s, nine.id, '1', c, m);
      startMatch(s, nine.id, '1', c, m);
      updateScore(s, s.matches[nine.id], 'A', 3, c, m);
      updateScore(s, s.matches[nine.id], 'B', 3, c, m);
    });
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        finishMatch(s, { matchId: nine.id, winner: null, force: false }, c, m);
      }),
    ).toThrow(/shootout/i);
    // A converts, B misses twice and A converts again: after the fifth attempt
    // B can no longer catch up, so the shootout is decided.
    for (const [side, shooter, hit] of [
      ['A', 0, true],
      ['B', 0, false],
      ['A', 1, true],
      ['B', 1, false],
      ['A', 0, true],
    ] as ['A' | 'B', number, boolean][]) {
      run(store.store, adminCtx(store.store), (s, c, m) => {
        recordShootoutAttempt(s, nine.id, side, shooter, hit, c, m);
      });
    }
    expect(state.matches[nine.id].radball?.shootout?.decided).toBe(true);
    run(store.store, adminCtx(store.store), (s, c, m) => {
      finishMatch(s, { matchId: nine.id, winner: null, force: false }, c, m);
    });
    const after = store.store.state;
    expect(after.matches[nine.id].winnerId).toBe(nine.participantAId);
    expect(finalRanking(after)[8].teamId).toBe(nine.participantAId);
    expect(finalRanking(after)[9].teamId).toBe(nine.participantBId);
    // Nobody is left sharing a place.
    const placed = finalRanking(after).filter((entry) => entry.teamId !== null);
    expect(new Set(placed.map((entry) => entry.teamId)).size).toBe(placed.length);
  });

  it('the final cannot start before both semifinals are finished', async () => {
    const store = await createDemo('ten-final-lock');
    runWholeTournamentBeforeFinal(store);
    const state = store.store.state;
    const final = matchOfKey(state, 'FINAL')!;
    const semis = [matchOfKey(state, 'SEMIFINAL_1')!, matchOfKey(state, 'SEMIFINAL_2')!];
    // One semifinal is still open.
    expect(semis.some((match) => match.state !== 'FINISHED')).toBe(true);
    expect(() =>
      run(store.store, adminCtx(store.store), (s, _c, _m) => {
        assertFinalPhaseDependency(s, final);
      }),
    ).toThrow(/before/i);
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        assignMatchToField(s, final.id, '2', c, m);
        startMatch(s, final.id, '2', c, m);
      }),
    ).toThrow(/before/i);
  });

  it('the recommended order is the queue order, and the host may change it', async () => {
    const store = await createDemo('ten-order');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const state = store.store.state;
    expect(state.radball?.ten?.final.order).toEqual([
      'PLACEMENT_9_10',
      'PLACEMENT_7_8',
      'PLACEMENT_5_6',
      'SEMIFINAL_1',
      'SEMIFINAL_2',
      'THIRD_PLACE',
      'FINAL',
    ]);
    const tournamentId = state.tournament!.id;
    // The queue really is in that order.
    expect(state.matchOrder.slice(-7).map((id) => state.matches[id].id)).toEqual(
      (state.radball?.ten?.final.order ?? []).map((key) => radball10FinalMatchId(tournamentId, key)),
    );
    // Reordering changes the schedule and nothing else (§25).
    const before = finalRanking(state);
    const flipped: RadballFinalKey[] = [
      'FINAL',
      'SEMIFINAL_2',
      'SEMIFINAL_1',
      'THIRD_PLACE',
      'PLACEMENT_5_6',
      'PLACEMENT_7_8',
      'PLACEMENT_9_10',
    ];
    run(store.store, adminCtx(store.store), (s, _c, m) => {
      setFinalPhaseOrder(s, flipped, m);
    });
    const after = store.store.state;
    expect(after.radball?.ten?.final.order).toEqual(flipped);
    expect(finalRanking(after)).toEqual(before);
    // The final still refuses to start.
    const final = matchOfKey(after, 'FINAL')!;
    expect(() =>
      run(store.store, adminCtx(store.store), (s, _c, _m) => {
        assertFinalPhaseDependency(s, final);
      }),
    ).toThrow(/before/i);
  });
});

/** Preliminary, final phase, placements and semifinal 1 -- but no SF2, bronze or final. */
function runWholeTournamentBeforeFinal(store: TestStore): void {
  playPreliminaryForDemo(store);
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    generateFinalPhase(state, ctx, mut, { confirm: true });
  });
  const keys: RadballFinalKey[] = [
    'PLACEMENT_9_10',
    'PLACEMENT_7_8',
    'PLACEMENT_5_6',
    'SEMIFINAL_1',
  ];
  for (const key of keys) {
    const match = matchOfKey(store.store.state, key);
    if (match && match.state !== 'FINISHED') playMatch(store, match.id, 4, 2, '1');
  }
}

/* ------------------------------------------------------------------ */
/* TEST 17: correction re-derives everything                            */
/* ------------------------------------------------------------------ */

describe('result correction re-derives the competition', () => {
  it('TEST 17: correcting a group result moves the dependent matches with it', async () => {
    const store = await createDemo('ten-correct');
    const state = store.store.state;
    const a = groupTeams(state, 'GROUP_A');
    const b = groupTeams(state, 'GROUP_B');
    // A strict ladder: inside each group the earlier team in draw order beats
    // every later one 4:1, so the group order is exactly the draw order.
    playPreliminary(store, (_index, teamA, teamB) => {
      const rankOf = (id: string) => (a.includes(id) ? a.indexOf(id) : 5 + b.indexOf(id));
      return rankOf(teamA) < rankOf(teamB) ? [4, 1] : [1, 4];
    });
    expect(state.radball?.ten?.rankings[groupId(state, 'GROUP_A')]).toEqual(a);
    run(store.store, adminCtx(store.store), (s, c, m) => {
      generateFinalPhase(s, c, m, { confirm: true });
    });

    // Before the correction the ladder stands: A5 is the Group A bottom team.
    const nine = matchOfKey(state, 'PLACEMENT_9_10')!;
    expect(nine.participantAId).toBe(a[4]);

    // The host corrects the Group A fixture between the bottom two teams so the
    // bottom team wins instead. That swaps 4th and 5th place in the group.
    const swap = preliminaryMatches(state, groupId(state, 'GROUP_A')).find(
      (match) =>
        (match.participantAId === a[3] && match.participantBId === a[4]) ||
        (match.participantAId === a[4] && match.participantBId === a[3]),
    )!;
    replayWith(store, swap.id, a[4], 5, 1, 'Score fixed');

    const ranking = state.radball?.ten?.rankings[groupId(state, 'GROUP_A')] ?? [];
    expect(ranking[3]).toBe(a[4]);
    expect(ranking[4]).toBe(a[3]);

    // No stale participant assignment survives anywhere in the final phase: the
    // 9/10 match now holds the new fifth, the 7/8 match the new fourth -- both
    // re-derived from the corrected table, neither remembered.
    const nineAfter = matchOfKey(state, 'PLACEMENT_9_10')!;
    expect(nineAfter.participantAId).toBe(a[3]);
    const sevenAfter = matchOfKey(state, 'PLACEMENT_7_8')!;
    expect(sevenAfter.participantAId).toBe(a[4]);
    const sf1 = matchOfKey(state, 'SEMIFINAL_1')!;
    expect(sf1.participantAId).toBe(ranking[0]);
    expect(sf1.participantBId).toBe(state.radball?.ten?.rankings[groupId(state, 'GROUP_B')]?.[1]);
    // The published table -- the A1..A5 the UI shows -- moved with it.
    expect(tableOf(state, groupId(state, 'GROUP_A')).map((row) => row.teamId)).toEqual(ranking);
  });

  it('refuses to roll back a group result once a dependent match has been played', async () => {
    const store = await createDemo('ten-correct-guard');
    const state = store.store.state;
    runWholeTournament(store);
    const played = preliminaryMatches(state, groupId(state, 'GROUP_A'))[0];
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        correctScore(s, s.matches[played.id], 5, 5, c, m, 'Too late');
      }),
    ).toThrow(/progressed/i);
  });
});

/* ------------------------------------------------------------------ */
/* TEST 18-19: the two fields                                            */
/* ------------------------------------------------------------------ */

describe('the groups are the field rosters', () => {
  /**
   * The World Cup split, without a split: each team carries the field it is
   * registered on, and that field is its group. `fields` is one entry per team.
   */
  function createWithFields(
    label: string,
    fields: (string | null)[],
    fieldNames: string[] = ['Field 1', 'Field 2'],
  ): Promise<TestStore> {
    const store = makeStore(label);
    return Promise.resolve(store).then(async (made) => {
      run(made.store, adminCtx(made.store), (state, ctx, mut) => {
        createTournament(
          state,
          {
            name: 'Field-group test',
            format: 'radball',
            participants: RADBALL10_DEMO_TEAMS.map((team, index) => ({
              name: team.name,
              team: null,
              seed: null,
              checkedIn: true,
              players: [team.players[0], team.players[1]] as [string, string],
              fieldId: fields[index] ?? null,
            })),
            thirdPlaceMatch: false,
            seeded: true,
            seedValue: 424242,
            settings: null,
            generateBracketNow: true,
            fieldNames,
            radball: { ageCategory: 'ELITE', preset: 'radball-10-team' },
          },
          ctx,
          mut,
        );
      });
      return made;
    });
  }

  const names = (state: TournamentState, key: 'GROUP_A' | 'GROUP_B') =>
    groupTeams(state, key).map((id) => state.participants[id]?.name);

  it('fills Group A from field 1 and Group B from field 2, in registration order', async () => {
    const store = await createWithFields(
      'ten-field-groups',
      RADBALL10_DEMO_TEAMS.map((_, index) => (index < 5 ? '1' : '2')),
    );
    const state = store.store.state;
    expect(names(state, 'GROUP_A')).toEqual(['Team A', 'Team B', 'Team C', 'Team D', 'Team E']);
    expect(names(state, 'GROUP_B')).toEqual(['Team F', 'Team G', 'Team H', 'Team I', 'Team J']);
    // Each group still plays on the field it came from.
    expect(state.radball?.groups[groupId(state, 'GROUP_A')]?.fieldId).toBe('1');
    expect(state.radball?.groups[groupId(state, 'GROUP_B')]?.fieldId).toBe('2');
  });

  it('refuses a team with no home field, because there is no group for it', async () => {
    const fields = RADBALL10_DEMO_TEAMS.map((_, index) => (index === 7 ? null : index < 5 ? '1' : '2'));
    await expect(createWithFields('ten-no-field', fields)).rejects.toThrow(/registered on no playing field/);
  });

  it('refuses a team on a third field: the format has one group per field', async () => {
    const fields = RADBALL10_DEMO_TEAMS.map((_, index) => (index === 9 ? '3' : index < 5 ? '1' : '2'));
    await expect(createWithFields('ten-third-field', fields, ['Field 1', 'Field 2', 'Field 3'])).rejects.toThrow(
      /one group per field/,
    );
  });

  it('refuses two rosters that are not the same size, naming both counts', async () => {
    const fields = RADBALL10_DEMO_TEAMS.map((_, index) => (index < 6 ? '1' : '2'));
    await expect(createWithFields('ten-unequal', fields)).rejects.toThrow(
      /same number of teams in both groups: Field 1 has 6 and Field 2 has 4/,
    );
  });
});

describe('two fields in the preliminary round', () => {
  it('keeps each group in its own queue and never offers it as shared', async () => {
    const store = await createDemo('ten-queue-pinning');
    // The queue panel is derived, not stored, so the assertions run against the
    // same functions the dashboard uses.
    const live = () => store.store.state;
    const fieldQueue = (fieldId: FieldId) =>
      openOf(live()).filter((match) => homeFieldOf(live(), match) === fieldId);
    const sharedQueue = () =>
      openOf(live()).filter((match) => homeFieldOf(live(), match) === null && isPlayable(match));

    // Fresh tournament: ten own fixtures each, nothing shared.
    expect(fieldQueue('1')).toHaveLength(10);
    expect(fieldQueue('2')).toHaveLength(10);
    expect(sharedQueue()).toHaveLength(0);
    for (const match of fieldQueue('1')) {
      expect(match.radball?.groupId).toBe(groupId(live(), 'GROUP_A'));
    }
    for (const match of fieldQueue('2')) {
      expect(match.radball?.groupId).toBe(groupId(live(), 'GROUP_B'));
    }

    // Halfway through: each field still only ever sees its own group.
    const groups = (['GROUP_A', 'GROUP_B'] as const).map((key) => ({
      key,
      fieldId: (key === 'GROUP_A' ? '1' : '2') as FieldId,
      list: preliminaryMatches(live(), groupId(live(), key)),
    }));
    for (let round = 0; round < 5; round += 1) {
      for (const group of groups) playMatch(store, group.list[round].id, 3, 1, group.fieldId);
    }
    expect(fieldQueue('1')).toHaveLength(5);
    expect(fieldQueue('2')).toHaveLength(5);
    expect(sharedQueue()).toHaveLength(0);

    // Preliminary round complete: both queues drain and nothing is shared.
    playPreliminaryForDemo(store);
    expect(fieldQueue('1')).toHaveLength(0);
    expect(fieldQueue('2')).toHaveLength(0);
    expect(sharedQueue()).toHaveLength(0);

    // Final phase generated: the five matches whose teams are known become
    // "either field" -- and only those. The final and the third-place match have
    // no participants yet, so they are not offered at all.
    run(store.store, adminCtx(store.store), (s, c, m) => {
      generateFinalPhase(s, c, m, { confirm: true });
    });
    const shared = sharedQueue();
    expect(shared.map((match) => match.radball?.finalKey).sort()).toEqual([
      'PLACEMENT_5_6',
      'PLACEMENT_7_8',
      'PLACEMENT_9_10',
      'SEMIFINAL_1',
      'SEMIFINAL_2',
    ]);
    // No final-phase match claims a field on its own. The host assigns them.
    expect(fieldQueue('1')).toHaveLength(0);
    expect(fieldQueue('2')).toHaveLength(0);
    // And the two matches waiting on a semifinal are neither queued nor shared.
    const waiting = finalPhaseMatches(live()).filter((match) => !isPlayable(match));
    expect(waiting.map((match) => match.radball?.finalKey).sort()).toEqual(['FINAL', 'THIRD_PLACE']);
    for (const match of waiting) expect(shared).not.toContain(match);
  });

  it('TEST 18: one Group A match and one Group B match run simultaneously', async () => {
    const store = await createDemo('ten-parallel');
    // Start from empty fields so the assertion is about what the scheduler
    // chooses, not about what creation happened to leave behind.
    for (const fieldId of ['1', '2'] as const) {
      if (store.store.state.fields[fieldId].matchId) {
        run(store.store, adminCtx(store.store), (s, c, m) => {
          unassignField(s, fieldId, c, m);
        });
      }
    }
    // Auto-assignment fills Field 1 with a Group A fixture and Field 2 with a
    // Group B one -- the two groups run in parallel by construction.
    run(store.store, adminCtx(store.store), (s, c, m) => {
      autoAssign(s, c, m);
    });
    const after = store.store.state;
    const one = after.fields['1'].matchId;
    const two = after.fields['2'].matchId;
    expect(one).toBeTruthy();
    expect(two).toBeTruthy();
    expect(one).not.toBe(two);
    expect(after.matches[one!].radball?.groupId).toBe(groupId(after, 'GROUP_A'));
    expect(after.matches[two!].radball?.groupId).toBe(groupId(after, 'GROUP_B'));

    // Both start and run at the same time.
    run(store.store, adminCtx(store.store), (s, c, m) => {
      startMatch(s, one!, '1', c, m);
      startMatch(s, two!, '2', c, m);
    });
    expect(store.store.state.matches[one!].state).toBe('RUNNING');
    expect(store.store.state.matches[two!].state).toBe('RUNNING');
  });

  it('TEST 19: a team can never be active on both fields', async () => {
    const store = await createDemo('ten-double-book');
    const state = store.store.state;
    const team = groupTeams(state, 'GROUP_A')[0];
    const own = preliminaryMatches(state, groupId(state, 'GROUP_A')).filter(
      (match) => match.participantAId === team || match.participantBId === team,
    );
    run(store.store, adminCtx(store.store), (s, c, m) => {
      assignMatchToField(s, own[0].id, '1', c, m);
      startMatch(s, own[0].id, '1', c, m);
    });
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, m) => {
        assignMatchToField(s, own[1].id, '2', c, m);
      }),
    ).toThrow(/two fields/i);
    expect(teamBusyOnOtherField(state, team, '2')?.id).toBe(own[0].id);
  });
});

/* ------------------------------------------------------------------ */
/* TEST 20: persistence                                                 */
/* ------------------------------------------------------------------ */

describe('restart persistence', () => {
  it('TEST 20: restarting the server does not destroy the tournament state', async () => {
    const store = await createDemo('ten-restart');
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    for (const key of ['PLACEMENT_9_10', 'PLACEMENT_7_8', 'PLACEMENT_5_6', 'SEMIFINAL_1'] as RadballFinalKey[]) {
      const match = matchOfKey(store.store.state, key);
      if (match && match.state !== 'FINISHED') playMatch(store, match.id, 4, 2, '1');
    }
    const dir = store.dir;
    await store.store.flush();
    await store.store.adapter.close();

    const reopened = await TournamentStore.open(dir);
    const after = reopened.state;
    expect(after.tournament?.format).toBe('radball');
    expect(after.radball?.system).toBe('radball-10-team');
    // One semifinal done, the second still open: the stage says so.
    expect(after.radball?.ten?.stage).toBe('SEMIFINALS');
    expect(after.radball?.groups[groupId(after, 'GROUP_A')].fieldId).toBe('1');
    expect(after.radball?.groups[groupId(after, 'GROUP_B')].fieldId).toBe('2');
    // The dependency references survived as references, not as frozen names.
    const final = matchOfKey(after, 'FINAL')!;
    expect(final.slotA.kind).toBe('winner-of');
    expect(final.slotB.kind).toBe('winner-of');
    // And the engine still agrees with them after a full re-derivation.
    const ctx = reopened.createContext('Host', 'admin', null);
    run(reopened, ctx, (state, c, m) => {
      rebuild(state, c, m);
    });
    expect(finalRanking(reopened.state)).toEqual(finalRanking(after));
    await reopened.flush();
    await reopened.adapter.close();
  });
});

/* ------------------------------------------------------------------ */
/* Reset                                                               */
/* ------------------------------------------------------------------ */

describe('explicit reset', () => {
  it('releases the groups, un-confirms the final phase and keeps the structure', async () => {
    const store = await createDemo('ten-reset');
    runWholeTournament(store);
    expect(store.store.state.radball?.ten?.stage).toBe('COMPLETED');

    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      resetTournament(state, ctx, mut);
    });

    const state = store.store.state;
    const ten = state.radball?.ten;
    // Every result is gone, and with it the published positions: a ranking is
    // only published once its group is complete, so nothing can feed the final
    // phase from a table that is still being played.
    expect(ten?.rankings[groupId(state, 'GROUP_A')]).toEqual([]);
    expect(ten?.groupFrozen[groupId(state, 'GROUP_A')]).toBe(false);
    expect(ten?.stage).toBe('GROUP_PHASE');
    expect(ten?.final.status).toBe('PENDING');
    expect(ten?.final.confirmed).toBe(false);
    expect(finalRanking(state).every((entry) => entry.teamId === null)).toBe(true);
    expect(state.tournament?.status).toBe('RUNNING');
    expect(state.tournament?.championId).toBeNull();
    // The seven final-phase matches survive as unplayed matches, so the format
    // itself is not something a reset has to rebuild.
    expect(finalPhaseMatches(state)).toHaveLength(RADBALL10_FINAL_MATCHES);
    for (const match of finalPhaseMatches(state)) {
      expect(match.state).toBe('WAITING');
      expect(match.participantAId).toBeNull();
      expect(match.participantBId).toBeNull();
    }
    // And the final phase can be generated again from scratch: the placement
    // matches, which only need the group tables, are playable again. The final
    // stays empty on purpose -- its feeders are two unplayed semifinals.
    playPreliminaryForDemo(store);
    run(store.store, adminCtx(store.store), (s, c, m) => {
      generateFinalPhase(s, c, m, { confirm: true });
    });
    expect(matchOfKey(store.store.state, 'PLACEMENT_9_10')?.participantAId).toBeTruthy();
    expect(matchOfKey(store.store.state, 'SEMIFINAL_1')?.participantAId).toBeTruthy();
    expect(matchOfKey(store.store.state, 'FINAL')?.participantAId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Demo                                                                */
/* ------------------------------------------------------------------ */

describe('the demo tournament', () => {
  it('runs the whole documented structure and lands exactly ten places', async () => {
    const store = await createDemo('ten-demo-run');
    const state = store.store.state;
    expect(state.participantOrder).toHaveLength(10);
    expect(state.radball?.system).toBe('radball-10-team');
    // Group A is the first five demo teams, Group B the rest.
    expect(groupTeams(state, 'GROUP_A').map((id) => state.participants[id].name)).toEqual([
      'Team A',
      'Team B',
      'Team C',
      'Team D',
      'Team E',
    ]);
    expect(groupTeams(state, 'GROUP_B').map((id) => state.participants[id].name)).toEqual([
      'Team F',
      'Team G',
      'Team H',
      'Team I',
      'Team J',
    ]);

    runWholeTournament(store);
    const ranking = finalRanking(store.store.state);
    expect(ranking).toHaveLength(10);
    expect(new Set(ranking.map((entry) => entry.teamId)).size).toBe(10);
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    // 20 + 7 = 27 matches, and nothing else was created on the way.
    expect(Object.values(store.store.state.matches)).toHaveLength(RADBALL10_TOTAL_MATCHES);
  });
});

/* ------------------------------------------------------------------ */
/* The state machine                                                    */
/* ------------------------------------------------------------------ */

describe('tournament state machine', () => {
  it('walks the nine states in order and never skips one', async () => {
    const store = await createDemo('ten-stages');
    const seen: string[] = [];
    const stage = () => store.store.state.radball?.ten?.stage;

    expect(stage()).toBe('GROUP_PHASE');
    seen.push(stage() as string);

    playPreliminaryForDemo(store);
    expect(stage()).toBe('GROUP_PHASE_COMPLETE');
    seen.push(stage() as string);

    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    expect(stage()).toBe('FINAL_PHASE_READY');
    seen.push(stage() as string);

    await playKey(store, 'PLACEMENT_9_10');
    expect(stage()).toBe('PLACEMENT_MATCHES');
    await playKey(store, 'PLACEMENT_7_8');
    await playKey(store, 'PLACEMENT_5_6');
    seen.push('PLACEMENT_MATCHES');

    await playKey(store, 'SEMIFINAL_1');
    expect(stage()).toBe('SEMIFINALS');
    seen.push('SEMIFINALS');
    await playKey(store, 'SEMIFINAL_2');
    // Both semifinals done, the bronze match untouched.
    expect(stage()).toBe('THIRD_PLACE');
    seen.push('THIRD_PLACE');

    await playKey(store, 'THIRD_PLACE');
    expect(stage()).toBe('FINAL');
    seen.push('FINAL');

    await playKey(store, 'FINAL');
    expect(stage()).toBe('COMPLETED');
    seen.push('COMPLETED');

    expect(seen).toEqual([
      'GROUP_PHASE',
      'GROUP_PHASE_COMPLETE',
      'FINAL_PHASE_READY',
      'PLACEMENT_MATCHES',
      'SEMIFINALS',
      'THIRD_PLACE',
      'FINAL',
      'COMPLETED',
    ]);
    // Every stage the requirement names is reachable; SETUP is the pre-start one.
    expect(seen).toContain('GROUP_PHASE_COMPLETE');
  });
});

async function playKey(store: TestStore, key: RadballFinalKey): Promise<void> {
  const match = matchOfKey(store.store.state, key);
  if (!match) throw new Error(`no ${key}`);
  if (match.state === 'FINISHED') return;
  playMatch(store, match.id, 4, 2, '1');
}

/* ------------------------------------------------------------------ */
/* Standings                                                            */
/* ------------------------------------------------------------------ */

describe('group standings', () => {
  it('is computed from the results with 3/1/0, never entered', async () => {
    const store = await createDemo('ten-standings');
    const state = store.store.state;
    const a = groupTeams(state, 'GROUP_A');
    const first = preliminaryMatches(state, groupId(state, 'GROUP_A')).find(
      (match) => match.participantAId === a[0] || match.participantBId === a[0],
    )!;
    playMatch(store, first.id, 3, 1, '1');
    const rows = tableOf(state, groupId(state, 'GROUP_A'));
    const winner = first.participantAId === a[0] ? a[0] : first.participantBId!;
    const loser = winner === a[0] ? first.participantBId! : first.participantAId!;
    expect(rows.find((row) => row.teamId === winner)?.points).toBe(3);
    expect(rows.find((row) => row.teamId === loser)?.points).toBe(0);
    expect(rows.find((row) => row.teamId === winner)?.goalsFor).toBe(3);
    expect(rows.find((row) => row.teamId === winner)?.goalDiff).toBe(2);
    // The columns the requirement asks for are all present and derived.
    for (const row of rows) {
      expect(row.goalDiff).toBe(row.goalsFor - row.goalsAgainst);
      expect(row.played).toBe(row.won + row.drawn + row.lost);
    }
    for (const id of [winner, loser]) {
      const row = rows.find((entry) => entry.teamId === id)!;
      expect(row.played).toBe(1);
      expect(row.rank).toBeGreaterThanOrEqual(1);
      expect(row.rank).toBeLessThanOrEqual(5);
    }
  });

  it('a level group match is a draw worth one point to each team', async () => {
    const store = await createDemo('ten-draw');
    const state = store.store.state;
    const first = preliminaryMatches(state)[0];
    playMatch(store, first.id, 2, 2, fieldOfGroupMatch(store, first));
    const rows = tableOf(state, groupId(state, 'GROUP_A'));
    for (const id of [first.participantAId, first.participantBId]) {
      expect(rows.find((row) => row.teamId === id)?.points).toBe(1);
      expect(rows.find((row) => row.teamId === id)?.drawn).toBe(1);
    }
  });

  it('freezes each group ranking when all ten of its fixtures are done', async () => {
    const store = await createDemo('ten-freeze');
    playPreliminaryForDemo(store);
    const state = store.store.state;
    const ten = state.radball?.ten;
    expect(ten?.groupFrozen[groupId(state, 'GROUP_A')]).toBe(true);
    expect(ten?.groupFrozen[groupId(state, 'GROUP_B')]).toBe(true);
    expect(ten?.stage).toBe('GROUP_PHASE_COMPLETE');
    // A1-A5 and B1-B5 are the published positions, not the seed order.
    for (const key of ['GROUP_A', 'GROUP_B'] as const) {
      const ranking = ten?.rankings[groupId(state, key)] ?? [];
      expect(ranking).toHaveLength(5);
      expect(new Set(ranking)).toEqual(new Set(groupTeams(state, key)));
    }
  });
});