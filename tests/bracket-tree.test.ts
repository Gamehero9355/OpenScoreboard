/**
 * The tournament tree.
 *
 * Two shapes share one renderer, and both are pinned here. A knockout keeps its
 * wire geometry; a league has to become a *tree* rather than a grid, which means
 * three claims worth failing over:
 *
 * 1. Every match in the competition lands on the poster exactly once. A grid
 *    could get away with dropping a match; a tree cannot, because a dropped
 *    match is a missing branch.
 * 2. Every wire starts on a qualification chip's edge and ends on a card's edge.
 *    A wire that floats is a promise the poster cannot keep.
 * 3. A wire only ever runs forward, from an earlier phase to a later one. Inside
 *    a single phase a team appears in a group and in the final, and drawing that
 *    as a wire would invent a match.
 */
import { describe, expect, it } from 'vitest';
import type {
  Match,
  RadballMatchMeta,
  StandingRow,
  TournamentState,
} from '../src/shared/types';
import { bracketRounds } from '../src/shared/matchUtils';
import { computeLayout, isLeagueTree } from '../src/frontend/components/BracketView';
import {
  LEAGUE_CARD_H,
  LEAGUE_CARD_W,
  progressionTree,
  type Poster,
} from '../src/frontend/lib/progression';

function state(matches: Match[], radball?: TournamentState['radball']): TournamentState {
  const byId: Record<string, Match> = {};
  for (const match of matches) byId[match.id] = match;
  return {
    protocol: 2,
    seq: 1,
    updatedAt: 0,
    tournament: null,
    participants: Object.fromEntries(
      ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'c1', 'c2'].map((id) => [id, { id, name: id.toUpperCase() }]),
    ),
    teams: {},
    fields: {},
    matches: byId,
    matchOrder: matches.map((match) => match.id),
    events: [],
    settings: {} as TournamentState['settings'],
    radball: radball ?? null,
  } as unknown as TournamentState;
}

let seq = 0;

function fixture(
  round: number,
  position: number,
  teamA: string | null,
  teamB: string | null,
  options: {
    state?: string;
    roundName?: string;
    phaseId?: string;
    groupId?: string | null;
    kind?: RadballMatchMeta['kind'];
    qualifies?: boolean;
    reason?: string | null;
    scoreA?: number;
    scoreB?: number;
  } = {},
): Match {
  seq += 1;
  const groupId = options.groupId ?? null;
  const phaseId = options.phaseId ?? 'ph_A';
  const name =
    options.roundName ?? (groupId ? `Group ${groupId} · Round ${round + 1}` : `Round ${round + 1}`);
  return {
    id: `m${seq}`,
    round,
    roundName: name,
    position,
    bracket: 'winners',
    state: options.state ?? 'FINISHED',
    scoreA: options.scoreA ?? 2,
    scoreB: options.scoreB ?? 1,
    participantAId: teamA,
    participantBId: teamB,
    winnerId: options.state === 'READY' ? null : teamA,
    loserId: options.state === 'READY' ? null : teamB,
    fieldId: null,
    history: [{ id: 's1', ts: 1, participantId: teamA, delta: 2, kind: 'score' }],
    slotA: teamA ? { kind: 'participant', participantId: teamA } : { kind: 'bye' },
    slotB: teamB ? { kind: 'participant', participantId: teamB } : { kind: 'bye' },
    isThirdPlace: options.kind === 'placement',
    radball: groupId
      ? {
          phaseId,
          groupId,
          kind: options.kind ?? 'group',
          requiresWinner: Boolean(options.qualifies),
          decisionReason: options.reason ?? null,
          sideChange: true,
          neutralBall: false,
          shootout: null,
        }
      : options.kind
        ? {
            phaseId: options.phaseId ?? 'ph_final',
            groupId: null,
            kind: options.kind,
            requiresWinner: true,
            decisionReason: options.reason ?? null,
            sideChange: true,
            neutralBall: false,
            shootout: null,
          }
        : null,
  } as unknown as Match;
}

/**
 * Group A is a full four-team round robin (two fixtures a round, three rounds).
 * Group B is a three-team group whose last round is a single fixture, so one of
 * its rows is short. Round numbering restarts per group, as Radball does it.
 */
