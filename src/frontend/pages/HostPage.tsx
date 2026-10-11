/**
 * Host dashboard.
 *
 * Layout follows the way a desk works during an event: the two playing fields
 * dominate the middle, the queue and the completed results sit in a fixed side
 * column you can glance at without scrolling, and the machine's own health is a
 * single status line at the bottom.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FieldId, Match, SystemStatus, TournamentState } from '../../shared/types';
import {
  fieldIds,
  fieldQueue,
  hasHomeRosters,
  homeFieldOf,
  isOnField,
  isRealMatch,
  matchTitle,
  nameOf,
  sharedQueue,
  waitingReason,
} from '../../shared/matchUtils';
import { live } from '../lib/live';
import { useLive, useLocalStorage, useNow } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { navigate } from '../lib/router';
import { cx, formatTime, relativeTime, tokenHeader } from '../lib/util';
import { resolveAccess } from '../lib/token';
import { Button, ConnectionBadge, Empty, MatchStateBadge, Panel, SaveIndicator } from '../components/primitives';
import { QrGallery } from '../components/QrPanel';
import { DisplayScreenPicker } from '../components/DisplayScreenPicker';
import { BracketView } from '../components/BracketView';
import { FieldCard } from '../components/FieldCard';
import {
  AssignMatchDialog,
  EndMatchDialog,
  ManualOverrideDialog,
  ManualScheduleDialog,
  ScoreCorrectionDialog,
  UnassignDialog,
} from '../components/dialogs';
import { IconQr, IconSwap, IconUsers } from '../components/icons';
import { openDecisionMatches } from '../lib/radball';
import { eventLine } from '../lib/eventText';

interface DialogState {
  kind: 'assign' | 'end' | 'correct' | 'override' | 'schedule' | 'unassign' | 'qr' | 'swap';
  fieldId?: FieldId;
  match?: Match | null;
  title?: string;
}

export function HostPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const { state, role } = snapshot;
  const now = useNow(2000);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [treeFullscreen, setTreeFullscreen] = useState(false);

  const isAdmin = role === 'admin';

  /* ---------------- machine health (admin only) ---------------- */
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { token } = resolveAccess();
        const response = await fetch('/api/system', { headers: tokenHeader(token) });
        if (!response.ok) return;
        const body = (await response.json()) as SystemStatus;
        if (!cancelled) setSystem(body);
      } catch {
        /* the status line falls back to WebSocket data */
      }
    };
    void load();
    const id = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isAdmin]);

  const completed = useMemo(() => (state ? finishedMatches(state) : []), [state]);
  const [storedTab, setStoredTab] = useLocalStorage<string | null>('tsb.host.fieldTab', null);

  // Every hook has to run before the guard below, in the same order on every
  // render: this callback used to sit after the early return, so the first
  // render (no state yet) ran one hook fewer than the second and React tore the
  // whole dashboard down with "rendered fewer hooks than expected" -- a blank
  // screen exactly when the host is opening the app.
  const closeTreeFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setTreeFullscreen(false);
  }, []);

  if (!state) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('conn.connecting')}…</p>
        <p className="hint">
          {snapshot.connection === 'live' ? t('host.loadingState') : t('host.waitingConnection')}
        </p>
      </div>
    );
  }

  // One tab per playing field; the choice survives reloads and follows the
  // tournament when fields are added or removed.
  const ids = fieldIds(state);
  const activeField = storedTab && ids.includes(storedTab) ? storedTab : (ids[0] ?? '1');
  const selectField = (fieldId: FieldId) => {
    setStoredTab(fieldId);
    // A field tab owns its control surface: dialogs scoped to another field
    // close when you leave it, so the other field's match display never
    // lingers over the newly opened field. Global dialogs (QR, swap) stay.
    setDialog((current) => {
      if (!current) return current;
      if (current.kind === 'qr' || current.kind === 'swap') return current;
      if (current.kind === 'assign' || current.kind === 'unassign') {
        return current.fieldId === fieldId ? current : null;
      }
      const matchField = current.match?.fieldId ?? null;
      if (!matchField) return current;
      return matchField === fieldId ? current : null;
    });
  };

  const closeDialog = () => setDialog(null);

  /* ---------------- the tree, full screen ---------------- */
  const openTreeFullscreen = () => {
    setTreeFullscreen(true);
    // Has to run in the click's own task; the browser rejects the request when
    // it comes later. A refusal is not fatal: the overlay is fixed to the
    // viewport anyway, so the tree still fills the window.
    const root = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (root.requestFullscreen) void root.requestFullscreen().catch(() => undefined);
  };

  // One click puts a match on a field -- the queue rows are the fastest path
  // during a live event, so they never open a dialog.
  const assign = async (matchId: string, fieldId: FieldId) => {
    const result = await live.command('match.assign', { matchId, fieldId });
    if (!result.ok) live.pushToast('warn', result.error ?? t('err.generic'));
  };

  return (
    <>
      {!state.tournament ? (
        <p className="banner banner--info">
          <IconUsers size={15} />
          <span className="grow">
            No tournament is loaded. Create one, or start the demo to see the fields, the bracket and the QR join
            links working immediately.
          </span>
          <Button size="sm" tone="primary" onClick={() => navigate('/setup')}>
            {t('setup.title')}
          </Button>
          <Button size="sm" disabled={!isAdmin} onClick={() => live.command('system.demo')}>
            {t('setup.demo')}
          </Button>
        </p>
      ) : null}

      {/* Radball: tie / decision guidance right at the top of the desk. */}
      {state.radball && openDecisionMatches(state).length > 0 ? (
        <p className="banner banner--warn">
          <strong>{t('radball.tieTitle')}</strong>
          <span className="grow small">
            {openDecisionMatches(state)
              .map((match) => `${nameOf(state, match.participantAId)} vs ${nameOf(state, match.participantBId)}`)
              .join(' · ')}{' '}
            — play it on any free field, then confirm the result.
          </span>
          <Button size="sm" onClick={() => navigate('/radball')}>
            {t('nav.radball')}
          </Button>
        </p>
      ) : null}

      <div className="shell">
        <div className="shell__main">
          <FieldTabs state={state} ids={ids} active={activeField} onSelect={selectField} />
          <FieldCard
            // Remount on a field change (so the scoring log, the operator QR
            // and the queue scroll reset), but keep the key distinct from the
            // queue panel's below: two siblings sharing one key make React
            // duplicate children instead of unmounting them, which stacked the
            // previous field's card on the dashboard after a tab switch.
            key={`field-card-${activeField}`}
            state={state}
            fieldId={activeField}
            controlLink={snapshot.links.find((link) => link.purpose === `field-${activeField}`) ?? null}
            displayLink={snapshot.links.find((link) => link.purpose === `display-${activeField}`) ?? null}
            onAssign={(id) => setDialog({ kind: 'assign', fieldId: id })}
            onEndMatch={(match) => setDialog({ kind: 'end', match })}
            onCorrect={(match) => setDialog({ kind: 'correct', match })}
            onOverride={(match) => setDialog({ kind: 'override', match })}
            onUnassign={(id, title) => setDialog({ kind: 'unassign', fieldId: id, title })}
          />

          {/* One queue, for the field you have open: its own matches first,
              then the pairings either field may host. Another field's matches
              are never listed here -- switch tabs to see those. */}
          <QueuePanel
            key={`field-queue-${activeField}`}
            state={state}
            fieldId={activeField}
            isAdmin={isAdmin}
            onAssign={assign}
          />

          {/* The manual schedule is a list the host typed, so the dashboard
              gives it back as a list: every fixture, editable, in the order it
              will be played. Nothing else in the app needs this because every
              other format derives its fixtures from the draw. */}
          {isManualSchedule(state) ? (
            <SchedulePanel
              state={state}
              isAdmin={isAdmin}
              onEdit={(match) => setDialog({ kind: 'schedule', match })}
              onAdd={() => setDialog({ kind: 'schedule', match: null })}
            />
          ) : null}

          <Panel
            className="panel--fill"
            title={t('host.tournamentTree')}
            flush
            actions={
              <>
                <Button size="sm" tone="ghost" onClick={openTreeFullscreen} title={t('host.fullscreenTree')}>
                  {t('a11y.fullscreen')}
                </Button>
                {state.radball ? (
                  <Button
                    size="sm"
                    tone="ghost"
                    disabled={!isAdmin}
                    onClick={() => live.command('radball.qualify', {})}
                    title={t('host.qualifyHint')}
                  >
                    {t('round.qualification')}
                  </Button>
                ) : isManualSchedule(state) ? (
                  /* No "replace" for a manual schedule: there is no draw to
                     re-roll, and regenerating a bracket here would throw away
                     every fixture the host typed. Adding one is the equivalent
                     action, and it lives in the schedule panel and here. */
                  <Button
                    size="sm"
                    tone="primary"
                    disabled={!isAdmin}
                    onClick={() => setDialog({ kind: 'schedule', match: null })}
                    title={t('host.scheduleAddHint')}
                  >
                    {t('setup.scheduleAdd')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    tone="ghost"
                    disabled={!isAdmin}
                    onClick={() => live.command('bracket.generate', { seeded: true, thirdPlaceMatch: state.tournament?.thirdPlaceMatch ?? true })}
                    title={t('host.regenerateHint')}
                  >
                    {t('action.replace')}
                  </Button>
                )}
              </>
            }
          >
            {/* One tree for every format. A Radball competition is a real
                knockout of winners rounds, so it renders the same tree here;
                the groups, tables and shootout board live on /radball. */}
            <BracketView
              state={state}
              showToolbar={false}
              // The tree follows the open tab: no other field's match stays
              // highlighted or centered when you switch fields.
              currentMatchId={state.fields[activeField]?.matchId ?? null}
            />
          </Panel>
        </div>

        <aside className="shell__side">
          {/* What the projector is showing, switched from the desk. Sitting at
              the top of the rail puts it where a host between games is already
              looking, rather than behind a dialog on a page they have to find. */}
          <Panel title={t('display.title')}>
            <DisplayScreenPicker />
          </Panel>

          <Panel
            title={`${t('field.count')} (${fieldIds(state).length})`}
            actions={
              <Button
                size="sm"
                tone="ghost"
                disabled={!isAdmin}
                onClick={() => {
                  const ids = fieldIds(state);
                  if (ids.length === 2) void live.command('match.swapFields');
                  else setDialog({ kind: 'swap' });
                }}
                title={t('dialog.swapHint')}
              >
                <IconSwap size={12} /> {t('action.swap')}
              </Button>
            }
            flush
          >
            <div className="compact-list">
              {fieldIds(state).map((fieldId) => {
                const field = state.fields[fieldId];
                const match = field.matchId ? state.matches[field.matchId] : null;
                return (
                  <button
                    type="button"
                    className={cx('compact-list__row', 'compact-list__row--pick', fieldId === activeField && 'compact-list__row--active')}
                    key={fieldId}
                    onClick={() => selectField(fieldId)}
                    title={`Control ${field.name}`}
                  >
                    <span className="tiny faint nowrap">{field.name}</span>
                    <span className="grow nowrap">
                      {match ? (
                        <>
                          {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                          {nameOf(state, match.participantBId)}
                        </>
                      ) : (
                        <span className="faint">{t('field.free')}</span>
                      )}
                    </span>
                    {match ? (
                      <span className="small tnum">
                        <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
                      </span>
                    ) : null}
                    {match ? <MatchStateBadge state={match.state} /> : null}
                    {field.controlledBy ? (
                      <span className="tiny faint nowrap" title={t('host.operatorAttached')}>
                        {field.controlledBy}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="panel__foot">
              <Button size="sm" tone="primary" disabled={!isAdmin} onClick={() => live.command('match.autoAssign')}>
                {t('action.autoAssign')}
              </Button>
              <Button size="sm" tone="ghost" onClick={() => setDialog({ kind: 'qr' })}>
                <IconQr size={12} /> {t('dialog.qr')}
              </Button>
            </div>
          </Panel>

          <Panel title={`${t('field.completed')} (${completed.length})`} flush>
            {completed.length === 0 ? (
              <Empty>{t('host.noFinishedMatch')}</Empty>
            ) : (
              <div className="compact-list scroll" style={{ maxHeight: '28vh' }}>
                {completed.slice(0, 30).map((match) => (
                  <div className="compact-list__row" key={match.id}>
                    <span className="tiny faint nowrap mono">{formatTime(match.finishedAt ?? match.startedAt ?? 0)}</span>
                    <span className="grow nowrap">
                      {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                      {nameOf(state, match.participantBId)}
                    </span>
                    <span className="small tnum">
                      {match.scoreA} : {match.scoreB}
                    </span>
                    <span className="small nowrap">
                      {match.winnerId ? (
                        <strong>{nameOf(state, match.winnerId)}</strong>
                      ) : (
                        <span className="faint">{t('score.draw')}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={t('field.activity')} flush>
            {state.events.length === 0 ? (
              <Empty>{t('host.noEvents')}</Empty>
            ) : (
              <div className="compact-list scroll" style={{ maxHeight: '30vh' }}>
                {[...state.events].reverse().slice(0, 60).map((event) => (
                  <div className="compact-list__row" key={event.seq}>
                    <span className="tiny faint mono nowrap">{formatTime(event.ts)}</span>
                    {/* The server writes English and sends the key with it, so the
                        feed reads in the language of whoever is looking at it. */}
                    <span className="grow">{eventLine(event)}</span>
                    <span className="tiny faint nowrap">{event.fieldId ? state.fields[event.fieldId].name : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </aside>
      </div>

      <div className="statusbar">
        <span className="statusbar__group">
          <ConnectionBadge />
          <SaveIndicator lastSaveAt={system?.lastSaveAt ?? null} pending={snapshot.pending} />
          <span className="statusbar__item tiny">
            <span className={cx('dot', system?.databaseOk === false && 'dot--error', system?.databaseOk && 'dot--live')} />
            {system ? `${system.database} · ${system.eventsStored} ${t('diag.events')}` : 'database'}
          </span>
          <span className="statusbar__item tiny">
            <span className="dot dot--live" />
            {system ? `${system.clients} ${t('diag.clients')}` : 'clients'}
          </span>
          {system ? (
            <>
              <span className="statusbar__item tiny faint">
                {system.messageCount} {t('diag.messageCount')}
              </span>
              <span className="statusbar__item tiny faint">
                {t('diag.memory')} {system.memoryMb} MB · cpu {system.cpuPercent}%
              </span>
              <span className="statusbar__item tiny faint">
                {t('diag.uptime')} {Math.round(system.uptimeSec / 60)} min
              </span>
            </>
          ) : null}
        </span>
        {/* State and age travel as one group so a wrapped line lands on the
            right, under the right, instead of jumping back to the left edge. */}
        <span className="statusbar__group">
          <span className="statusbar__item tiny faint">state #{state.seq}</span>
          <span className="statusbar__item tiny faint">updated {relativeTime(state.updatedAt, now)}</span>
        </span>
      </div>

      {treeFullscreen ? (
        <TreeFullscreen
          state={state}
          currentMatchId={state.fields[activeField]?.matchId ?? null}
          onClose={closeTreeFullscreen}
        />
      ) : null}

      {dialog?.kind === 'assign' && dialog.fieldId ? (
        <AssignMatchDialog state={state} fieldId={dialog.fieldId} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'end' && dialog.match ? (
        <EndMatchDialog match={dialog.match} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'correct' && dialog.match ? (
        <ScoreCorrectionDialog match={dialog.match} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'override' && dialog.match ? (
        <ManualOverrideDialog match={dialog.match} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'schedule' ? (
        <ManualScheduleDialog match={dialog.match ?? null} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'unassign' && dialog.fieldId ? (
        <UnassignDialog
          fieldId={dialog.fieldId}
          matchTitle={dialog.title ?? t('host.currentMatch')}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'swap' ? (
        <SwapFieldsDialog state={state} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === 'qr' ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
          <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('dialog.qr')}>
            <header className="modal__head">
              <h2 className="modal__title">{t('dialog.qr')}</h2>
              <Button tone="ghost" size="sm" onClick={closeDialog}>
                {t('action.close')}
              </Button>
            </header>
            <div className="modal__body">
              <p className="hint">
                Print these and stick them to the table. Spectator codes are read-only; each field's operator
                code lives on its own field tab and is renewed with every tournament.
              </p>
              <QrGallery links={snapshot.links.filter((link) => !link.purpose.startsWith('field-'))} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The dashboard's tournament tree, full screen.
 *
 * Literally the same BracketView the panel under the fields shows, with its
 * toolbar (zoom, follow, follow-the-live-match) and the browser's own fullscreen
 * so it can go straight on the projector. Leaving fullscreen -- the Close
 * button, Escape, or the browser's own exit -- closes the overlay too, so the
 * dashboard is never stranded behind a layer the user thinks has gone.
 */
function TreeFullscreen({
  state,
  currentMatchId,
  onClose,
}: {
  state: TournamentState;
  currentMatchId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // The browser leaves fullscreen on its own (F11, Esc, the window manager);
    // the overlay has to go with it.
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [onClose]);

  return (
    <div className="tree-fullscreen" role="dialog" aria-modal="true" aria-label={t('host.tournamentTree')}>
      <Panel
        className="panel--fill"
        title={t('host.tournamentTree')}
        flush
        actions={
          <Button size="sm" tone="ghost" onClick={onClose}>
            {t('action.close')}
          </Button>
        }
      >
        <BracketView state={state} currentMatchId={currentMatchId} />
      </Panel>
    </div>
  );
}

/**
 * The queue of the field you have open.
 *
 * It lists that field's own matches first, then -- under their own heading --
 * the pairings either field may host: the final, the bronze match and anything
 * that mixes two rosters. Another field's matches are never listed, so what is
 * under Field 1 is Field 1's queue and cannot be played from Field 2's tab.
 *
 * For a manual schedule the same question -- "what is coming up?" -- is answered
 * by the schedule panel below, which is the host's own fixture list rather than
 * a field's view of it.
 */

/** True for the one format whose fixtures the host typed by hand. */
function isManualSchedule(state: TournamentState): boolean {
  return state.tournament?.format === 'manual-schedule';
}

/**
 * Every fixture of a manual schedule, in the order the host will play them.
 *
 * This is the edit surface the format promises: the tree shows the same matches
 * as a picture, but a picture cannot be edited. Each row names the two teams,
 * the round it belongs to and where it sits, and opens the dialog the wizard's
 * builder uses -- so a host who forgot a pairing at half past nine adds it here
 * rather than recreating the event.
 */
function SchedulePanel({
  state,
  isAdmin,
  onEdit,
  onAdd,
}: {
  state: TournamentState;
  isAdmin: boolean;
  onEdit: (match: Match) => void;
  onAdd: () => void;
}) {
  const { t } = useI18n();
  // The host's own queue order, not the tree's: this list is meant to be read
  // top to bottom as "what is coming next".
  const matches = useMemo(
    () => state.matchOrder.map((id) => state.matches[id]).filter((match): match is Match => Boolean(match)),
    [state],
  );
  const played = matches.filter((match) => match.state === 'FINISHED').length;

  return (
    <Panel
      title={`${t('setup.scheduleReview')} (${matches.length})`}
      flush
      actions={
        isAdmin ? (
          <Button size="sm" tone="primary" onClick={onAdd} title={t('host.scheduleAddHint')}>
            {t('setup.scheduleAdd')}
          </Button>
        ) : null
      }
    >
      {matches.length === 0 ? (
        <Empty>{t('setup.scheduleEmpty')}</Empty>
      ) : (
        <div className="compact-list scroll" style={{ maxHeight: '28vh' }}>
          {matches.map((match) => {
            const field = match.fieldId ? state.fields[match.fieldId] : null;
            return (
              <button
                type="button"
                key={match.id}
                className={cx('compact-list__row', 'compact-list__row--pick')}
                disabled={!isAdmin}
                onClick={() => onEdit(match)}
              >
                <span className="tiny faint nowrap">{match.roundName}</span>
                <span className="grow nowrap">
                  {nameOf(state, match.participantAId)} <span className="faint">vs</span>{' '}
                  {nameOf(state, match.participantBId)}
                </span>
                <span className="tiny faint nowrap">{field ? field.name : t('setup.scheduleFieldAny')}</span>
                <MatchStateBadge state={match.state} />
              </button>
            );
          })}
        </div>
      )}
      {matches.length > 0 ? (
        <div className="panel__foot">
          <span className="small faint">
            {t('host.scheduleProgress', { played, total: matches.length })}
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * The queue of the field you have open.
 *
 * It lists that field's own matches first, then -- under their own heading --
 * the pairings either field may host: the final, the bronze match and anything
 * that mixes two rosters. Another field's matches are never listed, so what is
 * under Field 1 is Field 1's queue and cannot be played from Field 2's tab.
 *
 * For a manual schedule the same question -- "what is coming up?" -- is answered
 * by the schedule panel above, which is the host's own fixture list rather than
 * a field's view of it.
 */
function QueuePanel({
  state,
  fieldId,
  isAdmin,
  onAssign,
}: {
  state: TournamentState;
  fieldId: FieldId;
  isAdmin: boolean;
  onAssign: (matchId: string, fieldId: FieldId) => void;
}) {
  const own = useMemo(() => fieldQueue(state, fieldId), [state, fieldId]);
  const shared = useMemo(() => sharedQueue(state), [state]);
  const { t } = useI18n();
  // Without field rosters the fields split the draw instead, which the panel
  // says out loud so the queue never looks empty for no reason.
  const fieldName = state.fields[fieldId]?.name ?? t('field.label', { n: fieldId });
  const rosterless = !hasHomeRosters(state);

  const shownOwn = own.slice(0, 24);
  const shownShared = shared.slice(0, Math.max(0, 24 - shownOwn.length));
  const shown = shownOwn.length + shownShared.length;
  const total = own.length + shared.length;

  return (
    <Panel title={`${fieldName} · ${t('field.queue')} (${total})`} flush>
      {total === 0 ? (
        <Empty>No match belongs to {fieldName}.</Empty>
      ) : (
        <>
          <div className="queue scroll" style={{ maxHeight: '30vh' }}>
            {shownOwn.map((match, index) => (
              <QueueRow
                key={match.id}
                state={state}
                match={match}
                index={index}
                isAdmin={isAdmin}
                fieldId={fieldId}
                onAssign={onAssign}
              />
            ))}
            {shared.length > 0 ? (
              <div
                className="list-divider"
                title={t('host.sharedHint')}
              >
                <span>
                  {t('field.shared')} ({shared.length})
                </span>
              </div>
            ) : null}
            {shownShared.map((match, index) => (
              <QueueRow
                key={match.id}
                state={state}
                match={match}
                index={shownOwn.length + index}
                isAdmin={isAdmin}
                fieldId={fieldId}
                onAssign={onAssign}
              />
            ))}
          </div>
          {rosterless ? (
            <p className="hint" style={{ padding: 'var(--space-3) var(--space-4) 0' }}>
              No player is registered on a field, so each field runs its own section of the draw.{' '}
              {fieldName} has the matches that section feeds.
            </p>
          ) : null}
          {total > shown ? (
            <p className="hint" style={{ padding: '0 var(--space-4) var(--space-3)' }}>
              +{total - shown} more in this queue.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function QueueRow({
  state,
  match,
  index,
  isAdmin,
  fieldId,
  onAssign,
}: {
  state: TournamentState;
  match: Match;
  index: number;
  isAdmin: boolean;
  /** The field whose queue is being shown: the only one this row can assign to. */
  fieldId: FieldId;
  onAssign: (matchId: string, fieldId: FieldId) => void;
}) {
  const { t } = useI18n();
  const reason = waitingReason(state, match, asTranslate(t));
  const playable = Boolean(match.participantAId && match.participantBId);
  // "either field" describes where a match *may* go. Once it is on a field it is
  // that field's, and saying both things in one row is how the host ends up
  // unsure which field is actually running it.
  const placed = isOnField(state, match);
  const shared = homeFieldOf(state, match) === null && !placed;
  return (
    <div className={cx('queue__item', match.state === 'READY' && 'queue__item--ready', placed && 'queue__item--current')}>
      <span className="queue__index">{index + 1}</span>
      <div className="queue__match">
        <div className="queue__players">{matchTitle(state, match)}</div>
        <div className="queue__label">
          {match.roundName}
          {match.isThirdPlace ? ` · ${t('round.thirdPlace')}` : ''}
          {placed ? ` · on ${state.fields[match.fieldId as FieldId].name}` : shared ? ` · ${t('field.shared')}` : ''}
          {reason ? ` · ${reason}` : ''}
        </div>
      </div>
      <div className="queue__actions">
        <MatchStateBadge state={match.state} />
        {isAdmin && playable && !match.fieldId ? (
          <Button
            size="sm"
            onClick={() => onAssign(match.id, fieldId)}
            title={`Assign ${matchTitle(state, match)} to ${state.fields[fieldId].name}`}
          >
            {t('field.assignTo', { field: state.fields[fieldId].name })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One tab per playing field. Hidden for single-field tournaments. Each tab
 * carries the live score and state so the desk sees every field at a glance
 * and opens one for full control.
 */
function FieldTabs({
  state,
  ids,
  active,
  onSelect,
}: {
  state: TournamentState;
  ids: FieldId[];
  active: FieldId;
  onSelect: (fieldId: FieldId) => void;
}) {
  const { t } = useI18n();
  if (ids.length <= 1) return null;
  const move = (direction: 1 | -1) => {
    const index = Math.max(0, ids.indexOf(active));
    onSelect(ids[(index + direction + ids.length) % ids.length]);
  };
  return (
    <div
      className="field-tabs"
      role="tablist"
      aria-label={t('field.count')}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {ids.map((fieldId) => {
        const field = state.fields[fieldId];
        const match = field?.matchId ? state.matches[field.matchId] ?? null : null;
        const selected = fieldId === active;
        return (
          <button
            key={fieldId}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cx('field-tabs__tab', selected && 'field-tabs__tab--active')}
            onClick={() => onSelect(fieldId)}
            title={`Control ${field?.name ?? fieldId}`}
          >
            <span className="field-tabs__name">{field?.name ?? t('field.label', { n: fieldId })}</span>
            {match ? (
              <span className="field-tabs__meta">
                <span className="tnum">
                  <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
                </span>
                <MatchStateBadge state={match.state} />
              </span>
            ) : (
              <span className="field-tabs__meta faint">{t('field.free')}</span>
            )}
            {field?.controlledBy ? <span className="field-tabs__lock" title={`Controlled by ${field.controlledBy}`}>●</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Pick two fields and trade the matches sitting on them. */
function SwapFieldsDialog({ state, onClose }: { state: TournamentState; onClose: () => void }) {
  const ids = fieldIds(state);
  const [a, setA] = useState(ids[0] ?? '1');
  const [b, setB] = useState(ids[1] ?? '2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const submit = async () => {
    if (a === b) {
      setError(t('host.pickTwoFields'));
      return;
    }
    setBusy(true);
    const result = await live.command('match.swapFields', { fieldA: a, fieldB: b });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? t('err.generic'));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('dialog.swap')}>
        <header className="modal__head">
          <h2 className="modal__title">{t('dialog.swap')}</h2>
          <Button tone="ghost" size="sm" onClick={onClose}>
            {t('action.close')}
          </Button>
        </header>
        <div className="modal__body stack g3">
          <div className="grid-2">
            <label className="field-row">
              <span className="label">{t('field.label', { n: a })}</span>
              <select className="select" value={a} onChange={(event) => setA(event.target.value)}>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {state.fields[id].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-row">
              <span className="label">{t('field.label', { n: b })}</span>
              <select className="select" value={b} onChange={(event) => setB(event.target.value)}>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {state.fields[id].name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">{t('host.swapRunningHint')}</p>
          {error ? <p className="banner banner--error" style={{ borderRadius: 'var(--radius)' }}>{error}</p> : null}
          <div className="btn-row">
            <Button tone="primary" onClick={submit} busy={busy}>
              {t('action.swap')}
            </Button>
            <Button tone="ghost" onClick={onClose}>
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selectors                                                          */
/* ------------------------------------------------------------------ */

function finishedMatches(state: TournamentState): Match[] {
  return Object.values(state.matches)
    .filter((match) => match.state === 'FINISHED' && isRealMatch(match))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}
