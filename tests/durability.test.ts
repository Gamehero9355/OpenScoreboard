/**
 * Durability guarantees that a long event depends on.
 *
 * Each test here corresponds to a way the app used to lose or corrupt data
 * silently -- the failure modes that only show up at halftime in front of a hall
 * full of people, and that no happy-path test would ever reach.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BACKUP_FILES, pruneBackups } from '../src/backend/index';
import { TournamentStore } from '../src/backend/store/store';
import { EngineError } from '../src/backend/util/errors';
import { assignMatchToField, startMatch } from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';
import { adminCtx, createQuickTournament, createTestStore, playMatch, run, type TestStore } from './helpers';

interface SqliteModule {
  DatabaseSync: new (path: string) => {
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
    close: () => void;
  };
}

/**
 * Reach `node:sqlite` without going through a module loader, for the same
 * reason the driver itself does: a bundler would try to resolve the bare
 * specifier. Returns null when the runtime has no SQLite, in which case the
 * SQLite-specific tests below are skipped.
 */
function sqlite(): SqliteModule | null {
  const getBuiltin = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  return typeof getBuiltin === 'function' ? ((getBuiltin('node:sqlite') as SqliteModule | undefined) ?? null) : null;
}

const dirs: string[] = [];
const stores: TestStore[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tsb-durability-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const env of stores.splice(0)) {
    try {
      await env.store.flush();
      await env.store.adapter.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle */
    }
  }
});

describe('atomic commands', () => {
  it('leaves the live state untouched when an operation fails half way through', async () => {
    const env = await createTestStore('atomic');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 8 });

    const before = JSON.stringify(env.store.state);
    const firstMatch = Object.values(env.store.state.matches).find((m) => m.state !== 'CANCELLED');
    if (!firstMatch) throw new Error('expected a generated match');

    // The classic half-applied failure: a field is renamed, then renaming the
    // second one is refused because that field is busy. Used to leave the
    // settings changed, no delta broadcast and nothing written to disk.
    expect(() =>
      run(env.store, ctx, (state, c, mut) => {
        Object.assign(state.settings, { tournamentName: 'Renamed Halfway' });
        void c;
        void mut;
        // Throw the way an engine rule would, after real work has been done.
        throw new EngineError('FIELD_BUSY', 'Field 2 is busy.');
      }),
    ).toThrow(EngineError);

    expect(JSON.stringify(env.store.state)).toBe(before);
    expect(env.store.state.settings.tournamentName).not.toBe('Renamed Halfway');
    expect(firstMatch.state).toBe(env.store.state.matches[firstMatch.id]?.state);
  });

  it('never broadcasts or persists a failed operation', async () => {
    const env = await createTestStore('atomic-broadcast');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 4 });

    const seen: number[] = [];
    env.store.subscribe((delta) => seen.push(delta.seq));
    const seqBefore = env.store.state.seq;
    const savedBefore = env.store.saveCount;

    expect(() =>
      run(env.store, ctx, (_state, _c, mut) => {
        mut.events.push({ type: 'SCORE_UPDATED', message: 'should never be recorded' });
        throw new EngineError('INVALID_STATE', 'refused');
      }),
    ).toThrow(EngineError);

    expect(seen).toHaveLength(0);
    expect(env.store.state.seq).toBe(seqBefore);
    expect(env.store.saveCount).toBe(savedBefore);
    expect(env.store.state.events.some((event) => event.message === 'should never be recorded')).toBe(false);
  });

  it('keeps store.state the same object on both the success and the failure path', async () => {
    const env = await createTestStore('atomic-identity');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 4 });

    // Callers legitimately cache `store.state`; swapping the object out from
    // under them would hand back stale data after a refused command.
    const before = env.store.state;
    run(env.store, ctx, (_state, _c, mut) => {
      mut.events.push({ type: 'SYSTEM', message: 'applied' });
    });
    expect(env.store.state).toBe(before);

    expect(() =>
      run(env.store, ctx, () => {
        throw new EngineError('INVALID_STATE', 'refused');
      }),
    ).toThrow(EngineError);
    expect(env.store.state).toBe(before);
    // The refused operation left nothing behind.
    expect(before.events.some((event) => event.message === 'applied')).toBe(true);
  });

  it('still commits normally after a failed operation', async () => {
    const env = await createTestStore('atomic-recover');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 4 });

    expect(() =>
      run(env.store, ctx, () => {
        throw new Error('nope');
      }),
    ).toThrow();

    const match = Object.values(env.store.state.matches).find((m) => m.participantAId && m.participantBId);
    if (!match) throw new Error('expected a match');
    run(env.store, ctx, (state, c, mut) => {
      assignMatchToField(state, match.id, '1', c, mut);
      startMatch(state, match.id, '1', c, mut);
      updateScore(state, state.matches[match.id], 'A', 3, c, mut);
    });
    expect(env.store.state.matches[match.id]?.scoreA).toBe(3);
  });
});

