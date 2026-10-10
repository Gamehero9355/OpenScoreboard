/**
 * The saved-setup bridge: turns the wizard's draft into something the host can
 * put on the shelf, and a shelf entry back into a draft the wizard can show.
 *
 * Everything here is pure so the round trip can be tested without a DOM, and so
 * the rule "a saved setup must reproduce the wizard exactly" has one home
 * rather than being spread across the page.
 *
 * The roster is stored as the host typed it, per playing field, rather than as
 * parsed rows. Parsed rows would be tidier but would lose the original
 * spelling, the blank line and the half-finished last row -- and a loaded setup
 * has to come back as text the host can still read and correct in place.
 */
import {
  orderedSavedTournaments,
  type DrawMode,
  type RadballAgeCategory,
  type RadballFinalMode,
  type RadballSetupMode,
  type SavedManualMatch,
  type SavedTournamentEntry,
  type SavedTournamentLibrary,
  type SavedTournamentSetup,
  type TournamentFormat,
} from '../../shared/types';
import { formatDurationInput, parseDurationInput, parseScoringIncrements } from './util';
import { tr, type MessageKey, type MessageParams } from './i18n';

/**
 * A `t()` bound to one locale, threaded into the shelf labels below.
 *
 * Optional, so the round-trip tests keep the English strings they assert on and
 * the panel passes the translator in.
 */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The buttons a bracket offers when the wizard's box is unusable. */
const DEFAULT_INCREMENTS = [1, 2, 3];

/** What an empty or unreadable duration box means, in seconds. */
const DURATION_FALLBACK_SEC = 600;

/**
 * The parts of the wizard draft a saved setup reproduces.
 *
 * `SetupDraft` in the setup page extends this and adds only what is *not* worth
 * shelving: which step the host had reached, and when the local draft was last
 * touched. Declaring the shared half here means the two cannot drift.
 */
export interface SetupDraftFields {
  name: string;
  format: TournamentFormat;
  fieldNames: string[];
  fieldBulk: string[];
  radballBulk: string[];
  thirdPlace: boolean;
  seeded: boolean;
  seedValue: string;
  drawMode: DrawMode;
  manualSlots: (string | null)[];
  /**
   * The fixtures of a manual schedule, in the host's own order. Empty for every
   * other format, which has no fixtures until the engine draws them.
   */
  manualMatches: SavedManualMatch[];
  durationInput: string;
  incrementsInput: string;
  autoLoadNext: boolean;
  autoAssignNext: boolean;
  ageCategory: RadballAgeCategory;
  reducedTime: boolean;
  minRestInput: string;
  radballSetupMode: RadballSetupMode;
  groupCount: number;
  doubleLeg: boolean;
  rbFinalMode: RadballFinalMode;
  bdrPreset: boolean;
}

export interface SavedSetupPatch {
  name: string;
  durationInput: string;
  incrementsInput: string;
  minRestInput: string;
}

/** Save today's wizard state under a shelf label. */
export function draftToSetup(draft: SetupDraftFields): SavedTournamentSetup {
  return {
    version: 1,
    name: draft.name.trim(),
    format: draft.format,
    fieldNames: [...draft.fieldNames],
    fieldBulk: [...draft.fieldBulk],
    radballBulk: [...draft.radballBulk],
    thirdPlace: draft.thirdPlace,
    seeded: draft.seeded,
    seedValue: draft.seedValue,
    drawMode: draft.drawMode,
    manualSlots: [...draft.manualSlots],
    manualMatches: draft.manualMatches.map((entry) => ({ ...entry })),
    // The wizard keeps its duration and rest as free text so the host can type
    // "12:30" mid-edit; the shelf keeps the parsed number, and a blank box goes
    // back to the same 10 minutes the wizard would have used.
    durationSec: parseDurationInput(draft.durationInput) ?? DURATION_FALLBACK_SEC,
    scoringIncrements: parseScoringIncrements(draft.incrementsInput) ?? DEFAULT_INCREMENTS,
    autoLoadNext: draft.autoLoadNext,
    autoAssignNext: draft.autoAssignNext,
    ageCategory: draft.ageCategory,
    reducedTime: draft.reducedTime,
    minRestMinutes: Number(draft.minRestInput) || 0,
    setupMode: draft.radballSetupMode,
    groupCount: draft.groupCount,
    doubleLeg: draft.doubleLeg,
    finalMode: draft.rbFinalMode,
    bdrPreset: draft.bdrPreset,
  };
}

