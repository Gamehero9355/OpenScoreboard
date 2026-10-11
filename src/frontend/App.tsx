import { useEffect, useMemo, useState } from 'react';
import type { FieldId, Role } from '../shared/types';
import { installConnectivityHandlers, live } from './lib/live';
import { resolveAccess, rememberScope } from './lib/token';
import { useLive, useDocumentTitle } from './lib/hooks';
import { useI18n } from './lib/useI18n';
import { tr, type MessageKey } from './lib/i18n';
import { useRoute, navigate, Link } from './lib/router';
import { isTenTeamFormat } from './lib/radball10';
import { cx } from './lib/util';
import { Badge, Button, Toasts, useTournamentStatusLabel } from './components/primitives';
import { IconBracket, IconHome, IconList, IconSettings, IconStandings, IconTeams, IconTrophy, IconUsers, IconLock } from './components/icons';
import { HomePage } from './pages/HomePage';
import { HostPage } from './pages/HostPage';
import { OperatorPage } from './pages/OperatorPage';
import { DisplayPage } from './pages/DisplayPage';
import { BracketPage } from './pages/BracketPage';
import { RadballPage } from './pages/RadballPage';
import { Radball10Page } from './pages/Radball10Page';
import { ResultsPage } from './pages/ResultsPage';
import { StandingsPage } from './pages/StandingsPage';
import { SetupPage } from './pages/SetupPage';
import { TeamsPage } from './pages/TeamsPage';
import { SettingsPage } from './pages/SettingsPage';
import { PrintPage } from './pages/PrintPage';

/** Roles that are allowed to see the control interface. */
const CONTROL_ROLES: Role[] = ['admin'];

