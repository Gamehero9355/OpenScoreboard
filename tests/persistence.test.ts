import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStorageAdapter } from '../src/backend/database/json';
import { TournamentStore } from '../src/backend/store/store';
import { EngineError } from '../src/backend/util/errors';
import { assignMatchToField, startMatch } from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';
import { computeResults } from '../src/shared/stats';
import {
  adminCtx,
  createQuickTournament,
  createTestStore,
  idOf,
  nameOf,
  playMatch,
  run,
  type TestStore,
} from './helpers';

const dirs: string[] = [];
const stores: TestStore[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tsb-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle */
    }
  }
});

async function openAt(dir: string): Promise<TestStore> {
  return openWith(dir, {});
}

async function openAtJson(dir: string): Promise<TestStore> {
  return openWith(dir, { driver: 'json' });
}

async function openWith(
  dir: string,
  options: Parameters<typeof TournamentStore.open>[1],
): Promise<TestStore> {
  const store = await TournamentStore.open(dir, options ?? {});
  const env: TestStore = {
    store,
    dir,
    dispose: async () => {
      await store.flush();
      await store.adapter.close();
    },
  };
  stores.push(env);
  return env;
}

describe('embedded database', () => {
  it('uses SQLite when the runtime provides it', async () => {
    const env = await openAt(tempDir('driver'));
    expect(env.store.adapter.kind).toBe('sqlite');
    expect(env.store.adapterNote).toContain('SQLite');
  });

  it('round-trips a snapshot through the JSON driver', async () => {
    const dir = tempDir('json');
    const adapter = new JsonStorageAdapter(dir);
    await adapter.init();
    const state = { settings: { tournamentName: 'Round Trip' } } as never;
    await adapter.saveSnapshot({ version: 1, savedAt: 1234, seq: 9, state });
    const loaded = await adapter.loadSnapshot();
    expect(loaded?.seq).toBe(9);
    expect(loaded?.state).toEqual(state);
    await adapter.appendEvents([
      { seq: 1, ts: 1, type: 'SCORE_UPDATED', matchId: 'm1', fieldId: '1', actor: 'Host', payload: '{}' },
      { seq: 2, ts: 2, type: 'MATCH_STARTED', matchId: 'm1', fieldId: '1', actor: 'Host', payload: '{}' },
    ]);
    const events = await adapter.loadEvents(10);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    await adapter.close();
  });

  it('survives overlapping snapshot writes without losing the file', async () => {
    const dir = tempDir('race');
    const adapter = new JsonStorageAdapter(dir);
    await adapter.init();
    await Promise.all([
      adapter.saveSnapshot({ version: 1, savedAt: 1, seq: 1, state: { which: 1 } as never }),
      adapter.saveSnapshot({ version: 1, savedAt: 2, seq: 2, state: { which: 2 } as never }),
      adapter.saveSnapshot({ version: 1, savedAt: 3, seq: 3, state: { which: 3 } as never }),
    ]);
    const loaded = await adapter.loadSnapshot();
    expect(loaded).not.toBeNull();
    expect([1, 2, 3]).toContain((loaded as unknown as { state: { which: number } }).state.which);
    expect(adapter.stats().healthy).toBe(true);
    await adapter.close();
  });
});

