/**
 * A twelve-team World Cup, driven end to end and read the way a host reads it.
 *
 * The engine test proves the ranking fills; this proves the *screens* describe
 * twelve teams rather than reciting the ten-team case. A format that computes
 * correctly while its own page claims "20 preliminary, places 1-10" has still
 * failed a volunteer, and that failure is invisible to an assertion on state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStore, adminCtx, run, type TestStore } from './helpers';
import { createTournament } from '../src/backend/tournament/engine';
import { generateFinalPhase, finalPhaseMatches, preliminaryMatches } from '../src/backend/tournament/radball10';
import { formatDocumentation, finalRankingRows, preliminaryProgress, groupSlots } from '../src/frontend/lib/radball10';
import { radball10FinalStructure } from '../src/shared/radball10Structure';
import { assignMatchToField, finishMatch, startMatch } from '../src/backend/tournament/matchops';
import { updateScore } from '../src/backend/tournament/scoring';
import type { ParticipantInput } from '../src/shared/commands';
import type { TournamentState } from '../src/shared/types';

const openStores: TestStore[] = [];
afterEach(async () => {
  while (openStores.length > 0) await openStores.pop()?.dispose();
});

function playMatch(store: TestStore, matchId: string, a: number, b: number, field: string): void {
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    if (!state.matches[matchId].fieldId) assignMatchToField(state, matchId, field, ctx, mut);
    startMatch(state, matchId, field, ctx, mut);
    updateScore(state, state.matches[matchId], 'A', a, ctx, mut);
    updateScore(state, state.matches[matchId], 'B', b, ctx, mut);
    finishMatch(state, { matchId, winner: null, force: false }, ctx, mut);
  });
}

function playGroups(state: TournamentState, store: TestStore, groupSize: number): void {
  const groups = groupSlots(state);
  groups.forEach((group, groupIndex) => {
    const field = groupIndex === 0 ? '1' : '2';
    const fixtures = preliminaryMatches(state, group.groupId);
    fixtures.forEach((match, index) => playMatch(store, match.id, 6, 1 + (index % 4), field));
  });
  void groupSize;
}

async function twelveTeamStore(label: string): Promise<TestStore> {
  const store = await createTestStore(label);
  openStores.push(store);
  // Six squads per field: the field roster is the group, so Group A is Squad 1-6
  // and Group B is Squad 7-12.
  const teams: ParticipantInput[] = Array.from({ length: 12 }, (_, index) => ({
    name: `Squad ${index + 1}`,
    team: null,
    seed: null,
    checkedIn: true,
    players: [`P${index + 1}a`, `P${index + 1}b`],
    fieldId: index < 6 ? '1' : '2',
  }));
  run(store.store, adminCtx(store.store), (state, ctx, mut) => {
    createTournament(
      state,
      {
        name: 'World Cup — 12 teams',
        format: 'radball',
        participants: teams,
        thirdPlaceMatch: false,
        seeded: true,
        seedValue: null,
        settings: { fieldNames: ['Field 1', 'Field 2'] },
        generateBracketNow: true,
        radball: { ageCategory: 'ELITE', preset: 'radball-10-team' },
      },
      ctx,
      mut,
    );
  });
  return store;
}

describe('a twelve-team World Cup describes itself correctly', () => {
  it('the preliminary progress counts thirty fixtures, not twenty', async () => {
    const store = await twelveTeamStore('twelve-progress');
    const fresh = preliminaryProgress(groupSlots(store.store.state));
    expect(fresh).toMatchObject({ played: 0, total: 30, complete: false });

    playGroups(store.store.state, store, 6);
    const done = preliminaryProgress(groupSlots(store.store.state));
    expect(done).toMatchObject({ played: 30, total: 30, complete: true });
  });

  it('the rules panel prints twelve teams and the right match count', async () => {
    const store = await twelveTeamStore('twelve-docs');
    const lines = formatDocumentation(store.store.state, radball10FinalStructure(6));
    const text = lines.map((line) => `${line.label} ${line.text}`).join('\n');

    // 6 * 5 / 2 = 15 per group, 30 in total, 8 final-phase matches, 38 overall.
    expect(text).toContain('2 groups × 6 teams');
    expect(text).toContain('15 matches per group, 30 in total');
    expect(text).toContain('30 preliminary + 8 final-phase = 38 matches');
    expect(text).toContain('Every place 1-12 is decided by a match');
    // The eleventh/twelfth placement match only exists above ten teams.
    expect(text).toContain('11th / 12th place');
    // And none of the ten-team-only phrasing survives.
    expect(text).not.toContain('2 groups × 5 teams');
    expect(text).not.toContain('places 1-10');
    expect(text).not.toContain('27 matches');
  });

  it('the ranking offers twelve ordinals, all decided by a real match', async () => {
    const store = await twelveTeamStore('twelve-ranking');
    playGroups(store.store.state, store, 6);
    run(store.store, adminCtx(store.store), (state, ctx, mut) => {
      generateFinalPhase(state, ctx, mut, { confirm: true });
    });
    const structure = radball10FinalStructure(6);
    const play = (key: string) => {
      const id = `${store.store.state.tournament?.id}:rf10:${key.toLowerCase()}`;
      const match = store.store.state.matches[id];
      if (match) playMatch(store, match.id, 4, 2, '1');
    };
    structure
      .filter((entry) => entry.places && entry.key !== 'THIRD_PLACE' && entry.key !== 'FINAL')
      .forEach((entry) => play(entry.key));
    play('SEMIFINAL_1');
    play('SEMIFINAL_2');
    play('THIRD_PLACE');
    play('FINAL');

    const rows = finalRankingRows(store.store.state);
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.decided)).toBe(true);
    expect(rows.map((row) => row.ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th',
    ]);
    // Every place came from a match that was actually played.
    for (const row of rows) {
      expect(row.source).not.toBe('not decided');
    }
    expect(store.store.state.radball?.ten?.issues).toEqual([]);
    expect(store.store.state.tournament?.status).toBe('COMPLETED');
    expect(finalPhaseMatches(store.store.state)).toHaveLength(8);
  });
});
