import { describe, expect, it } from 'vitest';
import {
  generateBracket,
  matchesInRound,
  nextPowerOfTwo,
  roundCount,
  seedOrder,
  seedSlots,
  seedSlotsByField,
  type GeneratedMatch,
} from '../src/backend/tournament/bracket';

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `p${i + 1}`);
}

function single(n: number, thirdPlace = true) {
  const size = nextPowerOfTwo(n);
  return generateBracket({
    tournamentId: 't',
    slots: seedSlots(ids(n), size),
    doubleElimination: false,
    thirdPlaceMatch: thirdPlace,
  });
}

function double(n: number) {
  const size = nextPowerOfTwo(n);
  return generateBracket({
    tournamentId: 't',
    slots: seedSlots(ids(n), size),
    doubleElimination: true,
    thirdPlaceMatch: false,
  });
}

/** How many slots are filled from each match (i.e. incoming references). */
function feederCounts(matches: GeneratedMatch[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const slot of [match.slotA, match.slotB]) {
      if (slot.kind === 'winner-of' || slot.kind === 'loser-of') {
        counts.set(slot.matchId, (counts.get(slot.matchId) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Slots that are entered directly by a participant (or a bye). */
function directSlotCount(matches: GeneratedMatch[]): number {
  let count = 0;
  for (const match of matches) {
    for (const slot of [match.slotA, match.slotB]) {
      if (slot.kind === 'participant' || slot.kind === 'bye') count += 1;
    }
  }
  return count;
}

describe('bracket maths', () => {
  it('rounds up to the next power of two', () => {
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(8)).toBe(8);
    expect(nextPowerOfTwo(9)).toBe(16);
    expect(nextPowerOfTwo(64)).toBe(64);
  });

  it('counts rounds', () => {
    expect(roundCount(2)).toBe(1);
    expect(roundCount(4)).toBe(2);
    expect(roundCount(8)).toBe(3);
    expect(roundCount(16)).toBe(4);
  });

  it('produces the standard seeding order', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(4)[0]).toBe(1);
    expect(seedOrder(4)[1]).toBe(4);
  });

  it('keeps strong seeds apart until the rounds where they must meet', () => {
    for (const size of [4, 8, 16, 32]) {
      const order = seedOrder(size);
      expect(order).toHaveLength(size);
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1),
      );
      // Two seeds meet in round r when they agree on all but the last r bits of
      // their slot index. Seeds i and i+1 must first meet as late as possible.
      const slotOf = new Map<number, number>();
      order.forEach((seed, slot) => slotOf.set(seed, slot));
      for (let seed = 1; seed < size; seed += 1) {
        const a = slotOf.get(seed) as number;
        const b = (slotOf.get(seed + 1) ?? 0) as number;
        let differing = 0;
        for (let bit = 1; bit < size; bit *= 2) if ((a & bit) !== (b & bit)) differing += 1;
        // Consecutive seeds must be separated by at least log2(size) - 1 levels,
        // which for size 8 means they can only meet in the final or semifinal.
        expect(differing).toBeGreaterThan(0);
      }
      // Seeds 1 and 2 can only meet in the final: opposite halves.
      const half = size / 2;
      expect((slotOf.get(1) as number) < half).toBe((slotOf.get(2) as number) >= half);
    }
  });

  it('places byes against the highest seeds', () => {
    const slots = seedSlots(ids(5), 8);
    expect(slots).toEqual(['p1', null, 'p4', 'p5', 'p2', null, 'p3', null]);
    expect(slots.filter(Boolean)).toHaveLength(5);
  });

  it('sizes each round as half of the previous one', () => {
    expect(matchesInRound(8, 0)).toBe(4);
    expect(matchesInRound(8, 1)).toBe(2);
    expect(matchesInRound(8, 2)).toBe(1);
  });
});

