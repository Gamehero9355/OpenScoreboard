import { defaultFieldNames, type FieldId, type Match, type MatchState, type Participant, type TimerState, type TournamentState } from './types';

/**
 * A match that was actually played. Byes and cancelled matches are part of the
 * bracket structure but not part of the results, the statistics or the match
 * history.
 */
export function isRealMatch(match: Match): boolean {
  if (match.state === 'CANCELLED') return false;
  if (match.slotA.kind === 'bye' || match.slotB.kind === 'bye') return false;
  if (match.history.length === 0 && match.scoreA === 0 && match.scoreB === 0) return false;
  return true;
}

export function isPlayable(match: Match): boolean {
  return Boolean(match.participantAId && match.participantBId);
}

/**
 * Is this match currently sitting on a playing field?
 *
 * `match.fieldId` is kept after a match finishes so the board can still show
 * where it was played, so it is *not* the test. The invariant is
 * `match.fieldId` <=> `state.fields[fieldId].matchId === match.id`, and that is
 * what this checks. Anything asking "who is running what right now" -- the host's
 * queue panel, the field card, the display -- wants this, not `fieldId`.
 *
 * Pass `fieldId` to ask about one specific field ("is it on *this* field?").
 * Without it the answer is "is it on any field", which is the wrong question for
 * a per-field queue: the ring a match sits on owns it, and every other ring must
 * leave it alone.
 */
export function isOnField(state: TournamentState, match: Match, fieldId?: FieldId): boolean {
  const on = match.fieldId;
  if (!on) return false;
  if (fieldId !== undefined && on !== fieldId) return false;
  return state.fields[on]?.matchId === match.id;
}

export function isLiveMatchState(state: MatchState): boolean {
  return state === 'RUNNING' || state === 'PAUSED' || state === 'HALFTIME';
}

export const MATCH_STATE_LABEL: Record<MatchState, string> = {
  WAITING: 'Waiting',
  READY: 'Ready',
  ASSIGNED: 'On field',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  HALFTIME: 'Halftime',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
};

export const MATCH_STATE_TONE: Record<MatchState, string> = {
  WAITING: 'neutral',
  READY: 'info',
  ASSIGNED: 'accent',
  RUNNING: 'live',
  PAUSED: 'warn',
  HALFTIME: 'warn',
  FINISHED: 'done',
  CANCELLED: 'muted',
};

export function participantLabel(participant: Participant | null | undefined, fallback = 'TBD'): string {
  if (!participant) return fallback;
  return participant.team ? `${participant.name} · ${participant.team}` : participant.name;
}

export function nameOf(state: TournamentState, id: string | null, fallback = 'TBD'): string {
  if (!id) return fallback;
  const participant = state.participants[id];
  return participant ? participant.name : fallback;
}

/**
 * A team's crest file name, or null when it has none of its own and the folder's
 * default should stand in.
 *
 * The companion to `nameOf`: every screen that shows a name through `nameOf` can
 * ask for this and get the mark that belongs to it, without looking the
 * participant up a second time.
 */
export function logoOf(state: TournamentState, id: string | null): string | null {
  if (!id) return null;
  return state.participants[id]?.logo ?? null;
}

export function teamOf(state: TournamentState, id: string | null): string | null {
  if (!id) return null;
  return state.participants[id]?.team ?? null;
}

/**
 * One half's length in seconds, falling back to the match length divided by the
 * halves for a timer that predates the field.
 */
function periodDurationSecOf(timer: TimerState): number {
  if (Number.isFinite(timer.periodDurationSec)) return timer.periodDurationSec;
  const durationSec = Number.isFinite(timer.durationSec) ? timer.durationSec : 0;
  return durationSec / (timer.periodCount === 1 ? 1 : 2);
}

/** Milliseconds played in the match, including the segment still running. */
function timerElapsedMs(timer: TimerState, now: number): number {
  const elapsedMs = Number.isFinite(timer.elapsedMs) ? timer.elapsedMs : 0;
  if (!timer.running || timer.anchorAt === null) return Math.max(0, elapsedMs);
  return Math.max(0, elapsedMs + Math.max(0, now - timer.anchorAt));
}

/** Milliseconds played in the current half. */
function timerPeriodElapsedMs(timer: TimerState, now: number): number {
  const periodStart = Number.isFinite(timer.periodStartElapsedMs) ? timer.periodStartElapsedMs : 0;
  return Math.max(0, timerElapsedMs(timer, now) - periodStart);
}

