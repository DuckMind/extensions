# DM MCP adapter and the host

The adapter adds configurable MCP transports, tool discovery, approvals, OAuth
storage, and bounded `mcpScript` execution to the DM host. The exact host
integration depends on the DM build installed alongside this extension; see
[configuration](configuration.md), [tool approval](tools.md), and
[scripting](scripting.md) for supported settings and security boundaries.

This document replaces a historical comparison of an upstream host's built-in
MCP feature. Its claims and documentation links did not describe measurements
on the current DM host.

## Measured with 100 servers

The upstream benchmark has not been reproduced on this DM build. Do not infer
DM startup time or memory savings from that result.

## Measured token cost

The upstream token-cost benchmark has not been reproduced on this DM build.