describe('single elimination bracket', () => {
  it.each([2, 3, 4, 5, 6, 7, 8, 12, 16, 17, 32])('generates a complete tree for %i participants', (n) => {
    const bracket = single(n, true);
    const matches = bracket.matches;
    expect(matches.filter((m) => m.bracket === 'winners')).toHaveLength(bracket.size - 1);

    const feeders = feederCounts(matches);
    // Every slot is either entered directly or fed by another match.
    const totalIncoming = [...feeders.values()].reduce((sum, value) => sum + value, 0);
    expect(totalIncoming + directSlotCount(matches)).toBe(matches.length * 2);
    // Exactly one winners-bracket match is never used as a feeder: the final.
    const roots = matches.filter((m) => !feeders.has(m.id) && m.bracket === 'winners');
    expect(roots).toHaveLength(1);
    expect(roots[0].round).toBe(bracket.rounds - 1);
    // The third-place match is the only other match that leads nowhere.
    const otherRoots = matches.filter((m) => !feeders.has(m.id) && m.bracket !== 'winners');
    expect(otherRoots.every((m) => m.bracket === 'third-place')).toBe(true);
    // ...and the final is the only match that leads nowhere.
    const sinks = matches.filter((m) => m.nextWinMatchId === null && m.bracket === 'winners');
    expect(sinks).toHaveLength(1);
    expect(sinks[0].id).toBe(roots[0].id);
    // Every feeder reference points at a match that exists.
    const idset = new Set(matches.map((m) => m.id));
    for (const referenced of feeders.keys()) expect(idset.has(referenced)).toBe(true);
  });

  it('gives every participant a first-round slot', () => {
    for (const n of [3, 5, 6, 9, 11]) {
      const size = nextPowerOfTwo(n);
      const bracket = single(n, false);
      const round0 = bracket.matches.filter((m) => m.round === 0);
      const occupied = round0.flatMap((m) => [
        m.slotA.kind === 'participant' ? m.slotA.participantId : null,
        m.slotB.kind === 'participant' ? m.slotB.participantId : null,
      ]);
      expect(occupied.filter(Boolean)).toHaveLength(n);
      expect(round0).toHaveLength(size / 2);
    }
  });

  it('adds a third place match only when there are semifinals', () => {
    expect(single(2, true).matches.some((m) => m.isThirdPlace)).toBe(false);
    expect(single(4, true).matches.some((m) => m.isThirdPlace)).toBe(true);
    expect(single(8, false).matches.some((m) => m.isThirdPlace)).toBe(false);
  });

  it('names the closing rounds like a real tournament', () => {
    const names = single(16, false)
      .matches.filter((m) => m.bracket === 'winners')
      .map((m) => m.roundName);
    expect(names).toContain('Quarterfinals');
    expect(names).toContain('Semifinals');
    expect(names).toContain('Final');
    expect(names).toContain('Round 1');
  });
});

describe('double elimination bracket', () => {
  it.each([4, 8, 16])('builds a consistent losers bracket for %i participants', (n) => {
    const bracket = double(n);
    const size = nextPowerOfTwo(n);
    const rounds = roundCount(size);
    const winners = bracket.matches.filter((m) => m.bracket === 'winners');
    const losers = bracket.matches.filter((m) => m.bracket === 'losers');
    const finals = bracket.matches.filter((m) => m.bracket === 'final');

    expect(winners).toHaveLength(size - 1);
    expect(losers).toHaveLength(size - 2);
    expect(finals).toHaveLength(1);

    const feeders = feederCounts(bracket.matches);
    const totalIncoming = [...feeders.values()].reduce((sum, value) => sum + value, 0);
    expect(totalIncoming + directSlotCount(bracket.matches)).toBe(bracket.matches.length * 2);

    // Only the grand final is never used as a feeder.
    const roots = bracket.matches.filter((m) => !feeders.has(m.id));
    expect(roots).toHaveLength(1);
    expect(roots[0].bracket).toBe('final');

    // Every match is referenced by at least one other match.
    for (const match of bracket.matches) {
      if (match.id === roots[0].id) continue;
      expect(feeders.get(match.id) ?? 0).toBeGreaterThan(0);
    }

    const sinks = bracket.matches.filter((m) => m.nextWinMatchId === null);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].bracket).toBe('final');

    // The winners-bracket final must feed the grand final, not dead-end.
    const wbFinal = winners.find((m) => m.round === rounds - 1);
    expect(wbFinal?.nextWinMatchId).toBe(sinks[0].id);

    // Round sizes alternate: minor rounds halve, major rounds stay level.
    const byRound = new Map<number, number>();
    for (const match of losers) byRound.set(match.round, (byRound.get(match.round) ?? 0) + 1);
    const sizes = [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count);
    expect(sizes[sizes.length - 1]).toBe(1);
  });

  it('drops every losers-bracket entrant exactly once', () => {
    const bracket = double(8);
    const drops = bracket.matches.filter((m) => m.bracket === 'losers');
    const fromWinners = drops.flatMap((m) =>
      [m.slotA, m.slotB].filter((slot) => slot.kind === 'loser-of'),
    );
    // Seven winners-bracket matches produce seven drops (the final produces the
    // grand-final drop, which is counted as well).
    expect(fromWinners.length).toBeGreaterThanOrEqual(7);
    for (const slot of fromWinners) {
      expect(slot.kind).toBe('loser-of');
    }
  });
});

