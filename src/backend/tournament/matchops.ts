/**
 * Field and match lifecycle: assigning matches to the two playing fields,
 * starting, pausing, finishing, cancelling and the automatic next-match flow.
 */
import type { FieldId, Match, TournamentState } from '../../shared/types';
import { compareFieldIds } from '../../shared/types';
import { homeFieldOf } from '../../shared/matchUtils';
import { EngineError } from '../util/errors';
import { recalculateRadball, schedulableOn, teamLiveMatches } from './radball';
import { assertFinalPhaseDependency, requiresShootout } from './radball10';
import { completeMatch, finaliseTournament, releaseField, resolveBracket } from './resolve';
import { resetScores } from './scoring';
import {
  type Ctx,
  type Mutation,
  isOnField,
  notify,
  participantName,
  pushEvent,
  resetTimer,
  startTimer,
  stopTimer,
  touchMatch,
} from './state';

/**
 * All playing-field ids in canonical numeric order. The tournament can be
 * configured with 1..MAX_FIELDS fields, so nothing here may assume two.
 */
export function fieldIds(state: TournamentState): FieldId[] {
  return Object.keys(state.fields).sort(compareFieldIds);
}

/** @deprecated Use fieldIds(state) — kept for existing imports. */
export const FIELD_IDS: FieldId[] = ['1', '2'];

/* ------------------------------------------------------------------ */
/* Selectors                                                          */
/* ------------------------------------------------------------------ */

