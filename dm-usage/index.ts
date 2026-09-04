/**
 * /usage - Usage statistics dashboard
 *
 * Shows an inline view with usage stats grouped by provider.
 * - Tab cycles: Today → This Week → Last Week → All Time
 * - Arrow keys navigate providers
 * - Enter expands/collapses to show models
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@duckmind/dm-coding-agent";
import { DynamicBorder } from "@duckmind/dm-coding-agent";
import { CancellableLoader, Container, Spacer, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi, type AutocompleteItem } from "@duckmind/dm-tui";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Types
// =============================================================================

interface TokenStats {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface BaseStats {
	messages: number;
	cost: number;
	tokens: TokenStats;
}

interface ModelStats extends BaseStats {
	sessions: Set<string>;
}

interface ProviderStats extends BaseStats {
	sessions: Set<string>;
	models: Map<string, ModelStats>;
}

interface TotalStats extends BaseStats {
	sessions: number;
}

interface Insight {
	percent: number; // 0-100
	headline: string;
	advice: string;
}

interface PeriodInsights {
	insights: Insight[];
}

interface RawMessage {
	sessionId: string;
	timestamp: number;
	cost: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PeriodRawData {
	messages: RawMessage[];
	sessionCosts: Map<string, number>;
}

interface GlobalSessionSpan {
	startMs: number;
	endMs: number;
}

interface TimeFilteredStats {
	providers: Map<string, ProviderStats>;
	totals: TotalStats;
	dailySpend: Map<string, number>;
	insights: PeriodInsights;
}

interface UsageData {
	today: TimeFilteredStats;
	thisWeek: TimeFilteredStats;
	lastWeek: TimeFilteredStats;
	allTime: TimeFilteredStats;
}

type TabName = "today" | "thisWeek" | "lastWeek" | "allTime";
type ViewMode = "table" | "insights";
type UsageSubcommand = "use" | "show" | "rotation" | "verify" | "path" | "reset" | "help";
type UsageResetTarget = "manual" | "quota" | "all";

interface UsageManagedAccount {
	id: string;
	label: string;
	provider: string;
	source: "session" | "manual";
	updatedAt: string;
	quotaExhaustedUntil?: number;
}

interface UsageManagedState {
	version: 1;
	manualAccountId?: string;
	removedAccountIds: string[];
	accounts: UsageManagedAccount[];
	updatedAt: string;
}

interface UsageManagedSummary {
	data: UsageData;
	state: UsageManagedState;
	accounts: UsageManagedAccount[];
}

// =============================================================================
// Column Configuration
// =============================================================================

interface DataColumn {
	label: string;
	width: number;
	dimmed?: boolean;
	getValue: (stats: BaseStats & { sessions: Set<string> | number }) => string;
}

interface TableLayoutCandidate {
	columns: DataColumn[];
	minNameWidth: number;
	compact?: boolean;
}

interface TableLayout {
	columns: DataColumn[];
	nameWidth: number;
	tableWidth: number;
	compact: boolean;
}

const MAX_NAME_COL_WIDTH = 26;
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	"openai-codex": "duckmind-ultra",
	openrouter: "duckmind-standard",
};

function formatProviderName(provider: string): string {
	return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

const SESSIONS_COLUMN: DataColumn = {
	label: "Sessions",
	width: 9,
	getValue: (s) => formatNumber(typeof s.sessions === "number" ? s.sessions : s.sessions.size),
};

const MSGS_COLUMN: DataColumn = {
	label: "Msgs",
	width: 9,
	getValue: (s) => formatNumber(s.messages),
};

const COST_COLUMN: DataColumn = {
	label: "Cost",
	width: 9,
	getValue: (s) => formatCost(s.cost),
};

const TOKENS_COLUMN: DataColumn = {
	label: "Tokens",
	width: 9,
	getValue: (s) => formatTokens(s.tokens.total),
};

const INPUT_COLUMN: DataColumn = {
	label: "↑In",
	width: 8,
	dimmed: true,
	// Include cacheWrite so this reflects fresh input tokens sent this turn,
	// even for providers like Anthropic that split cached prompt creation out
	// from the regular input token count.
	getValue: (s) => formatTokens(s.tokens.input + s.tokens.cacheWrite),
};

const OUTPUT_COLUMN: DataColumn = {
	label: "↓Out",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.output),
};

const CACHE_COLUMN: DataColumn = {
	label: "Cache",
	width: 8,
	dimmed: true,
	getValue: (s) => formatTokens(s.tokens.cacheRead + s.tokens.cacheWrite),
};

const FULL_DATA_COLUMNS: DataColumn[] = [
	SESSIONS_COLUMN,
	MSGS_COLUMN,
	COST_COLUMN,
	TOKENS_COLUMN,
	INPUT_COLUMN,
	OUTPUT_COLUMN,
	CACHE_COLUMN,
];

const TABLE_LAYOUTS: TableLayoutCandidate[] = [
	{ columns: FULL_DATA_COLUMNS, minNameWidth: MAX_NAME_COL_WIDTH },
	{ columns: [SESSIONS_COLUMN, MSGS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 14, compact: true },
	{ columns: [SESSIONS_COLUMN, COST_COLUMN, TOKENS_COLUMN], minNameWidth: 12, compact: true },
	{ columns: [COST_COLUMN, TOKENS_COLUMN], minNameWidth: 10, compact: true },
	{ columns: [COST_COLUMN], minNameWidth: 8, compact: true },
];

// =============================================================================
// Data Collection
// =============================================================================

function getAgentDir(): string {
	// Respect DM_CODING_AGENT_DIR, keeping PI_CODING_AGENT_DIR only as a compatibility fallback
	return process.env.DM_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".dm", "agent");
}

function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

function getUsageStateDir(): string {
	return join(getAgentDir(), "usage");
}

function getUsageStatePath(): string {
	return join(getUsageStateDir(), "state.json");
}

function getAgentSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

async function collectSessionFilesRecursively(dir: string, files: string[], signal?: AbortSignal): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (signal?.aborted) return;
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await collectSessionFilesRecursively(entryPath, files, signal);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	} catch {
		// Skip directories we can't read
	}
}

async function getAllSessionFiles(signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	await collectSessionFilesRecursively(getSessionsDir(), files, signal);
	files.sort();
	return files;
}

interface SessionMessage {
	provider: string;
	model: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	timestamp: number;
}

interface ParsedSessionFile {
	sessionId: string;
	messages: SessionMessage[];
}

async function parseSessionFile(
	filePath: string,
	seenHashes: Set<string>,
	signal?: AbortSignal
): Promise<ParsedSessionFile | null> {
	try {
		const content = await readFile(filePath, "utf8");
		if (signal?.aborted) return null;
		const lines = content.trim().split("\n");
		const messages: SessionMessage[] = [];
		let sessionId = "";

		for (let i = 0; i < lines.length; i++) {
			if (signal?.aborted) return null;
			if (i % 500 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const line = lines[i]!;
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);

				if (entry.type === "session") {
					sessionId = entry.id;
				} else if (entry.type === "message" && entry.message?.role === "assistant") {
					const msg = entry.message;
					if (msg.usage && msg.provider && msg.model) {
						const input = msg.usage.input || 0;
						const output = msg.usage.output || 0;
						const cacheRead = msg.usage.cacheRead || 0;
						const cacheWrite = msg.usage.cacheWrite || 0;
						const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
						const timestamp = msg.timestamp || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);

						// Deduplicate copied history across branched session files.
						// Keep the existing ccusage-style hash so current totals remain comparable.
						const totalTokens = input + output + cacheRead + cacheWrite;
						const hash = `${timestamp}:${totalTokens}`;
						if (seenHashes.has(hash)) continue;
						seenHashes.add(hash);

						messages.push({
							provider: msg.provider,
							model: msg.model,
							cost: msg.usage.cost?.total || 0,
							input,
							output,
							cacheRead,
							cacheWrite,
							timestamp,
						});
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		return sessionId ? { sessionId, messages } : null;
	} catch {
		return null;
	}
}

// Helper to accumulate stats into a target
function accumulateStats(
	target: BaseStats,
	cost: number,
	tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number }
): void {
	target.messages++;
	target.cost += cost;
	target.tokens.total += tokens.total;
	target.tokens.input += tokens.input;
	target.tokens.output += tokens.output;
	target.tokens.cacheRead += tokens.cacheRead;
	target.tokens.cacheWrite += tokens.cacheWrite;
}

function emptyTokens(): TokenStats {
	return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyModelStats(): ModelStats {
	return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
}

function emptyProviderStats(): ProviderStats {
	return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens(), models: new Map() };
}

function emptyTimeFilteredStats(): TimeFilteredStats {
	return {
		providers: new Map(),
		totals: { sessions: 0, messages: 0, cost: 0, tokens: emptyTokens() },
		dailySpend: new Map(),
		insights: { insights: [] },
	};
}

function emptyPeriodRawData(): PeriodRawData {
	return { messages: [], sessionCosts: new Map() };
}

function emptyUsageData(): UsageData {
	return {
		today: emptyTimeFilteredStats(),
		thisWeek: emptyTimeFilteredStats(),
		lastWeek: emptyTimeFilteredStats(),
		allTime: emptyTimeFilteredStats(),
	};
}

function getPeriodsForTimestamp(timestamp: number, todayMs: number, weekStartMs: number, lastWeekStartMs: number): TabName[] {
	const periods: TabName[] = ["allTime"];
	if (timestamp >= todayMs) periods.push("today");
	if (timestamp >= weekStartMs) {
		periods.push("thisWeek");
	} else if (timestamp >= lastWeekStartMs) {
		periods.push("lastWeek");
	}
	return periods;
}

function addMessagesToUsageData(
	data: UsageData,
	sessionId: string,
	messages: SessionMessage[],
	todayMs: number,
	weekStartMs: number,
	lastWeekStartMs: number,
	rawByPeriod: Record<TabName, PeriodRawData>,
	globalSessionSpans: Map<string, GlobalSessionSpan>
): void {
	const sessionContributed = { today: false, thisWeek: false, lastWeek: false, allTime: false };

	for (const msg of messages) {
		// Track real per-session lifetime across every message we see, regardless of
		// which period the message falls into. Used later for the "8h+ session" insight.
		if (msg.timestamp > 0) {
			const span = globalSessionSpans.get(sessionId);
			if (!span) {
				globalSessionSpans.set(sessionId, { startMs: msg.timestamp, endMs: msg.timestamp });
			} else {
				if (msg.timestamp < span.startMs) span.startMs = msg.timestamp;
				if (msg.timestamp > span.endMs) span.endMs = msg.timestamp;
			}
		}

		const periods = getPeriodsForTimestamp(msg.timestamp, todayMs, weekStartMs, lastWeekStartMs);
		const tokens = {
			// Count fresh tokens processed this turn.
			// Include cacheWrite because those prompt tokens were newly written and billed.
			// Exclude cacheRead because repeated cache hits would otherwise dominate totals.
			total: msg.input + msg.output + msg.cacheWrite,
			input: msg.input,
			output: msg.output,
			cacheRead: msg.cacheRead,
			cacheWrite: msg.cacheWrite,
		};

		for (const period of periods) {
			const stats = data[period];

			let providerStats = stats.providers.get(msg.provider);
			if (!providerStats) {
				providerStats = emptyProviderStats();
				stats.providers.set(msg.provider, providerStats);
			}

			let modelStats = providerStats.models.get(msg.model);
			if (!modelStats) {
				modelStats = emptyModelStats();
				providerStats.models.set(msg.model, modelStats);
			}

			modelStats.sessions.add(sessionId);
			accumulateStats(modelStats, msg.cost, tokens);

			providerStats.sessions.add(sessionId);
			accumulateStats(providerStats, msg.cost, tokens);

			accumulateStats(stats.totals, msg.cost, tokens);
			if (msg.cost > 0 && msg.timestamp > 0) {
				const dayKey = new Date(msg.timestamp).toISOString().slice(0, 10);
				stats.dailySpend.set(dayKey, (stats.dailySpend.get(dayKey) ?? 0) + msg.cost);
			}
			sessionContributed[period] = true;

			const raw = rawByPeriod[period];
			raw.messages.push({
				sessionId,
				timestamp: msg.timestamp,
				cost: msg.cost,
				input: msg.input,
				cacheRead: msg.cacheRead,
				cacheWrite: msg.cacheWrite,
			});
			raw.sessionCosts.set(sessionId, (raw.sessionCosts.get(sessionId) ?? 0) + msg.cost);
		}
	}

	if (sessionContributed.today) data.today.totals.sessions++;
	if (sessionContributed.thisWeek) data.thisWeek.totals.sessions++;
	if (sessionContributed.lastWeek) data.lastWeek.totals.sessions++;
	if (sessionContributed.allTime) data.allTime.totals.sessions++;
}

async function collectUsageData(signal?: AbortSignal): Promise<UsageData | null> {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const todayMs = startOfToday.getTime();

	// Start of current week (Monday 00:00)
	const startOfWeek = new Date();
	const dayOfWeek = startOfWeek.getDay(); // 0 = Sunday, 1 = Monday, ...
	const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	startOfWeek.setDate(startOfWeek.getDate() - daysSinceMonday);
	startOfWeek.setHours(0, 0, 0, 0);
	const weekStartMs = startOfWeek.getTime();

	// Start of last week (previous Monday 00:00)
	const startOfLastWeek = new Date(startOfWeek);
	startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
	const lastWeekStartMs = startOfLastWeek.getTime();

	const data = emptyUsageData();
	const rawByPeriod: Record<TabName, PeriodRawData> = {
		today: emptyPeriodRawData(),
		thisWeek: emptyPeriodRawData(),
		lastWeek: emptyPeriodRawData(),
		allTime: emptyPeriodRawData(),
	};
	const globalSessionSpans = new Map<string, GlobalSessionSpan>();

	const sessionFiles = await getAllSessionFiles(signal);
	if (signal?.aborted) return null;
	const seenHashes = new Set<string>();

	for (const filePath of sessionFiles) {
		if (signal?.aborted) return null;
		const parsed = await parseSessionFile(filePath, seenHashes, signal);
		if (signal?.aborted) return null;
		if (!parsed) continue;

		addMessagesToUsageData(
			data,
			parsed.sessionId,
			parsed.messages,
			todayMs,
			weekStartMs,
			lastWeekStartMs,
			rawByPeriod,
			globalSessionSpans
		);

		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	// Classify sessions that are globally long-running once, then reuse across periods.
	const longSessionIds = new Set<string>();
	for (const [id, span] of globalSessionSpans) {
		if (span.endMs - span.startMs >= LONG_SESSION_MS) longSessionIds.add(id);
	}

	for (const period of TAB_ORDER) {
		data[period].insights = computeInsights(rawByPeriod[period], longSessionIds);
	}

	return data;
}

// =============================================================================
// Managed Account Command Helpers
// =============================================================================

const USAGE_SUBCOMMANDS = ["use", "show", "rotation", "verify", "path", "reset", "help"] as const;
const USAGE_RESET_TARGETS = ["manual", "quota", "all"] as const;
const USAGE_HELP_TEXT = [
	"Usage: /usage [use|show|rotation|verify|path|reset|help]",
	"use: select, activate, or remove managed account",
	"show: managed account and usage summary",
	"rotation: current rotation behavior",
	"verify: runtime health checks",
	"path: storage and settings locations",
	"reset: clear manual or quota state",
].join("\n");

function parseUsageCommandArgs(args: string): { subcommand?: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };
	const firstSpaceIndex = trimmed.indexOf(" ");
	if (firstSpaceIndex < 0) return { subcommand: trimmed.toLowerCase(), rest: "" };
	return {
		subcommand: trimmed.slice(0, firstSpaceIndex).toLowerCase(),
		rest: trimmed.slice(firstSpaceIndex + 1).trim(),
	};
}

function isUsageSubcommand(value: string): value is UsageSubcommand {
	return USAGE_SUBCOMMANDS.some((subcommand) => subcommand === value);
}

function parseUsageResetTarget(value: string): UsageResetTarget | undefined {
	if (value === "manual" || value === "quota" || value === "all") return value;
	return undefined;
}

function toAutocompleteItems(values: readonly string[]): AutocompleteItem[] {
	return values.map((value) => ({ value, label: value }));
}

function getUsageCommandCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const trimmedStart = argumentPrefix.trimStart();
	if (!trimmedStart) return toAutocompleteItems(USAGE_SUBCOMMANDS);

	const firstSpaceIndex = trimmedStart.indexOf(" ");
	if (firstSpaceIndex < 0) {
		const matches = USAGE_SUBCOMMANDS.filter((value) => value.startsWith(trimmedStart.toLowerCase()));
		return matches.length > 0 ? toAutocompleteItems(matches) : null;
	}

	const subcommand = trimmedStart.slice(0, firstSpaceIndex).toLowerCase();
	const rest = trimmedStart.slice(firstSpaceIndex + 1).toLowerCase();
	if (subcommand === "reset") {
		const matches = USAGE_RESET_TARGETS.filter((value) => value.startsWith(rest));
		return matches.length > 0 ? matches.map((value) => ({ value: `reset ${value}`, label: value })) : null;
	}
	if (subcommand === "use") {
		const matches = ["clear", "remove"].filter((value) => value.startsWith(rest));
		return matches.length > 0 ? matches.map((value) => ({ value: `use ${value}`, label: value })) : null;
	}
	return null;
}

function emptyUsageManagedState(): UsageManagedState {
	return { version: 1, removedAccountIds: [], accounts: [], updatedAt: new Date(0).toISOString() };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUsageManagedAccount(value: unknown): UsageManagedAccount | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const id = asString(record.id);
	const provider = asString(record.provider) ?? id;
	if (!id || !provider) return undefined;
	const label = asString(record.label) ?? formatProviderName(provider);
	const source = record.source === "manual" ? "manual" : "session";
	const updatedAt = asString(record.updatedAt) ?? new Date(0).toISOString();
	const quota =
		typeof record.quotaExhaustedUntil === "number" && Number.isFinite(record.quotaExhaustedUntil)
			? record.quotaExhaustedUntil
			: undefined;
	return { id, label, provider, source, updatedAt, quotaExhaustedUntil: quota };
}

function normalizeUsageManagedState(value: unknown): UsageManagedState {
	const empty = emptyUsageManagedState();
	if (!value || typeof value !== "object") return empty;
	const record = value as Record<string, unknown>;
	const accounts = Array.isArray(record.accounts)
		? record.accounts.map(normalizeUsageManagedAccount).filter((account): account is UsageManagedAccount => Boolean(account))
		: [];
	const removedAccountIds = Array.isArray(record.removedAccountIds)
		? record.removedAccountIds.map(asString).filter((id): id is string => Boolean(id))
		: [];
	return {
		version: 1,
		manualAccountId: asString(record.manualAccountId),
		removedAccountIds,
		accounts,
		updatedAt: asString(record.updatedAt) ?? empty.updatedAt,
	};
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

async function readUsageManagedState(): Promise<{ state: UsageManagedState; error?: string }> {
	try {
		const raw = await readFile(getUsageStatePath(), "utf8");
		return { state: normalizeUsageManagedState(JSON.parse(raw)) };
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return { state: emptyUsageManagedState() };
		return { state: emptyUsageManagedState(), error: error instanceof Error ? error.message : String(error) };
	}
}

async function saveUsageManagedState(state: UsageManagedState): Promise<void> {
	state.version = 1;
	state.updatedAt = new Date().toISOString();
	state.removedAccountIds = [...new Set(state.removedAccountIds)].sort();
	state.accounts = state.accounts
		.filter((account) => !state.removedAccountIds.includes(account.id))
		.sort((a, b) => a.label.localeCompare(b.label));
	await mkdir(dirname(getUsageStatePath()), { recursive: true });
	await writeFile(getUsageStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isQuotaActive(account: UsageManagedAccount): boolean {
	return typeof account.quotaExhaustedUntil === "number" && account.quotaExhaustedUntil > Date.now();
}

function getAccountStats(data: UsageData, account: UsageManagedAccount): ProviderStats | undefined {
	return data.allTime.providers.get(account.provider);
}

function getManagedAccounts(data: UsageData, state: UsageManagedState): UsageManagedAccount[] {
	const now = new Date().toISOString();
	const accounts = new Map<string, UsageManagedAccount>();
	for (const account of state.accounts) {
		if (!state.removedAccountIds.includes(account.id)) accounts.set(account.id, account);
	}
	for (const provider of data.allTime.providers.keys()) {
		if (state.removedAccountIds.includes(provider) || accounts.has(provider)) continue;
		accounts.set(provider, {
			id: provider,
			label: formatProviderName(provider),
			provider,
			source: "session",
			updatedAt: now,
		});
	}

	return Array.from(accounts.values()).sort((a, b) => {
		const manualId = state.manualAccountId;
		if (a.id === manualId && b.id !== manualId) return -1;
		if (b.id === manualId && a.id !== manualId) return 1;
		if (isQuotaActive(a) !== isQuotaActive(b)) return isQuotaActive(a) ? 1 : -1;
		const costDelta = (getAccountStats(data, b)?.cost ?? 0) - (getAccountStats(data, a)?.cost ?? 0);
		if (costDelta !== 0) return costDelta;
		return a.label.localeCompare(b.label);
	});
}

function getActiveManagedAccount(accounts: UsageManagedAccount[], state: UsageManagedState): UsageManagedAccount | undefined {
	const manual = accounts.find((account) => account.id === state.manualAccountId && !isQuotaActive(account));
	return manual ?? accounts.find((account) => !isQuotaActive(account));
}

function findManagedAccount(accounts: UsageManagedAccount[], query: string): UsageManagedAccount | undefined {
	const normalized = query.trim().toLowerCase();
	return accounts.find(
		(account) =>
			account.id.toLowerCase() === normalized ||
			account.provider.toLowerCase() === normalized ||
			account.label.toLowerCase() === normalized
	);
}

function formatManagedAccountLine(account: UsageManagedAccount, data: UsageData, state: UsageManagedState): string {
	const stats = getAccountStats(data, account);
	const tags = [
		state.manualAccountId === account.id ? "manual" : undefined,
		isQuotaActive(account) ? "quota" : undefined,
		account.source === "manual" ? "manual-entry" : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const suffix = tags ? ` (${tags})` : "";
	const cost = stats ? formatCost(stats.cost) : formatCost(0);
	const messages = stats ? formatNumber(stats.messages) : "0";
	const sessions = stats ? formatNumber(stats.sessions.size) : "0";
	return `${account.label}${suffix} · id=${account.id} · spend=${cost} · messages=${messages} · sessions=${sessions}`;
}

async function loadUsageManagedSummary(ctx: ExtensionCommandContext): Promise<UsageManagedSummary | null> {
	const data = await collectUsageData(ctx.signal);
	if (!data) {
		ctx.ui.notify("Usage data unavailable or cancelled.", "warning");
		return null;
	}
	const { state, error } = await readUsageManagedState();
	if (error) {
		ctx.ui.notify(`dm-usage state unreadable; using empty state: ${error}`, "warning");
	}
	return { data, state, accounts: getManagedAccounts(data, state) };
}

function managedAccountNoDataMessage(): string {
	return "No managed accounts found. Run /usage after at least one provider response, or use /usage use <provider-id> to create a local manual entry.";
}

async function activateUsageAccount(ctx: ExtensionCommandContext, summary: UsageManagedSummary, account: UsageManagedAccount): Promise<void> {
	summary.state.manualAccountId = account.id;
	summary.state.removedAccountIds = summary.state.removedAccountIds.filter((id) => id !== account.id);
	summary.state.accounts = summary.accounts.map((item) => (item.id === account.id ? { ...item, updatedAt: new Date().toISOString() } : item));
	await saveUsageManagedState(summary.state);
	ctx.ui.notify(`dm-usage: now using ${account.label} (${account.id})`, "info");
}

async function clearUsageManualAccount(ctx: ExtensionCommandContext, state: UsageManagedState): Promise<void> {
	const hadManual = Boolean(state.manualAccountId);
	state.manualAccountId = undefined;
	await saveUsageManagedState(state);
	ctx.ui.notify(`dm-usage: manual account ${hadManual ? "cleared" : "was not set"}`, "info");
}

async function removeUsageAccountState(ctx: ExtensionCommandContext, summary: UsageManagedSummary, account: UsageManagedAccount): Promise<void> {
	summary.state.removedAccountIds = [...summary.state.removedAccountIds, account.id];
	if (summary.state.manualAccountId === account.id) summary.state.manualAccountId = undefined;
	summary.state.accounts = summary.accounts.filter((item) => item.id !== account.id);
	await saveUsageManagedState(summary.state);
	ctx.ui.notify(`dm-usage: removed local managed-account state for ${account.label}; session data was not changed.`, "info");
}

async function runUsageUseSubcommand(ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const summary = await loadUsageManagedSummary(ctx);
	if (!summary) return;

	if (rest === "clear") {
		await clearUsageManualAccount(ctx, summary.state);
		return;
	}

	if (rest.startsWith("remove ")) {
		const account = findManagedAccount(summary.accounts, rest.slice("remove ".length));
		if (!account) {
			ctx.ui.notify(`Unknown managed account: ${rest.slice("remove ".length)}`, "warning");
			return;
		}
		await removeUsageAccountState(ctx, summary, account);
		return;
	}

	if (rest) {
		const account =
			findManagedAccount(summary.accounts, rest) ??
			({ id: rest, label: formatProviderName(rest), provider: rest, source: "manual", updatedAt: new Date().toISOString() } satisfies UsageManagedAccount);
		if (!summary.accounts.some((item) => item.id === account.id)) summary.accounts.push(account);
		await activateUsageAccount(ctx, summary, account);
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(summary.accounts.length ? summary.accounts.map((account) => formatManagedAccountLine(account, summary.data, summary.state)).join("\n") : managedAccountNoDataMessage(), summary.accounts.length ? "info" : "warning");
		return;
	}

	const options = [
		...summary.accounts.map((account) => formatManagedAccountLine(account, summary.data, summary.state)),
		"add manual account",
		"clear manual account",
	];
	const selected = await ctx.ui.select("DuckMind Usage Accounts", options);
	if (!selected) return;
	if (selected === "add manual account") {
		const id = (await ctx.ui.input("Managed account id (provider key, no secret)"))?.trim();
		if (!id) return;
		await runUsageUseSubcommand(ctx, id);
		return;
	}
	if (selected === "clear manual account") {
		await clearUsageManualAccount(ctx, summary.state);
		return;
	}

	const account = summary.accounts[options.indexOf(selected)];
	if (!account) return;
	const action = await ctx.ui.select("Account Action", ["activate", "remove local state", "cancel"]);
	if (action === "activate") await activateUsageAccount(ctx, summary, account);
	if (action === "remove local state") await removeUsageAccountState(ctx, summary, account);
}

async function runUsageShowSubcommand(ctx: ExtensionCommandContext): Promise<void> {
	const summary = await loadUsageManagedSummary(ctx);
	if (!summary) return;
	const active = getActiveManagedAccount(summary.accounts, summary.state);
	const hiddenCount = summary.state.removedAccountIds.length;
	const lines = [
		"DuckMind Usage managed account summary",
		`active: ${active ? `${active.label} (${active.id})` : "none"}`,
		`manual: ${summary.state.manualAccountId ?? "none"}`,
		`accounts: ${summary.accounts.length}${hiddenCount ? ` · hidden=${hiddenCount}` : ""}`,
		`all-time: spend=${formatCost(summary.data.allTime.totals.cost)} · messages=${formatNumber(summary.data.allTime.totals.messages)} · sessions=${formatNumber(summary.data.allTime.totals.sessions)} · tokens=${formatTokens(summary.data.allTime.totals.tokens.total)}`,
		"",
		...(summary.accounts.length
			? summary.accounts.map((account) => formatManagedAccountLine(account, summary.data, summary.state))
			: [managedAccountNoDataMessage()]),
	];
	if (ctx.hasUI) {
		await ctx.ui.select("DuckMind Usage Summary", lines);
	} else {
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

async function runUsageRotationSubcommand(ctx: ExtensionCommandContext): Promise<void> {
	const lines = [
		"Current policy: manual account first, then accounts without quota cooldown, then highest all-time local spend, then alphabetical fallback.",
		"dm-usage is observational: this state changes /usage account summaries only and does not route provider requests or store API secrets.",
		"Use /usage reset manual to clear manual selection, or /usage reset quota to clear quota cooldown markers.",
	];
	if (ctx.hasUI) {
		await ctx.ui.select("DuckMind Usage Rotation", lines);
	} else {
		ctx.ui.notify(lines.join(" "), "info");
	}
}

async function isDirectoryReadable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function isWritableDirectoryFor(filePath: string): Promise<boolean> {
	try {
		const directory = dirname(filePath);
		await mkdir(directory, { recursive: true });
		await access(directory, fsConstants.R_OK | fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

async function runUsageVerifySubcommand(ctx: ExtensionCommandContext): Promise<void> {
	const sessionsReadable = await isDirectoryReadable(getSessionsDir());
	const stateWritable = await isWritableDirectoryFor(getUsageStatePath());
	const settingsWritable = await isWritableDirectoryFor(getAgentSettingsPath());
	const stateRead = await readUsageManagedState();
	const summary = await loadUsageManagedSummary(ctx);
	const accounts = summary?.accounts.length ?? 0;
	const active = summary ? getActiveManagedAccount(summary.accounts, summary.state)?.id ?? "none" : "none";
	const ok = sessionsReadable && stateWritable && settingsWritable && !stateRead.error;
	const lines = [
		`verify: ${ok ? "PASS" : "WARN"}`,
		`sessions readable: ${sessionsReadable ? "yes" : "no"}`,
		`state directory writable: ${stateWritable ? "yes" : "no"}`,
		`settings directory writable: ${settingsWritable ? "yes" : "no"}`,
		`state json: ${stateRead.error ? `invalid (${stateRead.error})` : "ok"}`,
		`managed accounts: ${accounts}`,
		`active account: ${active}`,
	];
	if (ctx.hasUI) {
		await ctx.ui.select(`DuckMind Usage Verify (${ok ? "PASS" : "WARN"})`, lines);
	} else {
		ctx.ui.notify(lines.join("\n"), ok ? "info" : "warning");
	}
}

async function runUsagePathSubcommand(ctx: ExtensionCommandContext): Promise<void> {
	const lines = [
		`Session storage: ${getSessionsDir()}`,
		`Managed account state: ${getUsageStatePath()}`,
		`Agent settings: ${getAgentSettingsPath()}`,
	];
	if (ctx.hasUI) {
		await ctx.ui.select("DuckMind Usage Paths", lines);
	} else {
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

async function chooseUsageResetTarget(ctx: ExtensionCommandContext, argument: string): Promise<UsageResetTarget | undefined> {
	const explicitTarget = parseUsageResetTarget(argument.toLowerCase());
	if (explicitTarget) return explicitTarget;
	if (argument) {
		ctx.ui.notify("Unknown reset target. Use: /usage reset [manual|quota|all]", "warning");
		return undefined;
	}
	if (!ctx.hasUI) return "all";
	const selected = await ctx.ui.select("Reset DuckMind Usage State", [
		"manual - clear manual account override",
		"quota - clear quota cooldown markers",
		"all - clear manual override, quota cooldown markers, and hidden account state",
	]);
	if (!selected) return undefined;
	if (selected.startsWith("manual")) return "manual";
	if (selected.startsWith("quota")) return "quota";
	return "all";
}

async function runUsageResetSubcommand(ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const target = await chooseUsageResetTarget(ctx, rest);
	if (!target) return;
	const { state } = await readUsageManagedState();
	const hadManual = Boolean(state.manualAccountId);
	if (target === "manual" || target === "all") state.manualAccountId = undefined;
	let quotaCleared = 0;
	if (target === "quota" || target === "all") {
		state.accounts = state.accounts.map((account) => {
			if (account.quotaExhaustedUntil === undefined) return account;
			quotaCleared++;
			const { quotaExhaustedUntil: _quotaExhaustedUntil, ...restAccount } = account;
			return restAccount;
		});
	}
	const hiddenCleared = target === "all" ? state.removedAccountIds.length : 0;
	if (target === "all") state.removedAccountIds = [];
	await saveUsageManagedState(state);
	ctx.ui.notify(
		`reset: target=${target} manualCleared=${hadManual && !state.manualAccountId ? "yes" : "no"} quotaCleared=${quotaCleared} hiddenCleared=${hiddenCleared}`,
		"info"
	);
}

async function runUsageSubcommand(subcommand: UsageSubcommand, rest: string, ctx: ExtensionCommandContext): Promise<void> {
	if (subcommand === "use") return runUsageUseSubcommand(ctx, rest);
	if (subcommand === "show") return runUsageShowSubcommand(ctx);
	if (subcommand === "rotation") return runUsageRotationSubcommand(ctx);
	if (subcommand === "verify") return runUsageVerifySubcommand(ctx);
	if (subcommand === "path") return runUsagePathSubcommand(ctx);
	if (subcommand === "reset") return runUsageResetSubcommand(ctx, rest);
	ctx.ui.notify(USAGE_HELP_TEXT, "info");
}

// =============================================================================
// Insights
// =============================================================================

const PARALLEL_WINDOW_MS = 2 * 60_000; // exact ±N milliseconds around each message
const PARALLEL_SESSION_THRESHOLD = 4;
const LARGE_CONTEXT_THRESHOLD = 150_000;
const LARGE_CACHE_MISS_THRESHOLD = 100_000;
const LONG_SESSION_MS = 8 * 60 * 60 * 1000;
const TOP_SESSION_COUNT = 5;
const MIN_MESSAGES_FOR_PARALLEL_INSIGHT = 10;
const MIN_PERCENT_TO_SHOW = 1;

/**
 * Insights are weighted by recorded API cost. Periods with zero total cost produce
 * an empty `insights` list — the UI renders a distinct empty-state for that case.
 * Long-running-session classification is passed in from a global pass so that a
 * session's real lifetime is used rather than the slice visible inside this period.
 */
