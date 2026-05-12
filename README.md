# blackbox-ts

`blackbox-ts` is a fetch-first TypeScript port of Blackbox's provider/runtime adapter layer.
It gives products one small API for model providers without importing every vendor SDK into
the product codebase.

The package is intentionally narrow in `0.1.0-alpha.0`: provider registry, `provider:model`
references, capability profiles, normalized turn events, provider state shapes, a completion
compatibility helper, and first-party adapters for OpenAI, Anthropic, Gemini, xAI, and
OpenRouter.

## Install

```sh
pnpm add blackbox-ts
```

Before the npm package is published, consumers can install from a pinned GitHub
commit:

```sh
pnpm add github:tyxter-dev/blackbox-ts#<commit-sha>
```

Node 20.11 or newer is required. The package is ESM-only and has zero runtime dependencies.

## Basic Usage

```ts
import { ProviderRegistry, complete } from 'blackbox-ts';
import { createOpenAIProvider } from 'blackbox-ts/providers/openai';

const registry = new ProviderRegistry();
registry.registerModelProvider(
  createOpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4.1-mini',
  }),
);

const { provider, model } = registry.resolveModelProvider('openai:gpt-4.1-mini');
const result = await complete(provider, {
  system: 'Answer tersely.',
  messages: [{ role: 'user', content: 'What is blackbox-ts?' }],
  model,
  trace_id: crypto.randomUUID(),
});

console.log(result.content);
```

## Provider Policy

- Built-in `fetch` only; no official provider SDK dependency in v0.1.
- Capability profiles must be honest. Unsupported tools, MCP connections, workspaces,
  provider state, and structured output throw typed errors before provider dispatch.
- Raw provider payloads are preserved on normalized turn results and events.
- OpenRouter is modeled as an aggregator provider, not as an OpenAI alias.
- Product-specific behavior such as BYOK encryption, tenant scoping, billing, cost caps,
  compliance logs, channel guardrails, and webhooks belongs in the host product.

## Scope

This is not the full Blackbox agent loop. The first release is the provider runtime foundation
needed to keep product API contracts stable while deeper agent automation is built later.

See [docs/SPEC.md](docs/SPEC.md) and [FEATURES.md](FEATURES.md).
