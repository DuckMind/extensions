# dm-image2

Local bundled DM extension that exposes a dedicated `image_generation` tool.

What it does:

- vendors the `imagen.py` lane from M inside the DM package
- uses the active DM Ultradex / Codex account via a generated auth shim
- runs the bundled `imagen.py` orchestrator as the primary image lane
- bundles a pattern-only image prompt cookbook in `skills/image-generation/SKILL.md`, distilled from public prompt/reference case patterns, without calling third-party image APIs or external skill archives
- fails closed by default if `imagen.py` cannot run with a healthy credential source, so DM does not silently mask the required tool path
- keeps the image-generation workflow saved-to-disk instead of dumping raw image data inline
- returns the saved path plus an inline PNG preview in the TUI
- cooperates with DM abort signals so `Esc` / `Ctrl+C` can stop long image runs cleanly

Default save behavior:

- `save=project` → `<cwd>/.dm/generated-images/`
- `save=global` → `~/.dm/agent/generated-images/`
- `save=custom` → `saveDir`

This is a practical DM wrapper lane for image artifacts. It now uses the bundled `imagen.py` orchestrator from M as the required default PNG path so DM calls the same image-first tool family the operator requested.

Pattern skill note:

- `dm-image2` does not depend on external image-generation skill archives
- prompt patterns live directly in `skills/image-generation/SKILL.md`
- the skill teaches reusable visual workflows only; generation still happens through DM's `image_generation` tool and active DM credentials

Legacy fallback note:

- emergency-only debugging can opt into the older fallback lane with `DM_IMAGE_ALLOW_LEGACY_FALLBACK=1`
- the default behavior is intentionally strict so REQUESTS evidence is about the real `imagen.py` lane, not a masked fallback
