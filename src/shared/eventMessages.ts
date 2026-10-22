/**
 * The sentences the engine writes into the activity log and the toast stream.
 *
 * ## Why these live in `shared` and not in the frontend catalogue
 *
 * The server writes them. A line has to exist as English *on the machine* --
 * it lands in the database, in the CSV export and in `state.events` -- and the
 * only module both bundles can read is `src/shared`. This is the same trade
 * `waitingReason` in `matchUtils` already makes: the English lives here, the
 * German lives in the catalogue, and the catalogue carries these keys too, so a
 * line with no translation is a failing test rather than an English sentence
 * nobody noticed.
 *
 * ## How one line reaches the reader
 *
 *  1. The engine pushes `{ key, params }` -- see `pushEvent` and `notify` in
 *     `src/backend/tournament/state.ts`.
 *  2. The server renders `message` from this table. That string is the audit
 *     record, so it stays English whatever the hall is speaking: a log that
 *     changes language halfway through a tournament is not a record.
 *  3. The same `{ key, params }` travels to the clients as `AppEvent.text`, and
 *     the UI renders it in the language the device is reading --
 *     `src/frontend/lib/eventText.ts` -- falling back to `message` when the key
 *     is unknown, which is what keeps an older database readable.
 *
 * ## Param names carry meaning
 *
 * The frontend localises a few params before substituting them, so the names
 * are part of the contract:
 *
 *  - `round`   an engine round name ("Round 3", "Semifinals") -> translated
 *  - `rounds`  several of those joined with `' → '`            -> each translated
 *  - `group`   an engine group name ("Group A")                -> translated
 *  - `reason`  a machine decision reason ("CHAMPIONSHIP_TIE")  -> translated
 *  - `action`  a score action kind ("score", "undo", ...)      -> translated
 *  - `label`   a lower-cased match label, English prose only, with `labelTitle`
 *              carrying the properly cased name: German capitalises nouns, so
 *              both shapes travel instead of one being lower-cased into the
 *              other (which would print "gewinnt runde 3").
 *  - everything else is a name the host typed, a score or a number, and is
 *    passed through untouched -- including field names, which are the
 *    organiser's words and never translated.
 */

/** Values substituted into a `{placeholder}`. */
export type EventTextParams = Record<string, string | number>;

/**
 * English templates. `{name}` placeholders, exactly like the catalogue, so the
 * two tables can be read side by side.
 */
