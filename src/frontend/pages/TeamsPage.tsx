import { useMemo, useRef, useState } from 'react';
import { RADBALL_AGE_CATEGORIES, type RadballAgeCategory, type TeamLibraryEntry } from '../../shared/types';
import { useLive, useLocalStorage } from '../lib/hooks';
import { asTranslate, useI18n } from '../lib/useI18n';
import { tr } from '../lib/i18n';
import { live } from '../lib/live';
import { navigate } from '../lib/router';
import {
  AGE_GROUP_TABS,
  DEFAULT_AGE_GROUP,
  ageGroupCounts,
  ageGroupLabel,
  libraryTeamIssues,
  libraryTeams,
  parseLibraryTeams,
  teamsForTab,
  type AgeGroupTab,
} from '../lib/teams';
import { cx, downloadBlob } from '../lib/util';
import { logoSrc, refreshLogos, useLogos } from '../lib/logos';
import { Button, ConfirmDialog, Empty, Modal, Panel, SelectField, TextField } from '../components/primitives';
import { CrestWithName } from '../components/TeamCrest';
import { IconDownload, IconEdit, IconPlus, IconTrash } from '../components/icons';

const TAB_KEY = 'tsb.teams.tab';

interface TeamDraft {
  name: string;
  club: string;
  player1: string;
  player2: string;
  ageCategory: RadballAgeCategory;
  /** Crest file name from the host's logos folder, or '' for the default. */
  logo: string;
}

const EMPTY_DRAFT: TeamDraft = {
  name: '',
  club: '',
  player1: '',
  player2: '',
  ageCategory: DEFAULT_AGE_GROUP,
  logo: '',
};

function draftFrom(entry: TeamLibraryEntry): TeamDraft {
  return {
    name: entry.name,
    club: entry.club ?? '',
    player1: entry.players[0],
    player2: entry.players[1],
    ageCategory: entry.ageCategory,
    logo: entry.logo ?? '',
  };
}

function isAgeGroupTab(value: unknown): value is AgeGroupTab {
  return typeof value === 'string' && (AGE_GROUP_TABS as string[]).includes(value);
}

/** Mirror the server rules so the host sees the problem before pressing Add. */
function validateDraft(draft: TeamDraft): Partial<Record<keyof TeamDraft, string>> {
  const errors: Partial<Record<keyof TeamDraft, string>> = {};
  const name = draft.name.trim();
  const player1 = draft.player1.trim();
  const player2 = draft.player2.trim();
  if (!name) errors.name = tr('teams.err.name');
  else if (name.length > 60) errors.name = tr('teams.err.maxChars');
  if (draft.club.trim().length > 60) errors.club = tr('teams.err.maxChars');
  if (!player1) errors.player1 = tr('teams.err.player1');
  else if (player1.length > 60) errors.player1 = tr('teams.err.maxChars');
  if (!player2) errors.player2 = tr('teams.err.player2');
  else if (player2.length > 60) errors.player2 = tr('teams.err.maxChars');
  if (player1 && player2 && player1.toLowerCase() === player2.toLowerCase()) {
    errors.player2 = tr('teams.err.differFromPlayer1');
  }
  return errors;
}

const CSV_TEMPLATE = [
  'team,club,player 1,player 2,age group',
  'RV Gärtringen I,RV Gärtringen,Max Mustermann,Alexander Muster,U15',
  'RV Süd I,RV Süd,Jonas Becker,Finn Wagner,U15',
].join('\n');

