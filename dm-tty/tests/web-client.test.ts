import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

function browser(storage = new Map<string, string>()) {
	let layoutReads = 0;
	const elements = new Map<string, any>();
	for (const id of ["#token", "#save-token", "#clear-token", "#token-status", "#connect", "#disconnect", "#state", "#session-menu", "#tabs", "#tab-order", "#session-create", "#session-name", "#session-backend", "#session-refresh", "#session-add", "#terminal", "#command", "#command-form", "#command-preview", "#command-before", "#command-selection", "#command-after", "#command-caret", "#accessory", "#ctrl", "#alt", "#more", "#primary-key-strip", "#primary-key-row", "#function-keys", "#extra-key-row", "#history", "#history-panel", "#history-text", "#history-lines", "#history-copy", "#copy-status"]) {
		elements.set(id, {
			value: "", disabled: false, dataset: {}, style: {}, hidden: false, scrollHeight: 20, listeners: new Map(),
			addEventListener(name: string, callback: (event: any) => void) { this.listeners.set(name, callback); },
			focus() { this.focused = true; },
			setRangeText(text: string, start: number, end: number) {
				this.value = this.value.slice(0, start) + text + this.value.slice(end);
				this.selectionStart = this.selectionEnd = start + text.length;
			},
			setAttribute(name: string, value: string) { this[name] = value; },
			setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
			contains(node: unknown) { return node === this; },
			querySelectorAll() { return []; },
			getBoundingClientRect() { layoutReads++; return { left: 0, top: 0, width: 824, height: 494, right: 824, bottom: 494 }; },
		});
	}
	for (const [stripId, rowId] of [["#primary-key-strip", "#primary-key-row"], ["#function-keys", "#extra-key-row"]] as const) {
		const strip = elements.get(stripId);
		const row = elements.get(rowId);
		const arrows = [-1, 1].map((direction) => ({
			dataset: { scroll: String(direction) }, parentElement: strip, hidden: true, disabled: true,
		}));
		strip.querySelectorAll = () => arrows;
		row.clientWidth = 200;
		row.scrollWidth = 200;
		row.scrollLeft = 0;
		row.scrollBy = ({ left }: { left: number }) => {
			row.scrollLeft = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + left));
			row.listeners.get("scroll")?.({});
		};
	}
	elements.get("#function-keys").hidden = true;
	const sent: any[] = [];
	const timers = new Map<number, { fn: () => void; at: number }>();
	const frames = new Map<number, () => void>();
	const windowListeners = new Map<string, () => void>();
	let clock = 0, nextTimer = 0;
	const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
	const advance = (ms: number) => {
		const end = clock + ms;
		for (;;) {
			const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			timers.delete(next[0]); clock = next[1].at; next[1].fn();
		}
		clock = end;
	};
	let socket: any;
	class FakeSocket {
		static OPEN = 1;
		readyState = 1;
		bufferedAmount = 0;
		constructor() { socket = this; }
		send(message: string) { sent.push(JSON.parse(message)); }
		close() { this.readyState = 3; }
	}
	class FakeTerminal {
		cols = 80; rows = 24;
		element = { querySelector: () => ({ getBoundingClientRect: () => { layoutReads++; return { left: 12, top: 4, width: 800, height: 480, right: 812, bottom: 484 }; } }) };
		buffer = { active: { cursorX: 3, cursorY: 23 } };
		modes = { bracketedPasteMode: false };
		textarea = { addEventListener: (_name: string, callback: () => void) => { this.focusChange = callback; } };
		loadAddon() {}
		open() {}
		onData(callback: (data: string) => void) { this.data = callback; }
		onBinary() {}
		onCursorMove(callback: () => void) { this.cursorMove = callback; }
		reset() {}
		write(_data: string, callback?: () => void) { callback?.(); }
		attachCustomKeyEventHandler(callback: (event: any) => boolean) { this.customKey = callback; }
		focus() { this.focusChange?.(); }
		scrollPages(pages: number) { this.scrolled = pages; }
		scrolled = 0;
		selected = false;
		hasSelection() { return this.selected; }
		data?: (data: string) => void;
		cursorMove?: () => void;
		focusChange?: () => void;
		customKey?: (event: any) => boolean;
	}
	const term = new FakeTerminal();
	const selection = {
		anchorNode: null as any, focusNode: null as any, text: "",
		toString() { return this.text; },
		removeAllRanges() { this.anchorNode = this.focusNode = null; this.text = ""; },
		addRange(range: any) {
			this.anchorNode = this.focusNode = range.node;
			this.text = range.node.textContent;
		},
	};
	const clipboard = {
		writes: [] as string[], fallback: [] as string[], fallbackWorks: true,
		api: undefined as undefined | { writeText(text: string): Promise<void> },
	};
	runInNewContext(readFileSync(new URL("../web/client.js", import.meta.url), "utf8"), {
		document: {
			body: { style: {} }, querySelector: (id: string) => elements.get(id), addEventListener() {},
			getSelection: () => selection,
			createRange: () => ({ node: null as any, selectNodeContents(node: any) { this.node = node; } }),
			execCommand: (name: string) => {
				assert.equal(name, "copy");
				clipboard.fallback.push(selection.toString());
				return clipboard.fallbackWorks;
			},
		},
		navigator: { get clipboard() { return clipboard.api; } },
		Terminal: class { constructor() { return term; } },
		FitAddon: { FitAddon: class { fit() {} } },
			ResizeObserver: class { observe() {} },
			localStorage: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => { storage.set(key, value); },
				removeItem: (key: string) => { storage.delete(key); },
			},
		WebSocket: FakeSocket,
		location: { protocol: "http:", host: "127.0.0.1:8765" },
		window: { addEventListener(name: string, fn: () => void) { windowListeners.set(name, fn); } },
		requestAnimationFrame: (fn: () => void) => { const id = ++nextTimer; frames.set(id, fn); return id; },
		setTimeout: (fn: () => void, delay = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
		clearTimeout: (id: number) => timers.delete(id),
	});
	const token = elements.get("#token");
	const command = elements.get("#command");
	const form = elements.get("#command-form");
	if (!token.value) token.value = "private-test-token";
	elements.get("#connect").onclick();
	socket.onopen();
	const ready = (running = true, sessions = [{ id: "shell", label: "New shell", backend: "shell" }]) => {
		socket.onmessage({ data: JSON.stringify({ type: "ready", running, sessions, activeSession: sessions[0] }) }); frame();
	};
	const submit = () => {
		let prevented = false;
		form.listeners.get("submit")({ preventDefault() { prevented = true; } });
		assert.ok(prevented);
	};
	const key = (key: string, options = {}) => {
		let prevented = false;
		command.listeners.get("keydown")({ key, preventDefault() { prevented = true; }, ...options });
		return prevented;
	};
	return { elements, command, form, sent, term, ready, submit, key, frame, advance, windowListeners, selection, clipboard,
		layoutReads: () => layoutReads,
		flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ fn }) => fn()); frame(); },
		socket: () => socket };
}

test("replayed terminal queries never send replies into the current shell", () => {
	const { ready, socket, term, sent } = browser();
	ready();
	let complete: (() => void) | undefined;
	term.write = (_data, callback) => {
		term.data?.("\x1b[?1;2c");
		complete = callback;
	};
	const before = sent.filter((message) => message.type === "input").length;
	socket().onmessage({ data: JSON.stringify({
		type: "ready", running: true, activeSession: { id: "tmux:$1", label: "audit" },
		sessions: [{ id: "tmux:$1", label: "audit" }], replay: "\x1b[c",
	}) });
	assert.equal(sent.filter((message) => message.type === "input").length, before);
	term.data?.("\x1b[>0;276;0c");
	assert.equal(sent.filter((message) => message.type === "input").length, before);
	complete?.();
	term.data?.("x");
	assert.equal(sent.filter((message) => message.type === "input").at(-1)?.data, "x");
});

