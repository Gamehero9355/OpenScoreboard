/**
 * Real-time protocol helpers shared by the server (validation) and the client
 * (construction). The server never trusts a browser message: every field is
 * checked before it reaches the tournament engine.
 */
import type { ClientMessage, FieldId, Settings, MatchState } from './types';
import {
  DISPLAY_SCREENS,
  MAX_BREAK_DURATION_SEC,
  MAX_FIELDS,
  MIN_BREAK_DURATION_SEC,
  MIN_FIELDS,
  PROTOCOL_VERSION,
  isDisplayScreen,
  isFieldId,
} from './types';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
export function invalid<T = never>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Primitive guards                                                   */
/* ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

export function asInt(value: unknown, min: number, max: number): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return null;
  const int = Math.trunc(num);
  if (int < min || int > max) return null;
  return int;
}

export function asNumber(value: unknown, min: number, max: number): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

export function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function asFieldId(value: unknown): FieldId | null {
  return isFieldId(value) ? value : null;
}

export function asHexColor(value: unknown): string | null {
  const str = asString(value, 32);
  if (!str) return null;
  return /^#[0-9a-fA-F]{3,8}$/.test(str) ? str : null;
}

export function asMatchState(value: unknown): MatchState | null {
  const str = asString(value, 24);
  if (!str) return null;
  const allowed: MatchState[] = [
    'WAITING',
    'READY',
    'ASSIGNED',
    'RUNNING',
    'PAUSED',
    'HALFTIME',
    'FINISHED',
    'CANCELLED',
  ];
  return (allowed as string[]).includes(str) ? (str as MatchState) : null;
}

/* ------------------------------------------------------------------ */
/* Client message parsing                                             */
/* ------------------------------------------------------------------ */

export function parseClientMessage(raw: string, maxBytes: number): ValidationResult<ClientMessage> {
  if (typeof raw !== 'string' || raw.length === 0) return invalid('Empty message');
  if (raw.length > maxBytes) return invalid('Message too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('Message is not valid JSON');
  }
  if (!isRecord(parsed)) return invalid('Message must be an object');
  const t = parsed.t;
  if (t === 'hello') {
    const protocol = asInt(parsed.protocol, 1, 1000);
    if (protocol === null) return invalid('hello.protocol must be an integer');
    const token =
      parsed.token === null || parsed.token === undefined ? null : asString(parsed.token, 128);
    if (parsed.token !== null && parsed.token !== undefined && token === null) {
      return invalid('hello.token must be a string when provided');
    }
    const topic =
      parsed.topic === null || parsed.topic === undefined ? undefined : asString(parsed.topic, 64);
    const clientLabel =
      parsed.clientLabel === null || parsed.clientLabel === undefined
        ? undefined
        : asString(parsed.clientLabel, 64);
    const readOnly = parsed.readOnly === undefined ? undefined : asBool(parsed.readOnly);
    if (parsed.readOnly !== undefined && readOnly === null) {
      return invalid('hello.readOnly must be a boolean');
    }
    const pin =
      parsed.pin === null || parsed.pin === undefined ? undefined : asString(parsed.pin, 12);
    if (parsed.pin !== undefined && parsed.pin !== null && (!pin || !/^[0-9]{4,8}$/.test(pin))) {
      return invalid('hello.pin must be 4-8 digits');
    }
    return valid({
      t: 'hello',
      protocol,
      token,
      ...(pin ? { pin } : {}),
      ...(topic ? { topic: topic ?? undefined } : {}),
      ...(clientLabel ? { clientLabel } : {}),
      ...(readOnly ? { readOnly } : {}),
    });
  }
  if (t === 'resync') {
    const requestId =
      parsed.requestId === undefined ? undefined : asString(parsed.requestId, 64) ?? undefined;
    return valid({ t: 'resync', requestId });
  }
  if (t === 'ping') {
    return valid({ t: 'ping' });
  }
  if (t === 'cmd') {
    const requestId = asString(parsed.requestId, 64);
    if (!requestId) return invalid('cmd.requestId is required');
    const action = asString(parsed.action, 64);
    if (!action) return invalid('cmd.action is required');
    return valid({ t: 'cmd', requestId, action, payload: parsed.payload });
  }
  return invalid(`Unknown message type: ${String(t)}`);
}

