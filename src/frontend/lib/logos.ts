/**
 * Team crests.
 *
 * The list is fetched once per host session and shared by every screen that
 * draws a crest, because the folder is the host's and only changes when they
 * put a file in it. A spectator screen that had to ask the host for the list
 * would be one more message per board.
 */
import { useEffect, useState } from 'react';

export interface LogoIndex {
  files: string[];
  defaultFile: string | null;
  dir: string;
  exists: boolean;
}

/** What every team falls back to when it has no crest of its own. */
export const FALLBACK_LOGO_FILE = 'default.svg';

const EMPTY: LogoIndex = { files: [], defaultFile: null, dir: '', exists: false };

let cached: LogoIndex | null = null;
let inflight: Promise<LogoIndex> | null = null;
const listeners = new Set<(index: LogoIndex) => void>();

function publish(index: LogoIndex): LogoIndex {
  cached = index;
  for (const listener of listeners) listener(index);
  return index;
}

async function fetchIndex(): Promise<LogoIndex> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch('/api/logos', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('logo list unavailable');
        return (await response.json()) as LogoIndex;
      })
      .catch(() => EMPTY)
      .then((index) => {
        inflight = null;
        return publish({ ...EMPTY, ...index });
      });
  }
  return inflight;
}

/** The crests in the host's folder, plus where that folder is. */
export function useLogos(): LogoIndex {
  const [index, setIndex] = useState<LogoIndex>(() => cached ?? EMPTY);
  useEffect(() => {
    let live = true;
    const onChange = (next: LogoIndex) => {
      if (live) setIndex(next);
    };
    listeners.add(onChange);
    void fetchIndex().then((next) => {
      if (live) setIndex(next);
    });
    return () => {
      live = false;
      listeners.delete(onChange);
    };
  }, []);
  return index;
}

/**
 * Drop the cached list so the next screen re-reads the folder.
 *
 * Called after a host says they have just added a crest, because the only way
 * to add one is to drop a file in and the app has no way to see that happen.
 */
export function refreshLogos(): Promise<LogoIndex> {
  cached = null;
  return fetchIndex();
}

/**
 * The URL for a crest, or null when there is nothing to draw.
 *
 * A team with no crest of its own falls back to the folder's default, and then
 * to the built-in name, so a missing file leaves the board as it was rather than
 * showing a broken image in front of a score.
 */
export function logoSrc(logo: string | null | undefined, index: LogoIndex | null): string | null {
  const chosen = logo?.trim() ? logo.trim() : (index?.defaultFile ?? FALLBACK_LOGO_FILE);
  return `/logos/${encodeURIComponent(chosen)}`;
}

/**
 * The crest to actually draw, or null if the folder has nothing suitable.
 *
 * `logoSrc` always returns a URL so a browser retries a file that was dropped
 * in after the page loaded; this is the check that decides whether drawing
 * anything is worth it.
 */
export function resolvableLogo(logo: string | null | undefined, index: LogoIndex | null): string | null {
  if (!index) return null;
  const chosen = logo?.trim() ? logo.trim() : (index.defaultFile ?? FALLBACK_LOGO_FILE);
  return index.files.includes(chosen) ? chosen : null;
}