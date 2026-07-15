# Migration from the provider-only alpha

The parity implementation preserves the original model-provider contracts but makes several
important corrections.

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
