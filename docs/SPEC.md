# Blackbox Runtime Spec

## Scope

`blackbox-ts` is the canonical TypeScript Blackbox runtime. It provides model execution,
the agent loop, agent sessions, tools, structured output, policy/approvals, persistence,
workspaces, MCP, realtime protocols, workers, skills/workspace-agent packages, schedules,
pricing/cache, prompt planning, configuration and observability. [FEATURES.md](../FEATURES.md)
is the current feature catalog; [capabilities](CAPABILITIES.md) records adapter limits.

The package has no runtime dependencies and does not wrap Python. Python Blackbox is a
pinned historical compatibility reference. CI/releases verify this repository's offline
artifacts; the optional cross-language suite is described in
[parity maintenance](PARITY_MAINTENANCE.md).

Tenant identity, secret storage, bill collection, compliance retention and channel-specific
policies belong in the host product. Generic estimates, event stores and policy hooks are
library primitives, not product billing or compliance systems.

## Provider references and protocols

Model references use `provider:model`. Bundled examples include:

```text
openai:gpt-5.6-sol
anthropic:claude-sonnet-4-6
google:gemini-3-flash-preview
xai:grok-4.6
```

OpenRouter uses its aggregator model IDs, for example `openrouter:openai/gpt-4.1-mini`.
Legacy slash references and model-only inputs with a fallback provider remain compatibility
inputs. Model, agent and realtime providers have separate protocols and registry namespaces.

## Capabilities and normalized turns

Model adapters expose a `CapabilityProfile`. Unsupported request features and controls
must fail with typed errors before dispatch. `passthrough` forwards a feature without
normalizing its semantics and is weaker than `supported` for deterministic behavior.
Agent and realtime adapters expose their own capability contracts.

`TurnRequest` includes the model, input, instructions, tools/MCP/workspace specifications,
provider state, controls, trace ID and provider-specific `extra`. `TurnResult` carries
normalized text, usage, optional state/events/items/artifacts and raw provider payloads.
`runtime.models.run` collects the canonical model stream. `runtime.run/stream` adds the
model/tool loop, output strategies, policy, approvals and run-state handling.

`complete(provider, input)` is the compatibility helper for `LLMCompletionInput`: it maps
messages/system/model/token controls to a turn and returns
`{ content, tokens_in, tokens_out, model, provider, raw_response }`.

## Local session cancellation

After a local session emits `session.cancelled`, subsequent run diagnostics remain in the
session event log without changing its cancelled status. Draining `runtime.agents.stream`
or collecting with `runtime.agents.run` persists that status for replay. Cancellation
signals the active invocation; a model or policy that ignores the signal can delay stream
completion until it settles. Cancellation during an approval wait stops the protected action
without requiring an approval decision. Normal success and failure remain distinct terminal
outcomes.

## Adapters and package boundaries

OpenAI, Anthropic, Google Gemini, xAI and OpenRouter model adapters use built-in `fetch`
and accept `fetchImpl` for offline tests. Echo is deterministic and offline. Agent SDKs,
SQLite drivers and realtime duplex transports are injected behind interfaces; SDKs are not
installed by this package. Codex is an injected app-server contract port with explicit
limitations documented in [capabilities](CAPABILITIES.md#codex-agent-provider).

`runWorkspaceAgent` enters a package permission boundary for `allowlist_v1` grants and
composes it with an existing boundary. Agent providers unable to enforce package permissions are
rejected for restricted runs; model runs enforce the boundary in the runtime. Loading or lowering a package alone does not establish a
runtime boundary. TypeScript and Python package fields differ; see
[migration](MIGRATION.md#workspace-agent-package-interchange).

The ESM package targets Node 20.11+. The tarball includes compiled JavaScript/declarations,
README/CHANGELOG/FEATURES/LICENSE and examples, with no sourcemaps or `docs/`. Releases use
tag-triggered npm trusted publishing; editing the version does not publish a release.
