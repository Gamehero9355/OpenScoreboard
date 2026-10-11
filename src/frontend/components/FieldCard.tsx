/**
 * One playing field, shown on the host dashboard.
 *
 * This is the densest control surface in the app: score buttons, timer
 * transport, undo/redo and the field's own event history. Everything that
 * happens during a live match is reachable in one click from here, because the
 * host is usually also the person answering questions at the desk.
 */
import { useState } from 'react';
import type { FieldId, JoinLink, Match, TournamentState } from '../../shared/types';
import { homeFieldOf, nameOf, isRealMatch, waitingReason } from '../../shared/matchUtils';
import { asTranslate, useI18n } from '../lib/useI18n';
import { live } from '../lib/live';
import { cx, formatTime, keyOf } from '../lib/util';
import { Badge, Button, CopyableUrl, Empty, MatchStateBadge } from './primitives';
import { QrCode } from './QrPanel';
import { FieldTitleBar, MatchClock, ScoreBlock } from './scoreboard';
import { IconLock, IconQr, IconRedo, IconSwap, IconUndo } from './icons';

export interface FieldCardProps {
  state: TournamentState;
  fieldId: FieldId;
  onAssign: (fieldId: FieldId) => void;
  onEndMatch: (match: Match) => void;
  onCorrect: (match: Match) => void;
  onOverride: (match: Match) => void;
  onUnassign: (fieldId: FieldId, matchTitle: string) => void;
  /** This field's operator control link (admin sessions only, null otherwise). */
  controlLink?: JoinLink | null;
  /** This field's public display-board link (visible to every role). */
  displayLink?: JoinLink | null;
}

export function FieldCard(props: FieldCardProps) {
  const { state, fieldId } = props;
  const { t } = useI18n();
  const field = state.fields[fieldId];
  const match = field.matchId ? state.matches[field.matchId] ?? null : null;

  return (
    <section className="field" aria-label={field.name}>
      <FieldTitleBar
        state={state}
        fieldId={fieldId}
        match={match}
        right={
          <>
            {field.controlledBy ? (
              <Badge tone="accent" title={t('fc.controlSince', { time: formatTime(field.controlledSince ?? Date.now()) })}>
                <IconLock size={11} />
                {field.controlledBy}
              </Badge>
            ) : null}
            <Button
              size="sm"
              tone="ghost"
              onClick={() => window.open(`/field/${fieldId}`, '_blank', 'noopener,width=520,height=900')}
              title={t('fc.openOperator')}
            >
              {t('role.operator')}
            </Button>
          </>
        }
      />
      <div className="field__body">
        {match ? <LiveMatch {...props} match={match} /> : <IdleField {...props} />}
        <FieldQrCodes
          operatorLink={props.controlLink ?? null}
          displayLink={props.displayLink ?? null}
          hasTournament={Boolean(state.tournament)}
          fieldName={field.name}
        />
      </div>
    </section>
  );
}

/**
 * QR codes belonging to this field, shown on the field itself: the public
 * display board plus (for admins, once a tournament exists) the operator
 * code. The operator code is generated with the tournament, so before one
 * exists there is nothing to scan yet.
 */
