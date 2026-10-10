import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { parseLogoName, type ParticipantInput, type RadballCreateInput } from '../../shared/commands';
import type { ExampleSetup } from '../../shared/examples';
import type {
  RadballAgeCategory,
  RadballSetupMode,
  SavedManualMatch,
  SavedTournamentEntry,
  SavedTournamentSetup,
  Settings,
  TournamentFormat,
} from '../../shared/types';
import {
  MAX_FIELDS,
  MAX_MANUAL_MATCHES,
  RADBALL_AGE_CATEGORIES,
  RADBALL_RULESET_VERSION,
  defaultFieldNames,
  radballHalfSec,
} from '../../shared/types';
import { dealKeysIntoPairs, reconcileSlots, shuffleKeys } from '../lib/draw';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import { Link, navigate } from '../lib/router';
import { draftToSetup, savedSetups, setupToDraft, type SetupDraftFields } from '../lib/saved';
import {
  ageGroupLabel,
  libraryParticipantLines,
  libraryRosterLines,
  teamsInAgeGroup,
} from '../lib/teams';
import { cx, formatDurationInput, parseDurationInput, parseScoringIncrements } from '../lib/util';
import { tr } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';
import {
  Button,
  ConfirmDialog,
  Panel,
  Segmented,
  Steps,
  Switch,
  TextField,
} from '../components/primitives';
import { SaveSetupDialog, SavedTournamentsPanel } from '../components/SavedTournamentsPanel';
import { IconSave } from '../components/icons';
import { WorldCupGroups, type WorldCupGroupView } from '../components/WorldCupGroups';
import { CrestWithName } from '../components/TeamCrest';

const SETUP_DRAFT_KEY = 'tsb.setup.draft.v1';
const DURATION_PRESETS_MIN = [3, 5, 8, 10, 15];
const DURATION_MAX_SEC = 120 * 60;
const DURATION_MIN_SEC = 10;

const GENERIC_EXAMPLE = [
  'Player One,Team A',
  'Player Two,Team A',
  'Player Three,Team B',
  'Player Four,Team B',
];

const RADBALL_EXAMPLE = [
  'RV Gärtringen I,Max Mustermann,Alexander Muster',
  'RV Süd I,Jonas Becker,Finn Wagner',
  'RV Nord I,Luis Hoffmann,Paul Zimmermann',
  'RV Ost I,Elias Krüger,Noah Schmitt',
  'RV West I,Theo Braun,Levi Fischer',
];

/**
 * Ten squads for the World Cup, so one click fills two equal groups.
 *
 * The five-team list above cannot: a World Cup needs two equal rosters and the
 * split is the roster, so dealing five lines round-robin across two fields would
 * hand the host a 3/2 tournament the format then refuses. This list is dealt in
 * halves instead -- the first five onto Group A's field, the last five onto
 * Group B's -- which is the shape the example is worth demonstrating.
 */
const RADBALL_WORLD_CUP_EXAMPLE = [
  'RV Gärtringen I,Max Mustermann,Alexander Muster',
  'RV Süd I,Jonas Becker,Finn Wagner',
  'RV Nord I,Luis Hoffmann,Paul Zimmermann',
  'RV Ost I,Elias Krüger,Noah Schmitt',
  'RV West I,Theo Braun,Levi Fischer',
  'RV Mitte I,Lukas Sommer,Felix Winter',
  'RV Tal I,Anton Berger,Emil Krone',
  'RV Berg I,Milo Hartmann,Oskar Pohl',
  'RV See I,Rafael Kern,Vincent Roth',
  'RV Feld I,Simon Adler,Tobias Ludwig',
];

/**
 * Teams per group in the World Cup mode, or 0 when the two field rosters cannot
 * be two equal groups of at least two.
 *
 * The groups *are* the field rosters, so this is not a draw result: it is the
 * smaller of the two rosters the host typed, and zero when they disagree. The
 * rules step and the review both read it, so a roster of 12 split 6/6 reads 6
 * and a roster spread 7/5 says why the format cannot be used at all.
 */
function worldCupGroupSize(sizes: number[]): number {
  const [first, second] = sizes;
  if (first === undefined || second === undefined || first !== second) return 0;
  return first >= 2 ? first : 0;
}

/** The teams on field 1 and field 2, in field order: the two group sizes. */
function worldCupFieldCounts(teams: ParsedRadballTeam[]): number[] {
  return ['1', '2'].map((fieldId) => teams.filter((team) => team.fieldId === fieldId).length);
}

/**
 * The two groups, built from the field rosters: Field 1 is Group A, Field 2 is
 * Group B.
 *
 * Not a split that is decided anywhere -- it is what "the team was registered on
 * this field" means, spelled out once so the preview, the review step and the
 * summary all describe the same two rosters.
 */
function worldCupGroups(teams: ParsedRadballTeam[], fieldNames: string[]): WorldCupGroupView[] {
  return (['A', 'B'] as const).map((letter, index) => {
    const fieldId = String(index + 1);
    return {
      letter,
      fieldName: fieldLabel(fieldNames, fieldId),
      teams: teams.filter((team) => team.fieldId === fieldId).map((team) => team.name),
    };
  });
}

/** The same two groups, as named slots for the review step: "A1 Team A", "B3 Team H". */
function worldCupSlots(teams: ParsedRadballTeam[]): { slot: string; name: string }[] {
  return (['1', '2'] as const).flatMap((fieldId, groupIndex) =>
    teams
      .filter((team) => team.fieldId === fieldId)
      .map((team, slot) => ({ slot: `${String.fromCharCode(65 + groupIndex)}${slot + 1}`, name: team.name })),
  );
}

/**
 * The first team the World Cup format cannot place, and why.
 *
 * A team is placed by the field it sits on, so the only ways to fail are a team
 * on a third field (there is no group for it) and two rosters of different sizes
 * (the final phase pairs A-rank r with B-rank r). Both are the host's to fix on
 * the Radball teams step, and the message names the field and the count rather
 * than the rule.
 */
function worldCupRosterProblem(teams: ParsedRadballTeam[], fieldNames: string[]): string | null {
  const adrift = teams.find((team) => team.fieldId !== '1' && team.fieldId !== '2');
  if (adrift) {
    return tr('setup.err.wcAdrift', {
      team: adrift.name,
      where: adrift.fieldId ? fieldLabel(fieldNames, adrift.fieldId) : tr('setup.noField'),
      a: fieldLabel(fieldNames, '1'),
      b: fieldLabel(fieldNames, '2'),
    });
  }
  const groupA = teams.filter((team) => team.fieldId === '1').length;
  const groupB = teams.filter((team) => team.fieldId === '2').length;
  if (groupA !== groupB) {
    return tr('setup.err.wcUneven', {
      a: fieldLabel(fieldNames, '1'),
      aCount: groupA,
      b: fieldLabel(fieldNames, '2'),
      bCount: groupB,
    });
  }
  if (groupA < 2) {
    return tr('setup.err.wcTooSmall', { count: groupA });
  }
  return null;
}

/** The two ways into a tournament: build one, or open one the host filed. */
type SetupMode = 'create' | 'load';

export interface ParsedRadballTeam {
  name: string;
  club: string | null;
  players: [string, string];
  /** Crest file name from the logos folder, or null for the folder default. */
  logo: string | null;
  fieldId?: string | null;
  line?: number;
}

export interface ParsedParticipant {
  name: string;
  team: string | null;
  seed: number | null;
  checkedIn: boolean;
  /** Crest file name from the logos folder, when the row carried one. */
  logo: string | null;
  fieldId?: string | null;
  line?: number;
}

/**
 * The wizard's working state.
 *
 * Everything a saved setup reproduces lives on `SetupDraftFields`, so the shelf
 * and the wizard can never disagree about what a setup contains. What is left
 * here is deliberately unfiled: which step the host had reached, and when the
 * local draft was last touched.
 */
interface SetupDraft extends SetupDraftFields {
  version: 1;
  step: number;
  savedAt: number;
}

interface RosterIssue {
  line: number;
  fieldId?: string | null;
  message: string;
}

interface TournamentCreatePayload {
  name: string;
  format: TournamentFormat;
  participants: ParticipantInput[];
  thirdPlaceMatch: boolean;
  seeded: boolean;
  seedValue: number | null;
  settings: Record<string, unknown> | null;
  generateBracket: boolean;
  fieldNames: string[];
  manualOrder?: (number | null)[];
  manualMatches?: { a: number; b: number; round?: string; fieldId?: string }[];
  radball?: RadballCreateInput | null;
}

interface EffectiveSetup {
  payload: TournamentCreatePayload;
  settings: Record<string, unknown>;
  durationSec: number;
  increments: number[];
  participants: ParticipantInput[];
  trimmedFields: string[];
}

function emptyBulk(count = MAX_FIELDS): string[] {
  return Array.from({ length: count }, () => '');
}

export function createDraft(settings?: Settings): SetupDraft {
  const fieldNames = settings?.fieldNames?.length ? [...settings.fieldNames] : defaultFieldNames(2);
  return {
    version: 1,
    step: 0,
    name: '',
    format: 'single-elimination',
    fieldNames,
    fieldBulk: emptyBulk(),
    radballBulk: emptyBulk(),
    thirdPlace: true,
    seeded: true,
    seedValue: '20260921',
    drawMode: 'auto',
    manualSlots: [],
    manualMatches: [],
    durationInput: formatDurationInput(settings?.defaultMatchDurationSec ?? 600),
    incrementsInput: (settings?.scoringIncrements ?? [1, 2, 3]).join(','),
    autoLoadNext: settings?.autoLoadNext ?? true,
    autoAssignNext: settings?.autoAssignNext ?? true,
    ageCategory: 'ELITE',
    reducedTime: false,
    minRestInput: '0',
    radballSetupMode: 'standard',
    groupCount: 1,
    doubleLeg: false,
    rbFinalMode: 'none',
    bdrPreset: false,
    savedAt: 0,
  };
}

/**
 * Which step this format's wizard ends on.
 *
 * Every format asks event, format, fields, teams, one rules step and review --
 * six steps. The manual schedule asks seven, because "which matches do I want"
 * and "how long is a match, how is it scored" are two different questions, and
 * collapsing them into one panel is what made that step feel like a wall.
 *
 * Everything downstream reads the ceiling from here rather than from a literal 5,
 * so a format gaining a step is one change rather than seven.
 */
export function lastStepOf(format: TournamentFormat): number {
  return format === 'manual-schedule' ? 6 : 5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, fallback: string[], count = MAX_FIELDS): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const list = value.filter((entry): entry is string => typeof entry === 'string').slice(0, count);
  while (list.length < count) list.push('');
  return list;
}

export function normaliseDraft(value: unknown, settings?: Settings): SetupDraft | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const base = createDraft(settings);
  const format =
    value.format === 'single-elimination' ||
    value.format === 'double-elimination' ||
    value.format === 'radball' ||
    value.format === 'manual-schedule'
      ? value.format
      : base.format;
  // The manual schedule is one step longer, so a recovered draft of one has to be
  // allowed to sit on the step the others do not have. Reading the format first is
  // what makes the right ceiling available.
  const step = typeof value.step === 'number' && Number.isInteger(value.step)
    ? Math.max(0, Math.min(lastStepOf(format), value.step))
    : 0;
  const fieldNames = Array.isArray(value.fieldNames)
    ? value.fieldNames.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_FIELDS)
    : base.fieldNames;
  if (fieldNames.length < 1) return null;
  const manualSlots = Array.isArray(value.manualSlots)
    ? value.manualSlots.slice(0, 512).map((entry) => (typeof entry === 'string' ? entry : null))
    : [];
  const manualMatches = Array.isArray(value.manualMatches)
    ? value.manualMatches.slice(0, MAX_MANUAL_MATCHES).map((entry) => normaliseManualMatch(entry))
    : [];
  const radballSetupMode =
    value.radballSetupMode === 'advanced' || value.radballSetupMode === 'ten-team'
      ? value.radballSetupMode
      : 'standard';
  return {
    ...base,
    step,
    name: typeof value.name === 'string' ? value.name.slice(0, 80) : '',
    format,
    fieldNames,
    fieldBulk: stringList(value.fieldBulk, base.fieldBulk),
    radballBulk: stringList(value.radballBulk, base.radballBulk),
    thirdPlace: typeof value.thirdPlace === 'boolean' ? value.thirdPlace : base.thirdPlace,
    seeded: typeof value.seeded === 'boolean' ? value.seeded : base.seeded,
    seedValue: typeof value.seedValue === 'string' ? value.seedValue.slice(0, 20) : base.seedValue,
    drawMode: value.drawMode === 'manual' ? 'manual' : 'auto',
    manualSlots,
    manualMatches,
    durationInput:
      typeof value.durationInput === 'string' ? value.durationInput.slice(0, 12) : base.durationInput,
    incrementsInput:
      typeof value.incrementsInput === 'string' ? value.incrementsInput.slice(0, 40) : base.incrementsInput,
    autoLoadNext: typeof value.autoLoadNext === 'boolean' ? value.autoLoadNext : base.autoLoadNext,
    autoAssignNext: typeof value.autoAssignNext === 'boolean' ? value.autoAssignNext : base.autoAssignNext,
    ageCategory: RADBALL_AGE_CATEGORIES.includes(value.ageCategory as RadballAgeCategory)
      ? (value.ageCategory as RadballAgeCategory)
      : base.ageCategory,
    reducedTime: typeof value.reducedTime === 'boolean' ? value.reducedTime : base.reducedTime,
    minRestInput: typeof value.minRestInput === 'string' ? value.minRestInput.slice(0, 3) : base.minRestInput,
    radballSetupMode,
    groupCount:
      typeof value.groupCount === 'number' && Number.isInteger(value.groupCount)
        ? Math.max(1, Math.min(4, value.groupCount))
        : base.groupCount,
    doubleLeg: typeof value.doubleLeg === 'boolean' ? value.doubleLeg : base.doubleLeg,
    rbFinalMode:
      value.rbFinalMode === 'round-robin' || value.rbFinalMode === 'ranking-matches'
        ? value.rbFinalMode
        : 'none',
    bdrPreset: typeof value.bdrPreset === 'boolean' ? value.bdrPreset : false,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
  };
}

function loadDraft(settings?: Settings): { draft: SetupDraft; recovered: boolean } {
  try {
    const raw = window.localStorage.getItem(SETUP_DRAFT_KEY);
    if (!raw) return { draft: createDraft(settings), recovered: false };
    const parsed = normaliseDraft(JSON.parse(raw), settings);
    if (!parsed || parsed.savedAt === 0) return { draft: createDraft(settings), recovered: false };
    return { draft: parsed, recovered: true };
  } catch {
    return { draft: createDraft(settings), recovered: false };
  }
}

export function clearSetupDraft(): void {
  try {
    window.localStorage.removeItem(SETUP_DRAFT_KEY);
  } catch {
    return;
  }
}

