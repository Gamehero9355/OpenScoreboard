import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Match, TournamentState } from '../src/shared/types';
import { EngineError } from '../src/backend/util/errors';
import {
  assignMatchToField,
  autoAssign,
  unassignField,
  cancelMatch,
  claimField,
  finishMatch,
  getNextAvailableMatch,
  pauseMatch,
  resetMatch,
  resumeMatch,
  setTimer,
  startMatch,
  startSecondHalf,
} from '../src/backend/tournament/matchops';
import { correctScore, redoScore, undoScore, updateScore } from '../src/backend/tournament/scoring';
import {
  createTournament,
  generateBracketForTournament,
  removeParticipant,
  setMatchParticipants,
  updateParticipant,
} from '../src/backend/tournament/engine';
import { rebuild } from '../src/backend/tournament/resolve';
import { timerElapsed, timerRemaining } from '../src/backend/tournament/state';
import {
  adminCtx,
  createQuickTournament,
  createTestStore,
  idOf,
  matchByName,
  nameOf,
  playMatch,
  playOutTournament,
  run,
  sleep,
  type TestStore,
} from './helpers';

let env: TestStore;

beforeEach(async () => {
  env = await createTestStore('engine');
});

afterEach(async () => {
  await env.dispose();
});

function expectEngineError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`Expected an EngineError with code ${code}`);
}

describe('tournament creation', () => {
  it('creates participants, generates the bracket and readies the first round', () => {
    createQuickTournament(env.store, { participants: 8 });
    const state = env.store.state;
    expect(Object.keys(state.participants)).toHaveLength(8);
    expect(state.tournament?.status).toBe('RUNNING');
    expect(state.tournament?.bracketSize).toBe(8);
    const open = orderedPlayable(state);
    expect(open).toHaveLength(4);
    expect(open.every((m) => m.round === 0)).toBe(true);
    // The two free fields were pre-loaded, one opening match each.
    expect(state.fields['1'].matchId).toBeTruthy();
    expect(state.fields['2'].matchId).toBeTruthy();
    expect(state.fields['1'].matchId).not.toBe(state.fields['2'].matchId);
  });

  it('auto-advances byes so a 5 player bracket starts with real matches', () => {
    createQuickTournament(env.store, { participants: 5 });
    const state = env.store.state;
    const finished = Object.values(state.matches).filter((m) => m.state === 'FINISHED');
    // Three byes in a 5-of-8 bracket: seeds 1, 2 and 3 walk into the semifinals.
    expect(finished).toHaveLength(3);
    const open = orderedPlayable(state);
    // One real quarterfinal plus the semifinal between the two byed seeds.
    expect(open).toHaveLength(2);
    const quarterfinal = open.find((m) => m.round === 0);
    const semifinal = open.find((m) => m.round === 1);
    expect(quarterfinal?.participantAId).toBe(idOf(env.store, 'Player 04'));
    expect(quarterfinal?.participantBId).toBe(idOf(env.store, 'Player 05'));
    expect(semifinal?.participantAId).toBe(idOf(env.store, 'Player 02'));
    expect(semifinal?.participantBId).toBe(idOf(env.store, 'Player 03'));
    // The other semifinal still waits for the real quarterfinal to be played.
    const waiting = Object.values(state.matches).filter((m) => m.state === 'WAITING' && m.round === 1);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].participantAId).toBe(idOf(env.store, 'Player 01'));
    expect(waiting[0].participantBId).toBeNull();
  });

  it('refuses to build a bracket with fewer than two participants', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Draft Cup',
          format: 'single-elimination',
          participants: Array.from({ length: 5 }, (_, i) => ({
            name: `Draft ${i + 1}`,
            team: null,
            seed: null,
            checkedIn: true,
          })),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: false,
        },
        c,
        mut,
      );
    });
    expect(env.store.state.matchOrder).toHaveLength(0);
    for (const id of [...env.store.state.participantOrder].slice(1)) {
      run(env.store, ctx, (state, c, mut) => removeParticipant(state, id, c, mut));
    }
    expect(env.store.state.participantOrder).toHaveLength(1);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          generateBracketForTournament(state, { seeded: true, seedValue: 1, thirdPlaceMatch: false, order: null }, c, mut);
        }),
      'BAD_REQUEST',
    );
  });

  it('leaves unchecked participants out of the bracket', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Check-in Cup',
          format: 'single-elimination',
          participants: Array.from({ length: 4 }, (_, i) => ({
            name: `Checked ${i + 1}`,
            team: null,
            seed: null,
            checkedIn: i < 3,
          })),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
        },
        c,
        mut,
      );
    });
    expect(env.store.state.tournament?.bracketSize).toBe(4);
    const inBracket = Object.values(env.store.state.matches).flatMap((m) => [
      m.participantAId,
      m.participantBId,
    ]);
    expect(inBracket).not.toContain(idOf(env.store, 'Checked 4'));
  });

  it('produces the identical random bracket for the same fixed seed', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const layout = () =>
      Object.values(env.store.state.matches)
        .filter((m) => m.round === 0)
        .map((m) => `${m.position}:${nameOf(env.store, m.participantAId)}/${nameOf(env.store, m.participantBId)}`)
        .sort();
    run(env.store, ctx, (state, c, mut) => {
      generateBracketForTournament(state, { seeded: false, seedValue: 4242, thirdPlaceMatch: true, order: null }, c, mut);
    });
    const first = layout();
    run(env.store, ctx, (state, c, mut) => {
      generateBracketForTournament(state, { seeded: false, seedValue: 4242, thirdPlaceMatch: true, order: null }, c, mut);
    });
    expect(layout()).toEqual(first);

    run(env.store, ctx, (state, c, mut) => {
      generateBracketForTournament(state, { seeded: false, seedValue: 99, thirdPlaceMatch: true, order: null }, c, mut);
    });
    expect(layout()).not.toEqual(first);
  });
});

