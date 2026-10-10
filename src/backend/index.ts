/**
 * Bootstrap. Everything the host PC runs lives behind `startServer()`: the
 * embedded database, the tournament engine, the WebSocket hub, the HTTP/static
 * server, LAN discovery and the backup loop. `npm start` and the Electron shell
 * both call the same function, so there is exactly one way to run the app.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../shared/types';
import type { NetworkInfo, PublicState, Settings, TournamentState } from '../shared/types';
import { AccessControl, type SessionScope } from './auth/access';
import { buildNetworkInfo } from './net/interfaces';
import { allLinks, publicLinks, type LinkContext } from './net/links';
import { startMdns, type MdnsHandle } from './net/mdns';
import { TournamentStore, APP_VERSION } from './store/store';
import { WsHub } from './network/hub';
import type { DispatchDeps } from './network/dispatch';
import { createHttpServer } from './http/server';
import { resolveLogoFolder } from './net/logos';
import { buildDemoTournament, buildRadball10Demo, buildRadballDemo } from './tournament/demo';
import { createLogger, installProcessLogCapture } from './util/log';
import type { Ctx, Mutation } from './tournament/state';

/** Which demo a `--demo` start builds. */
export type DemoKind = 'knockout' | 'radball' | 'radball10';

export function buildDemo(kind: DemoKind) {
  if (kind === 'radball10') return buildRadball10Demo;
  if (kind === 'radball') return buildRadballDemo;
  return buildDemoTournament;
}

export interface StartOptions {
  port?: number;
  dataDir?: string;
  host?: string;
  clientDir?: string;
  mdnsName?: string;
  /** Where team logos are kept. Defaults to a `logos` folder beside the app. */
  logoDir?: string;
  /** Build and assign the demo tournament on start. */
  demo?: boolean;
  /**
   * Which demo to build: `knockout` (single elimination), `radball` (the BDR
   * five-team preset) or `radball10` (the documented ten-team World Cup shape).
   */
  demoKind?: DemoKind;
  /** Open the system browser at the local URL. */
  open?: boolean;
  /** Try the next free port when the requested one is taken. */
  autoPort?: boolean;
  quiet?: boolean;
  /** Called once the server is listening (used by the Electron shell). */
  onReady?: (info: ReadyInfo) => void;
}

export interface ReadyInfo {
  port: number;
  url: string;
  network: NetworkInfo;
  adminUrl: string;
  mdnsHostname: string | null;
  driver: string;
}

export interface RunningServer {
  port: number;
  url: string;
  adminUrl: string;
  network: () => NetworkInfo;
  store: TournamentStore;
  hub: WsHub;
  httpServer: Server;
  ready: ReadyInfo;
  close: () => Promise<void>;
}

