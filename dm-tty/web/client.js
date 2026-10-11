/* Browser-only: token is persisted only on an explicit Save click. */
const token = document.querySelector("#token");
const saveToken = document.querySelector("#save-token");
const clearToken = document.querySelector("#clear-token");
const tokenStatus = document.querySelector("#token-status");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const state = document.querySelector("#state");
const sessionMenu = document.querySelector("#session-menu");
const tabs = document.querySelector("#tabs");
const tabOrder = document.querySelector("#tab-order");
const sessionCreate = document.querySelector("#session-create");
const sessionName = document.querySelector("#session-name");
const sessionBackend = document.querySelector("#session-backend");
const sessionRefresh = document.querySelector("#session-refresh");
const sessionAdd = document.querySelector("#session-add");
const command = document.querySelector("#command");
const commandForm = document.querySelector("#command-form");
const commandPreview = document.querySelector("#command-preview");
const commandBefore = document.querySelector("#command-before");
const commandSelection = document.querySelector("#command-selection");
const commandAfter = document.querySelector("#command-after");
const commandCaret = document.querySelector("#command-caret");
const terminalContainer = document.querySelector("#terminal");
const historyButton = document.querySelector("#history");
const historyPanel = document.querySelector("#history-panel");
const historyText = document.querySelector("#history-text");
const historyLines = document.querySelector("#history-lines");
const historyCopy = document.querySelector("#history-copy");
const copyStatus = document.querySelector("#copy-status");
const accessory = document.querySelector("#accessory");
const ctrlButton = document.querySelector("#ctrl");
const altButton = document.querySelector("#alt");
const moreButton = document.querySelector("#more");
const functionKeys = document.querySelector("#function-keys");
const keyStrips = [
	{ strip: document.querySelector("#primary-key-strip"), row: document.querySelector("#primary-key-row") },
	{ strip: functionKeys, row: document.querySelector("#extra-key-row") },
];
function updateKeyScroll({ strip, row }) {
	if (strip.hidden) return;
	const [left, right] = strip.querySelectorAll(".key-scroll");
	const overflow = row.scrollWidth > row.clientWidth + 1;
	left.hidden = right.hidden = !overflow;
	left.disabled = !overflow || row.scrollLeft <= 1;
	right.disabled = !overflow || row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
}
for (const entry of keyStrips) {
	entry.row.addEventListener("scroll", () => updateKeyScroll(entry));
	new ResizeObserver(() => updateKeyScroll(entry)).observe(entry.row);
}
window.addEventListener("resize", () => keyStrips.forEach(updateKeyScroll));
keyStrips.forEach(updateKeyScroll);
const terminal = new Terminal({
	cursorBlink: true,
	cursorInactiveStyle: "none",
	scrollback: 2000,
	fontSize: 14,
	theme: { background: "#10131b", foreground: "#e2e8f0", cursor: "#c4b5fd" },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(terminalContainer);
let socket;
let authenticated = false;
let pendingOutput = 0;
let replayWrites = 0;
let connectionGeneration = 0;
let composingCommand = false;
let commandSettling = false;
let pendingCommandSubmit = false;
let remoteEditing = false;
let speechDraft = false;
let lastNativeValue = "";
let deletingLocalDraft = false;
let nativeDeleteHeld = false;
let deletionBoundaryTimer;
let ctrl = 0;
let alt = 0;
let lastAltTap = 0;
let lastCtrlTap = 0;
let ctrlHold;
let heldCtrl = false;
let compositionDraft = "";
let draftLineBreak = false;
let nativeReturn = null;
let commandFrame = 0;
let accessoryHold;
let accessoryTimer;
let consumedPointerClick;
let activeSessionId = "shell";
let pendingSessionId = null;
let sessionOrder = [];
let currentSessions = [];
const drafts = new Map();
let modifierInput = null;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const MAX_HISTORY_CHARS = 65_536;
const MAX_HISTORY_LINES = 2_000;
let streamHistory = "";
let historyEscape = "text";
let historyFrozen = false;
let selectedForCopy = null;
let displayedHistoryLines = MAX_HISTORY_LINES;
const TOKEN_STORAGE_KEY = "dm-tty-access-token";
try {
	token.value = localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
} catch { /* Storage may be blocked; manual entry still works. */ }
saveToken.addEventListener("click", () => {
	if (!token.value) { tokenStatus.textContent = "Enter an access token before saving"; return; }
	try {
		localStorage.setItem(TOKEN_STORAGE_KEY, token.value);
		tokenStatus.textContent = "Access token saved in this browser";
	} catch { tokenStatus.textContent = "Browser storage unavailable; token was not saved"; }
});
clearToken.addEventListener("click", () => {
	token.value = "";
	try {
		localStorage.removeItem(TOKEN_STORAGE_KEY);
		tokenStatus.textContent = "Saved token and input cleared";
	} catch { tokenStatus.textContent = "Input cleared; browser storage unavailable, saved token may remain"; }
});
function visibleHistory() {
	if (displayedHistoryLines === MAX_HISTORY_LINES) return streamHistory;
	const lines = streamHistory.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.slice(-displayedHistoryLines).join("\n");
}
function refreshHistory() {
	clearOutputSelection();
	historyFrozen = false;
	historyText.textContent = visibleHistory();
	historyPanel.scrollTop = historyPanel.scrollHeight;
}
historyLines.addEventListener("change", () => {
	const count = Number(historyLines.value);
	displayedHistoryLines = historyLines.value.trim() && Number.isFinite(count)
		? Math.max(1, Math.min(MAX_HISTORY_LINES, Math.trunc(count))) : MAX_HISTORY_LINES;
	historyLines.value = String(displayedHistoryLines);
	if (!historyPanel.hidden) refreshHistory();
});

function outputSelection() {
	const selection = document.getSelection?.();
	if (!selection || !historyText.contains(selection.anchorNode) || !historyText.contains(selection.focusNode)) return null;
	return selection.toString() || null;
}
function clearOutputSelection() {
	if (outputSelection()) document.getSelection().removeAllRanges();
}

function closeHistory() {
	clearOutputSelection();
	historyPanel.hidden = true;
	historyFrozen = false;
	selectedForCopy = null;
	historyButton.setAttribute("aria-expanded", "false");
	historyButton.textContent = "History";
}
function resetHistory() {
	closeHistory();
	streamHistory = "";
	historyEscape = "text";
	historyText.textContent = "";
	copyStatus.textContent = "";
}
function appendHistory(data) {
	// This is a bounded text transcript, not a second terminal emulator. Never
	// expose control sequences as text or allow the panel to send PTY input.
	let clean = "";
	for (const char of data) {
		if (historyEscape === "text") {
			if (char === "\x1b") historyEscape = "escape";
			else if (char === "\x9b") historyEscape = "csi";
			else if (char === "\x9d" || char === "\x90" || char === "\x9e" || char === "\x9f") historyEscape = "string";
			else if (char === "\n" || char === "\t" || char >= " ") clean += char;
		} else if (historyEscape === "escape") {
			if (char === "[") historyEscape = "csi";
			else if ("PX]^_".includes(char)) historyEscape = "string";
			else if (char === "(" || char === ")" || char === "#" || char === "%") historyEscape = "escape-arg";
			else historyEscape = char === "\x1b" ? "escape" : "text";
		} else if (historyEscape === "escape-arg") {
			historyEscape = "text";
		} else if (historyEscape === "csi") {
			if (char >= "@" && char <= "~") {
				// Cursor-addressed redraws have no newline; separate their text.
				if ("HfEd".includes(char) && clean && !clean.endsWith("\n")) clean += "\n";
				historyEscape = "text";
			} else if (char === "\x1b") historyEscape = "escape";
		} else if (historyEscape === "string") {
			if (char === "\x07" || char === "\x9c") historyEscape = "text";
			else if (char === "\x1b") historyEscape = "string-end";
		} else if (historyEscape === "string-end") {
			historyEscape = char === "\\" ? "text" : char === "\x1b" ? "string-end" : "string";
		}
	}
	streamHistory += clean;
	if (streamHistory.length > MAX_HISTORY_CHARS) streamHistory = streamHistory.slice(-MAX_HISTORY_CHARS);
	const lines = streamHistory.split("\n");
	if (lines.length > MAX_HISTORY_LINES) streamHistory = lines.slice(-MAX_HISTORY_LINES).join("\n");
	if (!historyPanel.hidden && !historyFrozen) {
		const atBottom = historyPanel.scrollTop + historyPanel.clientHeight >= historyPanel.scrollHeight - 2;
		historyText.textContent = visibleHistory();
		if (atBottom) historyPanel.scrollTop = historyPanel.scrollHeight;
	}
}
historyPanel.hidden = true;
historyButton.hidden = true;
function openHistory() {
	if (!authenticated || pendingSessionId || historyButton.hidden) return false;
	if (!historyPanel.hidden) return true;
	connectionGeneration++; // Cancel an Enter queued before opening history.
	pendingCommandSubmit = false;
	historyPanel.hidden = false;
	historyFrozen = false;
	historyText.textContent = visibleHistory();
	historyPanel.scrollTop = historyPanel.scrollHeight;
	historyButton.setAttribute("aria-expanded", "true");
	historyButton.textContent = "Live";
	historyPanel.focus();
	return true;
}
function selectAllOutput() {
	if (!openHistory() || !historyText.textContent) return false;
	historyFrozen = true;
	const range = document.createRange();
	range.selectNodeContents(historyText);
	const selection = document.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
	return true;
}
async function copyOutputText(selectedText = null) {
	if (!openHistory()) return;
	const text = selectedText || outputSelection() || historyText.textContent;
	if (!text) { copyStatus.textContent = "No output to copy"; return; }
	const generation = connectionGeneration;
	historyFrozen = true;
	let copied = false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			copied = true;
		}
	} catch { /* HTTP, insecure contexts and denied permission can use native Copy. */ }
	if (!copied && generation === connectionGeneration && authenticated) {
		if (outputSelection() === text || (!selectedText && selectAllOutput())) {
			try { copied = document.execCommand("copy"); } catch { /* Leave text selected for the browser Copy menu. */ }
		}
	}
	if (generation === connectionGeneration && authenticated) {
		copyStatus.textContent = copied ? "Copied output" : "Select text and use the browser Copy menu";
	}
}
historyText.addEventListener("pointerdown", () => { historyFrozen = true; });
document.addEventListener("selectionchange", () => {
	if (!historyPanel.hidden && outputSelection()) historyFrozen = true;
});
historyPanel.addEventListener("keydown", (event) => {
	if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		selectAllOutput();
	}
});
historyButton.addEventListener("click", () => {
	if (historyPanel.hidden) openHistory();
	else { closeHistory(); focusCommand(); }
});
historyCopy.addEventListener("pointerdown", () => { selectedForCopy = outputSelection(); });
historyCopy.addEventListener("click", () => {
	const selected = selectedForCopy || outputSelection();
	selectedForCopy = null;
	return copyOutputText(selected);
});