function computeInsights(raw: PeriodRawData, longSessionIds: Set<string>): PeriodInsights {
	if (raw.messages.length === 0) {
		return { insights: [] };
	}

	const total = raw.messages.reduce((sum, m) => sum + m.cost, 0);
	if (total <= 0) {
		return { insights: [] };
	}

	const candidates: Insight[] = [];

	// 1. Parallel sessions — ≥ N unique sessions active within an exact ±W ms window.
	const parallelWeight = computeParallelCostWeight(raw.messages);
	if (parallelWeight !== null) {
		candidates.push({
			percent: (parallelWeight / total) * 100,
			headline: `of your cost was while ${PARALLEL_SESSION_THRESHOLD}+ sessions ran in parallel`,
			advice:
				"All sessions share one rate limit. If you don't need them all at once, queueing uses capacity more evenly.",
		});
	}

	// 2. Large context — input + cacheRead + cacheWrite > threshold.
	const largeContextWeight = raw.messages
		.filter((m) => m.input + m.cacheRead + m.cacheWrite > LARGE_CONTEXT_THRESHOLD)
		.reduce((sum, m) => sum + m.cost, 0);
	candidates.push({
		percent: (largeContextWeight / total) * 100,
		headline: `of your cost was at >${formatThresholdTokens(LARGE_CONTEXT_THRESHOLD)} context`,
		advice:
			"Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.",
	});

	// 3. Large uncached prompt — fresh (non-cached) input > threshold, per the v0.2.0 formula.
	const uncachedWeight = raw.messages
		.filter((m) => m.input + m.cacheWrite > LARGE_CACHE_MISS_THRESHOLD)
		.reduce((sum, m) => sum + m.cost, 0);
	candidates.push({
		percent: (uncachedWeight / total) * 100,
		headline: `of your cost came from >${formatThresholdTokens(LARGE_CACHE_MISS_THRESHOLD)}-token uncached prompts`,
		advice:
			"Uncached input is expensive, and often happens when sending a message to a session that has gone idle. /compact before stepping away keeps the cold-start small.",
	});

	// 4. Long-running sessions — classification comes from the global pass so we use
	//    true session lifetime, not just the span visible inside this period slice.
	const longWeight = raw.messages
		.filter((m) => longSessionIds.has(m.sessionId))
		.reduce((sum, m) => sum + m.cost, 0);
	if (longWeight > 0) {
		candidates.push({
			percent: (longWeight / total) * 100,
			headline: `of your cost came from sessions active for ${LONG_SESSION_MS / 3_600_000}+ hours`,
			advice:
				"These are often background/loop sessions. Continuous usage can add up quickly so make sure it is intentional.",
		});
	}

	// 5. Top-N session concentration.
	if (raw.sessionCosts.size > TOP_SESSION_COUNT) {
		const sortedSessions = Array.from(raw.sessionCosts.values()).sort((a, b) => b - a);
		const topN = Math.min(TOP_SESSION_COUNT, sortedSessions.length);
		const topWeight = sortedSessions.slice(0, topN).reduce((sum, c) => sum + c, 0);
		candidates.push({
			percent: (topWeight / total) * 100,
			headline: `of your cost came from your top ${topN} session${topN === 1 ? "" : "s"}`,
			advice:
				"A small number of sessions drives most of your spend. The table view can help pinpoint which ones.",
		});
	}

	const insights = candidates.filter((i) => i.percent >= MIN_PERCENT_TO_SHOW).sort((a, b) => b.percent - a.percent);
	return { insights };
}

