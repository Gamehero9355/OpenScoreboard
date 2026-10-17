/**
 * Field operator screen.
 *
 * Designed for a phone in one hand: two score cards, one clock and the essential
 * transport controls. Nothing else competes for attention, every target is at
 * least 44px, and the page cannot be scrolled accidentally during a match.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldId, Match } from '../../shared/types';
import { fieldDisplayName, homeFieldOf, nameOf, periodElapsedSec, periodLeftSec, waitingReason } from '../../shared/matchUtils';
import { live } from '../lib/live';
import { useHotkeys, useLive, useMatchClock, useWakeLock } from '../lib/hooks';
import { rememberPin } from '../lib/token';
import { asTranslate, useI18n } from '../lib/useI18n';
import { cx, durationForTimeLeft, formatClock, formatDurationInput, formatTime, parseDurationInput } from '../lib/util';
import { Badge, Button, ConnectionBadge, MatchStateBadge, Modal } from '../components/primitives';
import { EndMatchDialog } from '../components/dialogs';
import { DisplayScreenPicker } from '../components/DisplayScreenPicker';
import { IconEye, IconLock, IconPause, IconPlay, IconRedo, IconStop, IconUndo } from '../components/icons';

type Overlay = { matchId: string; winner: 'A' | 'B' | null } | null;

export function OperatorPage({ fieldId }: { fieldId: FieldId }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const state = snapshot.state;
  const [dialog, setDialog] = useState<'end' | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [showDisplay, setShowDisplay] = useState(false);
  const [busy, setBusy] = useState(false);

  const field = state?.fields[fieldId] ?? null;
  const match = field?.matchId ? state?.matches[field.matchId] ?? null : null;
  const canControl = snapshot.role === 'admin' || snapshot.role === 'operator';

  useWakeLock(Boolean(match && match.state === 'RUNNING'));

  /* ---------------- claim the field so two phones cannot fight ---------------- */
  const claim = useCallback(
    async (force: boolean) => {
      const result = await live.command('field.claim', { fieldId, force }, { silent: true });
      setLockError(result.ok ? null : result.error ?? t('op.controlledByOther'));
      return result.ok;
    },
    [fieldId, t],
  );

  useEffect(() => {
    if (!canControl) return;
    void claim(false);
    return () => {
      void live.command('field.release', { fieldId, force: false }, { silent: true });
    };
  }, [canControl, claim, fieldId]);

  const run = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      if (busy) return;
      setBusy(true);
      // A caller may name a specific match (loading the next queued match onto
      // this field). Only fall back to the match already on the field when it
      // does not -- spreading `matchId` last used to overwrite the requested
      // match, so "load this match here" silently did nothing.
      const result = await live.command(action, { matchId: match?.id, ...payload, fieldId });
      setBusy(false);
      if (!result.ok && result.code === 'FIELD_LOCKED') {
        setLockError(result.error ?? t('op.lockedByOther'));
      }
      return result;
    },
    [busy, fieldId, match?.id, t],
  );

  const score = (side: 'A' | 'B', delta: number) => void run('match.score', { side, delta });

  const start = () => void run('match.start');
  const startSecondHalf = () => void run('match.startSecondHalf');
  const pause = () => void run(match?.state === 'PAUSED' ? 'match.resume' : 'match.pause');
  const undo = () => void run('match.undo');
  const redo = () => void run('match.redo');
  const reset = () => void run('match.reset');

  const nextAvailable = useMemo(() => (state ? nextReady(state, fieldId) : null), [state, fieldId]);

  /* --- this match's scoring log, newest first (the wide screen's rail) ------- */
  const actions = useMemo(() => (match ? [...match.history].reverse() : []), [match]);

  const startNext = async () => {
    if (!nextAvailable) return;
    const result = await run('match.start', { matchId: nextAvailable.id });
    if (result && !result.ok) {
      live.pushToast('warn', result.error ?? t('err.generic'));
      return;
    }
    setOverlay(null);
  };

  /* ---------------- keyboard shortcuts ---------------- */
  useHotkeys(
    {
      ' ': () => {
        if (!match) return;
        if (match.state === 'HALFTIME') startSecondHalf();
        else if (match.state === 'RUNNING' || match.state === 'PAUSED') pause();
        else start();
      },
      '1': () => score('A', 1),
      '2': () => score('B', 1),
      u: undo,
      r: redo,
      e: () => match && setDialog('end'),
      '?': () => setShowKeys((value) => !value),
      h: () => setShowKeys((value) => !value),
    },
    canControl,
  );

  const clock = useMatchClock(match);

  if (!state || !field) {
    if (state && !field) {
      return (
        <div className="op">
          <div className="op__bar">
            <span className="op__field">{t('field.label', { n: fieldId })}</span>
            <ConnectionBadge />
          </div>
          <div className="empty">{t('op.noField', { n: fieldId })}</div>
        </div>
      );
    }
    return (
      <div className="op">
        <div className="op__bar">
          <span className="op__field">{t('field.label', { n: fieldId })}</span>
          <ConnectionBadge />
        </div>
        <div className="empty">{t('conn.connecting')}…</div>
      </div>
    );
  }

  const finished = match?.state === 'FINISHED';

  return (
    <div className={cx('op', showKeys && 'op--keys-open')}>
      <div className="op__bar">
        <span className="op__identity">
          <span className="op__field">{fieldDisplayName(field.name, fieldId, asTranslate(t))}</span>
          <span className="op__round">
            {match
              ? `${match.roundName} · ${t('dialog.matchLabel', { n: match.position + 1 })}${
                  match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''
                }`
              : t('op.noMatchAssigned')}
          </span>
        </span>
        <span className="op__status">
          {match ? <MatchStateBadge state={match.state} /> : null}
          {snapshot.role === 'spectator' ? (
            <Badge tone="danger">
              <IconLock size={11} /> {t('role.spectator')}
            </Badge>
          ) : null}
          {/* The hall display, on the operator's own screen. A field operator
              is the person who knows the match is pausing, so the switch that
              puts "Pause" on the wall lives where they already are. */}
          <Button
            size="sm"
            tone="ghost"
            disabled={!canControl}
            onClick={() => setShowDisplay(true)}
            title={t('display.title')}
          >
            <IconEye size={13} /> {t('display.short')}
          </Button>
          <Button
            size="sm"
            tone="ghost"
            className="op__keys"
            aria-pressed={showKeys}
            onClick={() => setShowKeys((value) => !value)}
            title={t('dialog.shortcuts')}
          >
            {t('dialog.shortcuts')}
          </Button>
          <ConnectionBadge compact />
        </span>
      </div>

      {lockError ? (
        <div className="op-lock" role="alert">
          <strong>{t('op.lockTitle', { field: fieldDisplayName(field.name, fieldId, asTranslate(t)) })}</strong>
          <span className="small dim">{lockError}</span>
          <p className="hint">{t('op.lockHint')}</p>
          <Button tone="danger" onClick={() => void claim(true)}>
            {t('op.takeOver', { field: fieldDisplayName(field.name, fieldId, asTranslate(t)) })}
          </Button>
        </div>
      ) : null}

      {!canControl && !snapshot.pinChallenge ? (
        <div className="op-lock">
          <strong>{t('op.readOnlyTitle')}</strong>
          <span className="small dim">
            {snapshot.authNotice ?? t('err.readOnly')}
          </span>
        </div>
      ) : null}

      {snapshot.pinChallenge ? (
        <PinPrompt
          message={snapshot.authNotice ?? t('op.pinRequired')}
          onSubmit={(pin) => {
            rememberPin(pin);
            live.submitPin(pin);
          }}
        />
      ) : null}

      <div className="op__body">
        <aside className="op__rail" aria-label={t('dialog.shortcuts')}>
          <section className="op-panel">
            <h2 className="op-panel__title">{t('dialog.shortcuts')}</h2>
            <ShortcutLegend state={state} match={match} />
          </section>
          <section className="op-panel op-panel--fill">
            <h2 className="op-panel__title">{t('op.recentActions')}</h2>
            {actions.length > 0 ? (
              <ul className="op-log">
                {actions.map((action) => (
                  <li key={action.id} className="op-log__row">
                    <span className="op-log__time">{formatTime(action.ts)}</span>
                    <span className="op-log__what">
                      {action.participantId ? nameOf(state, action.participantId) : t('action.correct')}
                      {action.delta !== 0 ? ` ${action.delta > 0 ? '+' : ''}${action.delta}` : ''}
                    </span>
                    <span className="op-log__score tnum">
                      {action.prevA}:{action.prevB} → {action.nextA}:{action.nextB}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="op-panel__body dim">{t('fc.noActions')}</p>
            )}
          </section>
          <section className="op-panel">
            <h2 className="op-panel__title">{t('op.nextAvailable')}</h2>
            {nextAvailable ? (
              <p className="op-panel__body">
                {nameOf(state, nextAvailable.participantAId)}{' '}
                <span className="dim">vs</span> {nameOf(state, nextAvailable.participantBId)}
              </p>
            ) : (
              <p className="op-panel__body dim">{t('op.nothingReady')}</p>
            )}
          </section>
        </aside>

        {!match ? (
          <div className="op__main">
            <div className="field__empty stack g3" style={{ alignItems: 'center', flex: '1 1 auto' }}>
              <span className="op__field">{fieldDisplayName(field.name, fieldId, asTranslate(t))}</span>
              <span className="dim">{t('op.waitingAssignment')}</span>
              {nextAvailable ? (
                <span className="stack g2" style={{ alignItems: 'center' }}>
                  <span className="small">
                    {t('op.nextReadyLabel')} {nameOf(state, nextAvailable.participantAId)} vs{' '}
                    {nameOf(state, nextAvailable.participantBId)}
                  </span>
                  <Button tone="primary" size="lg" disabled={!canControl || busy} onClick={() => void startNext()}>
                    {t('setup.autoLoadNext')}
                  </Button>
                </span>
              ) : (
                <span className="hint">{t('op.nothingReady')}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="op__main">
            <div className="op__players">
              {(
                [
                  { side: 'A' as const, name: nameOf(state, match.participantAId), points: match.scoreA, other: match.scoreB },
                  { side: 'B' as const, name: nameOf(state, match.participantBId), points: match.scoreB, other: match.scoreA },
                ] as const
              ).map((entry) => (
                <div
                  key={entry.side}
                  className={cx(
                    'op-card',
                    entry.points > entry.other && 'op-card--leading',
                    entry.points < entry.other && 'op-card--trailing',
                  )}
                >
                  <div className="op-card__top">
                    <span className="op-card__name">{entry.name}</span>
                    <span className="op-card__points" aria-label={t('score.points', { n: entry.points })}>
                      {entry.points}
                    </span>
                  </div>
                  <div className="op-card__buttons">
                    {state.settings.scoringIncrements.map((increment) => (
                      <button
                        key={increment}
                        type="button"
                        className="op-plus"
                        disabled={!canControl || busy || finished}
                        onClick={() => score(entry.side, increment)}
                      >
                        <span className="op-plus__sign">+</span>
                        {increment}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="op-plus op-plus--minus"
                      disabled={!canControl || busy || finished}
                      onClick={() => score(entry.side, -1)}
                      aria-label={t('op.subtractOne', { name: entry.name })}
                    >
                      −
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="op__side">
              <MatchClock
                match={match}
                ms={clock.ms}
                over={clock.over}
                canControl={canControl}
                busy={busy}
                onSetDurationSec={(durationSec) => void run('match.setTimer', { durationSec })}
              />

              <div className="op__transport op__transport--wide">
                {match.state === 'HALFTIME' ? (
                  <button
                    type="button"
                    className="op-btn op-btn--start"
                    onClick={startSecondHalf}
                    disabled={!canControl || busy || finished}
                  >
                    <IconPlay size={18} /> {t('op.startSecondHalf')}
                  </button>
                ) : match.state === 'RUNNING' || match.state === 'PAUSED' ? (
                  <button type="button" className="op-btn op-btn--pause" onClick={pause} disabled={!canControl || busy}>
                    {match.state === 'PAUSED' ? <IconPlay size={18} /> : <IconPause size={18} />}
                    {match.state === 'PAUSED' ? t('action.resume') : t('action.pause')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="op-btn op-btn--start"
                    onClick={start}
                    disabled={!canControl || busy || finished}
                  >
                    <IconPlay size={18} /> {t('action.start')}
                  </button>
                )}
                <button
                  type="button"
                  className="op-btn op-btn--finish"
                  onClick={() => setDialog('end')}
                  disabled={!canControl || busy || finished}
                >
                  <IconStop size={16} /> {t('action.end')}
                </button>
              </div>

              <div className="op__secondary">
                <button
                  type="button"
                  className="op-btn op-btn--ghost"
                  onClick={undo}
                  disabled={!canControl || busy || match.history.length === 0}
                >
                  <IconUndo size={14} /> {t('action.undo')}
                </button>
                <button
                  type="button"
                  className="op-btn op-btn--ghost"
                  onClick={redo}
                  disabled={!canControl || busy || match.redoStack.length === 0}
                >
                  <IconRedo size={14} /> {t('action.redo')}
                </button>
                <button type="button" className="op-btn op-btn--ghost" onClick={reset} disabled={!canControl || busy}>
                  {t('action.reset')}
                </button>
                <button
                  type="button"
                  className="op-btn op-btn--ghost"
                  onClick={() => live.command('match.setTimer', { matchId: match.id, fieldId, mode: match.timer.mode === 'down' ? 'up' : 'down' })}
                  disabled={!canControl || busy}
                  title={t('op.switchClock')}
                >
                  {t(match.timer.mode === 'down' ? 'clock.up' : 'clock.down')}
                </button>
              </div>

              {waitingReason(state, match, asTranslate(t)) ? (
                <p className="hint center">{waitingReason(state, match, asTranslate(t))}</p>
              ) : null}
              {state.settings.autoLoadNext ? <p className="hint center">{t('op.autoLoadOn')}</p> : null}
            </div>
          </div>
        )}
      </div>

      {dialog === 'end' && match ? (
        <EndMatchDialog
          match={match}
          onClose={() => setDialog(null)}
          onFinished={(winnerId) => {
            setOverlay({
              matchId: match.id,
              winner: winnerId === match.participantAId ? 'A' : winnerId === match.participantBId ? 'B' : null,
            });
          }}
        />
      ) : null}

      {showDisplay ? (
        <Modal title={t('display.title')} onClose={() => setShowDisplay(false)}>
          <DisplayScreenPicker compact target={fieldId} />
        </Modal>
      ) : null}

      {overlay && !dialog ? (
        <WinnerOverlay
          state={state}
          match={state.matches[overlay.matchId] ?? match}
          next={nextAvailable}
          canControl={canControl}
          onStartNext={startNext}
          onClose={() => setOverlay(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The clock, its minute steppers, and the inline editor for its length.
 *
 * The clock on screen counts one half, so the steppers move one half by a
 * minute -- not the whole match, which would move each half by only thirty
 * seconds and invite repeated taps.
 *
 * ±1m is the fast path, but it cannot reach the lengths a hall actually
 * decides on mid-event, so the number itself is the second path: while the time
 * is stopped it is a button, and tapping it types the length outright. It is a
 * button only when stopped, so the control cannot be pressed under a running
 * game, where moving the ground would silently lengthen or shorten the half.
 *
 * The box holds the time the field *still has*, which for a countdown is the
 * number already on the wall -- retype 8:56 and it stays 8:56, type 4:00 and the
 * clock says 4:00. Opening it must never turn a half-way clock into a full one,
 * or the first thing the control does is contradict what it just showed. It is
 * therefore not the length of the half: that belongs to the steppers, which move
 * it a minute at a time.
 */
function MatchClock({
  match,
  ms,
  over,
  canControl,
  busy,
  onSetDurationSec,
}: {
  match: Match;
  ms: number;
  over: boolean;
  canControl: boolean;
  busy: boolean;
  onSetDurationSec: (durationSec: number) => void;
}) {
  const { t } = useI18n();
  const timer = match.timer;
  const halves = timer.periodCount === 1 ? 1 : 2;
  const stepSec = 60 * halves;
  const editable = canControl && !timer.running;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [unreadable, setUnreadable] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** What the box was opened with, so an untouched box saves nothing. */
  const openedRef = useRef(0);

  // A length belongs to the match that was on the field when the box opened.
  // Any of these three changes means the box is about someone else's game, or
  // the time is running again, so the draft is dropped rather than committed.
  useEffect(() => {
    setEditing(false);
  }, [match.id, timer.running, canControl]);

  useEffect(() => {
    // Focus as well as select: a box that appears without the keyboard and the
    // caret in it costs the operator a second tap on a phone, and a selection
    // that never happened means their first keystroke is inserted rather than
    // replacing the number they were shown.
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [editing]);

  const open = () => {
    // The time still left for this half -- the board's own number while the
    // clock counts down, so the box opens on what was just read. Floored, because
    // the board truncates too: rounding here is how a clock reading 8:55 came
    // back as 8:56 the moment it was touched.
    const left = Math.floor(periodLeftSec(timer, Date.now()));
    openedRef.current = left;
    setDraft(formatDurationInput(left));
    setUnreadable(false);
    setEditing(true);
  };

  /** Close the editor, saving the typed length unless it was cancelled. */
  const close = (commit: boolean) => {
    if (!editing) return;
    const typed = parseDurationInput(draft);
    // A box holding something unreadable stays open and says so instead of
    // closing on a length nobody meant: losing a typed number silently is how a
    // half starts on the wrong time. Escape, or a number that reads, closes it.
    if (commit && typed === null) {
      setUnreadable(true);
      return;
    }
    setEditing(false);
    // A box that was opened and abandoned saves nothing -- blur is also how the
    // editor closes, and "no number typed" must not snap the clock to a length
    // nobody chose.
    if (!commit || typed === null) return;
    if (typed === openedRef.current) return;
    // At halftime the number is the length of the half that is about to start:
    // the elapsed time belongs to the half that is over, and adding it back would
    // hand the second half the old half's time on top of what was typed.
    const played = match.state === 'HALFTIME' ? 0 : periodElapsedSec(timer, Date.now());
    onSetDurationSec(durationForTimeLeft(typed, halves, played));
  };

  const shown = formatClock(ms);
  const tone = cx(
    'op__time',
    over && 'op__time--over',
    (match.state === 'PAUSED' || match.state === 'HALFTIME') && 'op__time--paused',
  );

  return (
    <>
      <div className="op__clock">
        <Button
          size="sm"
          tone="ghost"
          disabled={!editable || busy}
          onClick={() => onSetDurationSec(Math.max(stepSec, timer.durationSec - stepSec))}
          title={t('op.shortenClock')}
        >
          −1m
        </Button>
        {editing ? (
          <input
            ref={inputRef}
            className={cx('input', 'op__time', 'op__time-input', unreadable && 'input--invalid')}
            value={draft}
            size={5}
            inputMode="numeric"
            autoComplete="off"
            aria-label={t('op.editClock')}
            aria-invalid={unreadable || undefined}
            onChange={(event) => {
              const next = padSeconds(event.target.value);
              setDraft(next);
              if (parseDurationInput(next) !== null) setUnreadable(false);
            }}
            onBlur={() => close(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                close(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close(false);
              }
            }}
          />
        ) : editable ? (
          <button
            type="button"
            className={cx(tone, 'op__time--editable')}
            onClick={open}
            title={t('op.editClock')}
            aria-label={`${t('op.editClock')} — ${shown}`}
          >
            {shown}
          </button>
        ) : (
          <span className={tone}>{shown}</span>
        )}
        <Button
          size="sm"
          tone="ghost"
          disabled={!editable || busy}
          onClick={() => onSetDurationSec(timer.durationSec + stepSec)}
          title={t('op.extendClock')}
        >
          +1m
        </Button>
      </div>
      {editing ? <p className="hint center">{t('op.editClockHint')}</p> : null}
    </>
  );
}

/** `6:3` on a phone keypad means 6:30 -- pad the seconds as they are typed. */
function padSeconds(text: string): string {
  return /^(\d{1,2}):\d$/.test(text) ? `${text}0` : text;
}

/**
 * The keyboard legend. The same list serves two screens: behind the
 * "Keyboard shortcuts" toggle on a phone, and permanently in the side rail on a
 * wide screen, where a mouse and a keyboard are a given and a hidden list would
 * hide the fastest way to score from the people who could use it.
 */
function ShortcutLegend({
  state,
  match,
}: {
  state: NonNullable<ReturnType<typeof useLive>['state']>;
  match: Match | null;
}) {
  const { t } = useI18n();
  return (
    <ul className="op-keys">
      <li>{t('op.scSpace')}</li>
      <li>{t('op.scPoint', { key: '1', name: nameOf(state, match?.participantAId ?? null) })}</li>
      <li>{t('op.scPoint', { key: '2', name: nameOf(state, match?.participantBId ?? null) })}</li>
      <li>{t('op.scMisc')}</li>
    </ul>
  );
}

function WinnerOverlay({
  state,
  match,
  next,
  canControl,
  onStartNext,
  onClose,
}: {
  state: NonNullable<ReturnType<typeof useLive>['state']>;
  match: Match | null;
  next: Match | null;
  canControl: boolean;
  onStartNext: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!match) return null;
  const winner = match.winnerId ? nameOf(state, match.winnerId) : null;
  return (
    <div className="op-win" role="dialog" aria-modal="true">
      <div className="op-win__panel">
        <span className="tiny dim">{t('match.finished')}</span>
        <span className="op-win__title">{match.roundName}</span>
        <span className="op-win__score">
          {match.scoreA} : {match.scoreB}
        </span>
        <span style={{ fontSize: 'var(--step-2)' }}>
          {winner ? (
            <>
              {t('score.winner')}: <strong>{winner}</strong>
            </>
          ) : (
            <span className="dim">{t('score.draw')}</span>
          )}
        </span>
        <span className="hint">{t('op.bracketUpdated')}</span>

        {next ? (
          <div className="stack g2">
            <span className="tiny faint">{t('op.nextAvailable')}</span>
            <span style={{ fontWeight: 650 }}>
              {nameOf(state, next.participantAId)} vs {nameOf(state, next.participantBId)}
            </span>
          </div>
        ) : (
          <span className="hint">{t('op.nothingElseReady')}</span>
        )}

        <div className="op-win__actions">
          <button type="button" className="op-btn op-btn--ghost" onClick={onClose}>
            {t('action.close')}
          </button>
          <button
            type="button"
            className="op-btn op-btn--start"
            onClick={onStartNext}
            disabled={!next || !canControl}
          >
            {t('op.startNext')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Blocking PIN prompt for control links. The host never grants a field scope
 * until the PIN matched, so refusing here really does leave the session
 * read-only rather than pretending.
 */
function PinPrompt({ message, onSubmit }: { message: string; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const { t } = useI18n();
  const valid = /^[0-9]{4,8}$/.test(pin);
  return (
    <div className="op-win" role="dialog" aria-modal="true">
      <form
        className="op-win__panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(pin);
        }}
      >
        <span className="tiny dim">{t('settings.requirePin')}</span>
        <span className="op-win__title">{t('op.unlockTitle')}</span>
        <p className="small dim">{message}</p>
        <input
          className="input input--num"
          style={{ fontSize: 'var(--step-3)', height: 'var(--touch-lg)', textAlign: 'center' }}
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
          aria-label={t('dialog.pin')}
          placeholder="••••"
        />
        <button type="submit" className="op-btn op-btn--start" disabled={!valid}>
          {t('op.unlock')}
        </button>
        <p className="hint">{t('op.pinHint')}</p>
      </form>
    </div>
  );
}

/**
 * Next match this operator may load: this field's own matches first, then a
 * match either field may host. A match owned by the other field is never pulled
 * onto this one.
 */
function nextReady(
  state: NonNullable<ReturnType<typeof useLive>['state']>,
  fieldId: FieldId,
): Match | null {
  const rank = new Map(state.matchOrder.map((id, index) => [id, index]));
  const ready = Object.values(state.matches).filter(
    (match) => match.state === 'READY' && !match.fieldId && match.participantAId && match.participantBId,
  );
  ready.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) || a.round - b.round || a.position - b.position);
  const own = ready.find((match) => homeFieldOf(state, match) === fieldId);
  if (own) return own;
  return ready.find((match) => homeFieldOf(state, match) === null) ?? null;
}
