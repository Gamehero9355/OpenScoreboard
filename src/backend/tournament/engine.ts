/**
 * Tournament engine -- tournament, participant and bracket level operations.
 * The UI never touches tournament data directly; it sends a command and the
 * engine produces a mutation describing exactly what changed.
 */
import type {
  Match,
  Participant,
  Tournament,
  TournamentFormat,
  TournamentState,
} from '../../shared/types';
import { parseLogoName, type ParticipantInput } from '../../shared/commands';
import type { FieldId, RadballAgeCategory, Settings } from '../../shared/types';
import { MAX_FIELDS, MAX_MANUAL_MATCHES, MIN_FIELDS, RADBALL_AGE_CATEGORIES, compareFieldIds } from '../../shared/types';
import { EngineError } from '../util/errors';
import { RADBALL_MIN_GROUP_SIZE } from '../../shared/radball10Structure';
import { mulberry32, shuffle } from '../util/ids';
import {
  generateBracket,
  generateManualSchedule,
  manualMatchId,
  nextPowerOfTwo,
  seedSlotsByField,
  type GeneratedMatch,
  type ManualFixture,
  type SeedGroup,
} from './bracket';
import { MAX_EVENTS, createField } from './defaults';
import { assignMatchToField, autoAssign } from './matchops';
import {
  createRadballCompetition,
  recalculateRadball,
  type RadballGroupSetup,
  type RadballSetup,
} from './radball';
import { rebuild, resolveBracket, finaliseTournament } from './resolve';
import { createTimerState, type Ctx, type Mutation, participantName, pushEvent, touchMatch } from './state';

export const MAX_PARTICIPANTS = 256;

/**
 * A crest is a bare file name in the host's logos folder.
 *
 * The shared validator has already refused anything with a path in it by the
 * time a command reaches the engine, but the same shape also arrives from a
 * restored backup, so the rule is applied where the value is stored.
 */
function normaliseLogoName(value: unknown): string | null {
  return parseLogoName(value);
}

/* ------------------------------------------------------------------ */
/* Selectors                                                          */
/* ------------------------------------------------------------------ */

export function orderedParticipants(state: TournamentState): Participant[] {
  return state.participantOrder
    .map((id) => state.participants[id])
    .filter((p): p is Participant => Boolean(p));
}

export function orderedMatches(state: TournamentState): Match[] {
  return state.matchOrder.map((id) => state.matches[id]).filter((m): m is Match => Boolean(m));
}

function requireTournament(state: TournamentState): Tournament {
  if (!state.tournament) {
    throw new EngineError('NO_TOURNAMENT', 'No tournament is loaded yet. Create one first.');
  }
  return state.tournament;
}

function radballRosterFieldLabel(fieldId: string | null): string {
  return fieldId ? `Field ${fieldId}` : 'The unassigned roster';
}

