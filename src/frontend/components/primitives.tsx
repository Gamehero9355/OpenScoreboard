/** Shared UI primitives. Deliberately small and unstyled-by-default so pages
 *  compose them instead of fighting them. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import type { MatchState, TournamentStatus } from '../../shared/types';
import { MATCH_STATE_TONE } from '../../shared/matchUtils';
import { useLive } from '../lib/hooks';
import { formatDateTime, type MessageKey } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';
import { live } from '../lib/live';
import { copyText, cx } from '../lib/util';
import { IconAlert, IconCheck, IconClose, IconWifi, IconWifiOff } from './icons';

/* ------------------------------------------------------------------ */
/* Button                                                             */
/* ------------------------------------------------------------------ */

type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  busy?: boolean;
}

export function Button({
  tone = 'default',
  size = 'md',
  block,
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'btn',
        tone === 'primary' && 'btn--primary',
        tone === 'danger' && 'btn--danger',
        tone === 'ghost' && 'btn--ghost',
        size === 'sm' && 'btn--small',
        size === 'lg' && 'btn--lg',
        block && 'btn--block',
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                             */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = 'neutral',
  dot,
  children,
  title,
}: {
  tone?: 'neutral' | 'live' | 'warn' | 'info' | 'danger' | 'accent' | 'done';
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cx('badge', tone !== 'neutral' && `badge--${tone}`)} {...(title ? { title } : {})}>
      {dot ? <span className="badge__dot" /> : null}
      {children}
    </span>
  );
}

/**
 * Which catalogue key speaks for each match state.
 *
 * A table of keys rather than a table of strings: the shared `MATCH_STATE_LABEL`
 * cannot call a hook, and the badge has to follow the language of whichever
 * device it is rendered on.
 */
const MATCH_STATE_KEY: Record<MatchState, MessageKey> = {
  WAITING: 'match.pending',
  READY: 'match.ready',
  ASSIGNED: 'match.scheduled',
  RUNNING: 'match.running',
  PAUSED: 'match.paused',
  HALFTIME: 'match.halftime',
  FINISHED: 'match.finished',
  CANCELLED: 'match.cancelled',
};

/** The localised name of a match state, for screens that print the raw enum. */
export function useMatchStateLabel(): (state: MatchState) => string {
  const { t } = useI18n();
  return useCallback((state: MatchState) => t(MATCH_STATE_KEY[state]), [t]);
}

/** The same, for the tournament's own lifecycle. `null` = no key, print the raw value. */
const TOURNAMENT_STATUS_KEY: Record<TournamentStatus, MessageKey | null> = {
  DRAFT: 'match.scheduled',
  RUNNING: 'match.running',
  COMPLETED: 'match.finished',
  ARCHIVED: null,
};

/** The localised name of a tournament status. */
export function useTournamentStatusLabel(): (status: TournamentStatus) => string {
  const { t } = useI18n();
  return useCallback((status: TournamentStatus) => {
    const key = TOURNAMENT_STATUS_KEY[status];
    return key ? t(key) : status;
  }, [t]);
}

export function MatchStateBadge({ state }: { state: MatchState }) {
  const { t } = useI18n();
  return (
    <Badge tone={MATCH_STATE_TONE[state] as 'neutral' | 'live' | 'warn' | 'info' | 'accent' | 'done'} dot={state === 'RUNNING'}>
      {t(MATCH_STATE_KEY[state])}
    </Badge>
  );
}

/** Live connection indicator. Colour plus text, never colour alone. */
export function ConnectionBadge({ compact = false }: { compact?: boolean }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const { connection } = snapshot;
  const label = t(
    connection === 'live'
      ? 'conn.live'
      : connection === 'connecting'
        ? 'conn.connecting'
        : connection === 'reconnecting'
          ? 'conn.reconnecting'
          : 'conn.offline',
  );
  const tone =
    connection === 'live' ? 'live' : connection === 'connecting' ? 'info' : connection === 'offline' ? 'danger' : 'warn';
  return (
    <Badge tone={tone} dot title={compact ? label : undefined}>
      {connection === 'live' ? <IconWifi size={12} /> : <IconWifiOff size={12} />}
      {label}
    </Badge>
  );
}