export function parseRadballTeams(raw: string): ParsedRadballTeam[] {
  const out: ParsedRadballTeam[] = [];
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cells = splitCsvLine(trimmed);
    const name = (cells[0] ?? '').trim();
    const headerCells = cells.map((cell) => cell.trim().toLowerCase());
    const isHeader =
      /^(team|team name|name)$/.test(headerCells[0] ?? '') &&
      headerCells.slice(1).some((cell) =>
        /^(club|team name|player 1|player 2|player one|player two|name 1|name 2|rider 1|rider 2)$/.test(cell),
      );
    if (isHeader) return;
const hasLegacyClubColumn = cells.length >= 4;
    // A fifth column carries the crest file name. It is optional and always
    // last, so a hand-typed three- or four-column roster keeps working and a
    // roster saved before logos existed is unchanged.
    const logo = cells.length >= 5 ? (cells[4] ?? '').trim() || null : null;
    out.push({
      name,
      club: hasLegacyClubColumn ? (cells[1] ?? '').trim() || null : null,
      players: hasLegacyClubColumn
        ? [(cells[2] ?? '').trim(), (cells[3] ?? '').trim()]
        : [(cells[1] ?? '').trim(), (cells[2] ?? '').trim()],
      logo,
      line: index + 1,
    });
  });
  return out;
}

export function parseParticipants(raw: string): ParsedParticipant[] {
  const out: ParsedParticipant[] = [];
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cells = splitCsvLine(trimmed);
    const name = (cells[0] ?? '').trim();
    if (!name || /^(name|participant|player|team ?name)$/i.test(name)) return;
    const team = (cells[1] ?? '').trim();
    const seedRaw = (cells[2] ?? '').trim();
    // A crest is a bare file name and always the last column, so a hand-typed
    // three-column roster is unchanged and a squad picked out of the library
    // keeps its mark.
    const logo = parseLogoName(cells[3]);
    out.push({
      name,
      team: team || null,
      seed: /^\d+$/.test(seedRaw) ? Number(seedRaw) : null,
      checkedIn: true,
      logo,
      line: index + 1,
    });
  });
  return out;
}

/**
 * The example roster, dealt across the wizard's field tabs.
 *
 * The World Cup is dealt in *halves*, because its groups are the field rosters:
 * dealing the ten squads round-robin across two fields would fill them 5/5 by
 * accident and 3/2 on any other split, and the format would then refuse the
 * tournament the host just asked for. Every other format keeps the round-robin
 * deal, which balances a roster the host has not sorted by field yet.
 */
export function exampleRosterFill(
  mode: { format: TournamentFormat; radballSetupMode: RadballSetupMode },
  fieldCount: number,
): string[] {
  const radball = mode.format === 'radball';
  const worldCup = radball && mode.radballSetupMode === 'ten-team' && fieldCount >= 2;
  const source = radball
    ? worldCup
      ? RADBALL_WORLD_CUP_EXAMPLE
      : RADBALL_EXAMPLE
    : GENERIC_EXAMPLE;
  const next = emptyBulk();
  if (worldCup) {
    const half = Math.ceil(source.length / 2);
    next[0] = source.slice(0, half).join('\n');
    next[1] = source.slice(half).join('\n');
    return next;
  }
  for (let index = 0; index < fieldCount; index += 1) {
    next[index] = source.filter((_, row) => row % fieldCount === index).join('\n');
  }
  return next;
}

export function participantKey(participant: { name: string; team: string | null }): string {
  return `${participant.name.toLowerCase()}|${(participant.team ?? '').toLowerCase()}`;
}

/**
 * One fixture of a manual schedule, as the wizard holds it.
 *
 * The sides are participant keys -- the same currency `manualSlots` spends --
 * so the list survives a rename of a team and a reload of a saved setup without
 * pointing at an id that no longer exists. `fieldIndex` is 0-based so it tracks
 * the field strip rather than the field's display name.
 */
export interface DraftManualMatch extends SavedManualMatch {}

/** The blank fixture the "Add match" button appends. */
function emptyManualMatch(): DraftManualMatch {
  return { a: null, b: null, round: '', fieldIndex: null };
}

/** Clamp anything read back from storage or a saved setup into a usable row. */
function normaliseManualMatch(value: unknown): DraftManualMatch {
  if (!isRecord(value)) return emptyManualMatch();
  const round = typeof value.round === 'string' ? value.round.slice(0, 24) : '';
  const fieldIndex =
    typeof value.fieldIndex === 'number' && Number.isInteger(value.fieldIndex) && value.fieldIndex >= 0
      ? value.fieldIndex
      : null;
  return {
    a: typeof value.a === 'string' && value.a ? value.a.slice(0, 200) : null,
    b: typeof value.b === 'string' && value.b ? value.b.slice(0, 200) : null,
    round,
    fieldIndex,
  };
}

/** True when a fixture names two roster entries and neither side is missing. */
export function isCompleteManualMatch(match: DraftManualMatch): boolean {
  return Boolean(match.a && match.b);
}

/** Fixtures that are ready to become matches, with the half-filled ones dropped. */
export function completeManualMatches(matches: DraftManualMatch[]): DraftManualMatch[] {
  return matches.filter(isCompleteManualMatch);
}

function splitCsvLine(line: string): string[] {
  const separator = line.includes(';') && !line.includes(',') ? ';' : ',';
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.replace(/^\uFEFF/, ''));
}

export function mergeRoster<T extends { fieldId?: string | null }>(bulk: string[], parse: (raw: string) => T[]): T[] {
  return bulk.flatMap((raw, index) => parse(raw).map((entry) => ({ ...entry, fieldId: String(index + 1) })));
}

export function rosterIssues(teams: ParsedRadballTeam[], fieldNames: string[] = []): RosterIssue[] {
  const issues: RosterIssue[] = [];
  const teamNames = new Map<string, { name: string; line: number; fieldId?: string | null }[]>();
  const people = new Map<string, { name: string; line: number; fieldId?: string | null }[]>();
  const fieldScope = (fieldId: string | null | undefined): string => fieldId ?? '';
  const addOccurrence = (
    map: Map<string, { name: string; line: number; fieldId?: string | null }[]>,
    key: string,
    name: string,
    line: number,
    fieldId: string | null,
  ) => {
    const occurrences = map.get(key) ?? [];
    occurrences.push({ name, line, fieldId });
    map.set(key, occurrences);
  };
  const reportDuplicates = (
    map: Map<string, { name: string; line: number; fieldId?: string | null }[]>,
    format: (name: string) => string,
    rule: string,
  ) => {
    for (const occurrences of map.values()) {
      const first = occurrences[0];
      for (let index = 1; index < occurrences.length; index += 1) {
        const current = occurrences[index];
        const firstField = first.fieldId ? fieldLabel(fieldNames, first.fieldId) : tr('setup.unassignedField');
        const firstLocation = tr('setup.atLocation', { field: firstField, line: first.line });
        issues.push({
          line: current.line,
          fieldId: current.fieldId,
          message: tr('setup.err.duplicateAt', { what: format(first.name), where: firstLocation, rule }),
        });
      }
    }
  };
  for (const team of teams) {
    const line = team.line ?? 0;
    const fieldId = team.fieldId ?? null;
    const addIssue = (message: string) => issues.push({ line, fieldId, message });
    if (!team.name) {
      addIssue(tr('setup.err.teamName'));
    } else if (team.name.length > 60) {
      addIssue(tr('setup.err.teamNameLong'));
    }
    if (team.club && team.club.length > 60) {
      addIssue(tr('setup.err.clubLong'));
    }
    if (!team.players[0] || !team.players[1]) {
      addIssue(tr('setup.err.bothPlayers'));
    } else if (team.players[0].toLowerCase() === team.players[1].toLowerCase()) {
      addIssue(tr('setup.err.samePlayer'));
    }
    if (team.players.some((player) => player.length > 60)) {
      addIssue(tr('setup.err.playerLong'));
    }
    if (team.name) {
      addOccurrence(teamNames, `${fieldScope(fieldId)}|${team.name.toLowerCase()}`, team.name, line, fieldId);
    }
    const [firstPlayer, secondPlayer] = team.players;
    if (firstPlayer) {
      addOccurrence(people, `${fieldScope(fieldId)}|${firstPlayer.toLowerCase()}`, firstPlayer, line, fieldId);
    }
    if (secondPlayer && secondPlayer.toLowerCase() !== firstPlayer?.toLowerCase()) {
      addOccurrence(people, `${fieldScope(fieldId)}|${secondPlayer.toLowerCase()}`, secondPlayer, line, fieldId);
    }
  }
  reportDuplicates(teamNames, (name) => tr('setup.roster.teamNamed', { name }), tr('setup.err.teamUnique'));
  reportDuplicates(people, (name) => tr('setup.roster.playerNamed', { name }), tr('setup.err.playerUnique'));
  return issues;
}

function rosterIssueSummary(issues: RosterIssue[]): string {
  const count = issues.length;
  if (count === 0) return '';
  const first = issues[0];
  if (!first) return tr('setup.err.rosterSummaryMany', { count, message: '' });
  return tr(count === 1 ? 'setup.err.rosterSummaryOne' : 'setup.err.rosterSummaryMany', {
    count,
    message: first.message,
  });
}

/**
 * Per-row problems in a generic roster, so the panel can name each one instead
 * of reporting a count.
 *
 * Each issue carries the `fieldId` of the roster it came from. That is the whole
 * difference between a list a host can act on and "5 Probleme": the panel shows
 * one field's rows, the check runs over all of them, and a line number with no
 * field points at nothing they are looking at.
 */
