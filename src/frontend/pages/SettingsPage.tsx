/**
 * Settings.
 *
 * Ten tabs, one page. Everything that changes the tournament behaviour is here:
 * table names, clock and scoring defaults, appearance, the access tokens of the
 * control links, backups, imports and a developer panel with the host's log
 * ring buffer -- so a problem during an event can be diagnosed on the spot
 * without a terminal.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { Settings, SystemStatus } from '../../shared/types';
import { MAX_FIELDS } from '../../shared/types';
import { live } from '../lib/live';
import { useLive, useNow } from '../lib/hooks';
import { forgetAccess, resolveAccess } from '../lib/token';
import { useI18n } from '../lib/useI18n';
import { LOCALES, LOCALE_NAMES, normaliseLocale, type Locale, type MessageKey } from '../lib/i18n';
import {
  downloadBlob,
  downloadFromHost,
  formatBytes,
  formatDateTime,
  formatTime,
  relativeTime,
  tokenHeader,
} from '../lib/util';
import { resultsCsv, matchesCsv, participantsCsv, tournamentJson } from '../../shared/exports';
import { Badge, Button, ConnectionBadge, ConfirmDialog, Panel, Segmented, Switch, TextField } from '../components/primitives';
import { QrGallery } from '../components/QrPanel';
import { IconDownload, IconRefresh, IconSave, IconTrash, IconUpload } from '../components/icons';

type Tab =
  | 'general'
  | 'network'
  | 'appearance'
  | 'scoring'
  | 'fields'
  | 'security'
  | 'backup'
  | 'transfer'
  | 'shortcuts'
  | 'developer';

/** Tab labels are catalogue keys so the rail follows the language. */
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'settings.general' },
  { id: 'network', label: 'settings.network' },
  { id: 'appearance', label: 'settings.appearance' },
  { id: 'scoring', label: 'settings.scoring' },
  { id: 'fields', label: 'settings.fields' },
  { id: 'security', label: 'settings.security' },
  { id: 'backup', label: 'settings.backup' },
  { id: 'transfer', label: 'export.results' },
  { id: 'shortcuts', label: 'dialog.shortcuts' },
  { id: 'developer', label: 'settings.developer' },
];

