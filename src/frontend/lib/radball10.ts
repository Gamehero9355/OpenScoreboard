/**
 * View helpers for the 10-team Radball format.
 *
 * Everything here *reads* the server's derivation. The engine owns the group
 * rankings, the final-phase structure, the final ranking and the state machine;
 * these functions only name and arrange what it produced. Nothing here computes a
 * point, a rank or a place -- if a number appears on the page, the engine put it
 * there.
 *
 * The one thing this module does add is *presentation of the references*: a
 * final-phase slot is a dependency ("Group A #1", "Winner · Semifinal 1"), and a
 * hall reads it that way, not as "Winner Match 4". Turning a stored reference
 * into that sentence is display, not derivation.
 */
import type {
  Match,
  Radball10Stage,
  RadballFinalKey,
  SlotSource,
  TournamentState,
} from '../../shared/types';
import { RADBALL_FINAL_KEYS } from '../../shared/types';
import { radballFinalKeys } from '../../shared/radball10Structure';
import { nameOf, ordinal as ordinalOf, isLiveMatchState, isOnField, waitingReason } from '../../shared/matchUtils';
import { tr, type MessageKey } from './i18n';
import { roundNameLabel, type Translate } from './radball';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** True for the dedicated ten-team format, false for every other Radball mode. */
export function isTenTeamFormat(state: TournamentState | null | undefined): boolean {
  return state?.tournament?.format === 'radball' && state?.radball?.system === 'radball-10-team';
}

