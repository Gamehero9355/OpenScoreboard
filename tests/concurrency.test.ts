import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineError } from '../src/backend/util/errors';
import {
  assignMatchToField,
  autoAssign,
  claimField,
  finishMatch,
  releaseFieldClaim,
  startMatch,
  swapFields,
} from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';
import { createTournament } from '../src/backend/tournament/engine';
import { assertFieldScope } from '../src/backend/tournament/state';
import {
  adminCtx,
  createQuickTournament,
  createTestStore,
  idOf,
  nameOf,
  operatorCtx,
  playMatch,
  run,
  type TestStore,
} from './helpers';

let env: TestStore;

beforeEach(async () => {
  env = await createTestStore('concurrency');
  createQuickTournament(env.store, { participants: 8 });
});

afterEach(async () => {
  await env.dispose();
});

function round(roundNumber: number, position: number) {
  const match = Object.values(env.store.state.matches).find(
    (m) => m.round === roundNumber && m.position === position && m.bracket === 'winners',
  );
  if (!match) throw new Error(`no match at round ${roundNumber} position ${position}`);
  return match;
}

describe('two fields running in parallel', () => {
  it('runs two independent matches with independent scores and timers', () => {
    const ctx = adminCtx(env.store);
    const qf1 = round(0, 0);
    const qf2 = round(0, 1);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
      startMatch(state, qf2.id, '2', c, mut);
      updateScore(state, state.matches[qf1.id], 'A', 2, c, mut);
      updateScore(state, state.matches[qf2.id], 'B', 3, c, mut);
    });

    const state = env.store.state;
    expect(state.fields['1'].matchId).toBe(qf1.id);
    expect(state.fields['2'].matchId).toBe(qf2.id);
    expect(state.matches[qf1.id].scoreA).toBe(2);
    expect(state.matches[qf1.id].scoreB).toBe(0);
    expect(state.matches[qf2.id].scoreA).toBe(0);
    expect(state.matches[qf2.id].scoreB).toBe(3);
    expect(state.matches[qf1.id].state).toBe('RUNNING');
    expect(state.matches[qf2.id].state).toBe('RUNNING');
    expect(state.matches[qf1.id].history).toHaveLength(1);
    expect(state.matches[qf2.id].history).toHaveLength(1);
  });

  it('advances field 1 while field 2 is still running', () => {
    const qf1 = round(0, 0);
    const qf2 = round(0, 1);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
      startMatch(state, qf2.id, '2', c, mut);
    });
    playMatch(env.store, qf1.id, '1', 4, 2, ctx);

    // Field 2 is untouched and still running.
    expect(env.store.state.matches[qf2.id].state).toBe('RUNNING');
    expect(env.store.state.fields['1'].matchId).toBeNull();
    expect(env.store.state.fields['2'].matchId).toBe(qf2.id);

    // The winner of qf1 is already waiting in the semifinal.
    const semi = round(1, 0);
    expect(semi.participantAId).toBe(idOf(env.store, 'Player 01'));
    expect(semi.participantBId).toBeNull();
    expect(semi.state).toBe('WAITING');
  });

  it('lets field 2 finish first and still fills the semifinal correctly', () => {
    const qf2 = round(0, 1);
    const qf1 = round(0, 0);
    const qf1Winner = qf1.participantAId as string;
    const qf2Winner = qf2.participantAId as string;
    const ctx = adminCtx(env.store);
    // Both matches start together on the two fields.
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
      startMatch(state, qf2.id, '2', c, mut);
    });

    // Field 2 finishes first, while field 1 is still running.
    playMatch(env.store, qf2.id, '2', 3, 1, ctx);
    expect(env.store.state.fields['2'].matchId).toBeNull();
    expect(env.store.state.matches[qf1.id].state).toBe('RUNNING');
    playMatch(env.store, qf1.id, '1', 5, 2, ctx);

    const semi = round(1, 0);
    expect(semi.participantAId).toBe(qf1Winner);
    expect(semi.participantBId).toBe(qf2Winner);
    expect(semi.state).toBe('READY');
  });

  it('handles both fields finishing in the same batch', () => {
    const qf1 = round(0, 0);
    const qf2 = round(0, 1);
    const qf1Winner = qf1.participantAId as string;
    const qf2Winner = qf2.participantBId as string;
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
      startMatch(state, qf2.id, '2', c, mut);
      updateScore(state, state.matches[qf1.id], 'A', 3, c, mut);
      updateScore(state, state.matches[qf2.id], 'B', 3, c, mut);
      finishMatch(state, { matchId: qf1.id, winner: null, force: false }, c, mut);
      finishMatch(state, { matchId: qf2.id, winner: null, force: false }, c, mut);
    });

    const semi = round(1, 0);
    expect(semi.state).toBe('READY');
    expect(semi.participantAId).toBe(qf1Winner);
    expect(semi.participantBId).toBe(qf2Winner);
    expect(env.store.state.fields['1'].matchId).toBeNull();
    expect(env.store.state.fields['2'].matchId).toBeNull();
  });

  it('feeds both quarterfinal winners into the next round in the right slots', () => {
    const ctx = adminCtx(env.store);
    playMatch(env.store, round(0, 0).id, '1', 3, 0, ctx);
    playMatch(env.store, round(0, 1).id, '2', 0, 3, ctx);
    playMatch(env.store, round(0, 2).id, '1', 3, 1, ctx);
    playMatch(env.store, round(0, 3).id, '2', 2, 3, ctx);

    const semi1 = round(1, 0);
    const semi2 = round(1, 1);
    expect(nameOf(env.store, semi1.participantAId)).toBe('Player 01');
    expect(nameOf(env.store, semi1.participantBId)).toBe('Player 05');
    expect(nameOf(env.store, semi2.participantAId)).toBe('Player 02');
    expect(nameOf(env.store, semi2.participantBId)).toBe('Player 06');
    expect(semi1.state).toBe('READY');
    expect(semi2.state).toBe('READY');
  });

  it('auto assigns the freed field to the next match in the queue', () => {
    env.store.state.settings.autoAssignNext = true;
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      autoAssign(state, c, mut);
    });
    const first = env.store.state.fields['1'].matchId as string;
    playMatch(env.store, first, '1', 3, 0);
    const after = env.store.state.fields['1'].matchId;
    expect(after).toBeTruthy();
    expect(after).not.toBe(first);
    expect(env.store.state.matches[after as string].state).toBe('ASSIGNED');
  });

  it('swaps the two fields without losing a match', () => {
    const ctx = adminCtx(env.store);
    const qf1 = round(0, 0);
    const qf2 = round(0, 1);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      swapFields(state, mut);
    });
    expect(env.store.state.fields['1'].matchId).toBe(qf2.id);
    expect(env.store.state.fields['2'].matchId).toBe(qf1.id);
    expect(env.store.state.matches[qf1.id].fieldId).toBe('2');
    expect(env.store.state.matches[qf2.id].fieldId).toBe('1');
  });

  it('refuses to swap while a match is running', () => {
    const ctx = adminCtx(env.store);
    const qf1 = round(0, 0);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
    });
    expect(() => run(env.store, ctx, (state, _c, mut) => swapFields(state, mut))).toThrow(EngineError);
  });
});

