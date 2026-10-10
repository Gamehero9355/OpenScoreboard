/**
 * End-to-end smoke test over the real WebSocket protocol.
 *
 * The engine tests drive the functions directly; this drives the *commands* --
 * validation, permissions and dispatch included -- so the parts the browser
 * actually uses are exercised too. Not part of the suite: it is a manual check
 * for "does the app actually work when you click the buttons".
 *
 *   node scripts/smoke-radball10.mjs <url> <token>
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../dist/server/shared/protocol.js';

const base = process.argv[2] ?? 'ws://127.0.0.1:39411';
const token = process.argv[3];

if (!token) {
  console.error('usage: node scripts/smoke-radball10.mjs <ws-url> <admin-token>');
  process.exit(2);
}

const ws = new WebSocket(`${base}/ws?t=${encodeURIComponent(token)}`, { origin: base });
let state = null;
let seq = 0;
let greeted = null;
let sawHello = null;
const waiting = new Map();

ws.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  // `state` carries a PublicState, so the tournament slice is one level in.
  if (message.t === 'state') state = message.state?.state ?? state;
  if (message.t === 'hello') sawHello = message;
  // The greeting and the first snapshot go out together; neither is useful
  // without the other, so the handshake is only "done" once both have arrived.
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

/** The server rate-limits a burst of commands; this script is not a client. */
const THINK = 60;
const pause = () => new Promise((resolve) => setTimeout(resolve, THINK));

function send(action, payload = {}) {
  const requestId = `r${++seq}`;
  return new Promise((resolve) => {
    waiting.set(requestId, resolve);
    ws.send(JSON.stringify({ t: 'cmd', requestId, action, payload }));
  });
}

const OPEN = () => new Promise((resolve) => ws.on('open', resolve));

const httpBase = base.replace(/^ws/, 'http');

/**
 * Re-read the authoritative state.
 *
 * The socket pushes deltas, and applying them here would mean reimplementing the
 * client's merge -- which is exactly the kind of second implementation this
 * project keeps refusing to grow. A smoke test may simply ask the server again.
 */
async function refresh() {
  const response = await fetch(`${httpBase}/api/state`);
  const body = await response.json();
  state = body.state;
  return state;
}

/** The server greets first; nothing is readable until we have answered. */
function greet() {
  return new Promise((resolve) => {
    greeted = resolve;
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        token,
        clientLabel: 'smoke',
      }),
    );
  });
}

function matches() {
  return Object.values(state.matches);
}

function finalOf(key) {
  const id = `${state.tournament.id}:rf10:${key.toLowerCase()}`;
  return state.matches[id];
}

async function play(match, scoreA, scoreB, field) {
  const ok = await send('match.assign', { matchId: match.id, fieldId: field });
  if (!ok.ok) throw new Error(`assign ${match.roundName}: ${ok.error}`);
  await pause();
  const started = await send('match.start', { matchId: match.id, fieldId: field });
  if (!started.ok) throw new Error(`start ${match.roundName}: ${started.error}`);
  await pause();
  await send('match.score', { matchId: match.id, fieldId: field, side: 'A', delta: scoreA });
  await pause();
  await send('match.score', { matchId: match.id, fieldId: field, side: 'B', delta: scoreB });
  await pause();
  const done = await send('match.finish', { matchId: match.id, fieldId: field, force: false });
  if (!done.ok) throw new Error(`finish ${match.roundName}: ${done.error}`);
  await pause();
}

/** Put a match on a field and start it, leaving the result open. */
async function start(match, field) {
  const ok = await send('match.assign', { matchId: match.id, fieldId: field });
  if (!ok.ok) throw new Error(`assign ${match.roundName}: ${ok.error}`);
  await pause();
  const started = await send('match.start', { matchId: match.id, fieldId: field });
  if (!started.ok) throw new Error(`start ${match.roundName}: ${started.error}`);
  await pause();
}

function name(id) {
  return state.participants[id]?.name ?? '?';
}