/** "All changes saved" indicator driven by the host's persistence status. */
export function SaveIndicator({ lastSaveAt, pending }: { lastSaveAt: number | null; pending: number }) {
  const { locale, t } = useI18n();
  const label = pending > 0 ? t('diag.savedPending') : lastSaveAt ? t('diag.savedOk') : t('diag.savedWaiting');
  const tone = pending > 0 ? 'warn' : lastSaveAt ? 'live' : 'neutral';
  return (
    <span className={cx('statusbar__item', 'tiny')} title={lastSaveAt ? formatDateTime(locale, lastSaveAt) : undefined}>
      <span className={cx('dot', tone === 'live' && 'dot--live', tone === 'warn' && 'dot--warn')} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                     */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx('panel', className)}>
      {title || actions ? (
        <header className="panel__head">
          <h2 className="panel__title">{title}</h2>
          {actions ? <div className="row g2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('panel__body', flush && 'panel__body--flush')}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/* ------------------------------------------------------------------ */
/* Page header                                                        */
/* ------------------------------------------------------------------ */

/**
 * The figure strip every top-level page opens with.
 *
 * One sheet -- the same object as the panels beneath it -- carrying a row of
 * labelled figure cells that share the full width and are split by hairlines.
 *
 * It replaces a flex row of edge-anchored zones. On any screen wider than about
 * 1100px that row opened a hole most of the page wide between the tournament
 * name and the one number the page exists to show, stranded that number as a
 * 7.5rem stick in the far corner beside the buttons, and spilled the reference
 * facts onto an orphan row under a full-width rule. A strip has no hole to
 * have: every cell is a column of the same ruler, so the slack is shared and
 * the row folds to two columns and then one instead of reflowing.
 *
 * Reference facts stay cells rather than becoming a card of their own. Ruleset,
 * age class and match lengths are looked up once, not watched, and a card gave
 * four short facts a hundred pixels of their own, outranking the matches the
 * page is actually about.
 *
 *   <PageHeader
 *     title={tournament.name}
 *     chips={<><Badge â€¦ /></>}
 *     progress={{ done, total, label: 'Matches' }}
 *     facts={[{ label: 'Ruleset', value: 'UCI Radball 2025' }, â€¦]}
 *     actions={<>â€¦</>}
 *   />
 */
export function PageHeader({
  title,
  chips,
  progress,
  facts,
  actions,
}: {
  title: string;
  chips?: ReactNode;
  progress?: { done: number; total: number; label: string };
  facts?: { label: string; value: ReactNode }[];
  actions?: ReactNode;
}) {
  return (
    <header className="pagehead">
      <div className="pagehead__strip">
        <div className="pagehead__cell pagehead__id">
          <h1 className="pagehead__title">{title}</h1>
          {chips ? <div className="pagehead__chips">{chips}</div> : null}
        </div>
        {progress ? <ProgressMeter done={progress.done} total={progress.total} label={progress.label} /> : null}
        {(facts ?? []).map((fact) => (
          <div className="pagehead__cell" key={fact.label}>
            <span className="pagehead__key">{fact.label}</span>
            <span className="pagehead__value">{fact.value}</span>
          </div>
        ))}
      </div>
      {actions ? <div className="pagehead__actions">{actions}</div> : null}
    </header>
  );
}

/**
 * How far the tournament has got, as the strip's one measurement.
 *
 * A count is not a state, so it gets tabular figures and a track rather than a
 * badge. The track runs the full width of its cell instead of a fixed 7.5rem,
 * which is what makes the cell read as a column of the strip rather than a
 * widget parked at the end of a row. It is exposed to assistive tech as a
 * progressbar with the label as its accessible name.
 */
export function ProgressMeter({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const { t } = useI18n();
  const safeTotal = Math.max(0, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  const percent = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;
  const complete = safeTotal > 0 && safeDone >= safeTotal;

  return (
    <div className={cx('pagehead__cell', 'progress', complete && 'progress--done')}>
      <span className="pagehead__key">{label}</span>
      <span className="progress__value tnum">
        {safeDone}
        <span className="progress__of">/{safeTotal}</span>
      </span>
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safeDone}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuetext={t('a11y.progress', { done: safeDone, total: safeTotal, label })}
      >
        <span className="progress__fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                      */
/* ------------------------------------------------------------------ */

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, className, id, ...rest }: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [rest['aria-describedby'], hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field-row">
      <label className="label" htmlFor={fieldId}>
        {label}
      </label>
      <input
        {...rest}
        id={fieldId}
        className={cx('input', error && 'input--invalid', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <span className="field-error" id={errorId} role="alert">
        {error ?? ''}
      </span>
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function SelectField({ label, hint, error, children, id, ...rest }: SelectFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [rest['aria-describedby'], hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field-row">
      <label className="label" htmlFor={fieldId}>
        {label}
      </label>
      <select
        {...rest}
        id={fieldId}
        className={cx('select', error && 'input--invalid')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      >
        {children}
      </select>
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <span className="field-error" id={errorId} role="alert">
        {error ?? ''}
      </span>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch__track" />
      <span className="stack">
        <span>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={cx('segmented', className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { t } = useI18n();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('data-modal-close'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        ref.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    const target = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-modal-close])',
    );
    target?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={cx('modal', wide && 'modal--wide')}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        ref={ref}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <Button tone="ghost" size="sm" onClick={onClose} aria-label={t('action.close')} data-modal-close>
            <IconClose />
          </Button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Confirmation for anything destructive or irreversible. Always spells out the
 * consequence in words instead of relying on the button colour.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ButtonTone;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button tone="ghost" onClick={onCancel}>
            {cancelLabel ?? t('action.cancel')}
          </Button>
          <Button tone={tone} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                             */
/* ------------------------------------------------------------------ */

export function Toasts() {
  const snapshot = useLive();
  const { t } = useI18n();
  if (snapshot.toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {snapshot.toasts.map((toast) => (
        <div key={toast.id} className={cx('toast', `toast--${toast.level}`)}>
          <span aria-hidden="true">
            {toast.level === 'error' ? <IconAlert /> : toast.level === 'warn' ? <IconAlert /> : <IconCheck />}
          </span>
          <span className="grow">{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            onClick={() => live.dismissToast(toast.id)}
            aria-label={t('a11y.dismiss')}
          >
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

export function CopyableUrl({
  url,
  label,
  onCopied,
}: {
  url: string;
  label?: string;
  onCopied?: (ok: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="url"
      style={{ cursor: 'pointer', textAlign: 'left' }}
      title={t('action.copyHint')}
      onClick={async () => {
        const ok = await copyText(url);
        onCopied?.(ok);
      }}
    >
      <span className="url__text">{url}</span>
      <span className="tiny faint nowrap">{label ?? t('action.copy')}</span>
    </button>
  );
}

export function Steps({ steps, active }: { steps: string[]; active: number }) {
  const { t } = useI18n();
  return (
    <ol className="steps" aria-label={t('a11y.setupProgress')}>
      {steps.map((step, index) => (
        <li
          key={step}
          className={cx(
            'steps__item',
            index < active && 'steps__item--done',
            index === active && 'steps__item--active',
          )}
          aria-current={index === active ? 'step' : undefined}
        >
          <span className="steps__num" aria-hidden="true">
            {index + 1}
          </span>
          <span>{step}</span>
          {index < active ? <span className="sr-only">{t('field.completed')}</span> : null}
        </li>
      ))}
    </ol>
  );
}
