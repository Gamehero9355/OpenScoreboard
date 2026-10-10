/**
 * Access control.
 *
 * Kept deliberately simple, but never trusting: the server owns every token, a
 * token only ever grants one scope, and readers can never mutate anything.
 *
 *  - admin      full access, also granted automatically on loopback so the host
 *               PC never has to type a secret
 *  - operator   bound to exactly one playing field
 *  - spectator  read only, no token needed, no commands accepted
 *
 * Tokens and the operator PIN are stored next to the database in
 * `access.json`, deliberately *outside* the tournament state so that a
 * tournament backup can never leak credentials. That file holds the only copy
 * of the operator tokens, so it is written atomically and a shadow copy
 * (`access.json.bak`) is kept: a half-written file must never be mistaken for
 * "no credentials configured" and silently rotate every control link.
 */
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FieldId, Role } from '../../shared/types';
import { makeToken } from '../util/ids';

export interface SessionScope {
  role: Role;
  /** null for admin and spectator; the bound field for operators. */
  fieldId: FieldId | null;
  label: string;
  source: 'loopback' | 'token' | 'public';
}

interface AccessFile {
  version: number;
  adminToken: string;
  /** One bearer token per playing field, keyed by field id ('1', '2', ...). */
  operatorTokens: Record<string, string>;
  pinHash: string | null;
  /**
   * Per-install salt for the operator PIN. Generated once and kept next to the
   * hash; without it every install would hash a given PIN identically and the
   * whole four-digit space would be enumerable offline in milliseconds.
   */
  pinSalt: string | null;
}

const ACCESS_VERSION = 2;

/** scrypt cost. 16 MiB of memory per guess, which is the point. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_KEYLEN = 32;
const PIN_SALT_BYTES = 16;

/**
 * Hash the operator PIN with a per-install salt.
 *
 * The returned string carries its own parameters (`scrypt$N$r$p$salt$hash`) so a
 * later cost increase can be recognised and re-hashed without a migration. A
 * legacy single-round SHA-256 hash is still *accepted* by `checkPin` and is
 * transparently upgraded the first time the correct PIN arrives.
 */