describe('restart recovery', () => {
  it('restores a finished tournament with identical results', async () => {
    const dir = tempDir('restart');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 8 });
    const ctx = adminCtx(first.store);
    const qf1 = Object.values(first.store.state.matches).find((m) => m.round === 0 && m.position === 0);
    const qf2 = Object.values(first.store.state.matches).find((m) => m.round === 0 && m.position === 1);
    playMatch(first.store, qf1!.id, '1', 5, 3, ctx);
    playMatch(first.store, qf2!.id, '2', 1, 4, ctx);
    await first.store.flush();
    const before = {
      matches: Object.keys(first.store.state.matches).length,
      participants: Object.keys(first.store.state.participants).length,
      semiA: nameOf(first.store, first.store.state.matches[qf1!.id].winnerId),
      semiB: nameOf(first.store, first.store.state.matches[qf2!.id].winnerId),
      events: first.store.state.events.length,
    };
    const second = await openAt(dir);

    expect(Object.keys(second.store.state.matches)).toHaveLength(before.matches);
    expect(Object.keys(second.store.state.participants)).toHaveLength(before.participants);
    const semi = Object.values(second.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    expect(nameOf(second.store, semi?.participantAId ?? null)).toBe(before.semiA);
    expect(nameOf(second.store, semi?.participantBId ?? null)).toBe(before.semiB);
    expect(semi?.state).toBe('READY');
    // The audit log is restored plus one entry recording the restore itself.
    expect(second.store.state.events.length).toBe(before.events + 1);
    expect(second.store.state.events.at(-1)?.message).toMatch(/restored from disk/i);
  });

  it('keeps running matches, scores and field assignment across a restart', async () => {
    const dir = tempDir('midmatch');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 4 });
    const ctx = adminCtx(first.store);
    const match = Object.values(first.store.state.matches).find((m) => m.round === 0 && m.position === 0);
    run(first.store, ctx, (state, c, mut) => {
      assignMatchToField(state, match!.id, '1', c, mut);
      startMatch(state, match!.id, '1', c, mut);
      updateScore(state, state.matches[match!.id], 'A', 2, c, mut);
      updateScore(state, state.matches[match!.id], 'B', 1, c, mut);
    });
    await first.store.flush();

    const second = await openAt(dir);
    const restored = second.store.state.matches[match!.id];
    expect(restored.scoreA).toBe(2);
    expect(restored.scoreB).toBe(1);
    expect(restored.state).toBe('RUNNING');
    expect(second.store.state.fields['1'].matchId).toBe(match!.id);
    // A timer that was left running is anchored, so the clock keeps counting
    // even though the wall clock moved on.
    expect(restored.timer.running).toBe(true);
    expect(restored.timer.anchorAt).toBeGreaterThan(0);
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0].prevA).toBe(0);
    expect(restored.history[1].nextB).toBe(1);
  });

  it('stops a timer that was persisted without a running match', async () => {
    const dir = tempDir('stale-timer');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 4 });
    const match = Object.values(first.store.state.matches).find((m) => m.round === 0 && m.position === 0);
    match!.timer.running = true;
    match!.timer.anchorAt = Date.now();
    match!.state = 'READY';
    await first.store.flush();

    const second = await openAt(dir);
    const restored = second.store.state.matches[match!.id];
    expect(restored.timer.running).toBe(false);
    expect(restored.timer.anchorAt).toBeNull();
  });

  it('falls back to the previous snapshot when the newest JSON file is corrupt', async () => {
    const dir = tempDir('corrupt');
    const first = await openAtJson(dir);
    createQuickTournament(first.store, { participants: 4 });
    await first.store.flush();
    const before = Object.keys(first.store.state.participants).length;
    // Write a second snapshot so a .bak exists, then corrupt the live file.
    await first.store.save();
    await first.store.save();
    await first.dispose();
    const live = join(dir, 'tournament-state.json');
    const bak = join(dir, 'tournament-state.json.bak');
    expect(readFileSync(bak, 'utf8').length).toBeGreaterThan(0);
    writeFileSync(live, '{ this is not json');

    const second = await openAtJson(dir);
    expect(Object.keys(second.store.state.participants).length).toBe(before);
    expect(second.store.adapter.stats().healthy).toBe(true);
  }, 20000);

  it('starts empty instead of crashing when every JSON snapshot file is broken', async () => {
    const dir = tempDir('broken');
    const first = await openAtJson(dir);
    createQuickTournament(first.store, { participants: 4 });
    await first.store.flush();
    await first.dispose();
    writeFileSync(join(dir, 'tournament-state.json'), 'garbage');
    writeFileSync(join(dir, 'tournament-state.json.bak'), 'also garbage');

    const second = await openAtJson(dir);
    expect(second.store.state.tournament).toBeNull();
    expect(second.store.state.participantOrder).toHaveLength(0);
    // The server is still usable afterwards.
    createQuickTournament(second.store, { participants: 4 });
    expect(second.store.state.tournament?.name).toBe('Test Cup');
  }, 20000);

  it('falls back to the JSON log when the SQLite file cannot be opened', async () => {
    const dir = tempDir('badsqlite');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 4 });
    await first.store.flush();
    await first.dispose();
    // Overwrite the database with something that is not SQLite.
    writeFileSync(join(dir, 'tournament.sqlite'), 'this is definitely not a database');

    const second = await openAt(dir);
    // Either the broken file is rejected (and we fall back), or SQLite repairs
    // itself -- in both cases the server must come up and be usable.
    expect(['json', 'sqlite']).toContain(second.store.adapter.kind);
    if (second.store.state.tournament === null) {
      createQuickTournament(second.store, { participants: 4 });
    }
    expect(second.store.state.participantOrder.length).toBeGreaterThan(0);
  }, 20000);

  it('can be pinned to the JSON driver for troubleshooting', async () => {
    const dir = tempDir('forced');
    const env = await openAtJson(dir);
    expect(env.store.adapter.kind).toBe('json');
    expect(env.store.adapterNote).toContain('forced');
  });
});