function leagueMatches(): Match[] {
  seq = 0;
  return [
    fixture(0, 0, 'a1', 'a2', { groupId: 'A' }),
    fixture(0, 1, 'a3', 'a4', { groupId: 'A' }),
    fixture(1, 2, 'a1', 'a3', { groupId: 'A' }),
    fixture(1, 3, 'a2', 'a4', { groupId: 'A' }),
    fixture(2, 4, 'a1', 'a4', { groupId: 'A' }),
    fixture(2, 5, 'a2', 'a3', { groupId: 'A' }),
    fixture(0, 1, 'b1', 'b2', { groupId: 'B' }),
    fixture(0, 2, 'b3', null, { groupId: 'B' }),
    fixture(1, 3, 'b1', 'b3', { groupId: 'B' }),
    fixture(1, 4, 'b2', null, { groupId: 'B' }),
  ];
}

function row(
  teamId: string,
  rank: number,
  points: number,
  status: StandingRow['status'] = 'open',
): StandingRow {
  return {
    teamId,
    played: 2,
    won: 2,
    drawn: 0,
    lost: 0,
    goalsFor: 6,
    goalsAgainst: 1,
    goalDiff: 5,
    points,
    rank,
    status,
    note: null,
  };
}

function leagueRadball(overrides: {
  pendingFinal?: boolean;
  championId?: string | null;
  finalPhase?: boolean;
} = {}): TournamentState['radball'] {
  const phases: Record<string, unknown> = {
    ph_A: {
      id: 'ph_A',
      name: 'Group stage',
      kind: 'group-stage',
      groupIds: ['A', 'B'],
      order: 0,
      qualification: null,
      status: 'RUNNING',
    },
  };
  const groups: Record<string, unknown> = {
    A: { id: 'A', name: 'Group A', phaseId: 'ph_A', teamIds: ['a1', 'a2', 'a3', 'a4'], doubleRoundRobin: false, qualifies: 2 },
    B: { id: 'B', name: 'Group B', phaseId: 'ph_A', teamIds: ['b1', 'b2', 'b3'], doubleRoundRobin: false, qualifies: 1 },
  };
  const phaseOrder = ['ph_A'];
  const tables: Record<string, StandingRow[]> = {
    A: [row('a1', 1, 6, 'qualified'), row('a3', 2, 3, 'qualified'), row('a4', 3, 0, 'eliminated'), row('a2', 4, 0, 'eliminated')],
    B: [row('b1', 1, 6, 'qualified')],
  };

  if (overrides.finalPhase) {
    phases.ph_final = {
      id: 'ph_final',
      name: 'Final round',
      kind: 'final-round',
      // The placement matches of a ranking-matches final round are created in a
      // group called "Finals"; only the final itself is left group-less.
      groupIds: ['g_final'],
      order: 1,
      qualification: { fromPhaseId: 'ph_A', places: 3 },
      status: 'RUNNING',
    };
    groups.g_final = {
      id: 'g_final',
      name: 'Finals',
      phaseId: 'ph_final',
      teamIds: ['a1', 'a3', 'b1'],
      doubleRoundRobin: false,
      qualifies: 0,
    };
    tables.g_final = [row('a1', 1, 6, 'qualified')];
    phaseOrder.push('ph_final');
  }

  return {
    config: {},
    phases,
    phaseOrder,
    groups,
    groupOrder: ['A', 'B'],
    tables,
    championId: overrides.championId ?? null,
    pendingFinal: overrides.pendingFinal ? { mode: 'ranking-matches' } : null,
    decisionSeq: 0,
  } as unknown as TournamentState['radball'];
}

/** A completed competition: group stage plus a final round of ranked matches. */
function finishedMatches(): Match[] {
  seq = 0;
  return [
    fixture(0, 0, 'a1', 'a2', { groupId: 'A' }),
    fixture(0, 1, 'a3', 'a4', { groupId: 'A' }),
    fixture(1, 2, 'a1', 'a3', { groupId: 'A' }),
    fixture(2, 4, 'a1', 'a4', { groupId: 'A' }),
    // The final round: one ranked match per pair of qualifiers, plus the final
    // itself. The final belongs to no group -- the engine creates it with
    // groupId null so it is part of no table -- which is exactly why the old
    // board filed it under its own heading and the tree has to give it a lane.
    fixture(900, 0, 'a1', 'a3', { phaseId: 'ph_final', roundName: 'Final', kind: 'final' }),
    fixture(900, 1, 'b1', null, {
      phaseId: 'ph_final',
      groupId: 'g_final',
      roundName: '3rd Place Match',
      kind: 'placement',
    }),
  ];
}

