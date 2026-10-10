/**
 * Queue inspection for a running server.
 *
 * Prints, per field, exactly what the dashboard's queue panel would show -- by
 * calling the very selectors the panel calls, not a copy of them. A script that
 * re-implements the rules is how a queue bug survives a fix: the two drift and
 * the script keeps reporting the old, wrong answer.
 *
 *   node scripts/queue-check.mjs <http-url>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:39411';

const { fieldQueue, homeFieldOf, isOnField, isPlayable, openMatches, sharedQueue } = await import(
  '../dist/server/shared/matchUtils.js'
);

const response = await fetch(`${base}/api/state`);
const state = (await response.json()).state;

const label = (match) => {
  const name = (id) => (id ? (state.participants[id]?.name ?? id) : '—');
  return `${name(match.participantAId)} vs ${name(match.participantBId)}`;
};

console.log(
  `stage ${state.radball?.ten?.stage ?? '-'} · ${Object.keys(state.matches).length} matches · ${openMatches(state).length} open`,
);

let overlap = 0;
for (const fieldId of Object.keys(state.fields).sort()) {
  const own = fieldQueue(state, fieldId);
  const onField = own.filter((m) => isOnField(state, m, fieldId));
  const groups = new Set(own.filter((m) => m.radball?.groupId).map((m) => m.radball.groupId));
  console.log(
    `field ${fieldId} queue: ${own.length} own · ${onField.length} already on it · groups ${[...groups].join(', ') || '(none)'}`,
  );
  for (const match of own) {
    const where = isOnField(state, match, fieldId) ? 'ON FIELD' : 'queue';
    console.log(`    [${where}] ${match.roundName} · ${label(match)}`);
  }
}

const shared = sharedQueue(state);
console.log(`\nshared · either field queue: ${shared.length}`);
for (const match of shared) {
  console.log(`    ${match.roundName} · ${label(match)}`);
}

const waiting = openMatches(state).filter((m) => homeFieldOf(state, m) === null && isPlayable(m) === false);
console.log(`\nhidden: ${waiting.length} matches still missing a player`);

// The invariant the whole panel rests on: one match, one queue.
const seen = new Map();
for (const fieldId of Object.keys(state.fields)) {
  for (const match of fieldQueue(state, fieldId)) {
    seen.set(match.id, [...(seen.get(match.id) ?? []), fieldId]);
  }
}
for (const match of shared) {
  seen.set(match.id, [...(seen.get(match.id) ?? []), 'shared']);
}
const doubled = [...seen].filter(([, where]) => where.length > 1);
overlap = doubled.length;
console.log(`\nmatches listed in more than one queue: ${overlap}`);
for (const [id, where] of doubled) {
  console.log(`  ${state.matches[id]?.roundName} → ${where.join(' + ')}`);
}
if (state.radball?.groups) {
  const misplaced = openMatches(state).filter((m) => {
    const pinned = m.radball?.groupId && state.radball.groups[m.radball.groupId]?.fieldId;
    return pinned && homeFieldOf(state, m) !== pinned;
  });
  console.log(`group fixtures on the wrong field: ${misplaced.length}`);
  for (const match of misplaced) {
    console.log(`  ${match.roundName} → homeFieldOf=${String(homeFieldOf(state, match))}`);
  }
}