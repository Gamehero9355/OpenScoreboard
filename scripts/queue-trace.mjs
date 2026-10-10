/**
 * Queue inspection across the whole ten-team lifecycle.
 *
 * Plays the competition forward stage by stage over the real command layer and
 * prints what the dashboard queue panel would show at each point, so the pinning
 * and the "shared — either field" list can be checked at every step.
 *
 *   node scripts/queue-trace.mjs <ws-url> <token>
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../dist/server/shared/protocol.js';
import { homeFieldOf, isPlayable } from '../dist/server/shared/matchUtils.js';

const base = process.argv[2];
const token = process.argv[3];
if (!base || !token) {
  console.error('usage: node scripts/queue-trace.mjs <ws-url> <admin-token>');
  process.exit(2);
}

const httpBase = base.replace(/^ws/, 'http');
const ws = new WebSocket(`${base}/ws?t=${encodeURIComponent(token)}`, { origin: base });
let state = null;
let seq = 0;
let greeted = null;
let sawHello = null;
const waiting = new Map();

ws.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  if (message.t === 'state') state = message.state?.state ?? state;
  if (message.t === 'hello') sawHello = message;
  if (sawHello && state) {
    const resolve = greeted;
    greeted = null;
    if (resolve) resolve(sawHello);
  }
  const ack = waiting.get(message.requestId);
  if (ack) {
    waiting.delete(message.requestId);
    ack(message);
  }
});

const pause = () => new Promise((r) => setTimeout(r, 60));

async function send(action, payload = {}) {
  const requestId = `r${++seq}`;
  return new Promise((resolve) => {
    waiting.set(requestId, resolve);
    ws.send(JSON.stringify({ t: 'cmd', requestId, action, payload }));
  });
}

const refresh = async () => {
  state = (await (await fetch(`${httpBase}/api/state`)).json()).state;
  return state;
};

const nameOf = (id) => (id ? (state.participants[id]?.name ?? '?') : '—');
const finalOf = (key) => state.matches[`${state.tournament.id}:rf10:${key.toLowerCase()}`];
const groupName = (id) => state.radball?.groups[id]?.name ?? id ?? '—';

async function play(match, a, b, field) {
  const assign = await send('match.assign', { matchId: match.id, fieldId: field });
  if (!assign.ok) throw new Error(`assign ${match.roundName}: ${assign.error}`);
  await pause();
  const start = await send('match.start', { matchId: match.id, fieldId: field });
  if (!start.ok) throw new Error(`start ${match.roundName}: ${start.error}`);
  await pause();
  await send('match.score', { matchId: match.id, fieldId: field, side: 'A', delta: a });
  await pause();
  await send('match.score', { matchId: match.id, fieldId: field, side: 'B', delta: b });
  await pause();
  const done = await send('match.finish', { matchId: match.id, force: false });
  if (!done.ok) throw new Error(`finish ${match.roundName}: ${done.error}`);
  await pause();
}

function report(label) {
  const open = Object.values(state.matches).filter((m) => m.state !== 'FINISHED' && m.state !== 'CANCELLED');
  console.log(`\n--- ${label} ---`);
  console.log(`stage ${state.radball?.ten?.stage} · ${Object.keys(state.matches).length} matches`);
  for (const fieldId of Object.keys(state.fields).sort()) {
    const own = open.filter((m) => homeFieldOf(state, m) === fieldId);
    const groups = new Set(own.filter((m) => m.radball?.groupId).map((m) => groupName(m.radball.groupId)));
    console.log(`  field ${fieldId}: ${own.length} own · ${[...groups].join(', ') || '(no group fixtures)'}`);
  }
  const shared = open.filter((m) => homeFieldOf(state, m) === null && isPlayable(m));
  console.log(`  SHARED: ${shared.length}`);
  for (const match of shared) {
    console.log(`    ${match.roundName.padEnd(18)} ${nameOf(match.participantAId)} vs ${nameOf(match.participantBId)}`);
  }
  const notPlayable = open.filter((m) => homeFieldOf(state, m) === null && !isPlayable(m));
  console.log(`  shared-but-unplayable (hidden): ${notPlayable.length}`);
  for (const match of notPlayable) {
    console.log(`    ${match.roundName.padEnd(18)} waiting for participants`);
  }
}

async function main() {
  await new Promise((r) => ws.on('open', r));
  await new Promise((resolve) => {
    greeted = resolve;
    ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, token, clientLabel: 'queue-trace' }));
  });
  await refresh();
  report('fresh, preliminary round untouched');

  const groups = state.radball.groupOrder.map((id) => ({
    id,
    fieldId: state.radball.groups[id].fieldId,
    list: Object.values(state.matches).filter((m) => m.radball?.groupId === id),
  }));
  // Play half of each group's fixtures, the way a real round goes.
  for (let round = 0; round < 5; round += 1) {
    for (const group of groups) await play(group.list[round], 3, 1, group.fieldId);
  }
  await refresh();
  report('halfway through the preliminary round');

  for (let round = 5; round < 10; round += 1) {
    for (const group of groups) await play(group.list[round], 3, 1, group.fieldId);
  }
  await refresh();
  report('preliminary round complete, final phase not yet generated');

  const generated = await send('radball.finalPhase', { confirm: true });
  if (!generated.ok) throw new Error(`generate: ${generated.error}`);
  await refresh();
  report('final phase generated, nothing played yet');

  await play(finalOf('PLACEMENT_9_10'), 4, 2, '1');
  await play(finalOf('SEMIFINAL_1'), 4, 2, '2');
  await refresh();
  report('one placement and one semifinal played');

  ws.close();
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  ws.close();
  process.exitCode = 1;
});