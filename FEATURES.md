# Features

## v0.1 Provider Runtime MVP

- Provider registry with provider aliases.
- `provider:model` references and fallback-provider parsing.
- Model catalog with aliases and lifecycle status.
- Capability profiles covering streaming, function tools, hosted tools, MCP, workspaces,
  provider state, structured output, and provider controls.
- Normalized model turn request/result/event types.
- Provider state type for native continuations and future agent loops.
- Completion compatibility helper for products that still expose a text completion route.
- Fetch-first providers:
  - OpenAI Chat Completions
  - Anthropic Messages
  - Gemini GenerateContent
  - xAI Chat Completions
  - OpenRouter Chat Completions
- Testing helpers for fake providers, scripted providers, and captured fetch calls.

## Explicitly Out Of Scope For v0.1

- Full `runtime.run` agent loop.
- Durable memory or workspace orchestration.
- Official provider SDK imports.
- Product-level billing, tenant scoping, BYOK encryption, compliance logging, or channel
  policy enforcement.
