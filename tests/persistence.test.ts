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

/**
 * Does this runtime hand out `node:sqlite`? Reached the same way the driver
 * reaches it, so the answer cannot disagree with what the app will pick: Node
 * 22.5 to 22.12 keep it behind `--experimental-sqlite`, and there the app
 * deliberately falls back to the JSON driver. The SQLite-specific checks below
 * are skipped rather than failed when that is the case, because the fallback is
 * a supported configuration, not a regression.
 */
function sqliteAvailable(): boolean {
  const getBuiltin = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule;
  return typeof getBuiltin === 'function' ? Boolean(getBuiltin('node:sqlite')) : false;
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
  it.skipIf(!sqliteAvailable())('uses SQLite when the runtime provides it', async () => {
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

  it('serialises overlapping snapshot writes instead of interleaving them', async () => {
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
    // Three concurrent writes to one file must leave exactly one of them, whole.
    // Accepting any of the three only proved that the file was not lost; the
    // queue exists so the *last* write is the survivor, and a torn file would
    // show up here as a parse failure rather than a stale value.
    const state = (loaded as unknown as { state: { which: number } }).state;
    expect(state.which).toBe(3);
    expect(loaded?.seq).toBe(3);
    expect(loaded?.savedAt).toBe(3);
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

  it('opens a snapshot whose slices have the wrong types instead of throwing', async () => {
    // `sanitiseState` is the last line of defence for everything on disk, so it
    // has to survive more than unparseable JSON. A file that parses but holds
    // the wrong *shapes* used to reach the fix-ups and throw on the first
    // property write, which meant a hand-edited or half-migrated file stopped
    // the server from starting at all.
    const dir = tempDir('wrong-shapes');
    const cases: Array<[string, unknown]> = [
      ['matches values that are not objects', { matches: { m1: 5, m2: null, m3: [1, 2] } }],
      ['participants values that are not objects', { participants: { p1: 7 } }],
      ['matchOrder that is a string', { matchOrder: 'abc' }],
      ['participantOrder that is a number', { participantOrder: 12 }],
      ['a radball slice that is a primitive', { radball: 'uci_radball_2025' }],
      ['a tournament that is a primitive', { tournament: 42 }],
      ['matches that is an array', { matches: [1, 2, 3] }],
      ['order arrays holding non-strings', { matchOrder: [1, null, 'm1'] }],
    ];
    for (const [label, slices] of cases) {
      const snapshot = { version: 1, savedAt: 1, seq: 1, state: { seq: 1, ...(slices as object) } };
      writeFileSync(join(dir, 'tournament-state.json'), JSON.stringify(snapshot));
      rmSync(join(dir, 'tournament-state.json.bak'), { force: true });

      const env = await openAtJson(dir);
      expect(env.store.state, label).toBeTruthy();
      // The good parts survive; only the unusable entries are dropped.
      if ('m3' in (slices as Record<string, unknown>)) {
        expect(Object.keys(env.store.state.matches), label).not.toContain('m3');
      }
      await env.dispose();
      stores.splice(stores.indexOf(env), 1);
    }

    // And the store is still writable afterwards.
    const last = await openAtJson(dir);
    createQuickTournament(last.store, { participants: 4 });
    expect(last.store.state.tournament?.name).toBe('Test Cup');
    expect(last.store.state.matchOrder.every((id) => typeof id === 'string')).toBe(true);
  }, 20000);

  it.skipIf(!sqliteAvailable())('falls back to the JSON log when the SQLite file cannot be opened', async () => {
    const dir = tempDir('badsqlite');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 4 });
    await first.store.flush();
    await first.dispose();
    // Overwrite the database with something that is not SQLite.
    writeFileSync(join(dir, 'tournament.sqlite'), 'this is definitely not a database');

    const second = await openAt(dir);
    // A file that is not a database cannot be repaired, so the fallback is the
    // only correct outcome. Accepting either driver here would leave the test
    // green whether or not the fallback existed at all.
    expect(second.store.adapter.kind).toBe('json');
    // And the operator has to be able to tell a damaged file from a runtime
    // that simply lacks node:sqlite -- those need different reactions.
    expect(second.store.adapterNote).toContain('could not be opened');
    // The server still comes up and is usable.
    if (second.store.state.tournament === null) createQuickTournament(second.store, { participants: 4 });
    expect(second.store.state.participantOrder.length).toBeGreaterThan(0);
    await second.store.save();
    expect(second.store.adapter.stats().healthy).toBe(true);
  }, 20000);

  it.skipIf(sqliteAvailable())('still works on a runtime without node:sqlite', async () => {
    // The JSON driver is a supported configuration, not a degraded one, so it
    // gets the same treatment as the fallback path above rather than being
    // skipped outright.
    const dir = tempDir('no-sqlite');
    const first = await openAt(dir);
    createQuickTournament(first.store, { participants: 4 });
    await first.store.flush();
    await first.dispose();

    const second = await openAt(dir);
    expect(second.store.adapter.kind).toBe('json');
    expect(second.store.adapterNote).toContain('node:sqlite not available');
    expect(second.store.state.tournament?.name).toBe('Test Cup');
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
