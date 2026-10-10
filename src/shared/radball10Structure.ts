/**
 * The World Cup structure -- declared once, generated from the team count, shared
 * by everyone.
 *
 * This is the format. The engine builds its final-phase matches from it, the UI
 * labels its rows from it and the documentation page prints it, so the page a
 * host reads and the matches that actually get played cannot drift apart: there
 * is only one builder, and all three read it.
 *
 * It lives in `shared/` rather than in the engine because the engine is not the
 * only thing that has to know it. A bracket drawer that hard-codes "A1 vs B2"
 * would be a second, silent copy of the rules -- exactly the failure mode the
 * dependency references exist to prevent.
 *
 * `key` is the identity and `matchType` the label. They are not the same: there
 * are two semifinals and both are typed `SEMIFINAL`, so anything keyed on the
 * type alone would give them one id and one queue slot.
 *
 * ## The shape, and why it scales
 *
 * The ten-team format is the smallest case of a rule that does not actually
 * mention ten:
 *
 *   - Two groups, one per playing field, so both play at once.
 *   - Each group is a single round robin. Every position is decided by a result.
 *   - Ranks 1 and 2 of each group enter the semifinals (A1 v B2, B1 v A2).
 *     Four teams reach the final and the third-place match, which decides places
 *     1-4.
 *   - Every *other* pair of positions meets in a placement match: A3 v B3 decides
 *     5th/6th, A4 v B4 decides 7th/8th, and so on up the table.
 *
 * So for two groups of N there are always exactly four knockout matches and
 * N-2 placement matches, and every one of the 2N places is decided by a match
 * somebody played. N=5 gives the documented ten-team World Cup: three placement
 * matches, two semifinals, the third-place match and the final -- seven. N=6
 * gives twelve teams: four placement matches, the same four knockout matches,
 * eleven in all. The shape is identical; only the tail lengthens.
 *
 * `placementKey` and `radballFinalKeys` are therefore *functions* of N, and the
 * module keeps the ten-team array as a named specialisation for the preset that
 * ships with it.
 */
import type { RadballDependency, RadballFinalKey, RadballMatchType } from './types';
import { ordinal } from './matchUtils';

/** One dependency endpoint: a group position, or a semifinal's winner/loser. */
export type Radball10SlotSpec =
  | { source: 'GROUP_A'; rank: number }
  | { source: 'GROUP_B'; rank: number }
  | { source: 'SEMIFINAL'; number: 1 | 2; place: 'winner' | 'loser' };

export interface Radball10StructureEntry {
  /** Unique identity: two semifinals share a match type but never a key. */
  key: RadballFinalKey;
  matchType: RadballMatchType;
  roundName: string;
  /** The places this match hands out, or null when it feeds another match. */
  places: [number, number] | null;
  slots: [Radball10SlotSpec, Radball10SlotSpec];
  dependsOn: RadballDependency;
}

/** The smallest group this structure is defined for: two, so rank 2 exists. */
export const RADBALL_MIN_GROUP_SIZE = 2;
/** The documented World Cup shape. */
export const RADBALL_WORLD_CUP_GROUP_SIZE = 5;

/** `5 -> 'PLACEMENT_5_6'`. The pair is a place label, so it is derived from N. */
export function placementKey(better: number, worse: number): RadballFinalKey {
  return `PLACEMENT_${better}_${worse}`;
}

/** The placement match types, ascending: `PLACEMENT_5_6`, `PLACEMENT_7_8`, ... */
export function placementMatchTypes(groupSize: number): RadballMatchType[] {
  const out: RadballMatchType[] = [];
  for (let rank = 3; rank <= groupSize; rank += 1) {
    out.push(placementMatchType(rank));
  }
  return out;
}

function placementMatchType(rank: number): RadballMatchType {
  return placementKey(2 * rank - 1, 2 * rank) as RadballMatchType;
}

/**
 * Every final-phase key in the recommended playing order.
 *
 * Placement matches first (lowest place upward, so the tail of the table clears
 * before the semifinals), then the semifinals, then the two matches that need
 * both of them. The order is advice; the dependencies are not (see
 * `assertFinalPhaseDependency`).
 */