describe('field ownership', () => {
  it('lets the first operator claim the field', () => {
    const operator = operatorCtx(env.store, '1', 'Operator A');
    run(env.store, operator, (state, c, mut) => claimField(state, '1', false, c, mut));
    expect(env.store.state.fields['1'].controlledBy).toBe('Operator A');
  });

  it('blocks a second operator from the same field', () => {
    run(env.store, operatorCtx(env.store, '1', 'Operator A'), (state, c, mut) =>
      claimField(state, '1', false, c, mut),
    );
    try {
      run(env.store, operatorCtx(env.store, '1', 'Operator B'), (state, c, mut) =>
        claimField(state, '1', false, c, mut),
      );
      throw new Error('expected FIELD_LOCKED');
    } catch (error) {
      expect((error as EngineError).code).toBe('FIELD_LOCKED');
      expect((error as EngineError).message).toContain('Operator A');
    }
    expect(env.store.state.fields['1'].controlledBy).toBe('Operator A');
  });

  it('lets the host force a release and hand the field over', () => {
    run(env.store, operatorCtx(env.store, '1', 'Operator A'), (state, c, mut) =>
      claimField(state, '1', false, c, mut),
    );
    const host = adminCtx(env.store);
    run(env.store, host, (state, c, mut) => releaseFieldClaim(state, '1', true, c, mut));
    expect(env.store.state.fields['1'].controlledBy).toBeNull();
    run(env.store, operatorCtx(env.store, '1', 'Operator B'), (state, c, mut) =>
      claimField(state, '1', false, c, mut),
    );
    expect(env.store.state.fields['1'].controlledBy).toBe('Operator B');
  });

  it('allows either field to be controlled by its own operator', () => {
    run(env.store, operatorCtx(env.store, '1', 'Operator A'), (state, c, mut) =>
      claimField(state, '1', false, c, mut),
    );
    run(env.store, operatorCtx(env.store, '2', 'Operator B'), (state, c, mut) =>
      claimField(state, '2', false, c, mut),
    );
    expect(env.store.state.fields['1'].controlledBy).toBe('Operator A');
    expect(env.store.state.fields['2'].controlledBy).toBe('Operator B');
  });
});

