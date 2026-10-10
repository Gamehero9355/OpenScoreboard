/**
 * WebSocket hub.
 *
 * Design goals: one connection per device, deltas instead of full state, no
 * polling, and a server that stays responsive with a hundred spectators attached
 * to a laptop's Wi-Fi.
 *
 *  - only changed matches/participants are sent (`Delta`)
 *  - a full `state` is sent on connect and on explicit resync
 *  - running timers are re-anchored every 15 s instead of being ticked server
 *    side, so N clients cost the same as one
 *  - unresponsive sockets are reaped, and clients reconnect on their own
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage } from '../../shared/protocol';
import type { Delta, NetworkInfo, PublicState, ServerMessage } from '../../shared/types';
import { isLoopback, type AccessControl, type SessionScope } from '../auth/access';
import type { TournamentStore } from '../store/store';
import { type Mutation } from '../tournament/state';
import { actorLabel, dispatchCommand, type DispatchDeps, type DispatchOutcome } from './dispatch';
import { claimField } from '../tournament/matchops';

export const MAX_CLIENTS = 200;
const MAX_MESSAGE_BYTES = 256 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const TIMER_ANCHOR_MS = 15_000;
const NETWORK_POLL_MS = 5_000;
const RATE_CAPACITY = 120;
const RATE_REFILL_PER_SEC = 30;
const DEDUPE_WINDOW = 256;
/**
 * Operator PIN throttling.
 *
 * The PIN is checked during `hello`, which is the one message type that arrives
 * before the command rate limiter exists, so it needs its own budget. Without
 * it a single socket could try the whole four-digit space at line rate, and each
 * new socket started with a fresh token bucket. Counting per *remote address*
 * rather than per socket means reconnecting does not hand the attacker a fresh
 * allowance either.
 */
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_BASE_MS = 30_000;
const PIN_LOCK_MAX_MS = 15 * 60_000;
/** Keep the failure table from growing without bound on a busy network. */
const PIN_TRACKED_CLIENTS = 512;

interface PinFailures {
  failures: number;
  lockedUntil: number;
}

interface ClientSession {
  id: string;
  socket: WebSocket;
  scope: SessionScope;
  actor: string;
  topic: string;
  label: string | null;
  alive: boolean;
  connectedAt: number;
  greetingSent: boolean;
  helloDeadline: NodeJS.Timeout | null;
  tokens: number;
  lastRefill: number;
  seen: Map<string, DispatchOutcome>;
  seenOrder: string[];
  /** Remote address, used to throttle PIN attempts across sockets. */
  remote: string;
  /** Request id of the command in flight, so a crash still produces an ack. */
  pendingRequestId: string | null;
}

export interface HubOptions {
  store: TournamentStore;
  access: AccessControl;
  deps: DispatchDeps;
  publicState: (scope: SessionScope) => PublicState;
  network: () => NetworkInfo;
  log?: (message: string) => void;
}

export class WsHub {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientSession>();
  private messages = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private timerAnchorTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private lastNetworkKey = '';
  private nextId = 1;
  private pinFailures = new Map<string, PinFailures>();

  constructor(private readonly options: HubOptions) {}

