# MCP scripting and semantic search

Jev semantic search is optional. Its default System One endpoint is `https://api.typesafe.ai/v1/systemone`.
Review the provider's terms at `https://docs.typesafe.ai/legal` for privacy and retention:
the no-training commitment does not mean zero retention.

Script evaluation remains disabled unless explicitly configured. The bundled
`examples/jev-semantic-filter.mjs` and `examples/jev-accessibility-loop.mjs`
are opt-in recipes, not automatically executed scripts. Review any third-party
code before enabling it.

Stdio MCP subprocesses inherit the host environment by default, including
credentials. Set `inheritEnv: false` on untrusted servers and explicitly allow
only the environment variables each subprocess needs.
