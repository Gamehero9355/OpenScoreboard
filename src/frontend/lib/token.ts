/**
 * Access tokens.
 *
 * The admin and field-operator QR codes hand the token over in the URL
 * fragment (`#t=...`), which is never sent to a server in a request line and
 * never appears in a log. The fragment is copied into local storage for the
 * device and then stripped from the visible URL.
 */
const STORAGE_KEY = 'tsb.access';

export interface StoredAccess {
  token: string;
  role: 'admin' | 'operator' | null;
  fieldId: string | null;
  savedAt: number;
  /** Operator PIN for this device, when the host requires one. */
  pin: string | null;
}

function read(): StoredAccess | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAccess;
    if (!parsed || typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(access: StoredAccess): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(access));
  } catch {
    /* private mode -- the session still works, it just will not be remembered */
  }
}

export function forgetAccess(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the token for this device. An explicit `#t=` in the URL always wins
 * (so scanning a fresh QR code on a shared tablet switches roles), otherwise a
 * previously stored token is reused.
 */
export function resolveAccess(): { token: string | null; pin: string | null; adopted: boolean } {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const fromUrl = params.get('t');

  if (fromUrl) {
    const previous = read();
    write({
      token: fromUrl,
      role: null,
      fieldId: null,
      savedAt: Date.now(),
      // A fresh scan keeps the PIN already entered on this device: the operator
      // should not have to type it again for the second field.
      pin: previous?.pin ?? null,
    });
    const clean = `${window.location.pathname}${window.location.search}`;
    try {
      window.history.replaceState(null, '', clean);
    } catch {
      /* ignore */
    }
    return { token: fromUrl, pin: previous?.pin ?? null, adopted: true };
  }

  const stored = read();
  return { token: stored?.token ?? null, pin: stored?.pin ?? null, adopted: false };
}

/** Remember the PIN for this device only, so a reload does not ask again. */
export function rememberPin(pin: string | null): void {
  const stored = read();
  if (!stored) return;
  write({ ...stored, pin });
}

/** PIN currently remembered on this device, if any. */
export function storedPin(): string | null {
  return read()?.pin ?? null;
}

export function rememberScope(role: 'admin' | 'operator' | 'spectator', fieldId: string | null): void {
  const stored = read();
  if (!stored) return;
  write({ ...stored, role: role === 'spectator' ? null : role, fieldId });
}

export function requestHeaders(): Record<string, string> {
  const stored = read();
  return stored ? { 'x-token': stored.token } : {};
}
