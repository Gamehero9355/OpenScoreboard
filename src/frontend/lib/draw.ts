/**
 * Manual-draw dealing helpers (pure, no React).
 *
 * Slots are paired into opening matches (0,1), (2,3), … Dealing one field's
 * roster always prefers whole matches: full pairs first, a leftover single
 * takes an empty pair alone (bye partner) instead of sharing a match with
 * another field. Only when the blocks mathematically cannot fit does the
 * remainder spill into the first free slots in order.
 */

/**
 * Reconcile manual bracket slots with the current roster: resize to `size`
 * and drop placements whose participant no longer exists (renamed, moved or
 * deleted mid-draw). A stale key left in a slot picker would render without
 * a matching option, showing the wrong name. Returns a new array.
 */
export function reconcileSlots(
  previous: (string | null)[],
  size: number,
  validKeys: Set<string>,
): (string | null)[] {
  const next: (string | null)[] = [];
  for (let i = 0; i < size; i += 1) {
    const kept = previous[i] ?? null;
    next.push(kept !== null && validKeys.has(kept) ? kept : null);
  }
  return next;
}

/** Fisher–Yates shuffle that returns a new array. */
export function shuffleKeys(keys: string[]): string[] {
  const out = [...keys];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Deal `keysInOrder` into whole opening-match pairs of `slots`.
 *
 * Slots currently holding any of the dealt keys are freed first, so a field
 * can be re-dealt without touching other fields. Returns a new array.
 */
export function dealKeysIntoPairs(
  slots: (string | null)[],
  keysInOrder: string[],
): (string | null)[] {
  const next = [...slots];
  const roster = new Set(keysInOrder);
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== null && roster.has(next[index] as string)) next[index] = null;
  }
  const pairs: [number, number][] = [];
  for (let s = 0; s + 1 < next.length; s += 2) pairs.push([s, s + 1]);

  const queue = [...keysInOrder];
  // Whole pairs first.
  for (const [a, b] of pairs) {
    if (queue.length < 2) break;
    if (next[a] === null && next[b] === null) {
      const first = queue.shift();
      const second = queue.shift();
      if (first === undefined || second === undefined) break;
      next[a] = first;
      next[b] = second;
    }
  }
  // A leftover single prefers an empty pair (bye partner) over sharing.
  if (queue.length === 1) {
    const emptyPair = pairs.find(([a, b]) => next[a] === null && next[b] === null);
    if (emptyPair) {
      const single = queue.shift();
      if (single !== undefined) next[emptyPair[0]] = single;
    }
  }
  // Overflow (only when blocks cannot fit): first free slots in order.
  for (let index = 0; index < next.length && queue.length > 0; index += 1) {
    if (next[index] === null) {
      const key = queue.shift();
      if (key !== undefined) next[index] = key;
    }
  }
  return next;
}
