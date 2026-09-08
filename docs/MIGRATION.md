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
no Python checkout; manual bidirectional checks remain available. Install the published
prerelease through `blackbox-ts@alpha`, or build this checkout's tarball to install from source.
The tarball drops repository docs and sourcemaps and adds `blackbox-ts/package.json`.
Documentation links in README/CHANGELOG point to GitHub.

Accounting now treats Anthropic input/total tokens as inclusive of cache read/creation;
cache hit ratios count reads only. Current OpenAI/xAI/Anthropic model controls and catalogs
were refreshed. `extra.model` remains rejected rather than overriding the selected model.
Pricing aliases are still not resolved by `PricingCatalog.get`; use a price row's exact model
ID. The bundled catalog contains 29 models and 36 pricing rows.

## Workspace-agent package interchange

Run restricted packages through `runWorkspaceAgent(runtime, spec, options)` from
`blackbox-ts/workspace-agents`. `permission_mode: 'allowlist_v1'` compiles `spec.grants`
and composes their boundary with any active boundary. Missing grants produce an empty allowlist; internal discovery tools and the loop's
finalizer retain their exemptions. An omitted mode or `inherit` adds no new package boundary; the host's existing
boundary and policy still apply. Grant scopes default to `read`, while tools without scope
metadata request `execute`, so declare scopes explicitly when needed.

Python and TypeScript packages are not interchangeable without translation:

- Python stores its grant array under `permissions`. TypeScript uses `grants`; its
  `permissions` field is an existing membership/settings record. A Python-written
  `allowlist_v1` manifest with an array in `permissions` fails closed.
- The TypeScript workspace-agent spec has no `agent_provider` or `agent_id`. Select an
  agent provider through the `runWorkspaceAgent` options; existing-agent selection through
  the package's `agent_id` is not supported. Parent `model_provider`, `hosted_tools` and
  `extra` fields have no matching package-field behavior either; do not rely on ignored
  imported fields to configure a run.
- Workspace grant refs are `workspace:read`, `workspace:list`, `workspace:write` and
  `workspace:command`; Python's `read_file`, `list_files`, `write_file` and `run_command`
  suffixes do not match them.
- Package `mcp_servers` contains names, not resolved connections. The caller provides
  `mcp_connections` or MCP-backed tools and the actual `workspace` through run options.
  For a local agent-provider package run, tools/workspace/policy travel on
  `AgentSpec.metadata.run_request`, a TypeScript local-adapter convention. The effective
  model and instructions are also placed on the agent spec.

Interchange work and other recorded compatibility gaps are tracked in
[blackbox-ts#2](https://github.com/tyxter-dev/blackbox-ts/issues/2). Detailed divergences are
in the generated [test crosswalk](parity-test-crosswalk.json).

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