function queueRank(state: TournamentState, matchId: string): number {
  const index = state.matchOrder.indexOf(matchId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Ready matches that are not on a field yet, in queue order. */
function readyMatches(state: TournamentState): Match[] {
  return Object.values(state.matches)
    .filter((m) => m.state === 'READY' && !m.fieldId)
    .sort((a, b) => queueRank(state, a.id) - queueRank(state, b.id) || a.round - b.round || a.position - b.position);
}

/**
 * The next match a field may be given.
 *
 * The field's own matches come first (both players were registered on it), then
 * matches that belong to no single field -- a pairing whose winner is not known
 * yet or that mixes both fields -- because either field may host those. A match
 * owned by another field is never handed over, which is what keeps Field 1's
 * queue from being played on Field 2. Without a field (the generic "next match"
 * call) this is plain queue order.
 */
export function getNextAvailableMatch(state: TournamentState, fieldId?: FieldId): Match | null {
  const ready = readyMatches(state);
  if (ready.length === 0) return null;
  if (!fieldId) return ready[0] ?? null;
  const own = ready.find((m) => homeFieldOf(state, m) === fieldId);
  if (own) return own;
  return ready.find((m) => homeFieldOf(state, m) === null) ?? null;
}

export function getUpcomingMatches(state: TournamentState, limit = 50): Match[] {
  const open = Object.values(state.matches).filter(
    (m) => m.state !== 'FINISHED' && m.state !== 'CANCELLED',
  );
  open.sort((a, b) => queueRank(state, a.id) - queueRank(state, b.id) || a.round - b.round || a.position - b.position);
  return open.slice(0, limit);
}

export function getBracketMatches(state: TournamentState): Match[] {
  return Object.values(state.matches).sort(
    (a, b) => a.round - b.round || a.position - b.position || a.id.localeCompare(b.id),
  );
}

export function freeFields(state: TournamentState): FieldId[] {
  return fieldIds(state).filter((id) => !state.fields[id]?.matchId);
}

/* ------------------------------------------------------------------ */
/* Field assignment                                                   */
/* ------------------------------------------------------------------ */

export function assignMatchToField(
  state: TournamentState,
  matchId: string,
  fieldId: FieldId,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  const field = state.fields[fieldId];
  if (!field) throw new EngineError('FIELD_NOT_FOUND', `Field ${fieldId} does not exist.`);
  if (match.state === 'FINISHED') throw new EngineError('INVALID_STATE', 'That match is already finished.');
  if (match.state === 'CANCELLED') throw new EngineError('INVALID_STATE', 'That match was cancelled.');
  // Checked before the generic "no participants" refusal, because that one would
  // be true and useless: a final waiting on its semifinals has no participants
  // *for a reason*, and the operator needs to be told which reason.
  assertFinalPhaseDependency(state, match);
  if (!match.participantAId || !match.participantBId) {
    throw new EngineError('INVALID_STATE', 'Both participants must be known before the match can be played.');
  }
  if (match.fieldId === fieldId) return;

  // Server-side hard validation (§17): a team may never sit on two fields at
  // once. The UI hint is secondary; this rule is enforced on every command.
  for (const teamId of [match.participantAId, match.participantBId]) {
    if (!teamId) continue;
    const clash = teamLiveMatches(state, teamId).find(
      (live) => live.id !== matchId && live.fieldId !== null && live.fieldId !== fieldId,
    );
    if (clash && clash.fieldId) {
      throw new EngineError(
        'TEAM_BUSY',
        `${participantName(state, teamId)} is already on ${state.fields[clash.fieldId]?.name ?? 'another field'} (${clash.roundName}). A team cannot play on two fields at once.`,
        { fieldId, matchId: clash.id },
      );
    }
  }

  const occupant = field.matchId ? state.matches[field.matchId] : null;
  if (occupant && occupant.id !== matchId) {
    if (occupant.state === 'RUNNING' || occupant.state === 'PAUSED' || occupant.state === 'HALFTIME') {
      throw new EngineError(
        'FIELD_BUSY',
        `${field.name} is running ${occupant.roundName}. Finish or unassign it first.`,
        { fieldId, matchId: occupant.id },
      );
    }
    occupant.fieldId = null;
    if (occupant.state === 'ASSIGNED') occupant.state = 'READY';
    touchMatch(mut, occupant.id);
    pushEvent(
      mut,
      'MATCH_UNASSIGNED',
      { key: 'event.matchUnassigned', params: { round: occupant.roundName, field: field.name } },
      { fieldId, matchId: occupant.id },
    );
  }

  if (match.fieldId && match.fieldId !== fieldId) {
    const previousField = state.fields[match.fieldId];
    if (previousField) {
      previousField.matchId = null;
      mut.fields.add(previousField.id);
    }
  }

  match.fieldId = fieldId;
  if (match.state !== 'RUNNING' && match.state !== 'PAUSED' && match.state !== 'HALFTIME') match.state = 'ASSIGNED';
  field.matchId = match.id;
  mut.fields.add(fieldId);
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'MATCH_ASSIGNED',
    { key: 'event.matchAssigned', params: { round: match.roundName, field: field.name } },
    { fieldId, matchId: match.id },
  );
  mut.urgency = 'immediate';
  void ctx;
}

export function unassignField(
  state: TournamentState,
  fieldId: FieldId,
  ctx: Ctx,
  mut: Mutation,
): void {
  const field = state.fields[fieldId];
  if (!field) throw new EngineError('FIELD_NOT_FOUND', `Field ${fieldId} does not exist.`);
  const match = field.matchId ? state.matches[field.matchId] : null;
  if (match) {
    if (match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME') {
      throw new EngineError('FIELD_BUSY', `Stop ${match.roundName} before clearing ${field.name}.`);
    }
    match.fieldId = null;
    if (match.state === 'ASSIGNED') match.state = 'READY';
    touchMatch(mut, match.id);
    pushEvent(
      mut,
      'MATCH_UNASSIGNED',
      { key: 'event.matchUnassigned', params: { round: match.roundName, field: field.name } },
      { fieldId, matchId: match.id },
    );
  }
  field.matchId = null;
  mut.fields.add(fieldId);
  mut.urgency = 'immediate';
  void ctx;
}

export function swapFields(state: TournamentState, mut: Mutation, fieldA: FieldId = '1', fieldB: FieldId = '2'): void {
  const a = state.fields[fieldA];
  const b = state.fields[fieldB];
  if (!a || !b) throw new EngineError('FIELD_NOT_FOUND', 'One of the selected fields does not exist.');
  const aMatch = a.matchId ? state.matches[a.matchId] : null;
  const bMatch = b.matchId ? state.matches[b.matchId] : null;
  if (aMatch && (aMatch.state === 'RUNNING' || aMatch.state === 'PAUSED' || aMatch.state === 'HALFTIME')) {
    throw new EngineError('FIELD_BUSY', 'Stop the running match before swapping fields.');
  }
  if (bMatch && (bMatch.state === 'RUNNING' || bMatch.state === 'PAUSED' || bMatch.state === 'HALFTIME')) {
    throw new EngineError('FIELD_BUSY', 'Stop the running match before swapping fields.');
  }
  a.matchId = bMatch?.id ?? null;
  b.matchId = aMatch?.id ?? null;
  if (aMatch) {
    aMatch.fieldId = fieldB;
    touchMatch(mut, aMatch.id);
  }
  if (bMatch) {
    bMatch.fieldId = fieldA;
    touchMatch(mut, bMatch.id);
  }
  mut.fields.add(fieldA);
  mut.fields.add(fieldB);
  pushEvent(mut, 'FIELD_UPDATED', {
    key: 'event.fieldsSwapped',
    params: { one: a.name, two: b.name },
  });
  mut.urgency = 'immediate';
}

export function autoAssign(state: TournamentState, ctx: Ctx, mut: Mutation): FieldId[] {
  const assigned: FieldId[] = [];
  for (const fieldId of fieldIds(state)) {
    if (state.fields[fieldId]?.matchId) continue;
    const next = nextSchedulableMatch(state, fieldId, ctx.now);
    // Keep going rather than stopping: the first field having nothing of its own
    // left must not keep a later field from picking up a match it does own.
    if (!next) continue;
    assignMatchToField(state, next.id, fieldId, ctx, mut);
    assigned.push(fieldId);
  }
  return assigned;
}

/**
 * The next match a field may take, availability-aware. Generic tournaments get
 * the plain queue order; Radball additionally skips matches whose team is
 * still busy on the other field or inside its minimum rest period (§16/§18) --
 * but only when a later, playable match exists. Valid scheduling always beats
 * filling the field.
 */
export function nextSchedulableMatch(state: TournamentState, fieldId: FieldId, now: number): Match | null {
  const next = getNextAvailableMatch(state, fieldId);
  if (!next) return null;
  if (state.tournament?.format !== 'radball') return next;
  if (schedulableOn(state, next, fieldId, now)) return next;
  const rank = new Map(state.matchOrder.map((id, index) => [id, index]));
  const ready = Object.values(state.matches)
    .filter((m) => m.state === 'READY' && !m.fieldId)
    .filter((m) => {
      const home = homeFieldOf(state, m);
      return home === fieldId || home === null;
    })
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.round - b.round ||
        a.position - b.position,
    );
  return ready.find((m) => m.id !== next.id && schedulableOn(state, m, fieldId, now)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Field ownership (prevents two operators fighting over one field)    */
/* ------------------------------------------------------------------ */

export function claimField(
  state: TournamentState,
  fieldId: FieldId,
  force: boolean,
  ctx: Ctx,
  mut: Mutation,
): void {
  const field = state.fields[fieldId];
  if (!field) throw new EngineError('FIELD_NOT_FOUND', `Field ${fieldId} does not exist.`);
  const claim = ctx.actor;
  if (field.controlledBy && field.controlledBy !== claim && !force) {
    throw new EngineError(
      'FIELD_LOCKED',
      `${field.name} is currently controlled by ${field.controlledBy}. Ask the host to release it.`,
      { fieldId, controlledBy: field.controlledBy },
    );
  }
  if (field.controlledBy === claim) return;
  field.controlledBy = claim;
  field.controlledSince = ctx.now;
  mut.fields.add(fieldId);
  pushEvent(
    mut,
    'FIELD_CLAIMED',
    { key: 'event.fieldClaimed', params: { field: field.name, claim } },
    { fieldId },
  );
  mut.urgency = 'immediate';
}

export function releaseFieldClaim(
  state: TournamentState,
  fieldId: FieldId,
  force: boolean,
  ctx: Ctx,
  mut: Mutation,
): void {
  const field = state.fields[fieldId];
  if (!field) throw new EngineError('FIELD_NOT_FOUND', `Field ${fieldId} does not exist.`);
  if (field.controlledBy && field.controlledBy !== ctx.actor && !force) {
    throw new EngineError('FIELD_LOCKED', `${field.name} is controlled by ${field.controlledBy}.`, { fieldId });
  }
  field.controlledBy = null;
  field.controlledSince = null;
  mut.fields.add(fieldId);
  pushEvent(mut, 'FIELD_RELEASED', { key: 'event.fieldReleased', params: { field: field.name } }, { fieldId });
  mut.urgency = 'immediate';
}

/* ------------------------------------------------------------------ */
/* Match lifecycle                                                    */
/* ------------------------------------------------------------------ */

export function startMatch(
  state: TournamentState,
  matchId: string,
  fieldId: FieldId | undefined,
  ctx: Ctx,
  mut: Mutation,
): void {
  // Before `requirePlayable`, deliberately: a final waiting on its semifinals has
  // no participants *for a reason*, and "both participants must be known" would
  // send the operator looking for a score problem instead of at the match that is
  // still running.
  const target = state.matches[matchId];
  if (!target) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  assertFinalPhaseDependency(state, target);
  const match = requirePlayable(state, matchId);
  // Idempotent on purpose: a double tap on START during a live event must not
  // produce an error banner.
  if (match.state === 'RUNNING') return;
  if (match.state === 'HALFTIME') throw new EngineError('INVALID_STATE', 'Start the second half before continuing.');
  if (match.timer.expired) throw new EngineError('INVALID_STATE', 'This match is already out of time. End or reset it.');
  if (!match.fieldId) {
    if (!fieldId) {
      throw new EngineError('INVALID_STATE', 'Assign the match to a playing field first.');
    }
    // Field placement validates the dependency chain server-side, so a final can
    // never be parked on a field while a semifinal is still running.
    assertFinalPhaseDependency(state, match);
    assignMatchToField(state, matchId, fieldId, ctx, mut);
  }
  assertFinalPhaseDependency(state, match);
  match.state = 'RUNNING';
  match.startedAt = match.startedAt ?? ctx.now;
  startTimer(match.timer, ctx.now);
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'MATCH_STARTED',
    { key: 'event.matchStarted', params: { round: match.roundName, field: fieldLabel(state, match.fieldId) } },
    { matchId: match.id, fieldId: match.fieldId },
  );
}

export function pauseMatch(
  state: TournamentState,
  matchId: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = requirePlayable(state, matchId);
  if (match.state === 'PAUSED') return;
  if (match.state !== 'RUNNING') throw new EngineError('INVALID_STATE', 'Only a running match can be paused.');
  match.state = 'PAUSED';
  stopTimer(match.timer, ctx.now);
  touchMatch(mut, match.id);
  pushEvent(mut, 'MATCH_PAUSED', { key: 'event.matchPaused', params: { round: match.roundName } }, {
    matchId: match.id,
    fieldId: match.fieldId,
  });
}

export function resumeMatch(
  state: TournamentState,
  matchId: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = requirePlayable(state, matchId);
  if (match.state === 'RUNNING') return;
  if (match.state === 'HALFTIME') throw new EngineError('INVALID_STATE', 'Start the second half from halftime.');
  if (match.timer.expired) throw new EngineError('INVALID_STATE', 'This match is already out of time. End or reset it.');
  if (match.state !== 'PAUSED') throw new EngineError('INVALID_STATE', 'This match is not paused.');
  match.state = 'RUNNING';
  startTimer(match.timer, ctx.now);
  touchMatch(mut, match.id);
  pushEvent(mut, 'MATCH_RESUMED', { key: 'event.matchResumed', params: { round: match.roundName } }, {
    matchId: match.id,
    fieldId: match.fieldId,
  });
}

export function startSecondHalf(
  state: TournamentState,
  matchId: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = requirePlayable(state, matchId);
  if (match.state !== 'HALFTIME') throw new EngineError('INVALID_STATE', 'This match is not at halftime.');
  if (match.timer.periodCount !== 2) throw new EngineError('INVALID_STATE', 'This match has no second half.');
  match.timer.period = 2;
  match.timer.periodStartElapsedMs = match.timer.elapsedMs;
  match.timer.expired = false;
  match.state = 'RUNNING';
  startTimer(match.timer, ctx.now);
  touchMatch(mut, match.id);
  pushEvent(mut, 'MATCH_SECOND_HALF_STARTED', { key: 'event.matchSecondHalf', params: { round: match.roundName } }, {
    matchId: match.id,
    fieldId: match.fieldId,
  });
}

export function cancelMatch(
  state: TournamentState,
  matchId: string,
  ctx: Ctx,
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'CANCELLED') throw new EngineError('INVALID_STATE', 'That match is already cancelled.');
  stopTimer(match.timer, ctx.now);
  match.state = 'CANCELLED';
  match.winnerId = null;
  match.loserId = null;
  if (isOnField(state, match)) releaseField(state, match.fieldId as FieldId, mut);
  match.fieldId = null;
  touchMatch(mut, match.id);
  pushEvent(mut, 'MATCH_CANCELLED', { key: 'event.matchCancelled', params: { round: match.roundName } }, {
    matchId: match.id,
  });
  resolveBracket(state, ctx, mut);
  finaliseTournament(state, ctx, mut);
  recalculateRadball(state, ctx, mut);
}