function updateModifiers() {
	ctrlButton.textContent = ctrl === 2 ? "CTRL 🔒" : ctrl ? "CTRL" : "Ctrl";
	ctrlButton.setAttribute("aria-pressed", String(ctrl > 0));
	ctrlButton.dataset.locked = String(ctrl === 2);
	altButton.textContent = alt === 2 ? "ALT 🔒" : alt ? "ALT" : "Alt";
	altButton.setAttribute("aria-pressed", String(alt > 0));
	altButton.dataset.locked = String(alt === 2);
}
function resetModifiers() {
	ctrl = 0;
	alt = 0;
	lastAltTap = 0;
	lastCtrlTap = 0;
	clearTimeout(ctrlHold);
	updateModifiers();
}

function setState(text, connected = false) {
	state.textContent = text;
	state.title = text;
	state.dataset.connected = String(connected);
	disconnect.disabled = !socket;
	sessionRefresh.disabled = !authenticated;
	sessionAdd.disabled = !authenticated;
	for (const button of accessory.querySelectorAll("button")) {
		if (!button.dataset.scroll) button.disabled = !connected;
	}
	if (!connected) {
		stopAccessoryHold();
		stopNativeDeletion();
		resetModifiers();
	}
}
function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function renderSessions(sessions = [], active) {
	historyButton.hidden = !authenticated;
	if (historyButton.hidden) closeHistory();
	if (!Array.isArray(sessions) || !sessions.length) {
		tabs.hidden = true;
		tabs.innerHTML = "";
		tabOrder.innerHTML = "";
		currentSessions = [];
		sessionOrder = [];
		return;
	}
	currentSessions = sessions.filter((session) => session && typeof session.id === "string");
	const ids = new Set(currentSessions.map((session) => session.id));
	sessionOrder = [...sessionOrder.filter((id) => ids.has(id)), ...currentSessions.map((session) => session.id).filter((id) => !sessionOrder.includes(id))];
	const ordered = sessionOrder.map((id) => currentSessions.find((session) => session.id === id));
	activeSessionId = typeof active?.id === "string" ? active.id : activeSessionId;
	tabs.innerHTML = ordered.map((session) => {
		if (!session || typeof session.id !== "string") return "";
		const id = encodeURIComponent(session.id);
		const label = escapeHtml(typeof session.label === "string" ? session.label : session.id);
		const selected = session.id === activeSessionId;
		return `<button type="button" role="tab" data-session-id="${escapeHtml(id)}" aria-selected="${selected}" data-attached="${session.attached === true}">${label}</button>`;
	}).join("");
	tabOrder.innerHTML = ordered.map((session, index) => {
		const id = escapeHtml(encodeURIComponent(session.id));
		const label = escapeHtml(typeof session.label === "string" ? session.label : session.id);
		return `<div class="tab-order-row"><span title="${label}">${label}</span><button type="button" data-move-id="${id}" data-direction="-1" aria-label="Move ${label} left" ${index === 0 ? "disabled" : ""}>←</button><button type="button" data-move-id="${id}" data-direction="1" aria-label="Move ${label} right" ${index === ordered.length - 1 ? "disabled" : ""}>→</button></div>`;
	}).join("");
	tabs.hidden = ordered.length < 2;
}
tabOrder.addEventListener("click", (event) => {
	const button = event.target?.closest?.("button[data-move-id]");
	if (!button || button.disabled || !authenticated) return;
	const id = decodeURIComponent(button.dataset.moveId ?? "");
	const index = sessionOrder.indexOf(id);
	const next = index + Number(button.dataset.direction);
	if (index < 0 || next < 0 || next >= sessionOrder.length || Math.abs(next - index) !== 1) return;
	[sessionOrder[index], sessionOrder[next]] = [sessionOrder[next], sessionOrder[index]];
	renderSessions(currentSessions, { id: activeSessionId });
	// Replacing the row also replaces the clicked button; keep keyboard reordering usable.
	const replacement = [...tabOrder.querySelectorAll("button[data-move-id]")].find((candidate) =>
		candidate.dataset.moveId === button.dataset.moveId && candidate.dataset.direction === button.dataset.direction);
	if (replacement && !replacement.disabled) replacement.focus();
});

