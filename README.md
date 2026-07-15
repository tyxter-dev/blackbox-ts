# blackbox-ts

`blackbox-ts` is the zero-runtime-dependency TypeScript port of the Python
[`tyxter-dev/blackbox`](https://github.com/tyxter-dev/blackbox) provider and agent runtime.
It keeps model, agent-session, realtime, workspace, MCP, worker, and package protocols separate
while exposing one provider-neutral runtime.

Node 20.11 or newer is required. The package is ESM-only and all default tests are offline.

## Install

```sh
pnpm add blackbox-ts
```

Until the repository and npm package are published, build a local tarball from this checkout:

```sh
pnpm pack
pnpm add ./blackbox-ts-0.1.0-alpha.0.tgz
```

## Run a model or full agent loop

```ts
import { AgentRuntime, EchoModelProvider, ProviderRegistry } from 'blackbox-ts';

const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
const runtime = new AgentRuntime({ registry });

const turn = await runtime.models.run({
  model: 'echo:echo',
  input: 'hello',
  trace_id: crypto.randomUUID(),
});

const result = await runtime.run({
  model: 'echo:echo',
  input: 'complete this run',
  trace_id: crypto.randomUUID(),
});

console.log(turn.output_text, result.output);
```

First-party fetch adapters are available at `blackbox-ts/providers/openai`, `/anthropic`,
`/gemini`, `/xai`, and `/openrouter`. Provider SDKs are never runtime dependencies.

The parent-compatible workflow profiles can supply the provider/model and controls while
explicit call arguments retain highest precedence:

```ts
import { RuntimeConfig } from 'blackbox-ts/config';

const config = RuntimeConfig.profile('fast_text').withOverrides({
  provider: 'openai:gpt-5.4-mini',
});
const result = await runtime.run({ input: 'Summarize this.', config, max_output_tokens: 256 });
```

## Runtime families

- `runtime.models`: normalized model turns and canonical streaming.
- `runtime.run/stream`: model → tools → model loop, structured output, fallback, approvals,
  dynamic toolsets, policy, persistence, and prompt planning.
- `runtime.agents`: local or injected cloud-agent sessions, replay, follow-ups, approvals,
  cancellation, and artifacts.
- `runtime.realtime`: managed low-latency sessions with text/audio/image input, interruption,
  and injected OpenAI Realtime or Gemini Live duplex transports.
- `blackbox-ts/workspaces`: local/git/sandbox/Docker/cloud workspace protocols and tools.
- `blackbox-ts/mcp`: MCP client/server, stdio/HTTP/SSE transports, trust, auth refresh,
  discovery cache, runtime tools, and provider-native routing.
- `blackbox-ts/workspace-agents` and `/skills`: portable governed agent packages, registries,
  validation, schedules, and Claude Code staging.
- `blackbox-ts/workers`: lease-based inbound environment workers.
- `blackbox-ts/observability`: redacted sinks, traces, metrics, replay/diff, OpenTelemetry, and
  evaluators.

## Contract policy

- Capability honesty is mandatory. Unsupported tools, hosted tools, MCP, workspaces, state,
  controls, and output modes fail before network dispatch.
- Raw provider payloads remain attached to normalized results/events and storage or telemetry
  redaction is explicit.
- OpenRouter is an aggregator, not an OpenAI alias.
- Product-owned identity, tenant isolation, BYOK encryption, billing enforcement, compliance
  logs, cost caps, and channel rules stay in the host product.
- Parent-partial features remain conservative: Vertex Agent Engine is a stub, Anthropic
  Managed Agents requires an explicit beta acknowledgement, and cloud/realtime production
  transports are injected.

The pinned score covers 143 Python catalog features, with 26 verification supplements and
TypeScript extensions reported separately. Scoped evidence is in
[the parity matrix](docs/PARITY_MATRIX.md), and the bidirectional fixture, drift, and baseline
update workflow is in [parity maintenance](docs/PARITY_MAINTENANCE.md). See
[features](FEATURES.md), [capabilities](docs/CAPABILITIES.md),
[migration](docs/MIGRATION.md), and [examples](examples/).
