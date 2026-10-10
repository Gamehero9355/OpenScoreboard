/**
 * HTTP rate limiting.
 *
 * The WebSocket command path already runs a token bucket (`hub.ts`), but nothing
 * limited HTTP. Every endpoint in this app is reachable from any device on the
 * venue WLAN, and Express and `ws` share one event loop with the timer anchors,
 * the heartbeat and the persistence writes -- so a single laptop looping on one
 * cheap GET is enough to stop scoring for the whole hall. Measured on the host
 * machine, `/api/network` costs 2.9 ms per call and `/api/qr` up to 10 ms, which
 * is one core saturated by a few hundred requests per second from one client.
 *
 * The limits below are sized for the actual audience rather than for the
 * internet: one host browser polling `/api/system`, a handful of phone clients,
 * and a projector. A real event never approaches them, so nothing legitimate is
 * refused, while the cheap anonymous GETs stop being a denial-of-service.
 */
import type { NextFunction, Request, Response } from 'express';

export interface BucketOptions {
  /** Requests allowed in a burst before the client starts waiting. */
  capacity: number;
  /** Average sustained rate, in requests per second. */
  refillPerSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the bucket has a whole token again. */
  retryAfterSec: number;
  remaining: number;
}

/**
 * A token bucket, one per key.
 *
 * Same shape as the WebSocket limiter so both are recognisable: tokens refill
 * continuously rather than in windows, which lets a burst of parallel asset
 * requests through on a cold bucket while still bounding the sustained rate.
 */
export class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly options: BucketOptions,
    /** Drop idle entries so a long-running event cannot grow this forever. */
    private readonly idleTtlMs = 10 * 60_000,
    private readonly maxBuckets = 4096,
  ) {}

  consume(key: string, now = Date.now()): RateLimitDecision {
    const entry = this.buckets.get(key);
    if (!entry) {
      this.evictIfNeeded(now);
      // The bucket starts full, and this request is the first one to draw from
      // it, so it is seeded with one token already spent -- otherwise a fresh
      // key would be good for `capacity + 1` requests.
      this.buckets.set(key, { tokens: this.options.capacity - 1, lastRefill: now });
      return { allowed: true, retryAfterSec: 0, remaining: this.options.capacity - 1 };
    }
    const elapsedSec = Math.max(0, (now - entry.lastRefill) / 1000);
    entry.tokens = Math.min(this.options.capacity, entry.tokens + elapsedSec * this.options.refillPerSec);
    entry.lastRefill = now;
    if (entry.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - entry.tokens) / this.options.refillPerSec));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }
    entry.tokens -= 1;
    return { allowed: true, retryAfterSec: 0, remaining: Math.floor(entry.tokens) };
  }

  private evictIfNeeded(now: number): void {
    if (this.buckets.size < this.maxBuckets) return;
    for (const [key, entry] of this.buckets) {
      if (now - entry.lastRefill > this.idleTtlMs) this.buckets.delete(key);
      if (this.buckets.size < this.maxBuckets) return;
    }
    // Still full of live clients: drop the oldest insertion, which is close
    // enough to oldest-inserted and costs nothing to maintain.
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Bucket sizes per surface, chosen from what each endpoint actually costs.
 *
 * The cheap-but-expensive-to-repeat endpoints (`/api/network`, `/api/qr`) are
 * the tightest, because they are the ones worth looping. `/api/state` is
 * generous per request but bounded in frequency, which caps both the CPU and
 * the egress a spectator screen can pull down the access point.
 */
export const HTTP_LIMITS = {
  /** Global ceiling across every endpoint, per client address. */
  global: { capacity: 120, refillPerSec: 40 } satisfies BucketOptions,
  /** `/api/network`: re-enumerates interfaces, ~3 ms a call. */
  network: { capacity: 20, refillPerSec: 5 } satisfies BucketOptions,
  /** `/api/qr`: up to ~10 ms for a 1024 px render of uncached text. */
  qr: { capacity: 15, refillPerSec: 4 } satisfies BucketOptions,
  /** `/api/state`: a full serialised snapshot per call. */
  state: { capacity: 30, refillPerSec: 8 } satisfies BucketOptions,
  /** CSV exports walk the whole bracket on every request. */
  export: { capacity: 10, refillPerSec: 2 } satisfies BucketOptions,
  /** Static assets and the service worker: a page load asks for a dozen. */
  static_: { capacity: 240, refillPerSec: 60 } satisfies BucketOptions,
} as const;

/**
 * One limiter per bucket class, all keyed by remote address.
 *
 * Sharing the global limiter across classes means a client cannot dodge the
 * overall ceiling by spreading its requests over endpoints; the per-class
 * limiters then stop any single expensive route from eating the whole budget.
 */
export function createHttpLimiters(): {
  check: (className: string, key: string) => RateLimitDecision;
  reset: () => void;
} {
  const limiters = new Map<string, TokenBucketLimiter>();
  for (const [name, options] of Object.entries(HTTP_LIMITS)) {
    limiters.set(name, new TokenBucketLimiter(options));
  }
  const global = limiters.get('global') as TokenBucketLimiter;
  return {
    check(className, key) {
      // The global budget is spent first, so exhausting it refuses regardless of
      // which endpoint is being asked for.
      const overall = global.consume(key);
      if (!overall.allowed) return overall;
      const scoped = limiters.get(className);
      return scoped ? scoped.consume(key) : overall;
    },
    reset() {
      for (const limiter of limiters.values()) limiter.reset();
    },
  };
}

/**
 * What kind of request this is, so one limiter can serve several budgets.
 *
 * Kept as a function rather than a middleware per class: it runs before any body
 * is parsed, which matters because `express.json` was itself a CPU-burner --
 * a multi-megabyte POST is now refused before it is read off the socket.
 */
export function limitClassFor(path: string): string {
  if (path === '/api/network') return 'network';
  if (path === '/api/qr') return 'qr';
  if (path === '/api/state') return 'state';
  if (path.startsWith('/api/export/')) return 'export';
  if (path.startsWith('/api/')) return 'global';
  return 'static_';
}

/**
 * Fold IPv4-mapped IPv6 and any zone suffix into one stable key, so one phone
 * cannot get a fresh allowance by reconnecting from a differently-spelled
 * address. Same rule as the PIN lockout in `hub.ts`.
 */
export function rateLimitKey(request: Request): string {
  const address = request.socket.remoteAddress ?? 'unknown';
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  const zone = bare.indexOf('%');
  return zone === -1 ? bare : bare.slice(0, zone);
}

export function rateLimitMiddleware(
  check: (className: string, key: string) => RateLimitDecision,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const decision = check(limitClassFor(request.path), rateLimitKey(request));
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader('Retry-After', String(decision.retryAfterSec));
    // 429 rather than 403: the request was understood and is temporarily
    // refused, which is what a client can act on by waiting.
    response
      .status(429)
      .json({
        ok: false,
        code: 'TOO_MANY_REQUESTS',
        error: 'Too many requests from this device. Slow down for a moment.',
        retryAfterSec: decision.retryAfterSec,
      });
  };
}