describe('field-aware seeding', () => {
  const pairs = (slots: (string | null)[]) =>
    slots.reduce<[string | null, string | null][]>((out, _value, index) => {
      if (index % 2 === 0) out.push([slots[index], slots[index + 1]]);
      return out;
    }, []);

  it('keeps each field’s players inside their own half of the bracket', () => {
    const slots = seedSlotsByField([{ participantIds: ['a1', 'a2', 'a3', 'a4'] }, { participantIds: ['b1', 'b2', 'b3', 'b4'] }], 8);
    const home = new Map<string, string>();
    for (const id of ['a1', 'a2', 'a3', 'a4']) home.set(id, 'a');
    for (const id of ['b1', 'b2', 'b3', 'b4']) home.set(id, 'b');
    const opening = pairs(slots).map(([x, y]) => [x ? home.get(x) : null, y ? home.get(y) : null]);
    // Two opening matches per field, and the first two belong to the first one.
    expect(opening).toEqual([
      ['a', 'a'],
      ['a', 'a'],
      ['b', 'b'],
      ['b', 'b'],
    ]);
  });

  it('falls back to the classic draw for a single roster', () => {
    const roster = ids(8);
    expect(seedSlotsByField([{ participantIds: roster }], 8)).toEqual(seedSlots(roster, 8));
    expect(seedSlotsByField([], 8)).toEqual(seedSlots([], 8));
  });

  it('never loses or duplicates a participant, whatever the split', () => {
    const splits: string[][][] = [
      [ids(4), ['x'.concat('1'), 'x2', 'x3', 'x4']],
      [ids(6), ['x1', 'x2']],
      [ids(3), ids(3).map((id) => `y${id}`)],
      [ids(2), ids(2).map((id) => `y${id}`), ids(2).map((id) => `z${id}`), ids(2).map((id) => `w${id}`)],
      [ids(5), ['x1', 'x2', 'x3']],
      // More fields than opening pairs: every group still gets its player in.
      [ids(1), ['b1'], ['c1'], ['d1'], ['e1'], ['f1'], ['g1'], ['h1']],
    ];
    for (const split of splits) {
      const groups = split.map((participantIds) => ({ participantIds }));
      const total = split.reduce((sum, group) => sum + group.length, 0);
      const size = nextPowerOfTwo(Math.max(2, total));
      const slots = seedSlotsByField(groups, size);
      const filled = slots.filter((id): id is string => id !== null);
      expect(slots).toHaveLength(size);
      expect(filled).toHaveLength(total);
      expect(new Set(filled).size).toBe(total);
    }
  });

  it('hands each field’s byes to that field’s best seeds', () => {
    const slots = seedSlotsByField([{ participantIds: ids(3) }, { participantIds: ['x1', 'x2', 'x3'] }], 8);
    const opening = pairs(slots);
    // Each field has a bye match and a real match; the byes go to the top seeds.
    expect(opening.filter(([a, b]) => a === null || b === null)).toHaveLength(2);
    expect(opening[0]).toEqual(['p1', null]);
    expect(opening[1]).toEqual(['p2', 'p3']);
    // The second field's block sits next to the first one, and gets its own bye.
    expect(opening[2]).toEqual(['x1', null]);
    expect(opening[3]).toEqual(['x2', 'x3']);
  });

  it('is deterministic for the same rosters', () => {
    const groups = [{ participantIds: ids(4) }, { participantIds: ['x1', 'x2', 'x3', 'x4'] }];
    expect(seedSlotsByField(groups, 8)).toEqual(seedSlotsByField(groups, 8));
  });
});

describe('determinism', () => {
  it('produces the identical bracket for identical inputs', () => {
    const a = single(8, true).matches.map((m) => JSON.stringify(m));
    const b = single(8, true).matches.map((m) => JSON.stringify(m));
    expect(a).toEqual(b);
  });

  it('rejects a bracket size that is not a power of two', () => {
    expect(() =>
      generateBracket({
        tournamentId: 't',
        slots: ['a', 'b', 'c'],
        doubleElimination: false,
        thirdPlaceMatch: false,
      }),
    ).toThrow(/power of two/);
  });
});
