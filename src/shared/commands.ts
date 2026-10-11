/**
 * Command catalogue. Every mutation coming from a browser goes through one of
 * these commands. Each entry declares the permission it needs and validates its
 * own payload shape. Semantic validation (does the match exist, is the field
 * free, ...) happens inside the tournament engine.
 */
import type { RadballAgeCategory, TournamentFormat } from './types';
import {
  MAX_FIELDS,
  MAX_MANUAL_MATCHES,
  MIN_FIELDS,
  RADBALL_FINAL_KEYS,
  isDisplayScreen,
  isFieldId,
  isRadballAgeCategory,
} from './types';
import {
  asBool,
  asFieldId,
  asInt,
  asNumber,
  asString,
  asMatchState,
  invalid,
  isRecord,
  valid,
  type ValidationResult,
} from './protocol';

export type Permission = 'admin' | 'operator' | 'none';

export interface ParticipantInput {
  name: string;
  team: string | null;
  seed: number | null;
  checkedIn: boolean;
  /** Home field id ('1', '2', ...) or null. Optional, defaults to null. */
  fieldId?: string | null;
  /** The two players of a 2er-Radball team. Required in Radball mode. */
  players?: [string, string] | null;
  /** Logo file name from the host's logos folder. Optional; absent means default. */
  logo?: string | null;
}

export interface RadballGroupInput {
  name: string;
  teamIndexes: number[];
  qualifies?: number;
  doubleRoundRobin?: boolean;
  fieldId?: string | null;
}

export interface RadballCreateInput {
  ageCategory?: string;
  reducedTime?: boolean;
  minRestMinutes?: number;
  shootoutAttempts?: number;
  groupCount?: number;
  groups?: RadballGroupInput[];
  doubleRoundRobin?: boolean;
  qualifies?: number;
  finalRound?: { topN?: number; mode?: string } | null;
  preset?: string | null;
  /** 10-team format: the host's recommended order for the final phase. */
  finalOrder?: string[] | null;
}

export interface CreateTournamentInput {
  name: string;
  format: TournamentFormat;
  participants: ParticipantInput[];
  thirdPlaceMatch: boolean;
  seeded: boolean;
  seedValue: number | null;
  settings: NullableSettings;
  /** Playing-field display names (1..MAX_FIELDS entries, default: two fields). */
  fieldNames?: string[];
  confirmReplace?: boolean;
  expectedTournamentId?: string | null;
  /**
   * Manual bracket placement: one entry per bracket slot, each either an index
   * into `participants` or null for a bye. When omitted the bracket is drawn
   * automatically (seeded or random).
   */
  manualOrder?: (number | null)[] | null;
/**
 * The fixtures of a manual schedule, in the host's own order. Only read when
 * the format is `manual-schedule`; every other format derives its matches from
 * the roster and would ignore this.
 */
manualMatches?: ManualMatchInput[] | null;
/** Radball competition setup. Only used when format is 'radball'. */
radball?: RadballCreateInput | null;
}

/**
 * One fixture the host wrote down for a manual schedule.
 *
 * Both sides are indexes into the same `participants` array the rest of the
 * create payload uses -- the same convention as `manualOrder`, because both are
 * answers to "who plays whom" asked before any participant has an id. Neither
 * side may be null: a fixture with a missing side is a bye, and a bye is
 * something the engine hands out, not something a host types.
 */
export interface ManualMatchInput {
  a: number;
  b: number;
  /** Round or stage label, e.g. "Group stage" or "Final". */
  round?: string | null;
  /** Pinned playing field ('1'..'8'), or null to let the host assign later. */
  fieldId?: string | null;
}

export type NullableSettings = Record<string, unknown> | null;

/** A squad as the library stores it, before it becomes a tournament participant. */
export interface LibraryTeamInput {
  name: string;
  club: string | null;
  players: [string, string];
  ageCategory: RadballAgeCategory;
  /** Logo file name from the host's logos folder, or null for the default. */
  logo: string | null;
}