test("IME command submits once after composition, preserves Unicode, and never sends before auth", () => {
	const { command, form, sent, term, ready, submit, flush, socket, frame } = browser();
	command.value = 'echo "Cộng hòa xã hội chủ nghĩa Việt Nam"';
	submit();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	ready();
	assert.equal(form.hidden, false);
	assert.equal(command.focused, true);
	assert.equal(form.style.left, "12px");
	assert.equal(command.style.width, "10px", "the IME proxy occupies at most one terminal cell");
	assert.equal(form.style.top, "464px");
	term.buffer.active.cursorX = 5;
	term.cursorMove?.();
	frame();
	assert.equal(form.style.textIndent, "50px");
	command.listeners.get("compositionstart")({});
	submit();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	assert.ok(command.value);
	command.listeners.get("compositionend")({});
	submit();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	flush();
	submit();
	submit(); // A double-submit in the same event loop still sends only once.
	flush();
	assert.deepEqual(sent.filter((message) => message.type === "input").map((message) => message.data),
		['echo "Cộng hòa xã hội chủ nghĩa Việt Nam"\r']);
	assert.equal(command.value, "");
	ready(false);
	command.value = "echo no-connection";
	submit();
	assert.equal(sent.filter((message) => message.type === "input").length, 1);
	assert.equal(command.value, "echo no-connection");
	ready();
	socket().bufferedAmount = 256 * 1024 + 1;
	submit();
	flush();
	assert.equal(command.value, "echo no-connection");
	assert.equal(sent.filter((message) => message.type === "input").length, 1);
});

test("Enter ends live shell editing so the next dictated command retains its native context", () => {
	const { command, ready, key, sent, flush } = browser();
	ready();
	key("Tab");
	key("Enter");
	const baseline = sent.length;
	command.value = "e";
	command.listeners.get("input")({ inputType: "insertText", data: "e" });
	assert.equal(command.value, "e", "first character after Return stays in the local draft");
	assert.equal(sent.length, baseline);
	for (const text of ["echo cộng", 'echo "Cộng hòa xã hội chủ nghĩa Việt Nam"']) {
		command.value = text;
		command.listeners.get("input")({ inputType: "insertText", data: text });
		assert.equal(command.value, text);
	}
	assert.equal(sent.length, baseline);
	key("Enter"); flush();
	assert.equal(sent.at(-1).data, 'echo "Cộng hòa xã hội chủ nghĩa Việt Nam"\r');
});

test("live speech replacements without composition remain a draft until explicit Enter", () => {
	const { command, ready, key, sent, flush } = browser();
	ready();
	key("ArrowUp");
	const baseline = sent.length;
	for (const [inputType, text] of [
		["insertText", "hello world"],
		["insertReplacementText", "Hello Việt Nam"],
		["insertText", "Hello Việt Nam!"],
	]) {
		command.value = text;
		command.listeners.get("input")({ inputType, data: text, cancelable: false });
		assert.equal(command.value, text, "OS replacement range must survive");
	}
	assert.equal(sent.length, baseline, "no provisional speech is sent or retracted remotely");
	key("Enter"); flush();
	assert.equal(sent.at(-1).data, "Hello Việt Nam!\r");
});

test("native dictation events keep single-letter results and spoken newlines local even in full-screen apps", () => {
	const { elements, command, ready, term, sent, key, flush } = browser();
	ready();
	(term.buffer.active as any).type = "alternate";
	command.value = "a";
	command.listeners.get("input")({ inputType: "insertFromDictation", data: "a" });
	let prevented = false;
	command.listeners.get("beforeinput")({
		inputType: "insertParagraph", preventDefault() { prevented = true; },
	});
	assert.equal(prevented, false, "a spoken new paragraph must not run a command");
	command.value = "a\nb";
	command.listeners.get("input")({ inputType: "insertParagraph", data: null });
	key("Tab");
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	const enter = { dataset: { key: "Enter" }, disabled: false };
	elements.get("#accessory").listeners.get("click")({ target: { closest: () => enter }, detail: 0 });
	flush();
	assert.equal(sent.at(-1).data, "a\nb\r");
	assert.equal(command.value, "");
});

test("input-only remote deletion repeats exactly once without composition or keydown", () => {
	const { command, ready, key, sent } = browser();
	ready();
	key("ArrowLeft");
	const baseline = sent.filter((m) => m.type === "input").length;
	for (let i = 0; i < 30; i++) {
		command.listeners.get("input")({ inputType: "deleteContentBackward", data: null });
	}
	assert.deepEqual(sent.filter((m) => m.type === "input").slice(baseline).map((m) => m.data),
		Array(30).fill("\x7f"));
});

test("noncancelable beforeinput deletion waits for input and sends only one byte", () => {
	const { command, ready, sent } = browser();
	ready();
	command.listeners.get("beforeinput")({
		inputType: "deleteContentBackward", cancelable: false, preventDefault() {},
	});
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	command.listeners.get("input")({ inputType: "deleteContentBackward", data: null });
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x7f"]);
});

test("input deleting the final local character never spills a Backspace to PTY", () => {
	const { command, ready, sent } = browser();
	ready();
	command.value = "ế";
	command.listeners.get("input")({ inputType: "insertText", data: "ế" });
	command.value = "";
	command.listeners.get("input")({ inputType: "deleteContentBackward", data: null });
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
});

test("hardware Backspace repeats in an empty proxy without acting twice", () => {
	const { command, ready, key, sent } = browser();
	ready();
	for (let i = 0; i < 30; i++) {
		assert.equal(key("Backspace", { repeat: i > 0, keyCode: 229 }), true);
	}
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), Array(30).fill("\x7f"));
});

test("held native deletion stops at a local draft boundary, then a fresh Backspace reaches PTY", () => {
	for (const path of ["hardware", "software"]) {
		const { command, ready, key, sent, advance } = browser();
		ready();
		command.value = "ế";
		command.listeners.get("input")({ inputType: "insertText", data: "ế" });
		const before = () => command.listeners.get("beforeinput")({
			inputType: "deleteContentBackward", preventDefault() {},
		});
		before();
		command.value = "";
		command.listeners.get("input")({ inputType: "deleteContentBackward" });
		for (let i = 0; i < 8; i++) {
			if (path === "hardware") key("Backspace", { repeat: true });
			else before();
			if (path === "software") command.listeners.get("input")({ inputType: "deleteContentBackward" });
		}
		assert.equal(sent.filter((m) => m.type === "input").length, 0, path);
		advance(300);
		if (path === "hardware") {
			command.listeners.get("keyup")({ key: "Backspace" });
			key("Backspace");
		}
		else before();
		assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x7f"], path);
	}
});

test("a replacement draft survives transport failure and cannot run after reconnect", () => {
	const { elements, command, ready, key, sent, socket, flush } = browser();
	ready();
	key("Tab");
	command.value = "speech stays here";
	command.listeners.get("input")({ inputType: "insertReplacementText", data: null });
	key("Enter");
	elements.get("#connect").onclick();
	socket().onopen(); ready(); flush();
	assert.equal(command.value, "speech stays here");
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\t"]);
});

test("native held Backspace keeps deleting a nonempty draft before stopping at its boundary", () => {
	const { command, ready, key, sent, advance } = browser();
	ready();
	command.value = "abc";
	command.listeners.get("input")({ inputType: "insertText", data: "abc" });
	for (const value of ["ab", "a", ""]) {
		assert.equal(key("Backspace", { repeat: true }), false, "native deletion must remain enabled");
		command.value = value;
		command.listeners.get("input")({ inputType: "deleteContentBackward" });
	}
	advance(800);
	assert.equal(key("Backspace", { repeat: true }), true);
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
});

test("speech replacement at a normal prompt keeps spoken paragraph local", () => {
	const { command, ready, sent, flush } = browser();
	ready();
	command.value = "echo speech";
	command.listeners.get("input")({ inputType: "insertReplacementText" });
	let prevented = false;
	command.listeners.get("beforeinput")({ inputType: "insertParagraph", preventDefault() { prevented = true; } });
	flush();
	assert.equal(prevented, false);
	assert.equal(command.value, "echo speech");
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
});

test("late speech correction after Enter is not executed until the next explicit submission", () => {
	const { command, ready, key, sent, flush } = browser();
	ready();
	command.value = "echo provisional";
	command.listeners.get("input")({ inputType: "insertReplacementText" });
	key("Enter");
	command.value = "echo corrected";
	command.listeners.get("input")({ inputType: "insertReplacementText" });
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), []);
	assert.equal(command.value, "echo corrected");
	key("Enter"); flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["echo corrected\r"]);
});

