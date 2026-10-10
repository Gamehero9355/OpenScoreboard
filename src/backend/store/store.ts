/**
 * The store owns the authoritative tournament state.
 *
 * Every mutation goes through `apply()`: the engine edits the state, the store
 * turns the resulting diff into a compact delta, persists it and hands the delta
 * to the WebSocket hub. There is exactly one writer, which is what lets the
 * server be authoritative without any locking.
 */
import { EventEmitter } from 'node:events';
import type {
  AppEvent,
  Delta,
  FieldId,
  FieldState,
  Match,
  Participant,
  SystemStatus,
  TournamentState,
} from '../../shared/types';
import { sentenceMessage, type EventSentence } from '../../shared/eventMessages';
import { EngineError } from '../util/errors';
import { createIdGenerator } from '../util/ids';
import {
  SCHEMA_VERSION,
  openStorage,
  type OpenStorageOptions,
  type PersistedSnapshot,
  type StorageAdapter,
  type StoredEvent,
} from '../database';
import { MAX_EVENTS, createEmptyState } from '../tournament/defaults';
import { sanitiseSavedTournamentLibrary } from '../tournament/saved';
import { sanitiseTeamLibrary } from '../tournament/teams';
import {
  type Ctx,
  type Mutation,
  createMutation,
  normaliseTimerState,
  pushEvent,
  stopTimer,
  timerPeriodElapsed,
  touchMatch,
} from '../tournament/state';

export const APP_VERSION = '1.0.0';
const DEBOUNCED_SAVE_MS = 1200;
const EVENT_RETENTION = 4000;

export interface StoreOptions {
  dataDir: string;
  roleForActor?: 'admin' | 'operator';
}

export type DeltaListener = (delta: Delta, event: Mutation) => void;

export class TournamentStore {
  readonly events = new EventEmitter();
  state: TournamentState;
  adapter!: StorageAdapter;
  adapterNote = '';
  dataDir: string;
  lastSaveAt: number | null = null;
  savedCleanly = false;
  saveCount = 0;

  private counter = 0;
  private listeners = new Set<DeltaListener>();
  private saveTimer: NodeJS.Timeout | null = null;
  private saveInFlight: Promise<void> | null = null;
  private saveAgain = false;
  /** Audit-log writes that have been started but not finished yet. */
  private appendQueue: Promise<void> = Promise.resolve();
  private newId = createIdGenerator();
  private startedAt = Date.now();

  private constructor(dataDir: string, state: TournamentState) {
    this.dataDir = dataDir;
    this.state = state;
    this.counter = state.seq;
  }

