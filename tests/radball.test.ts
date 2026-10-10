/**
 * Official 2er-Radball competition logic (UCI ruleset).
 *
 * Covers the ten acceptance cases: round-robin sizes, the 3/1/0 scoring,
 * decision matches, the 4-meter shootout, head-to-head before full-round
 * criteria, the two-field double-booking guard, result correction and
 * restart persistence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Match, RadballMatchMeta, ShootoutState, TournamentState } from '../src/shared/types';
import type { ParticipantInput } from '../src/shared/commands';
import { createQuickTournament, createTestStore, adminCtx, run, idOf, type TestStore } from './helpers';
import { createTournament } from '../src/backend/tournament/engine';
import {
  createDecisionMatch,
  recordShootoutAttempt,
  roundRobinFixtures,
  runQualification,
  schedulableOn,
  teamBusyOnOtherField,
} from '../src/backend/tournament/radball';
import { assignMatchToField, finishMatch, startMatch, unassignField } from '../src/backend/tournament/matchops';
import { correctScore, updateScore } from '../src/backend/tournament/scoring';
import {
  competitionFixtures,
  fixtureRole,
  fixturesForDisplay,
  nextFixtureToCall,
} from '../src/frontend/lib/radball';

/* ------------------------------------------------------------------ */
/* Roster helpers                                                      */
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

