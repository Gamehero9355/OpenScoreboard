/**
 * The display console's two questions.
 *
 * The console has to answer "which field?" and "which screen?" separately,
 * because the host has to be able to tell the two selectors apart at a glance.
 * The part that is easy to get wrong is the second one: when the fields
 * disagree, there is no screen to call current, and the console has to say so
 * rather than light up whichever tile it likes.
 *
 * The rule itself is pure and lives in `src/frontend/lib/displayConsole.ts`;
 * the rendering of it is not testable here (the suite runs in a node
 * environment, without a DOM), so the guard is on the rule.
 */
import { describe, expect, it } from 'vitest';
import {
  displayFieldChoice,
  displayStatusFor,
  displayTargetFor,
} from '../src/frontend/lib/displayConsole';
import type { DisplayScreen, FieldId } from '../src/shared/types';

/** A hall with two fields showing two different pictures. */
const screens: Record<string, DisplayScreen> = { '1': 'clock', '2': 'standings' };
const screenOf = (id: FieldId): DisplayScreen => screens[id] ?? 'scores';

describe('what is on the wall', () => {
  it('answers for the field that is open, and only for it', () => {
    // The other field's picture is none of this target's business.
    expect(displayStatusFor('1', ['1', '2'], screenOf)).toEqual({
      kind: 'field',
      fieldId: '1',
      screen: 'clock',
    });
    expect(displayStatusFor('2', ['1', '2'], screenOf)).toEqual({
      kind: 'field',
      fieldId: '2',
      screen: 'standings',
    });
  });

  it('answers with one screen while the fields agree', () => {
    const same: Record<string, DisplayScreen> = { '1': 'clock', '2': 'clock' };
    expect(displayStatusFor('all', ['1', '2'], (id) => same[id] ?? 'scores')).toEqual({
      kind: 'all',
      screen: 'clock',
    });
  });

  it('lists every field when they disagree', () => {
    // No screen is current then, so the console has to name them one by one.
    expect(displayStatusFor('all', ['1', '2'], screenOf)).toEqual({
      kind: 'mixed',
      fields: [
        { fieldId: '1', screen: 'clock' },
        { fieldId: '2', screen: 'standings' },
      ],
    });
  });

  it('treats a hall with one field as that field, never as "all"', () => {
    expect(displayStatusFor('1', ['1'], screenOf)).toEqual({
      kind: 'field',
      fieldId: '1',
      screen: 'clock',
    });
  });

  it('never calls a screen current when the fields disagree', () => {
    // The lit tile means "this is what is on the wall". With two different
    // pictures on the wall there is no such tile, and the console says so.
    const status = displayStatusFor('all', ['1', '2'], screenOf);
    expect(status.kind).toBe('mixed');
    expect('screen' in status).toBe(false);
  });
});

describe('which field the console edits', () => {
  it('follows the field the host has open', () => {
    // The dashboard's tab already says which field this is; the console does
    // not ask again, and it never offers a field the host is not on.
    expect(displayFieldChoice(['1', '2'], '2', true)).toEqual({ field: '2', allAllowed: true });
  });

  it('falls back to a field that exists when the open one is gone', () => {
    // A tournament that lost a field must not leave the console pointing at
    // nothing.
    expect(displayFieldChoice(['1', '2'], '7', true)).toEqual({ field: '1', allAllowed: true });
  });

  it('offers "all fields" to the host, and only when there is more than one', () => {
    expect(displayFieldChoice(['1', '2'], '1', true).allAllowed).toBe(true);
    expect(displayFieldChoice(['1'], '1', true).allAllowed).toBe(false);
  });

  it('never offers "all fields" to a field operator', () => {
    // It is one command per field, and an operator's link may not touch the
    // other field's screen.
    expect(displayFieldChoice(['1', '2'], '1', false)).toEqual({ field: '1', allAllowed: false });
  });
});

describe('what the console is editing', () => {
  it('is the field, until the host asks for every field at once', () => {
    expect(displayTargetFor('2', false, true)).toBe('2');
    expect(displayTargetFor('2', true, true)).toBe('all');
  });

  it('falls back to the field when "all fields" is not on offer', () => {
    // A choice cannot outlive the permission for it.
    expect(displayTargetFor('2', true, false)).toBe('2');
  });
});
