/**
 * The launcher's build check.
 *
 * Start-Scoreboard.bat decides whether to rebuild from this script's exit code:
 * zero means "up to date", anything else means "rebuild". The contract used to
 * be the other way round, which made a crash inside the check (exit 1, like
 * "up to date") leave the launcher starting a server whose `dist/` did not
 * exist. The direction is pinned here because the failure it prevents is
 * silent: the .bat is the one entry point CI never runs.
 *
 * The script locates its project from its own file location, so every case
 * copies it into a throwaway project rather than pointing it somewhere else.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/needs-build.mjs', import.meta.url));

function scaffoldProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'tsb-needs-build-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'needs-build.mjs'));
  writeFileSync(join(root, 'package.json'), '{}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
  return root;
}

/** Write the build stamp (dist/client/index.html) with a chosen timestamp. */
function markBuilt(root: string, when: Date): void {
  mkdirSync(join(root, 'dist', 'client'), { recursive: true });
  const stamp = join(root, 'dist', 'client', 'index.html');
  writeFileSync(stamp, '<!doctype html>\n');
  utimesSync(stamp, when, when);
}

function runCheck(root: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'needs-build.mjs')], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

describe('needs-build exit codes', () => {
  it('asks for a build when there is no dist, because that is what the launcher must act on', () => {
    const result = runCheck(scaffoldProject());
    expect(result.stdout).toMatch(/stale: no build yet/);
    expect(result.status).not.toBe(0);
  });

  it('reports a current build as up to date with exit code 0', () => {
    const root = scaffoldProject();
    markBuilt(root, new Date(Date.now() + 60_000));
    const result = runCheck(root);
    expect(result.stdout).toMatch(/up to date/);
    expect(result.status).toBe(0);
  });

  it('asks for a rebuild when a source file is newer than the build', () => {
    const root = scaffoldProject();
    markBuilt(root, new Date(Date.now() - 60_000));
    const result = runCheck(root);
    expect(result.stdout).toMatch(/stale: .*src.* is newer than the build/);
    expect(result.status).not.toBe(0);
  });
});
