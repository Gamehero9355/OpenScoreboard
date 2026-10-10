/**
 * Fallback driver: an atomically replaced snapshot plus an append-only
 * newline-delimited event log.
 *
 * Used on runtimes without `node:sqlite` (older Node builds and some Electron
 * versions). Correctness matters more than raw speed here: the snapshot is
 * always written to a temporary file, flushed, then renamed over the previous
 * one, so a power cut can never leave a half-written tournament behind. The
 * previous snapshot is kept as `.bak` and used when the primary file fails to
 * parse.
 */
import { constants, statSync } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SCHEMA_VERSION,
  type PersistedSnapshot,
  type StorageAdapter,
  type StorageStats,
  type StoredEvent,
} from './adapter';

const COMPACT_AFTER_LINES = 5000;
const KEEP_AFTER_COMPACT = 1500;

export class JsonStorageAdapter implements StorageAdapter {
  readonly kind = 'json';
  readonly path: string;
  private readonly snapshotPath: string;
  private readonly backupPath: string;
  private readonly eventsPath: string;
  private eventCount = 0;
  private healthy = true;
  private writeSequence = 0;
  /** Saves are serialised: a burst of score changes must not race on disk. */
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Per-instance salt. Two adapters can point at the same directory (a restart
   * that opens the new store before the old one is closed), and their temporary
   * file names must not collide.
   */
  private readonly salt = randomBytes(4).toString('hex');

  constructor(directory: string) {
    this.snapshotPath = `${directory}/tournament-state.json`;
    this.backupPath = `${directory}/tournament-state.json.bak`;
    this.eventsPath = `${directory}/tournament-events.ndjson`;
    this.path = this.snapshotPath;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    this.eventCount = await this.countLines();
    await this.compactIfNeeded();
  }

  async loadSnapshot(): Promise<PersistedSnapshot | null> {
    const primary = await this.readSnapshotFile(this.snapshotPath);
    if (primary) return primary;
    const backup = await this.readSnapshotFile(this.backupPath);
    if (backup) {
      this.healthy = true;
      return backup;
    }
    return null;
  }

  private async readSnapshotFile(file: string): Promise<PersistedSnapshot | null> {
    try {
      await access(file, constants.R_OK);
    } catch {
      return null;
    }
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSnapshot;
      if (!parsed || typeof parsed !== 'object' || !parsed.state) {
        this.healthy = false;
        return null;
      }
      return {
        version: parsed.version ?? SCHEMA_VERSION,
        savedAt: parsed.savedAt ?? 0,
        seq: parsed.seq ?? 0,
        state: parsed.state,
      };
    } catch {
      this.healthy = false;
      return null;
    }
  }

  async saveSnapshot(snapshot: PersistedSnapshot): Promise<void> {
    // Unique temporary name plus a serialised write queue: two overlapping
    // saves can never race for the same temporary file, which is what keeps the
    // snapshot atomic under a burst of score changes.
    const sequence = (this.writeSequence += 1);
    const tmpPath = `${this.snapshotPath}.${process.pid}.${this.salt}.${sequence}.tmp`;
    const payload = JSON.stringify(snapshot);
    const run = async (): Promise<void> => {
      const handle = await open(tmpPath, 'w');
      try {
        await handle.writeFile(payload, 'utf8');
        // Flush to disk before the rename so the rename cannot expose a partial
        // file even if the machine loses power immediately afterwards.
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(this.snapshotPath, this.backupPath);
      } catch {
        /* first save -- nothing to rotate */
      }
      await rename(tmpPath, this.snapshotPath);
      this.healthy = true;
    };
    const queued = this.writeQueue.then(run, run);
    // Keep the chain alive even when a write fails.
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  async appendEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    const lines = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const run = async (): Promise<void> => {
      await appendFile(this.eventsPath, lines, 'utf8');
      this.eventCount += events.length;
      if (this.eventCount > COMPACT_AFTER_LINES) await this.compactIfNeeded(true);
    };
    const queued = this.writeQueue.then(run, run);
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  async loadEvents(limit: number): Promise<StoredEvent[]> {
    try {
      const raw = await readFile(this.eventsPath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      const out: StoredEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const line = lines[i];
        if (line === undefined) continue;
        try {
          out.push(JSON.parse(line) as StoredEvent);
        } catch {
          /* skip a torn line */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async pruneEvents(keepNewest: number): Promise<number> {
    const events = await this.loadEvents(keepNewest);
    const removed = Math.max(0, this.eventCount - events.length);
    await writeFile(
      this.eventsPath,
      events.length
        ? `${events
            .slice()
            .reverse()
            .map((event) => JSON.stringify(event))
            .join('\n')}\n`
        : '',
      'utf8',
    );
    this.eventCount = events.length;
    return removed;
  }

  private async compactIfNeeded(force = false): Promise<void> {
    if (!force && this.eventCount <= COMPACT_AFTER_LINES) return;
    if (this.eventCount <= KEEP_AFTER_COMPACT) return;
    await this.pruneEvents(KEEP_AFTER_COMPACT);
  }

  private async countLines(): Promise<number> {
    try {
      const raw = await readFile(this.eventsPath, 'utf8');
      let count = 0;
      for (const line of raw.split('\n')) if (line.trim().length > 0) count += 1;
      return count;
    } catch {
      return 0;
    }
  }

  stats(): StorageStats {
    let sizeBytes = 0;
    for (const file of [this.snapshotPath, this.eventsPath]) {
      try {
        sizeBytes += statSync(file).size;
      } catch {
        /* file not written yet */
      }
    }
    return {
      kind: 'json',
      path: this.path,
      eventCount: this.eventCount,
      sizeBytes,
      healthy: this.healthy,
    };
  }

  async close(): Promise<void> {
    // Wait for queued writes so "closed" really means "everything is on disk".
    await this.writeQueue.catch(() => undefined);
  }
}
