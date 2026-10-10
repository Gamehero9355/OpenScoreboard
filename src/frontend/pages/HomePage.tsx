/**
 * First-run / landing page.
 *
 * The single most important thing on this screen is the address other devices
 * have to open. It is therefore the largest element on the page, it is
 * copyable, and it has a QR code next to it so a phone can join in one scan
 * without anyone typing an IP address.
 */
import { useState } from 'react';
import type { JoinLink } from '../../shared/types';
import { fieldIds, isRealMatch, nameOf } from '../../shared/matchUtils';
import { computeResults } from '../../shared/stats';
import { live } from '../lib/live';
import { useLive, useNow } from '../lib/hooks';
import { useI18n } from '../lib/useI18n';
import { Link, navigate } from '../lib/router';
import { Badge, Button, CopyableUrl, Panel } from '../components/primitives';
import { JoinCard, QrGallery } from '../components/QrPanel';
import { IconBracket, IconQr, IconTrophy, IconUsers, IconWifi, IconWifiOff } from '../components/icons';
import { relativeTime } from '../lib/util';

export function HomePage() {
  const snapshot = useLive();
  const { t } = useI18n();
  const { state, network, links, role } = snapshot;
  const [busy, setBusy] = useState(false);
  const now = useNow(5000);

  const isAdmin = role === 'admin';
  const hasTournament = Boolean(state?.tournament);
  const generalLink = links.find((link) => link.purpose === 'general') ?? links[0] ?? null;
  const address = network?.url ?? window.location.origin;

  const roleName = role === 'admin' ? t('role.admin') : role === 'operator' ? t('role.operator') : t('role.spectator');

  const startDemo = async () => {
    setBusy(true);
    const result = await live.command('system.demo');
    setBusy(false);
    if (result.ok) {
      live.pushToast('success', t('home.demoCreated'));
      navigate('/host');
    } else {
      live.pushToast('error', result.error ?? t('err.generic'));
    }
  };

  const results = state ? computeResults(state) : null;
  // Read the fields rather than the matches: a finished match keeps the field
  // it was played on for the history, so only the field knows what is live now.
  const liveMatches = state
    ? fieldIds(state)
        .map((fieldId) => state.fields[fieldId].matchId)
        .map((matchId) => (matchId ? state.matches[matchId] : null))
        .filter((match): match is NonNullable<typeof match> => Boolean(match))
    : [];
  const playedMatches = state ? Object.values(state.matches).filter((match) => isRealMatch(match)).length : 0;

  return (
    <div className="scroll">
      <div className="shell" style={{ gridTemplateColumns: 'minmax(0, 1fr) 380px' }}>
        <div className="shell__main">
          {network?.status !== 'CONNECTED' ? (
            <p className="banner banner--warn">
              <IconWifiOff size={15} />
              <span>
                <strong>{t('home.noAddress')}</strong> {t('home.noAddressHint')}
              </span>
            </p>
          ) : null}

          <section className="panel">
            <div className="panel__body stack g4">
              <div className="between">
                <div className="stack g1">
                  <span className="tiny dim">{t('settings.network')}</span>
                  <strong style={{ fontSize: 'var(--step-3)' }}>
                    {network?.status === 'CONNECTED' ? t('home.wlanAvailable') : t('home.wlanWaiting')}
                  </strong>
                </div>
                <Badge tone={network?.status === 'CONNECTED' ? 'live' : 'warn'} dot>
                  <IconWifi size={12} />
                  {network?.status === 'CONNECTED' ? t('home.connected') : t('home.noNetwork')}
                </Badge>
              </div>

              <CopyableUrl url={address} label={t('home.copyAddress')} />

              <p className="hint">
                {t('home.addressHint')}{' '}
                <Link to="/settings" className="mono">
                  {t('nav.settingsNetwork')}
                </Link>
                .
              </p>

              <div className="grid-2">
                <div className="stack g2">
                  <span className="tiny dim">{t('home.thisDevice')}</span>
                  <dl className="kv">
                    <dt>{t('settings.roleLabel')}</dt>
                    <dd>{roleName}</dd>
                    <dt>{t('home.connection')}</dt>
                    <dd>{snapshot.connection}</dd>
                    <dt>{t('diag.uptime')}</dt>
                    <dd>{network ? formatUptime(network.uptimeSec) : '—'}</dd>
                  </dl>
                </div>
                <div className="stack g2">
                  <span className="tiny dim">{t('setup.step.name')}</span>
                  <dl className="kv">
                    <dt>{t('setup.name')}</dt>
                    <dd>{state?.tournament?.name ?? t('err.noTournament')}</dd>
                    <dt>{t('results.played')}</dt>
                    <dd>{playedMatches}</dd>
                    <dt>{t('home.onFieldsNow')}</dt>
                    <dd>{liveMatches.length}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </section>

          {hasTournament && results ? (
            <Panel
              title={t('home.currentTournament')}
              actions={
                <>
                  <Button size="sm" onClick={() => navigate('/host')}>
                    {t('nav.host')}
                  </Button>
                  <Button size="sm" onClick={() => window.open('/display', '_blank', 'noopener')}>
                    {t('nav.display')}
                  </Button>
                </>
              }
            >
              <div className="stack g4">
                <div className="grid-3">
                  <Stat label={t('home.status')} value={results.status} />
                  <Stat label={t('results.played')} value={`${results.finishedMatches} / ${results.totalMatches}`} />
                  <Stat label={t('home.pointsScored')} value={String(results.totalPoints)} />
                </div>

                {liveMatches.length > 0 ? (
                  <div className="compact-list" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
                    {liveMatches.map((match) => (
                      <div className="compact-list__row" key={match.id}>
                        <span className="grow">
                          {nameOf(state!, match.participantAId)} <span className="faint">vs</span>{' '}
                          {nameOf(state!, match.participantBId)}
                        </span>
                        <span className="tiny faint">
                          {match.fieldId ? state!.fields[match.fieldId].name : t('home.queued')}
                        </span>
                        <span className="tnum">
                          <strong>{match.scoreA}</strong> : <strong>{match.scoreB}</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hint">
                    {t('home.noLiveMatch')} <Link to="/host">{t('home.dashboard')}</Link>.
                  </p>
                )}

                <div className="btn-row">
                  {state?.radball && state.tournament?.format === 'radball' ? (
                    <Button onClick={() => navigate('/radball')}>
                      <IconTrophy size={14} /> {t('nav.radball')}
                    </Button>
                  ) : (
                    <Button onClick={() => navigate('/bracket')}>
                      <IconBracket size={14} /> {t('nav.bracket')}
                    </Button>
                  )}
                  <Button onClick={() => navigate('/results')}>
                    <IconTrophy size={14} /> {t('nav.results')}
                  </Button>
                  <Button onClick={() => navigate('/setup')}>
                    <IconUsers size={14} /> {t('nav.setup')}
                  </Button>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel title={t('home.startEvent')}>
              <div className="grid-3">
                <button type="button" className="choice" onClick={() => navigate('/setup')} disabled={!isAdmin}>
                  <span className="choice__title">{t('setup.title')}</span>
                  <span className="choice__text">{t('home.choiceNewText')}</span>
                </button>
                <button type="button" className="choice" onClick={() => navigate('/host')}>
                  <span className="choice__title">{t('home.openExisting')}</span>
                  <span className="choice__text">{t('home.openExistingText')}</span>
                </button>
                <button type="button" className="choice" onClick={startDemo} disabled={!isAdmin || busy}>
                  <span className="choice__title">{t('setup.demo')}</span>
                  <span className="choice__text">{t('home.demoText')}</span>
                </button>
              </div>
              {isAdmin ? null : (
                <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
                  {t('home.readOnlyHint')}
                </p>
              )}
            </Panel>
          )}

          <Panel title={t('home.firewallPanel')}>
            <ol className="stack g2 small" style={{ listStyle: 'decimal', paddingLeft: '1.2rem' }}>
              <li>{t('home.firewall1', { app: t('app.name') })}</li>
              <li>{t('home.firewall2')}</li>
              <li>
                {t('home.firewall3')}{' '}
                <Link to="/settings">{t('nav.settingsNetwork')}</Link>.
              </li>
              <li>{t('home.firewall4')}</li>
            </ol>
          </Panel>
        </div>

        <aside className="shell__side">
          <div className="panel__body stack g5">
            {generalLink ? (
              <JoinCard link={generalLink} primary />
            ) : (
              <p className="empty">{t('home.noJoinLink')}</p>
            )}

            <div className="stack g2">
              <div className="between">
                <span className="tiny dim">
                  <IconQr size={12} /> {t('home.moreScreens')}
                </span>
                {isAdmin ? <Badge tone="accent">{t('home.hostOnly')}</Badge> : null}
              </div>
              <p className="hint">{isAdmin ? t('home.fieldCodeHint') : t('home.fieldCodeHintGuest')}</p>
            </div>

            {links.length > 1 ? <QrGallery links={orderedSidebarLinks(links)} max={6} /> : null}

            {network?.allIps && network.allIps.length > 1 ? (
              <div className="stack g2">
                <span className="tiny dim">{t('home.allAddresses')}</span>
                <ul className="stack g1 small">
                  {network.allIps.map((entry) => (
                    <li key={`${entry.iface}-${entry.address}`} className="between">
                      <span className="nowrap dim">{entry.iface}</span>
                      <CopyableUrl url={`http://${entry.address}:${network.port}`} label={t('action.copy')} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {snapshot.lastMessageAt ? (
              <p className="hint">{t('home.lastUpdate', { time: relativeTime(snapshot.lastMessageAt, now) })}</p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stack g1">
      <span className="tiny faint">{label}</span>
      <span style={{ fontSize: 'var(--step-2)', fontWeight: 700 }}>{value}</span>
    </div>
  );
}

/**
 * What a person standing at the desk actually needs: the host control first,
 * then the screens. Each field's operator code lives only on its own dashboard
 * field tab, so it is excluded here to avoid duplicates.
 */
function orderedSidebarLinks(links: { purpose: string }[]): JoinLink[] {
  const rank = (purpose: string): number => {
    if (purpose === 'host') return 50;
    if (purpose === 'display') return 60;
    if (purpose === 'bracket') return 70;
    if (purpose === 'results') return 80;
    return 99;
  };
  return [...(links as JoinLink[])]
    .filter((link) => link.purpose !== 'general' && !link.purpose.startsWith('display-') && !link.purpose.startsWith('field-'))
    .sort((a, b) => rank(a.purpose) - rank(b.purpose));
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