/**
 * The four wizard fields that are text in the draft and numbers on the shelf.
 * Returned as a patch rather than a whole draft so loading a setup replaces
 * every field it owns without touching the host's step position or the draft's
 * own bookkeeping.
 */
export function setupToDraftPatch(setup: SavedTournamentSetup): SavedSetupPatch {
  return {
    name: setup.name,
    durationInput: formatDurationInput(setup.durationSec),
    incrementsInput: setup.scoringIncrements.join(','),
    minRestInput: String(setup.minRestMinutes),
  };
}

/**
 * The draft that loading a setup produces.
 *
 * Built from the defaults the host is already set up for -- their field names
 * and match settings -- with everything the saved setup knows about laid on
 * top. That means a loaded setup inherits no stale value the shelf did not
 * actually record, while the wizard's own defaults still apply to anything a
 * future version of the shelf stops storing.
 */
export function setupToDraft(
  setup: SavedTournamentSetup,
  base: SetupDraftFields,
): SetupDraftFields {
  const patch = setupToDraftPatch(setup);
  return {
    ...base,
    ...patch,
    format: setup.format,
    fieldNames: [...setup.fieldNames],
    fieldBulk: [...setup.fieldBulk],
    radballBulk: [...setup.radballBulk],
    thirdPlace: setup.thirdPlace,
    seeded: setup.seeded,
    seedValue: setup.seedValue,
    drawMode: setup.drawMode,
    manualSlots: [...setup.manualSlots],
    manualMatches: setup.manualMatches.map((entry) => ({ ...entry })),
    autoLoadNext: setup.autoLoadNext,
    autoAssignNext: setup.autoAssignNext,
    ageCategory: setup.ageCategory,
    reducedTime: setup.reducedTime,
    radballSetupMode: setup.setupMode,
    groupCount: setup.groupCount,
    doubleLeg: setup.doubleLeg,
    rbFinalMode: setup.finalMode,
    bdrPreset: setup.bdrPreset,
  };
}

/* ------------------------------------------------------------------ */
/* Shelf browsing                                                     */
/* ------------------------------------------------------------------ */

/** Saved setups, most recently updated first. */
export function savedSetups(
  library: SavedTournamentLibrary | null | undefined,
): SavedTournamentEntry[] {
  return orderedSavedTournaments(library);
}

/** The name shown on a shelf card: the label, falling back to the setup name. */
export function savedSetupLabel(entry: SavedTournamentEntry): string {
  return entry.name || entry.setup.name || tr('saved.untitled');
}

/** Count the non-blank roster lines a setup carries. */
export function savedSetupRosterCount(setup: SavedTournamentSetup): number {
  const bulk = setup.format === 'radball' ? setup.radballBulk : setup.fieldBulk;
  return bulk.reduce((sum, text) => sum + (text.trim() ? text.split(/\r?\n/).length : 0), 0);
}

export function savedSetupFieldCount(setup: SavedTournamentSetup): number {
  return setup.fieldNames.length;
}

/** "Single elimination", "Radball 2er", ... in the host's own vocabulary. */
export function savedSetupFormatLabel(setup: SavedTournamentSetup, t?: Translate): string {
  const say = t ?? tr;
  if (setup.format === 'radball') return say('format.radball');
  if (setup.format === 'double-elimination') return say('format.double-elimination');
  if (setup.format === 'manual-schedule') return say('format.manual-schedule');
  return say('format.single-elimination');
}

