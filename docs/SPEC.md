# blackbox-ts Provider Runtime Spec

## Goals

`blackbox-ts` is the TypeScript adapter layer for provider-facing model execution. It keeps
provider protocol details outside product repositories and exposes stable runtime contracts
that product APIs can depend on before public release.

## Non-Goals

- It is not an agent product.
- It does not own tenant scoping, billing, encryption, rate limits, audit logs, or channel
  safety policies.
- It does not wrap Python Blackbox at runtime.
- It does not import official provider SDKs in v0.1.

## Provider References

Model references use the canonical form:

```text
provider:model
```

Examples:

```text
openai:gpt-4.1-mini
anthropic:claude-sonnet-4-5
gemini:gemini-2.5-flash
xai:grok-4-fast
openrouter:openai/gpt-4.1-mini
```

Consumers may pass a fallback provider when accepting legacy model-only inputs. Libraries and
public API docs should prefer canonical provider-qualified references.

## Capability Honesty

Every provider exposes a `CapabilityProfile`. If a request includes unsupported tools, hosted
tools, MCP connections, workspaces, provider state, or structured output, the adapter must throw
`UnsupportedCapabilityError` before making a network request.

`passthrough` means the adapter forwards a feature without normalizing its semantics. Products
that require deterministic behavior should treat passthrough as weaker than `supported`.

## Normalized Turns

`TurnRequest` is the canonical provider runtime input. It includes model, input messages, optional
instructions, tool/MCP/workspace specifications, provider state, generation controls, trace ID, and
an `extra` bag for provider-specific escape hatches.

`TurnResult` returns normalized output text, usage, provider state, normalized events, and raw
provider response payloads.

## Completion Compatibility

`complete(provider, input)` maps Tyxter's current text completion shape onto `TurnRequest` and
normalizes the result back to `{ content, tokens_in, tokens_out, model, provider, raw_response }`.
This keeps current product behavior stable while the provider runtime evolves.

## Provider Adapters

All v0.1 adapters use built-in `fetch`. They accept `fetchImpl` for deterministic tests and
non-standard runtimes. Network smoke tests are gated by provider API key environment variables and
are skipped by default.