function saveDraft() {
	drafts.set(activeSessionId, {
		value: command.value, start: command.selectionStart ?? command.value.length,
		end: command.selectionEnd ?? command.value.length, speech: speechDraft,
	});
}
function restoreDraft(id) {
	const draft = drafts.get(id);
	command.value = draft?.value ?? "";
	command.setSelectionRange(draft?.start ?? 0, draft?.end ?? 0);
	speechDraft = draft?.speech ?? false;
	lastNativeValue = command.value;
	positionCommand();
}
function beginSessionChange(id, message) {
	if (!authenticated || pendingSessionId || composingCommand || commandSettling || id === activeSessionId) return;
	saveDraft();
	stopAccessoryHold();
	stopNativeDeletion();
	pendingSessionId = id;
	connectionGeneration++; // Cancel any deferred Enter against the old attachment.
	pendingCommandSubmit = false;
	if (!send(message)) pendingSessionId = null;
}
function send(message) {
	if (authenticated && socket?.readyState === WebSocket.OPEN) {
		if (message.type === "input" && !historyPanel.hidden) return false;
		if (pendingSessionId && (message.type === "input" || message.type === "resize")) return false;
		if (socket.bufferedAmount > 256 * 1024) {
			socket.close();
			setState("Input congested; reconnect");
			return false;
		}
		socket.send(JSON.stringify({ v: 1, ...message,
			...(["input", "resize"].includes(message.type) ? { sessionId: activeSessionId } : {}) }));
		return true;
	}
	return false;
}

