# DM MCP Adapter

`dm-mcp-adapter` is the bundled MCP (Model Context Protocol) extension for DM.

Configure servers in `~/.dm/agent/mcp.json` or `.dm/mcp.json`, then restart DM.

Use `/mcp` or `/dm-mcp` for the command surface. The `/pi-mcp` alias remains only as a compatibility fallback for existing automation and is not advertised by DM.

For package-provided configuration, use `dm.mcp`. An installed package's `pi.mcp` field is read only when `dm.mcp` is absent. Set `DM_MCP_CONFIG_MODE=exclusive` for DM-only config selection; `PI_MCP_CONFIG_MODE` is read only when the DM variable is unset.
