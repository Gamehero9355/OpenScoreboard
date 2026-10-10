# Linting and formatting

## What runs

```bash
npm run lint        # oxlint, read-only
npm run lint:fix    # oxlint with autofix
npm run check       # typecheck + lint + tests  (what CI runs)
```

`oxlint` is used rather than ESLint because it is a single binary, needs no
config file to be useful, and runs in well under a second on this tree. It is
configured in `.oxlintrc.json`.

## No formatter, on purpose

**Do not add Prettier (or any whole-file reformatter) to this project.**

Two tests read the *source text* rather than executing it, and both depend on
the current formatting:

- `tests/hooks.test.ts` — scans every `.tsx` in `pages/` and `components/` and
  relies on a component body being indented by two spaces (`/^ {2}\S/`). It
  exists to catch hooks after an early `return`. Reformat the tree and the
  scanner finds nothing, and the test passes **vacuously** instead of failing.
- `tests/routing.test.ts` — asserts on the exact dependency array of a `useMemo`
  in `App.tsx`, guarding a real staleness bug. A reflow breaks it for cosmetic
  reasons.

`.editorconfig` therefore pins the basics (indentation, line endings, trailing
newline) so that editors and Git do not introduce churn, and nothing more.

## Rules switched off, and why

Each of these disagrees with the established house style or the compiler
settings. They are disabled rather than "fixed", because fixing them would mean
changing correct code:

| Rule | Why it is off |
| --- | --- |
| `unicorn/no-array-sort`, `no-array-reverse` | The suggested `toSorted()` is ES2023 and `tsconfig.json` targets `ES2022`, so there is nothing to migrate to. Sorting a local array in place is deliberate throughout the engine. |
| `unicorn/no-useless-spread` | Fires on `[...arr]` used to iterate **while mutating** — see the loops in `tournament/resolve.ts` and `network/dispatch.ts`. Removing those spreads would introduce real bugs. |
| `eslint/no-shadow` | The Radball modules nest callbacks that legitimately reuse a `groupId`/`phaseId` name from the enclosing scope. |
| `unicorn/no-useless-fallback-in-spread` | `...(init?.headers ?? {})` in `frontend/lib/util.ts` needs the `??` to satisfy the type. |
| `consistent-function-scoping`, `prefer-set-has`, `prefer-add-event-listener`, `prefer-array-find`, `oxc/no-map-spread`, `prefer-string-starts-ends-with` | Stylistic; reflowing the code to satisfy them is exactly what the note above warns against. |
| `eslint/no-await-in-loop` | Ordering is load-bearing where it appears (backup rotation, sequential test setup). |
| `no-unused-vars` in `tests/` | Test fixtures legitimately name parameters for readability. |
| `no-console` | The server prints a deliberate startup banner and operator hints to the console. |

## What oxlint actually caught

Worth remembering, because these were real and are now covered by tests:

- `oxc/no-async-endpoint-handlers` on four Express routes. Express 4 does not
  catch a rejected promise from an async handler, so a failure inside one became
  an unhandled rejection instead of an error response. All async routes now go
  through the `asyncRoute` wrapper.
- `eslint/no-unsafe-optional-chaining` in a persistence test.
- `no-unreachable` — dead statements after a `throw`.

## What is still not covered

oxlint is not type-aware. `noUncheckedIndexedAccess` is the single highest-value
compiler flag still missing from both `tsconfig.json` files; the code indexes
records (`state.matches[id]`, `settings.fieldNames[0]`) constantly, so turning it
on will surface a real batch of latent `undefined` bugs. Budget the fallout
before enabling it.