test("Shift+Enter edits a multiline draft locally; Enter sends it exactly once", () => {
	const { command, sent, ready, key, flush } = browser();
	ready();
	command.value = 'echo "Cộng hoà';
	assert.equal(key("Enter", { shiftKey: true }), false, "leave textarea newline insertion native");
	// The browser's default textarea edit inserts the newline, then fires input.
	command.value += '\nxã hội chủ nghĩa Việt Nam"';
	command.listeners.get("input")?.({});
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	assert.equal(key("Enter"), true, "plain Enter must not insert a newline");
	key("Enter");
	flush();
	assert.deepEqual(sent.filter((message) => message.type === "input").map((message) => message.data),
		['echo "Cộng hoà\nxã hội chủ nghĩa Việt Nam"\r']);
	assert.equal(command.value, "");
});

test("system-keyboard Return submits without keydown while physical Shift+Enter stays native", () => {
	const { command, ready, sent, key, flush } = browser();
	ready();
	command.value = "echo mobile";
	const before = () => {
		let prevented = false;
		command.listeners.get("beforeinput")({ inputType: "insertLineBreak", preventDefault() { prevented = true; } });
		return prevented;
	};
	key("Enter", { shiftKey: true });
	assert.equal(before(), false);
	assert.equal(before(), true);
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["echo mobile\r"]);
});

test("noncancelable Safari Return removes its native newline and submits once", () => {
	const { command, ready, sent, flush } = browser();
	ready();
	command.value = "echo Xin chào";
	command.setSelectionRange(command.value.length, command.value.length);
	let preventCalls = 0;
	command.listeners.get("beforeinput")({
		inputType: "insertLineBreak", cancelable: false, preventDefault() { preventCalls++; },
	});
	command.value += "\n"; // Safari's default action still runs after a noncancelable event.
	command.listeners.get("input")({ inputType: "insertLineBreak" });
	flush();
	assert.equal(preventCalls, 0);
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["echo Xin chào\r"]);
	assert.equal(command.value, "");

	command.setSelectionRange(0, 0);
	command.listeners.get("beforeinput")({
		inputType: "insertParagraph", cancelable: false, preventDefault() { preventCalls++; },
	});
	command.value = "\n";
	command.listeners.get("input")({ inputType: "insertParagraph" });
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["echo Xin chào\r", "\r"]);
	assert.equal(command.value, "");
});

test("composition Enter including Safari keyCode 229 does not submit or lose the draft", () => {
	const { command, sent, ready, key, flush } = browser();
	ready();
	command.value = "tiếng Việt";
	assert.equal(key("Enter", { isComposing: true }), false);
	assert.equal(key("Enter", { keyCode: 229 }), false);
	command.listeners.get("compositionstart")({});
	assert.equal(key("Enter"), false);
	command.listeners.get("compositionend")({});
	key("Enter");
	flush();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	assert.equal(command.value, "tiếng Việt");
	key("Enter");
	flush();
	assert.equal(sent.filter((message) => message.type === "input").length, 1);
});

test("noncancelable Return after direct editing cannot leak a newline to the PTY", () => {
	const { command, sent, ready, key, flush } = browser();
	ready();
	key("ArrowUp");
	command.value = "Việt";
	command.setSelectionRange(command.value.length, command.value.length);
	command.listeners.get("beforeinput")({
		inputType: "insertLineBreak", cancelable: false,
		preventDefault() { assert.fail("noncancelable event"); },
	});
	command.value = "\n";
	command.listeners.get("input")({ inputType: "insertLineBreak" });
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data),
		["\x1b[A", "Việt\r"]);
	assert.equal(command.value, "");
});

test("noncancelable composition Return preserves selection and does not submit", () => {
	const { command, sent, ready, flush } = browser();
	ready();
	command.value = "echo tiếng Việt";
	command.setSelectionRange(5, 10);
	command.listeners.get("compositionstart")({});
	command.listeners.get("compositionend")({ data: "tiếng" });
	command.listeners.get("beforeinput")({
		inputType: "insertParagraph", cancelable: false,
		preventDefault() { assert.fail("noncancelable event"); },
	});
	command.value = "echo \n Việt";
	command.listeners.get("input")({ inputType: "insertParagraph" });
	flush();
	assert.equal(command.value, "echo tiếng Việt");
	assert.equal(command.selectionStart, 5);
	assert.equal(command.selectionEnd, 10);
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
});

test("Safari Return that confirms composition cannot insert a draft newline", () => {
	const { command, sent, ready, flush } = browser();
	ready();
	command.value = "echo tiếng Việt";
	command.listeners.get("compositionstart")({});
	command.listeners.get("compositionend")({ data: "Việt" });
	let prevented = false;
	command.listeners.get("beforeinput")({
		inputType: "insertParagraph", cancelable: true, preventDefault() { prevented = true; },
	});
	assert.equal(prevented, true);
	flush();
	assert.equal(command.value, "echo tiếng Việt");
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
});

test("Safari final composition input after settling cannot send a preedit to a full-screen app", () => {
	const { command, term, sent, ready, flush } = browser();
	ready();
	(term.buffer.active as any).type = "alternate";
	command.listeners.get("compositionstart")({});
	command.value = "tieeng";
	command.listeners.get("compositionend")({ data: "tiếng" });
	flush(); // WebKit can deliver the final input after the compositionend timer.
	assert.deepEqual(sent.filter((message) => message.type === "input"), []);
	command.value = "tiếng";
	command.listeners.get("input")({ inputType: "insertFromComposition", data: "tiếng" });
	assert.deepEqual(sent.filter((message) => message.type === "input").map((message) => message.data), ["tiếng"]);
	assert.equal(command.value, "");
});

test("selection/copy/paste shortcuts stay native and multiline paste does not auto-send", () => {
	const { command, sent, ready, key, flush } = browser();
	ready();
	for (const keyName of ["a", "c", "v", "x"]) assert.equal(key(keyName, { metaKey: true }), false);
	assert.equal(key("v", { ctrlKey: true }), false);
	assert.equal(key("c", { ctrlKey: true, shiftKey: true }), false);
	command.value = "dòng một\ndòng hai";
	command.listeners.get("input")?.({ inputType: "insertFromPaste" });
	flush();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	assert.equal(command.value, "dòng một\ndòng hai");
});

test("terminal keys flush draft once, keep focus, then send live edits", () => {
	const { command, sent, ready, key, form } = browser();
	ready();
	command.value = "ec";
	assert.equal(key("Tab"), true);
	assert.equal(command.value, "");
	command.value = "ho";
	command.listeners.get("input")({});
	key("ArrowUp");
	key("ArrowLeft", { shiftKey: true });
	key("Backspace");
	key("Delete");
	key("Enter");
	key("Escape");
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data),
		["ec\t", "ho", "\x1b[A", "\x1b[1;2D", "\x7f", "\x1b[3~", "\r", "\x1b"]);
	assert.equal(form.hidden, false);
});

test("physical Ctrl/Alt/F keys and application cursor mode preserve terminal sequences", () => {
	const { sent, ready, key, term } = browser();
	ready();
	for (const character of "cdzlaeukwrbpn") key(character, { ctrlKey: true });
	key("b", { altKey: true });
	key("ArrowRight", { ctrlKey: true });
	for (let n = 1; n <= 12; n++) key(`F${n}`);
	(term.modes as any).applicationCursorKeysMode = true;
	key("ArrowUp");
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), [
		...[..."cdzlaeukwrbpn"].map((c) => String.fromCharCode(c.charCodeAt(0) - 96)),
		"\x1bb", "\x1b[1;5C", "\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS",
		... [15,17,18,19,20,21,23,24].map((n) => `\x1b[${n}~`), "\x1bOA",
	]);
});

test("mobile Ctrl beforeinput emits one byte, releases once, locks on double tap and resets offline", () => {
	const { elements, command, sent, ready, socket } = browser();
	ready();
	const ctrl = elements.get("#ctrl");
	const tap = () => ctrl.listeners.get("click")({});
	const type = (data: string) => {
		let prevented = false;
		command.listeners.get("beforeinput")({ inputType: "insertText", data, preventDefault() { prevented = true; } });
		return prevented;
	};
	tap();
	assert.equal(ctrl.textContent, "CTRL");
	assert.equal(type("c"), true);
	assert.equal(ctrl.textContent, "Ctrl");
	assert.equal(type("d"), false);
	tap(); tap();
	assert.equal(ctrl.textContent, "CTRL 🔒");
	assert.equal(type("d"), true);
	assert.equal(type("z"), true);
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x03", "\x04", "\x1a"]);
	socket().onclose({ code: 1000 });
	assert.equal(ctrl.textContent, "Ctrl");
	assert.equal(type("c"), false);
});

