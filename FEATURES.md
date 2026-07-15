# Features

## Provider-neutral runtime

- Separate model, agent-session, and realtime provider registries.
- `provider:model` references, legacy slash parsing, aliases, lifecycle metadata, fallback,
  and a bundled model catalog with provenance.
- Full canonical event family, run items, multimodal content, raw envelopes, provider/run
  state, usage, artifacts, approvals, sessions, typed results, and durable serialization.
- Granular capability profiles and negative contract tests for tools, hosted tools, MCP,
  workspaces, output strategies, controls, state modes, constraints, and value support.
- Deterministic Echo, fake, scripted, clock, fetch, agent, and realtime test providers.

## Model adapters

- OpenAI Responses and xAI Responses with native stream items, tools, structured output,
  provider state, reasoning, multimodal input, usage, and raw payloads.
- Anthropic Messages with streamed content blocks, thinking, tools, cache usage, native
  history, compaction controls, and raw payloads.
- Gemini GenerateContent with ordered parts, thought signatures, function calls/results,
  grounding, multimodal input, cache controls, usage, state, and raw payloads.
- OpenRouter as its own conservative aggregator adapter.
- Shared retry, timeout, cancellation, request-id, safe-error-body, and SSE transport.

## Agent execution

- One streaming `AgentLoop` for text, parallel local tools, context privacy, mocks, timeout,
  payload separation, dynamic catalog search/load, budgets, policy, approvals, fallback, and
  iteration guards.
- Provider-native, finalizer-tool, post-hoc, and repair/retry structured-output strategies.
- Persisted run state, native resume, in-memory/JSONL/injected-SQLite stores, provider cache,
  and isolated/redacted observability sinks.
- Local agent sessions plus injected OpenAI Agents and Claude Code adapters; durable replay,
  idempotent follow-ups, artifacts, approvals, cancellation, and conservative Vertex/webhook
  contracts.

## Environments and integrations

- Local workspace containment, commands, snapshots, patches, artifacts, tool bridge, and
  Git/injected sandbox/Docker/cloud/artifact-bundle providers.
- MCP protocol negotiation, server authoring, stdio/HTTP/SSE transports, auth refresh, trust,
  filtering, output limits, caching, namespaced local tools, and provider-native toolsets.
- Portable skills and workspace-agent packages with validation, deterministic pack/install,
  archive protection, in-memory/SQLite registries, cron/interval schedules, and Claude staging.
- Pricing/accounting with parent-pinned provenance, billable policy, cache metrics, prompt
  dry-runs, and ten frozen workflow profiles.
- Managed realtime sessions and injected OpenAI Realtime/Gemini Live duplex providers.
- Lease/heartbeat environment workers and partial opt-in Anthropic Managed Agents adapter.
- Trace reconstruction, production metrics, OpenTelemetry export, replay/diff, and evaluators.

## Deliberately product-owned

Tenant identity, secret storage/encryption, compliance retention, bill collection, cost caps,
channel guardrails, and product webhooks are not library responsibilities.