export function App() {
  const route = useRoute();
  const snapshot = useLive();
  const { t } = useI18n();
  const statusLabel = useTournamentStatusLabel();
  const [started, setStarted] = useState(false);
  const settings = snapshot.state?.settings;

  /* --- connect once, with the access token this device already has --------- */
  useEffect(() => {
    const access = resolveAccess();
    const readOnly = route.path.startsWith('/display');
    live.connect({
      token: access.token,
      pin: access.pin,
      // Purely informational: the host's developer panel groups connected
      // screens by this label so it is obvious what is attached.
      topic: topicFor(route.path),
      label: deviceLabel(),
      readOnly,
    });
    setStarted(true);
    return installConnectivityHandlers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- remember which role the token turned out to be ---------------------- */
  useEffect(() => {
    if (snapshot.role && snapshot.state) {
      rememberScope(snapshot.role, snapshot.tokenScope);
    }
  }, [snapshot.role, snapshot.tokenScope, snapshot.state]);

  /* --- theme + branding ---------------------------------------------------- */
  useEffect(() => {
    const root = document.documentElement;
    const theme = settings?.theme ?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    root.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('tsb.theme', theme);
    } catch {
      /* ignore */
    }
    if (settings?.primaryColor) root.style.setProperty('--brand', settings.primaryColor);
    if (settings?.accentColor) root.style.setProperty('--accent', settings.accentColor);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', theme === 'light' ? '#eef1f5' : '#0b0d10');
  }, [settings?.theme, settings?.primaryColor, settings?.accentColor]);

  /* --- service worker (production only, so dev reloads stay instant) ------- */
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!('serviceWorker' in navigator)) return;
    // A new build on the host takes over the worker and says so. Without this an
    // already-open screen keeps running the previous bundle out of the service
    // worker's cache -- the host rebuilds, every phone still shows the old UI,
    // and the only cure is a hard refresh nobody thinks to do.
    let reloaded = false;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'tsb:new-build' || reloaded) return;
      reloaded = true;
      // One reload is enough and cannot loop: the page it loads is already the
      // current build, so its worker is the active one and `activate` is over.
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    const id = window.setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }, 1500);
    return () => {
      window.clearTimeout(id);
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, []);

  /**
   * Which page a route renders can depend on the tournament it is showing: the
   * 10-team Radball format has its own page. Derived once, outside the memo.
   *
   * It has to be a dependency of that memo. Reading `snapshot.state` inside it
   * without listing it left the page frozen at whatever the state happened to be
   * on the first paint -- and on a cold load that is `null`, so reloading /radball
   * showed the plain competition page while clicking "Competition" from the
   * dashboard showed the 10-team one. Same URL, different site.
   *
   * The boolean is the key rather than `snapshot.state` itself: state is a new
   * object on every score, so depending on it would throw the memo away on every
   * delta and rebuild the tree with it.
   */
  const tenTeam = isTenTeamFormat(snapshot.state);

  const page = useMemo(() => {
    const [first, second] = route.segments;
    switch (first) {
      case undefined:
        return <HomePage />;
      case 'host':
        return <HostPage />;
      case 'field': {
        const fieldId: FieldId = second && /^[1-9][0-9]*$/.test(second) ? second : '1';
        return <OperatorPage fieldId={fieldId} />;
      }
      case 'display':
        return <DisplayPage view={second && /^[1-9][0-9]*$/.test(second) ? second : 'both'} />;
      case 'bracket':
        return <BracketPage />;
      case 'radball':
        // The 10-team format has its own page: a preliminary round that ends in
        // two frozen tables and a final phase that only exists once the host has
        // confirmed it. Splitting along that line is the only way the "generate
        // the final phase?" question can be asked when it becomes answerable.
        return tenTeam ? <Radball10Page /> : <RadballPage />;
      case 'results':
        // ?bare=1 is what the results QR code encodes. It renders the very same
        // page, but the shell below returns it without the top bar, so a scanned
        // phone shows the results alone instead of a menu above them.
        return <ResultsPage />;
      case 'standings':
        // The official group tables, on their own page. A Radball competition is
        // ranked group by group and ten teams never share a table, so there is no
        // single ranking to show -- which is exactly why this is its own tab and
        // not a panel hanging off Results.
        return <StandingsPage />;
      case 'setup':
        return <SetupPage />;
      case 'teams':
        return <TeamsPage />;
      case 'settings':
        return <SettingsPage />;
      case 'print':
        return <PrintPage kind={second === 'bracket' ? 'bracket' : second === 'history' ? 'history' : 'results'} />;
      default:
        return <NotFound path={route.path} />;
    }
  }, [route.path, route.segments, tenTeam]);

  const isDisplay = route.path.startsWith('/display') || route.path.startsWith('/field') || route.path.startsWith('/print');
  const isOperator = route.path.startsWith('/field');
  // The results page asked for on its own: same content, no top bar. The page's
  // own header stays, because that is the result -- the navigation above it is
  // what a scanned phone does not need.
  const isBareResults = route.path.startsWith('/results') && route.query.get('bare') === '1';

  useDocumentTitle(titleFor(route.path, snapshot.state?.tournament?.name ?? t('app.name'), t));

  if (!started) {
    return <div className="empty">{t('app.starting')}</div>;
  }

  if (isOperator || route.path.startsWith('/print')) {
    return (
      <>
        {page}
        <Toasts />
      </>
    );
  }

  if (isDisplay) {
    return (
      <>
        {page}
        <Toasts />
      </>
    );
  }

  if (isBareResults) {
    return (
      <div className="bare">
        <main className="page">{page}</main>
        <Toasts />
      </div>
    );
  }

  const canControl = CONTROL_ROLES.includes(snapshot.role) || snapshot.role === 'operator';
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img className="brand__mark" src="/favicon.svg" alt="" width={26} height={26} />
          <span className="brand__text">
            <span className="brand__title">{settings?.tournamentName ?? t('app.name')}</span>
            <span className="brand__sub">
              {snapshot.state?.tournament
                ? `${snapshot.state.tournament.name} · ${statusLabel(snapshot.state.tournament.status)}`
                : t('err.noTournament')}
            </span>
          </span>
        </Link>

        <nav className="nav" aria-label={t('a11y.mainNav')}>
          <NavItem to="/" label={t('nav.home')} icon={<IconHome size={14} />} current={route.path} />
          <NavItem to="/host" label={t('nav.host')} icon={<IconList size={14} />} current={route.path} />
          {snapshot.state?.tournament?.format === 'radball' ? (
            <NavItem to="/radball" label={t('nav.radball')} icon={<IconTrophy size={14} />} current={route.path} />
          ) : (
            <NavItem to="/bracket" label={t('nav.bracket')} icon={<IconBracket size={14} />} current={route.path} />
          )}
          <NavItem to="/results" label={t('nav.results')} icon={<IconTrophy size={14} />} current={route.path} />
          {/* Only Radball has standings: a knockout is ranked by its bracket, and
              offering a tab that can only ever say "nothing here" trains people to
              stop reading the bar. */}
          {snapshot.state?.tournament?.format === 'radball' ? (
            <NavItem to="/standings" label={t('nav.standings')} icon={<IconStandings size={14} />} current={route.path} />
          ) : null}
          <NavItem to="/setup" label={t('nav.setup')} icon={<IconUsers size={14} />} current={route.path} />
          <NavItem to="/teams" label={t('nav.teams')} icon={<IconTeams size={14} />} current={route.path} />
          <NavItem to="/settings" label={t('nav.settings')} icon={<IconSettings size={14} />} current={route.path} />
        </nav>

        <span className="topbar__spacer" />

        <div className="row g2">
          {canControl ? (
            <Button size="sm" tone="ghost" onClick={() => window.open('/display', '_blank', 'noopener')}>
              {t('nav.display')}
            </Button>
          ) : (
            <Badge tone="danger">
              <IconLock size={11} /> {t('role.spectator')}
            </Badge>
          )}
        </div>
      </header>

      <main className="page">{page}</main>

      <Toasts />
    </div>
  );
}