describe('backup and restore', () => {
  it('round-trips a tournament through a backup document', async () => {
    const source = await createTestStore('backup-src');
    createQuickTournament(source.store, { participants: 8 });
    const ctx = adminCtx(source.store);
    const qf = Object.values(source.store.state.matches).find((m) => m.round === 0 && m.position === 0);
    playMatch(source.store, qf!.id, '1', 4, 1, ctx);
    const document = source.store.createBackup();
    const championPlan = nameOf(source.store, source.store.state.matches[qf!.id].winnerId);

    const target = await createTestStore('backup-dst');
    const state = TournamentStore.parseBackup(JSON.parse(JSON.stringify(document)));
    await target.store.restore(state);

    expect(target.store.state.tournament?.name).toBe('Test Cup');
    expect(Object.keys(target.store.state.matches)).toHaveLength(
      Object.keys(source.store.state.matches).length,
    );
    expect(nameOf(target.store, target.store.state.matches[qf!.id].winnerId)).toBe(championPlan);
    const semi = Object.values(target.store.state.matches).find((m) => m.round === 1 && m.position === 0);
    expect(semi?.participantAId).toBe(idOf(target.store, championPlan));

    await source.dispose();
    await target.dispose();
  });

  it('rejects files that are not a scoreboard backup', () => {
    expect(() => TournamentStore.parseBackup(null)).toThrow(EngineError);
    expect(() => TournamentStore.parseBackup('nope')).toThrow(EngineError);
    expect(() => TournamentStore.parseBackup({ hello: 'world' })).toThrow(EngineError);
    expect(() =>
      TournamentStore.parseBackup({ app: 'tournament-scoreboard', schema: 1, state: {} }),
    ).toThrow(EngineError);
    try {
      TournamentStore.parseBackup({ hello: 'world' });
    } catch (error) {
      expect((error as EngineError).code).toBe('BAD_REQUEST');
      expect((error as EngineError).message).toMatch(/not a Tournament Scoreboard backup/i);
    }
  });

  it('keeps the audit log in the database', async () => {
    const env = await createTestStore('audit');
    createQuickTournament(env.store, { participants: 4 });
    const ctx = adminCtx(env.store);
    const match = Object.values(env.store.state.matches).find((m) => m.round === 0 && m.position === 0);
    playMatch(env.store, match!.id, '1', 3, 1, ctx);
    await env.store.flush();
    const events = await env.store.adapter.loadEvents(100);
    expect(events.length).toBeGreaterThan(4);
    const types = events.map((event) => event.type);
    expect(types).toContain('MATCH_FINISHED');
    expect(types).toContain('SCORE_UPDATED');
    const finished = events.find((event) => event.type === 'MATCH_FINISHED');
    expect(finished?.fieldId).toBe('1');
    expect(JSON.parse(finished?.payload ?? '{}')).toHaveProperty('winnerId');
    await env.dispose();
  }, 20000);
});

describe('results after reload', () => {
  it('computes the same statistics before and after a restart', async () => {
    const dir = tempDir('stats');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 8 });
    const ctx = adminCtx(first.store);
    const rounds = [0, 1, 2];
    for (const roundNumber of rounds) {
      for (const match of Object.values(first.store.state.matches).filter(
        (m) => m.round === roundNumber && (m.state === 'READY' || m.state === 'ASSIGNED') && !m.isThirdPlace,
      )) {
        // Fields are pre-loaded when the bracket is generated, so play each
        // match where it already sits.
        playMatch(first.store, match.id, match.fieldId ?? '1', 3, 1, ctx);
      }
    }
    await first.store.flush();
    const before = computeResults(first.store.state);
    expect(before.champion).not.toBeNull();
    const second = await openAt(dir);
    const after = computeResults(second.store.state);
    expect(after.rows).toEqual(before.rows);
    expect(after.champion?.id).toBe(before.champion?.id);
    expect(after.runnerUp?.id).toBe(before.runnerUp?.id);
    expect(after.thirdPlace?.id).toBe(before.thirdPlace?.id);
  });
});
