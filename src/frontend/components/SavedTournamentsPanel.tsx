/**
 * The "Load" half of the New tournament page: one shelf of setups, and the
 * dialogs that put a new one on it and rename one.
 *
 * The event that ships with the app sits at the top of that shelf instead of in
 * a panel of its own, so there is a single place to look. It keeps its dashed
 * border and an "Example" badge, and offers Load and Edit but no rename or
 * remove: it is app code rather than host data, so editing it asks for a shelf
 * name and files the result as the host's own setup.
 *
 * Loading does not create anything. It fills the wizard, which then shows the
 * same review step as any other setup -- so a saved setup is a head start, never
 * a shortcut past the confirmation that would otherwise be skipped.
 */
import { useState } from 'react';
import { EXAMPLE_SETUPS, type ExampleSetup } from '../../shared/examples';
import type { SavedTournamentEntry, SavedTournamentLibrary } from '../../shared/types';
import { live } from '../lib/live';
import { savedSetupFacts, savedSetupLabel, savedSetupSummary, savedSetups } from '../lib/saved';
import { asTranslate, useI18n } from '../lib/useI18n';
import { cx } from '../lib/util';
import { IconEdit, IconSave, IconTrash } from './icons';
import { Badge, Button, ConfirmDialog, Modal, Panel, TextField } from './primitives';

const MAX_LABEL = 80;

