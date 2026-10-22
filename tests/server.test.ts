import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type Delta, type ServerMessage } from '../src/shared/types';
import { startServer, type RunningServer } from '../src/backend/index';
import { homeFieldOf, periodLeftSec } from '../src/shared/matchUtils';

let server: RunningServer;
let dataDir: string;
let clientDir: string;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tsb-server-'));
  clientDir = mkdtempSync(join(tmpdir(), 'tsb-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>Tournament Scoreboard</title>');
  server = await startServer({
    port: 0,
    dataDir,
    clientDir,
    quiet: true,
    autoPort: true,
    mdnsName: 'tournament-scoreboard-test',
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  wsUrl = `ws://127.0.0.1:${server.port}/ws`;
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

/* ------------------------------------------------------------------ */
/* WebSocket test client                                              */
/* ------------------------------------------------------------------ */

interface Waiter {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class TestClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(url: string = wsUrl) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw: unknown) => {
      const parsed = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(parsed);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          waiter.resolve(parsed);
        }
      }
    });
  }

  open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  hello(payload: Partial<ClientMessage & { t: 'hello' }> = {}): void {
    this.socket.send(
      JSON.stringify({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        token: payload.token ?? null,
        ...(payload.topic ? { topic: payload.topic } : {}),
        ...(payload.clientLabel ? { clientLabel: payload.clientLabel } : {}),
        ...(payload.readOnly ? { readOnly: true } : {}),
      }),
    );
  }

  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 4000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry.timer !== timer);
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForState(): Promise<ServerMessage> {
    return this.waitFor((message) => message.t === 'state');
  }

  async command(action: string, payload?: unknown, requestId = nextRequestId()): Promise<{
    ok: boolean;
    error?: string;
    code?: string;
    requestId: string;
  }> {
    this.socket.send(JSON.stringify({ t: 'cmd', requestId, action, payload }));
    const ack = await this.waitFor(
      (message) => message.t === 'ack' && message.requestId === requestId,
      5000,
    );
    if (ack.t !== 'ack') throw new Error('unexpected message');
    return { ok: ack.ok, error: ack.error, code: ack.code, requestId };
  }

  waitForDelta(predicate: (delta: Delta) => boolean, timeoutMs = 4000): Promise<Delta> {
    const found = this.messages
      .filter((message): message is Extract<ServerMessage, { t: 'delta' }> => message.t === 'delta')
      .find((message) => predicate(message.delta));
    if (found) return Promise.resolve(found.delta);
    return this.waitFor(
      (message) => message.t === 'delta' && predicate(message.delta),
      timeoutMs,
    ).then((message) => (message as Extract<ServerMessage, { t: 'delta' }>).delta);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

const openClients: TestClient[] = [];
async function connect(
  options: { token?: string | null; readOnly?: boolean; topic?: string; label?: string } = {},
): Promise<TestClient> {
  const client = new TestClient();
  openClients.push(client);
  await client.open();
  client.hello({
    token: options.token ?? null,
    readOnly: options.readOnly,
    topic: options.topic,
    clientLabel: options.label,
  });
  await client.waitForState();
  return client;
}

afterAll(async () => {
  for (const client of openClients) await client.close();
});

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

describe('http api', () => {
  it('reports health without leaking anything', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.app).toBe('tournament-scoreboard');
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });

  it('serves the web interface and falls back to index.html for app routes', async () => {
    const direct = await fetch(`${baseUrl}/`);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain('Tournament Scoreboard');

    const deep = await fetch(`${baseUrl}/display/1`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('Tournament Scoreboard');
  });

  it('serves the bare results route the results QR code encodes', async () => {
    // The query string must not defeat the SPA fallback: a phone that scanned the
    // results QR asks for /results?bare=1, and that has to return the app.
    const deep = await fetch(`${baseUrl}/results?bare=1`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('Tournament Scoreboard');

    const state = (await (await fetch(`${baseUrl}/api/state?readonly=1`)).json()) as { links: { purpose: string; url: string }[] };
    const results = state.links.find((link) => link.purpose === 'results');
    expect(results?.url).toContain('/results?bare=1');
  });

  it('lists the host logo folder and serves only image files from it', async () => {
    const index = (await (await fetch(`${baseUrl}/api/logos`)).json()) as {
      files: string[];
      defaultFile: string | null;
      dir: string;
    };
    expect(Array.isArray(index.files)).toBe(true);
    // The folder path comes back so a host who cannot find it is told where it is.
    expect(typeof index.dir).toBe('string');

    // A crest is readable by a spectator: it is drawn on the boards. The
    // repository ships files in `logos/`, so this path is required rather than
    // skipped -- a conditional branch here would quietly stop testing anything
    // the day the folder is renamed or emptied.
    expect(index.files.length).toBeGreaterThan(0);
    const first = index.files[0];
    expect(first).toBeDefined();
    if (first) {
      const image = await fetch(`${baseUrl}/logos/${encodeURIComponent(first)}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toMatch(/^image\//);
    }
    // The token file lives next door in the data directory. This route must not
    // become a way to read it, by traversal or by extension.
    for (const attempt of ['..%2F..%2Fdata%2Faccess.json', 'access.json', '..%2F..%2Fpackage.json']) {
      const escaped = await fetch(`${baseUrl}/logos/${attempt}`);
      expect([400, 404]).toContain(escaped.status);
    }
  });

  it('never exposes control tokens to a read-only caller', async () => {
    const readonly = await fetch(`${baseUrl}/api/state?readonly=1`);
    const body = (await readonly.json()) as {
      role: string;
      links: { token?: string; url: string }[];
    };
    expect(body.role).toBe('spectator');
    expect(body.links.length).toBeGreaterThan(3);
    expect(body.links.every((link) => !link.token)).toBe(true);
    expect(body.links.every((link) => !link.url.includes('#t='))).toBe(true);
  });

  it('gives the host interface the control links', async () => {
    const response = await fetch(`${baseUrl}/api/state`);
    const body = (await response.json()) as { role: string; links: { purpose: string; token?: string }[] };
    expect(body.role).toBe('admin');
    const fieldLinks = body.links.filter((link) => link.purpose === 'field-1' || link.purpose === 'field-2');
    expect(fieldLinks).toHaveLength(2);
    expect(fieldLinks.every((link) => Boolean(link.token))).toBe(true);
    const hostLink = body.links.find((link) => link.purpose === 'host');
    // The host link is the one an operator opens the wizard with, so it must
    // carry a control token and must not be one of the read-only links.
    expect(hostLink).toBeDefined();
    expect(hostLink?.token).toBeTruthy();
    expect(typeof hostLink?.token).toBe('string');
  });

  it('blocks host-only endpoints for a read-only caller', async () => {
    const response = await fetch(`${baseUrl}/api/system?readonly=1`);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('renders QR codes locally as PNG and SVG', async () => {
    const png = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent(baseUrl)}&size=256`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toContain('image/png');
    const buffer = Buffer.from(await png.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(200);
    expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const svg = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent(baseUrl)}&format=svg`);
    expect(svg.status).toBe(200);
    expect(await svg.text()).toContain('<svg');
  });

  it('rejects a QR request without text', async () => {
    const response = await fetch(`${baseUrl}/api/qr`);
    expect(response.status).toBe(400);
  });

  it('exports CSV and JSON', async () => {
    const csv = await fetch(`${baseUrl}/api/export/results.csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain('place,name,team');
    const json = await fetch(`${baseUrl}/api/export/tournament.json`);
    expect(json.status).toBe(200);
    expect(await json.text()).toContain('tournament-scoreboard');
  });

  it('returns a downloadable backup', async () => {
    const response = await fetch(`${baseUrl}/api/backup`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('tournament-backup-');
    const body = (await response.json()) as { app: string; state: unknown };
    expect(body.app).toBe('tournament-scoreboard');
    expect(body.state).toBeTruthy();
  });

  it('rejects an unknown API endpoint with a JSON error', async () => {
    const response = await fetch(`${baseUrl}/api/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('survives a restore of an invalid document', async () => {
    const response = await fetch(`${baseUrl}/api/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not a Tournament Scoreboard backup/i);
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                          */
/* ------------------------------------------------------------------ */

describe('websocket api', () => {
  it('greets a loopback client as the host', async () => {
    const client = await connect({ label: 'Host PC' });
    const hello = await client.waitFor((message) => message.t === 'hello');
    expect(hello.t === 'hello' && hello.role).toBe('admin');
    await client.close();
  });

  it('honours a read-only hint on the host PC', async () => {
    const client = await connect({ readOnly: true, topic: 'display' });
    const hello = await client.waitFor((message) => message.t === 'hello');
    expect(hello.t === 'hello' && hello.role).toBe('spectator');
    await client.close();
  });

  it('refuses every control command from a read-only session', async () => {
    const spectator = await connect({ readOnly: true });
    const score = await spectator.command('match.score', { fieldId: '1', side: 'A', delta: 1 });
    expect(score.ok).toBe(false);
    expect(score.code).toBe('FORBIDDEN');
    const create = await spectator.command('tournament.create', {
      name: 'Hacked',
      participants: ['a', 'b'],
    });
    expect(create.ok).toBe(false);
    expect(create.code).toBe('FORBIDDEN');
    await spectator.close();
  });

  it('rejects malformed messages without dropping the connection', async () => {
    const client = await connect({ label: 'Fuzzer' });
    client.socket.send('this is not json');
    const notify = await client.waitFor((message) => message.t === 'notify');
    expect(notify.t === 'notify' && notify.level).toBe('error');

    // A command with no request id can only be reported, never executed.
    client.socket.send(JSON.stringify({ t: 'cmd', action: 'match.score' }));
    await client.waitFor(
      (message) => message.t === 'notify' && message.message.toLowerCase().includes('requestid'),
    );

    const unknown = await client.command('does.not.exist', {});
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('BAD_REQUEST');

    const badPayload = await client.command('match.score', { side: 'Z', delta: 1 });
    expect(badPayload.code).toBe('BAD_REQUEST');

    const oversized = await client.command('match.score', { side: 'A', delta: 9999 });
    expect(oversized.code).toBe('BAD_REQUEST');

    // An unknown message type is rejected too.
    client.socket.send(JSON.stringify({ t: 'launch-missiles' }));
    await client.waitFor((message) => message.t === 'notify' && /unknown message type/i.test(message.message));

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it('refuses a tournament it cannot parse', async () => {
    const host = await connect({ label: 'Host PC' });

    const noName = await host.command('tournament.create', { participants: ['Ana', 'Ben'] });
    expect(noName.ok).toBe(false);
    expect(noName.code).toBe('BAD_REQUEST');

    // A manual schedule with no fixture in it has nothing to put on the board,
    // so it is refused here rather than handing the host an empty event.
    const emptySchedule = await host.command('tournament.create', {
      name: 'Manual, empty',
      format: 'manual-schedule',
      participants: ['Ana', 'Ben', 'Cleo'],
    });
    expect(emptySchedule.ok).toBe(false);
    expect(emptySchedule.code).toBe('BAD_REQUEST');

    const selfMatch = await host.command('tournament.create', {
      name: 'Manual, self',
      format: 'manual-schedule',
      participants: ['Ana', 'Ben', 'Cleo'],
      manualMatches: [{ a: 0, b: 0 }],
    });
    expect(selfMatch.ok).toBe(false);
    expect(selfMatch.code).toBe('BAD_REQUEST');

    // A fixture pinned to a field the tournament does not have is a promise the
    // engine would have to silently break, so it never gets that far.
    const missingField = await host.command('tournament.create', {
      name: 'Manual, off-field',
      format: 'manual-schedule',
      participants: ['Ana', 'Ben', 'Cleo'],
      fieldNames: ['Field 1'],
      manualMatches: [{ a: 0, b: 1, fieldId: '4' }],
    });
    expect(missingField.ok).toBe(false);
    expect(missingField.code).toBe('BAD_REQUEST');

    // Every other format derives its own fixtures, so a fixture list travelling
    // with one is a contradiction rather than a harmless extra.
    const wrongFormat = await host.command('tournament.create', {
      name: 'Knockout, with fixtures',
      format: 'single-elimination',
      participants: ['Ana', 'Ben', 'Cleo'],
      manualMatches: [{ a: 0, b: 1 }],
    });
    expect(wrongFormat.ok).toBe(false);
    expect(wrongFormat.code).toBe('BAD_REQUEST');

    await host.close();
  });

  it('runs a full two-field tournament over the wire', async () => {
    const host = await connect({ label: 'Host PC' });
    const setup = await host.command('tournament.create', {
      name: 'Integration Cup',
      participants: ['Ana', 'Ben', 'Cleo', 'Dara', 'Eli', 'Fay', 'Gus', 'Hana'],
      format: 'single-elimination',
      thirdPlaceMatch: true,
      seeded: true,
      seedValue: 7,
    });
    expect(setup.ok).toBe(true);
    expect(server.store.state.participants && Object.keys(server.store.state.participants)).toHaveLength(8);

    const assign = await host.command('match.autoAssign', {});
    expect(assign.ok).toBe(true);
    const fieldOne = server.store.state.fields['1'].matchId as string;
    const fieldTwo = server.store.state.fields['2'].matchId as string;
    expect(fieldOne).toBeTruthy();
    expect(fieldTwo).toBeTruthy();
    expect(fieldOne).not.toBe(fieldTwo);

    // A spectator must see every score change arrive as a delta.
    const spectator = await connect({ readOnly: true, label: 'Phone' });
    const startOne = await host.command('match.start', { matchId: fieldOne });
    expect(startOne.ok).toBe(true);
    const startTwo = await host.command('match.start', { matchId: fieldTwo });
    expect(startTwo.ok).toBe(true);

    const delta = await spectator.waitForDelta(
      (update) => (update.matches ?? []).some((match) => match.id === fieldOne && match.state === 'RUNNING'),
    );
    expect(delta.matches?.length).toBeGreaterThan(0);

    const score = await host.command('match.score', { matchId: fieldOne, side: 'A', delta: 2 });
    expect(score.ok).toBe(true);
    const scoreDelta = await spectator.waitForDelta(
      (update) => (update.matches ?? []).some((match) => match.id === fieldOne && match.scoreA === 2),
    );
    expect(scoreDelta.seq).toBeGreaterThan(0);

    // Both finish; the winners must meet in the next round automatically.
    const finishOne = await host.command('match.finish', { matchId: fieldOne, winner: 'A' });
    expect(finishOne.ok).toBe(true);
    expect(server.store.state.fields['1'].matchId).toBeNull();
    const finishTwo = await host.command('match.finish', { matchId: fieldTwo, winner: 'B' });
    expect(finishTwo.ok).toBe(true);
    expect(server.store.state.matches[fieldOne].state).toBe('FINISHED');

    // Each field runs its own section of the draw, so both winners land in the
    // next match of their own section, which stays with that field.
    for (const [matchId, expectedField] of [
      [fieldOne, '1'],
      [fieldTwo, '2'],
    ] as const) {
      const played = server.store.state.matches[matchId];
      const next = server.store.state.matches[played.nextWinMatchId as string];
      expect(next, `${played.roundName} has no next match`).toBeTruthy();
      expect([next.participantAId, next.participantBId]).toContain(played.winnerId);
      expect(homeFieldOf(server.store.state, next)).toBe(expectedField);
      expect(played.state).toBe('FINISHED');
    }

    const duplicate = await host.command('match.finish', { matchId: fieldOne, winner: 'A' });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe('DUPLICATE_RESULT');

    await host.close();
    await spectator.close();
  }, 20000);

  it('ends the first half over the wire without ending the match', async () => {
    const host = await connect({ label: 'Host PC' });
    await host.command('tournament.create', {
      name: 'Break Cup',
      participants: ['Ana', 'Ben', 'Cleo', 'Dara'],
      format: 'single-elimination',
    });
    await host.command('match.autoAssign', {});
    const matchId = server.store.state.fields['1'].matchId as string;
    expect(matchId).toBeTruthy();
    expect(server.store.state.matches[matchId].timer.periodCount).toBe(2);

    const started = await host.command('match.start', { matchId });
    expect(started.ok).toBe(true);
    const scored = await host.command('match.score', { matchId, side: 'A', delta: 2 });
    expect(scored.ok).toBe(true);

    // The break: the clock stops and the match waits for the second half.
    const atBreak = await host.command('match.endHalf', { matchId });
    expect(atBreak.ok).toBe(true);
    const halted = server.store.state.matches[matchId];
    expect(halted.state).toBe('HALFTIME');
    expect(halted.timer.running).toBe(false);
    expect(halted.scoreA).toBe(2);
    expect(halted.winnerId).toBeNull();
    // The wall reads zero at the break, the same as an automatic halftime.
    expect(periodLeftSec(halted.timer, Date.now())).toBe(0);

    // It is not over: the match is still on the field and can be played out.
    expect(server.store.state.fields['1'].matchId).toBe(matchId);
    const resumed = await host.command('match.startSecondHalf', { matchId });
    expect(resumed.ok).toBe(true);
    expect(server.store.state.matches[matchId].state).toBe('RUNNING');
    expect(server.store.state.matches[matchId].timer.period).toBe(2);

    // A second half is the last period: there is no half left to end.
    const refused = await host.command('match.endHalf', { matchId });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('INVALID_STATE');

    // A spectator may not call the break.
    const spectator = await connect({ readOnly: true, label: 'Phone' });
    const notAllowed = await spectator.command('match.endHalf', { matchId });
    expect(notAllowed.ok).toBe(false);

    // The match is still a normal match: it can be finished, and the field is
    // free again for the tests that follow.
    const finished = await host.command('match.finish', { matchId, winner: 'A' });
    expect(finished.ok).toBe(true);
    expect(server.store.state.fields['1'].matchId).toBeNull();

    await host.close();
    await spectator.close();
  }, 20000);

  it('applies a repeated request id only once', async () => {
    const host = await connect({ label: 'Host PC' });
    await host.command('match.autoAssign', {});
    const matchId = server.store.state.fields['1'].matchId as string;
    expect(matchId).toBeTruthy();
    const start = await host.command('match.start', { matchId });
    expect(start.ok).toBe(true);
    const before = server.store.state.matches[matchId].scoreA;
    const requestId = nextRequestId();
    host.socket.send(
      JSON.stringify({ t: 'cmd', requestId, action: 'match.score', payload: { matchId, side: 'A', delta: 1 } }),
    );
    const first = await host.waitFor((message) => message.t === 'ack' && message.requestId === requestId);
    expect(first.t === 'ack' && first.ok).toBe(true);
    const afterFirst = server.store.state.matches[matchId].scoreA;
    // Same id again: the server answers from its cache and does not score twice.
    await host.command('match.score', { matchId, side: 'A', delta: 1 }, requestId);
    expect(server.store.state.matches[matchId].scoreA).toBe(afterFirst);
    expect(server.store.state.matches[matchId].scoreA).toBe(before + 1);
    await host.close();
  }, 20000);

  it('scopes an operator token to its own field', async () => {
    const links = (await (await fetch(`${baseUrl}/api/links`)).json()) as {
      links: { purpose: string; token?: string }[];
    };
    const fieldOneToken = links.links.find((link) => link.purpose === 'field-1')?.token;
    const fieldTwoToken = links.links.find((link) => link.purpose === 'field-2')?.token;
    expect(fieldOneToken).toBeTruthy();
    expect(fieldTwoToken).toBeTruthy();

    const operator = await connect({ token: fieldOneToken, label: 'Phone 1' });
    const hello = await operator.waitFor((message) => message.t === 'hello');
    expect(hello.t === 'hello' && hello.role).toBe('operator');
    expect(server.store.state.fields['1'].controlledBy).toContain('Field 1 operator');

    // Give field 1 a match so the operator has something to score.
    const host = await connect({ label: 'Host PC' });
    const autoAssign = await host.command('match.autoAssign', {});
    expect(autoAssign.ok).toBe(true);
    const fieldOneMatch = server.store.state.fields['1'].matchId;
    expect(fieldOneMatch).toBeTruthy();
    await host.command('match.start', { matchId: fieldOneMatch as string });

    const ownScore = await operator.command('match.score', { matchId: fieldOneMatch, side: 'A', delta: 1 });
    expect(ownScore.ok).toBe(true);

    const fieldTwoMatch = server.store.state.fields['2'].matchId as string;
    const otherScore = await operator.command('match.score', { matchId: fieldTwoMatch, side: 'A', delta: 1 });
    expect(otherScore.ok).toBe(false);
    expect(otherScore.code).toBe('FORBIDDEN');

    const adminAction = await operator.command('match.assign', { matchId: fieldTwoMatch, fieldId: '1' });
    expect(adminAction.ok).toBe(false);
    expect(adminAction.code).toBe('FORBIDDEN');

    // A second phone on the same control link is told the field is already
    // controlled. The claim is advisory by design -- both phones hold the same
    // field token and `assertOperatorField` only checks that the token matches
    // the field -- so what must be guaranteed is that the newcomer is *told*,
    // and that the holder in the state is not silently overwritten.
    const heldBy = server.store.state.fields['1'].controlledBy;
    expect(heldBy).toBeTruthy();
    const secondOperator = await connect({ token: fieldOneToken, label: 'Phone 2' });
    const warning = await secondOperator.waitFor(
      (message) => message.t === 'notify' && /controlled by/i.test(message.message),
    );
    expect(warning.t === 'notify' && warning.message).toContain(String(heldBy));
    expect(server.store.state.fields['1'].controlledBy).toBe(heldBy);
    await secondOperator.close();
    await host.close();
    await operator.close();
  }, 20000);

  it('recovers the full state after a reconnect', async () => {
    const first = await connect({ label: 'Tablet' });
    await first.waitForState();
    const seqBefore = server.store.state.seq;
    await first.close();

    const second = await connect({ label: 'Tablet' });
    const state = await second.waitFor((message) => message.t === 'state');
    if (state.t !== 'state') throw new Error('expected a state message');
    expect(state.state.state.seq).toBeGreaterThanOrEqual(seqBefore);
    expect(Object.keys(state.state.state.matches).length).toBe(
      Object.keys(server.store.state.matches).length,
    );
    expect(state.state.network.port).toBe(server.port);
    await second.close();
  }, 20000);

  it('resyncs on request', async () => {
    const client = await connect({ label: 'Display' });
    const before = client.messages.filter((message) => message.t === 'state').length;
    client.socket.send(JSON.stringify({ t: 'resync', requestId: 'resync-1' }));
    await client.waitFor((message) => message.t === 'ack' && message.requestId === 'resync-1');
    const after = client.messages.filter((message) => message.t === 'state').length;
    expect(after).toBeGreaterThan(before);
    await client.close();
  }, 20000);

  it('keeps working for the remaining clients when one disconnects mid-match', async () => {
    const host = await connect({ label: 'Host PC' });
    await host.command('match.autoAssign', {});
    const spectatorA = await connect({ readOnly: true });
    const spectatorB = await connect({ readOnly: true });
    const matchId = server.store.state.fields['1'].matchId as string;
    expect(matchId).toBeTruthy();
    await spectatorA.close();
    const result = await host.command('match.score', { matchId, side: 'B', delta: 1 });
    expect(result.ok).toBe(true);
    const delta = await spectatorB.waitForDelta(
      (update) => (update.matches ?? []).some((match) => match.id === matchId && match.scoreB >= 1),
    );
    expect(delta).toBeTruthy();
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
    await host.close();
    await spectatorB.close();
  }, 20000);

  it('reports system status only to the host', async () => {
    const response = await fetch(`${baseUrl}/api/system`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.database).toBeTruthy();
    expect(body.databaseOk).toBe(true);
    expect(typeof body.clients).toBe('number');
    expect(typeof body.lastSaveAt).toBe('number');
    expect(JSON.stringify(body)).not.toMatch(/trace|at Object\./);
  });

  it('keeps the team library over the wire and out of a spectator reach', async () => {
    const host = await connect({ label: 'Library host' });
    const spectator = await connect({ readOnly: true, label: 'Hall screen' });

    // A spectator can see the library, but not change it.
    const refused = await spectator.command('team.add', {
      name: 'RV Nord I',
      club: 'RV Nord',
      players: ['Anna', 'Ben'],
      ageCategory: 'U15',
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('FORBIDDEN');

    const added = await host.command('team.add', {
      name: 'RV Nord I',
      club: 'RV Nord',
      players: ['Anna', 'Ben'],
      ageCategory: 'U15',
    });
    expect(added.ok).toBe(true);

    // Everyone learns about it from the delta slice, not a refetch.
    const delta = await spectator.waitForDelta(
      (update) => Object.keys(update.teamLibrary?.teams ?? {}).length === 1,
    );
    expect(Object.keys(delta.teamLibrary?.teams ?? {})).toHaveLength(1);
    expect(delta.teamLibrary?.teams[delta.teamLibrary.order[0]].name).toBe('RV Nord I');

    // A duplicate name is refused with a readable reason, not a crash.
    const duplicate = await host.command('team.add', {
      name: 'rv nord i',
      club: null,
      players: ['Cal', 'Dan'],
      ageCategory: 'U17',
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toMatch(/already holds/i);

    // A bad payload never reaches the engine.
    const bad = await host.command('team.add', {
      name: 'RV Sued I',
      club: null,
      players: ['Only one'],
      ageCategory: 'U15',
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('BAD_REQUEST');

    // Bulk entry, then a move between age groups.
    const imported = await host.command('team.import', {
      mode: 'append',
      teams: [
        { name: 'RV Sued I', club: 'RV Sued', players: ['Cal', 'Dan'], ageCategory: 'U15' },
        { name: 'RV Ost I', club: null, players: ['Eve', 'Finn'], ageCategory: 'U15' },
      ],
    });
    expect(imported.ok).toBe(true);
    expect(server.store.state.teamLibrary.order).toHaveLength(3);

    const target = server.store.state.teamLibrary.order[2];
    const moved = await host.command('team.update', {
      id: target,
      team: {
        name: 'RV Ost I',
        club: null,
        players: ['Eve', 'Finn'],
        ageCategory: 'U19',
      },
    });
    expect(moved.ok).toBe(true);
    expect(server.store.state.teamLibrary.teams[target].ageCategory).toBe('U19');

    // Creating a tournament rebuilds the live state but keeps the library.
    const created = await host.command('tournament.create', {
      name: 'Library Cup',
      format: 'radball',
      participants: [
        { name: 'A', players: ['A1', 'A2'] },
        { name: 'B', players: ['B1', 'B2'] },
        { name: 'C', players: ['C1', 'C2'] },
      ],
      thirdPlaceMatch: false,
      confirmReplace: true,
      expectedTournamentId: server.store.state.tournament?.id ?? null,
      radball: { ageCategory: 'U15' },
    });
    expect(created.ok).toBe(true);
    expect(server.store.state.teamLibrary.order).toHaveLength(3);
    expect(server.store.state.participantOrder).toHaveLength(3);

    const removed = await host.command('team.remove', { id: target });
    expect(removed.ok).toBe(true);
    expect(server.store.state.teamLibrary.order).toHaveLength(2);

    await host.close();
    await spectator.close();
  }, 20000);

  it('creates a manual schedule and lets the host keep editing it', async () => {
    const host = await connect({ label: 'Host PC' });
    const created = await host.command('tournament.create', {
      name: 'Manual Cup',
      format: 'manual-schedule',
      participants: ['Ana', 'Ben', 'Cleo', 'Dara', 'Eli'],
      fieldNames: ['Field 1', 'Field 2'],
      manualMatches: [
        { a: 0, b: 1, round: 'Group stage' },
        { a: 0, b: 1, round: 'Group stage' },
        { a: 2, b: 3, round: 'Final', fieldId: '2' },
      ],
      confirmReplace: true,
      expectedTournamentId: server.store.state.tournament?.id ?? null,
    });
    expect(created.ok).toBe(true);
    // Five teams, three fixtures, one of them a repeat pairing. No bracket could
    // be built from this roster, which is why the format exists.
    const state = server.store.state;
    expect(Object.keys(state.matches)).toHaveLength(3);
    expect(state.tournament?.format).toBe('manual-schedule');
    expect(state.tournament?.rounds).toBe(2);
    const pinned = Object.values(state.matches).find((m) => m.roundName === 'Final');
    expect(pinned?.fieldId).toBe('2');

    // The same team is in two fixtures, so only those two can hold a ring: the
    // pre-load skips what it cannot place instead of failing the event.
    const loaded = Object.values(state.matches).filter((m) => m.fieldId);
    expect(loaded).toHaveLength(2);
    expect(new Set(loaded.flatMap((m) => [m.participantAId, m.participantBId])).size).toBe(4);

    // A fourth fixture, typed live.
    const ids = state.participantOrder;
    const added = await host.command('match.add', {
      participantAId: ids[3],
      participantBId: ids[4],
      roundName: 'Consolation',
    });
    expect(added.ok).toBe(true);
    expect(Object.keys(server.store.state.matches)).toHaveLength(4);

    const addedId = Object.keys(server.store.state.matches).at(-1) as string;
    const renamed = await host.command('match.setRoundName', {
      matchId: addedId,
      roundName: 'Friendly',
    });
    expect(renamed.ok).toBe(true);
    expect(server.store.state.matches[addedId]?.roundName).toBe('Friendly');

    const removed = await host.command('match.remove', { matchId: addedId });
    expect(removed.ok).toBe(true);
    expect(server.store.state.matches[addedId]).toBeUndefined();
    expect(Object.keys(server.store.state.matches)).toHaveLength(3);

    // A derived format refuses all three: its fixtures are a consequence of the
    // draw, not a list the host extends by hand.
    const replaced = await host.command('tournament.create', {
      name: 'Knockout Cup',
      format: 'single-elimination',
      participants: ['Ana', 'Ben', 'Cleo', 'Dara'],
      confirmReplace: true,
      expectedTournamentId: server.store.state.tournament?.id,
    });
    expect(replaced.ok).toBe(true);
    expect(server.store.state.tournament?.format).toBe('single-elimination');
    const bracketId = server.store.state.fields['1']?.matchId as string;
    const order = server.store.state.participantOrder;
    const handAdded = await host.command('match.add', {
      participantAId: order[0],
      participantBId: order[1],
    });
    expect(handAdded.ok).toBe(false);
    expect(handAdded.code).toBe('BAD_REQUEST');
    const handRenamed = await host.command('match.setRoundName', {
      matchId: bracketId,
      roundName: 'Renamed',
    });
    expect(handRenamed.ok).toBe(false);
    expect(handRenamed.code).toBe('BAD_REQUEST');

    await host.close();
  }, 20000);
});