function resize() {
	fit.fit();
	positionCommand();
	send({ type: "resize", cols: Math.max(2, Math.min(500, terminal.cols)), rows: Math.max(1, Math.min(200, terminal.rows)) });
}
function positionCommand() {
	if (commandFrame) return;
	commandFrame = requestAnimationFrame(() => {
		commandFrame = 0;
		renderCommand();
	});
}
function renderCommand() {
	// Render unsubmitted text separately from PTY output; never parse it as HTML/ANSI.
	const start = command.selectionStart ?? command.value.length;
	const end = command.selectionEnd ?? start;
	commandBefore.textContent = command.value.slice(0, start);
	commandSelection.textContent = command.value.slice(start, end);
	commandAfter.textContent = command.value.slice(end);
	const screen = terminal.element?.querySelector(".xterm-screen");
	if (!screen) return;
	const containerRect = terminalContainer.getBoundingClientRect();
	const screenRect = screen.getBoundingClientRect();
	const cellWidth = screenRect.width / terminal.cols;
	const cellHeight = screenRect.height / terminal.rows;
	const top = screenRect.top - containerRect.top + terminal.buffer.active.cursorY * cellHeight;
	commandForm.style.left = `${screenRect.left - containerRect.left}px`;
	commandForm.style.width = `${screenRect.width}px`;
	commandForm.style.textIndent = `${terminal.buffer.active.cursorX * cellWidth}px`;
	commandForm.style.lineHeight = `${cellHeight}px`;
	// Only the text preview wraps. The invisible native IME proxy stays one cell.
	const height = Math.min(Math.max(cellHeight, commandPreview.scrollHeight), cellHeight * 8, screenRect.height);
	commandForm.style.maxHeight = `${height}px`;
	commandForm.style.top = `${Math.max(screenRect.top - containerRect.top, Math.min(top, screenRect.bottom - containerRect.top - height))}px`;
	commandForm.scrollTop = Math.max(0, commandCaret.offsetTop + cellHeight - height);
	const caretRect = commandCaret.getBoundingClientRect();
	const formRect = commandForm.getBoundingClientRect();
	command.style.width = `${cellWidth}px`;
	command.style.height = `${cellHeight}px`;
	command.style.left = `${Math.max(0, Math.min(screenRect.width - cellWidth, caretRect.left - formRect.left))}px`;
	command.style.top = `${Math.max(0, caretRect.top - formRect.top + commandForm.scrollTop)}px`;
}
function focusCommand() {
	if (!authenticated || !historyPanel.hidden) return;
	commandForm.hidden = false;
	positionCommand();
	command.focus({ preventScroll: true });
}
function controlCharacter(key) {
	if (key === " ") return "\x00";
	if (key === "?") return "\x7f";
	const code = key.toUpperCase().charCodeAt(0);
	return key.length === 1 && code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
}
function keySequence(key, shift = false, control = false, meta = false) {
	const modifier = 1 + Number(shift) + 2 * Number(meta) + 4 * Number(control);
	const arrows = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
	if (arrows[key]) return modifier > 1 ? `\x1b[1;${modifier}${arrows[key]}`
		: `${terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b["}${arrows[key]}`;
	if (/^F([1-9]|1[0-2])$/.test(key)) {
		const n = Number(key.slice(1));
		if (n <= 4) return modifier > 1 ? `\x1b[1;${modifier}${"PQRS"[n - 1]}` : `\x1bO${"PQRS"[n - 1]}`;
		return `\x1b[${[15, 17, 18, 19, 20, 21, 23, 24][n - 5]}${modifier > 1 ? `;${modifier}` : ""}~`;
	}
	if (key === "Delete" || key === "Insert") return `\x1b[${key === "Delete" ? 3 : 2}${modifier > 1 ? `;${modifier}` : ""}~`;
	if (key === "PageUp" || key === "PageDown") return `\x1b[${key === "PageUp" ? 5 : 6}${modifier > 1 ? `;${modifier}` : ""}~`;
	if (key === "Tab") return shift ? "\x1b[Z" : meta ? "\x1b\t" : "\t";
	if (key === "Escape") return meta ? "\x1b\x1b" : "\x1b";
	if (key === "Enter") return meta ? "\x1b\r" : "\r";
	if (key === "Backspace") return meta ? "\x1b\x7f" : control ? "\x08" : "\x7f";
	const character = control ? controlCharacter(key) : key.length === 1 ? key : null;
	return character === null ? null : `${meta ? "\x1b" : ""}${character}`;
}
function terminalKey(key, shift = false, control = false, meta = false) {
	if (composingCommand || commandSettling || !authenticated || pendingSessionId || !historyPanel.hidden) return false;
	if (speechDraft && command.value && key !== "Enter" && !(key.toLowerCase() === "c" && (control || ctrl))) {
		setState("Submit the speech draft with Enter, or Ctrl+C to cancel", true);
		return false;
	}
	if (speechDraft && key === "Enter" && !control && !meta && !ctrl && !alt && command.value) {
		submitCommand();
		return true;
	}
	if (key === "Enter" && !shift && !control && !meta && !ctrl && !alt && !remoteEditing && command.value) {
		submitCommand();
		return true;
	}
	if ((key === "PageUp" || key === "PageDown") && terminal.buffer.active.type !== "alternate") {
		terminal.scrollPages(key === "PageUp" ? -1 : 1);
		return true;
	}
	const data = keySequence(key, shift, control || ctrl > 0, meta || alt > 0);
	if (data === null) return false;
	// Never execute a multiline paste as a side effect of Tab/history/control keys.
	if (command.value.includes("\n") && data !== "\x03") {
		setState("Send the multiline draft first, or Ctrl+C to cancel", true);
		return false;
	}
	if (!send({ type: "input", data: `${data === "\x03" ? "" : command.value}${data}` })) return false;
	command.value = "";
	lastNativeValue = "";
	if (data === "\x03") speechDraft = false;
	remoteEditing = data !== "\r" || terminal.buffer.active.type === "alternate";
	if (ctrl === 1) { ctrl = 0; lastCtrlTap = 0; }
	if (alt === 1) { alt = 0; lastAltTap = 0; }
	updateModifiers();
	positionCommand();
	return true;
}
function deleteDraft() {
	if (composingCommand || commandSettling || !authenticated) return false;
	const end = command.selectionEnd ?? command.value.length;
	const cursor = command.selectionStart ?? end;
	if (!end && !cursor) return false;
	let start = cursor;
	if (start === end) {
		if (graphemes) {
			for (const part of graphemes.segment(command.value.slice(0, start))) start = part.index;
		} else start -= Array.from(command.value.slice(0, start)).pop()?.length ?? 0;
	}
	command.setRangeText("", start, end);
	lastNativeValue = command.value;
	positionCommand();
	return true;
}
function accessoryKey(key) {
	if (!historyPanel.hidden) return false;
	if (key === "Backspace" && !remoteEditing && !ctrl && !alt
		&& terminal.buffer.active.type !== "alternate" && command.value) return deleteDraft();
	return terminalKey(key);
}
function stopAccessoryHold() {
	clearTimeout(accessoryTimer);
	accessoryHold = undefined;
}
function stopNativeDeletion() {
	clearTimeout(deletionBoundaryTimer);
	deletingLocalDraft = false;
	nativeDeleteHeld = false;
}
function extendNativeDeletion() {
	deletingLocalDraft = true;
	clearTimeout(deletionBoundaryTimer);
	// Soft keyboards may omit keyup; allow the next distinct tap after an idle gap.
	if (!nativeDeleteHeld) deletionBoundaryTimer = setTimeout(stopNativeDeletion, 250);
}
new ResizeObserver(resize).observe(terminalContainer);
terminal.onCursorMove(positionCommand);
terminal.textarea.addEventListener("focus", () => { commandForm.hidden = true; });
// Historical device queries must not inject fresh replies into the attached shell.
terminal.onData((data) => { if (!replayWrites) send({ type: "input", data }); });
terminal.onBinary((data) => { if (!replayWrites) send({ type: "input", data }); });
terminal.attachCustomKeyEventHandler((event) => {
	if (!authenticated || pendingSessionId) return false;
	if (event.type !== "keydown" || (!ctrl && !alt)) return true;
	if (event.metaKey || (event.ctrlKey && event.shiftKey && ["c", "v"].includes(event.key.toLowerCase()))) return true;
	event.preventDefault();
	terminalKey(event.key, event.shiftKey, event.ctrlKey, event.altKey);
	return false;
});
// xterm focuses its own textarea on click. Keep native IME as the default
// at the shell prompt; preserve output selection and full-screen terminal use.
terminalContainer.addEventListener("click", () => {
	if (authenticated && terminal.buffer.active.type !== "alternate"
		&& !terminal.hasSelection() && !document.getSelection?.()?.toString()) {
		remoteEditing = false;
		focusCommand();
	}
});
command.addEventListener("keydown", (event) => {
	draftLineBreak = event.key === "Enter" && event.shiftKey && !remoteEditing;
	// Safari can report composition-confirming Enter with keyCode 229 after compositionend.
	if (event.isComposing || (event.keyCode === 229 && event.key === "Enter") || composingCommand) return;
	if (["Backspace", "Delete"].includes(event.key) && !remoteEditing && command.value) nativeDeleteHeld = true;
	if (["Backspace", "Delete"].includes(event.key) && deletingLocalDraft && !command.value) {
		event.preventDefault();
		extendNativeDeletion();
		return;
	}
	if (terminal.buffer.active.type === "alternate" && !speechDraft) remoteEditing = true;
	if (event.metaKey || (event.ctrlKey && event.shiftKey && ["c", "v"].includes(event.key.toLowerCase()))) return;
	if (event.ctrlKey && event.key.toLowerCase() === "v" && !ctrl) return;
	if (event.ctrlKey || event.altKey || ctrl || alt || /^(Tab|Escape|Arrow|Home|End|Page|F\d|Delete)/.test(event.key)
		|| (remoteEditing && !speechDraft && event.key === "Enter")
		|| ((remoteEditing || !command.value) && event.key === "Backspace")) {
		event.preventDefault();
		terminalKey(event.key, event.shiftKey, event.ctrlKey, event.altKey);
		return;
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		if (command.value) submitCommand();
		else terminalKey("Enter");
	}
});
command.addEventListener("keyup", (event) => {
	if (["Backspace", "Delete"].includes(event.key)) stopNativeDeletion();
});
command.addEventListener("beforeinput", (event) => {
	const lineBreak = ["insertLineBreak", "insertParagraph"].includes(event.inputType);
	if (lineBreak && (event.isComposing || composingCommand || commandSettling)) {
		if (event.cancelable !== false) event.preventDefault();
		else rememberNativeReturn();
		return;
	}
	if (event.isComposing || composingCommand || commandSettling) return;
	if (["insertReplacementText", "insertFromDictation"].includes(event.inputType)
		|| (event.inputType === "insertFromPaste" && remoteEditing)) {
		speechDraft = true;
		remoteEditing = false;
	}
	if (lineBreak) {
		if (draftLineBreak) { draftLineBreak = false; return; }
		if (speechDraft) return;
		if (event.cancelable !== false) event.preventDefault();
		if (!remoteEditing && command.value) submitCommand();
		else terminalKey("Enter");
		if (event.cancelable === false) rememberNativeReturn();
		return;
	}
	if ((ctrl || alt) && event.data?.length === 1 && event.inputType === "insertText") {
		if (event.cancelable !== false) {
			event.preventDefault();
			if (terminalKey(event.data)) {
				modifierInput = event.data;
				setTimeout(() => { modifierInput = null; }, 0);
			}
		}
	} else if ((remoteEditing || !command.value) && ["deleteContentBackward", "deleteContentForward"].includes(event.inputType)) {
		if (event.cancelable !== false) {
			event.preventDefault();
			if (deletingLocalDraft) extendNativeDeletion();
			else terminalKey(event.inputType === "deleteContentBackward" ? "Backspace" : "Delete");
		}
	}
});
function rememberNativeReturn() {
	const value = command.value;
	const start = command.selectionStart;
	const end = command.selectionEnd;
	nativeReturn = {
		value, start, end, generation: connectionGeneration,
		expected: `${value.slice(0, start)}\n${value.slice(end)}`,
	};
}
function sendRemoteText() {
	if (terminal.buffer.active.type === "alternate" && !speechDraft) remoteEditing = true;
	if (!remoteEditing || speechDraft || composingCommand || commandSettling || !command.value) return;
	const text = command.value;
	if ((ctrl || alt) && text.length === 1) {
		command.value = "";
		if (!terminalKey(text)) command.value = text;
		return;
	}
	const data = terminal.modes.bracketedPasteMode && text.length > 1
		? `\x1b[200~${text.replace(/\r?\n/g, "\r")}\x1b[201~` : text;
	if (send({ type: "input", data })) { command.value = ""; lastNativeValue = ""; }
}
command.addEventListener("input", (event) => {
	if (nativeReturn) {
		const pending = nativeReturn;
		nativeReturn = null;
		if (pending.generation === connectionGeneration
			&& ["insertLineBreak", "insertParagraph"].includes(event.inputType)
			&& command.value === pending.expected) {
			command.value = pending.value;
			command.setSelectionRange(pending.start, pending.end);
			lastNativeValue = command.value;
			positionCommand();
			return;
		}
	}
	if (modifierInput && event.inputType === "insertText" && event.data === modifierInput) {
		modifierInput = null;
		command.value = lastNativeValue;
		positionCommand();
		return;
	}
	if ((ctrl || alt) && event.inputType === "insertText" && event.data?.length === 1
		&& !composingCommand && !commandSettling) {
		const committed = command.value;
		command.value = lastNativeValue;
		if (!terminalKey(event.data)) command.value = committed;
		lastNativeValue = command.value;
		positionCommand();
		return;
	}
	const deleting = ["deleteContentBackward", "deleteContentForward"].includes(event.inputType);
	if (deleting && (deletingLocalDraft || lastNativeValue)) extendNativeDeletion();
	else if (!deleting) stopNativeDeletion();
	if (!composingCommand && !commandSettling
		&& (["insertReplacementText", "insertFromDictation"].includes(event.inputType)
			|| (remoteEditing && (event.inputType === "insertFromPaste"
				|| (event.data?.length > 1 && event.inputType === "insertText"))))) {
		speechDraft = true;
		remoteEditing = false;
	}
	if (deleting && !command.value && !lastNativeValue && !deletingLocalDraft && !composingCommand && !commandSettling) {
		// Some iOS keyboards deliver only input, with no cancelable beforeinput/keydown.
		terminalKey(event.inputType === "deleteContentBackward" ? "Backspace" : "Delete");
	}
	lastNativeValue = command.value;
	sendRemoteText();
	positionCommand();
});
command.addEventListener("select", positionCommand);
command.addEventListener("compositionstart", () => { stopAccessoryHold(); stopNativeDeletion(); composingCommand = true; compositionDraft = command.value; });
command.addEventListener("compositionend", (event) => {
	composingCommand = false;
	commandSettling = true;
	const generation = connectionGeneration;
	const modifierCharacter = (ctrl || alt) && event.data?.length === 1 ? event.data : null;
	// Safari may dispatch Enter/submit before the IME's final input event.
	setTimeout(() => {
		commandSettling = false;
		if (generation !== connectionGeneration) return;
		if (modifierCharacter && (ctrl || alt)) {
			const committed = command.value;
			command.value = compositionDraft;
			if (!terminalKey(modifierCharacter)) command.value = committed;
		// WebKit can deliver the final committed input after this timer.
		// Never flush preedit text while the committed composition is absent.
		} else if (event.data === undefined || (event.data && command.value.includes(event.data))) sendRemoteText();
		lastNativeValue = command.value;
		positionCommand();
	}, 0);
});
// Keep the native keyboard open: pointer controls must not steal textarea focus.
accessory.addEventListener("pointerdown", (event) => {
	const button = event.target.closest("button");
	if (!button) return;
	event.preventDefault();
	if (button.disabled || event.button !== 0) return;
	const key = button.dataset.key;
	if (!["Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
	stopAccessoryHold();
	consumedPointerClick = button;
	if (!accessoryKey(key)) return;
	focusCommand();
	// Native keyboard holds emit their own events. One accessory press is one key.
	if (key === "Backspace") return;
	accessoryHold = { button, pointerId: event.pointerId };
	button.setPointerCapture?.(event.pointerId);
	// Only navigation keys repeat while the accessory button is held.
	function repeat() {
		if (accessoryHold?.button !== button || !authenticated) return;
		if (!accessoryKey(key)) { stopAccessoryHold(); return; }
		accessoryTimer = setTimeout(repeat, 55);
	}
	accessoryTimer = setTimeout(repeat, 420);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
	accessory.addEventListener(name, (event) => {
		if (accessoryHold?.pointerId === event.pointerId) stopAccessoryHold();
	});
}
window.addEventListener("blur", () => { stopAccessoryHold(); stopNativeDeletion(); });
accessory.addEventListener("click", (event) => {
	const button = event.target.closest("button");
	if (!button || button.disabled) return;
	if (!historyPanel.hidden && !button.dataset.scroll) return;
	if (button.dataset.scroll) {
		const entry = keyStrips.find(({ strip }) => strip === button.parentElement);
		if (entry) entry.row.scrollBy({ left: Number(button.dataset.scroll) * Math.max(120, entry.row.clientWidth * .75), behavior: "smooth" });
		return;
	}
	if (event.detail !== 0 && consumedPointerClick === button) {
		consumedPointerClick = undefined;
		focusCommand();
		return;
	}
	if (button.dataset.key) accessoryKey(button.dataset.key);
	else if (button.dataset.text && authenticated && !composingCommand && !commandSettling) {
		const text = button.dataset.text;
		if (ctrl || alt) terminalKey(text);
		else if (remoteEditing && !speechDraft) send({ type: "input", data: text });
		else {
			command.setRangeText(text, command.selectionStart, command.selectionEnd, "end");
			lastNativeValue = command.value;
			positionCommand();
		}
	}
	focusCommand();
});
tabs.addEventListener("click", (event) => {
	const button = event.target?.closest?.("button[data-session-id]");
	if (!button || button.disabled || !authenticated) return;
	const id = decodeURIComponent(button.dataset.sessionId ?? "");
	if (!id || id === activeSessionId) return;
	beginSessionChange(id, { type: "select", sessionId: id });
});
sessionRefresh.onclick = () => { if (authenticated) send({ type: "sessions" }); };
sessionCreate.addEventListener("submit", (event) => {
	event.preventDefault();
	const name = sessionName.value.trim();
	const backend = sessionBackend.value;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || !["tmux", "screen"].includes(backend)) {
		setState("Session name must start with a letter or digit (1–64 letters, digits, . _ -)", true);
		return;
	}
	if (!authenticated || pendingSessionId || composingCommand || commandSettling) return;
	saveDraft();
	stopAccessoryHold();
	pendingSessionId = "creating";
	connectionGeneration++;
	pendingCommandSubmit = false;
	if (!send({ type: "create", backend, name })) pendingSessionId = null;
});
ctrlButton.addEventListener("pointerdown", () => {
	heldCtrl = false;
	ctrlHold = setTimeout(() => { ctrl = 2; heldCtrl = true; updateModifiers(); }, 500);
});
for (const name of ["pointerup", "pointercancel", "pointerleave"]) {
	ctrlButton.addEventListener(name, () => clearTimeout(ctrlHold));
}
ctrlButton.addEventListener("click", () => {
	if (heldCtrl) { heldCtrl = false; return; }
	const now = Date.now();
	ctrl = ctrl === 2 ? 0 : now - lastCtrlTap < 350 ? 2 : ctrl ? 0 : 1;
	lastCtrlTap = now;
	updateModifiers();
});
altButton.addEventListener("click", () => {
	const now = Date.now();
	alt = alt === 2 ? 0 : now - lastAltTap < 350 ? 2 : alt ? 0 : 1;
	lastAltTap = now;
	updateModifiers();
});
sessionMenu.addEventListener("toggle", () => {
	if (sessionMenu.open && authenticated) send({ type: "sessions" });
	if (!sessionMenu.open && authenticated && terminal.buffer.active.type !== "alternate") focusCommand();
});
moreButton.addEventListener("click", () => {
	functionKeys.hidden = !functionKeys.hidden;
	moreButton.setAttribute("aria-expanded", String(!functionKeys.hidden));
	updateKeyScroll(keyStrips[1]);
	resize();
});
// iOS resizes the visual viewport rather than the layout viewport for its keyboard.
function resizeViewport() {
	if (window.visualViewport) {
		document.body.style.height = `${window.visualViewport.height}px`;
		window.scrollTo(0, 0);
	}
	resize();
}
window.visualViewport?.addEventListener("resize", resizeViewport);
commandForm.addEventListener("submit", (event) => {
	event.preventDefault();
	submitCommand();
});
function submitCommand() {
	if (composingCommand || commandSettling || pendingCommandSubmit || pendingSessionId || !historyPanel.hidden || !authenticated || socket?.readyState !== WebSocket.OPEN || !command.value) return;
	pendingCommandSubmit = true;
	const generation = connectionGeneration;
	const submitted = command.value;
	setTimeout(() => {
		pendingCommandSubmit = false;
		// A late native speech correction needs a fresh, explicit submission.
		if (generation !== connectionGeneration || pendingSessionId || !historyPanel.hidden || composingCommand || commandSettling || command.value !== submitted) return;
		// Respect the shell's paste mode, as xterm does, before the explicit submit.
		const draft = terminal.modes.bracketedPasteMode
			? `\x1b[200~${submitted.replace(/\r?\n/g, "\r")}\x1b[201~`
			: submitted;
		if (send({ type: "input", data: `${draft}\r` })) {
			command.value = "";
			lastNativeValue = "";
			speechDraft = false;
			if (terminal.buffer.active.type !== "alternate") remoteEditing = false;
			focusCommand();
		}
	}, 0);
}

connect.onclick = () => {
	if (!token.value) { setState("Enter the token shown by /tty start"); token.focus(); return; }
	saveDraft();
	resetHistory();
	historyButton.hidden = true;
	tabs.hidden = true;
	tabs.innerHTML = "";
	tabOrder.innerHTML = "";
	socket?.close();
	const current = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/terminal`);
	socket = current;
	authenticated = false;
	pendingSessionId = null;
	remoteEditing = false;
	speechDraft = false;
	draftLineBreak = false;
	stopNativeDeletion();
	resetModifiers();
	pendingOutput = 0;
	connectionGeneration++;
	setState("Connecting…");
	current.onopen = () => {
		if (socket !== current) return;
		current.send(JSON.stringify({ v: 1, type: "auth", token: token.value }));
		setState("Authenticating…");
	};
	current.onmessage = (event) => {
		if (socket !== current) return;
		let message;
		try { message = JSON.parse(event.data); } catch { current.close(); return; }
		if (message.type === "ready") {
			resetHistory();
			if (pendingSessionId || (message.activeSession?.id && message.activeSession.id !== activeSessionId)) {
				restoreDraft(message.activeSession?.id ?? activeSessionId);
				pendingSessionId = null;
				stopNativeDeletion();
				resetModifiers();
				remoteEditing = false;
			}
			terminal.reset();
			authenticated = true;
			renderSessions(message.sessions, message.activeSession);
			if (typeof message.replay === "string") appendHistory(message.replay);
			if (message.running) sessionMenu.open = false;
			setState(message.running ? `Connected · ${message.activeSession?.label ?? "shell"}` : "Session exited; choose another tab", message.running);
			if (message.replay) {
				replayWrites++;
				terminal.write(message.replay, () => { replayWrites--; });
			}
			resize();
			if (message.running) focusCommand();
			else commandForm.hidden = true;
		} else if (message.type === "sessions") {
			renderSessions(message.sessions, message.activeSession);
		} else if (message.type === "switching") {
			setState(`Opening ${message.session?.label ?? "terminal session"}…`, true);
		} else if (message.type === "output") {
			if (authenticated && typeof message.data === "string") appendHistory(message.data);
			pendingOutput += message.data.length;
			if (pendingOutput > 1024 * 1024) {
				current.close();
				setState("Output congested; reconnect for recent output");
				return;
			}
			terminal.write(message.data, () => { if (socket === current) pendingOutput -= message.data.length; });
		} else if (message.type === "exit") {
			commandForm.hidden = true;
			setState("Session exited; choose another tab or refresh", false);
		} else if (message.type === "error") {
			if (pendingSessionId) {
				pendingSessionId = null;
				if (!commandForm.hidden) focusCommand();
			}
			setState(message.message, state.dataset.connected === "true");
		}
	};
	current.onclose = (event) => {
		if (socket !== current) return;
		socket = undefined;
		authenticated = false;
		pendingSessionId = null;
		resetHistory();
		historyButton.hidden = true;
		renderSessions([]);
		commandForm.hidden = true;
		setState(event.code === 1008 ? "Authentication or protocol rejected" : event.code === 1012 ? "Another browser took control" : "Disconnected — reconnect to resume");
	};
	current.onerror = () => { if (socket === current) setState("Connection failed"); };
};
disconnect.onclick = () => { socket?.close(); };
token.addEventListener("keydown", (event) => { if (event.key === "Enter") connect.click(); });
window.addEventListener("pagehide", () => { stopAccessoryHold(); socket?.close(); });
