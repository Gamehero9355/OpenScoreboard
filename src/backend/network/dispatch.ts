/**
 * Command dispatcher -- the only bridge between a browser message and the
 * tournament engine. Everything is validated here: the command name, the
 * payload shape and the permission the session holds.
 */
import {
  COMMANDS,
  isCommandName,
  type CommandName,
  type CreateTournamentInput,
  type LibraryTeamInput,
  type ParticipantInput,
} from '../../shared/commands';
import { validateSettingsPatch, type ValidationResult } from '../../shared/protocol';
import type { DisplayScreen, FieldId, Match, Settings, TournamentState } from '../../shared/types';
import type { AccessControl, SessionScope } from '../auth/access';
import type { TournamentStore } from '../store/store';
import { EngineError, errorCode } from '../util/errors';
import {
  addManualMatch,
  addParticipant,
  createTournament,
  generateBracketForTournament,
  removeManualMatch,
  removeParticipant,
  reorderParticipants,
  resetTournament,
  setBracketSlot,
  setFieldNames,
  setManualMatchRoundName,
  setMatchParticipants,
  updateParticipant,
  updateTournament,
} from '../tournament/engine';
import {
  assignMatchToField,
  autoAssign,
  cancelMatch,
  claimField,
  endHalf,
  finishMatch,
  pauseMatch,
  releaseFieldClaim,
  resetMatch,
  reorderQueue,
  resumeMatch,
  setMatchReady,
  setTimer,
  startMatch,
  startSecondHalf,
  swapFields,
  unassignField,
} from '../tournament/matchops';
import { correctScore, redoScore, requireMatch, undoScore, updateScore } from '../tournament/scoring';
import {
  createDecisionMatch,
  recordShootoutAttempt,
  resetShootout,
  runQualification,
} from '../tournament/radball';
import {
  generateFinalPhase,
  setFinalPhaseOrder,
} from '../tournament/radball10';
import {
  removeTournamentSetup,
  renameTournamentSetup,
  saveTournamentSetup,
  type SaveTournamentSetupInput,
} from '../tournament/saved';
import type { RadballFinalKey } from '../../shared/types';
import type { Ctx, Mutation } from '../tournament/state';
import {
  addLibraryTeam,
  importLibraryTeams,
  removeLibraryTeam,
  reorderLibraryTeams,
  updateLibraryTeam,
} from '../tournament/teams';

export interface DispatchDeps {
  store: TournamentStore;
  access: AccessControl;
  onSettingsChanged?: (settings: Settings) => void;
  createBackupFile?: (kind: 'manual' | 'auto' | 'pre-restore') => Promise<string>;
  startDemo?: (state: TournamentState, ctx: Ctx, mut: Mutation) => void;
  /** Push a full fresh snapshot (including fresh join links) to every client. */
  resyncAll?: () => void;
  invalidateOperatorSessions?: () => void;
}

export interface DispatchOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
  mutated?: boolean;
}

export interface ClientIdentity {
  scope: SessionScope;
  actor: string;
}

export function actorLabel(scope: SessionScope, clientLabel: string | null): string {
  const suffix = clientLabel ? ` (${clientLabel})` : '';
  if (scope.role === 'admin') return `Host${suffix}`;
  if (scope.role === 'operator') {
    return scope.fieldId ? `Field ${scope.fieldId} operator${suffix}` : `Operator${suffix}`;
  }
  return `Spectator${suffix}`;
}

