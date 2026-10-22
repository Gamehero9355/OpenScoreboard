/**
 * HTTP layer.
 *
 * Same authorisation rules as the WebSocket channel: everything reads through
 * `resolveScope`, and no endpoint trusts a client-supplied role. Host-only
 * endpoints are reachable from the host PC (loopback) or with the admin token
 * from the admin QR link.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { PublicState, JoinLink, SystemStatus } from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/types';
import { backupFilename, eventsCsv, matchesCsv, participantsCsv, resultsCsv, tournamentJson } from '../../shared/exports';
import { isLoopback, type AccessControl, type SessionScope } from '../auth/access';
import type { TournamentStore } from '../store/store';
import { recentLogs } from '../util/log';
import { createHttpLimiters, rateLimitMiddleware } from './ratelimit';
import { qrPngDataUrl, qrSvg } from '../net/qr';
import { adminLinks, allLinks, publicLinks, type LinkContext } from '../net/links';
import { listLogos, readLogo, type LogoFolder } from '../net/logos';
import type { WsHub } from '../network/hub';
import { APP_VERSION } from '../store/store';

const CLIENT_EVENT_LIMIT = 60;

export interface HttpOptions {
  store: TournamentStore;
  access: AccessControl;
  hub: WsHub;
clientDir: string;
  dataDir: string;
  /** The host's folder of team crests, and whether it is there. */
  logoFolder: LogoFolder;
  getNetwork: () => PublicState['network'];
  linkContext: () => LinkContext;
  createBackupFile: (kind: 'manual' | 'auto' | 'pre-restore') => Promise<string>;
  restoreFromDocument: (document: unknown) => Promise<void>;
  port: () => number;
  log: (message: string) => void;
}

export interface HttpHandle {
  app: Express;
  /** Resolve the scope for any request; reused by the WebSocket upgrade too. */
  scopeFor: (request: Request) => SessionScope;
}