export function resetMatch(state: TournamentState, matchId: string, ctx: Ctx, mut: Mutation): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'CANCELLED') {
    match.state = match.fieldId ? 'ASSIGNED' : 'READY';
    match.locked = false;
    touchMatch(mut, match.id);
    resolveBracket(state, ctx, mut);
    pushEvent(mut, 'MATCH_RESET', { key: 'event.matchReactivated', params: { round: match.roundName } }, {
      matchId: match.id,
    });
    return;
  }
  resetScores(state, match, ctx, mut);
  resolveBracket(state, ctx, mut);
  // A reset result (a rollback of a Radball result) must pull back the
  // dependent standings, qualification and decisions with it (§30).
  recalculateRadball(state, ctx, mut);
}

export function setMatchReady(
  state: TournamentState,
  matchId: string,
  ready: boolean,
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (ready && !match.participantAId && !match.participantBId) {
    throw new EngineError('INVALID_STATE', 'This match has no participants yet.');
  }
  match.locked = true;
  match.state = ready
    ? match.participantAId && match.participantBId
      ? match.fieldId
        ? 'ASSIGNED'
        : 'READY'
      : 'WAITING'
    : 'WAITING';
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'BRACKET_UPDATED',
    ready
      ? { key: 'event.matchReady', params: { round: match.roundName } }
      : { key: 'event.matchNotReady', params: { round: match.roundName } },
    { matchId: match.id },
  );
}

