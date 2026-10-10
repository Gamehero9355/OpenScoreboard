/**
 * Developer log. Everything the server says goes to the console *and* to a
 * bounded in-memory ring so the Developer panel in Settings can show it without
 * reading files from disk. Stack traces never leave the server: only messages.
 */
export interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

const MAX_LINES = 400;
const lines: LogLine[] = [];

function push(level: LogLine['level'], scope: string, message: string): void {
  lines.push({ ts: Date.now(), level, scope, message });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function createLogger(scope: string) {
  return {
    info: (message: string) => {
      push('info', scope, message);
      // eslint-disable-next-line no-console
      console.log(`[${scope}] ${message}`);
    },
    warn: (message: string) => {
      push('warn', scope, message);
      // eslint-disable-next-line no-console
      console.warn(`[${scope}] ${message}`);
    },
    error: (message: string) => {
      push('error', scope, message);
      // eslint-disable-next-line no-console
      console.error(`[${scope}] ${message}`);
    },
  };
}

export function recentLogs(limit = 200): LogLine[] {
  return lines.slice(-limit);
}

export function logSystem(level: LogLine['level'], scope: string, message: string): void {
  push(level, scope, message);
}

/**
 * Run once to capture process-level failures into the ring buffer.
 *
 * `uncaughtException` is the subtle one. Registering *any* handler for it
 * overrides Node's default behaviour, which is to print the error and exit --
 * so a handler that only logs silently turns a fatal fault into a server that
 * keeps running in an unknown state. Everything here runs on one event loop
 * shared with every WebSocket, the timer anchors and the persistence writes, so
 * the process cannot be trusted after an uncaught throw: whatever was half
 * applied may still be in `store.state` and being broadcast to the hall.
 *
 * A crash is also the only honest signal that anything is wrong. The host sees a
 * closed window and restarts, which recovers the last valid snapshot from disk
 * and loses at most the seconds since the last write; a wedged server loses the
 * rest of the event instead. `beforeQuit` in `startServer` flushes, and the
 * Electron shell exits too, so the backup still lands.
 *
 * `unhandledRejection` is different and deliberately stays non-fatal: several
 * call sites (`store.appendEvents`, the backup timer, `openBrowser`) already
 * handle their own rejections, and one of those promises rejecting must not take
 * down a half-finished tournament. It is logged as loudly as the ring allows.
 */
export function installProcessLogCapture(onFatal?: (message: string) => void): void {
  const fatal = (message: string): void => {
    logSystem('error', 'process', message);
    try {
      onFatal?.(message);
    } catch {
      /* the last thing that can go wrong; fall through to the exit below */
    }
    // Give the ring buffer and any stdout write a tick to flush, then leave.
    // `exit` rather than `exitCode`: the process is already untrustworthy, and a
    // pending handle could otherwise keep the event loop alive indefinitely.
    setTimeout(() => process.exit(1), 50).unref();
  };

  process.on('uncaughtException', (error) => {
    fatal(`Uncaught exception: ${error.message}${error.stack ? `\n${error.stack}` : ''}`);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logSystem('error', 'process', `Unhandled rejection: ${message}`);
  });
}