  static async open(dataDir: string, options: OpenStorageOptions = {}): Promise<TournamentStore> {
    const { adapter, note } = await openStorage(dataDir, options);
    const snapshot = await adapter.loadSnapshot();
    const state = snapshot?.state ? sanitiseState(snapshot.state) : createEmptyState();
    const store = new TournamentStore(dataDir, state);
    store.adapter = adapter;
    store.adapterNote = note;
    store.counter = snapshot?.seq ?? state.seq ?? 0;
    store.lastSaveAt = snapshot?.savedAt ?? null;
    if (snapshot) {
      store.pushEvent('SYSTEM', {
        key: 'event.restoredFromDisk',
        params: { time: new Date(snapshot.savedAt).toISOString() },
      });
    }
    return store;
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * `now` is a live getter rather than a captured value: a context may live
   * across several engine calls, and a stale timestamp would make timer maths
   * silently wrong.
   */
  createContext(actor: string, role: Ctx['role'], fieldScope: FieldId | null): Ctx {
    const ctx = {
      actor,
      role,
      fieldScope,
      newId: this.newId,
    } as Ctx;
    Object.defineProperty(ctx, 'now', {
      get: () => Date.now(),
      enumerable: true,
    });
    return ctx;
  }

  /* ---------------------------------------------------------------- */
  /* Mutation                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Run an engine operation, then broadcast and persist what changed.
   *
   * The live state is copied first and restored if the operation throws. That
   * makes every command atomic without the caller having to think about it: an
   * engine rule that refuses half way through (a busy field, a level score that
   * needs a winner, a duplicate Radball squad) leaves the live state, every
   * connected screen and the database exactly as they were, instead of leaving
   * the server quietly diverged from all three.
   *
   * The rollback is written back over the state rather than swapped in, so
   * `store.state` stays the same object on both paths: anything holding a
   * reference to it keeps seeing live updates instead of quietly reading a stale
   * snapshot.
   *
   * The event log is deliberately *not* deep-cloned. It holds up to
   * `MAX_EVENTS` (2000) records and grows for the whole event, so cloning it on
   * every command made the copy grow over the tournament for no benefit: the
   * engine never mutates an event in place -- the only two writes are whole-array
   * replacements -- and events are appended only *after* the operation has
   * returned. Holding the current array by reference is therefore exact, and
   * measured 30-61% off `apply()` on a realistic mid-event state.
   */
  apply(operation: (state: TournamentState, ctx: Ctx, mut: Mutation) => void, ctx: Ctx): Mutation {
    const mut = createMutation();
    const rollback = snapshotForRollback(this.state);
    try {
      operation(this.state, ctx, mut);
    } catch (error) {
      // `rollback` carries exactly the same keys as `this.state`, so assigning it
      // back restores every slice and discards the partial work without
      // disturbing the object's identity.
      Object.assign(this.state, rollback);
      throw error;
    }

    this.counter += 1;
    const seq = this.counter;
    const now = Date.now();
    const created: AppEvent[] = [];

    for (const raw of mut.events) {
      this.counter += 1;
      const event: AppEvent = {
        seq: this.counter,
        ts: now,
        type: raw.type,
        fieldId: raw.fieldId ?? null,
        matchId: raw.matchId ?? null,
        actor: ctx.actor,
        message: raw.message,
        ...(raw.text ? { text: raw.text } : {}),
        ...(raw.data ? { data: raw.data } : {}),
      };
      created.push(event);
      this.state.events.push(event);
      if (this.state.events.length > MAX_EVENTS) {
        this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
      }
    }

    this.state.seq = this.counter;
    this.state.updatedAt = now;

    const delta = this.buildDelta(mut, seq, now, created);
    this.emit(delta, mut);
    this.persist(mut, delta, ctx);
    return mut;
  }

  advanceTimers(now = Date.now()): void {
    const transitionAt = Math.max(now, Date.now());
    const due = Object.values(this.state.matches).some((match) => {
      if (!match.timer.running || match.timer.mode !== 'down') return false;
      return timerPeriodElapsed(match.timer, transitionAt) >= match.timer.periodDurationSec * 1000;
    });
    if (!due) return;
    this.apply(
      (state, _ctx, mut) => {
        for (const match of Object.values(state.matches)) {
          if (!match.timer.running || match.timer.mode !== 'down') continue;
          if (timerPeriodElapsed(match.timer, transitionAt) < match.timer.periodDurationSec * 1000) continue;
          const boundary = match.timer.periodStartElapsedMs + match.timer.periodDurationSec * 1000;
          stopTimer(match.timer, transitionAt);
          match.timer.elapsedMs = boundary;
          match.timer.running = false;
          match.timer.anchorAt = null;
          if (match.timer.period === 1 && match.timer.periodCount === 2) {
            match.state = 'HALFTIME';
            pushEvent(mut, 'MATCH_HALFTIME', { key: 'event.matchHalftime', params: { round: match.roundName } }, {
              matchId: match.id,
              fieldId: match.fieldId,
            });
          } else {
            match.timer.expired = true;
            match.state = 'PAUSED';
            pushEvent(mut, 'TIMER_UPDATED', { key: 'event.matchTimeUp', params: { round: match.roundName } }, {
              matchId: match.id,
              fieldId: match.fieldId,
            });
          }
          touchMatch(mut, match.id);
        }
      },
      this.createContext('system', 'admin', null),
    );
  }

  private buildDelta(mut: Mutation, seq: number, now: number, created: AppEvent[]): Delta {
    const delta: Delta = { seq, updatedAt: now };
    if (mut.tournament) delta.tournament = this.state.tournament;
    if (mut.settings) delta.settings = this.state.settings;
    if (mut.fields.size > 0) {
      // A field can be marked changed and removed in the same operation, so an
      // id with no live entry is dropped rather than sent as `undefined`.
      delta.fields = [...mut.fields]
        .map((id) => this.state.fields[id])
        .filter((field): field is FieldState => Boolean(field));
    }
    if (mut.matches.size > 0) {
      delta.matches = [...mut.matches]
        .map((id) => this.state.matches[id])
        .filter((m): m is Match => Boolean(m));
    }
    if (mut.removedMatchIds.length > 0) delta.removedMatchIds = [...mut.removedMatchIds];
    if (mut.participants.size > 0) {
      delta.participants = [...mut.participants]
        .map((id) => this.state.participants[id])
        .filter((p): p is Participant => Boolean(p));
    }
    if (mut.removedParticipantIds.length > 0) delta.removedParticipantIds = [...mut.removedParticipantIds];
    if (mut.radball) delta.radball = this.state.radball;
    if (mut.teamLibrary) delta.teamLibrary = this.state.teamLibrary;
    if (mut.savedTournaments) delta.savedTournaments = this.state.savedTournaments;
    if (mut.matchOrder) delta.matchOrder = mut.matchOrder;
    if (mut.participantOrder) delta.participantOrder = mut.participantOrder;
    if (created.length > 0) delta.events = created;
    return delta;
  }

  private emit(delta: Delta, mut: Mutation): void {
    for (const listener of this.listeners) {
      try {
        listener(delta, mut);
      } catch (error) {
        // A broken client must never break the tournament.
        // eslint-disable-next-line no-console
        console.error('[store] listener failed', error);
      }
    }
  }

  subscribe(listener: DeltaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                      */
  /* ---------------------------------------------------------------- */

  private persist(mut: Mutation, delta: Delta, ctx: Ctx): void {
    const urgency = mut.urgency;
    if (urgency === 'immediate') {
      void this.save();
    } else {
      this.scheduleSave(DEBOUNCED_SAVE_MS);
    }
    void this.appendEvents(delta, ctx);
  }

  private appendEvents(delta: Delta, ctx: Ctx): Promise<void> {
    if (!delta.events || delta.events.length === 0) return Promise.resolve();
    const events: StoredEvent[] = delta.events.map((event) => ({
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      matchId: event.matchId,
      fieldId: event.fieldId,
      actor: event.actor,
      payload: JSON.stringify(event.data ?? (event.text ? { message: event.message, text: event.text } : { message: event.message })),
    }));
    const queued = this.adapter.appendEvents(events).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[store] could not append audit events', error);
      void ctx;
    });
    // Writing the audit log is deliberately not awaited on the mutation path,
    // so it is chained here instead. `flush()` is what the quit path calls to
    // mean "everything is on disk", and the JSON driver writes asynchronously:
    // without this, a save that had already finished let `flush()` return while
    // the last events were still in flight, and they only appeared a moment
    // later. SQLite happens to write synchronously inside the call, so the gap
    // was invisible until the fallback driver was exercised.
    this.appendQueue = this.appendQueue.then(() => queued);
    return queued;
  }

