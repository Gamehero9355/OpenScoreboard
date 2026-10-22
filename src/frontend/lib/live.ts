/**
 * Live client.
 *
 * One WebSocket per device, deltas applied in place, automatic reconnect with
 * backoff, and every command acknowledged by the server. The browser never
 * decides anything about the tournament -- it only renders what the host says
 * and sends commands that the host validates.
 */
import type {
  Delta,
  FieldId,
  JoinLink,
  NetworkInfo,
  Role,
  ServerMessage,
  TournamentState,
} from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/types';
import { tr } from './i18n';
import { sentenceLine } from './eventText';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** How many events a client keeps for its own activity feed. */
const MAX_CLIENT_EVENTS = 80;

/**
 * Merge one server delta into the last known state, copy on write.
 *
 * Exported and pure on purpose: a slice the server broadcasts but this function
 * forgets to apply renders as a screen that accepts an edit and then appears to
 * do nothing at all. Every field on `Delta` has to be handled here, and
 * `tests/live.test.ts` checks that it is.
 */
export function applyDeltaToState(previous: TournamentState, delta: Delta): TournamentState {
  // The state object is shared with every component, so a new object per delta
  // is what makes `useMemo(..., [state])` selectors -- the bracket, the queues,
  // the results -- see the change. Patching in place left them rendering
  // finished matches and an outdated bracket.
  const state: TournamentState = {
    ...previous,
    fields: { ...previous.fields },
    participants: { ...previous.participants },
    matches: { ...previous.matches },
    seq: delta.seq,
    updatedAt: delta.updatedAt,
  };
  if (delta.tournament !== undefined) state.tournament = delta.tournament;
  if (delta.settings) state.settings = delta.settings;
  if (delta.radball !== undefined) state.radball = delta.radball;
  if (delta.teamLibrary !== undefined) state.teamLibrary = delta.teamLibrary;
  if (delta.savedTournaments !== undefined) state.savedTournaments = delta.savedTournaments;
  if (delta.fields) for (const field of delta.fields) state.fields[field.id] = field;
  if (delta.participants) for (const participant of delta.participants) state.participants[participant.id] = participant;
  if (delta.removedParticipantIds) {
    for (const id of delta.removedParticipantIds) delete state.participants[id];
  }
  if (delta.matches) for (const match of delta.matches) state.matches[match.id] = match;
  if (delta.removedMatchIds) for (const id of delta.removedMatchIds) delete state.matches[id];
  if (delta.matchOrder) state.matchOrder = delta.matchOrder;
  if (delta.participantOrder) state.participantOrder = delta.participantOrder;
  if (delta.events && delta.events.length > 0) {
    state.events = [...state.events, ...delta.events].slice(-MAX_CLIENT_EVENTS);
  }
  return state;
}

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  ts: number;
}

export interface CommandResult {
  ok: boolean;
  code?: string;
  error?: string;
}

export interface LiveSnapshot {
  version: number;
  connection: ConnectionState;
  role: Role;
  tokenScope: FieldId | null;
  state: TournamentState | null;
  network: NetworkInfo | null;
  links: JoinLink[];
  toasts: Toast[];
  lastMessageAt: number;
  reconnects: number;
  pending: number;
  serverTime: number;
  /** The host refused this control link until the operator PIN is entered. */
  pinChallenge: boolean;
  /** Why the current session ended up read-only, when the host said so. */
  authNotice: string | null;
}

export interface ConnectOptions {
  token?: string | null;
  topic?: string;
  label?: string;
  /** Ask the server to treat this connection as read-only. */
  readOnly?: boolean;
  /** Second factor for a control link. */
  pin?: string | null;
}

function fieldScope(value: string | null): FieldId | null {
  return value !== null && /^[1-9][0-9]*$/.test(value) ? value : null;
}

const COMMAND_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 8000;
const PING_INTERVAL_MS = 25000;

