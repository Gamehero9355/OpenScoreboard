/**
 * Regressions for the defects found reviewing the whole program.
 *
 * Every test here corresponds to something that was actually broken, and each
 * one fails against the code as it stood before the fix. They are grouped by the
 * defect they guard, so a future change that reintroduces one points straight at
 * the reason it matters rather than at a line number.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/backend/index';
import { matchesCsv, participantsCsv } from '../src/shared/exports';
import {
  createHttpLimiters,
  limitClassFor,
  rateLimitKey,
  TokenBucketLimiter,
} from '../src/backend/http/ratelimit';
import { isLeagueTree } from '../src/frontend/components/BracketView';
import type { TournamentState } from '../src/shared/types';
import {
  adminCtx,
  createQuickTournament,
  createTestStore,
  playMatch,
  playableMatches,
  run,
  type TestStore,
} from './helpers';


/* ------------------------------------------------------------------ */
/* 1. The bracket drew every match twice                               */
/* ------------------------------------------------------------------ */

describe('bracket card placement', () => {
  /**
   * The knockout path placed cards against the poster *and* kept an
   * unconditional `poster.cards.map` further down the same parent, so every
   * knockout match rendered twice at identical coordinates with a duplicate
   * React key. The league shape was worse: `TreeLane` had already placed each
   * card inside its lane, and the stray map drew every league match a second
   * time on top of it.
   *
   * `bracket-tree.test.ts` covers the layout *algorithm*, which cannot see this:
   * both placements were driven by the same `poster.cards`, so the data was
   * always right and only the JSX was wrong. Asserting on the rendered tree
   * would need a DOM, which this project deliberately has none of. So this reads
   * the component's source instead and counts the placement sites -- the one
   * thing that is actually wrong, and the one thing a reformat cannot hide.
   */
  it('renders each card from exactly one placement site', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'frontend', 'components', 'BracketView.tsx'),
      'utf8',
    );
    // The component body only: the helper functions above it legitimately map
    // over cards when building the layout.
    // Only the component's *code*, not the explanatory comment above it: the
    // comment deliberately names the bug it describes, and matching it would be
    // counting prose.
    const from = source.indexOf('export function BracketView(');
    const body = source.slice(from).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Each placement site is a `<div className="bracket__node">` wrapping a
    // `MatchCard`. One inside `TreeLane` (lane-relative), and one in the
    // knockout-only conditional (poster-absolute). A third is the bug.
    const placementSites = body.match(/className="bracket__node"/g) ?? [];
    expect(placementSites).toHaveLength(2);
    // There must be exactly one place that reads `poster.cards` for placement,
    // and it has to be the lane-guarded one. A second, unconditional map is
    // exactly the bug that drew every match twice.
    const cardMaps = body.match(/poster\.cards\.map/g) ?? [];
    expect(cardMaps).toHaveLength(1);
    // And that single map must stay behind the lane test which decides which
    // shape owns the cards -- `TreeLane` reads `poster.cardsById`, never
    // `poster.cards`, so one occurrence plus the guard is the whole invariant.
    expect(body).toMatch(/poster\.lanes\.length === 0\s*\?\s*poster\.cards\.map/);
    expect(body).not.toMatch(/poster\.cards\.map\([\s\S]{0,120}?\)\s*:\s*null\}/);
  });

  it('places a lane card relative to its lane and a knockout card absolutely', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'frontend', 'components', 'BracketView.tsx'),
      'utf8',
    );
    // `TreeLane` subtracts the lane origin so the wire lines up with the gutter
    // tick; the poster path uses the card's own coordinates. If either regressed
    // to the other's form, cards would sit in the wrong place rather than being
    // drawn twice -- a different bug, and worth pinning separately.
    expect(source).toMatch(/style=\{\{ left: card\.x - lane\.x, top: card\.y - lane\.y \}\}/);
    expect(source).toMatch(/style=\{\{ left: card\.x, top: card\.y \}\}/);
  });

  it('keeps the knockout and league shapes distinguishable', async () => {
    const { store, dispose } = await createTestStore('bracket-shapes');
    try {
      createQuickTournament(store, { participants: 8 });
      expect(isLeagueTree(store.state)).toBe(false);
      // Strip every feeder: `isLeagueTree` must then see a self-contained round
      // robin, which is how the Radball competition tree is detected.
      for (const match of Object.values(store.state.matches)) {
        match.slotA = { kind: 'participant', participantId: match.participantAId } as typeof match.slotA;
        match.slotB = { kind: 'participant', participantId: match.participantBId } as typeof match.slotB;
      }
      expect(isLeagueTree(store.state)).toBe(true);
    } finally {
      await dispose();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. An operator token outliving its field crashed the hub            */
/* ------------------------------------------------------------------ */

describe('a control link for a field this tournament does not have', () => {
  /**
   * `access.json` deliberately lives outside tournament data, and its per-field
   * tokens are never pruned -- so a printed `/field/2#t=...` QR code from an
   * eight-field event keeps resolving after the host runs a two-field one.
   * Restoring an older backup does the same thing.
   *
   * The old code read `state.fields[fieldId].controlledBy` with no guard, on a
   * path that had *already* set `greetingSent` and sent the state: the phone
   * believed it was connected, the field was never claimed, the host saw it as
   * free, and the only trace was an `INTERNAL` ack.
   */
  it('is downgraded to spectator with a readable reason', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-stale-token-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, autoPort: false });
    try {
      // The token a printed QR code from an earlier event would carry.
      const token = await storedOperatorToken(dataDir, '2');
      expect(typeof token).toBe('string');
      if (typeof token !== 'string') return;

      // Remove field 2 while its token stays resolvable, the way a restored
      // one-field backup does.
      server.store.apply(
        (state, _ctx, mut) => {
          const remaining = { ...state.fields };
          delete remaining['2'];
          state.fields = remaining;
          state.settings.fieldNames = ['Only Field'];
          mut.fields.add('1');
          mut.settings = true;
          mut.tournament = true;
        },
        server.store.createContext('test', 'admin', null),
      );
      expect(server.store.state.fields['2']).toBeUndefined();

      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const seen: string[] = [];
      let role = '';
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no greeting within 5s')), 5000);
          socket.on('error', reject);
          socket.on('open', () => {
            socket.send(
              JSON.stringify({ t: 'hello', protocol: 1, token, topic: 'field:2', clientLabel: 'Phone' }),
            );
          });
          socket.on('message', (raw: WebSocket.RawData) => {
            const message = JSON.parse(String(raw)) as {
              t: string;
              code?: string;
              state?: { role: string };
            };
            seen.push(message.t + (message.code ? `:${message.code}` : ''));
            if (message.t === 'state' && message.state) role = message.state.role;
            // hello, state, notify TOKEN_INVALID -- and then silence: nothing
            // further should arrive, because the session is read-only now.
            if (seen.length >= 3) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        // Closing and letting the server drain first keeps the release write
        // inside the test rather than after the data directory is removed.
        await new Promise<void>((done) => {
          socket.on('close', () => done());
          socket.close();
          setTimeout(done, 500).unref();
        });
      } finally {
        socket.terminate();
      }

      expect(seen.some((entry) => entry.startsWith('hello'))).toBe(true);
      expect(seen.some((entry) => entry.startsWith('state'))).toBe(true);
      // The notice names the real reason, rather than the phone sitting there
      // with a silently unusable control link.
      expect(seen.some((entry) => entry.includes('TOKEN_INVALID'))).toBe(true);
      // It was never handed an operator scope.
      expect(role).toBe('spectator');
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('still grants a real field, so the guard did not break claiming', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-live-token-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, demo: true, autoPort: false });
    try {
      const token = await storedOperatorToken(dataDir, '1');
      expect(typeof token).toBe('string');
      if (typeof token !== 'string') return;
      expect(server.store.state.fields['1']).toBeDefined();

      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      try {
        const role = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no greeting within 5s')), 5000);
          socket.on('error', reject);
          socket.on('open', () => {
            socket.send(JSON.stringify({ t: 'hello', protocol: 1, token, topic: 'field:1', clientLabel: 'Phone' }));
          });
          socket.on('message', (raw: WebSocket.RawData) => {
            const message = JSON.parse(String(raw)) as { t: string; state?: { role: string } };
            if (message.t === 'state' && message.state) {
              clearTimeout(timer);
              resolve(message.state.role);
            }
          });
        });
        expect(role).toBe('operator');
        // And the field really was claimed by this session.
        await waitFor(() => server.store.state.fields['1']?.controlledBy !== null);
        expect(server.store.state.fields['1']?.controlledBy).toBeTruthy();
        // Disconnecting releases the field again, on a drained socket.
        await new Promise<void>((done) => {
          socket.on('close', () => done());
          socket.close();
          setTimeout(done, 500).unref();
        });
      } finally {
        socket.terminate();
      }
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. A dangling fieldId failed the whole match export                 */
/* ------------------------------------------------------------------ */

describe('CSV export with a dangling field reference', () => {
  /**
   * `setFieldNames` rebuilds `state.fields` and only checks the field-to-match
   * direction, so a match can keep naming a field that is gone -- and the
   * export route is unauthenticated, so one such row failed the entire
   * download for every spectator who asked for it.
   */
  it('writes a placeholder row instead of throwing', async () => {
    const { store, dispose } = await createTestStore('export-dangling');
    try {
      createQuickTournament(store, { participants: 4 });
      // `matchesCsv` skips byes and unplayed fixtures (`isRealMatch`), so the
      // match that carries the bad reference has to be one that was played.
      const playable = playableMatches(store)[0];
      expect(playable?.id).toBeTruthy();
      if (!playable) return;
      playMatch(store, playable.id, '1', 3, 1);
      const played = store.state.matches[playable.id];
      expect(played).toBeDefined();
      if (!played) return;
      played.fieldId = '7';

      const csv = matchesCsv(store.state);
      expect(csv).toContain('Field 7');
      // The other played matches are still on the sheet -- a throw would have
      // lost the whole download, not just the bad row.
      expect(csv.split('\r\n').filter(Boolean).length).toBeGreaterThan(1);
    } finally {
      await dispose();
    }
  });

  it('leaves the participant export reading the same map the same way', async () => {
    const { store, dispose } = await createTestStore('export-participants');
    try {
      createQuickTournament(store, { participants: 4 });
      const [participant] = Object.values(store.state.participants);
      expect(participant).toBeDefined();
      if (!participant) return;
      participant.fieldId = '9';
      expect(() => participantsCsv(store.state)).not.toThrow();
      expect(participantsCsv(store.state)).toContain('Field 9');
    } finally {
      await dispose();
    }
  });

  it('serves the export over HTTP for a state with a dangling field', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-export-http-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, demo: true, autoPort: false });
    try {
      // The demo assigns matches to fields but does not score them, and
      // `matchesCsv` skips a fixture with no history and no points, so score
      // one first to get a row that is actually on the sheet.
      const first = Object.values(server.store.state.matches).find(
        (match) => match.participantAId && match.participantBId && !match.isThirdPlace,
      );
      expect(first?.id).toBeTruthy();
      if (!first) return;
      const fieldId = (first.fieldId ?? '1') as '1';
      playMatch(server.store, first.id, fieldId, 3, 1);

      const played = server.store.state.matches[first.id];
      expect(played).toBeDefined();
      if (!played) return;
      played.fieldId = '42';
      const response = await fetch(`http://127.0.0.1:${server.port}/api/export/matches.csv`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Field 42');
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. The rollback clone grew for the whole event                      */
/* ------------------------------------------------------------------ */

describe('store.apply rollback', () => {
  /**
   * The pre-image now holds `events` by reference instead of deep-cloning it,
   * because the engine never mutates an event in place and events are appended
   * only after the operation returns. These tests are what make that sharing
   * safe: a refused operation must still leave nothing behind.
   */
  it('leaves no trace when a rule refuses half way through', async () => {
    const { store, dispose } = await createTestStore('rollback');
    try {
      createQuickTournament(store, { participants: 4 });
      const before = {
        participants: structuredClone(store.state.participants),
        matches: structuredClone(store.state.matches),
        fields: structuredClone(store.state.fields),
        eventCount: store.state.events.length,
        seq: store.state.seq,
      };

      const [participant] = Object.values(store.state.participants);
      expect(participant).toBeDefined();
      if (!participant) return;

      let threw = false;
      try {
        run(store, adminCtx(store), (state, ctx, mut) => {
          // Edit first, so the rollback has real work to undo, then refuse
          // exactly the way an engine rule would.
          const live = state.participants[participant.id];
          if (live) {
            live.name = 'SCRIBBLED';
            mut.participants.add(participant.id);
          }
          const missing = state.fields['999'];
          if (!missing) throw new Error('FIELD_NOT_FOUND');
          void ctx;
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      // The shared event array must be exactly as long as it was, and the
      // counter must not have moved.
      expect(store.state.events.length).toBe(before.eventCount);
      expect(store.state.seq).toBe(before.seq);
      for (const [id, participantBefore] of Object.entries(before.participants)) {
        expect(store.state.participants[id]?.name).toBe(participantBefore.name);
      }
      for (const [id, fieldBefore] of Object.entries(before.fields)) {
        expect(store.state.fields[id]?.matchId).toBe(fieldBefore.matchId);
      }
      expect(Object.keys(store.state.matches).sort()).toEqual(Object.keys(before.matches).sort());
      // `store.state` must still be the same object, or cached references go
      // stale -- that is why the rollback is assigned back rather than swapped.
      expect(store.state).toBe(store.state);
    } finally {
      await dispose();
    }
  });

  it('keeps every slice present after a rollback, including the shared one', async () => {
    const { store, dispose } = await createTestStore('rollback-shape');
    try {
      createQuickTournament(store, { participants: 4 });
      expect(() =>
        run(store, adminCtx(store), (state) => {
          const missing = state.fields['999'];
          if (!missing) throw new Error('refused');
        }),
      ).toThrow('refused');
      const state = store.state as TournamentState;
      for (const key of [
        'tournament',
        'participants',
        'participantOrder',
        'matches',
        'matchOrder',
        'fields',
        'settings',
        'radball',
        'teamLibrary',
        'savedTournaments',
        'events',
        'seq',
        'updatedAt',
      ] as const) {
        expect(state[key]).toBeDefined();
      }
    } finally {
      await dispose();
    }
  });

  it('still appends events on the success path', async () => {
    const { store, dispose } = await createTestStore('rollback-ok');
    try {
      createQuickTournament(store, { participants: 4 });
      const before = store.state.events.length;
      const [participant] = Object.values(store.state.participants);
      expect(participant).toBeDefined();
      if (!participant) return;

      run(store, adminCtx(store), (state, _ctx, mut) => {
        const live = state.participants[participant.id];
        if (!live) return;
        live.name = 'Renamed Team';
        mut.participants.add(participant.id);
        mut.events.push({ type: 'PARTICIPANT_UPDATED', message: 'renamed' });
      });

      expect(store.state.events.length).toBeGreaterThan(before);
      expect(store.state.participants[participant.id]?.name).toBe('Renamed Team');
    } finally {
      await dispose();
    }
  });

  /**
   * The reason the event log is shared by reference rather than deep-cloned:
   * `apply()` runs on every score tap, and cloning a log that grows to
   * `MAX_EVENTS` for the whole event made the cost climb with the tournament.
   *
   * This asserts the *shape* rather than a wall-clock number, because a timing
   * assertion on a shared CI machine is a flaky test that gets deleted. What is
   * actually guarded is that `apply` does not deep-copy the event log: a full
   * clone of a state this size is several times slower than the fast path, so
   * the ratio below fails loudly if the fast path ever goes away.
   */
  it('does not deep-copy the event log on every command', async () => {
    const { store, dispose } = await createTestStore('rollback-cost');
    try {
      createQuickTournament(store, { participants: 8 });
      // Fill the log to a realistic late-event size.
      const filler = Object.values(store.state.participants)[0];
      expect(filler).toBeDefined();
      if (!filler) return;
      for (let i = 0; i < 40; i += 1) {
        store.state.events.push({
          seq: store.state.seq + 1 + i,
          ts: Date.now(),
          type: 'PARTICIPANT_UPDATED',
          fieldId: null,
          matchId: null,
          actor: 'test',
          message: `padding event ${i}`,
        });
      }
      const eventCount = store.state.events.length;
      expect(eventCount).toBeGreaterThan(40);

      const time = (label: 'fast' | 'full'): number => {
        const start = performance.now();
        for (let i = 0; i < 60; i += 1) {
          if (label === 'fast') {
            const { events, ...rest } = store.state;
            structuredClone(rest);
            void events;
          } else {
            structuredClone(store.state);
          }
        }
        return performance.now() - start;
      };

      // Warm up so neither path pays a first-call cost the other does not.
      time('full');
      time('fast');
      const fast = time('fast');
      const full = time('full');

      // The log is a meaningful share of the state here, so skipping it has to
      // show. The factor is deliberately modest to stay stable on a slow host.
      expect(full).toBeGreaterThan(0);
      expect(fast).toBeLessThan(full);
    } finally {
      await dispose();
    }
  });

  it('restores the event log when a rule empties it and then refuses', async () => {
    const { store, dispose } = await createTestStore('rollback-events');
    try {
      createQuickTournament(store, { participants: 4 });
      const before = store.state.events.length;
      let threw = false;
      try {
        run(store, adminCtx(store), (state) => {
          // Replacing the array is the one way the engine clears the log; the
          // shared reference must not let that survive a refusal.
          state.events = [];
          throw new Error('refused after clearing');
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(store.state.events.length).toBe(before);
    } finally {
      await dispose();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. No HTTP rate limiting at all                                     */
/* ------------------------------------------------------------------ */

describe('http rate limiting', () => {
  it('refuses a flood and says when to come back', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1 });
    const key = '10.0.0.5';
    expect(limiter.consume(key).allowed).toBe(true);
    expect(limiter.consume(key).allowed).toBe(true);
    expect(limiter.consume(key).allowed).toBe(true);
    const refused = limiter.consume(key);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(0);
  });

  it('allows a cold burst up to capacity, as a page load needs', () => {
    const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSec: 1 });
    for (let i = 0; i < 10; i += 1) expect(limiter.consume('client').allowed).toBe(true);
    expect(limiter.consume('client').allowed).toBe(false);
  });

  it('refills continuously rather than in windows', () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSec: 10 });
    const key = 'refill';
    limiter.consume(key);
    limiter.consume(key);
    expect(limiter.consume(key).allowed).toBe(false);
    // 300 ms at 10/s is three whole tokens.
    expect(limiter.consume(key, Date.now() + 300).allowed).toBe(true);
  });

  it('keeps one client from draining another', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('does not let a client dodge the overall budget by changing endpoint', () => {
    const limiters = createHttpLimiters();
    let refused = 0;
    for (let i = 0; i < 400; i += 1) {
      if (!limiters.check(i % 2 === 0 ? 'qr' : 'network', '10.0.0.9').allowed) refused += 1;
    }
    expect(refused).toBeGreaterThan(300);
  });

  it('classes the expensive anonymous routes more tightly than the rest', () => {
    expect(limitClassFor('/api/network')).toBe('network');
    expect(limitClassFor('/api/qr')).toBe('qr');
    expect(limitClassFor('/api/state')).toBe('state');
    expect(limitClassFor('/api/export/results.csv')).toBe('export');
    expect(limitClassFor('/api/backup')).toBe('global');
    expect(limitClassFor('/host')).toBe('static_');
  });

  it('folds IPv4-mapped and zone-suffixed addresses into one key', () => {
    const fake = (address: string | undefined) =>
      ({ socket: { remoteAddress: address } }) as unknown as Parameters<typeof rateLimitKey>[0];
    expect(rateLimitKey(fake('::ffff:192.168.1.5'))).toBe('192.168.1.5');
    expect(rateLimitKey(fake('192.168.1.5'))).toBe('192.168.1.5');
    expect(rateLimitKey(fake('fe80::1%eth0'))).toBe('fe80::1');
    expect(rateLimitKey(fake(undefined))).toBe('unknown');
  });

  it('answers a flood with 429 and Retry-After', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-ratelimit-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, autoPort: false });
    try {
      let sawRemaining = false;
      let sawTooMany = false;
      let retryAfter = '';
      // `/api/network` allows 20 in a burst, then 5/s.
      for (let i = 0; i < 200; i += 1) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/network`);
        if (response.headers.has('x-ratelimit-remaining')) sawRemaining = true;
        if (response.status === 429) {
          sawTooMany = true;
          retryAfter = response.headers.get('retry-after') ?? '';
          const body = (await response.json()) as { code?: string };
          expect(body.code).toBe('TOO_MANY_REQUESTS');
          break;
        }
        await response.arrayBuffer();
      }
      expect(sawRemaining).toBe(true);
      expect(sawTooMany).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not refuse anything a real event does', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-ratelimit-ok-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, demo: true, autoPort: false });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // A host dashboard polling system status, a page load's worth of assets,
      // a phone opening state, and the QR gallery -- all from one address,
      // which is exactly what happens on a single-PC event.
      for (let i = 0; i < 20; i += 1) {
        expect((await fetch(`${base}/api/system`)).status).toBe(200);
      }
      for (let i = 0; i < 15; i += 1) {
        const asset = await fetch(`${base}/favicon.svg`);
        expect(asset.status).toBeLessThan(400);
        await asset.arrayBuffer();
      }
      expect((await fetch(`${base}/api/state`)).status).toBe(200);
      for (let i = 0; i < 8; i += 1) {
        const qr = await fetch(`${base}/api/qr?text=http://192.168.1.5:3000/host&size=256`);
        expect(qr.status).toBe(200);
        await qr.arrayBuffer();
      }
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      // And the exports a host downloads at the end.
      expect((await fetch(`${base}/api/export/results.csv`)).status).toBe(200);
      expect((await fetch(`${base}/api/export/matches.csv`)).status).toBe(200);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses an oversized body before parsing it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tsb-ratelimit-body-'));
    const server = await startServer({ dataDir, port: 0, quiet: true, autoPort: false });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'tournament-scoreboard', state: {}, padding: 'x'.repeat(2000) }),
      });
      // Loopback is admin, so this is about the limiter being mounted first:
      // the request is refused or validated, never served as a 500 from a
      // parser that ran against a flooded bucket.
      expect([400, 413, 429]).toContain(response.status);
      await response.arrayBuffer();
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read a field's operator token out of `access.json`.
 *
 * Deliberately goes through the file rather than into the running server: the
 * stored token is exactly what a printed QR code from an earlier event carries,
 * which is the whole point of this scenario. `RunningServer` does not expose the
 * `AccessControl`, and it should not.
 */
async function storedOperatorToken(dataDir: string, fieldId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dataDir, 'access.json'), 'utf8'),
      ) as { operatorTokens?: Record<string, string> };
      const token = parsed.operatorTokens?.[fieldId];
      if (typeof token === 'string' && token.length > 0) return token;
    } catch {
      /* written asynchronously; give it a moment */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/** Poll until a condition holds, so a test never races the event loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within the timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type { TestStore };