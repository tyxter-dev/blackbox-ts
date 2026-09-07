# Parity maintenance

`blackbox-ts` is the canonical implementation of the Blackbox provider/runtime contracts.
For this repository, the Python repository `tyxter-dev/blackbox` is a historical reference
frozen at the recorded pin: the pin records the last parent state this repository was
synchronized against, not a source of truth that this repository must follow.

The recorded pin is `d5be68e03ca7750920569578710a2ee25d25530c` on the Python repository's
`master` branch (Python Blackbox 0.2.0). `parent.commit` in `docs/parity-inventory.json` is
the authoritative pin site for generators; the current machine-readable carriers listed
below are checked against it offline. Historical plans, ADRs, and release notes retain
their original baselines.

No workflow in this repository checks the Python repository out, installs Python, or runs
the bidirectional parity suite. `.github/workflows/ci.yml` runs `pnpm check` and
`pnpm pack --dry-run` on the Node/OS matrix; `.github/workflows/release.yml` runs
`pnpm check` and then publishes. A release is provable from this repository alone.

## What the score records

The parity score keeps three deliberately separate sets, all at the recorded pin:

- 144 features from the Python `FEATURES.md` catalog (137 `Supported`, 1
  `Supported where advertised`, 3 `Partial`, 2 `Contract only`, 1 `Not supported yet`);
- 26 verification supplements for shipped Python behavior outside that catalog;
- TypeScript extensions, currently OpenRouter, which run shared contracts but never count
  toward the score.

The inventory vocabulary is unchanged this cycle: `parent_status` is the status the pinned
Python commit shipped for a group and `target_status` is the TypeScript status. Canonicality
is expressed by the direction lock in `scripts/check-parity-inventory.mjs`: the TypeScript
status may equal or exceed the pinned parent status (ranked
`Not supported yet` < `Contract only` < `Partial` < `Supported where advertised` <
`Supported`) but never fall below it, and unknown statuses are rejected. The full scoring
inversion (crosswalk direction, fixture goldenness swap, extension-to-declined-parent-feature
semantics, a single TypeScript-owned score) is deferred; see "Deferred" below.

## Offline checks in `pnpm check`

`pnpm check` is the CI and release gate. It runs `format:check`, `check:parity`, `typecheck`,
`typecheck:examples`, `check:api`, `lint`, `test`, and `test:package`. The steps that guard
the recorded pin are:

1. `pnpm check:parity` runs four scripts, none of which needs a Python checkout:
   - `node scripts/update-parity-inventory.mjs --check` — `docs/parity-inventory.json` is
     normalized schema v2 with stable feature ids and the evidence tables from
     `scripts/lib/parity-evidence.mjs`.
   - `node scripts/check-parity-inventory.mjs` — the inventory pins a full 40-character
     commit; it holds exactly 144 parent features and 26 supplements with the expected
     status histogram; the direction lock above; every evidence record resolves its
     TypeScript source/test paths and symbols; `docs/parent-baseline.json` is present,
     records the same commit and repository, and lists every parent evidence path; and the
     pin is repeated verbatim in `docs/parity-test-crosswalk.json`,
     `docs/catalog-snapshot.json`, `tests/fixtures/python/core-contracts.json`,
     `tests/fixtures/python/catalogs.json`, `tests/fixtures/python/provider-differential.json`
     (`parent_commit`), and `tests/fixtures/typescript/core-contracts.json`
     (`target_parent_commit`). A missing carrier fails the check.
   - `node scripts/generate-parity-matrix.mjs --check` — `docs/PARITY_MATRIX.md` is
     byte-identical to the rendering of the inventory.
   - `node scripts/generate-test-crosswalk.mjs --check` — `docs/parity-test-crosswalk.json`
     is byte-identical to the crosswalk derived from the baseline's 118 Python test modules
     and the inventory, every mapped TypeScript test file exists, and every divergence note
     names a recorded parent module.
2. `pnpm test` includes `tests/unit/parity-maintenance.test.ts`, which asserts the 144/26
   feature split, the 129 evidence files and 118 test modules in the baseline, the
   29 models and 36 price entries in the Python catalog fixture, and that the baseline,
   crosswalk, and both fixture directions carry the inventory pin. The golden suites
   `tests/golden/core-contracts.test.ts`, `tests/golden/python-provider-differential.test.ts`,
   and `tests/golden/python-catalog-differential.test.ts` replay the committed Python
   fixtures through the TypeScript contracts, the fetch-first OpenAI, Anthropic, Gemini, and
   xAI adapters, and the bundled catalogs.
3. `pnpm test:package` runs `node scripts/catalog-snapshot.mjs --check`, which regenerates
   `docs/catalog-snapshot.json` from the built bundled catalogs stamped with the inventory
   pin and fails when the committed snapshot differs.

`format:check` covers non-ignored JSON and Markdown artifacts; the matrix and catalog
snapshot are excluded by `.prettierignore` and checked by their generators. The remaining steps
(`typecheck`, `typecheck:examples`, `check:api`, `lint`) are not parity checks.

## Optional local tools

Both tools below are manual. No CI or release workflow schedules or requires them.
A baseline-update review can require the bidirectional suite as described below.

### Bidirectional suite

