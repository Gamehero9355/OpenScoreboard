/**
 * The 10-team Radball format (UCI World Cup shape).
 *
 *   10 teams -> 2 groups of 5 -> round robin -> cross-group final phase -> places 1-10
 *
 * This module is the engine; the bracket UI only draws what it computes. The
 * dependency chain is one direction and it is the *only* way information moves:
 *
 *   group results -> group tables -> group rankings (A1-A5 / B1-B5)
 *                  -> final-phase matches -> winners/losers -> places 1-10
 *
 * Nothing is ever copied forward. A final-phase match names the *position* it
 * feeds from (`group-rank`), not a team, and a place names the *match* that
 * decided it, not a name. Correct a group fixture and every dependent match
 * re-derives itself; there is no stale bracket to keep in sync because there is
 * no bracket state to keep.
 *
 * It is a separate format rather than a flavour of the free-form Radball
 * competition, because none of this makes sense for a league with three groups of
 * four: the field pinning, the fixed cross-group pairings and the 1-10 assignment
 * are all defined *by* the ten-team shape. Everything it needs from the generic
 * engine -- 3/1/0 tables, the tie-break cascade, the 4-meter shootout, the
 * two-field double-booking guard -- it calls instead of reimplementing.
 */
import type {
  FieldId,
  Match,
  Radball10Stage,
  RadballCompetition,
  RadballFinalKey,
  RadballFinalPlacement,
  RadballGroup,
  RadballMatchMeta,
  RadballMatchType,
  SlotSource,
  StandingRow,
  TournamentState,
} from '../../shared/types';
import {
  RADBALL_FINAL_KEYS,
  RADBALL_10TEAM_RULESET_VERSION,
  defaultRadballConfig,
  radballMatchSec,
} from '../../shared/types';
import {
  RADBALL10_FINAL_STRUCTURE,
  RADBALL_MIN_GROUP_SIZE,
  radball10FinalStructure,
  radballFinalKeys,
  placementKeys,
  type Radball10SlotSpec,
  type Radball10StructureEntry,
} from '../../shared/radball10Structure';
import { EngineError } from '../util/errors';
import { groupComplete, rankedGroupTable, roundRobinFixtures } from './radball';
import { resolveBracket } from './resolve';
import {
  type Ctx,
  type Mutation,
  createTimerState,
  notify,
  participantName,
  pushEvent,
  touchMatch,
} from './state';

/* ------------------------------------------------------------------ */
/* The structure, declared once                                        */
/* ------------------------------------------------------------------ */

export const RADBALL10_TEAM_COUNT = 10;
export const RADBALL10_GROUP_COUNT = 2;
export const RADBALL10_GROUP_SIZE = 5;
/** Every team meets every other team in its group once: 5 * 4 / 2. */
export const RADBALL10_GROUP_MATCHES = 10;
export const RADBALL10_PRELIMINARY_MATCHES = RADBALL10_GROUP_MATCHES * RADBALL10_GROUP_COUNT;
/**
 * The final phase: three placement matches, two semifinals, the third-place
 * match and the final. Seven, not six -- the two semifinals are the part that is
 * easy to miscount, and they are what turns four group positions into a title.
 */
export const RADBALL10_FINAL_MATCHES = RADBALL_FINAL_KEYS.length;
export const RADBALL10_TOTAL_MATCHES = RADBALL10_PRELIMINARY_MATCHES + RADBALL10_FINAL_MATCHES;

/** One group's single round robin: n * (n - 1) / 2 fixtures. */
export function groupRoundRobinMatches(groupSize: number): number {
  return (groupSize * (groupSize - 1)) / 2;
}

/**
 * The final-phase structure of a competition, from its own group size.
 *
 * Everything below reads this instead of the module constant, so a twelve-team
 * competition and the documented ten-team one run through the same code. The
 * group's own team count is the source of truth, never a literal: a saved
 * tournament carries its groups, and the shape follows from them.
 */
export function structureFor(state: TournamentState): Radball10StructureEntry[] {
  return radball10FinalStructure(groupSizeOf(state));
}

/** Teams per group, read off the competition's first group. */
export function groupSizeOf(state: TournamentState): number {
  const competition = state.radball;
  const first = competition?.groupOrder[0];
  const group = first ? competition?.groups[first] : null;
  return group?.teamIds.length ?? RADBALL10_GROUP_SIZE;
}

/** Teams in the whole competition: both groups, added up. */
export function teamCountOf(state: TournamentState): number {
  const competition = state.radball;
  if (!competition) return RADBALL10_TEAM_COUNT;
  return competition.groupOrder.reduce(
    (sum, groupId) => sum + (competition.groups[groupId]?.teamIds.length ?? 0),
    0,
  );
}

const STRUCTURE_BY_KEY = new Map(RADBALL10_FINAL_STRUCTURE.map((entry) => [entry.key, entry]));

/** Every stage name a UI needs to render, in flow order. */
export const RADBALL10_STAGES: Radball10Stage[] = [
  'SETUP',
  'GROUP_PHASE',
  'GROUP_PHASE_COMPLETE',
  'FINAL_PHASE_READY',
  'PLACEMENT_MATCHES',
  'SEMIFINALS',
  'THIRD_PLACE',
  'FINAL',
  'COMPLETED',
];

