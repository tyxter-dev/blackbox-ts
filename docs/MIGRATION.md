# Migration

## From the provider-only alpha

The runtime retains the model-provider family while adding separate execution surfaces.

1. Prefer `provider:model`; slash references remain compatibility input only.
2. Register providers in the explicit namespace: `registerModelProvider`,
   `registerAgentProvider`, or `registerRealtimeProvider`.
3. OpenAI and xAI now use Responses semantics. Read normalized items/events and
   `provider_state` instead of assuming Chat Completions payloads.
4. Gemini's canonical provider id is `google`; legacy product aliases should be registered at
   the boundary.
5. High-level execution is `AgentRuntime.run/stream`. `run()` collects the exact `stream()`
   event sequence.
6. Tool handlers return model-facing content and optional app-facing payloads separately.
7. Explicit unsupported controls now throw typed capability errors instead of being ignored.
8. Raw payload persistence and telemetry require the appropriate redaction/storage wrapper.
9. Import specialized surfaces from stable subpaths such as `blackbox-ts/mcp`, `/workspaces`,
   `/realtime`, `/workers`, and `/workspace-agents`.

Pricing is a replaceable snapshot pinned to the Python baseline. Do not treat an estimate as
an invoice or omit its `source` and `version` metadata.

## 0.2.0-alpha.0

TypeScript is now the canonical implementation. The Python pin records the historical
state used for compatibility checks. CI/releases keep offline fixture checks but require
no Python checkout; optional frozen-reference compatibility checks remain available. Install the published
prerelease through `blackbox-ts@alpha`, or build this checkout's tarball to install from source.
The tarball drops repository docs and sourcemaps and adds `blackbox-ts/package.json`.
Documentation links in README/CHANGELOG point to GitHub.

Accounting now treats Anthropic input/total tokens as inclusive of cache read/creation;
cache hit ratios count reads only. Current OpenAI/xAI/Anthropic model controls and catalogs
were refreshed. `extra.model` remains rejected rather than overriding the selected model.
The bundled catalog contains 29 models and 36 pricing rows.

## Pricing compatibility

`PricingCatalog.get` and `estimate` resolve registered model aliases after checking exact
price rows. Use `registerModelAlias(provider, alias, model)` for custom catalogs; bundled
pricing registers the bundled model aliases without adding rows. Resolution is one hop:
an alias pointing to an unpriced model still has no price and `estimate` throws
`pricing_not_found`. An explicit price row for an alias takes precedence.

For usage with combined and split cache counters, ordinary input is
`max(input_tokens - cached_input_tokens, 0)`. Any positive remainder of the combined cache
counter after subtracting reads and creation is charged as additional cache reads. Supplying
contradictory counters does not normalize them: explicit reads and creation retain their
quantities, while the combined counter controls the ordinary-input subtraction.

Rates now support independent optional `cached_input_per_million` and
`reasoning_output_per_million`. Read pricing falls back from `cache_read_per_million` to
`cached_input_per_million` to ordinary input; creation falls back from
`cache_creation_per_million` to cached input to ordinary input. An explicit reasoning rate
adds a supplemental `reasoning_output` component: all output tokens still incur their
ordinary output charge. Without that optional rate, reasoning adds no separate charge.
`PricingEntry.source_url` is preserved on estimates when supplied.

Bundled rows and normalized Python fixtures retain the earlier effective read and creation
fields for compatibility while also carrying the distinct cached-input rate and source URL.
Where Python omits a creation rate, those bundled rows still explicitly use ordinary input;
this preserves the historical TypeScript default rather than Python's cached-input fallback.
Optional-field absence is therefore not a round-trip guarantee. Rates and source URLs remain
snapshots of the recorded baseline, not live pricing lookups.

## Workspace-agent package interchange

Run restricted packages through `runWorkspaceAgent(runtime, spec, options)` from
`blackbox-ts/workspace-agents`. `permission_mode: 'allowlist_v1'` compiles `spec.grants`
and composes their boundary with any active boundary. Missing grants produce an empty allowlist; internal discovery tools and the loop's
finalizer retain their exemptions. An omitted mode or `inherit` adds no new package boundary; the host's existing
boundary and policy still apply. Grant scopes default to `read`, while tools without scope
metadata request `execute`, so declare scopes explicitly when needed.