/**
 * Two-pointer sweep of messages sorted by timestamp. For each message, count the
 * number of distinct session IDs whose messages fall within an exact ± window.
 * Returns the total cost attributable to moments when ≥ threshold sessions were
 * active, or null if the period has too few sessions/messages to call it.
 *
 * Messages with missing/invalid timestamps (parsed as 0) are filtered out first —
 * otherwise they would collapse into a single synthetic instant and inflate the
 * parallel count on older or incomplete logs.
 */
function computeParallelCostWeight(messages: RawMessage[]): number | null {
	const timed = messages.filter((m) => m.timestamp > 0);
	if (timed.length < MIN_MESSAGES_FOR_PARALLEL_INSIGHT) return null;
	const distinctSessions = new Set(timed.map((m) => m.sessionId));
	if (distinctSessions.size < PARALLEL_SESSION_THRESHOLD) return null;

	const sorted = timed.slice().sort((a, b) => a.timestamp - b.timestamp);
	const sidCount = new Map<string, number>();
	let uniqueCount = 0;
	let left = 0;
	let right = 0;
	let parallelCost = 0;

	for (let i = 0; i < sorted.length; i++) {
		const current = sorted[i]!;
		const high = current.timestamp + PARALLEL_WINDOW_MS;
		const low = current.timestamp - PARALLEL_WINDOW_MS;

		while (right < sorted.length && sorted[right]!.timestamp <= high) {
			const sid = sorted[right]!.sessionId;
			const next = (sidCount.get(sid) ?? 0) + 1;
			sidCount.set(sid, next);
			if (next === 1) uniqueCount++;
			right++;
		}
		while (left < right && sorted[left]!.timestamp < low) {
			const sid = sorted[left]!.sessionId;
			const next = (sidCount.get(sid) ?? 0) - 1;
			if (next === 0) {
				sidCount.delete(sid);
				uniqueCount--;
			} else {
				sidCount.set(sid, next);
			}
			left++;
		}

		if (uniqueCount >= PARALLEL_SESSION_THRESHOLD) parallelCost += current.cost;
	}

	return parallelCost;
}

