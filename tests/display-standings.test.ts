/**
 * The game a display shows while it is paused, and where its two teams stand.
 *
 * The pause notice tells the hall that a game stopped. What the hall wants to
 * know then is where *that game* stands: the two teams, their place in the
 * table they belong to, and the score they are playing. Not the whole table --
 * a break lasts a couple of minutes, and the race the other groups are running
 * is not the race the people in front of this screen are watching.
 *
 * The standing comes from the server's own table, so nothing is recomputed
 * here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { playingGameFor } from '../src/frontend/lib/displayStandings';
import { buildRadball10Demo } from '../src/backend/tournament/demo';
import { createTournament } from '../src/backend/tournament/engine';
import { assignMatchToField, unassignField } from '../src/backend/tournament/matchops';
import type { ParticipantInput } from '../src/shared/commands';
import { adminCtx, createTestStore, run, type TestStore } from './helpers';

const openStores: TestStore[] = [];

afterEach(async () => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    await store?.dispose();
  }
});

async function makeStore(label: string): Promise<TestStore> {
  const store = await createTestStore(label);
  openStores.push(store);
  return store;
}

/** The World Cup demo: Group A on Field 1, Group B on Field 2. */
async function makeWorldCup(label: string): Promise<TestStore> {
  const store = await makeStore(label);
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    buildRadball10Demo(state, ctx, mut);
  });
  return store;
}

describe('the game a paused display shows', () => {
  it('is the match on the field', async () => {
    const store = await makeWorldCup('pause-game-field');
    const state = store.store.state;
    const game = playingGameFor(state, ['1']);
    expect(game).not.toBeNull();
    expect(game!.match.id).toBe(state.fields['1']?.matchId);
    expect(game!.fieldId).toBe('1');
  });

  it('belongs to the group that field is running', async () => {
    const store = await makeWorldCup('pause-game-group');
    const state = store.store.state;
    const game = playingGameFor(state, ['1']);
    // The match on Field 1 is a Group A game, and the panel says so.
    const groupId = state.matches[state.fields['1']!.matchId!].radball?.groupId;
    expect(game!.groupName).toBe(state.radball?.groups[groupId!]?.name);
    expect(playingGameFor(state, ['2'])?.groupName).toBe(
      state.radball?.groups[state.matches[state.fields['2']!.matchId!].radball!.groupId!]?.name,
    );
  });

  it('shows the two teams of that game, and their place in the table', async () => {
    const store = await makeWorldCup('pause-game-sides');
    const state = store.store.state;
    const game = playingGameFor(state, ['1']);
    const match = state.matches[state.fields['1']!.matchId!];
    expect(game!.home?.teamId).toBe(match.participantAId);
    expect(game!.away?.teamId).toBe(match.participantBId);
    // The place is the team's rank in its group table.
    const rows = state.radball?.tables[match.radball!.groupId!] ?? [];
    expect(game!.home?.rank).toBe(rows.find((row) => row.teamId === match.participantAId)?.rank);
    expect(game!.away?.rank).toBe(rows.find((row) => row.teamId === match.participantBId)?.rank);
  });

  it('shows the live score of the game', async () => {
    const store = await makeWorldCup('pause-game-score');
    const state = store.store.state;
    const game = playingGameFor(state, ['1']);
    const match = state.matches[state.fields['1']!.matchId!];
    expect(game!.match.scoreA).toBe(match.scoreA);
    expect(game!.match.scoreB).toBe(match.scoreB);
  });

  it('has none for a field with no game on it', async () => {
    const store = await makeWorldCup('pause-game-empty');
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      for (const field of Object.values(s.fields)) {
        if (field.matchId) unassignField(s, field.id, c, mut);
      }
    });
    // No game is being played, so there is no standing to show.
    expect(playingGameFor(store.store.state, ['1'])).toBeNull();
  });

  it('follows the match when the format does not pin its groups', async () => {
    // Two unpinned groups: the match on the field is the only thing that says
    // which group that field is running.
    const store = await makeStore('pause-game-unpinned');
    const participants: ParticipantInput[] = Array.from({ length: 6 }, (_, index) => ({
      name: `Team ${index + 1}`,
      team: null,
      seed: null,
      checkedIn: true,
      players: [`P${index + 1}a`, `P${index + 1}b`],
    }));
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      createTournament(
        state,
        {
          name: 'Two groups',
          format: 'radball',
          participants,
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
          radball: { ageCategory: 'ELITE', groupCount: 2 },
        },
        ctx,
        mut,
      );
    });
    const state = store.store.state;
    const groups = state.radball?.groupOrder ?? [];
    expect(groups).toHaveLength(2);
    // The second group's fixture onto Field 1. The fields are emptied first:
    // the other group's fixture already sits on Field 2, and a team cannot
    // play on two fields at once.
    const foreign = Object.values(state.matches).find(
      (match) => match.radball?.groupId === groups[1] && !match.fieldId,
    );
    expect(foreign).toBeDefined();
    run(store.store, adminCtx(store.store), (s, c, mut) => {
      for (const field of Object.values(s.fields)) {
        if (field.matchId) unassignField(s, field.id, c, mut);
      }
      assignMatchToField(s, foreign!.id, '1', c, mut);
    });
    const after = store.store.state;
    const game = playingGameFor(after, ['1']);
    expect(game?.match.id).toBe(foreign!.id);
    expect(game?.groupName).toBe(after.radball?.groups[groups[1]!]?.name);
  });

  it('falls back to the tournament table for a knockout', async () => {
    const store = await makeStore('pause-game-knockout');
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      createTournament(
        state,
        {
          name: 'Knockout',
          format: 'single-elimination',
          participants: [
            { name: 'A', team: null, seed: null, checkedIn: true, players: ['Aa', 'Ab'] },
            { name: 'B', team: null, seed: null, checkedIn: true, players: ['Ba', 'Bb'] },
            { name: 'C', team: null, seed: null, checkedIn: true, players: ['Ca', 'Cb'] },
            { name: 'D', team: null, seed: null, checkedIn: true, players: ['Da', 'Db'] },
          ],
          thirdPlaceMatch: false,
          seeded: true,
          seedValue: null,
          settings: null,
          generateBracketNow: true,
        },
        ctx,
        mut,
      );
    });
    const state = store.store.state;
    const game = playingGameFor(state, ['1']);
    // A knockout has no groups, so the standing comes from the tournament table.
    expect(game?.groupName).toBeNull();
    expect(game?.home?.teamId).toBe(game?.match.participantAId);
    expect(game?.home?.points).toBeNull();
  });
});
