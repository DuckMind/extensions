# DM Skills Manager

`dm-skills-manager` is a bundled DM extension for browsing, previewing,
inserting, creating, editing, renaming, deleting, and toggling skills through
the `/skill` menu. Native `/skill:<name>` invocation remains available.

## Safety

- The extension only deletes top-level project or global skills owned by the
  current user.
- Delete actions require an explicit confirmation in the manager UI.
- Generated skills use the current DM model when enabled; a local fallback is
  used when generation is unavailable.

## Verification

Run `npm run verify` in this directory. The command typechecks runtime source
and runs the imported behavioral tests with Bun.