const MAX_BACKUPS = 20;

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  // Registered before anything is constructed so a failure during start-up is
  // captured too. The callback flushes the store, because the crash that
  // triggered it may have been a persistence failure.
  let fatalFlush: (() => Promise<void>) | null = null;
  installProcessLogCapture(() => {
    void fatalFlush?.().catch(() => undefined);
  });
  const log = createLogger('server');
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const clientDir = resolve(options.clientDir ?? defaultClientDir());
  const mdnsName = options.mdnsName ?? 'tournament-scoreboard';
  const logoFolder = await resolveLogoFolder(
    options.logoDir
      ? [options.logoDir]
      : [
          // Beside the built client in a packaged install, then the project root
          // when running from source or `npm start`.
          join(clientDir, '..', '..', 'logos'),
          join(process.cwd(), 'logos'),
        ],
  );

  await mkdir(join(dataDir, 'backups'), { recursive: true });

  const store = await TournamentStore.open(dataDir);
  const access = new AccessControl(dataDir);
  await access.load();
  store.state.settings.port = options.port ?? store.state.settings.port ?? 3000;
  store.state.settings.operatorPinSet = access.pinSet;
  if (options.host) store.state.settings.advertisedHost = options.host;

  const linkContext = (): LinkContext => ({
    network: network(),
    access,
    settings: store.state.settings,
    pinRequired: access.pinSet,
  });

  let cachedNetwork: NetworkInfo = buildNetworkInfo({
    port: options.port ?? 3000,
    preferredHost: store.state.settings.advertisedHost,
    mdnsName,
    serverStartedAt: Date.now(),
    driver: store.adapterNote,
  });

  const network = (): NetworkInfo => {
    // The port only changes after a restart, so refresh just the volatile bits.
    const rebuilt = buildNetworkInfo({
      port: actualPort,
      preferredHost: store.state.settings.advertisedHost,
      mdnsName,
      serverStartedAt: cachedNetwork.serverStartedAt,
      driver: store.adapterNote,
    });
    cachedNetwork = rebuilt;
    return rebuilt;
  };

  let actualPort = options.port ?? store.state.settings.port ?? 3000;

  const deps: DispatchDeps = {
    store,
    access,
    onSettingsChanged: (settings: Settings) => {
      store.state.settings.port = settings.port;
    },
    createBackupFile,
    startDemo: (state: TournamentState, ctx: Ctx, mut: Mutation) => {
      buildDemo(options.demoKind ?? 'knockout')(state, ctx, mut);
    },
  };

  const hub = new WsHub({
    store,
    access,
    deps,
    network,
    // The host sees the public join links *and* the control links; everybody
    // else only ever sees links that cannot change a score.
    publicState: (scope: SessionScope): PublicState => ({
      protocol: PROTOCOL_VERSION,
      state: { ...store.state, events: store.state.events.slice(-60) },
      network: network(),
      links: scope.role === 'admin' ? allLinks(linkContext()) : publicLinks(linkContext()),
      role: scope.role,
      tokenScope: scope.fieldId,
    }),
    log: (message) => log.info(message),
  });

  // The single wire between the tournament engine and every connected screen:
  // one subscription, deltas only, no polling anywhere.
  store.subscribe((delta, mut) => hub.broadcastDelta(delta, mut));

  // Fresh field QR codes on tournament creation have to reach every screen.
  deps.resyncAll = () => hub.forceResync();
  deps.invalidateOperatorSessions = () => hub.invalidateOperatorSessions();

  store.clientCounter = () => hub.clientStats();

  const { app } = createHttpServer({
    store,
    access,
    hub,
    clientDir,
    dataDir,
    logoFolder,
    getNetwork: network,
    linkContext,
    createBackupFile,
    restoreFromDocument: async (document: unknown) => {
      const state = TournamentStore.parseBackup(document);
      await store.restore(state);
      log.info('tournament restored from a backup document');
    },
    port: () => actualPort,
    log: (message) => log.warn(message),
  });

  const httpServer = createServer(app);
  hub.attach(httpServer, '/ws');

  const port = await listenWithFallback(httpServer, actualPort, options.autoPort !== false);
  actualPort = port;
  store.state.settings.port = port;
  cachedNetwork = network();

  const mdns: MdnsHandle | null = cachedNetwork.primaryIp
    ? startMdns(mdnsName, cachedNetwork.primaryIp, (message) => log.warn(message))
    : null;

  const stopBackups = scheduleBackups(store, log, createBackupFile);
  const timerScheduler = setInterval(() => store.advanceTimers(), 500);
  timerScheduler.unref();

  const localUrl = `http://127.0.0.1:${port}`;
  const adminUrl = `${localUrl}/host#t=${access.adminToken}`;
  const ready: ReadyInfo = {
    port,
    url: localUrl,
    network: cachedNetwork,
    adminUrl,
    mdnsHostname: mdns?.hostname ?? null,
    driver: store.adapterNote,
  };

  if (options.demo && !store.state.tournament) {
    const build = buildDemo(options.demoKind ?? 'knockout');
    store.apply(
      (state, ctx, mut) => {
        build(state, ctx, mut);
      },
      store.createContext('Demo', 'admin', null),
    );
  }

  if (!options.quiet) printBanner(ready, store, access.adminToken);

  if (options.open) openBrowser(adminUrl);

  options.onReady?.(ready);

  let closed = false;
  fatalFlush = () => store.flush();
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopBackups();
    clearInterval(timerScheduler);
    mdns?.stop();
    hub.shutdown();
    await store.flush();
    await store.adapter.close();
    await new Promise<void>((done) => httpServer.close(() => done()));
  };

  const shutdown = (signal: string) => {
    log.info(`${signal} received -- saving and shutting down`);
    void close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('beforeExit', () => {
    void store.flush();
  });

  async function createBackupFile(kind: 'manual' | 'auto' | 'pre-restore'): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const prefix = kind === 'auto' ? 'auto-backup' : kind === 'pre-restore' ? 'before-restore' : 'tournament-backup';
    const file = join(dataDir, 'backups', `${prefix}-${stamp}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(store.createBackup(), null, 2), 'utf8');
    log.info(`${kind} backup written to ${file}`);
    await pruneBackups(dataDir, log);
    return file;
  }

  return {
    port,
    url: localUrl,
    adminUrl,
    network,
    store,
    hub,
    httpServer,
    ready,
    close,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function defaultDataDir(): string {
  return process.env.TOURNAMENT_DATA_DIR ?? join(process.cwd(), 'data');
}

function defaultClientDir(): string {
  const candidates = [
    join(__dirname, '..', 'client'),
    join(process.cwd(), 'dist', 'client'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0] ?? join(process.cwd(), 'dist', 'client');
}

/**
 * Bind the server. Port 0 means "any free port", which the tests use and which
 * also makes the auto-port fallback reliable. The port that was actually bound
 * is read back from the socket rather than assumed.
 */
async function listenWithFallback(server: Server, port: number, autoPort: boolean): Promise<number> {
  if (port === 0) {
    if (await tryListen(server, 0)) return boundPort(server);
    throw new Error('Could not bind to an ephemeral port.');
  }
  const attempts = autoPort ? 12 : 1;
  let candidate = port;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await tryListen(server, candidate)) return boundPort(server);
    candidate += 1;
  }
  throw new Error(
    `Ports ${port}-${candidate - 1} are all in use. Start with --port <n> to choose another one.`,
  );
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address && typeof address === 'object') return address.port;
  return 0;
}

function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((done) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      done(false);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      done(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

export const MAX_BACKUP_FILES = MAX_BACKUPS;

/**
 * Keep only the newest backups.
 *
 * Sorted by modification time rather than by file name: the three prefixes sort
 * lexicographically into separate blocks, so name order would always delete the
 * automatic backups first and keep stale manual ones from an earlier event. A
 * safety net that is pruned before the snapshots it protects is not a safety net.
 *
 * Exported so the retention policy can be tested directly -- it is the one piece
 * of housekeeping that, when broken, fills the disk without ever announcing it.
 */
export async function pruneBackups(
  dataDir: string,
  log: { info: (message: string) => void } = { info: () => undefined },
): Promise<void> {
  const dir = join(dataDir, 'backups');
  try {
    const names = await readdir(dir);
    const stamped = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const info = await stat(join(dir, name));
            return { name, writtenAt: info.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    const files = stamped.filter((entry): entry is { name: string; writtenAt: number } => entry !== null);
    files.sort((a, b) => b.writtenAt - a.writtenAt);
    for (let i = MAX_BACKUPS; i < files.length; i += 1) {
      const entry = files[i];
      if (!entry) continue;
      try {
        await unlink(join(dir, entry.name));
        log.info(`removed old backup ${entry.name}`);
      } catch {
        /* locked or already gone; the next pass will try again */
      }
    }
  } catch {
    /* backups are best effort */
  }
}

function scheduleBackups(
  store: TournamentStore,
  log: { info: (message: string) => void },
  writeBackup: (kind: 'manual' | 'auto' | 'pre-restore') => Promise<string>,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const minutes = Math.max(1, store.state.settings.autoBackupIntervalMin || 15);
    timer = setInterval(() => {
      if (!store.state.settings.autoBackupEnabled) return;
      if (!store.state.tournament) return;
      // Go through the same helper the manual button uses, which also rotates
      // the directory. Writing scheduled backups directly is what let them
      // accumulate without bound.
      void writeBackup('auto').catch((error: unknown) => {
        log.info(`automatic backup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, minutes * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  return () => {
    if (timer) clearInterval(timer);
  };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* opening a browser is optional */
  }
}