export function createHttpServer(options: HttpOptions): HttpHandle {
  const { store, access, hub } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  // Rate limiting is mounted before the body parser on purpose. `express.json`
  // reads the whole request into memory and parses it, so a 12 MB body costs
  // real CPU on an event loop shared with every WebSocket, the timer anchors and
  // the persistence writes -- refusing on headers alone means a flood or an
  // oversized body never gets that far.
  const limiters = createHttpLimiters();
  app.use(rateLimitMiddleware(limiters.check));
  app.use(express.json({ limit: '12mb' }));

  /**
   * Cross-site request defence.
   *
   * Loopback requests are granted admin without a token, which is the whole
   * point on the host PC -- but it also means any page open in a browser on the
   * host PC could reach a mutating endpoint with a plain HTML form, because a
   * form post is a "simple" request that needs no preflight. Three independent
   * checks close that: browsers label cross-site fetches, they send an Origin
   * (or Referer) that has to match a hostname we actually answer on, and a form
   * cannot set `Content-Type: application/json` without a preflight.
   *
   * The hostname list is derived from `getNetwork()`, so it cannot go stale: it
   * holds exactly the addresses the join links and the QR codes advertise. It is
   * rebuilt per request rather than cached because a machine that is still
   * enumerating its interfaces gets its address a second after startup, and a
   * phone that was handed that address must not be refused.
   *
   * Deliberately permissive when *neither* Origin nor Referer is present: those
   * requests do not come from a browser page, so the tests and any scripted
   * administration keep working.
   */
  const allowedHosts = (): Set<string> => {
    const network = options.getNetwork();
    const hosts = new Set<string>(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1', '::']);
    if (network.mdnsName) hosts.add(network.mdnsName.toLowerCase());
    if (network.hostname) hosts.add(network.hostname.toLowerCase());
    if (network.primaryIp) hosts.add(network.primaryIp);
    for (const candidate of network.allIps) hosts.add(candidate.address);
    return hosts;
  };

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!isUnsafeMethod(request.method)) {
      next();
      return;
    }
    if (!request.path.startsWith('/api/')) {
      next();
      return;
    }
    if (crossSite(request, allowedHosts(), options.port())) {
      response
        .status(403)
        .json({ ok: false, code: 'FORBIDDEN', error: 'Cross-site requests are not accepted here.' });
      return;
    }
    next();
  });

  const scopeFor = (request: Request): SessionScope => {
    const headerToken = stringHeader(request.headers['x-token']);
    const queryToken = typeof request.query.token === 'string' ? request.query.token : null;
    const token = headerToken ?? queryToken;
    const resolved = access.resolveToken(token);
    // `?readonly=1` is a downgrade-only hint used by the display pages so a TV
    // browser on the host PC can never be granted control.
    const readOnly = request.query.readonly === '1' || request.query.readonly === 'true';
    if (readOnly) return access.spectator();
    if (resolved) return resolved;
    const remote = request.socket.remoteAddress;
    if (isLoopback(remote)) return access.adminFromLoopback();
    return access.spectator();
  };

  const requireAdmin = (request: Request, response: Response, next: NextFunction): void => {
    const scope = scopeFor(request);
    if (scope.role !== 'admin') {
      response.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'The host interface is required for this action.' });
      return;
    }
    (request as Request & { scope?: SessionScope }).scope = scope;
    next();
  };

  const publicState = (scope: SessionScope): PublicState => {
    const events = store.state.events.slice(-CLIENT_EVENT_LIMIT);
    return {
      protocol: PROTOCOL_VERSION,
      state: { ...store.state, events },
      network: options.getNetwork(),
      links: scope.role === 'admin' ? allLinks(options.linkContext()) : publicLinks(options.linkContext()),
      role: scope.role,
      tokenScope: scope.fieldId,
    };
  };

  /* ---------------- health & state ---------------- */

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      app: 'tournament-scoreboard',
      version: APP_VERSION,
      uptimeSec: store.uptimeSec(),
      clients: hub.clientStats().total,
    });
  });

  app.get('/api/state', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(publicState(scopeFor(request)));
  });

  app.get('/api/network', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(options.getNetwork());
  });

  app.get('/api/system', requireAdmin, (_request, response) => {
    const status: SystemStatus = store.systemStatus();
    status.clients = hub.clientStats().total;
    status.clientsByTopic = hub.clientStats().byTopic;
    status.messageCount = hub.messageCount;
    response.json(status);
  });

  app.get('/api/logs', requireAdmin, (request, response) => {
    const limit = Math.min(400, Math.max(10, Number(request.query.limit ?? 150) || 150));
    response.json({ lines: recentLogs(limit) });
  });

  app.get('/api/links', requireAdmin, (_request, response) => {
    const context = options.linkContext();
    const links: JoinLink[] = adminLinks(context);
    response.json({ links });
  });

  app.get('/api/history', requireAdmin, asyncRoute(async (request, response) => {
    const limit = Math.min(2000, Math.max(10, Number(request.query.limit ?? 400) || 400));
    const events = await store.adapter.loadEvents(limit);
    response.json({ events });
  }));

  /* ---------------- QR codes ---------------- */

  app.get('/api/qr', asyncRoute(async (request, response) => {
    const text = typeof request.query.text === 'string' ? request.query.text.slice(0, 300) : '';
    if (!text) {
      response.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'text is required' });
      return;
    }
    const size = Math.min(1024, Math.max(96, Number(request.query.size ?? 512) || 512));
    const format = request.query.format === 'svg' ? 'svg' : 'png';
    try {
      if (format === 'svg') {
        const svg = await qrSvg(text, { margin: 1 });
        response.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400').send(svg);
        return;
      }
      const dataUrl = await qrPngDataUrl(text, size, { margin: 1 });
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      response
        .type('image/png')
        .setHeader('Cache-Control', 'public, max-age=86400')
        .send(Buffer.from(base64, 'base64'));
    } catch {
      response.status(500).json({ ok: false, code: 'INTERNAL', error: 'Could not render that QR code.' });
    }
  }));

