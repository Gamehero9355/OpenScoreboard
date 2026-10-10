/**
 * Built-in example setups.
 *
 * These are not on the host's shelf and cannot be renamed or deleted: they ship
 * with the app so that a fresh install has something to load on the way to
 * understanding the software. Each one is a plain `SavedTournamentSetup`, the
 * exact shape the shelf stores, so loading one is the same code path as loading
 * something the host filed themselves -- it fills the wizard and still goes
 * through review.
 */
import type { SavedTournamentSetup } from './types';

export interface ExampleSetup {
  id: string;
  /** The card heading. */
  name: string;
  /** One sentence on what this example is for. */
  description: string;
  setup: SavedTournamentSetup;
}

/**
 * The 10-team Radball World Cup: the fullest format the scoreboard has, and the
 * one that exercises both fields at once.
 *
 * Five 2er teams sit on field 1 and five on field 2. That *is* the split: the
 * format plays one group per field, so the field 1 roster is Group A and the
 * field 2 roster is Group B. Twenty group fixtures run first, then a fixed final
 * phase decides places 1-10: 27 matches in all.
 *
 * The shape scales -- two groups of any equal size, with the final phase deciding
 * every place -- but this example stays at the documented ten, because ten is the
 * shape the rules are written for and a host loading an example wants the format
 * they can look up.
 *
 * Team names are the ones the built-in Radball demo already uses, so testing the
 * example and testing the demo show the same ten teams.
 */
const RADBALL_10_TEAM_EXAMPLE: SavedTournamentSetup = {
  version: 1,
  name: 'Radball World Cup \u2014 10 teams',
  format: 'radball',
  fieldNames: ['Field 1', 'Field 2'],
  // One slot per playing field, as the server's normaliser stores them. Empty
  // here because this example is Radball: the teams live in `radballBulk`.
  fieldBulk: ['', ''],
  radballBulk: [
    [
      'Team A,Anna Radler,Bert Radball',
      'Team B,Carla Kugel,Dirk Kugel',
      'Team C,Eva Bande,Finn Bande',
      'Team D,Greta Schuss,Hannes Schuss',
      'Team E,Ida Vorwaerts,Jann Vorwaerts',
    ].join('\n'),
    [
      'Team F,Kim Rueckspiel,Lars Rueckspiel',
      'Team G,Mia Achter,Noah Achter',
      'Team H,Olga Tordere,Paul Tordere',
      'Team I,Quirin Linie,Rune Linie',
      'Team J,Sina Kurve,Till Kurve',
    ].join('\n'),
  ],
  thirdPlace: false,
  seeded: true,
  seedValue: '20261004',
  drawMode: 'auto',
  manualSlots: [],
  // Only a manual schedule carries fixtures, and this example is not one.
  manualMatches: [],
  durationSec: 600,
  scoringIncrements: [1, 2, 3],
  autoLoadNext: true,
  autoAssignNext: true,
  ageCategory: 'ELITE',
  reducedTime: false,
  minRestMinutes: 0,
  setupMode: 'ten-team',
  groupCount: 2,
  doubleLeg: false,
  finalMode: 'none',
  bdrPreset: false,
};

export const EXAMPLE_SETUPS: ExampleSetup[] = [
  {
    id: 'example:radball-10-team',
    name: 'Radball World Cup \u2014 10 teams',
    description:
      'The full 2er format: ten teams on two fields, Group A on Field 1 and Group B on Field 2. Twenty group fixtures, then a final phase that decides places 1\u201310 \u2014 27 matches in all.',
    setup: RADBALL_10_TEAM_EXAMPLE,
  },
];

/** The example with this id, or null. */
export function findExampleSetup(id: string): ExampleSetup | null {
  return EXAMPLE_SETUPS.find((example) => example.id === id) ?? null;
}