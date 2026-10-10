/**
 * Results and statistics, computed from the live bracket. Pure functions over
 * the tournament state so the same numbers appear in the UI, the CSV export and
 * the printable report.
 */
import type { Match, Participant, TournamentState } from './types';
import { isRealMatch } from './matchUtils';

export interface ParticipantStats {
  participantId: string;
  name: string;
  team: string | null;
  seed: number | null;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifference: number;
  winRate: number;
  /** Round number (1-based) in which the participant stopped winning. */
  eliminatedInRound: number | null;
  eliminatedInRoundName: string | null;
  place: number | null;
}

export interface TournamentResults {
  tournamentName: string;
  status: string;
  champion: Participant | null;
  runnerUp: Participant | null;
  thirdPlace: Participant | null;
  finishedMatches: number;
  totalMatches: number;
  totalPoints: number;
  rows: ParticipantStats[];
  generatedAt: number;
}

function emptyStats(participant: Participant): ParticipantStats {
  return {
    participantId: participant.id,
    name: participant.name,
    team: participant.team,
    seed: participant.seed,
    played: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointDifference: 0,
    winRate: 0,
    eliminatedInRound: null,
    eliminatedInRoundName: null,
    place: null,
  };
}

export function eliminatedRound(state: TournamentState, participantId: string): Match | null {
  let worst: Match | null = null;
  for (const match of Object.values(state.matches)) {
    if (match.state !== 'FINISHED') continue;
    if (match.loserId !== participantId) continue;
    if (!isRealMatch(match)) continue;
    if (!worst || match.round > worst.round) worst = match;
  }
  return worst;
}

export function decidingMatch(state: TournamentState): Match | null {
  if (!state.tournament) return null;
  // A manual schedule has no deciding match: its fixtures are whatever the host
  // wrote down, so "the last one" is an accident of ordering rather than a
  // final. `decidingMatchIds` in the engine answers the same way, and the two
  // must agree or the results report would crown a champion the tournament
  // itself refuses to.
  if (state.tournament.format === 'manual-schedule') return null;
  const reset = Object.values(state.matches).find((m) => m.bracket === 'reset' && m.state === 'FINISHED');
  if (reset) return reset;
  if (state.tournament.format === 'double-elimination') {
    const final = Object.values(state.matches).find((m) => m.bracket === 'final');
    if (final) return final;
  }
  let best: Match | null = null;
  for (const match of Object.values(state.matches)) {
    if (match.bracket !== 'winners' || match.isThirdPlace) continue;
    if (!best || match.round > best.round || (match.round === best.round && match.position < best.position)) {
      best = match;
    }
  }
  return best;
}

export function computeResults(state: TournamentState): TournamentResults {
  const rows = new Map<string, ParticipantStats>();
  for (const id of state.participantOrder) {
    const participant = state.participants[id];
    if (participant) rows.set(id, emptyStats(participant));
  }

  let finished = 0;
  let total = 0;
  let totalPoints = 0;
  for (const match of Object.values(state.matches)) {
    if (match.isThirdPlace && !isRealMatch(match)) continue;
    total += 1;
    if (match.state !== 'FINISHED') continue;
    if (!isRealMatch(match)) continue;
    finished += 1;
    totalPoints += match.scoreA + match.scoreB;

    const a = match.participantAId ? rows.get(match.participantAId) : null;
    const b = match.participantBId ? rows.get(match.participantBId) : null;
    if (match.loserId === null) {
      if (a) {
        a.played += 1;
        a.draws += 1;
        a.pointsFor += match.scoreA;
        a.pointsAgainst += match.scoreB;
      }
      if (b) {
        b.played += 1;
        b.draws += 1;
        b.pointsFor += match.scoreB;
        b.pointsAgainst += match.scoreA;
      }
      continue;
    }
    if (a) {
      a.played += 1;
      a.pointsFor += match.scoreA;
      a.pointsAgainst += match.scoreB;
      if (match.winnerId === a.participantId) a.wins += 1;
      else a.losses += 1;
    }
    if (b) {
      b.played += 1;
      b.pointsFor += match.scoreB;
      b.pointsAgainst += match.scoreA;
      if (match.winnerId === b.participantId) b.wins += 1;
      else b.losses += 1;
    }
  }

  for (const stats of rows.values()) {
    stats.pointDifference = stats.pointsFor - stats.pointsAgainst;
    stats.winRate = stats.played === 0 ? 0 : Math.round((stats.wins / stats.played) * 1000) / 10;
    const eliminated = eliminatedRound(state, stats.participantId);
    if (eliminated) {
      stats.eliminatedInRound = eliminated.round + 1;
      stats.eliminatedInRoundName = eliminated.roundName;
    }
  }

  const final = decidingMatch(state);
  const championId = state.tournament?.championId ?? (final?.state === 'FINISHED' ? final.winnerId : null);
  const runnerUpId = championId && final ? (final.winnerId === championId ? final.loserId : null) : null;
  const thirdMatch = Object.values(state.matches).find((m) => m.isThirdPlace && m.state === 'FINISHED');
  let thirdId = thirdMatch?.winnerId ?? null;
  if (!thirdId && state.tournament?.format === 'double-elimination') {
    const lbFinal = Object.values(state.matches)
      .filter((m) => m.bracket === 'losers')
      .sort((a, b) => b.round - a.round)[0];
    if (lbFinal?.state === 'FINISHED') thirdId = lbFinal.loserId;
  }

  if (championId && rows.has(championId)) rows.get(championId)!.place = 1;
  if (runnerUpId && rows.has(runnerUpId)) rows.get(runnerUpId)!.place = 2;
  if (thirdId && rows.has(thirdId)) rows.get(thirdId)!.place = 3;

  const ordered = [...rows.values()].sort((a, b) => {
    const placeA = a.place ?? Number.MAX_SAFE_INTEGER;
    const placeB = b.place ?? Number.MAX_SAFE_INTEGER;
    if (placeA !== placeB) return placeA - placeB;
    const roundA = a.eliminatedInRound ?? Number.MAX_SAFE_INTEGER;
    const roundB = b.eliminatedInRound ?? Number.MAX_SAFE_INTEGER;
    if (roundA !== roundB) return roundB - roundA;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDifference !== a.pointDifference) return b.pointDifference - a.pointDifference;
    return a.name.localeCompare(b.name);
  });

  let nextPlace = 4;
  for (const stats of ordered) {
    if (stats.place === null) {
      stats.place = nextPlace;
      nextPlace += 1;
    }
  }

  return {
    tournamentName: state.tournament?.name ?? state.settings.tournamentName,
    status: state.tournament?.status ?? 'DRAFT',
    champion: championId ? (state.participants[championId] ?? null) : null,
    runnerUp: runnerUpId ? (state.participants[runnerUpId] ?? null) : null,
    thirdPlace: thirdId ? (state.participants[thirdId] ?? null) : null,
    finishedMatches: finished,
    totalMatches: total,
    totalPoints,
    rows: ordered,
    generatedAt: Date.now(),
  };
}
