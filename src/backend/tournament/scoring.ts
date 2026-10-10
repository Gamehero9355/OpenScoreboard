/**
 * Scoring, undo and redo.
 *
 * Every score change is recorded as an action that knows the score before and
 * after it, so undo and redo are exact inverses for every kind of change
 * (including manual corrections and resets) instead of only for plain +n.
 */
import type { FieldId, Match, ScoreAction, ScoreActionKind, SlotSource, TournamentState } from '../../shared/types';
import { EngineError } from '../util/errors';
import { MAX_MATCH_HISTORY } from './defaults';
import { recalculateRadball } from './radball';
import {
  type Ctx,
  type Mutation,
  isOnField,
  notify,
  participantName,
  pushEvent,
  resetTimer,
  touchMatch,
} from './state';

function otherSide(side: 'A' | 'B'): 'A' | 'B' {
  return side === 'A' ? 'B' : 'A';
}

function scores(match: Match): { a: number; b: number } {
  return { a: match.scoreA, b: match.scoreB };
}

function applyScores(match: Match, a: number, b: number): void {
  match.scoreA = a;
  match.scoreB = b;
}

function record(
  match: Match,
  kind: ScoreActionKind,
  prev: { a: number; b: number },
  next: { a: number; b: number },
  ctx: Ctx,
  fieldId: FieldId | null,
  participantId: string | null,
  delta: number,
  note: string | null,
): ScoreAction {
  const action: ScoreAction = {
    id: ctx.newId('act'),
    ts: ctx.now,
    participantId,
    delta,
    kind,
    actor: ctx.actor,
    fieldId,
    prevA: prev.a,
    prevB: prev.b,
    nextA: next.a,
    nextB: next.b,
    note,
  };
  match.history.push(action);
  if (match.history.length > MAX_MATCH_HISTORY) match.history.splice(0, match.history.length - MAX_MATCH_HISTORY);
  match.redoStack = [];
  return action;
}

export function requireMatch(state: TournamentState, matchId: string): Match {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  return match;
}

function requireEditable(match: Match, _ctx: Ctx): void {
  if (match.state === 'FINISHED') {
    throw new EngineError('INVALID_STATE', 'This match is already finished. Reset or correct it first.');
  }
  if (match.state === 'CANCELLED') {
    throw new EngineError('INVALID_STATE', 'This match was cancelled. Reactivate it first.');
  }
  if (!match.participantAId || !match.participantBId) {
    throw new EngineError('INVALID_STATE', 'Both participants must be known before scoring.');
  }
}

export function updateScore(
  state: TournamentState,
  match: Match,
  side: 'A' | 'B',
  delta: number,
  ctx: Ctx,
  mut: Mutation,
  note: string | null = null,
): ScoreAction {
  requireEditable(match, ctx);
  const prev = scores(match);
  const current = side === 'A' ? match.scoreA : match.scoreB;
  const target = current + delta;
  if (target < 0) {
    throw new EngineError('INVALID_SCORE', 'A score cannot go below zero. Use UNDO to remove a point.');
  }
  const max = state.settings.maxScore;
  if (max !== null && target > max) {
    throw new EngineError('INVALID_SCORE', `The configured maximum score is ${max}.`);
  }
  if (side === 'A') match.scoreA = target;
  else match.scoreB = target;
  const next = scores(match);
  const participantId = side === 'A' ? match.participantAId : match.participantBId;
  const action = record(match, 'score', prev, next, ctx, match.fieldId, participantId, delta, note);
  touchMatch(mut, match.id);
  // Free text on purpose: a name, a signed number and a score read the same in
  // both languages, so there is no sentence here to translate.
  pushEvent(mut, 'SCORE_UPDATED', `${participantName(state, participantId)} ${delta > 0 ? '+' : ''}${delta} (${next.a}:${next.b})`, {
    matchId: match.id,
    fieldId: match.fieldId,
    data: { scoreA: next.a, scoreB: next.b },
  });
  const reachedTarget =
    max !== null && (match.scoreA >= max || match.scoreB >= max) && state.settings.winCondition !== 'manual';
  if (reachedTarget) {
    notify(mut, 'info', {
      key: 'notify.targetReached',
      params: { max: max as number, round: match.roundName },
    });
  }
  return action;
}

export function undoScore(state: TournamentState, match: Match, _ctx: Ctx, mut: Mutation): ScoreAction {
  const action = match.history.pop();
  if (!action) {
    throw new EngineError('INVALID_STATE', 'There is nothing to undo for this match.');
  }
  applyScores(match, action.prevA, action.prevB);
  match.redoStack.push(action);
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'SCORE_UNDONE',
    {
      key: 'event.scoreUndone',
      params: { action: action.kind, actor: action.actor, a: action.prevA, b: action.prevB },
    },
    { matchId: match.id, fieldId: match.fieldId },
  );
  void state;
  return action;
}

export function redoScore(state: TournamentState, match: Match, _ctx: Ctx, mut: Mutation): ScoreAction {
  const action = match.redoStack.pop();
  if (!action) {
    throw new EngineError('INVALID_STATE', 'There is nothing to redo for this match.');
  }
  applyScores(match, action.nextA, action.nextB);
  match.history.push(action);
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'SCORE_REDONE',
    { key: 'event.scoreRedone', params: { action: action.kind, a: action.nextA, b: action.nextB } },
    { matchId: match.id, fieldId: match.fieldId },
  );
  void state;
  return action;
}

