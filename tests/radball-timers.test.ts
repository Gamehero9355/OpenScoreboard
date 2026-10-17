/**
 * Match lengths in Radball: two configured halves and a drift-proof reset.
 *
 * Five hurried −1m taps mid-game turned a 2x7min ELITE match into 4:30
 * halves with no way back: the steppers moved the whole match (only 30s per
 * half per tap, inviting repeat taps) and Reset kept the drifted durations
 * while zeroing everything else. Reset now restores the configured length;
 * generic knockout matches keep theirs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ParticipantInput } from '../src/shared/commands';
import { createTestStore, createQuickTournament, adminCtx, matchByName, run, type TestStore } from './helpers';
import { createTournament } from '../src/backend/tournament/engine';
import { createDecisionMatch } from '../src/backend/tournament/radball';
import { resetMatch, setTimer } from '../src/backend/tournament/matchops';

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

async function createEliteRadball(store: TestStore): Promise<void> {
  run(store.store, adminCtx(store.store), (state, c, mut) => {
    createTournament(
      state,
      {
        name: 'Radball Timer Cup',
        format: 'radball',
        participants: radballTeams(4),
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracketNow: true,
        radball: { ageCategory: 'ELITE', groupCount: 1, finalRound: null, minRestMinutes: 0 },
      },
      c,
      mut,
    );
  });
}

function firstGroupMatchId(store: TestStore): string {
  const match = Object.values(store.store.state.matches).find((m) => m.radball?.kind === 'group');
  if (!match) throw new Error('No group fixture');
  return match.id;
}

describe('radball match lengths', () => {
  it('creates ELITE group matches as two 7-minute halves', async () => {
    const store = await makeStore('timer-create');
    await createEliteRadball(store);
    const timer = store.store.state.matches[firstGroupMatchId(store)].timer;
    expect(timer.durationSec).toBe(840);
    expect(timer.periodCount).toBe(2);
    expect(timer.periodDurationSec).toBe(420);
  });

  it('restores the configured halves when a drifted match is reset', async () => {
    const store = await makeStore('timer-reset');
    await createEliteRadball(store);
    const matchId = firstGroupMatchId(store);
    // Five −1m taps the old way: the whole match shortens by a minute each.
    run(store.store, adminCtx(store.store), (state, _c, mut) => {
      setTimer(state, matchId, { durationSec: 540 }, mut);
    });
    expect(store.store.state.matches[matchId].timer.periodDurationSec).toBe(270);
    run(store.store, adminCtx(store.store), (state, c, mut) => {
      resetMatch(state, matchId, c, mut);
    });
    const timer = store.store.state.matches[matchId].timer;
    expect(timer.durationSec).toBe(840);
    expect(timer.periodDurationSec).toBe(420);
    expect(timer.elapsedMs).toBe(0);
    expect(timer.period).toBe(1);
  });

  it('restores a decision match to its single configured half', async () => {
    const store = await makeStore('timer-decision');
    await createEliteRadball(store);
    const ctx = adminCtx(store.store);
    let decisionId = '';
    run(store.store, ctx, (state, c, mut) => {
      const competition = state.radball;
      if (!competition) throw new Error('No competition');
      const match = createDecisionMatch(
        state,
        {
          phaseId: competition.phaseOrder[0],
          groupId: null,
          teamAId: state.participantOrder[0],
          teamBId: state.participantOrder[1],
          reason: 'CHAMPIONSHIP_TIE',
        },
        c,
        mut,
      );
      decisionId = match.id;
    });
    expect(store.store.state.matches[decisionId].timer.durationSec).toBe(420);
    run(store.store, ctx, (state, _c, mut) => {
      setTimer(state, decisionId, { durationSec: 200 }, mut);
    });
    run(store.store, ctx, (state, c, mut) => {
      resetMatch(state, decisionId, c, mut);
    });
    const timer = store.store.state.matches[decisionId].timer;
    expect(timer.durationSec).toBe(420);
    expect(timer.periodDurationSec).toBe(420);
  });

  it('leaves a generic knockout match duration alone on reset', async () => {
    const store = await makeStore('timer-generic');
    createQuickTournament(store.store, { participants: 8 });
    const matchId = matchByName(store.store, 'Player 01', 'Player 08');
    run(store.store, adminCtx(store.store), (state, _c, mut) => {
      setTimer(state, matchId, { durationSec: 300 }, mut);
    });
    run(store.store, adminCtx(store.store), (state, c, mut) => {
      resetMatch(state, matchId, c, mut);
    });
    const timer = store.store.state.matches[matchId].timer;
    expect(timer.durationSec).toBe(300);
    expect(timer.periodDurationSec).toBe(150);
  });
});
