# Changelog

## [7.0.0] - 2026-10-25

### Changed

- Adapted the search presentation from pinned upstream `b41f334da85b7608f3ff9e64e41b675e2f5d51f0`: semantic search shows shapes for strong hits and marks extraction-enabled servers. The package retains DM runtime dependencies, CLI, settings and metadata identity. Upstream authorship and revision are recorded in `THIRD_PARTY_NOTICES.md`.
- First interactive session after an adapter update now shows up to five highlights from skipped releases once. Embedded installations using their own adapter config do not receive a notice.
- The draft is version `7.0.0` for the upstream release line; verification is still required before installation.

### Compatibility blockers

- This is a draft, not a verified DM release. Nested-call test fixtures still use a removed host helper; session guard behavior requires real-path verification.
- The draft preserves the bounded QuickJS `mcpScript` and JEV runtime code, which require end-to-end verification before release.

## [6.0.0] - 2026-10-22

### Highlights

- The adapter brings upstream 6.0.0 MCP discovery, Executor app tools, and script-tool surfaces into the DM draft; codemode-backed script execution still requires a DM host sandbox.
- The DM adapter retains its own package name, agent directory, runtime packages, and upgrade state.

### Provenance

- Adapted from the upstream MCP adapter at main `2c5a3762e3edae5b650d582bbc854318b3019027`; upstream release claims and the removal of `mcpScript` are not DM release claims. Source identity is recorded in `THIRD_PARTY_NOTICES.md`.
