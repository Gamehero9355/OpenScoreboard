/**
 * The saved-tournament library: whole tournament setups the host filed so the
 * same event can be run again without retyping it.
 *
 * It is deliberately modelled on the team library (`teams.ts`) and obeys the
 * same rules: pure functions over `TournamentState` that record a `Mutation`,
 * so it travels in the same snapshot and reaches every connected screen as the
 * same delta. Like the team library it survives `tournament.create` -- that is
 * the whole point of keeping it.
 *
 * A saved setup holds the *wizard's* values, not a ready-made create payload.
 * Loading one fills the wizard, where the host reviews it and can change
 * anything before a single fixture exists.
 */
import {
  MAX_FIELDS,
  MAX_MANUAL_MATCHES,
  isDrawMode,
  isRadballAgeCategory,
  isRadballFinalMode,
  isRadballSetupMode,
  isTournamentFormat,
  emptySavedTournamentLibrary,
  emptySavedTournamentSetup,
  type SavedManualMatch,
  type SavedTournamentEntry,
  type SavedTournamentLibrary,
  type SavedTournamentSetup,
  type TournamentState,
} from '../../shared/types';
import { EngineError } from '../util/errors';
import type { Ctx, Mutation } from './state';
import { pushEvent } from './state';

/**
 * A club runs a handful of distinct events; a host who files one per team per
 * season is already misusing the shelf. The cap only exists so a runaway
 * client cannot grow the snapshot without bound.
 */
export const MAX_SAVED_TOURNAMENTS = 64;
const MAX_LABEL = 80;
const MAX_NAME = 24;
const MAX_ROSTER_ROWS = 512;
const MAX_MANUAL_SLOTS = 512;
const MAX_INCREMENTS = 6;
const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 120 * 60;
/** A round label is what the match itself shows, so it is the same 24 as a field name. */
const MAX_ROUND_NAME = 24;

/** One field's roster text is bounded too, so one paste cannot fill the disk. */
const MAX_ROSTER_CHARS = 40_000;

export interface SaveTournamentSetupInput {
  /** Present when overwriting an existing shelf entry; absent means "file it new". */
  id?: string | null;
  /** The shelf label. Falls back to the tournament name when blank. */
  name?: string | null;
  setup: SavedTournamentSetup;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/**
 * Per-field roster text, taken verbatim.
 *
 * Nothing is trimmed or shortened here: a roster the host typed is the roster
 * they get back, and silently dropping the tail of one would lose teams without
 * a word. Oversized input is refused by `assertUsable` instead, with a reason.
 */
function rosterText(value: unknown, fieldCount: number): string[] {
  const source = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const raw = source[index];
    out.push(typeof raw === 'string' ? raw : '');
  }
  return out;
}

function manualSlots(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_MANUAL_SLOTS)
    .map((entry) => (typeof entry === 'string' && entry.length > 0 ? entry.slice(0, 200) : null));
}

/**
 * The fixtures of a saved manual schedule.
 *
 * Every side is kept as the participant *key* it arrived as and is validated
 * against nothing: a saved setup is data the host may have hand-edited, and the
 * wizard -- which knows the roster -- is where a key that no longer matches
 * anybody gets reported. Truncating a round label rather than dropping the
 * fixture keeps the schedule readable; a field index outside the setup's own
 * fields becomes null, because pinning a fixture to a field that does not exist
 * is exactly the kind of silent surprise the shelf should not carry.
 */
function manualMatches(value: unknown, fieldCount: number): SavedManualMatch[] {
  if (!Array.isArray(value)) return [];
  const out: SavedManualMatch[] = [];
  for (const raw of value.slice(0, MAX_MANUAL_MATCHES)) {
    if (!isRecord(raw)) continue;
    const side = (entry: unknown): string | null =>
      typeof entry === 'string' && entry.length > 0 ? entry.slice(0, 200) : null;
    const round = typeof raw.round === 'string' ? raw.round.trim().slice(0, MAX_ROUND_NAME) : '';
    const fieldIndex =
      typeof raw.fieldIndex === 'number' && Number.isInteger(raw.fieldIndex) && raw.fieldIndex >= 0 && raw.fieldIndex < fieldCount
        ? raw.fieldIndex
        : null;
    out.push({ a: side(raw.a), b: side(raw.b), round, fieldIndex });
  }
  return out;
}