test("toolbar does not steal focus; scrollback and More work without shell input", () => {
	const { elements, ready, sent, term } = browser();
	ready();
	const accessory = elements.get("#accessory");
	let prevented = false;
	const button = { dataset: { key: "PageUp" }, disabled: false };
	const target = { closest: () => button };
	accessory.listeners.get("pointerdown")({ target, preventDefault() { prevented = true; } });
	accessory.listeners.get("click")({ target });
	assert.equal(prevented, true);
	assert.equal(term.scrolled, -1);
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	elements.get("#function-keys").hidden = true;
	elements.get("#more").listeners.get("click")({});
	assert.equal(elements.get("#function-keys").hidden, false);
});

test("terminal shortcuts cannot send unfinished composition or execute a multiline draft", () => {
	const { command, ready, key, sent, flush } = browser();
	ready();
	command.value = "echo một\necho hai";
	key("Tab");
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	command.listeners.get("compositionstart")({});
	key("c", { ctrlKey: true });
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	command.listeners.get("compositionend")({});
	flush();
	key("c", { ctrlKey: true });
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x03"]);
	assert.equal(command.value, "");
});

test("latched Ctrl converts a composed system-keyboard character without sending draft text", () => {
	const { elements, command, ready, sent, flush } = browser();
	ready();
	command.value = "discard this draft";
	elements.get("#ctrl").listeners.get("click")({});
	command.listeners.get("compositionstart")({});
	command.value += "c";
	command.listeners.get("compositionend")({ data: "c" });
	command.listeners.get("input")({ inputType: "insertText" });
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x03"]);
	assert.equal(command.value, "");
});

test("Ctrl hold locks, repeated control bytes stay locked, and another tap releases", () => {
	const { elements, ready, key, sent, flush } = browser();
	ready();
	const ctrl = elements.get("#ctrl");
	ctrl.listeners.get("pointerdown")({});
	flush();
	ctrl.listeners.get("pointerup")({});
	ctrl.listeners.get("click")({});
	assert.equal(ctrl.textContent, "CTRL 🔒");
	key("c"); key("d");
	assert.equal(ctrl.textContent, "CTRL 🔒");
	ctrl.listeners.get("click")({});
	assert.equal(ctrl.textContent, "Ctrl");
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x03", "\x04"]);
});

test("alternate-buffer text is live and composition commits once; raw xterm stays unchanged", () => {
	const { command, term, ready, sent, key, flush } = browser();
	ready();
	(term.buffer.active as any).type = "alternate";
	command.value = "i";
	command.listeners.get("input")({});
	command.listeners.get("compositionstart")({});
	command.value = "tiếng";
	command.listeners.get("input")({});
	command.listeners.get("compositionend")({ data: "tiếng" });
	flush();
	key("PageDown");
	term.data?.("\x1b[1;6A");
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data),
		["i", "tiếng", "\x1b[6~", "\x1b[1;6A"]);
});

test("multiline preview fits inside terminal bounds while proxy stays small and reconnect preserves draft", () => {
	const { elements, command, form, sent, ready, key, flush, socket, frame } = browser();
	ready();
	command.value = "echo 'một\nhai'";
	elements.get("#command-preview").scrollHeight = 60;
	command.listeners.get("input")?.({});
	frame();
	assert.equal(command.style.height, "20px");
	assert.ok(Number.parseFloat(form.style.top) + 60 <= 484, "editor must not clip below the terminal");
	key("Enter");
	const previous = socket();
	elements.get("#connect").onclick();
	socket().onopen();
	ready();
	previous.onclose({ code: 1000 });
	flush();
	assert.equal(sent.filter((message) => message.type === "input").length, 0);
	assert.equal(command.value, "echo 'một\nhai'");
});

test("shell bracketed-paste mode preserves a multiline draft until the explicit final Enter", () => {
	const { command, sent, term, ready, key, flush } = browser();
	ready();
	term.modes.bracketedPasteMode = true;
	command.value = "printf '%s\\n' 'một\nhai'";
	key("Enter");
	flush();
	assert.deepEqual(sent.filter((message) => message.type === "input").map((message) => message.data),
		["\x1b[200~printf '%s\\n' 'một\rhai'\x1b[201~\r"]);
});

