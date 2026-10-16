# Provider Capability Matrix

The adapter profile is authoritative at runtime. This table summarizes default model
profiles; model-specific constraints and explicitly supplied profiles can differ.

| Provider   | Native protocol             | Function tools | Hosted tools                             | Structured output                          | Provider state            | MCP / workspace                                    |
| ---------- | --------------------------- | -------------- | ---------------------------------------- | ------------------------------------------ | ------------------------- | -------------------------------------------------- |
| OpenAI     | Responses                   | Yes            | Supported kinds; raw passthrough         | Native and runtime fallbacks               | Yes                       | MCP supported / workspace unsupported              |
| xAI        | Responses-compatible        | Yes            | Typed kinds unsupported; raw passthrough | Native and runtime fallbacks               | Yes                       | Both unsupported                                   |
| Anthropic  | Messages                    | Yes            | Web search, remote MCP; raw passthrough  | Native model-gated; runtime fallbacks      | Native history            | Use remote_mcp hosted tool / workspace unsupported |
| Google     | GenerateContent             | Yes            | Web search; raw passthrough              | Native; tool combination requires Gemini 3 | Native history/signatures | Both unsupported                                   |
| OpenRouter | Chat Completions aggregator | No             | No                                       | Text/post-hoc                              | No                        | Both unsupported                                   |
| Echo       | Offline deterministic       | No             | No                                       | Text/post-hoc                              | No                        | Both unsupported                                   |

A model adapter's lack of workspace support does not prevent the host agent loop from using
local workspace tools. Function-tool support also differs from support for the explicit
`parallel_tool_calls` control: Anthropic and Gemini reject that control. Anthropic Fable 5.1
permits only `auto`/`none` tool choice and does not support the finalizer-tool output strategy.

Agent providers, realtime providers, workspaces and MCP servers use separate capability
contracts. Partial integrations remain explicit:

- Vertex AI Agent Engine throws an unsupported-feature error.
- `AnthropicEnvironmentWorkSource` is a worker integration requiring
  `acknowledge_live_beta: true` and an injected client.
- OpenAI Agents, Claude Code, OpenAI Realtime and Gemini Live use injected clients/transports.
  Workspace sandbox/Docker/cloud integrations also use injected clients.
- Webhook ingress remains a contract for product-owned verification and persistence.

## Codex agent provider

`CodexAgentProvider` is a contract port over an injected `CodexAppServerClient`:
`connect()` yields a connection with `send()`, `messages` and `close()`. The provider owns
thread/turn requests, event normalization, approval pauses and file-change artifacts.
Private `blackbox/*` lifecycle and approval events carry authority only when synthesized by
this adapter. Matching wire notifications become `cloud_agent.log` diagnostics with their
raw payloads preserved; fields claiming trusted or synthetic origin do not grant authority.
Log payloads do not create durable approval records or replace provider state. Native
`item/commandExecution/requestApproval` and `item/fileChange/requestApproval` server requests
still create approval pauses and receive JSON-RPC responses.

There is no bundled Codex SDK, process launcher or SDK version check. The default
`metadata.codex_sdk_version: '0.147.0'` records the protocol baseline used for this port,
not an installed dependency.

Authentication is subscription-only at the provider boundary: `AgentSpec.environment` rejects
`OPENAI_API_KEY`, and the adapter does not read the host environment. The injected transport
must maintain subscription authentication and must not add an inherited API key itself.
Blackbox local tools, hosted tools and MCP server specifications are rejected before opening
transport. Native Codex workspace tooling stays with the injected app-server.

`supports_resume` and `supports_package_permissions` are forced to `false`, including when
a client advertises them. Restricted `allowlist_v1` package runs therefore reject Codex.
Follow-ups, cancellation and native approvals are separate session operations. Consume streamed
events for text: the current `runtime.agents.run` collector does not derive Codex response text
from delta-only events, so its collected output may be empty.

The adapter reads `AgentSpec.metadata.id` and `.sandbox`, `TaskSpec.metadata.ephemeral`
(default `true`) and `.sandbox`, and `WorkspaceSpec.metadata.root` (or a local workspace's
`ref`). Task sandbox settings override the agent setting. These conventions and package
portability limitations are recorded in [migration](MIGRATION.md).
