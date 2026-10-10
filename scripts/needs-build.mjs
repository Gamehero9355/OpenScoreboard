/* Is the bundle in dist older than the things it is built from?
 *
 * The app runs out of dist\, so a source fix that was never built stays
 * invisible no matter how often the server is restarted. Start-Scoreboard.bat
 * calls this and rebuilds when it prints "stale".
 *
 * Exits 0 (rebuild) or 1 (up to date).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stamp = join(root, 'dist', 'client', 'index.html');
const inputs = [
  'src',
  'public',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
  'package.json',
];

function newestFile(target) {
  if (!existsSync(target)) return null;
  const stats = statSync(target);
  if (!stats.isDirectory()) return { path: target, mtimeMs: stats.mtimeMs };
  let newest = null;
  for (const entry of readdirSync(target)) {
    const found = newestFile(join(target, entry));
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
}

if (!existsSync(stamp)) {
  console.log('stale: no build yet');
  process.exit(0);
}

const builtAt = statSync(stamp).mtimeMs;
for (const input of inputs) {
  const found = newestFile(join(root, input));
  if (found && found.mtimeMs > builtAt) {
    console.log(`stale: ${relative(root, found.path)} is newer than the build`);
    process.exit(0);
  }
}

console.log('up to date');
process.exit(1);
