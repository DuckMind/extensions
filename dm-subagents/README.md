# dm-subagents

Bundled DM extension for delegating tasks to specialized agents.

## Included tools and commands

- `subagent` tool: launch, inspect, steer, interrupt, resume, schedule, and manage subagent runs
- `wait` tool: block until active async subagent runs complete or need attention
- `/run`, `/chain`, `/parallel`, `/prompt-workflow`, `/chain-prompts`, and `/subagents-*` slash commands

## Current upstream shape

Technical provenance: this package is synced from `nicobailon/dm-subagents` release `v0.33.1`. DM ships the adapted source as `dm-subagents`.
The nicobailon source-layout release includes `subagent`, `wait`, slash commands, prompts, skills, and bundled agent definitions; legacy local-only overlays are not silently claimed here.

## Default paths

- User agents: `~/.dm/agent/agents/{name}.md`
- Project agents: `.dm/agents/{name}.md`
- Config: `~/.dm/agent/extensions/subagent/config.json`

## Environment

- Preferred recursion env: `DM_SUBAGENT_MAX_DEPTH`
- Compatibility fallback still accepted: `DM_SUBAGENT_MAX_DEPTH`

## Bundled with dm

No separate install step is required. The extension ships inside DM's bundled extension catalog and uses the `dm` CLI by default for delegated runs.
