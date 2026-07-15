# Provider Capability Matrix

The adapter profile is authoritative at runtime; this table summarizes the bundled posture.
Model-specific constraints may be stricter and are checked before dispatch.

| Provider   | Native protocol             | Function tools | Hosted tools         | Structured output                 | Provider state            | MCP/workspace               |
| ---------- | --------------------------- | -------------- | -------------------- | --------------------------------- | ------------------------- | --------------------------- |
| OpenAI     | Responses                   | Yes            | Model-gated          | Yes                               | Yes                       | Model-gated/provider-native |
| xAI        | Responses-compatible        | Conservative   | No unless advertised | Model-gated                       | Model-gated               | No unless advertised        |
| Anthropic  | Messages                    | Yes            | Model-gated          | Native/model-gated plus fallbacks | Native history            | Model-gated                 |
| Google     | GenerateContent             | Yes            | Search/model-gated   | Yes                               | Native history/signatures | Model-gated                 |
| OpenRouter | Chat Completions aggregator | Conservative   | No                   | Text/post-hoc                     | No                        | No                          |
| Echo       | Offline deterministic       | No             | No                   | Text/post-hoc                     | No                        | No                          |

Agent providers, realtime providers, workspaces, and MCP servers have separate capability
contracts; they are never represented as model tools merely for convenience.

Partial/contract-only parity is intentionally unchanged:

- Vertex AI Agent Engine throws an unsupported-feature error.
- Anthropic Managed Agents requires `acknowledge_live_beta: true` and an injected client.
- OpenAI Agents, Claude Code, OpenAI Realtime, Gemini Live, sandbox, Docker, and cloud
  integrations accept injected clients/transports so the core package remains dependency-free.
- Webhook ingress remains a contract for product-owned verification and persistence.