/**
 * The scoring buttons as numbers, or the documented default when the stored list
 * is unusable. The rule is deliberately the wizard's own: one malformed button
 * throws the whole list away rather than quietly leaving the host with a
 * half-populated bracket and no warning.
 */
function scoringIncrements(value: unknown): number[] {
  const fallback = [1, 2, 3];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INCREMENTS) return fallback;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry === 0 || Math.abs(entry) > 99) {
      return fallback;
    }
    if (out.includes(entry)) return fallback;
    out.push(entry);
  }
  return out;
}

/**
 * Turn anything into a usable setup: every field clamped, nothing dropped
 * silently except a genuinely malformed row, and the field roster trimmed to
 * the fields the setup actually has.
 */
export function sanitiseSavedTournamentSetup(input: unknown): SavedTournamentSetup {
  const base = emptySavedTournamentSetup();
  if (!isRecord(input)) return base;
  const names = Array.isArray(input.fieldNames)
    ? input.fieldNames
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().slice(0, MAX_NAME))
        .filter(Boolean)
        .slice(0, MAX_FIELDS)
    : [];
  const fieldNames = names.length > 0 ? names : base.fieldNames;
  const age = isRadballAgeCategory(input.ageCategory) ? input.ageCategory : base.ageCategory;
  const setupMode = isRadballSetupMode(input.setupMode) ? input.setupMode : base.setupMode;
  const finalMode = isRadballFinalMode(input.finalMode) ? input.finalMode : base.finalMode;
  const seedValue =
    typeof input.seedValue === 'string' ? input.seedValue.trim().slice(0, 20) : base.seedValue;
  return {
    version: 1,
    name: typeof input.name === 'string' ? input.name.trim().slice(0, MAX_LABEL) : '',
    format: isTournamentFormat(input.format) ? input.format : base.format,
    fieldNames,
    fieldBulk: rosterText(input.fieldBulk, fieldNames.length),
    radballBulk: rosterText(input.radballBulk, fieldNames.length),
    thirdPlace: bool(input.thirdPlace, base.thirdPlace),
    seeded: bool(input.seeded, base.seeded),
    seedValue,
    drawMode: isDrawMode(input.drawMode) ? input.drawMode : base.drawMode,
    manualSlots: manualSlots(input.manualSlots),
    manualMatches: manualMatches(input.manualMatches, fieldNames.length),
    durationSec: int(input.durationSec, base.durationSec, MIN_DURATION_SEC, MAX_DURATION_SEC),
    scoringIncrements: scoringIncrements(input.scoringIncrements),
    autoLoadNext: bool(input.autoLoadNext, base.autoLoadNext),
    autoAssignNext: bool(input.autoAssignNext, base.autoAssignNext),
    ageCategory: age,
    reducedTime: bool(input.reducedTime, base.reducedTime),
    minRestMinutes: int(input.minRestMinutes, base.minRestMinutes, 0, 240),
    setupMode,
    groupCount: int(input.groupCount, base.groupCount, 1, 4),
    doubleLeg: bool(input.doubleLeg, base.doubleLeg),
    finalMode,
    bdrPreset: bool(input.bdrPreset, base.bdrPreset),
  };
}

/**
 * A setup that would produce nothing the host could create is refused at save
 * time, not at load time: the wizard can only file a setup it already
 * considers valid, so a malformed entry on the shelf would only ever be the
 * result of a hand-edited file.
 */