export function correctScore(
  state: TournamentState,
  match: Match,
  scoreA: number,
  scoreB: number,
  ctx: Ctx,
  mut: Mutation,
  note: string | null,
): ScoreAction {
  const prev = scores(match);
  if (prev.a === scoreA && prev.b === scoreB) {
    throw new EngineError('INVALID_SCORE', 'The correction equals the current score.');
  }
  const allowed = match.state === 'FINISHED' || match.state === 'CANCELLED';
  if (allowed) {
    // Correcting a finished match must not silently break the bracket.
    assertNoDownstreamProgress(state, match);
    match.state = 'READY';
    match.winnerId = null;
    match.loserId = null;
    match.finishedAt = null;
    if (state.tournament) state.tournament.championId = null;
  }
  applyScores(match, scoreA, scoreB);
  const action = record(
    match,
    'correct',
    prev,
    { a: scoreA, b: scoreB },
    ctx,
    match.fieldId,
    null,
    0,
    note,
  );
  touchMatch(mut, match.id);
  pushEvent(
    mut,
    'SCORE_CORRECTED',
    note
      ? { key: 'event.scoreCorrectedNote', params: { a: scoreA, b: scoreB, note } }
      : { key: 'event.scoreCorrected', params: { a: scoreA, b: scoreB } },
    { matchId: match.id, fieldId: match.fieldId },
  );
  // §30: a corrected result rolls back its consequences -- standings,
  // qualification, dependent decision matches -- and recalculates them.
  recalculateRadball(state, ctx, mut);
  return action;
}

/**
 * Guard against editing a match whose consequences already happened.
 *
 * Two kinds of dependency block a rollback. The obvious one is a match that reads
 * this one's winner or loser. The one the 10-team format adds is a match that
 * reads this match's *group position*: changing a group fixture renames the
 * participants of every final-phase match fed by that group, so a placement match
 * that has already been played would end up holding a result between two teams
 * that never met. Both are refused, with the blocking matches named, so the host
 * resets the dependent matches first -- the engine will then re-derive their
 * teams on the next resolve instead of keeping stale assignments.
 */
export function assertNoDownstreamProgress(state: TournamentState, match: Match): void {
  const groupId = match.radball?.groupId ?? null;
  const blockers: Match[] = [];
  for (const candidate of Object.values(state.matches)) {
    if (candidate.id === match.id) continue;
    const feedsFrom = feedsFromMatch(candidate.slotA, match.id);
    const feedsTo = feedsFromMatch(candidate.slotB, match.id);
    const feedsFromGroup =
      groupId !== null &&
      (readsGroupRank(candidate.slotA, groupId) || readsGroupRank(candidate.slotB, groupId));
    if (!feedsFrom && !feedsTo && !feedsFromGroup) continue;
    if (candidate.state === 'RUNNING' || candidate.state === 'PAUSED' || candidate.state === 'HALFTIME' || candidate.state === 'FINISHED') {
      blockers.push(candidate);
    }
  }
  if (blockers.length > 0) {
    throw new EngineError(
      'DOWNSTREAM_STARTED',
      `Cannot roll back: ${blockers.map((m) => m.roundName).join(', ')} already progressed. Reset those matches first.`,
      { blockers: blockers.map((m) => m.id) },
    );
  }
}

function feedsFromMatch(source: SlotSource, matchId: string): boolean {
  return (source.kind === 'winner-of' || source.kind === 'loser-of') && source.matchId === matchId;
}

function readsGroupRank(source: SlotSource, groupId: string): boolean {
  return source.kind === 'group-rank' && source.groupId === groupId;
}

export function resetScores(
  state: TournamentState,
  match: Match,
  ctx: Ctx,
  mut: Mutation,
): void {
  assertNoDownstreamProgress(state, match);
  const prev = scores(match);
  applyScores(match, 0, 0);
  record(match, 'reset', prev, { a: 0, b: 0 }, ctx, match.fieldId, null, 0, null);
  // Only keep the field link when the field still points back at this match.
  const stillOnField = isOnField(state, match);
  if (!stillOnField) match.fieldId = null;
  match.state = stillOnField ? 'ASSIGNED' : 'READY';
  match.winnerId = null;
  match.loserId = null;
  match.finishedAt = null;
  match.startedAt = null;
  resetTimer(match.timer, ctx.now);
  touchMatch(mut, match.id);
  pushEvent(mut, 'MATCH_RESET', { key: 'event.matchResetToZero', params: { round: match.roundName } }, {
    matchId: match.id,
    fieldId: match.fieldId,
  });
  if (state.tournament && state.tournament.championId && state.tournament.status === 'COMPLETED') {
    state.tournament.status = 'RUNNING';
    state.tournament.championId = null;
    state.tournament.completedAt = null;
    mut.tournament = true;
  }
  recalculateRadball(state, ctx, mut);
}

export function otherSideOf(side: 'A' | 'B'): 'A' | 'B' {
  return otherSide(side);
}