function formatThresholdTokens(n: number): string {
	if (n >= 1_000_000) return `${n / 1_000_000}M`;
	if (n >= 1_000) return `${n / 1_000}k`;
	return String(n);
}

function formatInsightPercent(p: number): string {
	if (p >= 10) return `${Math.round(p)}%`;
	return `${Math.round(p * 10) / 10}%`;
}

// =============================================================================
// Formatting Helpers
// =============================================================================

function formatCost(cost: number): string {
	if (cost === 0) return "-";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(2)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	if (cost < 100) return `$${cost.toFixed(1)}`;
	return `$${Math.round(cost)}`;
}

function formatTokens(count: number): string {
	if (count === 0) return "-";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatNumber(n: number): string {
	if (n === 0) return "-";
	return n.toLocaleString();
}

function padLeft(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return " ".repeat(len - vis) + s;
}

function padRight(s: string, len: number): string {
	const vis = visibleWidth(s);
	if (vis >= len) return s;
	return s + " ".repeat(len - vis);
}

function sumColumnWidths(columns: DataColumn[]): number {
	return columns.reduce((sum, col) => sum + col.width, 0);
}

function fitCell(s: string, len: number, align: "left" | "right" = "left"): string {
	if (len <= 0) return "";
	const truncated = truncateToWidth(s, len);
	return align === "right" ? padLeft(truncated, len) : padRight(truncated, len);
}

function clampLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
}

