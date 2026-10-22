/**
 * The socket lifecycle of the browser client.
 *
 * There is no DOM in this suite (`vitest.config.ts` runs in the `node`
 * environment), so instead of rendering anything these tests install the four
 * globals `LiveClient` touches -- `WebSocket`, `window`, `navigator`,
 * `location` -- and drive the callbacks by hand.
 *
 * The bug this file exists for: `submitPin` replaces the socket, but `close()`
 * is asynchronous while `open()` completes synchronously. The replaced socket's
 * `onclose` therefore fired *after* the new one was live and, because the
 * handlers trusted `this.socket`, it stopped the live socket's keepalive, failed
 * its pending commands and armed a reconnect that opened a third socket. From
 * then on every delta was applied twice and each PIN entry leaked another
 * orphan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveClient } from '../src/frontend/lib/live';

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  sent: string[];
  closeCount: number;
  send: (data: string) => void;
  close: () => void;
  /** Deliver a `t: 'live'` frame, as the server does. */
  deliver: (message: unknown) => void;
}

const CLOSED = 3;

/**
 * `close()` deliberately defers its `onclose` to the end of the turn, because
 * that asynchrony is the entire bug. Handing the callback to a queue the test
 * drains explicitly keeps the ordering observable instead of timer-dependent.
 */
let sockets: FakeSocket[] = [];
let closeQueue: Array<() => void> = [];
let timers: Array<() => void> = [];
let intervals = 0;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closeCount = 0;

  constructor(public url: string) {
    sockets.push(this as unknown as FakeSocket);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    closeQueue.push(() => this.onclose?.());
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Run every callback a deferred `close()` queued. */
function drainCloses(): void {
  const queued = closeQueue;
  closeQueue = [];
  for (const run of queued) run();
}

/** Run every `window.setTimeout` callback the client scheduled. */
function drainTimers(): void {
  const queued = timers;
  timers = [];
  for (const run of queued) run();
}

const globals = globalThis as Record<string, unknown>;
let saved: Array<[string, PropertyDescriptor | undefined]> = [];

/**
 * Node already defines `navigator` and `WebSocket` as accessor properties, so a
 * plain assignment throws. Define rather than assign, and remember the original
 * descriptor so `afterEach` can put it back exactly as it was.
 */
function stub(key: string, value: unknown): void {
  saved.push([key, Object.getOwnPropertyDescriptor(globals, key)]);
  Object.defineProperty(globals, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
  sockets = [];
  closeQueue = [];
  timers = [];
  intervals = 0;
  saved = [];
  stub('WebSocket', FakeWebSocket);
  stub('navigator', { onLine: true });
  stub('location', { protocol: 'http:', host: 'scoreboard.local:3000' });
  stub('window', {
    location: globals.location,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => {
      intervals += 1;
      return intervals;
    },
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(() => {
  for (const [key, descriptor] of saved.reverse()) {
    if (descriptor) Object.defineProperty(globals, key, descriptor);
    else delete globals[key];
  }
  saved = [];
});

/** The full-state frame the server sends on hello and on every resync. */
function stateFrame(seq: number): unknown {
  return {
    t: 'state',
    state: {
      state: { seq, updatedAt: seq, matches: {}, fields: {} },
      network: null,
      links: [],
      role: 'spectator',
      tokenScope: null,
    },
  };
}

/** Mark a socket open and let the server greet it, exactly as a real session does. */
function openSocket(index: number): FakeSocket {
  const socket = sockets[index];
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  socket.deliver(stateFrame(1));
  return socket;
}

/** A connected client: one socket, open, with a full-state frame applied. */
function connectedClient(pin: string | null = null): LiveClient {
  const client = new LiveClient();
  client.connect(pin === null ? {} : { pin });
  expect(sockets).toHaveLength(1);
  openSocket(0);
  expect(client.getSnapshot().connection).toBe('live');
  return client;
}

describe('socket replacement', () => {
  it('leaves the replacement socket alone when the old one finishes closing', () => {
    const client = connectedClient();
    const intervalsWhileLive = intervals;

    client.submitPin('1234');

    // The replacement is live before the old socket's close is delivered --
    // that ordering is the bug, not an accident of the test.
    expect(sockets).toHaveLength(2);
    openSocket(1);
    expect(client.getSnapshot().connection).toBe('live');
    expect(intervals).toBe(intervalsWhileLive + 1);

    drainCloses();

    // The dead socket must not have touched the live connection.
    expect(client.getSnapshot().connection).toBe('live');
    expect(intervals).toBe(intervalsWhileLive + 1); // its stopPing() never ran

    drainTimers();
    expect(sockets).toHaveLength(2); // no third connection was opened
    expect(client.getSnapshot().connection).toBe('live');
  });

  it('ignores frames from a superseded socket', () => {
    const client = connectedClient();
    client.submitPin('1234');
    const stale = sockets[0];
    const replacement = openSocket(1);
    drainCloses();

    const before = client.getSnapshot().version;
    stale.deliver({ t: 'delta', delta: { seq: 99, updatedAt: 99 } });
    expect(client.getSnapshot().version).toBe(before);
    expect(client.getSnapshot().state?.seq).toBe(1);

    // The same frame on the socket that is actually live must still land.
    replacement.deliver({ t: 'delta', delta: { seq: 99, updatedAt: 99 } });
    expect(client.getSnapshot().state?.seq).toBe(99);
  });

  it('sends the PIN on the replacement connection, not the retired one', () => {
    const client = connectedClient();
    client.submitPin('4321');
    openSocket(1);
    drainCloses();

    const hello = (socket: FakeSocket) =>
      socket.sent.map((raw) => JSON.parse(raw) as { t: string; pin?: string }).find((m) => m.t === 'hello');
    expect(hello(sockets[0])?.pin).toBeUndefined();
    expect(hello(sockets[1])?.pin).toBe('4321');
  });

  it('does not fail the pending commands of the live connection', async () => {
    const client = connectedClient();
    client.submitPin('1234');
    openSocket(1);
    drainCloses();
    expect(client.getSnapshot().connection).toBe('live');

    const result = client.command('match.pause', { matchId: 'm1' });
    expect(client.getSnapshot().pending).toBe(1);

    drainCloses(); // a second stray close, as a flaky network would deliver
    expect(client.getSnapshot().pending).toBe(1);
    expect(client.getSnapshot().connection).toBe('live');

    const sent = sockets[1].sent.map((raw) => JSON.parse(raw) as { t: string; requestId?: string });
    const requestId = sent.find((m) => m.t === 'cmd')?.requestId;
    expect(requestId).toBeDefined();
    sockets[1].deliver({ t: 'ack', requestId, ok: true });
    await expect(result).resolves.toMatchObject({ ok: true });
  });
});
