/**
 * The language switch, end to end.
 *
 * The unit tests prove the catalogue and the store are correct. This proves the
 * switch is actually wired to the host -- that tapping it produces a settings
 * delta every connected screen applies, and that a plain HTTP round trip reports
 * the new value. The bug that started this was a control that looked switchable
 * and did nothing, so "the button exists" is not the thing worth asserting.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/backend/index';

interface Greeted {
  role: string;
  language: string | undefined;
}

/** Connect, greet, and hand back the live client plus a way to watch it. */
async function connect(port: number, token?: string): Promise<{
  socket: WebSocket;
  role: string;
  initial: Greeted;
  nextState: () => Promise<Greeted>;
  send: (payload: unknown) => void;
  close: () => Promise<void>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue: Greeted[] = [];
  const waiters: ((value: Greeted) => void)[] = [];
  let role = '';

  /** Queue a state observation, or hand it straight to a waiting caller. */
  const publish = (value: Greeted) => {
    role = value.role || role;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no greeting')), 5000);
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(JSON.stringify({ t: 'hello', protocol: 1, ...(token ? { token } : {}) }));
    });
    socket.on('message', (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as {
        t: string;
        state?: { role: string; state: { settings: { language?: string } } };
        // A language change arrives as a `delta` carrying only the settings
        // slice, not as a fresh `state` -- which is the whole point of the delta
        // protocol and the reason a screen following the host needs no polling.
        delta?: { settings?: { language?: string } };
      };
      if (message.t === 'state' && message.state) {
        publish({
          role: message.state.role,
          language: message.state.state.settings.language,
        });
        clearTimeout(timer);
        resolve();
        return;
      }
      if (message.t === 'delta' && message.delta?.settings) {
        publish({ role, language: message.delta.settings.language });
      }
    });
  });
  const initial = queue.shift() as Greeted;
  return {
    socket,
    role,
    initial,
    /** The next `state` or settings-carrying `delta` this client receives. */
    nextState: () =>
      new Promise<Greeted>((resolve) => {
        const value = queue.shift();
        if (value) resolve(value);
        else waiters.push(resolve);
      }),
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () =>
      new Promise<void>((done) => {
        socket.on('close', () => done());
        socket.close();
        setTimeout(done, 500).unref();
      }),
  };
}

async function withServer(run: (server: RunningServer) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tsb-lang-'));
  const server = await startServer({ dataDir, port: 0, quiet: true, demo: true, autoPort: false });
  try {
    await run(server);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('switching the language on the host', () => {
  it('reaches every connected screen as a settings delta', async () => {
    await withServer(async (server) => {
      const host = await connect(server.port);
      // A second screen, standing in for the projector or a field tablet.
      const spectator = await connect(server.port);

      expect(host.role).toBe('admin');
      expect(host.initial.language).toBe('en');
      expect(spectator.initial.language).toBe('en');

      const seenBySpectator = spectator.nextState();
      host.send({ t: 'cmd', requestId: 'de', action: 'settings.update', payload: { patch: { language: 'de' } } });

      // The spectator must be told without being asked -- this is what makes one
      // tap on the host repaint the whole hall.
      const updated = await seenBySpectator;
      expect(updated.language).toBe('de');

      await host.close();
      await spectator.close();
    });
  });

  it('acknowledges the command, so the button can show a failure', async () => {
    await withServer(async (server) => {
      const host = await connect(server.port);
      const ack = new Promise<{ ok: boolean; code?: string }>((resolve) => {
        host.socket.on('message', (raw: WebSocket.RawData) => {
          const message = JSON.parse(String(raw)) as { t: string; requestId?: string; ok?: boolean; code?: string };
          if (message.t === 'ack' && message.requestId === 'de') {
            resolve({ ok: Boolean(message.ok), ...(message.code ? { code: message.code } : {}) });
          }
        });
      });
      host.send({ t: 'cmd', requestId: 'de', action: 'settings.update', payload: { patch: { language: 'de' } } });
      expect(await ack).toEqual({ ok: true });
      await host.close();
    });
  });

  it('is refused for a language the app does not have', async () => {
    await withServer(async (server) => {
      const host = await connect(server.port);
      const reject = new Promise<{ ok: boolean }>((resolve) => {
        host.socket.on('message', (raw: WebSocket.RawData) => {
          const message = JSON.parse(String(raw)) as { t: string; requestId?: string; ok?: boolean };
          if (message.t === 'ack' && message.requestId === 'fr') resolve({ ok: Boolean(message.ok) });
        });
      });
      host.send({ t: 'cmd', requestId: 'fr', action: 'settings.update', payload: { patch: { language: 'fr' } } });
      expect(await reject).toEqual({ ok: false });
      await host.close();
    });
  });

  it('survives a reload, so it is a real setting and not local state', async () => {
    await withServer(async (server) => {
      const host = await connect(server.port);
      host.send({ t: 'cmd', requestId: 'de', action: 'settings.update', payload: { patch: { language: 'de' } } });
      await new Promise((r) => setTimeout(r, 300));
      await host.close();

      // A brand-new connection, which is what a phone reloading looks like.
      const reloaded = await connect(server.port);
      expect(reloaded.initial.language).toBe('de');
      await reloaded.close();
    });
  });

  it('is readable over HTTP by the settings page on first paint', async () => {
    await withServer(async (server) => {
      const host = await connect(server.port);
      host.send({ t: 'cmd', requestId: 'de', action: 'settings.update', payload: { patch: { language: 'de' } } });
      await new Promise((r) => setTimeout(r, 300));
      const response = await fetch(`http://127.0.0.1:${server.port}/api/state`);
      const body = (await response.json()) as { state: { settings: { language?: string } } };
      expect(body.state.settings.language).toBe('de');
      await host.close();
    });
  });
});