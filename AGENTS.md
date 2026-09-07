# AGENTS.md

Guidance for Codex when working in this repo. Keep changes small, dependency-light,
and aligned with the public Blackbox contracts.

## Project and scope

**blackbox-ts** is the public MIT-licensed, canonical TypeScript Blackbox runtime.
Python Blackbox is a historical compatibility reference pinned in
`docs/parity-inventory.json`; it is not a runtime or release dependency.
[FEATURES.md](FEATURES.md) is the current feature catalog.

The library ships provider registries/catalogs, normalized model turns, the agent loop,
agent sessions, tools, structured output, policy/approvals, persistence, workspaces, MCP,
realtime protocols, workers, skills/workspace-agent packages, schedules, pricing/cache,
prompt planning, configuration and observability. Fetch-first model adapters cover OpenAI,
Anthropic, Google Gemini, xAI and OpenRouter. Cloud-agent/realtime integrations use injected
clients or transports; capability profiles distinguish supported and partial surfaces.

Product-owned tenant identity, BYOK storage/encryption, compliance retention, billing
collection, cost caps, channel rules and handoff webhooks remain outside this library.
Generic pricing estimates, policies, event sinks and workspace controls belong here.

## Non-negotiable rules

1. **No runtime dependencies.** Use built-in `fetch` and platform APIs. New dependencies
   must be dev-only unless the user explicitly changes the policy. Provider SDKs remain
   behind injected interfaces.
2. **Capability honesty is mandatory.** Unsupported tools, hosted tools, MCP, workspaces,
   provider state, controls and structured output must fail with typed errors before dispatch.
3. **Preserve raw provider payloads** on normalized results and events; storage/telemetry
   redaction must be explicit.
4. **OpenRouter is an aggregator provider**, not an OpenAI alias.
5. **Keep product behavior out.** Tenant policies, secret stores, billing enforcement and
   channel-specific integrations belong in the host product.
6. **Prefer stable public contracts.** Exported types affect downstream integrations and docs.
7. **Test adapters offline.** Fetch adapters accept `fetchImpl`; injected clients/transports
   need offline fixtures. Do not weaken tests to make provider behavior pass.

## Repository shape

```text
src/core/                      shared values, errors, events, policy and permission core
src/providers/                 protocols, registry/catalog, model and agent adapters
src/runtime/                   model execution, agent loop and agent-session facade
src/tools/                     registry, dispatch and dynamic toolsets
src/output/                    validation and structured-output strategies
src/persistence/               memory, JSONL and injected SQLite stores
src/workspaces/                workspace protocols, providers and tool bridge
src/mcp/                       client/server, transports and toolsets
src/realtime/                  sessions and injected duplex adapters
src/workers/                   leased environment workers
src/workspace-agents/           governed packages, registry and execution
src/skills/                    SKILL.md parsing and staging
src/schedules/                 package schedules
src/pricing/                   price catalog and estimates
src/cache/                     cache helpers and metrics
src/planning/                  prompt planning
src/config/                    workflow profiles and runtime configuration
src/observability/             sinks, traces, metrics and evaluators
src/testing/                   offline providers and fixture helpers
scripts/                       parity/API/catalog generators and package verification
tests/                        unit, golden, journey, security, perf and smoke suites;
                               shared fixtures under tests/fixtures/
docs/                          current specs, parity evidence and historical plans/ADRs
examples/                      runnable TypeScript integration examples
```

The package exposes the root, specialized subpaths and `blackbox-ts/package.json`.
The tarball contains JavaScript/declarations, README/CHANGELOG/FEATURES/LICENSE and examples;
repository `docs/`, source files and sourcemaps are excluded. Package verification requires
Git and checks generated paths against tracked source/examples; stage new files before it.

## Commands and checks

```sh
pnpm install
pnpm check
pnpm pack --dry-run
```

`pnpm check` runs formatting, offline parity checks, source/example typechecks, the public API
snapshot, ESLint, Vitest, build/catalog verification and a clean package consumer install
with an Echo model turn. Focused commands include `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build` and `pnpm test:package`. Update generated artifacts through their scripts.

Smoke suites are network-gated and skipped without provider keys. Run only the intended
provider suite with its key; never commit credentials. For example:

```sh
OPENAI_API_KEY=... pnpm exec vitest run tests/smoke/providers-smoke.test.ts -t OpenAI
```

The other gates use `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY` and
`OPENROUTER_API_KEY`; `pnpm test:smoke` runs the enabled cases. Manual Python
sync tools and exact checkout requirements are documented in
[parity maintenance](docs/PARITY_MAINTENANCE.md). CI and releases retain offline parity
checks and do not require a Python checkout.

## TypeScript and release posture

- ESM only; Node 20.11+.
- Keep exported types explicit and stable; use errors from `src/core/errors.ts`.
- Prefer structured core helpers over ad hoc parsing. Comment non-obvious protocol behavior.
- Before release, run `pnpm check` and `pnpm pack --dry-run`.
- The current candidate is `blackbox-ts@0.2.0-alpha.0`. Publishing is a separate action:
  `v*` tag pushes invoke the release workflow, which validates the package version,
  runs `pnpm check` and uses npm trusted publishing (OIDC). Prereleases use `alpha`;
  stable versions use `latest`. A version edit alone does not publish.
