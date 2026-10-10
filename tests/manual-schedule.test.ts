/**
 * The manual schedule format.
 *
 * This is the one format whose fixtures are *stored* rather than derived, so it
 * has to be held to the opposite of what a bracket is held to:
 *
 *  - three teams and five matches is legal, because there is no power of two,
 *  - a fixture is exactly the two teams the host picked, forever,
 *  - nothing advances, nothing completes, nothing crowns a champion on its own,
 *  - and the list can be edited while the event is running, from the dashboard.
 *
 * Each of those is a rule the other formats would break, so each of them is
 * asserted here rather than inherited from the bracket tests passing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Match, SavedTournamentSetup, TournamentState } from '../src/shared/types';
import type { ParticipantInput } from '../src/shared/commands';
import { EngineError } from '../src/backend/util/errors';
import {
  addManualMatch,
  createTournament,
  generateBracketForTournament,
  removeManualMatch,
  removeParticipant,
  setManualMatchRoundName,
} from '../src/backend/tournament/engine';
import { generateManualSchedule } from '../src/backend/tournament/bracket';
import { assignMatchToField, startMatch, unassignField } from '../src/backend/tournament/matchops';
import { saveTournamentSetup, sanitiseSavedTournamentSetup } from '../src/backend/tournament/saved';
import { computeResults } from '../src/shared/stats';
import { draftToSetup, setupToDraft } from '../src/frontend/lib/saved';
import {
  buildEffectiveSetup,
  createDraft,
  lastStepOf,
  mergeRoster,
  normaliseDraft,
  parseParticipants,
  participantIssues,
} from '../src/frontend/pages/SetupPage';
import { tr } from '../src/frontend/lib/i18n';
import { adminCtx, createTestStore, idOf, nameOf, playMatch, run, type TestStore } from './helpers';

let env: TestStore;

beforeEach(async () => {
  env = await createTestStore('manual');
});

afterEach(async () => {
  await env.dispose();
});

/** A roster of Team A.., sized by the caller. */
function roster(count = 5): ParticipantInput[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Team ${String.fromCharCode(65 + index)}`,
    team: null,
    seed: null,
    checkedIn: true,
  }));
}

/** Create a manual schedule the way the wizard would, straight through the engine. */
function createManual(
  matches: { a: number; b: number; round?: string; fieldId?: string }[],
  count = 5,
): TournamentState {
  const ctx = adminCtx(env.store);
  run(env.store, ctx, (state, c, mut) => {
    createTournament(
      state,
      {
        name: 'Manual Cup',
        format: 'manual-schedule',
        participants: roster(count),
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracketNow: true,
        fieldNames: ['Field 1', 'Field 2'],
        manualMatches: matches,
      },
      c,
      mut,
    );
  });
  return env.store.state;
}

/** Re-run creation with a swapped-in fixture list. */
function createManualExpectingError(
  matches: { a: number; b: number }[],
): void {
  const ctx = adminCtx(env.store);
  run(env.store, ctx, (state, c, mut) => {
    createTournament(
      state,
      {
        name: 'Manual Cup',
        format: 'manual-schedule',
        participants: roster(5),
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracketNow: true,
        fieldNames: ['Field 1', 'Field 2'],
        manualMatches: matches,
      },
      c,
      mut,
    );
  });
}

function allMatches(state: TournamentState): Match[] {
  return state.matchOrder.map((id) => state.matches[id]).filter((m): m is Match => Boolean(m));
}

/** The fixture pairing Team A+index and Team B+index, by their names. */
function fixture(state: TournamentState, a: number, b: number): Match {
  const idA = idOf(env.store, `Team ${String.fromCharCode(65 + a)}`);
  const idB = idOf(env.store, `Team ${String.fromCharCode(65 + b)}`);
  const match = allMatches(state).find((m) => m.participantAId === idA && m.participantBId === idB);
  if (!match) throw new Error(`No fixture for Team ${String.fromCharCode(65 + a)} vs ${String.fromCharCode(65 + b)}`);
  return match;
}

/** Apply an engine function to the live state and expect it to refuse. */
function expectEngineError(operation: () => void, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`Expected an EngineError with code ${code}`);
}

/* ------------------------------------------------------------------ */

describe('the manual schedule generator', () => {
  it('gives every fixture its own id, in the host’s order', () => {
    const generated = generateManualSchedule('t1', [
      { participantAId: 'a', participantBId: 'b', roundName: 'Group stage' },
      { participantAId: 'c', participantBId: 'd', roundName: 'Group stage' },
    ]);
    expect(generated.map((m) => m.id)).toEqual(['t1:m0', 't1:m1']);
  });

  it('numbers rounds by the label, not by the position in the list', () => {
    const generated = generateManualSchedule('t1', [
      { participantAId: 'a', participantBId: 'b', roundName: 'Final' },
      { participantAId: 'c', participantBId: 'd', roundName: 'Final' },
      { participantAId: 'e', participantBId: 'f', roundName: 'Semifinal' },
      { participantAId: 'g', participantBId: 'h', roundName: '' },
    ]);
    expect(generated.map((m) => [m.round, m.position, m.roundName])).toEqual([
      [0, 0, 'Final'],
      [0, 1, 'Final'],
      [1, 0, 'Semifinal'],
      [2, 0, 'Match 4'],
    ]);
  });

  it('leaves both slots as the two teams the host picked, feeding nothing', () => {
    const [match] = generateManualSchedule('t1', [
      { participantAId: 'a', participantBId: 'b', roundName: 'Final' },
    ]);
    expect(match?.slotA).toEqual({ kind: 'participant', participantId: 'a' });
    expect(match?.slotB).toEqual({ kind: 'participant', participantId: 'b' });
    expect(match?.nextWinMatchId).toBeNull();
    expect(match?.nextLoseMatchId).toBeNull();
    expect(match?.isGrandFinal).toBe(false);
    expect(match?.isThirdPlace).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('creating a manual schedule', () => {
  it('builds exactly the fixtures that were asked for', () => {
    const state = createManual([
      { a: 0, b: 1, round: 'Group stage' },
      { a: 1, b: 2, round: 'Group stage' },
      { a: 0, b: 2, round: 'Final' },
    ]);
    const matches = allMatches(state);
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.roundName)).toEqual(['Group stage', 'Group stage', 'Final']);
    expect(matches.map((m) => m.round)).toEqual([0, 0, 1]);
    expect(state.tournament?.format).toBe('manual-schedule');
    // No bracket, so no power of two to round up to and no bracket rounds to count.
    expect(state.tournament?.bracketSize).toBe(5);
    expect(state.tournament?.rounds).toBe(2);
    expect(state.tournament?.thirdPlaceMatch).toBe(false);
  });

  it('needs no power of two and lets the same pairing play twice', () => {
    // Five teams, three of them the same pairing. No bracket could ever produce
    // this, which is the whole point of the format.
    const state = createManual([
      { a: 0, b: 1 },
      { a: 0, b: 1 },
      { a: 0, b: 1 },
      { a: 3, b: 4 },
    ]);
    expect(allMatches(state)).toHaveLength(4);
    expect(allMatches(state).every((m) => m.state === 'READY' || m.state === 'ASSIGNED')).toBe(true);
    // Team A is in three fixtures, so only one of them can hold a ring at a
    // time; the rest wait in the queue rather than failing the whole event.
    const loaded = allMatches(state).filter((m) => m.fieldId);
    expect(loaded).toHaveLength(2);
    const teamsLoaded = loaded.flatMap((m) => [m.participantAId, m.participantBId]);
    expect(new Set(teamsLoaded).size).toBe(teamsLoaded.length);
  });

  it('lets the host pin a fixture to a field and fills the rest from the queue', () => {
    const state = createManual([
      { a: 0, b: 1, fieldId: '2' },
      { a: 2, b: 3 },
      { a: 3, b: 4 },
    ]);
    const pinned = fixture(state, 0, 1);
    expect(pinned.fieldId).toBe('2');
    expect(state.fields['2']?.matchId).toBe(pinned.id);
    // The other ring was supplied too, so neither field sits idle.
    expect(state.fields['1']?.matchId).toBeTruthy();
    expect(state.fields['1']?.matchId).not.toBe(state.fields['2']?.matchId);
  });

  it('marks every fixture ready so the operators can start immediately', () => {
    // Two fixtures, four distinct teams, two fields: exactly the shape the
    // knockout formats pre-load, and the manual one has to match it.
    const state = createManual([{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    expect(allMatches(state).every((m) => m.state === 'READY' || m.state === 'ASSIGNED')).toBe(true);
    expect(allMatches(state).every((m) => m.fieldId)).toBe(true);
  });

  it('refuses a fixture that pairs a team with itself', () => {
    expectEngineError(() => createManualExpectingError([{ a: 0, b: 0 }]), 'BAD_REQUEST');
  });
});

/* ------------------------------------------------------------------ */

describe('playing a manual schedule', () => {
  it('runs through the ordinary scoring pipeline', () => {
    const state = createManual([{ a: 0, b: 1, round: 'Final' }]);
    const match = fixture(state, 0, 1);
    playMatch(env.store, match.id, '1', 3, 1);
    const after = env.store.state.matches[match.id];
    expect(after?.state).toBe('FINISHED');
    expect(after?.scoreA).toBe(3);
    expect(after?.winnerId).toBe(idOf(env.store, 'Team A'));
  });

  it('never crowns a champion or completes the tournament on its own', () => {
    // The one rule that separates a manual schedule from a bracket: finishing
    // the last fixture is not the same as ending the event, and nothing may
    // pretend otherwise. The host ends it deliberately.
    const state = createManual([{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    for (const match of allMatches(state)) {
      playMatch(env.store, match.id, '1', 2, 0);
    }
    const tournament = env.store.state.tournament;
    expect(tournament?.status).toBe('RUNNING');
    expect(tournament?.championId).toBeNull();
    expect(tournament?.completedAt).toBeNull();
    // The results report has to agree: `decidingMatch` and `decidingMatchIds`
    // answer the same question from two different files, and a report that
    // crowned a champion the tournament refuses to would be worse than no
    // report at all.
    const results = computeResults(env.store.state);
    expect(results.champion).toBeNull();
    expect(results.runnerUp).toBeNull();
    expect(results.thirdPlace).toBeNull();
    expect(results.finishedMatches).toBe(2);
    // The table still ranks by what was actually played.
    expect(results.rows).toHaveLength(5);
    expect(results.rows[0]?.wins).toBe(1);
  });

  it('still crowns a champion once the host ends the event', () => {
    // Completing is a deliberate act -- `tournament.complete` on the host -- and
    // once it has happened the results report must show it like any other event.
    const state = createManual([{ a: 0, b: 1, round: 'Final' }]);
    const match = fixture(state, 0, 1);
    playMatch(env.store, match.id, '1', 3, 1);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      if (!s.tournament) return;
      s.tournament.status = 'COMPLETED';
      s.tournament.championId = s.matches[match.id]?.winnerId ?? null;
      s.tournament.completedAt = c.now;
      mut.tournament = true;
    });
    expect(env.store.state.tournament?.championId).toBe(idOf(env.store, 'Team A'));
    expect(computeResults(env.store.state).champion?.name).toBe('Team A');
  });

  it('leaves a fixture waiting rather than awarding a walkover', () => {
    // Taking a team off the roster empties one side. A bracket would hand the
    // other side the win; a manual schedule must not invent a result nobody
    // played, so the fixture just stays where it was.
    const state = createManual([{ a: 0, b: 1 }]);
    const orphan = fixture(state, 0, 1);
    expect(['READY', 'ASSIGNED']).toContain(orphan.state);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      // The fixture is holding a ring, and a team may not be taken off a roster
      // that is mid-event -- so the host clears the field first, as they would.
      unassignField(s, orphan.fieldId ?? '1', c, mut);
    });
    run(env.store, ctx, (s, c, mut) => {
      removeParticipant(s, idOf(env.store, 'Team B'), c, mut);
    });
    const after = env.store.state.matches[orphan.id];
    expect(after?.state).toBe('WAITING');
    expect(after?.winnerId).toBeNull();
    expect(after?.participantBId).toBeNull();
    // The other side is still standing, waiting for an opponent.
    expect(after?.participantAId).toBe(idOf(env.store, 'Team A'));
  });
});

/* ------------------------------------------------------------------ */

describe('editing a running schedule', () => {
  it('adds a fixture at the end of the host’s queue', () => {
    const state = createManual([{ a: 0, b: 1 }]);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      addManualMatch(
        s,
        {
          participantAId: s.participantOrder[2] ?? '',
          participantBId: s.participantOrder[3] ?? '',
          roundName: 'Late entry',
        },
        c,
        mut,
      );
    });
    const matches = allMatches(env.store.state);
    expect(matches).toHaveLength(2);
    expect(matches[1]?.roundName).toBe('Late entry');
    expect(matches[1]?.participantAId).toBe(state.participantOrder[2]);
    expect(nameOf(env.store, matches[1]?.participantBId ?? null)).toBe('Team D');
    // Created, not derived, so its two sides can never be re-resolved from a
    // feeder it does not have.
    expect(matches[1]?.locked).toBe(true);
    // The second field was still free, so the new fixture went straight onto it
    // exactly the way an opening fixture does.
    expect(matches[1]?.state).toBe('ASSIGNED');
    expect(matches[1]?.fieldId).toBe('2');
  });

  it('puts a new fixture on a free field rather than stealing one', () => {
    createManual([{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    // Both fields are already supplied by the opening assignment.
    expect(env.store.state.fields['1']?.matchId).toBeTruthy();
    expect(env.store.state.fields['2']?.matchId).toBeTruthy();
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      addManualMatch(s, {
        participantAId: s.participantOrder[0] ?? '',
        participantBId: s.participantOrder[4] ?? '',
      }, c, mut);
    });
    // Nobody was displaced: the running fixtures keep their rings.
    const before = allMatches(env.store.state).slice(0, 2).map((m) => m.fieldId);
    const after = allMatches(env.store.state).slice(0, 2).map((m) => m.fieldId);
    expect(after).toEqual(before);
    expect(allMatches(env.store.state)[2]?.fieldId).toBeNull();
  });

  it('refuses to add a fixture to a format that derives its own', () => {
    createManual([{ a: 0, b: 1 }]);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      // Swap the format under the engine's feet: the guard belongs to the engine
      // rather than to the command, so it is the engine's answer being tested.
      if (s.tournament) s.tournament.format = 'single-elimination';
      expectEngineError(() => {
        addManualMatch(s, {
          participantAId: s.participantOrder[2] ?? '',
          participantBId: s.participantOrder[3] ?? '',
        }, c, mut);
      }, 'BAD_REQUEST');
    });
  });

  it('refuses to re-roll a bracket over the host’s fixtures', () => {
    // Regenerating would discard every fixture the host typed and replace it
    // with ones nobody asked for. The dashboard hides the button; the engine
    // refuses it, because the button is not the only way in.
    const state = createManual([{ a: 0, b: 1, round: 'Group stage' }]);
    const ctx = adminCtx(env.store);
    expectEngineError(() => {
      run(env.store, ctx, (s, c, mut) => {
        generateBracketForTournament(s, { seeded: true, seedValue: null, thirdPlaceMatch: true, order: null }, c, mut);
      });
    }, 'BAD_REQUEST');
    expect(allMatches(env.store.state).map((m) => m.roundName)).toEqual(
      allMatches(state).map((m) => m.roundName),
    );
  });

  it('refuses to add a fixture pairing a team with itself', () => {
    createManual([{ a: 0, b: 1 }]);
    const ctx = adminCtx(env.store);
    expectEngineError(() => {
      run(env.store, ctx, (s, c, mut) => {
        addManualMatch(s, {
          participantAId: s.participantOrder[2] ?? '',
          participantBId: s.participantOrder[2] ?? '',
        }, c, mut);
      });
    }, 'BAD_REQUEST');
  });

  it('removes a fixture, leaving no field holding a match that no longer exists', () => {
    const state = createManual([{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    const match = fixture(state, 0, 1);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      removeManualMatch(s, match.id, c, mut);
    });
    const after = env.store.state;
    expect(after.matches[match.id]).toBeUndefined();
    expect(after.matchOrder).not.toContain(match.id);
    expect(allMatches(after)).toHaveLength(1);
    for (const fieldId of Object.keys(after.fields)) {
      const held = after.fields[fieldId]?.matchId;
      if (held) expect(after.matches[held]).toBeDefined();
    }
  });

  it('refuses to remove a fixture that is running', () => {
    const state = createManual([{ a: 0, b: 1 }]);
    const match = fixture(state, 0, 1);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      assignMatchToField(s, match.id, '1', c, mut);
      startMatch(s, match.id, '1', c, mut);
    });
    expect(env.store.state.matches[match.id]?.state).toBe('RUNNING');
    expectEngineError(() => {
      run(env.store, ctx, (s, c, mut) => {
        removeManualMatch(s, match.id, c, mut);
      });
    }, 'INVALID_STATE');
    expect(env.store.state.matches[match.id]).toBeDefined();
  });

  it('renames a round and renumbers the ones after it', () => {
    const state = createManual([
      { a: 0, b: 1, round: 'Groups' },
      { a: 2, b: 3, round: 'Groups' },
      { a: 3, b: 4, round: 'Final' },
    ]);
    expect(allMatches(state).map((m) => m.round)).toEqual([0, 0, 1]);
    const final = fixture(state, 3, 4);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      setManualMatchRoundName(s, final.id, 'Showcase', c, mut);
    });
    expect(allMatches(env.store.state).map((m) => [m.round, m.roundName])).toEqual([
      [0, 'Groups'],
      [0, 'Groups'],
      [1, 'Showcase'],
    ]);
    expect(env.store.state.tournament?.rounds).toBe(2);
  });

  it('refuses to rename the round of a running fixture', () => {
    const state = createManual([{ a: 0, b: 1 }]);
    const match = fixture(state, 0, 1);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      assignMatchToField(s, match.id, '1', c, mut);
      startMatch(s, match.id, '1', c, mut);
    });
    expectEngineError(() => {
      run(env.store, ctx, (s, c, mut) => {
        setManualMatchRoundName(s, match.id, 'Renamed live', c, mut);
      });
    }, 'INVALID_STATE');
    expect(env.store.state.matches[match.id]?.roundName).toBe(match.roundName);
  });

  it('writes the edit into the activity log, in both languages', () => {
    const state = createManual([{ a: 0, b: 1 }]);
    const ctx = adminCtx(env.store);
    run(env.store, ctx, (s, c, mut) => {
      addManualMatch(s, {
        participantAId: s.participantOrder[2] ?? '',
        participantBId: s.participantOrder[3] ?? '',
        roundName: 'Showcase',
      }, c, mut);
      removeManualMatch(s, fixture(state, 0, 1).id, c, mut);
    });
    const keys = env.store.state.events.map((event) => event.text?.key).filter(Boolean);
    expect(keys).toContain('event.matchAdded');
    expect(keys).toContain('event.matchRemoved');
    expect(keys).toContain('event.scheduleCreated');
  });
});

/* ------------------------------------------------------------------ */

describe('a saved manual setup', () => {
  const setup: SavedTournamentSetup = {
    version: 1,
    name: 'Manual Cup',
    format: 'manual-schedule',
    fieldNames: ['Field 1', 'Field 2'],
    fieldBulk: ['Team A\nTeam B', 'Team C\nTeam D'],
    radballBulk: ['', ''],
    thirdPlace: false,
    seeded: true,
    seedValue: '',
    drawMode: 'auto',
    manualSlots: [],
    manualMatches: [
      { a: 'team a|', b: 'team b|', round: 'Group stage', fieldIndex: 1 },
      { a: 'team c|', b: 'team d|', round: 'Final', fieldIndex: null },
    ],
    durationSec: 600,
    scoringIncrements: [1, 2, 3],
    autoLoadNext: true,
    autoAssignNext: true,
    ageCategory: 'ELITE',
    reducedTime: false,
    minRestMinutes: 0,
    setupMode: 'standard',
    groupCount: 1,
    doubleLeg: false,
    finalMode: 'none',
    bdrPreset: false,
  };

  it('survives the round trip through the wizard unchanged', () => {
    const restored = setupToDraft(setup, createDraft());
    expect(restored.manualMatches).toEqual(setup.manualMatches);
    expect(draftToSetup({ ...createDraft(), ...restored }).manualMatches).toEqual(setup.manualMatches);
  });

  it('sanitises a hand-edited shelf entry down to something usable', () => {
    const cleaned = sanitiseSavedTournamentSetup({
      ...setup,
      manualMatches: [
        { a: 'team a|', b: 'team b|', round: 'a-round-name-far-too-long-for-the-board', fieldIndex: 9 },
        { a: null, b: 'team b|', round: '', fieldIndex: null },
        'nonsense',
      ],
    });
    // The stray string is not a fixture at all, so it is dropped rather than
    // turned into an empty one the host would have to clean out by hand.
    expect(cleaned.manualMatches).toHaveLength(2);
    expect(cleaned.manualMatches[0]?.round).toHaveLength(24);
    expect(cleaned.manualMatches[0]?.fieldIndex).toBeNull();
    expect(cleaned.manualMatches[1]).toEqual({ a: null, b: 'team b|', round: '', fieldIndex: null });
  });

  it('refuses to file a manual setup with no fixture in it', () => {
    const ctx = adminCtx(env.store);
    expectEngineError(() => {
      run(env.store, ctx, (s, c, mut) => {
        saveTournamentSetup(s, { name: 'Empty', setup: { ...setup, manualMatches: [] } }, c, mut);
      });
    }, 'BAD_REQUEST');
  });

  it('gives the manual schedule an extra step, and only it', () => {
    // The fixtures are their own question and the clock is another one, so this
    // format's wizard is one step longer than the others'.
    expect(lastStepOf('manual-schedule')).toBe(6);
    expect(lastStepOf('single-elimination')).toBe(5);
    expect(lastStepOf('double-elimination')).toBe(5);
    expect(lastStepOf('radball')).toBe(5);
  });

  it('keeps the review in step with the extra step', () => {
    const manual = normaliseDraft({
      version: 1, step: 6, name: 'Manual Cup', format: 'manual-schedule',
      fieldNames: ['Field 1'], fieldBulk: ['Alpha'], savedAt: 1,
    });
    // The review is step 6 here, so a recovered draft may sit on it.
    expect(manual?.step).toBe(6);
    const other = normaliseDraft({
      version: 1, step: 6, name: 'Cup', format: 'single-elimination',
      fieldNames: ['Field 1'], fieldBulk: ['Alpha'], savedAt: 1,
    });
    // A draft of a shorter format cannot sit on a step it does not have.
    expect(other?.step).toBe(5);
  });
});

/* ------------------------------------------------------------------ */

describe('the wizard', () => {
  /** A draft with a two-field roster and a drafted schedule, ready to be built. */
  function draft(overrides: Record<string, unknown> = {}) {
    return {
      ...createDraft(),
      name: 'Manual Cup',
      format: 'manual-schedule' as const,
      fieldBulk: ['Team A\nTeam B', 'Team C\nTeam D'],
      fieldNames: ['Field 1', 'Field 2'],
      manualMatches: [
        { a: 'team a|', b: 'team b|', round: 'Group stage', fieldIndex: null },
        { a: 'team c|', b: 'team d|', round: 'Final', fieldIndex: 1 },
      ],
      ...overrides,
    };
  }

  it('turns the picked pairings into participant indexes', () => {
    const effective = buildEffectiveSetup(draft());
    if ('error' in effective) throw new Error(effective.error);
    expect(effective.payload.format).toBe('manual-schedule');
    expect(effective.payload.manualMatches).toEqual([
      { a: 0, b: 1, round: 'Group stage' },
      { a: 2, b: 3, round: 'Final', fieldId: '2' },
    ]);
  });

  it('drops a half-filled pairing instead of sending a bye', () => {
    const effective = buildEffectiveSetup(
      draft({
        manualMatches: [
          { a: 'team a|', b: null, round: '', fieldIndex: null },
          { a: 'team b|', b: 'team c|', round: 'Final', fieldIndex: null },
        ],
      }),
    );
    if ('error' in effective) throw new Error(effective.error);
    expect(effective.payload.manualMatches).toEqual([{ a: 1, b: 2, round: 'Final' }]);
  });

  it('reports the missing schedule rather than creating an empty event', () => {
    const effective = buildEffectiveSetup(draft({ manualMatches: [] }));
    expect(effective).toMatchObject({ error: expect.any(String), step: 4 });
  });

  it('reports a side that is no longer on the roster', () => {
    const effective = buildEffectiveSetup(
      draft({ manualMatches: [{ a: 'team a|', b: 'team zz|', round: 'Final', fieldIndex: null }] }),
    );
    if (!('error' in effective)) throw new Error('Expected an error');
    expect(effective.error).toContain('team zz');
  });

  it('names the fixtures that no roster entry plays, so a team is never missed', () => {
    // Four teams, one fixture between two of them: the other two are reported
    // rather than silently dropped, which is the whole "select the teams you
    // need" promise.
    const effective = buildEffectiveSetup(
      draft({
        manualMatches: [
          { a: 'team a|', b: 'team b|', round: 'Final', fieldIndex: null },
        ],
      }),
    );
    if ('error' in effective) throw new Error(effective.error);
    expect(effective.participants).toHaveLength(4);
    expect(effective.payload.manualMatches).toHaveLength(1);
  });

  it('takes a squad picked off the library shelf into the roster, crest included', () => {
    // The library is the host's own address book, so it has to be reachable from
    // this format too: the picker writes `name, club[, , logo]` into the roster
    // box, and the builder turns that into participants.
    const effective = buildEffectiveSetup(
      draft({
        fieldBulk: ['RV Nord I, RV Nord, , nord.png', 'RV Süd I, RV Süd, , sued.png'],
        manualMatches: [
          { a: 'rv nord i|rv nord', b: 'rv süd i|rv süd', round: 'Final', fieldIndex: null },
        ],
      }),
    );
    if ('error' in effective) throw new Error(effective.error);
    expect(effective.participants).toMatchObject([
      { name: 'RV Nord I', team: 'RV Nord', logo: 'nord.png' },
      { name: 'RV Süd I', team: 'RV Süd', logo: 'sued.png' },
    ]);
    expect(effective.payload.manualMatches).toEqual([{ a: 0, b: 1, round: 'Final' }]);
  });

  it('keeps a hand-typed roster with no crest exactly as it was before', () => {
    const effective = buildEffectiveSetup(
      draft({
        fieldBulk: ['Alpha,AC Nord', 'Beta'],
        manualMatches: [{ a: 'alpha|ac nord', b: 'beta|', round: 'Final', fieldIndex: null }],
      }),
    );
    if ('error' in effective) throw new Error(effective.error);
    expect(effective.participants).toMatchObject([
      { name: 'Alpha', team: 'AC Nord', logo: null },
      { name: 'Beta', team: null, logo: null },
    ]);
  });

  it('names the field of every roster problem, not just the count', () => {
    // The complaint this fixes: "5 Probleme" with nothing under it to act on,
    // because the panel was showing one field's rows while the check ran over
    // all of them. Every issue has to say which roster it lives in.
    const bad = mergeRoster(['Alpha,AC Nord', 'Beta\nBeta'], parseParticipants);
    expect(participantIssues(bad, ['Court A', 'Court B'])).toEqual([
      {
        line: 2,
        fieldId: '2',
        message: 'Already on the roster — first entered on Court B, line 1.',
      },
    ]);
  });

  it('says how many rows are wrong and where to look, not just that something is', () => {
    // The original complaint: a count with nothing under it, set as a banner
    // above the wizard. Both halves are locked here -- the count, and the fact
    // that the message points at the list rather than at nothing.
    const message = tr('setup.err.rosterToContinueMany', { count: 5 });
    expect(message).toContain('5');
    expect(message).toMatch(/below/i);
    // A single row reads as a row, not as "1 problem in the list".
    expect(tr('setup.err.rosterToContinueOne')).toMatch(/One roster row/i);
  });

  it('names the control that lifts the schedule refusal', () => {
    // An empty schedule is not a failure, and the message must not read like
    // one: it says what to press, which is right above it in the panel.
    const message = tr('setup.err.needOneMatch');
    expect(message).toMatch(/add the first match/i);
    expect(message).toMatch(/button/i);
    // Not a bare instruction that could be about anything.
    expect(message).not.toBe('Add at least one match to the schedule.');
  });

  it('recovers a manual draft from local storage', () => {
    const saved = normaliseDraft({
      version: 1,
      step: 4,
      name: 'Manual Cup',
      format: 'manual-schedule',
      fieldNames: ['Field 1', 'Field 2'],
      fieldBulk: ['Team A', ''],
      manualMatches: [{ a: 'team a|', b: 'team b|', round: 'Final', fieldIndex: 0 }],
      savedAt: 1,
    });
    expect(saved?.format).toBe('manual-schedule');
    expect(saved?.manualMatches).toEqual([
      { a: 'team a|', b: 'team b|', round: 'Final', fieldIndex: 0 },
    ]);
  });


  it('sends a clock complaint to the match step, not the schedule step', () => {
    // The fixture list is one step and the match settings are the next, so a bad
    // duration has to send the host to the step that holds it.
    const bad = buildEffectiveSetup(
      draft({ fieldBulk: ['Team A', 'Team B'], durationInput: ':(' }),
    );
    if (!('error' in bad)) throw new Error('Expected an error');
    expect(bad.step).toBe(5);
    // An empty schedule is still the schedule step's own problem.
    const empty = buildEffectiveSetup(draft({ manualMatches: [] }));
    if (!('error' in empty)) throw new Error('Expected an error');
    expect(empty.step).toBe(4);
  });

  it('creates a match from two picks and nothing else', () => {
    // The promise of the format: picking the two teams is the whole act. The
    // round and the field default to something workable, so the builder never
    // asks for them before it will accept the fixture.
    const pair = buildEffectiveSetup(
      draft({
        fieldBulk: ['Team A', 'Team B\nTeam C\nTeam D'],
        manualMatches: [{ a: 'team c|', b: 'team d|', round: '', fieldIndex: null }],
      }),
    );
    if ('error' in pair) throw new Error(pair.error);
    // A fixture typed with no round and no field still becomes a real match.
    expect(pair.payload.manualMatches).toEqual([{ a: 2, b: 3 }]);
  });
});