/** Seconds played in the current half. The same number in either clock mode. */
export function periodElapsedSec(timer: TimerState, now: number): number {
  return Math.max(0, timerPeriodElapsedMs(timer, now) / 1000);
}

/**
 * Seconds the field still has for the current half.
 *
 * For a countdown this *is* the number on the board, which is what makes it the
 * right thing to hand an operator who is being asked to retype that number: the
 * box and the wall clock then read the same. For a count-up it is the time the
 * half still has to run, because the counter on the board has already spent it.
 */
export function periodLeftSec(timer: TimerState, now: number): number {
  return Math.max(0, periodDurationSecOf(timer) - periodElapsedSec(timer, now));
}

export function timerMs(timer: TimerState, now: number): number {
  if (timer.mode === 'down') return Math.max(0, periodLeftSec(timer, now) * 1000);
  return Math.max(0, timerElapsedMs(timer, now));
}

export function clock(timer: TimerState, now: number): string {
  const ms = timerMs(timer, now);
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function isTimeUp(timer: TimerState, now: number): boolean {
  return timer.mode === 'down' && timerMs(timer, now) <= 0;
}

export function fieldName(state: TournamentState, fieldId: FieldId | null): string {
  if (!fieldId) return 'unassigned';
  return state.fields[fieldId]?.name ?? `Field ${fieldId}`;
}

/** True when at least one participant was registered on a playing field. */
export function hasHomeRosters(state: TournamentState): boolean {
  return Object.values(state.participants).some((p) => Boolean(p.fieldId && state.fields[p.fieldId]));
}

/**
 * The playing field a match belongs to.
 *
 * A match is a field's own when every player who can possibly turn up in it was
 * registered on that field. That is worked out structurally, not just from the
 * two participants: a slot waiting on "winner of Quarterfinal 2" already belongs
 * to the field that quarterfinal belongs to. So the semifinal is Field 1's from
 * the moment the bracket is drawn, long before anyone has played.
 *
 * When a tournament carries no field rosters at all -- a quick draw, an import,
 * or a tournament created before rosters existed -- there is nothing to link a
 * match to a field that way, so each field runs a **section of the draw**
 * instead: the opening round is cut into one contiguous block per field (Field 1
 * the top block, Field 2 the next) and a later match belongs to the block that
 * feeds it.
 *
 * `null` means "either field": the players come from two different fields (the
 * final, the bronze match, most losers-bracket rounds) or the match is fed by
 * two sections of the draw. Those matches may be played on either one. Every
 * Radball match without a pinned group is "either field" too -- see below.
 */
export function homeFieldOf(state: TournamentState, match: Match): FieldId | null {
  const fields = fieldIds(state);
  if (fields.length === 0) return null;

  // A group pinned to a field outranks everything below: in the 10-team format
  // Group A *is* Field 1 and Group B *is* Field 2, so every fixture of a group
  // belongs to that field's queue and one A match and one B match can run side
  // by side. The structural search below would answer "either field" for most of
  // these, because a group's teams are registered across both rosters.
  const pinned = pinnedFieldOfGroup(state, groupIdOfMatch(match));
  if (pinned) return pinned;

  const registered = registeredFields(state, match, 0, new Map());
  if (registered.size === 1) {
    const [only] = [...registered];
    return only ?? null;
  }

  // A Radball match is never "a section of the draw". That heuristic counts the
  // bracket's opening round and walks outwards from it, which is meaningful for a
  // knockout and meaningless here: a round robin has no sections, and the ten-team
  // final phase is cross-group by definition -- its teams come from both fields by
  // design, not by accident.
  //
  // Letting the heuristic run anyway produced actively wrong answers: the seven
  // final-phase matches inherited arbitrary ownership from the group rounds'
  // positions, so most of them claimed a single field and the host's queue showed
  // them as "Field 2's own" before anyone had assigned anything. A Radball match
  // with no registration to go by is *either field*, and the ten-team rules say so
  // outright: the host assigns each final-phase match to whichever field is free.
  if (match.radball) return null;

  if (hasHomeRosters(state)) return null;

  // No rosters anywhere: fall back to the section of the bracket this match
  // sits in and is fed by.
  const opening = openingRoundSize(state);
  if (opening < 2) return null;
  const entries = openingEntries(state, match, 0, new Map(), opening);
  if (entries.size === 0) return null;
  return blockOwner(fields, opening, entries);
}

/**
 * Every match that is still to be played, in the order the draw was made:
 * bracket order first (ranking rounds carry a `round: 900` sentinel precisely so
 * they sort after every real round), then the Radball final-phase slots.
 */
export function openMatches(state: TournamentState): Match[] {
  const rank = new Map(state.matchOrder.map((id, index) => [id, index]));
  return Object.values(state.matches)
    .filter((match) => match.state !== 'FINISHED' && match.state !== 'CANCELLED')
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) ||
        a.round - b.round ||
        a.position - b.position,
    );
}