describe('scoring', () => {
  it('adds points, records history and updates the audit log', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchByName(env.store, 'Player 01', 'Player 04');
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      updateScore(state, state.matches[matchId], 'A', 2, c, mut);
      updateScore(state, state.matches[matchId], 'B', 1, c, mut);
      updateScore(state, state.matches[matchId], 'A', 3, c, mut);
    });
    const match = env.store.state.matches[matchId];
    expect(match.scoreA).toBe(5);
    expect(match.scoreB).toBe(1);
    expect(match.history).toHaveLength(3);
    const scoreEvents = env.store.state.events.filter((e) => e.type === 'SCORE_UPDATED');
    expect(scoreEvents).toHaveLength(3);
  });

  it('never lets a score go below zero', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          updateScore(state, state.matches[matchId], 'A', -1, c, mut);
        }),
      'INVALID_SCORE',
    );
  });

  it('honours the configured maximum score', () => {
    createQuickTournament(env.store, { participants: 4 });
    env.store.state.settings.maxScore = 3;
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', 3, c, mut);
    });
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          updateScore(state, state.matches[matchId], 'A', 1, c, mut);
        }),
      'INVALID_SCORE',
    );
  });

  it('refuses to score a match whose participants are not known yet', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1);
    expect(semi).toBeTruthy();
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          updateScore(state, state.matches[semi!.id], 'A', 1, c, mut);
        }),
      'INVALID_STATE',
    );
  });
});

describe('undo and redo', () => {
  it('undoes a single point exactly', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', 1, c, mut);
      updateScore(state, state.matches[matchId], 'A', 1, c, mut);
      updateScore(state, state.matches[matchId], 'B', 3, c, mut);
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(2);
    run(env.store, ctx, (state, c, mut) => {
      undoScore(state, state.matches[matchId], c, mut);
    });
    expect(env.store.state.matches[matchId].scoreB).toBe(0);
    run(env.store, ctx, (state, c, mut) => {
      undoScore(state, state.matches[matchId], c, mut);
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(1);
    run(env.store, ctx, (state, c, mut) => {
      redoScore(state, state.matches[matchId], c, mut);
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(2);
  });

  it('undoes a manual correction', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', 1, c, mut);
      correctScore(state, state.matches[matchId], 9, 4, c, mut, 'wrong button');
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(9);
    run(env.store, ctx, (state, c, mut) => {
      undoScore(state, state.matches[matchId], c, mut);
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(1);
    expect(env.store.state.matches[matchId].scoreB).toBe(0);
  });

  it('clears the redo stack when a new point is scored', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', 1, c, mut);
    });
    run(env.store, ctx, (state, c, mut) => {
      undoScore(state, state.matches[matchId], c, mut);
    });
    expect(env.store.state.matches[matchId].redoStack).toHaveLength(1);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'B', 1, c, mut);
    });
    expect(env.store.state.matches[matchId].redoStack).toHaveLength(0);
  });

  it('reports an empty undo stack instead of failing silently', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          undoScore(state, state.matches[matchId], c, mut);
        }),
      'INVALID_STATE',
    );
  });
});

