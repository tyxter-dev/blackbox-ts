# Parity maintenance

See the [documentation index](README.md) for current guides and historical records.

`blackbox-ts` is the canonical implementation of the Blackbox provider/runtime contracts.
For this repository, the Python repository `tyxter-dev/blackbox` is a historical reference
frozen at the recorded pin: the pin records the last parent state this repository was
synchronized against, not a source of truth that this repository must follow.

The recorded pin is `d5be68e03ca7750920569578710a2ee25d25530c` on the Python repository's
`master` branch (Python Blackbox 0.2.0). `python_reference.commit` in `docs/parity-inventory.json` is
the authoritative pin site for generators; the current machine-readable carriers listed
below are checked against it offline. Historical plans, ADRs, and release notes retain
their original baselines.

No workflow in this repository checks the Python repository out, installs Python, or runs
the bidirectional parity suite. `.github/workflows/ci.yml` runs `pnpm check` and
`pnpm pack --dry-run` on the Node/OS matrix; `.github/workflows/release.yml` runs
`pnpm check` and then publishes. A release is provable from this repository alone.

## What the score records

Schema v3 records one TypeScript feature score: **138/145 fully supported (95.2%)**.
The 145 scoped features include OpenRouter and the unsupported namespaced ToolRef row.
The status histogram is 138 `supported`, 1 `conditional`, 3 `partial`, 2 `contract` and
1 `unsupported`; only `supported` enters the numerator. The 26 verification supplements
remain checked evidence outside the denominator.

Each feature owns its TypeScript `status` and evidence references; groups organize features
without status defaults. Statuses can honestly fall below the frozen Python status. Native
features need no Python counterpart. Legacy `parent.*` and `extension.*` IDs preserve
traceability; their spelling does not determine feature ownership or score inclusion.

`python_requirements` records a disposition for every frozen catalog requirement: `adopted`
links a scoped TypeScript feature, `unsupported` retains an unsupported scored feature and a
reason, and `declined` records a reason for excluding adoption without a scored feature.
Unsupported is not an automatic scope exclusion. The baseline independently records the
144 Python catalog names/statuses, parsed from its pinned `FEATURES.md`, alongside
TypeScript-authored legacy IDs. Existing ID bindings are retained during regeneration; adopted
and unsupported requirements must map to that canonical TypeScript feature ID. TypeScript
display names and statuses remain independent. The offline checker
rejects omitted requirements, unknown dispositions and changes to those historical statuses.
The frozen Python histogram remains 137 Supported, 1 Supported where advertised, 3 Partial,
2 Contract only and 1 Not supported yet. It is compatibility evidence, not a score floor.

Crosswalk direction and fixture authority are still the existing compatibility machinery;
those changes remain separately tracked below.

## Offline checks in `pnpm check`

`pnpm check` is the CI and release gate. It runs `format:check`, `check:parity`, `typecheck`,
`typecheck:examples`, `check:api`, `lint`, `test`, and `test:package`. The steps that guard
the recorded pin are:

1. `pnpm check:parity` runs four scripts, none of which needs a Python checkout:
   - `node scripts/update-parity-inventory.mjs --check` — `docs/parity-inventory.json` is
     normalized schema v3 with authored per-feature statuses/bindings and the evidence tables from
     `scripts/lib/parity-evidence.mjs`.
   - `node scripts/check-parity-inventory.mjs` — the inventory pins a full 40-character
     commit; feature statuses and Python dispositions are valid; every frozen Python requirement
     has a disposition; scored features and supplements resolve their TypeScript source/test
     paths and symbols; native evidence needs no Python side; `docs/parent-baseline.json` is present,
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
2. `pnpm test` includes `tests/unit/parity-maintenance.test.ts`, which asserts the 145-feature/26-supplement
   split and 138 fully supported features, the 129 evidence files and 118 test modules in the baseline, the
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
2. Update `python_reference.commit` in `docs/parity-inventory.json` first. The checkout-consuming generators and
   validators refuse a checkout whose `HEAD` differs from the inventory pin, and
   `scripts/catalog-snapshot.mjs` reads the pin from the inventory, so the inventory must
   move before anything is regenerated. Register new parent paths and symbol anchors in
   `scripts/lib/parity-evidence.mjs`, update the catalog features in their owning groups, and
   record a disposition in `python_requirements` for each catalog requirement. Reclassify
   TypeScript features independently: unsupported, partial and contract-only behavior stays
   non-full until implemented. Declined adoption needs an explicit scope reason.
3. Normalize the inventory and regenerate the parent baseline. The committed baseline is
   also a regeneration input: it preserves TypeScript-owned legacy ID bindings. Restore it
   from version control if missing; Python alone cannot reconstruct those bindings.

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
   `notes` in `scripts/generate-test-crosswalk.mjs`; update TypeScript statuses honestly when
   implementation support changes.
6. Regenerate the reverse TypeScript fixture, the crosswalk, and the matrix:

   ```sh
   pnpm generate:parity:ts
   pnpm generate:parity:crosswalk -- --parent ../blackbox
   pnpm generate:parity:matrix
   ```

   If the bundled catalogs changed, regenerate their snapshot with `pnpm generate:catalog`.

7. Review the regenerated frozen catalog requirements and TypeScript score separately. Update
   expected feature/status, supplement, evidence-file, test-module, model and price counts in
   `tests/unit/parity-maintenance.test.ts` and catalog differential tests when their inputs
   change, together with this document and `CHANGELOG.md`. The checker derives the denominator
   from scoped TypeScript features rather than a fixed Python count.
8. Run `pnpm check` and `pnpm pack --dry-run`. Run
   `pnpm parity:python -- --parent ../blackbox` to prove the bidirectional fixtures against
   the checkout before requesting review.
9. In the pull request, summarize upstream commits, feature/status changes, public API
   impact, fixture changes, and any deliberately declined parent behavior.

## Deferred

- Crosswalk direction and fixture-authority inversion remain pending; the TypeScript-owned
  score and compatibility dispositions are implemented. Tracked as remaining D1 work in [blackbox-ts#2](https://github.com/tyxter-dev/blackbox-ts/issues/2).
- The Python repository's own freeze/archive posture (README banner, archival) lives
  outside this repository; this document does not assert that it is archived.
  Tracked as D2 in [blackbox#22](https://github.com/tyxter-dev/blackbox/issues/22).
