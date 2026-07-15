# Python parity maintenance

`blackbox-ts` measures parent parity against an immutable checkout of
`tyxter-dev/blackbox`. The current baseline is
`f27decbc9aeaae972c5bbeb256c70450b7fe393a` on the Python repository's `master`
branch.

The score has three deliberately separate sets:

- 143 features from the Python `FEATURES.md` catalog;
- 26 verification supplements for shipped Python behavior outside that catalog;
- TypeScript extensions, currently OpenRouter, which run shared contracts but never count
  toward the Python score.

## Automated checks

`pnpm check:parity` is offline. It validates the inventory schema and stable IDs, TypeScript
evidence paths and symbols, the generated matrix, and the committed 108-module test
crosswalk.

The pinned-parent suite requires an explicit Python checkout:

```sh
pnpm parity:python -- --parent ../blackbox
```

That command builds TypeScript and then proves all of the following:

1. the checkout is exactly the pinned commit;
2. the recorded parent tree, evidence files, symbols, and test modules are unchanged;
3. Python regenerates the committed core, provider, model-catalog, and pricing fixtures
   byte-for-byte;
4. TypeScript regenerates its reverse fixtures byte-for-byte;
5. the pinned Python serializers accept and round-trip the TypeScript fixtures;
6. every Python test module remains represented in the crosswalk.

The normal TypeScript tests replay the Python provider protocol fixtures through the
fetch-first OpenAI, Anthropic, Gemini, and xAI adapters. They also compare all 19 bundled
models and 21 bundled price entries to Python-generated data.

## Drift detection

`.github/workflows/parity-drift.yml` compares the pinned commit with the Python default
branch each Monday and on manual dispatch. Drift is reported as a failing check with a JSON
artifact and changed-file summary. It never modifies this repository, opens a baseline PR,
or changes the score automatically.

Run the same read-only comparison locally with:

```sh
pnpm parity:drift -- --fail-on-drift
```

## Intentional baseline update

A parent bump must be its own reviewed pull request. Never update only the SHA or accept
generated fixture changes without reviewing the Python implementation and tests.

1. Fetch the Python repository and check out the exact candidate commit in a clean worktree.
2. Review every upstream commit and changed file since the pinned baseline. Pay particular
   attention to `FEATURES.md`, public contracts, serialization, provider adapters, bundled
   catalogs, and tests.
3. Update `parent.commit` in `docs/parity-inventory.json` and the pinned checkout refs in
   `.github/workflows/ci.yml` and `.github/workflows/release.yml`. Update
   `scripts/lib/parity-evidence.mjs` when paths or symbol anchors changed. The offline parity
   check rejects workflow refs that do not match the inventory.
4. Normalize the inventory and regenerate the immutable parent baseline:

   ```sh
   pnpm generate:parity:inventory
   pnpm parity:update-parent-baseline -- --parent ../blackbox
   ```

5. Reclassify every changed or added Python feature honestly. Unsupported, partial, and
   contract-only behavior must remain non-full until both implementations support it.
6. Regenerate the Python fixtures, reverse TypeScript fixture, crosswalk, and matrix:

   ```sh
   pnpm generate:parity:python -- --parent ../blackbox
   pnpm generate:parity:ts
   pnpm generate:parity:crosswalk -- --parent ../blackbox
   pnpm generate:parity:matrix
   ```

7. Implement only behavior established by the new Python baseline. Add or update ordinary
   TypeScript tests alongside the cross-language fixtures.
8. Run `pnpm parity:python -- --parent ../blackbox`, `pnpm check`, and
   `pnpm pack --dry-run` before requesting review.
9. In the pull request, summarize upstream commits, feature/status changes, public API
   impact, fixture changes, and any deliberately deferred parent behavior.

The baseline update is complete only when the bidirectional suite, ordinary CI matrix, and
package checks are green.
