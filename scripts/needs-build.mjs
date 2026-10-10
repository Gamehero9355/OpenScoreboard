/* Is the bundle in dist older than the things it is built from?
 *
 * The app runs out of dist\, so a source fix that was never built stays
 * invisible no matter how often the server is restarted. Start-Scoreboard.bat
 * calls this and rebuilds when it prints "stale".
 *
 * Exits 0 (up to date) or non-zero (rebuild). Non-zero is also what a crash
 * exits with, which is the safe direction: a check that cannot run rebuilds
 * the app instead of leaving the launcher to start a server whose dist\ does
 * not exist.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import.meta.dirname`: that needs Node 20.11, and the launcher runs this
// check before the Node version it recommends is known to be installed. The
// URL form works on every release the app can start on at all.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = join(root, 'dist', 'client', 'index.html');
const inputs = [
  'src',
  'public',
  'index.html',
  'vite.config.mts',
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
  process.exit(1);
}

const builtAt = statSync(stamp).mtimeMs;
for (const input of inputs) {
  const found = newestFile(join(root, input));
  if (found && found.mtimeMs > builtAt) {
    console.log(`stale: ${relative(root, found.path)} is newer than the build`);
    process.exit(1);
  }
}

console.log('up to date');
process.exit(0);
