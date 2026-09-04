# dm-cua

Browser-first Computer Use extension for DM.

What it does:

- launches or reuses a dedicated, project-scoped browser profile via bundled DM CUA CDP helpers
- discovers Chrome/Chromium and, when none is present, attempts a non-interactive OS package-manager install before launch
- bootstraps a blank tab on fresh empty profiles so browser automation does not fail on the first run
- exposes one tool, `browser_cua`, for list / navigate / snapshot / screenshot / click / type / evaluate / handoff / stop
- stores browser screenshots under `~/.dm/agent/cua/screenshots/` by default
- retains browser cookies and session state at `~/.dm/agent/cua/profiles/` by default, scoped to the DM project; set `DM_CUA_EPHEMERAL=1` for a disposable temporary profile or `DM_CUA_PROFILE_DIR` for an explicit profile location

Browser selection:

- default: Chrome/Chromium discovered by `dm-cua`; if absent, DM tries Homebrew on macOS, winget then Chocolatey on Windows, or a supported system package manager on Linux
- set `DM_CUA_AUTO_INSTALL=0` to disable installation side effects and fail with a clear blocker
- an explicitly configured browser path that does not exist always fails closed; DM does not replace that choice with an automatic install
- opt-in CloakBrowser trial: set `DM_CUA_BROWSER=cloak` and one of `DM_CUA_BROWSER_PATH`, `DM_CUA_CLOAK_PATH`, `CLOAKBROWSER_BINARY_PATH`, or `CHROME_PATH` to the CloakBrowser Chromium executable
- DM does not bundle or auto-download the compiled CloakBrowser binary; install/pre-download it outside DM first because upstream permits use but not redistribution
- Current `browser_cua` actions use bundled CDP commands; full CloakBrowser stealth parity would require a future Playwright-backed CUA lane.

What it does **not** do yet:

- it does not replace the macOS `computer-use` Codex plugin lane
- it does not replace Android `adbridge`

Those broader lanes are still tracked separately. This extension closes the most actionable CUA gap from the current DM snapshot: a first-class browser lane that works from a fresh dedicated browser profile instead of overloading `coding_task`.

## Human verification and login

When a page asks for a login or a human-only check (for example Cloudflare,
reCAPTCHA, AWS WAF, or Geetest), call `browser_cua` with `action: "handoff"`.
DM relaunches its dedicated browser visibly and leaves the window open for the
user to complete only the interaction they authorize. It does not solve
challenges, enter credentials, or read secrets on the user's behalf. After the
user returns to DM, later CUA calls reuse the retained project-scoped profile,
so a successfully completed session does not need another GUI handoff unless
the site asks again.