export function SettingsPage() {
  const snapshot = useLive();
  const settings = snapshot.state?.settings ?? null;
  const [tab, setTab] = useState<Tab>('general');
  const isAdmin = snapshot.role === 'admin';
  const { t } = useI18n();

  const patch = async (changes: Record<string, unknown>, message?: string) => {
    const result = await live.command('settings.update', { patch: changes });
    if (result.ok) {
      if (message) live.pushToast('success', message);
    } else {
      live.pushToast('error', result.error ?? t('settings.rejected'));
    }
    return result.ok;
  };

  if (!settings) return <p className="empty">{t('conn.connecting')}…</p>;

  if (!isAdmin) {
    return (
      <div className="empty stack g3" style={{ margin: 'auto' }}>
        <p>{t('settings.hostOnly')}</p>
        <p className="hint">
          {t('settings.hostOnlyHint', {
            role: snapshot.role === 'operator' ? t('role.operator') : t('role.spectator'),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="shell" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
      <aside className="shell__side">
        <div className="panel__body stack g1" style={{ position: 'sticky', top: 0 }}>
          <span className="tiny dim" style={{ padding: '0 var(--space-3) var(--space-2)' }}>
            {t('settings.title')}
          </span>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="nav__item"
              aria-current={tab === entry.id ? 'page' : undefined}
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => setTab(entry.id)}
            >
              {t(entry.label as MessageKey)}
            </button>
          ))}
          <LanguageRail />
        </div>
      </aside>

      <div className="shell__main scroll settings-panels">
        {tab === 'general' ? <GeneralTab settings={settings} patch={patch} /> : null}
        {tab === 'network' ? <NetworkTab settings={settings} patch={patch} /> : null}
        {tab === 'appearance' ? <AppearanceTab settings={settings} patch={patch} /> : null}
        {tab === 'scoring' ? <ScoringTab settings={settings} patch={patch} /> : null}
        {tab === 'fields' ? <FieldsTab settings={settings} patch={patch} /> : null}
        {tab === 'security' ? <SecurityTab settings={settings} patch={patch} /> : null}
        {tab === 'backup' ? <BackupTab /> : null}
        {tab === 'transfer' ? <TransferTab /> : null}
        {tab === 'shortcuts' ? <ShortcutsTab /> : null}
        {tab === 'developer' ? <DeveloperTab /> : null}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Language                                                           */
/* ================================================================== */

/**
 * The language control, in the settings rail so it is reachable from any tab.
 *
 * **One** row of buttons, not two. The previous version stacked a hall-wide
 * switch above a per-device switch, which read as a duplicated setting where one
 * worked and one did not -- and neither label said which was which.
 *
 * What it does depends on who is tapping:
 *
 *  - The **host** writes the setting, which travels in the settings delta and
 *    repaints the phones and the projector at once. That is what a hall needs
 *    when the organiser switches to Deutsch at the start of the event.
 *  - **Anybody else** -- a spectator's phone, a field operator's tablet -- sets
 *    it for that device only, stored locally and never sent to the host. One
 *    phone cannot change the language everybody else is reading.
 *
 * When this device is overriding the host, a single "use the host's language"
 * button appears underneath to drop back, so the override is never a trap.
 *
 * Buttons rather than a `<select>`: two options, and the host has to be able to
 * read this from across a scorer's table.
 */
function LanguageRail() {
  const snapshot = useLive();
  const settings = snapshot.state?.settings ?? null;
  const i18n = useI18n();
  const isAdmin = snapshot.role === 'admin' && settings !== null;
  const hostLocale = normaliseLocale(settings?.language);
  // What is actually on screen: this device's override, or the host's setting.
  const active = i18n.locale;

  const choose = (locale: Locale) => {
    if (!isAdmin) {
      i18n.setLocale(locale);
      return;
    }
    // Tapping the language that is already showing, while overridden, is how a
    // host means "make this the hall's language too" -- so it drops the override
    // instead of writing a setting that changes nothing.
    if (i18n.isOverridden && active === locale) {
      i18n.followHost();
      return;
    }
    void (async () => {
      const result = await live.command('settings.update', { patch: { language: locale } });
      if (!result.ok) live.pushToast('error', result.error ?? i18n.t('err.generic'));
    })();
  };

  return (
    <div className="stack g1" style={{ marginTop: 'var(--space-3)' }}>
      <span className="tiny dim" style={{ padding: '0 var(--space-3)' }}>
        {i18n.t('settings.language')}
        {i18n.isOverridden ? ` · ${i18n.t('settings.languageDeviceOnly')}` : null}
      </span>
      <div className="row g1 wrap" style={{ padding: '0 var(--space-3)' }}>
        {LOCALES.map((locale) => (
          <Button
            key={locale}
            size="sm"
            tone={active === locale ? 'primary' : 'ghost'}
            aria-pressed={active === locale}
            onClick={() => choose(locale)}
          >
            {LOCALE_NAMES[locale]}
          </Button>
        ))}
      </div>
      {i18n.isOverridden ? (
        <div style={{ padding: '0 var(--space-3)' }}>
          <Button size="sm" tone="ghost" onClick={i18n.followHost}>
            {i18n.t('settings.languageFollowHost', { host: LOCALE_NAMES[hostLocale] })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Draft-based text field                                             */
/* ================================================================== */

function DraftText({
  label,
  value,
  onSave,
  hint,
  type = 'text',
  inputMode,
  maxLength,
  placeholder,
  allowEmpty,
}: {
  label: string;
  value: string;
  onSave: (next: string) => void;
  hint?: string;
  type?: string;
  inputMode?: 'numeric' | 'text' | 'decimal';
  maxLength?: number;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const { t } = useI18n();
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value && (allowEmpty || draft.trim().length > 0);
  // A real `<label htmlFor>` rather than a `<span className="label">`: this is
  // the shared control behind most of the settings forms, and a screen reader
  // announcing an unlabelled input is the difference between usable Settings and
  // not.
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="row g2">
        <input
          id={id}
          className="input"
          type={type}
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          {...(inputMode ? { inputMode } : {})}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty) onSave(draft);
          }}
        />
        <Button size="sm" tone={dirty ? 'primary' : 'ghost'} disabled={!dirty} onClick={() => onSave(draft)}>
          {t('action.save')}
        </Button>
      </div>
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Tabs                                                               */
/* ================================================================== */

type Patch = (changes: Record<string, unknown>, message?: string) => Promise<boolean>;

function GeneralTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetText, setResetText] = useState('');

  return (
    <div className="stack">
      <Panel title={t('settings.eventPanel')}>
        <div className="stack g4">
          <DraftText
            label={t('settings.eventNameLabel')}
            value={settings.tournamentName}
            maxLength={80}
            onSave={(next) => void patch({ tournamentName: next }, t('settings.eventNameSaved'))}
            hint={t('settings.eventNameHint')}
          />
          <DraftText
            label={t('settings.loadedNameLabel')}
            value={snapshot.state?.tournament?.name ?? ''}
            maxLength={80}
            onSave={() => undefined}
            hint={
              snapshot.state?.tournament ? t('settings.loadedNameHint') : t('settings.loadedNameNone')
            }
          />
          {snapshot.state?.tournament ? (
            <DraftText
              label={t('settings.renameLabel')}
              value={snapshot.state.tournament.name}
              maxLength={80}
              onSave={(next) =>
                void live.command('tournament.update', { name: next }).then((result) => {
                  if (result.ok) live.pushToast('success', t('settings.renamed'));
                  else live.pushToast('error', result.error ?? t('settings.renameFailed'));
                })
              }
            />
          ) : null}
        </div>
      </Panel>

      <Panel title={t('settings.boardPanel')}>
        <div className="stack g4">
          <Switch
            checked={settings.showSponsorBar}
            onChange={(value) => void patch({ showSponsorBar: value })}
            label={t('settings.sponsorBar')}
            hint={t('settings.sponsorBarHint')}
          />
          <Switch
            checked={settings.invertDisplayColors}
            onChange={(value) => void patch({ invertDisplayColors: value })}
            label={t('settings.invert')}
            hint={t('settings.invertHint')}
          />
        </div>
      </Panel>

      <Panel title={t('settings.dangerPanel')}>
        <div className="stack g4">
          <div className="between">
            <span className="stack g1">
              <strong>{t('settings.resetLabel')}</strong>
              <span className="hint">{t('settings.resetHint')}</span>
            </span>
            <Button tone="danger" onClick={() => setConfirmReset(true)}>
              {t('settings.resetAction')}
            </Button>
          </div>
          <div className="between">
            <span className="stack g1">
              <strong>{t('settings.completeLabel')}</strong>
              <span className="hint">{t('settings.completeHint')}</span>
            </span>
            <Button onClick={() => void live.command('tournament.complete')}>{t('settings.completeAction')}</Button>
          </div>
        </div>
      </Panel>

      {confirmReset ? (
        <ConfirmDialog
          title={t('settings.resetConfirmTitle')}
          confirmLabel={t('action.reset')}
          tone="danger"
          onCancel={() => {
            setConfirmReset(false);
            setResetText('');
          }}
          onConfirm={() => {
            void live.command('tournament.reset', { confirm: resetText });
            setConfirmReset(false);
            setResetText('');
          }}
          body={
            <div className="stack g3">
              <p>{t('settings.resetConfirmBody')}</p>
              <TextField
                label={t('settings.typeReset')}
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                autoFocus
              />
            </div>
          }
        />
      ) : null}
    </div>
  );
}

function NetworkTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const network = snapshot.network;

  return (
    <div className="stack">
      <Panel title={t('settings.localNetworkPanel')}>
        <div className="stack g4">
          <div className="between">
            <span className="stack g1">
              <span className="tiny dim">{t('settings.wlanHint')}</span>
              <strong className="mono">{network?.url ?? t('settings.noAddress')}</strong>
            </span>
            <Badge tone={network?.status === 'CONNECTED' ? 'live' : 'warn'} dot>
              {network?.status ?? t('settings.networkUnknown')}
            </Badge>
          </div>

          <dl className="kv">
            <dt>{t('settings.serverPort')}</dt>
            <dd>{network?.port ?? settings.port}</dd>
            <dt>{t('settings.mdnsName')}</dt>
            <dd className="mono">{network?.mdnsName ?? '—'}</dd>
            <dt>{t('diag.driver')}</dt>
            <dd>{network?.driver}</dd>
            <dt>{t('settings.interfaces')}</dt>
            <dd>
              {(network?.allIps ?? []).map((entry) => (
                <div key={`${entry.iface}-${entry.address}`} className="mono small">
                  {entry.iface} · {entry.address}
                </div>
              ))}
              {(network?.allIps ?? []).length === 0 ? '—' : null}
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title={t('settings.preferencesPanel')}>
        <div className="stack g4">
          <DraftText
            label={t('settings.portLabel')}
            value={String(settings.port)}
            inputMode="numeric"
            onSave={(next) => void patch({ port: Number(next) }, t('settings.portSaved'))}
            hint={t('settings.portHint')}
          />
          <DraftText
            label={t('settings.address')}
            value={settings.advertisedHost ?? ''}
            allowEmpty
            placeholder={t('ph.addressExample')}
            onSave={(next) =>
              void patch({ advertisedHost: next.trim() || null }, t('settings.addressSaved'))
            }
            hint={t('settings.addressHint')}
          />
          <p className="hint">{t('settings.networkHint')}</p>
        </div>
      </Panel>
    </div>
  );
}

function AppearanceTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const [logoBusy, setLogoBusy] = useState(false);

  const readLogo = async (file: File) => {
    if (file.size > 300_000) {
      live.pushToast('error', t('settings.logoTooLarge'));
      return;
    }
    setLogoBusy(true);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    }).catch(() => null);
    setLogoBusy(false);
    if (!dataUrl) {
      live.pushToast('error', t('settings.logoUnreadable'));
      return;
    }
    void patch({ logoDataUrl: dataUrl }, t('settings.logoUpdated'));
  };

  return (
    <div className="stack">
      <Panel title={t('settings.themePanel')}>
        <div className="stack g4">
          <div className="field-row">
            <span className="label">{t('settings.theme')}</span>
            <Segmented
              ariaLabel={t('settings.themePanel')}
              value={settings.theme}
              onChange={(value) => void patch({ theme: value })}
              options={[
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'light', label: t('settings.themeLight') },
              ]}
            />
          </div>
          <p className="hint">{t('settings.themeHint')}</p>
        </div>
      </Panel>

      <Panel title={t('settings.coloursPanel')}>
        <div className="grid-2">
          <div className="field-row">
            <span className="label">{t('settings.primaryColor')}</span>
            <div className="row g2">
              <input
                type="color"
                value={settings.primaryColor}
                aria-label={t('settings.primaryColor')}
                style={{ width: 48, height: 34, background: 'none', border: '1px solid var(--line-strong)' }}
                onChange={(event) => void patch({ primaryColor: event.target.value })}
              />
              <span className="mono small">{settings.primaryColor}</span>
            </div>
          </div>
          <div className="field-row">
            <span className="label">{t('settings.accentColor')}</span>
            <div className="row g2">
              <input
                type="color"
                value={settings.accentColor}
                aria-label={t('settings.accentColor')}
                style={{ width: 48, height: 34, background: 'none', border: '1px solid var(--line-strong)' }}
                onChange={(event) => void patch({ accentColor: event.target.value })}
              />
              <span className="mono small">{settings.accentColor}</span>
            </div>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 'var(--space-3)' }}>
          {[
            { label: 'settings.presetBlue', primary: '#2f7bf6', accent: '#f0b429' },
            { label: 'settings.presetRed', primary: '#d1342f', accent: '#f5f7fa' },
            { label: 'settings.presetGreen', primary: '#157a4a', accent: '#b7e04a' },
            { label: 'settings.presetViolet', primary: '#6d4df0', accent: '#31d0d0' },
            { label: 'settings.presetMono', primary: '#8a93a3', accent: '#e9edf3' },
          ].map((preset) => (
            <Button
              key={preset.label}
              size="sm"
              onClick={() => void patch({ primaryColor: preset.primary, accentColor: preset.accent })}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: preset.primary,
                  border: '1px solid var(--line-strong)',
                  display: 'inline-block',
                }}
              />
              {t(preset.label as MessageKey)}
            </Button>
          ))}
        </div>
      </Panel>

      <Panel title={t('settings.logo')}>
        <div className="stack g3">
          {settings.logoDataUrl ? (
            <img
              src={settings.logoDataUrl}
              alt={t('settings.logo')}
              style={{ maxHeight: 90, maxWidth: 260, objectFit: 'contain' }}
            />
          ) : (
            <p className="hint">{t('settings.logoNone')}</p>
          )}
          <div className="btn-row">
            <label className="btn btn--small">
              <IconUpload size={12} /> {t('settings.logoUpload')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                style={{ display: 'none' }}
                disabled={logoBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readLogo(file);
                  event.target.value = '';
                }}
              />
            </label>
            <Button size="sm" tone="danger" disabled={!settings.logoDataUrl} onClick={() => void patch({ logoDataUrl: null }, t('settings.logoRemoved'))}>
              {t('settings.logoRemove')}
            </Button>
          </div>
          <p className="hint">
            {t('settings.logoHint')}{' '}
            <span className="mono">{snapshot.state?.tournament?.name ?? '—'}</span>
          </p>
        </div>
      </Panel>
    </div>
  );
}

function ScoringTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const { t } = useI18n();
  const [increments, setIncrements] = useState(settings.scoringIncrements.join(','));
  useEffect(() => setIncrements(settings.scoringIncrements.join(',')), [settings.scoringIncrements.join(',')]);

  return (
    <div className="stack">
      <Panel title={t('settings.clockPanel')}>
        <div className="stack g4">
          <DraftText
             label={t('settings.durationLabel')}
            value={`${String(Math.floor(settings.defaultMatchDurationSec / 60)).padStart(2, '0')}:${String(
              settings.defaultMatchDurationSec % 60,
            ).padStart(2, '0')}`}
            onSave={(next) => {
              const match = /^(\d{1,3}):(\d{2})$/.exec(next.trim());
              const seconds = match
                ? Number(match[1]) * 60 + Number(match[2])
                : /^\d+$/.test(next.trim())
                  ? Number(next.trim()) * 60
                  : null;
              if (seconds === null || seconds < 10) {
                live.pushToast('error', t('settings.durationInvalid'));
                return;
              }
              void patch({ defaultMatchDurationSec: seconds }, t('settings.durationSaved'));
            }}
             hint={t('settings.durationHint')}
          />
          <DraftText
             label={t('settings.breakLabel')}
            value={`${String(Math.floor(settings.breakDurationSec / 60)).padStart(2, '0')}:${String(
              settings.breakDurationSec % 60,
            ).padStart(2, '0')}`}
            onSave={(next) => {
              const match = /^(\d{1,3}):(\d{2})$/.exec(next.trim());
              const seconds = match
                ? Number(match[1]) * 60 + Number(match[2])
                : /^\d+$/.test(next.trim())
                  ? Number(next.trim()) * 60
                  : null;
              if (seconds === null || seconds < 10) {
                live.pushToast('error', t('settings.breakInvalid'));
                return;
              }
              void patch({ breakDurationSec: seconds }, t('settings.breakSaved'));
            }}
             hint={t('settings.breakHint')}
          />
          <div className="field-row">
            <span className="label">{t('settings.directionLabel')}</span>
            <Segmented
              ariaLabel={t('settings.timerModeLabel')}
              value={settings.timerMode}
              onChange={(value) => void patch({ timerMode: value })}
              options={[
                { value: 'down', label: t('clock.down') },
                { value: 'up', label: t('clock.up') },
              ]}
            />
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.scoreButtonsPanel')}>
        <div className="stack g4">
          <div className="field-row">
            <span className="label">{t('settings.incrementsLabel')}</span>
            <div className="row g2">
              <input className="input" value={increments} onChange={(event) => setIncrements(event.target.value)} />
              <Button
                size="sm"
                onClick={() => {
                  const parsed = increments
                    .split(',')
                    .map((entry) => Number(entry.trim()))
                    .filter((entry) => Number.isInteger(entry) && entry !== 0);
                  if (parsed.length === 0) {
                    live.pushToast('error', t('settings.incrementsInvalid'));
                    return;
                  }
                  void patch({ scoringIncrements: parsed }, t('settings.incrementsSaved'));
                }}
              >
                {t('action.save')}
              </Button>
            </div>
            <span className="hint">{t('settings.incrementsHint')}</span>
          </div>
          <div className="btn-row">
            {['1,2,3', '1,3', '1,2', '1', '2,3'].map((preset) => (
              <Button key={preset} size="sm" onClick={() => setIncrements(preset)}>
                {preset}
              </Button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.winPanel')}>
        <div className="stack g4">
          <div className="field-row">
            <span className="label">{t('settings.winLabel')}</span>
            <Segmented
              ariaLabel={t('settings.winPanel')}
              value={settings.winCondition}
              onChange={(value) => void patch({ winCondition: value })}
              options={[
                { value: 'manual', label: t('settings.winManual') },
                { value: 'points', label: t('settings.winPoints') },
                { value: 'timer', label: t('settings.winTimer') },
                { value: 'either', label: t('settings.winEither') },
              ]}
            />
          </div>
          <DraftText
            label={t('settings.maxScoreLabel')}
            value={settings.maxScore === null ? '' : String(settings.maxScore)}
            allowEmpty
            inputMode="numeric"
            onSave={(next) => {
              const trimmed = next.trim();
              void patch(
                { maxScore: trimmed ? Number(trimmed) : null },
                trimmed ? t('settings.maxScoreSaved') : t('settings.maxScoreRemoved'),
              );
            }}
            hint={t('settings.maxScoreHint')}
          />
          <Switch
            checked={settings.allowDraws}
            onChange={(value) => void patch({ allowDraws: value })}
            label={t('settings.allowDrawsLabel')}
            hint={t('settings.allowDrawsHint')}
          />
        </div>
      </Panel>
    </div>
  );
}

function FieldsTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const fields = snapshot.state?.fields;

  const addField = () => {
    if (settings.fieldNames.length >= MAX_FIELDS) return;
    const names = [...settings.fieldNames, t('field.label', { n: settings.fieldNames.length + 1 })];
    void patch({ fieldNames: names }, t('settings.fieldAdded', { name: names[names.length - 1] }));
  };

  const removeField = (fieldId: string) => {
    const names = settings.fieldNames.filter((_, index) => String(index + 1) !== fieldId);
    void patch({ fieldNames: names }, t('settings.fieldRemoved'));
  };

  return (
    <div className="stack">
      <Panel
        title={t('settings.surfacesPanel', { n: settings.fieldNames.length })}
        actions={
          <div className="btn-row">
            <Button size="sm" tone="ghost" disabled={settings.fieldNames.length <= 1} onClick={() => removeField(String(settings.fieldNames.length))}>
              {t('settings.removeLast')}
            </Button>
            <Button size="sm" disabled={settings.fieldNames.length >= MAX_FIELDS} onClick={addField}>
              {t('settings.addField')}
            </Button>
          </div>
        }
      >
        <div className="stack g4">
          {settings.fieldNames.map((fieldName, index) => {
            const fieldId = String(index + 1);
            const occupied = Boolean(fields?.[fieldId]?.matchId);
            return (
              <div key={fieldId} className="row g2" style={{ alignItems: 'flex-end' }}>
                <div className="grow">
                  <DraftText
                    label={t('settings.fieldNameLabel', { n: fieldId })}
                    value={fieldName}
                    maxLength={24}
                    onSave={(next) => {
                      const names = settings.fieldNames.map((entry, i) => (i === index ? next : entry));
                      void patch({ fieldNames: names }, t('settings.fieldRenamed', { name: next }));
                    }}
                    hint={
                      fields?.[fieldId]
                        ? occupied
                          ? t('settings.fieldRunning')
                          : t('settings.fieldFree')
                        : undefined
                    }
                  />
                </div>
                {settings.fieldNames.length > 1 ? (
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={occupied}
                    title={occupied ? t('settings.fieldOccupiedTitle') : t('settings.removeFieldTitle', { n: fieldId })}
                    onClick={() => removeField(fieldId)}
                  >
                    {t('action.remove')}
                  </Button>
                ) : null}
              </div>
            );
          })}
          <p className="hint">{t('settings.fieldsHint')}</p>
        </div>
      </Panel>

      <Panel title={t('settings.automationPanel')}>
        <div className="stack g4">
          <Switch
            checked={settings.autoAssignNext}
            onChange={(value) => void patch({ autoAssignNext: value })}
            label={t('setup.autoAssignNext')}
            hint={t('settings.autoAssignHint')}
          />
          <Switch
            checked={settings.autoLoadNext}
            onChange={(value) => void patch({ autoLoadNext: value })}
            label={t('setup.autoLoadNext')}
            hint={t('settings.autoLoadHint')}
          />
        </div>
      </Panel>
    </div>
  );
}

function SecurityTab({ settings, patch }: { settings: Settings; patch: Patch }) {
  const snapshot = useLive();
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [rotate, setRotate] = useState<null | { kind: string }>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  const rotateToken = async (kind: string) => {
    const { token } = resolveAccess();
    const response = await fetch('/api/access/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tokenHeader(token) },
      body: JSON.stringify({ kind }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; token?: string; error?: string };
    if (!response.ok || !body.ok) {
      live.pushToast('error', body.error ?? t('settings.rotateFailed'));
      return;
    }
    setNewToken(body.token ?? null);
    live.pushToast('success', t('settings.rotateDone'));
  };

  return (
    <div className="stack">
      <Panel title={t('dialog.pin')}>
        <div className="stack g4">
          <div className="between">
            <span className="stack g1">
              <strong>{t('settings.requirePin')}</strong>
              <span className="hint">{t('settings.requirePinHint')}</span>
            </span>
            <Badge tone={settings.operatorPinSet ? 'live' : 'neutral'}>
              {settings.operatorPinSet ? t('settings.pinSet') : t('settings.pinNotSet')}
            </Badge>
          </div>
          <div className="row g2">
            <input
              className="input input--num"
              inputMode="numeric"
              placeholder={t('settings.pinPlaceholder')}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
              aria-label={t('settings.pinNew')}
            />
            <Button
              size="sm"
              tone="primary"
              disabled={!/^\d{4,8}$/.test(pin)}
              onClick={() => {
                void patch({ operatorPin: pin }, t('settings.pinSavedHint')).then(() => setPin(''));
              }}
            >
              <IconSave size={12} /> {t('settings.pinSetAction')}
            </Button>
            <Button
              size="sm"
              tone="danger"
              disabled={!settings.operatorPinSet}
              onClick={() => void patch({ operatorPin: null }, t('settings.pinCleared'))}
            >
              {t('settings.pinRemoveAction')}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.tokensPanel')}>
        <div className="stack g4">
          <p className="hint">{t('settings.tokensHint')}</p>
          <div className="btn-row">
            <Button size="sm" onClick={() => setRotate({ kind: 'admin' })}>
              <IconRefresh size={12} /> {t('settings.rotateAdmin')}
            </Button>
            {settings.fieldNames.map((fieldName, index) => (
              <Button key={index} size="sm" onClick={() => setRotate({ kind: `field-${index + 1}` })}>
                <IconRefresh size={12} /> {t('settings.rotateField', { field: fieldName })}
              </Button>
            ))}
            <Button size="sm" tone="danger" onClick={() => forgetAccess()}>
              <IconTrash size={12} /> {t('settings.forgetDevice')}
            </Button>
          </div>
          {newToken ? (
            <p className="small">
              {t('settings.newToken')} <span className="mono">{newToken}</span>
            </p>
          ) : null}
          <QrGallery
            links={snapshot.links.filter((link) => link.adminOnly && !link.purpose.startsWith('field-'))}
            max={3}
          />
        </div>
      </Panel>

      {rotate ? (
        <ConfirmDialog
          title={
            rotate.kind === 'admin'
              ? t('settings.rotateAdmin')
              : t('settings.rotateField', { field: rotate.kind.replace('-', ' ') })
          }
          confirmLabel={t('settings.rotateConfirmAction')}
          tone="danger"
          onCancel={() => setRotate(null)}
          onConfirm={() => {
            const kind = rotate.kind;
            setRotate(null);
            void rotateToken(kind);
          }}
          body={
            <div className="stack g2">
              <p>{t('settings.rotateConfirmBody')}</p>
              {rotate.kind === 'admin' ? <p className="hint">{t('settings.rotateAdminHint')}</p> : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
}

function BackupTab() {
  const { t } = useI18n();
  const settings = useLive().state?.settings;
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<unknown>(null);

  const loadStatus = async () => {
    const { token } = resolveAccess();
    try {
      const response = await fetch('/api/system', { headers: tokenHeader(token) });
      if (!response.ok) return;
      setStatus((await response.json()) as SystemStatus);
    } catch {
      /* keep the previous status */
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const writeBackup = async () => {
    setBusy(true);
    const { token } = resolveAccess();
    const response = await fetch('/api/backup', {
      method: 'POST',
      headers: tokenHeader(token),
    });
    const body = (await response.json().catch(() => ({}))) as { file?: string; error?: string };
    setBusy(false);
    if (response.ok && body.file) live.pushToast('success', t('settings.backupWritten', { file: body.file }));
    else live.pushToast('error', body.error ?? t('settings.backupFailed'));
    void loadStatus();
  };

  const prune = async () => {
    const { token } = resolveAccess();
    const response = await fetch('/api/prune', { method: 'POST', headers: tokenHeader(token) });
    const body = (await response.json().catch(() => ({}))) as { removed?: number };
    live.pushToast('success', t('settings.pruned', { n: body.removed ?? 0 }));
    void loadStatus();
  };

  return (
    <div className="stack">
      <Panel title={t('settings.backup')}>
        <div className="stack g4">
          <p className="hint">{t('settings.backupHint')}</p>
          <div className="btn-row">
            <Button
              tone="primary"
              busy={busy}
              onClick={() => {
                void downloadFromHost('/api/backup', 'tournament-backup.json').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.downloadFailed')),
                );
              }}
            >
              <IconDownload size={13} /> {t('settings.downloadBackup')}
            </Button>
            <Button busy={busy} onClick={() => void writeBackup()}>
              <IconSave size={13} /> {t('settings.writeBackup')}
            </Button>
          </div>
          {status ? (
            <dl className="kv">
              <dt>{t('settings.database')}</dt>
              <dd>
                {status.database} · {status.databaseOk ? t('diag.healthy') : t('diag.unreachable')}
              </dd>
              <dt>{t('settings.location')}</dt>
              <dd className="mono small">{status.databasePath}</dd>
              <dt>{t('diag.lastSave')}</dt>
              <dd>{status.lastSaveAt ? formatDateTime(status.lastSaveAt) : '—'}</dd>
              <dt>{t('diag.events')}</dt>
              <dd>{status.eventsStored}</dd>
              <dt>{t('settings.hostProcess')}</dt>
              <dd>
                {t('settings.hostStats', {
                  mb: status.memoryMb,
                  cpu: status.cpuPercent,
                  min: Math.round(status.uptimeSec / 60),
                })}
              </dd>
            </dl>
          ) : null}
        </div>
      </Panel>

      <Panel title={t('settings.restore')}>
        <div className="stack g4">
          <p className="hint">{t('settings.restoreHint')}</p>
          <div className="btn-row">
            <label className="btn btn--small">
              <IconUpload size={12} /> {t('settings.chooseBackup')}
              <input
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setRestoreFile(file);
                  void file.text().then((text) => {
                    try {
                      setConfirmRestore(JSON.parse(text) as unknown);
                    } catch {
                      live.pushToast('error', t('settings.restore_failed'));
                    }
                  });
                  event.target.value = '';
                }}
              />
            </label>
            <span className="hint">{restoreFile ? restoreFile.name : t('settings.noFile')}</span>
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.autoBackup')}>
        <div className="stack g4">
          <Switch
            checked={settings?.autoBackupEnabled ?? false}
            onChange={(value) => {
              void live.command('settings.update', { patch: { autoBackupEnabled: value } });
            }}
            label={t('settings.autoBackupLabel')}
            hint={t('settings.autoBackupHint')}
          />
          <DraftText
            label={t('settings.intervalLabel')}
            value={String(settings?.autoBackupIntervalMin ?? 30)}
            inputMode="numeric"
            onSave={(next) => {
              void live
                .command('settings.update', { patch: { autoBackupIntervalMin: Number(next) } })
                .then((result) => {
                  if (result.ok) live.pushToast('success', t('settings.intervalSaved'));
                  else live.pushToast('error', result.error ?? t('settings.intervalRejected'));
                });
            }}
          />
          <div className="between">
            <span className="stack g1">
              <strong>{t('settings.pruneLabel')}</strong>
              <span className="hint">{t('settings.pruneHint')}</span>
            </span>
            <Button size="sm" onClick={() => void prune()}>
              {t('settings.pruneAction')}
            </Button>
          </div>
        </div>
      </Panel>

      {confirmRestore ? (
        <ConfirmDialog
          title={t('settings.restoreConfirmTitle')}
          confirmLabel={t('settings.restoreConfirmAction')}
          tone="danger"
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => {
            const document = confirmRestore;
            setConfirmRestore(null);
            const { token } = resolveAccess();
            void fetch('/api/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...tokenHeader(token) },
              body: JSON.stringify(document),
            })
              .then(async (response) => {
                const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
                if (response.ok && body.ok) live.pushToast('success', t('settings.restore_ok'));
                else live.pushToast('error', body.error ?? t('settings.restoreError'));
              })
              .catch(() => live.pushToast('error', t('settings.restoreError')));
          }}
          body={
            <div className="stack g2">
              <p>{t('settings.restoreBody')}</p>
              <p className="hint">{t('settings.restoreSafety')}</p>
            </div>
          }
        />
      ) : null}
    </div>
  );
}

function TransferTab() {
  const { t } = useI18n();
  const snapshot = useLive();
  const state = snapshot.state;
  const [importText, setImportText] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const client = useMemo(() => (state ? state : null), [state]);

  return (
    <div className="stack">
      <Panel title={t('settings.exportPanel')}>
        <div className="stack g4">
          <p className="hint">{t('settings.exportHint')}</p>
          <div className="btn-row">
            <Button
              onClick={() =>
                void downloadFromHost('/api/export/results.csv', 'results.csv').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.exportFailed')),
                )
              }
            >
              <IconDownload size={13} /> {t('export.results')}
            </Button>
            <Button
              onClick={() =>
                void downloadFromHost('/api/export/matches.csv', 'match-history.csv').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.exportFailed')),
                )
              }
            >
              <IconDownload size={13} /> {t('export.matches')}
            </Button>
            <Button
              onClick={() =>
                void downloadFromHost('/api/export/participants.csv', 'participants.csv').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.exportFailed')),
                )
              }
            >
              <IconDownload size={13} /> {t('export.participants')}
            </Button>
            <Button
              onClick={() =>
                void downloadFromHost('/api/export/events.csv', 'event-history.csv').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.exportFailed')),
                )
              }
            >
              <IconDownload size={13} /> {t('export.events')}
            </Button>
            <Button
              onClick={() =>
                void downloadFromHost('/api/export/tournament.json', 'tournament-export.json').catch((error: unknown) =>
                  live.pushToast('error', error instanceof Error ? error.message : t('settings.exportFailed')),
                )
              }
            >
              <IconDownload size={13} /> {t('export.json')}
            </Button>
            <Button onClick={() => window.open('/print/results', '_blank', 'noopener')}>
              {t('export.printResults')}
            </Button>
            <Button onClick={() => window.open('/print/bracket', '_blank', 'noopener')}>{t('export.printBracket')}</Button>
            <Button onClick={() => window.open('/print/history', '_blank', 'noopener')}>{t('export.printHistory')}</Button>
          </div>
          <div className="row g2 wrap">
            <span className="tiny faint">{t('settings.offlineCopies')}</span>
            <Button
              size="sm"
              tone="ghost"
              disabled={!client}
              onClick={() => client && downloadBlob(resultsCsv(client), 'results.csv', 'text/csv;charset=utf-8')}
            >
              results.csv
            </Button>
            <Button
              size="sm"
              tone="ghost"
              disabled={!client}
              onClick={() => client && downloadBlob(matchesCsv(client), 'match-history.csv', 'text/csv;charset=utf-8')}
            >
              match-history.csv
            </Button>
            <Button
              size="sm"
              tone="ghost"
              disabled={!client}
              onClick={() => client && downloadBlob(participantsCsv(client), 'participants.csv', 'text/csv;charset=utf-8')}
            >
              participants.csv
            </Button>
            <Button
              size="sm"
              tone="ghost"
              disabled={!client}
              onClick={() => client && downloadBlob(tournamentJson(client), 'tournament-export.json', 'application/json')}
            >
              tournament.json
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.importPanel')}>
        <div className="stack g4">
          <label className="field-row">
            <span className="label">{t('settings.importLabel')}</span>
            <textarea
              className="textarea"
              rows={8}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="row g3 wrap">
            <Segmented
              ariaLabel={t('settings.importMode')}
              value={mode}
              onChange={(value) => setMode(value)}
              options={[
                { value: 'append', label: t('settings.importAppend') },
                { value: 'replace', label: t('settings.importReplace') },
              ]}
            />
            <label className="btn btn--small">
              <IconUpload size={12} /> {t('settings.loadCsv')}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void file.text().then(setImportText);
                  event.target.value = '';
                }}
              />
            </label>
            <Button
              tone="primary"
              size="sm"
              disabled={importText.trim().length === 0}
              onClick={() => {
                const participants = importText
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [name, team] = line.split(/[;,]/).map((cell) => cell.trim());
                    return { name, team: team || null, seed: null, checkedIn: true };
                  })
                  .filter((entry) => Boolean(entry.name));
                if (participants.length === 0) {
                  live.pushToast('error', t('settings.noNames'));
                  return;
                }
                void live.command('participant.import', { participants, mode }).then((result) => {
                  if (result.ok) {
                    live.pushToast('success', t('participant.imported', { n: participants.length }));
                    setImportText('');
                  } else {
                    live.pushToast('error', result.error ?? t('settings.importRefused'));
                  }
                });
              }}
            >
              {t('action.import')}
            </Button>
          </div>
          <p className="hint">{t('settings.importHint')}</p>
        </div>
      </Panel>
    </div>
  );
}

