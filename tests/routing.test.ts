/**
 * A `useMemo` that reads something it does not depend on.
 *
 * The route -> page switch in `App.tsx` picks between the plain competition page
 * and the 10-team one by asking whether the loaded state is a 10-team Radball
 * competition. That answer is `null` on the first paint of a cold load, because
 * the state arrives over the WebSocket a moment later.
 *
 * The memo listed only the route in its dependencies. So it computed the page
 * once, from whatever the state happened to be at that instant, and kept that
 * answer for as long as the route stayed put:
 *
 *   - clicking "Competition" from the dashboard, with the state already in hand,
 *     rendered the 10-team page;
 *   - reloading /radball rendered the plain competition page instead.
 *
 * Same URL, different site, and nothing in the log to explain it. `tests/hooks`
 * already guards a React rule the same way -- by reading the source -- so this
 * does too: no jsdom here, and the bug is in what the dependency array *says*.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(process.cwd(), 'src', 'frontend', 'App.tsx'), 'utf8');

/** The `useMemo(...)` that decides which page a route renders. */
function routePageMemo(source: string): string {
  const start = source.indexOf('const page = useMemo(');
  expect(start, 'App.tsx should still choose the page in a useMemo').toBeGreaterThan(-1);
  // Walk to the `}, [ ... ]);` that closes it.
  const end = source.indexOf(']);', start);
  return source.slice(start, end + 3);
}

/** The identifier list of the memo's dependency array. */
function dependencies(memo: string): string[] {
  const match = /\},\s*\[([^\]]*)\]\);/.exec(memo);
  expect(match, 'the route memo should end in a dependency array').not.toBeNull();
  return (match![1] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe('the route to page switch', () => {
  const memo = routePageMemo(APP);

  it('does not read the live state inside the memo', () => {
    // Reading it there is what froze the page: the value is only correct at the
    // instant the memo first ran.
    expect(memo).not.toContain('snapshot.state');
    expect(memo).not.toMatch(/\bstate\./);
  });

  it('depends on the fact it chooses on', () => {
    // The page choice turns on exactly one thing: whether this is a 10-team
    // competition. That fact has to be a dependency, or the memo can answer a
    // question with stale information.
    const deps = dependencies(memo);
    expect(deps.length).toBeGreaterThan(0);
    const tenTeamDerived = /const\s+(\w+)\s*=\s*isTenTeamFormat\(snapshot\.state\);/.exec(APP);
    expect(tenTeamDerived, 'App.tsx should derive isTenTeamFormat outside the memo').not.toBeNull();
    expect(deps).toContain(tenTeamDerived![1]);
  });

  it('keys on the route as well as the format', () => {
    expect(dependencies(memo)).toContain('route.path');
  });

  it('keys on the boolean rather than the state object', () => {
    // Depending on the state object itself would rebuild the whole page tree on
    // every score and throw the memo away entirely.
    expect(dependencies(memo)).not.toContain('snapshot.state');
    expect(dependencies(memo)).not.toContain('state');
  });
});