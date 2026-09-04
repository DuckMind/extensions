# dm-cliproxy

Bundled DM extension for managing model providers through one
[CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) endpoint.

## Use

Run `/cliproxy-setup` inside DM to create:

```text
~/.dm/agent/dm-cliproxy/config.json
```

Use `/cliproxy` to refresh discovery, inspect models and usage, or diagnose the
connection. A missing proxy never blocks DM startup.

Config values support literals, `$ENV_VAR`, and `!command`. Prefer environment
variables or a command that reads a `0600` secret file. Treat `!command` as
trusted local code.

## Compatibility

DM first tries the technical discovery route `/.well-known/pi`, then falls back
to the OpenAI-compatible `/v1/models` route. The protocol path remains unchanged
because changing it would break CliProxyAPI discovery.

On first load, DM may copy (never delete or overwrite) legacy config from:

```text
~/.pi/agent/pi-cliproxyapi/config.json
~/.config/pi-cliproxyapi/config.json
```

The new directory is forced to mode `0700` and the copied config to `0600`.
Legacy paths exist only as compatibility fallbacks.

## Provenance

The managed source is adapted from `abix5/pi-cliproxyapi` at pinned revision
`b0ce7712f95eab9035b85dfa05aee0352b40c546`. This is technical provenance;
the shipped product and extension are DM.
