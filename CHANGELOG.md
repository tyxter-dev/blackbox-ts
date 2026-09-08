# Changelog

## Unreleased

- Codex private `blackbox/*` wire notifications are diagnostic logs rather than authoritative
  session or approval events. Adapter-synthesized lifecycle events and native approvals retain
  authority; raw notification payloads are preserved.

- Local session cancellation remains terminal when an in-flight run emits trailing failure,
  completion or approval diagnostics. Session streams preserve those events for durable replay
  without raising a terminal-transition error.

## 0.2.0-alpha.0

Canonical TypeScript runtime with compatibility refreshed to the pinned Python Blackbox
0.2.0 baseline.

- CI and release verification no longer check out Python or run bidirectional parity;
  offline parity checks remain in `pnpm check`. Automated drift checks are removed;
  manual sync/drift tools remain available.
- Published package contents are limited to compiled JavaScript/declarations,
  README/CHANGELOG/FEATURES/LICENSE and examples. Sourcemaps and repository docs are
  excluded; package metadata is available through `blackbox-ts/package.json`,
  `sideEffects: false` is declared, and npm provenance is configured.
- Package verification checks the exact tracked-source-derived file set and runs a real
  offline Echo model turn from a clean tarball install.

- Bumped the pinned parent baseline from `f27decbc9aeaae972c5bbeb256c70450b7fe393a` to
  `d5be68e03ca7750920569578710a2ee25d25530c` (Python Blackbox 0.2.0) and regenerated every
  parity artifact: the inventory now scores 144 parent features (137 supported) plus 26
  supplements, the baseline records 129 evidence files and 118 Python test modules, and the
  bidirectional fixtures, crosswalk, matrix, and catalog snapshot carry the new pin.
- Refreshed the bundled model and pricing catalogs to the parent's 2026-09-05 snapshot
  (29 models, 36 price entries). Known pricing divergences kept: `PricingEntry` has no
  `source_url`/`reasoning_output_per_million`, collapses cached-input and cache-read into one
  read rate, and `PricingCatalog.get` does no alias resolution.
- Ported the 0.2.0 usage and cache accounting semantics: cache hit ratios count reads only,
  OpenAI `input_tokens_details.cache_write_tokens` feeds cache creation, and Anthropic input
  and total tokens are inclusive of cache read/creation tokens.
- Ported the current-model provider controls: Gemini finish metadata, OpenAI/xAI effort
  tables, Astra surface rejection, current-model cache TTL mapping, and the Anthropic
  adaptive-model contract with the Fable 5.1 replay guard and pinned hosted `web_search`
  spec. `extra.model` overrides remain rejected (no effective-model override), the replay
  guard binds only system + tools + the recorded assistant prefix, and legacy effort lists
  stay narrower than the parent's advisory lists.
- Added the `allowlist_v1` package permission core (`src/core/tool-permissions.ts`, not
  root-exported), grant compilation and enforcement across exposure, routing, and dispatch,
  workspace/MCP tool permission metadata, provider capability gating, and
  `runWorkspaceAgent` package runs. Parent feature "Workspace agent runtime grants" is
  inventoried as Supported with recorded divergences: grants live under `grants` (parent
  `permissions`), workspace refs are `workspace:read|list|write|command`, MCP
  `connector_scopes` derive from `required_scopes` only, package denials emit tool-call
  events before `TOOL_CHOICE_REJECTED`, and there is no client-executed hosted-tool gate.
- Added `CodexAgentProvider` as a contract port over an injected app-server client with the
  event-normalization table, subscription-only guard, approval pause, and file-change
  artifacts; no child-process/SDK runtime. The provider forces `supports_resume` off as well
  as package permissions. "Cloud agent providers" stays Partial.
- Ported the Claude Code task-budget contract (`task.metadata.task_budget`), MCP
  `clientInfo`/`serverInfo` at version `0.2.0` (`clientInfo.name` stays `blackbox-ts`;
  `serverInfo.name` remains the server's constructor name), MCP
  `annotations.readOnlyHint`/`destructiveHint` mapping to `metadata.read_only`/`destructive`,
  in-flight `listTools` coalescing, and the parent's YAML-subset block grammar for
  `SKILL.md` frontmatter (inline flow scalars remain JSON-only).
- Parity tooling: the inventory direction lock now accepts a TypeScript status at or above
  the pinned parent status; the crosswalk maps Codex and permission modules explicitly and
  carries per-entry divergence `notes`; `scripts/catalog-snapshot.mjs` reads the parent pin
  from `docs/parity-inventory.json`.

## 0.1.0-alpha.1

- Automated releases through npm trusted publishing (OIDC): tag pushes now
  validate the tag against the package version, pick the dist-tag
  (prerelease → `alpha`, stable → `latest`), and publish from CI without
  registry tokens.

## 0.1.0-alpha.0

- Ported the Python Blackbox provider/runtime contracts against commit
  `f27decbc9aeaae972c5bbeb256c70450b7fe393a`.
- Added model, high-level agent-loop, agent-session, realtime, workspace, MCP, worker,
  workspace-agent, skill, scheduling, pricing, cache, planning, configuration, persistence,
  policy, approval, and observability surfaces.
- Added native fetch-first OpenAI Responses, xAI Responses, Anthropic Messages, Gemini
  GenerateContent, and OpenRouter adapters plus offline Echo/fake providers.
- Added a schema-v2 parity inventory for 143 parent features, 26 verification supplements,
  and separately scored TypeScript extensions, plus the 496-symbol public API snapshot.
- Added pinned-parent drift detection, a 108-module Python/TypeScript test crosswalk,
  bidirectional core-contract fixtures, four-provider protocol differentials, and exact bundled
  model/pricing differentials.
- Added Windows/Linux Node 20.11/22 CI, package-consumer checks, and network-gated smoke tests.

The alpha API was substantially expanded during parity work; see
[docs/MIGRATION.md](https://github.com/tyxter-dev/blackbox-ts/blob/main/docs/MIGRATION.md).