export function hashPin(pin: string, salt: string): string {
  const saltBuf = Buffer.from(salt, 'hex');
  const derived = scryptSync(pin.normalize('NFKC'), saltBuf, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

/** The pre-scrypt format, kept only so an existing install still unlocks. */
function legacyPinHash(pin: string): string {
  return createHash('sha256').update(`tournament-scoreboard:${pin}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AccessControl {
  private readonly filePath: string;
  private data: AccessFile;
  /** Serialises every write; concurrent writers would otherwise truncate. */
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'access.json');
    this.data = {
      version: ACCESS_VERSION,
      adminToken: makeToken(18),
      operatorTokens: { '1': makeToken(18), '2': makeToken(18) },
      pinHash: null,
      pinSalt: null,
    };
  }

  /**
   * Load the credentials, falling back to the shadow copy.
   *
   * This file holds the only copy of the operator tokens: if it were ever
   * silently regenerated, every phone and every printed QR code would stop
   * working halfway through an event. So a parse failure is treated as damage,
   * not as "first run": the shadow copy is tried, and if that fails too the
   * unreadable file is moved aside rather than overwritten.
   */
  async load(): Promise<void> {
    const recovered = await this.readAccessFile(this.filePath);
    if (recovered) {
      this.data = recovered;
      return;
    }
    const shadow = await this.readAccessFile(`${this.filePath}.bak`);
    if (shadow) {
      this.data = shadow;
      // The shadow is now the live file; repair the original in place.
      await this.enqueueSave();
      return;
    }
    // Nothing readable anywhere. Preserve whatever is on disk for forensics
    // instead of destroying it, then start from a clean set of credentials.
    await this.quarantineUnreadable();
    await this.enqueueSave();
  }

  private async readAccessFile(path: string): Promise<AccessFile | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: Partial<AccessFile>;
    try {
      parsed = JSON.parse(raw) as Partial<AccessFile>;
    } catch {
      return null;
    }
    if (!parsed.adminToken || !parsed.operatorTokens?.['1']) return null;
    const tokens: Record<string, string> = {};
    for (const [id, token] of Object.entries(parsed.operatorTokens)) {
      if (/^[1-9][0-9]*$/.test(id) && typeof token === 'string' && token.length > 0) {
        tokens[id] = token;
      }
    }
    // Migrate old two-field files: field 2 keeps working even if missing.
    if (!tokens['2']) tokens['2'] = makeToken(18);
    return {
      version: ACCESS_VERSION,
      adminToken: parsed.adminToken,
      operatorTokens: tokens,
      pinHash: typeof parsed.pinHash === 'string' ? parsed.pinHash : null,
      pinSalt: typeof parsed.pinSalt === 'string' ? parsed.pinSalt : null,
    };
  }

  /** Move a file we could not parse out of the way, keeping it recoverable. */
  private async quarantineUnreadable(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = join(dirname(this.filePath), `access.unreadable-${stamp}.json`);
    try {
      await stat(this.filePath);
    } catch {
      return; // nothing there at all: a genuine first run
    }
    try {
      await rename(this.filePath, target);
      // eslint-disable-next-line no-console
      console.error(
        `[access] ${this.filePath} could not be read; the damaged file was kept at ${target} and fresh credentials were issued.`,
      );
    } catch {
      // Cannot move it: leave it alone and let the atomic write replace it.
    }
  }

  async save(): Promise<void> {
    await this.enqueueSave();
  }

  /**
   * Queue one atomic write: temp file, fsync, then rename. The rename is the
   * only operation a reader can observe, so a power cut leaves either the old
   * credentials or the new ones -- never a truncated file.
   */
  private enqueueSave(): Promise<void> {
    const run = this.writeQueue.then(
      () => this.writeAtomic(),
      () => this.writeAtomic(),
    );
    // Keep the queue alive even if one write fails.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeAtomic(): Promise<void> {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const sequence = (this.writeSequence += 1);
    const tmpPath = `${this.filePath}.${process.pid}.${sequence}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      // Flush before the rename so the rename can never expose a partial file.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Keep the previous good copy as a shadow so `load()` has something to
    // fall back to if this machine loses power mid-rename.
    try {
      await rm(`${this.filePath}.bak`, { force: true });
      await rename(this.filePath, `${this.filePath}.bak`);
    } catch {
      /* first write -- nothing to rotate */
    }
    await rename(tmpPath, this.filePath);
  }

  get adminToken(): string {
    return this.data.adminToken;
  }

  /**
   * Make sure every listed field owns a token. Synchronous on purpose: join
   * links are rendered in a sync code path, so new tokens are persisted in
   * the background right away.
   */
  ensureTokens(fieldIds: string[]): void {
    let changed = false;
    for (const id of fieldIds) {
      if (!this.data.operatorTokens[id]) {
        this.data.operatorTokens[id] = makeToken(18);
        changed = true;
      }
    }
    if (changed) void this.save().catch(() => undefined);
  }

  operatorToken(fieldId: FieldId): string {
    if (!this.data.operatorTokens[fieldId]) {
      this.data.operatorTokens[fieldId] = makeToken(18);
      void this.save().catch(() => undefined);
    }
    return this.data.operatorTokens[fieldId];
  }

  fieldLabel(fieldId: FieldId): string {
    return `Field ${fieldId}`;
  }

  async rotateOperatorToken(fieldId: FieldId): Promise<string> {
    this.data.operatorTokens[fieldId] = makeToken(18);
    await this.save();
    return this.data.operatorTokens[fieldId];
  }

  /**
   * Issue fresh operator tokens for every listed field. Called when a new
   * tournament is created so each tournament gets its own field QR codes and
   * a code printed for an earlier event stops working. Synchronous on purpose
   * (see `ensureTokens`): the new tokens are persisted in the background.
   */
  rotateOperatorTokens(fieldIds: string[]): void {
    for (const id of fieldIds) {
      if (!/^[1-9][0-9]*$/.test(id)) continue;
      this.data.operatorTokens[id] = makeToken(18);
    }
    void this.save().catch(() => undefined);
  }

  async rotateAdminToken(): Promise<string> {
    this.data.adminToken = makeToken(18);
    await this.save();
    return this.data.adminToken;
  }

  get pinSet(): boolean {
    return this.data.pinHash !== null;
  }

  async setPin(pin: string | null): Promise<void> {
    if (!pin) {
      this.data.pinHash = null;
      this.data.pinSalt = null;
    } else {
      const salt = randomBytes(PIN_SALT_BYTES).toString('hex');
      this.data.pinSalt = salt;
      this.data.pinHash = hashPin(pin, salt);
    }
    await this.save();
  }

  async rotatePinIfUnset(): Promise<string | null> {
    if (this.data.pinHash) return null;
    const pin = String(randomInt(1000, 10000));
    await this.setPin(pin);
    return pin;
  }

  /**
   * Verify the operator PIN.
   *
   * A stored hash from before scrypt (a bare SHA-256 digest) is still accepted,
   * and is quietly rewritten in the salted form on the first success so an
   * existing install upgrades itself without the host noticing.
   */
  checkPin(pin: string): boolean {
    const stored = this.data.pinHash;
    if (!stored) return true;
    const salt = this.data.pinSalt;
    if (!salt) {
      // Legacy format: verify against the old digest, then upgrade.
      if (!safeEqual(legacyPinHash(pin), stored)) return false;
      const fresh = randomBytes(PIN_SALT_BYTES).toString('hex');
      this.data.pinSalt = fresh;
      this.data.pinHash = hashPin(pin, fresh);
      void this.save().catch(() => undefined);
      return true;
    }
    return safeEqual(hashPin(pin, salt), stored);
  }

  requiresPin(): boolean {
    return this.data.pinHash !== null;
  }

  /** Resolve a bearer token into a scope. Returns null for unknown tokens. */
  resolveToken(token: string | null | undefined): SessionScope | null {
    if (!token) return null;
    if (safeEqual(token, this.data.adminToken)) {
      return { role: 'admin', fieldId: null, label: 'Host', source: 'token' };
    }
    for (const [fieldId, fieldToken] of Object.entries(this.data.operatorTokens)) {
      if (typeof fieldToken === 'string' && fieldToken.length > 0 && safeEqual(token, fieldToken)) {
        return { role: 'operator', fieldId, label: `Field ${fieldId} operator`, source: 'token' };
      }
    }
    return null;
  }

  /** Everything without a token is a spectator. */
  spectator(): SessionScope {
    return { role: 'spectator', fieldId: null, label: 'Spectator', source: 'public' };
  }

  adminFromLoopback(): SessionScope {
    return { role: 'admin', fieldId: null, label: 'Host (local)', source: 'loopback' };
  }
}

export function isLoopback(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalised = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalised === '127.0.0.1' || normalised === '::1' || normalised === 'localhost';
}
