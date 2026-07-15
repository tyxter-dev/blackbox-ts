# ADR 0003: Zero-Dependency Core and Optional Integrations

**Status:** Accepted
**Parent baseline:** `f27decbc9aeaae972c5bbeb256c70450b7fe393a`

The root package keeps zero runtime dependencies and supports Node.js 20.11 and later. Core
providers use built-in `fetch`; JSONL, local workspace, stdio/HTTP MCP, and observability
contracts use platform APIs. SQLite, production WebSocket/WebRTC, zip packaging, cloud-agent
SDKs, and OpenTelemetry exporters are injected behind interfaces.

Production bridges may later use optional peer dependencies behind explicit subpath exports.
They must never be imported by the root entrypoint, and missing optional integrations must
raise `ProviderNotConfiguredError` or another typed configuration error. The first optional
peer requires a separate repository-policy ADR.

Structured output follows the same rule: core accepts a generic validator or raw JSON Schema;
provider-native enforcement and finalizer-tool strategies are capability-gated, with explicit
fallback selection rather than silent degradation.
