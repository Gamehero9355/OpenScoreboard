import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FieldId, TournamentState } from '../src/shared/types';
import { TournamentStore } from '../src/backend/store/store';
import type { Ctx, Mutation } from '../src/backend/tournament/state';
import { createTournament, orderedMatches } from '../src/backend/tournament/engine';
import { assignMatchToField, finishMatch, startMatch } from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';

export interface TestStore {
  store: TournamentStore;
  dir: string;
  dispose: () => Promise<void>;
}

export async function createTestStore(label = 'store'): Promise<TestStore> {
  const dir = mkdtempSync(join(tmpdir(), `tsb-${label}-`));
  const store = await TournamentStore.open(dir);
  return {
    store,
    dir,
    dispose: async () => {
      await store.flush();
      await store.adapter.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows can keep the file locked for a moment */
      }
    },
  };
}

export function adminCtx(store: TournamentStore): Ctx {
  return store.createContext('Host', 'admin', null);
}

export function operatorCtx(store: TournamentStore, field: FieldId, label?: string): Ctx {
  return store.createContext(label ?? `Field ${field} operator`, 'operator', field);
}

export type Operation = (state: TournamentState, ctx: Ctx, mut: Mutation) => void;

export function run(store: TournamentStore, ctx: Ctx, operation: Operation): Mutation {
  return store.apply(operation, ctx);
}

export interface QuickTournamentOptions {
  participants?: number;
  format?: 'single-elimination' | 'double-elimination';
  thirdPlaceMatch?: boolean;
  seeded?: boolean;
  seedValue?: number | null;
  name?: string;
  fieldNames?: string[];
  /**
   * Home field per participant, by index. `['1', '1', '2', '2']` registers the
   * first half of the roster on Field 1 and the rest on Field 2.
   */
  homeFields?: (string | null)[];
}

export interface QuickTournament {
  participantIds: string[];
  tournamentId: string;
}

/**
 * Build a tournament with `n` deterministically named participants and a
 * generated bracket, exactly the way the wizard would.
 */
export function createQuickTournament(
  store: TournamentStore,
  options: QuickTournamentOptions = {},
): QuickTournament {
  const count = options.participants ?? 8;
  const names = Array.from({ length: count }, (_, i) => `Player ${String(i + 1).padStart(2, '0')}`);
  const ctx = adminCtx(store);
  run(store, ctx, (state, c, mut) => {
    createTournament(
      state,
      {
        name: options.name ?? 'Test Cup',
        format: options.format ?? 'single-elimination',
        participants: names.map((name, index) => ({
          name,
          team: null,
          seed: index + 1,
          checkedIn: true,
          fieldId: options.homeFields?.[index] ?? null,
        })),
        thirdPlaceMatch: options.thirdPlaceMatch ?? true,
        seeded: options.seeded ?? true,
        seedValue: options.seedValue ?? 20260921,
        settings: null,
        generateBracketNow: true,
        ...(options.fieldNames ? { fieldNames: options.fieldNames } : {}),
      },
      c,
      mut,
    );
  });
  const tournamentId = store.state.tournament?.id ?? '';
  return { participantIds: [...store.state.participantOrder], tournamentId };
}

export function participantIds(store: TournamentStore): string[] {
  return [...store.state.participantOrder];
}

export function idOf(store: TournamentStore, name: string): string {
  const id = store.state.participantOrder.find((pid) => store.state.participants[pid]?.name === name);
  if (!id) throw new Error(`No participant named ${name}`);
  return id;
}

export function nameOf(store: TournamentStore, id: string | null): string {
  if (!id) return 'TBD';
  return store.state.participants[id]?.name ?? 'Unknown';
}

export function matchByName(store: TournamentStore, a: string, b: string): string {
  const idA = idOf(store, a);
  const idB = idOf(store, b);
  const match = Object.values(store.state.matches).find(
    (m) =>
      (m.participantAId === idA && m.participantBId === idB) ||
      (m.participantAId === idB && m.participantBId === idA),
  );
  if (!match) throw new Error(`No match found for ${a} vs ${b}`);
  return match.id;
}

/**
 * Matches an operator could play right now: waiting in the queue or already
 * sitting on a field. Generating a bracket pre-loads the free fields, so
 * "playable" is no longer the same as "ready".
 */
export function playableMatches(store: TournamentStore) {
  return orderedMatches(store.state).filter((m) => m.state === 'READY' || m.state === 'ASSIGNED');
}

export function playMatch(
  store: TournamentStore,
  matchId: string,
  field: FieldId,
  scoreA: number,
  scoreB: number,
  ctx?: Ctx,
): void {
  const context = ctx ?? adminCtx(store);
  run(store, context, (state, c, mut) => {
    assignMatchToField(state, matchId, field, c, mut);
    startMatch(state, matchId, field, c, mut);
  });
  if (scoreA > 0) {
    run(store, context, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'A', scoreA, c, mut);
    });
  }
  if (scoreB > 0) {
    run(store, context, (state, c, mut) => {
      updateScore(state, state.matches[matchId], 'B', scoreB, c, mut);
    });
  }
  run(store, context, (state, c, mut) => {
    finishMatch(state, { matchId, winner: null, force: true }, c, mut);
  });
}

/** Play the whole tournament, always letting the higher-seeded player win. */
export function playOutTournament(
  store: TournamentStore,
  options: { higherSeedWins?: boolean } = {},
): { champion: string | null; played: number } {
  const higherWins = options.higherSeedWins ?? true;
  const ctx = adminCtx(store);
  let played = 0;
  for (let guard = 0; guard < 2000; guard += 1) {
    const open = orderedMatches(store.state).filter(
      (m) =>
        (m.state === 'READY' || m.state === 'ASSIGNED') &&
        !m.isThirdPlace &&
        (m.bracket === 'winners' || m.bracket === 'losers' || m.bracket === 'final' || m.bracket === 'reset'),
    );
    if (open.length === 0) break;
    const match = open[0];
    const seedA = store.state.participants[match.participantAId ?? '']?.seed ?? 999;
    const seedB = store.state.participants[match.participantBId ?? '']?.seed ?? 999;
    const aWins = higherWins ? seedA < seedB : seedA > seedB;
    playMatch(store, match.id, match.fieldId ?? '1', aWins ? 3 : 1, aWins ? 1 : 3, ctx);
    played += 1;
  }
  // Third place match, if it became playable.
  for (const third of Object.values(store.state.matches).filter(
    (m) => m.isThirdPlace && (m.state === 'READY' || m.state === 'ASSIGNED'),
  )) {
    playMatch(store, third.id, '2', 3, 1, ctx);
    played += 1;
  }
  return { champion: store.state.tournament?.championId ?? null, played };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