describe('event log sequence', () => {
  it('never rewinds the sequence when a backup is restored', async () => {
    const env = await createTestStore('seq-restore');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 8 });

    // Play enough to push the counter well past the first match.
    const match = Object.values(env.store.state.matches).find((m) => m.participantAId && m.participantBId);
    if (!match) throw new Error('expected a match');
    playMatch(env.store, match.id, '1', 5, 3, ctx);
    const highWater = env.store.state.seq;
    expect(highWater).toBeGreaterThan(10);

    const before = await env.store.adapter.loadEvents(2000);
    const beforeBySeq = new Map(before.map((event) => [event.seq, event]));
    expect(beforeBySeq.size).toBe(before.length);

    // An old backup carries a much lower sequence number.
    const backup = JSON.parse(JSON.stringify(env.store.createBackup())) as { state: { seq: number } };
    backup.state.seq = 3;
    await env.store.restore(TournamentStore.parseBackup(backup));

    expect(env.store.state.seq).toBeGreaterThanOrEqual(highWater);

    const after = await env.store.adapter.loadEvents(2000);
    expect(after.map((event) => event.seq)).toEqual([...new Set(after.map((event) => event.seq))]);
    for (const event of after) {
      const previous = beforeBySeq.get(event.seq);
      if (!previous) continue;
      // A sequence number already on disk must still carry its original row:
      // re-using one would silently rewrite the audit trail.
      expect(event.ts).toBe(previous.ts);
      expect(event.type).toBe(previous.type);
      expect(event.payload).toBe(previous.payload);
    }
  });

  it('keeps the audit log monotonic after clearing the tournament', async () => {
    const env = await createTestStore('seq-clear');
    stores.push(env);
    const ctx = adminCtx(env.store);
    createQuickTournament(env.store, { participants: 4 });
    const before = env.store.state.seq;

    await env.store.clear();

    expect(env.store.state.seq).toBeGreaterThanOrEqual(before);
    run(env.store, ctx, (_state, _c, mut) => {
      mut.events.push({ type: 'SYSTEM', message: `marker-` });
    });
    await env.store.flush();
    const events = await env.store.adapter.loadEvents(2000);
    const seqs = events.map((event) => event.seq);
    expect(seqs.length).toBe(new Set(seqs).size);
  });
});

describe('sqlite snapshot recovery', () => {
  const sqliteModule = sqlite();

  it.skipIf(!sqliteModule)('recovers the previous snapshot when the newest one is unreadable', async () => {
    const dir = tempDir('sqlite-shadow');
    const first = await TournamentStore.open(dir);
    stores.push({ store: first, dir, dispose: async () => first.adapter.close() });
    const ctx = adminCtx(first);
    createQuickTournament(first, { name: 'Shadow Cup', participants: 4 });
    await first.flush();

    // A second save rotates the good copy into the shadow table.
    run(first, ctx, (_state, _c, mut) => {
      mut.events.push({ type: 'SYSTEM', message: 'second save' });
    });
    await first.flush();
    await first.adapter.close();

    // Corrupt the live blob the way a damaged page or a partial write would.
    const db = new sqliteModule!.DatabaseSync(join(dir, 'tournament.sqlite'));
    db.prepare('UPDATE snapshot SET data = ? WHERE id = 1').run('{ this is not json');
    db.close();

    const reopened = await TournamentStore.open(dir);
    stores.push({ store: reopened, dir, dispose: async () => reopened.adapter.close() });

    // The point of the shadow copy: the tournament is still there.
    expect(reopened.state.tournament?.name).toBe('Shadow Cup');
    expect(reopened.state.participantOrder.length).toBe(4);
  });

  it.skipIf(!sqliteModule)('keeps the shadow copy one save behind, not frozen at the second save', async () => {
    // The shadow table holds exactly one row by design, so every save after the
    // first conflicts with it. An upsert that does nothing on conflict freezes
    // the shadow at the state from the start of the event, which is exactly the
    // case the fallback exists for. Three saves, each distinguishable, is the
    // smallest sequence that can tell "tracks the previous snapshot" apart from
    // "stopped updating".
    const dir = tempDir('sqlite-shadow-rotating');
    const first = await TournamentStore.open(dir);
    stores.push({ store: first, dir, dispose: async () => first.adapter.close() });
    const ctx = adminCtx(first);
    createQuickTournament(first, { name: 'Save One', participants: 4 });
    await first.flush();
    run(first, ctx, (state, _c, mut) => {
      if (state.tournament) state.tournament.name = 'Save Two';
      mut.settings = true;
    });
    await first.flush();
    run(first, ctx, (state, _c, mut) => {
      if (state.tournament) state.tournament.name = 'Save Three';
      mut.settings = true;
    });
    await first.flush();
    await first.adapter.close();

    const db = new sqliteModule!.DatabaseSync(join(dir, 'tournament.sqlite'));
    db.prepare('UPDATE snapshot SET data = ? WHERE id = 1').run('{ truncated mid-write');
    db.close();

    const reopened = await TournamentStore.open(dir);
    stores.push({ store: reopened, dir, dispose: async () => reopened.adapter.close() });
    // "Save Two" is the snapshot that preceded the corrupt one.
    expect(reopened.state.tournament?.name).toBe('Save Two');
    expect(reopened.state.participantOrder.length).toBe(4);
  });

  it.skipIf(!sqliteModule)('starts empty rather than reporting a healthy database when nothing can be read', async () => {
    const dir = tempDir('sqlite-empty');
    const first = await TournamentStore.open(dir);
    stores.push({ store: first, dir, dispose: async () => first.adapter.close() });
    createQuickTournament(first, { name: 'Doomed Cup', participants: 4 });
    await first.flush();
    await first.flush();
    await first.adapter.close();

    const db = new sqliteModule!.DatabaseSync(join(dir, 'tournament.sqlite'));
    db.prepare('UPDATE snapshot SET data = ? WHERE id = 1').run('garbage');
    db.prepare('UPDATE snapshot_shadow SET data = ? WHERE id = 1').run('also garbage');
    db.close();

    const reopened = await TournamentStore.open(dir);
    stores.push({ store: reopened, dir, dispose: async () => reopened.adapter.close() });
    expect(reopened.state.tournament).toBeNull();
  });
});

