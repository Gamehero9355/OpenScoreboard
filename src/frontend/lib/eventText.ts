/**
 * The engine's own sentences, in the language this device is reading.
 *
 * Every activity log line and every toast is written by the server, so what
 * arrives over the wire is the English wording plus a catalogue key and its
 * values (`AppEvent.text`, `ServerMessage.notify.text` --
 * `src/shared/eventMessages.ts`). This module is the one place that turns that
 * pair back into a sentence, for the activity feed, for the toasts and for the
 * tests that hold the two halves together.
 *
 * ## Two jobs, and the second is the one that shows
 *
 * The first is the lookup. The second is the *values*: the engine writes
 * "Round 3" and "Group A" into its sentences because those names are its own
 * identifiers, and a German line that reads "{round} auf {field} gestartet"
 * with the English name still inside it is not translated at all. So the param
 * names carry meaning -- see the table's header -- and `round`, `rounds`,
 * `group`, `reason` and `action` are translated here through the same helpers
 * the rest of the UI uses, which is what keeps "Runde 3" spelled the same way
 * in the log as it is in the bracket.
 *
 * ## Falling back, deliberately
 *
 * A line without a key (an older database, or the few sentences the engine
 * writes as free text such as a validator's own output) renders exactly as it
 * was stored. That is the honest outcome: the alternative is guessing at a
 * sentence the engine built dynamically, and a wrong log line is worse than an
 * English one.
 */
import type { AppEvent } from '../../shared/types';
import type { EventText, EventTextParams } from '../../shared/eventMessages';
import { activeLocale, hasMessage, tr, type MessageKey } from './i18n';
import { decisionReasonLabel, groupNameLabel, roundNameLabel } from './radball';

/** Score action kinds as the engine names them, for the "Undo: …" lines. */
const ACTION_KEYS: Record<string, MessageKey> = {
  score: 'eventAction.score',
  undo: 'eventAction.undo',
  redo: 'eventAction.redo',
  correct: 'eventAction.correct',
  reset: 'eventAction.reset',
  auto: 'eventAction.auto',
};

/**
 * Translate one value before it is substituted.
 *
 * `all` is needed for the one param that travels in two shapes: `label` is the
 * lower-cased name English prose wants ("X wins decision match"), and
 * `labelTitle` is the same name as the engine spelled it, which is the one
 * German can capitalise and translate. English keeps `label` as it arrived, so
 * the line a device reads is byte-for-byte the line the server stored; German
 * takes the cased name, because "gewinnt runde 3" is not a sentence.
 */
function localiseParam(name: string, value: string | number, all: EventTextParams): string | number {
  const text = String(value);
  switch (name) {
    case 'round':
      return roundNameLabel(text);
    case 'label':
      if (activeLocale() !== 'de' || all.labelTitle === undefined) return value;
      return roundNameLabel(String(all.labelTitle));
    case 'rounds':
      // A ' → '-joined schedule ("Semifinals → Final"); the separator is a
      // layout device, the names in it are the engine's.
      return text.split(' → ').map((part) => roundNameLabel(part)).join(' → ');
    case 'group':
      return groupNameLabel(text);
    case 'reason':
      return decisionReasonLabel(text);
    case 'action': {
      const key = ACTION_KEYS[text];
      // An unknown kind is a machine enum this module has never seen; it is
      // passed through rather than guessed at, exactly as decision reasons are.
      return key ? tr(key) : text;
    }
    default:
      return value;
  }
}

function localiseParams(params?: EventTextParams): EventTextParams | undefined {
  if (!params) return undefined;
  const out: EventTextParams = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = localiseParam(name, value, params);
  }
  return out;
}

/**
 * A server-written sentence, in this device's language.
 *
 * `message` is the English the server stored: it is returned unchanged when the
 * line carries no key, and it is the last resort if the key is one this build
 * does not know (a newer server, an older page).
 */
export function sentenceLine(text: EventText | undefined, message: string): string {
  if (!text || !hasMessage(text.key)) return message;
  return tr(text.key, localiseParams(text.params));
}

/** One row of the activity feed. */
export function eventLine(event: AppEvent): string {
  return sentenceLine(event.text, event.message);
}