export class LiveClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private outbox = new Map<string, { resolve: (result: CommandResult) => void; timer: number }>();
  private options: ConnectOptions = {};
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private counter = 0;
  private version = 0;
  private disposed = false;
  /** Set while the socket is being replaced on purpose, so no retry piles up. */
  private suppressReconnect = false;
  private snapshot: LiveSnapshot = {
    version: 0,
    connection: 'connecting',
    role: 'spectator',
    tokenScope: null,
    state: null,
    network: null,
    links: [],
    toasts: [],
    lastMessageAt: 0,
    reconnects: 0,
    pending: 0,
    serverTime: Date.now(),
    pinChallenge: false,
    authNotice: null,
  };

  /* ---------------------------------------------------------------- */
  /* Subscription                                                      */
  /* ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  private emit(): void {
    this.version += 1;
    this.snapshot = {
      ...this.snapshot,
      version: this.version,
      toasts: this.snapshot.toasts,
    };
    for (const listener of this.listeners) listener();
  }

  private patch(changes: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Connection                                                        */
  /* ---------------------------------------------------------------- */

  connect(options: ConnectOptions = {}): void {
    this.options = options;
    this.open();
  }

  private url(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  private open(): void {
    if (this.disposed) return;
    this.clearReconnect();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.patch({ connection: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });

    // Every handler below is bound to *this* socket, not to `this.socket`. A
    // superseded socket fires its events on a later tick -- `close()` in
    // particular is asynchronous while `open()` runs to completion
    // synchronously -- so a handler that trusted `this.socket` would let a dead
    // connection stop the live one's ping, fail its pending commands and arm a
    // reconnect that opens a third socket. Comparing the identity is what keeps
    // "replace the socket" from leaking the old one.
    const current = (): boolean => this.socket === socket;

    socket.onopen = () => {
      if (!current()) return;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.sendRaw({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        token: this.options.token ?? null,
        ...(this.options.pin ? { pin: this.options.pin } : {}),
        ...(this.options.topic ? { topic: this.options.topic } : {}),
        ...(this.options.label ? { clientLabel: this.options.label } : {}),
        ...(this.options.readOnly ? { readOnly: true } : {}),
      });
      this.startPing();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (!current()) return;
      this.handleMessage(String(event.data));
    };

    socket.onerror = () => {
      /* close fires next; nothing to do here */
    };

    socket.onclose = () => {
      if (!current()) return;
      this.stopPing();
      this.failPending(tr('live.lost'));
      if (this.disposed || this.suppressReconnect) return;
      this.patch({ connection: navigator.onLine === false ? 'offline' : 'reconnecting' });
      this.scheduleReconnect();
    };
    this.suppressReconnect = false;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 350 * 2 ** (this.reconnectAttempt - 1));
    const delay = base + Math.random() * 250;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.patch({ reconnects: this.snapshot.reconnects + 1 });
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.sendRaw({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Called when the device comes back online or the tab is shown again. */
  revive(): void {
    if (this.disposed) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      this.resync();
      return;
    }
    this.reconnectAttempt = 0;
    this.open();
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnect();
    this.stopPing();
    this.failPending(tr('live.shuttingDown'));
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Incoming                                                          */
  /* ---------------------------------------------------------------- */

  private sendRaw(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      /* the close handler will take over */
    }
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    this.snapshot.lastMessageAt = Date.now();

    switch (message.t) {
      case 'hello': {
        this.patch({
          role: message.role,
          tokenScope: fieldScope(message.tokenScope),
          serverTime: message.serverTime,
        });
        break;
      }
      case 'state': {
        this.patch({
          connection: 'live',
          state: message.state.state,
          network: message.state.network,
          links: message.state.links,
          role: message.state.role,
          tokenScope: fieldScope(message.state.tokenScope),
          serverTime: Date.now(),
          pinChallenge: false,
          authNotice: null,
        });
        break;
      }
      case 'delta': {
        this.applyDelta(message.delta);
        break;
      }
      case 'timer': {
        const state = this.snapshot.state;
        const match = state?.matches[message.matchId];
        if (state && match) {
          this.snapshot = {
            ...this.snapshot,
            state: {
              ...state,
              matches: { ...state.matches, [message.matchId]: { ...match, timer: message.timer } },
            },
          };
          this.emit();
        }
        break;
      }
      case 'ack': {
        const pending = this.outbox.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          this.outbox.delete(message.requestId);
          this.snapshot.pending = this.outbox.size;
          pending.resolve({
            ok: message.ok,
            ...(message.error ? { error: message.error } : {}),
            ...(message.code ? { code: message.code } : {}),
          });
          this.emit();
        }
        break;
      }
      case 'notify': {
        // The engine's own sentence, in this device's language. Read once here so
        // the toast is written in the language it was shown in, which is what
        // `tr` is for: `live` has no hook to re-render a toast from.
        const line = sentenceLine(message.text, message.message);
        if (message.code === 'PIN_REQUIRED') {
          this.patch({ pinChallenge: true, authNotice: message.message });
        }
        if (message.code === 'TOKEN_INVALID') {
          this.patch({ authNotice: message.message });
        }
        if (message.level === 'error') this.pushToast('error', line);
        else if (message.level === 'warn') this.pushToast('warn', line);
        break;
      }
      case 'presence': {
        this.applyPresence(message.fields);
        break;
      }
      case 'pong': {
        this.snapshot.serverTime = message.serverTime;
        break;
      }
      default:
        break;
    }
  }

  private applyDelta(delta: Delta): void {
    const previous = this.snapshot.state;
    if (!previous) {
      // A delta before the first full state means we joined mid-stream: ask for
      // a clean snapshot rather than trying to patch a state we never had.
      this.sendRaw({ t: 'resync' });
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      state: applyDeltaToState(previous, delta),
      serverTime: delta.updatedAt,
      ...(delta.network ? { network: delta.network } : {}),
    };
    this.emit();
  }

  private applyPresence(fields: Record<string, { controlledBy: string | null; controlledSince: number | null }>): void {
    const state = this.snapshot.state;
    if (!state) return;
    const nextFields = { ...state.fields };
    let changed = false;
    for (const [id, presence] of Object.entries(fields)) {
      const field = nextFields[id];
      if (!presence || !field) continue;
      nextFields[id] = { ...field, controlledBy: presence.controlledBy, controlledSince: presence.controlledSince };
      changed = true;
    }
    if (changed) this.snapshot = { ...this.snapshot, state: { ...state, fields: nextFields } };
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Outgoing                                                          */
  /* ---------------------------------------------------------------- */

  private nextRequestId(): string {
    this.counter += 1;
    return `${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }

  /**
   * Send a command and wait for the host to acknowledge it. Every mutating
   * button in the UI goes through here, so nothing is ever fire-and-forget.
   */
  async command(
    action: string,
    payload: Record<string, unknown> = {},
    options: { silent?: boolean } = {},
  ): Promise<CommandResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      const result: CommandResult = {
        ok: false,
        code: 'OFFLINE',
        error: tr('live.notConnected'),
      };
      if (!options.silent) this.pushToast('error', result.error as string);
      return result;
    }
    const requestId = this.nextRequestId();
    return new Promise<CommandResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.outbox.delete(requestId);
        this.snapshot.pending = this.outbox.size;
        resolve({ ok: false, code: 'TIMEOUT', error: tr('live.timeout') });
        this.emit();
      }, COMMAND_TIMEOUT_MS);
      this.outbox.set(requestId, { resolve, timer });
      this.snapshot.pending = this.outbox.size;
      this.emit();
      this.sendRaw({ t: 'cmd', requestId, action, payload });
    });
  }

  resync(): void {
    this.sendRaw({ t: 'resync' });
  }

  /**
   * Retry the session with an operator PIN. The socket is reopened so the PIN
   * travels in a fresh hello and the host can grant the scope before this
   * device is allowed to send anything.
   */
  submitPin(pin: string | null): void {
    this.options = { ...this.options, pin };
    this.patch({ pinChallenge: false });
    const socket = this.socket;
    this.suppressReconnect = true;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    this.clearReconnect();
    this.reconnectAttempt = 0;
    this.open();
  }

  private failPending(reason: string): void {
    if (this.outbox.size === 0) return;
    for (const [id, pending] of this.outbox) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'DISCONNECTED', error: reason });
      this.outbox.delete(id);
    }
    this.snapshot.pending = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Toasts                                                            */
  /* ---------------------------------------------------------------- */

  pushToast(level: Toast['level'], message: string): void {
    const toast: Toast = { id: this.nextRequestId(), level, message, ts: Date.now() };
    const toasts = [...this.snapshot.toasts, toast].slice(-4);
    this.snapshot = { ...this.snapshot, toasts };
    this.emit();
    window.setTimeout(() => this.dismissToast(toast.id), level === 'error' ? 9000 : 5000);
  }

  dismissToast(id: string): void {
    const toasts = this.snapshot.toasts.filter((toast) => toast.id !== id);
    if (toasts.length === this.snapshot.toasts.length) return;
    this.snapshot = { ...this.snapshot, toasts };
    this.emit();
  }
}

export const live = new LiveClient();

/** Ask the host to resync whenever the tab wakes up or the network returns. */
export function installConnectivityHandlers(): () => void {
  const onOnline = () => {
    live.pushToast('info', tr('live.networkBack'));
    live.revive();
  };
  const onOffline = () => {
    live.pushToast('warn', tr('live.deviceOffline'));
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') live.revive();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
