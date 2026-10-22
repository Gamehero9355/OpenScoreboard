/**
 * Engine scaffolding shared by every tournament operation: the mutation
 * accumulator that records what changed, the context every call receives, the
 * authoritative timer maths and bracket slot resolution.
 */
import type {
  AppEventType,
  FieldId,
  Match,
  Role,
  SlotSource,
  TimerState,
  TournamentState,
} from '../../shared/types';
import { sentenceMessage, type EventSentence, type EventText } from '../../shared/eventMessages';
import { isOnField } from '../../shared/matchUtils';
import { EngineError } from '../util/errors';

/* ------------------------------------------------------------------ */
/* Mutation accumulator                                               */
/* ------------------------------------------------------------------ */

export interface NewEvent {
  type: AppEventType;
  /** English wording, rendered from the sentence the engine pushed. */
  message: string;
  /** The same sentence as a key plus its values, for the clients' catalogue. */
  text?: EventText;
  fieldId?: FieldId | null;
  matchId?: string | null;
  data?: Record<string, unknown>;
}

export interface Mutation {
  matches: Set<string>;
  participants: Set<string>;
  fields: Set<FieldId>;
  events: NewEvent[];
  tournament: boolean;
  settings: boolean;
  matchOrder: string[] | null;
  participantOrder: string[] | null;
  removedMatchIds: string[];
  removedParticipantIds: string[];
  /** Radball competition slice (phases, tables, shootouts) changed. */
  radball: boolean;
  /** The host's reusable team library changed. */
  teamLibrary: boolean;
  /** The shelf of saved tournament setups changed. */
  savedTournaments: boolean;
  notify: { level: 'info' | 'warn' | 'error'; message: string; text?: EventText } | null;
  /** Score changes must hit the database immediately, UI tweaks need not. */
  urgency: 'immediate' | 'debounced';
}

export function createMutation(): Mutation {
  return {
    matches: new Set(),
    participants: new Set(),
    fields: new Set(),
    events: [],
    tournament: false,
    settings: false,
    matchOrder: null,
    participantOrder: null,
    removedMatchIds: [],
    removedParticipantIds: [],
    radball: false,
    teamLibrary: false,
    savedTournaments: false,
    notify: null,
    urgency: 'debounced',
  };
}

export function touchMatch(mut: Mutation, matchId: string): void {
  mut.matches.add(matchId);
  mut.urgency = 'immediate';
}

export function pushEvent(
  mut: Mutation,
  type: AppEventType,
  sentence: EventSentence,
  extra?: { fieldId?: FieldId | null; matchId?: string | null; data?: Record<string, unknown> },
): void {
  mut.events.push({
    type,
    message: sentenceMessage(sentence),
    ...(typeof sentence === 'string' ? {} : { text: sentence }),
    fieldId: extra?.fieldId ?? null,
    matchId: extra?.matchId ?? null,
    ...(extra?.data ? { data: extra.data } : {}),
  });
}

/**
 * A toast for every connected device.
 *
 * Takes the same sentence shape as `pushEvent`, so "X wins the final (3:2)"
 * reads German on a German phone without the engine keeping two copies of the
 * wording.
 */
export function notify(mut: Mutation, level: 'info' | 'warn' | 'error', sentence: EventSentence): void {
  mut.notify = {
    level,
    message: sentenceMessage(sentence),
    ...(typeof sentence === 'string' ? {} : { text: sentence }),
  };
}

/* ------------------------------------------------------------------ */
/* Context                                                            */
/* ------------------------------------------------------------------ */

export interface Ctx {
  now: number;
  actor: string;
  role: Role;
  /** For operator sessions: the only field they are allowed to touch. */
  fieldScope: FieldId | null;
  newId: (prefix: string) => string;
}

export function assertAdmin(ctx: Ctx): void {
  if (ctx.role !== 'admin') {
    throw new EngineError('FORBIDDEN', 'This action requires the host/admin interface.');
  }
}

/**
 * Operators may only act on their own field. When the payload carries a field
 * id it must match their scope; when it does not, the match must live on their
 * field.
 */
export function assertFieldScope(ctx: Ctx, fieldId: FieldId | undefined | null, match?: Match | null): void {
  if (ctx.role === 'admin') return;
  if (ctx.role !== 'operator') {
    throw new EngineError('FORBIDDEN', 'Read-only sessions cannot change anything.');
  }
  const target = fieldId ?? match?.fieldId ?? null;
  if (ctx.fieldScope === null) {
    throw new EngineError('UNAUTHORIZED', 'This session is not linked to a playing field.');
  }
  if (target === null) {
    throw new EngineError(
      'FORBIDDEN',
      `Assign the match to ${fieldName(ctx.fieldScope)} before controlling it.`,
    );
  }
  if (target !== ctx.fieldScope) {
    throw new EngineError(
      'FORBIDDEN',
      `This control link belongs to ${fieldName(ctx.fieldScope)} and cannot change another field.`,
    );
  }
}

function fieldName(fieldId: FieldId): string {
  return `Field ${fieldId}`;
}