describe('backup retention', () => {
  /**
   * Written for the same reason the scheduled writer used not to call it: with
   * pruning missing, a week-long event fills the disk with full-state JSON dumps
   * and the only symptom is that it eventually stops saving.
   */
  it('bounds the directory and drops the oldest writes first', async () => {
    const dir = tempDir('backups');
    const backupDir = join(dir, 'backups');
    const fsPromises = await import('node:fs/promises');
    await fsPromises.mkdir(backupDir, { recursive: true });

    const written: string[] = [];
    // Three prefixes, so a name-sorted prune would delete the auto backups first.
    const prefixes = ['auto-backup', 'tournament-backup', 'before-restore'];
    for (let i = 0; i < 30; i += 1) {
      const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `${prefixes[i % prefixes.length]}-${stamp}.json`;
      await fsPromises.writeFile(join(backupDir, name), '{}', 'utf8');
      // Pin the mtime so "oldest" is unambiguous regardless of filesystem clock.
      await fsPromises.utimes(join(backupDir, name), when, when);
      written.push(name);
    }
    expect(readdirSync(backupDir)).toHaveLength(30);

    await pruneBackups(dir);

    const remaining = readdirSync(backupDir);
    expect(remaining).toHaveLength(MAX_BACKUP_FILES);
    // The newest files survive, whichever prefix they happen to carry.
    const newest = new Set(written.slice(30 - MAX_BACKUP_FILES));
    expect(remaining.filter((name) => newest.has(name))).toHaveLength(MAX_BACKUP_FILES);
    for (const name of remaining) {
      expect(statSync(join(backupDir, name)).size).toBe(2);
    }
  });

  it('does not prune a whole prefix class, only the genuinely oldest writes', async () => {
    const dir = tempDir('backups-mixed');
    const backupDir = join(dir, 'backups');
    const fsPromises = await import('node:fs/promises');
    await fsPromises.mkdir(backupDir, { recursive: true });

    const write = async (name: string, when: Date): Promise<void> => {
      await fsPromises.writeFile(join(backupDir, name), '{}', 'utf8');
      await fsPromises.utimes(join(backupDir, name), when, when);
    };

    // Five manual backups that are genuinely old, and twenty automatic ones that
    // are all newer. Sorting by file name would delete every `auto-backup-*`
    // first and keep the stale manual copies -- exactly backwards.
    for (let i = 0; i < 5; i += 1) {
      const stamp = new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await write(`tournament-backup-${stamp}.json`, new Date(Date.UTC(2025, 0, 1, 0, 0, i)));
    }
    for (let i = 0; i < 20; i += 1) {
      const when = new Date(Date.UTC(2026, 5, 1, 0, 0, i));
      const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await write(`auto-backup-${stamp}.json`, when);
    }
    expect(readdirSync(backupDir)).toHaveLength(25);

    await pruneBackups(dir);

    const remaining = readdirSync(backupDir);
    expect(remaining).toHaveLength(MAX_BACKUP_FILES);
    // The five oldest really are the manual ones; the automatic safety net stays.
    expect(remaining.filter((name) => name.startsWith('auto-backup-'))).toHaveLength(20);
    expect(remaining.filter((name) => name.startsWith('tournament-backup-'))).toHaveLength(0);
  });

  it('is a no-op on a directory that does not exist yet', async () => {
    const dir = tempDir('backups-missing');
    await expect(pruneBackups(join(dir, 'nope'))).resolves.toBeUndefined();
  });
});