describe('match completion and advancement', () => {
  it('advances the winner into the next round automatically', () => {
    createQuickTournament(env.store, { participants: 8 });
    const matchId = matchByName(env.store, 'Player 01', 'Player 08');
    playMatch(env.store, matchId, '1', 5, 3);

    const semi = Object.values(env.store.state.matches).find(
      (m) => m.round === 1 && m.position === 0,
    );
    expect(semi).toBeTruthy();
    expect(semi?.participantAId).toBe(idOf(env.store, 'Player 01'));
    expect(semi?.participantBId).toBeNull();
    expect(semi?.state).toBe('WAITING');
  });

  it('creates the semifinal pairing once both quarterfinals are decided', () => {
    createQuickTournament(env.store, { participants: 8 });
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 08'), '1', 5, 3);
    playMatch(env.store, matchByName(env.store, 'Player 04', 'Player 05'), '2', 2, 4);

    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    expect(semi?.participantAId).toBe(idOf(env.store, 'Player 01'));
    expect(semi?.participantBId).toBe(idOf(env.store, 'Player 05'));
    expect(semi?.state).toBe('READY');
  });

  it('marks the tournament complete and stores the champion', () => {
    createQuickTournament(env.store, { participants: 4 });
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 04'), '1', 3, 0);
    playMatch(env.store, matchByName(env.store, 'Player 02', 'Player 03'), '2', 3, 1);
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 02'), '1', 3, 2);

    expect(env.store.state.tournament?.status).toBe('COMPLETED');
    expect(nameOf(env.store, env.store.state.tournament?.championId ?? null)).toBe('Player 01');
  });

  it('plays a complete 8 player tournament with 7 real matches', () => {
    createQuickTournament(env.store, { participants: 8 });
    const result = playOutTournament(env.store);
    expect(result.played).toBe(8); // 7 bracket matches plus the third-place match
    expect(nameOf(env.store, result.champion)).toBe('Player 01');
    const real = Object.values(env.store.state.matches).filter(
      (m) => m.state === 'FINISHED' && m.history.length > 0,
    );
    expect(real).toHaveLength(8);
  });

  it('rejects a duplicate finish instead of silently overwriting', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchByName(env.store, 'Player 01', 'Player 04');
    playMatch(env.store, matchId, '1', 3, 0);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          finishMatch(state, { matchId, winner: null, force: false }, c, mut);
        }),
      'DUPLICATE_RESULT',
    );
  });

  it('requires an explicit winner when the score is level', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchByName(env.store, 'Player 01', 'Player 04');
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      startMatch(state, matchId, '1', c, mut);
      updateScore(state, state.matches[matchId], 'A', 2, c, mut);
      updateScore(state, state.matches[matchId], 'B', 2, c, mut);
    });
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          finishMatch(state, { matchId, winner: null, force: false }, c, mut);
        }),
      'NO_WINNER',
    );
    run(env.store, ctx, (state, c, mut) => {
      finishMatch(state, { matchId, winner: 'B', force: false }, c, mut);
    });
    expect(env.store.state.matches[matchId].winnerId).toBe(idOf(env.store, 'Player 04'));
  });

  it('records a draw without advancing anybody when draws are allowed', () => {
    createQuickTournament(env.store, { participants: 4 });
    env.store.state.settings.allowDraws = true;
    const ctx = adminCtx(env.store);
    const matchId = matchByName(env.store, 'Player 01', 'Player 04');
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      startMatch(state, matchId, '1', c, mut);
      updateScore(state, state.matches[matchId], 'A', 2, c, mut);
      updateScore(state, state.matches[matchId], 'B', 2, c, mut);
      finishMatch(state, { matchId, winner: null, force: false }, c, mut);
    });
    expect(env.store.state.matches[matchId].winnerId).toBeNull();
    expect(env.store.state.matches[matchId].state).toBe('FINISHED');
    // Whoever wins the other quarterfinal walks over.
    const other = matchByName(env.store, 'Player 02', 'Player 03');
    playMatch(env.store, other, '2', 3, 1);
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    expect(semi?.participantAId).toBeNull();
    expect(semi?.participantBId).toBe(idOf(env.store, 'Player 02'));
    expect(semi?.state).toBe('FINISHED');
    expect(semi?.winnerId).toBe(idOf(env.store, 'Player 02'));
  });

  it('fills the third place match with the losing semifinalists', () => {
    createQuickTournament(env.store, { participants: 4, thirdPlaceMatch: true });
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 04'), '1', 3, 0);
    playMatch(env.store, matchByName(env.store, 'Player 02', 'Player 03'), '2', 3, 1);
    const third = Object.values(env.store.state.matches).find((m) => m.isThirdPlace);
    expect(third?.participantAId).toBe(idOf(env.store, 'Player 04'));
    expect(third?.participantBId).toBe(idOf(env.store, 'Player 03'));
    expect(third?.state).toBe('READY');
  });

  it('leaves the bracket intact when a finished match is reset early enough', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const matchId = matchByName(env.store, 'Player 01', 'Player 08');
    playMatch(env.store, matchId, '1', 5, 3);
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    expect(semi?.participantAId).toBe(idOf(env.store, 'Player 01'));

    run(env.store, ctx, (state, c, mut) => {
      resetMatch(state, matchId, c, mut);
    });
    expect(env.store.state.matches[matchId].scoreA).toBe(0);
    expect(env.store.state.matches[matchId].state).toBe('READY');
    const semiAfter = env.store.state.matches[semi!.id];
    expect(semiAfter.participantAId).toBeNull();
    expect(semiAfter.state).toBe('WAITING');
  });

  it('refuses to reset a match whose successor already ran', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const qf = matchByName(env.store, 'Player 01', 'Player 04');
    playMatch(env.store, qf, '1', 3, 0);
    playMatch(env.store, matchByName(env.store, 'Player 02', 'Player 03'), '2', 3, 1);
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 02'), '1', 3, 2);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          resetMatch(state, qf, c, mut);
        }),
      'DOWNSTREAM_STARTED',
    );
  });

  it('cancels a match without disturbing the other side of the bracket', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const cancelled = matchByName(env.store, 'Player 01', 'Player 04');
    run(env.store, ctx, (state, c, mut) => {
      cancelMatch(state, cancelled, c, mut);
    });
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1);
    // The other quarterfinal has not been played yet, so the semifinal keeps
    // waiting instead of being cancelled along with its feeder.
    expect(semi?.state).toBe('WAITING');
    expect(semi?.participantAId).toBeNull();

    playMatch(env.store, matchByName(env.store, 'Player 02', 'Player 03'), '2', 3, 1);
    const after = env.store.state.matches[semi!.id];
    expect(after.state).toBe('FINISHED');
    expect(after.winnerId).toBe(idOf(env.store, 'Player 02'));
    expect(after.participantBId).toBe(idOf(env.store, 'Player 02'));
  });
});

