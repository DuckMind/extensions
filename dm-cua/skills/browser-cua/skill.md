# Browser CUA

Use `browser_cua` when DM needs a live browser lane instead of a static fetch.

Recommended loop:

1. `browser_cua({ action: "list" })`
2. `browser_cua({ action: "snapshot" })` or `browser_cua({ action: "screenshot" })`
3. act with `navigate`, `click`, `click_xy`, `type`, or `evaluate`
4. verify again with `snapshot` or `screenshot`
5. `browser_cua({ action: "stop" })` when you want to close the dedicated browser lane

Rules:

- Start with an inspect action before click/type on unfamiliar pages.
- Prefer `navigate` for deterministic URLs, including search URLs.
- Use `screenshot` before complex click loops or when spatial layout matters.
- Fresh dedicated browser profiles auto-bootstrap a blank tab, so the first browser action should not fail just because the page list is empty.
- If the default Chrome/Chromium browser is absent, `browser_cua` attempts a non-interactive OS package-manager install before launch. Set `DM_CUA_AUTO_INSTALL=0` only when machine changes are not allowed.
- An explicit browser path remains authoritative and fails closed when invalid; do not hide a bad path by installing another browser.
- Default browser is the bundled Chrome/Chromium-compatible CDP lane. To evaluate CloakBrowser, install/pre-download CloakBrowser outside DM, then run with `DM_CUA_BROWSER=cloak` and `DM_CUA_BROWSER_PATH` or `CLOAKBROWSER_BINARY_PATH` pointing at its Chromium executable. DM must not bundle the compiled CloakBrowser binary because upstream permits use but not redistribution.
