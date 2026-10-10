/**
 * Team logos: the images a host drops into a folder on the project, and the one
 * that stands in for every team without a logo of its own.
 *
 * Why a folder and not an upload: this app is offline by law. There is nowhere
 * to upload *to*, and a host setting up a sports day would rather drop twenty
 * club crests into a folder next to the project than fight a file dialog twenty
 * times. So the folder is the source of truth and the picker is a list of what
 * is in it.
 *
 * Two rules make a folder of arbitrary host files safe to serve from the app's
 * own origin:
 *
 *  - Only the extensions below are ever listed, and a name is only served after
 *    it has been listed. `..`, absolute paths, nested folders and symlinks are
 *    refused, so `GET /logos/../../data/access.json` is not a thing.
 *  - SVG is allowed, because club crests are usually SVG, and it is served with
 *    a `default-src 'none'` policy: an SVG loaded through `<img>` cannot run
 *    script, and one opened directly cannot either.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Extensions we are willing to render as a crest. */
const LOGO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'];

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/** The file every team without a logo of its own falls back to. */
export const DEFAULT_LOGO_FILE = 'default.svg';

/** Big enough for a club crest, small enough to fail fast on a rogue file. */
const MAX_LOGO_BYTES = 2_000_000;

export interface LogoFolder {
  /** Absolute path, reported to the host so they know where to drop files. */
  dir: string;
  /** Whether the folder exists. An empty list is normal, a missing folder is not. */
  exists: boolean;
}

export interface LogoIndex {
  files: string[];
  /** The fallback file name if the folder actually has it, else null. */
  defaultFile: string | null;
  dir: string;
  exists: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function isLogoName(name: string): boolean {
  // A leading dot is a hidden file, not a crest, and never has a real extension.
  if (!name || name.startsWith('.') || name !== name.trim()) return false;
  // No separator of either flavour. This is the rule that makes the folder flat:
  // a nested path is never a crest, so there is no subfolder to escape from and
  // no path to normalise before the containment check below.
  if (/[\\/]/.test(name)) return false;
  return LOGO_EXTENSIONS.includes(extensionOf(name));
}

/**
 * List the crests in the folder.
 *
 * Sorted case-insensitively so the picker reads alphabetically, and the default
 * is reported separately so the host does not have to know which file it is.
 */
export async function listLogos(folder: LogoFolder): Promise<LogoIndex> {
  let names: string[] = [];
  if (folder.exists) {
    try {
      const entries = await readdir(folder.dir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile() && isLogoName(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch {
      names = [];
    }
  }
  return {
    files: names,
    defaultFile: names.includes(DEFAULT_LOGO_FILE) ? DEFAULT_LOGO_FILE : null,
    dir: folder.dir,
    exists: folder.exists,
  };
}

/** Resolve a requested file name to an absolute path inside the folder, or null. */
export function resolveLogoPath(folder: LogoFolder, requested: string): string | null {
  if (!isLogoName(requested)) return null;
  const root = resolve(folder.dir);
  const target = resolve(root, normalize(requested));
  // Belt and braces: `isLogoName` already refuses separators, but a resolved
  // path outside the root is the one thing that must never be servable.
  if (isAbsolute(requested) || target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export interface LogoBytes {
  body: Buffer;
  contentType: string;
}

/**
 * Read one crest. Returns null for anything unlisted, missing, or too big --
 * a broken image is better than a failed page render on the projector.
 */
export async function readLogo(folder: LogoFolder, requested: string): Promise<LogoBytes | null> {
  const path = resolveLogoPath(folder, requested);
  if (!path) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_LOGO_BYTES) return null;
    const body = await readFile(path);
    const contentType = CONTENT_TYPES[extensionOf(requested)];
    if (!contentType) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}

/** Resolve the logos folder next to the running app, and report whether it is there. */
export async function resolveLogoFolder(candidates: string[]): Promise<LogoFolder> {
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    try {
      const info = await stat(join(dir, '.'));
      if (info.isDirectory()) return { dir, exists: true };
    } catch {
      /* try the next candidate */
    }
  }
  const dir = resolve(candidates[0] ?? 'logos');
  return { dir, exists: false };
}