function pickFittingText(width: number, variants: string[]): string {
	for (const variant of variants) {
		if (visibleWidth(variant) <= width) return variant;
	}
	return variants[variants.length - 1] || "";
}

function getTableLayout(width: number): TableLayout {
	const safeWidth = Math.max(width, 0);

	for (const candidate of TABLE_LAYOUTS) {
		const columnsWidth = sumColumnWidths(candidate.columns);
		const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - columnsWidth, 0));
		if (nameWidth >= candidate.minNameWidth) {
			return {
				columns: candidate.columns,
				nameWidth,
				tableWidth: nameWidth + columnsWidth,
				compact: candidate.compact ?? false,
			};
		}
	}

	const fallback = TABLE_LAYOUTS[TABLE_LAYOUTS.length - 1]!;
	const fallbackColumnsWidth = sumColumnWidths(fallback.columns);
	const fallbackNameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(safeWidth - fallbackColumnsWidth, 0));
	return {
		columns: fallback.columns,
		nameWidth: fallbackNameWidth,
		tableWidth: fallbackNameWidth + fallbackColumnsWidth,
		compact: fallback.compact ?? false,
	};
}

// Visual shell inspired by robhowley/pi-userland packages/pi-openrouter
// overlay/chart helpers, kept local-session-only for dm-usage.
function renderPanel(title: string, rows: string[], width: number, theme: Theme): string[] {
	const safeWidth = Math.max(Math.floor(width), 0);
	if (safeWidth < 12) {
		return clampLines([theme.fg("accent", theme.bold(title)), ...rows, ""], safeWidth);
	}

	const innerWidth = Math.max(safeWidth - 2, 1);
	const titleText = ` ${title} `;
	const visibleTitle = truncateToWidth(titleText, Math.max(innerWidth - 1, 1), "");
	const titleWidth = visibleWidth(visibleTitle);
	const topRight = Math.max(innerWidth - titleWidth, 0);
	const top = `╭${visibleTitle}${"─".repeat(topRight)}╮`;
	const bottom = `╰${"─".repeat(innerWidth)}╯`;
	const body = rows.length > 0 ? rows : [theme.fg("dim", "No data")];

	return [
		theme.fg("border", top),
		...body.map((line) => panelRow(line, innerWidth, theme)),
		theme.fg("border", bottom),
		"",
	];
}

