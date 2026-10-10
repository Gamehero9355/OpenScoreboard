/**
 * Bracket resolution.
 *
 * Winner propagation is *derived*, never copied: a downstream slot reads the
 * result of its feeder match. That makes advancement idempotent, recursive and
 * trivially correct when two fields finish at the same time -- there is no
 * "copy the winner across" step that could run twice.
 */
import type { Match, TournamentState } from '../../shared/types';
import { EngineError } from '../util/errors';
import { roundCount } from './bracket';
import {
  type Ctx,
  type Mutation,
  createTimerState,
  isByeMatch,
  isOnField,
  notify,
  participantName,
  pushEvent,
  resolveSlot,
  setSlotParticipantId,
  stopTimer,
  timerDisplay,
  touchMatch,
} from './state';

const MAX_PASSES = 4000;

/** Stop the clock and mark a match finished. Does not resolve downstream. */
export function completeMatch(
  match: Match,
  winnerId: string | null,
  loserId: string | null,
  ctx: Ctx,
  mut: Mutation,
): void {
  stopTimer(match.timer, ctx.now);
  match.state = 'FINISHED';
  match.winnerId = winnerId;
  match.loserId = loserId;
  match.finishedAt = ctx.now;
  match.timer.running = false;
  match.timer.anchorAt = null;
  touchMatch(mut, match.id);
}

export function releaseField(state: TournamentState, fieldId: string, mut: Mutation): void {
  const field = state.fields[fieldId];
  if (!field) return;
  field.matchId = null;
  mut.fields.add(fieldId);
  mut.urgency = 'immediate';
}

/** The match that decides the tournament, if the bracket has one. */
export function decidingMatchIds(state: TournamentState): string[] {
  if (!state.tournament) return [];
  // A manual schedule has no decider: every fixture is one the host wrote down,
  // and crowning the winner of whichever one happens to sit last would be a
  // champion named by an accident of ordering. The host ends the event
  // deliberately, with `tournament.complete`.
  if (state.tournament.format === 'manual-schedule') return [];
  const ids: string[] = [];
  const reset = Object.values(state.matches).find((m) => m.bracket === 'reset' && m.state !== 'CANCELLED');
  if (reset) return [reset.id];
  if (state.tournament.format === 'double-elimination') {
    const final = Object.values(state.matches).find((m) => m.bracket === 'final');
    if (final) return [final.id];
  }
  let best: Match | null = null;
  for (const match of Object.values(state.matches)) {
    if (match.bracket !== 'winners' || match.isThirdPlace) continue;
    if (!best) {
      best = match;
      continue;
    }
    // Two-element tuples read as a pair here; the destructuring says so rather than
    // leaving the compiler to reason about `number | undefined` at index 0 and 1.
    const [bestRound, bestPosition] = [best.round, best.position];
    const [round, position] = [match.round, match.position];
    if (round > bestRound || (round === bestRound && position < bestPosition)) best = match;
  }
  if (best) ids.push(best.id);
  return ids;
}

function createResetMatch(state: TournamentState, grandFinal: Match, ctx: Ctx, mut: Mutation): Match {
  const id = `${grandFinal.tournamentId}:grand-final-reset`;
  const existing = state.matches[id];
  if (existing) return existing;
  const match: Match = {
    id,
    tournamentId: grandFinal.tournamentId,
    round: grandFinal.round,
    roundName: 'Grand Final Reset',
    position: 1,
    bracketSlot: 1,
    bracket: 'reset',
    isThirdPlace: false,
    isGrandFinal: true,
    slotA: grandFinal.participantAId
      ? { kind: 'winner-of', matchId: grandFinal.id }
      : { kind: 'bye' },
    slotB: grandFinal.participantBId
      ? { kind: 'loser-of', matchId: grandFinal.id }
      : { kind: 'bye' },
    participantAId: grandFinal.winnerId,
    participantBId: grandFinal.loserId,
    scoreA: 0,
    scoreB: 0,
    state: grandFinal.winnerId && grandFinal.loserId ? 'READY' : 'WAITING',
    fieldId: null,
    winnerId: null,
    loserId: null,
    startedAt: null,
    finishedAt: null,
    timer: createTimerState(state.settings.timerMode, state.settings.defaultMatchDurationSec),
    nextWinMatchId: null,
    nextWinSlot: null,
    nextLoseMatchId: null,
    nextLoseSlot: null,
    history: [],
    redoStack: [],
    locked: true,
    note: 'Required because the winners-bracket side lost the grand final.',
    radball: null,
  };
  state.matches[id] = match;
  state.matchOrder.push(id);
  touchMatch(mut, id);
  pushEvent(mut, 'BRACKET_UPDATED', { key: 'event.grandFinalReset' }, { matchId: id });
  void ctx;
  return match;
}

