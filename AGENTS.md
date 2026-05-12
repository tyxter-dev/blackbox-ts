# AGENTS.md

Guidance for Codex when working in this repo. Keep changes small, dependency-light,
and aligned with Python Blackbox concepts.

## Project

**blackbox-ts** is a public MIT licensed TypeScript provider-runtime adapter
library. It is the TypeScript port of Python Blackbox's provider/runtime layer,
not the full first-release port of the agent loop.

The package should stay usable by product repositories that do not want provider
SDKs or product-owned LLM contracts in their runtime graph.

## Scope

First release scope:

- Provider registry and model catalog.
- `provider:model` references.
- Capability profiles.
- Normalized model-turn requests, results, and events.
- Provider state types.
- Completion compatibility helper.
- Fetch-first adapters for OpenAI, Anthropic, Gemini, xAI, and OpenRouter.
- Test fakes and fixture helpers.

Out of scope for v0.1:

- Full `runtime.run` agent loop.
- Durable memory, workspace orchestration, or billing.
- Product-specific BYOK storage, tenant scoping, compliance logs, cost caps, or
  channel guardrails.
- Official provider SDK dependencies.

## Non-negotiable Rules

1. **No runtime dependencies.** Use built-in `fetch` and platform APIs. New
   dependencies must be dev-only unless the user explicitly changes the policy.
2. **Capability honesty is mandatory.** Unsupported tools, hosted tools, MCP,
   workspaces, provider state, and structured output must throw typed errors
   before network dispatch.
3. **Preserve raw provider payloads** on normalized turn results and events.
4. **OpenRouter is an aggregator provider**, not an OpenAI alias.
5. **Keep product behavior out of this library.** Tyxter-specific billing,
   environment scoping, encryption, logs, WhatsApp rules, and handoff webhooks
   belong in Tyxter.
6. **Prefer stable public contracts over convenience shortcuts.** Public type
   changes affect Tyxter API stabilization and downstream docs.
7. **Provider adapters must be testable offline.** Accept `fetchImpl` and cover
   request/response mapping with fixtures.

## Repo Shape

```text
src/core/                      shared contracts, refs, state, events, errors
src/providers/                 provider protocol, registry, catalog
src/providers/openai-compatible shared chat-completions adapter
src/providers/openai           OpenAI adapter
src/providers/anthropic        Anthropic adapter
src/providers/gemini           Gemini adapter
src/providers/xai              xAI adapter
src/providers/openrouter       OpenRouter adapter
src/testing/                   fake providers and fetch fixtures
tests/unit/                    pure contract/unit tests
tests/golden/                  offline provider mapping tests
tests/smoke/                   env-gated real provider smoke tests
docs/                          public specs
```

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack --dry-run
```

Network smoke tests are skipped unless provider API keys are present:

```bash
OPENAI_API_KEY=... pnpm test:smoke
ANTHROPIC_API_KEY=... pnpm test:smoke
GOOGLE_API_KEY=... pnpm test:smoke
XAI_API_KEY=... pnpm test:smoke
OPENROUTER_API_KEY=... pnpm test:smoke
```

## Testing Expectations

- Unit tests cover refs, registry, catalog, capability assertions, completion
  compatibility, and fake providers.
- Golden tests cover offline request/response mapping, usage extraction, and raw
  payload preservation for every provider adapter.
- Smoke tests must be network-gated and skipped by default.
- Do not weaken tests to make provider behavior pass. Fix the adapter or update
  the spec when the provider contract has truly changed.

## TypeScript Style

- ESM only.
- Node 20.11+ target.
- Keep exported types explicit and stable.
- Use typed errors from `src/core/errors.ts`.
- Avoid ad hoc string parsing when a structured helper belongs in `src/core`.
- Add comments only where they clarify non-obvious provider protocol behavior.

## Release Posture

The package is publishable as `blackbox-ts@0.1.0-alpha.x`. Before release, run
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and
`pnpm pack --dry-run`.
