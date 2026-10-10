/**
 * The logos folder.
 *
 * The security-relevant half is that this is a route which reads whatever file
 * a host has put in a folder and hands it back over the app's own origin. These
 * tests pin the rules that make that safe, because a regression here is a file
 * disclosure rather than a layout bug.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOGO_FILE,
  listLogos,
  readLogo,
  resolveLogoFolder,
  resolveLogoPath,
  type LogoFolder,
} from '../src/backend/net/logos';

const dirs: string[] = [];

async function folderWith(files: Record<string, string>): Promise<LogoFolder> {
  const dir = await mkdtemp(join(tmpdir(), 'tsb-logos-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return { dir, exists: true };
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('logo folder', () => {
  it('lists only image files, case-insensitively sorted', async () => {
    const folder = await folderWith({
      'Zebra.png': 'x',
      'nord.svg': '<svg/>',
      'notes.txt': 'not a logo',
      'archive.zip': 'x',
      // Hidden and dotfiles are never crests, however they are named.
      '.hidden.png': 'x',
    });
    const index = await listLogos(folder);
    expect(index.files).toEqual(['nord.svg', 'Zebra.png']);
    expect(index.exists).toBe(true);
  });

  it('reports the default crest only when the folder actually has it', async () => {
    const withDefault = await folderWith({ [DEFAULT_LOGO_FILE]: '<svg/>', 'a.png': 'x' });
    expect((await listLogos(withDefault)).defaultFile).toBe(DEFAULT_LOGO_FILE);

    const without = await folderWith({ 'a.png': 'x' });
    expect((await listLogos(without)).defaultFile).toBeNull();
  });

  it('says so when there is no folder at all, rather than pretending it is empty', async () => {
    const missing = await resolveLogoFolder([join(tmpdir(), 'tsb-logos-does-not-exist-xyz')]);
    expect(missing.exists).toBe(false);
    const index = await listLogos(missing);
    expect(index.files).toEqual([]);
    expect(index.defaultFile).toBeNull();
  });

  it('picks the first candidate folder that exists', async () => {
    const real = await folderWith({ 'a.png': 'x' });
    const resolved = await resolveLogoFolder([join(tmpdir(), 'tsb-nope-xyz'), real.dir]);
    expect(resolved.exists).toBe(true);
    expect(resolved.dir).toBe(real.dir);
  });

  it('refuses any name that is not a bare image file name', async () => {
    const folder = await folderWith({ 'nord.png': 'x' });
    // Every one of these would read a file the app has no business serving.
    for (const name of [
      '../access.json',
      '../../data/access.json',
      'sub/dir.png',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '..',
      '.',
      'access.json',
      'run.sh',
      '',
      ' .png',
    ]) {
      expect(resolveLogoPath(folder, name), `must refuse ${JSON.stringify(name)}`).toBeNull();
    }
    expect(resolveLogoPath(folder, 'nord.png')).toBe(join(folder.dir, 'nord.png'));
  });

  it('serves a listed image and nothing else', async () => {
    const folder = await folderWith({ 'nord.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    const logo = await readLogo(folder, 'nord.svg');
    expect(logo?.contentType).toBe('image/svg+xml');
    expect(logo?.body.toString()).toContain('<svg');
    expect(await readLogo(folder, '../access.json')).toBeNull();
    expect(await readLogo(folder, 'missing.png')).toBeNull();
  });

  it('refuses a file that is too large to be a crest', async () => {
    const folder = await folderWith({});
    await writeFile(join(folder.dir, 'huge.png'), Buffer.alloc(2_000_001));
    expect(await readLogo(folder, 'huge.png')).toBeNull();
  });
});