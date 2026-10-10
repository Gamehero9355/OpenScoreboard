/**
 * Demo mode -- builds a complete, playable tournament in one call so a new user
 * can see two live fields, a bracket, the scoreboard and a QR code within
 * seconds of installing the app. Deterministic on purpose: the same demo is
 * produced every time, which also makes it useful in tests.
 */
import type { TournamentState } from '../../shared/types';
import { generateBracketForTournament, createTournament } from './engine';
import { assignMatchToField, autoAssign, getNextAvailableMatch } from './matchops';
import { addParticipant } from './engine';
import type { Ctx, Mutation } from './state';

export const DEMO_NAMES = [
  'Team Alpha',
  'Team Bravo',
  'Team Charlie',
  'Team Delta',
  'Team Echo',
  'Team Foxtrot',
  'Team Golf',
  'Team Hotel',
];

export interface DemoOptions {
  name?: string;
  /** Assign the first two playable matches to the two fields. */
  autoStartFields?: boolean;
}

export function buildDemoTournament(
  state: TournamentState,
  ctx: Ctx,
  mut: Mutation,
  options: DemoOptions = {},
): void {
  const name = options.name ?? 'Demo Championship';
  state.settings.fieldNames = ['Field 1', 'Field 2'];
  state.settings.defaultMatchDurationSec = 180;
  state.settings.timerMode = 'down';
  state.settings.scoringIncrements = [1, 2, 3];
  state.settings.autoLoadNext = true;
  // The demo shows the full workflow, so a finished match immediately puts the
  // next queued match on the field that just freed up.
  state.settings.autoAssignNext = true;

  const fieldCount = state.settings.fieldNames.length > 0 ? state.settings.fieldNames.length : 2;

  createTournament(
    state,
    {
      name,
      format: 'single-elimination',
      participants: DEMO_NAMES.map((participantName, index) => ({
        name: participantName,
        team: null,
        seed: null,
        checkedIn: true,
        // Deal the demo roster across the fields (round-robin, so the top
        // seeds are spread). Every field then owns half of the bracket and
        // gets a real queue of its own -- the whole point of the demo.
        fieldId: String((index % fieldCount) + 1),
      })),
      thirdPlaceMatch: true,
      seeded: true,
      seedValue: 20260921,
      settings: null,
      generateBracketNow: true,
    },
    ctx,
    mut,
  );

  if (options.autoStartFields !== false) {
    // Fill as many fields as the demo bracket can serve (two for the
    // default two-field setup, fewer when the bracket is small). Generating the
    // bracket already pre-loaded them, so only genuinely free fields are filled
    // here -- never over the top of a match that is already sitting there.
    for (const fieldId of Object.keys(state.fields).sort((a, b) => Number(a) - Number(b))) {
      const field = state.fields[fieldId];
      if (!field || field.matchId) continue;
      const next = getNextAvailableMatch(state, fieldId);
      if (!next) continue;
      assignMatchToField(state, next.id, fieldId, ctx, mut);
    }
  }
  mut.urgency = 'immediate';
}

/**
 * A Radball 2er squad. Typed as a two-tuple rather than `string[]` because a
 * squad *is* two players -- the length is part of the domain rule, not a
 * runtime detail, so the roster builder below can read both slots directly.
 */
export interface DemoRadballTeam {
  name: string;
  club?: string;
  players: [string, string];
}

export const RADBALL_DEMO_TEAMS: DemoRadballTeam[] = [
  { name: 'RV Gärtringen I', club: 'RV Gärtringen', players: ['Max Mustermann', 'Alexander Muster'] },
  { name: 'RV Gärtringen II', club: 'RV Gärtringen', players: ['Jonas Beispiel', 'Fabian Probe'] },
  { name: 'RV Böblingen I', club: 'RV Böblingen', players: ['Leon Radler', 'Nico Satteil'] },
  { name: 'RV Sindelfingen', club: 'RV Sindelfingen', players: ['Tim Ball', 'Jan Sattel'] },
  { name: 'RV Holzgerlingen', club: 'RV Holzgerlingen', players: ['Erik Reifen', 'Paul Pedal'] },
];