export interface CommandSpec {
  permission: Permission;
  /** Operator commands are restricted to the field the session owns. */
  fieldScoped: boolean;
  /** Operator commands that do not target a field still need a field scope. */
  validate: (payload: unknown) => ValidationResult<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function obj(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {};
}

function reqId(payload: Record<string, unknown>, key: string, max = 64): string | null {
  return asString(payload[key], max);
}

function parseParticipantInput(raw: unknown): ValidationResult<ParticipantInput> {
  if (typeof raw === 'string') {
    const name = asString(raw, 60);
    if (!name) return invalid('Participant name must be 1-60 characters');
    return valid({ name, team: null, seed: null, checkedIn: true });
  }
  if (!isRecord(raw)) return invalid('Participant must be a string or an object');
  const name = asString(raw.name, 60);
  if (!name) return invalid('Participant name must be 1-60 characters');
  const team = raw.team === undefined || raw.team === null ? null : asString(raw.team, 60);
  if (raw.team !== undefined && raw.team !== null && team === null) {
    return invalid('Participant team must be 1-60 characters');
  }
  let seed: number | null = null;
  if (raw.seed !== undefined && raw.seed !== null && raw.seed !== '') {
    seed = asInt(raw.seed, 1, 4096);
    if (seed === null) return invalid('Participant seed must be a positive integer');
  }
  let checkedIn = true;
  if (raw.checkedIn !== undefined && raw.checkedIn !== null) {
    const b = asBool(raw.checkedIn);
    if (b === null) return invalid('Participant checkedIn must be a boolean');
    checkedIn = b;
  }
  let fieldId: string | null = null;
  if (raw.fieldId !== undefined && raw.fieldId !== null && raw.fieldId !== '') {
    const parsed = String(raw.fieldId);
    if (!isFieldId(parsed)) return invalid('Participant fieldId must be a playing field ("1".."8")');
    fieldId = parsed;
  }
  let players: [string, string] | null = null;
  if (raw.players !== undefined && raw.players !== null) {
    if (!Array.isArray(raw.players) || raw.players.length !== 2) {
      return invalid('A Radball team needs exactly two player names. Use team name, player 1, player 2.');
    }
    const first = asString(raw.players[0], 60);
    const second = asString(raw.players[1], 60);
    if (!first || !second) return invalid('Enter both player names in columns 2 and 3: team name, player 1, player 2.');
    if (first.toLowerCase() === second.toLowerCase()) {
      return invalid('Player 1 and player 2 must be different people.');
    }
    players = [first, second];
  }
  return valid({ name, team, seed, checkedIn, fieldId, players, logo: parseLogoName(raw.logo) });
}

function parseParticipantList(raw: unknown, max: number): ValidationResult<ParticipantInput[]> {
  if (!Array.isArray(raw)) return invalid('participants must be an array');
  if (raw.length > max) return invalid(`Too many participants (max ${max})`);
  const out: ParticipantInput[] = [];
  for (const entry of raw) {
    const parsed = parseParticipantInput(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  if (out.length === 0) return invalid('At least one participant is required');
  return valid(out);
}

const RADBALL_AGES = ['U11', 'U13', 'U15', 'U17', 'U19', 'U23', 'ELITE'];

const RADBALL_PRESETS = ['bdr-elite-2025', 'radball-standard-2025', 'radball-10-team'];

/**
 * Parse a list of final-phase keys. Keys rather than match types because there
 * are two semifinals and both are typed `SEMIFINAL` -- one key each, so no match
 * can be scheduled twice or dropped.
 */
function parseFinalKeyOrder(
  raw: unknown,
  max: number,
  allowed: readonly string[] = RADBALL_FINAL_KEYS,
): ValidationResult<string[] | null> {
  if (raw === undefined || raw === null) return valid(null);
  if (!Array.isArray(raw)) return invalid('finalOrder must be an array');
  if (raw.length > max) return invalid(`finalOrder may list at most ${max} matches`);
  const out: string[] = [];
  for (const entry of raw) {
    const key = asString(entry, 24);
    if (!key || !allowed.includes(key)) {
      return invalid(`finalOrder entries must be one of ${allowed.join(', ')}`);
    }
    if (out.includes(key)) return invalid(`finalOrder lists ${key} twice`);
    out.push(key);
  }
  return valid(out);
}

/**
 * Validate one library squad. Age group is required: filing a team under an age
 * group is the whole point of the library, and a guess is worse than asking.
 */
function parseLibraryTeamInput(raw: unknown): ValidationResult<LibraryTeamInput> {
  if (!isRecord(raw)) return invalid('A team must be an object');
  const name = asString(raw.name, 60);
  if (!name) return invalid('Team name must be 1-60 characters');
  let club: string | null = null;
  if (raw.club !== undefined && raw.club !== null && String(raw.club).trim() !== '') {
    club = asString(raw.club, 60);
    if (club === null) return invalid('The club must be 60 characters or fewer');
  }
  if (!Array.isArray(raw.players) || raw.players.length !== 2) {
    return invalid('A 2er team needs exactly two player names. Use team name, player 1, player 2.');
  }
  const first = asString(raw.players[0], 60);
  const second = asString(raw.players[1], 60);
  if (!first || !second) return invalid('Enter both player names in columns 3 and 4: team, club, player 1, player 2.');
  if (first.toLowerCase() === second.toLowerCase()) return invalid('Player 1 and player 2 must be different people.');
  if (!isRadballAgeCategory(raw.ageCategory)) {
    return invalid(`ageCategory must be one of ${RADBALL_AGES.join(', ')}`);
  }
  return valid({ name, club, players: [first, second], ageCategory: raw.ageCategory, logo: parseLogoName(raw.logo) });
}

/**
 * A logo is a bare file name from the host's own logos folder.
 *
 * Only a name is accepted, and only one without a path in it: the browser could
 * otherwise ask the host to store `../../../access.json` as a team's crest and
 * learn its contents through an `<img>` request. The server would refuse to
 * serve it, but the value would sit in the backup file and the roster, so it is
 * refused here where the host gets told why.
 */
export function parseLogoName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.length > 120) return null;
  if (/[\\/]/.test(value) || value === '.' || value === '..') return null;
  // Same extension set the logos folder serves, so an unrenderable crest is
  // caught by the host rather than by a broken image on the projector.
  if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(value)) return null;
  return value;
}

