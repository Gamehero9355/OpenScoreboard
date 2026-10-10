/**
 * The team library: the host's reusable 2er Radball squads, filed into age
 * groups. Pure functions over `TournamentState` that record a `Mutation`, so
 * the library obeys the same single-writer rule as the live tournament and
 * travels in the same snapshot.
 *
 * The library deliberately survives `tournament.create` -- that is the whole
 * point of keeping it. Squads are entered once and reused across seasons.
 */
import {
  RADBALL_AGE_CATEGORIES,
  emptyTeamLibrary,
  isRadballAgeCategory,
  type RadballAgeCategory,
  type TeamLibrary,
  type TeamLibraryEntry,
  type TournamentState,
} from '../../shared/types';
import { EngineError } from '../util/errors';
import type { Ctx, Mutation } from './state';
import { pushEvent } from './state';

/** A club can enter a handful of squads; a season never needs more than this. */
export const MAX_LIBRARY_TEAMS = 512;
const MAX_NAME = 60;

/** A bare file name in the host's logos folder, or null for the default crest. */
function normaliseLogo(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Defence in depth: the wire validator already refuses paths and odd
  // extensions, but this value is also read from disk on restore, so a
  // hand-edited backup cannot put a traversal in front of the logo route.
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') return null;
  if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(trimmed)) return null;
  return trimmed.slice(0, 120);
}

export interface LibraryTeamInput {
  name: string;
  club: string | null;
  players: [string, string];
  ageCategory: RadballAgeCategory;
  /** Optional on the way in: absent means "keep the default crest". */
  logo?: string | null;
}

function normaliseName(value: string): string {
  return value.trim();
}

/**
 * Reject anything that would make the library ambiguous to fill in: a blank
 * squad, a blank or doubled player, an unknown age group, or a name already on
 * file. Names are unique across the whole library rather than per age group, so
 * moving a squad between groups can never collide with itself.
 */
function assertUsable(input: LibraryTeamInput, library: TeamLibrary, ignoreId?: string): void {
  const name = normaliseName(input.name);
  if (!name) throw new EngineError('BAD_REQUEST', 'Enter a team name.');
  if (name.length > MAX_NAME) {
    throw new EngineError('BAD_REQUEST', `Team name must be ${MAX_NAME} characters or fewer.`);
  }
  if (input.club !== null && input.club.length > MAX_NAME) {
    throw new EngineError('BAD_REQUEST', `The club must be ${MAX_NAME} characters or fewer.`);
  }
  const [first, second] = input.players;
  if (!first || !second) {
    throw new EngineError('BAD_REQUEST', 'Enter both player names. A 2er team needs a pair.');
  }
  if (first.toLowerCase() === second.toLowerCase()) {
    throw new EngineError('BAD_REQUEST', 'Player 1 and player 2 must be different people.');
  }
  if (first.length > MAX_NAME || second.length > MAX_NAME) {
    throw new EngineError('BAD_REQUEST', `Player names must be ${MAX_NAME} characters or fewer.`);
  }
  if (!isRadballAgeCategory(input.ageCategory)) {
    throw new EngineError('BAD_REQUEST', 'Choose a Radball age group for this team.');
  }
  const clash = Object.values(library.teams).find(
    (entry) => entry.id !== ignoreId && entry.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new EngineError('CONFLICT', `The team library already holds "${clash.name}".`);
  }
}

function markLibraryDirty(mut: Mutation): void {
  mut.teamLibrary = true;
  mut.urgency = 'immediate';
}

/**
 * Build and file a squad without touching the event log, so a 40-row import
 * produces one event instead of forty. Returns null when the row is unusable.
 */
