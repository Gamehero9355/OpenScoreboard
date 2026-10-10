/**
 * Bracket engine -- pure functions, no I/O, no clock, no randomness unless a
 * seed is supplied. Given the same inputs it always produces the same bracket,
 * which is what makes "the bracket must not regenerate on reload" work.
 */
import type { BracketSide, SlotSource } from '../../shared/types';

export interface GeneratedMatch {
  id: string;
  round: number;
  roundName: string;
  position: number;
  bracketSlot: number;
  bracket: BracketSide;
  isThirdPlace: boolean;
  isGrandFinal: boolean;
  slotA: SlotSource;
  slotB: SlotSource;
  nextWinMatchId: string | null;
  nextWinSlot: 'A' | 'B' | null;
  nextLoseMatchId: string | null;
  nextLoseSlot: 'A' | 'B' | null;
}

export interface GenerateOptions {
  tournamentId: string;
  /** Ordered participant ids. Index 0 is the highest seed. `null` = bye. */
  slots: (string | null)[];
  doubleElimination: boolean;
  thirdPlaceMatch: boolean;
}

export interface GeneratedBracket {
  matches: GeneratedMatch[];
  size: number;
  rounds: number;
  /** Queue order: playable order, earliest rounds first. */
  order: string[];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

export function roundCount(size: number): number {
  let rounds = 0;
  let s = size;
  while (s > 1) {
    s /= 2;
    rounds += 1;
  }
  return Math.max(1, rounds);
}

export function matchesInRound(size: number, round: number): number {
  return Math.max(1, size / 2 ** (round + 1));
}

/**
 * Standard bracket seeding order. For size 8 this yields
 * [1, 8, 5, 4, 3, 6, 7, 2] so seed 1 and seed 2 can only meet in the final.
 */
export function seedOrder(size: number): number[] {
  const rounds = roundCount(size);
  let order = [1];
  for (let r = 0; r < rounds; r += 1) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed);
      next.push(sum - seed);
    }
    order = next;
  }
  return order;
}

/**
 * Map a list of participants (highest seed first) onto bracket slots using
 * standard seeding. Empty slot numbers become `null` (a bye).
 */
export function seedSlots(participantIds: string[], size: number): (string | null)[] {
  const order = seedOrder(size);
  const slots: (string | null)[] = order.map((seedNumber) => {
    // `seedOrder` yields 1..size and the length test keeps the index in range,
    // so this is never undefined -- the map just cannot prove it.
    if (seedNumber > participantIds.length) return null;
    return participantIds[seedNumber - 1] ?? null;
  });
  return slots;
}

/** One playing field's roster, already in seeding order (best first). */
export interface SeedGroup {
  participantIds: string[];
}

/**
 * Standard seeding, but each playing field's players stay in their own block of
 * the bracket.
 *
 * A field's players open against each other and can only meet the other field's
 * players later in the tree, which is what makes "this match belongs to Field 1"
 * true for a roster that was entered per field. Blocks are whole opening pairs
 * and allocated in proportion to the roster size, so byes land inside a field's
 * own block and are handed to that field's best seeds.
 *
 * Anything that does not fit its block (an uneven split, or a field-less roster
 * bigger than the rest) spills into the free slots in order, which turns that
 * pairing into a match either field may host. Fewer than two non-empty groups --
 * the classic single-roster tournament -- returns the plain seeded draw.
 */