/**
 * A field's own matches: every player who can still turn up in them was
 * registered on that field, plus anything already sitting on it. Includes the
 * later rounds that field feeds, so the semifinal sits in the queue from the
 * moment the draw is made.
 */
export function fieldQueue(state: TournamentState, fieldId: FieldId): Match[] {
  return openMatches(state).filter(
    (match) => isOnField(state, match, fieldId) || homeFieldOf(state, match) === fieldId,
  );
}

/**
 * Matches neither field owns *and* nobody has taken yet: both players are known,
 * and either field may play them.
 *
 * "Nobody has taken yet" is the load-bearing clause. A match that has been
 * assigned to a field is that field's match now, whatever it was before --
 * listing it here as well would put one running game in two queues at once and
 * print "either field" next to "on Field 2" in the same row, which is exactly
 * how a host ends up unsure which ring is running the match.
 */
export function sharedQueue(state: TournamentState): Match[] {
  return openMatches(state).filter(
    (match) => homeFieldOf(state, match) === null && isPlayable(match) && !isOnField(state, match),
  );
}

/**
 * Every field a player in this match could have been registered on. Empty means
 * nobody in it carries a field, so it is not tied to one that way.
 */
function registeredFields(
  state: TournamentState,
  match: Match,
  depth: number,
  cache: Map<string, Set<FieldId>>,
): Set<FieldId> {
  const cached = cache.get(match.id);
  if (cached) return cached;
  // Defensive: the bracket is a DAG, but broken data must not recurse forever.
  if (depth > 32) return new Set<FieldId>();

  const fields = new Set<FieldId>();
  const add = (fieldId: FieldId | null | undefined): void => {
    if (fieldId && state.fields[fieldId]) fields.add(fieldId);
  };
  for (const slot of ['A', 'B'] as const) {
    const current = slot === 'A' ? match.participantAId : match.participantBId;
    if (current) {
      add(state.participants[current]?.fieldId);
      continue;
    }
    const source = slot === 'A' ? match.slotA : match.slotB;
    if (source.kind === 'participant') {
      add(state.participants[source.participantId]?.fieldId);
      continue;
    }
    if (source.kind === 'winner-of' || source.kind === 'loser-of') {
      const feeder = state.matches[source.matchId];
      if (!feeder) continue;
      for (const field of registeredFields(state, feeder, depth + 1, cache)) fields.add(field);
      continue;
    }
    if (source.kind === 'group-rank') {
      // Follow the published ranking so the slot constrains the field exactly as
      // the team it will eventually hold does. Before the group is ranked the
      // slot adds no constraint, which correctly leaves the match "either field".
      const teamId = state.radball?.ten?.rankings[source.groupId]?.[source.rank - 1];
      if (teamId) add(state.participants[teamId]?.fieldId);
      continue;
    }
    // A bye carries nobody, so it puts no constraint on the field.
  }
  cache.set(match.id, fields);
  return fields;
}

/** Number of opening-round matches in the winners bracket. */
function openingRoundSize(state: TournamentState): number {
  let count = 0;
  for (const match of Object.values(state.matches)) {
    if (match.bracket === 'winners' && match.round === 0) count += 1;
  }
  return count;
}

/**
 * Opening-round matches this match is fed by, following the bracket. A match
 * with a broken or missing feeder falls back to the section it covers itself,
 * so a damaged tree still lands in a queue instead of vanishing.
 */