function FieldQrCodes({
  operatorLink,
  displayLink,
  hasTournament,
  fieldName,
}: {
  operatorLink: JoinLink | null;
  displayLink: JoinLink | null;
  hasTournament: boolean;
  fieldName: string;
}) {
  const [open, setOpen] = useState(true);
  const { t } = useI18n();
  if (!operatorLink && !displayLink) return null;
  return (
    <div className="stack g2" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
      <div className="between">
        <span className="tiny dim row g2">
          <IconQr size={12} /> {t('fc.qrCodes')}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? t('action.hide') : t('action.show')}
        </button>
      </div>
      {open ? (
        <div className="grid-2">
          {displayLink ? (
            <FieldQrTile
              link={displayLink}
              title={t('nav.display')}
              hint={t('fc.displayHint', { field: fieldName })}
            />
          ) : null}
          {operatorLink ? (
            hasTournament ? (
              <FieldQrTile
                link={operatorLink}
                title={t('role.operator')}
                hint={t('fc.operatorHint', { field: fieldName })}
              />
            ) : (
              <div className="stack g2">
                <span className="tiny dim">{t('role.operator')}</span>
                <p className="hint">{t('fc.operatorPending', { field: fieldName })}</p>
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FieldQrTile({ link, title, hint }: { link: JoinLink; title: string; hint: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack g2">
      <span className="tiny dim">{title}</span>
      <QrCode text={link.url} compact alt={t('fc.qrAlt', { title })} />
      <p className="hint">{hint}</p>
      <CopyableUrl
        url={link.url}
        label={copied ? t('fc.copied') : t('fc.copyLink')}
        onCopied={(ok) => {
          setCopied(ok);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      />
    </div>
  );
}

function IdleField({ state, fieldId, onAssign }: FieldCardProps) {
  const suggestion = suggestNext(state, fieldId);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();

  // One click loads the top of this field's own queue — no picking dialog.
  const assignTop = async () => {
    if (!suggestion) {
      onAssign(fieldId);
      return;
    }
    setBusy(true);
    const result = await live.command('match.assign', { matchId: suggestion.id, fieldId });
    setBusy(false);
    if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
  };

  return (
    <>
      <div className="field__empty stack g3" style={{ alignItems: 'center' }}>
        <span>
          {state.fields[fieldId].name} {t('field.free')}
        </span>
        {suggestion ? (
          <span className="dim small">
            {t('fc.nextInQueue')} {nameOf(state, suggestion.participantAId)} vs{' '}
            {nameOf(state, suggestion.participantBId)}
          </span>
        ) : null}
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <Button tone="primary" onClick={assignTop} busy={busy}>
            {suggestion ? t('action.autoAssign') : t('action.assign')}
          </Button>
          {suggestion ? (
            <Button tone="ghost" onClick={() => onAssign(fieldId)} title={t('fc.pickDifferent')}>
              {t('fc.choose')}
            </Button>
          ) : null}
        </div>
      </div>
      {suggestion ? null : (
        <p className="hint">{t('fc.nothingReady')}</p>
      )}
    </>
  );
}

function LiveMatch({
  state,
  fieldId,
  match,
  onEndMatch,
  onCorrect,
  onOverride,
  onUnassign,
}: FieldCardProps & { match: Match }) {
  const [showHistory, setShowHistory] = useState(false);
  const { t } = useI18n();
  const increments = state.settings.scoringIncrements;
  const running = match.state === 'RUNNING';
  const paused = match.state === 'PAUSED';
  const halftime = match.state === 'HALFTIME';
  const finished = match.state === 'FINISHED';
  const playable = Boolean(match.participantAId && match.participantBId);

  const score = (side: 'A' | 'B', delta: number) =>
    live.command('match.score', { matchId: match.id, side, delta, fieldId });

  const sides = [
    { side: 'A' as const, name: nameOf(state, match.participantAId), points: match.scoreA },
    { side: 'B' as const, name: nameOf(state, match.participantBId), points: match.scoreB },
  ];

  const deltas = [...new Set([...increments, -1])];

  return (
    <>
      <ScoreBlock state={state} match={match} />

      <div className="score__controls" role="group" aria-label={t('a11y.score')}>
        {sides.map((entry) => (
          <div key={entry.side} className="stack g1 grow">
            <span className="tiny faint nowrap">{entry.name}</span>
            <div className="btn-row">
              {deltas.map((delta) => (
                <Button
                  key={keyOf(entry.side, delta)}
                  size="sm"
                  disabled={finished || !playable}
                  onClick={() => score(entry.side, delta)}
                  title={
                    delta > 0
                      ? t('fc.addPoints', { n: Math.abs(delta), name: entry.name })
                      : t('fc.subtractPoints', { n: Math.abs(delta), name: entry.name })
                  }
                >
                  {delta > 0 ? `+${delta}` : delta}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="row g2 wrap">
        {halftime ? (
          <Button
            tone="primary"
            disabled={!playable || finished}
            onClick={() => live.command('match.startSecondHalf', { matchId: match.id, fieldId })}
          >
            {t('op.startSecondHalf')}
          </Button>
        ) : !running && !paused ? (
          <Button
            tone="primary"
            disabled={!playable || finished}
            onClick={() => live.command('match.start', { matchId: match.id, fieldId })}
          >
            {t('action.start')}
          </Button>
        ) : (
          <Button
            disabled={finished}
            onClick={() =>
              live.command(paused ? 'match.resume' : 'match.pause', { matchId: match.id, fieldId })
            }
          >
            {paused ? t('action.resume') : t('action.pause')}
          </Button>
        )}
        <Button
          disabled={match.history.length === 0}
          onClick={() => live.command('match.undo', { matchId: match.id, fieldId })}
          title={t('settings.scUndo')}
        >
          <IconUndo size={14} /> {t('action.undo')}
        </Button>
        <Button
          disabled={match.redoStack.length === 0}
          onClick={() => live.command('match.redo', { matchId: match.id, fieldId })}
          title={t('settings.scRedo')}
        >
          <IconRedo size={14} /> {t('action.redo')}
        </Button>
        <Button disabled={finished} onClick={() => live.command('match.reset', { matchId: match.id, fieldId })}>
          {t('action.reset')}
        </Button>
        <Button tone="danger" disabled={finished || !playable} onClick={() => onEndMatch(match)}>
          {t('action.finish')}
        </Button>
      </div>

      <div className="row g2 wrap">
        <Button size="sm" tone="ghost" onClick={() => onCorrect(match)}>
          {t('action.correct')}
        </Button>
        <Button size="sm" tone="ghost" onClick={() => onOverride(match)}>
          {t('action.override')}
        </Button>
        <Button
          size="sm"
          tone="ghost"
          onClick={() => onUnassign(fieldId, `${nameOf(state, match.participantAId)} vs ${nameOf(state, match.participantBId)}`)}
        >
          <IconSwap size={12} /> {t('action.unassign')}
        </Button>
        <Button
          size="sm"
          tone="ghost"
          onClick={() =>
            live.command('match.finish', { matchId: match.id, winner: null, force: false }).then((result) => {
              if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
            })
          }
          disabled={finished || !playable}
          title={t('fc.finishFromScore')}
        >
          {t('action.finish')}
        </Button>
      </div>

      {waitingReason(state, match, asTranslate(t)) ? <p className="hint">{waitingReason(state, match, asTranslate(t))}</p> : null}
      {finished ? (
        <p className="small">
          {t('score.winner')}: <strong>{nameOf(state, match.winnerId, t('score.draw'))}</strong>
          {match.finishedAt ? (
            <span className="faint">
              {' '}
              · {t('match.finished')} {formatTime(match.finishedAt)}
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="between">
        <span className="tiny faint">
          {match.roundName} · {t('dialog.matchLabel', { n: match.position + 1 })}
          {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => setShowHistory((value) => !value)}
        >
          {showHistory ? t('fc.hideLog', { n: match.history.length }) : t('fc.showLog', { n: match.history.length })}
        </button>
      </div>

      {showHistory ? (
        <div className="compact-list" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
          {match.history.length === 0 ? (
            <p className="empty">{t('fc.noActions')}</p>
          ) : (
            [...match.history].reverse().map((action) => (
              <div className="compact-list__row" key={action.id}>
                <span className="tiny faint mono">{formatTime(action.ts)}</span>
                <span className="grow nowrap">
                  {action.participantId ? nameOf(state, action.participantId) : t('action.correct')}{' '}
                  {action.delta !== 0 ? (
                    <span className={action.delta > 0 ? '' : 'dim'}>
                      {action.delta > 0 ? `+${action.delta}` : action.delta}
                    </span>
                  ) : null}
                  {action.note ? <span className="faint"> · {action.note}</span> : null}
                </span>
                <span className="tiny faint nowrap">
                  {action.prevA}:{action.prevB} → {action.nextA}:{action.nextB}
                </span>
                <span className="tiny faint nowrap">{action.actor}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The match this field should pick up next: its own first (both players were
 * registered here), then a match either field may host. Another field's match
 * is never suggested, so the desk is never nudged into taking over the other
 * field's queue.
 */
function suggestNext(state: TournamentState, fieldId: FieldId): Match | null {
  const rank = new Map(state.matchOrder.map((id, index) => [id, index]));
  const ready = Object.values(state.matches).filter(
    (match) => match.state === 'READY' && !match.fieldId && match.participantAId && match.participantBId,
  );
  ready.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
  const own = ready.find((match) => homeFieldOf(state, match) === fieldId);
  if (own) return own;
  return ready.find((match) => homeFieldOf(state, match) === null) ?? null;
}

/** Compact "what is on the fields" summary used by the sidebar. */
export function FieldSummary({ state, fieldId }: { state: TournamentState; fieldId: FieldId }) {
  const { t } = useI18n();
  const field = state.fields[fieldId];
  const match = field.matchId ? state.matches[field.matchId] ?? null : null;
  if (!match) return <Empty>{`${field.name} ${t('field.free')}`}</Empty>;
  return (
    <div className="compact-list__row">
      <span className="tiny faint nowrap">{field.name}</span>
      <span className="grow nowrap">
        {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
        {nameOf(state, match.participantBId)}
      </span>
      <span className={cx('tnum', 'small')}>
        <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
      </span>
      {match.state === 'FINISHED' ? <MatchStateBadge state={match.state} /> : <MatchClock match={match} />}
      {isRealMatch(match) ? null : <span className="tiny faint">{t('fc.noScore')}</span>}
    </div>
  );
}