function panelRow(content: string, innerWidth: number, theme: Theme): string {
	const fitted = truncateToWidth(content, innerWidth);
	const padding = Math.max(innerWidth - visibleWidth(fitted), 0);
	return `${theme.fg("border", "│")}${fitted}${" ".repeat(padding)}${theme.fg("border", "│")}`;
}

function renderSpendSparkline(dailySpend: Map<string, number>, maxWidth: number): string {
	if (dailySpend.size === 0) return "No spend data";

	const sortedDays = Array.from(dailySpend.keys()).sort();
	const visibleDays = sortedDays.slice(-Math.max(1, Math.min(30, maxWidth)));
	const values = visibleDays.map((day) => dailySpend.get(day) ?? 0);
	const max = Math.max(...values);
	if (max <= 0) return "No spend";

	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	return values
		.map((value) => {
			const idx = Math.max(0, Math.min(blocks.length - 1, Math.ceil((value / max) * blocks.length) - 1));
			return blocks[idx];
		})
		.join("");
}

function formatDailyAverage(stats: TimeFilteredStats): string {
	const days = stats.dailySpend.size;
	if (days === 0) return "avg/day -";
	return `avg/day ${formatCost(stats.totals.cost / days)}`;
}

// =============================================================================
// Component
// =============================================================================

