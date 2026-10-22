/**
 * The display screen switcher.
 *
 * Every playing field owns a TV page (`/display/1`, ...) and the host can put
 * any of the six screens on it. This used to be a native <select>: a closed
 * dropdown that hid every option behind a click, and -- worse for the person
 * standing at the desk -- a label in faint 12px capitals naming the field that
 * was about to be changed, with the six possible screens reduced to six
 * unfamiliar names behind that dropdown.
 *
 * Now every option is on the table, and the two questions the host actually
 * has are kept apart:
 *
 *  1. **Which field?** The dashboard already answers this: the tab at the top
 *     of the page is the field the host is on, so the console edits that
 *     field's screen and says so. The only other choice is *all fields* --
 *     one command per field, the move a host makes when the hall pauses for
 *     the presentation and again when it starts.
 *  2. **Which screen?** A grid of tiles, each carrying a wireframe of what it
 *     looks like on the projector plus its name.
 *
 * Both used to be the same kind of square button in one three-column grid, so
 * the panel read as a box of nine squares and nobody could tell which row
 * changed the field and which changed the picture. The field is a row of round
 * pills now, the screen a grid of picture tiles, each with its own label, and
 * the line between them says what is on the wall right now -- so "what is up
 * there" and "what I am about to put there" can never be mistaken for one
 * another.
 */
import { useState } from 'react';
import type { DisplayScreen, FieldId } from '../../shared/types';
import { DISPLAY_SCREENS, displayMessageFor, displayScreenFor, screenAtBreak } from '../../shared/types';
import { fieldDisplayName } from '../../shared/matchUtils';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import { asTranslate, useI18n } from '../lib/useI18n';
import type { MessageKey } from '../lib/i18n';
import { cx } from '../lib/util';
import { Button } from './primitives';
import { ScreenPreview } from './displayPreview';
import {
  displayFieldChoice,
  displayStatusFor,
  displayTargetFor,
  type DisplayTarget,
} from '../lib/displayConsole';

/** The name of every screen, in the app's own words. */
export const DISPLAY_SCREEN_KEY: Record<DisplayScreen, MessageKey> = {
  scores: 'display.screen.scores',
  pause: 'display.screen.pause',
  logo: 'display.screen.logo',
  clock: 'display.screen.clock',
  standings: 'display.screen.standings',
  results: 'display.screen.results',
};

/** The screens that carry the host's own line of text. */
const MESSAGE_SCREENS: DisplayScreen[] = ['pause', 'logo'];