async function main() {
  await OPEN();
  const hello = await greet();
  if (hello.role !== 'admin') throw new Error(`expected an admin session, got ${hello.role}`);
  await send('device.identify', { label: 'smoke', kind: 'admin' });
  if (!state) throw new Error('no state after the greeting');

  const ten = state.radball?.ten;
  if (state.radball?.system !== 'radball-10-team') {
    throw new Error(
      `not a 10-team radball tournament (format=${state.tournament?.format} system=${state.radball?.system} matches=${matches().length})`,
    );
  }
  console.log(`system ......... ${state.radball.system}`);
  console.log(`stage .......... ${ten.stage}`);
  console.log(`matches ........ ${matches().length}`);

  // Preliminary round: Field 1 takes Group A, Field 2 takes Group B, alternating
  // the two so the run exercises the parallel path.
  const groups = state.radball.groupOrder.map((id) => state.radball.groups[id]);
  const queues = groups.map((group) => ({
    fieldId: group.fieldId,
    list: matches().filter((m) => m.radball?.groupId === group.id),
  }));
  console.log(
    `groups ......... ${groups.map((g) => `${g.name} on field ${g.fieldId}, ${g.teamIds.length} teams`).join(' | ')}`,
  );

  // §24: refused while a single preliminary fixture is outstanding.
  const probe = queues[0].list[0];
  await play(probe, 3, 1, queues[0].fieldId);
  const early = await send('radball.finalPhase', { confirm: true });
  if (early.ok) throw new Error('final phase was generated before the preliminary round finished');
  console.log(`locked early ... ${early.error}`);
  // Put that one back into the queue so the sweep below plays every fixture.
  const reset = await send('match.reset', { matchId: probe.id, fieldId: queues[0].fieldId });
  if (!reset.ok) throw new Error(`reset probe: ${reset.error}`);

  for (let round = 0; round < 10; round += 1) {
    for (const queue of queues) {
      const match = queue.list[round];
      if (!match) continue;
      // Deterministic, never level: the higher-indexed team always wins 3:1.
      await play(match, 3, 1, queue.fieldId);
    }
  }
  await refresh();
  console.log(`stage .......... ${state.radball.ten.stage}`);

  const order = state.radball.groupOrder
    .map((id, index) => {
      const ranking = state.radball.ten.rankings[id] ?? [];
      return `${index === 0 ? 'A' : 'B'}: ${ranking.map((teamId, place) => `${index === 0 ? 'A' : 'B'}${place + 1}=${name(teamId)}`).join(' ')}`;
    })
    .join('\n                ');
  console.log(`group positions  ${order}`);

  const generated = await send('radball.finalPhase', { confirm: true });
  if (!generated.ok) throw new Error(`generate: ${generated.error}`);
  await refresh();
  console.log(`final phase .... ${matches().length} matches total`);
  for (const key of ['PLACEMENT_9_10', 'PLACEMENT_7_8', 'PLACEMENT_5_6', 'SEMIFINAL_1', 'SEMIFINAL_2', 'THIRD_PLACE', 'FINAL']) {
    const match = finalOf(key);
    console.log(`  ${match.roundName.padEnd(16)} ${name(match.participantAId)} vs ${name(match.participantBId)}`);
  }

  // §25: reordering the queue must not unlock anything.
  const flipped = ['FINAL', 'SEMIFINAL_2', 'SEMIFINAL_1', 'THIRD_PLACE', 'PLACEMENT_5_6', 'PLACEMENT_7_8', 'PLACEMENT_9_10'];
  const reordered = await send('radball.finalOrder', { order: flipped });
  if (!reordered.ok) throw new Error(`reorder: ${reordered.error}`);

  // The placement matches only need the group tables, so they open immediately.
  await play(finalOf('PLACEMENT_9_10'), 4, 2, '1');
  await play(finalOf('PLACEMENT_7_8'), 4, 2, '2');
  await play(finalOf('PLACEMENT_5_6'), 4, 2, '1');
  await refresh();

  // Both semifinals side by side -- one per field, as the format intends.
  await start(finalOf('SEMIFINAL_1'), '1');
  await start(finalOf('SEMIFINAL_2'), '2');
  const finalsDuringSemis = finalOf('FINAL');
  const tooEarly = await send('match.start', {
    matchId: finalsDuringSemis.id,
    fieldId: '1',
    force: false,
  });
  if (tooEarly.ok) throw new Error('the final started before its semifinals');
  console.log(`dependency lock  ${tooEarly.error}`);

  for (const [index, key] of ['SEMIFINAL_1', 'SEMIFINAL_2'].entries()) {
    const match = finalOf(key);
    await send('match.score', { matchId: match.id, fieldId: index === 0 ? '1' : '2', side: 'A', delta: 4 });
    await pause();
    await send('match.score', { matchId: match.id, fieldId: index === 0 ? '1' : '2', side: 'B', delta: 2 });
    await pause();
    const done = await send('match.finish', { matchId: match.id, force: false });
    if (!done.ok) throw new Error(`finish ${match.roundName}: ${done.error}`);
    await pause();
  }
  await refresh();

  const bronze = finalOf('THIRD_PLACE');
  const finalMatch = finalOf('FINAL');
  console.log(`bronze pairing .. ${name(bronze.participantAId)} vs ${name(bronze.participantBId)}`);
  console.log(`final pairing ... ${name(finalMatch.participantAId)} vs ${name(finalMatch.participantBId)}`);

  await play(bronze, 4, 2, '2');
  await play(finalMatch, 4, 2, '1');
  await refresh();

  console.log(`stage .......... ${state.radball.ten.stage}`);
  console.log(`issues ......... ${JSON.stringify(state.radball.ten.issues)}`);
  console.log(`status ......... ${state.tournament.status}`);
  console.log('final ranking:');
  for (const entry of state.radball.ten.ranking) {
    console.log(`  ${String(entry.place).padStart(2)}. ${name(entry.teamId)}   (${entry.source})`);
  }
  const ids = state.radball.ten.ranking.map((entry) => entry.teamId);
  if (ids.some((id) => !id)) throw new Error('a place is unoccupied');
  if (new Set(ids).size !== 10) throw new Error('a team holds two places');
  if (state.tournament.status !== 'COMPLETED') throw new Error('the tournament was not completed');
  console.log('\nOK: ten places, one team each, tournament completed.');

  ws.close();
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  ws.close();
  process.exitCode = 1;
});