function insertTeam(
  library: TeamLibrary,
  input: LibraryTeamInput,
  now: number,
  makeId: (prefix: string) => string,
): TeamLibraryEntry | null {
  const normalised: LibraryTeamInput = {
    name: normaliseName(input.name),
    club: input.club?.trim() ? input.club.trim() : null,
    players: [input.players[0]?.trim() ?? '', input.players[1]?.trim() ?? ''],
    ageCategory: input.ageCategory,
    logo: normaliseLogo(input.logo),
  };
  try {
    assertUsable(normalised, library);
  } catch {
    return null;
  }
  if (library.order.length >= MAX_LIBRARY_TEAMS) return null;
  const entry: TeamLibraryEntry = {
    id: makeId('t'),
    name: normalised.name,
    club: normalised.club,
    players: normalised.players as [string, string],
    ageCategory: normalised.ageCategory,
    logo: normalised.logo ?? null,
    createdAt: now,
    updatedAt: now,
  };
  library.teams[entry.id] = entry;
  library.order.push(entry.id);
  return entry;
}

export function addLibraryTeam(
  state: TournamentState,
  input: LibraryTeamInput,
  ctx: Ctx,
  mut: Mutation,
): TeamLibraryEntry {
  const library = state.teamLibrary;
  // Validate up front so the host gets the precise reason, then file the squad.
  assertUsable(input, library);
  if (library.order.length >= MAX_LIBRARY_TEAMS) {
    throw new EngineError('BAD_REQUEST', `The team library holds at most ${MAX_LIBRARY_TEAMS} teams.`);
  }
  const entry = insertTeam(library, input, ctx.now, ctx.newId);
  if (!entry) throw new EngineError('INTERNAL', 'That team could not be filed in the library.');
  markLibraryDirty(mut);
  pushEvent(mut, 'TEAM_ADDED', { key: 'event.teamAdded', params: { name: entry.name } }, {
    data: { teamId: entry.id, ageCategory: entry.ageCategory },
  });
  return entry;
}

export function updateLibraryTeam(
  state: TournamentState,
  id: string,
  patch: Partial<LibraryTeamInput>,
  ctx: Ctx,
  mut: Mutation,
): TeamLibraryEntry {
  const library = state.teamLibrary;
  const entry = library.teams[id];
  if (!entry) throw new EngineError('NOT_FOUND', 'That team is no longer in the library.');

  const next: LibraryTeamInput = {
    name: patch.name !== undefined ? normaliseName(patch.name) : entry.name,
    club: patch.club !== undefined ? (patch.club?.trim() || null) : entry.club,
    players: patch.players !== undefined ? patch.players : entry.players,
    ageCategory: patch.ageCategory !== undefined ? patch.ageCategory : entry.ageCategory,
    logo: patch.logo !== undefined ? normaliseLogo(patch.logo) : entry.logo,
  };
  assertUsable(next, library, id);

  entry.name = next.name;
  entry.club = next.club;
  entry.players = [next.players[0].trim(), next.players[1].trim()];
  entry.ageCategory = next.ageCategory;
  entry.logo = next.logo ?? null;
  entry.updatedAt = ctx.now;
  markLibraryDirty(mut);
  pushEvent(mut, 'TEAM_UPDATED', { key: 'event.teamUpdated', params: { name: entry.name } }, {
    data: { teamId: entry.id, ageCategory: entry.ageCategory },
  });
  return entry;
}

export function removeLibraryTeam(state: TournamentState, id: string, mut: Mutation): TeamLibraryEntry {
  const library = state.teamLibrary;
  const entry = library.teams[id];
  if (!entry) throw new EngineError('NOT_FOUND', 'That team is no longer in the library.');
  delete library.teams[id];
  library.order = library.order.filter((teamId) => teamId !== id);
  markLibraryDirty(mut);
  pushEvent(mut, 'TEAM_REMOVED', { key: 'event.teamRemoved', params: { name: entry.name } }, {
    data: { teamId: id },
  });
  return entry;
}

/** Reorder within the whole library; ids the host did not send keep their place. */
export function reorderLibraryTeams(state: TournamentState, ids: string[], mut: Mutation): void {
  const library = state.teamLibrary;
  const known = ids.filter((id) => Boolean(library.teams[id]));
  const seen = new Set(known);
  const missing = library.order.filter((id) => !seen.has(id));
  library.order = [...known, ...missing];
  markLibraryDirty(mut);
  pushEvent(mut, 'TEAM_UPDATED', { key: 'event.teamOrder' });
}

/**
 * Bulk entry. `append` keeps what is on file and adds the new squads,
 * `replace` starts from an empty library. Rows that clash with an existing name
 * are skipped rather than failing the whole paste, so one stale line cannot
 * block a season's worth of entries.
 */