function assertUsable(entry: { name: string; setup: SavedTournamentSetup }): void {
  if (!entry.name) throw new EngineError('BAD_REQUEST', 'Give this setup a name so you can find it again.');
  if (entry.name.length > MAX_LABEL) {
    throw new EngineError('BAD_REQUEST', `The name must be ${MAX_LABEL} characters or fewer.`);
  }
  const { setup } = entry;
  if (!setup.name) throw new EngineError('BAD_REQUEST', 'The setup needs a tournament name.');
  if (setup.fieldNames.length < 1) {
    throw new EngineError('BAD_REQUEST', 'A setup needs at least one playing field.');
  }
  const roster = setup.format === 'radball' ? setup.radballBulk : setup.fieldBulk;
  const rows = roster.reduce((sum, text) => sum + (text.trim() ? text.split(/\r?\n/).length : 0), 0);
  if (setup.format === 'radball' ? rows < 3 : rows < 2) {
    throw new EngineError(
      'BAD_REQUEST',
      setup.format === 'radball'
        ? 'A Radball setup needs at least 3 teams.'
        : 'A setup needs at least 2 participants.',
    );
  }
  if (rows > MAX_ROSTER_ROWS) {
    throw new EngineError('BAD_REQUEST', `A setup holds at most ${MAX_ROSTER_ROWS} roster rows.`);
  }
  // A manual schedule with no fixture in it cannot create a tournament: the
  // engine has nothing to put on the board and nothing the host could fix on the
  // review step. Refused here, where the wizard is still open and the roster is
  // still in front of them.
  if (setup.format === 'manual-schedule') {
    const usable = setup.manualMatches.filter((entry) => entry.a && entry.b).length;
    if (usable === 0) {
      throw new EngineError(
        'BAD_REQUEST',
        'A manual schedule needs at least one match: pick the two teams that play each other.',
      );
    }
  }
  for (const text of roster) {
    if (typeof text === 'string' && text.length > MAX_ROSTER_CHARS) {
      throw new EngineError('BAD_REQUEST', `One field's roster is too long to save (max ${MAX_ROSTER_CHARS} characters).`);
    }
  }
  // The World Cup preset plays one group per field, so the shelf refuses exactly
  // what the wizard refuses: a team on a third field, or two field rosters that
  // are not the two equal groups of at least two the final phase pairs A-rank
  // against B-rank. A saved setup must be loadable.
  if (setup.format === 'radball' && setup.setupMode === 'ten-team') {
    if (setup.fieldNames.length < 2) {
      throw new EngineError(
        'BAD_REQUEST',
        'The World Cup format needs two playing fields: Group A on field 1, Group B on field 2.',
      );
    }
    const counts = setup.radballBulk.map((text) => text.split(/\r?\n/).filter((line) => line.trim()).length);
    const groupA = counts[0] ?? 0;
    const groupB = counts[1] ?? 0;
    const [fieldA = 'field 1', fieldB = 'field 2'] = setup.fieldNames;
    if (counts.slice(2).some((count) => count > 0)) {
      throw new EngineError(
        'BAD_REQUEST',
        `The World Cup format plays one group per field: put every team on ${fieldA} or ${fieldB}.`,
      );
    }
    if (groupA !== groupB) {
      throw new EngineError(
        'BAD_REQUEST',
        `The World Cup format needs the same number of teams in both groups: ${fieldA} has ${groupA} and ${fieldB} has ${groupB}.`,
      );
    }
    // No separate check for a group of one: the three-row roster floor above and
    // this equal-size rule together leave 2/2 as the smallest legal setup.
  }
}

function markDirty(mut: Mutation): void {
  mut.savedTournaments = true;
  mut.urgency = 'immediate';
}

/**
 * File a setup on the shelf, or overwrite the one named by `id`.
 *
 * Overwriting keeps the entry's identity and `createdAt`, so a shelf label the
 * host already knows does not turn into a different card. The label is only
 * unique among *other* entries: re-saving "City Open 2026" onto itself has to
 * work, or a setup could never be corrected in place.
 */
