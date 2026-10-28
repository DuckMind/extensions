# MCP scripting and semantic search

Jev semantic search is optional. Its default System One endpoint is `https://api.typesafe.ai/v1/systemone`.
Review the provider's terms at `https://docs.typesafe.ai/legal` for privacy and retention:
the no-training commitment does not mean zero retention.

## Semantic search

`settings.semanticSearch` controls classifier-backed MCP tool search. Use
`/mcp-adapter semantic setup` to select servers; `false` turns it off. Only
enable a provider after reviewing where its search inputs are sent. Jev is a
separate opt-in search integration with the System One endpoint above.

## Moving from a System One key

If a config still has `settings.jev`, review the adapter's migration notice
and move to `settings.semanticSearch`. Do not copy a provider key into a
project file.

## Typed values from tool results

`settings.extraction` is off unless configured with `allowedServers` and a
supported Cloudflare Clairic model. Only allow servers whose tool results you
approve sending to that model; see [configuration](configuration.md#settings).

## Scripting MCP calls with DM's codemode

DM's `codemode` and `tool_search` can find and call deferred MCP tools through
the host's nested tool API. The adapter also retains its own `mcpScript` tool:
set `settings.scriptMode: true` to enable bounded QuickJS scripts that call MCP
tools through `tools.search`, `tools.describe`, and `tools.call`. MCP calls
still follow server approval settings. These are separate scripting paths.

## Script tools

Top-level `scriptTools` entries save operator-approved codemode scripts as
`mcp__script__<name>` deferred tools. See [script tool configuration](configuration.md#script-tools)
for the schema, trust rules, and optional `declare` setting. Project entries
require project trust and approval before they run.

## Saving a script as a tool

The `mcp({ action: "save-script" })` action previews a proposed script and
config entry for operator approval before writing them. See
[script tools](configuration.md#script-tools) for where entries are stored.

Script evaluation remains disabled unless explicitly configured. The bundled
`examples/jev-semantic-filter.mjs` and `examples/jev-accessibility-loop.mjs`
are opt-in recipes, not automatically executed scripts. Review any third-party
code before enabling it.

Stdio MCP subprocesses inherit the host environment by default, including
credentials. Set `inheritEnv: false` on untrusted servers and explicitly allow
only the environment variables each subprocess needs.