export function importLibraryTeams(
  state: TournamentState,
  inputs: LibraryTeamInput[],
  mode: 'append' | 'replace',
  ctx: Ctx,
  mut: Mutation,
): { added: number; skipped: string[] } {
  const library = state.teamLibrary;
  if (mode === 'replace') {
    library.teams = {};
    library.order = [];
  }
  const skipped: string[] = [];
  let added = 0;
  for (const raw of inputs) {
    if (library.order.length >= MAX_LIBRARY_TEAMS) {
      skipped.push(`stopped at ${MAX_LIBRARY_TEAMS} teams`);
      break;
    }
    const name = normaliseName(raw.name);
    const entry = insertTeam(library, raw, ctx.now, ctx.newId);
    if (entry) {
      added += 1;
      continue;
    }
    // Report the same reason the single-entry path would have given.
    try {
      assertUsable(raw, library);
      skipped.push(`${name || 'that row'}: library is full`);
    } catch (error) {
      skipped.push(
        error instanceof EngineError ? `${name || 'that row'}: ${error.message}` : `${name || 'that row'}: rejected.`,
      );
    }
  }
  markLibraryDirty(mut);
  // Four shapes, because "1 team" and "3 teams" read differently in both
  // languages and a count substitution cannot fix that from a template.
  const imported = added === 1 ? 'event.teamsImportedOne' : 'event.teamsImported';
  const importedSkipped = added === 1 ? 'event.teamsImportedOneSkipped' : 'event.teamsImportedSkipped';
  pushEvent(mut, 'TEAMS_IMPORTED', {
    key: skipped.length > 0 ? importedSkipped : imported,
    params: { n: added, skipped: skipped.length },
  });
  return { added, skipped };
}

/**
 * Defensive normalisation of a library read from disk or a backup file. Drops
 * anything malformed rather than refusing to start, so a hand-edited file can
 * never take the whole scoreboard down with it.
 */
export function sanitiseTeamLibrary(input: unknown): TeamLibrary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyTeamLibrary();
  const raw = input as Partial<TeamLibrary>;
  const source = raw.teams && typeof raw.teams === 'object' ? raw.teams : {};
  const teams: Record<string, TeamLibraryEntry> = {};
  for (const [id, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Partial<TeamLibraryEntry>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const players = Array.isArray(entry.players) ? entry.players : [];
    const first = typeof players[0] === 'string' ? players[0].trim() : '';
    const second = typeof players[1] === 'string' ? players[1].trim() : '';
    if (!first || !second) continue;
    const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : Date.now();
    teams[id] = {
      id,
      name,
      club: typeof entry.club === 'string' && entry.club.trim() ? entry.club : null,
      players: [first, second],
      ageCategory: isRadballAgeCategory(entry.ageCategory) ? entry.ageCategory : 'ELITE',
      // A library written before logos existed has no key here, and it has to
      // come back as an explicit null rather than undefined.
      logo: normaliseLogo(typeof entry.logo === 'string' ? entry.logo : null),
      createdAt,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : createdAt,
    };
  }
  // The first name to claim a spelling keeps it, so a duplicated row cannot
  // leave the host with two identical squads in one library.
  const claimed = new Set<string>();
  for (const id of Object.keys(teams)) {
    const team = teams[id];
    if (!team) continue;
    const key = team.name.toLowerCase();
    if (claimed.has(key)) {
      delete teams[id];
      continue;
    }
    claimed.add(key);
  }
  const order = Array.isArray(raw.order)
    ? raw.order.filter((id): id is string => typeof id === 'string' && Boolean(teams[id]))
    : [];
  const seen = new Set(order);
  for (const id of Object.keys(teams)) {
    if (!seen.has(id)) order.push(id);
  }
  return { teams, order };
}

/** Age groups that currently hold at least one team, in ruleset order. */
export function populatedAgeCategories(library: TeamLibrary): RadballAgeCategory[] {
  const used = new Set(Object.values(library.teams).map((entry) => entry.ageCategory));
  return RADBALL_AGE_CATEGORIES.filter((age) => used.has(age));
}