/** "1st", "2nd", "3rd", "4th" ... — the shared one, so the two cannot drift. */
export function ordinal(value: number): string {
  return ordinalOf(value);
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

export type GroupLetter = 'A' | 'B';

/**
 * The fallback name for a group the host never named.
 *
 * Only ever reached for a competition whose `groups` map is missing an entry, so
 * it is a safety net rather than something a hall reads -- but it is still a
 * sentence on screen, so it goes through the catalogue when one is supplied.
 */
function groupLetterName(letter: GroupLetter, t?: Translate): string {
  return (t ?? tr)(letter === 'B' ? 'radball.groupB' : 'radball.groupA');
}

/** The fallback name for a field id with no entry in `state.fields`. */
export function fieldNameFor(fieldId: string, t?: Translate): string {
  return (t ?? tr)('field.label', { n: fieldId });
}

export interface GroupSlot {
  groupId: string;
  letter: GroupLetter;
  name: string;
  fieldId: string | null;
  fieldName: string;
  teams: string[];
  /** Published positions: index 0 is 1st place. */
  ranking: string[];
  played: number;
  total: number;
  complete: boolean;
}

/**
 * The two groups with their five published positions each.
 *
 * A1..A5 are *positions*, not seeds: `ranking[0]` is whoever actually finished
 * first in Group A. That is what lets the final phase be written as "A1 vs B2"
 * and still be correct after a correction.
 */
export function groupSlots(state: TournamentState, t?: Translate): GroupSlot[] {
  const competition = state.radball;
  if (!competition) return [];
  return competition.groupOrder.slice(0, 2).map((groupId, index) => {
    const group = competition.groups[groupId];
    const letter: GroupLetter = index === 1 ? 'B' : 'A';
    const fixtures = Object.values(state.matches).filter(
      (match) => match.radball?.groupId === groupId && match.radball?.matchType === 'GROUP_MATCH',
    );
    const fieldId = group?.fieldId ?? null;
    return {
      groupId,
      letter,
      name: group?.name ?? groupLetterName(letter, t),
      fieldId,
      fieldName: fieldId ? (state.fields[fieldId]?.name ?? fieldNameFor(fieldId, t)) : '—',
      teams: [...(group?.teamIds ?? [])],
      ranking: [...(competition.ten?.rankings[groupId] ?? [])],
      played: fixtures.filter((match) => match.state === 'FINISHED').length,
      total: fixtures.length,
      complete: competition.ten?.groupFrozen[groupId] === true,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Slots and dependencies                                              */
/* ------------------------------------------------------------------ */

/** A structural reference before its match exists: "Group A #3", "Loser SF2". */
export type SlotRef =
  | { source: 'GROUP_A'; rank: number }
  | { source: 'GROUP_B'; rank: number }
  | { source: 'SEMIFINAL'; number: 1 | 2; place: 'winner' | 'loser' };

/** Minimal shape of a structure entry the view needs. */
export type FinalPhaseSpec = {
  key: RadballFinalKey;
  roundName: string;
  places: [number, number] | null;
  slots: [SlotRef, SlotRef];
  dependsOn: string;
};

/**
 * What one side of a match is, in words a hall would use.
 *
 * A stored `group-rank` slot reads as "Group A #3"; a `winner-of` slot reads as
 * "Winner · Semifinal 1", and only as that until its feeder is decided. This is
 * the §29 answer to the ambiguous "Winner Match 4".
 */
/**
 * The key a group position is addressed by in the tree: "A1", "B3".
 *
 * Deliberately built from the group letter and the rank rather than from the
 * group id, so the line keeps pointing at A1 when the host renames or reorders
 * the groups -- a connector keyed on an id would silently reattach itself to the
 * wrong table. Null for a semifinal slot, which has no position row to come from.
 */
export function slotFeedKey(ref: SlotRef): string | null {
  if (ref.source === 'GROUP_A') return `A${ref.rank}`;
  if (ref.source === 'GROUP_B') return `B${ref.rank}`;
  return null;
}

export function slotRefLabel(state: TournamentState, ref: SlotRef, t?: Translate): string {
  if (ref.source === 'GROUP_A' || ref.source === 'GROUP_B') {
    const letter: GroupLetter = ref.source === 'GROUP_B' ? 'B' : 'A';
    const groupId = (state.radball?.groupOrder ?? [])[ref.source === 'GROUP_B' ? 1 : 0];
    return `${state.radball?.groups[groupId ?? '']?.name ?? groupLetterName(letter, t)} #${ref.rank}`;
  }
  const say = t ?? tr;
  const noun = say(ref.place === 'winner' ? 'score.winner' : 'score.loser');
  return `${noun} · ${say('round.semiFinal')} ${ref.number}`;
}

/** The same sentence for a slot as it is actually stored on a match. */
export function slotSourceLabel(state: TournamentState, source: SlotSource, t?: Translate): string {
  switch (source.kind) {
    case 'group-rank': {
      const group = state.radball?.groups[source.groupId];
      const index = (state.radball?.groupOrder ?? []).indexOf(source.groupId);
      const letter: GroupLetter = index === 1 ? 'B' : 'A';
      return `${group?.name ?? groupLetterName(letter, t)} #${source.rank}`;
    }
    case 'winner-of':
    case 'loser-of': {
      const feeder = state.matches[source.matchId];
      const say = t ?? tr;
      const noun = say(source.kind === 'winner-of' ? 'score.winner' : 'score.loser');
      return feeder
        ? `${noun} · ${feeder.roundName}`
        : (t ?? tr)('radball10.undecidedMatch', { noun });
    }
    case 'participant':
      return nameOf(state, source.participantId);
    default:
      return (t ?? tr)('radball10.tbd');
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a fixture is in its life, in the four words a volunteer uses.
 *
 * `played` / `live` / `next` / `waiting` map onto the engine's own match states
 * rather than inventing a parallel set: FINISHED, the on-field and running
 * states, READY, and WAITING. Anything else is treated as waiting, because a
 * cancelled fixture is not something a host wants counted as "going to be played".
 */
export type FixtureState = 'played' | 'live' | 'next' | 'waiting';

export interface GroupFixture {
  id: string;
  /** 1-based: what the hall calls round 1. The engine stores rounds from zero. */
  round: number;
  nameA: string;
  nameB: string;
  scoreA: number;
  scoreB: number;
  status: FixtureState;
  /** Short status word for the row: Live, On field, Ready, Waiting. */
  statusLabel: string;
  /** Why a fixture cannot start yet, when that is the reason. */
  blockedBy: string | null;
}

/**
 * The four status words, in the host's own vocabulary.
 *
 * `Live` and `On field` are deliberately different: one match is being scored
 * right now and the other is sitting on a ring waiting for the whistle. Both are
 * happening, neither is next, and a volunteer chasing the clock needs to tell
 * them apart. The field itself is named in the card header, so the badge does not
 * repeat it.
 *
 * English is the default so every existing caller keeps the wording it had;
 * `groupFixtures(state, groupId, t?)` takes a translator for the UI to use.
 */
const FIXTURE_LABEL: Record<FixtureState, string> = {
  played: 'Played',
  live: 'On field',
  next: 'Ready',
  waiting: 'Waiting',
};

/** The same four words, as catalogue keys, for a translated caller. */
const FIXTURE_LABEL_KEY: Record<FixtureState, 'radball.fixturePlayed' | 'match.running' | 'match.ready' | 'match.awaiting'> = {
  played: 'radball.fixturePlayed',
  live: 'match.running',
  next: 'match.ready',
  waiting: 'match.awaiting',
};

/**
 * The row's short status word.
 *
 * A match being scored reads as `Live` rather than `On field`, so it takes the
 * translator when there is one and keeps the English word when there is not --
 * which is every existing caller and every test.
 */
function fixtureLabel(status: FixtureState, match: Match, t?: Translate): string {
  if (status === 'live' && isLiveMatchState(match.state)) return t ? t('match.running') : 'Live';
  return t ? t(FIXTURE_LABEL_KEY[status]) : FIXTURE_LABEL[status];
}

function fixtureStatus(state: TournamentState, match: Match): FixtureState {
  if (match.state === 'FINISHED') return 'played';
  // A fixture that owns a ring, or is mid-match, is the one happening now.
  if (isOnField(state, match) || isLiveMatchState(match.state)) return 'live';
  // Both squads are known and nothing else is in the way: up next.
  if (match.state === 'READY') return 'next';
  return 'waiting';
}

/**
 * One group's ten preliminary fixtures, in the order they are played.
 *
 * Sorted by round and then position rather than by `matchOrder`, because the
 * queue order is the host's to change and the printed schedule should not move
 * when they do.
 */
export function groupFixtures(state: TournamentState, groupId: string, t?: Translate): GroupFixture[] {
  const fixtures = Object.values(state.matches)
    .filter((match) => match.radball?.groupId === groupId && match.radball?.matchType === 'GROUP_MATCH')
    .sort((a, b) => a.round - b.round || a.position - b.position);
  return fixtures.map((match) => {
    const status = fixtureStatus(state, match);
    return {
      id: match.id,
      round: match.round + 1,
      nameA: nameOf(state, match.participantAId),
      nameB: nameOf(state, match.participantBId),
      scoreA: match.scoreA,
      scoreB: match.scoreB,
      status,
      // Mid-match reads as Live; assigned-but-not-started keeps "On field".
      statusLabel: fixtureLabel(status, match, t),
      blockedBy: status === 'waiting' ? waitingReason(state, match, t) : null,
    };
  });
}

/**
 * One group's ten fixtures reduced to the three questions a host asks mid-event.
 *
 * Printed as three lines rather than ten rows: the tree is a glance panel, and a
 * finished event's twenty results belong on the Results tab and the completed
 * list beside the dashboard -- not here, where they push the two live matches off
 * the bottom of the screen. Nothing is lost: the count says how many are done and
 * the Results tab has every one of them.
 */
export interface GroupFixtureDigest {
  /** Finished, newest last: "B 3:1 E · C 4:2 D". */
  played: string[];
  /** The match on this field right now, if there is one. */
  live: GroupFixture | null;
  /** The next match up on this field. */
  next: GroupFixture | null;
  /** Open matches this field cannot play yet. */
  waiting: number;
}

export function groupFixtureDigest(state: TournamentState, groupId: string): GroupFixtureDigest {
  const fixtures = groupFixtures(state, groupId);
  const short = (fixture: GroupFixture) =>
    `${fixture.nameA} ${fixture.scoreA}:${fixture.scoreB} ${fixture.nameB}`;
  return {
    played: fixtures.filter((f) => f.status === 'played').map(short),
    // Prefer the match actually being scored over one merely assigned. Tested
    // against the match's own state, not against `statusLabel` -- that string is
    // translated, so comparing it would silently stop matching in German.
    live:
      fixtures.find((f) => f.status === 'live' && isLiveMatchState(state.matches[f.id]?.state ?? 'PENDING')) ??
      fixtures.find((f) => f.status === 'live') ??
      null,
    next: fixtures.find((f) => f.status === 'next') ?? null,
    waiting: fixtures.filter((f) => f.status === 'waiting').length,
  };
}

/* ------------------------------------------------------------------ */
/* Final phase                                                         */
/* ------------------------------------------------------------------ */

/** Derived match id, so the view finds a match without importing engine helpers. */
export function finalMatchId(state: TournamentState, key: RadballFinalKey): string {
  return `${state.tournament?.id ?? ''}:rf10:${key.toLowerCase()}`;
}

/**
 * Every final-phase key in the recommended playing order, for this competition.
 *
 * A function of the group size rather than a constant: two groups of six have
 * four placement matches, so the ten-team list would be both too short and wrong.
 */
export function recommendedOrder(state: TournamentState): RadballFinalKey[] {
  return radballFinalKeys(groupSizeOfState(state));
}

/** The ten-team World Cup's order. Kept for the preset and the tests. */
export const RECOMMENDED_ORDER: RadballFinalKey[] = [...RADBALL_FINAL_KEYS];

export interface FinalPhaseRow {
  key: RadballFinalKey;
  match: Match | null;
  title: string;
  /** What the match is played for, e.g. "Play for 9th / 10th". */
  purpose: string;
  /**
   * The same thing in four characters, for the row's leading column: "9/10",
   * "SF 1", "3/4", "1/2".
   *
   * The seven rows are the format, and a leading column of short place labels is
   * what makes them scannable: the eye reads down one aligned column and sees the
   * whole ladder, instead of re-parsing a sentence on every line.
   */
  shortLabel: string;
  places: [number, number] | null;
  sideA: string;
  sideB: string;
  /**
   * Stable key for each side when it comes from a published group position, so
   * the tree can draw the line from that position's row to the match it feeds.
   * Null for a side that comes from a semifinal instead: those two rows have no
   * feeder on the left, and drawing a line to nothing would be a lie.
   */
  slotAKey: string | null;
  slotBKey: string | null;
  scoreA: number | null;
  scoreB: number | null;
  state: Match['state'] | 'NOT_CREATED';
  fieldId: string | null;
  /** Why this match cannot be played yet, if that is why. */
  blockedBy: string | null;
  winnerId: string | null;
}

/** The row's leading label: a place pair where it hands out places, else its round. */
function shortLabelFor(entry: FinalPhaseSpec): string {
  if (entry.places) return `${entry.places[0]}/${entry.places[1]}`;
  if (entry.key === 'SEMIFINAL_1') return 'SF 1';
  if (entry.key === 'SEMIFINAL_2') return 'SF 2';
  return entry.roundName;
}

/**
 * A side's name, resolving a group slot to the team that holds it once the group
 * is frozen.
 *
 * Until then "Group A #3" is the honest answer -- nobody has finished third yet.
 * The moment the group *is* frozen the position means one specific squad, and
 * printing the squad saves the reader a trip up to the standings table for the
 * only window where the label and the name disagree.
 */
function sideLabel(state: TournamentState, ref: SlotRef, t?: Translate): string {
  if (ref.source === 'GROUP_A' || ref.source === 'GROUP_B') {
    const groupId = groupIdOfRef(state, ref.source);
    const frozen = groupId ? state.radball?.ten?.groupFrozen[groupId] === true : false;
    const teamId = frozen ? state.radball?.ten?.rankings[groupId ?? '']?.[ref.rank - 1] : undefined;
    if (teamId) return nameOf(state, teamId);
  }
  return slotRefLabel(state, ref, t);
}

function groupIdOfRef(state: TournamentState, source: 'GROUP_A' | 'GROUP_B'): string | null {
  const competition = state.radball;
  if (!competition) return null;
  const index = source === 'GROUP_B' ? 1 : 0;
  return competition.groupOrder[index] ?? null;
}

/**
 * The seven final-phase rows, in whatever order the host scheduled them.
 *
 * The order is the *schedule*, not the structure. The `blockedBy` column is
 * computed from the semifinals alone, so no schedule can make the final startable
 * early -- which is exactly §25's promise.
 */
export function finalPhaseRows(
  state: TournamentState,
  structure: FinalPhaseSpec[],
  t?: Translate,
): FinalPhaseRow[] {
  const semis = [state.matches[finalMatchId(state, 'SEMIFINAL_1')], state.matches[finalMatchId(state, 'SEMIFINAL_2')]];
  const settled = (match: Match | undefined) => match?.state === 'FINISHED';
  const openSemis = semis.filter((match) => match && !settled(match)).map((match) => match!.roundName);

  return structure.map((entry) => {
    const match = state.matches[finalMatchId(state, entry.key)] ?? null;
    const blockedBy = entry.dependsOn === 'semifinals-complete' && openSemis.length > 0 ? openSemis.join(' and ') : null;
    return {
      key: entry.key,
      match,
      title: roundNameLabel(entry.roundName, t),
      purpose: entry.places
        ? tr('radball10.playFor', {
            a: ordinal(entry.places[0]),
            b: ordinal(entry.places[1]),
          })
        : tr('radball10.qualifiesForFinal'),
      shortLabel: shortLabelFor(entry),
      places: entry.places,
      sideA: match?.participantAId ? nameOf(state, match.participantAId) : sideLabel(state, entry.slots[0], t),
      sideB: match?.participantBId ? nameOf(state, match.participantBId) : sideLabel(state, entry.slots[1], t),
      slotAKey: slotFeedKey(entry.slots[0]),
      slotBKey: slotFeedKey(entry.slots[1]),
      scoreA: match && match.scoreA > 0 ? match.scoreA : null,
      scoreB: match && match.scoreB > 0 ? match.scoreB : null,
      state: match?.state ?? 'NOT_CREATED',
      fieldId: match?.fieldId ?? null,
      blockedBy: match && match.state !== 'FINISHED' ? blockedBy : null,
      winnerId: match?.winnerId ?? null,
    };
  });
}

/**
 * One sentence for the whole preliminary round, and how far along it is.
 *
 * Both groups are played together, so the progress belongs to the round rather
 * than to a column inside each group's card -- which is also why the cards no
 * longer carry their own played-count badges.
 */
export function preliminaryProgress(
  groups: GroupSlot[],
): { played: number; total: number; complete: boolean; label: string } {
  const played = groups.reduce((sum, group) => sum + group.played, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const complete = total > 0 && played >= total;
  return {
    played,
    total,
    complete,
    label: complete
      ? tr('radball10.progressAll', { total })
      : tr('radball10.progressOf', { played, total }),
  };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/**
 * Places 1-10 exactly as the engine derived them, each naming the match that
 * decided it. Nothing is re-sorted: the row order *is* the place order, because
 * the engine assigned them.
 */
export interface FinalRankingRow {
  place: number;
  ordinal: string;
  teamId: string | null;
  name: string;
  /** "final", "third place", "placement 5 6", ... */
  source: string;
  decided: boolean;
}

export function finalRankingRows(state: TournamentState): FinalRankingRow[] {
  const entries = state.radball?.ten?.ranking ?? [];
  return entries.map((entry) => ({
    place: entry.place,
    ordinal: ordinal(entry.place),
    teamId: entry.teamId,
    name: entry.teamId ? nameOf(state, entry.teamId) : '—',
    source:
      entry.source === 'NOT_DECIDED'
        ? tr('radball10.notDecided')
        : entry.source.toLowerCase().replaceAll('_', ' '),
    decided: entry.teamId !== null,
  }));
}

/** The validation messages that keep a half-finished competition from being claimed. */
export function validationIssues(state: TournamentState): string[] {
  return state.radball?.ten?.issues ?? [];
}

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

export const STAGE_ORDER: Radball10Stage[] = [
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

/**
 * The nine states as short labels.
 *
 * A function rather than a table for the same reason as every other label map
 * here: the catalogue can only be read through a `t`, and this module has no
 * React to read one from. The stages with an entry are translated; `SETUP` is
 * the same word in both languages and `GROUP_PHASE`/`GROUP_PHASE_COMPLETE`/
 * `FINAL_PHASE_READY` have no entry, so those three stay English.
 */
export function stageLabel(stage: Radball10Stage, t?: Translate): string {
  const say = t ?? tr;
  switch (stage) {
    case 'PLACEMENT_MATCHES':
      return say('radball10.stagePlacement');
    case 'SEMIFINALS':
      return say('radball10.stageSemifinals');
    case 'THIRD_PLACE':
      return say('radball10.stageThirdPlace');
    case 'FINAL':
      return say('round.final');
    case 'COMPLETED':
      return say('radball10.stageCompleted');
    case 'GROUP_PHASE_COMPLETE':
      return say('radball10.stagePreliminaryComplete');
    case 'FINAL_PHASE_READY':
      return say('radball10.stageFinalPhaseReady');
    default:
      return say(stage === 'SETUP' ? 'radball10.stageSetup' : 'radball10.preliminaryRound');
  }
}

/**
 * One sentence per stage: what is going on and what unlocks the next step.
 *
 * A key table rather than a sentence table, so the trail can read in the host's
 * language. The counts belong to the competition, not to the sentence, which is
 * why the sentences themselves name no number.
 */
const STAGE_HINT_KEY: Record<Radball10Stage, MessageKey> = {
  SETUP: 'radball10.hintSetup',
  GROUP_PHASE: 'radball10.hintGroupPhase',
  GROUP_PHASE_COMPLETE: 'radball10.hintGroupPhaseComplete',
  FINAL_PHASE_READY: 'radball10.hintFinalPhaseReady',
  PLACEMENT_MATCHES: 'radball10.hintPlacement',
  SEMIFINALS: 'radball10.hintSemifinals',
  THIRD_PLACE: 'radball10.hintThirdPlace',
  FINAL: 'radball10.hintFinal',
  COMPLETED: 'radball10.hintCompleted',
};

export interface StageStep {
  stage: Radball10Stage;
  label: string;
  hint: string;
  reached: boolean;
  current: boolean;
}

/**
 * The nine states as a trail, with the current one marked.
 *
 * Rendered so an organiser can see *where* the competition is and not only what
 * is on the field. The current stage is derived server-side from the results,
 * which is what makes an impossible state unrepresentable rather than merely
 * forbidden.
 */
export function stageTrail(state: TournamentState, t?: Translate): StageStep[] {
  const current = state.radball?.ten?.stage ?? 'SETUP';
  const index = STAGE_ORDER.indexOf(current);
  return STAGE_ORDER.map((stage, position) => ({
    stage,
    label: stageLabel(stage, t),
    hint: (t ?? tr)(STAGE_HINT_KEY[stage]),
    reached: index >= position,
    current: stage === current,
  }));
}

/* ------------------------------------------------------------------ */
/* Format documentation                                                */
/* ------------------------------------------------------------------ */

export interface FormatDocLine {
  label: string;
  text: string;
}

/**
 * The structure, written out for the host under Tournament → Rules / Format.
 *
 * Generated from the same structure table the engine builds its matches from, so
 * the page and the code cannot drift apart.
 *
 * `t` is optional and only reaches the group names and the slot references: the
 * prose around them counts matches out of the structure, and there is no
 * catalogue entry for a sentence that has to agree with those counts.
 */
export function formatDocumentation(
  state: TournamentState,
  structure: FinalPhaseSpec[],
  t?: Translate,
): FormatDocLine[] {
  const pair = (key: RadballFinalKey): string => {
    const entry = structure.find((candidate) => candidate.key === key);
    if (!entry) return '';
    return `${slotRefLabel(state, entry.slots[0], t)} vs ${slotRefLabel(state, entry.slots[1], t)}`;
  };
  // Counts read off the competition, so a twelve-team tournament describes
  // itself correctly instead of claiming to be the ten-team one.
  const competition = state.radball;
  const groupSize = groupSizeOfState(state);
  const total = groupSize * 2;
  const perGroup = (groupSize * (groupSize - 1)) / 2;
  const fieldNames = (competition?.groupOrder ?? [])
    .map((groupId) => state.fields[competition?.groups[groupId]?.fieldId ?? '']?.name)
    .filter(Boolean);

  const lines: FormatDocLine[] = [
    {
      label: (t ?? tr)('radball10.preliminaryRound'),
      text:
        `${(t ?? tr)('radball10.docGroups', {
          size: groupSize,
          perGroup,
          total: perGroup * 2,
        })} ` +
        (fieldNames.length === 2
          ? (t ?? tr)('radball10.docFieldsTwo', {
              a: (t ?? tr)('radball.groupA'),
              b: (t ?? tr)('radball.groupB'),
              fieldA: fieldNames[0],
              fieldB: fieldNames[1],
            })
          : (t ?? tr)('radball10.docFieldsPinned')),
    },
  ];
  // Placement matches and the semifinals, in the structure's own order.
  for (const key of radballFinalKeys(groupSize)) {
    const entry = structure.find((candidate) => candidate.key === key);
    if (!entry) continue;
    if (key === 'THIRD_PLACE' || key === 'FINAL') continue;
    lines.push({
      label: entry.roundName,
      text: entry.places
        ? (t ?? tr)('radball10.docPlayForPlace', {
            pair: pair(key),
            a: ordinal(entry.places[0]),
            b: ordinal(entry.places[1]),
          })
        : (t ?? tr)('radball10.docToSemifinal', { pair: pair(key) }),
    });
  }
  lines.push({
    label: (t ?? tr)('radball10.stageThirdPlace'),
    text: `${(t ?? tr)('score.loser')} ${(t ?? tr)('round.semiFinal')} 1 vs ${(t ?? tr)('score.loser')} ${(t ?? tr)('round.semiFinal')} 2`,
  });
  lines.push({
    label: (t ?? tr)('radball10.radballFinal'),
    text: `${(t ?? tr)('score.winner')} ${(t ?? tr)('round.semiFinal')} 1 vs ${(t ?? tr)('score.winner')} ${(t ?? tr)('round.semiFinal')} 2`,
  });
  lines.push({
    label: (t ?? tr)('radball10.docTotal'),
    text: (t ?? tr)('radball10.docTotalText', {
      pre: perGroup * 2,
      phase: structure.length,
      sum: perGroup * 2 + structure.length,
      places: total,
    }),
  });
  return lines;
}

/** Teams per group, read off the competition's own first group. */
export function groupSizeOfState(state: TournamentState): number {
  const competition = state.radball;
  const first = competition?.groupOrder[0];
  const group = first ? competition?.groups[first] : null;
  return group?.teamIds.length ?? 5;
}