export function participantIssues(participants: ParsedParticipant[], fieldNames: string[] = []): RosterIssue[] {
  const issues: RosterIssue[] = [];
  /** participantKey -> where it was first entered, so a duplicate can say so. */
  const seen = new Map<string, { line: number; field: string }>();
  for (const participant of participants) {
    const line = participant.line ?? 0;
    // Which roster this row sits in. It has to travel with the issue: the panel
    // only ever shows one field's rows, and "line 4" with no field is the
    // difference between a fixable list and "5 Probleme" with nothing to click.
    const fieldId = participant.fieldId ?? null;
    const field = fieldId ? fieldLabel(fieldNames, fieldId) : tr('setup.unassignedField');
    if (participant.name.length > 60) issues.push({ line, fieldId, message: tr('setup.err.participantLong') });
    if (participant.team && participant.team.length > 60) {
      issues.push({ line, fieldId, message: tr('setup.err.participantTeamLong') });
    }
    const key = participantKey(participant);
    const first = seen.get(key);
    if (first) {
      issues.push({
        line,
        fieldId,
        message: tr('setup.err.duplicateParticipant', { line: first.line, field: first.field }),
      });
    } else seen.set(key, { line, field });
  }
  return issues;
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function radballGroupSizes(teamCount: number, groupCount: number): number[] {
  if (teamCount <= 0 || groupCount <= 0) return [];
  const size = Math.ceil(teamCount / groupCount);
  const groups: number[] = [];
  let left = teamCount;
  while (left > 0) {
    const current = Math.min(size, left);
    groups.push(current);
    left -= current;
  }
  return groups;
}

function effectiveRadball(draft: SetupDraft, teamCount: number, worldCupCounts: number[]) {
  if (draft.bdrPreset) {
    return {
      groupCount: 1,
      groupSizes: [teamCount],
      doubleLeg: false,
      finalMode: 'ranking-matches' as const,
      qualifies: teamCount === 5 ? 4 : 0,
      label: tr('setup.radballLabel.bdrPreset'),
    };
  }
  if (draft.radballSetupMode === 'ten-team') {
    // The group sizes are the field rosters, not half the roster: twelve teams
    // spread 7/5 are not two groups of six, and saying "2 × 6" here would promise
    // a shape the server would refuse. The shape itself scales -- N-2 placement
    // matches plus the four knockout matches, whatever N is.
    const groupSize = worldCupGroupSize(worldCupCounts);
    const finalPhase = groupSize ? groupSize + 2 : 0;
    const [first = 0, second = 0] = worldCupCounts;
    return {
      groupCount: 2,
      groupSizes: groupSize ? [groupSize, groupSize] : [],
      doubleLeg: false,
      finalMode: 'ten-team' as const,
      qualifies: 0,
      label: groupSize
        ? tr('setup.radballLabel.worldCupOk', { size: groupSize, phase: finalPhase, teams: teamCount })
        : tr('setup.radballLabel.worldCupBad', { first, second }),
    };
  }
  if (draft.radballSetupMode === 'standard') {
    return {
      groupCount: 1,
      groupSizes: [teamCount],
      doubleLeg: false,
      finalMode: 'none' as const,
      qualifies: 0,
      label: tr('setup.radballLabel.standard'),
    };
  }
  const groupSizes = radballGroupSizes(teamCount, draft.groupCount);
  const perGroup = draft.rbFinalMode === 'none' ? 0 : draft.rbFinalMode === 'ranking-matches' ? 4 : 2;
  return {
    groupCount: groupSizes.length,
    groupSizes,
    doubleLeg: draft.doubleLeg,
    finalMode: draft.rbFinalMode,
    qualifies: perGroup,
    label:
      draft.rbFinalMode === 'ranking-matches'
        ? tr('setup.radballLabel.ranking', { n: perGroup })
        : draft.rbFinalMode === 'round-robin'
          ? tr('setup.radballLabel.roundRobin', { n: perGroup })
          : tr('setup.radballLabel.tableDecides'),
  };
}

function fieldLabel(fieldNames: string[], fieldId: string): string {
  const index = Number(fieldId) - 1;
  return fieldNames[index]?.trim() || tr('field.label', { n: fieldId });
}

export function buildEffectiveSetup(draft: SetupDraft): EffectiveSetup | { error: string; step: number } {
  const name = draft.name.trim();
  if (!name) return { error: tr('setup.err.nameRequired'), step: 0 };
  const trimmedFields = draft.fieldNames.map((entry, index) => entry.trim() || tr('field.label', { n: index + 1 }));
  if (trimmedFields.some((entry) => entry.length > 24)) return { error: tr('setup.err.fieldNamesLong'), step: 2 };
  // Where the clock and the scoring buttons live. The manual schedule asks for the
  // fixtures on its own step first, so its match settings are the one after.
  const matchStep = lastStepOf(draft.format) - 1;
  const parsedDuration = parseDurationInput(draft.durationInput);
  const increments = parseScoringIncrements(draft.incrementsInput);
  if (!increments) return { error: tr('setup.err.increments'), step: matchStep };

  if (draft.format === 'radball') {
    const teams = mergeRoster(draft.radballBulk.slice(0, draft.fieldNames.length), parseRadballTeams);
    if (teams.length < 3) return { error: tr('setup.err.radballTeams'), step: 3 };
    const issues = rosterIssues(teams, draft.fieldNames);
    if (issues.length > 0) return { error: rosterIssueSummary(issues), step: 3 };
    const radball = effectiveRadball(draft, teams.length, worldCupFieldCounts(teams));
    if (radball.groupSizes.some((size) => size < 2)) {
      return { error: tr('setup.err.groupSize'), step: 4 };
    }
    if (draft.bdrPreset && teams.length !== 5) {
      return { error: tr('setup.err.bdrFive'), step: 4 };
    }
    if (draft.radballSetupMode === 'ten-team') {
      if (trimmedFields.length < 2) {
        return { error: tr('setup.err.worldCupFields'), step: 2 };
      }
      // The World Cup shape scales -- two equal groups of at least two, whatever
      // the size -- and the split is the rosters: Group A is what sits on field
      // 1, Group B what sits on field 2.
      const problem = worldCupRosterProblem(teams, draft.fieldNames);
      if (problem) return { error: problem, step: 3 };
    }
    if (draft.radballSetupMode === 'advanced') {
      const minRestMinutes = Number(draft.minRestInput);
      if (!Number.isInteger(minRestMinutes) || minRestMinutes < 0 || minRestMinutes > 240) {
        return { error: tr('setup.err.minRest'), step: 4 };
      }
    }
    if (draft.radballSetupMode === 'advanced' && draft.rbFinalMode === 'ranking-matches') {
      const groupWithFour = radball.groupSizes.filter((size) => size >= 4).length;
      if (groupWithFour < draft.groupCount) {
        return { error: tr('setup.err.rankingGroups'), step: 4 };
      }
    }
    const participants: ParticipantInput[] = teams.map((team) => ({
      name: team.name,
      team: team.club,
seed: null,
      checkedIn: true,
      players: team.players,
      logo: team.logo,
      fieldId: team.fieldId ?? null,
    }));
    const finalRound =
      draft.bdrPreset || draft.rbFinalMode === 'none'
        ? undefined
        : { mode: draft.rbFinalMode };
    return {
      payload: {
        name,
        format: 'radball',
        participants,
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracket: true,
        fieldNames: trimmedFields,
        radball: {
          ageCategory: draft.ageCategory,
          reducedTime: draft.reducedTime,
          ...(draft.bdrPreset
            ? { preset: 'bdr-elite-2025' as const }
            : draft.radballSetupMode === 'ten-team'
              ? {
                  preset: 'radball-10-team' as const,
                  minRestMinutes: Number(draft.minRestInput) || 0,
                  // No group split travels with it: the engine reads the groups
                  // off the participants' home fields, which are already in the
                  // roster above.
                }
              : draft.radballSetupMode === 'standard'
                ? { preset: 'radball-standard-2025' as const }
                : {
                    minRestMinutes: Number(draft.minRestInput),
                    groupCount: draft.groupCount,
                    doubleRoundRobin: draft.doubleLeg,
                    ...(finalRound
                      ? { qualifies: radball.qualifies, finalRound }
                      : {}),
                  }),
        },
      },
      settings: {
        tournamentName: name,
        fieldNames: trimmedFields,
        defaultMatchDurationSec: parsedDuration ?? 600,
        scoringIncrements: increments,
        autoLoadNext: draft.autoLoadNext,
        autoAssignNext: draft.autoAssignNext,
        allowDraws: true,
      },
      durationSec: parsedDuration ?? 600,
      increments,
      participants,
      trimmedFields,
    };
  }

  if (parsedDuration === null || parsedDuration < DURATION_MIN_SEC) {
    return { error: tr('setup.err.duration'), step: matchStep };
  }
  const durationSec = parsedDuration;
  const participants = mergeRoster(draft.fieldBulk.slice(0, draft.fieldNames.length), parseParticipants);
  if (participants.length < 2) return { error: tr('setup.err.needTwoParticipants'), step: 3 };
  const issues = participantIssues(participants, draft.fieldNames);
  if (issues.length > 0) {
    return {
      error: tr(issues.length === 1 ? 'setup.err.rosterBeforeOne' : 'setup.err.rosterBeforeMany', {
        count: issues.length,
      }),
      step: 3,
    };
  }

  /* ---------------- the manual schedule ---------------- */
  // The roster is entered exactly as it is for the knockout formats; what
  // differs is that nothing is drawn afterwards. Every fixture the host wrote
  // down becomes a match with those two teams in it, and nothing else does.
  if (draft.format === 'manual-schedule') {
    const fixtures = completeManualMatches(draft.manualMatches);
    if (fixtures.length === 0) {
      return { error: tr('setup.err.needOneMatch'), step: 4 };
    }
    if (draft.manualMatches.length > MAX_MANUAL_MATCHES) {
      return { error: tr('setup.err.tooManyMatches', { n: MAX_MANUAL_MATCHES }), step: 4 };
    }
    // A side that no longer names anybody in the roster would silently become a
    // bye, and a bye is not something this format hands out.
    const indexByKey = new Map(participants.map((participant, index) => [participantKey(participant), index]));
    for (const fixture of draft.manualMatches) {
      if (!fixture.a || !fixture.b) continue;
      const missing = [fixture.a, fixture.b].find((key) => !indexByKey.has(key));
      if (missing) {
        // The key is `name|team` lower-cased, so the name it was typed as comes
        // back out of it -- a key printed raw would read as a bug report.
        const name = missing.split('|')[0] || missing;
        return { error: tr('setup.err.unknownParticipant', { name }), step: 4 };
      }
    }
    const payloadParticipants: ParticipantInput[] = participants.map((participant) => ({
      name: participant.name,
      team: participant.team,
      seed: participant.seed,
      checkedIn: participant.checkedIn,
      logo: participant.logo,
      fieldId: participant.fieldId ?? null,
    }));
    return {
      payload: {
        name,
        format: 'manual-schedule',
        participants: payloadParticipants,
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: null,
        generateBracket: true,
        fieldNames: trimmedFields,
        manualMatches: fixtures.map((fixture) => ({
          a: indexByKey.get(fixture.a as string) ?? 0,
          b: indexByKey.get(fixture.b as string) ?? 0,
          ...(fixture.round.trim() ? { round: fixture.round.trim() } : {}),
          ...(fixture.fieldIndex !== null && fixture.fieldIndex < trimmedFields.length
            ? { fieldId: String(fixture.fieldIndex + 1) }
            : {}),
        })),
      },
      settings: {
        tournamentName: name,
        fieldNames: trimmedFields,
        defaultMatchDurationSec: durationSec,
        scoringIncrements: increments,
        autoLoadNext: draft.autoLoadNext,
        autoAssignNext: draft.autoAssignNext,
      },
      durationSec,
      increments,
      participants: payloadParticipants,
      trimmedFields,
    };
  }

  const bracketSize = nextPowerOfTwo(participants.length);
  const validKeys = new Set(participants.map(participantKey));
  const manualSlots = draft.manualSlots.length === bracketSize ? draft.manualSlots : reconcileSlots(draft.manualSlots, bracketSize, validKeys);
  let manualOrder: (number | null)[] | undefined;
  if (draft.drawMode === 'manual') {
    const placed = manualSlots.filter((slot): slot is string => slot !== null);
    if (placed.length !== participants.length) {
      return { error: tr('setup.err.placeAll', { count: participants.length }), step: 4 };
    }
    const indexByKey = new Map(participants.map((participant, index) => [participantKey(participant), index]));
    manualOrder = manualSlots.map((key) => (key === null ? null : (indexByKey.get(key) ?? null)));
  }
  const seedValue = draft.drawMode === 'manual' || !draft.seeded || !draft.seedValue.trim()
    ? null
    : Number(draft.seedValue.trim());
  if (seedValue !== null && (!Number.isInteger(seedValue) || seedValue < 0 || seedValue > 2 ** 31)) {
    return { error: tr('setup.err.seedRange'), step: 4 };
  }
  const payloadParticipants: ParticipantInput[] = participants.map((participant) => ({
    name: participant.name,
    team: participant.team,
    seed: participant.seed,
    checkedIn: participant.checkedIn,
    logo: participant.logo,
    fieldId: participant.fieldId ?? null,
  }));
  return {
    payload: {
      name,
      format: draft.format,
      participants: payloadParticipants,
      thirdPlaceMatch: draft.thirdPlace && draft.format === 'single-elimination',
      seeded: draft.drawMode === 'manual' ? true : draft.seeded,
      seedValue,
      settings: null,
      generateBracket: true,
      fieldNames: trimmedFields,
      ...(manualOrder ? { manualOrder } : {}),
    },
    settings: {
      tournamentName: name,
      fieldNames: trimmedFields,
      defaultMatchDurationSec: durationSec,
      scoringIncrements: increments,
      autoLoadNext: draft.autoLoadNext,
      autoAssignNext: draft.autoAssignNext,
    },
    durationSec,
    increments,
    participants: payloadParticipants,
    trimmedFields,
  };
}

function isEffectiveSetup(value: EffectiveSetup | { error: string; step: number }): value is EffectiveSetup {
  return 'payload' in value;
}

export function SetupPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const settings = snapshot.state?.settings;
  const isAdmin = snapshot.role === 'admin';
  const initial = useRef<{ draft: SetupDraft; recovered: boolean } | null>(null);
  if (!initial.current) initial.current = loadDraft(settings);
  const [draft, setDraft] = useState<SetupDraft>(initial.current.draft);
  const [draftRecovered, setDraftRecovered] = useState(initial.current.recovered);
  const [stepError, setStepError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  /** A prepared create waiting on the replace confirmation, when one is needed. */
  const [pendingSetup, setPendingSetup] = useState<EffectiveSetup | null>(null);
  const [mode, setMode] = useState<SetupMode>('create');
  const [saveOpen, setSaveOpen] = useState(false);
  const [savingBusy, setSavingBusy] = useState(false);
  const [loadedSetupId, setLoadedSetupId] = useState<string | null>(null);
  /**
   * The shelf entry currently open for editing, if any.
   *
   * Distinct from loading: Load creates the tournament, Edit opens the setup in
   * the wizard so it can be changed and written back to the same entry. Without
   * this there is no way back into a saved setup -- Load no longer stops at the
   * wizard -- so a setup could be created once and never corrected.
   */
const [editing, setEditing] = useState<SavedTournamentEntry | null>(null);
  /**
   * The shipped example, opened for changes. It is kept apart from `editing`
   * because there is no entry to write back to: the example is code, not host
   * data, so saving files a copy on the shelf and leaves the original alone.
   */
  const [editingExample, setEditingExample] = useState<ExampleSetup | null>(null);
  const [rosterField, setRosterField] = useState(0);
  const [drawField, setDrawField] = useState('1');
  const [libraryAge, setLibraryAge] = useState<RadballAgeCategory | null>(null);
  const [libraryPicked, setLibraryPicked] = useState<Set<string>>(() => new Set());
  const [libraryNote, setLibraryNote] = useState<string | null>(null);
  const [imported, setImported] = useState(0);
  const [hydratedSettings, setHydratedSettings] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepPanelRef = useRef<HTMLDivElement>(null);
  const editedRef = useRef(initial.current.draft.savedAt > 0);
  const rosterTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const drawTabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const update = useCallback((patch: Partial<SetupDraft>) => {
    editedRef.current = true;
    setDraft((current) => ({ ...current, ...patch, savedAt: Date.now() }));
    // Any edit retires the step's complaint: the host is acting on it, so
    // leaving it on screen would be nagging about something already fixed.
    setStepError(null);
  }, []);

  useEffect(() => {
    if (hydratedSettings || draftRecovered || editedRef.current || !settings) return;
    setDraft((current) => ({
      ...current,
      fieldNames: settings.fieldNames?.length ? [...settings.fieldNames] : current.fieldNames,
      durationInput: formatDurationInput(settings.defaultMatchDurationSec),
      incrementsInput: settings.scoringIncrements.join(','),
      autoLoadNext: settings.autoLoadNext,
      autoAssignNext: settings.autoAssignNext,
    }));
    setHydratedSettings(true);
  }, [draftRecovered, hydratedSettings, settings]);

  useEffect(() => {
    if (draft.savedAt === 0) return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        return;
      }
    }, 250);
    return () => window.clearTimeout(id);
  }, [draft]);

  const lastStep = lastStepOf(draft.format);
  const stepLabels = useMemo(() => {
    const labels = [
      t('setup.step.name'),
      t('setup.step.format'),
      t('setup.step.fields'),
      draft.format === 'radball' ? t('setup.step.radballTeams') : t('setup.step.participants'),
      draft.format === 'radball'
        ? t('setup.step.radballRules')
        : draft.format === 'manual-schedule'
          ? t('setup.step.schedule')
          : t('setup.step.bracket'),
    ];
    // The manual schedule's fixtures are their own step, and the clock and the
    // scoring buttons are the one after it.
    if (draft.format === 'manual-schedule') labels.push(t('setup.step.match'));
    labels.push(t('setup.step.review'));
    return labels;
  }, [draft.format, t]);

  const fieldCount = draft.fieldNames.length;
  const activeRosterField = Math.min(rosterField, fieldCount - 1);
  const effectiveDrawField = Number(drawField) <= fieldCount ? drawField : '1';
  const radballTeams = useMemo(
    () => mergeRoster(draft.radballBulk.slice(0, draft.fieldNames.length), parseRadballTeams),
    [draft.fieldNames.length, draft.radballBulk],
  );
  const participants = useMemo(
    () => mergeRoster(draft.fieldBulk.slice(0, draft.fieldNames.length), parseParticipants),
    [draft.fieldBulk, draft.fieldNames.length],
  );
  const bracketSize = nextPowerOfTwo(participants.length);
  /* What the manual schedule currently holds, in the wizard's own vocabulary.
     A fixture with a half-filled side is still on screen -- the host is mid-edit
     -- but it counts as nothing until both teams are picked, which is the same
     rule the engine applies. */
  const scheduleMatches = useMemo(
    () => completeManualMatches(draft.manualMatches),
    [draft.manualMatches],
  );
  const scheduleRoundNames = useMemo(() => {
    const names: string[] = [];
    scheduleMatches.forEach((match, index) => {
      const label = match.round.trim() || t('setup.scheduleRoundFallback', { n: index + 1 });
      if (!names.includes(label)) names.push(label);
    });
    return names;
  }, [scheduleMatches, t]);
  const completeManual = scheduleMatches.length;
  const manualRounds = scheduleRoundNames.length;
  const validParticipantKeys = useMemo(() => new Set(participants.map(participantKey)), [participants]);
  const manualSlots = useMemo(() => {
    if (draft.manualSlots.length === bracketSize && draft.manualSlots.every((slot) => slot === null || validParticipantKeys.has(slot))) {
      return draft.manualSlots;
    }
    return reconcileSlots(draft.manualSlots, bracketSize, validParticipantKeys);
  }, [bracketSize, draft.manualSlots, validParticipantKeys]);
  const manualAssigned = manualSlots.filter((slot): slot is string => slot !== null);
  const manualMissing = participants.filter((participant) => !manualAssigned.includes(participantKey(participant)));
  const drawVisible = participants.filter((participant) => participant.fieldId === effectiveDrawField);
  const effective = useMemo(
    () => buildEffectiveSetup(draft),
    [draft],
  );
  const worldCupCounts = worldCupFieldCounts(radballTeams);
  const radball = effectiveRadball(draft, radballTeams.length, worldCupCounts);
  const worldCupPerGroup = worldCupGroupSize(worldCupCounts);
  const radballIssues = useMemo(
    () => rosterIssues(radballTeams, draft.fieldNames),
    [draft.fieldNames, radballTeams],
  );
  const participantRosterIssues = useMemo(
    () => participantIssues(participants, draft.fieldNames),
    [participants, draft.fieldNames],
  );

  /* ---------------- team library picker ---------------- */
  // The picker's own age-group view. It never writes back to the tournament's
  // age category: the library filing and the competition rules stay separate.
  const libraryAgeGroup: RadballAgeCategory = libraryAge ?? draft.ageCategory;
  const libraryTeams = useMemo(
    () => teamsInAgeGroup(snapshot.state?.teamLibrary, libraryAgeGroup),
    [libraryAgeGroup, snapshot.state?.teamLibrary],
  );
  // "Already on this field" has to be answered from the roster the host is
  // looking at, which is the Radball one in Radball and the participant one
  // everywhere else.
  const activeRosterNames = useMemo(() => {
    const names = new Set(
      (draft.format === 'radball'
        ? parseRadballTeams(draft.radballBulk[activeRosterField] ?? '')
        : parseParticipants(draft.fieldBulk[activeRosterField] ?? '')
      ).map((entry) => entry.name.toLowerCase()),
    );
    return names;
  }, [activeRosterField, draft.fieldBulk, draft.format, draft.radballBulk]);
  const pickedEntries = libraryTeams.filter((entry) => libraryPicked.has(entry.id));
  const pickableEntries = pickedEntries.filter((entry) => !activeRosterNames.has(entry.name.toLowerCase()));

  const toggleLibraryPick = (id: string) => {
    setLibraryPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setLibraryPicks = (ids: string[]) => setLibraryPicked(new Set(ids));

  /** Copy the picked library squads onto the active field's roster. */
  const addLibraryTeamsToRoster = () => {
    if (pickableEntries.length === 0) return;
    // Which roster, and which line format: the Radball box reads
    // `team, player 1, player 2`, every other format reads `name, team`.
    const radball = draft.format === 'radball';
    const lines = radball
      ? libraryRosterLines(pickableEntries)
      : libraryParticipantLines(pickableEntries);
    const current = (radball ? draft.radballBulk : draft.fieldBulk)[activeRosterField] ?? '';
    const next = [...(radball ? draft.radballBulk : draft.fieldBulk)];
    next[activeRosterField] = current.trim() ? `${current.trim()}\n${lines.join('\n')}` : lines.join('\n');
    const skipped = pickedEntries.length - pickableEntries.length;
    update(radball ? { radballBulk: next } : { fieldBulk: next });
    setLibraryPicked(new Set());
    setImported(lines.length);
    setLibraryNote(
      tr(lines.length === 1 ? 'setup.libraryAddedOne' : 'setup.libraryAddedMany', {
        count: lines.length,
        field: activeRosterName,
      }) + (skipped > 0 ? ` ${tr('setup.librarySkipped', { count: skipped })}` : ''),
    );
  };

  const setFieldCount = (count: number) => {
    const clamped = Math.max(1, Math.min(MAX_FIELDS, Math.trunc(count) || 1));
    const next = draft.fieldNames.slice(0, clamped);
    for (let index = next.length; index < clamped; index += 1) {
      next.push(tr('field.label', { n: index + 1 }));
    }
    update({ fieldNames: next });
    setRosterField((current) => Math.min(current, clamped - 1));
  };

  const setRoster = (bulk: string[], index: number, value: string) => {
    const next = [...bulk];
    while (next.length <= index) next.push('');
    next[index] = value;
    update(bulk === draft.radballBulk ? { radballBulk: next } : { fieldBulk: next });
    setImported(0);
  };

  const onFile = async (file: File, target: number) => {
    const text = await file.text();
    const radball = draft.format === 'radball';
    const parsed = radball ? parseRadballTeams(text) : parseParticipants(text);
    const current = radball ? draft.radballBulk : draft.fieldBulk;
    const next = [...current];
    while (next.length <= target) next.push('');
    next[target] = next[target]?.trim() ? `${next[target].trim()}\n${text.trim()}` : text;
    update(radball ? { radballBulk: next } : { fieldBulk: next });
    setImported(parsed.length);
    setStepError(parsed.length === 0 ? tr('setup.err.noRows') : null);
  };

  const goToStep = (next: number, error?: string) => {
    editedRef.current = true;
    setDraft((current) => ({ ...current, step: next, savedAt: current.savedAt || Date.now() }));
    setStepError(error ?? null);
    window.requestAnimationFrame(() => {
      const focusId = error ? ({ 0: 'setup-name', 2: 'field-name-1', 3: 'roster-input' }[next] ?? null) : null;
      const target = focusId ? document.getElementById(focusId) : error ? stepPanelRef.current : headingRef.current;
      target?.focus();
    });
  };

  const next = () => {
    if (draft.step === 0 && !draft.name.trim()) return goToStep(0, tr('setup.err.nameToContinue'));
    if (draft.step === 1 && !draft.format) return goToStep(1, tr('setup.err.chooseType'));
    if (draft.step === 2 && draft.fieldNames.some((entry) => !entry.trim())) {
      return goToStep(2, tr('setup.err.nameFields'));
    }
    if (draft.step === 3) {
      if (draft.format === 'radball') {
        if (radballTeams.length < 3) return goToStep(3, tr('setup.err.addRadballTeams'));
        if (radballIssues.length > 0) return goToStep(3, rosterIssueSummary(radballIssues));
      } else {
        if (participants.length < 2) return goToStep(3, tr('setup.err.needTwoParticipants'));
        if (participantRosterIssues.length > 0) {
          return goToStep(
            3,
            tr(
              participantRosterIssues.length === 1
                ? 'setup.err.rosterToContinueOne'
                : 'setup.err.rosterToContinueMany',
              { count: participantRosterIssues.length },
            ),
          );
        }
      }
    }
    // Both rules steps (the fixtures and the clock) can refuse, and the manual
    // schedule has two of them. `effective.step` already says which, so the test
    // is just "is this a rules step before the review".
    if (draft.step >= 4 && draft.step < lastStep && !isEffectiveSetup(effective)) {
      return goToStep(effective.step, effective.error);
    }
    goToStep(Math.min(lastStep, draft.step + 1));
  };

  /**
   * The one place a tournament gets created, from the wizard or from the shelf.
   *
   * Both routes go through here so the replace confirmation, the command and the
   * success toast can only ever happen one way. `pending` is set when a tournament
   * is already loaded and the host has to agree to replacing it.
   */
  const createTournamentFrom = async (prepared: EffectiveSetup, pending: boolean) => {
    const current = snapshot.state?.tournament;
    setBusy(true);
    setStepError(null);
    const result = await live.command('tournament.create', {
      ...prepared.payload,
      settings: prepared.settings,
      confirmReplace: pending,
      expectedTournamentId: current?.id ?? null,
    });
    setBusy(false);
    if (!result.ok) {
      setReplaceOpen(false);
      setStepError(result.error ?? tr('setup.err.create'));
      window.requestAnimationFrame(() => stepPanelRef.current?.focus());
      return false;
    }
    clearSetupDraft();
    setReplaceOpen(false);
    live.pushToast(
      'success',
      tr(
        prepared.trimmedFields.length === 1 ? 'setup.toastReadyOne' : 'setup.toastReadyMany',
        { name: prepared.payload.name, count: prepared.trimmedFields.length },
      ),
    );
    navigate('/host');
    return true;
  };

  const submit = async (confirmReplace = false) => {
    if (!isEffectiveSetup(effective)) return goToStep(effective.step, effective.error);
    if (snapshot.state?.tournament && !confirmReplace) {
      setReplaceOpen(true);
      return;
    }
    await createTournamentFrom(effective, confirmReplace);
  };

  /* ---------------- the shelf ---------------- */
  // A saved setup is a head start, not a shortcut: loading one fills the wizard
  // at step 1, where the host renames the event for this year and walks the
  // same review as anything they typed themselves.

  const shelfEntries = useMemo(
    () => savedSetups(snapshot.state?.savedTournaments),
    [snapshot.state?.savedTournaments],
  );

  const chooseMode = (next: SetupMode) => {
    setMode(next);
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  /**
   * Start a tournament straight from a saved setup.
   *
   * One click, no wizard. The setup was validated when it was filed and the host
   * filed it deliberately, so walking them back through six steps to confirm what
   * they already chose was friction with no safety value -- the one thing that
   * *does* need asking about, replacing a tournament that is already loaded, keeps
   * its existing confirmation.
   *
   * The setup is still run through the wizard's own rules rather than trusted
   * blindly. If it can no longer create a tournament -- a hand-edited file, a
   * changed rule -- the host is dropped into the wizard at the offending step with
   * the reason, instead of getting a failed command and an empty page.
   */
  const startFromSetup = async (label: string, setup: SavedTournamentSetup, fromShelf: boolean) => {
    const loaded: SetupDraft = {
      version: 1,
      ...setupToDraft(setup, createDraft(settings)),
      step: 0,
      savedAt: Date.now(),
    };
    const prepared = buildEffectiveSetup(loaded);
    if (!isEffectiveSetup(prepared)) {
      // Fall back to the wizard rather than failing: the setup is one edit away
      // from being usable and the host is already looking at the right place.
      editedRef.current = true;
      setDraft(loaded);
      setDraftRecovered(false);
      setLoadedSetupId(fromShelf ? loadedSetupId : null);
      setMode('create');
      goToStep(prepared.step, prepared.error);
      live.pushToast('warn', tr('setup.err.cannotCreate', { label }));
      return;
    }
    // Replacing a loaded tournament is the one irreversible step, so it still asks.
    if (snapshot.state?.tournament) {
      editedRef.current = true;
      setDraft(loaded);
      setReplaceOpen(true);
      setPendingSetup(prepared);
      return;
    }
    await createTournamentFrom(prepared, false);
  };

  const loadSetup = (entry: SavedTournamentEntry) => {
    setEditing(null);
    setLoadedSetupId(entry.id);
    void startFromSetup(entry.name, entry.setup, true);
  };

  /**
   * Open a saved setup in the wizard to change it, creating nothing.
   *
   * The wizard is the editor: it already knows every format, the Radball rules,
   * CSV import and the team library, so a saved setup gets exactly the same
   * editing power as one being built from scratch. Saving writes back to the same
   * entry, which keeps its label and its place on the shelf.
   */
const beginEdit = (entry: SavedTournamentEntry) => {
    openInWizard(entry.setup);
    setEditing(entry);
    setLoadedSetupId(entry.id);
  };

  /**
   * Open the shipped example in the wizard to change it.
   *
   * Same editor as a shelf entry, but there is nothing to write back to: the
   * example is part of the app, so a save files the changed setup on the shelf
   * under a name of the host's choosing and the original stays as it ships.
   */
  const beginEditExample = (example: ExampleSetup) => {
    openInWizard(example.setup);
    setEditing(null);
    setEditingExample(example);
    setLoadedSetupId(null);
  };

  /** Common "open this setup in the wizard" reset, creating nothing. */
  const openInWizard = (setup: SavedTournamentSetup) => {
    editedRef.current = true;
    setDraft({
      version: 1,
      ...setupToDraft(setup, createDraft(settings)),
      step: 0,
      savedAt: Date.now(),
    });
    setDraftRecovered(false);
    setStepError(null);
    setReplaceOpen(false);
    setPendingSetup(null);
    setRosterField(0);
    setDrawField('1');
    setLibraryPicked(new Set());
    setLibraryNote(null);
    setImported(0);
    setMode('create');
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  /** Leave the editor without writing anything back. */
  const cancelEdit = () => {
    setEditing(null);
    setEditingExample(null);
    setDraft(createDraft(settings));
    setLoadedSetupId(null);
    setStepError(null);
    setMode('load');
  };

  /**
   * Write the wizard back over the entry being edited.
   *
   * No dialog and no label prompt: the entry keeps the name the host filed it
   * under, and only its contents change. The event name inside the setup is
   * edited on step 1, which is where the host can see which of the two they are
   * changing.
   */
const saveEditedSetup = async () => {
    // The example has no entry to update, so a save becomes a normal "save this
    // setup" and asks for the shelf label instead of writing over app code.
    if (editingExample) {
      if (!isEffectiveSetup(effective)) return goToStep(effective.step, effective.error);
      setSaveOpen(true);
      return;
    }
    if (!editing) return;
    if (!isEffectiveSetup(effective)) return goToStep(effective.step, effective.error);
    setSavingBusy(true);
    const result = await live.command('setup.save', {
      id: editing.id,
      name: editing.name,
      setup: draftToSetup(draft),
    });
    setSavingBusy(false);
    if (!result.ok) {
      live.pushToast('error', result.error ?? tr('setup.err.update'));
      return;
    }
live.pushToast('success', `Saved setup “${editing.name}” updated.`);
    setEditing(null);
    setEditingExample(null);
    setLoadedSetupId(null);
    setDraft(createDraft(settings));
    setMode('load');
  };

  const loadExample = (example: ExampleSetup) => {
    setEditing(null);
    setEditingExample(null);
    setLoadedSetupId(null);
    void startFromSetup(example.name, example.setup, false);
  };

const startFresh = () => {
    editedRef.current = false;
    setEditing(null);
    setEditingExample(null);
    setDraft(createDraft(settings));
    setLoadedSetupId(null);
    setStepError(null);
    setMode('create');
  };

  const labelClash = useMemo(() => {
    const label = draft.name.trim().toLowerCase();
    if (!label) return null;
    return shelfEntries.find((entry) => entry.name.toLowerCase() === label) ?? null;
  }, [draft.name, shelfEntries]);

  const saveSetup = async (name: string, overwriteId: string | null) => {
    // Only a setup the wizard itself would accept is worth filing: an entry that
    // could never create a tournament is noise the host would have to clean up.
    if (!isEffectiveSetup(effective)) return goToStep(effective.step, effective.error);
    const updating = overwriteId !== null;
    setSavingBusy(true);
    const result = await live.command('setup.save', {
      id: overwriteId,
      name,
      setup: draftToSetup(draft),
    });
    setSavingBusy(false);
    if (!result.ok) {
      live.pushToast('error', result.error ?? tr('setup.err.save'));
      return;
    }
setSaveOpen(false);
    // Filing the example's copy ends the edit: there is no longer an example
    // being changed, only a saved setup of the host's own.
    setEditingExample(null);
    if (updating) setLoadedSetupId(overwriteId);
    live.pushToast(
      'success',
      updating
        ? `Saved setup “${name}” updated. Load it any time to run this event again.`
        : `Saved setup “${name}”. Load it any time to run this event again.`,
    );
  };

  const chooseRosterTab = (index: number, focus = false) => {
    setRosterField(index);
    if (focus) window.requestAnimationFrame(() => rosterTabRefs.current[index]?.focus());
  };

  const moveRosterTab = (direction: 1 | -1) => {
    const nextIndex = (activeRosterField + direction + fieldCount) % fieldCount;
    chooseRosterTab(nextIndex, true);
  };

  const chooseDrawTab = (fieldId: string, focus = false) => {
    setDrawField(fieldId);
    if (focus) {
      const index = Number(fieldId) - 1;
      window.requestAnimationFrame(() => drawTabRefs.current[index]?.focus());
    }
  };

  const moveDrawTab = (direction: 1 | -1) => {
    const index = (Number(effectiveDrawField) - 1 + direction + fieldCount) % fieldCount;
    chooseDrawTab(String(index + 1), true);
  };

  const autoFillManual = () => {
    const next = [...manualSlots];
    const used = new Set(next.filter((key): key is string => key !== null));
    const unplaced = participants
      .filter((participant) => participant.fieldId === effectiveDrawField)
      .map(participantKey)
      .filter((key) => !used.has(key));
    if (unplaced.length === 0) return;
    const filled = dealKeysIntoPairs(next, unplaced);
    update({ manualSlots: filled });
  };

  const shuffleManual = () => {
    const rosterKeys = participants
      .filter((participant) => participant.fieldId === effectiveDrawField)
      .map(participantKey);
    update({ manualSlots: dealKeysIntoPairs(manualSlots, shuffleKeys(rosterKeys)) });
  };

  const clearManual = () => {
    const rosterKeys = new Set(
      participants.filter((participant) => participant.fieldId === effectiveDrawField).map(participantKey),
    );
    update({
      manualSlots: manualSlots.map((key) => (key !== null && rosterKeys.has(key) ? null : key)),
    });
  };

  if (!isAdmin) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('setup.hostOnlyLede')}</p>
        <Button size="lg" onClick={() => navigate('/')}>{t('setup.backToStart')}</Button>
      </div>
    );
  }

  const activeRosterRows = draft.format === 'radball'
    ? parseRadballTeams(draft.radballBulk[activeRosterField] ?? '')
    : parseParticipants(draft.fieldBulk[activeRosterField] ?? '');
  const activeRoster = activeRosterRows as ParsedRadballTeam[] | ParsedParticipant[];
  /* The panel lists every problem in the whole roster, not only the open tab:
     "Next" is refused for a bad row on Field 4 while the host is looking at
     Field 1, and a list that only covered the visible tab would then be empty --
     leaving a count with nothing under it to act on. */
  const visibleRosterIssues = draft.format === 'radball' ? radballIssues : participantRosterIssues;
  const activeRosterName = fieldLabel(draft.fieldNames, String(activeRosterField + 1));
  /* Which steps still put their complaint in a banner above the wizard.
     Steps 0-2 ask one short question and hold nothing else, so a banner
     displaces nothing. From the roster on, the step holds a list the host has to
     work through, and a banner above it both separates them from that list and
     pushes it off the top of the panel. */
  const stepKeepsBanner = draft.step <= 2;
  const standardDuration = radballHalfSec(draft.ageCategory, draft.reducedTime) * 2;
  const decisionDuration = radballHalfSec(draft.ageCategory, draft.reducedTime);
  const minRestValue = Number(draft.minRestInput);
  const minRestError = draft.minRestInput.trim() === '' || !Number.isInteger(minRestValue) || minRestValue < 0 || minRestValue > 240
    ? tr('setup.wholeNumber')
    : undefined;

  return (
    <form
      className="scroll setup-page"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.step < lastStep) next();
        else if (editing) void saveEditedSetup();
        else void submit(false);
      }}
    >
      <div className="setup-page__head">
        <div className="stack g2">