  private scheduleSave(delay: number): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delay);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveInFlight) {
      this.saveAgain = true;
      return this.saveInFlight;
    }
    const snapshot: PersistedSnapshot = {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      seq: this.counter,
      state: this.state,
    };
    this.saveInFlight = this.adapter
      .saveSnapshot(snapshot)
      .then(() => {
        this.lastSaveAt = snapshot.savedAt;
        this.saveCount += 1;
        this.savedCleanly = true;
        this.events.emit('saved', this.lastSaveAt);
      })
      .catch((error: unknown) => {
        this.savedCleanly = false;
        // eslint-disable-next-line no-console
        console.error('[store] snapshot save failed', error);
        this.events.emit('save-error', error);
      })
      .finally(() => {
        this.saveInFlight = null;
        if (this.saveAgain) {
          this.saveAgain = false;
          void this.save();
        }
      });
    return this.saveInFlight;
  }

  async flush(): Promise<void> {
    if (this.saveTimer || this.saveInFlight) await this.save();
    // The snapshot and the audit log are separate writes; "flushed" has to mean
    // both have landed.
    await this.appendQueue;
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                           */
  /* ---------------------------------------------------------------- */

  pushEvent(type: AppEvent['type'], sentence: EventSentence, extra?: Partial<AppEvent>): AppEvent {
    this.counter += 1;
    const event: AppEvent = {
      seq: this.counter,
      ts: Date.now(),
      type,
      fieldId: extra?.fieldId ?? null,
      matchId: extra?.matchId ?? null,
      actor: extra?.actor ?? 'system',
      message: sentenceMessage(sentence),
      ...(typeof sentence === 'string' ? {} : { text: sentence }),
      ...(extra?.data ? { data: extra.data } : {}),
    };
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
    this.state.seq = this.counter;
    return event;
  }

  /* ---------------------------------------------------------------- */
  /* Backup / restore                                                 */
  /* ---------------------------------------------------------------- */

  createBackup(): BackupDocument {
    return {
      app: 'tournament-scoreboard',
      schema: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      exportedAt: Date.now(),
      state: this.state,
    };
  }

  static parseBackup(raw: unknown): TournamentState {
    if (!raw || typeof raw !== 'object') {
      throw new EngineError('BAD_REQUEST', 'This file is not a Tournament Scoreboard backup.');
    }
    const doc = raw as Partial<BackupDocument>;
    if (doc.app !== 'tournament-scoreboard' || !doc.state || typeof doc.state !== 'object') {
      throw new EngineError('BAD_REQUEST', 'This file is not a Tournament Scoreboard backup.');
    }
    const state = doc.state as Partial<TournamentState>;
    if (!state.settings || typeof state.settings !== 'object') {
      throw new EngineError('BAD_REQUEST', 'The backup is missing its settings block.');
    }
    return sanitiseState(state as TournamentState);
  }

  async restore(state: TournamentState): Promise<void> {
    this.state = sanitiseState(state);
    // The audit log is keyed by `seq`, so the counter must never travel
    // backwards: restoring a typical older backup would otherwise re-use
    // sequence numbers and silently overwrite the newer rows already on disk.
    // Stepping above whatever this process has already written keeps the log
    // monotonic, and the saved snapshot carries the new high-water mark so a
    // restart resumes from there.
    this.state.seq = Math.max(this.counter, this.state.seq ?? 0);
    this.counter = this.state.seq;
    this.pushEvent('TOURNAMENT_LOADED', { key: 'event.restoredFromBackup' });
    await this.save();
    const delta: Delta = {
      seq: this.counter,
      updatedAt: Date.now(),
      tournament: this.state.tournament,
      settings: this.state.settings,
      fields: Object.values(this.state.fields),
      matches: Object.values(this.state.matches),
      participants: Object.values(this.state.participants),
      matchOrder: this.state.matchOrder,
      participantOrder: this.state.participantOrder,
      radball: this.state.radball,
      teamLibrary: this.state.teamLibrary,
      savedTournaments: this.state.savedTournaments,
      events: this.state.events.slice(-20),
    };
    this.emit(delta, createMutation());
  }

  /**
   * Wipe the live tournament. The team library is deliberately kept: it is the
   * host's own address book of clubs, not state belonging to one competition.
   */
  async clear(): Promise<void> {
    const teamLibrary = this.state.teamLibrary;
    this.state = createEmptyState(this.state.settings);
    this.state.teamLibrary = teamLibrary;
    // Same reason as `restore`: the event log is keyed by `seq`, so resetting the
    // counter would let the next event overwrite an existing audit row.
    this.state.seq = this.counter;
    this.pushEvent('SYSTEM', { key: 'event.stateCleared' });
    await this.save();
  }

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  clientCounter: () => { total: number; byTopic: Record<string, number> } = () => ({
    total: 0,
    byTopic: {},
  });

  systemStatus(): SystemStatus {
    const memory = process.memoryUsage();
    const stats = this.adapter.stats();
    return {
      database: stats.kind,
      databasePath: stats.path,
      databaseOk: stats.healthy,
      lastSaveAt: this.lastSaveAt,
      savedCleanly: this.savedCleanly,
      clients: this.clientCounter().total,
      clientsByTopic: this.clientCounter().byTopic,
      messageCount: this.saveCount,
      eventsStored: stats.eventCount,
      memoryMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      cpuPercent: Math.round(process.cpuUsage().user / 10000) / 100,
      version: APP_VERSION,
      uptimeSec: this.uptimeSec(),
    };
  }

  async pruneEventLog(): Promise<number> {
    return this.adapter.pruneEvents(EVENT_RETENTION);
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}

/**
 * The pre-image `apply()` rolls back to.
 *
 * Everything except `events` is deep-cloned, because engine rules edit matches,
 * participants, fields, settings and the competition slices in place. `events`
 * is shared by reference on purpose -- see the note on `apply`. The object
 * carries the same keys as the live state, so `Object.assign` restores it whole.
 */
function snapshotForRollback(state: TournamentState): TournamentState {
  const { events, ...rest } = state;
  return { ...(structuredClone(rest) as Omit<TournamentState, 'events'>), events };
}

export interface BackupDocument {
  app: 'tournament-scoreboard';
  schema: number;
  appVersion: string;
  exportedAt: number;
  state: TournamentState;
}

/**
 * Defensive normalisation of anything coming from disk: a corrupt or
 * hand-edited file must never crash the server.
 */
function sanitiseState(input: Partial<TournamentState>): TournamentState {
  const base = createEmptyState(input.settings ?? undefined);
  const state: TournamentState = {
    ...base,
    tournament: input.tournament ?? null,
    participants: input.participants ?? {},
    participantOrder: input.participantOrder ?? [],
    matches: input.matches ?? {},
    matchOrder: input.matchOrder ?? [],
    events: Array.isArray(input.events) ? input.events.slice(-MAX_EVENTS) : [],
    seq: typeof input.seq === 'number' ? input.seq : 0,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : Date.now(),
  };
  // Merge persisted fields over the defaults so old two-field backups and new
  // multi-field states both load. Field names come from the settings; any
  // persisted field without a name keeps its own.
  const rawFields = (input.fields ?? {}) as Record<string, TournamentState['fields'][string]>;
  const names = Array.isArray(state.settings.fieldNames) && state.settings.fieldNames.length > 0
    ? state.settings.fieldNames
    : ['Field 1', 'Field 2'];
  const ids = new Set<string>();
  names.forEach((_, index) => ids.add(String(index + 1)));
  for (const id of Object.keys(rawFields)) {
    if (/^[1-9][0-9]*$/.test(id)) ids.add(id);
  }
  const ordered = [...ids].sort((a, b) => Number(a) - Number(b)).slice(0, 8);
  const fields: TournamentState['fields'] = {};
  ordered.forEach((id, position) => {
    // The persisted entry is untrusted input, so it is treated as a partial
    // `FieldState` rather than assumed to have every key.
    const persisted = (rawFields[id] ?? {}) as Partial<FieldState>;
    fields[id] = {
      id,
      name: names[position] ?? persisted.name ?? `Field ${id}`,
      matchId: persisted.matchId ?? null,
      controlledBy: persisted.controlledBy ?? null,
      controlledSince: persisted.controlledSince ?? null,
    };
  });
  state.fields = fields;
  state.settings.fieldNames = ordered.map((id) => fields[id]?.name ?? `Field ${id}`);
  for (const match of Object.values(state.matches)) {
    if (!Array.isArray(match.history)) match.history = [];
    if (!Array.isArray(match.redoStack)) match.redoStack = [];
    match.timer = normaliseTimerState(match.timer, state.settings.timerMode, state.settings.defaultMatchDurationSec);
    if (match.timer.running && match.state !== 'RUNNING') {
      match.timer.running = false;
      match.timer.anchorAt = null;
    }
    if (match.state === 'HALFTIME') {
      match.timer.running = false;
      match.timer.anchorAt = null;
    }
  }
  // Drop references to participants that no longer exist.
  for (const match of Object.values(state.matches)) {
    if (match.participantAId && !state.participants[match.participantAId]) match.participantAId = null;
    if (match.participantBId && !state.participants[match.participantBId]) match.participantBId = null;
  }
  for (const id of Object.keys(state.fields)) {
    const field = state.fields[id];
    if (field && field.matchId && !state.matches[field.matchId]) field.matchId = null;
  }
  // Backups written before per-field rosters carry no home field.
  for (const participant of Object.values(state.participants)) {
    if (participant.fieldId === undefined) participant.fieldId = null;
    else if (participant.fieldId !== null && !state.fields[participant.fieldId]) {
      participant.fieldId = null;
    }
    if (participant.players === undefined) participant.players = null;
    // Backups written before team logos carry no crest, which means the folder
    // default rather than a missing image on every screen.
    if (participant.logo === undefined) participant.logo = null;
  }
  // The competition slice travels with backups and snapshots verbatim.
  state.radball = (input.radball as TournamentState['radball']) ?? null;
  if (state.radball && typeof state.radball.decisionSeq !== 'number') {
    state.radball.decisionSeq = 0;
  }
  // Snapshots written before the language setting existed carry no value; an
    // unrecognised one is treated the same way rather than reaching the client.
  if (state.settings.language !== 'en' && state.settings.language !== 'de') {
    state.settings.language = 'en';
  }
  // Snapshots written before the library existed have no such slice.
  state.teamLibrary = sanitiseTeamLibrary(input.teamLibrary);
  // Likewise for the shelf of saved setups. Both are the host's own shelf
  // rather than state belonging to one competition, so a restore brings them
  // back exactly as the exported file had them.
  state.savedTournaments = sanitiseSavedTournamentLibrary(input.savedTournaments);
  return state;
}