export function saveTournamentSetup(
  state: TournamentState,
  input: SaveTournamentSetupInput,
  ctx: Ctx,
  mut: Mutation,
): SavedTournamentEntry {
  const library = state.savedTournaments;
  const setup = sanitiseSavedTournamentSetup(input.setup);
  const existing = input.id ? library.entries[input.id] : undefined;
  if (input.id && !existing) {
    throw new EngineError('NOT_FOUND', 'That saved setup is no longer on the shelf.');
  }
  const fallbackLabel = setup.name;
  const name = (input.name ?? '').trim() || (existing?.name ?? fallbackLabel);
  const clash = Object.values(library.entries).find(
    (entry) => entry.id !== existing?.id && entry.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new EngineError('CONFLICT', `The shelf already holds a setup called "${clash.name}".`);
  }
  if (!existing && library.order.length >= MAX_SAVED_TOURNAMENTS) {
    throw new EngineError('BAD_REQUEST', `The shelf holds at most ${MAX_SAVED_TOURNAMENTS} saved setups.`);
  }
  const entry: SavedTournamentEntry = existing
    ? { ...existing, name, setup, updatedAt: ctx.now }
    : {
        id: ctx.newId('s'),
        name,
        setup,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
  assertUsable(entry);
  library.entries[entry.id] = entry;
  if (!existing) library.order.push(entry.id);
  markDirty(mut);
  pushEvent(
    mut,
    existing ? 'SETUP_UPDATED' : 'SETUP_SAVED',
    { key: existing ? 'event.setupUpdated' : 'event.setupSaved', params: { name: entry.name } },
    { data: { setupId: entry.id } },
  );
  return entry;
}

/** Rename a shelf entry without touching the setup it points at. */
export function renameTournamentSetup(
  state: TournamentState,
  id: string,
  rawName: string,
  ctx: Ctx,
  mut: Mutation,
): SavedTournamentEntry {
  const library = state.savedTournaments;
  const entry = library.entries[id];
  if (!entry) throw new EngineError('NOT_FOUND', 'That saved setup is no longer on the shelf.');
  const name = rawName.trim();
  assertUsable({ name, setup: entry.setup });
  const clash = Object.values(library.entries).find(
    (other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new EngineError('CONFLICT', `The shelf already holds a setup called "${clash.name}".`);
  }
  entry.name = name;
  entry.updatedAt = ctx.now;
  markDirty(mut);
  pushEvent(mut, 'SETUP_UPDATED', { key: 'event.setupRenamed', params: { name } }, {
    data: { setupId: id },
  });
  return entry;
}

export function removeTournamentSetup(
  state: TournamentState,
  id: string,
  mut: Mutation,
): SavedTournamentEntry {
  const library = state.savedTournaments;
  const entry = library.entries[id];
  if (!entry) throw new EngineError('NOT_FOUND', 'That saved setup is no longer on the shelf.');
  delete library.entries[id];
  library.order = library.order.filter((entryId) => entryId !== id);
  markDirty(mut);
  pushEvent(mut, 'SETUP_REMOVED', { key: 'event.setupRemoved', params: { name: entry.name } }, {
    data: { setupId: id },
  });
  return entry;
}

/**
 * Defensive normalisation of a shelf read from disk or a backup file. Entries
 * that cannot be made sense of are dropped rather than refusing to start, so a
 * hand-edited file can never take the whole scoreboard down with it.
 */
export function sanitiseSavedTournamentLibrary(input: unknown): SavedTournamentLibrary {
  if (!isRecord(input)) return emptySavedTournamentLibrary();
  const source = isRecord(input.entries) ? input.entries : {};
  const entries: Record<string, SavedTournamentEntry> = {};
  for (const [id, value] of Object.entries(source)) {
    if (!id || !isRecord(value)) continue;
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_LABEL) : '';
    if (!name) continue;
    const setup = sanitiseSavedTournamentSetup(value.setup);
    // A shelf entry with nothing to create is noise the host cannot act on.
    if (setup.format === 'radball' ? countRows(setup.radballBulk) < 3 : countRows(setup.fieldBulk) < 2) {
      continue;
    }
    const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now();
    entries[id] = {
      id,
      name,
      setup,
      createdAt,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : createdAt,
    };
  }
  // The first name to claim a spelling keeps it, so two cards that say the same
  // thing can never leave the host choosing between identical entries.
  const claimed = new Set<string>();
  for (const id of Object.keys(entries)) {
    const entry = entries[id];
    if (!entry) continue;
    const key = entry.name.toLowerCase();
    if (claimed.has(key)) {
      delete entries[id];
      continue;
    }
    claimed.add(key);
  }
  const order = Array.isArray(input.order)
    ? input.order.filter((id): id is string => typeof id === 'string' && Boolean(entries[id]))
    : [];
  const seen = new Set(order);
  for (const id of Object.keys(entries)) {
    if (!seen.has(id)) order.push(id);
  }
  return { entries, order };
}

function countRows(bulk: string[]): number {
  return bulk.reduce((sum, text) => sum + (text.trim() ? text.split(/\r?\n/).length : 0), 0);
}