export interface SavedSetupSummary {
  format: string;
  fields: number;
  roster: string;
  /** The one thing about the rules that is not the same for every event. */
  rule: string | null;
}

export interface SavedSetupFacts extends SavedSetupSummary {
  updated: string;
}

/**
 * What a setup is made of, in the host's own words: how many people are on it,
 * over how many fields, and whatever rule actually differs (an age category, a
 * 10-team split, a seeded draw).
 *
 * Takes a bare setup rather than a shelf entry so the built-in examples can be
 * described by the same words as the host's own setups.
 */
export function savedSetupSummary(setup: SavedTournamentSetup, t?: Translate): SavedSetupSummary {
  const roster =
    setup.format === 'radball'
      ? tr('setup.countTeams', { n: savedSetupRosterCount(setup) })
      : tr('setup.countParticipants', { n: savedSetupRosterCount(setup) });
  return {
    format: savedSetupFormatLabel(setup, t),
    fields: savedSetupFieldCount(setup),
    roster,
    rule: savedSetupRule(setup, t),
  };
}

/** The same description plus when the shelf entry was last touched. */
export function savedSetupFacts(
  entry: SavedTournamentEntry,
  now = Date.now(),
  t?: Translate,
): SavedSetupFacts {
  return { ...savedSetupSummary(entry.setup, t), updated: relativeDate(entry.updatedAt, now) };
}

/**
 * The one rule that differs between two otherwise identical setups.
 *
 * Only the branches the catalogue names are translated; "N groups", "home &
 * away", "ranking matches", "N min rest" and "one group" have no entry, so those
 * stay English rather than borrowing a phrase that would name a different rule.
 */
function savedSetupRule(setup: SavedTournamentSetup, t?: Translate): string | null {
  const say = t ?? tr;
  if (setup.format === 'radball') {
    if (setup.bdrPreset) return say('saved.bdrPreset');
    if (setup.setupMode === 'ten-team') return say('saved.worldCup10');
    if (setup.setupMode === 'advanced') {
      const parts = [
        say(setup.groupCount === 1 ? 'saved.groupOne' : 'saved.groupMany', {
          n: setup.groupCount,
        }),
      ];
      if (setup.doubleLeg) parts.push(say('saved.homeAway'));
      if (setup.finalMode !== 'none') {
        parts.push(say(setup.finalMode === 'ranking-matches' ? 'saved.rankingMatches' : 'saved.finalRoundRobin'));
      }
      if (setup.minRestMinutes > 0) parts.push(say('saved.minRest', { n: setup.minRestMinutes }));
      return `${setup.ageCategory} · ${parts.join(' · ')}`;
    }
    return `${setup.ageCategory} · ${say('saved.oneGroup')}`;
  }
  if (setup.drawMode === 'manual') return say('saved.placedByHand');
  // A manual schedule has no draw at all: the host wrote the fixtures down, so
  // the number of them is the one fact that separates two otherwise equal
  // setups. Everything else about it -- the roster, the fields, the clock -- is
  // already on the card.
  if (setup.format === 'manual-schedule') {
    const count = setup.manualMatches.filter((entry) => entry.a && entry.b).length;
    return say(count === 1 ? 'saved.manualOne' : 'saved.manualMany', { n: count });
  }
  if (!setup.seeded) return say('saved.randomDraw');
  if (setup.thirdPlace && setup.format === 'single-elimination') {
    return say('saved.seededBronze');
  }
  return say('saved.seededDraw');
}

/** "just now" / "3 days ago" / a date, matching the host's plain vocabulary. */
function relativeDate(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return tr('saved.unknownDate');
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return tr('saved.today');
  if (days === 1) return tr('saved.yesterday');
  if (days < 30) return tr('saved.daysAgo', { n: days });
  const date = new Date(ts);
  return tr('saved.date', { date: date.toLocaleDateString() });
}