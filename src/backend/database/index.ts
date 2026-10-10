import { mkdirSync } from 'node:fs';
import type { StorageOpenResult } from './adapter';
import { JsonStorageAdapter } from './json';
import { createSqliteAdapter } from './sqlite';

export type StorageDriver = 'auto' | 'sqlite' | 'json';

export interface OpenStorageOptions {
  /**
   * Force a driver. `auto` (the default) prefers SQLite and only falls back to
   * the JSON event log when the runtime has no `node:sqlite`. The override is
   * exposed as `TOURNAMENT_STORAGE=sqlite|json` for troubleshooting and used by
   * the tests to exercise both drivers.
   */
  driver?: StorageDriver;
}

export function resolveDriver(requested?: StorageDriver): StorageDriver {
  if (requested && requested !== 'auto') return requested;
  const fromEnv = process.env.TOURNAMENT_STORAGE;
  if (fromEnv === 'json' || fromEnv === 'sqlite') return fromEnv;
  return 'auto';
}

/**
 * Open the local database. SQLite is preferred because it gives us proper
 * transactions and a single file to back up; the JSON log is the safety net for
 * runtimes where `node:sqlite` is not available.
 */
export async function openStorage(
  dataDir: string,
  options: OpenStorageOptions = {},
): Promise<StorageOpenResult> {
  mkdirSync(dataDir, { recursive: true });
  const driver = resolveDriver(options.driver);

  if (driver !== 'json') {
    const sqlitePath = `${dataDir}/tournament.sqlite`;
    const sqlite = await createSqliteAdapter(sqlitePath);
    if (sqlite) {
      try {
        await sqlite.init();
        return { adapter: sqlite, note: 'SQLite (node:sqlite)' };
      } catch (error) {
        if (driver === 'sqlite') throw error;
        const reason = error instanceof Error ? error.message : String(error);
        // Fall through to the JSON driver rather than refusing to start.
        // eslint-disable-next-line no-console
        console.warn(`[storage] SQLite unavailable (${reason}); falling back to the JSON event log.`);
      }
    } else if (driver === 'sqlite') {
      throw new Error('This runtime does not provide node:sqlite.');
    }
  }

  const json = new JsonStorageAdapter(dataDir);
  await json.init();
  return {
    adapter: json,
    note:
      driver === 'json'
        ? 'JSON snapshot + event log (forced)'
        : 'JSON snapshot + event log (node:sqlite not available)',
  };
}

export * from './adapter';
export { JsonStorageAdapter } from './json';
