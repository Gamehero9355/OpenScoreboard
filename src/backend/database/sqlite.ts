/**
 * SQLite driver built on Node's embedded `node:sqlite` module. No native
 * compilation, no prebuilt binaries to download -- the database ships with the
 * runtime, which keeps the Windows installer dependency-free.
 */
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  type PersistedSnapshot,
  type StorageAdapter,
  type StorageStats,
  type StoredEvent,
} from './adapter';

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

const SQLITE_MODULE = 'node:sqlite';

/**
 * Load the embedded SQLite module without going through any module loader that
 * might rewrite bare specifiers (bundlers, test runners, Electron).
 * `process.getBuiltinModule` exists from Node 22.3 and returns the real built-in
 * or undefined -- no resolution involved.
 */
function loadSqliteModule(): SqliteModule | null {
  const getBuiltin = (process as NodeJS.Process & {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule;
  if (typeof getBuiltin === 'function') {
    try {
      const mod = getBuiltin(SQLITE_MODULE) as SqliteModule | undefined;
      if (mod && typeof mod.DatabaseSync === 'function') return mod;
    } catch {
      /* fall through to the dynamic import below */
    }
  }
  return null;
}

/* The module is loaded defensively so the app still starts on runtimes that do
 * not provide it; the caller falls back to the JSON driver. */
export async function createSqliteAdapter(filePath: string): Promise<StorageAdapter | null> {
  const mod = loadSqliteModule();
  if (!mod) return null;

  let db: DatabaseSync;
  try {
    db = new mod.DatabaseSync(filePath);
  } catch {
    return null;
  }

  const adapter: StorageAdapter = {
    kind: 'sqlite',
    path: filePath,

    async init() {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          saved_at INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          version INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshot_shadow (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          saved_at INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          version INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          match_id TEXT,
          field_id TEXT,
          actor TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `);
    },

    /**
     * Read the newest snapshot that still parses.
     *
     * A snapshot is the *only* copy of the tournament, so a single unreadable
     * `data` blob must never be reported as "nothing stored" -- the next save
     * would then overwrite it with an empty state and the event would be gone.
     * The previous snapshot is kept in `snapshot_shadow` and tried as a fallback.
     */
    async loadSnapshot() {
      for (const table of ['snapshot', 'snapshot_shadow']) {
        const row = db.prepare(`SELECT version, saved_at, seq, data FROM ${table} WHERE id = 1`).get() as
          | { version: number; saved_at: number; seq: number; data: string }
          | undefined;
        if (!row) continue;
        try {
          const state = JSON.parse(row.data) as PersistedSnapshot['state'];
          if (!state || typeof state !== 'object') throw new Error('snapshot is not an object');
          if (table === 'snapshot_shadow') {
            // eslint-disable-next-line no-console
            console.error(
              '[sqlite] the newest snapshot could not be read; recovered the previous one from the shadow copy.',
            );
          }
          return { version: row.version, savedAt: row.saved_at, seq: row.seq, state };
        } catch {
          continue;
        }
      }
      return null;
    },

    async saveSnapshot(snapshot: PersistedSnapshot) {
      const data = JSON.stringify(snapshot.state);
      // Rotate the live row into the shadow before replacing it, so there is
      // always one known-good copy to fall back on.
      //
      // `DO UPDATE`, not `DO NOTHING`: the shadow holds exactly one row by
      // design, so every save after the first conflicts with the previous save
      // and a do-nothing upsert would freeze the shadow at whatever it happened
      // to hold when it was first written -- turning the "recover the previous
      // snapshot" fallback into "recover the state from the start of the event",
      // which is precisely the case it exists for.
      db.prepare(
        `INSERT INTO snapshot_shadow (id, saved_at, seq, version, data)
         SELECT 1, saved_at, seq, version, data FROM snapshot WHERE id = 1
         ON CONFLICT(id) DO UPDATE SET saved_at = excluded.saved_at, seq = excluded.seq,
           version = excluded.version, data = excluded.data`,
      ).run();
      db.prepare(
        `INSERT INTO snapshot (id, saved_at, seq, version, data) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET saved_at = excluded.saved_at, seq = excluded.seq,
           version = excluded.version, data = excluded.data`,
      ).run(snapshot.savedAt, snapshot.seq, snapshot.version, data);
    },

    async appendEvents(events: StoredEvent[]) {
      if (events.length === 0) return;
      const insert = db.prepare(
        'INSERT OR REPLACE INTO events (seq, ts, type, match_id, field_id, actor, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const event of events) {
          insert.run(
            event.seq,
            event.ts,
            event.type,
            event.matchId,
            event.fieldId,
            event.actor,
            event.payload,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async loadEvents(limit: number) {
      const rows = db
        .prepare('SELECT seq, ts, type, match_id, field_id, actor, payload FROM events ORDER BY seq DESC LIMIT ?')
        .all(limit) as {
        seq: number;
        ts: number;
        type: string;
        match_id: string | null;
        field_id: string | null;
        actor: string;
        payload: string;
      }[];
      return rows.map((row) => ({
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        matchId: row.match_id,
        fieldId: row.field_id,
        actor: row.actor,
        payload: row.payload,
      }));
    },

    async pruneEvents(keepNewest: number) {
      const row = db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
      const excess = row.count - keepNewest;
      if (excess <= 0) return 0;
      db.prepare('DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq ASC LIMIT ?)').run(excess);
      return excess;
    },

    stats(): StorageStats {
      let eventCount = 0;
      try {
        const row = db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
        eventCount = row.count;
      } catch {
        eventCount = -1;
      }
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(filePath).size;
      } catch {
        sizeBytes = 0;
      }
      return { kind: 'sqlite', path: filePath, eventCount, sizeBytes, healthy: eventCount >= 0 };
    },

    async close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };

  return adapter;
}

export { SCHEMA_VERSION };
