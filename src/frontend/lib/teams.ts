/**
 * Pure view helpers over the team library. Nothing here recalculates anything:
 * the server owns the library, the browser only arranges and formats it, plus
 * the CSV parsing the bulk-entry box needs.
 */
import {
  RADBALL_AGE_CATEGORIES,
  isRadballAgeCategory,
  orderedLibraryTeams,
  type RadballAgeCategory,
  type TeamLibrary,
  type TeamLibraryEntry,
} from '../../shared/types';
import { tr, type MessageKey, type MessageParams } from './i18n';

/**
 * A `t()` bound to one locale, threaded into the label helpers below.
 *
 * Optional, for the same reason as in `lib/radball.ts`: these helpers are pure
 * and are called from tests and from places with no React in scope, so English
 * stays the default and the page passes the translator in.
 */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The tabs the library is sorted into. "all" is a view, never a filing. */
export type AgeGroupTab = RadballAgeCategory | 'all';

export const AGE_GROUP_TABS: AgeGroupTab[] = ['all', ...RADBALL_AGE_CATEGORIES];

export const DEFAULT_AGE_GROUP: RadballAgeCategory = 'ELITE';

/**
 * What an age group means in one line, for the sidebar and the add form.
 *
 * The two catalogue entries carry the whole sentence: `radball.eliteNoLimit` for
 * the open class and `radball.underAge` for the rest, with the year count derived
 * from the identifier exactly as before.
 */
export function ageGroupLabel(age: RadballAgeCategory, t?: Translate): string {
  if (age === 'ELITE') return t ? t('radball.eliteNoLimit') : 'Elite · no age limit';
  const years = Number(age.slice(1));
  return t ? t('radball.underAge', { age, years }) : `${age} · under ${years}`;
}

/** Every team, in the host's own order. */
export function libraryTeams(library: TeamLibrary | null | undefined): TeamLibraryEntry[] {
  return orderedLibraryTeams(library);
}

/** The teams filed under one age group, in the host's own order. */
export function teamsInAgeGroup(
  library: TeamLibrary | null | undefined,
  age: RadballAgeCategory,
): TeamLibraryEntry[] {
  return libraryTeams(library).filter((entry) => entry.ageCategory === age);
}

export function teamsForTab(library: TeamLibrary | null | undefined, tab: AgeGroupTab): TeamLibraryEntry[] {
  if (tab === 'all') return libraryTeams(library);
  return teamsInAgeGroup(library, tab);
}

/** How many teams each tab holds, for the count in the tab label. */
export function ageGroupCounts(library: TeamLibrary | null | undefined): Record<AgeGroupTab, number> {
  const counts = Object.fromEntries(AGE_GROUP_TABS.map((tab) => [tab, 0])) as Record<AgeGroupTab, number>;
  for (const entry of libraryTeams(library)) {
    counts[entry.ageCategory] += 1;
    counts.all += 1;
  }
  return counts;
}

export function teamLabel(entry: TeamLibraryEntry): string {
  return `${entry.players[0]} & ${entry.players[1]}`;
}

/* ------------------------------------------------------------------ */
/* Bulk entry                                                          */
/* ------------------------------------------------------------------ */

export interface ParsedLibraryTeam {
  name: string;
  club: string | null;
  players: [string, string];
  ageCategory: RadballAgeCategory;
  line: number;
}

export interface LibraryTeamIssue {
  line: number;
  message: string;
}

const NAME_HEADERS = new Set(['team', 'team name', 'name', 'mannschaft', 'verein']);
const COLUMN_HEADERS = new Set([
  'club',
  'player 1',
  'player 2',
  'player one',
  'player two',
  'name 1',
  'name 2',
  'rider 1',
  'rider 2',
  'age',
  'age group',
  'age category',
  'u11',
  'u13',
  'u15',
  'u17',
  'u19',
  'u23',
  'elite',
]);

/** Split one line on `,` or `;`, honouring double-quoted cells. */
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
  return cells.map((cell) => cell.replace(/^\uFEFF/, '').trim());
}

/**
 * Read a bulk paste into squads.
 *
 * Accepted column orders, so a list exported from a club sheet usually needs no
 * editing: `team, player 1, player 2`, `team, club, player 1, player 2`, and
 * either of those with a trailing age group. The age group falls back to
 * whichever tab the host is on, which is what makes "paste into U13" work.
 */
export function parseLibraryTeams(raw: string, fallbackAge: RadballAgeCategory = DEFAULT_AGE_GROUP): ParsedLibraryTeam[] {
  const out: ParsedLibraryTeam[] = [];
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const cells = splitCsvLine(line.trim());
    // Skip a header row, but only when column 1 names the team *and* another
    // column names a field -- otherwise a squad called "U13" would vanish.
    const lowered = cells.map((cell) => cell.toLowerCase());
    if (NAME_HEADERS.has(lowered[0] ?? '') && lowered.slice(1).some((cell) => COLUMN_HEADERS.has(cell))) {
      return;
    }

    const trailingAge = cells.length >= 5 ? parseAgeCell(cells[cells.length - 1]) : null;
    const body = trailingAge ? cells.slice(0, -1) : cells;
    const hasClub = body.length >= 4;
    const name = (body[0] ?? '').trim();
    const club = hasClub ? (body[1] ?? '').trim() || null : null;
    const players: [string, string] = hasClub
      ? [(body[2] ?? '').trim(), (body[3] ?? '').trim()]
      : [(body[1] ?? '').trim(), (body[2] ?? '').trim()];
    out.push({
      name,
      club,
      players,
      ageCategory: trailingAge ?? fallbackAge,
      line: index + 1,
    });
  });
  return out;
}