/* ------------------------------------------------------------------ */

describe('league tree', () => {
  it('recognises a league as having no feeders', () => {
    expect(isLeagueTree(state(leagueMatches()))).toBe(true);
  });

  it('puts every fixture on the poster exactly once', () => {
    const leagueState = state(leagueMatches(), leagueRadball());
    const poster = progressionTree(leagueState);
    const keys = poster.cards.map((card) => card.key);
    expect(keys).toHaveLength(leagueMatches().length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives each group its own lane, because round numbers restart in each', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball()));
    expect(poster.lanes.map((lane) => lane.title)).toEqual(['Group A', 'Group B']);
  });

  it('gives a lane one tick per playing round, shortened to fit the gutter', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball()));
    const groupA = poster.lanes[0];
    // The gutter is 40px. A tick cannot carry "Group A · Round 1" and the lane
    // header above already says "Group A", so the tick drops the prefix and
    // keeps the full name for the tooltip.
    expect(groupA.ticks.map((tick) => tick.title)).toEqual(['Round 1', 'Round 2', 'Round 3']);
    expect(groupA.ticks.map((tick) => tick.fullTitle)).toEqual([
      'Group A · Round 1',
      'Group A · Round 2',
      'Group A · Round 3',
    ]);
    const groupB = poster.lanes[1];
    expect(groupB.ticks).toHaveLength(2);
    expect(groupB.ticks.every((tick) => !tick.title.startsWith('Group B'))).toBe(true);
  });

  it('shows a team that got a bye as a fixture, not as a gap', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball()));
    // b3 plays a bye in round 1, so the row still holds both fixtures.
    const lane = poster.lanes[1];
    const firstRowCards = poster.cards.filter(
      (card) => card.y === lane.ticks[0].y - LEAGUE_CARD_H / 2,
    );
    expect(firstRowCards).toHaveLength(2);
  });

  it('rows a team in the server table order and only shows the qualifiers', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball()));
    // Group A qualifies two, Group B one. The eliminated teams are not leaves,
    // so they are not on the poster -- the full table lives on the Results tab.
    const outputs = poster.lanes.flatMap((lane) => lane.outputs);
    expect(outputs.map((out) => out.name)).toEqual(['A1', 'A3', 'B1']);
    expect(outputs.every((out) => out.role === 'qualified')).toBe(true);
  });

  it('points every qualification wire from a chip edge to a card edge', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    const chips = poster.lanes.flatMap((lane) => lane.outputs);
    const wires = poster.wires.filter((wire) => wire.tone === 'qualify');
    expect(wires.length).toBeGreaterThan(0);

    const ports = new Set(chips.map((chip) => `${chip.x + chip.width}@${chip.y + chip.height / 2}`));
    const targets = new Set(
      poster.cards.map((card) => `${card.x}@${card.y + LEAGUE_CARD_H / 2}`),
    );
    for (const wire of wires) {
      const numbers = (wire.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const [x0, y0, , , , , x1, y1] = numbers;
      // Both ends must be a real edge. A wire that floats is a promise the
      // poster cannot keep.
      expect(ports.has(`${x0}@${y0}`)).toBe(true);
      expect(targets.has(`${x1}@${y1}`)).toBe(true);
    }
  });

  it('never draws a wire backwards, from a later phase to an earlier one', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    const laneX = poster.lanes.map((lane) => lane.x);
    for (const wire of poster.wires) {
      const numbers = (wire.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const [x0, , , , , , x1] = numbers;
      expect(x1).toBeGreaterThan(x0);
    }
    // Lanes run left to right in phase order, so a final-round lane can never
    // sit to the left of the group that fed it.
    expect(laneX).toEqual([...laneX].sort((a, b) => a - b));
  });

  it('has no duplicate keys anywhere, which would collapse two things into one', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    for (const list of [poster.bands, poster.lanes, poster.wires, poster.ghosts]) {
      const keys = list.map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('splits one round number that carries several different names', () => {
    // The final phase's ranking matches all share the decision round number but
    // each has its own label, so no lane ends up wearing the wrong one.
    const ranking = [
      fixture(900, 0, 'a1', 'a3', { roundName: 'Ranking match 1' }),
      fixture(900, 1, 'a2', 'a4', { roundName: 'Ranking match 2' }),
    ];
    const poster = progressionTree(state(ranking));
    const ticks = poster.lanes[0].ticks;
    expect(ticks.map((tick) => tick.title)).toEqual(['Ranking match 1', 'Ranking match 2']);
  });

  it('draws the final, which belongs to no group, instead of losing it', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    const lanes = poster.lanes.map((lane) => lane.title);
    expect(lanes).toContain('Final');
    const finalCard = poster.cards.find((card) => card.match.roundName === 'Final');
    expect(finalCard).toBeDefined();
  });

  it('shows the road to a final round that has not been earned yet', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball({ pendingFinal: true })));
    // No final-round fixtures exist, so the last band is a plate the qualified
    // teams are heading for -- the shape of the event before it is played.
    expect(poster.ghosts).toHaveLength(1);
    expect(poster.ghosts[0].title).toBe('Final round');
    expect(poster.bands[poster.bands.length - 1].tone).toBe('final');
    const pending = poster.wires.filter((wire) => wire.tone === 'pending');
    // One wire per team that is through: A1, A3 and B1.
    expect(pending).toHaveLength(3);
    for (const wire of pending) {
      const numbers = (wire.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(numbers[6]).toBe(poster.ghosts[0].x);
    }
  });

  it('draws no pending plate when the final round already exists', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    expect(poster.ghosts).toHaveLength(0);
  });

  it('crowns the champion and feeds the crown from the match that decided it', () => {
    const poster = progressionTree(
      state(finishedMatches(), leagueRadball({ finalPhase: true, championId: 'a1' })),
    );
    expect(poster.crown).not.toBeNull();
    expect(poster.crown!.name).toBe('A1');
    const crownWire = poster.wires.find((wire) => wire.tone === 'champion');
    expect(crownWire).toBeDefined();
    // The final match decided the title, so the wire must leave that card.
    const finalCard = poster.cards.find((card) => card.match.roundName === 'Final')!;
    const numbers = (crownWire!.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers[0]).toBe(finalCard.x + LEAGUE_CARD_W);
    expect(numbers[6]).toBe(poster.crown!.x);
  });

  it('crowns from the table when no final was played', () => {
    // A competition with a single group and no final round: the champion is the
    // group leader, and the wire has to leave that group's lead chip.
    const poster = progressionTree(
      state(leagueMatches(), leagueRadball({ championId: 'a1' })),
    );
    expect(poster.crown!.name).toBe('A1');
    const crownWire = poster.wires.find((wire) => wire.tone === 'champion')!;
    const lead = poster.lanes
      .flatMap((lane) => lane.outputs)
      .find((out) => out.teamId === 'a1')!;
    const numbers = (crownWire.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers[0]).toBe(lead.x + lead.width);
  });

  it('has no crown before there is a champion', () => {
    const poster = progressionTree(state(leagueMatches(), leagueRadball()));
    expect(poster.crown).toBeNull();
  });

  it('keeps every card, chip and band inside the canvas it reports', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    for (const card of poster.cards) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + LEAGUE_CARD_W).toBeLessThanOrEqual(poster.width);
      expect(card.y + LEAGUE_CARD_H).toBeLessThanOrEqual(poster.height);
    }
    for (const lane of poster.lanes) {
      for (const output of lane.outputs) {
        expect(output.x + output.width).toBeLessThanOrEqual(poster.width);
        expect(output.y + output.height).toBeLessThanOrEqual(poster.height);
      }
    }
    for (const band of poster.bands) {
      expect(band.x + band.width).toBeLessThanOrEqual(poster.width);
    }
  });

  it('draws a plain league with no Radball model as one lane and no wires', () => {
    // Nothing qualifies for anything, and the tree says so by having no wires
    // rather than inventing a qualification.
    const untagged = leagueMatches().map((match) => ({
      ...match,
      radball: null,
      roundName: `Round ${match.round + 1}`,
    }));
    const poster = progressionTree(state(untagged as unknown as Match[]));
    expect(poster.lanes).toHaveLength(1);
    expect(poster.lanes[0].ticks).toHaveLength(3);
    expect(poster.cards).toHaveLength(untagged.length);
    expect(poster.wires).toHaveLength(0);
  });

  it('gives every card to exactly one lane, so the printed tree reads in order', () => {
    const poster = progressionTree(state(finishedMatches(), leagueRadball({ finalPhase: true })));
    const owned = poster.lanes.flatMap((lane) => lane.cardKeys);
    // A lane renders its own fixtures, so every card belongs to one lane and
    // the printed page can put them where they belong instead of printing every
    // lane and then a pile of cards.
    expect(owned).toHaveLength(poster.cards.length);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual(poster.cards.map((card) => card.key).sort());
    // The lookup a lane uses has to resolve every key it hands out.
    for (const key of owned) expect(poster.cardsById.get(key)).toBeDefined();
  });

  it('has an empty canvas, not a broken one, for a tournament with no matches', () => {
    const poster = progressionTree(state([]));
    expect(poster.bands).toHaveLength(0);
    expect(poster.cards).toHaveLength(0);
    expect(poster.width).toBeGreaterThan(0);
    expect(poster.height).toBeGreaterThan(0);
  });
});