describe('timer', () => {
  it('accumulates time only while running', async () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      startMatch(state, matchId, '1', c, mut);
    });
    await sleep(60);
    run(env.store, ctx, (state, c, mut) => {
      pauseMatch(state, matchId, c, mut);
    });
    const afterPause = timerElapsed(env.store.state.matches[matchId].timer, Date.now());
    expect(afterPause).toBeGreaterThanOrEqual(40);
    await sleep(60);
    const stillPaused = timerElapsed(env.store.state.matches[matchId].timer, Date.now());
    expect(stillPaused).toBe(afterPause);
    run(env.store, ctx, (state, c, mut) => {
      resumeMatch(state, matchId, c, mut);
    });
    await sleep(40);
    expect(timerElapsed(env.store.state.matches[matchId].timer, Date.now())).toBeGreaterThan(afterPause);
  });

  it('rejects pausing a match that is not running', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          pauseMatch(state, matchId, c, mut);
        }),
      'INVALID_STATE',
    );
  });

  it('stores the configured duration and mode', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, _c, mut) => {
      setTimer(state, matchId, { mode: 'up', durationSec: 600 }, mut);
    });
    expect(env.store.state.matches[matchId].timer.mode).toBe('up');
    expect(env.store.state.matches[matchId].timer.durationSec).toBe(600);
    expect(env.store.state.matches[matchId].timer.periodDurationSec).toBe(300);
  });

  it('preserves elapsed time when adjusting a paused timer', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, _c, mut) => {
      const match = state.matches[matchId];
      match.state = 'PAUSED';
      match.timer.running = false;
      match.timer.anchorAt = null;
      match.timer.durationSec = 600;
      match.timer.elapsedMs = 12_345;
      setTimer(state, matchId, { durationSec: 540 }, mut);
    });
    const shortened = env.store.state.matches[matchId].timer;
    expect(shortened.durationSec).toBe(540);
    expect(shortened.elapsedMs).toBe(12_345);
    expect(timerRemaining(shortened, 0)).toBe(257_655);

    run(env.store, ctx, (state, _c, mut) => {
      setTimer(state, matchId, { durationSec: 660 }, mut);
    });
    const extended = env.store.state.matches[matchId].timer;
    expect(extended.durationSec).toBe(660);
    expect(extended.elapsedMs).toBe(12_345);
    expect(timerRemaining(extended, 0)).toBe(317_655);
  });

  it('stops at halftime and starts the second half with a fresh clock', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      startMatch(state, matchId, '1', c, mut);
    });
    const firstHalfMs = env.store.state.matches[matchId].timer.periodDurationSec * 1000;
    const firstBoundary = (env.store.state.matches[matchId].timer.anchorAt ?? Date.now()) + firstHalfMs;
    env.store.advanceTimers(firstBoundary);

    const halftime = env.store.state.matches[matchId];
    expect(halftime.state).toBe('HALFTIME');
    expect(halftime.timer.period).toBe(1);
    expect(halftime.timer.running).toBe(false);
    expect(halftime.timer.elapsedMs).toBe(firstHalfMs);
    expect(timerRemaining(halftime.timer, firstBoundary)).toBe(0);

    run(env.store, ctx, (state, c, mut) => {
      startSecondHalf(state, matchId, c, mut);
    });
    const secondHalf = env.store.state.matches[matchId];
    expect(secondHalf.state).toBe('RUNNING');
    expect(secondHalf.timer.period).toBe(2);
    expect(secondHalf.timer.periodStartElapsedMs).toBe(firstHalfMs);
    expect(secondHalf.timer.running).toBe(true);
    expect(timerRemaining(secondHalf.timer, secondHalf.timer.anchorAt ?? Date.now())).toBe(firstHalfMs);

    const secondBoundary = (secondHalf.timer.anchorAt ?? Date.now()) + firstHalfMs;
    env.store.advanceTimers(secondBoundary);
    const expired = env.store.state.matches[matchId];
    expect(expired.state).toBe('PAUSED');
    expect(expired.timer.expired).toBe(true);
    expect(timerRemaining(expired.timer, secondBoundary)).toBe(0);
  });
});