function ShortcutsTab() {
  const { t } = useI18n();
  const rows: [string, MessageKey][] = [
    ['Space', 'settings.scSpace'],
    ['1', 'settings.scAddFirst'],
    ['2', 'settings.scAddSecond'],
    ['U', 'settings.scUndo'],
    ['R', 'settings.scRedo'],
    ['E', 'settings.scEnd'],
    ['Esc', 'settings.scEscape'],
    ['?', 'settings.scHelp'],
    ['+ / −', 'settings.scZoom'],
    ['0', 'settings.scZoomReset'],
    ['Ctrl + wheel', 'settings.scZoomWheel'],
  ];
  return (
    <Panel title={t('dialog.shortcuts')}>
      <div className="stack g4">
        <p className="hint">{t('settings.shortcutsHint')}</p>
        <table className="table">
          <tbody>
            {rows.map(([key, label]) => (
              <tr key={key}>
                <td style={{ width: 120 }}>
                  <kbd className="mono">{key}</kbd>
                </td>
                <td>{t(label)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

interface HostLogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

function DeveloperTab() {
  const snapshot = useLive();
  const { t } = useI18n();
  const now = useNow(1000);
  const [logs, setLogs] = useState<HostLogLine[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const { token } = resolveAccess();
    const headers = tokenHeader(token);
    try {
      const [logResponse, statusResponse] = await Promise.all([
        fetch('/api/logs?limit=200', { headers }),
        fetch('/api/system', { headers }),
      ]);
      if (logResponse.ok) {
        const body = (await logResponse.json()) as { lines?: HostLogLine[] };
        setLogs(body.lines ?? []);
      }
      if (statusResponse.ok) setStatus((await statusResponse.json()) as SystemStatus);
    } catch {
      /* offline */
    }
    setBusy(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const stateSize = snapshot.state ? formatBytes(JSON.stringify(snapshot.state).length) : '—';

  return (
    <div className="stack">
      <Panel
        title={t('settings.connectionPanel')}
        actions={
          <Button size="sm" tone="ghost" busy={busy} onClick={() => void load()}>
            <IconRefresh size={12} /> {t('settings.reload')}
          </Button>
        }
      >
        <div className="stack g4">
          <dl className="kv">
            <dt>{t('diag.websocket')}</dt>
            <dd>
              <ConnectionBadge /> {snapshot.connection}
            </dd>
            <dt>{t('settings.roleLabel')}</dt>
            <dd>
              {snapshot.role} {snapshot.tokenScope ? `· ${t('field.label', { n: snapshot.tokenScope })}` : ''}
            </dd>
            <dt>{t('diag.reconnects')}</dt>
            <dd>{snapshot.reconnects}</dd>
            <dt>{t('settings.pendingLabel')}</dt>
            <dd>{snapshot.pending}</dd>
            <dt>{t('settings.lastMessageLabel')}</dt>
            <dd>{snapshot.lastMessageAt ? relativeTime(snapshot.lastMessageAt, now) : '—'}</dd>
            <dt>{t('settings.stateSizeLabel')}</dt>
            <dd>{stateSize}</dd>
            <dt>{t('settings.sequenceLabel')}</dt>
            <dd>{snapshot.state?.seq ?? 0}</dd>
          </dl>
          <div className="btn-row">
            <Button
              size="sm"
              onClick={() => {
                live.resync();
                live.pushToast('info', t('settings.resyncRequested'));
              }}
            >
              {t('settings.forceResync')}
            </Button>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => {
                const raw = JSON.stringify(snapshot.state, null, 2);
                downloadBlob(raw, 'live-state.json', 'application/json');
              }}
            >
              {t('settings.dumpState')}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.hostPanel')}>
        {status ? (
          <dl className="kv">
            <dt>{t('settings.versionLabel')}</dt>
            <dd>
              {status.version} · {t('settings.protocolLabel')} {snapshot.state ? '2' : '—'}
            </dd>
            <dt>{t('settings.database')}</dt>
            <dd>
              {status.database} ({status.databaseOk ? t('diag.healthy') : t('settings.dbError')}) · {status.databasePath}
            </dd>
            <dt>{t('diag.clients')}</dt>
            <dd>
              {t('settings.clientsTotal', { n: status.clients })}{' '}
              {Object.entries(status.clientsByTopic)
                .map(([topic, count]) => `${topic} ${count}`)
                .join(', ') || t('settings.clientsNone')}
            </dd>
            <dt>{t('diag.messageCount')}</dt>
            <dd>{status.messageCount}</dd>
            <dt>{t('diag.memory')}</dt>
            <dd>
              {status.memoryMb} MB · {status.cpuPercent}%
            </dd>
            <dt>{t('diag.uptime')}</dt>
            <dd>{Math.round(status.uptimeSec / 60)} min</dd>
            <dt>{t('settings.lastCleanSave')}</dt>
            <dd>{status.savedCleanly ? t('settings.yes') : t('settings.pending')}</dd>
          </dl>
        ) : (
          <p className="hint">{t('settings.hostStatusHint')}</p>
        )}
      </Panel>

      <Panel title={t('diag.logs')}>
        <div className="stack g3">
          <pre
            className="mono small scroll"
            style={{
              maxHeight: '40vh',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: 'var(--space-3)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {logs.length > 0
              ? logs
                  .map(
                    (line) =>
                      `${formatTime(line.ts)} ${line.level.toUpperCase().padEnd(5)} ${line.scope.padEnd(10)} ${line.message}`,
                  )
                  .join('\n')
              : t('settings.noLogs')}
          </pre>
          <p className="hint">{t('settings.logHint')}</p>
        </div>
      </Panel>
    </div>
  );
}