/* ------------------------------------------------------------------ */
/* Timer (server authoritative)                                       */
/* ------------------------------------------------------------------ */

export function createTimerState(
  mode: 'down' | 'up',
  durationSec: number,
  periodCount: 1 | 2 = 2,
): TimerState {
  return {
    mode,
    durationSec,
    periodCount,
    period: 1,
    periodDurationSec: periodCount === 1 ? durationSec : durationSec / 2,
    periodStartElapsedMs: 0,
    elapsedMs: 0,
    running: false,
    anchorAt: null,
    expired: false,
    breakEndsAt: null,
  };
}

export function normaliseTimerState(
  input: Partial<TimerState> | null | undefined,
  mode: 'down' | 'up',
  durationSec: number,
): TimerState {
  const safeDuration = Number.isFinite(input?.durationSec) && (input?.durationSec ?? 0) > 0
    ? (input?.durationSec as number)
    : durationSec;
  const periodCount: 1 | 2 = input?.periodCount === 1 ? 1 : 2;
  const period: 1 | 2 = periodCount === 1 ? 1 : input?.period === 2 ? 2 : 1;
  const defaultPeriodDuration = periodCount === 1 ? safeDuration : safeDuration / 2;
  const periodDurationSec = Number.isFinite(input?.periodDurationSec) && (input?.periodDurationSec ?? 0) > 0
    ? (input?.periodDurationSec as number)
    : defaultPeriodDuration;
  const elapsedMs = Number.isFinite(input?.elapsedMs) ? Math.max(0, input?.elapsedMs as number) : 0;
  const periodStartElapsedMs = period === 2 && Number.isFinite(input?.periodStartElapsedMs)
    ? Math.max(0, input?.periodStartElapsedMs as number)
    : 0;
  return {
    mode: input?.mode === 'up' || input?.mode === 'down' ? input.mode : mode,
    durationSec: safeDuration,
    periodCount,
    period,
    periodDurationSec,
    periodStartElapsedMs,
    elapsedMs,
    running: input?.running === true,
    anchorAt: typeof input?.anchorAt === 'number' ? input.anchorAt : null,
    expired: input?.expired === true,
    // A snapshot written before the break had a clock carries no anchor; an
    // unrecognised one is treated the same way rather than reaching a screen
    // that would count down from nothing.
    breakEndsAt:
      typeof input?.breakEndsAt === 'number' && Number.isFinite(input.breakEndsAt)
        ? input.breakEndsAt
        : null,
  };
}

export function timerElapsed(timer: TimerState, now: number): number {
  if (!timer.running || timer.anchorAt === null) return Math.max(0, timer.elapsedMs);
  return Math.max(0, timer.elapsedMs + (now - timer.anchorAt));
}

export function timerPeriodElapsed(timer: TimerState, now: number): number {
  return Math.max(0, timerElapsed(timer, now) - timer.periodStartElapsedMs);
}

export function timerRemaining(timer: TimerState, now: number): number {
  return Math.max(0, timer.periodDurationSec * 1000 - timerPeriodElapsed(timer, now));
}

/** The number a scoreboard should print right now. */
export function timerDisplay(timer: TimerState, now: number): number {
  return timer.mode === 'down' ? timerRemaining(timer, now) : timerElapsed(timer, now);
}

export function startTimer(timer: TimerState, now: number): void {
  if (timer.running || timer.expired) return;
  timer.running = true;
  timer.anchorAt = now;
}

/**
 * Start the break clock.
 *
 * The break between the two halves gets a countdown of its own, so the hall can
 * see how long the pause has been running. It is an anchor rather than a tick:
 * the server publishes the moment the break ends and every screen counts down
 * from it on its own.
 *
 * The countdown stopping at zero does not start the second half. The teams have
 * to be back on their feet first, and that is the host's call.
 */
export function startBreak(timer: TimerState, now: number, durationSec: number): void {
  timer.breakEndsAt = now + Math.max(0, durationSec) * 1000;
}

/** The break clock is over: nothing is counting down any more. */
export function clearBreak(timer: TimerState): void {
  timer.breakEndsAt = null;
}

export function stopTimer(timer: TimerState, now: number): void {
  if (!timer.running || timer.anchorAt === null) {
    timer.running = false;
    timer.anchorAt = null;
    return;
  }
  timer.elapsedMs = Math.max(0, timer.elapsedMs + (now - timer.anchorAt));
  timer.running = false;
  timer.anchorAt = null;
}