export const RADBALL10_STAGE_LABEL: Record<Radball10Stage, string> = {
  SETUP: 'Setup',
  GROUP_PHASE: 'Preliminary round',
  GROUP_PHASE_COMPLETE: 'Preliminary round complete',
  FINAL_PHASE_READY: 'Final phase ready',
  PLACEMENT_MATCHES: 'Placement matches',
  SEMIFINALS: 'Semifinals',
  THIRD_PLACE: '3rd / 4th place match',
  FINAL: 'Final',
  COMPLETED: 'Completed',
};

/* ------------------------------------------------------------------ */
/* Setup validation                                                     */
/* ------------------------------------------------------------------ */

/**
 * The format is defined for exactly ten teams in two groups of five. Refusing
 * anything else here is what keeps the rest of the module free of "what if this
 * group is bigger" branches -- every group position 1..5 below is safe to
 * address because it is guaranteed to exist.
 */
export function validateRadball10Setup(groupSizes: number[]): void {
  if (groupSizes.length !== RADBALL10_GROUP_COUNT) {
    throw new EngineError('BAD_REQUEST', `The World Cup format uses exactly ${RADBALL10_GROUP_COUNT} groups.`);
  }
  // `RADBALL10_GROUP_COUNT` entries are checked above, so the first one exists.
  const first = groupSizes[0] ?? 0;
  // Two groups of the same size. Not a preference: every final-phase pair is
  // "Group A rank r against Group B rank r", and an unequal pair would leave a
  // position with nobody to meet.
  for (let index = 0; index < groupSizes.length; index += 1) {
    if (groupSizes[index] !== first) {
      throw new EngineError(
        'BAD_REQUEST',
        `Both groups must hold the same number of teams: ${String.fromCharCode(65)} has ${first}, ${String.fromCharCode(65 + index)} has ${groupSizes[index]}.`,
      );
    }
  }
  if (first < RADBALL_MIN_GROUP_SIZE) {
    throw new EngineError(
      'BAD_REQUEST',
      `Each group needs at least ${RADBALL_MIN_GROUP_SIZE} teams for a final phase; this has ${first}.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Ids and labels                                                       */
/* ------------------------------------------------------------------ */

/** Group ids are derived from the tournament so a reload finds them again. */
export function radball10GroupId(tournamentId: string, index: number): string {
  return `${tournamentId}:rgroup:10:${index}`;
}

export function radball10GroupMatchId(
  tournamentId: string,
  groupIndex: number,
  round: number,
  position: number,
): string {
  return `${tournamentId}:rg10:${groupIndex}:r${round}p${position}`;
}

export function radball10FinalPhaseId(tournamentId: string): string {
  return `${tournamentId}:rphase:final10`;
}

export function radball10FinalMatchId(tournamentId: string, key: RadballFinalKey): string {
  return `${tournamentId}:rf10:${key.toLowerCase()}`;
}

/** The structure entry behind a final-phase key. */
export function structureEntry(key: RadballFinalKey): Radball10StructureEntry {
  const entry = STRUCTURE_BY_KEY.get(key);
  if (!entry) throw new EngineError('BAD_REQUEST', `Unknown final-phase match: ${key}`);
  return entry;
}

/** The label the UI shows instead of a team name while the slot is empty. */
export function slotSpecLabel(state: TournamentState, spec: Radball10SlotSpec): string {
  if (spec.source === 'GROUP_A') return `Group A #${spec.rank}`;
  if (spec.source === 'GROUP_B') return `Group B #${spec.rank}`;
  const match = semifinalMatch(state, spec.number);
  const noun = spec.place === 'winner' ? 'Winner' : 'Loser';
  return match ? `${noun} · ${match.roundName}` : `${noun} Semifinal ${spec.number}`;
}

/* ------------------------------------------------------------------ */
/* Construction                                                         */
/* ------------------------------------------------------------------ */

export interface Radball10SetupInput {
  ageCategory: Parameters<typeof defaultRadballConfig>[0];
  reducedTime: boolean;
  minRestMinutes: number;
  shootoutAttempts: number;
  /** Group A's teams, then group B's, in draw order. */
  groupA: string[];
  groupB: string[];
  /** Group A -> field, Group B -> field. Defaults to 1 and 2. */
  groupFields: [FieldId, FieldId];
  /** Explicit assignment order for the final phase; null = recommended order. */
  finalOrder: RadballFinalKey[] | null;
}

/**
 * Build the whole preliminary phase: the competition slice, two groups of five,
 * twenty fixtures, and the pins that keep Group A on one field and Group B on
 * the other.
 */
export function createRadball10Competition(
  state: TournamentState,
  setup: Radball10SetupInput,
  tournamentId: string,
  ctx: Ctx,
  mut: Mutation,
): RadballCompetition {
  validateRadball10Setup([setup.groupA.length, setup.groupB.length]);

  const config = {
    ...defaultRadballConfig(setup.ageCategory),
    rulesetVersion: RADBALL_10TEAM_RULESET_VERSION,
    reducedTime: setup.reducedTime,
    minRestMinutes: setup.minRestMinutes,
    shootoutAttempts: setup.shootoutAttempts,
  };
  const phaseId = `${tournamentId}:rphase:10`;
  const competition: RadballCompetition = {
    config,
    system: 'radball-10-team',
    phases: {
      [phaseId]: {
        id: phaseId,
        kind: 'group-stage',
        name: 'Preliminary round',
        order: 0,
        groupIds: [],
        qualification: null,
        status: 'RUNNING',
      },
    },
    phaseOrder: [phaseId],
    groups: {},
    groupOrder: [],
    tables: {},
    championId: null,
    // The final phase is not a generic "final round" template: its shape is
    // declared in RADBALL10_FINAL_STRUCTURE and created only on confirmation.
    pendingFinal: null,
    decisionSeq: 0,
    ten: {
      stage: 'GROUP_PHASE',
      rankings: {},
      groupFrozen: {},
      final: {
        id: radball10FinalPhaseId(tournamentId),
        status: 'PENDING',
        matchIds: [],
        order: [],
        confirmed: false,
      },
      ranking: emptyRanking(setup.groupA.length + setup.groupB.length),
      issues: [],
    },
  };

  const groups: RadballGroup[] = [setup.groupA, setup.groupB].map((teamIds, groupIndex) => {
    const group: RadballGroup = {
      id: radball10GroupId(tournamentId, groupIndex),
      phaseId,
      name: `Group ${String.fromCharCode(65 + groupIndex)}`,
      teamIds: [...teamIds],
      doubleRoundRobin: false,
      // Nobody "advances" in the usual sense: all five positions feed a named
      // final-phase match, which RADBALL10_FINAL_STRUCTURE states.
      qualifies: 0,
      fieldId: setup.groupFields[groupIndex] ?? String(groupIndex + 1),
    };
    competition.groups[group.id] = group;
    competition.groupOrder.push(group.id);
    const phase = competition.phases[phaseId];
    // `phaseId` was resolved from the competition's own order above, so the
    // phase is present; a missing one is a corrupt competition, not a caller error.
    if (phase) phase.groupIds.push(group.id);
    return group;
  });

  state.radball = competition;

  const durationSec = radballMatchSec(config);
  groups.forEach((group, groupIndex) => {
    let position = 0;
    for (const fixture of roundRobinFixtures(group.teamIds, false)) {
      const match = makeRadball10Match({
        id: radball10GroupMatchId(tournamentId, groupIndex, fixture.round, position),
        tournamentId,
        phaseId,
        groupId: group.id,
        matchType: 'GROUP_MATCH',
        finalKey: null,
        semiNumber: null,
        roundName: `${group.name} · Round ${fixture.round + 1}`,
        round: fixture.round,
        position,
        slotA: { kind: 'participant', participantId: fixture.teamA },
        slotB: { kind: 'participant', participantId: fixture.teamB },
        dependsOn: 'none',
        requiresWinner: false,
        durationSec,
        periodCount: 2,
      });
      state.matches[match.id] = match;
      state.matchOrder.push(match.id);
      mut.matches.add(match.id);
      touchMatch(mut, match.id);
      position += 1;
    }
  });

  mut.matchOrder = [...state.matchOrder];
  mut.radball = true;
  void ctx;
  return competition;
}

function emptyRanking(total: number): RadballFinalPlacement[] {
  return Array.from({ length: total }, (_, index) => ({
    place: index + 1,
    teamId: null,
    source: 'NOT_DECIDED',
    matchId: null,
  }));
}

interface Radball10MatchSpec {
  id: string;
  tournamentId: string;
  phaseId: string;
  groupId: string | null;
  matchType: RadballMatchType;
  finalKey: RadballFinalKey | null;
  semiNumber: number | null;
  roundName: string;
  round: number;
  position: number;
  slotA: SlotSource;
  slotB: SlotSource;
  dependsOn: RadballMatchMeta['dependsOn'];
  requiresWinner: boolean;
  durationSec: number;
  periodCount: 1 | 2;
}

/**
 * One match constructor for the whole format.
 *
 * `locked` is derived, never set by hand: a match whose teams are *named* (the
 * group fixtures, whose participants never move) is locked, and a match whose
 * teams are *referenced* is not. That distinction is what stops a cached
 * occupant from outliving the ranking it came from -- §39's "no stale bracket".
 */
function makeRadball10Match(spec: Radball10MatchSpec): Match {
  const derived = spec.dependsOn !== 'none';
  const playable =
    spec.slotA.kind === 'participant' && spec.slotB.kind === 'participant'
      ? Boolean(spec.slotA.participantId && spec.slotB.participantId)
      : false;
  return {
    id: spec.id,
    tournamentId: spec.tournamentId,
    round: spec.round,
    roundName: spec.roundName,
    position: spec.position,
    bracketSlot: spec.position,
    bracket: 'winners',
    isThirdPlace: spec.matchType === 'THIRD_PLACE',
    isGrandFinal: spec.matchType === 'FINAL',
    slotA: spec.slotA,
    slotB: spec.slotB,
    participantAId: spec.slotA.kind === 'participant' ? spec.slotA.participantId : null,
    participantBId: spec.slotB.kind === 'participant' ? spec.slotB.participantId : null,
    scoreA: 0,
    scoreB: 0,
    state: playable ? 'READY' : 'WAITING',
    fieldId: null,
    winnerId: null,
    loserId: null,
    startedAt: null,
    finishedAt: null,
    timer: createTimerState('down', spec.durationSec, spec.periodCount),
    nextWinMatchId: null,
    nextWinSlot: null,
    nextLoseMatchId: null,
    nextLoseSlot: null,
    history: [],
    redoStack: [],
    locked: !derived,
    note: null,
    radball: {
      phaseId: spec.phaseId,
      groupId: spec.groupId,
      kind: radballKindOf(spec.matchType),
      matchType: spec.matchType,
      finalKey: spec.finalKey,
      semiNumber: spec.semiNumber,
      dependsOn: spec.dependsOn,
      requiresWinner: spec.requiresWinner,
      decisionReason: null,
      sideChange: !spec.requiresWinner,
      neutralBall: spec.requiresWinner,
      shootout: null,
    },
  };
}

/**
 * Map the competition role onto the engine branch that processes it. The two
 * vocabularies answer different questions and both are kept: `kind` decides how
 * points are counted and whether a level score needs a shootout, `matchType`
 * decides which places the match hands out.
 */
function radballKindOf(matchType: RadballMatchType): RadballMatchMeta['kind'] {
  if (matchType === 'GROUP_MATCH') return 'group';
  if (matchType === 'FINAL') return 'final';
  if (matchType === 'SEMIFINAL' || matchType === 'THIRD_PLACE') return 'knockout';
  return 'placement';
}

/* ------------------------------------------------------------------ */
/* Lookups                                                              */
/* ------------------------------------------------------------------ */

/**
 * The ten-team view, or a refusal. Every exported operation starts here so the
 * format's entry points cannot be reached on a competition that is not it.
 */
export function requireTen(state: TournamentState): NonNullable<RadballCompetition['ten']> {
  const value = state.radball?.ten;
  if (!value) {
    throw new EngineError('BAD_REQUEST', 'This is not a 10-team Radball competition.');
  }
  return value;
}

/** Every ten-team match, optionally of one competition role. */
export function radball10Matches(state: TournamentState, matchType?: RadballMatchType): Match[] {
  return Object.values(state.matches).filter((match) => {
    const type = match.radball?.matchType;
    if (!type) return false;
    return matchType === undefined || type === matchType;
  });
}

/** Every final-phase match, in the structure's own (recommended) order. */
export function finalPhaseMatches(state: TournamentState): Match[] {
  const tournamentId = state.tournament?.id ?? '';
  return structureFor(state)
    .map((entry) => state.matches[radball10FinalMatchId(tournamentId, entry.key)])
    .filter((match): match is Match => Boolean(match));
}

/** Every preliminary fixture, of one group or of both. */
export function preliminaryMatches(state: TournamentState, groupId?: string): Match[] {
  return radball10Matches(state, 'GROUP_MATCH').filter((match) =>
    groupId === undefined ? true : match.radball?.groupId === groupId,
  );
}

export function matchOfKey(state: TournamentState, key: RadballFinalKey): Match | undefined {
  return state.matches[radball10FinalMatchId(state.tournament?.id ?? '', key)];
}

export function semifinalMatch(state: TournamentState, number: 1 | 2): Match | undefined {
  return matchOfKey(state, number === 1 ? 'SEMIFINAL_1' : 'SEMIFINAL_2');
}

/** The group id a symbolic reference (`GROUP_A`) points at. */
export function groupIdOfKey(state: TournamentState, key: 'GROUP_A' | 'GROUP_B'): string | null {
  const competition = state.radball;
  if (!competition) return null;
  const index = key === 'GROUP_A' ? 0 : 1;
  return competition.groupOrder[index] ?? radball10GroupId(state.tournament?.id ?? '', index);
}

/* ------------------------------------------------------------------ */
/* Final phase generation                                               */
/* ------------------------------------------------------------------ */

export interface FinalPhaseReadiness {
  ready: boolean;
  /** Per-group fixture counts, for the confirmation dialog. */
  groups: { name: string; played: number; total: number; fieldId: FieldId | null }[];
  reason: string | null;
}

/**
 * May the final phase be created yet?
 *
 * §24: no. Not until all ten Group A fixtures *and* all ten Group B fixtures are
 * decided. This is deliberately not "the group tables look finished" -- the
 * dependency chain is only trustworthy once every result behind it exists, and a
 * half-played group would freeze a ranking that a later result would contradict.
 */
export function finalPhaseReadiness(state: TournamentState): FinalPhaseReadiness {
  const competition = state.radball;
  if (!competition?.ten) {
    return { ready: false, groups: [], reason: 'Not a 10-team Radball competition.' };
  }
  const groups = competition.groupOrder.map((groupId) => {
    const group = competition.groups[groupId];
    const fixtures = preliminaryMatches(state, groupId);
    const total = fixtures.filter((match) => match.state !== 'CANCELLED').length;
    const played = fixtures.filter((match) => match.state === 'FINISHED').length;
    return {
      name: group?.name ?? groupId,
      played,
      total,
      fieldId: group?.fieldId ?? null,
    };
  });
  const outstanding = groups.filter((entry) => entry.played < entry.total);
  return {
    ready: outstanding.length === 0,
    groups,
    reason:
      outstanding.length === 0
        ? null
        : `Play the remaining preliminary fixtures first: ${outstanding
            .map((entry) => `${entry.name} ${entry.played}/${entry.total}`)
            .join(', ')}.`,
  };
}

/**
 * Create the six final-phase matches. Idempotent: a second call is refused rather
 * than duplicating the structure, because a duplicate would produce two matches
 * that both claim places 1 and 2.
 */
export function generateFinalPhase(
  state: TournamentState,
  ctx: Ctx,
  mut: Mutation,
  options: { order?: RadballFinalKey[] | null; confirm?: boolean } = {},
): RadballFinalKey[] {
  const competition = state.radball;
  const tournament = state.tournament;
  if (!competition || !tournament) {
    throw new EngineError('BAD_REQUEST', 'This is not a 10-team Radball competition.');
  }
  const structure = requireTen(state).final;
  const readiness = finalPhaseReadiness(state);
  if (!readiness.ready) {
    throw new EngineError('INVALID_STATE', readiness.reason ?? 'The preliminary round is not complete.');
  }
  if (structure.status === 'GENERATED') {
    throw new EngineError('CONFLICT', 'The final phase has already been generated.');
  }
  if (structure.confirmed && options.confirm === false) {
    throw new EngineError('INVALID_STATE', 'The final phase was not confirmed.');
  }

  const phaseId = radball10FinalPhaseId(tournament.id);
  if (!competition.phases[phaseId]) {
    competition.phases[phaseId] = {
      id: phaseId,
      kind: 'placement-round',
      name: 'Final phase',
      order: competition.phaseOrder.length,
      groupIds: [],
      qualification: {
        fromPhaseId: competition.phaseOrder[0] ?? null,
        places: teamCountOf(state),
      },
      status: 'RUNNING',
    };
    competition.phaseOrder.push(phaseId);
  }

  const created: string[] = [];
  // Created in the *recommended* order, always: the stored queue order is the
  // host's schedule, but ids and structure must not depend on it. The entries
  // come from the competition's own group count, so a twelve-team competition
  // gets four placement matches rather than three.
  for (const [position, entry] of structureFor(state).entries()) {
    const id = radball10FinalMatchId(tournament.id, entry.key);
    if (state.matches[id]) {
      created.push(id);
      continue;
    }
    const match = makeRadball10Match({
      id,
      tournamentId: tournament.id,
      phaseId,
      groupId: null,
      matchType: entry.matchType,
      finalKey: entry.key,
      semiNumber: entry.key === 'SEMIFINAL_1' ? 1 : entry.key === 'SEMIFINAL_2' ? 2 : null,
      roundName: entry.roundName,
      // Final-phase matches sit past every real group round in the queue sort but
      // before the decision matches, which use the 900 sentinel.
      round: 900,
      position,
      slotA: slotSourceOf(state, entry.slots[0]),
      slotB: slotSourceOf(state, entry.slots[1]),
      dependsOn: entry.dependsOn,
      // Every final-phase match must produce a place, so a level score is a
      // shootout, never an undefined outcome.
      requiresWinner: true,
      durationSec: radballMatchSec(competition.config),
      periodCount: 2,
    });
    state.matches[id] = match;
    state.matchOrder.push(id);
    mut.matches.add(id);
    touchMatch(mut, id);
    created.push(id);
  }

  structure.matchIds = created;
  structure.order = normaliseFinalOrder(options.order ?? null, groupSizeOf(state));
  structure.status = 'GENERATED';
  structure.confirmed = true;

  // The host's schedule order becomes the queue order, so the match list, the
  // auto-assigner and the operator's "next match" all follow it at once.
  reorderQueueAround(state, structure.order.map((key) => radball10FinalMatchId(tournament.id, key)));

  for (const phaseIdToClose of competition.phaseOrder) {
    const phase = competition.phases[phaseIdToClose];
    if (phase && phase.id !== phaseId) phase.status = 'COMPLETED';
  }

  mut.matchOrder = [...state.matchOrder];
  mut.radball = true;
  mut.urgency = 'immediate';
  pushEvent(mut, 'FINAL_PHASE_GENERATED', {
    key: 'event.finalPhaseGenerated',
    params: { n: created.length },
  });
  // Re-derive before resolving, so the stage and the validation see the structure
  // that now exists. Generating the final phase changes both: the competition has
  // entered its last phase, and from here on an unplayed place is a missing
  // dependency rather than a preliminary round still in progress.
  syncRadball10(state, ctx, mut);
  // The six matches were just born with empty slots. The group tables are already
  // complete, so walk the chain once and every placement match and semifinal is
  // filled before anyone sees them.
  resolveBracket(state, ctx, mut);
  return structure.order;
}

/**
 * A host-supplied order: deduplicated, and completed with anything missing so a
 * half-filled list can never lose a match from the queue.
 */
export function normaliseFinalOrder(
  requested: readonly RadballFinalKey[] | null,
  groupSize: number = RADBALL10_GROUP_SIZE,
): RadballFinalKey[] {
  const valid = radballFinalKeys(groupSize);
  const seen = new Set<RadballFinalKey>();
  const out: RadballFinalKey[] = [];
  for (const key of requested ?? []) {
    if (!valid.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  for (const key of valid) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

/**
 * Rearrange the final-phase queue. Idempotent, and it cannot touch anything
 * else: the preliminary fixtures and any live match keep their places, so a
 * schedule change mid-event never pulls a match off a running field.
 */
export function setFinalPhaseOrder(
  state: TournamentState,
  requested: readonly RadballFinalKey[],
  mut: Mutation,
): void {
  const tournament = state.tournament;
  if (!tournament) {
    throw new EngineError('BAD_REQUEST', 'This is not a 10-team Radball competition.');
  }
  const structure = requireTen(state).final;
  if (structure.status !== 'GENERATED') {
    throw new EngineError('INVALID_STATE', 'Generate the final phase before changing its order.');
  }
  const order = normaliseFinalOrder(requested);
  structure.order = order;
  reorderQueueAround(state, order.map((key) => radball10FinalMatchId(tournament.id, key)));
  mut.matchOrder = [...state.matchOrder];
  mut.radball = true;
  mut.urgency = 'immediate';
  pushEvent(mut, 'TOURNAMENT_PHASE_UPDATED', {
    key: 'event.finalPhaseOrder',
    params: { rounds: order.map((key) => structureEntry(key).roundName).join(' → ') },
  });
}

/**
 * Put the final-phase matches into the host's order, leaving the preliminary
 * fixtures in front of them. Everything that is not a final-phase match keeps its
 * place, so a schedule change mid-event never pulls a match off a running field.
 */
function reorderQueueAround(state: TournamentState, order: string[]): void {
  const finalIds = new Set(order);
  const preliminary = state.matchOrder.filter((id) => !finalIds.has(id));
  state.matchOrder = [...preliminary, ...order.filter((id) => state.matches[id])];
}

/**
 * Turn a slot spec into the stored slot reference.
 *
 * A group position becomes a `group-rank` slot and a semifinal side becomes a
 * `winner-of` / `loser-of` slot. Neither names a team: that is the whole point,
 * because a stored name is a promise the engine cannot keep once an earlier
 * result changes.
 */
function slotSourceOf(state: TournamentState, spec: Radball10SlotSpec): SlotSource {
  if (spec.source === 'GROUP_A' || spec.source === 'GROUP_B') {
    const groupId = groupIdOfKey(state, spec.source);
    if (!groupId) return { kind: 'bye' };
    return { kind: 'group-rank', groupId, rank: spec.rank };
  }
  const matchId = radball10FinalMatchId(
    state.tournament?.id ?? '',
    spec.number === 1 ? 'SEMIFINAL_1' : 'SEMIFINAL_2',
  );
  return { kind: spec.place === 'winner' ? 'winner-of' : 'loser-of', matchId };
}

/* ------------------------------------------------------------------ */
/* The dependency chain                                                 */
/* ------------------------------------------------------------------ */

/**
 * Re-derive the whole ten-team competition from the results in the state.
 *
 * Called after every result change. The steps are the requirement's chain, in
 * order and in one place, so there is exactly one code path that can produce a
 * final ranking and no second one that could disagree with it.
 */
export function syncRadball10(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  const competition = state.radball;
  if (!competition?.ten) return;
  const view = competition.ten;
  let touched = false;

  // 1. Group standings and the published rankings (A1-A5 / B1-B5).
  for (const groupId of competition.groupOrder) {
    const rows: StandingRow[] = rankedGroupTable(state, groupId);
    // A ranking is published only once the group is *complete*. Publishing a
    // provisional order would put teams into the semifinals while their group is
    // still being played, and a later result would silently rename the
    // finalists -- exactly the stale-bracket failure the references exist to
    // prevent. An unpublished group reads as "not decided" everywhere.
    const frozen = groupComplete(state, groupId);
    const ranking = frozen ? rows.map((row) => row.teamId) : [];
    const current = view.rankings[groupId];
    if (!Array.isArray(current) || JSON.stringify(current) !== JSON.stringify(ranking)) {
      view.rankings[groupId] = ranking;
      touched = true;
    }
    const wasFrozen = view.groupFrozen[groupId] === true;
    if (view.groupFrozen[groupId] !== frozen) {
      view.groupFrozen[groupId] = frozen;
      touched = true;
      if (frozen && !wasFrozen) {
        pushEvent(mut, 'GROUP_FROZEN', {
          key: 'event.groupComplete',
          params: {
            group: competition.groups[groupId]?.name ?? 'Group',
            ranking: ranking
              .map((teamId, index) => `${String.fromCharCode(65 + index)}${index + 1} ${participantName(state, teamId)}`)
              .join(', '),
          },
        });
      }
    }
  }

  // 2. Final ranking 1-10 from the match results, plus its validation.
  const ranking = computeFinalRanking(state);
  if (JSON.stringify(ranking.entries) !== JSON.stringify(view.ranking)) {
    view.ranking = ranking.entries;
    touched = true;
    pushEvent(
      mut,
      'FINAL_RANKING_UPDATED',
      ranking.entries.every((entry) => entry.teamId)
        ? { key: 'event.finalRankingAssigned' }
        : { key: 'event.finalRankingUpdated' },
    );
  }
  if (JSON.stringify(ranking.issues) !== JSON.stringify(view.issues)) {
    view.issues = ranking.issues;
    touched = true;
    if (ranking.issues.length > 0) {
      pushEvent(mut, 'VALIDATION_FAILED', ranking.issues.join(' '), {
        matchId: radball10FinalMatchId(state.tournament?.id ?? '', 'FINAL'),
      });
    }
  }

  // 3. Stage machine.
  const stage = deriveStage(state);
  if (view.stage !== stage) {
    const previous = view.stage;
    view.stage = stage;
    touched = true;
    if (stage === 'GROUP_PHASE_COMPLETE' && previous !== 'GROUP_PHASE_COMPLETE') {
      pushEvent(mut, 'FINAL_PHASE_READY', { key: 'event.finalPhaseReady' });
    }
  }

  // 4. Champion and tournament status.
  const tournament = state.tournament;
  const champion = view.ranking.find((entry) => entry.place === 1)?.teamId ?? null;
  if (champion !== competition.championId) {
    competition.championId = champion;
    touched = true;
  }
  const complete = stage === 'COMPLETED' && view.issues.length === 0;
  if (complete && tournament?.status !== 'COMPLETED') {
    if (tournament) {
      tournament.status = 'COMPLETED';
      tournament.championId = champion;
      tournament.completedAt = ctx.now;
      mut.tournament = true;
    }
    pushEvent(mut, 'TOURNAMENT_UPDATED', {
      key: 'event.tournamentComplete',
      params: { name: participantName(state, champion) },
    });
    notify(mut, 'info', { key: 'notify.champion', params: { name: participantName(state, champion) } });
  } else if (!complete && tournament?.status === 'COMPLETED') {
    tournament.status = 'RUNNING';
    tournament.championId = null;
    tournament.completedAt = null;
    mut.tournament = true;
  }

  if (touched) {
    mut.radball = true;
    mut.urgency = 'immediate';
  }
}

export interface FinalRankingResult {
  entries: RadballFinalPlacement[];
  issues: string[];
}

/**
 * Places 1-10, each one derived from the match that decided it.
 *
 * Nothing here sorts a table of the ten teams. Every entry points at a match and
 * a side of it, so the answer cannot be stale, cannot tie two teams into one
 * place, and cannot leave "tied for 5th" when a match exists that settles it.
 *
 * An issue means the ranking is *broken*, never that it is *unfinished*. Nothing
 * is complained about before the final phase is generated, and nothing is
 * complained about while it is being played: generating the structure creates
 * seven unplayed matches, so an undecided place in that window is the expected
 * state of a tournament in progress rather than a missing dependency.
 *
 * That distinction was worth getting right. Reporting an unplayed match as an
 * issue meant the host generated the final phase, saw a red "the final ranking
 * is not complete" banner naming six problems, and read it as the generation
 * having failed -- at the exact moment it had succeeded. The issues start once
 * there is nothing left to play and a place still has no team, which is the only
 * state in which the ranking cannot be finished by playing more matches.
 */
export function computeFinalRanking(state: TournamentState): FinalRankingResult {
  // One entry per team in the competition, not a fixed ten.
  const total = teamCountOf(state);
  const entries: RadballFinalPlacement[] = Array.from({ length: total });
  const issues: string[] = [];
  const tournamentId = state.tournament?.id ?? '';
  const generated = state.radball?.ten?.final.status === 'GENERATED';
  // Nothing left to play: every final-phase match is decided, or cancelled so it
  // never will be. Only from here on is an undecided place a fault rather than a
  // game still to come. Safe to call: `deriveStage` reads readiness and match
  // states, never the ranking this function computes.
  const settled = generated && deriveStage(state) === 'COMPLETED';

  for (const entry of structureFor(state)) {
    const id = radball10FinalMatchId(tournamentId, entry.key);
    const match = state.matches[id];
    if (!entry.places) continue;
    const [better, worse] = entry.places;
    if (!match) {
      entries[better - 1] = { place: better, teamId: null, source: entry.key, matchId: id };
      entries[worse - 1] = { place: worse, teamId: null, source: entry.key, matchId: id };
      if (generated) issues.push(`Place ${better}/${worse}: the ${entry.roundName} match does not exist.`);
      continue;
    }
    if (match.state !== 'FINISHED' || !match.winnerId) {
      entries[better - 1] = { place: better, teamId: null, source: entry.key, matchId: id };
      entries[worse - 1] = { place: worse, teamId: null, source: entry.key, matchId: id };
      if (settled) {
        issues.push(`Place ${better}/${worse}: the ${entry.roundName} match is not finished (${match.state}).`);
      }
      continue;
    }
    entries[better - 1] = { place: better, teamId: match.winnerId, source: entry.key, matchId: id };
    entries[worse - 1] = { place: worse, teamId: match.loserId, source: entry.key, matchId: id };
  }

  // §36: the validation is part of the computation, not a post-hoc check. A place
  // with no team, or a team in two places, is a missing dependency and is
  // reported instead of quietly leaving a hole in the table. A *duplicate* place is
  // a fault the moment it appears, because no amount of further play resolves it.
  // An empty place is only a fault once nothing is left to play -- before that it
  // is a fixture still waiting on a result.
  const occupied = entries.filter((entry) => entry.teamId !== null);
  if (!generated) return { entries, issues };
  if (settled && occupied.length !== total && issues.length === 0) {
    issues.push(`${occupied.length} of ${total} places are decided.`);
  }
  const seen = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.teamId) continue;
    const first = seen.get(entry.teamId);
    if (first !== undefined) {
      issues.push(
        `${participantName(state, entry.teamId)} holds both ${ordinal(first)} and ${ordinal(entry.place)} place -- a dependency is wrong.`,
      );
    } else {
      seen.set(entry.teamId, entry.place);
    }
  }
  const roster = state.participantOrder.filter((id) => state.participants[id]);
  const missing = roster.filter((id) => !seen.has(id));
  if (missing.length > 0 && issues.length > 0) {
    issues.push(`Still unplaced: ${missing.map((id) => participantName(state, id)).join(', ')}.`);
  }

  return { entries, issues: dedupe(issues) };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function ordinal(value: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const mod = value % 100;
  return `${value}${suffixes[(mod - 20) % 10] ?? suffixes[mod] ?? 'th'}`;
}

/* ------------------------------------------------------------------ */
/* The state machine                                                    */
/* ------------------------------------------------------------------ */

/**
 * The current stage, derived from the results -- never set by hand.
 *
 * The ordering is the requirement's list, and each stage names what has to be
 * true before the next one is reachable. Deriving it (rather than storing a flag
 * someone has to move) is what makes an impossible transition unrepresentable:
 * there is no path that reaches `FINAL` while a semifinal is unfinished, because
 * `FINAL` is a *question about the matches*, not a state anyone can assert.
 */
export function deriveStage(state: TournamentState): Radball10Stage {
  const competition = state.radball;
  if (!competition?.ten) return 'SETUP';
  const open = (match: Match | undefined): boolean =>
    match !== undefined && match.state !== 'FINISHED' && match.state !== 'CANCELLED';

  // Before the structure exists the only question is whether the twenty
  // preliminary fixtures are done.
  if (competition.ten.final.status !== 'GENERATED') {
    return finalPhaseReadiness(state).ready ? 'GROUP_PHASE_COMPLETE' : 'GROUP_PHASE';
  }
  // Once it exists: "ready" is the moment the structure is there and nobody has
  // touched it yet. It is a real state, not a formality -- it is the window in
  // which the host can still change the recommended order or move a match to the
  // other field without anything running.
  const finalPhase = finalPhaseMatches(state);
  if (finalPhase.every((match) => !match.startedAt)) return 'FINAL_PHASE_READY';

  // Placements first: they only need the group tables, so a hall always has
  // something legal to run. Then the semifinals, then the two matches that need
  // both of them. A missing match counts as open, so a stage can never be passed
  // by accident.
  // Every placement match, whatever their number: two groups of N have N-2 of
  // them, and the stage is "placement matches" while any of them is still open.
  if (placementKeys(groupSizeOf(state)).some((key) => open(matchOfKey(state, key)))) {
    return 'PLACEMENT_MATCHES';
  }
  if (open(matchOfKey(state, 'SEMIFINAL_1')) || open(matchOfKey(state, 'SEMIFINAL_2'))) return 'SEMIFINALS';
  if (open(matchOfKey(state, 'THIRD_PLACE'))) return 'THIRD_PLACE';
  if (open(matchOfKey(state, 'FINAL'))) return 'FINAL';
  return 'COMPLETED';
}

/**
 * May this match be put on a field and started right now?
 *
 * The dependency check is server-side for the same reason the double-booking
 * check is: an operator on a phone must not be able to start a final whose
 * semifinal is still running, whatever the button on their screen says.
 */
export function assertFinalPhaseDependency(state: TournamentState, match: Match): void {
  const meta = match.radball;
  if (!meta?.matchType || meta.dependsOn === 'none') return;
  if (meta.dependsOn === 'group-complete') {
    const readiness = finalPhaseReadiness(state);
    if (!readiness.ready) {
      throw new EngineError('INVALID_STATE', readiness.reason ?? 'The preliminary round is not complete.');
    }
    return;
  }
  const semis = [matchOfKey(state, 'SEMIFINAL_1'), matchOfKey(state, 'SEMIFINAL_2')].filter(
    (entry): entry is Match => Boolean(entry),
  );
  const unfinished = semis.filter((entry) => entry.state !== 'FINISHED' && entry.state !== 'CANCELLED');
  if (unfinished.length > 0) {
    throw new EngineError(
      'INVALID_STATE',
      `${match.roundName} cannot start before ${unfinished.map((entry) => entry.roundName).join(' and ')} are finished.`,
      { matchId: match.id },
    );
  }
}

/**
 * Is this match's tie resolved by a shootout or accepted as a draw?
 *
 * §27 hands the decision to the ruleset instead of the bracket: the rules engine
 * knows the competition is Radball, knows which ruleset the host selected, and
 * therefore knows whether a level 9th-place score is decided at the 4-metre line
 * or recorded as a draw. The UI never decides this.
 *
 * Only the ten-team format's final-phase matches come through here. A generic
 * Radball group fixture is *not* one of them -- a level group score is a legal
 * draw worth a point to each team, and treating it as anything else would have
 * broken every existing competition.
 */
export function tieResolutionOf(state: TournamentState, match: Match): 'shootout' | 'draw' {
  const config = state.radball?.config;
  const matchType = match.radball?.matchType;
  if (!config || !matchType || matchType === 'GROUP_MATCH') return 'draw';
  // Any placement match, whatever places it hands out: the pair in the name is
  // the label, not a closed set of three.
  if (matchType.startsWith('PLACEMENT_')) {
    return config.placementTieResolution;
  }
  return config.tieResolution;
}

/** A level final-phase match must be settled at the 4-metre line. */
export function requiresShootout(state: TournamentState, match: Match): boolean {
  return tieResolutionOf(state, match) === 'shootout';
}