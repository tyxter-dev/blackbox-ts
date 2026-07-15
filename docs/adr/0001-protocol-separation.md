# ADR 0001: Separate Provider Protocol Families

**Status:** Accepted
**Parent baseline:** `f27decbc9aeaae972c5bbeb256c70450b7fe393a`

Model turns, agent sessions, and realtime sessions use separate provider protocols and
registry namespaces. `ModelProvider.streamTurn()` is canonical; collected model runs are
derived from that stream. Agent providers own durable session lifecycle. Realtime providers
own bidirectional low-latency transport and commands. A provider object may implement more
than one family, but registration and capability claims remain explicit per family.

This avoids making chat completions, cloud-agent jobs, or realtime sockets pretend to share
one lifecycle. Close hooks are deduplicated by object identity.