export function resetTimer(timer: TimerState, now: number): void {
  timer.elapsedMs = 0;
  timer.period = 1;
  timer.periodStartElapsedMs = 0;
  timer.running = false;
  timer.anchorAt = null;
  timer.expired = false;
  // A reset match is a fresh match: it has no break behind it yet.
  timer.breakEndsAt = null;
  void now;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Slot resolution                                                    */
/* ------------------------------------------------------------------ */

export type SlotResolution =
  | { status: 'filled'; participantId: string }
  | { status: 'pending' }
  | { status: 'empty' };

export function slotSource(match: Match, slot: 'A' | 'B'): SlotSource {
  return slot === 'A' ? match.slotA : match.slotB;
}

export function slotParticipantId(match: Match, slot: 'A' | 'B'): string | null {
  return slot === 'A' ? match.participantAId : match.participantBId;
}

export function setSlotParticipantId(match: Match, slot: 'A' | 'B', participantId: string | null): void {
  if (slot === 'A') match.participantAId = participantId;
  else match.participantBId = participantId;
}

/**
 * Derive what a bracket slot should contain.
 *
 * - `filled`  a real participant occupies it
 * - `pending` the feeder match has not finished yet
 * - `empty`   the slot can never be filled (bye, cancelled or a feeder that
 *             produced no participant), which lets the other side advance
 *             automatically.
 *
 * A `group-rank` slot never returns `empty` while its group still has fixtures
 * to play: the ranking simply is not known yet, and reporting "can never be
 * filled" would auto-advance the other side and hand out a place nobody played
 * for. It only becomes `empty` once the group itself is gone.
 */
export function resolveSlot(state: TournamentState, match: Match, slot: 'A' | 'B'): SlotResolution {
  const source = slotSource(match, slot);
  const current = slotParticipantId(match, slot);
  if (match.locked && current && state.participants[current]) {
    return { status: 'filled', participantId: current };
  }
  switch (source.kind) {
    case 'bye':
      return current && state.participants[current]
        ? { status: 'filled', participantId: current }
        : { status: 'empty' };
    case 'participant':
      return state.participants[source.participantId]
        ? { status: 'filled', participantId: source.participantId }
        : { status: 'empty' };
    case 'group-rank': {
      // Read the *published* ranking, never a cached occupant. This is the whole
      // point of the reference: correct a group result and every dependent slot
      // re-reads the table on the next resolve.
      const ranking = state.radball?.ten?.rankings[source.groupId];
      const teamId = ranking?.[source.rank - 1];
      if (teamId && state.participants[teamId]) return { status: 'filled', participantId: teamId };
      const group = state.radball?.groups[source.groupId];
      if (!group) return { status: 'empty' };
      // The group exists and owns this position, so the ranking simply is not
      // published yet: the group's fixtures are still being played. Pending, not
      // empty -- "empty" would walk the other side through and hand out a place
      // nobody played for.
      if (group.teamIds.length < source.rank) return { status: 'empty' };
      return { status: 'pending' };
    }
    case 'winner-of':
    case 'loser-of': {
      const feeder = state.matches[source.matchId];
      if (!feeder) return { status: 'empty' };
      if (feeder.state === 'CANCELLED') return { status: 'empty' };
      if (feeder.state === 'FINISHED') {
        const id = source.kind === 'winner-of' ? feeder.winnerId : feeder.loserId;
        return id && state.participants[id] ? { status: 'filled', participantId: id } : { status: 'empty' };
      }
      // The feeder is still playing: the slot is pending, never cached. This is
      // what makes resetting a finished match correctly un-fill the next round.
      return { status: 'pending' };
    }
    default:
      return { status: 'empty' };
  }
}

/**
 * The invariant is `match.fieldId` <=> `state.fields[id].matchId === match.id`.
 * `match.fieldId` is kept after a match finishes so the UI can still show where
 * it was played -- use this helper whenever the code needs to know whether the
 * match is *currently* sitting on a field.
 *
 * Re-exported from `shared/matchUtils.ts` rather than defined twice: the host's
 * queue panel and the engine must answer "is it on a field right now" identically,
 * or a running match ends up in two queues.
 */
export { isOnField };

/** Matches that only exist to pass someone through (byes). */
export function isByeMatch(match: Match): boolean {
  const a = match.slotA.kind === 'bye';
  const b = match.slotB.kind === 'bye';
  if (!a && !b) return false;
  // A bye only counts for the scoreboard if the match never really happened.
  return match.history.length === 0;
}

export function participantName(state: TournamentState, id: string | null): string {
  if (!id) return 'TBD';
  const p = state.participants[id];
  return p ? p.name : 'Unknown';
}

export function matchLabel(match: Match): string {
  return `${match.roundName} · match ${match.position + 1}`;
}

/**
 * Human sentence for what a slot is still waiting on. A `group-rank` slot waits
 * for its group's table, which the host reads far better as "Group A 1st place"
 * than as "a feeder match".
 */
export function slotSourceLabel(state: TournamentState, match: Match, slot: 'A' | 'B'): string {
  const source = slotSource(match, slot);
  if (source.kind === 'group-rank') {
    const group = state.radball?.groups[source.groupId];
    return `${group?.name ?? 'Group'} ${ordinal(source.rank)} place`;
  }
  if (source.kind === 'winner-of' || source.kind === 'loser-of') {
    const feeder = state.matches[source.matchId];
    const what = source.kind === 'winner-of' ? 'winner' : 'loser';
    return feeder ? `${what} of ${feeder.roundName}` : 'a feeder match';
  }
  if (source.kind === 'participant') return 'a participant';
  return 'nobody';
}

export function ordinal(value: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const mod = value % 100;
  return `${value}${suffixes[(mod - 20) % 10] ?? suffixes[mod] ?? 'th'}`;
}