/**
 * Bring the whole bracket to a consistent state: fill slots from their feeders,
 * auto-advance byes, keep match states in sync. Runs to a fixpoint so a chain of
 * byes resolves in one call.
 */
export function resolveBracket(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  if (!state.tournament) return;
  let changed = true;
  let passes = 0;

  while (changed && passes < MAX_PASSES) {
    changed = false;
    passes += 1;

    for (const id of [...state.matchOrder]) {
      const match = state.matches[id];
      if (!match) continue;
      if (match.state === 'FINISHED' || match.state === 'CANCELLED') continue;

      const resA = resolveSlot(state, match, 'A');
      const resB = resolveSlot(state, match, 'B');
      const nextA = resA.status === 'filled' ? resA.participantId : null;
      const nextB = resB.status === 'filled' ? resB.participantId : null;
      const live = match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME';

      // A live match may only ever gain a participant, never lose one: nobody
      // must be able to pull a player out from under a running scoreboard.
      if (nextA !== match.participantAId && (!live || nextA !== null)) {
        setSlotParticipantId(match, 'A', nextA);
        touchMatch(mut, match.id);
        changed = true;
      }
      if (nextB !== match.participantBId && (!live || nextB !== null)) {
        setSlotParticipantId(match, 'B', nextB);
        touchMatch(mut, match.id);
        changed = true;
      }

      // A slot that can never be filled lets the other side walk through. A
      // slot that is merely *pending* must never trigger this: its feeder may
      // still be playing on the other field right now.
      //
      // A manual schedule is exempt: its slots are the two teams the host
      // picked, and an empty one means the roster lost a team, not that the
      // other side has nobody to beat. Recording a walkover there would hand
      // out a result the host never played.
      if (!live && state.tournament.format !== 'manual-schedule') {
        const aEmpty = resA.status === 'empty';
        const bEmpty = resB.status === 'empty';
        const aFilled = resA.status === 'filled';
        const bFilled = resB.status === 'filled';
        if (aFilled && bEmpty) {
          completeMatch(match, nextA, null, ctx, mut);
          pushEvent(
            mut,
            'BRACKET_UPDATED',
            {
              key: 'event.advancesNoOpponent',
              params: { team: participantName(state, nextA), round: match.roundName },
            },
            { matchId: match.id },
          );
          changed = true;
          continue;
        }
        if (bFilled && aEmpty) {
          completeMatch(match, nextB, null, ctx, mut);
          pushEvent(
            mut,
            'BRACKET_UPDATED',
            {
              key: 'event.advancesNoOpponent',
              params: { team: participantName(state, nextB), round: match.roundName },
            },
            { matchId: match.id },
          );
          changed = true;
          continue;
        }
        if (aEmpty && bEmpty) {
          match.state = 'CANCELLED';
          if (isOnField(state, match)) releaseField(state, match.fieldId as string, mut);
          match.fieldId = null;
          touchMatch(mut, match.id);
          changed = true;
          continue;
        }
      }

      if (!live) {
        const playable = Boolean(nextA && nextB);
        if (playable && match.state === 'WAITING') {
          match.state = 'READY';
          touchMatch(mut, match.id);
          changed = true;
        } else if (!playable && match.state !== 'WAITING' && match.state !== 'ASSIGNED') {
          match.state = 'WAITING';
          touchMatch(mut, match.id);
          changed = true;
        }
      }
    }
  }

  if (passes >= MAX_PASSES) {
    throw new EngineError('INVALID_STATE', 'Bracket resolution did not settle -- the bracket is corrupt.');
  }
}