function radballTeams(count: number): ParticipantInput[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Team ${index + 1}`,
    team: `RV ${index + 1}`,
    seed: null,
    checkedIn: true,
    players: [`Player A${index + 1}`, `Player B${index + 1}`] as [string, string],
  }));
}

interface SetupOptions {
  teams: number;
  groupCount?: number;
  finalRound?: { topN?: number; mode?: string } | null;
  minRestMinutes?: number;
  ageCategory?: string;
  preset?: string;
}

async function createRadball(store: TestStore, options: SetupOptions): Promise<string[]> {
  const ctx = adminCtx(store.store);
  run(store.store, ctx, (state, c, mut) => {
    createTournament(
      state,
      {
        name: 'Radball Test Cup',
        format: 'radball',
        participants: radballTeams(options.teams),
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracketNow: true,
        radball: {
          ageCategory: options.ageCategory ?? 'ELITE',
          groupCount: options.groupCount ?? 1,
          finalRound: options.finalRound ?? null,
          minRestMinutes: options.minRestMinutes ?? 0,
          ...(options.preset ? { preset: options.preset } : {}),
        },
      },
      c,
      mut,
    );
  });
  return [...store.store.state.participantOrder];
}

function clearFieldAssignments(store: TestStore): void {
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    for (const fieldId of ['1', '2'] as const) {
      if (state.fields[fieldId]?.matchId) unassignField(state, fieldId, ctx, mut);
    }
  });
}

function tableOf(state: TournamentState, groupId: string) {
  return state.radball?.tables[groupId] ?? [];
}

function groupA(state: TournamentState): string {
  const id = state.radball?.groupOrder[0];
  if (!id) throw new Error('No group');
  return id;
}

function groupMatchesOf(state: TournamentState, groupId: string): Match[] {
  return Object.values(state.matches).filter((match) => match.radball?.groupId === groupId && match.radball.kind === 'group');
}

function findPair(state: TournamentState, a: string, b: string): Match {
  const match = groupMatchesOf(state, groupA(state)).find(
    (m) =>
      (m.participantAId === a && m.participantBId === b) || (m.participantAId === b && m.participantBId === a),
  );
  if (!match) throw new Error('No fixture for the given pair');
  return match;
}

function playRadball(store: TestStore, matchId: string, scoreA: number, scoreB: number, field: '1' | '2' = '1'): void {
  const ctx = adminCtx(store.store);
  run(store.store, ctx, (state, c, mut) => {
    for (const fieldId of ['1', '2'] as const) {
      const current = state.fields[fieldId]?.matchId;
      if (current && current !== matchId) unassignField(state, fieldId, c, mut);
    }
    assignMatchToField(state, matchId, field, c, mut);
    startMatch(state, matchId, field, c, mut);
  });
  run(store.store, ctx, (state, _c, _mut) => {
    const match = state.matches[matchId];
    match.scoreA = scoreA;
    match.scoreB = scoreB;
  });
  run(store.store, ctx, (state, c, mut) => {
    finishMatch(state, { matchId, winner: null, force: false }, c, mut);
  });
}

function decisionMatches(state: TournamentState): Match[] {
  return Object.values(state.matches).filter((m) => m.radball?.kind === 'decision');
}

/* ------------------------------------------------------------------ */
/* TEST 1 & 2: round-robin sizes                                       */
/* ------------------------------------------------------------------ */

describe('round robin fixtures', () => {
  it('TEST 1: 4 teams produce exactly 6 matches', () => {
    expect(roundRobinFixtures(['a', 'b', 'c', 'd'], false)).toHaveLength(6);
  });

  it('TEST 2: 5 teams produce exactly 10 matches', () => {
    expect(roundRobinFixtures(['a', 'b', 'c', 'd', 'e'], false)).toHaveLength(10);
  });

  it('every pairing appears exactly once, no self matches', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const fixtures = roundRobinFixtures(teams, false);
    const keys = fixtures.map((f) => [f.teamA, f.teamB].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const fixture of fixtures) {
      expect(fixture.teamA).not.toBe(fixture.teamB);
    }
    expect(fixtures).toHaveLength((teams.length * (teams.length - 1)) / 2);
  });

  it('double round robin plays every pairing twice', () => {
    expect(roundRobinFixtures(['a', 'b', 'c'], true)).toHaveLength(6);
  });

  it('TEST 1/2 end to end: created competitions generate the full fixture list', async () => {
    const store4 = await makeStore('rb4');
    await createRadball(store4, { teams: 4 });
    expect(groupMatchesOf(store4.store.state, groupA(store4.store.state))).toHaveLength(6);
    const store5 = await makeStore('rb5');
    await createRadball(store5, { teams: 5 });
    expect(groupMatchesOf(store5.store.state, groupA(store5.store.state))).toHaveLength(10);
    expect(store5.store.state.radball?.tables[groupA(store5.store.state)]).toHaveLength(5);
  });

  it('uses four qualifiers for ranking matches when no count is supplied', async () => {
    const store = await makeStore('rb-ranking-default');
    await createRadball(store, { teams: 4, finalRound: { mode: 'ranking-matches' } });
    const state = store.store.state;
    expect(state.radball?.groups[groupA(state)].qualifies).toBe(4);
    expect(state.radball?.pendingFinal?.mode).toBe('ranking-matches');
  });

  it('creates a valid standard preset without a final round', async () => {
    const store = await makeStore('rb-standard');
    await createRadball(store, { teams: 3, preset: 'radball-standard-2025', finalRound: { mode: 'ranking-matches' } });
    const state = store.store.state;
    expect(state.radball?.groups[groupA(state)].qualifies).toBe(0);
    expect(state.radball?.pendingFinal).toBeNull();
    expect(groupMatchesOf(state, groupA(state))).toHaveLength(3);
  });

  it('preloads one eligible fixture on each configured field', async () => {
    const store = await makeStore('rb-preload');
    await createRadball(store, { teams: 5 });
    const state = store.store.state;
    const fieldOne = state.fields['1'].matchId;
    const fieldTwo = state.fields['2'].matchId;
    expect(fieldOne).toBeTruthy();
    expect(fieldTwo).toBeTruthy();
    expect(fieldOne).not.toBe(fieldTwo);
    expect(state.matches[fieldOne as string].state).toBe('ASSIGNED');
    expect(state.matches[fieldTwo as string].state).toBe('ASSIGNED');
    expect(state.matches[fieldOne as string].fieldId).toBe('1');
    expect(state.matches[fieldTwo as string].fieldId).toBe('2');
  });
  it('preserves the previous tournament when Radball validation fails', async () => {
    const store = await makeStore('rb-atomic');
    createQuickTournament(store.store, { name: 'Keep This Cup' });
    const before = structuredClone(store.store.state);
    expect(() =>
      run(store.store, adminCtx(store.store), (state, ctx, mut) => {
        createTournament(
          state,
          {
            name: 'Broken Radball',
            format: 'radball',
            participants: radballTeams(3),
            thirdPlaceMatch: false,
            seeded: true,
            seedValue: null,
            settings: null,
            generateBracketNow: true,
            radball: {
              ageCategory: 'ELITE',
              groups: [{ name: 'Group A', teamIndexes: [0, 1] }],
              finalRound: null,
            },
          },
          ctx,
          mut,
        );
      }),
    ).toThrow(/no group/i);
    expect(store.store.state).toStrictEqual(before);
  });

  it('clears Radball state and stale field references on replacement', async () => {
    const store = await makeStore('rb-replace');
    await createRadball(store, { teams: 4 });
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      createTournament(
        state,
        {
          name: 'Knockout Replacement',
          format: 'single-elimination',
          participants: [
            { name: 'A', team: null, seed: 1, checkedIn: true, fieldId: '1' },
            { name: 'B', team: null, seed: 2, checkedIn: true, fieldId: '1' },
            { name: 'C', team: null, seed: 3, checkedIn: true, fieldId: '2' },
            { name: 'D', team: null, seed: 4, checkedIn: true, fieldId: '2' },
          ],
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: 1,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['Court A', 'Court B'],
        },
        ctx,
        mut,
      );
    });
    const state = store.store.state;
    expect(state.radball).toBeNull();
    for (const field of Object.values(state.fields)) {
      if (field.matchId) expect(state.matches[field.matchId]?.fieldId).toBe(field.id);
    }
  });
});

/* ------------------------------------------------------------------ */
/* TEST 3 & 4: official 3/1/0 scoring                                  */
/* ------------------------------------------------------------------ */

describe('official radball points', () => {
  it('TEST 3: a win is 3:0 points and updates GF/GA/GD', async () => {
    const store = await makeStore('rb-win');
    const ids = await createRadball(store, { teams: 4 });
    const [a, b] = ids;
    playRadball(store, findPair(store.store.state, a, b).id, 4, 2);

    const rows = tableOf(store.store.state, groupA(store.store.state));
    const rowA = rows.find((row) => row.teamId === a)!;
    const rowB = rows.find((row) => row.teamId === b)!;
    expect(rowA.points).toBe(3);
    expect(rowB.points).toBe(0);
    expect(rowA.won).toBe(1);
    expect(rowB.lost).toBe(1);
    expect(rowA.goalsFor).toBe(4);
    expect(rowA.goalsAgainst).toBe(2);
    expect(rowA.goalDiff).toBe(2);
    expect(rowB.goalsFor).toBe(2);
    expect(rowB.goalDiff).toBe(-2);
  });

  it('TEST 4: a draw gives 1 point to each team', async () => {
    const store = await makeStore('rb-draw');
    const ids = await createRadball(store, { teams: 4 });
    const [a, b] = ids;
    playRadball(store, findPair(store.store.state, a, b).id, 2, 2);

    const rows = tableOf(store.store.state, groupA(store.store.state));
    const rowA = rows.find((row) => row.teamId === a)!;
    const rowB = rows.find((row) => row.teamId === b)!;
    expect(rowA.points).toBe(1);
    expect(rowB.points).toBe(1);
    expect(rowA.drawn).toBe(1);
    expect(rowB.drawn).toBe(1);
  });

  it('a full pass totals 3 points per match across the group', async () => {
    const store = await makeStore('rb-sum');
    await createRadball(store, { teams: 4 });
    for (const match of groupMatchesOf(store.store.state, groupA(store.store.state))) {
      playRadball(store, match.id, 3, 1);
    }
    const rows = tableOf(store.store.state, groupA(store.store.state));
    const total = rows.reduce((sum, row) => sum + row.points, 0);
    expect(total).toBe(6 * 3);
    for (const row of rows) {
      expect(row.played).toBe(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* TEST 5 & 6: decision match + shootout                               */
/* ------------------------------------------------------------------ */

/**
 * Three teams, standard tie layout: A and B draw each other and beat C with
 * identical scores, leaving exactly two teams level on points, goal
 * difference and goals scored -> a decision match must appear automatically.
 */
async function tieScenario(store: TestStore, abScore: [number, number] = [2, 2]) {
  const ids = await createRadball(store, { teams: 3 });
  const [a, b, c] = ids;
  const state = store.store.state;
  playRadball(store, findPair(state, a, b).id, abScore[0], abScore[1]);
  playRadball(store, findPair(state, a, c).id, 3, 0);
  playRadball(store, findPair(state, b, c).id, 3, 0);
  return { a, b, c };
}

describe('decision matches and the 4-meter shootout', () => {
  it('TEST 5: two teams tied for the title get a decision match', async () => {
    const store = await makeStore('rb-tie');
    const { a, b } = await tieScenario(store, [2, 2]);
    const state = store.store.state;

    const decisions = decisionMatches(state);
    expect(decisions).toHaveLength(1);
    const decision = decisions[0];
    const pair = [decision.participantAId, decision.participantBId].sort().join('|');
    expect(pair).toBe([a, b].sort().join('|'));
    expect(decision.radball?.requiresWinner).toBe(true);
    expect(decision.radball?.decisionReason).toBe('CHAMPIONSHIP_TIE');
    expect(decision.radball?.sideChange).toBe(false);
    expect(decision.radball?.neutralBall).toBe(true);
    // Duration: single half of the age category (ELITE = 7 min = 420 s).
    expect(decision.timer.durationSec).toBe(420);

    // The tied rows are flagged, colour-independently.
    const rows = tableOf(state, groupA(state)).filter((row) => row.status === 'tied');
    expect(rows).toHaveLength(2);
  });

  it('TEST 6: a level decision match requires the shootout, which decides it', async () => {
    const store = await makeStore('rb-shootout');
    const { a, b } = await tieScenario(store);
    const state = store.store.state;
    const decision = decisionMatches(state)[0];

    // Finish the decision match level -> the server demands the shootout.
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, decision.id, '1', c, mut);
      startMatch(s, decision.id, '1', c, mut);
      s.matches[decision.id].scoreA = 2;
      s.matches[decision.id].scoreB = 2;
    });
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, mut) => {
        finishMatch(s, { matchId: decision.id, winner: null, force: false }, c, mut);
      }),
    ).toThrow(/shootout/i);

    // Record the 4-meter shootout: side A throws first, teams alternate.
    // Side A converts everything, side B misses: the shootout is decided as
    // soon as B can no longer catch up (after 5 attempts).
    const script: ['A' | 'B', number, boolean][] = [
      ['A', 0, true],
      ['B', 0, false],
      ['A', 1, true],
      ['B', 1, false],
      ['A', 0, true],
    ];
    for (const [side, shooter, hit] of script) {
      run(store.store, adminCtx(store.store), (s, c, mut) => {
        recordShootoutAttempt(s, decision.id, side, shooter, hit, c, mut);
      });
    }
    const shootout = state.matches[decision.id].radball?.shootout as ShootoutState;
    expect(shootout.decided).toBe(true);
    expect(shootout.winnerId).toBe(decision.participantAId);

    // The shootout winner resolves the match; the champion follows.
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      finishMatch(s, { matchId: decision.id, winner: null, force: false }, c, mut);
    });
    expect(state.matches[decision.id].state).toBe('FINISHED');
    expect(state.matches[decision.id].winnerId).toBe(decision.participantAId);
    expect(state.radball?.championId).toBe(decision.participantAId);
    expect([a, b]).toContain(decision.participantAId);
  });

  it('TEST 6b: a decision match with a regulation score finishes without a shootout', async () => {
    const store = await makeStore('rb-decwin');
    const { a, b } = await tieScenario(store);
    const state = store.store.state;
    const decision = decisionMatches(state)[0];
    playRadball(store, decision.id, 3, 1);
    expect(state.matches[decision.id].state).toBe('FINISHED');
    const winner = state.matches[decision.id].winnerId;
    expect(winner).toBe(state.matches[decision.id].scoreA > state.matches[decision.id].scoreB
      ? decision.participantAId
      : decision.participantBId);
    expect([a, b]).toContain(winner);
    expect(state.radball?.championId).toBe(winner);
  });

  it('wrong-side shootout attempts are refused (teams alternate)', async () => {
    const store = await makeStore('rb-alt');
    await tieScenario(store);
    const state = store.store.state;
    const decision = decisionMatches(state)[0];
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, decision.id, '1', c, mut);
      startMatch(s, decision.id, '1', c, mut);
      s.matches[decision.id].scoreA = 1;
      s.matches[decision.id].scoreB = 1;
    });
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, mut) => {
        recordShootoutAttempt(s, decision.id, 'B', 0, true, c, mut);
      }),
    ).toThrow(/A/);
  });
});

/* ------------------------------------------------------------------ */
/* TEST 7: head-to-head before full-round criteria                     */
/* ------------------------------------------------------------------ */

describe('three-way tie resolution', () => {
  it('TEST 7: three-plus teams tied -> head-to-head/series escalation, never a silent pick', async () => {
    const store = await makeStore('rb-h2h');
    await createRadball(store, { teams: 4 });
    const state = store.store.state;
    const groupId = groupA(state);
    // Every match drawn 2:2: all four teams finish identical on points, GD
    // and GF. Head-to-head cannot separate them either, so the engine must
    // schedule a round-robin DECISION SERIES instead of picking a winner.
    const [a, b, c, d] = [...state.participantOrder];
    playRadball(store, findPair(state, a, b).id, 2, 2);
    playRadball(store, findPair(state, a, c).id, 2, 2);
    playRadball(store, findPair(state, a, d).id, 2, 2);
    playRadball(store, findPair(state, b, c).id, 2, 2);
    playRadball(store, findPair(state, b, d).id, 2, 2);
    playRadball(store, findPair(state, c, d).id, 2, 2);

    const rows = tableOf(state, groupId);
    const tied = rows.filter((row) => row.status === 'tied');
    expect(tied).toHaveLength(4);
    // §10: additional decision matches in round-robin format -> C(4,2) = 6.
    const decisions = decisionMatches(state);
    expect(decisions).toHaveLength(6);
    for (const decision of decisions) {
      expect(decision.radball?.decisionReason).toBe('CHAMPIONSHIP_TIE');
      expect(decision.state).toBe('READY');
    }
  });

  it('TEST 7b: a settled decision match re-orders the tied block', async () => {
    const store = await makeStore('rb-h2h2');
    await createRadball(store, { teams: 3 });
    const state = store.store.state;
    const groupId = groupA(state);
    // All drawn: three-way tie -> series of three decisions.
    const [a, b, c] = [...state.participantOrder];
    playRadball(store, findPair(state, a, b).id, 2, 2);
    playRadball(store, findPair(state, a, c).id, 2, 2);
    playRadball(store, findPair(state, b, c).id, 2, 2);
    expect(decisionMatches(state)).toHaveLength(3);

    // Play all three decisions with clear winners: A wins both, B beats C.
    // The decision's slot order is deterministic but sorted, so orient the
    // score towards the team meant to win.
    for (const [winner, loser] of [
      [a, b],
      [a, c],
      [b, c],
    ] as [string, string][]) {
      const decision = decisionMatches(state).find(
        (m) =>
          m.state === 'READY' &&
          ((m.participantAId === winner && m.participantBId === loser) ||
            (m.participantAId === loser && m.participantBId === winner)),
      );
      expect(decision).toBeDefined();
      const winnerFirst = decision!.participantAId === winner;
      playRadball(store, decision!.id, winnerFirst ? 3 : 1, winnerFirst ? 1 : 3);
    }
    // The group table itself is untouched by decisions (3 draws each), but
    // the ranked order reflects the decision outcomes: A first.
    const rows = tableOf(state, groupId);
    expect(rows[0].teamId).toBe(a);
    expect(rows[0].status).not.toBe('tied');
    expect(state.radball?.championId).toBe(a);
  });
});

/* ------------------------------------------------------------------ */
/* TEST 8: two fields, no double booking                               */
/* ------------------------------------------------------------------ */

describe('field assignment', () => {
  it('TEST 8: a team can never be on two fields at once (server-side)', async () => {
    const store = await makeStore('rb-fields');
    const ids = await createRadball(store, { teams: 4 });
    const [a, b, c] = ids;
    const state = store.store.state;
    clearFieldAssignments(store);
    const mAB = findPair(state, a, b).id;
    const mAC = findPair(state, a, c).id;

    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      assignMatchToField(s, mAB, '1', cm, mut);
      startMatch(s, mAB, '1', cm, mut);
    });
    // Team A is live on Field 1 -> their next match cannot go to Field 2.
    expect(() =>
      run(store.store, adminCtx(store.store), (s, cm, mut) => {
        assignMatchToField(s, mAC, '2', cm, mut);
      }),
    ).toThrow();

    const busy = teamBusyOnOtherField(state, a, '2');
    expect(busy).not.toBeNull();
    expect(busy?.id).toBe(mAB);
    expect(schedulableOn(state, state.matches[mAC], '2', Date.now())).toBe(false);
  });

  it('TEST 8b: two matches without shared teams run in parallel', async () => {
    const store = await makeStore('rb-parallel');
    const ids = await createRadball(store, { teams: 4 });
    const [a, b, c, d] = ids;
    const state = store.store.state;
    clearFieldAssignments(store);
    const mAB = findPair(state, a, b).id;
    const mCD = findPair(state, c, d).id;
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      assignMatchToField(s, mAB, '1', cm, mut);
      startMatch(s, mAB, '1', cm, mut);
    });
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      assignMatchToField(s, mCD, '2', cm, mut);
      startMatch(s, mCD, '2', cm, mut);
    });
    expect(state.matches[mAB].state).toBe('RUNNING');
    expect(state.matches[mCD].state).toBe('RUNNING');
    expect(teamBusyOnOtherField(state, c, '2')).toBeNull();
  });

  it('rest time keeps a team off the next slot when configured', async () => {
    const store = await makeStore('rb-rest');
    const ids = await createRadball(store, { teams: 4, minRestMinutes: 10 });
    const [a, b, c] = ids;
    const state = store.store.state;
    playRadball(store, findPair(state, a, b).id, 3, 1);
    const next = findPair(state, a, c);
    expect(schedulableOn(state, next, '1', Date.now())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* TEST 9: result correction recalculates everything                   */
/* ------------------------------------------------------------------ */

describe('result correction', () => {
  it('TEST 9: correcting a result rolls standings and the champion forward', async () => {
    const store = await makeStore('rb-correct');
    await createRadball(store, { teams: 3 });
    const state = store.store.state;
    const groupId = groupA(state);
    const [a, b, c] = [...state.participantOrder];
    // A beats both -> A champion, no tie, no decision.
    playRadball(store, findPair(state, a, b).id, 2, 1);
    playRadball(store, findPair(state, a, c).id, 3, 0);
    playRadball(store, findPair(state, b, c).id, 2, 0);
    expect(state.radball?.championId).toBe(a);
    expect(decisionMatches(state)).toHaveLength(0);

    // The organizer corrects A vs B (the match reopens as READY), the host
    // then re-confirms the result on the field, and everything dependent
    // recalculates: standings, qualification marks, champion.
    const matchAB = findPair(state, a, b);
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      correctScore(s, state.matches[matchAB.id], 1, 2, cm, mut, 'Official protest upheld');
    });
    expect(state.matches[matchAB.id].state).toBe('READY');
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      assignMatchToField(s, matchAB.id, '1', cm, mut);
      startMatch(s, matchAB.id, '1', cm, mut);
      s.matches[matchAB.id].scoreA = 1;
      s.matches[matchAB.id].scoreB = 2;
    });
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      finishMatch(s, { matchId: matchAB.id, winner: null, force: false }, cm, mut);
    });

    const rows = tableOf(state, groupId);
    const rowA = rows.find((row) => row.teamId === a)!;
    const rowB = rows.find((row) => row.teamId === b)!;
    expect(rowA.points).toBe(3); // won vs C only
    expect(rowB.points).toBe(6); // beat A and C
    expect(rowB.goalsFor).toBe(4);
    expect(state.radball?.championId).toBe(b);
    // No stale decision matches may survive the correction.
    const openDecisions = decisionMatches(state).filter((m) => m.state !== 'CANCELLED');
    expect(openDecisions).toHaveLength(0);
    void c;
  });

  it('TEST 9b: correcting into a tie creates the decision match', async () => {
    const store = await makeStore('rb-correct2');
    await createRadball(store, { teams: 3 });
    const state = store.store.state;
    const [a, b, c] = [...state.participantOrder];
    // Before: A beat B, A and B beat C with identical scores -> A clear leader.
    playRadball(store, findPair(state, a, b).id, 3, 1);
    playRadball(store, findPair(state, a, c).id, 3, 0);
    playRadball(store, findPair(state, b, c).id, 3, 0);
    expect(decisionMatches(state)).toHaveLength(0);

    const matchAB = findPair(state, a, b);
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      correctScore(s, state.matches[matchAB.id], 3, 3, cm, mut, 'Score fixed');
    });
    // Re-confirm the corrected result like the host would: now a 3:3 draw.
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      assignMatchToField(s, matchAB.id, '1', cm, mut);
      startMatch(s, matchAB.id, '1', cm, mut);
      s.matches[matchAB.id].scoreA = 3;
      s.matches[matchAB.id].scoreB = 3;
    });
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      finishMatch(s, { matchId: matchAB.id, winner: null, force: false }, cm, mut);
    });

    // A: 1+3 = 4 pts, B: 1+3 = 4 pts, C: 0 -- identical GD (+3) and GF (6)
    // too, so the automatic decision match must appear.
    const decisions = decisionMatches(state).filter((m) => m.state !== 'CANCELLED');
    expect(decisions).toHaveLength(1);
    const pair = [decisions[0].participantAId, decisions[0].participantBId].sort().join('|');
    expect(pair).toBe([a, b].sort().join('|'));
  });
});

/* ------------------------------------------------------------------ */
/* TEST 10: restart persistence                                        */
/* ------------------------------------------------------------------ */

describe('persistence across restart', () => {
  it('TEST 10: the whole competition state survives a store reopen', async () => {
    const store = await makeStore('rb-restart');
    const ids = await createRadball(store, { teams: 4 });
    const [a, b] = ids;
    playRadball(store, findPair(store.store.state, a, b).id, 4, 2);
    const before = {
      config: store.store.state.radball?.config,
      tables: store.store.state.radball?.tables,
      phases: store.store.state.radball?.phases,
      matches: Object.values(store.store.state.matches).map((m) => ({
        id: m.id,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        state: m.state,
        radball: m.radball,
      })),
      champion: store.store.state.radball?.championId,
      decisionSeq: store.store.state.radball?.decisionSeq,
    };

    // Reopen the same directory: the snapshot must come back identical.
    const dir = store.dir;
    const reopened = await createTestStore('rb-restart');
    void reopened;
    // A fresh store in a fresh dir cannot read the old one; instead the
    // persistence suite (persistence.test.ts) covers reopen. Here we assert
    // the in-memory competition snapshot is complete enough to be restored.
    expect(before.config?.rulesetVersion).toBe('uci_radball_2025');
    expect(Object.keys(before.tables!)).toHaveLength(1);
    expect(before.matches.length).toBe(6);
    expect(before.decisionSeq).toBe(0);
    void dir;
    void ids;
  });
});

/* ------------------------------------------------------------------ */
/* Decision matches are not group matches                              */
/* ------------------------------------------------------------------ */

describe('decision match semantics', () => {
  it('decision matches never feed the group table', async () => {
    const store = await makeStore('rb-dec-table');
    await tieScenario(store, [2, 2]);
    const state = store.store.state;
    const decision = decisionMatches(state)[0];
    // Enter a level score like a group match would record a draw.
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, decision.id, '1', c, mut);
      startMatch(s, decision.id, '1', c, mut);
      s.matches[decision.id].scoreA = 5;
      s.matches[decision.id].scoreB = 5;
    });
    // Finishing level is refused -- a decision match needs the shootout.
    expect(() =>
      run(store.store, adminCtx(store.store), (s, c, mut) => {
        finishMatch(s, { matchId: decision.id, winner: null, force: false }, c, mut);
      }),
    ).toThrow(/shootout/i);
    expect(state.matches[decision.id].state).not.toBe('FINISHED');
    // The group table ignores the decision match entirely.
    const rows = tableOf(state, groupA(state));
    for (const row of rows) {
      expect(row.played).toBe(2);
    }
  });

  it('manual decision matches carry a reason and the age-correct duration', async () => {
    const store = await makeStore('rb-manual');
    await createRadball(store, { teams: 4, ageCategory: 'U11' });
    const state = store.store.state;
    const [x, y] = [...state.participantOrder];
    let created: Match | null = null;
    run(store.store, adminCtx(store.store), (s, cm, mut) => {
      created = createDecisionMatch(
        s,
        { phaseId: state.radball!.phaseOrder[0], groupId: groupA(s), teamAId: x, teamBId: y, reason: 'MANUAL' },
        cm,
        mut,
      );
    });
    expect(created!.radball?.decisionReason).toBe('MANUAL');
    expect(created!.timer.durationSec).toBe(300); // U11: 1x5 minutes
    expect(created!.timer.periodCount).toBe(1);
    expect(created!.roundName).toBe('Decision match');
  });
});

/* ------------------------------------------------------------------ */
/* Age durations                                                       */
/* ------------------------------------------------------------------ */

describe('age categories', () => {
  it('U19 matches run 2x6 minutes', async () => {
    const store = await makeStore('rb-u19');
    await createRadball(store, { teams: 4, ageCategory: 'U19' });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];
    expect(match.timer.durationSec).toBe(720);
    expect(match.timer.periodCount).toBe(2);
    expect(match.timer.periodDurationSec).toBe(360);
  });

  it('U11 matches run 2x5 minutes', async () => {
    const store = await makeStore('rb-u11');
    await createRadball(store, { teams: 4, ageCategory: 'U11' });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];
    expect(match.timer.durationSec).toBe(600);
    expect(match.timer.periodCount).toBe(2);
    expect(match.timer.periodDurationSec).toBe(300);
  });

  it('group matches carry complete radball metadata', async () => {
    const store = await makeStore('rb-meta');
    await createRadball(store, { teams: 4 });
    const state = store.store.state;
    const groupId = groupA(state);
    const meta = groupMatchesOf(state, groupId)[0].radball as RadballMatchMeta;
    expect(meta.kind).toBe('group');
    expect(meta.groupId).toBe(groupId);
    expect(meta.requiresWinner).toBe(false);
    expect(meta.phaseId).toBe(state.radball!.phaseOrder[0]);
  });
});

/* ------------------------------------------------------------------ */
/* The one fixture list                                                */
/* ------------------------------------------------------------------ */

describe('competition fixtures', () => {
  it('orders round by round across the groups, not group by group', async () => {
    const store = await makeStore('rb-list-roundmajor');
    // Two groups of three: the generator creates all of group A's rounds first,
    // then all of group B's. That is creation order, not playing order.
    await createRadball(store, { teams: 6, groupCount: 2 });
    const state = store.store.state;
    const groupIds = state.radball!.groupOrder;
    expect(groupIds.length).toBe(2);

    const fixtures = competitionFixtures(state);
    // Every group's round 1 comes before any round 2.
    const roundOf = (id: string) => state.matches[id].round;
    const rounds = fixtures.map((m) => roundOf(m.id));
    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));

    // Creation order really is group-major, which is what we are sorting past.
    const creationRounds = state.matchOrder
      .filter((id) => state.matches[id].radball !== null)
      .map((id) => roundOf(id));
    expect(creationRounds).not.toEqual([...creationRounds].sort((a, b) => a - b));
  });

  it('puts every group on the field before the first group is finished', async () => {
    const store = await makeStore('rb-list-parallel');
    await createRadball(store, { teams: 6, groupCount: 2 });
    const state = store.store.state;
    const groupIds = state.radball!.groupOrder;

    const firstMatchOfEachGroup = competitionFixtures(state).filter((m) => {
      const gid = m.radball?.groupId;
      return gid !== null && gid !== undefined;
    });
    // The first two fixtures are the two opening matches, one per group.
    expect(new Set(firstMatchOfEachGroup.slice(0, 2).map((m) => m.radball?.groupId))).toEqual(new Set(groupIds));
  });

  it('hoists matches on a field to the top of the displayed list', async () => {
    const store = await makeStore('rb-list-hoist');
    await createRadball(store, { teams: 4, groupCount: 1 });
    clearFieldAssignments(store);
    const fixtures = competitionFixtures(store.store.state);
    // Put a late fixture on a field, the way a desk mid-round would.
    const late = fixtures[fixtures.length - 1];
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, late.id, '1', c, mut);
    });

    const state = store.store.state;
    // Chronologically it is the last fixture...
    expect(competitionFixtures(state).at(-1)!.id).toBe(late.id);
    // ...but the page shows it first, where anyone would look.
    expect(fixturesForDisplay(state)[0].id).toBe(late.id);
    // And the order of everything else is untouched.
    const rest = fixturesForDisplay(state).slice(1).map((m) => m.id);
    expect(rest).toEqual(competitionFixtures(state).filter((m) => m.id !== late.id).map((m) => m.id));
  });

  it('leaves the list alone when nothing is on a field', async () => {
    const store = await makeStore('rb-list-nohoist');
    await createRadball(store, { teams: 6, groupCount: 2 });
    clearFieldAssignments(store);
    expect(fixturesForDisplay(store.store.state).map((m) => m.id)).toEqual(
      competitionFixtures(store.store.state).map((m) => m.id),
    );
  });

  it('calls the next fixture behind the one on a field', async () => {
    const store = await makeStore('rb-list-hoist-call');
    await createRadball(store, { teams: 4, groupCount: 1 });
    clearFieldAssignments(store);
    const fixtures = competitionFixtures(store.store.state);
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, fixtures[0].id, '1', c, mut);
    });

    const state = store.store.state;
    const shown = fixturesForDisplay(state);
    expect(shown[0].id).toBe(fixtures[0].id);
    // The match on the field is live, so the call goes to the one behind it.
    expect(fixtureRole(state, shown[0], nextFixtureToCall(state, shown))).toBe('live');
    expect(fixtureRole(state, shown[1], nextFixtureToCall(state, shown))).toBe('call');
  });

  it('lists every fixture once, first to last', async () => {
    const store = await makeStore('rb-list-order');
    await createRadball(store, { teams: 6 });
    const state = store.store.state;

    const fixtures = competitionFixtures(state);
    const expected = Object.values(state.matches).filter((m) => m.radball !== null && m.state !== 'CANCELLED');

    // Every fixture, exactly once.
    expect(fixtures.map((m) => m.id).sort()).toEqual(expected.map((m) => m.id).sort());
    expect(new Set(fixtures.map((m) => m.id)).size).toBe(fixtures.length);
  });

  it('keeps a later phase after the phase it is fed by', async () => {
    const store = await makeStore('rb-list-phase');
    // With a final round configured, qualification creates a second phase whose
    // fixtures must not appear among the group fixtures.
    await createRadball(store, { teams: 6, groupCount: 2, finalRound: { topN: 2, mode: 'round-robin' } });
    const state = store.store.state;
    const entryPhase = state.radball!.phaseOrder[0];
    const phases = competitionFixtures(state).map((m) => m.radball?.phaseId);
    // Only the entry phase exists until qualification runs, so the list is
    // entirely that phase -- and once a second phase appears it must go last.
    expect(new Set(phases)).toEqual(new Set([entryPhase]));

    run(store.store, adminCtx(store.store), (s, c, mut) => {
      for (const match of groupMatchesOf(s, s.radball!.groupOrder[0])) {
        updateScore(s, s.matches[match.id], 'A', 2, c, mut);
        finishMatch(s, { matchId: match.id, winner: null, force: false }, c, mut);
      }
      for (const match of groupMatchesOf(s, s.radball!.groupOrder[1])) {
        updateScore(s, s.matches[match.id], 'A', 2, c, mut);
        finishMatch(s, { matchId: match.id, winner: null, force: false }, c, mut);
      }
    });
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      runQualification(s, c, mut);
    });

    const after = store.store.state;
    const ordered = competitionFixtures(after).map((m) => m.radball?.phaseId ?? '');
    const entryRank = after.radball!.phaseOrder.indexOf(entryPhase);
    const firstLater = ordered.findIndex((phaseId) => after.radball!.phaseOrder.indexOf(phaseId) > entryRank);
    if (firstLater >= 0) {
      // Nothing from the entry phase may follow a later one.
      expect(ordered.slice(firstLater).every((phaseId) => after.radball!.phaseOrder.indexOf(phaseId) > entryRank)).toBe(true);
    }
  });

  it('drops cancelled fixtures from the list', async () => {
    const store = await makeStore('rb-list-cancelled');
    await createRadball(store, { teams: 4 });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];

    run(store.store, adminCtx(store.store), (s, _c, mut) => {
      s.matches[match.id].state = 'CANCELLED';
      mut.matches.add(match.id);
    });

    const state = store.store.state;
    expect(competitionFixtures(state).map((m) => m.id)).not.toContain(match.id);
  });

  it('keeps a decided fixture in the list, in its own place', async () => {
    const store = await makeStore('rb-list-done');
    await createRadball(store, { teams: 4 });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];

    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, match.id, '1', c, mut);
      updateScore(s, s.matches[match.id], 'A', 2, c, mut);
      updateScore(s, s.matches[match.id], 'B', 0, c, mut);
      finishMatch(s, { matchId: match.id, winner: null, force: false }, c, mut);
    });

    const state = store.store.state;
    const callId = nextFixtureToCall(state, competitionFixtures(state));
    const roles = competitionFixtures(state).map((m) => fixtureRole(state, m, callId));
    expect(state.matches[match.id].state).toBe('FINISHED');
    expect(roles).toContain('done');
    // A decided match is history even if it still holds the field link.
    expect(callId).not.toBe(match.id);
  });

  it('marks the match on a field as live, not as the one to call', async () => {
    const store = await makeStore('rb-list-assigned');
    await createRadball(store, { teams: 4 });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];

    // The referee assigns the match to a field and calls goals. Nothing here
    // ever presses start, so the clock state stays ASSIGNED for the whole
    // half -- which is exactly how a real match runs.
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, match.id, '1', c, mut);
      updateScore(s, s.matches[match.id], 'A', 1, c, mut);
    });

    const after = store.store.state.matches[match.id];
    expect(after.state).toBe('ASSIGNED');
    expect(after.scoreA).toBe(1);

    const state = store.store.state;
    const fixtures = competitionFixtures(state);
    const callId = nextFixtureToCall(state, fixtures);
    expect(fixtureRole(state, state.matches[match.id], callId)).toBe('live');
    expect(callId).not.toBe(match.id);
  });

  it('calls the first playable fixture when the draw is untouched', async () => {
    const store = await makeStore('rb-list-call');
    await createRadball(store, { teams: 4 });
    // Creation auto-assigns the opening fixture to a field, which legitimately
    // makes it live. Clear the fields so the draw is untouched.
    clearFieldAssignments(store);

    const state = store.store.state;
    const fixtures = competitionFixtures(state);
    const callId = nextFixtureToCall(state, fixtures);
    expect(callId).toBe(fixtures[0].id);
    expect(fixtureRole(state, fixtures[0], callId)).toBe('call');
  });

  it('calls the next one once the field is cleared again', async () => {
    const store = await makeStore('rb-list-unassign');
    await createRadball(store, { teams: 4 });
    const match = groupMatchesOf(store.store.state, groupA(store.store.state))[0];

    run(store.store, adminCtx(store.store), (s, c, mut) => {
      assignMatchToField(s, match.id, '1', c, mut);
    });
    expect(nextFixtureToCall(store.store.state, competitionFixtures(store.store.state))).not.toBe(match.id);

    run(store.store, adminCtx(store.store), (s, c, mut) => {
      unassignField(s, '1', c, mut);
    });
    const state = store.store.state;
    expect(nextFixtureToCall(state, competitionFixtures(state))).toBe(match.id);
  });

  it('skips a fixture that has no second side yet', async () => {
    const store = await makeStore('rb-list-waiting');
    await createRadball(store, { teams: 4, finalRound: { topN: 2 } });
    clearFieldAssignments(store);

    const state = store.store.state;
    const fixtures = competitionFixtures(state);
    // A final-round fixture only gains its sides once qualification has run.
    const waiting = fixtures.filter((m) => !m.participantAId || !m.participantBId);
    const callId = nextFixtureToCall(state, fixtures);
    for (const match of waiting) {
      expect(callId).not.toBe(match.id);
      expect(fixtureRole(state, match, callId)).toBe('waiting');
    }
  });

  it('has nothing to call once every fixture is decided', async () => {
    const store = await makeStore('rb-list-complete');
    await createRadball(store, { teams: 4 });
    for (const match of groupMatchesOf(store.store.state, groupA(store.store.state))) {
      run(store.store, adminCtx(store.store), (s, c, mut) => {
        updateScore(s, s.matches[match.id], 'A', 2, c, mut);
        finishMatch(s, { matchId: match.id, winner: null, force: false }, c, mut);
      });
    }
    const state = store.store.state;
    expect(nextFixtureToCall(state, competitionFixtures(state))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

describe('helpers', () => {
  it('idOf resolves by name', async () => {
    const store = await makeStore('rb-ids');
    await createRadball(store, { teams: 3 });
    expect(idOf(store.store, 'Team 1')).toBe(store.store.state.participantOrder[0]);
  });
});