/**
 * Radball demo: the BDR championship preset (5 teams, single round robin,
 * final + third-place ranking matches). Deterministic, so tests can use it.
 */
export function buildRadballDemo(
  state: TournamentState,
  ctx: Ctx,
  mut: Mutation,
  options: { name?: string } = {},
): void {
  state.settings.fieldNames = ['Field 1', 'Field 2'];
  state.settings.autoLoadNext = true;
  state.settings.autoAssignNext = true;
  state.settings.allowDraws = true; // group fixtures may draw in Radball

  createTournament(
    state,
    {
      name: options.name ?? 'BDR Deutsche Meisterschaft 2er-Radball Elite',
      format: 'radball',
      participants: RADBALL_DEMO_TEAMS.map((team) => ({
        name: team.name,
        team: team.club ?? null,
        seed: null,
        checkedIn: true,
        players: [team.players[0], team.players[1]],
      })),
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracketNow: true,
      radball: {
        ageCategory: 'ELITE',
        preset: 'bdr-elite-2025',
      },
    },
    ctx,
    mut,
  );

  // Pre-load the fields exactly like the knockout demo does.
  autoAssign(state, ctx, mut);
  mut.urgency = 'immediate';
}

/**
 * The 10-team demo: the documented UCI World Cup shape with ten plain teams,
 * Group A on Field 1 and Group B on Field 2. Deterministic, so the acceptance
 * tests can run a whole tournament through it and assert on the real engine
 * rather than on hand-written state.
 *
 * The teams are *registered* on the field they play in, because that is the
 * split: the first five go on Field 1 (Group A) and the last five on Field 2
 * (Group B). Writing it any other way would describe a group assignment the
 * format no longer has.
 */
export const RADBALL10_DEMO_TEAMS: DemoRadballTeam[] = [
  { name: 'Team A', players: ['Anna Radler', 'Bert Radball'] },
  { name: 'Team B', players: ['Carla Kugel', 'Dirk Kugel'] },
  { name: 'Team C', players: ['Eva Bande', 'Finn Bande'] },
  { name: 'Team D', players: ['Greta Schuss', 'Hannes Schuss'] },
  { name: 'Team E', players: ['Ida Vorwaerts', 'Jann Vorwaerts'] },
  { name: 'Team F', players: ['Kim Rueckspiel', 'Lars Rueckspiel'] },
  { name: 'Team G', players: ['Mia Achter', 'Noah Achter'] },
  { name: 'Team H', players: ['Olga Tordere', 'Paul Tordere'] },
  { name: 'Team I', players: ['Quirin Linie', 'Rune Linie'] },
  { name: 'Team J', players: ['Sina Kurve', 'Till Kurve'] },
];

export function buildRadball10Demo(
  state: TournamentState,
  ctx: Ctx,
  mut: Mutation,
  options: { name?: string } = {},
): void {
  state.settings.fieldNames = ['Field 1', 'Field 2'];
  state.settings.autoLoadNext = true;
  state.settings.autoAssignNext = true;
  state.settings.allowDraws = true;

  createTournament(
    state,
    {
      name: options.name ?? 'Radball World Cup · 10 teams',
      format: 'radball',
      participants: RADBALL10_DEMO_TEAMS.map((team, index) => ({
        name: team.name,
        team: null,
        seed: null,
        checkedIn: true,
        players: [team.players[0], team.players[1]],
        fieldId: index < RADBALL10_DEMO_TEAMS.length / 2 ? '1' : '2',
      })),
      thirdPlaceMatch: false,
      seeded: true,
      seedValue: null,
      settings: null,
      generateBracketNow: true,
      radball: {
        ageCategory: 'ELITE',
        preset: 'radball-10-team',
      },
    },
    ctx,
    mut,
  );

  // Group A's opening fixture onto Field 1, Group B's onto Field 2, so the demo
  // opens with one match per field exactly as a real event does.
  autoAssign(state, ctx, mut);
  mut.urgency = 'immediate';
}

export { addParticipant, generateBracketForTournament };