  attach(server: Server, path = '/ws'): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    this.wss = wss;

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== path) {
        socket.destroy();
        return;
      }
      if (this.clients.size >= MAX_CLIENTS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        this.onConnection(ws, request);
      });
    });

    wss.on('close', () => this.stopTimers());
    this.startTimers();
  }

  private startTimers(): void {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          client.socket.terminate();
        }
      }
    }, HEARTBEAT_MS);
    this.timerAnchorTimer = setInterval(() => this.broadcastTimerAnchors(), TIMER_ANCHOR_MS);
    this.networkTimer = setInterval(() => this.checkNetwork(), NETWORK_POLL_MS);
    for (const timer of [this.heartbeatTimer, this.timerAnchorTimer, this.networkTimer]) {
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  private stopTimers(): void {
    for (const timer of [this.heartbeatTimer, this.timerAnchorTimer, this.networkTimer]) {
      if (timer) clearInterval(timer);
    }
    this.heartbeatTimer = null;
    this.timerAnchorTimer = null;
    this.networkTimer = null;
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                             */
  /* ---------------------------------------------------------------- */

  private onConnection(ws: WebSocket, request: IncomingMessage): void {
    const id = `c${this.nextId++}`;
    const remote = request.socket.remoteAddress ?? null;
    const scope: SessionScope = isLoopback(remote)
      ? this.options.access.adminFromLoopback()
      : this.options.access.spectator();

    const session: ClientSession = {
      id,
      socket: ws,
      scope,
      actor: scope.label,
      topic: 'display',
      label: null,
      alive: true,
      connectedAt: Date.now(),
      greetingSent: false,
      helloDeadline: null,
      tokens: RATE_CAPACITY,
      lastRefill: Date.now(),
      seen: new Map(),
      seenOrder: [],
      remote: normaliseRemote(remote),
      pendingRequestId: null,
    };
    this.clients.set(id, session);

    session.helloDeadline = setTimeout(() => {
      if (!session.greetingSent) ws.close(4400, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    if (typeof session.helloDeadline.unref === 'function') session.helloDeadline.unref();

    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data: unknown) => {
      session.alive = true;
      // `onMessage` is async and not serialised per socket, so a rejection here
      // would otherwise become an unhandled rejection and the client would sit
      // there until its own timeout expired. Always answer with an ack.
      void this.onMessage(session, String(data)).catch((error: unknown) => {
        const requestId = session.pendingRequestId;
        session.pendingRequestId = null;
        this.options.log?.(
          `client ${session.id} message failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.send(session, {
          t: 'ack',
          requestId: requestId ?? '',
          ok: false,
          code: 'INTERNAL',
          error: 'The server could not complete that action.',
        });
      });
    });
    ws.on('close', () => this.dropClient(session));
    ws.on('error', () => this.dropClient(session));

    // The session is only greeted once its own hello arrives: the hello may
    // carry a token or a read-only hint that changes the scope, and a client
    // must never be told it is the host and then downgraded a moment later.
  }

  private dropClient(session: ClientSession): void {
    if (session.helloDeadline) clearTimeout(session.helloDeadline);
    this.clients.delete(session.id);
    const release = session.scope.role === 'operator' ? session.scope.fieldId : null;
    if (release) {
      const current = this.options.store.state.fields[release];
      if (current && current.controlledBy === session.actor) {
        try {
          // The field has to be looked up again inside the operation: `apply`
          // hands the engine a draft, so an object captured from the live state
          // would be edited in place and then thrown away.
          this.options.store.apply(
            (state, _c, m) => {
              const field = state.fields[release];
              if (!field || field.controlledBy !== session.actor) return;
              field.controlledBy = null;
              field.controlledSince = null;
              m.fields.add(release);
              m.events.push({
                type: 'FIELD_RELEASED',
                message: `${field.name} control released (${session.actor} disconnected).`,
                fieldId: release,
              });
            },
            this.options.store.createContext('system', 'admin', null),
          );
        } catch {
          /* best effort */
        }
      }
    }
    this.options.log?.(`client ${session.id} disconnected (${this.clients.size} left)`);
  }

  private greet(session: ClientSession): void {
    if (session.greetingSent) return;
    session.greetingSent = true;
    if (session.helloDeadline) {
      clearTimeout(session.helloDeadline);
      session.helloDeadline = null;
    }
    this.send(session, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
      role: session.scope.role,
      tokenScope: session.scope.fieldId,
    });
    this.sendState(session);

    // An operator link takes ownership of its field so the host can see who is
    // driving each board, and so a second phone cannot silently take over.
    if (session.scope.role === 'operator' && session.scope.fieldId) {
      const fieldId = session.scope.fieldId;
      // `hello` already downgraded any scope naming a field this tournament
      // does not have, so the lookup cannot miss here -- but it costs one guard
      // to keep the claim path total rather than trusting that invariant from
      // another method.
      const field = this.options.store.state.fields[fieldId];
      if (!field) {
        /* `hello` downgrades this case; nothing left to claim. */
      } else if (field.controlledBy && field.controlledBy !== session.actor) {
        this.send(session, {
          t: 'notify',
          level: 'warn',
          message: `${field.name} is currently controlled by ${field.controlledBy}. Ask the host to release it.`,
        });
      } else {
        try {
          this.options.store.apply(
            (s, c, m) => claimField(s, fieldId, false, c, m),
            this.options.store.createContext(session.actor, 'operator', fieldId),
          );
        } catch {
          /* claim conflicts are reported through the notify above */
        }
      }
    }
  }

  private send(session: ClientSession, message: ServerMessage): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    try {
      session.socket.send(JSON.stringify(message));
      this.messages += 1;
    } catch {
      session.socket.terminate();
    }
  }

  private sendState(session: ClientSession): void {
    this.send(session, {
      t: 'state',
      state: this.options.publicState(session.scope),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Incoming messages                                                */
  /* ---------------------------------------------------------------- */

  private async onMessage(session: ClientSession, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw, MAX_MESSAGE_BYTES);
    if (!parsed.ok) {
      // The validator drops everything it could not fully accept, so the id is
      // recovered from the raw frame. Without it a client whose frame was
      // slightly malformed would wait out its own timeout instead of being told
      // what was wrong.
      const requestId = requestIdOf(raw);
      this.send(session, { t: 'notify', level: 'error', message: parsed.error });
      if (requestId) {
        this.send(session, { t: 'ack', requestId, ok: false, code: 'BAD_REQUEST', error: parsed.error });
      }
      return;
    }
    const message = parsed.value;

    if (message.t === 'hello') {
      if (message.token) {
        const scope = this.options.access.resolveToken(message.token);
        if (scope) {
          session.scope = scope;
        } else {
          this.send(session, {
            t: 'notify',
            level: 'warn',
            code: 'TOKEN_INVALID',
            message: 'That access link is not valid any more. Continue as a read-only spectator.',
          });
          session.scope = this.options.access.spectator();
        }
      }

      // A control link is a bearer secret, so the optional PIN is a genuine
      // second factor: without it the session is downgraded before it can ever
      // issue a command, and the client is told why. Attempts are throttled per
      // remote address with an escalating lockout, so the four-digit space
      // cannot simply be walked through on the venue WLAN.
      if (session.scope.role === 'operator' && this.options.access.requiresPin()) {
        const lockMs = this.pinLockedFor(session.remote);
        if (lockMs > 0) {
          this.send(session, {
            t: 'notify',
            level: 'error',
            code: 'PIN_LOCKED',
            message: `Too many wrong PIN attempts. This device is locked out for ${Math.ceil(lockMs / 1000)} more seconds.`,
          });
          session.scope = this.options.access.spectator();
        } else if (!message.pin || !this.options.access.checkPin(message.pin)) {
          if (message.pin) {
            const remaining = this.recordPinFailure(session.remote);
            this.options.log?.(
              `wrong operator PIN from ${session.remote} (${remaining} attempt${remaining === 1 ? '' : 's'} before lockout)`,
            );
          }
          this.send(session, {
            t: 'notify',
            level: 'warn',
            code: 'PIN_REQUIRED',
            message: message.pin
              ? 'That PIN is not correct. This control link stays read-only.'
              : 'This control link needs the operator PIN before it can score.',
          });
          session.scope = this.options.access.spectator();
        } else {
          this.clearPinFailures(session.remote);
        }
      }
      // A token can outlive the field it names. `access.json` deliberately lives
      // outside tournament data, and its per-field tokens are never pruned, so a
      // printed `/field/5#t=…` QR code from an eight-field event keeps resolving
      // after the host runs a two-field one -- restoring an older backup does the
      // same. The scope has to be settled here, before `greet` sends the state,
      // or the client is told it is an operator and only downgraded afterwards.
      if (session.scope.role === 'operator' && session.scope.fieldId) {
        if (!this.options.store.state.fields[session.scope.fieldId]) {
          this.send(session, {
            t: 'notify',
            level: 'warn',
            code: 'TOKEN_INVALID',
            message:
              'That control link is for a playing field this tournament does not have. Continue as a read-only spectator.',
          });
          session.scope = this.options.access.spectator();
        }
      }

      // Downgrade only: a display can declare itself read-only, nothing can
      // declare itself admin.
      if (message.readOnly && session.scope.role !== 'spectator') {
        session.scope = this.options.access.spectator();
      }
      session.actor = actorLabel(session.scope, message.clientLabel ?? null);
      session.topic =
        message.topic ?? (session.scope.role === 'operator' ? `field:${session.scope.fieldId}` : 'display');
      session.label = message.clientLabel ?? null;
      this.greet(session);
      return;
    }

    if (message.t === 'ping') {
      this.send(session, { t: 'pong', serverTime: Date.now() });
      return;
    }

    if (message.t === 'resync') {
      this.sendState(session);
      if (message.requestId) {
        this.send(session, { t: 'ack', requestId: message.requestId, ok: true });
      }
      return;
    }

    if (message.t === 'cmd') {
      if (!session.greetingSent) {
        this.send(session, {
          t: 'ack',
          requestId: message.requestId,
          ok: false,
          code: 'BAD_REQUEST',
          error: 'Session not ready yet, retry in a moment.',
        });
        return;
      }
      if (!this.consumeToken(session)) {
        this.send(session, {
          t: 'ack',
          requestId: message.requestId,
          ok: false,
          code: 'TOO_MANY_REQUESTS',
          error: 'Too many actions in a row. Slow down for a second.',
        });
        return;
      }
      const cached = session.seen.get(message.requestId);
      if (cached) {
        this.send(session, {
          t: 'ack',
          requestId: message.requestId,
          ok: cached.ok,
          ...(cached.error ? { error: cached.error } : {}),
          ...(cached.code ? { code: cached.code } : {}),
        });
        return;
      }
      // Only armed for the dispatch itself, so the failure handler above always has
      // the id of the command that was genuinely in flight.
      session.pendingRequestId = message.requestId;
      let outcome: DispatchOutcome;
      try {
        outcome = await dispatchCommand(
          this.options.deps,
          { scope: session.scope, actor: session.actor },
          message.action,
          message.payload,
        );
      } finally {
        session.pendingRequestId = null;
      }
      this.remember(session, message.requestId, outcome);
      this.send(session, {
        t: 'ack',
        requestId: message.requestId,
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.code ? { code: outcome.code } : {}),
      });
      if (outcome.ok && outcome.message) {
        this.send(session, { t: 'notify', level: 'info', message: outcome.message });
      }
    }
  }

  private consumeToken(session: ClientSession): boolean {
    const now = Date.now();
    const elapsed = (now - session.lastRefill) / 1000;
    session.lastRefill = now;
    session.tokens = Math.min(RATE_CAPACITY, session.tokens + elapsed * RATE_REFILL_PER_SEC);
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }

  /** How long `remote` is still locked out, in milliseconds (0 when free). */
  private pinLockedFor(remote: string): number {
    const entry = this.pinFailures.get(remote);
    if (!entry) return 0;
    if (entry.lockedUntil <= Date.now()) return 0;
    return entry.lockedUntil - Date.now();
  }

  /** Count one wrong PIN and return the attempts left before lockout. */
  private recordPinFailure(remote: string): number {
    this.prunePinFailures();
    const entry = this.pinFailures.get(remote) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= PIN_MAX_FAILURES) {
      // Back off exponentially per lockout, so repeated guessing gets slower.
      const over = entry.failures - PIN_MAX_FAILURES;
      const wait = Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_BASE_MS * 2 ** Math.min(over, 6));
      entry.lockedUntil = Date.now() + wait;
      entry.failures = 0;
    }
    this.pinFailures.set(remote, entry);
    return Math.max(0, PIN_MAX_FAILURES - entry.failures);
  }

  private clearPinFailures(remote: string): void {
    this.pinFailures.delete(remote);
  }

  /** Drop entries whose lockout has expired, then bound the table's size. */
  private prunePinFailures(): void {
    const now = Date.now();
    for (const [remote, entry] of this.pinFailures) {
      if (entry.lockedUntil <= now && entry.failures === 0) this.pinFailures.delete(remote);
    }
    while (this.pinFailures.size > PIN_TRACKED_CLIENTS) {
      const oldest = this.pinFailures.keys().next();
      if (oldest.done) break;
      this.pinFailures.delete(oldest.value);
    }
  }

  private remember(session: ClientSession, requestId: string, outcome: DispatchOutcome): void {
    session.seen.set(requestId, outcome);
    session.seenOrder.push(requestId);
    while (session.seenOrder.length > DEDUPE_WINDOW) {
      const oldest = session.seenOrder.shift();
      if (oldest) session.seen.delete(oldest);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Broadcasts                                                       */
  /* ---------------------------------------------------------------- */

  broadcastDelta(delta: Delta, mut: Mutation): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ t: 'delta', delta } satisfies ServerMessage);
    const notify = mut.notify
      ? JSON.stringify({
          t: 'notify',
          level: mut.notify.level,
          message: mut.notify.message,
          ...(mut.notify.text ? { text: mut.notify.text } : {}),
        } satisfies ServerMessage)
      : null;
    for (const client of this.clients.values()) {
      if (!client.greetingSent) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      try {
        client.socket.send(payload);
        this.messages += 1;
        if (notify && client.scope.role !== 'spectator') {
          client.socket.send(notify);
          this.messages += 1;
        }
      } catch {
        client.socket.terminate();
      }
    }
  }

  private broadcastTimerAnchors(): void {
    if (this.clients.size === 0) return;
    const store = this.options.store;
    const running = Object.values(store.state.matches).filter((match) => match.timer.running);
    if (running.length === 0) return;
    const serverTime = Date.now();
    for (const match of running) {
      const payload = JSON.stringify({
        t: 'timer',
        matchId: match.id,
        timer: match.timer,
        serverTime,
      } satisfies ServerMessage);
      for (const client of this.clients.values()) {
        if (!client.greetingSent || client.socket.readyState !== WebSocket.OPEN) continue;
        try {
          client.socket.send(payload);
        } catch {
          client.socket.terminate();
        }
      }
    }
  }

  private checkNetwork(): void {
    const network = this.options.network();
    const key = `${network.primaryIp}|${network.status}|${network.port}`;
    if (key === this.lastNetworkKey) return;
    const first = this.lastNetworkKey === '';
    this.lastNetworkKey = key;
    if (first) return;
    this.options.log?.(`network change detected: ${network.url ?? 'no LAN address'} (${network.status})`);
    const delta: Delta = { seq: this.options.store.state.seq, updatedAt: Date.now(), network };
    const payload = JSON.stringify({ t: 'delta', delta } satisfies ServerMessage);
    for (const client of this.clients.values()) {
      if (!client.greetingSent || client.socket.readyState !== WebSocket.OPEN) continue;
      try {
        client.socket.send(payload);
      } catch {
        client.socket.terminate();
      }
    }
  }

  invalidateOperatorSessions(): void {
    for (const client of this.clients.values()) {
      if (client.scope.role !== 'operator') continue;
      this.send(client, {
        t: 'notify',
        level: 'warn',
        code: 'TOKEN_INVALID',
        message: 'This tournament was replaced. Reconnect with the new field QR code to control the next event.',
      });
      try {
        client.socket.close(4401, 'tournament replaced');
      } catch {
        client.socket.terminate();
      }
    }
  }

  /** Force every connected client to reload its full state. */
  forceResync(): void {
    for (const client of this.clients.values()) {
      if (client.greetingSent) this.sendState(client);
    }
  }

  clientStats(): { total: number; byTopic: Record<string, number> } {
    const byTopic: Record<string, number> = {};
    for (const client of this.clients.values()) {
      byTopic[client.topic] = (byTopic[client.topic] ?? 0) + 1;
    }
    return { total: this.clients.size, byTopic };
  }

  get messageCount(): number {
    return this.messages;
  }

  /** Everyone currently holding a field lock. */
  fieldHolders(): Record<string, string | null> {
    const holders: Record<string, string | null> = {};
    for (const [id, field] of Object.entries(this.options.store.state.fields)) {
      holders[id] = field.controlledBy;
    }
    return holders;
  }

  shutdown(): void {
    this.stopTimers();
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.pinFailures.clear();
    this.wss?.close();
  }
}

/**
 * Fold IPv4-mapped IPv6 and any zone suffix into one stable string, so a single
 * phone cannot get a fresh PIN allowance by reconnecting from a different-looking
 * address form.
 */
function normaliseRemote(address: string | null): string {
  if (!address) return 'unknown';
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  const zone = bare.indexOf('%');
  return zone === -1 ? bare : bare.slice(0, zone);
}

/** Best-effort recovery of the request id from a frame that failed validation. */
function requestIdOf(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const id = (parsed as { requestId?: unknown }).requestId;
    return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
  } catch {
    return null;
  }
}
