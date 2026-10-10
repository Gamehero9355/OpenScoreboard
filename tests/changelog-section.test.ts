/**
 * The release notes for one version.
 *
 * The release workflow publishes whatever `changelog-section.mjs` prints, so a
 * missing or wrong section becomes a published release with the wrong body, and
 * the only place that shows is the download page. The two directions are pinned
 * here: a matching section comes out whole, and anything else stops the release
 * instead of shipping an empty one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/changelog-section.mjs', import.meta.url));
const repositoryChangelog = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle */
    }
  }
});

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-changelog-'));
  dirs.push(dir);
  const file = join(dir, 'CHANGELOG.md');
  writeFileSync(file, contents);
  return file;
}

function runChangeLog(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('release notes from the changelog', () => {
  it('takes the section body out of the real repository changelog', () => {
    const result = runChangeLog('v1.0.0', repositoryChangelog);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/First release\./);
    // The heading is the release title, not part of the body.
    expect(result.stdout).not.toMatch(/## \[1\.0\.0\]/);
    expect(result.stdout).not.toMatch(/Unreleased/);
  });

  it('accepts a bare version as well as a tag, so a manual run behaves the same', () => {
    const tagged = runChangeLog('v1.0.0', repositoryChangelog);
    const bare = runChangeLog('1.0.0', repositoryChangelog);
    expect(bare.stdout).toBe(tagged.stdout);
    expect(bare.status).toBe(0);
  });

  it('keeps sub-headings and stops before the next version, so nothing older leaks in', () => {
    const file = fixture(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '- still being written',
        '',
        '## [1.2.0] - 2026-10-10',
        '',
        '### Added',
        '',
        '- a new thing',
        '',
        '### Fixed',
        '',
        '- a repaired thing',
        '',
        '## [1.1.0]',
        '',
        '- the previous release',
        '',
      ].join('\n'),
    );
    const result = runChangeLog('v1.2.0', file);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/### Added/);
    expect(result.stdout).toMatch(/- a new thing/);
    expect(result.stdout).toMatch(/### Fixed/);
    expect(result.stdout).toMatch(/- a repaired thing/);
    expect(result.stdout).not.toMatch(/still being written/);
    expect(result.stdout).not.toMatch(/the previous release/);
    expect(result.stdout).not.toMatch(/## \[1\.2\.0\]/);
  });

  it('matches a heading that carries a compare link, which is how link-carrying changelogs write it', () => {
    const file = fixture(
      [
        '## [1.2.0](https://github.com/owner/repo/compare/v1.1.0...v1.2.0)',
        '',
        '- a new thing',
        '',
        '## [1.1.0]',
        '',
        '- older',
        '',
      ].join('\n'),
    );
    const result = runChangeLog('v1.2.0', file);
    expect(result.status).toBe(0);
    // `console.log` closes the body with a newline; the body itself is one line.
    expect(result.stdout.trimEnd()).toBe('- a new thing');
  });

  it('reads a file checked out with CRLF endings, which is what Windows does here', () => {
    const file = fixture(
      ['## [1.2.0]', '', '### Added', '', '- a new thing', '', '## [1.1.0]', '', '- older', ''].join(
        '\r\n',
      ),
    );
    const result = runChangeLog('v1.2.0', file);
    expect(result.status).toBe(0);
    // No carriage return may survive into the release notes.
    expect(result.stdout).not.toMatch(/\r/);
    expect(result.stdout.trimEnd()).toBe('### Added\n\n- a new thing');
  });

  it('stops the release when the version has no section at all', () => {
    const result = runChangeLog('v9.9.9', repositoryChangelog);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/No "## \[9\.9\.9\]" section/);
    // The message has to say what to do about it, not only what is wrong.
    expect(result.stderr).toMatch(/Unreleased/);
  });

  it('does not treat "Unreleased" as a version', () => {
    const result = runChangeLog('Unreleased', repositoryChangelog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No "## \[Unreleased\]" section/);
  });

  it('refuses an empty section, so the release cannot carry no notes', () => {
    const file = fixture(['## [1.2.0]', '', '## [1.1.0]', '', '- older', ''].join('\n'));
    const result = runChangeLog('v1.2.0', file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/empty/);
  });

  it('names the file it could not read instead of printing nothing', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'tsb-changelog-missing-')), 'CHANGELOG.md');
    const result = runChangeLog('v1.0.0', missing);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Could not read/);
  });

  it('explains itself when called without a version', () => {
    const result = runChangeLog();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage: node scripts\/changelog-section\.mjs/);
  });
});
