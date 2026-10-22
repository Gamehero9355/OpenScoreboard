/**
 * Radball 2er competition engine (UCI ruleset `uci_radball_2025`).
 *
 * A dedicated tournament mode next to the generic knockout engine -- never the
 * other way round. Nothing in here touches elimination brackets, and nothing
 * in the generic engine knows about round-robin tables:
 *
 *   Tournament State -> Competition Phase -> Matches -> Results
 *     -> Standings -> Tie-Break Rules -> Qualification -> Next Phase
 *
 * The visual UI only ever renders this state; the state is the source of
 * truth. Standings are recomputed server-side after every result change, ties
 * at qualification cuts or championship positions automatically spawn decision
 * matches, and level decision matches are resolved by a structured 4-meter
 * shootout -- never by a silent pick.
 */
import type {
  FieldId,
  Match,
  RadballAgeCategory,
  RadballCompetition,
  RadballConfig,
  RadballDependency,
  RadballGroup,
  RadballMatchKind,
  RadballMatchType,
  RadballPhase,
  ShootoutState,
  StandingRow,
  TournamentState,
} from '../../shared/types';
import {
  defaultRadballConfig,
  radballDecisionSec,
  radballMatchSec,
} from '../../shared/types';
import { EngineError } from '../util/errors';
import { resolveBracket } from './resolve';
import {
  groupSizeOf,
  preliminaryMatches,
  createRadball10Competition,
  requiresShootout,
  syncRadball10,
  validateRadball10Setup,
} from './radball10';
import {
  type Ctx,
  type Mutation,
  createTimerState,
  notify,
  participantName,
  pushEvent,
  touchMatch,
} from './state';

/* ------------------------------------------------------------------ */
/* Round-robin scheduler                                              */
/* ------------------------------------------------------------------ */

export interface RadballFixture {
  round: number;
  teamA: string;
  teamB: string;
}

/**
 * Deterministic circle-method schedule: every team plays every other team
 * exactly once (twice mirrored for a double round robin). Odd counts produce
 * a BYE per round which is represented by simply skipping the pairing -- no
 * fake `A vs BYE` matches are ever created. Input order is preserved, so the
 * same teams always produce the same schedule and a reload never re-draws.
 */
