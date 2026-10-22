/**
 * The game a display is showing, and where its two teams stand.
 *
 * The pause notice tells the hall that a game stopped. What the hall wants to
 * know then is where *that game* stands: the two teams, their position in the
 * table they belong to, and the score they are playing. Not the whole table --
 * a break lasts a couple of minutes, and the race the other groups are running
 * is not the race the people in front of this screen are watching.
 *
 * The standing comes from the server's own table (`competition.tables` for a
 * Radball group, the derived bracket table for a knockout). Nothing is
 * recomputed here.
 */
import { computeResults, type TournamentResults } from '../../shared/stats';
import { matchAtBreak } from '../../shared/matchUtils';
import type { FieldId, Match, StandingRow, TournamentState } from '../../shared/types';

/** Where one side of the game stands. */
export interface SideStanding {
  /** The team, when there is one. */
  teamId: string | null;
  /** The team's position in the table (1 = first). Null when there is none. */
  rank: number | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  /** Points on the table. Null in a knockout, which has none. */
  points: number | null;
}

/** The game being played, with the standing of both sides. */
export interface PlayingGame {
  /** The match itself: the score on the wall is its live score. */
  match: Match;
  /** The group the game belongs to, when it is a group game. */
  groupName: string | null;
  /** The field the game is on. */
  fieldId: FieldId | null;
  /** The two sides, in the order they play. */
  home: SideStanding | null;
  away: SideStanding | null;
}

/**
 * The game being played on these fields.
 *
 * A display covers one field or all of them. The game is the one on a field:
 * the match at its break if one is there (that is why the pause notice is up),
 * otherwise the match running on the first field that has one.
 */
export function playingGameFor(state: TournamentState, fieldIds: FieldId[]): PlayingGame | null {
  const match = gameOnField(state, fieldIds);
  if (!match) return null;
  const groupId = match.radball?.groupId ?? null;
  const competition = state.radball;
  const group = groupId && competition ? competition.groups[groupId] : undefined;
  if (competition && group && groupId) {
    const rows = competition.tables[groupId] ?? [];
    return {
      match,
      groupName: group.name,
      fieldId: match.fieldId ?? group.fieldId,
      home: sideFromGroup(rows, match.participantAId),
      away: sideFromGroup(rows, match.participantBId),
    };
  }
  // A knockout has no groups: the tournament table is the standings it has.
  const rows = computeResults(state).rows;
  return {
    match,
    groupName: null,
    fieldId: match.fieldId,
    home: sideFromTournament(rows, match.participantAId),
    away: sideFromTournament(rows, match.participantBId),
  };
}

/** The match these fields are playing: the one at its break, else the first running. */
function gameOnField(state: TournamentState, fieldIds: FieldId[]): Match | null {
  const atBreak = matchAtBreak(state, fieldIds);
  if (atBreak) return atBreak;
  for (const fieldId of fieldIds) {
    const matchId = state.fields[fieldId]?.matchId;
    const match = matchId ? state.matches[matchId] : null;
    if (match && match.state !== 'FINISHED' && match.state !== 'CANCELLED') return match;
  }
  return null;
}

/** One side's standing in its group table. */
function sideFromGroup(rows: StandingRow[], teamId: string | null): SideStanding | null {
  if (!teamId) return null;
  const row = rows.find((entry) => entry.teamId === teamId);
  if (!row) return null;
  return {
    teamId: row.teamId,
    rank: row.rank,
    played: row.played,
    won: row.won,
    drawn: row.drawn,
    lost: row.lost,
    points: row.points,
  };
}

/** One side's standing in the derived tournament table. */
function sideFromTournament(
  rows: TournamentResults['rows'],
  teamId: string | null,
): SideStanding | null {
  if (!teamId) return null;
  const row = rows.find((entry) => entry.participantId === teamId);
  if (!row) return null;
  return {
    teamId: row.participantId,
    rank: row.place ?? null,
    played: row.played,
    won: row.wins,
    drawn: row.draws,
    lost: row.losses,
    points: null,
  };
}
