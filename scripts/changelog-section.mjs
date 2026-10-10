/* The release notes for one version, taken from the changelog.
 *
 * The release workflow runs this and fails when it prints nothing. Tagging a
 * version whose entries are still sitting under "## [Unreleased]" is an easy
 * mistake, and what it produces is a published release with an empty body: a
 * download page that explains nothing, which nobody notices until someone asks
 * what changed. Failing the release is cheaper than publishing that.
 *
 *   node scripts/changelog-section.mjs v1.2.0 [path/to/CHANGELOG.md]
 *
 * Prints the section body on stdout -- sub-headings and all, without the "##"
 * heading itself -- or exits non-zero with the reason on stderr.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const H2 = /^##\s+(\S.*?)\s*$/;

/**
 * The version a `##` heading names, or null when it names none.
 *
 * A heading without a version ("## Unreleased", "## Notes") still ends the
 * section above it, so this returns null rather than throwing: the caller only
 * compares against it, it never skips past one.
 *
 * Shapes accepted, all of which turn up in Keep-a-Changelog files:
 *   ## [1.0.0]
 *   ## [1.0.0] - 2026-10-10
 *   ## [1.0.0](https://github.com/<repo>/compare/v0.9.0...v1.0.0)
 *   ## 1.0.0 - 2026-10-10
 */
function headingVersion(text) {
  const bracketed = /^\[([^\]]*)\]/.exec(text);
  const candidate = (bracketed ? bracketed[1] : text).trim();
  const found = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(candidate);
  return found ? found[0].replace(/^v/, '') : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [requested, fileArgument] = process.argv.slice(2);
if (!requested) {
  fail('Usage: node scripts/changelog-section.mjs <version|tag> [changelog]');
}
// A tag is `v1.2.0`; the heading is `[1.2.0]`. Accept either.
const wanted = requested.replace(/^v/, '');
const changelog = fileArgument
  ? resolve(fileArgument)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

let contents;
try {
  contents = readFileSync(changelog, 'utf8');
} catch (error) {
  fail(`Could not read ${changelog}: ${error instanceof Error ? error.message : String(error)}`);
}

// Split on optional carriage returns on purpose: a Windows checkout (and this
// repository's own `* text=auto`) hands the file CRLF endings, and a heading
// that ends in "\r" would never match without this.
const lines = contents.split(/\r?\n/);
let from = -1;
let to = lines.length;
for (let index = 0; index < lines.length; index += 1) {
  const heading = H2.exec(lines[index]);
  if (!heading) continue;
  if (from === -1) {
    if (headingVersion(heading[1]) === wanted) from = index + 1;
    continue;
  }
  // The next `##` heading ends this section, whether or not it is a version.
  to = index;
  break;
}

if (from === -1) {
  fail(
    `No "## [${wanted}]" section in the changelog. Move this version's entries out of ` +
      '"## [Unreleased]" into their own section, then tag again.',
  );
}

const body = lines.slice(from, to).join('\n').trim();
if (body.length === 0) {
  fail(`The "## [${wanted}]" section is empty, so the release would carry no notes.`);
}

console.log(body);