describe('knockout tree', () => {
  /** Four players, two rounds: quarterfinals feeding one semifinal. */
  function knockoutMatches(): Match[] {
    seq = 0;
    const base = (round: number, position: number, a: string | null, b: string | null) => ({
      ...fixture(round, position, a, b, { state: 'READY' }),
      slotA: a ? { kind: 'participant', participantId: a } : { kind: 'winner-of', matchId: 'q1' },
      slotB: b ? { kind: 'participant', participantId: b } : { kind: 'winner-of', matchId: 'q2' },
      radball: null,
    });
    return [
      { ...base(0, 0, 'a', 'b'), id: 'q1' },
      { ...base(0, 1, 'c', 'd'), id: 'q2' },
      {
        ...base(1, 2, null, null),
        id: 's1',
        slotA: { kind: 'winner-of', matchId: 'q1' },
        slotB: { kind: 'winner-of', matchId: 'q2' },
      },
    ] as unknown as Match[];
  }

  it('is not treated as a league', () => {
    expect(isLeagueTree(state(knockoutMatches()))).toBe(false);
  });

  it('draws one wire per feeder', () => {
    const knockoutState = state(knockoutMatches());
    const layout = computeLayout(bracketRounds(knockoutState));
    expect(layout.connectors).toHaveLength(2);
    expect(layout.connectors.every((wire) => wire.kind === 'win')).toBe(true);
  });

  it('joins every wire to the card edge, not a PAD above it', () => {
    const knockoutState = state(knockoutMatches());
    const layout = computeLayout(bracketRounds(knockoutState));
    for (const wire of layout.connectors) {
      const [from, rest] = wire.key.split('->');
      const to = rest.slice(0, rest.lastIndexOf(':'));
      const feeder = layout.byId.get(from);
      const target = layout.byId.get(to);
      expect(feeder).toBeDefined();
      expect(target).toBeDefined();
      // "M x0 y0 C c1x c1y, c2x c2y, x1 y1" -- eight numbers, ends at 6 and 7.
      const [x0, y0, , , , , x1, y1] = (wire.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      // A card is drawn at left: x, top: PAD + TITLE_H + y and is COL_W by
      // CARD_H. The wire has to use the same origin, or it floats above the card.
      expect(x0).toBe(feeder!.x + 244);
      expect(y0).toBe(20 + 44 + feeder!.y + 42);
      expect(x1).toBe(target!.x);
      expect(y1).toBe(20 + 44 + target!.y + 42);
    }
  });

  it('keeps every card inside the canvas it reports', () => {
    const knockoutState = state(knockoutMatches());
    const layout = computeLayout(bracketRounds(knockoutState));
    for (const column of layout.columns) {
      for (const node of column.nodes) {
        expect(node.x + 244).toBeLessThanOrEqual(layout.width - 20);
        expect(20 + 44 + node.y + 84).toBeLessThanOrEqual(layout.height - 20);
      }
    }
  });

  it('has no duplicate column keys, which would collapse two rounds into one', () => {
    const knockoutState = state(knockoutMatches());
    const keys = computeLayout(bracketRounds(knockoutState)).columns.map((column) => column.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reaches the poster unchanged, so both shapes share one renderer', () => {
    const knockoutState = state(knockoutMatches());
    const layout: ReturnType<typeof computeLayout> = computeLayout(bracketRounds(knockoutState));
    // The knockout poster is the layout with the same origin the wires use.
    const poster: Poster = {
      width: layout.width,
      height: layout.height,
      cardWidth: 244,
      cardHeight: 84,
      laneHead: 0,
      bands: [],
      lanes: [],
      cards: [],
      cardsById: new Map(),
      ghosts: [],
      crown: null,
      wires: [],
    };
    expect(poster.width).toBe(layout.width);
    expect(poster.cardWidth).toBe(244);
  });
});