function NavItem({
  to,
  label,
  icon,
  current,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  current: string;
}) {
  const active = to === '/' ? current === '/' : current.startsWith(to);
  return (
    <Link to={to} className={cx('nav__item')} aria-current={active ? 'page' : undefined} aria-label={label} title={label}>
      {icon}
      <span className="nav__label">{label}</span>
    </Link>
  );
}

/** The browser tab title. Takes `t()` because it runs outside any component. */
function titleFor(path: string, tournament: string, t: (key: MessageKey) => string): string {
  if (path.startsWith('/host')) return `${t('nav.host')} · ${tournament}`;
  if (path.startsWith('/display')) return `${t('nav.display')} · ${tournament}`;
  if (path.startsWith('/field')) return `${t('nav.field')} · ${tournament}`;
  if (path.startsWith('/radball')) return `${t('nav.radball')} · ${tournament}`;
  if (path.startsWith('/bracket')) return `${t('nav.bracket')} · ${tournament}`;
  if (path.startsWith('/results')) return `${t('nav.results')} · ${tournament}`;
  if (path.startsWith('/standings')) return `${t('nav.standings')} · ${tournament}`;
  if (path.startsWith('/settings')) return `${t('settings.title')} · ${t('app.name')}`;
  if (path.startsWith('/setup')) return `${t('nav.setup')} · ${t('app.name')}`;
  if (path.startsWith('/teams')) return `${t('team.title')} · ${t('app.name')}`;
  return tournament;
}

function NotFound({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <div className="empty stack g3" style={{ margin: 'auto' }}>
      <p>
        There is no page at <span className="mono">{path}</span>.
      </p>
      <Button tone="primary" onClick={() => navigate('/')}>
        {t('action.back')}
      </Button>
    </div>
  );
}

function topicFor(path: string): string {
  if (path.startsWith('/display')) return 'display';
  const fieldMatch = /^\/field\/([1-9][0-9]*)/.exec(path);
  if (fieldMatch) return `field:${fieldMatch[1]}`;
  if (path.startsWith('/field')) return 'field:1';
  if (path.startsWith('/host')) return 'host';
  if (path.startsWith('/radball')) return 'radball';
  if (path.startsWith('/bracket')) return 'bracket';
  if (path.startsWith('/results')) return 'results';
  if (path.startsWith('/standings')) return 'standings';
  if (path.startsWith('/teams')) return 'teams';
  if (path.startsWith('/print')) return 'print';
  return 'app';
}

function deviceLabel(): string {
  const agent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(agent);
  if (/iPad|Tablet/i.test(agent)) return tr('device.tablet');
  if (mobile) return tr('device.phone');
  if (/Windows/i.test(agent)) return tr('device.windows');
  if (/Macintosh/i.test(agent)) return tr('device.mac');
  if (/Linux/i.test(agent)) return tr('device.linux');
  return tr('device.browser');
}