Native readers remain TypeScript-only. For a Python-written format-version-1 ZIP, use the
explicit, one-way importer:

```ts
import { importPythonWorkspaceAgentPackage, runWorkspaceAgent } from 'blackbox-ts/workspace-agents';

const imported = importPythonWorkspaceAgentPackage(bytes, {
  connector_auth: { files: 'host-managed' }, // Match declared connector names and actual host auth.
});
const result = await runWorkspaceAgent(runtime, imported.spec, {
  ...imported.run_options,
  input: 'Read the report',
});
```

Importing validates and translates data; it does not start a run or configure credentials.
Each declared connector requires an explicit `connector_auth` value because Python's
`kind` does not identify an authentication mechanism. The importer preserves `kind` as
`type`, auth mode, scopes, metadata and translated tool refs. It maps Python `permissions`
to `grants`, leaving the native `permissions` record separate. Default workspace tool names
and grant/connector refs translate `read_file/list_files/write_file/run_command` to
`read/list/write/command`; other Python workspace operations are rejected.

Supported execution routes are the model loop (no `agent_provider`) and `agent_provider:
'local'`. A concrete model is required. `model_provider` qualifies the model as `provider:model`; conflicting selectors
are rejected. Pass the returned `run_options` to preserve the selected route, explicit
hosted tools and nonempty `extra`. Hosted tools require the native explicit
`{ type, name?, config? }` shape: Python's serialized hosted dataclasses can lack a type
discriminator and are rejected rather than inferred. `extra` becomes TypeScript model-request
options on both supported routes; this is an explicit translation, since Python's direct
model-package path does not forward `spec.extra`. Model capability checks and package
permission preflight still apply, including refusal of opaque `extra` under `allowlist_v1`.
Caller overrides use the existing `runWorkspaceAgent` permission boundary.

The importer rejects other agent providers, `agent_id`, MCP declarations/toolsets, skills,
schedules (including disabled ones), active memory/retention settings, publication directory
or approval actions and channels, and unknown fields or extra archive files. These settings
need host-side conversion; Python schedule matching/interval semantics and skill execution
are not equivalent to the native package fields. Private/public visibility and descriptive
version, ownership, memory and publication metadata are preserved; workspace/unlisted
visibility is rejected. Descriptive source records live under `spec.metadata.python_package`.
There is no reverse exporter. Repacking the translated spec writes a native TypeScript
package; retain `run_options` separately because native packages do not store those options.
The caller still provides resolved workspace/tools and credentials.

The pinned Python ZIP sample participates in `pnpm generate:parity:python -- --parent <checkout>`
and its optional `--check` path, alongside the other frozen compatibility fixtures.
Use Python 3.11 to reproduce the recorded samples. CI consumes them offline.

TypeScript-generated expectations in `tests/fixtures/typescript/core-contracts.json` are
canonical and have no Python pin or Python serialization tags. `pnpm check:parity` checks
them against current TypeScript source; `tests/golden/core-contracts.test.ts` replays public
contracts and pins defaults/error semantics. Python samples live under `tests/fixtures/python`
and their compatibility suites under `tests/compatibility`. The generated
[test crosswalk](parity-test-crosswalk.json) lists executable TypeScript tests first and
retains the frozen Python module mappings separately.

## Injected agent providers and skills

Codex uses the injected app-server contract described in [capabilities](CAPABILITIES.md#codex-agent-provider).
Protocol metadata `codex_sdk_version: '0.147.0'` does not mean the package installs that SDK.
The provider rejects API-key authentication in its supplied environment and cannot resume
sessions or enforce package permissions. Translate parent conventions to TypeScript
`AgentSpec.metadata.id`/`.sandbox`, `TaskSpec.metadata.ephemeral`/`.sandbox` and
`WorkspaceSpec.metadata.root`; these are adapter-specific metadata, not extra fields on
`WorkspaceAgentSpec`.

Claude Code validates `TaskSpec.metadata.task_budget` as `{ total: <integer 1..1000000> }`
before its injected client's session start. The adapter does not implement the parent's
SDK query loop or agent-level task-budget precedence.

The fallback SKILL.md parser supports the parent's YAML-subset block lists/maps, but inline
flow scalars remain JSON-only. A hand-written Python skill using YAML-only flow values may
still need translation; this is not a general YAML parser.