export function SavedTournamentsPanel({
  library,
  /** The shelf entry the wizard was loaded from, if any. */
  activeId,
  onLoad,
  onEdit,
  onLoadExample,
  onEditExample,
  onSave,
}: {
  library: SavedTournamentLibrary | null | undefined;
  activeId: string | null;
  onLoad: (entry: SavedTournamentEntry) => void;
  onEdit: (entry: SavedTournamentEntry) => void;
  onLoadExample: (example: ExampleSetup) => void;
  onEditExample: (example: ExampleSetup) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const entries = savedSetups(library);
  const [renaming, setRenaming] = useState<SavedTournamentEntry | null>(null);
  const [removing, setRemoving] = useState<SavedTournamentEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const rename = async (name: string) => {
    if (!renaming) return;
    setBusy(true);
    const result = await live.command('setup.rename', { id: renaming.id, name });
    setBusy(false);
    if (!result.ok) {
      live.pushToast('error', result.error ?? t('err.generic'));
      return;
    }
    setRenaming(null);
    live.pushToast('success', t('saved.renamedToast', { name }));
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const result = await live.command('setup.remove', { id: removing.id });
    setBusy(false);
    if (!result.ok) {
      live.pushToast('error', result.error ?? t('err.generic'));
      return;
    }
    setRemoving(null);
    live.pushToast('info', t('saved.removedToast', { name: removing.name }));
  };

  return (
    <div className="setup-shelf">
      <Panel
        title={t('setup.saved')}
        actions={
          <Button size="sm" onClick={onSave}>
            <IconSave size={14} />
            {t('action.save')}
          </Button>
        }
      >
        <div className="stack g3">
          <p className="hint">{t('saved.intro')}</p>
          {entries.length === 0 ? (
            <div className="setup-shelf__empty">
              <strong>{t('saved.onlyExample')}</strong>
              <span className="small dim">
                {t('saved.onlyExampleBefore')}{' '}
                <strong>{t('saved.saveCurrentSetup')}</strong> {t('saved.onlyExampleAfter')}
              </span>
            </div>
          ) : null}
          <ul className="setup-shelf__list">
            {EXAMPLE_SETUPS.map((example) => (
              <li key={example.id} className={cx('setup-shelf__card', 'setup-shelf__card--example')}>
                <div className="setup-shelf__main">
                  <span className="setup-shelf__name">{example.name}</span>
                  <span className="setup-shelf__event">{example.description}</span>
                  <span className="setup-shelf__meta">
                    <Badge tone="accent">{t('saved.exampleBadge')}</Badge>
                    <span className="small dim">
                      {savedSetupSummary(example.setup, asTranslate(t)).format} · {savedSetupSummary(example.setup, asTranslate(t)).roster} ·{' '}
                      {savedSetupSummary(example.setup, asTranslate(t)).rule} · {t('saved.shipsWithApp')}
                    </span>
                  </span>
                </div>
                <div className="setup-shelf__actions">
                  <Button size="sm" tone="primary" onClick={() => onLoadExample(example)}>
                    {t('setup.load')}
                  </Button>
                  <Button size="sm" onClick={() => onEditExample(example)} title={t('saved.changeExampleTitle')}>
                    {t('action.rename')}
                  </Button>
                </div>
              </li>
            ))}
            {entries.map((entry) => (
              <SavedSetupCard
                key={entry.id}
                entry={entry}
                active={entry.id === activeId}
                onLoad={() => onLoad(entry)}
                onEdit={() => onEdit(entry)}
                onRename={() => setRenaming(entry)}
                onRemove={() => setRemoving(entry)}
              />
            ))}
          </ul>
        </div>

        {renaming ? (
          <RenameSetupDialog
            entry={renaming}
            busy={busy}
            onClose={() => setRenaming(null)}
            onConfirm={(name) => void rename(name)}
          />
        ) : null}

        {removing ? (
          <ConfirmDialog
            title={t('saved.removeTitle')}
            body={
              <p>{t('saved.removeBody', { label: savedSetupLabel(removing) })}</p>
            }
            confirmLabel={t('action.delete')}
            tone="danger"
            busy={busy}
            onConfirm={() => void remove()}
            onCancel={() => setRemoving(null)}
          />
        ) : null}
      </Panel>
    </div>
  );
}

function SavedSetupCard({
  entry,
  active,
  onLoad,
  onEdit,
  onRename,
  onRemove,
}: {
  entry: SavedTournamentEntry;
  active: boolean;
  onLoad: () => void;
  onEdit: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const label = savedSetupLabel(entry);
  const facts = savedSetupFacts(entry, Date.now(), t);
  return (
    <li className={cx('setup-shelf__card', active && 'setup-shelf__card--active')}>
      <div className="setup-shelf__main">
        <span className="setup-shelf__name">{label}</span>
        {entry.setup.name && entry.setup.name !== label ? (
          <span className="setup-shelf__event faint">{entry.setup.name}</span>
        ) : null}
        <span className="setup-shelf__meta">
          <Badge tone="info">{facts.format}</Badge>
          <span className="small dim">
            {facts.roster} ·{' '}
            {t(facts.fields === 1 ? 'saved.fieldOne' : 'saved.fieldMany', { n: facts.fields })}
            {facts.rule ? ` · ${facts.rule}` : ''} · {facts.updated}
          </span>
        </span>
      </div>
      <div className="setup-shelf__actions">
        <Button size="sm" tone="primary" onClick={onLoad}>
          {t('setup.load')}
        </Button>
        <Button size="sm" onClick={onEdit} title={t('saved.changeTitle')}>
          {t('action.rename')}
        </Button>
        <Button size="sm" tone="ghost" aria-label={`${t('action.rename')}: ${label}`} onClick={onRename}>
          <IconEdit size={14} />
        </Button>
        <Button size="sm" tone="ghost" aria-label={`${t('action.delete')}: ${label}`} onClick={onRemove}>
          <IconTrash size={14} />
        </Button>
      </div>
    </li>
  );
}

/**
 * File the wizard under a shelf label, or update the entry that already owns
 * that label.
 *
 * The label alone decides which entry is written: the server keeps one entry per
 * label, so "update" and "save" are one action with different wording rather than
 * two things for the host to choose between. The dialog says which one is about
 * to happen, because quietly replacing a setup would be worse than asking.
 */
export function SaveSetupDialog({
  /** The shelf entry this label would overwrite, when there is one. */
  clash,
  initialName,
  busy,
  onClose,
  onConfirm,
}: {
  clash: SavedTournamentEntry | null;
  initialName: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (name: string, overwriteId: string | null) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_LABEL;
  const replaces = clash !== null && trimmed.toLowerCase() === clash.name.toLowerCase();
  const canSave = trimmed.length > 0 && !tooLong;
  return (
    <Modal
      title={t('action.save')}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={!canSave}
            onClick={() => onConfirm(trimmed, replaces ? clash.id : null)}
          >
            {replaces ? t('action.replace') : t('action.save')}
          </Button>
        </>
      }
    >
      <div className="stack g3">
        <TextField
          label={t('action.rename')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_LABEL}
          autoFocus
          placeholder={t('saved.labelPlaceholder')}
          hint={t('saved.labelHint')}
          error={tooLong ? t('saved.labelTooLong', { n: MAX_LABEL }) : undefined}
        />
        {replaces ? (
          <div className="setup-callout">
            <strong>{t('saved.updatesTitle', { name: clash.name })}</strong>
            <span>{t('saved.updatesBody')}</span>
          </div>
        ) : (
          <p className="hint">{t('saved.createHintBody')}</p>
        )}
      </div>
    </Modal>
  );
}

function RenameSetupDialog({
  entry,
  busy,
  onClose,
  onConfirm,
}: {
  entry: SavedTournamentEntry;
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(entry.name);
  const trimmed = name.trim();
  const tooLong = trimmed.length > MAX_LABEL;
  const unchanged = trimmed === entry.name;
  return (
    <Modal
      title={t('action.rename')}
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            tone="primary"
            busy={busy}
            disabled={trimmed.length === 0 || tooLong || unchanged}
            onClick={() => onConfirm(trimmed)}
          >
            {t('action.rename')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('action.rename')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={MAX_LABEL}
        autoFocus
        hint={t('saved.renameHint', { name: entry.setup.name })}
        error={tooLong ? t('saved.labelTooLong', { n: MAX_LABEL }) : undefined}
      />
    </Modal>
  );
}