test("IME proxy is invisible but focusable; only inert text and one caret render at the prompt", () => {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const terminalStart = html.indexOf('<main id="terminal"');
	const terminalEnd = html.indexOf("</main>", terminalStart);
	const formStart = html.indexOf('<form id="command-form"');
	assert.ok(terminalStart >= 0 && formStart > terminalStart && formStart < terminalEnd);
	assert.match(html.slice(formStart, terminalEnd), /<textarea id="command"[^>]*rows="1"/);
	assert.match(html.slice(formStart, terminalEnd), /<textarea id="command"[^>]*wrap="off"/);
	assert.match(html, /id="command-preview"[^>]*aria-hidden="true"/);
	assert.doesNotMatch(html, /id="(?:raw|ime|dictation|help-panel|notice)"/);
	assert.doesNotMatch(html, /id="command-send"/);
	assert.doesNotMatch(html, /<textarea[^>]*(?:hidden|aria-hidden="true")/);
	assert.match(html, /Terminal input|Shell command/);
	const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
	assert.match(css, /#command-form\s*\{[^}]*position:\s*absolute/);
	assert.match(css, /#command(?:,\s*#command:focus)?\s*\{[^}]*opacity:\s*0/);
	assert.match(css, /#command(?:,\s*#command:focus)?\s*\{[^}]*pointer-events:\s*none/);
	assert.match(css, /#command(?:,\s*#command:focus)?\s*\{[^}]*outline:\s*none/);
	assert.doesNotMatch(css, /#command\s*\{[^}]*user-select:\s*none/);
});

test("session tabs stay compact and select only authenticated terminal sessions", () => {
	const { elements, ready, sent } = browser();
	ready(true, [
		{ id: "shell", label: "New shell", backend: "shell" },
		{ id: "tmux:work", label: "tmux · work", backend: "tmux" },
	]);
	const tabs = elements.get("#tabs");
	assert.equal(tabs.hidden, false);
	assert.match(tabs.innerHTML, /role="tab"/);
	assert.match(tabs.innerHTML, /tmux · work/);
	assert.match(tabs.innerHTML, /aria-selected="true"/);
	const button = { dataset: { sessionId: encodeURIComponent("tmux:work") }, disabled: false };
	tabs.listeners.get("click")({ target: { closest: () => button } });
	assert.deepEqual(sent.at(-1), { v: 1, type: "select", sessionId: "tmux:work" });
});

test("tab ordering follows arrow controls, survives refresh, and drops closed tabs", () => {
	const { elements, ready, socket, sent } = browser();
	const shell = { id: "shell", label: "Shell", backend: "shell" };
	const work = { id: "tmux:work", label: "Work", backend: "tmux" };
	const demo = { id: "screen:demo", label: "Demo", backend: "screen" };
	const order = elements.get("#tab-order");
	const tabs = elements.get("#tabs");
	const replacement = { dataset: { moveId: encodeURIComponent(demo.id), direction: "-1" }, disabled: false, focused: false,
		focus() { this.focused = true; } };
	order.querySelectorAll = () => [replacement];
	const move = (id: string, direction: number, disabled = false) => order.listeners.get("click")({
		target: { closest: () => ({ dataset: { moveId: encodeURIComponent(id), direction: String(direction) }, disabled }) },
	});
	ready(true, [shell, work, demo]);
	move(demo.id, -1);
	assert.equal(replacement.focused, true, "arrow focus survives rendering for keyboard reordering");
	move(demo.id, -1);
	assert.ok(tabs.innerHTML.indexOf("Demo") < tabs.innerHTML.indexOf("Shell"));
	assert.ok(tabs.innerHTML.indexOf("Shell") < tabs.innerHTML.indexOf("Work"));
	assert.equal(sent.filter((message) => message.type === "select").length, 0, "reordering must not switch PTYs");
	socket().onmessage({ data: JSON.stringify({ type: "sessions", sessions: [work, shell, demo], activeSession: shell }) });
	assert.ok(tabs.innerHTML.indexOf("Demo") < tabs.innerHTML.indexOf("Shell"), "server refresh preserves local order");
	socket().onmessage({ data: JSON.stringify({ type: "sessions", sessions: [shell, demo], activeSession: shell }) });
	assert.doesNotMatch(order.innerHTML, /Work/);
	move(demo.id, -1, true);
	assert.ok(tabs.innerHTML.indexOf("Demo") < tabs.innerHTML.indexOf("Shell"));
	socket().onclose({ code: 1000 });
	assert.equal(tabs.innerHTML, "");
	assert.equal(order.innerHTML, "");
});

test("access token persists only on Save and Clear removes both stored and entered tokens", () => {
	const storage = new Map<string, string>();
	const { elements, ready, socket } = browser(storage);
	const token = elements.get("#token");
	const save = elements.get("#save-token");
	const clear = elements.get("#clear-token");
	const key = "dm-tty-access-token";
	assert.equal(storage.size, 0, "connecting alone must not persist credentials");
	ready();
	assert.equal(storage.size, 0);
	token.value = "opt-in-token";
	save.listeners.get("click")({});
	assert.equal(storage.get(key), "opt-in-token");
	token.value = "new-unsaved-token";
	socket().onclose({ code: 1000 });
	assert.equal(storage.get(key), "opt-in-token", "typing or disconnect must not update storage");
	clear.listeners.get("click")({});
	assert.equal(storage.has(key), false);
	assert.equal(token.value, "");
	assert.equal(browser(storage).elements.get("#token").value, "private-test-token", "no saved credential loads on a new page");
	const saved = browser(new Map([[key, "previously-saved"]]));
	assert.equal(saved.elements.get("#token").value, "previously-saved");
	assert.equal(saved.sent[0].token, "previously-saved");
});

test("TTY keeps the terminal keyboard-first with controls behind overflow", () => {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
	assert.match(html, /<details id="session-menu">/);
	assert.doesNotMatch(html, /<details id="session-menu" open>/);
	assert.doesNotMatch(html, /Keyboard input|Voice draft|Direct terminal keys|<summary>Help<\/summary>/);
	assert.doesNotMatch(html, /aria-describedby="notice"/);
	assert.match(html, /<nav id="accessory"[^>]*aria-label="Terminal keys"/);
	assert.match(css, /#accessory\s*\{[^}]*position:\s*sticky/);
	assert.match(css, /#accessory\s*\{[^}]*bottom:\s*0/);
	assert.match(css, /#key-row|\.key-row\s*\{[^}]*overflow-x:\s*auto/);
	assert.match(css, /#tabs\s*\{[^}]*overflow-x:\s*auto/);
	assert.match(html, /id="tab-order"/);
	assert.match(html, /id="history-lines"[^>]*min="1"[^>]*max="2000"/);
	assert.match(html, /id="save-token"/);
	assert.match(html, /id="clear-token"/);
	assert.doesNotMatch(html, /Select all output|Copy all output|id="history-select"/);
});

test("switching tabs cancels pending submission, gates raw input and preserves independent drafts", () => {
	const { elements, ready, command, key, sent, socket, term, flush } = browser();
	const shell = { id: "shell", label: "Shell", backend: "shell" };
	const work = { id: "tmux:work", label: "tmux · work", backend: "tmux" };
	const select = (id: string) => elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: encodeURIComponent(id) } }) },
	});
	ready(true, [shell, work]);
	command.value = "echo bản nháp";
	command.selectionStart = 5;
	command.selectionEnd = 8;
	key("Enter");
	select(work.id);
	term.data?.("must-not-reach-either-shell");
	flush();
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
	ready(true, [work, shell]);
	assert.equal(command.value, "", "a different terminal must not inherit the previous draft");
	command.value = "second draft";
	select(shell.id);
	ready(true, [shell, work]);
	assert.equal(command.value, "echo bản nháp");
	assert.equal(command.selectionStart, 5);
	assert.equal(command.selectionEnd, 8);
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
	select(work.id);
	socket().onmessage({ data: JSON.stringify({ type: "error", message: "Session unavailable" }) });
	assert.equal(command.value, "echo bản nháp");
	key("c", { ctrlKey: true });
	assert.equal(sent.at(-1).data, "\x03", "failed selection restores the current terminal");
});

test("output after a tab switch releases its per-connection backlog", () => {
	const { elements, ready, socket } = browser();
	const shell = { id: "shell", label: "Shell", backend: "shell" };
	const work = { id: "tmux:work", label: "Work", backend: "tmux" };
	ready(true, [shell, work]);
	elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: encodeURIComponent(work.id) } }) },
	});
	ready(true, [work, shell]);
	for (let i = 0; i < 18; i++) {
		socket().onmessage({ data: JSON.stringify({ type: "output", data: "x".repeat(64 * 1024) }) });
	}
	assert.equal(socket().readyState, 1, "processed output must not accumulate toward the congestion limit");
});

test("screen and tmux history is scrollable, isolated per tab and survives replay on switching", () => {
	const { elements, ready, socket } = browser();
	const shell = { id: "shell", label: "Shell", backend: "shell" };
	const tmux = { id: "tmux:$1", label: "Work", backend: "tmux" };
	const screen = { id: "screen:123.demo", label: "Demo", backend: "screen" };
	const select = (id: string) => elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: encodeURIComponent(id) } }) },
	});
	const output = (data: string) => socket().onmessage({ data: JSON.stringify({ type: "output", data }) });
	const history = elements.get("#history");
	const panel = elements.get("#history-panel");
	const text = elements.get("#history-text");
	ready(true, [shell, tmux, screen]);
	assert.equal(history.hidden, false);
	select(tmux.id);
	ready(true, [tmux, shell, screen]);
	assert.equal(history.hidden, false);
	output("\x1b[?1049h\x1b[1;1Hfirst tmux line\nsecond ");
	output("tmux line\n");
	history.listeners.get("click")({});
	assert.equal(history["aria-expanded"], "true");
	assert.equal(panel.hidden, false);
	assert.match(text.textContent, /first tmux line\nsecond tmux line/);
	assert.doesNotMatch(text.textContent, /\x1b/);
	select(screen.id);
	ready(true, [screen, shell, tmux]);
	output("screen only\n");
	history.listeners.get("click")({});
	assert.match(text.textContent, /screen only/);
	assert.doesNotMatch(text.textContent, /tmux line/);
	select(tmux.id);
	socket().onmessage({ data: JSON.stringify({ type: "ready", running: true,
		activeSession: tmux, sessions: [tmux, shell, screen], replay: "first tmux line\nsecond tmux line\n" }) });
	history.listeners.get("click")({});
	assert.equal(text.textContent.match(/first tmux line/g)?.length, 1, "server replay must not duplicate observed history");
	select(shell.id);
	ready(true, [shell, tmux, screen]);
	assert.equal(history.hidden, false);
	assert.equal(panel.hidden, true);
});

test("displayed history line limit clamps and updates live without sending terminal input", () => {
	const { elements, ready, socket, sent, selection } = browser();
	ready();
	const output = (data: string) => socket().onmessage({ data: JSON.stringify({ type: "output", data }) });
	const history = elements.get("#history");
	const lines = elements.get("#history-lines");
	const text = elements.get("#history-text");
	output("first\nsecond\nthird\n");
	history.listeners.get("click")({});
	lines.value = "2";
	const before = sent.length;
	lines.listeners.get("change")({});
	assert.equal(text.textContent, "second\nthird");
	output("fourth\n");
	assert.equal(text.textContent, "third\nfourth");
	elements.get("#history-panel").listeners.get("keydown")({ key: "a", ctrlKey: true, preventDefault() {} });
	assert.equal(selection.toString(), "third\nfourth");
	lines.value = "1";
	lines.listeners.get("change")({});
	assert.equal(text.textContent, "fourth");
	assert.equal(selection.toString(), "");
	for (const [value, expected] of [["0", "1"], ["5000", "2000"], ["", "2000"]] as const) {
		lines.value = value;
		lines.listeners.get("change")({});
		assert.equal(lines.value, expected);
	}
	assert.equal(text.textContent, "first\nsecond\nthird\nfourth\n");
	assert.equal(sent.length, before);
});

