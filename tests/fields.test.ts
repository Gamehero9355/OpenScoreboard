import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/shared/commands';
import { asFieldId, validateSettingsPatch } from '../src/shared/protocol';
import { fieldQueue, homeFieldOf, isOnField, sharedQueue } from '../src/shared/matchUtils';
import { MAX_FIELDS, type Match, type TournamentState } from '../src/shared/types';
import type { TournamentStore } from '../src/backend/store/store';
import { EngineError } from '../src/backend/util/errors';
import {
  createTournament,
  setFieldNames,
  updateParticipant,
} from '../src/backend/tournament/engine';
import {
  assignMatchToField,
  autoAssign,
  getNextAvailableMatch,
  startMatch,
  swapFields,
  unassignField,
} from '../src/backend/tournament/matchops';
import { buildDemoTournament } from '../src/backend/tournament/demo';
import {
  adminCtx,
  createTestStore,
  playableMatches,
  playMatch,
  run,
  type TestStore,
} from './helpers';

let env: TestStore;

beforeEach(async () => {
  env = await createTestStore('fields');
});

afterEach(async () => {
  await env.dispose();
});

function participants(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Player ${String(i + 1).padStart(2, '0')}`,
    team: null,
    seed: null,
    checkedIn: true,
  }));
}

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

describe('home-field queues', () => {
  /**
   * Eight players registered four and four on the two fields, drawn manually so
   * each field's players open against each other -- the way the wizard produces
   * a field-split draw.
   */
  function createFieldSplitTournament(store: TournamentStore) {
    const ctx = adminCtx(store);
    run(store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Two Hall Cup',
          format: 'single-elimination',
          participants: Array.from({ length: 8 }, (_, i) => ({
            name: `Player ${String(i + 1).padStart(2, '0')}`,
            team: null,
            seed: i + 1,
            checkedIn: true,
            fieldId: i < 4 ? '1' : '2',
          })),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          manualOrder: [0, 1, 2, 3, 4, 5, 6, 7],
        },
        c,
        mut,
      );
    });
    return ctx;
  }

  function at(state: TournamentState, round: number, position: number): Match {
    const match = Object.values(state.matches).find((m) => m.round === round && m.position === position);
    if (!match) throw new Error(`No match at round ${round} position ${position}`);
    return match;
  }

  it('reads the home field from where the players were registered', () => {
    createFieldSplitTournament(env.store);
    const state = env.store.state;
    expect(homeFieldOf(state, at(state, 0, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 1))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 2))).toBe('2');
    expect(homeFieldOf(state, at(state, 0, 3))).toBe('2');
    // Both semifinals are fed by one field each, so they belong to that field.
    expect(homeFieldOf(state, at(state, 1, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 1, 1))).toBe('2');
    // The final brings both fields together: either one, not neither.
    expect(homeFieldOf(state, at(state, 2, 0))).toBeNull();
  });

  it('knows the field of a match whose players are not decided yet', () => {
    createFieldSplitTournament(env.store);
    const state = env.store.state;
    const semi = at(state, 1, 0);
    expect(semi.participantAId).toBeNull();
    expect(semi.participantBId).toBeNull();
    // Nothing has been played, yet semifinal 1 is already Field 1's match.
    expect(homeFieldOf(state, semi)).toBe('1');
  });

  it('never offers a field a match from the other field’s queue', () => {
    createFieldSplitTournament(env.store);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      unassignField(state, '1', c, mut);
      unassignField(state, '2', c, mut);
    });
    const state = env.store.state;
    const forOne = getNextAvailableMatch(state, '1');
    const forTwo = getNextAvailableMatch(state, '2');
    expect(forOne).not.toBeNull();
    expect(forTwo).not.toBeNull();
    expect(homeFieldOf(state, forOne as Match)).toBe('1');
    expect(homeFieldOf(state, forTwo as Match)).toBe('2');
    expect(forOne?.id).not.toBe(forTwo?.id);
  });

  it('pre-loads each field with a match of its own, never the other field’s', () => {
    createFieldSplitTournament(env.store);
    const { fields, matches } = env.store.state;
    expect(homeFieldOf(env.store.state, matches[fields['1'].matchId as string])).toBe('1');
    expect(homeFieldOf(env.store.state, matches[fields['2'].matchId as string])).toBe('2');
  });

  it('hands a finishing field its own next match and leaves the other field alone', () => {
    createFieldSplitTournament(env.store);
    env.store.state.settings.autoAssignNext = true;
    const ctx = adminCtx(env.store);
    const state = env.store.state;
    const secondOwn = at(state, 0, 1);
    const otherField = state.fields['2'].matchId;
    playMatch(env.store, at(state, 0, 0).id, '1', 3, 0, ctx);
    expect(env.store.state.fields['1'].matchId).toBe(secondOwn.id);
    expect(env.store.state.fields['2'].matchId).toBe(otherField);
  });

  it('keeps a free field free while the other field still owns the open matches', () => {
    createFieldSplitTournament(env.store);
    env.store.state.settings.autoAssignNext = true;
    const ctx = adminCtx(env.store);
    const otherFieldMatch = env.store.state.fields['2'].matchId;
    // Field 1 plays its whole half: both quarterfinals, then its semifinal.
    playMatch(env.store, at(env.store.state, 0, 0).id, '1', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 0, 1).id, '1', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 1, 0).id, '1', 3, 0, ctx);
    const state = env.store.state;
    // The final is not ready (Field 2's semifinal has not been played) and the
    // two remaining quarterfinals belong to Field 2, so Field 1 stays free.
    expect(state.fields['1'].matchId).toBeNull();
    expect(state.fields['2'].matchId).toBe(otherFieldMatch);
    expect(getNextAvailableMatch(state, '1')).toBeNull();
    const nextForTwo = getNextAvailableMatch(state, '2');
    expect(nextForTwo).not.toBeNull();
    expect(homeFieldOf(state, nextForTwo as Match)).toBe('2');
  });

  it('lets either field play a match that mixes both fields', () => {
    createFieldSplitTournament(env.store);
    env.store.state.settings.autoAssignNext = true;
    const ctx = adminCtx(env.store);
    playMatch(env.store, at(env.store.state, 0, 0).id, '1', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 0, 1).id, '1', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 1, 0).id, '1', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 0, 2).id, '2', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 0, 3).id, '2', 3, 0, ctx);
    playMatch(env.store, at(env.store.state, 1, 1).id, '2', 3, 0, ctx);
    const final = at(env.store.state, 2, 0);
    expect(homeFieldOf(env.store.state, final)).toBeNull();
    // The field that just finished picks the mixed final up automatically.
    expect(env.store.state.fields['2'].matchId).toBe(final.id);
    expect(final.state).toBe('ASSIGNED');
    // ...and the other field could host it instead when a host asks for that.
    run(env.store, ctx, (state, c, mut) => {
      unassignField(state, '2', c, mut);
      assignMatchToField(state, final.id, '1', c, mut);
    });
    expect(env.store.state.fields['1'].matchId).toBe(final.id);
  });
});

describe('queue sections without field rosters', () => {
  /**
   * A tournament drawn without rosters -- a quick draw, an import, or a
   * tournament created before rosters existed. There is nothing to link a match
   * to a field by registration, so each field runs one section of the draw.
   */
  function createRosterlessTournament(store: TournamentStore, options: { count?: number; fieldNames?: string[] } = {}) {
    const count = options.count ?? 8;
    const ctx = adminCtx(store);
    run(store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Quick Draw Cup',
          format: 'single-elimination',
          participants: Array.from({ length: count }, (_, i) => ({
            name: `Player ${String(i + 1).padStart(2, '0')}`,
            team: null,
            seed: null,
            checkedIn: true,
          })),
          thirdPlaceMatch: true,
          seeded: true,
          seedValue: 20260921,
          settings: null,
          generateBracketNow: true,
          fieldNames: options.fieldNames ?? ['Field 1', 'Field 2'],
        },
        c,
        mut,
      );
    });
    return ctx;
  }

  function at(state: TournamentState, round: number, position: number): Match {
    const match = Object.values(state.matches).find((m) => m.round === round && m.position === position && m.bracket === 'winners');
    if (!match) throw new Error(`No winners match at round ${round} position ${position}`);
    return match;
  }

  it('gives each field one half of an eight-player draw', () => {
    createRosterlessTournament(env.store);
    const state = env.store.state;
    expect(homeFieldOf(state, at(state, 0, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 1))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 2))).toBe('2');
    expect(homeFieldOf(state, at(state, 0, 3))).toBe('2');
    // Each semifinal is fed by one field's half and stays with it.
    expect(homeFieldOf(state, at(state, 1, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 1, 1))).toBe('2');
    // The final and the bronze match bring both halves together.
    expect(homeFieldOf(state, at(state, 2, 0))).toBeNull();
    const third = Object.values(state.matches).find((m) => m.isThirdPlace);
    expect(third).toBeTruthy();
    expect(homeFieldOf(state, third as Match)).toBeNull();
  });

  it('pre-loads each field with its own section and hands it on after a finish', () => {
    createRosterlessTournament(env.store);
    env.store.state.settings.autoAssignNext = true;
    const state = env.store.state;
    expect(homeFieldOf(state, state.matches[state.fields['1'].matchId as string])).toBe('1');
    expect(homeFieldOf(state, state.matches[state.fields['2'].matchId as string])).toBe('2');
    const ctx = adminCtx(env.store);
    const otherField = state.fields['2'].matchId;
    playMatch(env.store, state.fields['1'].matchId as string, '1', 3, 0, ctx);
    // Field 1's own next match follows it; Field 2 is untouched.
    const next = env.store.state.fields['1'].matchId as string;
    expect(next).toBeTruthy();
    expect(homeFieldOf(env.store.state, env.store.state.matches[next])).toBe('1');
    expect(env.store.state.fields['2'].matchId).toBe(otherField);
  });

  it('survives a Radball sort-last round sentinel instead of spinning forever', () => {
    // Radball ranking and decision matches carry `round: 900` so they sort
    // after every real round. That is a sort sentinel, not a bracket depth, and
    // it used to reach the block-width maths as 2 ** 900 == Infinity, which
    // grew an unbounded Set and threw "Set maximum size exceeded" while the host
    // dashboard rendered -- taking the whole page down to a blank screen.
    createRosterlessTournament(env.store);
    const state = env.store.state;
    const final = at(state, 2, 0);
    final.round = 900;
    final.slotA = { kind: 'winner-of', matchId: at(state, 1, 0).id } as Match['slotA'];
    final.slotB = { kind: 'winner-of', matchId: at(state, 1, 1).id } as Match['slotB'];
    // Reachable, no throw, and honest about spanning both sections.
    expect(() => homeFieldOf(state, final)).not.toThrow();
    expect(homeFieldOf(state, final)).toBeNull();

    // A sentinel on a match whose feeders are missing takes the same path.
    const orphan = at(state, 1, 0);
    orphan.round = 900;
    orphan.slotA = { kind: 'winner-of', matchId: 'gone' } as Match['slotA'];
    orphan.slotB = { kind: 'winner-of', matchId: 'gone' } as Match['slotB'];
    expect(() => homeFieldOf(state, orphan)).not.toThrow();
  });

  it('splits a four-field draw into four sections', () => {    createRosterlessTournament(env.store, { fieldNames: ['A', 'B', 'C', 'D'] });
    const state = env.store.state;
    for (const [position, field] of [0, 1, 2, 3].map((p, i) => [p, String(i + 1)] as const)) {
      expect(homeFieldOf(state, at(state, 0, position))).toBe(field);
    }
    for (const fieldId of ['1', '2', '3', '4']) {
      expect(state.fields[fieldId].matchId).toBeTruthy();
    }
  });

  it('keeps byes inside the section they belong to', () => {
    createRosterlessTournament(env.store, { count: 6 });
    const state = env.store.state;
    expect(homeFieldOf(state, at(state, 0, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 1))).toBe('1');
    expect(homeFieldOf(state, at(state, 0, 2))).toBe('2');
    expect(homeFieldOf(state, at(state, 0, 3))).toBe('2');
    expect(homeFieldOf(state, at(state, 1, 0))).toBe('1');
    expect(homeFieldOf(state, at(state, 1, 1))).toBe('2');
  });

  it('treats a one-match draw as either field’s match', () => {
    createRosterlessTournament(env.store, { count: 2 });
    const state = env.store.state;
    const only = at(state, 0, 0);
    expect(homeFieldOf(state, only)).toBeNull();
    // Either field can take it, so a free Field 2 is not left waiting.
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (st, c, mut) => {
      unassignField(st, '1', c, mut);
    });
    expect(getNextAvailableMatch(env.store.state, '2')?.id).toBe(only.id);
  });
});

describe('demo tournament', () => {
  function createDemo(store: TournamentStore) {
    const ctx = adminCtx(store);
    run(store, ctx, (state, c, mut) => {
      buildDemoTournament(state, c, mut);
    });
    return ctx;
  }

  it('registers the demo roster on the fields so each field owns a queue', () => {
    createDemo(env.store);
    const state = env.store.state;
    const rosters = Object.values(state.participants).map((p) => p.fieldId);
    expect(rosters.every((fieldId) => fieldId !== null)).toBe(true);
    expect(rosters.filter((fieldId) => fieldId === '1')).toHaveLength(4);
    expect(rosters.filter((fieldId) => fieldId === '2')).toHaveLength(4);
    // Each field's opening round is its own, and both fields are pre-loaded.
    for (const fieldId of ['1', '2'] as const) {
      const onField = state.matches[state.fields[fieldId].matchId as string];
      expect(onField).toBeTruthy();
      expect(homeFieldOf(state, onField)).toBe(fieldId);
    }
    // The closing matches mix both rosters, so either field may host them.
    const rounds = state.tournament?.rounds ?? 3;
    const final = Object.values(state.matches).find((m) => m.bracket === 'winners' && m.round === rounds - 1);
    const thirdPlace = Object.values(state.matches).find((m) => m.isThirdPlace);
    expect(final, 'no final match').toBeTruthy();
    expect(thirdPlace, 'no third place match').toBeTruthy();
    expect(homeFieldOf(state, final as Match)).toBeNull();
    expect(homeFieldOf(state, thirdPlace as Match)).toBeNull();
  });

  it('never puts a demo match from one field into the other field’s queue', () => {
    const ctx = createDemo(env.store);
    run(env.store, ctx, (state, c, mut) => {
      unassignField(state, '1', c, mut);
      unassignField(state, '2', c, mut);
    });
    const state = env.store.state;
    // Everything open right now belongs to exactly one field.
    const open = Object.values(state.matches).filter((m) => m.state === 'READY' || m.state === 'ASSIGNED');
    expect(open.length).toBeGreaterThanOrEqual(4);
    for (const match of open) {
      expect(homeFieldOf(state, match)).not.toBeNull();
    }
    const forOne = getNextAvailableMatch(state, '1') as Match;
    const forTwo = getNextAvailableMatch(state, '2') as Match;
    expect(homeFieldOf(state, forOne)).toBe('1');
    expect(homeFieldOf(state, forTwo)).toBe('2');
  });
});

describe('a match on a field leaves the shared queue', () => {
  /**
   * The host dashboard splits the open matches into "this field's queue" and
   * "either field". A match that has already been placed on a ring is that
   * ring's match, so it must appear in exactly one list -- and the row must not
   * claim "either field" while also saying "on Field 2".
   *
   * Regression: the shared list filtered only on "no field owns this", so an
   * *assigned* mixed-field match stayed in it while running, and neither queue
   * claimed it as its own.
   */
  function createMixedFinal(store: TournamentStore) {
    const ctx = adminCtx(store);
    run(store, ctx, (state, c, mut) => {
      buildDemoTournament(state, c, mut);
    });
    // Play everything up to the final so it has two players and can be placed.
    const final = mixedFinal(store.state);
    const hasBoth = (m: Match): boolean => Boolean(m.participantAId && m.participantBId);
    for (let guard = 0; guard < 50 && !hasBoth(final); guard += 1) {
      const next = playableMatches(store).find((m) => m.id !== final.id && m.bracket !== 'third-place');
      if (!next) break;
      playMatch(store, next.id, homeFieldOf(store.state, next) ?? '1', 6, 3, ctx);
    }
    expect(final.participantAId).toBeTruthy();
    expect(final.participantBId).toBeTruthy();
    run(store, ctx, (state, c, mut) => {
      unassignField(state, '1', c, mut);
      unassignField(state, '2', c, mut);
    });
    expect(homeFieldOf(store.state, final)).toBeNull();
    return ctx;
  }

  function mixedFinal(state: TournamentState): Match {
    const final = Object.values(state.matches).find(
      (m) => m.bracket === 'winners' && m.round === (state.tournament?.rounds ?? 3) - 1,
    );
    if (!final) throw new Error('No final match');
    expect(homeFieldOf(state, final)).toBeNull();
    return final;
  }

  it('offers an unassigned mixed match to both queues as either field', () => {
    createMixedFinal(env.store);
    const state = env.store.state;
    const final = mixedFinal(state);
    for (const fieldId of ['1', '2'] as const) {
      expect(sharedQueue(state).map((m) => m.id)).toContain(final.id);
      expect(fieldQueue(state, fieldId).map((m) => m.id)).not.toContain(final.id);
    }
  });

  it('drops it from the shared list and gives it to the field once it is on one', () => {
    const ctx = createMixedFinal(env.store);
    const final = mixedFinal(env.store.state);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, final.id, '2', c, mut);
    });
    const state = env.store.state;
    expect(isOnField(state, final)).toBe(true);
    // Offered by one ring only -- not by both, and not as shared any more.
    expect(sharedQueue(state).map((m) => m.id)).not.toContain(final.id);
    expect(fieldQueue(state, '2').map((m) => m.id)).toContain(final.id);
    expect(fieldQueue(state, '1').map((m) => m.id)).not.toContain(final.id);
    // The host must never see the same match in two lists at once.
    const ids = [...fieldQueue(state, '1'), ...fieldQueue(state, '2'), ...sharedQueue(state)].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps it out of the shared list while it runs and after it finishes', () => {
    const ctx = createMixedFinal(env.store);
    const final = mixedFinal(env.store.state);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, final.id, '1', c, mut);
    });
    run(env.store, ctx, (state, c, mut) => {
      startMatch(state, final.id, '1', c, mut);
    });
    expect(sharedQueue(env.store.state).map((m) => m.id)).not.toContain(final.id);
    playMatch(env.store, final.id, '1', 6, 5, ctx);
    // Finished matches leave the queues altogether, but `fieldId` survives for
    // the results -- which is why `isOnField`, not `fieldId`, is the test.
    expect(final.fieldId).toBe('1');
    expect(sharedQueue(env.store.state).map((m) => m.id)).not.toContain(final.id);
    expect(fieldQueue(env.store.state, '1').map((m) => m.id)).not.toContain(final.id);
  });
});

describe('variable playing fields', () => {
  it('creates a tournament with four named fields', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Four Field Cup',
          format: 'single-elimination',
          participants: participants(8),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: 42,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['Matte A', 'Matte B', 'Matte C', 'Matte D'],
        },
        c,
        mut,
      );
    });
    const state = env.store.state;
    expect(Object.keys(state.fields)).toHaveLength(4);
    expect(state.fields['3'].name).toBe('Matte C');
    expect(state.settings.fieldNames).toEqual(['Matte A', 'Matte B', 'Matte C', 'Matte D']);
  });

  it('defaults to two fields when no field names are given', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Classic Cup',
          format: 'single-elimination',
          participants: participants(4),
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
    expect(Object.keys(env.store.state.fields)).toEqual(['1', '2']);
  });

  it('auto-assign fills every configured field', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Big Hall Cup',
          format: 'single-elimination',
          participants: participants(8),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: 7,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['A', 'B', 'C', 'D'],
        },
        c,
        mut,
      );
      autoAssign(state, c, mut);
    });
    const state = env.store.state;
    for (const id of ['1', '2', '3', '4']) {
      expect(state.fields[id].matchId).not.toBeNull();
    }
  });

  it('swaps any two fields, not just 1 and 2', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Swap Cup',
          format: 'single-elimination',
          participants: participants(8),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: 7,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['A', 'B', 'C'],
        },
        c,
        mut,
      );
    });
    // Clear every field first, then park two known matches on fields 1 and 3 so
    // the swap has an unambiguous starting point.
    run(env.store, ctx, (state, c, mut) => {
      unassignField(state, '1', c, mut);
      unassignField(state, '2', c, mut);
      unassignField(state, '3', c, mut);
    });
    const open = Object.values(env.store.state.matches)
      .filter((m) => m.state === 'READY')
      .sort((a, b) => a.round - b.round || a.position - b.position);
    expect(open.length).toBeGreaterThanOrEqual(2);
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, open[0].id, '1', c, mut);
      assignMatchToField(state, open[1].id, '3', c, mut);
      swapFields(state, mut, '1', '3');
    });
    expect(env.store.state.fields['1'].matchId).toBe(open[1].id);
    expect(env.store.state.fields['3'].matchId).toBe(open[0].id);
    expect(env.store.state.fields['2'].matchId).toBeNull();
  });

  it('adds a field later and refuses to remove an occupied one', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Grow Cup',
          format: 'single-elimination',
          participants: participants(4),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['A', 'B'],
        },
        c,
        mut,
      );
      setFieldNames(state, ['A', 'B', 'C'], mut);
    });
    expect(Object.keys(env.store.state.fields)).toEqual(['1', '2', '3']);

    const open = Object.values(env.store.state.matches).filter(
      (m) => m.state === 'READY' || m.state === 'ASSIGNED',
    );
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, open[0].id, '3', c, mut);
      expectEngineError(() => setFieldNames(state, ['A', 'B'], mut), 'FIELD_BUSY');
    });
    // Removing a free field works.
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, open[0].id, '1', c, mut);
      setFieldNames(state, ['A', 'B'], mut);
    });
    expect(Object.keys(env.store.state.fields)).toEqual(['1', '2']);
  });

  it('refuses to remove a field a match still names, even when the field looks free', () => {
    // The other direction of the same relationship. `fields['3'].matchId` can be
    // null while a match still carries `fieldId: '3'` -- a hand-edited or
    // partially-written file can disagree with itself. Letting the removal
    // through left a `fieldId` that no state has any more, which the boards,
    // the print sheet and the results table all dereference.
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Three Field Cup',
          format: 'single-elimination',
          participants: participants(4),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['A', 'B', 'C'],
        },
        c,
        mut,
      );
    });
    expect(Object.keys(env.store.state.fields)).toEqual(['1', '2', '3']);

    const open = Object.values(env.store.state.matches).filter((m) => m.state === 'READY' || m.state === 'ASSIGNED');
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, open[0].id, '3', c, mut);
    });
    // Now make the field look free while the match still names it.
    run(env.store, ctx, (state, _c, mut) => {
      const field = state.fields['3'];
      if (field) field.matchId = null;
      mut.fields.add('3');
    });
    const match = env.store.state.matches[open[0].id];
    expect(match.fieldId).toBe('3');
    expect(env.store.state.fields['3'].matchId).toBeNull();

    run(env.store, ctx, (state, _c, mut) => {
      expectEngineError(() => setFieldNames(state, ['A', 'B'], mut), 'FIELD_BUSY');
    });
    // Refused, so nothing moved.
    expect(Object.keys(env.store.state.fields)).toEqual(['1', '2', '3']);
    expect(env.store.state.matches[open[0].id].fieldId).toBe('3');
  });
});

describe('manual bracket draw', () => {
  it('places players into the exact slots the host picked', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Manual Cup',
          format: 'single-elimination',
          participants: participants(4),
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          // Slot order: P4 vs P1, P3 vs P2 (indexes into the participant list).
          manualOrder: [3, 0, 2, 1],
        },
        c,
        mut,
      );
    });
    const round0 = Object.values(env.store.state.matches)
      .filter((m) => m.round === 0)
      .sort((a, b) => a.position - b.position);
    expect(round0).toHaveLength(2);
    const names = (id: string | null) => (id ? env.store.state.participants[id].name : null);
    expect([names(round0[0].participantAId), names(round0[0].participantBId)]).toEqual([
      'Player 04',
      'Player 01',
    ]);
    expect([names(round0[1].participantAId), names(round0[1].participantBId)]).toEqual([
      'Player 03',
      'Player 02',
    ]);
  });

  it('refuses a manual bracket with the wrong slot count', () => {
    const ctx = adminCtx(env.store);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          createTournament(
            state,
            {
              name: 'Broken Cup',
              format: 'single-elimination',
              participants: participants(4),
              thirdPlaceMatch: false,
              seeded: true,
              seedValue: null,
              settings: null,
              generateBracketNow: true,
              manualOrder: [0, 1],
            },
            c,
            mut,
          );
        }),
      'BAD_REQUEST',
    );
  });

  it('rejects a duplicated participant in the create command', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Dup Cup',
      format: 'single-elimination',
      participants: participants(4),
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracket: true,
      manualOrder: [0, 0, 1, 2],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts field names and a manual order in the create command', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Full Cup',
      format: 'single-elimination',
      participants: participants(4),
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracket: true,
      fieldNames: ['Ring 1', 'Ring 2', 'Ring 3'],
      manualOrder: [0, 1, 2, 3],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts the standard Radball preset and replacement acknowledgement', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Standard Radball',
      format: 'radball',
      participants: [1, 2, 3].map((index) => ({
        name: `Team ${index}`,
        team: `Club ${index}`,
        players: [`Player A${index}`, `Player B${index}`],
      })),
      radball: { preset: 'radball-standard-2025' },
      confirmReplace: true,
      expectedTournamentId: 'old-tournament',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.confirmReplace).toBe(true);
      expect(result.value.expectedTournamentId).toBe('old-tournament');
    }
  });

  it('scopes Radball team and player uniqueness to each field', () => {
    const common = {
      name: 'Shared Radball Roster',
      format: 'radball' as const,
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracket: true,
      fieldNames: ['Field 1', 'Field 2'],
      radball: { preset: 'radball-standard-2025' },
    };
    const participant = (name: string, fieldId: '1' | '2', players: [string, string]) => ({
      name,
      team: null,
      seed: null,
      checkedIn: true,
      fieldId,
      players,
    });
    const acrossFields = COMMANDS['tournament.create'].validate({
      ...common,
      participants: [
        participant('Team A', '1', ['Anna', 'Lena']),
        participant('Team B', '1', ['Marie', 'Clara']),
        participant('Team A', '2', ['Anna', 'Lena']),
        participant('Team C', '2', ['David', 'Eva']),
      ],
    });
    expect(acrossFields.ok).toBe(true);

    const duplicateTeam = COMMANDS['tournament.create'].validate({
      ...common,
      participants: [
        participant('Team A', '1', ['Anna', 'Lena']),
        participant('Team A', '1', ['Marie', 'Clara']),
        participant('Team C', '2', ['David', 'Eva']),
      ],
    });
    expect(duplicateTeam.ok).toBe(false);
    if (!duplicateTeam.ok) expect(duplicateTeam.error).toContain('Field 1 already contains team');

    const duplicatePlayer = COMMANDS['tournament.create'].validate({
      ...common,
      participants: [
        participant('Team A', '1', ['Anna', 'Lena']),
        participant('Team B', '1', ['Anna', 'Clara']),
        participant('Team C', '2', ['David', 'Eva']),
      ],
    });
    expect(duplicatePlayer.ok).toBe(false);
    if (!duplicatePlayer.ok) expect(duplicatePlayer.error).toContain('Field 1 already contains player');
  });

  it('rejects a non-boolean replacement acknowledgement', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Bad Confirmation',
      participants: participants(4),
      confirmReplace: 'yes',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects too many fields in the create command', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Huge Cup',
      format: 'single-elimination',
      participants: participants(4),
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracket: true,
      fieldNames: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => `Field ${i + 1}`),
    });
    expect(result.ok).toBe(false);
  });
});

describe('participants per field', () => {
  it('stores the home field each participant registered on', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Roster Cup',
          format: 'single-elimination',
          participants: [
            { name: 'Player 01', team: null, seed: null, checkedIn: true, fieldId: '1' },
            { name: 'Player 02', team: null, seed: null, checkedIn: true, fieldId: '1' },
            { name: 'Player 03', team: null, seed: null, checkedIn: true, fieldId: '2' },
            { name: 'Player 04', team: null, seed: null, checkedIn: true, fieldId: '2' },
          ],
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          fieldNames: ['Matte A', 'Matte B'],
        },
        c,
        mut,
      );
    });
    const byName = new Map(
      Object.values(env.store.state.participants).map((p) => [p.name, p.fieldId]),
    );
    expect(byName.get('Player 01')).toBe('1');
    expect(byName.get('Player 03')).toBe('2');
  });

  it('refuses a home field that does not exist', () => {
    const ctx = adminCtx(env.store);
    expectEngineError(
      () =>
        run(env.store, ctx, (state, c, mut) => {
          createTournament(
            state,
            {
              name: 'Lost Cup',
              format: 'single-elimination',
              participants: [
                { name: 'Player 01', team: null, seed: null, checkedIn: true, fieldId: '1' },
                { name: 'Player 02', team: null, seed: null, checkedIn: true, fieldId: '5' },
              ],
              thirdPlaceMatch: false,
              seeded: true,
              seedValue: null,
              settings: null,
              generateBracketNow: true,
              fieldNames: ['A', 'B'],
            },
            c,
            mut,
          );
        }),
      'BAD_REQUEST',
    );
  });

  it('rejects a participant field beyond the created fields in the command', () => {
    const result = COMMANDS['tournament.create'].validate({
      name: 'Far Cup',
      format: 'single-elimination',
      participants: [
        { name: 'Player 01', fieldId: '3' },
        { name: 'Player 02', fieldId: '1' },
      ],
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracket: true,
      fieldNames: ['A', 'B'],
    });
    expect(result.ok).toBe(false);
  });

  it('moves a participant to another field later', () => {
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (state, c, mut) => {
      createTournament(
        state,
        {
          name: 'Move Cup',
          format: 'single-elimination',
          participants: [
            { name: 'Player 01', team: null, seed: null, checkedIn: true, fieldId: '1' },
            { name: 'Player 02', team: null, seed: null, checkedIn: true, fieldId: '1' },
          ],
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: false,
          fieldNames: ['A', 'B'],
        },
        c,
        mut,
      );
    });
    const id = env.store.state.participantOrder[0];
    const validated = COMMANDS['participant.update'].validate({ id, fieldId: '2' });
    expect(validated.ok).toBe(true);
    run(env.store, ctx, (state, c, mut) => {
      updateParticipant(state, id, { fieldId: '2' }, c, mut);
    });
    expect(env.store.state.participants[id].fieldId).toBe('2');
  });
});

describe('field validation', () => {
  it('accepts field ids 1..MAX_FIELDS', () => {
    expect(asFieldId('1')).toBe('1');
    expect(asFieldId('4')).toBe('4');
    expect(asFieldId(String(MAX_FIELDS))).toBe(String(MAX_FIELDS));
    expect(asFieldId('0')).toBeNull();
    expect(asFieldId('9')).toBeNull();
    expect(asFieldId('')).toBeNull();
  });

  it('validates a multi-field settings patch', () => {
    const current = env.store.state.settings;
    const ok = validateSettingsPatch({ fieldNames: ['A', 'B', 'C'] }, current);
    expect(ok.ok).toBe(true);
    const empty = validateSettingsPatch({ fieldNames: [] }, current);
    expect(empty.ok).toBe(false);
    const tooMany = validateSettingsPatch(
      { fieldNames: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => `F${i}`) },
      current,
    );
    expect(tooMany.ok).toBe(false);
  });

  it('validates the swap command payload', () => {
    expect(COMMANDS['match.swapFields'].validate({}).ok).toBe(true);
    expect(COMMANDS['match.swapFields'].validate({ fieldA: '1', fieldB: '3' }).ok).toBe(true);
    expect(COMMANDS['match.swapFields'].validate({ fieldA: '1', fieldB: '1' }).ok).toBe(false);
    expect(COMMANDS['match.swapFields'].validate({ fieldA: '1', fieldB: '9' }).ok).toBe(false);
  });

  it('preserves exact timer durations', () => {
    const command = COMMANDS['match.setTimer'].validate({ matchId: 'match-1', durationSec: 185.75 });
    expect(command.ok && command.value.durationSec).toBe(185.75);
    expect(COMMANDS['match.setTimer'].validate({ matchId: 'match-1', durationSec: '185.75' }).ok).toBe(true);
    expect(COMMANDS['match.setTimer'].validate({ matchId: 'match-1', durationSec: 0.5 }).ok).toBe(false);

    const settings = validateSettingsPatch({ defaultMatchDurationSec: 185.75 }, env.store.state.settings);
    expect(settings.ok && settings.value.defaultMatchDurationSec).toBe(185.75);
  });
});