describe('operator permissions', () => {
  it('scopes an operator to its own field', () => {
    const operator = operatorCtx(env.store, '1');
    expect(() => assertFieldScope(operator, '2')).toThrow(EngineError);
    expect(() => assertFieldScope(operator, '1')).not.toThrow();
  });

  it('lets an operator score on its own field only', () => {
    const ctx = adminCtx(env.store);
    const qf1 = round(0, 0);
    const qf2 = round(0, 1);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, qf1.id, '1', c, mut);
      assignMatchToField(state, qf2.id, '2', c, mut);
      startMatch(state, qf1.id, '1', c, mut);
      startMatch(state, qf2.id, '2', c, mut);
    });
    const operator = operatorCtx(env.store, '1');
    run(env.store, operator, (state, c, mut) => {
      updateScore(state, state.matches[qf1.id], 'A', 1, c, mut);
    });
    expect(env.store.state.matches[qf1.id].scoreA).toBe(1);

    expect(() =>
      run(env.store, operator, (state, c, mut) => {
        assertFieldScope(c, '2', state.matches[qf2.id]);
        updateScore(state, state.matches[qf2.id], 'A', 1, c, mut);
      }),
    ).toThrow(EngineError);
    expect(env.store.state.matches[qf2.id].scoreA).toBe(0);
  });

  it('rejects a read-only session', () => {
    const spectator = env.store.createContext('Spectator', 'spectator', null);
    expect(() => assertFieldScope(spectator, '1')).toThrow(EngineError);
  });
});

describe('load behaviour', () => {
  it('keeps up with a long series of rapid score changes', () => {
    const ctx = adminCtx(env.store);
    const matchId = round(0, 0).id;
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, matchId, '1', c, mut);
      startMatch(state, matchId, '1', c, mut);
    });
    const started = Date.now();
    const rounds = 400;
    for (let i = 0; i < rounds; i += 1) {
      const side = i % 2 === 0 ? 'A' : 'B';
      run(env.store, ctx, (state, c, mut) => {
        updateScore(state, state.matches[matchId], side, 1, c, mut);
      });
    }
    const elapsed = Date.now() - started;
    expect(env.store.state.matches[matchId].history.length).toBeGreaterThan(0);
    // 400 individual score commands (each with a delta build) must stay well
    // under a second even on a slow laptop.
    expect(elapsed).toBeLessThan(2000);
  });

  it('handles a large bracket without quadratic blow-up', () => {
    const ctx = adminCtx(env.store);
    const started = Date.now();
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Big Cup',
          format: 'single-elimination',
          participants: Array.from({ length: 128 }, (_, i) => ({
            name: `Big ${i + 1}`,
            team: null,
            seed: null,
            checkedIn: true,
          })),
          thirdPlaceMatch: true,
          seeded: true,
          seedValue: 7,
          settings: null,
          generateBracketNow: true,
        },
        c,
        mut,
      );
    });
    const elapsed = Date.now() - started;
    expect(Object.keys(env.store.state.matches).length).toBe(128);
    expect(elapsed).toBeLessThan(3000);
  });
});