test("all tabs expose selectable history and copy every displayed row without sending a draft", async () => {
	for (const backend of ["shell", "tmux", "screen"]) {
		const { elements, ready, socket, sent, command, submit, flush, selection, clipboard } = browser();
		ready(true, [{ id: `${backend}:test`, label: "Test", backend }]);
		const output = "offscreen first row\nCộng hòa xã hội chủ nghĩa Việt Nam\n<tag>last row</tag>";
		socket().onmessage({ data: JSON.stringify({ type: "output", data: output }) });
		command.value = "must stay local";
		submit();
		const before = sent.length;
		elements.get("#history").listeners.get("click")({});
		elements.get("#history-panel").listeners.get("keydown")({ key: "a", ctrlKey: true, preventDefault() {} });
		flush();
		assert.equal(elements.get("#history-panel").hidden, false);
		assert.equal(selection.toString(), output);
		assert.equal(command.value, "must stay local");
		assert.equal(sent.length, before);
		await elements.get("#history-copy").listeners.get("click")({});
		assert.equal(clipboard.fallback.at(-1), output, "HTTP fallback copies all rows, not just the viewport");
		assert.match(elements.get("#copy-status").textContent, /Copied/);
		assert.equal(sent.length, before);
	}
});

test("native partial selection survives new output and Copy uses only the selected output", async () => {
	const { elements, ready, socket, selection, clipboard, command, sent } = browser();
	ready();
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "first\nsecond" }) });
	elements.get("#history").listeners.get("click")({});
	const text = elements.get("#history-text");
	text.listeners.get("pointerdown")({});
	selection.anchorNode = selection.focusNode = text;
	selection.text = "second";
	command.value = "untouched draft";
	const before = sent.length;
	const backspace = { dataset: { key: "Backspace" }, disabled: false };
	elements.get("#accessory").listeners.get("click")({ target: { closest: () => backspace }, detail: 0 });
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "\nthird" }) });
	assert.equal(text.textContent, "first\nsecond", "streaming must not replace the selected DOM node");
	await elements.get("#history-copy").listeners.get("click")({});
	assert.equal(clipboard.fallback.at(-1), "second");
	assert.equal(command.value, "untouched draft");
	assert.equal(sent.length, before);
	elements.get("#history").listeners.get("click")({});
	assert.equal(selection.toString(), "", "closing clears only the output selection");
	elements.get("#history").listeners.get("click")({});
	assert.equal(text.textContent, "first\nsecond\nthird", "live output continues to be retained during selection");
});

test("History Copy supports async clipboard, denied permission fallback, and honest manual-copy failure", async () => {
	for (const mode of ["secure", "denied", "manual"]) {
		const { elements, ready, socket, clipboard, selection } = browser();
		ready();
		socket().onmessage({ data: JSON.stringify({ type: "output", data: "tiếng Việt\nall output" }) });
		clipboard.api = { async writeText(text: string) {
			if (mode !== "secure") throw new Error("NotAllowedError");
			clipboard.writes.push(text);
		} };
		clipboard.fallbackWorks = mode !== "manual";
		elements.get("#history").listeners.get("click")({});
		elements.get("#history-panel").listeners.get("keydown")({ key: "a", ctrlKey: true, preventDefault() {} });
		await elements.get("#history-copy").listeners.get("click")({});
		if (mode === "secure") {
			assert.deepEqual(clipboard.writes, ["tiếng Việt\nall output"]);
			assert.deepEqual(clipboard.fallback, []);
		} else {
			assert.equal(clipboard.fallback.at(-1), "tiếng Việt\nall output");
		}
		assert.equal(selection.toString(), "tiếng Việt\nall output");
		assert.match(elements.get("#copy-status").textContent, mode === "manual" ? /browser.*Copy/i : /Copied/);
	}
});

test("output select-all keyboard shortcuts are scoped; live Ctrl+A/C remain terminal keys", async () => {
	const { elements, ready, socket, key, sent, selection, clipboard } = browser();
	ready();
	key("a", { ctrlKey: true });
	key("c", { ctrlKey: true });
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x01", "\x03"]);
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "terminal output" }) });
	elements.get("#history").listeners.get("click")({});
	const before = sent.length;
	for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
		let prevented = false;
		elements.get("#history-panel").listeners.get("keydown")({
			key: "a", ...modifier, preventDefault() { prevented = true; },
		});
		assert.equal(prevented, true);
		assert.equal(selection.toString(), "terminal output");
		await elements.get("#history-copy").listeners.get("click")({});
		assert.equal(clipboard.fallback.at(-1), "terminal output");
	}
	assert.equal(sent.length, before);
});

test("copy state clears on auth/session changes and ignores stale async completion", async () => {
	const { elements, ready, socket, clipboard, selection } = browser();
	ready();
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "old private output" }) });
	let resolve!: () => void;
	clipboard.api = { writeText: () => new Promise<void>((done) => { resolve = done; }) };
	const pending = elements.get("#history-copy").listeners.get("click")({});
	socket().onclose({ code: 1000 });
	assert.equal(selection.toString(), "");
	assert.equal(elements.get("#history-text").textContent, "");
	assert.equal(elements.get("#history").hidden, true);
	resolve();
	await pending;
	assert.equal(elements.get("#copy-status").textContent, "", "late clipboard result cannot overwrite a new controller's state");
});

test("mux history stays bounded to recent lines and clears before a new authentication", () => {
	const { elements, ready, socket } = browser();
	const mux = { id: "screen:123.demo", label: "Demo", backend: "screen" };
	ready(true, [mux]);
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "FIRST-MARKER\n" + "x\n".repeat(4000) + "LAST-MARKER\n" }) });
	elements.get("#history").listeners.get("click")({});
	const text = elements.get("#history-text");
	assert.ok(text.textContent.length <= 65536);
	assert.ok(text.textContent.split("\n").length <= 2000);
	assert.doesNotMatch(text.textContent, /FIRST-MARKER/);
	assert.match(text.textContent, /LAST-MARKER/);
	socket().onmessage({ data: JSON.stringify({ type: "output", data: "y".repeat(100_000) + "LONG-TAIL" }) });
	assert.equal(text.textContent.length, 65536, "a newline-free stream must also stay bounded");
	assert.ok(text.textContent.endsWith("LONG-TAIL"));
	elements.get("#connect").onclick();
	socket().onopen();
	ready(true, [mux]);
	elements.get("#history").listeners.get("click")({});
	assert.doesNotMatch(text.textContent, /LAST-MARKER/, "a new authentication cannot expose the previous controller's text");
	assert.doesNotMatch(text.textContent, /LONG-TAIL/);
});

test("history filters split terminal controls, treats output as text, and cannot send a pending command", () => {
	const { elements, ready, socket, sent, command, submit, flush, key, term } = browser();
	ready(true, [{ id: "tmux:$1", label: "Work", backend: "tmux" }]);
	const output = (data: string) => socket().onmessage({ data: JSON.stringify({ type: "output", data }) });
	output("\x1b]0;private title");
	output("\x1b\\\x1b[?1049h<tag>\x1b[");
	output("31m tiếng Việt\r\n");
	output("last line");
	const button = elements.get("#history");
	button.listeners.get("click")({});
	const panel = elements.get("#history-panel");
	const text = elements.get("#history-text");
	assert.equal(panel.focused, true);
	assert.equal(text.textContent, "<tag> tiếng Việt\nlast line");
	assert.doesNotMatch(text.textContent, /private title|\x1b/);
	const before = sent.length;
	command.value = "printf 'MUST_NOT_RUN\\n'";
	submit();
	flush();
	assert.equal(key("Enter"), true, "the editor may consume the key while history is open");
	term.data?.("MUST_NOT_REACH_PTY");
	flush();
	assert.equal(sent.length, before);
	button.listeners.get("click")({});
	assert.equal(panel.hidden, true);
	assert.equal(button["aria-expanded"], "false");
});

test("exited sessions still allow authenticated tab selection and refresh", () => {
	const { elements, ready, sent, socket } = browser();
	ready();
	socket().onmessage({ data: JSON.stringify({ type: "exit", code: 0 }) });
	elements.get("#session-refresh").onclick();
	assert.equal(sent.at(-1).type, "sessions");
	elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: "tmux%3Awork" } }) },
	});
	assert.equal(sent.at(-1).type, "select");
	socket().onclose({ code: 1000 });
	const count = sent.length;
	elements.get("#session-refresh").onclick();
	assert.equal(sent.length, count, "offline discovery must not send anything");
});

