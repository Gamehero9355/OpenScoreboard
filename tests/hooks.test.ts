import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = join(process.cwd(), 'src', 'frontend', 'pages');
const COMPONENTS = join(process.cwd(), 'src', 'frontend', 'components');

interface Violation {
  file: string;
  line: number;
  hook: string;
  guardLine: number;
  guard: string;
}

/**
 * Find a `use…()` called after a top-level early `return` in a component.
 *
 * React requires the same hooks in the same order on every render. A component
 * that returns early before one of its hooks runs fewer of them on that render,
 * and React tears the entire tree down with "rendered fewer hooks than
 * expected" (#310) -- the page renders nothing at all, with no error in the
 * server log and nothing but a background on screen.
 *
 * HostPage had exactly this and the host dashboard was a blank page whenever it
 * was opened before the tournament state arrived. The scan relies on the
 * house style: a component body is indented by two spaces, so anything at that
 * column is a top-level statement rather than something inside a callback.
 */
function detect(file: string, source: string): Violation[] {
  const lines = source.split(/\r?\n/);
  const out: Violation[] = [];
  let inComponent = false;
  let guardReturnLine = -1;
  let guardText = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(export )?function [A-Z]\w*\(/.test(line)) {
      inComponent = true;
      guardReturnLine = -1;
      guardText = '';
      continue;
    }
    if (!inComponent) continue;
    if (/^\}/.test(line)) {
      inComponent = false;
      continue;
    }

    // An early return at the component's top level, in either shape:
    //   if (!state) {  /  return <X>;  /  }
    //   if (!state) return <X>;
    // Both are common in this tree -- there are well over a hundred single-line
    // guards -- and both put every hook below them in the wrong order, so both
    // have to be recognised. A guard inside a nested block is three or more
    // spaces deep and does not match, which is what keeps a callback's own
    // early return out of this.
    if (guardReturnLine === -1 && /^ {2}if \(.*\)\s*\{\s*$/.test(line)) {
      if ((lines[i + 1] ?? '').trim().startsWith('return')) {
        guardReturnLine = i + 2;
        guardText = line.trim();
      }
      continue;
    }
    if (guardReturnLine === -1 && /^ {2}if \(.*\)\s+return\b/.test(line)) {
      guardReturnLine = i + 1;
      guardText = line.trim();
      continue;
    }
    if (guardReturnLine === -1) continue;

    // A hook at the component's top level, however it is bound.
    //
    // The leading `(?:.*\s)?` matters: the previous pattern started with `\S`,
    // which consumed the first character of the line and so could only ever see
    // a hook that had something *before* it. A line that is nothing but a hook
    // call -- `useA();`, `useEffect(() => {}, []);` -- was invisible, and that is
    // the shape a lone destructured `useLive()` takes at the top of a component.
    // Requiring a word boundary still excludes `userName`, and the leading
    // pattern now excludes `something.useThing()` and `a.b.useHook()` as well,
    // which the old one wrongly reported.
    // `(?!\s)` after the two spaces is what keeps this to the component's own
    // top level: without it the leading `.*\s` can swallow the extra indentation
    // of a nested block and report a hook that belongs to a callback.
    const match = /^ {2}(?!\s)(?:.*\s)?\b(use[A-Z]\w*)\(/.exec(line);
    if (match) {
      out.push({
        file,
        line: i + 1,
        hook: match[1],
        guardLine: guardReturnLine,
        guard: guardText,
      });
    }
  }
  return out;
}

function scanDir(dir: string): Violation[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tsx'))
    .flatMap((name) => detect(name, readFileSync(join(dir, name), 'utf8')));
}

describe('rules of hooks', () => {
  it('no page calls a hook after a top-level early return', () => {
    // Named in the failure so the offending component is obvious.
    expect(scanDir(PAGES)).toEqual([]);
  });

  it('no component calls a hook after a top-level early return', () => {
    expect(scanDir(COMPONENTS)).toEqual([]);
  });

  it('flags a hook that follows a guard, the way HostPage did', () => {
    const broken = [
      'export function Demo() {',
      '  const [a, setA] = useState(0);',
      '  if (!ready) {',
      '    return null;',
      '  }',
      '  const onClick = useCallback(() => setA(1), []);',
      '  return onClick;',
      '}',
    ].join('\n');
    const hits = detect('Demo.tsx', broken);
    expect(hits).toHaveLength(1);
    expect(hits[0].hook).toBe('useCallback');
    expect(hits[0].guard).toBe('if (!ready) {');
  });

  it('accepts the same component with the hook hoisted above the guard', () => {
    const fixed = [
      'export function Demo() {',
      '  const [a, setA] = useState(0);',
      '  const onClick = useCallback(() => setA(1), []);',
      '  if (!ready) {',
      '    return null;',
      '  }',
      '  return onClick;',
      '}',
    ].join('\n');
    expect(detect('Demo.tsx', fixed)).toEqual([]);
  });

  /**
   * The one-line early return.
   *
   * `if (!ready) return null;` is the more common shape and was invisible to
   * the scan above -- it only recognised a brace on the `if` line and a `return`
   * on the next. There are around 120 of these in the tree, so the guard was
   * quietly covering a minority of the real cases. Written on the same regexes
   * the scanner uses, so a change to either shows up here.
   */
  it('flags a hook after a single-line early return', () => {
    const broken = [
      'export function Demo() {',
      '  const [a, setA] = useState(0);',
      '  if (!ready) return null;',
      '  const onClick = useCallback(() => setA(1), []);',
      '  return onClick;',
      '}',
    ].join('\n');
    const hits = detect('Demo.tsx', broken);
    expect(hits).toHaveLength(1);
    expect(hits[0].hook).toBe('useCallback');
  });

  it('flags a hook after either shape of early return', () => {
    // The point of the guard is that it does not matter how the host wrote the
    // early return; the rules-of-hooks violation is the same.
    const single = detect(
      'Demo.tsx',
      ['export function D() {', '  if (!x) return null;', '  useA();', '  return null;', '}'].join('\n'),
    );
    const braced = detect(
      'Demo.tsx',
      ['export function D() {', '  if (!x) {', '    return null;', '  }', '  useA();', '  return null;', '}'].join('\n'),
    );
    expect(single).toHaveLength(1);
    expect(braced).toHaveLength(1);
  });

  it('ignores hooks that are not at the top level of a component', () => {
    // A hook inside a nested callback is a different component's business and
    // must not trip the scan.
    const nested = [
      'export function Demo() {',
      '  const [a, setA] = useState(0);',
      '  if (!ready) {',
      '    return null;',
      '  }',
      '  const onClick = () => {',
      '    const other = useThing();',
      '    setA(other);',
      '  };',
      '  return onClick;',
      '}',
    ].join('\n');
    expect(detect('Demo.tsx', nested)).toEqual([]);
  });
});