/* ---------------- team logos ---------------- */

  /**
   * What is in the host's logos folder.
   *
   * Read by the team library's picker and readable by a spectator: the crests
   * are on every screen, so the list is public. The folder path is included
   * because the only way to add a crest is to put a file in it, and a host who
   * cannot find the folder will conclude the feature is broken.
   */
  app.get('/api/logos', asyncRoute(async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await listLogos(options.logoFolder));
  }));

  // The image bytes. Public for the same reason, and `readLogo` only ever serves
  // a name it would itself have listed, so this cannot become a file reader.
  app.get('/logos/:file', asyncRoute(async (request, response) => {
    const logo = await readLogo(options.logoFolder, String(request.params.file ?? ''));
    if (!logo) {
      response.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'That logo is not in the folder.' });
      return;
    }
    response
      .type(logo.contentType)
      // A crest is host-owned and can be replaced in place under the same name,
      // so it is revalidated rather than pinned for a day.
      .setHeader('Cache-Control', 'public, max-age=300')
      // An SVG opened directly must not be able to run anything.
      .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(logo.body);
  }));

  /* ---------------- exports ---------------- */

  app.get('/api/export/results.csv', (_request, response) => {
    sendCsv(response, resultsCsv(store.state), 'results.csv');
  });
  app.get('/api/export/matches.csv', (_request, response) => {
    sendCsv(response, matchesCsv(store.state), 'match-history.csv');
  });
  app.get('/api/export/participants.csv', (_request, response) => {
    sendCsv(response, participantsCsv(store.state), 'participants.csv');
  });
  app.get('/api/export/events.csv', requireAdmin, (_request, response) => {
    const events = [...store.state.events].reverse();
    sendCsv(response, eventsCsv(events), 'event-history.csv');
  });
  app.get('/api/export/tournament.json', requireAdmin, (_request, response) => {
    response
      .type('application/json')
      .setHeader('Content-Disposition', `attachment; filename="${backupFilename('tournament-export')}"`)
      .send(tournamentJson(store.state));
  });

  /* ---------------- backup & restore ---------------- */

  app.get('/api/backup', requireAdmin, (_request, response) => {
    response
      .type('application/json')
      .setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`)
      .send(JSON.stringify(store.createBackup(), null, 2));
  });

  app.post('/api/backup', requireAdmin, asyncRoute(async (_request, response) => {
    const file = await options.createBackupFile('manual');
    response.json({ ok: true, file });
  }));

  app.post('/api/restore', requireAdmin, asyncRoute(async (request, response) => {
    try {
      await options.createBackupFile('pre-restore');
      await options.restoreFromDocument(request.body);
      hub.forceResync();
      response.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The file could not be read.';
      response.status(400).json({ ok: false, code: 'BAD_REQUEST', error: message });
    }
  }));

  app.post('/api/prune', requireAdmin, asyncRoute(async (_request, response) => {
    const removed = await store.pruneEventLog();
    response.json({ ok: true, removed });
  }));

  /**
   * Re-issue a control token. Used when a tablet is handed to another person or
   * a printed QR code goes missing; every client is resynced so the old link is
   * replaced everywhere at once.
   */
  app.post('/api/access/rotate', requireAdmin, asyncRoute(async (request, response) => {
    const kind = typeof request.body?.kind === 'string' ? request.body.kind : '';
    if (kind === 'admin') {
      const token = await access.rotateAdminToken();
      hub.forceResync();
      response.json({ ok: true, kind, token });
      return;
    }
    const fieldMatch = /^field-([1-9][0-9]*)$/.exec(kind);
    const fieldId = fieldMatch?.[1];
    if (fieldId) {
      if (!store.state.fields[fieldId]) {
        response
          .status(400)
          .json({ ok: false, code: 'BAD_REQUEST', error: 'That playing field does not exist.' });
        return;
      }
      const token = await access.rotateOperatorToken(fieldId);
      hub.forceResync();
      response.json({ ok: true, kind, token });
      return;
    }
    response
      .status(400)
      .json({ ok: false, code: 'BAD_REQUEST', error: 'kind must be admin or field-N (e.g. field-1)' });
  }));

  /* ---------------- static client ---------------- */

  const indexHtml = join(options.clientDir, 'index.html');
  const hasClient = existsSync(indexHtml);
  if (hasClient) {
    app.use(
      express.static(options.clientDir, {
        index: false,
        etag: true,
        maxAge: '7d',
        setHeaders: (response, path) => {
          // The shell and the service worker must never be cached aggressively
          // or a phone would keep running last week's UI.
          if (path.endsWith('sw.js') || path.endsWith('index.html') || path.endsWith('manifest.webmanifest')) {
            response.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
  }

  app.get('/api/*', (_request, response) => {
    response.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Unknown endpoint.' });
  });

  app.get('*', (request, response) => {
    if (!hasClient) {
      response
        .status(503)
        .type('text/plain')
        .send(
          'The web interface has not been built yet.\nRun "npm run build" (or "npm run dev" while developing) and reload.',
        );
      return;
    }
    if (looksLikeFile(request.path)) {
      response.status(404).type('text/plain').send('Not found');
      return;
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(indexHtml);
  });

  // Last-resort error handler: never leak a stack trace to a browser on the LAN.
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    options.log(`http error: ${error.message}`);
    if (response.headersSent) return;
    response.status(500).json({ ok: false, code: 'INTERNAL', error: 'The server could not handle that request.' });
  });

  return { app, scopeFor };
}

function sendCsv(response: Response, content: string, filename: string): void {
  response
    .type('text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    .send(`\uFEFF${content}`);
}

function isUnsafeMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/**
 * Express 4 does not catch a rejected promise from an async handler, so a
 * failure inside one surfaces as an unhandled rejection rather than the error
 * response the host sees. Forwarding to `next()` routes it into the error
 * handler at the bottom of the stack instead.
 */
function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    handler(request, response, next).catch(next);
  };
}

/**
 * Split a `Host` header into its host and port, lowercased.
 *
 * IPv6 arrives bracketed (`[fe80::1]:3000`), so the colon search has to skip
 * past the closing bracket rather than splitting on the last colon blindly.
 */
function hostParts(value: string): { host: string; port: string } {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end >= 0) {
      return { host: raw.slice(0, end + 1), port: raw.slice(end + 2) };
    }
    return { host: raw, port: '' };
  }
  const colon = raw.lastIndexOf(':');
  return colon < 0 ? { host: raw, port: '' } : { host: raw.slice(0, colon), port: raw.slice(colon + 1) };
}

/**
 * True when the request looks like it was initiated by another site.
 *
 * `Sec-Fetch-Site` is definitive when present (every current browser sends it).
 * Below that, the check is anchored on a list of hostnames this server actually
 * answers on -- loopback, every local IP, the mDNS name and this machine's own
 * hostname -- and *not* on the `Host` header the request claims.
 *
 * That distinction is the whole defence. Comparing `Origin` against `Host` looks
 * equivalent but is not: under DNS rebinding an attacker's page is served from
 * its own origin while resolving to this machine, so it sends
 * `Host: attacker.example` *and* `Origin: http://attacker.example` and the two
 * agree perfectly. The response is then granted admin, because loopback requests
 * are admin without a token. Validating `Host` against a list we control cannot
 * be spoofed that way, and costs nothing: the list is the set of addresses we
 * hand out in the join links in the first place.
 */
function crossSite(request: Request, allowedHosts: Set<string>, port: number): boolean {
  const site = stringHeader(request.headers['sec-fetch-site']);
  if (site && site !== 'same-origin' && site !== 'none') return true;

  // HTTP/1.1 requires `Host`. Without one there is nothing to anchor on.
  const hostHeader = stringHeader(request.headers.host);
  if (!hostHeader) return true;
  const { host, port: hostPort } = hostParts(hostHeader);
  // An absent port means the default for the scheme, which is not us unless the
  // server really is listening there.
  if (hostPort !== '' && hostPort !== String(port)) return true;
  if (!allowedHosts.has(host)) return true;

  // The canonical `host[:port]` this request was addressed to, once the Host
  // header has been validated. Origin and Referer are compared against *this*,
  // never against the raw header, so the two sides are normalised the same way.
  const authority = hostPort === '' ? host : `${host}:${hostPort}`;

  const origin = stringHeader(request.headers.origin);
  if (origin) {
    return origin !== `http://${authority}` && origin !== `https://${authority}`;
  }

  const referer = stringHeader(request.headers.referer);
  if (referer) {
    try {
      const url = new URL(referer);
      const expected = request.protocol === 'https' ? 'https' : 'http';
      if (url.host !== authority) return true;
      if (url.protocol.replace(':', '') !== expected) return true;
    } catch {
      return true;
    }
  }

  // A form can post without either header on older browsers, but it still
  // cannot claim a JSON content type without triggering a preflight.
  const contentType = stringHeader(request.headers['content-type']) ?? '';
  return !contentType.toLowerCase().includes('application/json');
}

/**
 * Everything here is served from the host PC over the venue LAN, and nothing is
 * ever fetched from the internet. A tight policy says so out loud: no inline
 * script (the theme bootstrap lives in `public/theme-boot.js`), no framing, no
 * plugins. `style-src` needs `unsafe-inline` because the bracket layout is
 * positioned with inline style attributes.
 */
function securityHeaders() {
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; ');
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    // Control tokens live in the URL fragment, but the HTTP layer also accepts
    // them as a query parameter; never let one leak through a Referer header.
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  };
}

function looksLikeFile(path: string): boolean {
  const last = path.split('/').pop() ?? '';
  return last.includes('.') && !last.startsWith('.');
}

function stringHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