test("reconnect to a different controller session never transfers the old draft", () => {
	const { elements, ready, command, socket, key, sent } = browser();
	const shell = { id: "shell", label: "Shell", backend: "shell" };
	const work = { id: "tmux:$1", label: "Work", backend: "tmux" };
	ready(true, [shell, work]);
	command.value = "shell-only draft";
	socket().onclose({ code: 1012 });
	elements.get("#connect").onclick();
	socket().onopen();
	ready(true, [work, shell]);
	assert.equal(command.value, "");
	key("c", { ctrlKey: true });
	assert.equal(sent.at(-1).sessionId, work.id);
	elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: "shell" } }) },
	});
	ready(true, [shell, work]);
	assert.equal(command.value, "shell-only draft");
	socket().onmessage({ data: JSON.stringify({ type: "error", message: "Session unavailable" }) });
	assert.equal(command.value, "shell-only draft");
});

test("session creation is explicit, validated, and does not send a pending draft", () => {
	const { elements, ready, sent, command, flush } = browser();
	ready();
	command.value = "never execute on creation";
	elements.get("#session-name").value = "work-2";
	elements.get("#session-backend").value = "tmux";
	elements.get("#session-create").listeners.get("submit")({ preventDefault() {} });
	assert.deepEqual(sent.at(-1), { v: 1, type: "create", backend: "tmux", name: "work-2" });
	flush();
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
});

test("tab changes wait for native composition and escape session labels as text", () => {
	const { elements, ready, command, sent } = browser();
	ready(true, [
		{ id: "shell", label: "Shell", backend: "shell" },
		{ id: "tmux:work", label: "<img src=x onerror=alert(1)>", backend: "tmux" },
	]);
	assert.doesNotMatch(elements.get("#tabs").innerHTML, /<img/);
	command.listeners.get("compositionstart")({});
	elements.get("#tabs").listeners.get("click")({
		target: { closest: () => ({ dataset: { sessionId: "tmux%3Awork" } }) },
	});
	assert.equal(sent.filter((m) => m.type === "select").length, 0);
});

test("Alt is one-shot or double-tap locked and works with xterm keys", () => {
	const { elements, ready, command, sent, term, socket } = browser();
	ready();
	const alt = elements.get("#alt");
	alt.listeners.get("click")({});
	command.listeners.get("beforeinput")({ inputType: "insertText", data: "b", preventDefault() {} });
	assert.equal(sent.at(-1).data, "\x1bb");
	assert.equal(alt.textContent, "Alt");
	alt.listeners.get("click")({});
	alt.listeners.get("click")({});
	assert.equal(alt.dataset.locked, "true");
	term.focus();
	assert.equal(term.customKey?.({ type: "keydown", key: "f", preventDefault() {} }), false);
	assert.equal(sent.at(-1).data, "\x1bf");
	assert.equal(alt.dataset.locked, "true");
	socket().onclose({ code: 1000 });
	assert.equal(alt.textContent, "Alt");
});

test("noncancelable and input-only mobile modifier events emit exactly one encoded key", () => {
	for (const modifier of ["ctrl", "alt"]) {
		for (const withBeforeInput of [true, false]) {
			const { elements, ready, command, sent } = browser();
			ready();
			elements.get(`#${modifier}`).listeners.get("click")({});
			if (withBeforeInput) command.listeners.get("beforeinput")({
				inputType: "insertText", data: "c", cancelable: false, preventDefault() {},
			});
			command.value = "c";
			command.listeners.get("input")({ inputType: "insertText", data: "c" });
			assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data),
				[modifier === "ctrl" ? "\x03" : "\x1bc"]);
			assert.equal(command.value, "");
		}
	}
});

test("accessory Return uses the same late-correction guard as physical Enter", () => {
	const { elements, ready, command, sent, flush } = browser();
	ready();
	command.value = "echo provisional";
	elements.get("#accessory").listeners.get("click")({
		target: { closest: () => ({ dataset: { key: "Enter" } }) }, detail: 0,
	});
	command.value = "echo corrected";
	flush();
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	assert.equal(command.value, "echo corrected");
});

test("accessory rows keep labeled keys separated and reveal overflow controls without OS scrollbars", () => {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
	assert.match(css, /\.key-row \{[^}]*gap: 5px;[^}]*overflow-x: auto/);
	assert.match(css, /\.key-row button \{[^}]*flex: 0 0 auto;[^}]*min-width: 38px/);
	assert.match(css, /button\[data-key="PageDown"\] \{ min-width: 48px/);
	assert.match(css, /\.key-scroll\[hidden\] \{ display: none/);
	assert.match(html, /id="function-keys" class="key-strip" hidden/);
	for (const label of ["Home", "End", "PageUp", "PageDown", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]) {
		assert.match(html, new RegExp(`data-key="${label}"`));
	}
	assert.equal((html.match(/class="key-scroll"/g) ?? []).length, 4);
});

test("overflow arrows scroll each row independently without sending input or changing the IME draft", () => {
	const { elements, ready, sent, command } = browser();
	ready();
	const accessory = elements.get("#accessory");
	const primary = elements.get("#primary-key-row");
	const extra = elements.get("#extra-key-row");
	const [firstLeft, firstRight] = elements.get("#primary-key-strip").querySelectorAll();
	const [left, right] = elements.get("#function-keys").querySelectorAll();
	primary.scrollWidth = 460;
	extra.scrollWidth = 980;
	primary.listeners.get("scroll")({});
	elements.get("#more").listeners.get("click")({});
	assert.equal(elements.get("#function-keys").hidden, false);
	assert.equal(firstRight.hidden, false);
	assert.equal(firstLeft.disabled, true);
	assert.equal(right.hidden, false);
	assert.equal(left.disabled, true);
	command.value = "gõ tiếng Việt";
	const baseline = sent.length;
	const tap = (button: any) => {
		let prevented = false;
		accessory.listeners.get("pointerdown")({
			target: { closest: () => button }, pointerId: 1, button: 0,
			preventDefault() { prevented = true; },
		});
		assert.equal(prevented, true, "pointer scroll keeps native keyboard focus");
		accessory.listeners.get("click")({ target: { closest: () => button }, detail: 1 });
	};
	tap(right);
	assert.ok(extra.scrollLeft > 0);
	assert.equal(left.disabled, false);
	assert.equal(primary.scrollLeft, 0);
	assert.equal(sent.length, baseline, "ordinary scroll must not emit terminal input");
	command.listeners.get("compositionstart")({});
	tap(left);
	assert.equal(extra.scrollLeft, 0);
	tap(firstRight);
	assert.ok(primary.scrollLeft > 0);
	assert.equal(firstLeft.disabled, false);
	assert.equal(command.value, "gõ tiếng Việt");
	assert.equal(sent.length, baseline, "scrolling must not send PTY bytes during composition");
	for (let i = 0; i < 8; i++) tap(right);
	assert.equal(right.disabled, true, "right arrow stops at the end of F1–F12");
	assert.equal(sent.length, baseline);
	primary.scrollWidth = primary.clientWidth;
	primary.scrollLeft = 0;
	primary.listeners.get("scroll")({});
	assert.equal(firstRight.hidden, true);
	assert.equal(firstLeft.hidden, true);
});

test("terminal click restores IME on the shell without interrupting selection or full-screen apps", () => {
	const { elements, command, form, ready, term } = browser();
	ready();
	const terminalContainer = elements.get("#terminal");
	command.value = "echo tiếng Việt";
	command.focused = false;
	term.focusChange?.(); // xterm takes focus when the terminal is clicked.
	assert.equal(form.hidden, true);
	terminalContainer.listeners.get("click")({});
	assert.equal(command.focused, true);
	assert.equal(form.hidden, false);
	assert.equal(command.value, "echo tiếng Việt");

	term.selected = true;
	term.focusChange?.();
	terminalContainer.listeners.get("click")({});
	assert.equal(form.hidden, true, "selection must remain available for copy");
	term.selected = false;

	(term.buffer.active as any).type = "alternate";
	term.focusChange?.();
	terminalContainer.listeners.get("click")({});
	assert.equal(form.hidden, true, "alternate-buffer programs keep xterm focus");
});