export function roundRobinFixtures(teamIds: string[], doubleLeg: boolean): RadballFixture[] {
  const teams = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2 === 1) teams.push('');
  const n = teams.length;
  const rounds = n - 1;
  const out: RadballFixture[] = [];
  const ring = [...teams];
  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < n / 2; i += 1) {
      const a = ring[i];
      const b = ring[n - 1 - i];
      if (!a || !b) continue;
      out.push({ round, teamA: a, teamB: b });
    }
    const last = ring.pop() as string;
    ring.splice(1, 0, last);
  }
  if (doubleLeg) {
    const first = [...out];
    for (const fixture of first) {
      out.push({ round: rounds + fixture.round, teamA: fixture.teamB, teamB: fixture.teamA });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Setup & validation                                                 */
/* ------------------------------------------------------------------ */

export interface RadballGroupSetup {
  name: string;
  teamIds: string[];
  qualifies: number;
  doubleRoundRobin: boolean;
  /** Playing field this group is pinned to. The 10-team format uses it. */
  fieldId: FieldId | null;
}

export interface RadballSetup {
  ageCategory: RadballAgeCategory;
  reducedTime: boolean;
  minRestMinutes: number;
  shootoutAttempts: number;
  groups: RadballGroupSetup[];
  finalRound: { mode: 'round-robin' | 'ranking-matches' } | null;
  preset: string | null;
  /**
   * Split into groups of five and pin Group A / Group B to a field each. The
   * 10-team format is a *structure*, not a draw, so it fills this itself.
   */
  tenTeam: {
    groupA: string[];
    groupB: string[];
    groupFields: [FieldId, FieldId];
    finalOrder: string[] | null;
  } | null;
}

/**
 * Structural validation before a Radball tournament may start (§38). Throws
 * BAD_REQUEST with a readable reason instead of building a broken competition.
 */
export function validateRadballSetup(teamIds: string[], setup: RadballSetup): void {
  if (setup.tenTeam) {
    validateRadball10Setup([setup.tenTeam.groupA.length, setup.tenTeam.groupB.length]);
    const assigned = new Set([...setup.tenTeam.groupA, ...setup.tenTeam.groupB]);
    for (const id of teamIds) {
      if (!assigned.has(id)) {
        throw new EngineError('BAD_REQUEST', 'The 10-team format needs all ten teams assigned to a group.');
      }
    }
    if (assigned.size !== teamIds.length) {
      throw new EngineError('BAD_REQUEST', 'Each team can only play in one group.');
    }
    return;
  }
  if (teamIds.length < 3) {
    throw new EngineError('BAD_REQUEST', 'A Radball competition needs at least 3 teams. Enter one team per line: team name, player 1, player 2.');
  }
  if (setup.groups.length < 1 || setup.groups.length > 8) {
    throw new EngineError('BAD_REQUEST', 'A Radball competition needs 1..8 groups.');
  }
  const seen = new Set<string>();
  for (const group of setup.groups) {
    if (!group.name.trim()) throw new EngineError('BAD_REQUEST', 'Every group needs a name.');
    if (group.teamIds.length < 2) {
      throw new EngineError('BAD_REQUEST', `Group ${group.name} needs at least 2 teams.`);
    }
    if (group.qualifies < 0 || group.qualifies > group.teamIds.length) {
      throw new EngineError(
        'BAD_REQUEST',
        `Group ${group.name} cannot qualify ${group.qualifies} of ${group.teamIds.length} teams.`,
      );
    }
    for (const id of group.teamIds) {
      if (!teamIds.includes(id)) throw new EngineError('BAD_REQUEST', `Group ${group.name} references an unknown team.`);
      if (seen.has(id)) throw new EngineError('BAD_REQUEST', 'Each team can only play in one group.');
      seen.add(id);
    }
  }
  const missing = teamIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new EngineError('BAD_REQUEST', `${missing.length} team(s) are in no group. Every team must play somewhere.`);
  }
  if (setup.preset === 'radball-standard-2025' && setup.groups.length !== 1) {
    throw new EngineError('BAD_REQUEST', 'The standard Radball preset uses one group.');
  }
  if (setup.preset === 'bdr-elite-2025' && teamIds.length !== 5) {
    throw new EngineError('BAD_REQUEST', 'The BDR Elite preset is defined for exactly 5 teams.');
  }
  if (setup.finalRound) {
    const totalQualifiers = setup.groups.reduce((sum, group) => sum + group.qualifies, 0);
    if (totalQualifiers < 2) {
      throw new EngineError('BAD_REQUEST', 'A final round needs at least 2 qualified teams. Raise the qualifies count.');
    }
    if (setup.finalRound.mode === 'ranking-matches' && totalQualifiers < 4) {
      throw new EngineError('BAD_REQUEST', 'Ranking matches (final + 3rd place) need at least 4 qualified teams.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Competition construction                                           */
/* ------------------------------------------------------------------ */

function phaseId(tournamentId: string, index: number): string {
  return `${tournamentId}:rphase:${index}`;
}

function groupId(tournamentId: string, phaseIndex: number, groupIndex: number): string {
  return `${tournamentId}:rgroup:${phaseIndex}:${groupIndex}`;
}

function makeRadballMatch(opts: {
  tournamentId: string;
  id: string;
  phaseId: string;
  groupId: string | null;
  kind: RadballMatchKind;
  matchType: RadballMatchType | null;
  semiNumber: number | null;
  dependsOn: RadballDependency;
  roundName: string;
  round: number;
  position: number;
  teamAId: string | null;
  teamBId: string | null;
  durationSec: number;
  periodCount: 1 | 2;
  requiresWinner: boolean;
  decisionReason: string | null;
  /** false for matches whose teams are derived and must never be cached. */
  locked: boolean;
  ctx: Ctx;
}): Match {
  void opts.ctx;
  const { teamAId, teamBId } = opts;
  const playable = Boolean(teamAId && teamBId);
  return {
    id: opts.id,
    tournamentId: opts.tournamentId,
    round: opts.round,
    roundName: opts.roundName,
    position: opts.position,
    bracketSlot: opts.position,
    bracket: 'winners',
    isThirdPlace: opts.kind === 'placement' || opts.matchType === 'THIRD_PLACE',
    isGrandFinal: opts.kind === 'final',
    slotA: teamAId ? { kind: 'participant', participantId: teamAId } : { kind: 'bye' },
    slotB: teamBId ? { kind: 'participant', participantId: teamBId } : { kind: 'bye' },
    participantAId: teamAId,
    participantBId: teamBId,
    scoreA: 0,
    scoreB: 0,
    state: playable ? 'READY' : 'WAITING',
    fieldId: null,
    winnerId: null,
    loserId: null,
    startedAt: null,
    finishedAt: null,
    halftimeScore: null,
    timer: createTimerState('down', opts.durationSec, opts.periodCount),
    nextWinMatchId: null,
    nextWinSlot: null,
    nextLoseMatchId: null,
    nextLoseSlot: null,
    history: [],
    redoStack: [],
    locked: opts.locked,
    note: null,
    radball: {
      phaseId: opts.phaseId,
      groupId: opts.groupId,
      kind: opts.kind,
      matchType: opts.matchType,
      finalKey: null,
      semiNumber: opts.semiNumber,
      dependsOn: opts.dependsOn,
      requiresWinner: opts.requiresWinner,
      decisionReason: opts.decisionReason,
      sideChange: !opts.requiresWinner,
      neutralBall: opts.requiresWinner,
      shootout: null,
    },
  };
}

function insertMatch(state: TournamentState, match: Match, mut: Mutation): void {
  state.matches[match.id] = match;
  state.matchOrder.push(match.id);
  mut.matches.add(match.id);
  mut.matchOrder = [...state.matchOrder];
  touchMatch(mut, match.id);
}

/** Build phases, groups and the full fixture list for a new competition. */
export function createRadballCompetition(
  state: TournamentState,
  setup: RadballSetup,
  ctx: Ctx,
  mut: Mutation,
): void {
  const tournament = state.tournament;
  if (!tournament) throw new EngineError('NO_TOURNAMENT', 'No tournament is loaded yet.');
  validateRadballSetup([...state.participantOrder], setup);

  const config: RadballConfig = {
    ...defaultRadballConfig(setup.ageCategory),
    reducedTime: setup.reducedTime,
    minRestMinutes: setup.minRestMinutes,
    shootoutAttempts: setup.shootoutAttempts,
  };

  // The 10-team format owns its own construction: it pins groups to fields,
  // creates the twenty fixtures itself and publishes the final phase only when
  // the host confirms it. Handing it to the generic builder would need a dozen
  // `if` clauses to describe a shape the generic builder does not have.
  if (setup.tenTeam) {
    createRadball10Competition(
      state,
      {
        ageCategory: setup.ageCategory,
        reducedTime: setup.reducedTime,
        minRestMinutes: setup.minRestMinutes,
        shootoutAttempts: setup.shootoutAttempts,
        groupA: setup.tenTeam.groupA,
        groupB: setup.tenTeam.groupB,
        groupFields: setup.tenTeam.groupFields,
        finalOrder: (setup.tenTeam.finalOrder as never) ?? null,
      },
      tournament.id,
      ctx,
      mut,
    );
    tournament.bracketSize = state.participantOrder.length;
    tournament.rounds = 5;
    tournament.status = 'RUNNING';
    tournament.startedAt = tournament.startedAt ?? ctx.now;
    mut.tournament = true;
    pushEvent(
      mut,
      'TOURNAMENT_PHASE_UPDATED',
      // Counted from the competition that was just built, not from a constant:
      // this is the first line in the audit log, and a host reading "2 groups of
      // 5" for a twelve-team event would have no reason to trust the rest.
      {
        key: 'event.worldCupCreated',
        params: {
          size: groupSizeOf(state),
          n: preliminaryMatches(state).length,
          ruleset: state.radball?.config.rulesetVersion ?? '',
          age: config.ageCategory,
        },
      },
    );
    recalculateRadball(state, ctx, mut);
    return;
  }

  const competition: RadballCompetition = {
    config,
    system: 'standard',
    phases: {},
    phaseOrder: [],
    groups: {},
    groupOrder: [],
    tables: {},
    championId: null,
    pendingFinal: setup.finalRound ? { mode: setup.finalRound.mode } : null,
    decisionSeq: 0,
    ten: null,
  };

  const entryKind = setup.groups.length > 1 ? 'group-stage' : 'round-robin';
  const entryPhase: RadballPhase = {
    id: phaseId(tournament.id, 0),
    kind: setup.preset === 'bdr-elite-2025' ? 'group-stage' : entryKind,
    name: setup.preset === 'bdr-elite-2025' ? 'Preliminary round' : setup.groups.length > 1 ? 'Group stage' : 'Round robin',
    order: 0,
    groupIds: [],
    qualification: null,
    status: 'RUNNING',
  };
  competition.phases[entryPhase.id] = entryPhase;
  competition.phaseOrder.push(entryPhase.id);

  setup.groups.forEach((groupSetup, groupIndex) => {
    const gid = groupId(tournament.id, 0, groupIndex);
    const group: RadballGroup = {
      id: gid,
      phaseId: entryPhase.id,
      name: groupSetup.name,
      teamIds: [...groupSetup.teamIds],
      doubleRoundRobin: groupSetup.doubleRoundRobin,
      qualifies: groupSetup.qualifies,
      fieldId: groupSetup.fieldId,
    };
    competition.groups[gid] = group;
    competition.groupOrder.push(gid);
    entryPhase.groupIds.push(gid);

    const durationSec = radballMatchSec(config);
    let position = 0;
    for (const fixture of roundRobinFixtures(group.teamIds, group.doubleRoundRobin)) {
      const leg = group.doubleRoundRobin && fixture.round >= roundCount(group.teamIds.length) ? ' · 2nd leg' : '';
      insertMatch(
        state,
        makeRadballMatch({
          tournamentId: tournament.id,
          id: `${tournament.id}:rg:0:${groupIndex}:r${fixture.round}p${position}`,
          phaseId: entryPhase.id,
          groupId: gid,
          kind: 'group',
          matchType: null,
          semiNumber: null,
          dependsOn: 'none',
          roundName: `${group.name} · Round ${fixture.round + 1}${leg}`,
          round: fixture.round,
          position,
          teamAId: fixture.teamA,
          teamBId: fixture.teamB,
          durationSec,
          periodCount: 2,
          requiresWinner: false,
          decisionReason: null,
          locked: true,
          ctx,
        }),
        mut,
      );
      position += 1;
    }
  });

  state.radball = competition;
  mut.radball = true;

  tournament.bracketSize = state.participantOrder.length;
  tournament.rounds = Math.max(
    1,
    ...setup.groups.map((group) => roundCount(group.teamIds.length) * (group.doubleRoundRobin ? 2 : 1)),
  );
  tournament.status = 'RUNNING';
  tournament.startedAt = tournament.startedAt ?? ctx.now;
  mut.tournament = true;

  pushEvent(
    mut,
    'TOURNAMENT_PHASE_UPDATED',
    {
      key: 'event.radballCreated',
      params: {
        groups: setup.groups.length,
        fixtures: state.matchOrder.length,
        ruleset: config.rulesetVersion,
        age: config.ageCategory,
      },
    },
  );
  recalculateRadball(state, ctx, mut);
}

function roundCount(teamCount: number): number {
  const n = teamCount % 2 === 1 ? teamCount + 1 : teamCount;
  return Math.max(1, n - 1);
}

/* ------------------------------------------------------------------ */
/* Standings                                                          */
/* ------------------------------------------------------------------ */

function orderIndex(state: TournamentState, teamId: string): number {
  const index = state.participantOrder.indexOf(teamId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareRows(state: TournamentState, a: StandingRow, b: StandingRow): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  // Deterministic display order only -- never a sporting decision. Ties that
  // matter (advancement, title) always go to a decision match instead.
  return orderIndex(state, a.teamId) - orderIndex(state, b.teamId);
}

/**
 * The official table of one group, derived exclusively from finalized group
 * fixtures (3/1/0). Decision matches and shootouts never award table points.
 */
export function computeGroupTable(state: TournamentState, groupId: string): StandingRow[] {
  const competition = state.radball;
  const group = competition?.groups[groupId];
  if (!group) return [];
  const rows = new Map<string, StandingRow>();
  for (const teamId of group.teamIds) {
    rows.set(teamId, {
      teamId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
      rank: 0,
      status: 'open',
      note: null,
    });
  }
  const win = competition?.config.winPoints ?? 3;
  const draw = competition?.config.drawPoints ?? 1;
  for (const match of Object.values(state.matches)) {
    const meta = match.radball;
    if (!meta || meta.groupId !== groupId || meta.kind !== 'group') continue;
    if (match.state !== 'FINISHED') continue;
    const a = match.participantAId;
    const b = match.participantBId;
    const rowA = a ? rows.get(a) : undefined;
    const rowB = b ? rows.get(b) : undefined;
    if (!rowA || !rowB) continue;
    rowA.played += 1;
    rowB.played += 1;
    rowA.goalsFor += match.scoreA;
    rowA.goalsAgainst += match.scoreB;
    rowB.goalsFor += match.scoreB;
    rowB.goalsAgainst += match.scoreA;
    if (match.scoreA > match.scoreB) {
      rowA.won += 1;
      rowB.lost += 1;
      rowA.points += win;
    } else if (match.scoreA < match.scoreB) {
      rowB.won += 1;
      rowA.lost += 1;
      rowB.points += win;
    } else {
      rowA.drawn += 1;
      rowB.drawn += 1;
      rowA.points += draw;
      rowB.points += draw;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => compareRows(state, a, b));
  sorted.forEach((row, index) => {
    row.goalDiff = row.goalsFor - row.goalsAgainst;
    row.rank = index + 1;
  });
  return sorted;
}

/** True when every group fixture is decided (finished or cancelled). */
export function groupComplete(state: TournamentState, groupId: string): boolean {
  return !Object.values(state.matches).some(
    (match) =>
      match.radball?.groupId === groupId &&
      match.radball.kind === 'group' &&
      match.state !== 'FINISHED' &&
      match.state !== 'CANCELLED',
  );
}

function groupHasFinishedFixtures(state: TournamentState, groupId: string): boolean {
  return Object.values(state.matches).some(
    (match) => match.radball?.groupId === groupId && match.radball.kind === 'group' && match.state === 'FINISHED',
  );
}

/** Groups whose title decides the championship (final rounds, lone groups). */
export function isTitleGroup(state: TournamentState, groupId: string): boolean {
  const competition = state.radball;
  // The 10-team format has no "title group": every position feeds a named
  // final-phase match, and a group table never decides the title on its own.
  if (competition?.ten) return false;
  const group = competition?.groups[groupId];
  if (!group) return false;
  const phase = competition?.phases[group.phaseId];
  if (!phase) return false;
  if (phase.kind === 'final-round') return true;
  if ((phase.kind === 'group-stage' || phase.kind === 'round-robin') && !competition?.pendingFinal) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Tie detection                                                      */
/* ------------------------------------------------------------------ */

export interface GroupTie {
  groupId: string;
  teamIds: string[];
  /** 'cut' = qualification places at stake, 'title' = championship at stake. */
  context: 'cut' | 'title';
}

function sameLine(a: StandingRow, b: StandingRow): boolean {
  return a.points === b.points && a.goalDiff === b.goalDiff && a.goalsFor === b.goalsFor;
}

/**
 * Ties that must be played off: equal-stats sets containing rank 1 of a title
 * group, or straddling the qualification cut of a qualifying group. Mid-table
 * ties that change nothing are left alone, and ties the played decision
 * matches have already settled are no longer ties.
 */
export function detectGroupTies(state: TournamentState, groupId: string): GroupTie[] {
  const competition = state.radball;
  const group = competition?.groups[groupId];
  if (!group) return [];
  const rows = rankedGroupTable(state, groupId);
  if (rows.length < 2) return [];
  const ties: GroupTie[] = [];

  // Championship tie: any level-on-stats block at the top of a title group.
  const leader = rows[0];
  if (!leader) return [];
  if (isTitleGroup(state, groupId)) {
    const block = rows.filter((row) => sameLine(row, leader));
    if (block.length >= 2) {
      const tie: GroupTie = { groupId, teamIds: block.map((row) => row.teamId), context: 'title' };
      const resolution = resolveTie(state, groupId, tie);
      if (!resolution.resolved) {
        ties.push({ groupId, teamIds: resolution.pool, context: 'title' });
      }
    }
  }

  // Qualification cut: a block that straddles the cut line.
  if (group.qualifies > 0 && group.qualifies < rows.length) {
    const lastIn = rows[group.qualifies - 1];
    const firstOut = rows[group.qualifies];
    if (lastIn && firstOut && sameLine(lastIn, firstOut)) {
      const block = rows.filter((row) => sameLine(row, lastIn));
      const tie: GroupTie = { groupId, teamIds: block.map((row) => row.teamId), context: 'cut' };
      const resolution = resolveTie(state, groupId, tie);
      if (!resolution.resolved) {
        ties.push({ groupId, teamIds: resolution.pool, context: 'cut' });
      }
    }
  }
  return ties;
}

/**
 * Mini-table from finished matches played exclusively among `teamIds`:
 * group fixtures, plus the group's own decision matches when
 * `includeDecisions` is set (they never award table points, but they do
 * decide ties).
 */
export function headToHeadTable(
  state: TournamentState,
  groupId: string,
  teamIds: string[],
  includeDecisions = false,
): StandingRow[] {
  const wanted = new Set(teamIds);
  const rows = new Map<string, StandingRow>();
  for (const teamId of teamIds) {
    rows.set(teamId, {
      teamId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
      rank: 0,
      status: 'open',
      note: null,
    });
  }
  const win = state.radball?.config.winPoints ?? 3;
  const draw = state.radball?.config.drawPoints ?? 1;
  for (const match of Object.values(state.matches)) {
    const meta = match.radball;
    if (!meta || meta.groupId !== groupId) continue;
    if (meta.kind === 'decision') {
      if (!includeDecisions) continue;
    } else if (meta.kind !== 'group') {
      continue;
    }
    if (match.state !== 'FINISHED') continue;
    const a = match.participantAId;
    const b = match.participantBId;
    if (!a || !b || !wanted.has(a) || !wanted.has(b)) continue;
    const rowA = rows.get(a);
    const rowB = rows.get(b);
    if (!rowA || !rowB) continue;
    // §12/§13: a decision match decided on 4-meter shootout counts as a win
    // for the shootout winner in the mini-table, even though the official
    // score (e.g. 2:2) stays on the record.
    let effA = match.scoreA;
    let effB = match.scoreB;
    if (meta.kind === 'decision' && meta.shootout?.decided && meta.shootout.winnerId) {
      if (meta.shootout.winnerId === a) {
        effA = 1;
        effB = 0;
      } else {
        effA = 0;
        effB = 1;
      }
    }
    rowA.played += 1;
    rowB.played += 1;
    rowA.goalsFor += effA;
    rowA.goalsAgainst += effB;
    rowB.goalsFor += effB;
    rowB.goalsAgainst += effA;
    if (effA > effB) {
      rowA.won += 1;
      rowB.lost += 1;
      rowA.points += win;
    } else if (effA < effB) {
      rowB.won += 1;
      rowA.lost += 1;
      rowB.points += win;
    } else {
      rowA.drawn += 1;
      rowB.drawn += 1;
      rowA.points += draw;
      rowB.points += draw;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => compareRows(state, a, b));
  sorted.forEach((row, index) => {
    row.goalDiff = row.goalsFor - row.goalsAgainst;
    row.rank = index + 1;
  });
  return sorted;
}

/* ------------------------------------------------------------------ */
/* Tie resolution -- the official cascade                              */
/* ------------------------------------------------------------------ */

export interface TieResolution {
  /** True when the criteria chain (incl. decision matches) settles the boundary. */
  resolved: boolean;
  /** Decision matches the rules still demand, as team-id pairs. */
  pairs: [string, string][];
  /** Teams still inseparable and bound for those decision matches. */
  pool: string[];
}

/**
 * The official tie-break cascade for one tied set (§9/§10):
 *
 *   1. matches between the tied teams -- group fixtures *and* already played
 *      decision matches -- by points, goal difference, goals scored
 *   2. goal difference of the whole round (the group table)
 *   3. goals scored in the whole round
 *   4. decision match(es); a round-robin decision series when more than two
 *      teams remain inseparable
 *
 * `resolved` says whether the ranking boundary (championship or qualification
 * cut) is already decided. `pairs` lists the decision matches still required.
 * Nothing here ever picks a winner silently: an unresolved boundary always
 * comes back with at least one pair.
 */
export function resolveTie(state: TournamentState, groupId: string, tie: GroupTie): TieResolution {
  const group = state.radball?.groups[groupId];
  if (!group) return { resolved: true, pairs: [], pool: [] };
  // The raw table (no decision refinement) supplies the ranks here: calling
  // rankedGroupTable would recurse back into resolveTie for the same block.
  const rows = computeGroupTable(state, groupId);
  const rankOf = new Map(rows.map((row) => [row.teamId, row.rank]));
  const minRank = Math.min(...tie.teamIds.map((id) => rankOf.get(id) ?? Number.MAX_SAFE_INTEGER));
  // Title: one team must end up clearly first. Cut: the teams that take the
  // qualifying places must be clearly ahead of the first one missing out.
  const needed = tie.context === 'title' ? 1 : Math.max(1, group.qualifies - (minRank - 1));

  const keyOf = tieKeyFn(state, groupId, rows, tie.teamIds);
  const ordered = [...tie.teamIds].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i += 1) {
      const left = kb[i] ?? 0;
      const right = ka[i] ?? 0;
      if (left !== right) return left - right;
    }
    // Display-order fallback only -- never a sporting decision.
    return orderIndex(state, a) - orderIndex(state, b);
  });
  if (ordered.length <= needed) return { resolved: true, pairs: [], pool: [] };
  const lastIn = keyOf(ordered[needed - 1] ?? '');
  const firstOut = keyOf(ordered[needed] ?? '');
  if (lastIn.some((value, index) => value !== firstOut[index])) {
    return { resolved: true, pairs: [], pool: [] };
  }

  // Everyone still inseparable around the boundary must be played off.
  const pool = ordered.filter((teamId) => {
    const key = keyOf(teamId);
    return key.every((value, index) => value === lastIn[index]);
  });
  if (pool.length === 2) {
    const [a, b] = pool;
    if (a !== undefined && b !== undefined) return { resolved: false, pairs: [[a, b]], pool };
  }
  if (pool.length < 2) return { resolved: true, pairs: [], pool: [] };
  const pairs: [string, string][] = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i];
      const b = pool[j];
      if (a !== undefined && b !== undefined) pairs.push([a, b]);
    }
  }
  return { resolved: false, pairs, pool };
}

/**
 * The five-step cascade key for one team inside a tied set: head-to-head
 * (group fixtures *and* played decision matches) points, goal difference and
 * goals scored, then whole-round goal difference and goals scored.
 */
function tieKeyFn(
  state: TournamentState,
  groupId: string,
  rows: StandingRow[],
  teamIds: string[],
): (teamId: string) => number[] {
  const decisions = headToHeadTable(state, groupId, teamIds, true);
  const statOf = new Map(decisions.map((row) => [row.teamId, row]));
  return (teamId: string): number[] => {
    const d = statOf.get(teamId);
    const full = rows.find((row) => row.teamId === teamId);
    return [d?.points ?? 0, d?.goalDiff ?? 0, d?.goalsFor ?? 0, full?.goalDiff ?? 0, full?.goalsFor ?? 0];
  };
}

/**
 * The official ranking of one group: the raw table (points, goal difference,
 * goals scored) with one refinement -- a block of tied teams whose boundary
 * has been settled by played decision matches is re-ordered by the full
 * cascade key, so the team that won its decision match really sits above the
 * one that lost. Blocks with decisions still pending keep the raw order
 * (display only -- they are marked `tied`, never silently ranked).
 */
export function rankedGroupTable(state: TournamentState, groupId: string): StandingRow[] {
  // Always derived fresh from the fixtures -- never from the cached table,
  // or a corrected result could keep ranking against yesterday's numbers.
  const rows = computeGroupTable(state, groupId).map((row) => ({ ...row }));
  if (rows.length < 2) return rows;
  let changed = false;
  let index = 0;
  while (index < rows.length) {
    let end = index + 1;
    const anchor = rows[index];
    if (!anchor) break;
    while (end < rows.length && sameLine(anchor, rows[end] as StandingRow)) end += 1;
    const block = rows.slice(index, end);
    if (block.length >= 2) {
      const teamIds = block.map((row) => row.teamId);
      const context: 'title' | 'cut' =
        isTitleGroup(state, groupId) && index === 0 ? 'title' : 'cut';
      const resolution = resolveTie(state, groupId, { groupId, teamIds, context });
      if (resolution.resolved) {
        const keyOf = tieKeyFn(state, groupId, rows, teamIds);
        block.sort((a, b) => {
          const ka = keyOf(a.teamId);
          const kb = keyOf(b.teamId);
          for (let i = 0; i < ka.length; i += 1) {
            if ((kb[i] ?? 0) !== (ka[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
          }
          return orderIndex(state, a.teamId) - orderIndex(state, b.teamId);
        });
        rows.splice(index, block.length, ...block);
        changed = true;
      }
    }
    index = end;
  }
  if (changed) rows.forEach((row, position) => (row.rank = position + 1));
  return rows;
}

/* ------------------------------------------------------------------ */
/* Decision matches                                                   */
/* ------------------------------------------------------------------ */

export function decisionScopeMatches(
  state: TournamentState,
  phaseId: string,
  groupId: string | null,
): Match[] {
  return Object.values(state.matches).filter(
    (match) =>
      match.radball?.kind === 'decision' &&
      match.radball.phaseId === phaseId &&
      (groupId === null || match.radball.groupId === groupId),
  );
}

function autoDecisionKey(teamAId: string, teamBId: string): string {
  return [teamAId, teamBId].sort().join('|');
}

export function createDecisionMatch(
  state: TournamentState,
  opts: {
    phaseId: string;
    groupId: string | null;
    teamAId: string;
    teamBId: string;
    reason: string;
  },
  ctx: Ctx,
  mut: Mutation,
): Match {
  const tournament = state.tournament;
  const competition = state.radball;
  if (!tournament || !competition) throw new EngineError('NO_TOURNAMENT', 'No Radball competition is loaded.');
  if (!state.participants[opts.teamAId] || !state.participants[opts.teamBId]) {
    throw new EngineError('PARTICIPANT_NOT_FOUND', 'One of the decision-match teams no longer exists.');
  }
  competition.decisionSeq += 1;
  const durationSec = radballDecisionSec(competition.config);
  const match = makeRadballMatch({
    tournamentId: tournament.id,
    id: `${tournament.id}:dec:${competition.decisionSeq}`,
    phaseId: opts.phaseId,
    groupId: opts.groupId,
    kind: 'decision',
    matchType: null,
    semiNumber: null,
    dependsOn: 'none',
    roundName: 'Decision match',
    round: 900,
    position: competition.decisionSeq,
    teamAId: opts.teamAId,
    teamBId: opts.teamBId,
    durationSec,
    periodCount: 1,
    requiresWinner: true,
    decisionReason: opts.reason,
    locked: true,
    ctx,
  });
  insertMatch(state, match, mut);
  mut.radball = true;
  pushEvent(
    mut,
    'DECISION_MATCH_CREATED',
    {
      key: 'event.decisionMatchCreated',
      params: {
        a: participantName(state, opts.teamAId),
        b: participantName(state, opts.teamBId),
        reason: opts.reason,
      },
    },
    { matchId: match.id },
  );
  return match;
}

/**
 * Sync the group's decision matches with the official cascade (`resolveTie`):
 * two teams always play off; three or more go through the head-to-head
 * mini-table (incl. played decisions), then full-round criteria, then a
 * round-robin decision series when nothing separates them. Never silently
 * picks a winner.
 */
export function ensureTieDecision(
  state: TournamentState,
  groupId: string,
  tie: GroupTie,
  ctx: Ctx,
  mut: Mutation,
): void {
  const group = state.radball?.groups[groupId];
  if (!group) return;
  const reason = tie.context === 'title' ? 'CHAMPIONSHIP_TIE' : 'QUALIFICATION_TIE';
  const required = new Set(resolveTie(state, groupId, tie).pairs.map(([a, b]) => autoDecisionKey(a, b)));

  // Create what is missing, retire auto-created pairings that are no longer
  // required (a finished or running decision is always left alone).
  const existing = decisionScopeMatches(state, group.phaseId, groupId).filter(
    (match) => match.radball?.decisionReason !== 'MANUAL' && match.state !== 'FINISHED' && match.state !== 'CANCELLED',
  );
  for (const match of existing) {
    const key = autoDecisionKey(match.participantAId ?? '', match.participantBId ?? '');
    if (!required.has(key) && match.state !== 'RUNNING' && match.state !== 'PAUSED' && match.state !== 'HALFTIME') {
      match.state = 'CANCELLED';
      touchMatch(mut, match.id);
      pushEvent(
        mut,
        'MATCH_CANCELLED',
        { key: 'event.decisionMatchSuperseded', params: { round: match.roundName } },
        { matchId: match.id },
      );
    }
  }
  for (const key of required) {
    const already = existing.some(
      (match) => autoDecisionKey(match.participantAId ?? '', match.participantBId ?? '') === key,
    );
    if (already) continue;
    const [a, b] = key.split('|');
    if (a === undefined || b === undefined) continue;
    createDecisionMatch(state, { phaseId: group.phaseId, groupId, teamAId: a, teamBId: b, reason }, ctx, mut);
  }
}

/* ------------------------------------------------------------------ */
/* 4-meter shootout                                                   */
/* ------------------------------------------------------------------ */

function shootoutHits(shootout: ShootoutState, side: 'A' | 'B', regulationOnly: boolean): number {
  let hits = 0;
  for (const attempt of shootout.attempts) {
    if (attempt.side !== side) continue;
    if (regulationOnly && attempt.suddenDeath) continue;
    if (attempt.hit) hits += 1;
  }
  return hits;
}

function shootoutThrown(shootout: ShootoutState, side: 'A' | 'B', regulationOnly: boolean): number {
  let count = 0;
  for (const attempt of shootout.attempts) {
    if (attempt.side !== side) continue;
    if (regulationOnly && attempt.suddenDeath) continue;
    count += 1;
  }
  return count;
}

function evaluateShootout(state: TournamentState, match: Match): void {
  const shootout = match.radball?.shootout;
  if (!shootout || shootout.decided) return;
  const perTeam = shootout.attemptsPerTeam;
  const hitsA = shootoutHits(shootout, 'A', false);
  const hitsB = shootoutHits(shootout, 'B', false);
  const thrownA = shootoutThrown(shootout, 'A', false);
  const thrownB = shootoutThrown(shootout, 'B', false);
  const regulationDone = thrownA >= perTeam && thrownB >= perTeam;
  let winner: string | null = null;
  if (!regulationDone) {
    // Early decision inside regulation when a side cannot be caught anymore.
    const regA = shootoutHits(shootout, 'A', true);
    const regB = shootoutHits(shootout, 'B', true);
    const thrownRegA = shootoutThrown(shootout, 'A', true);
    const thrownRegB = shootoutThrown(shootout, 'B', true);
    if (regA > regB + (perTeam - thrownRegB)) winner = match.participantAId;
    else if (regB > regA + (perTeam - thrownRegA)) winner = match.participantBId;
  } else if (hitsA !== hitsB && thrownA === thrownB) {
    // End of regulation with a leader, or a completed sudden-death pair.
    winner = hitsA > hitsB ? match.participantAId : match.participantBId;
  }
  if (winner) {
    shootout.decided = true;
    shootout.winnerId = winner;
    shootout.finishedAt = Date.now();
  }
  void state;
}

/**
 * True when this match can be settled at the 4-metre line: a decision match of
 * any Radball format, or a ten-team final-phase match whose ruleset says so.
 */
function allowsShootout(state: TournamentState, match: Match): boolean {
  const meta = match.radball;
  if (!meta) return false;
  if (meta.kind === 'decision') return true;
  if (meta.matchType === null) return false;
  return requiresShootout(state, match);
}

export function recordShootoutAttempt(
  state: TournamentState,
  matchId: string,
  side: 'A' | 'B',
  shooter: number,
  hit: boolean,
  ctx: Ctx,
  mut: Mutation,
): ShootoutState {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('MATCH_NOT_FOUND', 'That match no longer exists.');
  const meta = match.radball;
  if (!meta || !allowsShootout(state, match)) {
    throw new EngineError('BAD_REQUEST', 'Shootouts only exist on decision and final-phase matches.');
  }
  if (match.state === 'FINISHED' || match.state === 'CANCELLED') {
    throw new EngineError('INVALID_STATE', 'This decision match is already closed.');
  }
  if (!meta.shootout) {
    meta.shootout = {
      attemptsPerTeam: state.radball?.config.shootoutAttempts ?? 4,
      attempts: [],
      decided: false,
      winnerId: null,
      startedAt: ctx.now,
      finishedAt: null,
    };
    pushEvent(mut, 'SHOOTOUT_STARTED', { key: 'event.shootoutStarted', params: { round: match.roundName } }, {
      matchId,
    });
  }
  const shootout = meta.shootout;
  if (shootout.decided) throw new EngineError('INVALID_STATE', 'This shootout is already decided.');
  const expectedSide = shootout.attempts.length % 2 === 0 ? 'A' : 'B';
  if (side !== expectedSide) {
    throw new EngineError('BAD_REQUEST', `The next attempt belongs to team ${expectedSide}. Teams alternate.`);
  }
  const suddenDeath = shootout.attempts.length >= shootout.attemptsPerTeam * 2;
  shootout.attempts.push({ side, shooter, hit, suddenDeath });
  touchMatch(mut, match.id);
  mut.radball = true;
  mut.urgency = 'immediate';
  evaluateShootout(state, match);
  if (shootout.decided) {
    pushEvent(
      mut,
      'SHOOTOUT_FINISHED',
      { key: 'event.shootoutDecided', params: { winner: participantName(state, shootout.winnerId) } },
      { matchId, data: { winnerId: shootout.winnerId } },
    );
    notify(mut, 'info', { key: 'notify.shootoutWon', params: { winner: participantName(state, shootout.winnerId) } });
  }
  return shootout;
}

export function resetShootout(state: TournamentState, matchId: string, ctx: Ctx, mut: Mutation): void {
  const match = state.matches[matchId];
  if (!match?.radball || !allowsShootout(state, match)) {
    throw new EngineError('BAD_REQUEST', 'Shootouts only exist on decision and final-phase matches.');
  }
  if (match.state === 'FINISHED') {
    throw new EngineError('INVALID_STATE', 'Reset the match before clearing its shootout.');
  }
  match.radball.shootout = null;
  touchMatch(mut, match.id);
  mut.radball = true;
  mut.urgency = 'immediate';
  pushEvent(mut, 'SHOOTOUT_STARTED', { key: 'event.shootoutCleared', params: { round: match.roundName } }, {
    matchId,
  });
  void ctx;
}

/* ------------------------------------------------------------------ */
/* Qualification & phases                                             */
/* ------------------------------------------------------------------ */

/** Unfinished decision matches in a phase scope block progress. */
export function pendingDecisions(state: TournamentState, phaseId: string): Match[] {
  return decisionScopeMatches(state, phaseId, null).filter(
    (match) => match.state !== 'FINISHED' && match.state !== 'CANCELLED',
  );
}

function finalPhaseExists(state: TournamentState): boolean {
  return Object.values(state.radball?.phases ?? {}).some((phase) => phase.kind === 'final-round');
}

/**
 * Carry qualified teams into the final round (created once, then reused).
 * Throws when groups are incomplete or ties are still unresolved.
 */
export function runQualification(
  state: TournamentState,
  ctx: Ctx,
  mut: Mutation,
  onlyPhaseId?: string,
): string[] {
  const competition = state.radball;
  const tournament = state.tournament;
  if (!tournament || !competition) throw new EngineError('NO_TOURNAMENT', 'No Radball competition is loaded.');
  if (competition.ten) {
    throw new EngineError(
      'BAD_REQUEST',
      'The 10-team format has its own fixed final phase. Use "Generate final phase" once the preliminary round is complete.',
    );
  }
  if (!competition.pendingFinal) throw new EngineError('BAD_REQUEST', 'This competition plans no final round.');
  if (finalPhaseExists(state)) return [];

  const created: string[] = [];
  const entryPhases = competition.phaseOrder
    .map((id) => competition.phases[id])
    .filter(
      (phase): phase is RadballPhase =>
        phase !== undefined && (phase.kind === 'group-stage' || phase.kind === 'round-robin'),
    );
  const scope = onlyPhaseId ? entryPhases.filter((phase) => phase.id === onlyPhaseId) : entryPhases;
  if (scope.length === 0) throw new EngineError('BAD_REQUEST', 'No group phase to qualify from.');

  const qualifiers: { teamId: string; fromGroupId: string }[] = [];
  for (const phase of scope) {
    if (pendingDecisions(state, phase.id).length > 0) {
      throw new EngineError('INVALID_STATE', `Unresolved decision matches in ${phase.name}. Play them first.`);
    }
    for (const groupId of phase.groupIds) {
      const group = competition.groups[groupId];
      if (!group) continue;
      if (!groupComplete(state, groupId)) {
        throw new EngineError('INVALID_STATE', `Group ${group.name} is not finished yet.`);
      }
      const rows = rankedGroupTable(state, groupId);
      const cut = rows.filter((row) => row.status === 'tied');
      if (cut.length > 0) {
        throw new EngineError('INVALID_STATE', `Group ${group.name} still has an unresolved tie.`);
      }
      for (const row of rows.slice(0, group.qualifies)) {
        qualifiers.push({ teamId: row.teamId, fromGroupId: groupId });
      }
    }
  }
  if (qualifiers.length < 2) {
    throw new EngineError('BAD_REQUEST', 'Fewer than 2 teams qualified. Check the qualifies counts.');
  }

  const order = competition.phaseOrder.length;
  const phase: RadballPhase = {
    id: `${tournament.id}:rphase:final`,
    kind: 'final-round',
    name: 'Final round',
    order,
    groupIds: [],
    qualification: { fromPhaseId: scope.map((p) => p.id).join('+'), places: qualifiers.length },
    status: 'RUNNING',
  };
  competition.phases[phase.id] = phase;
  competition.phaseOrder.push(phase.id);

  const teamIds = qualifiers.map((entry) => entry.teamId);
  const mode = competition.pendingFinal.mode;
  const durationSec = radballMatchSec(competition.config);
  if (mode === 'round-robin') {
    const gid = `${tournament.id}:rgroup:final:0`;
    competition.groups[gid] = {
      id: gid,
      phaseId: phase.id,
      name: 'Final round',
      teamIds: [...teamIds],
      doubleRoundRobin: false,
      qualifies: 0,
      fieldId: null,
    };
    competition.groupOrder.push(gid);
    phase.groupIds.push(gid);
    let position = 0;
    for (const fixture of roundRobinFixtures(teamIds, false)) {
      insertMatch(
        state,
        makeRadballMatch({
          tournamentId: tournament.id,
          id: `${tournament.id}:rf:final:r${fixture.round}p${position}`,
          phaseId: phase.id,
          groupId: gid,
          kind: 'group',
          matchType: null,
          semiNumber: null,
          dependsOn: 'none',
          roundName: `Final Round · Round ${fixture.round + 1}`,
          round: fixture.round,
          position,
          teamAId: fixture.teamA,
          teamBId: fixture.teamB,
          durationSec,
          periodCount: 2,
          requiresWinner: false,
          decisionReason: null,
          locked: true,
          ctx,
        }),
        mut,
      );
      position += 1;
    }
  } else {
    // Ranking matches: 1st vs 2nd final, 3rd vs 4th third place, then pairs.
    const gid = `${tournament.id}:rgroup:final:0`;
    competition.groups[gid] = {
      id: gid,
      phaseId: phase.id,
      name: 'Finals',
      teamIds: [...teamIds],
      doubleRoundRobin: false,
      qualifies: 0,
      fieldId: null,
    };
    competition.groupOrder.push(gid);
    phase.groupIds.push(gid);
    const labels = ['Final', '3rd Place Match', '5th Place Match', '7th Place Match'];
    for (let pair = 0; pair * 2 + 1 < teamIds.length && pair < labels.length; pair += 1) {
      const kind = pair === 0 ? 'final' : 'placement';
      insertMatch(
        state,
        makeRadballMatch({
          tournamentId: tournament.id,
          id: `${tournament.id}:rf:final:m${pair}`,
          phaseId: phase.id,
          groupId: pair === 0 ? null : gid,
          kind,
          matchType: null,
          semiNumber: null,
          dependsOn: 'none',
          roundName: labels[pair] ?? 'Final round',
          round: 900,
          position: pair,
          // The loop condition guarantees both indexes are in range.
          teamAId: teamIds[pair * 2] ?? '',
          teamBId: teamIds[pair * 2 + 1] ?? '',
          durationSec,
          periodCount: 2,
          requiresWinner: true,
          decisionReason: null,
          locked: true,
          ctx,
        }),
        mut,
      );
      created.push(`${tournament.id}:rf:final:m${pair}`);
    }
  }

  for (const entry of scope) {
    entry.status = 'COMPLETED';
  }
  mut.radball = true;
  pushEvent(
    mut,
    'QUALIFICATION_UPDATED',
    {
      key: 'event.qualifiedForFinal',
      params: { teams: qualifiers.map((entry) => participantName(state, entry.teamId)).join(', ') },
    },
  );
  pushEvent(mut, 'TOURNAMENT_PHASE_UPDATED', { key: 'event.finalRoundCreated' });
  return created;
}

/* ------------------------------------------------------------------ */
/* Central recalculation                                              */
/* ------------------------------------------------------------------ */

function tablesEqual(a: StandingRow[], b: StandingRow[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Recompute every table and re-evaluate ties, qualification marks, phase
 * statuses and the champion. Runs server-side after each result change, so a
 * corrected score rolls every dependent standing forward again (§30).
 */
export function recalculateRadball(state: TournamentState, ctx: Ctx, mut: Mutation): void {
  const tournament = state.tournament;
  const competition = state.radball;
  if (!tournament || tournament.format !== 'radball' || !competition) return;

  // The 10-team format freezes each group's ranking once all ten of its fixtures
  // are decided and then hands those five positions to a fixed final phase. The
  // generic tie machinery below would answer that by *spawning decision matches*
  // -- extra fixtures outside the documented 26, re-ordering a ranking that is
  // supposed to be settled, and capable of renaming a semifinal's participants
  // after the semifinal was played. So it is skipped: the 10-team chain owns the
  // whole downstream of a group result instead.
  if (competition.ten) {
    const anyFinished = competition.groupOrder.some((groupId) => groupHasFinishedFixtures(state, groupId));
    let tablesChanged = false;
    for (const groupId of competition.groupOrder) {
      const rows = rankedGroupTable(state, groupId);
      if (!tablesEqual(rows, competition.tables[groupId] ?? [])) {
        competition.tables[groupId] = rows;
        tablesChanged = true;
      }
    }
    if (tablesChanged) {
      mut.radball = true;
      mut.urgency = 'immediate';
      if (anyFinished) pushEvent(mut, 'STANDINGS_UPDATED', { key: 'event.groupStandingsRecalculated' });
    }
    syncRadball10(state, ctx, mut);
    // The published rankings may have just filled (or emptied) group-rank slots,
    // so the dependency chain has to be walked again before anyone reads a team
    // name off a final-phase match.
    resolveBracket(state, ctx, mut);
    return;
  }

  let tablesChanged = false;
  let anyFinished = false;
  for (const groupId of competition.groupOrder) {
    if (groupHasFinishedFixtures(state, groupId)) anyFinished = true;
    // Ranked order (decision-settled blocks re-sorted) is what every consumer
    // -- qualification, champion, UI -- reads; recompute before marking ties.
    const rows = rankedGroupTable(state, groupId);
    if (!tablesEqual(rows, competition.tables[groupId] ?? [])) {
      competition.tables[groupId] = rows;
      tablesChanged = true;
    }
  }
  if (tablesChanged) {
    mut.radball = true;
    mut.urgency = 'immediate';
    if (anyFinished) {
      pushEvent(mut, 'STANDINGS_UPDATED', { key: 'event.standingsRecalculated' });
    }
  }

  // Qualification marks + tie flags on every row.
  const previousStatuses = new Map<string, string>();
  for (const groupId of competition.groupOrder) {
    for (const row of competition.tables[groupId] ?? []) {
      previousStatuses.set(`${groupId}|${row.teamId}`, `${row.status}|${row.note ?? ''}`);
    }
  }
  const tiedKeys = new Set<string>();
  for (const groupId of competition.groupOrder) {
    for (const tie of detectGroupTies(state, groupId)) {
      for (const teamId of tie.teamIds) tiedKeys.add(`${groupId}|${teamId}`);
    }
  }
  let marksChanged = false;
  for (const groupId of competition.groupOrder) {
    const group = competition.groups[groupId];
    if (!group) continue;
    const complete = groupComplete(state, groupId);
    for (const row of competition.tables[groupId] ?? []) {
      const key = `${groupId}|${row.teamId}`;
      let status = row.status;
      let note = row.note;
      if (tiedKeys.has(key)) {
        status = 'tied';
        note = complete ? 'Decision match required' : 'Currently tied';
      } else if (!complete) {
        status = 'open';
        note = null;
      } else if (group.qualifies > 0) {
        status = row.rank <= group.qualifies ? 'qualified' : 'eliminated';
        note = null;
      } else if (isTitleGroup(state, groupId)) {
        status = row.rank === 1 ? 'qualified' : 'eliminated';
        note = null;
      } else {
        status = row.rank === 1 ? 'qualified' : 'eliminated';
        note = null;
      }
      if (status !== row.status || (note ?? '') !== (row.note ?? '')) {
        row.status = status;
        row.note = note;
        marksChanged = true;
      }
    }
  }
  if (marksChanged) {
    mut.radball = true;
    mut.urgency = 'immediate';
  }
  // Transition events: teams newly qualified or eliminated, fresh ties.
  const advanced: string[] = [];
  const out: string[] = [];
  let freshTie = false;
  for (const groupId of competition.groupOrder) {
    for (const row of competition.tables[groupId] ?? []) {
      const key = `${groupId}|${row.teamId}`;
      const before = previousStatuses.get(key) ?? 'open|';
      const after = `${row.status}|${row.note ?? ''}`;
      if (before === after) continue;
      if (row.status === 'qualified' && groupComplete(state, groupId)) advanced.push(row.teamId);
      if (row.status === 'eliminated' && groupComplete(state, groupId)) out.push(row.teamId);
      if (row.status === 'tied' && !before.startsWith('tied')) freshTie = true;
    }
  }
  if (advanced.length > 0) {
    pushEvent(mut, 'TEAM_ADVANCED', {
      key: 'event.qualified',
      params: { teams: advanced.map((id) => participantName(state, id)).join(', ') },
    });
  }
  if (out.length > 0) {
    pushEvent(mut, 'TEAM_ELIMINATED', {
      key: 'event.eliminated',
      params: { teams: out.map((id) => participantName(state, id)).join(', ') },
    });
  }
  if (freshTie) {
    pushEvent(mut, 'TIE_DETECTED', { key: 'event.tieDetected' });
  }

  // Automatic decision matches for completed groups with real ties.
  for (const groupId of competition.groupOrder) {
    if (!groupComplete(state, groupId)) continue;
    for (const tie of detectGroupTies(state, groupId)) {
      ensureTieDecision(state, groupId, tie, ctx, mut);
    }
  }

  // Automatic qualification into a planned final round.
  if (competition.pendingFinal && !finalPhaseExists(state)) {
    try {
      runQualification(state, ctx, mut);
    } catch {
      // Not eligible yet (groups open or ties pending) -- retry on the next result.
    }
  }

  // Champion: final round decided, or a lone group with a clear winner.
  const pending = competition.phaseOrder.some((id) => pendingDecisions(state, id).length > 0);
  let champion: string | null = null;
  if (!pending) {
    const finalPhase = competition.phaseOrder
      .map((id) => competition.phases[id])
      .find((phase) => phase?.kind === 'final-round');
    if (finalPhase) {
      const finalMatch = Object.values(state.matches).find(
        (match) => match.radball?.phaseId === finalPhase.id && match.radball.kind === 'final' && match.state === 'FINISHED',
      );
      if (finalMatch?.winnerId) {
        champion = finalMatch.winnerId;
      } else {
        const tableGroup = finalPhase.groupIds.map((gid) => competition.tables[gid] ?? []).find((rows) => rows.length > 0);
        const complete = finalPhase.groupIds.every((gid) => groupComplete(state, gid));
        if (tableGroup && complete && tableGroup[0] && !tiedKeys.has(`${finalPhase.groupIds[0]}|${tableGroup[0].teamId}`)) {
          champion = tableGroup[0].teamId;
        }
      }
    } else if (!competition.pendingFinal) {
      const titles = competition.groupOrder.filter((gid) => isTitleGroup(state, gid));
      const titleGroupId = titles[0];
      if (titles.length === 1 && titleGroupId && groupComplete(state, titleGroupId)) {
        const rows = competition.tables[titleGroupId] ?? [];
        const leader = rows[0];
        if (leader && !tiedKeys.has(`${titleGroupId}|${leader.teamId}`)) champion = leader.teamId;
      }
    }
  }
  if (champion !== competition.championId) {
    competition.championId = champion;
    mut.radball = true;
  }
  if (champion && tournament.championId !== champion) {
    tournament.championId = champion;
    tournament.status = 'COMPLETED';
    tournament.completedAt = ctx.now;
    mut.tournament = true;
    pushEvent(mut, 'TOURNAMENT_UPDATED', { key: 'event.champion', params: { name: participantName(state, champion) } });
    notify(mut, 'info', { key: 'notify.champion', params: { name: participantName(state, champion) } });
  } else if (!champion && tournament.status === 'COMPLETED') {
    tournament.status = 'RUNNING';
    tournament.championId = null;
    tournament.completedAt = null;
    mut.tournament = true;
  }
}

/* ------------------------------------------------------------------ */
/* Availability: no team on two fields, optional rest time            */
/* ------------------------------------------------------------------ */

/** Non-finished matches a team is currently involved in. */
export function teamLiveMatches(state: TournamentState, teamId: string): Match[] {
  return Object.values(state.matches).filter(
    (match) =>
      (match.state === 'ASSIGNED' || match.state === 'RUNNING' || match.state === 'PAUSED' || match.state === 'HALFTIME') &&
      (match.participantAId === teamId || match.participantBId === teamId),
  );
}

/** A live match of this team on another field (server-side double-booking guard). */
export function teamBusyOnOtherField(state: TournamentState, teamId: string, fieldId: FieldId): Match | null {
  return (
    teamLiveMatches(state, teamId).find((match) => match.fieldId !== null && match.fieldId !== fieldId) ?? null
  );
}

function lastFinishOf(state: TournamentState, teamId: string): number | null {
  let last: number | null = null;
  for (const match of Object.values(state.matches)) {
    if (match.state !== 'FINISHED' || !match.finishedAt) continue;
    if (match.participantAId !== teamId && match.participantBId !== teamId) continue;
    if (last === null || match.finishedAt > last) last = match.finishedAt;
  }
  return last;
}

/** Rest-time rule for the automatic scheduler (manual assignment stays free). */
export function restOk(state: TournamentState, teamId: string, now: number): boolean {
  const minutes = state.radball?.config.minRestMinutes ?? 0;
  if (minutes <= 0) return true;
  const last = lastFinishOf(state, teamId);
  if (last === null) return true;
  return now - last >= minutes * 60_000;
}

/** A match the automatic scheduler may put on `fieldId` right now. */
export function schedulableOn(
  state: TournamentState,
  match: Match,
  fieldId: FieldId,
  now: number,
): boolean {
  for (const teamId of [match.participantAId, match.participantBId]) {
    if (!teamId) return false;
    if (teamBusyOnOtherField(state, teamId, fieldId)) return false;
    if (state.tournament?.format === 'radball' && !restOk(state, teamId, now)) return false;
  }
  return true;
}

