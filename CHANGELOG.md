# Changelog

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
[docs/MIGRATION.md](docs/MIGRATION.md).
