/**
 * Shared domain model. Used by the backend engine, the HTTP layer, the
 * WebSocket protocol and the React client. Keep this file free of any
 * runtime dependency so it can be imported from every environment.
 */
import type { EventText } from './eventMessages';

/* ------------------------------------------------------------------ */
/* Participants & tournament                                          */
/* ------------------------------------------------------------------ */

export interface Participant {
  id: string;
  name: string;
  team: string | null;
  /**
   * File name of this team's logo inside the host's logos folder, or null to
   * fall back to the folder's default. Copied off the library squad the roster
   * was built from, so a logo follows the team onto the boards.
   */
  logo: string | null;
  seed: number | null;
  checkedIn: boolean;
  createdAt: number;
  /**
   * Home field this participant was registered for ('1', '2', ...), or null
   * when unassigned. Informational: matches still flow across all fields
   * dynamically — but the draw and the board can show where everyone started.
   */
  fieldId: FieldId | null;
  /**
   * The two players of a 2er-Radball team, in seating order. Null in generic
   * tournament mode. The participant (team) stays the competitive unit:
   * points, ranking and progression always belong to it, never to a player.
   */
  players: [string, string] | null;
}

/**
 * The competition structures the engine can run.
 *
 * `manual-schedule` is the odd one out and deliberately so: it has no structure
 * of its own. The host picks the teams, then writes down the fixtures they want
 * -- any pairing, any number of times, named whatever they like. Everything else
 * in this union derives its matches from the roster; this one stores them.
 */
export type TournamentFormat =
  | 'single-elimination'
  | 'double-elimination'
  | 'radball'
  | 'manual-schedule';

export type TournamentStatus = 'DRAFT' | 'RUNNING' | 'COMPLETED' | 'ARCHIVED';

export interface Tournament {
  id: string;
  name: string;
  format: TournamentFormat;
  status: TournamentStatus;
  bracketSize: number;
  rounds: number;
  thirdPlaceMatch: boolean;
  seeded: boolean;
  seedValue: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  championId: string | null;
}

/* ------------------------------------------------------------------ */
/* Matches                                                            */
/* ------------------------------------------------------------------ */

export type MatchState =
  | 'WAITING'
  | 'READY'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'PAUSED'
  | 'HALFTIME'
  | 'FINISHED'
  | 'CANCELLED';

export const MATCH_STATES: MatchState[] = [
  'WAITING',
  'READY',
  'ASSIGNED',
  'RUNNING',
  'PAUSED',
  'HALFTIME',
  'FINISHED',
  'CANCELLED',
];

/**
 * Where a bracket slot gets its occupant from. `bye` means the slot is
 * permanently empty (participant count is not a power of two) which lets the
 * engine auto-advance the other side without waiting for a real match.
 *
 * `group-rank` is the dependency reference the 10-team Radball format needs: the
 * slot names a *group position* ("Group A, 1st place") instead of a team, so the
 * occupant is re-derived from the group table every time a result changes. Copying
 * a team name into the slot would freeze yesterday's answer; this cannot.
 */
export type SlotSource =
  | { kind: 'bye' }
  | { kind: 'participant'; participantId: string }
  | { kind: 'winner-of'; matchId: string }
  | { kind: 'loser-of'; matchId: string }
  | { kind: 'group-rank'; groupId: string; rank: number };

export interface TimerState {
  mode: 'down' | 'up';
  durationSec: number;
  periodCount: 1 | 2;
  period: 1 | 2;
  periodDurationSec: number;
  periodStartElapsedMs: number;
  /** Accumulated milliseconds while not running. */
  elapsedMs: number;
  running: boolean;
  /** Epoch ms at which the running segment started (null when paused). */
  anchorAt: number | null;
  expired: boolean;
}

export type ScoreActionKind =
  | 'score'
  | 'undo'
  | 'redo'
  | 'correct'
  | 'reset'
  | 'auto';

export interface ScoreAction {
  id: string;
  ts: number;
  /** null when the action affects both sides (reset / correct). */
  participantId: string | null;
  delta: number;
  kind: ScoreActionKind;
  actor: string;
  fieldId: FieldId | null;
  /** Scores before the action -- undo restores these. */
  prevA: number;
  prevB: number;
  /** Scores after the action -- redo restores these. */
  nextA: number;
  nextB: number;
  note: string | null;
}

export type BracketSide = 'winners' | 'losers' | 'final' | 'third-place' | 'reset';

