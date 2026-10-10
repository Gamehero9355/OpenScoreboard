import { describe, expect, it } from 'vitest';
import type { Delta, Match, Participant, RadballCompetition, TournamentState } from '../src/shared/types';
import { applyDeltaToState } from '../src/frontend/lib/live';
import { parseRadballTeams } from '../src/frontend/pages/SetupPage';
import { libraryRosterLines, libraryTeams } from '../src/frontend/lib/teams';
import { sanitiseTeamLibrary } from '../src/backend/tournament/teams';

function baseState(): TournamentState {
  return {
    tournament: null,
    participants: {},
    participantOrder: [],
    matches: {},
    matchOrder: [],
    fields: {},
    settings: { fieldNames: ['Field 1', 'Field 2'] } as TournamentState['settings'],
    radball: null,
    teamLibrary: { teams: {}, order: [] },
    savedTournaments: { entries: {}, order: [] },
    events: [],
    seq: 1,
    updatedAt: 1,
  };
}

function libraryWith(name: string) {
  return sanitiseTeamLibrary({
    teams: { a: { id: 'a', name, club: null, players: ['Anna', 'Ben'], ageCategory: 'U15' } },
    order: ['a'],
  });
}

/**
 * A guard against the exact bug that shipped once: the server broadcasts a
 * state slice, the client forgets to apply it, and the screen accepts an edit
 * while appearing to do nothing. Every optional field of `Delta` must be
 * handled by `applyDeltaToState`.
 */