function parseLibraryTeamList(raw: unknown, max: number): ValidationResult<LibraryTeamInput[]> {
  if (!Array.isArray(raw)) return invalid('teams must be an array');
  if (raw.length > max) return invalid(`Too many teams (max ${max})`);
  const out: LibraryTeamInput[] = [];
  for (const entry of raw) {
    const parsed = parseLibraryTeamInput(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return valid(out);
}

/**
 * Validate the Radball competition setup that travels inside
 * `tournament.create`. Returns null when no Radball setup was supplied.
 */
function parseRadballCreate(raw: unknown, teamCount: number): ValidationResult<Record<string, unknown> | null> {
  if (raw === undefined || raw === null) return valid(null);
  if (!isRecord(raw)) return invalid('radball must be an object');
  const out: Record<string, unknown> = {};
  if (raw.ageCategory !== undefined) {
    const age = asString(raw.ageCategory, 8);
    if (!age || !RADBALL_AGES.includes(age.toUpperCase())) {
      return invalid('ageCategory must be U11, U13, U15, U17, U19, U23 or ELITE');
    }
    out.ageCategory = age.toUpperCase();
  }
  for (const key of ['reducedTime', 'doubleRoundRobin'] as const) {
    if (raw[key] !== undefined) {
      const b = asBool(raw[key]);
      if (b === null) return invalid(`${key} must be a boolean`);
      out[key] = b;
    }
  }
  if (raw.minRestMinutes !== undefined) {
    const minutes = asInt(raw.minRestMinutes, 0, 240);
    if (minutes === null) return invalid('minRestMinutes must be 0..240');
    out.minRestMinutes = minutes;
  }
  if (raw.shootoutAttempts !== undefined) {
    const attempts = asInt(raw.shootoutAttempts, 2, 10);
    if (attempts === null) return invalid('shootoutAttempts must be 2..10');
    out.shootoutAttempts = attempts;
  }
  if (raw.groupCount !== undefined) {
    const count = asInt(raw.groupCount, 1, 8);
    if (count === null) return invalid('groupCount must be 1..8');
    out.groupCount = count;
  }
  if (raw.qualifies !== undefined) {
    const places = asInt(raw.qualifies, 0, 16);
    if (places === null) return invalid('qualifies must be 0..16');
    out.qualifies = places;
  }
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups) || raw.groups.length === 0 || raw.groups.length > 8) {
      return invalid('groups must list 1..8 groups');
    }
    const groups: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    for (const entry of raw.groups) {
      if (!isRecord(entry)) return invalid('Every group must be an object');
      const groupName = asString(entry.name, 24) ?? `Group ${groups.length + 1}`;
      if (!Array.isArray(entry.teamIndexes) || entry.teamIndexes.length < 2) {
        return invalid(`Group ${groupName} needs at least 2 teams`);
      }
      const teamIndexes: number[] = [];
      for (const rawIndex of entry.teamIndexes) {
        const index = asInt(rawIndex, 0, teamCount - 1);
        if (index === null) return invalid(`Group ${groupName} references an unknown team`);
        if (seen.has(index)) return invalid('Each team can only play in one group');
        seen.add(index);
        teamIndexes.push(index);
      }
      const group: Record<string, unknown> = { name: groupName, teamIndexes };
      if (entry.qualifies !== undefined) {
        const places = asInt(entry.qualifies, 0, teamIndexes.length);
        if (places === null) return invalid(`Group ${groupName} qualifies must be 0..${teamIndexes.length}`);
        group.qualifies = places;
      }
      if (entry.doubleRoundRobin !== undefined) {
        const b = asBool(entry.doubleRoundRobin);
        if (b === null) return invalid(`Group ${groupName} doubleRoundRobin must be a boolean`);
        group.doubleRoundRobin = b;
      }
      if (entry.fieldId !== undefined && entry.fieldId !== null) {
        const fieldId = String(entry.fieldId);
        if (!isFieldId(fieldId)) return invalid(`Group ${groupName} fieldId must be a playing field ("1".."8")`);
        group.fieldId = fieldId;
      }
      groups.push(group);
    }
    out.groups = groups;
  }
  if (raw.finalRound !== undefined && raw.finalRound !== null) {
    if (!isRecord(raw.finalRound)) return invalid('finalRound must be an object');
    const mode = raw.finalRound.mode === undefined ? 'round-robin' : asString(raw.finalRound.mode, 24);
    if (mode !== 'round-robin' && mode !== 'ranking-matches') {
      return invalid('finalRound.mode must be round-robin or ranking-matches');
    }
    const finalRound: Record<string, unknown> = { mode };
    if (raw.finalRound.topN !== undefined) {
      const topN = asInt(raw.finalRound.topN, 2, 16);
      if (topN === null) return invalid('finalRound.topN must be 2..16');
      finalRound.topN = topN;
    }
    out.finalRound = finalRound;
  }
  if (raw.preset !== undefined && raw.preset !== null) {
    const preset = asString(raw.preset, 32);
    if (!preset || !RADBALL_PRESETS.includes(preset)) {
      return invalid('Unknown Radball preset');
    }
    out.preset = preset;
  }
  const finalOrder = parseFinalKeyOrder(raw.finalOrder, RADBALL_FINAL_KEYS.length);
  if (!finalOrder.ok) return finalOrder;
  if (finalOrder.value) out.finalOrder = finalOrder.value;
  return valid(out);
}

/**
 * Parse the fixture list of a manual schedule against the roster it will be
 * played by.
 *
 * Every side is checked against the participant count rather than against
 * created participants: the fixtures arrive in the same payload as the roster,
 * so there is nothing to look them up in yet. The one rule that is not a range
 * check is that the two sides differ -- a team cannot be scheduled against
 * itself, and the engine would refuse the match it produced.
 */
