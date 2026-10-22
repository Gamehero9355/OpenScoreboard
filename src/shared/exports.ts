/**
 * Export builders. Pure string generation so the exact same file can be produced
 * by the server (direct download) or the browser (offline export).
 */
import { computeResults } from './stats';
import { isRealMatch, nameOf } from './matchUtils';
import type { AppEvent, TournamentState } from './types';

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function resultsCsv(state: TournamentState): string {
  const results = computeResults(state);
  const rows: (string | number | null)[][] = [
    ['place', 'name', 'team', 'seed', 'played', 'wins', 'losses', 'draws', 'points_for', 'points_against', 'difference', 'win_rate_%', 'eliminated_in'],
  ];
  for (const row of results.rows) {
    rows.push([
      row.place,
      row.name,
      row.team,
      row.seed,
      row.played,
      row.wins,
      row.losses,
      row.draws,
      row.pointsFor,
      row.pointsAgainst,
      row.pointDifference,
      row.winRate,
      row.eliminatedInRoundName ?? '',
    ]);
  }
  return toCsv(rows);
}

export function matchesCsv(state: TournamentState): string {
  const rows: (string | number | null)[][] = [
    ['match_id', 'bracket', 'round', 'round_name', 'position', 'state', 'field', 'participant_a', 'participant_b', 'score_a', 'score_b', 'winner', 'started_at', 'finished_at', 'duration_s'],
  ];
  const matches = Object.values(state.matches).sort(
    (a, b) => a.round - b.round || a.position - b.position || a.id.localeCompare(b.id),
  );
  for (const match of matches) {
    if (!isRealMatch(match)) continue;
    rows.push([
      match.id,
      match.bracket,
      match.round + 1,
      match.roundName,
      match.position + 1,
      match.state,
      // A match can still name a field this state has no entry for. `setFieldNames`
      // now refuses to drop a field a match names, but a backup restored from an
      // older build, or a file edited by hand, can carry a `fieldId` its own
      // field list does not contain. This route is unauthenticated, so one
      // dangling id must not be able to 500 the whole export. `participantsCsv`
      // below reads the same map the same defensive way.
      match.fieldId ? (state.fields[match.fieldId]?.name ?? `Field ${match.fieldId}`) : '',
      nameOf(state, match.participantAId, ''),
      nameOf(state, match.participantBId, ''),
      match.scoreA,
      match.scoreB,
      nameOf(state, match.winnerId, ''),
      match.startedAt ? new Date(match.startedAt).toISOString() : '',
      match.finishedAt ? new Date(match.finishedAt).toISOString() : '',
      match.startedAt && match.finishedAt ? Math.round((match.finishedAt - match.startedAt) / 1000) : '',
    ]);
  }
  return toCsv(rows);
}

export function participantsCsv(state: TournamentState): string {
  const rows: (string | number | null)[][] = [['name', 'team', 'seed', 'field', 'checked_in']];
  for (const id of state.participantOrder) {
    const participant = state.participants[id];
    if (!participant) continue;
    rows.push([
      participant.name,
      participant.team,
      participant.seed,
      participant.fieldId ? (state.fields[participant.fieldId]?.name ?? `Field ${participant.fieldId}`) : '',
      participant.checkedIn ? 'yes' : 'no',
    ]);
  }
  return toCsv(rows);
}

export function eventsCsv(events: AppEvent[]): string {
  const rows: (string | number | null)[][] = [['timestamp', 'type', 'field', 'match_id', 'actor', 'message']];
  for (const event of events) {
    rows.push([
      new Date(event.ts).toISOString(),
      event.type,
      event.fieldId ?? '',
      event.matchId ?? '',
      event.actor,
      event.message,
    ]);
  }
  return toCsv(rows);
}

/** Full offline copy of the tournament, good for archiving or moving machines. */
export function tournamentJson(state: TournamentState): string {
  return JSON.stringify(
    {
      app: 'tournament-scoreboard',
      schema: 1,
      appVersion: '1.0.0',
      exportedAt: Date.now(),
      tournament: state.tournament,
      settings: state.settings,
      participants: Object.values(state.participants),
      matches: Object.values(state.matches),
      matchOrder: state.matchOrder,
      results: computeResults(state),
    },
    null,
    2,
  );
}

export function backupFilename(prefix = 'tournament-backup', at = new Date()): string {
  const iso = at.toISOString().slice(0, 10);
  return `${prefix}-${iso}.json`;
}