function parseAgeCell(value: string): RadballAgeCategory | null {
  const normalised = value.trim().toUpperCase().replace(/\s+/g, '');
  if (isRadballAgeCategory(normalised)) return normalised;
  // "U13", "U-13" and "13" all mean the same sheet column.
  const numeric = /^U?-?(\d{1,2})$/.exec(normalised);
  if (numeric) {
    const candidate = `U${numeric[1]}`;
    if (isRadballAgeCategory(candidate)) return candidate;
  }
  return null;
}

/**
 * Per-row problems, so the host fixes the paste before anything is filed.
 *
 * `t` reaches only the one message the catalogue names outright -- the missing
 * players, which the catalogue carries as two sentences the code already had.
 * The length and duplicate warnings have no entry, so they stay English rather
 * than borrowing a phrase that would say something else about the column.
 */
export function libraryTeamIssues(teams: ParsedLibraryTeam[], t?: Translate): LibraryTeamIssue[] {
  const issues: LibraryTeamIssue[] = [];
  const say = (key: MessageKey, params?: MessageParams) => (t ? t(key, params) : tr(key, params));
  const names = new Map<string, number[]>();
  for (const team of teams) {
    const add = (message: string) => issues.push({ line: team.line, message });
    if (!team.name) add(say('teams.err.nameColumn'));
    else if (team.name.length > 60) add(say('teams.err.nameLong'));
    if (team.club && team.club.length > 60) add(say('teams.err.clubLong'));
    if (!team.players[0] || !team.players[1]) {
      add(`${say('radball.enterBoth')} ${say('radball.twoerTeam')}`);
    } else if (team.players[0].toLowerCase() === team.players[1].toLowerCase()) {
      add(say('teams.err.differentPlayers'));
    } else if (team.players.some((player) => player.length > 60)) {
      add(say('teams.err.playerNamesLong'));
    }
    if (team.name) {
      const key = team.name.toLowerCase();
      names.set(key, [...(names.get(key) ?? []), team.line]);
    }
  }
  for (const [name, lines] of names) {
    if (lines.length < 2) continue;
    issues.push({
      line: lines[1],
      message: say('teams.err.duplicateName', { name, count: lines.length }),
    });
  }
  return issues;
}

/**
 * A single sentence naming the first thing to fix.
 *
 * The message itself arrives already translated from `libraryTeamIssues`; "Line"
 * has no catalogue entry, so it stays as it was.
 */
export function libraryIssueSummary(issues: LibraryTeamIssue[]): string {
  if (issues.length === 0) return '';
  const first = issues[0];
  const rest = issues.length - 1;
  return rest > 0
    ? tr('teams.lineSummaryMore', { line: first.line, message: first.message, n: rest })
    : tr('teams.lineSummary', { line: first.line, message: first.message });
}

/* ------------------------------------------------------------------ */
/* Library -> tournament roster lines                                  */
/* ------------------------------------------------------------------ */

/** Quote a cell only when it would otherwise break the column split. */
function csvCell(value: string): string {
  return /[,;"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Render library teams as roster lines the setup wizard can paste straight in.
 * The output is exactly what `parseRadballTeams` reads back: a club column only
 * when there is a club, otherwise the shorter three-column form.
 *
 * A crest rides along as a trailing fifth column whenever the squad has one.
 * It has to travel through this text because that text *is* the roster -- the
 * wizard's draft, the saved setup and the tournament create all go through the
 * same lines -- and a logo stored only on the library entry would stop existing
 * the moment a squad was copied onto a field.
 */
export function libraryRosterLines(entries: TeamLibraryEntry[]): string[] {
  return entries.map((entry) => {
    const cells = entry.club
      ? [entry.name, entry.club, entry.players[0], entry.players[1]]
      : [entry.name, entry.players[0], entry.players[1]];
    if (entry.logo) cells.push(entry.logo);
    return cells.map(csvCell).join(',');
  });
}

/**
 * Render library squads as participant lines the generic roster box reads.
 *
 * The output is what `parseParticipants` parses back -- `name, team` -- so a
 * squad picked off the shelf lands in a knockout or a manual schedule exactly as
 * if the host had typed its name and club.
 *
 * The club is the *team* column, which is the only field a generic roster has for
 * an affiliation. A crest rides along as the fourth column behind an empty seed
 * slot, for the same reason `libraryRosterLines` carries one: the roster text is
 * the only thing that survives the copy -- the wizard's draft, the saved setup
 * and the create command all read the same lines -- and a logo left behind on the
 * library entry would silently stop existing the moment a squad was picked.
 */
export function libraryParticipantLines(entries: TeamLibraryEntry[]): string[] {
  return entries.map((entry) => {
    const cells = [entry.name, entry.club ?? ''];
    if (entry.logo) cells.push('', entry.logo);
    return cells.map(csvCell).join(',');
  });
}