export interface Match {
  id: string;
  tournamentId: string;
  round: number;
  roundName: string;
  position: number;
  bracketSlot: number;
  bracket: BracketSide;
  isThirdPlace: boolean;
  isGrandFinal: boolean;
  slotA: SlotSource;
  slotB: SlotSource;
  /** Resolved occupants (null while still waiting for a feeder match). */
  participantAId: string | null;
  participantBId: string | null;
  scoreA: number;
  scoreB: number;
  state: MatchState;
  fieldId: FieldId | null;
  winnerId: string | null;
  loserId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  timer: TimerState;
  nextWinMatchId: string | null;
  nextWinSlot: 'A' | 'B' | null;
  nextLoseMatchId: string | null;
  nextLoseSlot: 'A' | 'B' | null;
  history: ScoreAction[];
  redoStack: ScoreAction[];
  /** Manual override: engine will not re-derive the participants. */
  locked: boolean;
  note: string | null;
  /**
   * Radball competition metadata. Null for generic knockout matches. A set
   * value marks the match as part of the Radball phase model (group fixture,
   * placement, final or decision match) instead of an elimination bracket.
   */
  radball: RadballMatchMeta | null;
}

/* ------------------------------------------------------------------ */
/* Radball 2er competition model (UCI ruleset)                        */
/* ------------------------------------------------------------------ */

/** Age categories with official half durations (seconds per half). */
export type RadballAgeCategory = 'U11' | 'U13' | 'U15' | 'U17' | 'U19' | 'U23' | 'ELITE';

export const RADBALL_HALF_SEC: Record<RadballAgeCategory, number> = {
  U11: 300,
  U13: 300,
  U15: 300,
  U17: 300,
  U19: 360,
  U23: 420,
  ELITE: 420,
};

export const RADBALL_AGE_CATEGORIES: RadballAgeCategory[] = ['U11', 'U13', 'U15', 'U17', 'U19', 'U23', 'ELITE'];

/** One half in seconds for the category (tournament reduced time forces 300). */
export function radballHalfSec(age: RadballAgeCategory, reducedTime: boolean): number {
  if (reducedTime) return 300;
  return RADBALL_HALF_SEC[age] ?? 420;
}

export type RadballPhaseKind =
  | 'round-robin'
  | 'group-stage'
  | 'final-round'
  | 'placement-round'
  | 'knockout'
  | 'decision'
  | 'shootout';

/** Which engine branch a match belongs to. Drives the whole lifecycle. */
export type RadballMatchKind = 'group' | 'knockout' | 'placement' | 'final' | 'decision';

/**
 * The explicit role a match plays in the competition, independent of which
 * engine branch runs it.
 *
 * `RadballMatchKind` answers "how is this match processed"; this answers "what is
 * this match *for*". A 10-team placement match is processed as a placement match
 * but exists to hand out 5th and 6th place, and the UI, the audit log and the
 * final ranking all need the second answer. Group fixtures carry
 * `GROUP_MATCH`; the generic formats leave this null.
 */
export type RadballMatchType =
  | 'GROUP_MATCH'
  | 'SEMIFINAL'
  | `PLACEMENT_${number}_${number}`
  | 'THIRD_PLACE'
  | 'FINAL';

/**
 * A unique key per final-phase match.
 *
 * `RadballMatchType` cannot be it: there are two semifinals and both are
 * `SEMIFINAL`, so anything keyed on the type alone would give them one id and
 * one queue slot. The key is what identifies a final-phase match in ids, in the
 * host's schedule order and on the wire; the type is the label the human reads.
 */
export type RadballFinalKey =
  | `PLACEMENT_${number}_${number}`
  | 'SEMIFINAL_1'
  | 'SEMIFINAL_2'
  | 'THIRD_PLACE'
  | 'FINAL';

/**
 * Every final-phase key for the ten-team World Cup, in the recommended order.
 *
 * The placement keys are a function of the group size -- two groups of N have
 * N-2 placement matches -- so this array is the documented ten-team case rather
 * than the general rule. `radballFinalKeys(groupSize)` in
 * `shared/radball10Structure` is the general one, and the engine uses that
 * against the competition's own group count rather than this list.
 */
export const RADBALL_FINAL_KEYS: RadballFinalKey[] = [
  'PLACEMENT_9_10',
  'PLACEMENT_7_8',
  'PLACEMENT_5_6',
  'SEMIFINAL_1',
  'SEMIFINAL_2',
  'THIRD_PLACE',
  'FINAL',
];

/** Which dependency edges of a match must be settled before it may be played. */
export type RadballDependency =
  /** Nothing: the teams are known from the start (group fixtures). */
  | 'none'
  /** Both sides come from final group positions. */
  | 'group-complete'
  /** Feeds on one semifinal's winner. */
  | 'semifinal-winner'
  /** Feeds on one semifinal's loser. */
  | 'semifinal-loser'
  /** Feeds on both semifinals. */
  | 'semifinals-complete';

