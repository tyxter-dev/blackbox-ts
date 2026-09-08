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
the optional Python compatibility suite. `.github/workflows/ci.yml` runs `pnpm check` and
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

## Canonical expectations and compatibility evidence

`tests/fixtures/typescript/core-contracts.json` is generated from fixed native inputs in
`tests/fixtures/typescript/build-core-fixture.ts`. It carries TypeScript authority without a
Python pin or `_kind` tags. `pnpm generate:parity:ts` deliberately updates the expectations;
review the diff before accepting it. The generator loads current source through the existing
Vite dev dependency with HTTP/WebSocket listeners and file watching disabled, then closes the
loader. It does not depend on a previous `dist` build.

`tests/golden/core-contracts.test.ts` compares current output with committed expectations,
replays constructors and durable serialization, and pins explicit configuration/output/error
semantics, pricing components and native package round trips. Frozen Python samples remain
under `tests/fixtures/python`; `tests/compatibility` replays their adopted contracts offline.
Those samples do not define the TypeScript score or canonical fixture values.

The schema-v2 test crosswalk enumerates `tests/**/*.test.ts`, matching Vitest's executable-test
pattern, including new files before staging. Its `entries` list TypeScript tests first with
Python mappings or explicit N/A reasons. `python_compatibility` retains all 118 frozen Python
module dispositions and divergence notes. `feature_coverage` follows the 145 scoped TypeScript
features. Currently 33 TypeScript test files are listed; enumeration is not a claim that gated
smoke tests ran. A new test without a mapping or explicit N/A reason fails generation.

## Offline checks in `pnpm check`

`pnpm check` runs formatting, `check:parity`, source/example typechecks, public API checking,
ESLint, Vitest and package verification. No Python interpreter or checkout is required.
`pnpm check:parity` runs five checks:

1. Normalize inventory schema v3 and evidence definitions without rewriting authored status
   or feature bindings.
2. Validate TypeScript statuses, evidence and complete frozen Python dispositions. The baseline
   must share the pin and repository, retain legacy-ID bindings and contain Python evidence paths.
3. Compare the feature matrix with deterministic rendering of the inventory.
4. Compare the TypeScript-first crosswalk with current executable tests and frozen mappings.
5. Compare the canonical TypeScript fixture with current-source generation, without rewriting it.

The pin checker covers `docs/parent-baseline.json`, the crosswalk's `python_reference_commit`,
`docs/catalog-snapshot.json`, and all four Python JSON samples: `core-contracts.json`,
`catalogs.json`, `provider-differential.json` and `workspace-agent-package.json`. These latter
artifacts use `parent_commit`. The canonical TypeScript fixture intentionally has no Python pin.
Missing, malformed or stale carriers fail closed.

`tests/unit/parity-maintenance.test.ts` exercises native-only features, honest lower statuses,
invalid evidence, lost dispositions/bindings, stale pins, missing test dispositions and a
changed canonical expectation. `pnpm test:package` also compares the built catalog snapshot
(29 models, 36 pricing rows) and installs a clean tarball consumer. Matrix/catalog formatting
is checked by their generators; current guides and JSON artifacts are covered by
`format:check`. Historical plans are excluded from Prettier and use structural plan validation.
Frozen catalog compatibility requires each adopted Python row to remain unchanged and present,
while allowing additional TypeScript-native rows; the native catalog snapshot covers the full lists.

## Optional local tools

### Frozen Python compatibility suite

`pnpm parity:python -- --parent <checkout>` requires a checkout whose `HEAD` exactly matches
the recorded pin. It checks the baseline, regenerates frozen Python samples into a temporary
directory, checks the crosswalk against the checkout's test list, checks the canonical
TypeScript fixture, and validates an explicit Python-serializer projection of its native
values. Python tags and null defaults are introduced only in that optional projection;
Python cannot rewrite the canonical expectations.

The Python generator includes the actual workspace-agent save/ZIP writer. Its file mtimes
represent a fixed local wall time, so ZIP timestamps do not depend on the host timezone.
`--check` formats and compares temporary output and leaves committed samples untouched.
The interpreter is selected with `PYTHON` (`python` on Windows, `python3` elsewhere by default).
Use Python 3.11 to reproduce the recorded samples:

```sh
PYTHON=python3.11 pnpm parity:python -- --parent ../blackbox
```

### Drift report

`pnpm parity:drift` reads the Python default branch through the GitHub API (`GITHUB_TOKEN`
is optional). `--output <file>` writes its report; `--fail-on-drift` opts into failure when
the branch moved. Network/report-writing failures still fail. Drift alone changes no score,
fixture or release gate. No CI or release workflow runs this command.

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

4. Regenerate the frozen Python compatibility fixtures, including the ZIP sample, under Python 3.11. The generator honours `PYTHON`; the
   0.2.0 sync used a `uv`-managed interpreter:

   ```sh
   PYTHON=$(~/.local/bin/uv python find 3.11) pnpm generate:parity:python -- --parent ../blackbox
   ```

5. Port the adopted behavior and any bundled model/pricing changes in `src/`, with
   ordinary TypeScript tests alongside the cross-language fixtures, before generating
   artifacts from the TypeScript implementation. Record deliberate divergences as crosswalk
   `notes` in `scripts/generate-test-crosswalk.mjs`; update TypeScript statuses honestly when
   implementation support changes.
6. Regenerate the TypeScript-first crosswalk and matrix. Update canonical TypeScript
   expectations only for reviewed TypeScript behavior changes, independently of the Python pin:

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
   `pnpm parity:python -- --parent ../blackbox` to check frozen compatibility against
   the checkout before requesting review.
9. In the pull request, summarize upstream commits, feature/status changes, public API
   impact, fixture changes, and any deliberately declined parent behavior.

## Remaining external work

The Python repository's own freeze/archive posture remains outside this repository, tracked
in [blackbox#22](https://github.com/tyxter-dev/blackbox/issues/22). This document does not assert
that the repository is archived. The prior TypeScript deferrals D1 and D3–D8 have implementation
resolution notes and focused evidence in the [completed refresh plan](plans/parity-refresh-plan.md#deferrals).
