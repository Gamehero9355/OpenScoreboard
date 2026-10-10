/**
 * Throwaway harness: drive a real Radball competition through the host's
 * WebSocket so the bracket tree can be looked at with real data.
 */
import WebSocket from 'ws';

const TOKEN = process.argv[2];
const PORT = process.argv[3] ?? '3001';
const PHASE = process.argv[4] ?? 'group';

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const pending = new Map();
let state = null;

function send(msg) {
  ws.send(JSON.stringify(msg));
}

function command(name, payload) {
  return new Promise((resolve) => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    pending.set(id, resolve);
    send({ t: 'command', id, name, payload });
  });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.t === 'welcome' || msg.t === 'state') state = msg.state;
  if (msg.t === 'result' && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.t === 'error') console.error('server error', JSON.stringify(msg).slice(0, 400));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  send({ t: 'hello', protocol: 2, token: TOKEN, clientLabel: 'harness' });
  await wait(700);

  const teams = [
    'RSC Freiburg, Jonas Weber, Felix Roth',
    'TSV München, Lena Huber, Max Bauer',
    'BG Köln, Sarah Neumann, Tim Klein',
    'SV Bremen, Anna Fischer, Luca Vogel',
    'SC Hamburg, Marie Schulz, Paul Brandt',
    '1. FC Nürnberg, Emma Richter, Jan Wolf',
    'VfB Stuttgart, Mia Wagner, Luis Braun',
    'Hertha Berlin, Zoe Zimmermann, Finn Richter',
  ];

  const create = await command('tournament.create', {
    name: 'U15 Radball Hallenliga',
    format: 'radball',
    participants: teams.map((line) => line.split(', ')),
    confirmReplace: true,
    fieldNames: ['Hall 1', 'Hall 2'],
    radball: {
      ageCategory: 'U15',
      groupCount: 2,
      qualifies: 2,
      finalRound: { mode: 'ranking-matches' },
    },
  });
  console.log('create:', create.ok ? 'ok' : JSON.stringify(create).slice(0, 500));
  await wait(500);

  const radball = () => state.radball;
  console.log('phases:', JSON.stringify(radball()?.phaseOrder));

  // Play every group fixture in the entry phase, alternating winners so the
  // tables have a spread of points.
  const entryPhases = (radball()?.phaseOrder ?? [])
    .map((id) => state.radball.phases[id])
    .filter((p) => p && (p.kind === 'group-stage' || p.kind === 'round-robin'));
  const entryPhaseIds = new Set(entryPhases.map((p) => p.id));

  const playable = Object.values(state.matches).filter(
    (m) => m.radball && entryPhaseIds.has(m.radball.phaseId) && m.participantAId && m.participantBId && m.state === 'READY',
  );
  console.log('group fixtures to play:', playable.length);

  let n = 0;
  for (const m of playable) {
    n += 1;
    // A mix of wins and draws so the qualification cut has something to decide.
    const draw = n % 4 === 0;
    await command('match.assign', { matchId: m.id, fieldId: n % 2 === 0 ? 1 : 2 });
    if (draw) {
      await command('match.score', { matchId: m.id, side: 'A', delta: 1 });
      await command('match.score', { matchId: m.id, side: 'B', delta: 1 });
    } else {
      const side = n % 2 === 0 ? 'A' : 'B';
      await command('match.score', { matchId: m.id, side, delta: 1 });
      await command('match.score', { matchId: m.id, side, delta: 1 });
      await command('match.score', { matchId: m.id, side, delta: 1 });
    }
    await command('match.end', { matchId: m.id });
    await wait(30);
  }
  await wait(900);
  console.log('after group stage, phaseOrder:', JSON.stringify(radball()?.phaseOrder));
  console.log('champion:', radball()?.championId);

  if (PHASE !== 'group') {
    const q = await command('radball.qualify', {});
    console.log('qualify:', q.ok ? 'ok' : JSON.stringify(q).slice(0, 400));
    await wait(900);
    console.log('after qualify, phaseOrder:', JSON.stringify(radball()?.phaseOrder));

    // Play the final round so the crown has something to point at.
    const finals = Object.values(state.matches).filter(
      (m) => m.radball && m.radball.phaseId !== entryPhaseIds.values().next().value && m.participantAId && m.participantBId && m.state === 'READY',
    );
    console.log('final round fixtures:', finals.map((m) => m.roundName));
    for (const m of finals) {
      await command('match.assign', { matchId: m.id, fieldId: 1 });
      await command('match.score', { matchId: m.id, side: 'A', delta: 1 });
      await command('match.score', { matchId: m.id, side: 'A', delta: 1 });
      await command('match.score', { matchId: m.id, side: 'A', delta: 1 });
      await command('match.end', { matchId: m.id });
      await wait(40);
    }
    await wait(1000);
    console.log('champion:', radball()?.championId);
  }

  console.log('READY');
  ws.close();
  process.exit(0);
});

ws.on('error', (e) => {
  console.error('ws error', e.message);
  process.exit(1);
});
