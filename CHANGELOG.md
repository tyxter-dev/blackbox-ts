# Changelog

## 0.1.0-alpha.0

- Ported the Python Blackbox provider/runtime contracts against commit
  `f27decbc9aeaae972c5bbeb256c70450b7fe393a`.
- Added model, high-level agent-loop, agent-session, realtime, workspace, MCP, worker,
  workspace-agent, skill, scheduling, pricing, cache, planning, configuration, persistence,
  policy, approval, and observability surfaces.
- Added native fetch-first OpenAI Responses, xAI Responses, Anthropic Messages, Gemini
  GenerateContent, and OpenRouter adapters plus offline Echo/fake providers.
- Added generated 146-requirement parity and 473-symbol public API snapshots.
- Added Windows/Linux Node 20.11/22 CI, package-consumer checks, and network-gated smoke tests.

The alpha API was substantially expanded during parity work; see
[docs/MIGRATION.md](docs/MIGRATION.md).