export function seedSlotsByField(groups: SeedGroup[], size: number): (string | null)[] {
  const nonEmpty = groups.filter((group) => group.participantIds.length > 0);
  if (nonEmpty.length < 2) {
    return seedSlots(nonEmpty[0]?.participantIds ?? [], size);
  }

  const pairsTotal = size / 2;
  const totalPlayers = nonEmpty.reduce((sum, group) => sum + group.participantIds.length, 0);
  const share = nonEmpty.map((group) => (group.participantIds.length / totalPlayers) * pairsTotal);
  // At least one opening match per field, then hand out what is left over.
  const quotas = share.map((value) => Math.min(Math.max(1, Math.floor(value)), Math.max(1, pairsTotal)));
  let assigned = quotas.reduce((sum, value) => sum + value, 0);
  let guard = 0;
  while (assigned !== pairsTotal && guard < 512) {
    guard += 1;
    const order = share
      .map((value, index) => ({ index, fraction: value - (quotas[index] ?? 0) }))
      .sort((a, b) => b.fraction - a.fraction);
    let moved = false;
    for (const { index } of order) {
      // `index` came from `quotas.map`, so the slot exists for the whole loop.
      const quota = quotas[index];
      if (quota === undefined) continue;
      if (assigned < pairsTotal) {
        quotas[index] = quota + 1;
        assigned += 1;
        moved = true;
        if (assigned === pairsTotal) break;
      } else if (quota > 1) {
        quotas[index] = quota - 1;
        assigned -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const slots: (string | null)[] = [];
  const spill: string[] = [];
  nonEmpty.forEach((group, index) => {
    const pairsLeft = Math.max(0, pairsTotal - slots.length / 2);
    const blockPairs = Math.min(quotas[index] ?? 1, pairsLeft);
    const miniSize = Math.max(2, nextPowerOfTwo(group.participantIds.length));
    const placed = new Set<string>();
    for (const seedNumber of seedOrder(miniSize).slice(0, blockPairs * 2)) {
      if (seedNumber > group.participantIds.length) {
        slots.push(null);
        continue;
      }
      const id = group.participantIds[seedNumber - 1];
      // Guarded by the length check above, so the id is present.
      if (id === undefined) continue;
      slots.push(id);
      placed.add(id);
    }
    for (const id of group.participantIds) if (!placed.has(id)) spill.push(id);
  });

  // Whatever did not fit its own block takes the first free slot; those pairings
  // mix two fields and can be played on either one.
  for (const id of spill) {
    const hole = slots.indexOf(null);
    if (hole === -1) slots.push(id);
    else slots[hole] = id;
  }
  while (slots.length < size) slots.push(null);
  return slots.slice(0, size);
}

function nameForRound(round: number, totalRounds: number, bracket: BracketSide): string {
  if (bracket === 'third-place') return '3rd Place Match';
  if (bracket === 'final') return 'Grand Final';
  if (bracket === 'reset') return 'Grand Final Reset';
  if (bracket === 'losers') return `Losers Round ${round + 1}`;
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${round + 1}`;
}

function bye(): SlotSource {
  return { kind: 'bye' };
}
function fromParticipant(participantId: string): SlotSource {
  return { kind: 'participant', participantId };
}
function winnerOf(matchId: string): SlotSource {
  return { kind: 'winner-of', matchId };
}
function loserOf(matchId: string): SlotSource {
  return { kind: 'loser-of', matchId };
}

/* ------------------------------------------------------------------ */
/* Generators                                                         */
/* ------------------------------------------------------------------ */

function winnersMatchId(tournamentId: string, round: number, position: number): string {
  return `${tournamentId}:w${round}:${position}`;
}
function losersMatchId(tournamentId: string, round: number, position: number): string {
  return `${tournamentId}:l${round}:${position}`;
}

function generateSingleElimination(opts: GenerateOptions, size: number, rounds: number): GeneratedMatch[] {
  const { tournamentId, slots, thirdPlaceMatch } = opts;
  const matches: GeneratedMatch[] = [];

  for (let round = 0; round < rounds; round += 1) {
    const count = matchesInRound(size, round);
    for (let position = 0; position < count; position += 1) {
      const id = winnersMatchId(tournamentId, round, position);
      let slotA: SlotSource;
      let slotB: SlotSource;
      if (round === 0) {
        slotA = slots[position * 2] ? fromParticipant(slots[position * 2] as string) : bye();
        slotB = slots[position * 2 + 1] ? fromParticipant(slots[position * 2 + 1] as string) : bye();
      } else {
        slotA = winnerOf(winnersMatchId(tournamentId, round - 1, position * 2));
        slotB = winnerOf(winnersMatchId(tournamentId, round - 1, position * 2 + 1));
      }
      const isLast = round === rounds - 1;
      matches.push({
        id,
        round,
        roundName: nameForRound(round, rounds, 'winners'),
        position,
        bracketSlot: position,
        bracket: 'winners',
        isThirdPlace: false,
        isGrandFinal: false,
        slotA,
        slotB,
        nextWinMatchId: isLast ? null : winnersMatchId(tournamentId, round + 1, Math.floor(position / 2)),
        nextWinSlot: isLast ? null : position % 2 === 0 ? 'A' : 'B',
        nextLoseMatchId: null,
        nextLoseSlot: null,
      });
    }
  }

  if (thirdPlaceMatch && rounds >= 2) {
    const semiRound = rounds - 2;
    const semiCount = matchesInRound(size, semiRound);
    if (semiCount >= 2) {
      matches.push({
        id: `${tournamentId}:third`,
        round: rounds - 1,
        roundName: '3rd Place Match',
        position: 1,
        bracketSlot: 1,
        bracket: 'third-place',
        isThirdPlace: true,
        isGrandFinal: false,
        slotA: loserOf(winnersMatchId(tournamentId, semiRound, 0)),
        slotB: loserOf(winnersMatchId(tournamentId, semiRound, 1)),
        nextWinMatchId: null,
        nextWinSlot: null,
        nextLoseMatchId: null,
        nextLoseSlot: null,
      });
    }
  }

  return matches;
}

function generateDoubleElimination(opts: GenerateOptions, size: number, rounds: number): GeneratedMatch[] {
  const { tournamentId, slots } = opts;
  const matches: GeneratedMatch[] = [];
  const lbRoundCount = Math.max(0, (rounds - 1) * 2);
  const hasGrandFinal = lbRoundCount > 0;
  const grandFinalId = hasGrandFinal ? `${tournamentId}:grand-final` : null;

  /* --- Winners bracket ------------------------------------------- */
  for (let round = 0; round < rounds; round += 1) {
    const count = matchesInRound(size, round);
    for (let position = 0; position < count; position += 1) {
      const id = winnersMatchId(tournamentId, round, position);
      const isLast = round === rounds - 1;
      const slotA = round === 0
        ? slots[position * 2] ? fromParticipant(slots[position * 2] as string) : bye()
        : winnerOf(winnersMatchId(tournamentId, round - 1, position * 2));
      const slotB = round === 0
        ? slots[position * 2 + 1] ? fromParticipant(slots[position * 2 + 1] as string) : bye()
        : winnerOf(winnersMatchId(tournamentId, round - 1, position * 2 + 1));
      matches.push({
        id,
        round,
        roundName: nameForRound(round, rounds, 'winners'),
        position,
        bracketSlot: position,
        bracket: 'winners',
        isThirdPlace: false,
        isGrandFinal: false,
        slotA,
        slotB,
        nextWinMatchId: isLast
          ? grandFinalId
          : winnersMatchId(tournamentId, round + 1, Math.floor(position / 2)),
        nextWinSlot: isLast ? (grandFinalId ? 'A' : null) : position % 2 === 0 ? 'A' : 'B',
        nextLoseMatchId: null,
        nextLoseSlot: null,
      });
    }
  }

  /* --- Losers bracket -------------------------------------------- */
  // Odd ("minor") rounds only pair survivors of the previous losers round,
  // even ("major") rounds also absorb the losers dropping out of winners
  // round j = ceil(k/2).

  // Wire the losers bracket: minor rounds feed from the previous losers round,
  // major rounds feed from the previous losers round *and* a winners round.
  for (let k = 1; k <= lbRoundCount; k += 1) {
    const j = Math.ceil(k / 2);
    const count = Math.max(1, size / 2 ** (j + 1));
    const isMajor = k % 2 === 0;
    for (let position = 0; position < count; position += 1) {
      const id = losersMatchId(tournamentId, k - 1, position);
      let slotA: SlotSource;
      let slotB: SlotSource;
      if (k === 1) {
        slotA = loserOf(winnersMatchId(tournamentId, 0, position * 2));
        slotB = loserOf(winnersMatchId(tournamentId, 0, position * 2 + 1));
      } else if (isMajor) {
        // Losers-bracket survivor meets a fresh loser dropping from the
        // winners bracket. The WB loser list is reversed to avoid instant
        // rematches of the previous winners round.
        const wbRound = Math.min(j, rounds - 1);
        const wbCount = matchesInRound(size, wbRound);
        const reversed = wbCount - 1 - position;
        slotA = winnerOf(losersMatchId(tournamentId, k - 2, position));
        slotB = loserOf(winnersMatchId(tournamentId, wbRound, reversed));
      } else {
        slotA = winnerOf(losersMatchId(tournamentId, k - 2, position * 2));
        slotB = winnerOf(losersMatchId(tournamentId, k - 2, position * 2 + 1));
      }
      const isLastLb = k === lbRoundCount;
      const nextLbRound = k; // 0-based index of the next losers round
      const nextLbCount = Math.max(1, size / 2 ** (Math.ceil((k + 1) / 2) + 1));
      // The next round is "major" when k is odd; those pair position-to-position
      // into slot A, while minor rounds pair neighbours into A/B.
      const nextIsMajor = k % 2 === 1;
      const nextPosition = isLastLb
        ? 0
        : nextIsMajor
          ? Math.min(position, nextLbCount - 1)
          : Math.min(Math.floor(position / 2), nextLbCount - 1);
      matches.push({
        id,
        round: k - 1,
        roundName: nameForRound(k - 1, rounds, 'losers'),
        position,
        bracketSlot: position,
        bracket: 'losers',
        isThirdPlace: false,
        isGrandFinal: false,
        slotA,
        slotB,
        nextWinMatchId: isLastLb
          ? grandFinalId
          : losersMatchId(tournamentId, nextLbRound, nextPosition),
        nextWinSlot: isLastLb ? (grandFinalId ? 'B' : null) : nextIsMajor ? 'A' : position % 2 === 0 ? 'A' : 'B',
        nextLoseMatchId: null,
        nextLoseSlot: null,
      });
    }
  }

  /* --- Grand final ------------------------------------------------ */
  if (grandFinalId) {
    const wbFinal = winnersMatchId(tournamentId, rounds - 1, 0);
    const lbFinal = losersMatchId(tournamentId, lbRoundCount - 1, 0);
    matches.push({
      id: grandFinalId,
      round: rounds,
      roundName: 'Grand Final',
      position: 0,
      bracketSlot: 0,
      bracket: 'final',
      isThirdPlace: false,
      isGrandFinal: true,
      slotA: winnerOf(wbFinal),
      slotB: winnerOf(lbFinal),
      nextWinMatchId: null,
      nextWinSlot: null,
      nextLoseMatchId: null,
      nextLoseSlot: null,
    });
  }

  return matches;
}

/**
 * Build the full bracket. `slots` is the already-seeded list of participant ids
 * (null = bye) whose length is a power of two.
 */
export function generateBracket(opts: GenerateOptions): GeneratedBracket {
  const size = opts.slots.length;
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error(`Bracket size must be a power of two >= 2 (got ${size})`);
  }
  const rounds = roundCount(size);
  const matches = opts.doubleElimination
    ? generateDoubleElimination(opts, size, rounds)
    : generateSingleElimination(opts, size, rounds);

  // Order playable rounds sensibly: winners rounds 1..n, then the losers
  // bracket and the finals. The queue logic only ever considers matches whose
  // participants are resolved, so a naive order is safe.
  const rank = (m: GeneratedMatch): number => {
    if (m.bracket === 'winners') return m.round * 2;
    if (m.bracket === 'losers') return m.round * 2 + 1 + rounds * 2;
    return rounds * 6 + m.round;
  };
  const order = [...matches]
    .sort((a, b) => (rank(a) - rank(b)) || (a.position - b.position))
    .map((m) => m.id);

  return { matches, size, rounds, order };
}

/* ------------------------------------------------------------------ */
/* Manual schedule                                                     */
/* ------------------------------------------------------------------ */

/** One fixture as the engine receives it: two teams, a label, maybe a field. */
export interface ManualFixture {
  participantAId: string;
  participantBId: string;
  roundName: string;
  /** Pinned playing field, or null/absent to let the host assign it later. */
  fieldId?: string | null;
}

/** Stable, human-readable ids -- `…:m0`, `…:m1` -- in the host's own order. */
export function manualMatchId(tournamentId: string, index: number): string {
  return `${tournamentId}:m${index}`;
}

/**
 * Turn a hand-written fixture list into matches.
 *
 * The one piece of structure this adds is the round numbering, and it is
 * structure the host asked for rather than structure imposed on them: two
 * fixtures that share a label are one round, and the first label seen owns the
 * first round number. That is what makes "Group stage, Group stage, Semifinals,
 * Final" read as three rounds on the board instead of four unrelated matches,
 * while still letting every fixture be whatever pairing the host chose.
 *
 * There is no size constraint and no power-of-two rule. A manual schedule of
 * three matches is as valid as one of three hundred.
 */
export function generateManualSchedule(
  tournamentId: string,
  fixtures: ManualFixture[],
): GeneratedMatch[] {
  /** Label -> round number, in the order the labels first appear. */
  const roundOf = new Map<string, number>();
  /** Round number -> how many fixtures already sit in it. */
  const inRound: number[] = [];

  return fixtures.map((fixture, index) => {
    const label = fixture.roundName.trim() || `Match ${index + 1}`;
    let round = roundOf.get(label);
    if (round === undefined) {
      round = roundOf.size;
      roundOf.set(label, round);
      inRound.push(0);
    }
    const position = inRound[round] ?? 0;
    inRound[round] = position + 1;
    return {
      id: manualMatchId(tournamentId, index),
      round,
      roundName: label,
      position,
      bracketSlot: position,
      bracket: 'winners',
      isThirdPlace: false,
      isGrandFinal: false,
      // Both sides are known from the start, which is the whole difference
      // between this format and a bracket: nothing feeds anything.
      slotA: fromParticipant(fixture.participantAId),
      slotB: fromParticipant(fixture.participantBId),
      nextWinMatchId: null,
      nextWinSlot: null,
      nextLoseMatchId: null,
      nextLoseSlot: null,
    };
  });
}

/** True when a slot can never be filled -- used to auto-advance byes. */
export function isByeSource(source: SlotSource): boolean {
  return source.kind === 'bye';
}
