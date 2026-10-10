/** Small browser-side helpers. No dependencies, no external calls. */

import { formatDateTime as intlDateTime, intlTag, type Locale } from './i18n';
import { resolveAccess } from './token';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatClockLong(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A time of day, optionally in the host's own format.
 *
 * The shape is deliberately unchanged -- `HH:MM:SS` in the local zone -- because
 * this is a score sheet, and a hall reads the seconds off the row rather than off
 * a prose phrase. `locale` only decides how the digits and separators are
 * written; it is optional so the screens not wired to the catalogue yet keep the
 * plain form, and so nothing that is not a rendered surface pays for it.
 */
export function formatTime(ts: number, locale?: Locale): string {
  const date = new Date(ts);
  if (locale) {
    try {
      return new Intl.DateTimeFormat(intlTag(locale, 'time'), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(date);
    } catch {
      /* a trimmed runtime without full ICU data still gets the plain form */
    }
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;
}

export function formatDateTime(ts: number, locale?: Locale): string {
  if (locale) return intlDateTime(locale, ts);
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${formatTime(ts)}`;
}

/**
 * How long ago something happened, in the reader's language.
 *
 * Uses `Intl.RelativeTimeFormat` rather than a hand-rolled `"5m ago"`, because
 * German writes these differently (`vor 5 Minuten`, `vor 2 Tagen`) and the units
 * are not the same abbreviations. Falls back to the English form if the runtime
 * has no ICU data -- a trimmed Node build in a venue laptop is exactly the case
 * this guards, and a readable English timestamp beats a thrown error.
 */
export function relativeTime(ts: number, now = Date.now(), locale?: Locale): string {
  const delta = Math.round((now - ts) / 1000);
  const abs = Math.abs(delta);
  const [value, unit] =
    abs < 60
      ? [delta, 'second']
      : abs < 3600
        ? [Math.round(delta / 60), 'minute']
        : abs < 86400
          ? [Math.round(delta / 3600), 'hour']
          : [Math.round(delta / 86400), 'day'];
  try {
    return new Intl.RelativeTimeFormat(intlTag(locale ?? 'en', 'date'), { numeric: 'auto' }).format(
      value,
      unit as Intl.RelativeTimeFormatUnit,
    );
  } catch {
    if (delta < 5) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function abbreviatedUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function downloadBlob(content: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface ApiError {
  code: string;
  error: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const parsed = (body ?? {}) as Partial<ApiError>;
    throw new Error(parsed.error ?? `Request failed with status ${response.status}`);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};

export function tokenHeader(token: string | null): Record<string, string> {
  return token ? { 'x-token': token } : {};
}

/**
 * Download a host endpoint. Uses fetch rather than a plain anchor so the access
 * token can travel in a header (an admin-only endpoint must not depend on the
 * device being on loopback), and honours the filename the host suggests.
 */
export async function downloadFromHost(path: string, fallbackName: string): Promise<string> {
  const { token } = resolveAccess();
  const response = await fetch(path, { headers: tokenHeader(token) });
  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const name = match?.[1] ?? fallbackName;
  const text = await response.text();
  downloadBlob(text, name, response.headers.get('content-type') ?? 'text/plain;charset=utf-8');
  return name;
}

export function hashPicker(): { token: string | null; clean: string } {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(raw);
  const token = params.get('t');
  const clean = `${window.location.pathname}${window.location.search}`;
  return { token, clean };
}

/** Cheap stable id for list keys built from screen state. */
export function keyOf(...parts: (string | number | null | undefined)[]): string {
  return parts.filter((part) => part !== null && part !== undefined).join(':');
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseDurationInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 60;
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  return null;
}

export function formatDurationInput(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The scoring buttons a bracket offers, or null when the box is unusable. */
export function parseScoringIncrements(raw: string): number[] | null {
  const values = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(Number);
  if (
    values.length === 0 ||
    values.length > 6 ||
    new Set(values).size !== values.length ||
    values.some((value) => !Number.isInteger(value) || value === 0 || Math.abs(value) > 99)
  ) {
    return null;
  }
  return [...new Set(values)];
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