/**
 * Called after any match finishes. Handles tournament completion, the
 * double-elimination grand-final reset and the final state of the bracket.
 */
export function finaliseTournament(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  const tournament = state.tournament;
  if (!tournament) return;
  // Radball owns its own completion (tables, tie-breaks, champion) inside
  // recalculateRadball -- the knockout decider must never fire for it.
  if (tournament.format === 'radball') return;
  // A manual schedule owns its own ending too: there is no decider, so there is
  // nothing for this function to crown. `decidingMatchIds` already answers with
  // an empty list for it; the early return keeps the double-elimination reset
  // logic from ever running against fixtures that feed nothing.
  if (tournament.format === 'manual-schedule') return;

  const finishedMatches = Object.values(state.matches).filter((m) => m.state === 'FINISHED');
  const deciding = decidingMatchIds(state);
  const decided = deciding.length > 0 && deciding.every((id) => state.matches[id]?.state === 'FINISHED');

  // Double elimination: if the side that came through the losers bracket wins
  // the grand final, a single deciding rematch is required.
  if (tournament.format === 'double-elimination' && !state.matches[`${tournament.id}:grand-final-reset`]) {
    const grandFinal = Object.values(state.matches).find((m) => m.bracket === 'final');
    if (
      grandFinal &&
      grandFinal.state === 'FINISHED' &&
      grandFinal.winnerId &&
      grandFinal.participantBId &&
      grandFinal.winnerId === grandFinal.participantBId &&
      grandFinal.participantAId
    ) {
      createResetMatch(state, grandFinal, ctx, mut);
      resolveBracket(state, ctx, mut);
      return;
    }
  }

  if (!decided) {
    if (tournament.status === 'COMPLETED') {
      tournament.status = 'RUNNING';
      tournament.championId = null;
      tournament.completedAt = null;
      mut.tournament = true;
    }
    return;
  }

  const finalId = deciding[deciding.length - 1];
  if (!finalId) return;
  const finalMatch = state.matches[finalId];
  const championId = finalMatch?.winnerId ?? null;
  if (championId && tournament.championId !== championId) {
    tournament.championId = championId;
    tournament.status = 'COMPLETED';
    tournament.completedAt = ctx.now;
    mut.tournament = true;
    pushEvent(
      mut,
      'TOURNAMENT_UPDATED',
      { key: 'event.tournamentComplete', params: { name: participantName(state, championId) } },
      { matchId: finalId },
    );
    notify(mut, 'info', {
      key: 'notify.tournamentComplete',
      params: { name: participantName(state, championId) },
    });
  } else if (!championId && tournament.status === 'COMPLETED') {
    tournament.status = 'RUNNING';
    tournament.championId = null;
    tournament.completedAt = null;
    mut.tournament = true;
  }
  void finishedMatches;
}

/** Full re-derivation: used after bulk changes (load, reset, manual seeding). */
export function rebuild(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  if (!state.tournament) return;
  if (state.tournament.format === 'double-elimination') {
    const resetId = `${state.tournament.id}:grand-final-reset`;
    if (state.matches[resetId]) {
      const anyScore = Object.values(state.matches).some(
        (m) => m.id !== resetId && (m.scoreA > 0 || m.scoreB > 0),
      );
      if (!anyScore) {
        delete state.matches[resetId];
        state.matchOrder = state.matchOrder.filter((id) => id !== resetId);
        mut.removedMatchIds.push(resetId);
      }
    }
  }
  resolveBracket(state, ctx, mut);
  finaliseTournament(state, ctx, mut);
}

export function clockText(match: Match, now: number): string {
  const ms = timerDisplay(match.timer, now);
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function bracketRoundCount(size: number): number {
  return roundCount(size);
}

export { isByeMatch };