export function TeamsPage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const library = snapshot.state?.teamLibrary ?? null;
  const isAdmin = snapshot.role === 'admin';

  const [storedTab, setStoredTab] = useLocalStorage<string>(TAB_KEY, 'all');
  const tab: AgeGroupTab = isAgeGroupTab(storedTab) ? storedTab : 'all';
  const setTab = (next: AgeGroupTab) => setStoredTab(next);

  const counts = useMemo(() => ageGroupCounts(library), [library]);
  const allTeams = useMemo(() => libraryTeams(library), [library]);
  const teams = useMemo(() => teamsForTab(library, tab), [library, tab]);
  const filledGroups = RADBALL_AGE_CATEGORIES.filter((age) => counts[age] > 0).length;

  const [draft, setDraft] = useState<TeamDraft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<Partial<Record<keyof TeamDraft, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TeamLibraryEntry | null>(null);
  const [removing, setRemoving] = useState<TeamLibraryEntry | null>(null);
  const [bulk, setBulk] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /* A new team lands in the group the host is currently looking at. */
  const defaultAge: RadballAgeCategory = tab === 'all' ? DEFAULT_AGE_GROUP : tab;

  const patchDraft = (patch: Partial<TeamDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof TeamDraft];
      return next;
    });
  };

  const addTeam = async () => {
    const errors = validateDraft(draft);
    setDraftErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const result = await live.command('team.add', {
      name: draft.name.trim(),
      club: draft.club.trim() || null,
      players: [draft.player1.trim(), draft.player2.trim()],
      ageCategory: draft.ageCategory,
      logo: draft.logo.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? t('err.generic'));
      return;
    }
    // Say it happened. A silent success is indistinguishable from a dead button.
    live.pushToast('success', `${draft.name.trim()} filed under ${draft.ageCategory}.`);
    // Land the host on the group they just filed the team under.
    if (tab === 'all') setTab(draft.ageCategory);
    setDraft({ ...EMPTY_DRAFT, ageCategory: draft.ageCategory });
  };

  const saveEdit = async (entry: TeamLibraryEntry, next: TeamDraft): Promise<string | null> => {
    setBusy(true);
    setError(null);
    const result = await live.command('team.update', {
      id: entry.id,
      team: {
        name: next.name.trim(),
        club: next.club.trim() || null,
        players: [next.player1.trim(), next.player2.trim()],
        ageCategory: next.ageCategory,
        logo: next.logo.trim() || null,
      },
    });
    setBusy(false);
    if (!result.ok) return result.error ?? t('err.generic');
    setEditing(null);
    live.pushToast('success', `${next.name.trim()} saved.`);
    return null;
  };

  /** Re-file a squad into another age group straight from its row. */
  const moveTeam = async (entry: TeamLibraryEntry, age: RadballAgeCategory) => {
    // `team.update` replaces the whole squad, so the crest has to be resent or
    // moving a team between age groups would quietly reset its logo.
    const result = await live.command('team.update', {
      id: entry.id,
      team: {
        name: entry.name,
        club: entry.club,
        players: entry.players,
        ageCategory: age,
        logo: entry.logo ?? null,
      },
    });
    if (result.ok) live.pushToast('success', `${entry.name} moved to ${age}.`);
    else live.pushToast('error', result.error ?? t('err.generic'));
  };

  const removeTeam = async () => {
    if (!removing) return;
    setBusy(true);
    const result = await live.command('team.remove', { id: removing.id });
    setBusy(false);
    if (result.ok) live.pushToast('success', `${removing.name} removed from the library.`);
    else live.pushToast('error', result.error ?? t('err.generic'));
    setRemoving(null);
  };

  const parsedBulk = useMemo(() => parseLibraryTeams(bulk, defaultAge), [bulk, defaultAge]);
  const bulkIssues = useMemo(() => libraryTeamIssues(parsedBulk, asTranslate(t)), [parsedBulk, t]);
  const bulkReady = parsedBulk.length > 0 && bulkIssues.length === 0;

  const runImport = async (mode: 'append' | 'replace') => {
    setBusy(true);
    setError(null);
    const result = await live.command('team.import', {
      mode,
      teams: parsedBulk.map((team) => ({
        name: team.name,
        club: team.club,
        players: team.players,
        ageCategory: team.ageCategory,
      })),
    });
    setBusy(false);
    setConfirmReplace(false);
    if (!result.ok) {
      setError(result.error ?? t('err.generic'));
      return;
    }
    setBulk('');
    live.pushToast('success', `${t('team.count', { n: parsedBulk.length })}.`);
  };

  const readFile = async (file: File) => {
    try {
      setBulk(await file.text());
      setError(null);
    } catch {
      setError(t('err.generic'));
    }
  };

  const selectTab = (next: AgeGroupTab) => {
    setTab(next);
    setError(null);
  };

  /** Roving focus across the age-group rail, matching the field tabs. */
  const moveTab = (direction: 1 | -1) => {
    const next = AGE_GROUP_TABS[(AGE_GROUP_TABS.indexOf(tab) + direction + AGE_GROUP_TABS.length) % AGE_GROUP_TABS.length];
    selectTab(next);
    tabRefs.current[AGE_GROUP_TABS.indexOf(next)]?.focus();
  };

  const downloadTemplate = () => {
    downloadBlob(CSV_TEMPLATE, 'team-library-template.csv', 'text/csv;charset=utf-8');
  };

  if (!snapshot.state) return <p className="empty">{t('conn.connecting')}…</p>;

  return (
    <div className="shell" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
      <aside className="shell__side">
        <div
          className="stack g1"
          role="tablist"
          aria-label={t('team.ageGroup')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
              event.preventDefault();
              moveTab(1);
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
              event.preventDefault();
              moveTab(-1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              selectTab(AGE_GROUP_TABS[0]);
            } else if (event.key === 'End') {
              event.preventDefault();
              selectTab(AGE_GROUP_TABS[AGE_GROUP_TABS.length - 1]);
            }
          }}
          style={{ position: 'sticky', top: 0 }}
        >
          <span className="tiny dim" style={{ padding: '0 var(--space-3) var(--space-2)' }}>
            {t('team.ageGroup')}
          </span>
          {AGE_GROUP_TABS.map((entry, index) => {
            const selected = entry === tab;
            const age = entry as RadballAgeCategory;
            return (
              <button
                key={entry}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={cx('nav__item', 'age-tab', selected && 'age-tab--active')}
                onClick={() => selectTab(entry)}
              >
                <span className="grow nowrap">
                  {entry === 'all' ? t('team.all') : ageGroupLabel(age, asTranslate(t))}
                </span>
                <span className="tnum age-tab__count">{counts[entry]}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="shell__main scroll">
        {error ? (
          <p className="banner banner--error" role="alert">
            {error}
          </p>
        ) : null}

        <Panel
          title={tab === 'all' ? t('team.all') : ageGroupLabel(tab as RadballAgeCategory, asTranslate(t))}
          actions={
            <>
              <Button size="sm" tone="ghost" onClick={downloadTemplate}>
                <IconDownload size={14} />
                {t('team.csvTemplate')}
              </Button>
              <Button size="sm" tone="primary" onClick={() => navigate('/setup')}>
                {t('nav.setup')}
              </Button>
            </>
          }
        >
          {isAdmin ? (
            <TeamForm
              draft={draft}
              errors={draftErrors}
              busy={busy}
              submitLabel={t('team.add')}
              onChange={patchDraft}
              onSubmit={addTeam}
            />
          ) : (
            <Empty>{t('err.forbidden')}</Empty>
          )}

          {teams.length === 0 ? (
            <Empty>
              {allTeams.length === 0
                ? t('teams.emptyNone')
                : t('teams.emptyGroup', {
                    age: ageGroupLabel(tab as RadballAgeCategory, asTranslate(t)),
                  })}
            </Empty>
          ) : (
            <div className="team-table-wrap">
              <table className="table team-table">
                <thead>
                  <tr>
                    <th scope="col">{t('results.team')}</th>
                    <th scope="col">{t('team.club')}</th>
                    <th scope="col">{t('teams.col.players')}</th>
                    <th scope="col" className="team-table__age">
                      {t('team.ageGroup')}
                    </th>
                    <th scope="col" className="right">
                      <span className="sr-only">{t('teams.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((entry) => (
                    <tr key={entry.id}>
                      <th scope="row" className="team-table__name">
                        <CrestWithName logo={entry.logo} name={entry.name} />
                      </th>
                      <td className="dim">{entry.club ?? <span className="faint">—</span>}</td>
                      <td>
                        <span className="nowrap">
                          {entry.players[0]} <span className="faint">&amp;</span> {entry.players[1]}
                        </span>
                      </td>
                      <td className="team-table__age">
                        {isAdmin ? (
                          <>
                            <label className="sr-only" htmlFor={`age-${entry.id}`}>
                              {`${t('team.ageGroup')}: ${entry.name}`}
                            </label>
                            <select
                              id={`age-${entry.id}`}
                              className="select select--sm"
                              value={entry.ageCategory}
                              onChange={(event) => void moveTeam(entry, event.target.value as RadballAgeCategory)}
                            >
                              {RADBALL_AGE_CATEGORIES.map((age) => (
                                <option key={age} value={age}>
                                  {age}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <span className="badge">{entry.ageCategory}</span>
                        )}
                      </td>
                      <td className="right nowrap">
                        {isAdmin ? (
                          <div className="row g1" style={{ justifyContent: 'flex-end' }}>
                            <Button
                              size="sm"
                              tone="ghost"
                              onClick={() => {
                                setError(null);
                                setEditing(entry);
                              }}
                              aria-label={`${t('action.rename')}: ${entry.name}`}
                              title={t('action.rename')}
                            >
                              <IconEdit size={14} />
                            </Button>
                            <Button
                              size="sm"
                              tone="ghost"
                              onClick={() => setRemoving(entry)}
                              aria-label={`${t('action.remove')}: ${entry.name}`}
                              title={t('action.remove')}
                            >
                              <IconTrash size={14} />
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {isAdmin ? (
          <Panel
            title={t('team.paste')}
            actions={
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                {t('setup.importCsv')}
              </Button>
            }
          >
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept=".csv,text/csv,text/plain"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
                event.target.value = '';
              }}
            />
            <div className="stack g3">
              <label className="label" htmlFor="bulk-teams">
                {t('teams.bulkLabel')}
              </label>
              <textarea
                id="bulk-teams"
                className="textarea setup-roster"
                value={bulk}
                onChange={(event) => setBulk(event.target.value)}
                rows={7}
                spellCheck={false}
                aria-describedby="bulk-format bulk-actions"
                placeholder={CSV_TEMPLATE.split('\n').slice(1).join('\n')}
              />
              <p className="hint" id="bulk-format">
                {t('teams.bulkHint', { age: defaultAge })}
              </p>
              <div className="between wrap g3" id="bulk-actions">
                <span className="setup-roster-summary" aria-live="polite">
                  <strong className="tnum">{parsedBulk.length}</strong>{' '}
                  <span className="faint">
                    {t(
                      parsedBulk.length === 1 ? 'teams.bulkReadyOne' : 'teams.bulkReadyMany',
                      { n: parsedBulk.length },
                    )}
                    {bulkIssues.length > 0 ? ` · ${t('teams.bulkToFix', { n: bulkIssues.length })}` : ''}
                  </span>
                </span>
                <div className="row g2 wrap">
                  <Button size="sm" tone="danger" disabled={!bulkReady} onClick={() => setConfirmReplace(true)}>
                    {t('action.replace')}
                  </Button>
                  <Button size="sm" tone="primary" busy={busy} disabled={!bulkReady} onClick={() => void runImport('append')}>
                    <IconPlus size={14} />
                    {t('action.add')}
                  </Button>
                </div>
              </div>
              {bulkIssues.length > 0 ? (
                <div className="setup-issues" role="alert">
                  <strong>{t('teams.fixLines')}</strong>
                  {bulkIssues.slice(0, 6).map((issue, index) => (
                    <span key={`${issue.line}-${index}`}>
                      {t('teams.lineSummary', { line: issue.line, message: issue.message })}
                    </span>
                  ))}
                  {bulkIssues.length > 6 ? (
                    <span>{t('setup.moreIssues', { n: bulkIssues.length - 6 })}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Panel>
        ) : null}

        <p className="hint">
          {allTeams.length === 0
            ? t('teams.libraryNote')
            : `${t(
                filledGroups === 1 ? 'teams.onFileOne' : 'teams.onFileMany',
                { count: allTeams.length, groups: filledGroups },
              )} ${t('teams.libraryNote')}`}
        </p>
      </div>

      {editing ? (
        <EditTeamDialog
          entry={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(next) => saveEdit(editing, next)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={t('teams.removeTitle')}
          body={
            <p>{t('teams.removeBody', { name: removing.name })}</p>
          }
          confirmLabel={t('action.remove')}
          tone="danger"
          busy={busy}
          onConfirm={() => void removeTeam()}
          onCancel={() => setRemoving(null)}
        />
      ) : null}

      {confirmReplace ? (
        <ConfirmDialog
          title={t('teams.replaceTitle')}
          body={
            <p>{t('teams.replaceBody', { all: counts.all, parsed: parsedBulk.length })}</p>
          }
          confirmLabel={t('action.replace')}
          tone="danger"
          busy={busy}
          onConfirm={() => void runImport('replace')}
          onCancel={() => setConfirmReplace(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                              */
/* ------------------------------------------------------------------ */

function TeamForm({
  draft,
  errors,
  busy,
  submitLabel,
  onChange,
  onSubmit,
}: {
  draft: TeamDraft;
  errors: Partial<Record<keyof TeamDraft, string>>;
  busy: boolean;
  submitLabel: string;
  onChange: (patch: Partial<TeamDraft>) => void;
  onSubmit: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <form
      className="team-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <TextField
        label={t('team.name')}
        value={draft.name}
        maxLength={60}
        autoComplete="off"
        error={errors.name}
        onChange={(event) => onChange({ name: event.target.value })}
      />
      {/* "Club (optional)" loses the parenthetical: there is no catalogue entry
          for it, and a bare "Verein" is the right label for the field. */}
      <TextField
        label={t('team.club')}
        value={draft.club}
        maxLength={60}
        autoComplete="off"
        error={errors.club}
        onChange={(event) => onChange({ club: event.target.value })}
      />
      <TextField
        label={t('team.player1')}
        value={draft.player1}
        maxLength={60}
        autoComplete="off"
        error={errors.player1}
        onChange={(event) => onChange({ player1: event.target.value })}
      />
      <TextField
        label={t('team.player2')}
        value={draft.player2}
        maxLength={60}
        autoComplete="off"
        error={errors.player2}
        onChange={(event) => onChange({ player2: event.target.value })}
      />
      <SelectField
        label={t('team.ageGroup')}
        value={draft.ageCategory}
        onChange={(event) => onChange({ ageCategory: event.target.value as RadballAgeCategory })}
      >
        {RADBALL_AGE_CATEGORIES.map((age) => (
          <option key={age} value={age}>
            {ageGroupLabel(age, asTranslate(t))}
          </option>
        ))}
      </SelectField>
      <LogoPicker value={draft.logo} onChange={(logo) => onChange({ logo })} />
      <div className="field-row team-form__action">
        <Button type="submit" tone="primary" busy={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Choose a crest out of the host's logos folder.
 *
 * A grid of the actual images rather than a select of file names: the host is
 * looking for "the one with the red cross", and a list of `logo2-final-v3.png`
 * does not answer that. The folder's own default is offered as its own tile, so
 * "no crest of its own" is a choice with a picture rather than an empty option.
 */
function LogoPicker({ value, onChange }: { value: string; onChange: (logo: string) => void }) {
  const { t } = useI18n();
  const index = useLogos();
  const defaultFile = index.defaultFile;
  const chosen = value.trim();
  // A crest the squad had that has since been deleted from the folder: still
  // shown, so the host can see why it is not rendering and pick another.
  const orphaned = chosen && !index.files.includes(chosen) ? chosen : null;

  return (
    <fieldset className="logo-picker">
      <legend className="label">{t('teams.logoLegend')}</legend>
      <div
        className="logo-picker__grid"
        role="radiogroup"
        aria-label={t('teams.logoAria')}
      >
        <button
          type="button"
          role="radio"
          aria-checked={!chosen}
          className={cx('logo-tile', !chosen && 'logo-tile--on')}
          onClick={() => onChange('')}
          title={t('teams.logoDefaultTitle')}
        >
          {defaultFile ? (
            <img src={logoSrc(defaultFile, index) ?? undefined} alt="" aria-hidden="true" />
          ) : (
            <span className="logo-tile__none" aria-hidden="true">
              {t('teams.logoNone')}
            </span>
          )}
          <span className="logo-tile__name">{t('teams.logoDefault')}</span>
        </button>

        {/* The default already has a tile of its own, so the folder's own
          `default.svg` is only listed once it is actually chosen -- otherwise
          the grid shows the same mark twice under two different names. */}
      {index.files
        .filter((file) => file !== defaultFile || chosen === file)
        .map((file) => (
          <button
            key={file}
            type="button"
            role="radio"
            aria-checked={chosen === file}
            className={cx('logo-tile', chosen === file && 'logo-tile--on')}
            onClick={() => onChange(file)}
            title={file}
          >
            <img src={logoSrc(file, index) ?? undefined} alt="" aria-hidden="true" />
            <span className="logo-tile__name">{file}</span>
          </button>
        ))}
      </div>

      {orphaned ? (
        <p className="hint hint--warn">{t('teams.logoGone', { file: orphaned })}</p>
      ) : null}

      <p className="hint">
        {index.exists ? (
          <>
            {t(
              index.files.length === 1 ? 'teams.logoFolderOne' : 'teams.logoFolderMany',
              { count: index.files.length },
            )}{' '}
            {t('teams.logoFolderHint', { dir: index.dir })}
          </>
        ) : (
          <>{t('teams.logoFolderMissing', { dir: index.dir })}</>
        )}
      </p>
      <Button size="sm" tone="ghost" onClick={() => void refreshLogos()}>
        {t('teams.refreshLogos')}
      </Button>
    </fieldset>
  );
}

function EditTeamDialog({
  entry,
  busy,
  onClose,
  onSave,
}: {
  entry: TeamLibraryEntry;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: TeamDraft) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TeamDraft>(() => draftFrom(entry));
  const [error, setError] = useState<string | null>(null);
  const errors = validateDraft(draft);
  const valid = Object.keys(errors).length === 0;

  const submit = async () => {
    setError(await onSave(draft));
  };

  return (
    <Modal
      title={`${t('action.rename')}: ${entry.name}`}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button tone="primary" busy={busy} disabled={!valid} onClick={() => void submit()}>
            {t('action.save')}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}
      <TeamForm
        draft={draft}
        errors={errors}
        busy={busy}
        submitLabel={t('action.save')}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onSubmit={async () => {
          if (!valid) {
            setError(Object.values(errors)[0] ?? tr('teams.checkDetails'));
            return;
          }
          await submit();
        }}
      />
    </Modal>
  );
}