<h1 className="panel__title" ref={headingRef} tabIndex={-1}>
            {editing
              ? t('setup.editSaved')
              : editingExample
                ? t('setup.editExample')
                : mode === 'load'
                  ? t('setup.title')
                  : t('setup.createTitle')}
          </h1>
          <p className="hint">
            {editing
              ? t('setup.changingSaved', { name: editing.name })
              : editingExample
                ? t('setup.changingExample', { name: editingExample.name })
                : mode === 'load'
                  ? t('setup.loadHint')
                  : t('setup.createHint')}
          </p>
        </div>
        <div className="setup-page__status">
          <div className="setup-page__mode" role="group" aria-label={t('setup.createOrLoad')}>
            <button
              type="button"
              aria-pressed={mode === 'create'}
              className={cx('setup-page__mode-btn', mode === 'create' && 'setup-page__mode-btn--on')}
              onClick={() => chooseMode('create')}
            >
              {t('setup.createNew')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'load'}
              className={cx('setup-page__mode-btn', mode === 'load' && 'setup-page__mode-btn--on')}
              onClick={() => chooseMode('load')}
            >
              {t('setup.loadSaved')}
              {shelfEntries.length > 0 ? <span className="setup-page__mode-count tnum">{shelfEntries.length}</span> : null}
            </button>
          </div>
{mode === 'create' ? (
            <div className="setup-page__status-row small faint" aria-live="polite">
              <span>
                {draft.savedAt
                  ? t('setup.draftSaved', {
                      time: new Date(draft.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    })
                  : t('setup.newSetup')}
              </span>
              {editing || editingExample ? (
                <>
                  <Button size="sm" tone="ghost" onClick={cancelEdit}>{t('setup.discardChanges')}</Button>
                  <Button size="sm" tone="primary" busy={savingBusy} onClick={() => void saveEditedSetup()}>
                    <IconSave size={14} />
                    {editingExample ? t('setup.saveToShelf') : t('setup.saveChanges')}
                  </Button>
                </>
              ) : (
                <>
                  {/* "Create new" only navigates, so a host who saved a setup and
                      landed on Review had no way to clear the draft and begin
                      another event -- reloading brought the same draft back. */}
                  {draft.savedAt > 0 ? (
                    <Button size="sm" tone="ghost" onClick={startFresh} title={t('setup.clearDraftTitle')}>
                      {t('setup.startNew')}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => setSaveOpen(true)}>
                    <IconSave size={14} />
                    {t('setup.saveSetup')}
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

{editing || editingExample ? (
        <div className="banner banner--info setup-page__recovery">
          <div className="grow stack g1">
            <strong>
              {editingExample
                ? t('setup.editingCopy', { name: editingExample.name })
                : t('setup.editingSaved', { name: editing?.name ?? '' })}
            </strong>
            <span className="small">
              {editingExample ? (
                <>
                  {t('setup.eventNameLabel')} <strong>{draft.name.trim() || editingExample.setup.name}</strong>.{' '}
                  {t('setup.savingAsks')}
                </>
              ) : (
                <>
                  {t('setup.shelfNameLabel')} <strong>{editing?.name}</strong> · {t('setup.eventNameLabel')}{' '}
                  <strong>{draft.name.trim() || editing?.setup.name}</strong>. {t('setup.editingChanges')}
                </>
              )}
            </span>
          </div>
          <Button size="sm" onClick={() => setMode('load')}>{t('setup.backToSaved')}</Button>
          <Button size="sm" tone="ghost" onClick={cancelEdit}>{t('setup.discardChanges')}</Button>
        </div>
      ) : null}

      {draftRecovered ? (
        <div className="banner banner--info setup-page__recovery">
          <div className="grow stack g1">
            <strong>{t('setup.draftRecovered')}</strong>
            <span className="small">{t('setup.draftRecoveredHint')}</span>
          </div>
          <Button size="sm" onClick={() => setDraftRecovered(false)}>{t('action.continue')}</Button>
          <Button
            size="sm"
            tone="ghost"
            onClick={() => {
              clearSetupDraft();
              startFresh();
              setDraftRecovered(false);
            }}
          >
            {t('setup.discard')}
          </Button>
        </div>
      ) : null}

      {mode === 'load' ? (
        <SavedTournamentsPanel
          library={snapshot.state?.savedTournaments}
          activeId={loadedSetupId}
onLoad={loadSetup}
          onEdit={beginEdit}
          onLoadExample={loadExample}
          onEditExample={beginEditExample}
          onSave={() => chooseMode('create')}
        />
      ) : null}

      {mode === 'create' ? (
      <div
        className="panel setup-wizard"
        ref={stepPanelRef}
        role="region"
        aria-labelledby="setup-step-title"
        tabIndex={-1}
      >
        <Steps steps={stepLabels} active={draft.step} />
        <div className="setup-wizard__body">
          <div className="setup-wizard__intro">
            <span className="tiny dim">{t('setup.stepOf', { n: draft.step + 1 })}</span>
            <h2 id="setup-step-title">{stepLabels[draft.step]}</h2>
            <p className="hint">{stepDescription(draft.step, draft.format)}</p>
          </div>

          {/* A step's own complaint never goes above the wizard. Every one of
              them is a property of a control inside a panel -- a row, a field, a
              fixture -- so it belongs beside that control: a red block up here
              reads as the application failing, separates the host from the
              content they came for, and pushes the whole step down. */}
          {stepError && stepKeepsBanner ? (
            <div className="banner banner--error setup-page__error" role="alert" aria-live="assertive">
              {stepError}
            </div>
          ) : null}

          {draft.step === 0 ? (
            <Panel title={t('setup.name')}>
              <div className="setup-question">
                <TextField
                  id="setup-name"
                  label={t('setup.name')}
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  maxLength={80}
                  autoFocus
                  placeholder={t('ph.cityOpen')}
                  hint={t('setup.nameHint')}
                  error={stepError ?? undefined}
                />
              </div>
            </Panel>
          ) : null}

          {draft.step === 1 ? (
            <Panel title={t('setup.competitionType')}>
              <div className="setup-question stack g4">
                <Segmented
                  ariaLabel={t('setup.formatAria')}
                  value={draft.format}
                  onChange={(value) => update({ format: value })}
                  options={[
                    { value: 'single-elimination', label: t('format.single-elimination') },
                    { value: 'double-elimination', label: t('format.double-elimination') },
                    { value: 'manual-schedule', label: t('format.manual-schedule') },
                    { value: 'radball', label: t('format.radball') },
                  ]}
                />
                {draft.format === 'radball' ? (
                  <div className="setup-callout">
                    <strong>{t('setup.radballIntro')}</strong>
                    <span>
                      {t('setup.radballIntroBefore')} <strong>{t('setup.worldCup')}</strong>{' '}
                      {t('setup.radballIntroAfter')}
                    </span>
                  </div>
                ) : draft.format === 'single-elimination' ? (
                  <Switch
                    checked={draft.thirdPlace}
                    onChange={(value) => update({ thirdPlace: value })}
                    label={t('setup.thirdPlaceSwitch')}
                    hint={t('setup.thirdPlaceHint')}
                  />
                ) : draft.format === 'manual-schedule' ? (
                  <div className="setup-callout">
                    <strong>{t('format.manual-schedule')}</strong>
                    <span>{t('setup.scheduleIntro')}</span>
                  </div>
                ) : (
                  <p className="hint">{t('setup.doubleElimHint')}</p>
                )}
              </div>
            </Panel>
          ) : null}

          {draft.step === 2 ? (
            <Panel title={t('setup.fieldsPanel')}>
              <div className="setup-question stack g4">
                <Segmented
                  className="setup-segmented"
                  ariaLabel={t('setup.fieldCountAria')}
                  value={String(fieldCount)}
                  onChange={(value) => setFieldCount(Number(value))}
                  options={Array.from({ length: MAX_FIELDS }, (_, index) => ({
                    value: String(index + 1),
                    label: String(index + 1),
                  }))}
                />
                <div className="grid-2">
                  {draft.fieldNames.map((fieldName, index) => (
                    <TextField
                      key={index}
                      id={`field-name-${index + 1}`}
                      label={t('settings.fieldNameLabel', { n: index + 1 })}
                      value={fieldName}
                      onChange={(event) =>
                        update({ fieldNames: draft.fieldNames.map((entry, i) => (i === index ? event.target.value : entry)) })
                      }
                      maxLength={24}
                      placeholder={t('field.label', { n: index + 1 })}
                    />
                  ))}
                </div>
                <p className="hint">{t('setup.fieldsHint')}</p>
              </div>
            </Panel>
          ) : null}

          {draft.step === 3 ? (
            <Panel
              title={
                draft.format === 'radball'
                  ? t('setup.rostersTeams', { field: activeRosterName })
                  : t('setup.rostersParticipants', { field: activeRosterName })
              }
              actions={
                <Button
                  size="sm"
                  onClick={() => document.getElementById(`roster-file-${activeRosterField}`)?.click()}
                >
                  {t('setup.importCsv')}
                </Button>
              }
            >
              <input
                id={`roster-file-${activeRosterField}`}
                className="sr-only"
                type="file"
                accept=".csv,text/csv,text/plain"
                tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onFile(file, activeRosterField);
                  event.target.value = '';
                }}
              />
              <div className="setup-question stack g4">
                {/* The library is the host's own shelf of squads, and it is offered
                    wherever the roster is a list of participants -- a knockout or a
                    manual schedule reads the same lines a picked squad renders into.
                    Radball writes a different shape, so it has always had its own
                    branch and keeps it. */}
                {draft.format !== 'radball' ? (
                  <div className="library-picker">
                    <div className="between wrap g3">
                      <span className="label">{t('setup.startFromSaved')}</span>
                      <Link to="/teams" className="btn btn--ghost btn--small">
                        {t('setup.manageLibrary')}
                      </Link>
                    </div>
                    {libraryTeams.length === 0 ? (
                      <p className="hint">
                        {t('setup.noLibraryTeams', { age: ageGroupLabel(libraryAgeGroup) })}{' '}
                        <Link to="/teams">{t('setup.openLibrary')}</Link>{' '}
                        {t('setup.libraryStays')}
                      </p>
                    ) : (
                      <>
                        <Segmented
                          className="setup-segmented"
                          ariaLabel={t('setup.libraryAgeAria')}
                          value={libraryAgeGroup}
                          onChange={(value) => {
                            setLibraryAge(value);
                            setLibraryPicked(new Set());
                            setLibraryNote(null);
                          }}
                          options={RADBALL_AGE_CATEGORIES.map((age) => ({ value: age, label: age }))}
                        />
                        <div className="library-picker__scroll">
                          <div className="library-picker__list" role="group" aria-label={t('setup.libraryAgeTeams', { age: libraryAgeGroup })}>
                            {libraryTeams.map((entry) => {
                              const onField = activeRosterNames.has(entry.name.toLowerCase());
                              const checked = libraryPicked.has(entry.id);
                              return (
                                <label
                                  key={entry.id}
                                  className={cx('library-pick', checked && 'library-pick--on', onField && 'library-pick--dup')}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleLibraryPick(entry.id)}
                                  />
<span className="grow">
                                    {/* The crest is shown here as well as in the
                                        library so the host can see which squads
                                        will arrive with a mark before copying
                                        them onto a field. */}
                                    <CrestWithName logo={entry.logo} name={entry.name} size="sm" />
                                    <span className="library-pick__players">
                                      {entry.players[0]} &amp; {entry.players[1]}
                                      {entry.club ? <span className="faint"> · {entry.club}</span> : null}
                                    </span>
                                  </span>
                                  {onField ? (
                                    <span className="badge">
                                      {t('setup.onFieldBadge', { field: activeRosterName })}
                                    </span>
                                  ) : null}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                        <div className="between wrap g3">
                          <div className="row g2 wrap">
                            <Button
                              size="sm"
                              tone="ghost"
                              onClick={() => setLibraryPicks(libraryTeams.map((entry) => entry.id))}
                            >
                              {t('action.selectAll')}
                            </Button>
                            <Button size="sm" tone="ghost" onClick={() => setLibraryPicks([])}>
                              {t('action.clear')}
                            </Button>
                            {libraryNote ? <span className="hint">{libraryNote}</span> : null}
                          </div>
<Button
                            size="sm"
                            tone="primary"
                            disabled={pickableEntries.length === 0}
                            onClick={addLibraryTeamsToRoster}
                            aria-label={t(
                              pickableEntries.length === 1
                                ? 'setup.addTeamsOneAria'
                                : 'setup.addTeamsManyAria',
                              { count: pickableEntries.length, field: activeRosterName },
                            )}
                          >
                            {/* The field this button is aimed at has to be named
                                in the label itself: with up to eight fields, the
                                tab strip above is not enough to be sure which
                                roster the picked squads will land on. */}
                            {t('setup.addToField', { field: activeRosterName })}
                            <span className="btn__count" aria-hidden="true">
                              {pickableEntries.length}
                            </span>
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                <div
                  className="field-tabs"
                  role="tablist"
                  aria-label={t('setup.fieldRostersAria')}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') {
                      event.preventDefault();
                      moveRosterTab(1);
                    } else if (event.key === 'ArrowLeft') {
                      event.preventDefault();
                      moveRosterTab(-1);
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      chooseRosterTab(0, true);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      chooseRosterTab(fieldCount - 1, true);
                    }
                  }}
                >
                  {draft.fieldNames.map((_, index) => {
                    const count = draft.format === 'radball'
                      ? parseRadballTeams(draft.radballBulk[index] ?? '').length
                      : parseParticipants(draft.fieldBulk[index] ?? '').length;
                    const selected = index === activeRosterField;
                    return (
                      <button
                        key={index}
                        ref={(element) => { rosterTabRefs.current[index] = element; }}
                        id={`roster-tab-${index + 1}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls="roster-panel"
                        tabIndex={selected ? 0 : -1}
                        className={cx('field-tabs__tab', selected && 'field-tabs__tab--active')}
                        onClick={() => chooseRosterTab(index)}
                      >
                        <span className="field-tabs__name">{fieldLabel(draft.fieldNames, String(index + 1))}</span>
                        {/* In the World Cup format the field roster *is* the
                            group, so the tab says which one it is: the host
                            decides the split here, by typing teams, and nowhere
                            else. Only the first two fields can be a group. */}
                        {draft.format === 'radball' && draft.radballSetupMode === 'ten-team' && index < 2 ? (
                          <span className="badge">
                            {index === 0 ? t('radball.groupA') : t('radball.groupB')}
                          </span>
                        ) : null}
                        <span className="field-tabs__meta faint">{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div id="roster-panel" role="tabpanel" aria-labelledby={`roster-tab-${activeRosterField + 1}`} className="stack g2">
                  <label className="label" htmlFor="roster-input">
                    {draft.format === 'radball'
                      ? t('setup.rosterLabelRadball')
                      : t('setup.rosterLabelParticipants')}
                  </label>
                  <textarea
                    id="roster-input"
                    className="textarea setup-roster"
                    value={draft.format === 'radball'
                      ? (draft.radballBulk[activeRosterField] ?? '')
                      : (draft.fieldBulk[activeRosterField] ?? '')}
                    onChange={(event) => setRoster(
                      draft.format === 'radball' ? draft.radballBulk : draft.fieldBulk,
                      activeRosterField,
                      event.target.value,
                    )}
                    rows={12}
                    spellCheck={false}
                    aria-describedby="roster-format roster-summary"
                    placeholder={draft.format === 'radball'
                      ? 'RV Gärtringen I,Max Mustermann,Alexander Muster\nRV Süd I,Anna Weber,Lena Hoffmann'
                      : t('setup.rosterExample')}
                  />
                  <p className="hint" id="roster-format">
                    {draft.radballSetupMode === 'ten-team' && draft.format === 'radball'
                      ? `${t('setup.wcRosterHint', {
                          a: fieldLabel(draft.fieldNames, '1'),
                          b: fieldLabel(draft.fieldNames, '2'),
                        })} `
                      : ''}
                    {draft.format === 'radball'
                      ? t('setup.rosterHintRadball')
                      : t('setup.rosterHintParticipants')}
                  </p>
                </div>
                <div className="setup-roster-summary" id="roster-summary" aria-live="polite">
                  <strong>
                    {draft.format === 'radball'
                      ? t('setup.countTeams', { n: radballTeams.length })
                      : t('setup.countParticipants', { n: participants.length })}
                  </strong>
                  <span className="faint">
                    {imported > 0 ? `${t('setup.importedCount', { n: imported })} · ` : ''}
                    {t('setup.onFieldCount', { n: activeRoster.length, field: activeRosterName })}
                  </span>
                </div>
                {/* The roster's own refusal, one line above the concrete rows it is
                    about. Not a banner: the panel holds a list the host has to
                    work through, and a red block would push that list down. */}
                {stepError && draft.step === 3 ? (
                  <p className="setup-roster__error" role="alert" aria-live="assertive">
                    {stepError}
                  </p>
                ) : null}
                {visibleRosterIssues.length > 0 ? (
                  <div className="setup-issues" role="alert">
                    <strong>
                      {draft.format === 'radball' ? t('setup.fixTeamRows') : t('setup.fixRows')}
                    </strong>
                    {visibleRosterIssues.slice(0, 24).map((issue, index) => {
                      const field = issue.fieldId ? fieldLabel(draft.fieldNames, issue.fieldId) : null;
                      return (
                        <span key={`${issue.fieldId ?? 'all'}-${issue.line}-${index}`}>
                          {field ? `${field}: ` : ''}{t('setup.lineIssue', { line: issue.line, message: issue.message })}
                        </span>
                      );
                    })}
                    {visibleRosterIssues.length > 24 ? (
                      <span>{t('setup.moreIssues', { n: visibleRosterIssues.length - 24 })}</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="setup-page__examples">
                  <p className="hint">
                    {draft.format === 'radball'
                      ? t('setup.homeFieldHint')
                      : draft.format === 'manual-schedule'
                        ? t('setup.scheduleRosterHint')
                        : t('setup.drawHintParticipants')}
                  </p>
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={() => {
                      const next = exampleRosterFill(draft, fieldCount);
                      update(draft.format === 'radball' ? { radballBulk: next } : { fieldBulk: next });
                    }}
                  >
                    {t('setup.replaceExample')}
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}

          {draft.step === 4 && draft.format === 'radball' ? (
            <Panel title={t('setup.radballRulesTitle')}>
              <div className="setup-question stack g4">
                <Segmented
                  className="setup-segmented"
                  ariaLabel={t('setup.modeAria')}
                  value={draft.radballSetupMode}
                  onChange={(value) => update({ radballSetupMode: value, bdrPreset: false, rbFinalMode: 'none' })}
                  options={[
                    { value: 'standard', label: t('setup.modeStandard') },
                    { value: 'ten-team', label: t('setup.modeWorldCup') },
                    { value: 'advanced', label: t('setup.modeAdvanced') },
                  ]}
                />
                <div className="field-row">
                  <span className="label">{t('setup.ageCategory')}</span>
                  <Segmented
                    className="setup-segmented"
                    ariaLabel={t('setup.ageAria')}
                    value={draft.ageCategory}
                    onChange={(value) => update({ ageCategory: value })}
                    options={RADBALL_AGE_CATEGORIES.map((age) => ({ value: age, label: age }))}
                  />
                  <span className="hint">
                    {t('setup.ageHint', {
                      desc: ageDescription(draft.ageCategory),
                      group: standardDuration / 60,
                      decision: decisionDuration / 60,
                    })}
                  </span>
                </div>
                <Switch
                  checked={draft.reducedTime}
                  onChange={(value) => update({ reducedTime: value })}
                  label={t('setup.reducedTimeLabel')}
                  hint={t('setup.reducedTimeHint')}
                />
                {draft.radballSetupMode === 'standard' ? (
                  <div className="setup-callout">
                    <strong>{t('setup.safePreset')}</strong>
                    <span>{t('setup.safePresetHint')}</span>
                  </div>
                ) : draft.radballSetupMode === 'ten-team' ? (
                  /* -------------------------------------- the World Cup mode -- */
                  <div className="stack g4">
                    <div className="setup-callout">
                      <strong>
                        {worldCupPerGroup
                          ? t('setup.wcSummary', {
                              teams: radballTeams.length,
                              size: worldCupPerGroup,
                              a: fieldLabel(draft.fieldNames, '1'),
                              b: fieldLabel(draft.fieldNames, '2'),
                            })
                          : t('setup.wcSummaryNoSize', {
                              a: fieldLabel(draft.fieldNames, '1'),
                              b: fieldLabel(draft.fieldNames, '2'),
                            })}
                      </strong>
                      <span>
                        {t('setup.wcExplainer', {
                          a: fieldLabel(draft.fieldNames, '1'),
                          b: fieldLabel(draft.fieldNames, '2'),
                          n: worldCupPerGroup || 5,
                        })}
                      </span>
                    </div>

                    {worldCupPerGroup === 0 ? (
                      <div className="banner banner--error" role="alert">
                        {worldCupRosterProblem(radballTeams, draft.fieldNames) ??
                          t('setup.wcNeedsTwo')}
                      </div>
                    ) : (
                      <WorldCupGroups groups={worldCupGroups(radballTeams, draft.fieldNames)} />
                    )}

                    <TextField
                      label={t('setup.minRestLabel')}
                      value={draft.minRestInput}
                      onChange={(event) => update({ minRestInput: event.target.value })}
                      inputMode="numeric"
                      hint={t('setup.minRestHint')}
                      error={minRestError}
                    />
                  </div>
                ) : (
                  <div className="stack g4">
                    <div className="grid-2">
                      <TextField
                        label={t('setup.minRestLabel')}
                        value={draft.minRestInput}
                        onChange={(event) => update({ minRestInput: event.target.value })}
                        inputMode="numeric"
                        hint={t('setup.minRestHint')}
                        error={minRestError}
                      />
                      <div className="field-row">
                        <span className="label">{t('setup.groupsLabel')}</span>
                        <Segmented
                          className="setup-segmented"
                          ariaLabel={t('setup.groupsAria')}
                          value={String(draft.groupCount)}
                          onChange={(value) => update({ groupCount: Number(value) })}
                          options={[1, 2, 3, 4].map((count) => ({ value: String(count), label: String(count) }))}
                        />
                      </div>
                    </div>
                    <Switch
                      checked={draft.doubleLeg}
                      onChange={(value) => update({ doubleLeg: value })}
                      label={t('setup.doubleLegLabel')}
                      hint={t('setup.doubleLegHint')}
                    />
                    <div className="field-row">
                      <span className="label">{t('setup.afterGroups')}</span>
                      <Segmented
                        className="setup-segmented"
                        ariaLabel={t('setup.finalRoundAria')}
                        value={draft.rbFinalMode}
                        onChange={(value) => update({ rbFinalMode: value, bdrPreset: false })}
                        options={[
                          { value: 'none', label: t('setup.finalNone') },
                          { value: 'round-robin', label: t('setup.finalRoundRobin') },
                          { value: 'ranking-matches', label: t('setup.finalRanking') },
                        ]}
                      />
                    </div>
                    {draft.rbFinalMode === 'ranking-matches' ? (
                      <div className="banner banner--warn">{t('setup.rankingWarn')}</div>
                    ) : null}
                    <Switch
                      checked={draft.bdrPreset}
                      onChange={(value) => update({ bdrPreset: value, rbFinalMode: value ? 'ranking-matches' : 'none' })}
                      label={t('setup.bdrPresetLabel')}
                      hint={t('setup.bdrPresetHint')}
                    />
                    {draft.bdrPreset && radballTeams.length !== 5 ? (
                      <div className="banner banner--error" role="alert">
                        {t('setup.bdrNeedsFive', { n: radballTeams.length })}
                      </div>
                    ) : null}
                  </div>
                )}
                {radballTeams.length > 0 && radball.groupSizes.some((size) => size < 2) ? (
                  <div className="banner banner--error" role="alert">{t('setup.fewerGroups')}</div>
                ) : null}
                <TextField
                  label={t('setup.increments')}
                  value={draft.incrementsInput}
                  onChange={(event) => update({ incrementsInput: event.target.value })}
                  hint={t('setup.incrementsHint')}
                  error={parseScoringIncrements(draft.incrementsInput) ? undefined : t('setup.incrementsUse')}
                />
                <div className="grid-2">
                  <Switch
                    checked={draft.autoAssignNext}
                    onChange={(value) => update({ autoAssignNext: value })}
                    label={t('setup.autoAssignNext')}
                    hint={t('setup.autoAssignHint')}
                  />
                  <Switch
                    checked={draft.autoLoadNext}
                    onChange={(value) => update({ autoLoadNext: value })}
                    label={t('setup.autoLoadNext')}
                    hint={t('setup.autoLoadHint')}
                  />
                </div>
              </div>
            </Panel>
          ) : null}

          {draft.step === 4 && draft.format !== 'radball' && draft.format !== 'manual-schedule' ? (
            <Panel title={t('setup.step.bracket')}>
              <div className="setup-question stack g4">
                <Segmented
                  className="setup-segmented"
                  ariaLabel={t('setup.drawModeAria')}
                  value={draft.drawMode}
                  onChange={(value) => update({ drawMode: value })}
                  options={[
                    { value: 'auto', label: t('setup.drawAutomatic') },
                    { value: 'manual', label: t('setup.drawManualMode') },
                  ]}
                />
                {draft.drawMode === 'auto' ? (
                  <>
                    <Switch
                      checked={draft.seeded}
                      onChange={(value) => update({ seeded: value })}
                      label={t('setup.seededLabel')}
                      hint={t('setup.seededHint')}
                    />
                    {draft.seeded ? (
                      <TextField
                        label={t('setup.seed')}
                        value={draft.seedValue}
                        onChange={(event) => update({ seedValue: event.target.value })}
                        inputMode="numeric"
                        hint={t('setup.seedHint')}
                      />
                    ) : null}
                    <div className="setup-summary">
                      <strong>
                        {t('setup.bracketSlots', {
                          slots: bracketSize,
                          byes: bracketSize - participants.length,
                        })}
                      </strong>
                      <span className="small dim">{t('setup.homeBlocksHint')}</span>
                    </div>
                  </>
                ) : (
                  <div className="stack g3">
                    <div
                      className="field-tabs"
                      role="tablist"
                      aria-label={t('setup.drawFilterAria')}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') {
                          event.preventDefault();
                          moveDrawTab(1);
                        } else if (event.key === 'ArrowLeft') {
                          event.preventDefault();
                          moveDrawTab(-1);
                        } else if (event.key === 'Home') {
                          event.preventDefault();
                          chooseDrawTab('1', true);
                        } else if (event.key === 'End') {
                          event.preventDefault();
                          chooseDrawTab(String(fieldCount), true);
                        }
                      }}
                    >
                      {draft.fieldNames.map((_, index) => {
                        const fieldId = String(index + 1);
                        const roster = participants.filter((participant) => participant.fieldId === fieldId);
                        const placed = roster.filter((participant) => manualAssigned.includes(participantKey(participant))).length;
                        const selected = fieldId === effectiveDrawField;
                        return (
                          <button
                            key={fieldId}
                            ref={(element) => { drawTabRefs.current[index] = element; }}
                            id={`draw-tab-${index + 1}`}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls="draw-panel"
                            tabIndex={selected ? 0 : -1}
                            className={cx('field-tabs__tab', selected && 'field-tabs__tab--active')}
                            onClick={() => chooseDrawTab(fieldId)}
                          >
                            <span className="field-tabs__name">{fieldLabel(draft.fieldNames, fieldId)}</span>
                            <span className="field-tabs__meta faint">{placed}/{roster.length}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div id="draw-panel" role="tabpanel" aria-labelledby={`draw-tab-${Number(effectiveDrawField)}`} className="stack g3">
                      <div className="btn-row">
                        <Button onClick={autoFillManual}>
                          {t('setup.autoFill', { field: fieldLabel(draft.fieldNames, effectiveDrawField) })}
                        </Button>
                        <Button tone="ghost" onClick={shuffleManual}>{t('setup.shuffleField')}</Button>
                        <Button tone="ghost" onClick={clearManual}>{t('setup.clearField')}</Button>
                        <span className="small faint">
                          {t('setup.placedCount', {
                            placed: manualAssigned.length,
                            total: participants.length,
                          })}
                        </span>
                      </div>
                      {participants.length < 2 ? (
                        <p className="hint">{t('setup.addParticipantsFirst')}</p>
                      ) : (
                        <div className="setup-draw-grid">
                          {pairRows(bracketSize).map((pair) => (
                            <div key={pair.match} className="setup-draw-match">
                              <span className="tiny dim">
                                {t('setup.openingMatch', { n: pair.match })}
                              </span>
                              {pair.slots.map((slot) => {
                                const occupantKey = manualSlots[slot] ?? null;
                                const occupant = occupantKey ? participants.find((participant) => participantKey(participant) === occupantKey) ?? null : null;
                                if (occupant && occupant.fieldId !== effectiveDrawField) {
                                  return (
                                    <div key={slot} className="setup-draw-slot">
                                      <span className="label">{t('setup.slot', { n: slot + 1 })}</span>
                                      <span className="small">{occupant.name} · {fieldLabel(draft.fieldNames, occupant.fieldId ?? '1')}</span>
                                    </div>
                                  );
                                }
                                const options = drawVisible.filter((participant) => {
                                  const key = participantKey(participant);
                                  return key === occupantKey || !manualAssigned.includes(key);
                                });
                                return (
                                  <label key={slot} className="setup-draw-slot">
                                    <span className="label">{t('setup.slot', { n: slot + 1 })}</span>
                                    <select
                                      className="select"
                                      value={occupantKey ?? ''}
                                      onChange={(event) => {
                                        const value = event.target.value || null;
                                        update({ manualSlots: manualSlots.map((entry, index) => (index === slot ? value : entry)) });
                                      }}
                                    >
                                      <option value="">{t('setup.bye')}</option>
                                      {options.map((participant) => (
                                        <option key={participantKey(participant)} value={participantKey(participant)}>
                                          {participant.name}{participant.team ? ` · ${participant.team}` : ''}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                      {manualMissing.length > 0 ? (
                        <div className="banner banner--warn" role="status">
                          {t('setup.stillUnplaced', {
                            names: manualMissing.slice(0, 8).map((participant) => participant.name).join(', '),
                          })}
                          {manualMissing.length > 8
                            ? t('setup.moreNames', { n: manualMissing.length - 8 })
                            : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                <div className="grid-2">
                  <DurationField value={draft.durationInput} onChange={(value) => update({ durationInput: value })} />
                  <TextField
                    label={t('setup.increments')}
                    value={draft.incrementsInput}
                    onChange={(event) => update({ incrementsInput: event.target.value })}
                    hint={t('setup.incrementsHint')}
                    error={parseScoringIncrements(draft.incrementsInput) ? undefined : t('setup.incrementsUse')}
                  />
                </div>
                <div className="grid-2">
                  <Switch
                    checked={draft.autoAssignNext}
                    onChange={(value) => update({ autoAssignNext: value })}
                    label={t('setup.autoAssignNext')}
                    hint={t('setup.autoAssignHintShort')}
                  />
                  <Switch
                    checked={draft.autoLoadNext}
                    onChange={(value) => update({ autoLoadNext: value })}
                    label={t('setup.autoLoadNext')}
                    hint={t('setup.autoLoadHintShort')}
                  />
                </div>
              </div>
            </Panel>
          ) : null}

          {draft.step === 4 && draft.format === 'manual-schedule' ? (
            <Panel title={t('setup.step.schedule')}>
              <div className="setup-question stack g4">
                {/* The fixtures and nothing else. The clock and the scoring are the
                    next step, so this panel is one question with one answer:
                    which matches, in which order. */}
                <ScheduleBuilder
                  matches={draft.manualMatches}
                  participants={participants}
                  fieldCount={fieldCount}
                  fieldNames={draft.fieldNames}
                  error={stepError}
                  onChange={(manualMatches) => update({ manualMatches })}
                />
              </div>
            </Panel>
          ) : null}

          {draft.step === 5 && draft.format === 'manual-schedule' ? (
            <Panel title={t('setup.step.match')}>
              <div className="setup-question stack g4">
                <div className="grid-2">
                  <DurationField value={draft.durationInput} onChange={(value) => update({ durationInput: value })} />
                  <TextField
                    label={t('setup.increments')}
                    value={draft.incrementsInput}
                    onChange={(event) => update({ incrementsInput: event.target.value })}
                    hint={t('setup.incrementsHint')}
                    error={parseScoringIncrements(draft.incrementsInput) ? undefined : t('setup.incrementsUse')}
                  />
                </div>
                <div className="grid-2">
                  <Switch
                    checked={draft.autoAssignNext}
                    onChange={(value) => update({ autoAssignNext: value })}
                    label={t('setup.autoAssignNext')}
                    hint={t('setup.autoAssignHintShort')}
                  />
                  <Switch
                    checked={draft.autoLoadNext}
                    onChange={(value) => update({ autoLoadNext: value })}
                    label={t('setup.autoLoadNext')}
                    hint={t('setup.autoLoadHintShort')}
                  />
                </div>
              </div>
            </Panel>
          ) : null}

          {draft.step === lastStep ? (
            <Panel title={t('setup.reviewTitle')}>
              <div className="setup-question stack g4">
                {isEffectiveSetup(effective) ? (
                  <>
                    <dl className="kv setup-review">
                      <dt>{t('setup.step.name')}</dt><dd>{effective.payload.name}</dd>
                      <dt>{t('setup.step.format')}</dt><dd>{formatName(effective.payload.format)}</dd>
                      <dt>{t('setup.step.fields')}</dt><dd>{effective.trimmedFields.join(' · ')}</dd>
                      <dt>{t('setup.step.roster')}</dt>
                      <dd>
                        {draft.fieldNames.map((_, index) => {
                          const fieldId = String(index + 1);
                          const count = draft.format === 'radball'
                            ? parseRadballTeams(draft.radballBulk[index] ?? '').length
                            : parseParticipants(draft.fieldBulk[index] ?? '').length;
                          return (
                            <div key={fieldId}>
                              {fieldLabel(draft.fieldNames, fieldId)}:{' '}
                              {draft.format === 'radball'
                                ? t('setup.countTeams', { n: count })
                                : t('setup.countParticipants', { n: count })}
                            </div>
                          );
                        })}
                      </dd>
                      {draft.format === 'radball' ? (
                        <>
                          <dt>{t('setup.step.rules')}</dt>
                          <dd>
                            {RADBALL_RULESET_VERSION} · {draft.ageCategory} ·{' '}
                            {draft.reducedTime ? t('setup.reducedTimeShort') : t('setup.officialDuration')}
                          </dd>
                          <dt>{t('setup.groupsLabel')}</dt>
                          <dd>
                            {t('setup.countTeams', { n: radball.groupSizes.join(' + ') || '—' })} ·{' '}
                            {radball.doubleLeg ? t('setup.roundRobinDouble') : t('setup.roundRobinSingle')}{' '}
                            {t('setup.roundRobinSuffix')}
                          </dd>
                          <dt>{t('setup.reviewAfterGroups')}</dt><dd>{radball.label}</dd>
                          <dt>{t('setup.reviewMatchTime')}</dt>
                          <dd>
                            {t('setup.matchTimeValue', {
                              group: standardDuration / 60,
                              decision: decisionDuration / 60,
                            })}
                          </dd>
                          {draft.radballSetupMode === 'ten-team' && worldCupPerGroup > 0 ? (
                            <>
                              <dt>{t('setup.reviewFinalPhase')}</dt>
                              <dd>
                                {t('setup.finalPhaseValue', {
                                  n: worldCupPerGroup * (worldCupPerGroup - 1) + worldCupPerGroup + 2,
                                  places: radballTeams.length,
                                })}
                              </dd>
                              <dt>{t('setup.groupSplit')}</dt>
                              <dd>
                                {worldCupSlots(radballTeams).map((entry) => (
                                  <div key={entry.slot}>
                                    {entry.slot}: {entry.name}
                                  </div>
                                ))}
                              </dd>
                            </>
                          ) : null}
                        </>
                      ) : draft.format === 'manual-schedule' ? (
                        <>
                          <dt>{t('setup.scheduleReview')}</dt>
                          <dd>
                            {completeManual === 1
                              ? t('setup.scheduleReviewValueOne', { rounds: manualRounds })
                              : t('setup.scheduleReviewValue', { n: completeManual, rounds: manualRounds })}
                          </dd>
                          <dt>{t('setup.reviewRounds')}</dt>
                          <dd>{scheduleRoundNames.join(' · ') || '—'}</dd>
                        </>
                      ) : (
                        <>
                          <dt>{t('setup.reviewBracket')}</dt>
                          <dd>
                            {t('setup.bracketValue', {
                              slots: bracketSize,
                              byes: bracketSize - participants.length,
                              mode:
                                draft.drawMode === 'auto'
                                  ? draft.seeded
                                    ? t('setup.seededShort')
                                    : t('setup.randomShort')
                                  : t('setup.placedManually', {
                                      placed: manualAssigned.length,
                                      total: participants.length,
                                    }),
                            })}
                          </dd>
                          <dt>{t('round.thirdPlace')}</dt>
                          <dd>{effective.payload.thirdPlaceMatch ? t('common.yes') : t('common.no')}</dd>
                        </>
                      )}
                      {draft.format === 'radball' ? null : (
                        <>
                          <dt>{t('setup.reviewDuration')}</dt>
                          <dd>
                            {t('setup.perMatch', {
                              time: formatDurationInput(effective.durationSec),
                            })}
                          </dd>
                        </>
                      )}
                      <dt>{t('setup.reviewScoring')}</dt>
                      <dd>{effective.increments.map((value) => `${value > 0 ? '+' : ''}${value}`).join(', ')}</dd>
                      <dt>{t('setup.reviewNextMatch')}</dt>
                      <dd>
                        {t('setup.autoSummary', {
                          assign: draft.autoAssignNext ? t('setup.on') : t('setup.off'),
                          load: draft.autoLoadNext ? t('setup.on') : t('setup.off'),
                        })}
                      </dd>
                      <dt>{t('setup.reviewFirstStop')}</dt><dd>{t('setup.firstStopValue')}</dd>
                    </dl>
                    <div className="setup-roster-details">
                      <span className="tiny dim">{t('setup.rosterDetails')}</span>
                      {draft.fieldNames.map((_, index) => {
                        const fieldId = String(index + 1);
                        const rows = draft.format === 'radball'
                          ? parseRadballTeams(draft.radballBulk[index] ?? '')
                          : parseParticipants(draft.fieldBulk[index] ?? '');
                        return (
                          <details key={fieldId}>
                            <summary>{fieldLabel(draft.fieldNames, fieldId)} · {rows.length}</summary>
                            <ul>
                              {rows.map((row, rowIndex) => (
                                <li key={`${row.name}-${rowIndex}`}>
                                  <strong>{row.name}</strong>
                                  {draft.format === 'radball' && 'players' in row
                                    ? ` · ${row.players[0] || t('setup.missingRider')} + ${row.players[1] || t('setup.missingRider')}`
                                    : ` · ${'team' in row && row.team ? row.team : t('setup.noTeam')}`}
                                </li>
                              ))}
                              {rows.length === 0 ? (
                                <li className="faint">{t('setup.noHomeRoster')}</li>
                              ) : null}
                            </ul>
                          </details>
                        );
                      })}
                    </div>
                    {snapshot.state?.tournament ? (
                      <div className="banner banner--warn">
                        <strong>{t('setup.replaceWarn')}</strong>
                        <span>{t('setup.replaceWarnBody', { name: snapshot.state.tournament.name })}</span>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="banner banner--error" role="alert">{effective.error}</div>
                )}
              </div>
            </Panel>
          ) : null}
        </div>

        <div className="setup-wizard__nav">
          <Button size="lg" tone="ghost" onClick={() => goToStep(Math.max(0, draft.step - 1))} disabled={draft.step === 0 || busy}>
            {t('action.back')}
          </Button>
          <span className="small faint">{t('setup.stepOf', { n: draft.step + 1 })}</span>
          {draft.step < lastStep ? (
            <Button type="submit" size="lg" tone="primary" disabled={busy}>{t('action.next')}</Button>
          ) : editing ? (
            /* Editing an existing setup: the last step saves instead of creating,
               and the button says so. A host who pressed Edit must never be one
               stray click from replacing the tournament on the dashboard. */
            <Button
              size="lg"
              tone="primary"
              type="submit"
              busy={savingBusy}
              disabled={!isEffectiveSetup(effective)}
            >
              {t('setup.saveChanges')}
            </Button>
          ) : (
            <Button
              size="lg"
              tone="primary"
              type="submit"
              busy={busy}
              disabled={!isEffectiveSetup(effective)}
            >
              {draft.format === 'radball'
                ? t('setup.createDashboard')
                : draft.format === 'manual-schedule'
                  ? t('setup.createScheduleDashboard')
                  : t('setup.createBracketDashboard')}
            </Button>
          )}
        </div>
      </div>
      ) : null}

      {saveOpen ? (
        <SaveSetupDialog
          clash={labelClash}
          initialName={draft.name.trim()}
          busy={savingBusy}
          onClose={() => setSaveOpen(false)}
          onConfirm={(name, overwriteId) => void saveSetup(name, overwriteId)}
        />
      ) : null}

      {replaceOpen && snapshot.state?.tournament ? (
        <ConfirmDialog
          title={t('dialog.replaceTitle')}
          confirmLabel={t('dialog.replaceConfirm')}
          cancelLabel={t('dialog.keepEditing')}
          tone="danger"
          busy={busy}
          onCancel={() => {
            setReplaceOpen(false);
            setPendingSetup(null);
          }}
          onConfirm={() => {
            // A pending setup was prepared by Load and already carries its own
            // name; otherwise the wizard's own draft is what gets created.
            const prepared = pendingSetup ?? (isEffectiveSetup(effective) ? effective : null);
            if (prepared) void createTournamentFrom(prepared, true);
          }}
          body={
            <div className="stack g3">
              <p>{t('dialog.replaceBody', { name: snapshot.state.tournament.name })}</p>
              <p>{t('dialog.replaceQr')}</p>
              {pendingSetup ? (
                pendingSetup.payload.name === snapshot.state.tournament.name ? (
                  // Re-running the same event is the common case, and "X will be
                  // replaced by X" reads like a no-op. Say what is actually true.
                  <p className="hint">{t('dialog.replaceSame')}</p>
                ) : (
                  <p className="hint">{t('dialog.replaceWith', { name: pendingSetup.payload.name })}</p>
                )
              ) : null}
            </div>
          }
        />
      ) : null}
    </form>
  );
}

function stepDescription(step: number, format: TournamentFormat): string {
  if (step === 0) return tr('setup.desc.name');
  if (step === 1) return tr('setup.desc.format');
  if (step === 2) return tr('setup.desc.fields');
  if (step === 3) return format === 'radball' ? tr('setup.desc.rosterRadball') : tr('setup.desc.roster');
  if (step === 4) {
    if (format === 'radball') return tr('setup.desc.rulesRadball');
    if (format === 'manual-schedule') return tr('setup.desc.rulesSchedule');
    return tr('setup.desc.rules');
  }
  // The manual schedule's second rules step. Every other format's review is step
  // 5, so this has to be tested before the generic review fallback.
  if (step === 5 && format === 'manual-schedule') return tr('setup.desc.match');
  return tr('setup.desc.review');
}

function formatName(format: TournamentFormat): string {
  if (format === 'radball') return tr('setup.formatRadballName');
  if (format === 'double-elimination') return tr('format.double-elimination');
  if (format === 'manual-schedule') return tr('format.manual-schedule');
  return tr('format.single-elimination');
}

function ageDescription(age: RadballAgeCategory): string {
  const minutes = age === 'U11' || age === 'U13' || age === 'U15' || age === 'U17' ? 5 : age === 'U19' ? 6 : 7;
  return tr('radball.perAge', { age, minutes });
}

function pairRows(size: number): { match: number; slots: number[] }[] {
  const rows: { match: number; slots: number[] }[] = [];
  for (let match = 0; match < size / 2; match += 1) {
    rows.push({ match: match + 1, slots: [match * 2, match * 2 + 1] });
  }
  return rows;
}

function DurationField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const parsed = parseDurationInput(value);
  const total = parsed ?? 600;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const commit = (nextTotal: number) => {
    onChange(formatDurationInput(Math.min(DURATION_MAX_SEC, Math.max(DURATION_MIN_SEC, Math.round(nextTotal)))));
  };
  const typeMinutes = (text: string) => {
    if (!/^\d{0,3}$/.test(text)) return;
    onChange(formatDurationInput(text === '' ? seconds : Math.min(DURATION_MAX_SEC, Number(text) * 60 + seconds)));
  };
  const typeSeconds = (text: string) => {
    if (!/^\d{0,2}$/.test(text)) return;
    const next = text === '' ? 0 : Math.min(59, Number(text));
    onChange(formatDurationInput(Math.min(DURATION_MAX_SEC, minutes * 60 + next)));
  };
  return (
    <div className="field-row">
       <span className="label">{t('setup.totalDuration')}</span>
      <div className="duration-presets" role="group" aria-label={t('setup.durationPresets')}>
        {DURATION_PRESETS_MIN.map((preset) => (
          <Button key={preset} tone={total === preset * 60 ? 'primary' : 'ghost'} onClick={() => commit(preset * 60)} aria-pressed={total === preset * 60}>
            {t('setup.minutesShort', { n: preset })}
          </Button>
        ))}
      </div>
      <div className="row g3 wrap">
        <div className="duration-step">
          <Button tone="ghost" onClick={() => commit(total - 60)} aria-label={t('setup.minusMinute')}>−</Button>
          <input className="input duration-step__box" value={String(minutes)} inputMode="numeric" autoComplete="off" aria-label={t('setup.minutesAria')} onChange={(event) => typeMinutes(event.target.value)} />
          <span className="small dim">min</span>
          <Button tone="ghost" onClick={() => commit(total + 60)} aria-label={t('setup.plusMinute')}>+</Button>
        </div>
        <div className="duration-step">
          <Button tone="ghost" onClick={() => commit(total - 5)} aria-label={t('setup.minusFiveSeconds')}>−</Button>
          <input className="input duration-step__box" value={String(seconds).padStart(2, '0')} inputMode="numeric" autoComplete="off" aria-label={t('setup.secondsAria')} onChange={(event) => typeSeconds(event.target.value.replace(/^0+(?=\d)/, ''))} />
          <span className="small dim">sec</span>
          <Button tone="ghost" onClick={() => commit(total + 5)} aria-label={t('setup.plusFiveSeconds')}>+</Button>
        </div>
      </div>
       <span className="hint">
        {t('setup.durationHint', { time: `${minutes}:${String(seconds).padStart(2, '0')}` })}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The manual schedule                                                 */
/* ------------------------------------------------------------------ */

/**
 * Two team pickers, side by side. This is the whole of creating a match.
 *
 * The format's promise is that a fixture is "these two teams", so the pickers are
 * the first and the largest thing on the card -- everything else a match can
 * carry (its round, its field) has a working default and lives behind Details on
 * the same card. Both usages, the quick-add strip at the top and the card itself,
 * render through here so they can never drift apart.
 */
function TeamPairSelects({
  a,
  b,
  participants,
  selectRef,
  onA,
  onB,
}: {
  a: string | null;
  b: string | null;
  participants: ParsedParticipant[];
  /** Focus target for the quick-add strip, so adding is repeatable by keyboard. */
  selectRef?: Ref<HTMLSelectElement>;
  onA: (key: string | null) => void;
  onB: (key: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="setup-schedule__pair">
      <label className="setup-draw-slot">
        <span className="label">{t('score.side', { side: 'A' })}</span>
        <select
          ref={selectRef}
          className="select"
          value={a ?? ''}
          onChange={(event) => onA(event.target.value || null)}
        >
          <option value="">{t('setup.schedulePickTeam')}</option>
          {participants
            .filter((participant) => participantKey(participant) !== b)
            .map((participant) => (
              <option key={participantKey(participant)} value={participantKey(participant)}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
              </option>
            ))}
        </select>
      </label>
      <span className="setup-schedule__vs" aria-hidden="true">
        vs
      </span>
      <label className="setup-draw-slot">
        <span className="label">{t('score.side', { side: 'B' })}</span>
        <select
          className="select"
          value={b ?? ''}
          onChange={(event) => onB(event.target.value || null)}
        >
          <option value="">{t('setup.schedulePickTeam')}</option>
          {participants
            .filter((participant) => participantKey(participant) !== a)
            .map((participant) => (
              <option key={participantKey(participant)} value={participantKey(participant)}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The schedule builder of the manual format: one card per fixture the host
 * wants, in the order they want it.
 *
 * The roster is already entered by the time this step opens, so both sides of
 * every card are a pick from a known list -- which is the whole promise of the
 * format. There is no draw to review, no byes to distribute and no power of two
 * to hit; the only rule is that the two teams differ, and that one is enforced
 * here as well as server side because a card reading "A vs A" is a confusing
 * thing to leave on screen.
 */
function ScheduleBuilder({
  matches,
  participants,
  fieldCount,
  fieldNames,
  error,
  onChange,
}: {
  matches: DraftManualMatch[];
  participants: ParsedParticipant[];
  fieldCount: number;
  fieldNames: string[];
  /** The step's refusal, rendered beside the button that lifts it. */
  error?: string | null;
  onChange: (matches: DraftManualMatch[]) => void;
}) {
  const { t } = useI18n();
  /** The pair currently being composed. Picking two teams is all it takes. */
  const [pairA, setPairA] = useState<string>('');
  const [pairB, setPairB] = useState<string>('');
  const firstSelect = useRef<HTMLSelectElement>(null);
  const complete = completeManualMatches(matches);
  const played = new Set<string>();
  for (const match of complete) {
    if (match.a) played.add(match.a);
    if (match.b) played.add(match.b);
  }
  // A roster entry nobody plays yet is only worth mentioning while there are
  // still fixtures to add: it is the quickest way to notice a team was missed.
  const unplayed = participants
    .filter((participant) => !played.has(participantKey(participant)))
    .map((participant) => participant.name);

  const patch = (index: number, next: Partial<DraftManualMatch>) => {
    onChange(matches.map((match, position) => (position === index ? { ...match, ...next } : match)));
  };
  const drop = (index: number) => onChange(matches.filter((_, position) => position !== index));
  const move = (index: number, by: 1 | -1) => {
    const target = index + by;
    if (target < 0 || target >= matches.length) return;
    const next = [...matches];
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    onChange(next);
  };

  /** Commit the pair being composed and clear it for the next one. */
  const addPair = () => {
    if (!pairA || !pairB || pairA === pairB) return;
    onChange([...matches, { a: pairA, b: pairB, round: '', fieldIndex: null }]);
    setPairA('');
    setPairB('');
    // Straight back to the first dropdown, so a whole fixture list can be typed
    // without ever reaching for the mouse again.
    firstSelect.current?.focus();
  };

  const fieldOptions = fieldNames.slice(0, fieldCount);
  const pairReady = Boolean(pairA && pairB && pairA !== pairB);

  return (
    <div className="stack g3 setup-schedule">
      {participants.length < 2 ? <p className="hint">{t('setup.addParticipantsFirst')}</p> : null}
      {/* The one thing this step asks: pick two teams. Everything else about a
          match has a default and is on the card it belongs to. */}
      <div className="setup-schedule__add">
        <TeamPairSelects
          a={pairA || null}
          b={pairB || null}
          participants={participants}
          selectRef={firstSelect}
          onA={(a) => setPairA(a ?? '')}
          onB={(b) => setPairB(b ?? '')}
        />
        <Button tone="primary" disabled={!pairReady} onClick={addPair}>
          {t('setup.scheduleAdd')}
        </Button>
      </div>
      {pairA && pairB && pairA === pairB ? (
        <p className="setup-schedule__error">{t('setup.scheduleSameTeam')}</p>
      ) : null}
      {/* The step's own refusal, said once, directly under the control that lifts
          it. A banner above the panel would separate the host from the very
          control that fixes it. */}
      {error ? (
        <p className="setup-schedule__error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {matches.length === 0 ? (
        <p className="setup-schedule__empty">{t('setup.scheduleEmpty')}</p>
      ) : null}
      <div className="setup-draw-grid">
        {matches.map((match, index) => {
          const sameSide = Boolean(match.a && match.a === match.b);
          return (
            <div key={`match-${index}`} className="setup-draw-match setup-schedule__row">
              <span className="tiny dim setup-schedule__num">
                {t('setup.matchNumber', { n: index + 1 })}
              </span>
              <TeamPairSelects
                a={match.a}
                b={match.b}
                participants={participants}
                onA={(a) => patch(index, { a })}
                onB={(b) => patch(index, { b })}
              />
              <div className="row g1">
                <Button
                  size="sm"
                  tone="ghost"
                  disabled={index === 0}
                  aria-label={t('setup.scheduleMoveUp')}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  tone="ghost"
                  disabled={index === matches.length - 1}
                  aria-label={t('setup.scheduleMoveDown')}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  tone="ghost"
                  aria-label={t('setup.scheduleRemove')}
                  onClick={() => drop(index)}
                >
                  ✕
                </Button>
              </div>
              {sameSide ? <p className="setup-schedule__error">{t('setup.scheduleSameTeam')}</p> : null}
              {/* Round and field are the two things a match *may* carry, and both
                  have a working default, so they are one disclosure away rather
                  than four controls standing between the host and the pickers. */}
              <details className="setup-schedule__details" open={Boolean(match.round || match.fieldIndex !== null)}>
                <summary>{t('setup.scheduleDetails')}</summary>
                <label className="setup-draw-slot">
                  <span className="label">{t('setup.scheduleRound')}</span>
                  <input
                    className="input"
                    value={match.round}
                    maxLength={24}
                    autoComplete="off"
                    placeholder={t('setup.scheduleRoundPlaceholder')}
                    onChange={(event) => patch(index, { round: event.target.value.slice(0, 24) })}
                  />
                  <span className="hint">{t('setup.scheduleRoundHint')}</span>
                </label>
                <label className="setup-draw-slot">
                  <span className="label">{t('setup.scheduleField')}</span>
                  <select
                    className="select"
                    value={match.fieldIndex === null ? '' : String(match.fieldIndex)}
                    onChange={(event) =>
                      patch(index, { fieldIndex: event.target.value === '' ? null : Number(event.target.value) })
                    }
                  >
                    <option value="">{t('setup.scheduleFieldAny')}</option>
                    {fieldOptions.map((name, position) => (
                      <option key={position} value={position}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </details>
            </div>
          );
        })}
      </div>
      {unplayed.length > 0 ? (
        <p className="hint">
          {t('setup.scheduleUnplayed', {
            names: unplayed.slice(0, 12).join(', '),
            more: unplayed.length > 12 ? ` +${unplayed.length - 12}` : '',
          })}
        </p>
      ) : null}
    </div>
  );
}
