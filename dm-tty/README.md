# DM TTY

DM TTY exposes a local POSIX shell in an authenticated browser terminal.
Run `/tty start` in DM, or start a terminal-only service with
`dm --host 127.0.0.1 --port 8765`. Run `dm --host 0.0.0.0` only on a
network you trust: the token grants full shell access, and HTTP/WebSocket
traffic has no built-in TLS. Use HTTPS or an SSH tunnel remotely.

The browser opens a separate shell, not a mirror of your DM session. Run
`dm` in that shell to start a new session. Enter submits; Shift+Enter adds
a draft line. The native textarea supports Vietnamese IME and system
dictation without recording audio. The accessory bar offers terminal keys,
including Ctrl, Alt, arrows, Backspace, and F1–F12. Closing the browser
preserves the shell until DM TTY stops.

The Sessions menu discovers existing tmux and screen sessions, can create
one, and offers arrows to reorder the tabs on the current page. History
shows recent streamed output and lets you choose how many lines to display
(1–2,000); you can select text in the browser and use Copy. Retention is
bounded to 2,000 lines or 65,536 UTF-16 units. This is streamed text, so
terminal redraws can appear more than once. The old Select all output and
Copy all output buttons are no longer present.

The token is not included in URLs. **Save Access Token** persists it in
local storage for this browser origin only when you explicitly request it;
**Clear saved token** removes that copy. Scripts on the same origin can
read a saved token. Avoid shared browsers and untrusted origins. When
running `dm --host` with redirected stderr, pass `--token-file` to write
a private 0600 file, removed when the service stops.

The Python PTY bridge needs Python 3 and a POSIX host (macOS, Linux, or
WSL). Native Windows is unsupported. Desktop browser tests do not establish
native Safari/iOS Vietnamese keyboard or clipboard behavior.

Development verification: `npm run verify`.