export function DisplayScreenPicker({
  fieldIds,
  activeField,
  density = 'rail',
}: {
  /** The field screens this picker edits. The host passes every field, an operator its own. */
  fieldIds: FieldId[];
  /**
   * The field the host has open on the dashboard. The console edits this
   * field's screen: the dashboard's own tab already says which field this is,
   * so the console does not ask the question a second time.
   */
  activeField?: FieldId;
  /**
   * `rail` is the host's narrow side column (three tiles a row), `sheet` the
   * operator's phone in one hand (two tiles a row, so the labels stay large).
   */
  density?: 'rail' | 'sheet';
}) {
  const snapshot = useLive();
  const { t } = useI18n();
  const settings = snapshot.state?.settings;
  const canControl = snapshot.role === 'admin' || snapshot.role === 'operator';

  // A field operator may only switch their own field's screen, and the server
  // refuses anything else -- so the picker must not offer it in the first
  // place.
  const scoped = snapshot.role === 'operator' && snapshot.tokenScope ? [snapshot.tokenScope] : fieldIds;
  const isAdmin = snapshot.role === 'admin';

  // The field the console edits is the one the host has open, and "all fields"
  // is on offer only to the host and only when there is more than one field.
  const choice = displayFieldChoice(scoped, activeField, isAdmin);
  const allAllowed = choice.allAllowed;

  // The host's other choice: every field at once. It does not follow the host
  // to the next field. A tap on a screen tile has to change the field the
  // host is on -- "every field" is a deliberate step, not a mode that follows
  // the tab around, or a tap meant for one field would quietly change both.
  const [showAll, setShowAll] = useState(false);
  const [shownField, setShownField] = useState<FieldId>(choice.field);
  if (shownField !== choice.field) {
    setShownField(choice.field);
    setShowAll(false);
  }
  const target: DisplayTarget = displayTargetFor(choice.field, showAll, allAllowed);

  const messageOf = (id: FieldId): string => (settings ? (displayMessageFor(settings, id) ?? '') : '');

  /**
   * The screen a field is *set* to -- what the wall goes back to when the
   * break ends.
   */
  const settingOf = (id: FieldId): DisplayScreen => (settings ? displayScreenFor(settings, id) : 'scores');

  /**
   * The screen a field's wall is *showing* right now.
   *
   * The wall puts the pause notice up while its match is at the break, so the
   * console has to say the same thing: the lit tile is the picture on the
   * screen, not the setting behind it. Everywhere else the two are the same
   * picture -- the break is the one moment they would differ, and it is
   * exactly the moment the host needs to see it.
   */
  const wallScreenOf = (id: FieldId): DisplayScreen => {
    const matchId = snapshot.state?.fields[id]?.matchId;
    const match = matchId ? snapshot.state?.matches[matchId] : null;
    return screenAtBreak(settingOf(id), match?.state);
  };

  // What is on the wall right now, for the target that is open. The fields
  // disagreeing is the one case in which no screen is current -- and it has to
  // be said out loud rather than guessed from a tile that happens to be lit.
  //
  // The rule reads the wall, not the setting, so a field that is at its break
  // shows the pause notice here as well as on the projector: the host sees
  // the switch the moment it happens.
  const status = displayStatusFor(target, scoped, wallScreenOf);
  const currentScreen: DisplayScreen | null = status.kind === 'mixed' ? null : status.screen;

  // A typed message is a draft: it belongs to the target it was typed for and
  // survives the deltas that arrive while it is being written.
  const messages = scoped.map(messageOf);
  const sharedMessage = messages.length > 0 && messages.every((m) => m === messages[0]) ? messages[0] : '';
  const savedMessage = target === 'all' ? sharedMessage : messageOf(target);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const message = drafts[target] ?? savedMessage;

  const nameOf = (id: FieldId): string =>
    fieldDisplayName(snapshot.state?.fields[id]?.name, id, asTranslate(t));

  /**
   * Put a screen on one field, or on every field at once.
   *
   * "All displays" is one command per field, so the results are collected and
   * a refusal is said out loud. A silently dropped command would leave the
   * host looking at a screen that did not move, with nothing to explain it.
   *
   * The screen is either one for every field or one per field -- the second
   * for the message, which belongs to the screen a field is *set* to and not
   * to the picture the wall happens to be showing.
   */
  const applyScreen = async (
    next: DisplayScreen | ((id: FieldId) => DisplayScreen),
    text?: string | null,
  ) => {
    if (!canControl) return;
    const targets = target === 'all' ? scoped : [target];
    const results = await Promise.all(
      targets.map((id) =>
        live.command('display.setScreen', {
          screen: typeof next === 'function' ? next(id) : next,
          target: id,
          ...(text === undefined ? {} : { message: text }),
        }),
      ),
    );
    const refused = results.find((result) => !result.ok);
    if (refused) live.pushToast('warn', refused.error ?? t('err.generic'));
  };

  const chooseScreen = (next: DisplayScreen) => {
    // The picture already on the wall is not a choice. Sending it would write
    // the break's pause notice into the setting behind it, and the field would
    // still be on the pause screen after the second half started.
    if (next === currentScreen) return;
    void applyScreen(next);
  };

  const saveMessage = () => {
    // The message belongs to a screen. If the fields disagree there is no
    // single screen to write it onto, and the message row is not even on
    // screen then -- but the guard keeps a stray save from resetting every
    // field's picture to the board.
    if (currentScreen === null) return;
    const trimmed = message.trim();
    // The screen the field is set to, not the one the wall is showing: at the
    // break the wall is on the pause notice, and writing that into the setting
    // would leave the field on the pause screen after the second half starts.
    void applyScreen(settingOf, trimmed || null);
    setDrafts((prev) => {
      if (!(target in prev)) return prev;
      const next = { ...prev };
      delete next[target];
      return next;
    });
  };

  const carriesMessage = currentScreen !== null && MESSAGE_SCREENS.includes(currentScreen);
  const previewWidth = density === 'sheet' ? 76 : 46;

  /**
   * The line that answers "what is up there right now?".
   *
   * It sits between the two selectors on purpose: it belongs to the field
   * that is open, and it is what tells the host which picture the lit tile
   * means -- the one on the wall, not the one being chosen.
   */
  const statusLine = (() => {
    if (status.kind === 'field') {
      return (
        <span className="display-status__line">
          {t('display.nowShowing', { field: nameOf(status.fieldId) })}{' '}
          <strong>{t(DISPLAY_SCREEN_KEY[status.screen])}</strong>
        </span>
      );
    }
    if (status.kind === 'all') {
      return (
        <span className="display-status__line">
          {t('display.allShowing')}{' '}
          <strong>{t(DISPLAY_SCREEN_KEY[status.screen])}</strong>
        </span>
      );
    }
    // The fields disagree: say so, and say which is which.
    return (
      <>
        <span className="display-status__line">{t('display.mixedShowing')}</span>
        <span className="display-status__fields">
          {status.fields.map((entry) => (
            <span key={entry.fieldId}>
              <span className="faint">{nameOf(entry.fieldId)}</span>{' '}
              <strong>{t(DISPLAY_SCREEN_KEY[entry.screen])}</strong>
            </span>
          ))}
        </span>
      </>
    );
  })();

  return (
    <div className="stack display-console">
      {/* Which field. The dashboard's own tab already says which field the
          host is on, so the console edits that one and offers only the other
          thing a host needs: every field at once. A field operator has one
          field and no business with the others, so it gets no row at all. */}
      {allAllowed ? (
        <div className="display-zone">
          <p className="display-zone__label">{t('display.fieldLabel')}</p>
          <div className="display-fields" role="group" aria-label={t('display.chooseField')}>
            <button
              type="button"
              className="display-field"
              aria-pressed={target !== 'all'}
              disabled={!canControl}
              onClick={() => setShowAll(false)}
              title={nameOf(choice.field)}
            >
              <span className="nowrap">{nameOf(choice.field)}</span>
            </button>
            <button
              type="button"
              className="display-field"
              aria-pressed={target === 'all'}
              disabled={!canControl}
              onClick={() => setShowAll(true)}
              title={t('display.allFields')}
            >
              <span className="nowrap">{t('display.allFields')}</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* What is on the wall for the field that is open. */}
      <p className="display-status" role="status">
        {statusLine}
      </p>

      {/* Which screen. Six tiles, each with a wireframe of what it looks like
          on the projector; the lit one is what the field shows right now. */}
      <div className="display-zone">
        <p className="display-zone__label">{t('display.screenLabel')}</p>
        <div
          className={cx('display-grid', density === 'sheet' && 'display-grid--sheet')}
          role="group"
          aria-label={t('display.chooseScreen')}
        >
          {DISPLAY_SCREENS.map((value) => {
            const active = currentScreen === value;
            return (
              <button
                key={value}
                type="button"
                className="display-tile"
                aria-pressed={active}
                disabled={!canControl}
                onClick={() => chooseScreen(value)}
              >
                <ScreenPreview screen={value} width={previewWidth} />
                <span className="display-tile__label">{t(DISPLAY_SCREEN_KEY[value])}</span>
              </button>
            );
          })}
        </div>
      </div>

      {carriesMessage ? (
        <form
          className="row g2"
          onSubmit={(event) => {
            event.preventDefault();
            saveMessage();
          }}
        >
          <input
            className="input input--sm grow"
            value={message}
            maxLength={160}
            disabled={!canControl}
            placeholder={t('display.messagePlaceholder')}
            aria-label={t('display.messageLabel')}
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((prev) => ({ ...prev, [target]: value }));
            }}
            onBlur={saveMessage}
          />
          <Button size="sm" tone="ghost" type="submit" disabled={!canControl}>
            {t('display.setMessage')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