export type RadballPhaseStatus = 'PENDING' | 'RUNNING' | 'COMPLETED';

export interface RadballPhase {
  id: string;
  kind: RadballPhaseKind;
  name: string;
  order: number;
  groupIds: string[];
  /** How teams reach this phase (final rounds). Null for entry phases. */
  qualification: { fromPhaseId: string | null; places: number } | null;
  status: RadballPhaseStatus;
}

export interface RadballGroup {
  id: string;
  phaseId: string;
  name: string;
  teamIds: string[];
  doubleRoundRobin: boolean;
  /** Top-N advance (0 = nobody advances from here). */
  qualifies: number;
  /**
   * Playing field this group belongs to. The 10-team format pins Group A to
   * Field 1 and Group B to Field 2 so both groups run in parallel; other formats
   * leave it null and fall back to the participants' home field.
   */
  fieldId: FieldId | null;
}

export type StandingStatus = 'qualified' | 'playoff' | 'tied' | 'open' | 'eliminated';

export interface StandingRow {
  teamId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  rank: number;
  status: StandingStatus;
  note: string | null;
}

export interface ShootoutAttempt {
  /** Alternating throwing order, team A always throws first. */
  side: 'A' | 'B';
  /** Index of the throwing player within the team (0 or 1). */
  shooter: number;
  hit: boolean;
  suddenDeath: boolean;
}