function openingEntries(
  state: TournamentState,
  match: Match,
  depth: number,
  cache: Map<string, Set<number>>,
  opening: number,
): Set<number> {
  const cached = cache.get(match.id);
  if (cached) return cached;
  const entries = new Set<number>();
  // Registered before recursing so a malformed cycle cannot spin.
  cache.set(match.id, entries);
  if (depth > 32) return entries;

  if (match.bracket === 'winners' && match.round === 0) {
    entries.add(match.position);
    return entries;
  }
  for (const source of [match.slotA, match.slotB]) {
    if (source.kind === 'winner-of' || source.kind === 'loser-of') {
      const feeder = state.matches[source.matchId];
      if (feeder) {
        for (const entry of openingEntries(state, feeder, depth + 1, cache, opening)) entries.add(entry);
        continue;
      }
    }
    if (match.bracket === 'winners') {
      // A winners match at round R covers 2^R slots of the opening round, but
      // `round` is not always a bracket depth: Radball ranking and decision
      // matches carry a `round: 900` sentinel purely so they sort after every
      // real round, and 2 ** 900 is Infinity. Clamping to the opening round
      // keeps the span meaningful -- these numbers are positions *in* the
      // opening round, so none of them can exceed it -- and stops a sentinel
      // from turning this loop into an unbounded Set that takes the page down.
      const raw = 2 ** Math.max(0, match.round);
      const span = Number.isFinite(raw) ? Math.min(raw, opening) : opening;
      const start = match.position * span;
      for (let index = 0; index < span; index += 1) entries.add(start + index);
    }
  }
  return entries;
}

/**
 * Field that owns a block of the opening round, or null when the entries span
 * more than one block and either field may therefore play the match.
 */
function blockOwner(fields: FieldId[], opening: number, entries: Set<number>): FieldId | null {
  const blocks = Math.min(fields.length, opening);
  let owner: FieldId | null = null;
  for (const entry of entries) {
    const index = Math.min(blocks - 1, Math.floor((entry * blocks) / opening));
    const fieldId = fields[index] ?? null;
    if (fieldId === null) return null;
    if (owner === null) owner = fieldId;
    else if (owner !== fieldId) return null;
  }
  return owner;
}

/** Ids of all playing fields in canonical numeric order. */
export function fieldIds(state: TournamentState): FieldId[] {
  return Object.keys(state.fields).sort((a, b) => Number(a) - Number(b));
}

/** The first match currently sitting on any field (canonical field order). */
export function firstFieldMatchId(state: TournamentState): string | null {
  for (const id of fieldIds(state)) {
    const matchId = state.fields[id]?.matchId;
    if (matchId) return matchId;
  }
  return null;
}

/**
 * The smallest thing this module needs to put a sentence in the reader's
 * language.
 *
 * The key is a plain `string` because `src/shared` cannot import the frontend
 * catalogue -- the server bundle pulls from here too, and the catalogue is a UI
 * concern. That costs the compile-time guarantee that a key exists, which is the
 * trade: `englishWaiting` below is the exhaustive fallback that keeps the default
 * English wording byte-for-byte what it always was.
 *
 * Callers pass `asTranslate(t)` from `lib/useI18n`, which adapts the strictly
 * typed `t` to this looser signature in one place instead of at every call site.
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The name a playing field is shown under.
 *
 * Stored field names default to the English "Field 1", "Field 2", ... so a
 * host who never renamed them would otherwise read English in a German hall.
 * A name the host typed is their own wording and passes through untouched;
 * only an untouched default is rendered in the reader's language, and a
 * missing name reads as the translated label -- the same fallback every call
 * site already used. Callers pass `asTranslate(t)`, same as `waitingReason`.
 */
export function fieldDisplayName(stored: unknown, fieldId: string, t?: Translate): string {
  const say: Translate =
    t ?? ((key, params) => (key === 'field.label' && params?.n !== undefined ? `Field ${params.n}` : key));
  if (typeof stored === 'string' && stored.trim() !== '') {
    const n = Number(fieldId);
    const builtin = Number.isInteger(n) && n >= 1 ? defaultFieldNames(n)[n - 1] : undefined;
    if (stored !== builtin) return stored;
  }
  return say('field.label', { n: fieldId });
}

/** Human readable "next up" description for a match that is still waiting. */
export function waitingReason(state: TournamentState, match: Match, t?: Translate): string | null {
  if (match.state !== 'WAITING') return null;
  const say: Translate = t ?? englishWaiting;
  const missing: string[] = [];
  for (const slot of ['A', 'B'] as const) {
    const source = slot === 'A' ? match.slotA : match.slotB;
    const current = slot === 'A' ? match.participantAId : match.participantBId;
    if (current) continue;
    if (source.kind === 'winner-of') {
      const feeder = state.matches[source.matchId];
      missing.push(
        feeder
          ? say('match.waitingWinnerOf', { round: feeder.roundName, n: feeder.position + 1 })
          : say('match.waitingFeeder'),
      );
    } else if (source.kind === 'loser-of') {
      const feeder = state.matches[source.matchId];
      missing.push(
        feeder
          ? say('match.waitingLoserOf', { round: feeder.roundName, n: feeder.position + 1 })
          : say('match.waitingFeeder'),
      );
    } else if (source.kind === 'group-rank') {
      const group = state.radball?.groups[source.groupId];
      missing.push(
        say('match.waitingGroupPlace', {
          group: group?.name ?? say('radball.groupA'),
          rank: source.rank,
          ordinal: ordinal(source.rank),
        }),
      );
    } else if (source.kind === 'participant') {
      missing.push(say('match.waitingParticipant'));
    }
  }
  if (missing.length === 0) return null;
  return say('match.waitingFor', { what: missing.join(say('match.joinAnd')) });
}