describe('manual overrides', () => {
  it('lets the host swap participants in a waiting match', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    run(env.store, ctx, (state, c, mut) => {
      setMatchParticipants(state, semi!.id, idOf(env.store, 'Player 03'), idOf(env.store, 'Player 06'), c, mut);
    });
    const updated = env.store.state.matches[semi!.id];
    expect(updated.locked).toBe(true);
    expect(updated.state).toBe('READY');
    expect(updated.participantAId).toBe(idOf(env.store, 'Player 03'));
  });

  it('keeps a manual override when results are recomputed', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const semi = Object.values(env.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    run(env.store, ctx, (state, c, mut) => {
      setMatchParticipants(state, semi!.id, idOf(env.store, 'Player 03'), idOf(env.store, 'Player 06'), c, mut);
    });
    playMatch(env.store, matchByName(env.store, 'Player 01', 'Player 08'), '1', 5, 3);
    run(env.store, ctx, (state, c, mut) => {
      rebuild(state, c, mut);
    });
    expect(env.store.state.matches[semi!.id].participantAId).toBe(idOf(env.store, 'Player 03'));
  });

  it('renames a participant without touching the bracket', () => {
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const id = idOf(env.store, 'Player 01');
    run(env.store, ctx, (state, c, mut) => {
      updateParticipant(state, id, { name: 'Renamed', team: 'Team X' }, c, mut);
    });
    expect(nameOf(env.store, id)).toBe('Renamed');
    expect(env.store.state.participants[id].team).toBe('Team X');
  });
});

