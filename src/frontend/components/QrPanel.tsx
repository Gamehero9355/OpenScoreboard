/**
 * QR codes are rendered by the host on demand (`/api/qr`) so a phone can scan
 * them with the camera app and land straight on the right page -- no app, no
 * app store, no internet.
 */
import { useState } from 'react';
import type { JoinLink } from '../../shared/types';
import { useI18n } from '../lib/useI18n';
import { Badge, Button, CopyableUrl } from './primitives';
import { IconLock } from './icons';
import { cx } from '../lib/util';

export function QrCode({
  text,
  size = 320,
  compact,
  alt,
}: {
  text: string;
  size?: number;
  compact?: boolean;
  alt: string;
}) {
  return (
    <div className={cx('qr', compact && 'qr--compact')}>
      <img
        src={`/api/qr?text=${encodeURIComponent(text)}&size=${size}`}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

export function QrTile({
  link,
  onCopy,
  compact,
}: {
  link: JoinLink;
  onCopy?: (url: string) => void;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const shown = link.token ? `${link.url.replace(/#t=.*$/, '')}` : link.url;
  return (
    <div className="stack g2 qr-tile" style={{ alignItems: 'stretch' }}>
      <div className="row g2 between qr-tile__head">
        <strong>{link.label}</strong>
        {link.adminOnly ? (
          <Badge tone="danger" title={t('qr.hostOnlyHint')}>
            <IconLock size={11} /> {t('home.hostOnly')}
          </Badge>
        ) : null}
        {link.requiresPin ? <Badge tone="accent">{t('dialog.pin')}</Badge> : null}
      </div>
      <QrCode text={link.url} compact={compact} alt={t('qr.alt', { label: link.label })} />
      <p className="hint">{link.description}</p>
      <CopyableUrl
        url={shown}
        label={copied ? t('fc.copied') : t('fc.copyLink')}
        onCopied={(ok) => {
          setCopied(ok);
          if (ok) onCopy?.(shown);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      />
    </div>
  );
}

export function JoinCard({
  link,
  primary,
}: {
  link: JoinLink;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <div className="stack g3">
      <div className="row g2 between">
        <span className="tiny dim">{primary ? t('dialog.qr') : link.label}</span>
        {link.adminOnly ? (
          <Badge tone="danger">
            <IconLock size={11} /> {t('home.hostOnly')}
          </Badge>
        ) : null}
      </div>
      <QrCode text={link.url} alt={t('qr.alt', { label: link.label })} />
      <div className="stack g1">
        <span className="tiny faint">{primary ? t('qr.openOnPhone') : link.description}</span>
        <CopyableUrl
          url={link.token ? link.url.replace(/#t=.*$/, '') : link.url}
          label={copied ? t('fc.copied') : t('action.copy')}
          onCopied={(ok) => {
            setCopied(ok);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        />
      </div>
    </div>
  );
}

export function QrGallery({ links, max }: { links: JoinLink[]; max?: number }) {
  const shown = max ? links.slice(0, max) : links;
  return (
    <div className="qr-grid">
      {shown.map((link) => (
        <QrTile key={link.purpose} link={link} compact />
      ))}
    </div>
  );
}

export function PrintLinkRow({ links }: { links: JoinLink[] }) {
  return (
    <div className="btn-row">
      {links.map((link) => (
        <Button
          key={link.purpose}
          size="sm"
          onClick={() => window.open(link.url.replace(/#t=.*$/, ''), '_blank', 'noopener')}
        >
          Open {link.label}
        </Button>
      ))}
    </div>
  );
}