const TAB_LABELS: Record<TabName, string> = {
	today: "Today",
	thisWeek: "This Week",
	lastWeek: "Last Week",
	allTime: "All Time",
};

const TAB_ORDER: TabName[] = ["today", "thisWeek", "lastWeek", "allTime"];

class UsageComponent {
	private activeTab: TabName = "allTime";
	private viewMode: ViewMode = "table";
	private data: UsageData;
	private selectedIndex = 0;
	private expanded = new Set<string>();
	private providerOrder: string[] = [];
	private theme: Theme;
	private requestRender: () => void;
	private done: () => void;

	constructor(theme: Theme, data: UsageData, requestRender: () => void, done: () => void) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.data = data;
		this.updateProviderOrder();
	}

	private updateProviderOrder(): void {
		const stats = this.data[this.activeTab];
		this.providerOrder = Array.from(stats.providers.entries())
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(([name]) => name);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.providerOrder.length - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}

		if (matchesKey(data, "v")) {
			this.viewMode = this.viewMode === "table" ? "insights" : "table";
			this.requestRender();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.requestRender();
		} else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.activeTab = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]!;
			this.updateProviderOrder();
			this.requestRender();
		} else if (this.viewMode === "table" && matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && matchesKey(data, "down")) {
			if (this.selectedIndex < this.providerOrder.length - 1) {
				this.selectedIndex++;
				this.requestRender();
			}
		} else if (this.viewMode === "table" && (matchesKey(data, "enter") || matchesKey(data, "space"))) {
			const provider = this.providerOrder[this.selectedIndex];
			if (provider) {
				if (this.expanded.has(provider)) {
					this.expanded.delete(provider);
				} else {
					this.expanded.add(provider);
				}
				this.requestRender();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Render Methods
	// -------------------------------------------------------------------------

	render(width: number): string[] {
		if (this.viewMode === "insights") {
			return clampLines(
				[
					...this.renderTitle(width),
					...this.renderTabs(width, getTableLayout(width)),
					...this.renderSpendChart(width),
					...this.renderInsights(width),
					...this.renderHelp(width),
				],
				width
			);
		}

		const layout = getTableLayout(width);
		return clampLines(
			[
				...this.renderTitle(width),
				...this.renderTabs(width, layout),
				...this.renderHeader(layout),
				...this.renderRows(layout),
				...this.renderTotals(layout),
				...this.renderFormulaNote(width),
				...this.renderHelp(width),
			],
			width
		);
	}

	private renderTitle(width: number): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		const label = this.viewMode === "insights" ? "Usage Insights" : "Usage Statistics";
		return renderPanel(
			"DuckMind Usage",
			[
				`${th.fg("accent", th.bold(label))} · ${TAB_LABELS[this.activeTab]}`,
				`Spend ${formatCost(stats.totals.cost)} · ${formatNumber(stats.totals.messages)} messages · ${formatTokens(stats.totals.tokens.total)} tokens`,
				`Providers ${formatNumber(stats.providers.size)} · Sessions ${formatNumber(stats.totals.sessions)} · ${formatDailyAverage(stats)}`,
			],
			width,
			th
		);
	}

	private renderSpendChart(width: number): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		return renderPanel(
			"Daily Spend",
			[
				th.fg("accent", renderSpendSparkline(stats.dailySpend, Math.max(width - 4, 10))),
				th.fg("dim", "Local session spend, last 30 active UTC days"),
			],
			width,
			th
		);
	}

	private renderInsights(width: number): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		const { insights } = stats.insights;
		const hasMessages = stats.totals.messages > 0;
		const hasCost = stats.totals.cost > 0;
		const lines: string[] = [];

		lines.push("What's contributing to your cost?");
		lines.push(th.fg("dim", "Approximate, based on local sessions on this machine."));
		lines.push("");
		const note = `${TAB_LABELS[this.activeTab]} · weighted by cost (USD) · these overlap and can sum to >100%`;
		lines.push(th.fg("dim", note));
		lines.push("");

		if (!hasMessages) {
			lines.push(th.fg("dim", "  No usage recorded for this period."));
			lines.push("");
			return lines;
		}
		if (!hasCost) {
			lines.push(th.fg("dim", "  No cost data recorded for this period."));
			lines.push("");
			return lines;
		}
		if (insights.length === 0) {
			lines.push(th.fg("dim", "  No insights above 1% for this period."));
			lines.push("");
			return lines;
		}

		const indent = "     ";
		const adviceWidth = Math.max(width - indent.length, 30);

		for (const insight of insights) {
			const pct = th.fg("accent", th.bold(formatInsightPercent(insight.percent)));
			lines.push(`${pct} ${insight.headline}`);
			for (const wrapped of wrapTextWithAnsi(insight.advice, adviceWidth)) {
				lines.push(`${indent}${th.fg("dim", wrapped)}`);
			}
			lines.push("");
		}

		return lines;
	}

	private renderTabs(width: number, layout: TableLayout): string[] {
		const th = this.theme;
		const fullTabs = TAB_ORDER.map((tab) => {
			const label = TAB_LABELS[tab];
			return tab === this.activeTab ? th.fg("accent", `[${label}]`) : th.fg("dim", ` ${label} `);
		}).join("  ");

		const activeTabOnly = th.fg("accent", `[${TAB_LABELS[this.activeTab]}]`);
		const tabLine = pickFittingText(width, [
			fullTabs,
			`${activeTabOnly}  ${th.fg("dim", "[Tab/←→]")}`,
			activeTabOnly,
		]);

		// Compact-note only applies to the table view — it's meaningless for insights.
		const infoLines =
			this.viewMode === "table" && layout.compact
				? wrapTextWithAnsi(th.fg("dim", "Compact view. Widen the terminal for more columns."), Math.max(width, 1))
				: [];

		return [tabLine, ...infoLines, ""];
	}

	private renderHeader(layout: TableLayout): string[] {
		const th = this.theme;

		let headerLine = fitCell("Provider / Model", layout.nameWidth);
		for (const col of layout.columns) {
			const label = fitCell(col.label, col.width, "right");
			headerLine += col.dimmed ? th.fg("dim", label) : label;
		}

		return [th.fg("muted", headerLine), th.fg("border", "─".repeat(layout.tableWidth))];
	}

	private renderDataRow(
		name: string,
		stats: BaseStats & { sessions: Set<string> | number },
		layout: TableLayout,
		options: { indent?: number; selected?: boolean; dimAll?: boolean; prefix?: string } = {}
	): string {
		const th = this.theme;
		const { indent = 0, selected = false, dimAll = false, prefix } = options;

		const rawPrefix = prefix ?? " ".repeat(indent);
		const safePrefix = layout.nameWidth > 0 ? truncateToWidth(rawPrefix, layout.nameWidth, "") : "";
		const prefixWidth = visibleWidth(safePrefix);
		const innerNameWidth = Math.max(layout.nameWidth - prefixWidth, 0);
		const truncName = innerNameWidth > 0 ? truncateToWidth(name, innerNameWidth) : "";
		const styledName = selected ? th.fg("accent", truncName) : dimAll ? th.fg("dim", truncName) : truncName;

		let row = safePrefix + (innerNameWidth > 0 ? padRight(styledName, innerNameWidth) : "");

		for (const col of layout.columns) {
			const value = fitCell(col.getValue(stats), col.width, "right");
			const shouldDim = col.dimmed || dimAll;
			row += shouldDim ? th.fg("dim", value) : value;
		}

		return row;
	}

	private renderRows(layout: TableLayout): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];
		const lines: string[] = [];

		if (this.providerOrder.length === 0) {
			lines.push(th.fg("dim", "  No usage data for this period"));
			return lines;
		}

		for (let i = 0; i < this.providerOrder.length; i++) {
			const providerName = this.providerOrder[i]!;
			const providerStats = stats.providers.get(providerName)!;
			const isSelected = i === this.selectedIndex;
			const isExpanded = this.expanded.has(providerName);
			const arrow = isExpanded ? "▾" : "▸";
			const prefix = isSelected ? th.fg("accent", `${arrow} `) : th.fg("dim", `${arrow} `);

			lines.push(
				this.renderDataRow(formatProviderName(providerName), providerStats, layout, {
					selected: isSelected,
					prefix,
				})
			);

			if (isExpanded) {
				const models = Array.from(providerStats.models.entries()).sort((a, b) => b[1].cost - a[1].cost);

				for (const [modelName, modelStats] of models) {
					lines.push(this.renderDataRow(modelName, modelStats, layout, { indent: 4, dimAll: true }));
				}
			}
		}

		return lines;
	}

	private renderTotals(layout: TableLayout): string[] {
		const th = this.theme;
		const stats = this.data[this.activeTab];

		let totalRow = fitCell(th.bold("Total"), layout.nameWidth);
		for (const col of layout.columns) {
			const value = fitCell(col.getValue(stats.totals), col.width, "right");
			totalRow += col.dimmed ? th.fg("dim", value) : value;
		}

		return [th.fg("border", "─".repeat(layout.tableWidth)), totalRow, ""];
	}

	private renderFormulaNote(width: number): string[] {
		const line = pickFittingText(width, [
			"Tokens = Input + Output + CacheWrite  ·  ↑In = Input + CacheWrite  (as of 0.2.0)",
			"Tokens = In + Out + CacheWrite  ·  ↑In = In + CacheWrite  (v0.2.0+)",
			"Tokens & ↑In include CacheWrite (v0.2.0+)",
			"Incl. CacheWrite (v0.2.0+)",
		]);
		return [this.theme.fg("dim", line), ""];
	}

	private renderHelp(width: number): string[] {
		const variants =
			this.viewMode === "insights"
				? [
						"[Tab/←→] period  [v] table view  [q] close",
						"[Tab] period  [v] table  [q] close",
						"[v] table  [q] close",
						"[q] close",
				  ]
				: [
						"[Tab/←→] period  [↑↓] select  [Enter] expand  [v] insights  [q] close",
						"[Tab] period  [↑↓] select  [Enter] expand  [v] insights  [q] close",
						"[↑↓] select  [Enter] expand  [v] insights  [q] close",
						"[↑↓] select  [v] insights  [q] close",
						"[↑↓] select  [q] close",
						"[q] close",
				  ];
		const line = pickFittingText(width, variants);
		return [this.theme.fg("dim", line)];
	}

	invalidate(): void {}
	dispose(): void {}
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: `Show usage statistics dashboard and account tools: ${USAGE_SUBCOMMANDS.join(", ")}`,
		getArgumentCompletions: getUsageCommandCompletions,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseUsageCommandArgs(args);
			if (parsed.subcommand) {
				if (!isUsageSubcommand(parsed.subcommand)) {
					ctx.ui.notify(`Unknown /usage subcommand: ${parsed.subcommand}\n${USAGE_HELP_TEXT}`, "warning");
					return;
				}
				await runUsageSubcommand(parsed.subcommand, parsed.rest, ctx);
				return;
			}

			if (!ctx.hasUI) {
				await runUsageShowSubcommand(ctx);
				return;
			}

			const data = await ctx.ui.custom<UsageData | null>((tui, theme, _kb, done) => {
				const loader = new CancellableLoader(
					tui,
					(s: string) => theme.fg("accent", s),
					(s: string) => theme.fg("muted", s),
					"Loading Usage..."
				);
				let finished = false;
				const finish = (value: UsageData | null) => {
					if (finished) return;
					finished = true;
					loader.dispose();
					done(value);
				};

				loader.onAbort = () => finish(null);

				collectUsageData(loader.signal)
					.then(finish)
					.catch(() => finish(null));

				return loader;
			});

			if (!data) {
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
				container.addChild(new Spacer(1));

				const usage = new UsageComponent(theme, data, () => tui.requestRender(), () => done());

				return {
					render: (w: number) => {
						const borderLines = clampLines(container.render(w), w);
						const usageLines = usage.render(w);
						const bottomBorder = theme.fg("border", "─".repeat(w));
						return clampLines([...borderLines, ...usageLines, "", bottomBorder], w);
					},
					invalidate: () => container.invalidate(),
					handleInput: (input: string) => usage.handleInput(input),
					dispose: () => {},
				};
			});
		},
	});
}