export function radballFinalKeys(groupSize: number): RadballFinalKey[] {
  return [...placementKeys(groupSize), 'SEMIFINAL_1', 'SEMIFINAL_2', 'THIRD_PLACE', 'FINAL'];
}

/** Just the placement keys, ascending by the place they hand out. */
export function placementKeys(groupSize: number): RadballFinalKey[] {
  const out: RadballFinalKey[] = [];
  for (let rank = groupSize; rank >= 3; rank -= 1) {
    out.push(placementKey(2 * rank - 1, 2 * rank));
  }
  return out;
}

/**
 * The final phase for two groups of `groupSize`, in the recommended order.
 *
 * Placement matches are emitted from the *bottom* of the table upward (the 9th/10th
 * match before the 5th/6th one), which is the order a hall can actually run: those
 * matches need only the group tables, so they can be played while the semifinal
 * positions are still being fought out over on the other side.
 */
export function radball10FinalStructure(groupSize: number): Radball10StructureEntry[] {
  if (groupSize < RADBALL_MIN_GROUP_SIZE) {
    throw new Error(`A World Cup group needs at least ${RADBALL_MIN_GROUP_SIZE} teams; got ${groupSize}.`);
  }

  const placement: Radball10StructureEntry[] = [];
  for (let rank = groupSize; rank >= 3; rank -= 1) {
    const better = 2 * rank - 1;
    const worse = 2 * rank;
    placement.push({
      key: placementKey(better, worse),
      matchType: placementMatchType(rank),
      roundName: `${ordinal(better)} / ${ordinal(worse)} place`,
      places: [better, worse],
      // A_r against B_r. The mirrored pair (A_r v B_r either way round) is the
      // documented shape, and the winner takes the better place because
      // `places` is ordered better-first.
      slots: [{ source: 'GROUP_A', rank }, { source: 'GROUP_B', rank }],
      dependsOn: 'group-complete',
    });
  }

  return [
    ...placement,
    {
      key: 'SEMIFINAL_1',
      matchType: 'SEMIFINAL',
      roundName: 'Semifinal 1',
      places: null,
      slots: [{ source: 'GROUP_A', rank: 1 }, { source: 'GROUP_B', rank: 2 }],
      // Both semifinals hang off the group tables only -- they can be played in any
      // order, or at the same time on the two fields. Only the final and the
      // third-place match need *both* of them.
      dependsOn: 'group-complete',
    },
    {
      key: 'SEMIFINAL_2',
      matchType: 'SEMIFINAL',
      roundName: 'Semifinal 2',
      places: null,
      slots: [{ source: 'GROUP_B', rank: 1 }, { source: 'GROUP_A', rank: 2 }],
      dependsOn: 'group-complete',
    },
    {
      key: 'THIRD_PLACE',
      matchType: 'THIRD_PLACE',
      roundName: '3rd / 4th place',
      places: [3, 4],
      slots: [
        { source: 'SEMIFINAL', number: 1, place: 'loser' },
        { source: 'SEMIFINAL', number: 2, place: 'loser' },
      ],
      dependsOn: 'semifinals-complete',
    },
    {
      key: 'FINAL',
      matchType: 'FINAL',
      roundName: 'Radball Final',
      places: [1, 2],
      slots: [
        { source: 'SEMIFINAL', number: 1, place: 'winner' },
        { source: 'SEMIFINAL', number: 2, place: 'winner' },
      ],
      dependsOn: 'semifinals-complete',
    },
  ];
}

/**
 * The documented ten-team World Cup: two groups of five.
 *
 * A named specialisation rather than the general rule, because the preset, the
 * demo, the built-in example and the tests all mean *this* competition when they
 * name it. Read it as `radball10FinalStructure(5)`, which it is.
 */
export const RADBALL10_FINAL_STRUCTURE: Radball10StructureEntry[] =
  radball10FinalStructure(RADBALL_WORLD_CUP_GROUP_SIZE);
