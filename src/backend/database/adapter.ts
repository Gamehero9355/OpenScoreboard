/**
 * Storage layer.
 *
 * Two interchangeable drivers implement the same interface:
 *
 *  - `sqlite`  embedded SQLite via Node's built-in `node:sqlite` (no native
 *              build step, no external dependency)
 *  - `json`    a crash-safe append-only event log plus atomically replaced
 *              snapshots, used when `node:sqlite` is unavailable (older Node,
 *              some Electron builds)
 *
 * Both persist the same thing: a periodic full snapshot of the tournament state
 * and an append-only audit log. Restoring therefore only ever needs to read the
 * last snapshot, which is what makes "the PC restarted mid-tournament" a
 * non-event.
 */
import type { TournamentState } from '../../shared/types';

export const SCHEMA_VERSION = 1;

export interface PersistedSnapshot {
  version: number;
  savedAt: number;
  seq: number;
  state: TournamentState;
}

export interface StoredEvent {
  seq: number;
  ts: number;
  type: string;
  matchId: string | null;
  fieldId: string | null;
  actor: string;
  payload: string;
}

export interface StorageStats {
  kind: string;
  path: string;
  eventCount: number;
  sizeBytes: number;
  healthy: boolean;
}

export interface StorageAdapter {
  readonly kind: string;
  readonly path: string;
  init(): Promise<void>;
  loadSnapshot(): Promise<PersistedSnapshot | null>;
  saveSnapshot(snapshot: PersistedSnapshot): Promise<void>;
  appendEvents(events: StoredEvent[]): Promise<void>;
  loadEvents(limit: number): Promise<StoredEvent[]>;
  pruneEvents(keepNewest: number): Promise<number>;
  stats(): StorageStats;
  close(): Promise<void>;
}

export interface StorageOpenResult {
  adapter: StorageAdapter;
  /** Human readable note about which driver was chosen and why. */
  note: string;
}