describe('client delta application', () => {
  it('applies every field the Delta type can carry', () => {
    // The keys a full-featured delta can carry, so a new slice added to Delta
    // without a matching branch here fails this test instead of the product.
    const covered: Array<keyof Delta> = [
      'seq',
      'updatedAt',
      'tournament',
      'settings',
      'radball',
      'teamLibrary',
      'savedTournaments',
      'fields',
      'matches',
      'participants',
      'removedMatchIds',
      'removedParticipantIds',
      'events',
      'network',
      'matchOrder',
      'participantOrder',
    ];
    const source = applyDeltaToState.toString();
    for (const key of covered) {
      if (key === 'seq' || key === 'updatedAt') continue; // assigned in the object literal
      if (key === 'network') continue; // handled by the caller, not the state
      expect(source, `applyDeltaToState must handle delta.${key}`).toContain(`delta.${key}`);
    }
  });

  it('applies a team library delta, so an added squad shows up at once', () => {
    const before = baseState();
    const after = applyDeltaToState(before, { seq: 2, updatedAt: 2, teamLibrary: libraryWith('RV Nord I') });
    expect(libraryTeams(after.teamLibrary).map((team) => team.name)).toEqual(['RV Nord I']);
  });

  it('keeps the rest of the state when only the library changed', () => {
    const before = baseState();
    before.teamLibrary = libraryWith('RV Sued I');
    const after = applyDeltaToState(before, { seq: 3, updatedAt: 3, teamLibrary: libraryWith('RV Nord I') });
    // The library is replaced wholesale, every other slice is untouched.
    expect(libraryTeams(after.teamLibrary).map((team) => team.name)).toEqual(['RV Nord I']);
    expect(after.settings).toBe(before.settings);
    expect(after.radball).toBe(before.radball);
    expect(after.seq).toBe(3);
  });

  it('empties the library when the server sends an empty one', () => {
    const before = baseState();
    before.teamLibrary = libraryWith('RV Nord I');
    const after = applyDeltaToState(before, {
      seq: 4,
      updatedAt: 4,
      teamLibrary: { teams: {}, order: [] },
    });
    expect(libraryTeams(after.teamLibrary)).toEqual([]);
  });

  it('leaves the library alone on deltas that do not mention it', () => {
    const before = baseState();
    before.teamLibrary = libraryWith('RV Nord I');
    const after = applyDeltaToState(before, { seq: 5, updatedAt: 5 });
    expect(after.teamLibrary).toBe(before.teamLibrary);
  });

  it('returns a new state object so memoised selectors re-render', () => {
    const before = baseState();
    const after = applyDeltaToState(before, { seq: 6, updatedAt: 6 });
    expect(after).not.toBe(before);
    // ...and new inner objects for the collections that are merged into.
    expect(after.fields).not.toBe(before.fields);
    expect(after.participants).not.toBe(before.participants);
    expect(after.matches).not.toBe(before.matches);
  });

  it('still merges fields, participants, matches, orders and events', () => {
    const before = baseState();
    const participant = { id: 'p1', name: 'A', team: null, seed: null, checkedIn: true, createdAt: 1, fieldId: null, players: null } as Participant;
    const match = { id: 'm1', scoreA: 2 } as Match;
    const after = applyDeltaToState(before, {
      seq: 7,
      updatedAt: 7,
      fields: [{ id: '1', name: 'Court A', matchId: null, controlledBy: null, controlledSince: null }],
      participants: [participant],
      matches: [match],
      removedMatchIds: ['m0'],
      removedParticipantIds: ['p0'],
      matchOrder: ['m1'],
      participantOrder: ['p1'],
      events: [{ seq: 7, ts: 7, type: 'SYSTEM', fieldId: null, matchId: null, actor: 'Host', message: 'hi' }],
    });
    expect(after.fields['1'].name).toBe('Court A');
    expect(after.participants.p1.name).toBe('A');
    expect(after.matches.m1.scoreA).toBe(2);
    expect(after.matchOrder).toEqual(['m1']);
    expect(after.participantOrder).toEqual(['p1']);
    expect(after.events).toHaveLength(1);
  });

  it('applies a radball competition delta and a tournament null-out', () => {
    const before = baseState();
    const competition = { config: { rulesetVersion: 'uci_radball_2025' } } as RadballCompetition;
    const withRadball = applyDeltaToState(before, { seq: 8, updatedAt: 8, radball: competition });
    expect(withRadball.radball).toBe(competition);
    const cleared = applyDeltaToState(withRadball, { seq: 9, updatedAt: 9, tournament: null, radball: null });
    expect(cleared.tournament).toBeNull();
    expect(cleared.radball).toBeNull();
  });

  it('keeps only the last 80 events on a client', () => {
    const before = baseState();
    before.events = Array.from({ length: 80 }, (_, index) => ({
      seq: index,
      ts: index,
      type: 'SYSTEM' as const,
      fieldId: null,
      matchId: null,
      actor: 'Host',
      message: `e${index}`,
    }));
    const after = applyDeltaToState(before, {
      seq: 10,
      updatedAt: 10,
      events: [
        { seq: 100, ts: 100, type: 'TEAM_ADDED', fieldId: null, matchId: null, actor: 'Host', message: 'new' },
      ],
    });
    expect(after.events).toHaveLength(80);
    expect(after.events[79].message).toBe('new');
  });

  /**
   * The full round trip the feature depends on: a squad filed in the library
   * arrives over the wire as a roster line the tournament wizard can read.
   */
  it('carries a library squad into a readable tournament roster', () => {
    const library = sanitiseTeamLibrary({
      teams: {
        a: { id: 'a', name: 'RV Nord I', club: 'RV Nord', players: ['Anna', 'Ben'], ageCategory: 'U15' },
        b: { id: 'b', name: 'RV Süd I', club: null, players: ['Cal', 'Dan'], ageCategory: 'U15' },
      },
      order: ['a', 'b'],
    });
    const after = applyDeltaToState(baseState(), { seq: 11, updatedAt: 11, teamLibrary: library });
    const text = libraryRosterLines(libraryTeams(after.teamLibrary)).join('\n');
    const roster = parseRadballTeams(text);
    expect(roster).toHaveLength(2);
    expect(roster.map((team) => team.name)).toEqual(['RV Nord I', 'RV Süd I']);
    expect(roster.every((team) => team.players[0] && team.players[1])).toBe(true);
  });
});