export interface FinishInput {
  matchId: string;
  winner: 'A' | 'B' | null;
  force: boolean;
}

export function finishMatch(
  state: TournamentState,
  input: FinishInput,
  ctx: Ctx,
  mut: Mutation,
): Match {
  const match = state.matches[input.matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (match.state === 'FINISHED') {
    throw new EngineError(
      'DUPLICATE_RESULT',
      `${match.roundName} was already finished. Use reset or correct score to change the result.`,
    );
  }
  if (match.state === 'CANCELLED') {
    throw new EngineError('INVALID_STATE', 'This match was cancelled. Reactivate it before ending it.');
  }
  if (!match.participantAId || !match.participantBId) {
    throw new EngineError('INVALID_STATE', 'Both participants must be known before the match can be ended.');
  }

  const meta = match.radball;
  const isDecision = meta?.kind === 'decision';

  let winnerId: string | null = null;
  if (input.winner === 'A') winnerId = match.participantAId;
  else if (input.winner === 'B') winnerId = match.participantBId;
  else if (match.scoreA > match.scoreB) winnerId = match.participantAId;
  else if (match.scoreB > match.scoreA) winnerId = match.participantBId;
  else if (isDecision || requiresShootout(state, match)) {
    // §13 and §27: a level decision or final-phase match is NOT finished. It has
    // to be settled at the 4-metre line first. Never recorded as a draw and
    // never picked silently -- an undefended 5th place would break the format.
    // *Which* matches demand this is the ruleset's answer, not the UI's.
    if (!meta?.shootout || !meta.shootout.decided || !meta.shootout.winnerId) {
      throw new EngineError(
        'SHOOTOUT_REQUIRED',
        `${match.roundName} is level at ${match.scoreA}:${match.scoreB}. Record the 4-meter shootout to decide it.`,
        { matchId: match.id },
      );
    }
    winnerId = meta.shootout.winnerId;
  } else if (meta) {
    // §6: a level Radball group match is a legal draw worth one point to each
    // team -- never a "pick a winner" situation.
    winnerId = null;
  } else if (state.settings.allowDraws || (input.force && ctx.role === 'admin')) winnerId = null;
  else {
    throw new EngineError(
      'NO_WINNER',
      `The score is level at ${match.scoreA}:${match.scoreB}. Choose the winner explicitly.`,
      { matchId: match.id },
    );
  }

  const loserId = winnerId === match.participantAId ? match.participantBId : winnerId === match.participantBId ? match.participantAId : null;
  const fieldId = match.fieldId;
  completeMatch(match, winnerId, loserId, ctx, mut);
  if (fieldId) {
    releaseField(state, fieldId, mut);
    mut.fields.add(fieldId);
  }

  if (isDecision || meta?.matchType) {
    const label = isDecision ? 'Decision match' : match.roundName;
    pushEvent(
      mut,
      'MATCH_FINISHED',
      {
        key: meta?.shootout ? 'event.matchDecidedShootout' : 'event.matchDecided',
        params: { round: label, winner: participantName(state, winnerId), a: match.scoreA, b: match.scoreB },
      },
      { matchId: match.id, fieldId, data: { winnerId, scoreA: match.scoreA, scoreB: match.scoreB, shootout: Boolean(meta?.shootout) } },
    );
    notify(mut, 'info', {
      key: meta?.shootout ? 'notify.matchDecidedShootout' : 'notify.matchDecided',
      params: {
        winner: participantName(state, winnerId),
        // Two shapes of one name: the English line lower-cases it and German
        // capitalises it, so both travel and the client picks by language.
        label: label.toLowerCase(),
        labelTitle: label,
        a: match.scoreA,
        b: match.scoreB,
      },
    });
  } else if (winnerId) {
    pushEvent(
      mut,
      'MATCH_FINISHED',
      {
        key: 'event.matchFinished',
        params: {
          round: match.roundName,
          winner: participantName(state, winnerId),
          a: match.scoreA,
          b: match.scoreB,
        },
      },
      { matchId: match.id, fieldId, data: { winnerId, scoreA: match.scoreA, scoreB: match.scoreB } },
    );
    notify(mut, 'info', {
      key: 'notify.matchWon',
      params: {
        winner: participantName(state, winnerId),
        round: match.roundName,
        a: match.scoreA,
        b: match.scoreB,
      },
    });
  } else {
    pushEvent(mut, 'MATCH_FINISHED', { key: 'event.matchDraw', params: { round: match.roundName } }, {
      matchId: match.id,
      fieldId,
    });
    notify(mut, 'warn', { key: 'notify.matchDraw', params: { round: match.roundName } });
  }

  resolveBracket(state, ctx, mut);
  finaliseTournament(state, ctx, mut);
  // §8/§9: standings, ties, qualification and the champion flow from every
  // finalized result. A settled decision match also unlocks the next step.
  recalculateRadball(state, ctx, mut);

  if (state.settings.autoAssignNext && fieldId && !state.fields[fieldId]?.matchId) {
    // Only the finished field's own matches (or a match either field may host)
    // follow it: the other field's queue stays where it is.
    const next = nextSchedulableMatch(state, fieldId, ctx.now);
    if (next) assignMatchToField(state, next.id, fieldId, ctx, mut);
  }
  mut.urgency = 'immediate';
  return match;
}

export function setTimer(
  state: TournamentState,
  matchId: string,
  patch: { mode?: 'down' | 'up'; durationSec?: number },
  mut: Mutation,
): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  const running = match.timer.running;
  if (patch.mode !== undefined) match.timer.mode = patch.mode;
  if (patch.durationSec !== undefined) {
    match.timer.durationSec = patch.durationSec;
    match.timer.periodDurationSec = patch.durationSec / match.timer.periodCount;
    match.timer.expired = false;
    if (match.state === 'HALFTIME') {
      match.timer.elapsedMs = match.timer.periodDurationSec * 1000;
      match.timer.periodStartElapsedMs = 0;
    } else if (!running && match.state !== 'PAUSED') {
      match.timer.elapsedMs = 0;
      match.timer.period = 1;
      match.timer.periodStartElapsedMs = 0;
    }
  }
  if (running) match.timer.anchorAt = Date.now();
  touchMatch(mut, match.id);
  pushEvent(mut, 'TIMER_UPDATED', { key: 'event.timerUpdated', params: { round: match.roundName } }, {
    matchId: match.id,
  });
}

export function reorderQueue(state: TournamentState, matchIds: string[], mut: Mutation): void {
  const known = matchIds.filter((id) => Boolean(state.matches[id]));
  const missing = state.matchOrder.filter((id) => !known.includes(id));
  state.matchOrder = [...known, ...missing];
  mut.matchOrder = [...state.matchOrder];
  pushEvent(mut, 'MATCH_REORDERED', { key: 'event.queueReordered' });
  mut.urgency = 'immediate';
}

export function resetTimerForMatch(state: TournamentState, matchId: string, mut: Mutation): void {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  resetTimer(match.timer, Date.now());
  touchMatch(mut, match.id);
  pushEvent(mut, 'TIMER_UPDATED', { key: 'event.timerReset', params: { round: match.roundName } }, {
    matchId: match.id,
  });
}

function requirePlayable(state: TournamentState, matchId: string): Match {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  if (!match.participantAId || !match.participantBId) {
    throw new EngineError('INVALID_STATE', 'Both participants must be known before the match can run.');
  }
  return match;
}

function fieldLabel(state: TournamentState, fieldId: FieldId | null): string {
  if (!fieldId) return 'the field';
  return state.fields[fieldId]?.name ?? `field ${fieldId}`;
}