describe('queue and auto assignment', () => {
  it('reports the first ready match in queue order', () => {
    createQuickTournament(env.store, { participants: 8 });
    const next = getNextAvailableMatch(env.store.state);
    expect(next).not.toBeNull();
    const ready = orderedReady(env.store.state);
    expect(next?.id).toBe(ready[0].id);
  });

  it('pre-loads every free field when the bracket is generated', () => {
    createQuickTournament(env.store, { participants: 8 });
    const { fields, matches } = env.store.state;
    const first = fields['1'].matchId as string;
    const second = fields['2'].matchId as string;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(matches[first].round).toBe(0);
    expect(matches[second].round).toBe(0);
  });

  it('fills a field that was cleared again from the queue', () => {
    createQuickTournament(env.store, { participants: 8 });
    const ctx = adminCtx(env.store);
    const cleared = env.store.state.fields['1'].matchId as string;
    run(env.store, ctx, (state, c, mut) => {
      unassignField(state, '1', c, mut);
    });
    // The freed field gets the first match the queue has for it -- the one that
    // was sitting there before is still first in line.
    expect(getNextAvailableMatch(env.store.state, '1')?.id).toBe(cleared);
    const assigned = run(env.store, ctx, (state, c, mut) => {
      autoAssign(state, c, mut);
    });
    expect(assigned.fields.size).toBe(1);
    expect(env.store.state.fields['1'].matchId).toBe(cleared);
    expect(env.store.state.matches[cleared].state).toBe('ASSIGNED');
  });

  it('assigns the next ready match to the freed field after a finish', () => {
    createQuickTournament(env.store, { participants: 8 });
    env.store.state.settings.autoAssignNext = true;
    const ctx = adminCtx(env.store);
    const first = getNextAvailableMatch(env.store.state)!;
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, first.id, '1', c, mut);
    });
    playMatch(env.store, first.id, '1', 3, 1);
    expect(env.store.state.fields['1'].matchId).toBeTruthy();
    expect(env.store.state.fields['1'].matchId).not.toBe(first.id);
  });
});

describe('field locks', () => {
  it('rejects a second operator taking a locked field', () => {
    createQuickTournament(env.store, { participants: 4 });
    const first = env.store.createContext('Operator A', 'operator', '1');
    const second = env.store.createContext('Operator B', 'operator', '1');
    run(env.store, first, (state, c, mut) => claimField(state, '1', false, c, mut));
    expectEngineError(
      () =>
        run(env.store, second, (state, c, mut) => {
          claimField(state, '1', false, c, mut);
        }),
      'FIELD_LOCKED',
    );
  });
});

describe('delta broadcasting', () => {
  it('only reports the match that actually changed', () => {
    createQuickTournament(env.store, { participants: 4 });
    const deltas: string[] = [];
    const unsubscribe = env.store.subscribe((delta) => {
      deltas.push(JSON.stringify(Object.keys(delta)));
    });
    const ctx = adminCtx(env.store);
    const matchId = matchOrderFirst(env.store);
    run(env.store, ctx, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', 1, c, mut);
    });
    unsubscribe();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toContain('matches');
  });
});

function matchOrderFirst(store: { state: TournamentState }): string {
  const { state } = store;
  const id = state.matchOrder.find((mid) => {
    const match = state.matches[mid];
    return match && (match.state === 'READY' || match.state === 'ASSIGNED');
  });
  if (!id) throw new Error('no playable match');
  return id;
}

function orderedReady(state: TournamentState): Match[] {
  return state.matchOrder
    .map((id) => state.matches[id])
    .filter((match): match is Match => Boolean(match) && match.state === 'READY');
}

/** Opening a bracket pre-loads the fields, so "playable" means ready or placed. */
function orderedPlayable(state: TournamentState): Match[] {
  return state.matchOrder
    .map((id) => state.matches[id])
    .filter((match): match is Match => Boolean(match) && (match.state === 'READY' || match.state === 'ASSIGNED'));
}