function fieldScopeOf(scope: SessionScope): FieldId | null {
  return scope.role === 'operator' ? scope.fieldId : null;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function bool(payload: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = payload[key];
  return typeof value === 'boolean' ? value : fallback;
}

function resolveMatchId(state: TournamentState, payload: Record<string, unknown>): string {
  const explicit = str(payload, 'matchId');
  if (explicit) return explicit;
  const fieldId = payload.fieldId as FieldId | undefined;
  if (!fieldId) throw new EngineError('BAD_REQUEST', 'A match id or field id is required.');
  const field = state.fields[fieldId];
  if (!field || !field.matchId) {
    throw new EngineError('FIELD_BUSY', `${field?.name ?? 'That field'} has no match assigned.`);
  }
  return field.matchId;
}

/**
 * Re-read a match from the state `store.apply` is about to hand to the engine.
 *
 * `requireMatch` already proved the id exists on `store.state`, and `apply`
 * operates on that very object, so the entry cannot have vanished between the
 * check and the call. Going through this helper rather than indexing directly
 * keeps that reasoning written down in one place instead of repeating a bare
 * `liveMatch(s, match.id)` at every call site, and it still refuses loudly if the
 * assumption is ever broken.
 */
function liveMatch(state: TournamentState, matchId: string): Match {
  const match = state.matches[matchId];
  if (!match) throw new EngineError('NOT_FOUND', 'That match is no longer available.');
  return match;
}

/**
 * Refuse a decision match when the competition has no phase to file it under.
 * Typed `never` so it can sit in a `??` chain and still end the expression.
 */
function failPhase(): never {
  throw new EngineError('BAD_REQUEST', 'This competition has no phase yet to file a decision match under.');
}

/** An operator session must own the field the match is sitting on. */
function assertOperatorField(scope: SessionScope, fieldId: FieldId | null): void {
  if (scope.role !== 'operator') return;
  if (fieldId === null) {
    throw new EngineError('FORBIDDEN', 'Assign the match to your field before controlling it.');
  }
  if (fieldId !== scope.fieldId) {
    throw new EngineError('FORBIDDEN', 'This control link belongs to another field.');
  }
}

export async function dispatchCommand(
  deps: DispatchDeps,
  identity: ClientIdentity,
  action: string,
  rawPayload: unknown,
): Promise<DispatchOutcome> {
  if (!isCommandName(action)) {
    return { ok: false, code: 'BAD_REQUEST', error: `Unknown command: ${action}` };
  }
  const name: CommandName = action;
  const spec = COMMANDS[name];
  const payloadResult: ValidationResult<Record<string, unknown>> = spec.validate(rawPayload);
  if (!payloadResult.ok) {
    return { ok: false, code: 'BAD_REQUEST', error: payloadResult.error };
  }
  const payload = payloadResult.value;
  const scope = identity.scope;

  if (spec.permission === 'admin' && scope.role !== 'admin') {
    return { ok: false, code: 'FORBIDDEN', error: 'Only the host interface can perform this action.' };
  }
  if (spec.permission === 'operator' && scope.role === 'spectator') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'This is a read-only session. Scan the control QR code to change scores.',
    };
  }

  const { store } = deps;
  const state = store.state;
  let mutated = false;
  const ctx = store.createContext(identity.actor, scope.role, fieldScopeOf(scope));
  const execute = (operation: (s: TournamentState, c: Ctx, m: Mutation) => void): void => {
    store.apply(operation, ctx);
    mutated = true;
  };

  try {
    switch (name) {
      /* ---------------- scoring ---------------- */
      case 'match.score': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          updateScore(
            s,
            liveMatch(s, match.id),
            payload.side as 'A' | 'B',
            payload.delta as number,
            c,
            m,
            (payload.note as string | null) ?? null,
          );
        });
        break;
      }
      case 'match.undo': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          undoScore(s, liveMatch(s, match.id), c, m);
        });
        break;
      }
      case 'match.redo': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          redoScore(s, liveMatch(s, match.id), c, m);
        });
        break;
      }
      case 'match.correct': {
        const match = requireMatch(state, str(payload, 'matchId'));
        execute((s, c, m) => {
          correctScore(
            s,
            liveMatch(s, match.id),
            payload.scoreA as number,
            payload.scoreB as number,
            c,
            m,
            (payload.note as string | null) ?? null,
          );
        });
        break;
      }
      case 'match.setTimer': {
        const match = requireMatch(state, str(payload, 'matchId'));
        assertOperatorField(scope, match.fieldId);
        execute((s, _c, m) => {
          setTimer(
            s,
            match.id,
            {
              ...(payload.mode ? { mode: payload.mode as 'down' | 'up' } : {}),
              ...(payload.durationSec !== undefined ? { durationSec: payload.durationSec as number } : {}),
            },
            m,
          );
        });
        break;
      }
      case 'match.start': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId ?? ((payload.fieldId as FieldId | undefined) ?? null));
        execute((s, c, m) => {
          startMatch(s, match.id, payload.fieldId as FieldId | undefined, c, m);
        });
        break;
      }
      case 'match.pause': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          pauseMatch(s, match.id, c, m);
        });
        break;
      }
      case 'match.resume': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          resumeMatch(s, match.id, c, m);
        });
        break;
      }
      case 'match.startSecondHalf': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          startSecondHalf(s, match.id, c, m);
        });
        break;
      }
      case 'match.endHalf': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          endHalf(s, match.id, c, m);
        });
        break;
      }
      case 'match.reset': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          resetMatch(s, match.id, c, m);
        });
        break;
      }
      case 'match.finish': {
        const match = requireMatch(state, resolveMatchId(state, payload));
        assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          finishMatch(
            s,
            {
              matchId: match.id,
              winner: (payload.winner as 'A' | 'B' | null) ?? null,
              force: bool(payload, 'force'),
            },
            c,
            m,
          );
        });
        break;
      }
      case 'match.cancel': {
        const match = requireMatch(state, str(payload, 'matchId'));
        execute((s, c, m) => {
          cancelMatch(s, match.id, c, m);
        });
        break;
      }
      case 'match.assign': {
        execute((s, c, m) => {
          assignMatchToField(s, str(payload, 'matchId'), payload.fieldId as FieldId, c, m);
        });
        break;
      }
      case 'match.unassign': {
        execute((s, c, m) => {
          unassignField(s, payload.fieldId as FieldId, c, m);
        });
        break;
      }
      case 'match.swapFields': {
        execute((s, _c, m) => {
          swapFields(s, m, payload.fieldA as FieldId, payload.fieldB as FieldId);
        });
        break;
      }
      case 'match.autoAssign': {
        execute((s, c, m) => {
          autoAssign(s, c, m);
        });
        break;
      }
      case 'match.setParticipants': {
        execute((s, c, m) => {
          setMatchParticipants(
            s,
            str(payload, 'matchId'),
            (payload.participantAId as string | null) ?? null,
            (payload.participantBId as string | null) ?? null,
            c,
            m,
          );
        });
        break;
      }
      case 'match.ready': {
        execute((s, _c, m) => {
          setMatchReady(s, str(payload, 'matchId'), bool(payload, 'ready', true), m);
        });
        break;
      }
      case 'match.reorder': {
        execute((s, _c, m) => {
          reorderQueue(s, payload.matchIds as string[], m);
        });
        break;
      }

      /* ---------------- the manual schedule ---------------- */
      // Adding, removing and renaming fixtures is what makes the manual format
      // editable while the event runs. Each engine function refuses the derived
      // formats itself, so a bracket can never grow a hand-written match.
      case 'match.add': {
        execute((s, c, m) => {
          addManualMatch(
            s,
            {
              participantAId: payload.participantAId as string,
              participantBId: payload.participantBId as string,
              roundName: (payload.roundName as string | undefined) ?? null,
              fieldId: (payload.fieldId as FieldId | undefined) ?? null,
            },
            c,
            m,
          );
        });
        break;
      }
      case 'match.remove': {
        execute((s, c, m) => {
          removeManualMatch(s, payload.matchId as string, c, m);
        });
        break;
      }
      case 'match.setRoundName': {
        execute((s, c, m) => {
          setManualMatchRoundName(s, payload.matchId as string, payload.roundName as string, c, m);
        });
        break;
      }

      /* ---------------- fields ---------------- */
      case 'field.claim':
      case 'field.release': {
        const fieldId = payload.fieldId as FieldId;
        if (scope.role === 'operator' && scope.fieldId !== fieldId) {
          return { ok: false, code: 'FORBIDDEN', error: 'This link can only act on its own field.' };
        }
        execute((s, c, m) => {
          if (name === 'field.claim') claimField(s, fieldId, bool(payload, 'force'), c, m);
          else releaseFieldClaim(s, fieldId, bool(payload, 'force'), c, m);
        });
        break;
      }
      case 'field.rename': {
        execute((s, _c, m) => {
          const fieldId = payload.fieldId as FieldId;
          const field = s.fields[fieldId];
          if (!field) throw new EngineError('FIELD_NOT_FOUND', 'That field does not exist.');
          field.name = payload.name as string;
          const index = Number(fieldId) - 1;
          if (index >= 0 && index < s.settings.fieldNames.length) {
            s.settings.fieldNames[index] = payload.name as string;
          }
          m.fields.add(fieldId);
          m.settings = true;
          m.urgency = 'immediate';
        });
        break;
      }

      /* ---------------- participants ---------------- */
      case 'participant.add': {
        execute((s, c, m) => {
          addParticipant(
            s,
            {
              name: payload.name as string,
              team: (payload.team as string | null) ?? null,
              seed: (payload.seed as number | null) ?? null,
              checkedIn: bool(payload, 'checkedIn', true),
              fieldId: (payload.fieldId as string | null) ?? null,
            },
            c,
            m,
          );
        });
        break;
      }
      case 'participant.update': {
        execute((s, c, m) => {
          const { id, ...patch } = payload;
          updateParticipant(s, id as string, patch, c, m);
        });
        break;
      }
      case 'participant.remove': {
        execute((s, c, m) => {
          removeParticipant(s, str(payload, 'id'), c, m);
        });
        break;
      }
      case 'participant.reorder': {
        execute((s, _c, m) => {
          reorderParticipants(s, payload.ids as string[], m);
        });
        break;
      }
      case 'participant.import': {
        const mode = (payload.mode as 'append' | 'replace') ?? 'append';
        execute((s, c, m) => {
          if (mode === 'replace') {
            for (const id of [...s.participantOrder]) removeParticipant(s, id, c, m);
          }
          for (const raw of payload.participants as ParticipantInput[]) addParticipant(s, raw, c, m);
        });
        break;
      }

      /* ---------------- team library ---------------- */
      case 'team.add': {
        execute((s, c, m) => {
          addLibraryTeam(s, payload as unknown as LibraryTeamInput, c, m);
        });
        break;
      }
      case 'team.update': {
        const id = str(payload, 'id');
        const team = payload.team as LibraryTeamInput;
        execute((s, c, m) => {
          updateLibraryTeam(s, id, team, c, m);
        });
        break;
      }
      case 'team.remove': {
        execute((s, _c, m) => {
          removeLibraryTeam(s, str(payload, 'id'), m);
        });
        break;
      }
      case 'team.reorder': {
        execute((s, _c, m) => {
          reorderLibraryTeams(s, payload.ids as string[], m);
        });
        break;
      }
      case 'team.import': {
        const teams = payload.teams as LibraryTeamInput[];
        const mode = (payload.mode as 'append' | 'replace') ?? 'append';
        const outcome = { result: null as { added: number; skipped: string[] } | null };
        execute((s, c, m) => {
          outcome.result = importLibraryTeams(s, teams, mode, c, m);
        });
        if (outcome.result && outcome.result.skipped.length > 0) {
          return {
            ok: true,
            mutated: true,
            message: `Imported ${outcome.result.added} teams, skipped ${outcome.result.skipped.length}.`,
          };
        }
        break;
      }

      /* ---------------- saved setups ---------------- */
      case 'setup.save': {
        const input: SaveTournamentSetupInput = {
          id: (payload.id as string | null | undefined) ?? null,
          name: (payload.name as string | null | undefined) ?? null,
          setup: payload.setup as SaveTournamentSetupInput['setup'],
        };
        execute((s, c, m) => {
          saveTournamentSetup(s, input, c, m);
        });
        break;
      }
      case 'setup.rename': {
        const id = str(payload, 'id');
        const name = str(payload, 'name');
        execute((s, c, m) => {
          renameTournamentSetup(s, id, name, c, m);
        });
        break;
      }
      case 'setup.remove': {
        const id = str(payload, 'id');
        execute((s, _c, m) => {
          removeTournamentSetup(s, id, m);
        });
        break;
      }

      /* ---------------- tournament / bracket ---------------- */
      case 'tournament.create': {
        if (state.tournament && payload.confirmReplace !== true) {
          return {
            ok: false,
            code: 'CONFLICT',
            error: `Tournament "${state.tournament.name}" is already loaded. Confirm replacement before creating another.`,
          };
        }
        const expectedTournamentId = (payload.expectedTournamentId as string | null | undefined) ?? null;
        if (!state.tournament && expectedTournamentId) {
          return {
            ok: false,
            code: 'CONFLICT',
            error: 'The tournament that was being replaced is no longer loaded. Review the current state and try again.',
          };
        }
        if (state.tournament && expectedTournamentId !== state.tournament.id) {
          return {
            ok: false,
            code: 'CONFLICT',
            error: 'The loaded tournament changed while replacement was being confirmed. Review the current event and try again.',
          };
        }
        const requestedSettings = payload.settings;
        let settings: Record<string, unknown> | null = null;
        if (requestedSettings && typeof requestedSettings === 'object' && !Array.isArray(requestedSettings)) {
          const allowed = new Set([
            'tournamentName',
            'fieldNames',
            'defaultMatchDurationSec',
            'scoringIncrements',
            'autoLoadNext',
            'autoAssignNext',
            'allowDraws',
          ]);
          const unsupported = Object.keys(requestedSettings as Record<string, unknown>).find((key) => !allowed.has(key));
          if (unsupported) {
            return { ok: false, code: 'BAD_REQUEST', error: `Setting ${unsupported} cannot be changed while creating a tournament` };
          }
          const validated = validateSettingsPatch(requestedSettings as Record<string, unknown>, state.settings);
          if (!validated.ok) return { ok: false, code: 'BAD_REQUEST', error: validated.error };
          settings = validated.value as Record<string, unknown>;
        }
        execute((s, c, m) => {
          createTournament(
            s,
            {
              name: payload.name as string,
              // The allow-list in the shared validator is the authority; this
              // cast only carries the value it already checked.
              format: payload.format as 'single-elimination' | 'double-elimination' | 'radball' | 'manual-schedule',
              participants: payload.participants as ParticipantInput[],
              thirdPlaceMatch: bool(payload, 'thirdPlaceMatch', true),
              seeded: bool(payload, 'seeded', true),
              seedValue: (payload.seedValue as number | null) ?? null,
              settings,
              generateBracketNow: bool(payload, 'generateBracket', true),
              fieldNames: (payload.fieldNames as string[] | undefined) ?? undefined,
              manualOrder: (payload.manualOrder as (number | null)[] | undefined) ?? undefined,
              manualMatches: (payload.manualMatches as CreateTournamentInput['manualMatches']) ?? null,
              radball: (payload.radball as CreateTournamentInput['radball']) ?? null,
            },
            c,
            m,
          );
        });
        deps.access.rotateOperatorTokens(Object.keys(store.state.fields));
        deps.invalidateOperatorSessions?.();
        deps.onSettingsChanged?.(store.state.settings);
        deps.resyncAll?.();
        break;
      }
      case 'tournament.update': {
        execute((s, _c, m) => {
          updateTournament(
            s,
            {
              ...(payload.name !== undefined ? { name: payload.name as string } : {}),
              ...(payload.thirdPlaceMatch !== undefined
                ? { thirdPlaceMatch: bool(payload, 'thirdPlaceMatch') }
                : {}),
            },
            m,
          );
        });
        break;
      }
      case 'tournament.reset': {
        execute((s, c, m) => {
          resetTournament(s, c, m);
        });
        break;
      }
      case 'tournament.complete': {
        execute((s, _c, m) => {
          if (!s.tournament) throw new EngineError('NO_TOURNAMENT', 'No tournament is loaded.');
          s.tournament.status = 'COMPLETED';
          s.tournament.completedAt = Date.now();
          m.tournament = true;
          m.urgency = 'immediate';
        });
        break;
      }
      case 'bracket.generate': {
        execute((s, c, m) => {
          generateBracketForTournament(
            s,
            {
              seeded: bool(payload, 'seeded', true),
              seedValue: (payload.seedValue as number | null) ?? null,
              thirdPlaceMatch: bool(payload, 'thirdPlaceMatch', true),
              order: (payload.order as (string | null)[] | null) ?? null,
            },
            c,
            m,
          );
        });
        break;
      }
      case 'bracket.setSlot': {
        execute((s, c, m) => {
          setBracketSlot(
            s,
            str(payload, 'matchId'),
            payload.slot as 'A' | 'B',
            (payload.participantId as string | null) ?? null,
            c,
            m,
          );
        });
        break;
      }

      /* ---------------- radball competition ---------------- */
      case 'radball.shootoutRecord': {
        const match = requireMatch(state, str(payload, 'matchId'));
        // A field operator may only drive the shootout of the match on their
        // own field; admins may act from anywhere.
        if (scope.role === 'operator') assertOperatorField(scope, match.fieldId);
        execute((s, c, m) => {
          recordShootoutAttempt(
            s,
            match.id,
            payload.side as 'A' | 'B',
            payload.shooter as number,
            payload.hit as boolean,
            c,
            m,
          );
        });
        break;
      }
      case 'radball.shootoutReset': {
        execute((s, c, m) => {
          resetShootout(s, str(payload, 'matchId'), c, m);
        });
        break;
      }
      case 'radball.decisionCreate': {
        execute((s, c, m) => {
          const tournament = s.tournament;
          const competition = s.radball;
          if (!tournament || !competition) {
            throw new EngineError('NO_TOURNAMENT', 'No Radball competition is loaded.');
          }
          const phaseId =
            (payload.phaseId as string | undefined) ??
            competition.phaseOrder[competition.phaseOrder.length - 1] ??
            // A competition with an empty phase order has nothing to attach a
            // decision match to; refusing beats writing an unroutable match.
            failPhase();
          const groupId = (payload.groupId as string | undefined) ?? null;
          const match = createDecisionMatch(
            s,
            {
              phaseId,
              groupId,
              teamAId: payload.teamAId as string,
              teamBId: payload.teamBId as string,
              reason: payload.reason as string,
            },
            c,
            m,
          );
          void match;
        });
        break;
      }
      case 'radball.qualify': {
        execute((s, c, m) => {
          runQualification(s, c, m, payload.phaseId as string | undefined);
        });
        break;
      }
      case 'radball.finalPhase': {
        execute((s, c, m) => {
          generateFinalPhase(s, c, m, {
            order: (payload.order as RadballFinalKey[] | null) ?? null,
            confirm: payload.confirm as boolean,
          });
        });
        break;
      }
      case 'radball.finalOrder': {
        execute((s, _c, m) => {
          setFinalPhaseOrder(s, (payload.order as RadballFinalKey[] | null) ?? [], m);
        });
        break;
      }

      /* ---------------- settings / system ---------------- */
      case 'settings.update': {
        const validated = validateSettingsPatch(payload.patch as Record<string, unknown>, state.settings);
        if (!validated.ok) return { ok: false, code: 'BAD_REQUEST', error: validated.error };
        const patch = { ...(validated.value as Record<string, unknown>) };
        const pin = patch.operatorPin as string | null | undefined;
        if (pin !== undefined) {
          await deps.access.setPin(pin);
          patch.operatorPinSet = pin !== null && pin !== '';
          patch.requireOperatorPin = pin !== null && pin !== '';
        }
        delete patch.operatorPin;
        execute((s, _c, m) => {
          const names = patch.fieldNames as string[] | undefined;
          delete patch.fieldNames;
          Object.assign(s.settings, patch);
          if (names) {
            // Adding/removing/renaming fields in one step; refuses to drop a
            // field that still has a match on it.
            setFieldNames(s, names, m);
            deps.access.ensureTokens(Object.keys(s.fields));
          } else {
            for (const id of Object.keys(s.fields)) {
              const index = Number(id) - 1;
              const field = s.fields[id];
              const name = s.settings.fieldNames[index];
              if (field && index >= 0 && name !== undefined) {
                field.name = name;
              }
              m.fields.add(id);
            }
          }
          m.settings = true;
          m.urgency = 'immediate';
          deps.onSettingsChanged?.(s.settings);
        });
        break;
      }
      /**
       * Switch a display. It writes the settings slice because that is what
       * every screen already follows -- one value, one delta, and the TV
       * repaints without a second channel to keep in sync. A `target` field id
       * switches that field's own display; no target switches the combined
       * display. An operator may only switch their own field (or the combined
       * display, for backwards compatibility); switching another field's TV is
       * the host's job.
       */
      case 'display.setScreen': {
        const rawTarget = payload.target as string | undefined;
        const target: FieldId | null = rawTarget ? (rawTarget as FieldId) : null;
        if (target !== null && scope.role === 'operator' && scope.fieldId !== target) {
          return { ok: false, code: 'FORBIDDEN', error: 'This control link can only switch its own field display.' };
        }
        if (target !== null && !store.state.fields[target]) {
          return { ok: false, code: 'FIELD_NOT_FOUND', error: 'That field does not exist.' };
        }
        execute((s, _c, m) => {
          if (target === null) {
            s.settings.displayScreen = payload.screen as DisplayScreen;
            if (payload.message !== undefined) {
              s.settings.displayMessage = (payload.message as string | null) ?? null;
            }
          } else {
            if (!s.settings.displayScreens || typeof s.settings.displayScreens !== 'object') {
              s.settings.displayScreens = {};
            }
            s.settings.displayScreens[target] = payload.screen as DisplayScreen;
            if (payload.message !== undefined) {
              if (!s.settings.displayMessages || typeof s.settings.displayMessages !== 'object') {
                s.settings.displayMessages = {};
              }
              s.settings.displayMessages[target] = (payload.message as string | null) ?? null;
            }
          }
          m.settings = true;
          m.urgency = 'immediate';
        });
        break;
      }
      case 'system.backup':
      case 'system.backupNow': {
        if (!deps.createBackupFile) {
          throw new EngineError('INTERNAL', 'Backups are not available in this build.');
        }
        const file = await deps.createBackupFile('manual');
        return { ok: true, mutated: false, message: `Backup written to ${file}` };
      }
      case 'system.demo': {
        if (!deps.startDemo) {
          throw new EngineError('INTERNAL', 'Demo mode is not available in this build.');
        }
        execute((s, c, m) => {
          deps.startDemo?.(s, c, m);
          m.urgency = 'immediate';
        });
        deps.access.rotateOperatorTokens(Object.keys(store.state.fields));
        deps.invalidateOperatorSessions?.();
        deps.resyncAll?.();
        break;
      }
      case 'system.demoProgress':
      case 'device.identify':
      case 'client.ping': {
        return { ok: true, mutated: false };
      }
      default: {
        return { ok: false, code: 'BAD_REQUEST', error: `Unhandled command: ${String(name)}` };
      }
    }
    return { ok: true, mutated };
  } catch (error) {
    if (error instanceof EngineError) {
      return { ok: false, code: error.code, error: error.message };
    }
    // eslint-disable-next-line no-console
    console.error('[dispatch] unexpected failure', error);
    return { ok: false, code: errorCode(error), error: 'The server could not complete that action.' };
  }
}