export const EVENT_TEXTS = {
  /* --- participants and setup --- */
  'event.participantAdded': 'Participant added: {name}',
  'event.participantUpdated': 'Participant updated: {name}',
  'event.participantRemoved': 'Participant removed: {name}',
  'event.participantOrder': 'Participant order updated.',
  'event.tournamentCreated': 'Tournament created: {name} ({n} participants)',
  'event.tournamentDetails': 'Tournament details updated.',
  'event.bracketGenerated': 'Bracket generated: {slots} slots, {rounds} rounds, {matches} matches.',
  'event.resultsReset': 'All results and scores were reset.',
  'event.resultsResetFinalPhase':
    'Results reset. The final phase must be generated again once both groups are complete.',
  'event.bracketOverride': 'Manual override applied to {round}.',
  'event.bracketSlotEdited': 'Bracket slot {slot} edited on {round}.',
  /* A manual schedule is typed, not derived, so it has its own lines: there is
     no slot count or round depth to report, only how many fixtures the host
     wrote down and what changed since. */
  'event.scheduleCreated': 'Manual schedule created: {n} matches.',
  'event.matchAdded': 'Match added: {a} vs {b} ({round}).',
  'event.matchRemoved': 'Match removed: {a} vs {b} ({round}).',
  'event.matchRoundRenamed': '{round} renamed to {name}.',

  /* --- fields and assignment --- */
  'event.matchAssigned': '{round} assigned to {field}.',
  'event.matchUnassigned': '{round} removed from {field}.',
  'event.fieldsSwapped': '{one} and {two} swapped matches.',
  'event.fieldClaimed': '{field} is now controlled by {claim}.',
  'event.fieldReleased': '{field} control released.',

  /* --- match lifecycle --- */
  'event.matchStarted': '{round} started on {field}.',
  'event.matchPaused': '{round} paused.',
  'event.matchResumed': '{round} resumed.',
  'event.matchSecondHalf': '{round} second half started.',
  'event.matchCancelled': '{round} cancelled.',
  'event.matchReactivated': '{round} reactivated.',
  'event.matchReady': '{round} marked ready.',
  'event.matchNotReady': '{round} marked not ready.',
  'event.matchHalftime': '{round} went to halftime.',
  'event.matchTimeUp': '{round} time is up.',
  'event.matchFinished': '{round} finished - {winner} wins {a}:{b}.',
  'event.matchDecided': '{round} decided - {winner} wins {a}:{b}.',
  'event.matchDecidedShootout': '{round} decided after a 4-meter shootout - {winner} wins {a}:{b}.',
  'event.matchDraw': '{round} ended as a draw - nobody advances.',
  'event.timerUpdated': '{round} timer updated.',
  'event.timerReset': '{round} timer reset.',
  'event.queueReordered': 'Match queue reordered.',

  /* --- scoring --- */
  'event.scoreUndone': 'Undo: {action} by {actor} (back to {a}:{b})',
  'event.scoreRedone': 'Redo: {action} (forward to {a}:{b})',
  'event.scoreCorrected': 'Score corrected to {a}:{b}.',
  'event.scoreCorrectedNote': 'Score corrected to {a}:{b} ({note}).',
  'event.matchResetToZero': '{round} reset to 0:0.',

  /* --- the state itself (backup, restore, clear) --- */
  'event.restoredFromDisk': 'Tournament restored from disk (saved {time}).',
  'event.restoredFromBackup': 'Tournament restored from a backup file.',
  'event.stateCleared': 'State cleared.',

  /* --- Radball competition --- */
  'event.worldCupCreated':
    'Radball World Cup competition created: 2 groups of {size}, {n} preliminary fixtures ({ruleset}, {age}).',
  'event.radballCreated': 'Radball competition created: {groups} group(s), {fixtures} fixtures ({ruleset}, {age}).',
  'event.decisionMatchCreated': 'Decision match: {a} vs {b} ({reason}).',
  'event.decisionMatchSuperseded': 'Superseded decision match cancelled ({round}).',
  'event.shootoutStarted': '4-meter shootout started ({round}).',
  'event.shootoutDecided': 'Shootout decided: {winner} wins the decision.',
  'event.shootoutCleared': 'Shootout cleared ({round}).',
  'event.qualifiedForFinal': 'Qualified for the final round: {teams}.',
  'event.finalRoundCreated': 'Final round created.',
  'event.groupStandingsRecalculated': 'Group standings recalculated from the latest results.',
  'event.standingsRecalculated': 'Standings recalculated from the latest results.',
  'event.qualified': 'Qualified: {teams}.',
  'event.eliminated': 'Eliminated: {teams}.',
  'event.tieDetected': 'Teams are tied where it matters. Decision matches are created.',
  'event.champion': 'Champion: {name}.',
  'event.tournamentComplete': 'Tournament complete. Champion: {name}.',

  /* --- Radball World Cup final phase --- */
  'event.finalPhaseGenerated': 'Final phase generated: {n} matches from the final group positions.',
  'event.finalPhaseOrder': 'Final phase order updated: {rounds}.',
  'event.groupComplete': '{group} complete: {ranking}.',
  'event.finalRankingAssigned': 'Final ranking 1-10 assigned.',
  'event.finalRankingUpdated': 'Final ranking updated.',
  'event.finalPhaseReady':
    'Preliminary round complete. Both group rankings are frozen — the final phase can be generated.',

  /* --- knockout resolution --- */
  'event.grandFinalReset': 'Grand final reset is required -- both finalists now have one loss.',
  'event.advancesNoOpponent': '{team} advances (no opponent) in {round}.',

  /* --- the shelf of saved setups --- */
  'event.setupSaved': 'Tournament setup saved: {name}',
  'event.setupUpdated': 'Saved setup updated: {name}',
  'event.setupRenamed': 'Saved setup renamed: {name}',
  'event.setupRemoved': 'Saved setup removed: {name}',

  /* --- the team library --- */
  'event.teamAdded': 'Team added to the library: {name}',
  'event.teamUpdated': 'Library team updated: {name}',
  'event.teamRemoved': 'Team removed from the library: {name}',
  'event.teamOrder': 'Library team order updated.',
  'event.teamsImportedOne': 'Imported 1 team into the library.',
  'event.teamsImported': 'Imported {n} teams into the library.',
  'event.teamsImportedOneSkipped': 'Imported 1 team into the library, skipped {skipped}.',
  'event.teamsImportedSkipped': 'Imported {n} teams into the library, skipped {skipped}.',

  /* --- toasts --- */
  'notify.matchWon': '{winner} wins {round} ({a}:{b}).',
  'notify.matchDecided': '{winner} wins {label} ({a}:{b}).',
  'notify.matchDecidedShootout': '{winner} wins {label} on shootout ({a}:{b}).',
  'notify.matchDraw': '{round} ended in a draw. Nobody advances from this match.',
  'notify.shootoutWon': '{winner} wins the shootout. Confirm the decision result.',
  'notify.targetReached': 'Target score {max} reached on {round}. Confirm the winner on the field screen.',
  'notify.champion': '{name} wins the tournament!',
  'notify.tournamentComplete': 'Tournament complete -- {name} wins!',
} as const satisfies Record<string, string>;

/** Every sentence the engine can write. A typo here is a compile error. */
export type EventTextKey = keyof typeof EVENT_TEXTS;

/**
 * A sentence as the engine pushes it: the key plus the values it needs.
 *
 * The key is typed, so a misspelled one fails the build instead of reaching a
 * screen as a raw `event.macthStarted`.
 */
export interface EventText {
  key: EventTextKey;
  params?: EventTextParams;
}

/**
 * What an engine call site passes: either a keyed sentence, or free text for
 * the rare line that is not one (a validator's own output). Free text is
 * stored as it stands and shows up untranslated, which is the honest outcome --
 * guessing at a sentence the engine wrote dynamically would be worse.
 */
export type EventSentence = EventText | string;

/**
 * Fill an English template in.
 *
 * A placeholder the caller did not pass stays visible, exactly as the
 * catalogue's own `translate` does, so a missing value shows up in the line
 * instead of silently vanishing from the audit record.
 */
export function renderEventText(key: EventTextKey, params?: EventTextParams): string {
  const template = EVENT_TEXTS[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** The English wording of a pushed sentence, for storage and export. */
export function sentenceMessage(sentence: EventSentence): string {
  return typeof sentence === 'string' ? sentence : renderEventText(sentence.key, sentence.params);
}

/** Every key in the table, for the catalogue completeness test. */
export const EVENT_TEXT_KEYS = Object.keys(EVENT_TEXTS) as EventTextKey[];
