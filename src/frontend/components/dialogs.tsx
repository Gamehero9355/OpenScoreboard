/**
 * Dialogs shared by the host dashboard and the field operator.
 *
 * Each one performs a real server command and reports the server's answer, so
 * "END MATCH" behaves identically no matter which screen triggered it.
 */
import { useMemo, useState } from 'react';
import type { FieldId, Match, TournamentState } from '../../shared/types';
import { fieldDisplayName, fieldIds, isRealMatch, nameOf, waitingReason } from '../../shared/matchUtils';
import { live } from '../lib/live';
import { useLive } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { Badge, Button, ConfirmDialog, Modal, MatchStateBadge, TextField } from './primitives';
import { ShootoutPanel } from './ShootoutPanel';
import { cx } from '../lib/util';

/* ------------------------------------------------------------------ */
/* End match                                                          */
/* ------------------------------------------------------------------ */

export function EndMatchDialog({
  match,
  onClose,
  onFinished,
}: {
  match: Match;
  onClose: () => void;
  onFinished?: (winnerId: string | null) => void;
}) {
  const { state } = useLive();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const aName = state ? nameOf(state, match.participantAId) : t('score.side', { side: 'A' });
  const bName = state ? nameOf(state, match.participantBId) : t('score.side', { side: 'B' });
  const level = match.scoreA === match.scoreB;
  const winner: 'A' | 'B' | null =
    match.scoreA > match.scoreB ? 'A' : match.scoreB > match.scoreA ? 'B' : null;
  const allowDraws = state?.settings.allowDraws ?? false;
  const radballMeta = match.radball;
  const isDecision = radballMeta?.kind === 'decision';
  const isRadballGroup = Boolean(radballMeta) && !isDecision;
  const shootout = radballMeta?.shootout ?? null;
  const shootoutDecided = Boolean(shootout?.decided && shootout?.winnerId);

  const confirm = async (side: 'A' | 'B' | null) => {
    setBusy(true);
    const result = await live.command('match.finish', {
      matchId: match.id,
      winner: side,
      force: false,
    });
    setBusy(false);
    if (result.ok) {
      onFinished?.(side === 'A' ? match.participantAId : side === 'B' ? match.participantBId : null);
      onClose();
    }
  };

  const confirmWithWinner = async () => {
    setBusy(true);
    const result = await live.command('match.finish', {
      matchId: match.id,
      winner: shootoutDecided ? null : winner,
      force: false,
    });
    setBusy(false);
    if (result.ok) {
      onFinished?.(null);
      onClose();
    }
  };

  /** Referee input for the 4-meter shootout; the server enforces the order. */
  const recordAttempt = (side: 'A' | 'B', shooter: number, hit: boolean) => {
    void live
      .command('radball.shootoutRecord', { matchId: match.id, side, shooter, hit })
      .then((result) => {
        if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
      });
  };

  return (
    <Modal
      title={isDecision ? t('round.decision') : t('dialog.endMatch')}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          {isDecision && level && !shootoutDecided ? null : isDecision && level && shootoutDecided ? (
            <Button tone="primary" onClick={confirmWithWinner} busy={busy}>
              {t('dialog.confirmDecision')}
            </Button>
          ) : level ? (
            <>
              {isRadballGroup ? null : (
                <>
                  <Button onClick={() => confirm('A')} busy={busy} disabled={!match.participantAId}>
                    {t('score.winner')}: {aName}
                  </Button>
                  <Button onClick={() => confirm('B')} busy={busy} disabled={!match.participantBId}>
                    {t('score.winner')}: {bName}
                  </Button>
                </>
              )}
              {isRadballGroup ? (
                <Button tone="primary" onClick={() => confirm(null)} busy={busy}>
                  {t('score.recordDraw')}
                </Button>
              ) : allowDraws ? (
                <Button tone="danger" onClick={() => confirm(null)} busy={busy}>
                  {t('score.recordDraw')}
                </Button>
              ) : null}
            </>
          ) : (
            <Button tone="primary" onClick={() => confirm(winner)} busy={busy}>
              {t('dialog.confirmResult')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack g3">
        <p className="small dim">
          {match.roundName} · {t('dialog.matchLabel', { n: match.position + 1 })}
          {match.fieldId && state ? ` · ${fieldDisplayName(state.fields[match.fieldId]?.name, match.fieldId, asTranslate(t))}` : ''}
          {isDecision ? t('dialog.mustProduceWinner') : ''}
        </p>
        <div className="stack g1">
          <div className="between">
            <span className={cx(winner === 'A' && 'grow')}>{aName}</span>
            <span className="tnum" style={{ fontSize: 'var(--step-4)', fontWeight: 700 }}>
              {match.scoreA}
            </span>
          </div>
          <div className="between">
            <span className={cx(winner === 'B' && 'grow')}>{bName}</span>
            <span className="tnum" style={{ fontSize: 'var(--step-4)', fontWeight: 700 }}>
              {match.scoreB}
            </span>
          </div>
        </div>
        {isDecision && level && !shootoutDecided ? (
          <>
            <p className="banner banner--warn" style={{ border: 0, borderRadius: 'var(--radius)' }}>
              <strong>{t('radball.shootoutDecides')}</strong> {t('dialog.shootoutPrompt')}
            </p>
            <ShootoutPanel state={state!} match={match} shootout={shootout} onRecord={recordAttempt} />
          </>
        ) : level && isRadballGroup ? (
          <p className="banner banner--info" style={{ border: 0, borderRadius: 'var(--radius)' }}>
            {t('radball.drawAllowed')}
          </p>
        ) : level ? (
          <p className="banner banner--warn" style={{ border: 0, borderRadius: 'var(--radius)' }}>
            {t('dialog.level')}
          </p>
        ) : (
          <p className="small">
            {t('score.winner')}: <strong>{winner === 'A' ? aName : bName}</strong>
            {isRealMatch(match) ? null : <span className="dim">{t('dialog.noScoreYet')}</span>}
          </p>
        )}
        {match.history.length > 0 ? (
          <p className="hint">
            {match.history.length === 1
              ? t('dialog.historyOne')
              : t('dialog.history', { n: match.history.length })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Assign a match to a field                                          */
/* ------------------------------------------------------------------ */

export function AssignMatchDialog({
  state,
  fieldId,
  onClose,
}: {
  state: TournamentState;
  fieldId: FieldId;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { t } = useI18n();

  const candidates = useMemo(() => {
    const order = state.matchOrder;
    const rank = new Map(order.map((id, index) => [id, index]));
    return Object.values(state.matches)
      .filter((match) => match.state === 'READY' || (match.state === 'ASSIGNED' && match.fieldId !== fieldId))
      .filter((match) => {
        if (!filter.trim()) return true;
        const needle = filter.trim().toLowerCase();
        return `${nameOf(state, match.participantAId)} ${nameOf(state, match.participantBId)} ${match.roundName}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
  }, [state, fieldId, filter]);

  const assign = async (matchId: string) => {
    setBusyId(matchId);
    const result = await live.command('match.assign', { matchId, fieldId });
    setBusyId(null);
    if (result.ok) onClose();
  };

  return (
    <Modal
      title={t('field.assignTo', { field: state.fields[fieldId].name })}
      onClose={onClose}
      wide
      footer={
        <Button tone="ghost" onClick={onClose}>
          {t('action.close')}
        </Button>
      }
    >
      <TextField
        label={t('ph.search')}
        placeholder={t('dialog.searchPlaceholder')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {candidates.length === 0 ? (
        <p className="empty">{t('dialog.noCandidates')}</p>
      ) : (
        <div className="compact-list" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
          {candidates.map((match) => (
            <div key={match.id} className="compact-list__row">
              <div className="grow">
                <div>
                  {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                  {nameOf(state, match.participantBId)}
                </div>
                <div className="queue__label">
                  {match.roundName} · {t('dialog.matchLabel', { n: match.position + 1 })}
                  {match.fieldId
                    ? t('dialog.currentlyOn', {
                        field: fieldDisplayName(state.fields[match.fieldId]?.name, match.fieldId, asTranslate(t)),
                      })
                    : ''}
                </div>
              </div>
              <MatchStateBadge state={match.state} />
              <Button
                size="sm"
                tone="primary"
                onClick={() => assign(match.id)}
                busy={busyId === match.id}
              >
                {t('action.assign')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Score correction                                                   */
/* ------------------------------------------------------------------ */

export function ScoreCorrectionDialog({ match, onClose }: { match: Match; onClose: () => void }) {
  const { state } = useLive();
  const { t } = useI18n();
  const [a, setA] = useState(String(match.scoreA));
  const [b, setB] = useState(String(match.scoreB));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state) return null;

  const submit = async () => {
    const scoreA = Number(a);
    const scoreB = Number(b);
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      setError(t('dialog.scoreInvalid'));
      return;
    }
    setBusy(true);
    const result = await live.command('match.correct', {
      matchId: match.id,
      scoreA,
      scoreB,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? t('err.generic'));
  };

  return (
    <Modal
      title={t('dialog.correct')}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button tone="primary" onClick={submit} busy={busy}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      <div className="stack g3">
        <p className="small dim">
          {nameOf(state, match.participantAId)} vs {nameOf(state, match.participantBId)} · {match.roundName}
        </p>
        <div className="grid-2">
          <TextField
            label={nameOf(state, match.participantAId)}
            className="input--num"
            inputMode="numeric"
            value={a}
            onChange={(event) => setA(event.target.value)}
          />
          <TextField
            label={nameOf(state, match.participantBId)}
            className="input--num"
            inputMode="numeric"
            value={b}
            onChange={(event) => setB(event.target.value)}
          />
        </div>
        <TextField
          label={t('dialog.reasonLabel')}
          placeholder={t('dialog.reasonPlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {match.state === 'FINISHED' ? <p className="hint">{t('dialog.correctFinished')}</p> : null}
        {error ? <p className="banner banner--error" style={{ borderRadius: 'var(--radius)' }}>{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Manual participant override                                        */
/* ------------------------------------------------------------------ */

export function ManualOverrideDialog({ match, onClose }: { match: Match; onClose: () => void }) {
  const { state } = useLive();
  const { t } = useI18n();
  const [a, setA] = useState(match.participantAId ?? '');
  const [b, setB] = useState(match.participantBId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state) return null;
  const participants = state.participantOrder
    .map((id) => state.participants[id])
    .filter((participant) => Boolean(participant));
  const homeField = (fieldId: string | null): string => {
    if (!fieldId) return '';
    const index = Number(fieldId) - 1;
    const name = state.settings.fieldNames[index];
    return ` · ${fieldDisplayName(name, fieldId, asTranslate(t))}`;
  };

  const submit = async () => {
    if (a && a === b) {
      setError(t('dialog.selfMatch'));
      return;
    }
    setBusy(true);
    const result = await live.command('match.setParticipants', {
      matchId: match.id,
      participantAId: a || null,
      participantBId: b || null,
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? t('err.generic'));
  };

  return (
    <Modal
      title={t('dialog.override')}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button tone="primary" onClick={submit} busy={busy}>
            {t('action.apply')}
          </Button>
        </>
      }
    >
      <div className="stack g3">
        <p className="small dim">
          {t('dialog.overrideLine', { round: match.roundName, n: match.position + 1 })}
        </p>
        <label className="field-row">
          <span className="label">{t('score.side', { side: 'A' })}</span>
          <select className="select" value={a} onChange={(event) => setA(event.target.value)}>
            <option value="">— {t('match.bye').trim()} —</option>
            {participants.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
                {homeField(participant.fieldId)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span className="label">{t('score.side', { side: 'B' })}</span>
          <select className="select" value={b} onChange={(event) => setB(event.target.value)}>
            <option value="">— {t('match.bye').trim()} —</option>
            {participants.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
                {homeField(participant.fieldId)}
              </option>
            ))}
          </select>
        </label>
        {waitingReason(state, match, asTranslate(t)) ? <p className="hint">{waitingReason(state, match, asTranslate(t))}</p> : null}
        {error ? <p className="banner banner--error" style={{ borderRadius: 'var(--radius)' }}>{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Small confirmations                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Manual schedule                                                     */
/* ------------------------------------------------------------------ */

/**
 * Write one fixture of a manual schedule, or change one that is already there.
 *
 * The same dialog serves both because they are the same question -- which two
 * teams, what round, which field -- asked once with a match in hand and once
 * without. Editing an existing fixture only sends what actually changed, so a
 * host who came to fix a spelling in the round label does not also re-lock the
 * participants (which `match.setParticipants` does by design, since it is the
 * bracket-override command).
 *
 * For an existing fixture the dialog also offers removal: a manual schedule is
 * a list the host typed, and the natural way to take one entry off it is from
 * where they are already looking at it.
 */
export function ManualScheduleDialog({ match, onClose }: { match: Match | null; onClose: () => void }) {
  const { state } = useLive();
  const { t } = useI18n();
  const [a, setA] = useState(match?.participantAId ?? '');
  const [b, setB] = useState(match?.participantBId ?? '');
  const [round, setRound] = useState(match?.roundName ?? '');
  const [field, setField] = useState(match?.fieldId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!state) return null;
  const participants = state.participantOrder
    .map((id) => state.participants[id])
    .filter((participant) => Boolean(participant));
  const running = match?.state === 'RUNNING' || match?.state === 'PAUSED' || match?.state === 'HALFTIME';
  const participantsChanged =
    match === null || a !== (match.participantAId ?? '') || b !== (match.participantBId ?? '');
  const roundChanged = match === null || round.trim() !== match.roundName;
  const fieldChanged = match !== null && (field || null) !== (match.fieldId ?? null);

  /** A side may offer everybody except whoever already occupies the other side. */
  const sideOptions = (current: string, other: string) =>
    participants.filter((participant) => participant.id === current || participant.id !== other);

  const submit = async () => {
    if (a && a === b) {
      setError(t('dialog.selfMatch'));
      return;
    }
    if (!a || !b) {
      setError(t('setup.err.fillBothSides'));
      return;
    }
    setBusy(true);
    setError(null);
    if (match === null) {
      const created = await live.command('match.add', {
        participantAId: a,
        participantBId: b,
        ...(round.trim() ? { roundName: round.trim() } : {}),
        ...(field ? { fieldId: field } : {}),
      });
      setBusy(false);
      if (created.ok) onClose();
      else setError(created.error ?? t('err.generic'));
      return;
    }
    // Participants first: the field assignment below needs both of them known,
    // and the round name is the one change that cannot invalidate anything.
    if (participantsChanged) {
      const moved = await live.command('match.setParticipants', {
        matchId: match.id,
        participantAId: a,
        participantBId: b,
      });
      if (!moved.ok) {
        setBusy(false);
        setError(moved.error ?? t('err.generic'));
        return;
      }
    }
    if (fieldChanged && field) {
      const assigned = await live.command('match.assign', { matchId: match.id, fieldId: field });
      if (!assigned.ok) {
        setBusy(false);
        setError(assigned.error ?? t('err.generic'));
        return;
      }
    }
    if (roundChanged) {
      const renamed = await live.command('match.setRoundName', {
        matchId: match.id,
        roundName: round.trim() || match.roundName,
      });
      if (!renamed.ok) {
        setBusy(false);
        setError(renamed.error ?? t('err.generic'));
        return;
      }
    }
    setBusy(false);
    onClose();
  };

  const remove = async () => {
    if (!match) return;
    setBusy(true);
    const result = await live.command('match.remove', { matchId: match.id });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? t('err.generic'));
  };

  /** Where a team started, so a pick list does not have to say it twice. */
  const homeField = (fieldId: string | null): string => {
    if (!fieldId) return '';
    const index = Number(fieldId) - 1;
    return ` · ${fieldDisplayName(state.settings.fieldNames[index], fieldId, asTranslate(t))}`;
  };

  return (
    <Modal
      title={match === null ? t('setup.scheduleAdd') : `${t('action.edit')} — ${match.roundName}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            {t('action.cancel')}
          </Button>
          <Button tone="primary" onClick={submit} busy={busy}>
            {match === null ? t('setup.scheduleAdd') : t('action.apply')}
          </Button>
        </>
      }
    >
      <div className="stack g3">
        <label className="field-row">
          <span className="label">{t('score.side', { side: 'A' })}</span>
          <select className="select" value={a} onChange={(event) => setA(event.target.value)}>
            <option value="">{t('setup.schedulePickTeam')}</option>
            {sideOptions(a, b).map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
                {homeField(participant.fieldId)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span className="label">{t('score.side', { side: 'B' })}</span>
          <select className="select" value={b} onChange={(event) => setB(event.target.value)}>
            <option value="">{t('setup.schedulePickTeam')}</option>
            {sideOptions(b, a).map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.name}
                {participant.team ? ` · ${participant.team}` : ''}
                {homeField(participant.fieldId)}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label={t('setup.scheduleRound')}
          value={round}
          maxLength={24}
          onChange={(event) => setRound(event.target.value.slice(0, 24))}
          placeholder={t('setup.scheduleRoundPlaceholder')}
          hint={t('setup.scheduleRoundHint')}
        />
        <label className="field-row">
          <span className="label">{t('setup.scheduleField')}</span>
          <select className="select" value={field} onChange={(event) => setField(event.target.value)}>
            <option value="">{t('setup.scheduleFieldAny')}</option>
            {fieldIds(state).map((fieldId) => (
              <option key={fieldId} value={fieldId}>
                {fieldDisplayName(state.fields[fieldId]?.name, fieldId, asTranslate(t))}
              </option>
            ))}
          </select>
        </label>
        {running ? <p className="hint">{t('dialog.overrideRunning')}</p> : null}
        {error ? <p className="banner banner--error" style={{ borderRadius: 'var(--radius)' }}>{error}</p> : null}
        {match === null ? null : confirmRemove ? (
          <ConfirmDialog
            title={t('setup.scheduleRemove')}
            confirmLabel={t('action.remove')}
            cancelLabel={t('action.cancel')}
            tone="danger"
            busy={busy}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={remove}
            body={
              <div className="stack g2">
                <p>{t('dialog.removeMatchBody', { round: match.roundName })}</p>
                <p className="hint">{t('dialog.removeMatchHint')}</p>
              </div>
            }
          />
        ) : (
          <Button tone="ghost" onClick={() => setConfirmRemove(true)} disabled={running || busy}>
            {t('setup.scheduleRemove')}
          </Button>
        )}
      </div>
    </Modal>
  );
}

export function ResetMatchDialog({ match, onClose }: { match: Match; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  return (
    <ConfirmDialog
      title={`${t('action.reset')} — ${t('dialog.confirm')}`}
      confirmLabel={t('action.reset')}
      tone="danger"
      busy={busy}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        const result = await live.command('match.reset', { matchId: match.id });
        setBusy(false);
        if (result.ok) onClose();
      }}
      body={
        <div className="stack g2">
          <p>{t('dialog.resetBody')}</p>
          <p className="hint">{t('dialog.resetHint')}</p>
        </div>
      }
    />
  );
}

export function UnassignDialog({
  fieldId,
  matchTitle,
  onClose,
}: {
  fieldId: FieldId;
  matchTitle: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  return (
    <ConfirmDialog
      title={`${t('dialog.unassign')} — ${t('dialog.confirm')}`}
      confirmLabel={t('action.unassign')}
      busy={busy}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        const result = await live.command('match.unassign', { fieldId });
        setBusy(false);
        if (result.ok) onClose();
      }}
      body={
        <p>
          {t('dialog.unassignBefore', { match: matchTitle })} <Badge tone="info">{t('match.ready')}</Badge>.{' '}
          {t('dialog.unassignAfter')}
        </p>
      }
    />
  );
}