test("draft and native selection render as literal text without PTY local echo, then clear on send", () => {
	const { elements, command, ready, sent, key, flush, frame } = browser();
	ready();
	command.value = 'echo "<script>tiếng Việt</script>"';
	command.selectionStart = 6;
	command.selectionEnd = 22;
	command.listeners.get("input")({});
	frame();
	assert.equal(elements.get("#command-before").textContent, command.value.slice(0, 6));
	assert.equal(elements.get("#command-selection").textContent, command.value.slice(6, 22));
	assert.equal(elements.get("#command-after").textContent, command.value.slice(22));
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	key("Enter");
	flush();
	assert.equal(elements.get("#command-before").textContent, "");
	assert.equal(elements.get("#command-selection").textContent, "");
	assert.equal(elements.get("#command-after").textContent, "");
	assert.equal(sent.filter((m) => m.type === "input").length, 1);
});

test("input, selection and PTY cursor bursts paint once per frame without synchronous layout", () => {
	const { elements, command, ready, term, frame, layoutReads, sent } = browser();
	ready();
	const baseline = layoutReads();
	for (let i = 300; i > 0; i--) {
		command.value = "ế".repeat(i);
		command.selectionStart = command.selectionEnd = i;
		command.listeners.get("input")({ inputType: "deleteContentBackward" });
		command.listeners.get("select")({});
		term.cursorMove?.();
	}
	assert.equal(layoutReads(), baseline, "native editing must not force layout per input event");
	frame();
	assert.ok(layoutReads() - baseline <= 4, "one geometry pass per animation frame");
	assert.equal(elements.get("#command-before").textContent, "ế");
	assert.equal(sent.filter((m) => m.type === "input").length, 0);
	const painted = layoutReads();
	frame();
	assert.equal(layoutReads(), painted, "no perpetual render loop");
});

test("system keyboard Backspace on an empty proxy reaches PTY without keydown", () => {
	const { command, ready, sent } = browser();
	ready();
	let prevented = false;
	command.listeners.get("beforeinput")({
		inputType: "deleteContentBackward", preventDefault() { prevented = true; },
	});
	assert.equal(prevented, true);
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x7f"]);
});

test("accessory Backspace deletes one grapheme on press and never repeats while held", () => {
	const { elements, command, ready, sent, advance, frame } = browser();
	ready();
	const accessory = elements.get("#accessory");
	const button = { dataset: { key: "Backspace" }, disabled: false, setPointerCapture() {} };
	const target = { closest: () => button };
	const event = { target, pointerId: 1, button: 0, preventDefault() {} };
	command.value = "aế👨‍👩‍👧‍👦";
	command.selectionStart = command.selectionEnd = command.value.length;
	accessory.listeners.get("pointerdown")(event);
	assert.equal(command.value, "aế", "one whole grapheme removed before pointerup");
	advance(1000); frame();
	assert.equal(command.value, "aế", "elapsed time cannot synthesize another deletion");
	assert.equal(sent.filter((m) => m.type === "input").length, 0, "holding cannot spill into remote shell edits");
	accessory.listeners.get("pointerup")(event);
	accessory.listeners.get("click")({ target, detail: 1 });
	assert.equal(command.value, "aế", "release click must not delete twice");
	assert.equal(sent.filter((m) => m.type === "input").length, 0, "release click must not delete twice");
});

test("accessory Backspace preserves native selection through release, cancel, blur and disconnect", () => {
	for (const stop of ["pointerup", "pointercancel", "lostpointercapture", "blur", "disconnect"]) {
		const { elements, command, ready, sent, advance, windowListeners, socket } = browser();
		ready();
		command.value = "aếb";
		command.selectionStart = 1; command.selectionEnd = 2;
		const accessory = elements.get("#accessory");
		const button = { dataset: { key: "Backspace" }, disabled: false, setPointerCapture() {} };
		const event = { target: { closest: () => button }, pointerId: 7, button: 0, preventDefault() {} };
		accessory.listeners.get("pointerdown")(event);
		assert.equal(command.value, "ab");
		if (stop === "blur") windowListeners.get("blur")?.();
		else if (stop === "disconnect") socket().onclose({ code: 1000 });
		else accessory.listeners.get(stop)?.(event);
		advance(1500);
		assert.equal(command.value, "ab", stop);
		assert.equal(sent.filter((m) => m.type === "input").length, 0);
	}
});

test("remote accessory Backspace sends one byte per press with no timed or release duplicate", () => {
	const { elements, ready, sent, advance } = browser();
	ready();
	const accessory = elements.get("#accessory");
	const button = { dataset: { key: "Backspace" }, disabled: false, setPointerCapture() {} };
	const event = { target: { closest: () => button }, pointerId: 3, button: 0, preventDefault() {} };
	accessory.listeners.get("pointerdown")(event);
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x7f"]);
	advance(600);
	const count = sent.filter((m) => m.type === "input").length;
	assert.equal(count, 1, "a held accessory Backspace must not synthesize repeat bytes");
	accessory.listeners.get("pointerup")(event);
	accessory.listeners.get("click")({ target: event.target, detail: 1 });
	advance(1000);
	assert.equal(sent.filter((m) => m.type === "input").length, count);
	assert.ok(sent.filter((m) => m.type === "input").every((m) => m.data === "\x7f"));
});

test("keyboard activation of accessory Backspace edits the local selection without flushing it", () => {
	const { elements, command, ready, sent, advance } = browser();
	ready();
	command.value = "aếb";
	command.selectionStart = 1; command.selectionEnd = 2;
	const button = { dataset: { key: "Backspace" }, disabled: false };
	elements.get("#accessory").listeners.get("click")({ target: { closest: () => button }, detail: 0 });
	advance(1500);
	assert.equal(command.value, "ab");
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
});

test("accessory deletion updates native draft state before a separate OS Backspace", () => {
	const { elements, command, ready, sent, advance } = browser();
	ready();
	command.value = "ế";
	command.selectionStart = command.selectionEnd = 1;
	command.listeners.get("input")({ inputType: "insertText", data: "ế" });
	const button = { dataset: { key: "Backspace" }, disabled: false };
	const target = { closest: () => button };
	elements.get("#accessory").listeners.get("pointerdown")({
		target, pointerId: 1, button: 0, preventDefault() {},
	});
	assert.equal(command.value, "");
	advance(1500);
	assert.deepEqual(sent.filter((m) => m.type === "input"), []);
	command.listeners.get("input")({ inputType: "deleteContentBackward" });
	assert.deepEqual(sent.filter((m) => m.type === "input").map((m) => m.data), ["\x7f"]);
});

test("native deletion only responds to delivered events, never elapsed time", () => {
	for (const path of ["hardware", "beforeinput", "input"]) {
		const { command, ready, key, sent, advance } = browser();
		ready();
		for (let i = 1; i <= 3; i++) {
			if (path === "hardware") key("Backspace", { repeat: i > 1 });
			else command.listeners.get(path)({ inputType: "deleteContentBackward", preventDefault() {} });
			advance(1500);
			assert.equal(sent.filter((m) => m.type === "input").length, i, path);
		}
	}
});

test("accessory arrow repeat remains bounded and stops on release, cancel, blur or disconnect", () => {
	for (const stop of ["pointerup", "pointercancel", "lostpointercapture", "blur", "disconnect"]) {
		const { elements, ready, sent, advance, windowListeners, socket } = browser();
		ready();
		const button = { dataset: { key: "ArrowLeft" }, disabled: false, setPointerCapture() {} };
		const event = { target: { closest: () => button }, pointerId: 4, button: 0, preventDefault() {} };
		const accessory = elements.get("#accessory");
		accessory.listeners.get("pointerdown")(event);
		advance(600);
		const count = sent.filter((m) => m.type === "input").length;
		assert.ok(count >= 3 && count <= 10);
		if (stop === "blur") windowListeners.get("blur")?.();
		else if (stop === "disconnect") socket().onclose({ code: 1000 });
		else accessory.listeners.get(stop)(event);
		advance(1500);
		assert.equal(sent.filter((m) => m.type === "input").length, count, stop);
		assert.ok(sent.filter((m) => m.type === "input").every((m) => m.data === "\x1b[D"));
	}
});