function parseManualMatches(
  raw: unknown,
  participantCount: number,
  fieldCount: number | null,
): ValidationResult<ManualMatchInput[] | null> {
  if (raw === undefined || raw === null) return valid(null);
  if (!Array.isArray(raw)) return invalid('manualMatches must be an array');
  if (raw.length > MAX_MANUAL_MATCHES) {
    return invalid(`A manual schedule holds at most ${MAX_MANUAL_MATCHES} matches`);
  }
  const out: ManualMatchInput[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return invalid('Every manual match must be an object');
    const a = asInt(entry.a, 0, participantCount - 1);
    const b = asInt(entry.b, 0, participantCount - 1);
    if (a === null || b === null) {
      return invalid('A manual match needs both sides filled in from the roster');
    }
    if (a === b) return invalid('A team cannot be scheduled against itself');
    let round: string | null = null;
    if (entry.round !== undefined && entry.round !== null && String(entry.round).trim() !== '') {
      round = asString(entry.round, 24);
      if (round === null) return invalid('A round name must be 1-24 characters');
    }
    let fieldId: string | null = null;
    if (entry.fieldId !== undefined && entry.fieldId !== null && String(entry.fieldId).trim() !== '') {
      const parsed = String(entry.fieldId);
      if (!isFieldId(parsed)) return invalid('A match can only be pinned to a playing field ("1".."8")');
      // Named here rather than engine-side so the host hears about it while the
      // wizard is still open, with the roster in front of them.
      if (fieldCount !== null && Number(parsed) > fieldCount) {
        return invalid(`A match is pinned to field ${parsed}, but only ${fieldCount} fields are created`);
      }
      fieldId = parsed;
    }
    out.push({ a, b, ...(round ? { round } : {}), ...(fieldId ? { fieldId } : {}) });
  }
  return valid(out);
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                          */
/* ------------------------------------------------------------------ */

export const COMMANDS = {
  'match.score': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const side = asString(p.side, 1);
      if (side !== 'A' && side !== 'B') return invalid('side must be "A" or "B"');
      const delta = asInt(p.delta, -99, 99);
      if (delta === null || delta === 0) return invalid('delta must be a non-zero integer');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      if (p.fieldId !== undefined && fieldId === undefined) return invalid('fieldId must be a playing field ("1".."8")');
      const matchId = p.matchId === undefined ? undefined : reqId(p, 'matchId');
      const note = p.note === undefined ? undefined : asString(p.note, 120);
      return valid({ side, delta, fieldId, matchId, note });
    },
  },
  'match.setTimer': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const out: Record<string, unknown> = { matchId };
      if (p.mode !== undefined) {
        if (p.mode !== 'down' && p.mode !== 'up') return invalid('mode must be down or up');
        out.mode = p.mode;
      }
      if (p.durationSec !== undefined) {
        const d = asNumber(p.durationSec, 1, 24 * 60 * 60);
        if (d === null) return invalid('durationSec must be 1..86400');
        out.durationSec = d;
      }
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      if (p.fieldId !== undefined && fieldId === undefined) return invalid('fieldId must be a playing field ("1".."8")');
      out.fieldId = fieldId;
      return valid(out);
    },
  },
  'match.start': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      if (p.fieldId !== undefined && fieldId === undefined) return invalid('fieldId must be a playing field ("1".."8")');
      return valid({ matchId, fieldId });
    },
  },
  'match.pause': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      return valid({ matchId, fieldId });
    },
  },
  'match.resume': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      return valid({ matchId, fieldId });
    },
  },
  'match.startSecondHalf': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      if (p.fieldId !== undefined && fieldId === undefined) return invalid('fieldId must be a playing field ("1".."8")');
      return valid({ matchId, fieldId });
    },
  },
  'match.reset': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      return valid({ matchId, fieldId });
    },
  },
  'match.undo': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      return valid({ matchId, fieldId });
    },
  },
  'match.redo': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      return valid({ matchId, fieldId });
    },
  },
  'match.correct': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const scoreA = asInt(p.scoreA, 0, 100000);
      const scoreB = asInt(p.scoreB, 0, 100000);
      if (scoreA === null || scoreB === null) return invalid('scoreA and scoreB must be 0..100000');
      const note = p.note === undefined ? undefined : asString(p.note, 200);
      return valid({ matchId, scoreA, scoreB, note });
    },
  },
  'match.finish': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = p.fieldId === undefined ? undefined : asFieldId(p.fieldId);
      const force = p.force === undefined ? false : asBool(p.force);
      if (force === null) return invalid('force must be a boolean');
      const winner = p.winner;
      if (winner !== undefined && winner !== null && winner !== 'A' && winner !== 'B') {
        return invalid('winner must be "A", "B" or null');
      }
      return valid({ matchId, fieldId, force, winner: winner ?? null });
    },
  },
  'match.cancel': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      return valid({ matchId });
    },
  },
  'match.assign': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const fieldId = asFieldId(p.fieldId);
      if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
      return valid({ matchId, fieldId });
    },
  },
  'match.unassign': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const fieldId = asFieldId(p.fieldId);
      if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
      return valid({ fieldId });
    },
  },
  'match.swapFields': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      // With two fields the pair defaults to 1/2; with more fields the host
      // picks which two fields trade their matches.
      const fieldA = p.fieldA === undefined ? '1' : asFieldId(p.fieldA);
      const fieldB = p.fieldB === undefined ? '2' : asFieldId(p.fieldB);
      if (!fieldA || !fieldB) return invalid('fieldA and fieldB must be playing fields ("1".."8")');
      if (fieldA === fieldB) return invalid('fieldA and fieldB must be different fields');
      return valid({ fieldA, fieldB });
    },
  },
  'match.autoAssign': {
    permission: 'admin',
    fieldScoped: false,
    validate: () => valid({}),
  },
  'match.setParticipants': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const a = p.participantAId === null || p.participantAId === undefined ? null : asString(p.participantAId, 64);
      const b = p.participantBId === null || p.participantBId === undefined ? null : asString(p.participantBId, 64);
      return valid({ matchId, participantAId: a, participantBId: b });
    },
  },
  'match.setState': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const state = asMatchState(p.state);
      if (!state) return invalid('state is invalid');
      return valid({ matchId, state });
    },
  },
  'match.reorder': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      if (!Array.isArray(p.matchIds)) return invalid('matchIds must be an array');
      if (p.matchIds.length > 512) return invalid('Too many matches');
      const ids: string[] = [];
      for (const raw of p.matchIds) {
        const id = asString(raw, 64);
        if (!id) return invalid('Every match id must be a non-empty string');
        ids.push(id);
      }
      if (new Set(ids).size !== ids.length) return invalid('Duplicate match ids');
      return valid({ matchIds: ids });
    },
  },
  /**
   * Write one more fixture into a manual schedule.
   *
   * The whole point of the manual format is that the schedule is whatever the
   * host says it is, so the list has to be extendable while the event runs --
   * a late entry, a best-of-three the host only decided on that morning. The
   * engine refuses it for the derived formats: their matches are a consequence
   * of the draw, and adding one by hand would leave a bracket whose tree and
   * whose fixtures disagree.
   */
  'match.add': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const participantAId = p.participantAId === null || p.participantAId === undefined
        ? null
        : asString(p.participantAId, 64);
      const participantBId = p.participantBId === null || p.participantBId === undefined
        ? null
        : asString(p.participantBId, 64);
      if (!participantAId || !participantBId) {
        return invalid('participantAId and participantBId are required');
      }
      if (participantAId === participantBId) {
        return invalid('A team cannot play against itself');
      }
      const out: Record<string, unknown> = { participantAId, participantBId };
      if (p.roundName !== undefined && p.roundName !== null && String(p.roundName).trim() !== '') {
        const roundName = asString(p.roundName, 24);
        if (!roundName) return invalid('A round name must be 1-24 characters');
        out.roundName = roundName;
      }
      if (p.fieldId !== undefined && p.fieldId !== null && String(p.fieldId).trim() !== '') {
        const fieldId = asFieldId(p.fieldId);
        if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
        out.fieldId = fieldId;
      }
      return valid(out);
    },
  },
  /**
   * Take one fixture back out of a manual schedule.
   *
   * Refused by the engine for a match that is already running: an operator
   * holding a live clock on that fixture is the one state a schedule edit must
   * not reach underneath.
   */
  'match.remove': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      return valid({ matchId });
    },
  },
  /** Rename the round or stage a manual fixture belongs to. */
  'match.setRoundName': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      if (p.roundName === undefined || p.roundName === null || String(p.roundName).trim() === '') {
        return invalid('A round name must be 1-24 characters');
      }
      const roundName = asString(p.roundName, 24);
      if (!roundName) return invalid('A round name must be 1-24 characters');
      return valid({ matchId, roundName });
    },
  },
  'match.ready': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const ready = asBool(p.ready);
      if (ready === null) return invalid('ready must be a boolean');
      return valid({ matchId, ready });
    },
  },
  'field.claim': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const fieldId = asFieldId(p.fieldId);
      if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
      const label = p.label === undefined ? undefined : asString(p.label, 40);
      const force = p.force === undefined ? false : asBool(p.force);
      if (force === null) return invalid('force must be a boolean');
      return valid({ fieldId, label, force });
    },
  },
  'field.release': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const fieldId = asFieldId(p.fieldId);
      if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
      const force = p.force === undefined ? false : asBool(p.force);
      if (force === null) return invalid('force must be a boolean');
      return valid({ fieldId, force });
    },
  },
  'field.rename': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const fieldId = asFieldId(p.fieldId);
      if (!fieldId) return invalid('fieldId must be a playing field ("1".."8")');
      const name = asString(p.name, 24);
      if (!name) return invalid('name must be 1-24 characters');
      return valid({ fieldId, name });
    },
  },
  'participant.add': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const parsed = parseParticipantInput(obj(payload));
      if (!parsed.ok) return parsed;
      return valid({ ...parsed.value });
    },
  },
  'participant.update': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const id = reqId(p, 'id');
      if (!id) return invalid('id is required');
      const out: Record<string, unknown> = { id };
      if (p.name !== undefined) {
        const name = asString(p.name, 60);
        if (!name) return invalid('name must be 1-60 characters');
        out.name = name;
      }
      if (p.team !== undefined) {
        if (p.team === null || p.team === '') out.team = null;
        else {
          const team = asString(p.team, 60);
          if (!team) return invalid('team must be 1-60 characters or null');
          out.team = team;
        }
      }
      if (p.seed !== undefined) {
        if (p.seed === null || p.seed === '') out.seed = null;
        else {
          const seed = asInt(p.seed, 1, 4096);
          if (seed === null) return invalid('seed must be a positive integer or null');
          out.seed = seed;
        }
      }
      if (p.checkedIn !== undefined) {
        const b = asBool(p.checkedIn);
        if (b === null) return invalid('checkedIn must be a boolean');
        out.checkedIn = b;
      }
      if (p.fieldId !== undefined) {
        if (p.fieldId === null || p.fieldId === '') out.fieldId = null;
        else {
          const fieldId = String(p.fieldId);
          if (!isFieldId(fieldId)) return invalid('fieldId must be a playing field ("1".."8") or null');
          out.fieldId = fieldId;
        }
      }
      if (p.players !== undefined) {
        if (p.players === null) out.players = null;
        else {
          if (!Array.isArray(p.players) || p.players.length !== 2) {
            return invalid('A Radball team needs exactly two player names. Use team name, player 1, player 2.');
          }
          const first = asString(p.players[0], 60);
          const second = asString(p.players[1], 60);
          if (!first || !second) return invalid('Enter both player names in columns 2 and 3: team name, player 1, player 2.');
          if (first.toLowerCase() === second.toLowerCase()) {
            return invalid('Player 1 and player 2 must be different people.');
          }
          out.players = [first, second];
        }
      }
      if (Object.keys(out).length < 2) return invalid('No changes supplied');
      return valid(out);
    },
  },
  'participant.remove': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const id = reqId(obj(payload), 'id');
      if (!id) return invalid('id is required');
      return valid({ id });
    },
  },
  'participant.import': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const parsed = parseParticipantList(p.participants, 512);
      if (!parsed.ok) return parsed;
      const mode = p.mode === undefined ? 'append' : asString(p.mode, 16);
      if (mode !== 'append' && mode !== 'replace') return invalid('mode must be append or replace');
      return valid({ participants: parsed.value, mode });
    },
  },
  'participant.reorder': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      if (!Array.isArray(p.ids)) return invalid('ids must be an array');
      if (p.ids.length > 512) return invalid('Too many ids');
      const ids: string[] = [];
      for (const raw of p.ids) {
        const id = asString(raw, 64);
        if (!id) return invalid('Every id must be a non-empty string');
        ids.push(id);
      }
      if (new Set(ids).size !== ids.length) return invalid('Duplicate ids');
      return valid({ ids });
    },
  },
  'tournament.create': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const name = asString(p.name, 80);
      if (!name) return invalid('Tournament name must be 1-80 characters');
      const format =
        p.format === undefined ? 'single-elimination' : asString(p.format, 32);
      if (
        format !== 'single-elimination' &&
        format !== 'double-elimination' &&
        format !== 'radball' &&
        format !== 'manual-schedule'
      ) {
        return invalid('format must be single-elimination, double-elimination, radball or manual-schedule');
      }
      const parsed = parseParticipantList(p.participants, 512);
      if (!parsed.ok) return parsed;
      if (format === 'radball' && parsed.value.length < 3) {
        return invalid('A Radball competition needs at least 3 teams. Enter one team per line: team name, player 1, player 2.');
      }
      if (format !== 'radball' && parsed.value.length < 2) {
        return invalid('At least 2 participants are required');
      }
      if (format === 'radball') {
        const teamNames = new Set<string>();
        const people = new Set<string>();
        for (const entry of parsed.value) {
          if (!entry.players) return invalid(`Team "${entry.name}" needs exactly two player names. Use team name, player 1, player 2.`);
          const field = entry.fieldId ? `Field ${entry.fieldId}` : 'The unassigned roster';
          const scope = entry.fieldId ?? '';
          const teamKey = `${scope}|${entry.name.toLowerCase()}`;
          if (teamNames.has(teamKey)) {
            return invalid(`${field} already contains team "${entry.name}". Each team name must be unique within a field.`);
          }
          teamNames.add(teamKey);
          for (const player of entry.players) {
            const playerKey = `${scope}|${player.toLowerCase()}`;
            if (people.has(playerKey)) {
              return invalid(`${field} already contains player "${player}". Each player can appear only once within a field.`);
            }
            people.add(playerKey);
          }
        }
      }
      // Home fields are validated against the field setup created alongside.
      // (Checked again engine-side; this catches typos early with a clear error.)
      if (Array.isArray(p.fieldNames)) {
        const createdFieldCount = p.fieldNames.length;
        for (const entry of parsed.value) {
          if (entry.fieldId && Number(entry.fieldId) > createdFieldCount) {
            return invalid(`Participant ${entry.name} is assigned to field ${entry.fieldId}, but only ${createdFieldCount} fields are created`);
          }
        }
      }
      const thirdPlaceMatch = p.thirdPlaceMatch === undefined ? true : asBool(p.thirdPlaceMatch);
      if (thirdPlaceMatch === null) return invalid('thirdPlaceMatch must be a boolean');
      const seeded = p.seeded === undefined ? true : asBool(p.seeded);
      if (seeded === null) return invalid('seeded must be a boolean');
      let seedValue: number | null = null;
      if (p.seedValue !== undefined && p.seedValue !== null && p.seedValue !== '') {
        seedValue = asInt(p.seedValue, 0, 2 ** 31);
        if (seedValue === null) return invalid('seedValue must be a non-negative integer');
      }
      const settings = isRecord(p.settings) ? p.settings : null;
      const generated = p.generateBracket === undefined ? true : asBool(p.generateBracket);
      if (generated === null) return invalid('generateBracket must be a boolean');
      let fieldNames: string[] | undefined;
      if (p.fieldNames !== undefined && p.fieldNames !== null) {
        if (!Array.isArray(p.fieldNames)) return invalid('fieldNames must be an array');
        if (p.fieldNames.length < MIN_FIELDS || p.fieldNames.length > MAX_FIELDS) {
          return invalid(`fieldNames must have ${MIN_FIELDS}..${MAX_FIELDS} entries`);
        }
        fieldNames = [];
        for (const entry of p.fieldNames) {
          const fieldName = asString(entry, 24);
          if (!fieldName) return invalid('Field names must be 1-24 characters');
          fieldNames.push(fieldName);
        }
      }
      let manualOrder: (number | null)[] | null = null;
      if (p.manualOrder !== undefined && p.manualOrder !== null) {
        if (!Array.isArray(p.manualOrder)) return invalid('manualOrder must be an array');
        if (p.manualOrder.length < 2 || p.manualOrder.length > 512) {
          return invalid('manualOrder must have 2..512 slots');
        }
        if ((p.manualOrder.length & (p.manualOrder.length - 1)) !== 0) {
          return invalid('manualOrder length must be a power of two (2, 4, 8, 16, ...)');
        }
        manualOrder = [];
        for (const entry of p.manualOrder) {
          if (entry === null) {
            manualOrder.push(null);
            continue;
          }
          const index = asInt(entry, 0, parsed.value.length - 1);
          if (index === null) return invalid('manualOrder entries must be participant indexes or null');
          manualOrder.push(index);
        }
        const used = manualOrder.filter((entry): entry is number => entry !== null);
        if (new Set(used).size !== used.length) {
          return invalid('Each participant can only occupy one bracket slot');
        }
      }
      const radball = parseRadballCreate(p.radball, parsed.value.length);
      if (!radball.ok) return radball;
      if (format === 'radball' && manualOrder) {
        return invalid('Manual bracket slots do not apply to Radball round-robin groups');
      }
      // The fixture list is checked against the roster *and* the field setup,
      // because a match pinned to field 4 of a two-field hall is a fixture the
      // engine would have to silently unpin.
      const createdFieldCount = Array.isArray(p.fieldNames) ? p.fieldNames.length : null;
      const manualMatches = parseManualMatches(p.manualMatches, parsed.value.length, createdFieldCount);
      if (!manualMatches.ok) return manualMatches;
      if (format !== 'manual-schedule' && manualMatches.value) {
        return invalid('A manual schedule only applies to the manual schedule format');
      }
      if (format === 'manual-schedule' && manualMatches.value === null) {
        return invalid('A manual schedule needs at least one match');
      }
      if (format === 'radball' && radball.value?.preset === 'radball-10-team') {
        // The group a team plays in is the field it was registered on, so the
        // roster *is* the split: Group A is the teams on field 1, Group B those
        // on field 2. Two equal groups of at least two are the rules; both are
        // checked again in the engine, where the groups exist.
        if (Array.isArray(p.fieldNames) && p.fieldNames.length < 2) {
          return invalid('The World Cup format needs two playing fields: Group A on field 1, Group B on field 2');
        }
        const onField = (fieldId: string) => parsed.value.filter((entry) => entry.fieldId === fieldId).length;
        const groupA = onField('1');
        const groupB = onField('2');
        const adrift = parsed.value.find((entry) => entry.fieldId !== '1' && entry.fieldId !== '2');
        if (adrift) {
          return invalid(
            `${adrift.name} has no group: the World Cup format plays one group per field, so a team must be registered on field 1 (Group A) or field 2 (Group B)`,
          );
        }
        if (groupA !== groupB) {
          return invalid(
            `The World Cup format needs the same number of teams in both groups: field 1 has ${groupA} and field 2 has ${groupB}`,
          );
        }
        if (groupA < 2) {
          return invalid(
            `Each group needs at least 2 teams for a final phase; ${parsed.value.length} teams give ${groupA} per group`,
          );
        }
      }
      const confirmReplace = p.confirmReplace === undefined ? false : asBool(p.confirmReplace);
      if (confirmReplace === null) return invalid('confirmReplace must be a boolean');
      let expectedTournamentId: string | null = null;
      if (p.expectedTournamentId !== undefined && p.expectedTournamentId !== null) {
        expectedTournamentId = asString(p.expectedTournamentId, 64);
        if (!expectedTournamentId) return invalid('expectedTournamentId must be a tournament id or null');
      }
      return valid({
        name,
        format,
        participants: parsed.value,
        thirdPlaceMatch,
        seeded,
        seedValue,
        settings,
        generateBracket: generated,
        confirmReplace,
        expectedTournamentId,
        ...(fieldNames ? { fieldNames } : {}),
        ...(manualOrder ? { manualOrder } : {}),
        ...(manualMatches.value ? { manualMatches: manualMatches.value } : {}),
        ...(radball.value ? { radball: radball.value } : {}),
      });
    },
  },
  'team.add': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const parsed = parseLibraryTeamInput(obj(payload));
      if (!parsed.ok) return parsed;
      return valid({ ...parsed.value });
    },
  },
  'team.update': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const id = reqId(p, 'id');
      if (!id) return invalid('id is required');
      // Validate the whole squad, not just the changed keys, so a partial edit
      // can never leave the library with a half-filled team.
      const current = parseLibraryTeamInput(p.team);
      if (!current.ok) return current;
      return valid({ id, team: { ...current.value } });
    },
  },
  'team.remove': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const id = reqId(obj(payload), 'id');
      if (!id) return invalid('id is required');
      return valid({ id });
    },
  },
  'team.reorder': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      if (!Array.isArray(p.ids)) return invalid('ids must be an array');
      if (p.ids.length > 512) return invalid('Too many ids (max 512)');
      const ids: string[] = [];
      for (const entry of p.ids) {
        const id = asString(entry, 64);
        if (!id) return invalid('Every id must be a non-empty string');
        ids.push(id);
      }
      if (new Set(ids).size !== ids.length) return invalid('Duplicate ids');
      return valid({ ids });
    },
  },
  'team.import': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const parsed = parseLibraryTeamList(p.teams, 512);
      if (!parsed.ok) return parsed;
      if (parsed.value.length === 0) return invalid('Paste at least one team before importing');
      const mode = p.mode === 'replace' ? 'replace' : 'append';
      return valid({ teams: parsed.value, mode });
    },
  },
  'setup.save': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      let id: string | null = null;
      if (p.id !== undefined && p.id !== null && p.id !== '') {
        id = asString(p.id, 64);
        if (!id) return invalid('id must be a saved-setup id');
      }
      let name: string | null = null;
      if (p.name !== undefined && p.name !== null) {
        name = asString(p.name, 80);
        if (!name) return invalid('name must be 1-80 characters');
      }
      // The setup itself is a wide, deeply-nested structure that only means
      // anything in the context of the wizard's own rules (a manual draw only
      // makes sense for a knockout, the 10-team split needs ten teams, ...).
      // So the envelope is checked here and the body is normalised and judged
      // once, in one place, by `sanitiseSavedTournamentSetup` on the server.
      if (!isRecord(p.setup)) return invalid('setup must be an object');
      return valid({ id, name, setup: p.setup });
    },
  },
  'setup.rename': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const id = reqId(p, 'id');
      if (!id) return invalid('id is required');
      const name = asString(p.name, 80);
      if (!name) return invalid('name must be 1-80 characters');
      return valid({ id, name });
    },
  },
  'setup.remove': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const id = reqId(obj(payload), 'id');
      if (!id) return invalid('id is required');
      return valid({ id });
    },
  },
  'tournament.update': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const out: Record<string, unknown> = {};
      if (p.name !== undefined) {
        const name = asString(p.name, 80);
        if (!name) return invalid('name must be 1-80 characters');
        out.name = name;
      }
      if (p.thirdPlaceMatch !== undefined) {
        const b = asBool(p.thirdPlaceMatch);
        if (b === null) return invalid('thirdPlaceMatch must be a boolean');
        out.thirdPlaceMatch = b;
      }
      if (Object.keys(out).length === 0) return invalid('No changes supplied');
      return valid(out);
    },
  },
  'tournament.reset': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const confirm = asString(p.confirm, 40);
      if (confirm !== 'RESET') return invalid('Type RESET to confirm');
      return valid({ confirm });
    },
  },
  'tournament.complete': {
    permission: 'admin',
    fieldScoped: false,
    validate: () => valid({}),
  },
  'bracket.generate': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const seeded = p.seeded === undefined ? true : asBool(p.seeded);
      if (seeded === null) return invalid('seeded must be a boolean');
      const thirdPlaceMatch = p.thirdPlaceMatch === undefined ? true : asBool(p.thirdPlaceMatch);
      if (thirdPlaceMatch === null) return invalid('thirdPlaceMatch must be a boolean');
      let seedValue: number | null = null;
      if (p.seedValue !== undefined && p.seedValue !== null && p.seedValue !== '') {
        seedValue = asInt(p.seedValue, 0, 2 ** 31);
        if (seedValue === null) return invalid('seedValue must be a non-negative integer');
      }
      const manualOrder =
        p.order === undefined || p.order === null || Array.isArray(p.order) ? p.order ?? null : null;
      if (p.order !== undefined && p.order !== null && !Array.isArray(p.order)) {
        return invalid('order must be an array');
      }
      if (manualOrder !== null && !Array.isArray(manualOrder)) {
        return invalid('order must be an array');
      }
      const order = (manualOrder as (string | null)[] | null) ?? null;
      if (order) {
        if (order.length > 512) return invalid('Too many bracket slots');
        for (const entry of order) {
          if (entry !== null && typeof entry !== 'string') return invalid('order entries must be ids or null');
        }
      }
      return valid({ seeded, seedValue, thirdPlaceMatch, order });
    },
  },
  'bracket.setSlot': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      if (p.slot !== 'A' && p.slot !== 'B') return invalid('slot must be "A" or "B"');
      const participantId =
        p.participantId === null || p.participantId === undefined
          ? null
          : asString(p.participantId, 64);
      return valid({ matchId, slot: p.slot, participantId });
    },
  },
  'radball.shootoutRecord': {
    permission: 'operator',
    fieldScoped: true,
    validate: (payload) => {
      const p = obj(payload);
      const matchId = reqId(p, 'matchId');
      if (!matchId) return invalid('matchId is required');
      const side = asString(p.side, 1);
      if (side !== 'A' && side !== 'B') return invalid('side must be "A" or "B"');
      const hit = asBool(p.hit);
      if (hit === null) return invalid('hit must be a boolean');
      const shooter = asInt(p.shooter, 0, 1);
      if (shooter === null) return invalid('shooter must be 0 or 1 (first or second player)');
      return valid({ matchId, side, hit, shooter });
    },
  },
  'radball.shootoutReset': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const matchId = reqId(obj(payload), 'matchId');
      if (!matchId) return invalid('matchId is required');
      return valid({ matchId });
    },
  },
  'radball.decisionCreate': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const teamAId = asString(p.teamAId, 64);
      const teamBId = asString(p.teamBId, 64);
      if (!teamAId || !teamBId) return invalid('teamAId and teamBId are required');
      if (teamAId === teamBId) return invalid('A team cannot play a decision match against itself');
      const phaseId = p.phaseId === undefined ? undefined : asString(p.phaseId, 64);
      const groupId = p.groupId === undefined ? undefined : asString(p.groupId, 64);
      const reason = p.reason === undefined ? 'MANUAL' : asString(p.reason, 40);
      if (!reason) return invalid('reason must be a short label');
      return valid({ teamAId, teamBId, phaseId, groupId, reason });
    },
  },
  'radball.qualify': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const phaseId = p.phaseId === undefined ? undefined : asString(p.phaseId, 64);
      return valid({ phaseId });
    },
  },
  /**
   * Create the six final-phase matches of the 10-team format. Refused until all
   * twenty preliminary fixtures are decided -- the engine, not the client, is
   * what decides whether it is too early.
   */
  'radball.finalPhase': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const confirm = p.confirm === undefined ? true : asBool(p.confirm);
      if (confirm === null) return invalid('confirm must be a boolean');
      const order = parseFinalKeyOrder(p.order, RADBALL_FINAL_KEYS.length);
      if (!order.ok) return order;
      return valid({ confirm, order: order.value ?? null });
    },
  },
  /**
   * Reorder the final-phase queue. Advice only: the dependency chain is fixed by
   * the rules, so no order can make the final startable before its semifinals.
   */
  'radball.finalOrder': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const order = parseFinalKeyOrder(obj(payload).order, RADBALL_FINAL_KEYS.length);
      if (!order.ok) return order;
      if (!order.value) return invalid('order must list the final-phase matches');
      return valid({ order: order.value });
    },
  },
  'settings.update': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      if (!isRecord(p.patch)) return invalid('patch must be an object');
      return valid({ patch: p.patch });
    },
  },
  /**
   * Switch what the hall's display screens show.
   *
   * Deliberately `operator` rather than `admin`: the person who can see that
   * the match has gone to half-time is the operator standing at the field, and
   * making them walk to the desk to press Pause is the friction this exists to
   * remove. The screen is hall-wide (there is one projector), so it is not
   * field-scoped -- any operator switches the same screen.
   */
  'display.setScreen': {
    permission: 'operator',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      if (!isDisplayScreen(p.screen)) {
        return invalid('screen must be one of scores, pause, logo, clock, standings, results');
      }
      const out: Record<string, unknown> = { screen: p.screen };
      // The message is optional: switching screens and editing the pause text
      // are two different presses, and a switch that forgot the text must not
      // wipe what the host typed.
      if (p.message !== undefined) {
        if (p.message === null || p.message === '') out.message = null;
        else {
          const message = asString(p.message, 160);
          if (!message) return invalid('message must be 160 characters or fewer');
          out.message = message;
        }
      }
      return valid(out);
    },
  },
  'system.backup': {
    permission: 'admin',
    fieldScoped: false,
    validate: () => valid({}),
  },
  'system.demo': {
    permission: 'admin',
    fieldScoped: false,
    validate: () => valid({}),
  },
  'system.demoProgress': {
    permission: 'admin',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const stage = asInt(p.stage, 0, 6);
      if (stage === null) return invalid('stage must be 0..6');
      return valid({ stage });
    },
  },
  'system.backupNow': {
    permission: 'admin',
    fieldScoped: false,
    validate: () => valid({}),
  },
  'device.identify': {
    permission: 'none',
    fieldScoped: false,
    validate: (payload) => {
      const p = obj(payload);
      const label = p.label === undefined ? undefined : asString(p.label, 40);
      const kind = p.kind === undefined ? undefined : asString(p.kind, 24);
      // `asString` returns null (not just undefined) for a missing or blank
      // value, so both have to be treated as "not supplied".
      if (kind !== undefined && kind !== null && !['operator', 'display', 'admin', 'spectator'].includes(kind)) {
        return invalid('kind is invalid');
      }
      return valid({ label, kind });
    },
  },
  'client.ping': {
    permission: 'none',
    fieldScoped: false,
    validate: () => valid({}),
  },
} satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

export function isCommandName(value: string): value is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}

export const ADMIN_COMMANDS = COMMAND_NAMES.filter((c) => COMMANDS[c].permission === 'admin');