export function helloMessage(
  token?: string | null,
  topic?: string,
  clientLabel?: string,
  readOnly?: boolean,
): string {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    token: token ?? null,
    ...(topic ? { topic } : {}),
    ...(clientLabel ? { clientLabel } : {}),
    ...(readOnly ? { readOnly } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Settings validation (used by the settings API + engine)            */
/* ------------------------------------------------------------------ */

export interface SettingsPatch {
  [key: string]: unknown;
}

export function validateSettingsPatch(patch: SettingsPatch, current: Settings): ValidationResult<Partial<Settings>> {
  const out: Partial<Settings> = {};
  const keys = Object.keys(patch);
  if (keys.length === 0) return invalid('Empty settings patch');
  if (keys.length > 40) return invalid('Too many settings in one request');

  for (const key of keys) {
    const raw = patch[key];
    switch (key) {
      case 'tournamentName': {
        const v = asString(raw, 80);
        if (!v) return invalid('tournamentName must be 1-80 characters');
        out.tournamentName = v;
        break;
      }
      case 'theme': {
        if (raw !== 'dark' && raw !== 'light') return invalid('theme must be dark or light');
        out.theme = raw;
        break;
      }
      case 'language': {
        // Optional on the wire so an older host that does not know the key can
        // still receive a patch mentioning it; rejected by value, not presence.
        if (raw === undefined) break;
        if (raw !== 'en' && raw !== 'de') return invalid('language must be en or de');
        out.language = raw;
        break;
      }
      case 'primaryColor': {
        const v = asHexColor(raw);
        if (!v) return invalid('primaryColor must be a hex colour');
        out.primaryColor = v;
        break;
      }
      case 'accentColor': {
        const v = asHexColor(raw);
        if (!v) return invalid('accentColor must be a hex colour');
        out.accentColor = v;
        break;
      }
      case 'logoDataUrl': {
        if (raw === null) {
          out.logoDataUrl = null;
          break;
        }
        const v = asString(raw, 400_000);
        if (!v || !/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/.test(v)) {
          return invalid('logoDataUrl must be a base64 image data URL or null');
        }
        out.logoDataUrl = v;
        break;
      }
      case 'showSponsorBar': {
        const v = asBool(raw);
        if (v === null) return invalid('showSponsorBar must be a boolean');
        out.showSponsorBar = v;
        break;
      }
      case 'invertDisplayColors': {
        const v = asBool(raw);
        if (v === null) return invalid('invertDisplayColors must be a boolean');
        out.invertDisplayColors = v;
        break;
      }
      case 'displayScreen': {
        if (!isDisplayScreen(raw)) return invalid(`displayScreen must be one of ${DISPLAY_SCREENS.join(', ')}`);
        out.displayScreen = raw;
        break;
      }
      case 'displayScreens': {
        if (raw === null || raw === undefined) break;
        if (typeof raw !== 'object' || Array.isArray(raw)) return invalid('displayScreens must be an object');
        const maps: Record<string, unknown> = {};
        for (const [fieldId, screen] of Object.entries(raw as Record<string, unknown>)) {
          if (!isFieldId(fieldId)) return invalid('displayScreens keys must be playing fields ("1".."8")');
          if (screen === null || screen === undefined) continue;
          if (!isDisplayScreen(screen)) return invalid(`displayScreens[${fieldId}] must be one of ${DISPLAY_SCREENS.join(', ')}`);
          maps[fieldId] = screen;
        }
        (out as Record<string, unknown>).displayScreens = maps;
        break;
      }
      case 'displayMessages': {
        if (raw === null || raw === undefined) break;
        if (typeof raw !== 'object' || Array.isArray(raw)) return invalid('displayMessages must be an object');
        const maps: Record<string, string | null> = {};
        for (const [fieldId, message] of Object.entries(raw as Record<string, unknown>)) {
          if (!isFieldId(fieldId)) return invalid('displayMessages keys must be playing fields ("1".."8")');
          if (message === null || message === '') {
            maps[fieldId] = null;
            continue;
          }
          const v = asString(message, 160);
          if (!v) return invalid(`displayMessages[${fieldId}] must be 160 characters or fewer`);
          maps[fieldId] = v;
        }
        (out as Record<string, unknown>).displayMessages = maps;
        break;
      }
      case 'displayMessage': {
        // Null and the empty string both mean "no message", so clearing it is a
        // normal patch rather than something the settings page has to special-case.
        if (raw === null || raw === '') {
          out.displayMessage = null;
          break;
        }
        const v = asString(raw, 160);
        if (!v) return invalid('displayMessage must be 160 characters or fewer');
        out.displayMessage = v;
        break;
      }
      case 'defaultMatchDurationSec': {
        const v = asNumber(raw, 10, 24 * 60 * 60);
        if (v === null) return invalid('defaultMatchDurationSec must be 10..86400');
        out.defaultMatchDurationSec = v;
        break;
      }
      case 'breakDurationSec': {
        const v = asNumber(raw, MIN_BREAK_DURATION_SEC, MAX_BREAK_DURATION_SEC);
        if (v === null) {
          return invalid(`breakDurationSec must be ${MIN_BREAK_DURATION_SEC}..${MAX_BREAK_DURATION_SEC}`);
        }
        out.breakDurationSec = v;
        break;
      }
      case 'scoringIncrements': {
        if (!Array.isArray(raw)) return invalid('scoringIncrements must be an array');
        if (raw.length === 0 || raw.length > 6) return invalid('scoringIncrements needs 1..6 entries');
        const increments: number[] = [];
        for (const entry of raw) {
          const v = asInt(entry, -99, 99);
          if (v === null || v === 0) return invalid('Each increment must be an integer != 0');
          if (!increments.includes(v)) increments.push(v);
        }
        out.scoringIncrements = increments;
        break;
      }
      case 'winCondition': {
        if (raw !== 'manual' && raw !== 'points' && raw !== 'timer' && raw !== 'either') {
          return invalid('winCondition must be manual, points, timer or either');
        }
        out.winCondition = raw;
        break;
      }
      case 'maxScore': {
        if (raw === null) {
          out.maxScore = null;
          break;
        }
        const v = asInt(raw, 1, 100000);
        if (v === null) return invalid('maxScore must be null or 1..100000');
        out.maxScore = v;
        break;
      }
      case 'allowDraws': {
        const v = asBool(raw);
        if (v === null) return invalid('allowDraws must be a boolean');
        out.allowDraws = v;
        break;
      }
      case 'timerMode': {
        if (raw !== 'down' && raw !== 'up') return invalid('timerMode must be down or up');
        out.timerMode = raw;
        break;
      }
      case 'fieldNames': {
        if (!Array.isArray(raw) || raw.length < MIN_FIELDS || raw.length > MAX_FIELDS) {
          return invalid(`fieldNames must have ${MIN_FIELDS}..${MAX_FIELDS} entries`);
        }
        const names: string[] = [];
        for (const entry of raw) {
          const name = asString(entry, 24);
          if (!name) return invalid('Field names must be 1-24 characters');
          names.push(name);
        }
        out.fieldNames = names;
        break;
      }
      case 'autoLoadNext':
      case 'autoAssignNext':
      case 'requireOperatorPin':
      case 'autoBackupEnabled': {
        const v = asBool(raw);
        if (v === null) return invalid(`${key} must be a boolean`);
        (out as Record<string, unknown>)[key] = v;
        break;
      }
      case 'operatorPin': {
        if (raw === null || raw === '') {
          out.requireOperatorPin = false;
          (out as Record<string, unknown>).operatorPin = null;
          break;
        }
        const v = asString(raw, 12);
        if (!v || !/^[0-9]{4,8}$/.test(v)) return invalid('operatorPin must be 4-8 digits');
        (out as Record<string, unknown>).operatorPin = v;
        out.requireOperatorPin = true;
        break;
      }
      case 'port': {
        const v = asInt(raw, 1, 65535);
        if (v === null) return invalid('port must be 1..65535');
        out.port = v;
        break;
      }
      case 'advertisedHost': {
        if (raw === null || raw === '') {
          out.advertisedHost = null;
          break;
        }
        const v = asString(raw, 120);
        if (!v) return invalid('advertisedHost must be a hostname or null');
        out.advertisedHost = v;
        break;
      }
      case 'autoBackupIntervalMin': {
        const v = asInt(raw, 1, 24 * 60);
        if (v === null) return invalid('autoBackupIntervalMin must be 1..1440');
        out.autoBackupIntervalMin = v;
        break;
      }
      default:
        return invalid(`Unknown setting: ${key}`);
    }
  }
  // Guard rail: never let a patch disable the current theme colours silently
  if (out.primaryColor && !out.accentColor && out.primaryColor === current.accentColor) {
    return invalid('primaryColor and accentColor must differ');
  }
  return valid(out);
}

export { PROTOCOL_VERSION };