export interface ShootoutState {
  attemptsPerTeam: number;
  attempts: ShootoutAttempt[];
  decided: boolean;
  winnerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RadballMatchMeta {
  phaseId: string;
  groupId: string | null;
  kind: RadballMatchKind;
  /** Explicit competition role. Null for the generic Radball formats. */
  matchType: RadballMatchType | null;
  /** Unique key of a final-phase match. Null outside the ten-team format. */
  finalKey: RadballFinalKey | null;
  /** Semifinal number 1 or 2, for the matches that depend on one. */
  semiNumber: number | null;
  /** Which edges of the dependency chain must be settled first. */
  dependsOn: RadballDependency;
  /** Decision matches must produce a winner (shootout when level). */
  requiresWinner: boolean;
  /** Machine-readable reason, e.g. CHAMPIONSHIP_TIE. */
  decisionReason: string | null;
  sideChange: boolean;
  neutralBall: boolean;
  shootout: ShootoutState | null;
}

export interface RadballConfig {
  rulesetVersion: string;
  ageCategory: RadballAgeCategory;
  /** Tournament reduced time: every match 2x5 regardless of category. */
  reducedTime: boolean;
  /** Minimum rest between two matches of one team, minutes (0 = off). */
  minRestMinutes: number;
  winPoints: number;
  drawPoints: number;
  shootoutAttempts: number;
  /**
   * How a level final-phase match is decided.
   *
   * `shootout` is the Radball 4-meter shootout. `draw` records the level score
   * as a draw and lets the standings engine resolve it -- only ever used by the
   * 10-team format, whose placement matches are configured separately below.
   */
  tieResolution: 'shootout' | 'draw';
  /**
   * Tie rule for the 5/6, 7/8 and 9/10 placement matches in the 10-team format.
   * A level score here must still produce a defined place, so the default is a
   * shootout rather than a draw.
   */
  placementTieResolution: 'shootout' | 'draw';
}

export const RADBALL_RULESET_VERSION = 'uci_radball_2025';
export const RADBALL_10TEAM_RULESET_VERSION = 'uci_radball_2025_wc10';

export function defaultRadballConfig(age: RadballAgeCategory = 'ELITE'): RadballConfig {
  return {
    rulesetVersion: RADBALL_RULESET_VERSION,
    ageCategory: age,
    reducedTime: false,
    minRestMinutes: 0,
    winPoints: 3,
    drawPoints: 1,
    shootoutAttempts: 4,
    tieResolution: 'shootout',
    placementTieResolution: 'shootout',
  };
}

/** Group match duration: two halves of the category. */
export function radballMatchSec(config: RadballConfig): number {
  return radballHalfSec(config.ageCategory, config.reducedTime) * 2;
}

/** Decision match duration: a single half, never with side change. */
export function radballDecisionSec(config: RadballConfig): number {
  return radballHalfSec(config.ageCategory, config.reducedTime);
}

/**
 * The competition structures the Radball engine knows.
 *
 * `standard` is the free-form format: any number of groups, any number of teams,
 * an optional final round. `radball-10-team` is the documented UCI World Cup
 * shape -- exactly ten teams, two groups of five, and a fixed cross-group final
 * phase. They are different data, not different wording: the ten-team format
 * pins groups to fields, publishes A1-A5 / B1-B5 as derived references and
 * assigns places 1-10 from results, none of which make sense for a free-form
 * league. Both share the Radball match lifecycle, the standings maths and the
 * 4-meter shootout.
 */
export type RadballSystem = 'standard' | 'radball-10-team';

export interface RadballFinalPlacement {
  /** 1..10. */
  place: number;
  teamId: string | null;
  /** Where this place comes from, e.g. `FINAL`, `SEMIFINAL_1`, `GROUP_A_RANK_1`. */
  source: string;
  matchId: string | null;
}

export interface RadballFinalPhase {
  id: string;
  status: 'PENDING' | 'GENERATED';
  /** The six final-phase match ids, in creation order. */
  matchIds: string[];
  /** Host-configurable order. Never changes the dependencies. */
  order: RadballFinalKey[];
  /** True once the host confirmed "Generate final phase?". */
  confirmed: boolean;
}

export interface TournamentState10 {
  /** The explicit state machine the 10-team format runs on. */
  stage: Radball10Stage;
  /** groupId -> ordered team ids. The published A1-A5 / B1-B5 answers. */
  rankings: Record<string, string[]>;
  /** groupId -> true once every one of its ten fixtures is decided. */
  groupFrozen: Record<string, boolean>;
  /**
   * The final-phase descriptor. Always present, but `PENDING` until the host
   * confirms generation -- so the UI can offer it before it exists and refuse
   * afterwards, without a second null case to reason about.
   */
  final: RadballFinalPhase;
  ranking: RadballFinalPlacement[];
  /** Places still without an occupant, with the reason. Empty when valid. */
  issues: string[];
}

export type Radball10Stage =
  | 'SETUP'
  | 'GROUP_PHASE'
  | 'GROUP_PHASE_COMPLETE'
  | 'FINAL_PHASE_READY'
  | 'PLACEMENT_MATCHES'
  | 'SEMIFINALS'
  | 'THIRD_PLACE'
  | 'FINAL'
  | 'COMPLETED';

export interface RadballCompetition {
  config: RadballConfig;
  system: RadballSystem;
  phases: Record<string, RadballPhase>;
  phaseOrder: string[];
  groups: Record<string, RadballGroup>;
  groupOrder: string[];
  /** groupId -> ranked table rows. Recomputed server-side after every result. */
  tables: Record<string, StandingRow[]>;
  championId: string | null;
  /** Final-round template waiting for qualification. Null when none planned. */
  pendingFinal: { mode: 'round-robin' | 'ranking-matches' } | null;
  /** Monotonic counter for decision-match ids (persisted, reload-safe). */
  decisionSeq: number;
  /** The 10-team structure. Null for every other Radball format. */
  ten: TournamentState10 | null;
}

/* ------------------------------------------------------------------ */
/* Team library                                                       */
/* ------------------------------------------------------------------ */

/**
 * A reusable 2er Radball team, stored independently of any tournament.
 *
 * The library is the host's own address book of clubs and players: it survives
 * creating, resetting and replacing a tournament, so the same squads can be
 * entered again next season without retyping them. The age group is a filing
 * label only -- the playing rules of a competition are set by
 * `RadballConfig.ageCategory` on the tournament itself.
 */
export interface TeamLibraryEntry {
  id: string;
  /** Squad name, unique across the whole library (case-insensitive). */
  name: string;
  /** Club or affiliation. Optional. */
  club: string | null;
  /** The two players, in seating order. */
  players: [string, string];
  ageCategory: RadballAgeCategory;
  /**
   * File name of this squad's logo in the host's logos folder, or null for the
   * folder's default. A plain file name and nothing else: the folder is the
   * host's own, and the server only ever serves names it has listed itself.
   */
  logo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TeamLibrary {
  teams: Record<string, TeamLibraryEntry>;
  /** Display order, the host's own sequence. Unknown ids are appended. */
  order: string[];
}

export function emptyTeamLibrary(): TeamLibrary {
  return { teams: {}, order: [] };
}

export function isRadballAgeCategory(value: unknown): value is RadballAgeCategory {
  return typeof value === 'string' && RADBALL_AGE_CATEGORIES.includes(value as RadballAgeCategory);
}

/** Library teams in the host's order, dropping ids with no stored entry. */
export function orderedLibraryTeams(library: TeamLibrary | null | undefined): TeamLibraryEntry[] {
  if (!library) return [];
  const out: TeamLibraryEntry[] = [];
  const seen = new Set<string>();
  for (const id of library.order) {
    const entry = library.teams[id];
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  for (const entry of Object.values(library.teams)) {
    if (!seen.has(entry.id)) out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Saved tournaments                                                   */
/* ------------------------------------------------------------------ */

/** How the opening round of a knockout bracket is decided. */
export type DrawMode = 'auto' | 'manual';

/**
 * One fixture of a manual schedule, as the wizard holds it.
 *
 * The two sides are participant *keys* (`name|team`, lower-cased) rather than
 * ids, which is the vocabulary the wizard's own slot editor already speaks: a
 * saved setup is loaded back into a wizard where no participants exist yet, so
 * there is no id to reference. `fieldIndex` is 0-based rather than a field id so
 * renaming a playing field cannot orphan a fixture.
 */
export interface SavedManualMatch {
  a: string | null;
  b: string | null;
  /** The round or stage label the host typed, e.g. "Group stage", "Final". */
  round: string;
  /** Index into `fieldNames`, or null to leave the match unassigned. */
  fieldIndex: number | null;
}

/**
 * A manual schedule holds at most this many fixtures.
 *
 * The cap is not a gameplay limit -- a fortnight of round-robin fixtures would
 * fit -- it is the snapshot-size guard the roster already has, applied to the
 * one list that grows with the host's own typing rather than with the roster.
 */
export const MAX_MANUAL_MATCHES = 512;

/** Which Radball structure the setup describes. */
export type RadballSetupMode = 'standard' | 'advanced' | 'ten-team';

/** What happens once the Radball group stage is finished. */
export type RadballFinalMode = 'none' | 'round-robin' | 'ranking-matches';

/**
 * A whole tournament setup, kept so the host can run the same event again
 * without retyping it.
 *
 * This is deliberately the *wizard's* vocabulary rather than a create-command
 * payload: a saved setup is loaded straight back into the wizard, where the
 * host reviews it and can change anything before the bracket is generated.
 * Roster text is stored per playing field exactly as it was typed, so a load
 * hands back something the host can still read and edit.
 *
 * Like the team library it survives creating, replacing and resetting a
 * tournament -- a sports day is a recurring event, and next year's entries are
 * the same entries.
 */
export interface SavedTournamentSetup {
  version: 1;
  /** The name the setup was saved with, pre-filled into step 1 on load. */
  name: string;
  format: TournamentFormat;
  /** Playing-field display names, 1..MAX_FIELDS entries. */
  fieldNames: string[];
  /** Roster text per field: `name, team, seed` for the knockout formats. */
  fieldBulk: string[];
  /** 2er roster text per field: `team, player 1, player 2` for Radball. */
  radballBulk: string[];
  thirdPlace: boolean;
  seeded: boolean;
  seedValue: string;
  drawMode: DrawMode;
  /** One entry per bracket slot: a participant key, or null for a bye. */
  manualSlots: (string | null)[];
  /**
   * The fixtures of a manual schedule, in the order the host listed them. Empty
   * for every other format, which has no fixtures until the engine draws them.
   */
  manualMatches: SavedManualMatch[];
  durationSec: number;
  scoringIncrements: number[];
  autoLoadNext: boolean;
  autoAssignNext: boolean;
  ageCategory: RadballAgeCategory;
  reducedTime: boolean;
  minRestMinutes: number;
  setupMode: RadballSetupMode;
  groupCount: number;
  doubleLeg: boolean;
  finalMode: RadballFinalMode;
  bdrPreset: boolean;
}

export interface SavedTournamentEntry {
  id: string;
  /**
   * The label the host filed it under. The setup carries its own `name` too;
   * this one is the shelf label and is what the load list shows.
   */
  name: string;
  setup: SavedTournamentSetup;
  createdAt: number;
  updatedAt: number;
}

export interface SavedTournamentLibrary {
  entries: Record<string, SavedTournamentEntry>;
  /** Filing order. Unknown ids are appended; listing sorts by `updatedAt`. */
  order: string[];
}

/**
 * Match length a saved setup falls back to when it carries none.
 *
 * Ten minutes: the same value the setup wizard itself falls back to when its
 * duration box is empty or unreadable, so a hand-edited saved file and a blank
 * wizard agree on what "unset" means.
 */
export const SAVED_SETUP_DEFAULT_DURATION_SEC = 600;

/** The canonical shape every saved setup falls back to, field by field. */
export function emptySavedTournamentSetup(): SavedTournamentSetup {
  return {
    version: 1,
    name: '',
    format: 'single-elimination',
    fieldNames: defaultFieldNames(DEFAULT_FIELD_COUNT),
    fieldBulk: [],
    radballBulk: [],
    thirdPlace: true,
    seeded: true,
    seedValue: '',
    drawMode: 'auto',
    manualSlots: [],
    manualMatches: [],
    durationSec: SAVED_SETUP_DEFAULT_DURATION_SEC,
    scoringIncrements: [1, 2, 3],
    autoLoadNext: true,
    autoAssignNext: true,
    ageCategory: 'ELITE',
    reducedTime: false,
    minRestMinutes: 0,
    setupMode: 'standard',
    groupCount: 1,
    doubleLeg: false,
    finalMode: 'none',
    bdrPreset: false,
  };
}

export function emptySavedTournamentLibrary(): SavedTournamentLibrary {
  return { entries: {}, order: [] };
}

/**
 * Saved setups, most recently updated first.
 *
 * Unlike the team library there is no host-authored order to keep: what the
 * list needs to answer is "which one do I run next?", and the setup saved or
 * renamed last is that one. Ties fall back to newest-created first, then id,
 * so the order is stable across reloads.
 */
export function orderedSavedTournaments(
  library: SavedTournamentLibrary | null | undefined,
): SavedTournamentEntry[] {
  if (!library) return [];
  const out: SavedTournamentEntry[] = [];
  const seen = new Set<string>();
  for (const id of library.order) {
    const entry = library.entries[id];
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  for (const entry of Object.values(library.entries)) {
    if (!seen.has(entry.id)) out.push(entry);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function isTournamentFormat(value: unknown): value is TournamentFormat {
  return (
    value === 'single-elimination' ||
    value === 'double-elimination' ||
    value === 'radball' ||
    value === 'manual-schedule'
  );
}

export function isDrawMode(value: unknown): value is DrawMode {
  return value === 'auto' || value === 'manual';
}

export function isRadballSetupMode(value: unknown): value is RadballSetupMode {
  return value === 'standard' || value === 'advanced' || value === 'ten-team';
}

export function isRadballFinalMode(value: unknown): value is RadballFinalMode {
  return value === 'none' || value === 'round-robin' || value === 'ranking-matches';
}

/* ------------------------------------------------------------------ */
/* Fields                                                             */
/* ------------------------------------------------------------------ */

/**
 * Playing-field identifier. Numeric strings starting at '1'. The tournament
 * can be configured with 1..MAX_FIELDS playing fields; the default is two.
 */
export type FieldId = string;

export const MIN_FIELDS = 1;
export const MAX_FIELDS = 8;
export const DEFAULT_FIELD_COUNT = 2;

/** True for a well-formed field id ('1'..MAX_FIELDS). */
export function isFieldId(value: unknown): value is FieldId {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2) return false;
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  const num = Number(value);
  return num >= MIN_FIELDS && num <= MAX_FIELDS;
}

/** Canonical numeric ordering for field ids ('10' sorts after '9'). */
export function compareFieldIds(a: string, b: string): number {
  return Number(a) - Number(b);
}

/** Default display names for `count` playing fields. */
export function defaultFieldNames(count: number): string[] {
  const names: string[] = [];
  for (let i = 1; i <= count; i += 1) names.push(`Field ${i}`);
  return names;
}

export interface FieldState {
  id: FieldId;
  name: string;
  matchId: string | null;
  /** Operator session currently holding the field lock (never a secret). */
  controlledBy: string | null;
  controlledSince: number | null;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export type Theme = 'dark' | 'light';
export type WinCondition = 'manual' | 'points' | 'timer' | 'either';

/**
 * What the hall's display screens are showing.
 *
 * `scores` is the board the display has always drawn -- one flip-score sheet
 * per field. The rest replace it with a single hall-wide screen, and they exist
 * because the projector is already on the wall: between games it should be able
 * to say "Pause", carry the club's crest, show the wall clock, publish the
 * tables, or list the running order -- without anybody tabbing to another app.
 *
 * The switch is one value for the whole hall rather than one per field, because
 * the projector that shows the tables is the same projector that shows the
 * scores, and two operators flipping it to different things would be a fight
 * the display cannot win.
 */
export type DisplayScreen = 'scores' | 'pause' | 'logo' | 'clock' | 'standings' | 'results';

/** Every display screen, in the order a switcher lists them. */
export const DISPLAY_SCREENS: DisplayScreen[] = ['scores', 'pause', 'logo', 'clock', 'standings', 'results'];

/** True for a well-formed display screen. */
export function isDisplayScreen(value: unknown): value is DisplayScreen {
  return typeof value === 'string' && (DISPLAY_SCREENS as string[]).includes(value);
}

export interface Settings {
  /* General */
  tournamentName: string;
  /* Language: `en` or `de`. Absent in backups written before the setting existed. */
  language?: 'en' | 'de';
  /* Appearance */
  theme: Theme;
  primaryColor: string;
  accentColor: string;
  logoDataUrl: string | null;
  showSponsorBar: boolean;
  invertDisplayColors: boolean;
  /**
   * What every projector and TV is showing right now. Defaults to the score
   * board, so a hall that never touches it sees exactly what it always saw.
   */
  displayScreen: DisplayScreen;
  /**
   * The line under the “Pause” heading, and the caption on the logo screen.
   * Null (or empty) leaves the headline to speak for itself.
   */
  displayMessage: string | null;
  /* Scoring */
  defaultMatchDurationSec: number;
  scoringIncrements: number[];
  winCondition: WinCondition;
  maxScore: number | null;
  allowDraws: boolean;
  timerMode: 'down' | 'up';
  /* Fields: one display name per playing field (1..MAX_FIELDS entries). */
  fieldNames: string[];
  autoLoadNext: boolean;
  autoAssignNext: boolean;
  /* Security */
  requireOperatorPin: boolean;
  operatorPinSet: boolean;
  /* Network */
  port: number;
  advertisedHost: string | null;
  /* Backup */
  autoBackupEnabled: boolean;
  autoBackupIntervalMin: number;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */

export type AppEventType =
  | 'SCORE_UPDATED'
  | 'SCORE_UNDONE'
  | 'SCORE_REDONE'
  | 'SCORE_CORRECTED'
  | 'MATCH_RESET'
  | 'MATCH_STARTED'
  | 'MATCH_PAUSED'
  | 'MATCH_RESUMED'
  | 'MATCH_HALFTIME'
  | 'MATCH_SECOND_HALF_STARTED'
  | 'MATCH_FINISHED'
  | 'MATCH_CANCELLED'
  | 'MATCH_ASSIGNED'
  | 'MATCH_UNASSIGNED'
  | 'MATCH_REORDERED'
  | 'MATCH_ADDED'
  | 'MATCH_REMOVED'
  | 'SCHEDULE_CREATED'
  | 'TIMER_UPDATED'
  | 'BRACKET_UPDATED'
  | 'BRACKET_GENERATED'
  | 'FIELD_UPDATED'
  | 'FIELD_CLAIMED'
  | 'FIELD_RELEASED'
  | 'TOURNAMENT_UPDATED'
  | 'PARTICIPANT_ADDED'
  | 'PARTICIPANT_UPDATED'
  | 'PARTICIPANT_REMOVED'
  | 'TEAM_ADDED'
  | 'TEAM_UPDATED'
  | 'TEAM_REMOVED'
  | 'TEAMS_IMPORTED'
  | 'SETUP_SAVED'
  | 'SETUP_UPDATED'
  | 'SETUP_REMOVED'
  | 'SETTINGS_UPDATED'
  | 'TOURNAMENT_LOADED'
  | 'DRAW_REGISTERED'
  | 'STANDINGS_UPDATED'
  | 'TIE_DETECTED'
  | 'DECISION_MATCH_CREATED'
  | 'SHOOTOUT_STARTED'
  | 'SHOOTOUT_FINISHED'
  | 'TEAM_ADVANCED'
  | 'TEAM_ELIMINATED'
  | 'QUALIFICATION_UPDATED'
  | 'TOURNAMENT_PHASE_UPDATED'
  | 'GROUP_FROZEN'
  | 'FINAL_PHASE_READY'
  | 'FINAL_PHASE_GENERATED'
  | 'FINAL_RANKING_UPDATED'
  | 'VALIDATION_FAILED'
  | 'SYSTEM';

export interface AppEvent {
  seq: number;
  ts: number;
  type: AppEventType;
  fieldId: FieldId | null;
  matchId: string | null;
  actor: string;
  /**
   * The line as it was written, in English. This is the audit record: it is what
   * the database holds, what the CSV export prints and what a client without the
   * catalogue falls back to.
   */
  message: string;
  /**
   * The same line as a catalogue key plus its values, so every device can read
   * the activity feed in its own language. Absent on rows written before this
   * existed, and on the few lines the engine writes as free text.
   */
  text?: EventText;
  data?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Live state                                                         */
/* ------------------------------------------------------------------ */

export interface TournamentState {
  tournament: Tournament | null;
  participants: Record<string, Participant>;
  participantOrder: string[];
  matches: Record<string, Match>;
  matchOrder: string[];
  fields: Record<FieldId, FieldState>;
  settings: Settings;
  /** Radball competition model. Null unless format is 'radball'. */
  radball: RadballCompetition | null;
  /**
   * The host's reusable 2er teams, sorted into age groups. Unlike every other
   * slice this one is *not* cleared when a tournament is created or replaced.
   */
  teamLibrary: TeamLibrary;
  /**
   * Whole tournament setups the host filed for reuse. Also survives creating,
   * replacing and resetting a tournament, for the same reason: the next event
   * of the same kind should not have to be typed again.
   */
  savedTournaments: SavedTournamentLibrary;
  events: AppEvent[];
  seq: number;
  updatedAt: number;
}

export interface NetworkInfo {
  primaryIp: string | null;
  allIps: { iface: string; address: string; family: string }[];
  port: number;
  url: string | null;
  mdnsName: string;
  status: 'CONNECTED' | 'NO_NETWORK_CONNECTION' | 'LOOPBACK_ONLY';
  serverStartedAt: number;
  uptimeSec: number;
  driver: string;
}

export interface SystemStatus {
  database: string;
  databasePath: string;
  databaseOk: boolean;
  lastSaveAt: number | null;
  savedCleanly: boolean;
  clients: number;
  clientsByTopic: Record<string, number>;
  messageCount: number;
  eventsStored: number;
  memoryMb: number;
  cpuPercent: number;
  version: string;
  /** Seconds since the host process started. */
  uptimeSec: number;
}

export interface JoinLink {
  purpose:
    | 'general'
    | 'host'
    | `field-${string}`
    | 'display'
    | `display-${string}`
    | 'bracket'
    | 'results';
  label: string;
  description: string;
  url: string;
  /** Only present for control links. Never sent to spectators. */
  token?: string;
  requiresPin: boolean;
  adminOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* Real-time protocol                                                 */
/* ------------------------------------------------------------------ */

/** Everything a client needs and is allowed to see. */
export interface PublicState {
  protocol: number;
  state: TournamentState;
  network: NetworkInfo;
  links: JoinLink[];
  role: Role;
  tokenScope: string | null;
}

export type Role = 'admin' | 'operator' | 'spectator';

export interface Delta {
  seq: number;
  updatedAt: number;
  tournament?: Tournament | null;
  settings?: Settings;
  fields?: FieldState[];
  matches?: Match[];
  participants?: Participant[];
  removedMatchIds?: string[];
  removedParticipantIds?: string[];
  events?: AppEvent[];
  network?: NetworkInfo;
  matchOrder?: string[];
  participantOrder?: string[];
  radball?: RadballCompetition | null;
  teamLibrary?: TeamLibrary;
  savedTournaments?: SavedTournamentLibrary;
}

export type ServerMessage =
  | { t: 'hello'; protocol: number; serverTime: number; role: Role; tokenScope: string | null }
  | { t: 'state'; state: PublicState }
  | { t: 'delta'; delta: Delta }
  | { t: 'timer'; matchId: string; timer: TimerState; serverTime: number }
  | {
      t: 'notify';
      level: 'info' | 'warn' | 'error';
      message: string;
      /** Catalogue key plus values, so the toast reads in the device's language. */
      text?: EventText;
      requestId?: string;
      /** Machine-readable reason, e.g. PIN_REQUIRED, so the client can react. */
      code?: string;
    }
  | { t: 'ack'; requestId: string; ok: boolean; error?: string; code?: string }
  | { t: 'presence'; fields: Record<FieldId, { controlledBy: string | null; controlledSince: number | null }> }
  | { t: 'pong'; serverTime: number };

export interface ClientHelloMessage {
  t: 'hello';
  protocol: number;
  token?: string | null;
  /**
   * Second factor for a control link. Sent only to the host, never stored in
   * the tournament data, and checked server side before the session is allowed
   * to send any command.
   */
  pin?: string | null;
  /** Subscribe to a restricted topic: field:1, field:2, display, bracket, host */
  topic?: string;
  clientLabel?: string;
  /**
   * Downgrade-only hint. The display pages set this so a screen left on a TV
   * literally cannot send a score command, even when it is opened on the host
   * PC itself.
   */
  readOnly?: boolean;
}

export interface ClientCommandMessage {
  t: 'cmd';
  requestId: string;
  action: string;
  payload?: unknown;
}

export interface ClientResyncMessage {
  t: 'resync';
  requestId?: string;
}

export interface ClientPingMessage {
  t: 'ping';
}

export type ClientMessage =
  | ClientHelloMessage
  | ClientCommandMessage
  | ClientResyncMessage
  | ClientPingMessage;

export const PROTOCOL_VERSION = 2;