function printBanner(ready: ReadyInfo, store: TournamentStore, adminToken: string): void {
  const network = ready.network;
  const lines: string[] = [];
  lines.push('');
  lines.push('  TOURNAMENT SCOREBOARD');
  lines.push(`  v${APP_VERSION} · storage: ${store.adapterNote}`);
  lines.push('');
  if (network.status === 'CONNECTED') {
    lines.push('  LOCAL NETWORK AVAILABLE');
    lines.push(`    ${network.url}`);
  } else if (network.status === 'LOOPBACK_ONLY') {
    lines.push('  NO LAN ADDRESS FOUND — only this PC can connect');
    lines.push(`    ${ready.url}`);
  } else {
    lines.push('  NO NETWORK CONNECTION');
  }
  if (ready.mdnsHostname) lines.push(`    http://${ready.mdnsHostname}:${ready.port}  (if mDNS is available)`);
  lines.push('');
  lines.push('  Host dashboard');
  lines.push(`    ${ready.adminUrl}`);
  lines.push('');
  lines.push('  Admin token (keep private)');
  lines.push(`    ${adminToken}`);
  lines.push('');
  lines.push('  Scan the QR code in the host dashboard to connect phones.');
  lines.push('  Windows Firewall: allow this app on PRIVATE networks.');
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): StartOptions {
  const options: StartOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
      case '-p':
        options.port = Number(argv[++i]);
        break;
      case '--data-dir':
        options.dataDir = argv[++i];
        break;
      case '--client-dir':
        options.clientDir = argv[++i];
        break;
      case '--logo-dir':
        options.logoDir = argv[++i];
        break;
      case '--mdns':
        options.mdnsName = argv[++i];
        break;
      case '--host':
        options.host = argv[++i];
        break;
      case '--demo':
        options.demo = true;
        break;
      case '--demo-kind': {
        const kind = argv[++i];
        if (kind !== 'knockout' && kind !== 'radball' && kind !== 'radball10') {
          console.error(`--demo-kind must be knockout, radball or radball10 (got ${kind})`);
          process.exitCode = 1;
          break;
        }
        options.demo = true;
        options.demoKind = kind;
        break;
      }
      case '--open':
        options.open = true;
        break;
      case '--no-auto-port':
        options.autoPort = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return options;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Tournament Scoreboard ${APP_VERSION}

Usage: node dist/server/backend/index.js [options]

  --port, -p <n>      Port to listen on (default 3000, falls back to the next free port)
  --data-dir <path>   Where the database and backups live (default ./data)
  --client-dir <path> Where the built web interface lives (default ./dist/client)
  --mdns <name>       mDNS hostname (default tournament-scoreboard)
  --demo              Start with a ready-to-play demo tournament
  --demo-kind <kind>  Which demo: knockout (default), radball, radball10
  --open              Open the host dashboard in the default browser
  --no-auto-port      Fail instead of trying the next port when the port is busy
  --help, -h          Show this help
`);
}

const isDirectRun =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;

if (isDirectRun) {
  startServer(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`\nCould not start the Tournament Scoreboard server:\n  ${message}\n`);
    process.exit(1);
  });
}
