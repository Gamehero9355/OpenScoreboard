import type { FieldState, Settings, TournamentState } from '../../shared/types';
import {
  DEFAULT_FIELD_COUNT,
  defaultFieldNames,
  emptySavedTournamentLibrary,
  emptyTeamLibrary,
} from '../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  tournamentName: 'Local Tournament',
  // Absent means "not chosen yet", which the client reads as English. Keeping it
  // optional means a backup written before the setting existed loads unchanged.
  language: 'en',
  theme: 'dark',
  primaryColor: '#2f6fe4',
  accentColor: '#f1c21b',
  logoDataUrl: null,
  showSponsorBar: true,
  invertDisplayColors: false,
  // The score board is the display's default: a hall that never opens the new
  // screen switcher sees exactly the board it has always seen.
  displayScreen: 'scores',
  displayMessage: null,
  defaultMatchDurationSec: 180,
  scoringIncrements: [1, 2, 3],
  winCondition: 'manual',
  maxScore: null,
  allowDraws: false,
  timerMode: 'down',
  fieldNames: ['Field 1', 'Field 2'],
  autoLoadNext: true,
  autoAssignNext: false,
  requireOperatorPin: false,
  operatorPinSet: false,
  port: 3000,
  advertisedHost: null,
  autoBackupEnabled: true,
  autoBackupIntervalMin: 15,
};

export function createField(id: string, name: string): FieldState {
  return {
    id,
    name,
    matchId: null,
    controlledBy: null,
    controlledSince: null,
  };
}

export function createEmptyState(settings?: Partial<Settings>): TournamentState {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const names = merged.fieldNames.length > 0 ? merged.fieldNames : defaultFieldNames(DEFAULT_FIELD_COUNT);
  merged.fieldNames = [...names];
  const fields: TournamentState['fields'] = {};
  names.forEach((name, index) => {
    const id = String(index + 1);
    fields[id] = createField(id, name);
  });
  return {
    tournament: null,
    participants: {},
    participantOrder: [],
    matches: {},
    matchOrder: [],
    fields,
    settings: merged,
    radball: null,
    teamLibrary: emptyTeamLibrary(),
    savedTournaments: emptySavedTournamentLibrary(),
    events: [],
    seq: 0,
    updatedAt: Date.now(),
  };
}

export const MAX_EVENTS = 2000;
export const MAX_MATCH_HISTORY = 300;
export const MAX_SCORE_EVENTS = 500;
