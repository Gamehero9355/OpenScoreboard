/**
 * What the display console says about the wall.
 *
 * The console asks two questions -- which field, and which screen -- and this
 * helper answers the second one for the target that is open. It is a pure
 * function on purpose: the rule that decides whether the fields agree is the
 * rule that decides whether a screen tile may be shown as "current", and it
 * has to be testable without a DOM.
 *
 * It lives in the frontend because it is a presentation concern: the server
 * stores the screens (`displayScreens` per field, `displayScreen` as the
 * hall-wide fallback) and knows nothing about which one the host is looking
 * at.
 */
import type { DisplayScreen, FieldId } from '../../shared/types';

/** What the picker is editing: one field's screen, or every field at once. */
export type DisplayTarget = FieldId | 'all';

/** One field and the picture on its wall. */
export interface FieldScreen {
  fieldId: FieldId;
  screen: DisplayScreen;
}

/**
 * What is on the wall right now.
 *
 * `field` is one field's own screen, `all` every field showing the same
 * picture, and `mixed` the case the console has to say out loud: the fields
 * disagree, so there is no current screen and no tile may be pressed.
 */
export type DisplayStatus =
  | { kind: 'field'; fieldId: FieldId; screen: DisplayScreen }
  | { kind: 'all'; screen: DisplayScreen }
  | { kind: 'mixed'; fields: FieldScreen[] };

/**
 * Read the current screen for the target that is open.
 *
 * `fields` are the fields the picker may change, `screenOf` reads one field's
 * screen. A target of a single field is answered from that field alone --
 * what the other field shows is none of its business while it is open.
 */
export function displayStatusFor(
  target: DisplayTarget,
  fields: FieldId[],
  screenOf: (fieldId: FieldId) => DisplayScreen,
): DisplayStatus {
  if (target !== 'all') {
    return { kind: 'field', fieldId: target, screen: screenOf(target) };
  }
  const seen = fields.map((fieldId): FieldScreen => ({ fieldId, screen: screenOf(fieldId) }));
  const first = seen[0];
  const uniform = first !== undefined && seen.every((entry) => entry.screen === first.screen);
  return uniform ? { kind: 'all', screen: first.screen } : { kind: 'mixed', fields: seen };
}

/**
 * The field the console edits, and whether "all fields" is on offer.
 *
 * The host's dashboard already says which field is open -- the tab at the top
 * of the page -- so the console does not ask again: it edits that field's
 * screen. A field that is no longer in the tournament falls back to the first
 * one there is, so the console never points at nothing.
 *
 * "All fields" is the host's alone: it is one command per field, and a field
 * operator's link may not touch the other field's screen. With a single field
 * on offer there is nothing to choose between, so it is not offered at all.
 */
export function displayFieldChoice(
  scoped: FieldId[],
  activeField: FieldId | undefined,
  isAdmin: boolean,
): { field: FieldId; allAllowed: boolean } {
  const field = activeField && scoped.includes(activeField) ? activeField : (scoped[0] ?? '1');
  return { field, allAllowed: isAdmin && scoped.length > 1 };
}

/**
 * What the console is editing right now.
 *
 * The field itself, unless the host has asked for every field at once -- and
 * even then only while that is allowed: the choice cannot outlive the
 * permission for it.
 */
export function displayTargetFor(field: FieldId, all: boolean, allAllowed: boolean): DisplayTarget {
  return all && allAllowed ? 'all' : field;
}
