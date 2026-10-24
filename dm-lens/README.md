# DM Lens

DM Lens is a bundled DM extension for real-time code feedback: LSP diagnostics,
linters, formatters, type checking, structural analysis, and focused project
reports.

## Installation

DM ships DM Lens with the published `dm` package. The managed source and
catalog provenance are recorded in this repository's `extensions/extensions.json`.
DM package and extension discovery use the DuckMind extension catalog; they do
not query a third-party product registry.

## Runtime contract

- Extension entry: `index.ts`
- DM package name: `dm-lens`
- Optional MCP commands: `dm-lens`, `dm-lens-mcp`, and `dm-lens-analyze`
- Configuration and environment variables use the `DM_LENS_` / `.dm-lens`
  namespace.

## Test-runner delivery

Lens stages test-runner findings at the idle boundary and consumes them
at the next turn's event handler. This no longer needs the legacy non-context
entry renderer or the old empty-message compatibility fallback.

The upstream source revision is recorded as technical provenance in the managed
extension catalog. It is not a runtime lookup endpoint.
