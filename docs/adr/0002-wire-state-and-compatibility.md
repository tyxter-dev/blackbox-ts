# ADR 0002: Event-First Wire State and Compatibility

**Status:** Accepted
**Parent baseline (historical):** `f27decbc9aeaae972c5bbeb256c70450b7fe393a`

Canonical events and run items are the source of runtime state. Durable public values use
snake_case keys and versioned JSON envelopes so Python and TypeScript values can round-trip.
Provider-native continuation stays in `ProviderState`; it is never reconstructed from a
lossy chat transcript. Raw provider payloads are retained, sensitivity-tagged, and redacted
only when their storage policy forbids persistence.

The canonical provider reference is `provider:model`. `provider/model` remains a deprecated
read-compatible form. Chat-shaped messages and the initial flattened request controls remain
compatibility projections; conflicts with the nested canonical control object fail loudly.
Unsupported multimodal projections throw typed errors instead of dropping content.

## Clarification — 2026-09-07

The round-trip statement above describes the wire-state design, not universal Python/TypeScript
package interchange. Workspace-agent manifests require field translation, and the fallback
SKILL.md parser accepts JSON-only inline flow scalars. See the current
[package interchange](../MIGRATION.md#workspace-agent-package-interchange) and
[skills limitations](../MIGRATION.md#injected-agent-providers-and-skills).