`pnpm parity:python -- --parent <checkout>` needs a Python checkout whose `HEAD` is exactly
the recorded pin (the checkout-consuming scripts refuse any other commit). It builds
TypeScript and then runs:

1. `scripts/update-parent-baseline.mjs --check` — the recorded parent tree, evidence files,
   symbols, and test modules are unchanged;
2. `scripts/generate-python-fixtures.mjs --check` — the pinned Python code regenerates the
   committed core, provider, model-catalog, and pricing fixtures byte-for-byte;
3. `scripts/generate-test-crosswalk.mjs --check` with checkout validation — the tracked
   Python test modules still match the baseline;
4. `scripts/generate-typescript-fixtures.mjs --check` — TypeScript regenerates its reverse
   fixture byte-for-byte;
5. `scripts/validate-typescript-fixtures.mjs` — the pinned Python serializers accept and
   round-trip the TypeScript fixture.

The Python steps use the interpreter named by the `PYTHON` environment variable
(`python` on Windows, `python3` elsewhere by default). The committed Python fixture bytes
were generated under Python 3.11;
regenerate under 3.11 to reproduce them byte-for-byte.

### Drift report

`pnpm parity:drift` compares the recorded pin with the Python repository's default branch
through the GitHub API (read-only; `GITHUB_TOKEN` is optional, `--output <file>` writes the
JSON report). Parent movement alone does not fail the script by default and affects no
automated CI or release gate. Pass `--fail-on-drift` to opt into a non-zero exit on drift.
API or report-writing failures still fail the command. No workflow runs this script.

## Bumping the recorded pin

A pin bump is a downstream synchronization: it imports parent behavior that this repository
chooses to adopt and re-records the parent state the artifacts were generated from. It must
be its own reviewed pull request; never update only the SHA or accept generated fixture
changes without reviewing the Python implementation and tests. Use the following procedure for a future sync.

1. Obtain a read-only checkout of the Python repository at the candidate commit (for
   example `../blackbox`). Review every upstream commit and changed file since the recorded
   pin, paying particular attention to `FEATURES.md`, public contracts, serialization,
   provider adapters, bundled catalogs, and tests.
2. Update `parent.commit` in `docs/parity-inventory.json` first. The checkout-consuming generators and
   validators refuse a checkout whose `HEAD` differs from the inventory pin, and
   `scripts/catalog-snapshot.mjs` reads the pin from the inventory, so the inventory must
   move before anything is regenerated. Register new parent paths and symbol anchors in
   `scripts/lib/parity-evidence.mjs`, update the catalog features in their owning groups, and
   set `catalog_unique_feature_count` in `docs/parity-inventory.json` to the resulting parent
   feature count before regeneration. Reclassify changed features honestly: unsupported, partial, and contract-only behavior
   stays non-full until the TypeScript implementation supports it, and the direction lock
   still applies.
3. Normalize the inventory and regenerate the parent baseline:

   ```sh
   pnpm generate:parity:inventory
   pnpm parity:update-parent-baseline -- --parent ../blackbox
   ```

4. Regenerate the Python fixtures under Python 3.11. The generator honours `PYTHON`; the
   0.2.0 sync used a `uv`-managed interpreter:

   ```sh
   PYTHON=$(~/.local/bin/uv python find 3.11) pnpm generate:parity:python -- --parent ../blackbox
   ```

5. Port the adopted behavior and any bundled model/pricing changes in `src/`, with
   ordinary TypeScript tests alongside the cross-language fixtures, before generating
   artifacts from the TypeScript implementation. Record deliberate divergences as crosswalk
   `notes` in `scripts/generate-test-crosswalk.mjs`, not as status changes.
6. Regenerate the reverse TypeScript fixture, the crosswalk, and the matrix:

   ```sh
   pnpm generate:parity:ts
   pnpm generate:parity:crosswalk -- --parent ../blackbox
   pnpm generate:parity:matrix
   ```

   If the bundled catalogs changed, regenerate their snapshot with `pnpm generate:catalog`.

7. Move every hard-coded count: `catalog_unique_feature_count` in
   `docs/parity-inventory.json` (updated in step 2); the feature and status histogram in
   `scripts/check-parity-inventory.mjs`; the feature, supplement, evidence-file,
   test-module, model, and price counts in `tests/unit/parity-maintenance.test.ts`; the
   model and price counts in `tests/golden/python-catalog-differential.test.ts`; this
   document; and `CHANGELOG.md`.
8. Run `pnpm check` and `pnpm pack --dry-run`. Run
   `pnpm parity:python -- --parent ../blackbox` to prove the bidirectional fixtures against
   the checkout before requesting review.
9. In the pull request, summarize upstream commits, feature/status changes, public API
   impact, fixture changes, and any deliberately declined parent behavior.

## Deferred

- Full parity-scoring inversion (crosswalk direction, fixture goldenness swap,
  extension-to-declined-parent-feature semantics, a single TypeScript-owned score).
  Until it lands, the inventory vocabulary still reads Python-first.
  Tracked as D1 in [blackbox-ts#2](https://github.com/tyxter-dev/blackbox-ts/issues/2).
- The Python repository's own freeze/archive posture (README banner, archival) lives
  outside this repository; this document does not assert that it is archived.
  Tracked as D2 in [blackbox#22](https://github.com/tyxter-dev/blackbox/issues/22).