/**
 * The English wording for the keys `waitingReason` uses, spelled out here.
 *
 * They live in the frontend catalogue like every other user-facing string; this
 * function exists only because `src/shared` cannot import it, and it keeps the
 * English default that every existing caller (and the engine's own tests) relies
 * on. Passing a real `t` is what makes the UI German.
 */
function englishWaiting(key: string, params?: Record<string, string | number>): string {
  const n = String(params?.n ?? '');
  const round = String(params?.round ?? '');
  const group = String(params?.group ?? 'group');
  const ordinalText = String(params?.ordinal ?? n);
  const what = String(params?.what ?? '');
  switch (key) {
    case 'match.waitingWinnerOf':
      return `winner of ${round} #${n}`;
    case 'match.waitingLoserOf':
      return `loser of ${round} #${n}`;
    case 'match.waitingGroupPlace':
      return `${group} ${ordinalText} place`;
    case 'match.waitingFeeder':
      return 'a feeder match';
    case 'match.waitingParticipant':
      return 'a participant';
    case 'match.joinAnd':
      return ' and ';
    case 'match.waitingFor':
      return `Waiting for ${what}`;
    default:
      return what;
  }
}

/** 1 -> "1st", 2 -> "2nd", 4 -> "4th". */
export function ordinal(value: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const mod = value % 100;
  return `${value}${suffixes[(mod - 20) % 10] ?? suffixes[mod] ?? 'th'}`;
}

/**
 * The group a match belongs to, when it has one. The 10-team format reads this
 * to pin a group's whole fixture list to one playing field.
 */
export function groupIdOfMatch(match: Match): string | null {
  return match.radball?.groupId ?? null;
}

/**
 * The playing field a group is pinned to, or null when the format does not pin
 * one. Group A is Field 1 and Group B is Field 2 in the 10-team format, which is
 * what lets one A match and one B match run at the same time.
 */
export function pinnedFieldOfGroup(state: TournamentState, groupId: string | null): string | null {
  if (!groupId) return null;
  const fieldId = state.radball?.groups[groupId]?.fieldId;
  if (!fieldId || !state.fields[fieldId]) return null;
  return fieldId;
}

/** Suggested winner from the current score, or null when level. */
export function impliedWinner(match: Match): 'A' | 'B' | null {
  if (match.scoreA > match.scoreB) return 'A';
  if (match.scoreB > match.scoreA) return 'B';
  return null;
}

export function matchTitle(state: TournamentState, match: Match): string {
  const a = nameOf(state, match.participantAId, 'TBD');
  const b = nameOf(state, match.participantBId, 'TBD');
  return `${a} vs ${b}`;
}

export function bracketRounds(state: TournamentState): { round: number; name: string; matches: Match[] }[] {
  const byRound = new Map<string, { round: number; name: string; matches: Match[] }>();
  for (const match of Object.values(state.matches)) {
    const key = `${match.bracket}:${match.round}`;
    let bucket = byRound.get(key);
    if (!bucket) {
      bucket = { round: match.round, name: match.roundName, matches: [] };
      byRound.set(key, bucket);
    }
    bucket.matches.push(match);
  }
  for (const bucket of byRound.values()) {
    bucket.matches.sort((a, b) => a.position - b.position);
  }
  const winners = [...byRound.values()]
    .filter((bucket) => bucket.matches[0]?.bracket === 'winners')
    .sort((a, b) => a.round - b.round);
  const losers = [...byRound.values()]
    .filter((bucket) => bucket.matches[0]?.bracket === 'losers')
    .sort((a, b) => a.round - b.round);
  const finals = [...byRound.values()]
    .filter((bucket) => {
      const side = bucket.matches[0]?.bracket;
      return side === 'final' || side === 'reset' || side === 'third-place';
    })
    .sort((a, b) => a.round - b.round || a.name.localeCompare(b.name));
  return [...winners, ...losers, ...finals];
}
