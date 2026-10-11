/**
 * Access control over HTTP and WebSocket.
 *
 * These are the tests that matter for a device on the venue Wi-Fi: a spectator
 * or operator token must never be handed a control link, a control link with a
 * PIN must not be able to score before the PIN is supplied, and rotating a
 * token must take the old one out of service immediately.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/shared/types';
import { startServer, type RunningServer } from '../src/backend/index';
import { buildDemoTournament } from '../src/backend/tournament/demo';

let server: RunningServer;
let dataDir: string;
let clientDir: string;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tsb-access-'));
  clientDir = mkdtempSync(join(tmpdir(), 'tsb-access-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>Tournament Scoreboard</title>');
  server = await startServer({
    port: 0,
    dataDir,
    clientDir,
    quiet: true,
    autoPort: true,
    mdnsName: 'tournament-scoreboard-access-test',
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  // A tournament with two matches on the fields, so scoring has a target.
  server.store.apply(
    (state, ctx, mut) => buildDemoTournament(state, ctx, mut),
    server.store.createContext('Test host', 'admin', null),
  );
});

afterAll(async () => {
  await server?.close();
  for (const dir of [dataDir, clientDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface Session {
  socket: WebSocket;
  messages: ServerMessage[];
  role: () => string;
  notices: () => string[];
  command: (action: string, payload?: unknown) => Promise<{ ok: boolean; code?: string; error?: string }>;
  close: () => Promise<void>;
}

function open(token: string | null, pin?: string, readOnly?: boolean): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const messages: ServerMessage[] = [];
    let role = 'unknown';

    socket.on('message', (raw: unknown) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      messages.push(message);
      if (message.t === 'hello') role = message.role;
    });
    socket.on('error', reject);
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          token,
          ...(pin ? { pin } : {}),
          ...(readOnly ? { readOnly: true } : {}),
        }),
      );
      // Wait until the greeting landed so the scope is final.
      const started = Date.now();
      const poll = () => {
        const greeted = messages.some((message) => message.t === 'state');
        if (greeted || Date.now() - started > 3000) {
          resolve({
            socket,
            messages,
            role: () => role,
            notices: () =>
              messages
                .filter((message) => message.t === 'notify')
                .map((message) => (message.t === 'notify' ? (message.code ?? message.level) : '')),
            command: (action, payload) =>
              new Promise((done) => {
                const requestId = `r${Math.random().toString(36).slice(2)}`;
                const onMessage = (raw: unknown) => {
                  const message = JSON.parse(String(raw)) as ServerMessage;
                  if (message.t === 'ack' && message.requestId === requestId) {
                    socket.off('message', onMessage);
                    done({ ok: message.ok, ...(message.code ? { code: message.code } : {}), ...(message.error ? { error: message.error } : {}) });
                  }
                };
                socket.on('message', onMessage);
                socket.send(JSON.stringify({ t: 'cmd', requestId, action, payload }));
                setTimeout(
                  () => done({ ok: false, code: 'TIMEOUT', error: 'no ack' }),
                  3000,
                );
              }),
            close: () =>
              new Promise((done) => {
                socket.once('close', () => done());
                socket.close();
              }),
          });
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  });
}

async function hostToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/links`);
  const body = (await response.json()) as { links: { purpose: string; token?: string }[] };
  const token = body.links.find((link) => link.purpose === 'host')?.token;
  if (!token) throw new Error('the host token is missing');
  return token;
}

async function operatorToken(field: 'field-1' | 'field-2'): Promise<string> {
  const response = await fetch(`${baseUrl}/api/links`);
  const body = (await response.json()) as { links: { purpose: string; token?: string }[] };
  const token = body.links.find((link) => link.purpose === field)?.token;
  if (!token) throw new Error(`${field} token is missing`);
  return token;
}

describe('link exposure', () => {
  it('gives the host every link including the control tokens', async () => {
    const token = await hostToken();
    const session = await open(token);
    const state = session.messages.find((message) => message.t === 'state');
    if (state?.t !== 'state') throw new Error('no state');
    const purposes = state.state.links.map((link) => link.purpose);
    expect(purposes).toContain('general');
    expect(purposes).toContain('field-1');
    expect(purposes).toContain('host');
    expect(state.state.links.some((link) => link.purpose === 'general' && !link.token)).toBe(true);
    await session.close();
  });

  it('never sends a control token to an operator or a spectator', async () => {
    const operator = await operatorToken('field-1');
    const asOperator = await (await fetch(`${baseUrl}/api/state?token=${operator}`)).json();
    const purposes = (asOperator as { links: { purpose: string; token?: string; adminOnly: boolean }[] }).links;
    expect(purposes.every((link) => !link.token)).toBe(true);
    expect(purposes.every((link) => !link.adminOnly)).toBe(true);
    expect(purposes.map((link) => link.purpose)).not.toContain('host');
    // The public links a spectator is allowed to see are still there.
    expect(purposes.map((link) => link.purpose)).toContain('general');
    expect(purposes.map((link) => link.purpose)).toContain('display');
  });
});

describe('operator pin', () => {
  it('keeps a control link read-only until the correct PIN is supplied', async () => {
    const token = await operatorToken('field-2');
    const pinSession = await open(await hostToken());
    const set = await pinSession.command('settings.update', { patch: { operatorPin: '7314' } });
    expect(set.ok).toBe(true);

    const withoutPin = await open(token);
    expect(withoutPin.role()).toBe('spectator');
    expect(withoutPin.notices()).toContain('PIN_REQUIRED');

    const wrongPin = await open(token, '0000');
    expect(wrongPin.role()).toBe('spectator');
    expect(wrongPin.notices()).toContain('PIN_REQUIRED');

    const rightPin = await open(token, '7314');
    expect(rightPin.role()).toBe('operator');

    // A spectator downgrade really does refuse a score command.
    const refused = await withoutPin.command('match.score', { side: 'A', delta: 1, fieldId: '2' });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('FORBIDDEN');

    const removed = await pinSession.command('settings.update', { patch: { operatorPin: null } });
    expect(removed.ok).toBe(true);

    await Promise.all([withoutPin.close(), wrongPin.close(), rightPin.close(), pinSession.close()]);
  }, 20000);
});

describe('token rotation', () => {
  it('invalidates the old operator token and issues a working replacement', async () => {
    const before = await operatorToken('field-1');
    const response = await fetch(`${baseUrl}/api/access/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'field-1' }),
    });
    const body = (await response.json()) as { ok: boolean; token?: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(before);

    const stale = await open(before);
    expect(stale.role()).toBe('spectator');

    const fresh = await open(body.token as string);
    expect(fresh.role()).toBe('operator');

    await Promise.all([stale.close(), fresh.close()]);
  }, 20000);
});

describe('tournament creation', () => {
  it('issues fresh field QR codes and retires the previous tournament’s codes', async () => {
    const before = await operatorToken('field-1');
    const connectedOperator = await open(before);
    const disconnected = new Promise<void>((resolve) => connectedOperator.socket.once('close', () => resolve()));
    const host = await open(await hostToken());
    const currentId = server.store.state.tournament?.id;
    expect(currentId).toBeTruthy();
    const payload = {
      name: 'Fresh Codes Cup',
      participants: ['Ana', 'Ben', 'Cleo', 'Dara'],
      format: 'single-elimination',
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: 42,
      settings: { defaultMatchDurationSec: 777, scoringIncrements: [1, 3], autoAssignNext: true },
      expectedTournamentId: currentId,
    };
    const staleConfirmation = await host.command('tournament.create', { ...payload, confirmReplace: true, expectedTournamentId: 'stale' });
    expect(staleConfirmation.ok).toBe(false);
    expect(staleConfirmation.code).toBe('CONFLICT');
    const refused = await host.command('tournament.create', payload);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('CONFLICT');
    expect(await operatorToken('field-1')).toBe(before);
    const created = await host.command('tournament.create', { ...payload, confirmReplace: true });
    expect(created.ok).toBe(true);
    await disconnected;
    expect(server.store.state.settings.defaultMatchDurationSec).toBe(777);
    expect(server.store.state.settings.scoringIncrements).toEqual([1, 3]);
    expect(server.store.state.settings.autoAssignNext).toBe(true);

    const after = await operatorToken('field-1');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);

    const stale = await open(before);
    expect(stale.role()).toBe('spectator');

    const fresh = await open(after);
    expect(fresh.role()).toBe('operator');

    await Promise.all([stale.close(), fresh.close(), host.close()]);
  }, 20000);
});

describe('http surface', () => {
  it('refuses an unknown rotate kind with a readable error', async () => {
    const response = await fetch(`${baseUrl}/api/access/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'everything' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('kind');
  });

  /**
   * Loopback is granted admin without a token so the host PC never types a
   * secret. That makes a page open in a browser on the host PC the interesting
   * attacker, and a plain HTML form is the interesting vector: it needs no
   * preflight, so it would otherwise reach every mutating endpoint.
   */
  it('rejects a cross-site form post to a host-only endpoint', async () => {
    const response = await fetch(`${baseUrl}/api/prune`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: 'x=1',
    });
    expect(response.status).toBe(403);
  });

  it('rejects an origin that does not match the host it reached', async () => {
    const response = await fetch(`${baseUrl}/api/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('still answers a same-origin post from the host page', async () => {
    const response = await fetch(`${baseUrl}/api/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
    });
    expect(response.status).toBe(200);
  });

  it('sends the hardening headers the app needs to stay locked down', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Inline script would defeat the whole policy, so the theme bootstrap has to
    // be a real file.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('serves exports without leaking stack traces', async () => {
    const results = await fetch(`${baseUrl}/api/export/results.csv`);
    expect(results.status).toBe(200);
    const text = await results.text();
    expect(text).toContain('place,name');
    expect(text).not.toMatch(/at Object\./);
  });

  it('writes and restores a backup document', async () => {
    const backup = await fetch(`${baseUrl}/api/backup`);
    const document = await backup.json();
    // The content type is not decoration: a form post cannot set it without a
    // preflight, which is what keeps this route out of reach of a page on the
    // host PC. The real client always sends it.
    const prune = await fetch(`${baseUrl}/api/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect((await prune.json()).ok).toBe(true);

    const restore = await fetch(`${baseUrl}/api/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });
    expect(restore.status).toBe(200);
    expect(server.store.state.tournament).not.toBeNull();

    const broken = await fetch(`${baseUrl}/api/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(broken.status).toBe(400);
  }, 20000);
});

/**
 * The hall display is switched from a field operator's phone as well as the
 * host's desk, so this is an access-control question and not just a UI one:
 * the operator command must reach the settings slice, and a spectator session
 * must not be able to change what the hall sees.
 */
describe('display screen switching', () => {
  it('lets a field operator switch the hall display and refuses a spectator', async () => {
    const operator = await open(await operatorToken('field-1'));
    expect(operator.role()).toBe('operator');

    const switched = await operator.command('display.setScreen', { screen: 'pause', message: 'Halbzeit' });
    expect(switched.ok).toBe(true);
    expect(server.store.state.settings.displayScreen).toBe('pause');
    expect(server.store.state.settings.displayMessage).toBe('Halbzeit');

    // Back to the board. A switch that carries no message must not wipe the one
    // the host typed, or clearing the pause text would happen by accident.
    const back = await operator.command('display.setScreen', { screen: 'scores' });
    expect(back.ok).toBe(true);
    expect(server.store.state.settings.displayScreen).toBe('scores');
    expect(server.store.state.settings.displayMessage).toBe('Halbzeit');

    const rejected = await operator.command('display.setScreen', { screen: 'nope' });
    expect(rejected.ok).toBe(false);
    expect(rejected.code).toBe('BAD_REQUEST');

    // A token the server does not know is a spectator; no token at all would be
    // the host PC on loopback, which is granted admin.
    const spectator = await open('not-a-real-token');
    expect(spectator.role()).toBe('spectator');
    const refused = await spectator.command('display.setScreen', { screen: 'standings' });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('FORBIDDEN');
    // A refused command changes nothing.
    expect(server.store.state.settings.displayScreen).toBe('scores');

    await Promise.all([operator.close(), spectator.close()]);
  }, 20000);
});