function assertUniqueRadballRoster(
  state: TournamentState,
  entry: { name: string; fieldId: string | null; players: [string, string] },
  ignoreId?: string,
): void {
  if (state.tournament?.format !== 'radball') return;
  const normalizedName = entry.name.trim().toLowerCase();
  const normalizedPlayers = entry.players.map((player) => player.trim().toLowerCase());
  if (normalizedPlayers[0] === normalizedPlayers[1]) {
    throw new EngineError('BAD_REQUEST', 'Player 1 and player 2 must be different people.');
  }
  const field = radballRosterFieldLabel(entry.fieldId);
  for (const id of state.participantOrder) {
    if (id === ignoreId) continue;
    const existing = state.participants[id];
    if (!existing || existing.fieldId !== entry.fieldId) continue;
    if (existing.name.trim().toLowerCase() === normalizedName) {
      throw new EngineError('BAD_REQUEST', `${field} already contains team "${entry.name}". Each team name must be unique within a field.`);
    }
    const duplicatePlayer = existing.players?.find((player) => normalizedPlayers.includes(player.trim().toLowerCase()));
    if (duplicatePlayer) {
      throw new EngineError('BAD_REQUEST', `${field} already contains player "${duplicatePlayer}". Each player can appear only once within a field.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Participants                                                       */
/* ------------------------------------------------------------------ */

export function addParticipant(
  state: TournamentState,
  input: ParticipantInput,
  ctx: Ctx,
  mut: Mutation,
): Participant {
  if (state.participantOrder.length >= MAX_PARTICIPANTS) {
    throw new EngineError('BAD_REQUEST', `A tournament can hold at most ${MAX_PARTICIPANTS} participants.`);
  }
  const fieldId = input.fieldId ?? null;
  if (fieldId !== null && !state.fields[fieldId]) {
    throw new EngineError('BAD_REQUEST', `Playing field ${fieldId} does not exist.`);
  }
  const players = input.players ?? null;
  if (state.tournament?.format === 'radball') {
    if (!players) {
      throw new EngineError('BAD_REQUEST', 'Radball teams need exactly two player names. Use team name, player 1, player 2.');
    }
    assertUniqueRadballRoster(state, { name: input.name, fieldId, players });
  }
  const participant: Participant = {
    id: ctx.newId('p'),
    name: input.name,
    team: input.team,
    logo: normaliseLogoName(input.logo),
    seed: input.seed,
    checkedIn: input.checkedIn,
    createdAt: ctx.now,
    fieldId,
    players,
  };
  state.participants[participant.id] = participant;
  state.participantOrder.push(participant.id);
  mut.participants.add(participant.id);
  mut.participantOrder = [...state.participantOrder];
  pushEvent(mut, 'PARTICIPANT_ADDED', { key: 'event.participantAdded', params: { name: participant.name } }, {
    data: { participantId: participant.id },
  });
  mut.urgency = 'immediate';
  return participant;
}

export function updateParticipant(
  state: TournamentState,
  id: string,
  patch: Record<string, unknown>,
  ctx: Ctx,
  mut: Mutation,
): Participant {
  const participant = state.participants[id];
  if (!participant) throw new EngineError('PARTICIPANT_NOT_FOUND', 'That participant no longer exists.');
  const before = participant.name;
  const nextName = typeof patch.name === 'string' ? patch.name : participant.name;
  const nextFieldId = 'fieldId' in patch ? ((patch.fieldId as string | null) ?? null) : participant.fieldId;
  if (nextFieldId !== null && !state.fields[nextFieldId]) {
    throw new EngineError('BAD_REQUEST', `Playing field ${nextFieldId} does not exist.`);
  }
  const nextPlayers = 'players' in patch ? ((patch.players as [string, string] | null) ?? null) : participant.players;
  if (state.tournament?.format === 'radball') {
    if (!nextPlayers) {
      throw new EngineError('BAD_REQUEST', 'Radball teams need exactly two player names. Use team name, player 1, player 2.');
    }
    assertUniqueRadballRoster(state, { name: nextName, fieldId: nextFieldId, players: nextPlayers }, id);
  }
  if (typeof patch.name === 'string') participant.name = patch.name;
  if ('team' in patch) participant.team = (patch.team as string | null) ?? null;
  if ('logo' in patch) participant.logo = normaliseLogoName(patch.logo);
  if ('seed' in patch) participant.seed = (patch.seed as number | null) ?? null;
  if (typeof patch.checkedIn === 'boolean') participant.checkedIn = patch.checkedIn;
  if ('fieldId' in patch) participant.fieldId = nextFieldId;
  if ('players' in patch) participant.players = nextPlayers;
  mut.participants.add(id);
  pushEvent(
    mut,
    'PARTICIPANT_UPDATED',
    { key: 'event.participantUpdated', params: { name: before } },
    { data: { participantId: id } },
  );
  mut.urgency = 'immediate';
  void ctx;
  return participant;
}

export function removeParticipant(
  state: TournamentState,
  id: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const participant = state.participants[id];
  if (!participant) throw new EngineError('PARTICIPANT_NOT_FOUND', 'That participant no longer exists.');

  const inProgress = Object.values(state.matches).find(
    (m) =>
      (m.participantAId === id || m.participantBId === id) &&
      (m.state === 'RUNNING' || m.state === 'PAUSED' || m.state === 'HALFTIME' || m.state === 'ASSIGNED'),
  );
  if (inProgress) {
    throw new EngineError(
      'CONFLICT',
      `${participant.name} is currently playing in ${inProgress.roundName}. Finish or unassign that match first.`,
    );
  }
  const played = Object.values(state.matches).some(
    (m) => (m.participantAId === id || m.participantBId === id) && m.state === 'FINISHED',
  );
  if (played) {
    throw new EngineError(
      'CONFLICT',
      `${participant.name} already has results in this bracket. Reset the tournament to remove them.`,
    );
  }

  delete state.participants[id];
  state.participantOrder = state.participantOrder.filter((pid) => pid !== id);
  mut.participantOrder = [...state.participantOrder];
  mut.removedParticipantIds.push(id);
  for (const match of Object.values(state.matches)) {
    if (match.slotA.kind === 'participant' && match.slotA.participantId === id) match.slotA = { kind: 'bye' };
    if (match.slotB.kind === 'participant' && match.slotB.participantId === id) match.slotB = { kind: 'bye' };
  }
  if (state.tournament) {
    resolveBracket(state, ctx, mut);
    finaliseTournament(state, ctx, mut);
  }
  pushEvent(mut, 'PARTICIPANT_REMOVED', {
    key: 'event.participantRemoved',
    params: { name: participant.name },
  });
  mut.urgency = 'immediate';
  void ctx;
}

export function reorderParticipants(state: TournamentState, ids: string[], mut: Mutation): void {
  const known = ids.filter((id) => Boolean(state.participants[id]));
  const missing = state.participantOrder.filter((id) => !known.includes(id));
  state.participantOrder = [...known, ...missing];
  mut.participantOrder = [...state.participantOrder];
  pushEvent(mut, 'PARTICIPANT_UPDATED', { key: 'event.participantOrder' });
  mut.urgency = 'immediate';
}

/* ------------------------------------------------------------------ */
/* Bracket seeding                                                    */
/* ------------------------------------------------------------------ */

export interface SeedOptions {
  seeded: boolean;
  seedValue: number | null;
  /** Explicit bracket slot order (drag and drop editing). */
  order?: (string | null)[] | null;
}

/**
 * Produce the ordered (highest seed first) participant id list that will be
 * laid out into bracket slots.
 */
export function seedParticipantList(state: TournamentState, options: SeedOptions): string[] {
  const participants = orderedParticipants(state).filter((p) => p.checkedIn);
  if (participants.length < 2) {
    throw new EngineError('BAD_REQUEST', 'At least two checked-in participants are required.');
  }
  if (!options.seeded) {
    const random = options.seedValue === null ? Math.random : mulberry32(options.seedValue);
    return shuffle(participants, random).map((p) => p.id);
  }
  const explicit = participants.filter((p) => p.seed !== null);
  const implicit = participants.filter((p) => p.seed === null);
  const sortedExplicit = [...explicit].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
  const sortedImplicit = [...implicit].sort((a, b) => a.createdAt - b.createdAt);
  const ordered = [...sortedExplicit, ...sortedImplicit];
  if (options.seedValue !== null) {
    const random = mulberry32(options.seedValue);
    const randomPart = shuffle(sortedImplicit, random);
    return [...sortedExplicit, ...randomPart].map((p) => p.id);
  }
  return ordered.map((p) => p.id);
}

function toMatches(tournamentId: string, generated: GeneratedMatch[], settings: Settings): Match[] {
  return generated.map((g) => ({
    id: g.id,
    tournamentId,
    round: g.round,
    roundName: g.roundName,
    position: g.position,
    bracketSlot: g.bracketSlot,
    bracket: g.bracket,
    isThirdPlace: g.isThirdPlace,
    isGrandFinal: g.isGrandFinal,
    slotA: g.slotA,
    slotB: g.slotB,
    participantAId: g.slotA.kind === 'participant' ? g.slotA.participantId : null,
    participantBId: g.slotB.kind === 'participant' ? g.slotB.participantId : null,
    scoreA: 0,
    scoreB: 0,
    state: 'WAITING',
    fieldId: null,
    winnerId: null,
    loserId: null,
    startedAt: null,
    finishedAt: null,
    timer: createTimerState(settings.timerMode, settings.defaultMatchDurationSec),
    nextWinMatchId: g.nextWinMatchId,
    nextWinSlot: g.nextWinSlot,
    nextLoseMatchId: g.nextLoseMatchId,
    nextLoseSlot: g.nextLoseSlot,
    history: [],
    redoStack: [],
    locked: false,
    note: null,
    radball: null,
  }));
}

/* ------------------------------------------------------------------ */
/* Create / generate                                                  */
/* ------------------------------------------------------------------ */

export interface CreateTournamentInput {
  name: string;
  format: TournamentFormat;
  participants: ParticipantInput[];
  thirdPlaceMatch: boolean;
  seeded: boolean;
  seedValue: number | null;
  settings: Record<string, unknown> | null;
  generateBracketNow: boolean;
  /** Playing-field display names (1..MAX_FIELDS). Defaults to the current setup. */
  fieldNames?: string[];
  /**
   * Manual bracket placement: one entry per bracket slot, each an index into
   * `participants` or null for a bye. When present the automatic draw is
   * skipped and these slots are used verbatim.
   */
  manualOrder?: (number | null)[] | null;
  /**
   * The fixtures of a manual schedule, in the host's own order. `a` and `b` are
   * indexes into `participants` -- the convention the wizard sends, and the same
   * one `manualOrder` uses, because both are answers to "who plays whom" asked
   * before any participant has an id.
   */
  manualMatches?: {
    a: number;
    b: number;
    round?: string | null;
    fieldId?: string | null;
  }[] | null;
  /** Radball competition setup. Only used when format is 'radball'. */
  radball?: {
    ageCategory?: string;
    reducedTime?: boolean;
    minRestMinutes?: number;
    shootoutAttempts?: number;
    groupCount?: number;
    groups?: { name: string; teamIndexes: number[]; qualifies?: number; doubleRoundRobin?: boolean; fieldId?: string | null }[];
    doubleRoundRobin?: boolean;
    qualifies?: number;
    finalRound?: { topN?: number; mode?: string } | null;
    preset?: string | null;
    /** 10-team format: the host's recommended final-phase order. */
    finalOrder?: string[] | null;
  } | null;
}

/** Ids of all playing fields in canonical numeric order. */
export function fieldIdsOf(state: TournamentState): FieldId[] {
  return Object.keys(state.fields).sort(compareFieldIds);
}

/**
 * Map the command-level Radball setup (team indexes) onto created team ids.
 * Teams were just added in input order, so participantOrder mirrors the input.
 */
/** A field's display name, falling back to its id when it is not in the state. */
function fieldNameOf(state: TournamentState, fieldId: string | null | undefined): string {
  if (!fieldId) return 'no playing field';
  return state.fields[fieldId]?.name ?? `field ${fieldId}`;
}

function distributeQualifiers(total: number, groupSizes: number[]): number[] {
  let remaining = Math.max(0, Math.min(total, groupSizes.reduce((sum, size) => sum + size, 0)));
  const out = groupSizes.map(() => 0);
  while (remaining > 0) {
    for (let index = 0; index < out.length && remaining > 0; index += 1) {
      const slot = out[index];
      const size = groupSizes[index];
      // `out` was mapped from `groupSizes`, so both exist for every index.
      if (slot === undefined || size === undefined) continue;
      if (slot < size) {
        out[index] = slot + 1;
        remaining -= 1;
      }
    }
  }
  return out;
}

function buildRadballSetup(state: TournamentState, input: CreateTournamentInput): RadballSetup {
  const raw = input.radball ?? {};
  const teamIds = [...state.participantOrder];
  const doubleLeg = raw.doubleRoundRobin ?? false;
  const age: RadballAgeCategory = RADBALL_AGE_CATEGORIES.includes(raw.ageCategory as RadballAgeCategory)
    ? (raw.ageCategory as RadballAgeCategory)
    : 'ELITE';

  if (raw.preset === 'bdr-elite-2025') {
    return {
      ageCategory: age,
      reducedTime: raw.reducedTime ?? false,
      minRestMinutes: raw.minRestMinutes ?? 0,
      shootoutAttempts: raw.shootoutAttempts ?? 4,
      groups: [{ name: 'Group A', teamIds, qualifies: 4, doubleRoundRobin: false, fieldId: null }],
      finalRound: { mode: 'ranking-matches' },
      preset: 'bdr-elite-2025',
      tenTeam: null,
    };
  }

  if (raw.preset === 'radball-standard-2025') {
    return {
      ageCategory: age,
      reducedTime: raw.reducedTime ?? false,
      minRestMinutes: 0,
      shootoutAttempts: 4,
      groups: [{ name: 'Group A', teamIds, qualifies: 0, doubleRoundRobin: false, fieldId: null }],
      finalRound: null,
      preset: 'radball-standard-2025',
      tenTeam: null,
    };
  }

  // The 10-team format owns its split, and the split is the roster: a team
  // plays in the group of the field it was registered on, so Group A is field 1
  // and Group B is field 2. There is deliberately no separate group assignment --
  // it would be a second answer to a question the home field has already
  // answered, and the two could disagree.
  if (raw.preset === 'radball-10-team') {
    const fields = fieldIdsOf(state);
    if (fields.length < 2) {
      throw new EngineError(
        'BAD_REQUEST',
        'The World Cup format needs two playing fields: Group A on field 1 and Group B on field 2.',
      );
    }
    const [fieldA, fieldB] = fields;
    const groupA: string[] = [];
    const groupB: string[] = [];
    for (const id of teamIds) {
      const fieldId = state.participants[id]?.fieldId ?? null;
      if (fieldId === fieldA) groupA.push(id);
      else if (fieldId === fieldB) groupB.push(id);
      else {
        // Neither group can hold a team with no home field: it would have to be
        // put somewhere, and "somewhere" is exactly the assignment the format
        // does not have.
        throw new EngineError(
          'BAD_REQUEST',
          `${participantName(state, id)} is registered on ${
            fieldId ? `${state.fields[fieldId]?.name ?? `field ${fieldId}`}` : 'no playing field'
          }. The World Cup format plays one group per field: Group A takes the teams registered on ${
            fieldNameOf(state, fieldA)
          }, Group B those on ${fieldNameOf(state, fieldB)}.`,
        );
      }
    }
    // Two equal groups, one per field. The World Cup shape scales: two groups of
    // N have N-2 placement matches and decide all 2N places, so an equal group
    // size of at least two is the only requirement. Each group's size comes from
    // its own field, so the rule below is about the rosters the host typed.
    if (groupA.length !== groupB.length) {
      throw new EngineError(
        'BAD_REQUEST',
        `The World Cup format needs the same number of teams in both groups: ${fieldNameOf(
          state,
          fieldA,
        )} has ${groupA.length} and ${fieldNameOf(state, fieldB)} has ${groupB.length}.`,
      );
    }
    if (groupA.length < RADBALL_MIN_GROUP_SIZE) {
      throw new EngineError(
        'BAD_REQUEST',
        `Each group needs at least ${RADBALL_MIN_GROUP_SIZE} teams for a final phase; ${teamIds.length} teams give ${groupA.length} per group.`,
      );
    }
    return {
      ageCategory: age,
      reducedTime: raw.reducedTime ?? false,
      minRestMinutes: raw.minRestMinutes ?? 0,
      shootoutAttempts: raw.shootoutAttempts ?? 4,
      groups: [],
      finalRound: null,
      preset: 'radball-10-team',
      tenTeam: {
        groupA,
        groupB,
        // The two groups are pinned to the two fields, so both slots are set.
        groupFields: [fields[0] ?? '1', fields[1] ?? '2'],
        finalOrder: raw.finalOrder ?? null,
      },
    };
  }

  const finalMode: 'round-robin' | 'ranking-matches' =
    raw.finalRound?.mode === 'ranking-matches' ? 'ranking-matches' : 'round-robin';
  const finalRound = raw.finalRound ? { mode: finalMode } : null;
  const topN = typeof raw.finalRound?.topN === 'number' ? raw.finalRound.topN : null;

  let groups: RadballGroupSetup[];
  if (raw.groups && raw.groups.length > 0) {
    const teamGroups = raw.groups.map((group) =>
      group.teamIndexes.map((teamIndex) => {
        const id = teamIds[teamIndex];
        if (!id) throw new EngineError('BAD_REQUEST', `Group ${group.name} references an unknown team.`);
        return id;
      }),
    );
    const distributed = distributeQualifiers(
      topN ?? raw.qualifies ?? (finalMode === 'ranking-matches' ? 4 : finalRound ? 2 : 0),
      teamGroups.map((group) => group.length),
    );
    groups = raw.groups.map((group, index) => ({
      name: group.name?.trim() || `Group ${String.fromCharCode(65 + index)}`,
      // Both arrays were mapped from `raw.groups`, so index always resolves.
      teamIds: teamGroups[index] ?? [],
      qualifies: group.qualifies ?? distributed[index] ?? 0,
      doubleRoundRobin: group.doubleRoundRobin ?? doubleLeg,
      fieldId: group.fieldId ?? null,
    }));
  } else {
    const count = Math.max(1, Math.min(8, raw.groupCount ?? 1));
    const perGroup = Math.ceil(teamIds.length / count);
    const slices: string[][] = [];
    for (let index = 0; index < count; index += 1) {
      const slice = teamIds.slice(index * perGroup, (index + 1) * perGroup);
      if (slice.length === 0) break;
      slices.push(slice);
    }
    const distributed = distributeQualifiers(
      topN ?? raw.qualifies ?? (finalMode === 'ranking-matches' ? 4 : finalRound ? 2 : 0),
      slices.map((slice) => slice.length),
    );
    groups = slices.map((slice, index) => ({
      name: count > 1 ? `Group ${String.fromCharCode(65 + index)}` : 'Group A',
      teamIds: slice,
      qualifies: distributed[index] ?? 0,
      doubleRoundRobin: doubleLeg,
      fieldId: null,
    }));
  }

  return {
    ageCategory: age,
    reducedTime: raw.reducedTime ?? false,
    minRestMinutes: raw.minRestMinutes ?? 0,
    shootoutAttempts: raw.shootoutAttempts ?? 4,
    groups,
    finalRound,
    preset: null,
    tenTeam: null,
  };
}

/**
 * Apply a new set of playing-field names (which also defines the field
 * count). Existing fields keep their match assignment and operator lock;
 * removing a field that still has a match on it is refused.
 */
export function setFieldNames(state: TournamentState, names: string[], mut: Mutation): void {
  if (names.length < MIN_FIELDS || names.length > MAX_FIELDS) {
    throw new EngineError('BAD_REQUEST', `A tournament needs ${MIN_FIELDS}..${MAX_FIELDS} playing fields.`);
  }
  const trimmed = names.map((name) => name.trim());
  if (trimmed.some((name) => name.length === 0 || name.length > 24)) {
    throw new EngineError('BAD_REQUEST', 'Field names must be 1-24 characters.');
  }
  const next: TournamentState['fields'] = {};
  trimmed.forEach((name, index) => {
    const id = String(index + 1);
    const existing = state.fields[id];
    next[id] = existing ? { ...existing, name } : createField(id, name);
    mut.fields.add(id);
  });
  for (const id of Object.keys(state.fields)) {
    if (!next[id]) {
      const removed = state.fields[id];
      if (removed?.matchId) {
        throw new EngineError(
          'FIELD_BUSY',
          `${removed.name} still has a match on it. Clear the field before removing it.`,
        );
      }
      mut.fields.add(id);
    }
  }
  state.fields = next;
  state.settings.fieldNames = [...trimmed];
  mut.settings = true;
  mut.urgency = 'immediate';
}

export function createTournament(
  state: TournamentState,
  input: CreateTournamentInput,
  ctx: Ctx,
  mut: Mutation,
): Tournament {
  const draft = structuredClone(state);
  const tournament = buildTournament(draft, input, ctx, mut);
  Object.assign(state, draft);
  return tournament;
}

function buildTournament(
  state: TournamentState,
  input: CreateTournamentInput,
  ctx: Ctx,
  mut: Mutation,
): Tournament {
  if (input.participants.length > MAX_PARTICIPANTS) {
    throw new EngineError('BAD_REQUEST', `A tournament can hold at most ${MAX_PARTICIPANTS} participants.`);
  }
  clearLiveState(state, mut);

  const tournament: Tournament = {
    id: ctx.newId('t'),
    name: input.name,
    format: input.format,
    status: 'DRAFT',
    // The manual format has no bracket, so there is no power of two to round up
    // to: the size is the roster the host typed, and `rounds` counts the labels
    // they gave their fixtures. Both are filled in by the schedule builder.
    bracketSize: input.format === 'manual-schedule'
      ? Math.max(2, input.participants.length)
      : nextPowerOfTwo(Math.max(2, input.participants.length)),
    rounds: 0,
    thirdPlaceMatch: input.thirdPlaceMatch && input.format === 'single-elimination',
    seeded: input.seeded,
    seedValue: input.seedValue,
    createdAt: ctx.now,
    startedAt: null,
    completedAt: null,
    championId: null,
  };
  state.tournament = tournament;
  mut.tournament = true;

  if (input.fieldNames) {
    setFieldNames(state, input.fieldNames, mut);
  }

  for (const raw of input.participants) {
    addParticipant(state, raw, ctx, mut);
  }
  if (input.settings) {
    Object.assign(state.settings, input.settings);
  }
  state.settings.tournamentName = input.name;
  if (input.format === 'radball') state.settings.allowDraws = true;
  mut.settings = true;

  pushEvent(mut, 'TOURNAMENT_UPDATED', {
    key: 'event.tournamentCreated',
    params: { name: tournament.name, n: input.participants.length },
  });

  if (input.format === 'radball') {
    createRadballCompetition(state, buildRadballSetup(state, input), ctx, mut);
    autoAssign(state, ctx, mut);
    mut.urgency = 'immediate';
    return tournament;
  }

  // The manual format stores its fixtures rather than deriving them. Everything
  // downstream -- scoring, timers, fields, the board -- is the ordinary match
  // pipeline; only the "where do the matches come from" step differs.
  if (input.format === 'manual-schedule') {
    createManualSchedule(state, manualScheduleEntries(state, input.manualMatches ?? []), ctx, mut);
    mut.urgency = 'immediate';
    return tournament;
  }

  if (input.generateBracketNow) {
    let order: (string | null)[] | null = null;
    if (input.manualOrder) {
      const expected = nextPowerOfTwo(Math.max(2, input.participants.length));
      if (input.manualOrder.length !== expected) {
        throw new EngineError(
          'BAD_REQUEST',
          `A manual bracket for ${input.participants.length} participants needs exactly ${expected} slots.`,
        );
      }
      order = input.manualOrder.map((index) =>
        index === null ? null : (state.participantOrder[index] ?? null),
      );
      if (order.some((id) => id !== null && !state.participants[id as string])) {
        throw new EngineError('BAD_REQUEST', 'The manual bracket references an unknown participant.');
      }
    }
    generateBracketForTournament(
      state,
      {
        seeded: input.seeded,
        seedValue: input.seedValue,
        thirdPlaceMatch: tournament.thirdPlaceMatch,
        order,
      },
      ctx,
      mut,
    );
  }
  mut.urgency = 'immediate';
  return tournament;
}

function clearLiveState(state: TournamentState, mut: Mutation): void {
  const previousFields = state.fields;
  for (const id of Object.keys(state.matches)) {
    delete state.matches[id];
    mut.removedMatchIds.push(id);
  }
  for (const id of Object.keys(state.participants)) {
    delete state.participants[id];
    mut.removedParticipantIds.push(id);
  }
  state.matchOrder = [];
  state.participantOrder = [];
  state.tournament = null;
  state.radball = null;
  state.events = [];
  mut.radball = true;
  // Keep whatever field setup the host configured (names + count); fall back
  // to the settings when a field is new.
  const names = state.settings.fieldNames.length > 0 ? state.settings.fieldNames : ['Field 1', 'Field 2'];
  const next: TournamentState['fields'] = {};
  names.forEach((name, index) => {
    const id = String(index + 1);
    next[id] = {
      ...(previousFields[id] ?? createField(id, name)),
      name,
      matchId: null,
      controlledBy: null,
      controlledSince: null,
    };
    mut.fields.add(id);
  });
  for (const id of Object.keys(previousFields)) {
    if (!next[id]) mut.fields.add(id);
  }
  state.fields = next;
  mut.matchOrder = [];
  mut.participantOrder = [];
  mut.tournament = true;
}

export interface GenerateOptions {
  seeded: boolean;
  seedValue: number | null;
  thirdPlaceMatch: boolean;
  order: (string | null)[] | null;
}

/**
 * Seed the bracket so every playing field's players stay in their own block:
 * the rosters are grouped by the field they were registered on (field order,
 * then the players without a home field) and each block is seeded inside
 * itself. Without home fields this is exactly the classic seeded draw.
 */
function seedSlotsForFields(
  state: TournamentState,
  seeded: string[],
  size: number,
): (string | null)[] {
  const byField = new Map<string, string[]>();
  const homeless: string[] = [];
  for (const id of seeded) {
    const fieldId = state.participants[id]?.fieldId ?? null;
    if (!fieldId || !state.fields[fieldId]) {
      homeless.push(id);
      continue;
    }
    const list = byField.get(fieldId);
    if (list) list.push(id);
    else byField.set(fieldId, [id]);
  }
  const groups: SeedGroup[] = [];
  for (const fieldId of Object.keys(state.fields).sort(compareFieldIds)) {
    const ids = byField.get(fieldId);
    if (ids && ids.length > 0) groups.push({ participantIds: ids });
  }
  if (homeless.length > 0) groups.push({ participantIds: homeless });
  return seedSlotsByField(groups, size);
}

export function generateBracketForTournament(
  state: TournamentState,
  options: GenerateOptions,
  ctx: Ctx,
  mut: Mutation,
): void {
  const tournament = requireTournament(state);
  // A manual schedule is typed, not drawn. Re-rolling a bracket over it would
  // throw away every fixture the host wrote down and replace them with ones
  // nobody asked for, so the command is refused rather than merely hidden from
  // the dashboard.
  if (tournament.format === 'manual-schedule') {
    throw new EngineError(
      'BAD_REQUEST',
      'A manual schedule has no draw to regenerate. Edit its fixtures instead.',
    );
  }

  for (const id of Object.keys(state.matches)) {
    delete state.matches[id];
    mut.removedMatchIds.push(id);
  }
  state.matchOrder = [];

  const size = nextPowerOfTwo(Math.max(2, orderedParticipants(state).filter((p) => p.checkedIn).length));
  if (size < 2) {
    throw new EngineError('BAD_REQUEST', 'At least two checked-in participants are required to build a bracket.');
  }
  if (size > 512) {
    throw new EngineError('BAD_REQUEST', 'Bracket size would exceed 512 slots.');
  }

  let slots: (string | null)[];
  if (options.order && options.order.length === size) {
    slots = options.order.map((id) => (id && state.participants[id] ? id : null));
  } else {
    const seeded = seedParticipantList(state, { seeded: options.seeded, seedValue: options.seedValue });
    slots = seedSlotsForFields(state, seeded, size);
  }

  const generated = generateBracket({
    tournamentId: tournament.id,
    slots,
    doubleElimination: tournament.format === 'double-elimination',
    thirdPlaceMatch: options.thirdPlaceMatch && tournament.format === 'single-elimination',
  });

  for (const match of toMatches(tournament.id, generated.matches, state.settings)) {
    state.matches[match.id] = match;
  }
  state.matchOrder = [...generated.order];
  mut.matchOrder = [...state.matchOrder];
  for (const id of Object.keys(state.matches)) mut.matches.add(id);

  tournament.bracketSize = generated.size;
  tournament.rounds = generated.rounds;
  tournament.thirdPlaceMatch = options.thirdPlaceMatch && tournament.format === 'single-elimination';
  tournament.seeded = options.seeded;
  tournament.seedValue = options.seedValue;
  tournament.status = 'RUNNING';
  tournament.startedAt = tournament.startedAt ?? ctx.now;
  tournament.completedAt = null;
  tournament.championId = null;
  mut.tournament = true;

  pushEvent(mut, 'BRACKET_GENERATED', {
    key: 'event.bracketGenerated',
    params: { slots: generated.size, rounds: generated.rounds, matches: generated.matches.length },
  });

  resolveBracket(state, ctx, mut);
  // Pre-load the opening round: every free field picks up the first match it
  // owns, so each operator has their own match waiting when the event starts.
  autoAssign(state, ctx, mut);
  finaliseTournament(state, ctx, mut);
  mut.urgency = 'immediate';
}

/* ------------------------------------------------------------------ */
/* Manual schedule                                                     */
/* ------------------------------------------------------------------ */

/** What the engine needs to know about one hand-written fixture. */
export interface ManualScheduleEntry {
  participantAId: string;
  participantBId: string;
  roundName?: string | null;
  fieldId?: string | null;
}

/**
 * Resolve the wizard's fixture indexes onto the participants that were just
 * created.
 *
 * The participants were added in input order, so `participantOrder` mirrors the
 * array the indexes were written against -- the same assumption
 * `buildRadballSetup` makes for its group splits. An out-of-range index is a
 * malformed payload rather than a state problem, and is refused here so the host
 * hears about it while the roster is still on screen.
 */
function manualScheduleEntries(
  state: TournamentState,
  fixtures: { a: number; b: number; round?: string | null; fieldId?: string | null }[],
): ManualScheduleEntry[] {
  return fixtures.map((fixture) => {
    const a = state.participantOrder[fixture.a];
    const b = state.participantOrder[fixture.b];
    if (!a || !b) {
      throw new EngineError('BAD_REQUEST', 'A manual match references an unknown participant.');
    }
    return {
      participantAId: a,
      participantBId: b,
      roundName: fixture.round ?? null,
      fieldId: fixture.fieldId ?? null,
    };
  });
}

/**
 * Pre-load the free fields of a manual schedule.
 *
 * `autoAssign` refuses a fixture whose team is already on another field, which is
 * right for a bracket -- there a team has exactly one fixture at a time -- and
 * wrong here: the host may schedule the same team twice, and creating the event
 * must not fail because of it. So the pre-load walks the queue in the host's
 * order and takes the first fixture that fits, the way `nextSchedulableMatch`
 * already does for Radball whenever a team is still busy on the other ring.
 *
 * A field left empty by this is not a bug: it means every remaining fixture
 * needs a team that is already playing, and the queue is where it waits.
 */
function preloadManualSchedule(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  const candidates = state.matchOrder
    .map((id) => state.matches[id])
    .filter((match): match is Match => Boolean(match));
  for (const fieldId of fieldIdsOf(state)) {
    const field = state.fields[fieldId];
    if (!field || field.matchId) continue;
    const next = candidates.find(
      (match) =>
        match.state === 'READY' &&
        !match.fieldId &&
        Boolean(match.participantAId && match.participantBId) &&
        !matchTeamsBusy(state, match, fieldId),
    );
    if (next) assignMatchToField(state, next.id, fieldId, ctx, mut);
  }
}

/** True when one of this match's teams already sits on a different playing field. */
function matchTeamsBusy(state: TournamentState, match: Match, target: FieldId): boolean {
  const teams = [match.participantAId, match.participantBId].filter((id): id is string => Boolean(id));
  if (teams.length === 0) return false;
  return Object.values(state.matches).some(
    (other) =>
      other.id !== match.id &&
      other.fieldId !== null &&
      other.fieldId !== target &&
      teams.some((team) => other.participantAId === team || other.participantBId === team),
  );
}

/**
 * Put the host's fixtures on the board, replacing whatever was there.
 *
 * Called at creation with the whole list, and reached by nothing else: a running
 * manual schedule is edited one fixture at a time through `addManualMatch` and
 * friends, because a host who has already started scoring must never have their
 * schedule rebuilt underneath them.
 */
export function createManualSchedule(
  state: TournamentState,
  entries: ManualScheduleEntry[],
  ctx: Ctx,
  mut: Mutation,
): void {
  const tournament = requireTournament(state);
  clearMatches(state, mut);

  const fixtures: ManualFixture[] = [];
  for (const entry of entries) {
    for (const id of [entry.participantAId, entry.participantBId]) {
      if (!state.participants[id]) {
        throw new EngineError('PARTICIPANT_NOT_FOUND', 'That participant no longer exists.');
      }
    }
    if (entry.participantAId === entry.participantBId) {
      throw new EngineError('BAD_REQUEST', 'A team cannot be scheduled against itself.');
    }
    if (entry.fieldId && !state.fields[entry.fieldId]) {
      throw new EngineError('BAD_REQUEST', `Playing field ${entry.fieldId} does not exist.`);
    }
    fixtures.push({
      participantAId: entry.participantAId,
      participantBId: entry.participantBId,
      roundName: entry.roundName ?? '',
      fieldId: entry.fieldId ?? null,
    });
  }

  const generated = generateManualSchedule(tournament.id, fixtures);
  const created: Match[] = toMatches(tournament.id, generated, state.settings);
  // The generator is deliberately shape-only (rounds, positions, slot wiring);
  // the field the host pinned a fixture to is data, so it travels beside it.
  created.forEach((match, index) => {
    match.fieldId = fixtures[index]?.fieldId ?? null;
    state.matches[match.id] = match;
  });
  state.matchOrder = generated.map((m) => m.id);
  mut.matchOrder = [...state.matchOrder];
  for (const id of state.matchOrder) mut.matches.add(id);

  tournament.rounds = Math.max(1, generated.reduce((max, m) => Math.max(max, m.round + 1), 0));
  tournament.status = 'RUNNING';
  tournament.startedAt = tournament.startedAt ?? ctx.now;
  tournament.completedAt = null;
  tournament.championId = null;
  mut.tournament = true;

  // A fixture the host pinned to a field is pinned on purpose, so the pin is
  // honoured and only the still-free fields are filled from the queue.
  const pinned = new Set<FieldId>();
  for (const match of Object.values(state.matches)) {
    const fieldId = match.fieldId;
    if (!fieldId || pinned.has(fieldId)) continue;
    const field = state.fields[fieldId];
    if (!field || field.matchId) continue;
    match.state = 'READY';
    field.matchId = match.id;
    mut.fields.add(fieldId);
    pinned.add(fieldId);
    touchMatch(mut, match.id);
    pushEvent(
      mut,
      'MATCH_ASSIGNED',
      { key: 'event.matchAssigned', params: { round: match.roundName, field: field.name } },
      { fieldId, matchId: match.id },
    );
  }

  resolveBracket(state, ctx, mut);
  preloadManualSchedule(state, ctx, mut);
  pushEvent(mut, 'SCHEDULE_CREATED', {
    key: 'event.scheduleCreated',
    params: { n: generated.length },
  });
  mut.urgency = 'immediate';
}

/** Drop every match, leaving the queue empty and the fields clear. */
function clearMatches(state: TournamentState, mut: Mutation): void {
  for (const id of Object.keys(state.matches)) {
    const match = state.matches[id];
    if (!match) continue;
    if (match.fieldId && state.fields[match.fieldId]?.matchId === id) {
      const field = state.fields[match.fieldId];
      if (field) field.matchId = null;
      mut.fields.add(match.fieldId);
    }
    delete state.matches[id];
    mut.removedMatchIds.push(id);
  }
  state.matchOrder = [];
  mut.matchOrder = [];
}

/**
 * Add one fixture to a running manual schedule.
 *
 * The new match goes on the end of the host's queue, which is where they put it,
 * and takes a field only if one is free -- a host who has two matches running
 * does not want their new fixture stealing a ring from either.
 */
export function addManualMatch(
  state: TournamentState,
  entry: ManualScheduleEntry,
  ctx: Ctx,
  mut: Mutation,
): Match {
  const tournament = requireTournament(state);
  if (tournament.format !== 'manual-schedule') {
    throw new EngineError(
      'BAD_REQUEST',
      'This format builds its own fixtures from the draw. Only a manual schedule can be extended by hand.',
    );
  }
  for (const id of [entry.participantAId, entry.participantBId]) {
    if (!state.participants[id]) {
      throw new EngineError('PARTICIPANT_NOT_FOUND', 'That participant no longer exists.');
    }
  }
  if (entry.participantAId === entry.participantBId) {
    throw new EngineError('BAD_REQUEST', 'A team cannot be scheduled against itself.');
  }
  if (Object.keys(state.matches).length >= MAX_MANUAL_MATCHES) {
    throw new EngineError('BAD_REQUEST', `A manual schedule holds at most ${MAX_MANUAL_MATCHES} matches.`);
  }
  // Two ids can collide only if a fixture was removed and the counter rewound,
  // which no code path does -- but a duplicate id would silently overwrite a
  // live match, so the guard is worth the line.
  let index = 0;
  let id = manualMatchId(tournament.id, index);
  while (state.matches[id]) {
    index += 1;
    id = manualMatchId(tournament.id, index);
  }

  const roundName = entry.roundName?.trim() || `Match ${index + 1}`;
  const generated: GeneratedMatch = {
    id,
    round: 0,
    roundName,
    position: 0,
    bracketSlot: 0,
    bracket: 'winners',
    isThirdPlace: false,
    isGrandFinal: false,
    slotA: { kind: 'participant', participantId: entry.participantAId },
    slotB: { kind: 'participant', participantId: entry.participantBId },
    nextWinMatchId: null,
    nextWinSlot: null,
    nextLoseMatchId: null,
    nextLoseSlot: null,
  };
  const [match] = toMatches(tournament.id, [generated], state.settings);
  if (!match) {
    throw new EngineError('INVALID_STATE', 'The schedule could not create that match.');
  }
  // The match is created, not derived, so it is never re-resolved from a feeder:
  // its two sides are the two teams the host picked, permanently.
  match.locked = true;

  state.matches[id] = match;
  state.matchOrder.push(id);
  mut.matchOrder = [...state.matchOrder];
  mut.matches.add(id);

  const fieldId = entry.fieldId ?? null;
  if (fieldId && state.fields[fieldId] && !state.fields[fieldId].matchId && !matchTeamsBusy(state, match, fieldId)) {
    assignMatchToField(state, id, fieldId, ctx, mut);
  } else {
    match.state = 'READY';
    touchMatch(mut, id);
    preloadManualSchedule(state, ctx, mut);
  }

  tournament.rounds = Math.max(
    tournament.rounds,
    state.matchOrder.reduce((max, matchId) => {
      const m = state.matches[matchId];
      return Math.max(max, (m?.round ?? 0) + 1);
    }, 0),
  );
  mut.tournament = true;

  pushEvent(mut, 'MATCH_ADDED', {
    key: 'event.matchAdded',
    params: {
      a: participantName(state, entry.participantAId),
      b: participantName(state, entry.participantBId),
      round: match.roundName,
    },
  }, { matchId: id });
  mut.urgency = 'immediate';
  return match;
}

/**
 * Take one fixture back out of a manual schedule.
 *
 * Only the derived formats keep a fixture alive: in a bracket the match is a
 * consequence of the draw, and cancelling it is how the engine already says
 * "this slot will never be filled". A manual fixture is an entry on a list the
 * host typed, so removing the entry is the honest undo -- and it is refused for
 * a fixture that is currently on a field, because an operator holding a live
 * clock must not have the match vanish underneath them.
 */
export function removeManualMatch(
  state: TournamentState,
  matchId: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const tournament = requireTournament(state);
  if (tournament.format !== 'manual-schedule') {
    throw new EngineError(
      'BAD_REQUEST',
      'This format builds its own fixtures from the draw. Only a manual schedule can be shortened by hand.',
    );
  }
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME') {
    throw new EngineError('INVALID_STATE', 'Reset the match before removing it from the schedule.');
  }
  const removed = {
    a: participantName(state, match.participantAId),
    b: participantName(state, match.participantBId),
    round: match.roundName,
  };

  if (match.fieldId && state.fields[match.fieldId]?.matchId === matchId) {
    const field = state.fields[match.fieldId];
    if (field) field.matchId = null;
    mut.fields.add(match.fieldId);
  }
  // Nothing in a manual schedule feeds anything, so no other fixture can name
  // this one as a source. Clearing the pointers anyway keeps the invariant true
  // even if a future format reuses these ids.
  for (const other of Object.values(state.matches)) {
    if (other.nextWinMatchId === matchId) {
      other.nextWinMatchId = null;
      other.nextWinSlot = null;
      touchMatch(mut, other.id);
    }
    if (other.nextLoseMatchId === matchId) {
      other.nextLoseMatchId = null;
      other.nextLoseSlot = null;
      touchMatch(mut, other.id);
    }
  }

  delete state.matches[matchId];
  state.matchOrder = state.matchOrder.filter((id) => id !== matchId);
  mut.matchOrder = [...state.matchOrder];
  mut.removedMatchIds.push(matchId);

  resolveBracket(state, ctx, mut);
  preloadManualSchedule(state, ctx, mut);
  pushEvent(mut, 'MATCH_REMOVED', { key: 'event.matchRemoved', params: removed });
  mut.urgency = 'immediate';
}

/**
 * Rename the round or stage a fixture belongs to.
 *
 * Renaming renumbers the round it lands in against the labels that remain, so a
 * schedule of "Group A / Group A / Final" stays two rounds whoever is spelled
 * how. The queue order is the host's own and is left alone.
 */
export function setManualMatchRoundName(
  state: TournamentState,
  matchId: string,
  roundName: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const tournament = requireTournament(state);
  if (tournament.format !== 'manual-schedule') {
    throw new EngineError('BAD_REQUEST', 'Only a manual schedule has rounds the host named.');
  }
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME') {
    throw new EngineError('INVALID_STATE', 'Reset the match before renaming its round.');
  }
  const before = match.roundName;
  match.roundName = roundName;
  touchMatch(mut, matchId);

  // Renumber: first label seen wins round 0, the next new one round 1, and so
  // on. Matches keep their relative order, so the queue only ever gains or loses
  // a boundary rather than being reshuffled.
  const roundOf = new Map<string, number>();
  let highest = 0;
  for (const id of state.matchOrder) {
    const m = state.matches[id];
    if (!m) continue;
    const label = m.roundName || `Match ${id}`;
    let round = roundOf.get(label);
    if (round === undefined) {
      round = roundOf.size;
      roundOf.set(label, round);
    }
    m.round = round;
    highest = Math.max(highest, round + 1);
  }
  tournament.rounds = Math.max(1, highest);
  mut.tournament = true;

  resolveBracket(state, ctx, mut);
  pushEvent(mut, 'BRACKET_UPDATED', {
    key: 'event.matchRoundRenamed',
    params: { round: before, name: roundName },
  }, { matchId });
  void ctx;
  mut.urgency = 'immediate';
}

export function updateTournament(
  state: TournamentState,
  patch: { name?: string; thirdPlaceMatch?: boolean },
  mut: Mutation,
): void {
  const tournament = requireTournament(state);
  if (patch.name !== undefined) {
    tournament.name = patch.name;
    state.settings.tournamentName = patch.name;
    mut.settings = true;
  }
  if (patch.thirdPlaceMatch !== undefined) {
    tournament.thirdPlaceMatch = patch.thirdPlaceMatch;
  }
  mut.tournament = true;
  pushEvent(mut, 'TOURNAMENT_UPDATED', { key: 'event.tournamentDetails' });
  mut.urgency = 'immediate';
}

export function resetTournament(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  requireTournament(state);
  for (const match of Object.values(state.matches)) {
    match.scoreA = 0;
    match.scoreB = 0;
    match.state = 'WAITING';
    match.winnerId = null;
    match.loserId = null;
    match.startedAt = null;
    match.finishedAt = null;
    match.timer = createTimerState(state.settings.timerMode, state.settings.defaultMatchDurationSec);
    match.history = [];
    match.redoStack = [];
    match.fieldId = null;
    if (match.radball?.shootout) match.radball.shootout = null;
    mut.matches.add(match.id);
  }
  for (const id of Object.keys(state.fields)) {
    const field = state.fields[id];
    if (field) field.matchId = null;
    mut.fields.add(id);
  }
  const tournament = state.tournament as Tournament;
  tournament.status = 'RUNNING';
  tournament.championId = null;
  tournament.completedAt = null;
  mut.tournament = true;

  // The 10-team format keeps its final-phase matches alive across a reset, but
  // only as *unplayed* matches with empty references. Their existence is part of
  // the format, not part of the results, so removing them would take the
  // documented structure with it. The published group rankings are dropped and
  // the phase un-confirmed, so the six matches fall back to "waiting" until both
  // groups are genuinely finished again -- which is what §2 means by releasing
  // the groups on an explicit reset.
  if (state.radball?.ten) {
    state.radball.ten.final.status = 'PENDING';
    state.radball.ten.final.confirmed = false;
    state.radball.ten.rankings = {};
    state.radball.ten.groupFrozen = {};
    pushEvent(mut, 'TOURNAMENT_UPDATED', { key: 'event.resultsResetFinalPhase' });
  }

  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  pushEvent(mut, 'TOURNAMENT_UPDATED', { key: 'event.resultsReset' });
  rebuild(state, ctx, mut);
  // `rebuild` only walks the knockout bracket. A Radball competition owns its own
  // downstream -- standings, rankings, places -- so it has to be re-derived here
  // or a reset would leave the old tables standing next to zeroed scores.
  recalculateRadball(state, ctx, mut);
  mut.urgency = 'immediate';
}

export function setMatchParticipants(
  state: TournamentState,
  matchId: string,
  participantAId: string | null,
  participantBId: string | null,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME' || match.state === 'FINISHED') {
    throw new EngineError('INVALID_STATE', 'Reset the match before changing its participants.');
  }
  for (const id of [participantAId, participantBId]) {
    if (id && !state.participants[id]) {
      throw new EngineError('PARTICIPANT_NOT_FOUND', 'One of the selected participants no longer exists.');
    }
  }
  if (participantAId && participantAId === participantBId) {
    throw new EngineError('BAD_REQUEST', 'A participant cannot play against themselves.');
  }
  match.participantAId = participantAId;
  match.participantBId = participantBId;
  match.locked = true;
  match.state = participantAId && participantBId ? 'READY' : 'WAITING';
  touchMatch(mut, matchId);
  pushEvent(
    mut,
    'BRACKET_UPDATED',
    { key: 'event.bracketOverride', params: { round: match.roundName } },
    { matchId },
  );
  void ctx;
}

export function setBracketSlot(
  state: TournamentState,
  matchId: string,
  slot: 'A' | 'B',
  participantId: string | null,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME' || match.state === 'FINISHED') {
    throw new EngineError('INVALID_STATE', 'Reset the match before editing the bracket slot.');
  }
  if (participantId && !state.participants[participantId]) {
    throw new EngineError('PARTICIPANT_NOT_FOUND', 'That participant no longer exists.');
  }
  const otherCurrent = slot === 'A' ? match.participantBId : match.participantAId;
  if (participantId && participantId === otherCurrent) {
    throw new EngineError('BAD_REQUEST', 'That participant already occupies the other slot.');
  }
  if (slot === 'A') {
    match.participantAId = participantId;
    match.slotA = participantId ? { kind: 'participant', participantId } : { kind: 'bye' };
  } else {
    match.participantBId = participantId;
    match.slotB = participantId ? { kind: 'participant', participantId } : { kind: 'bye' };
  }
  match.locked = true;
  match.state = match.participantAId && match.participantBId ? 'READY' : 'WAITING';
  touchMatch(mut, matchId);
  pushEvent(
    mut,
    'BRACKET_UPDATED',
    { key: 'event.bracketSlotEdited', params: { slot, round: match.roundName } },
    { matchId },
  );
  void ctx;
}

export { requireTournament };
