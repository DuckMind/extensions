/**
 * Project rules scanner for dm-lens.
 *
 * Scans for rule files that other tools/agents may have left:
 * - .claude/rules/   — Claude Code rule files
 * - .agents/rules/   — Generic agent rule files
 * - .cursorrules     — Cursor IDE rules
 * - CLAUDE.md        — Claude Code project context
 * - AGENTS.md        — Generic agent context
 *
 * session_start logs the count and the project snapshot caches the result.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface ProjectRule {
	source: string; // ".claude/rules", ".agents/rules", "root"
	name: string; // filename or display name
	filePath: string; // absolute path
	relativePath: string; // relative to cwd
}

export interface RuleScanResult {
	rules: ProjectRule[];
	hasCustomRules: boolean;
}

const RULE_DIRS = [
	{ dir: ".claude/rules", source: ".claude/rules" },
	{ dir: ".agents/rules", source: ".agents/rules" },
];

const RULE_FILES = [
	{ file: "CLAUDE.md", source: "root" },
	{ file: "AGENTS.md", source: "root" },
	{ file: ".cursorrules", source: "root" },
];

// #250/#747 class: this walk is scoped to `.claude/rules`/`.agents/rules`
// subtrees, so it never walks the whole cwd — but it's still unbounded
// recursion. A small depth/file cap guards a pathologically deep or huge rules
// directory (or a symlink loop) without needing the full home ceiling the
// project-wide walkers use. Rules trees are shallow and small in practice, so
// these bounds never trim a legitimate layout.
const RULES_SCAN_MAX_DEPTH = 8;
const RULES_SCAN_MAX_FILES = 500;

function findMarkdownFiles(
	dir: string,
	baseDir: string,
	depth = 0,
	collected: { count: number } = { count: 0 },
): ProjectRule[] {
	const results: ProjectRule[] = [];

	if (depth > RULES_SCAN_MAX_DEPTH) return results;
	if (!fs.existsSync(dir)) return results;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (collected.count >= RULES_SCAN_MAX_FILES) break;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(
				...findMarkdownFiles(fullPath, baseDir, depth + 1, collected),
			);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			collected.count += 1;
			results.push({
				source: path.relative(baseDir, dir) || path.basename(baseDir),
				name: entry.name,
				filePath: fullPath,
				relativePath: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
			});
		}
	}
	return results;
}

export function scanProjectRules(cwd: string): RuleScanResult {
	const rules: ProjectRule[] = [];

	// Scan rule directories
	for (const { dir, source } of RULE_DIRS) {
		const dirPath = path.join(cwd, dir);
		if (fs.existsSync(dirPath)) {
			const found = findMarkdownFiles(dirPath, path.join(cwd, dir));
			for (const rule of found) {
				rules.push({
					source,
					name: rule.name,
					filePath: rule.filePath,
					relativePath: `${dir}/${rule.relativePath}`,
				});
			}
		}
	}

	// Check for root-level rule files
	for (const { file, source } of RULE_FILES) {
		const filePath = path.join(cwd, file);
		if (fs.existsSync(filePath)) {
			rules.push({
				source,
				name: file,
				filePath,
				relativePath: file,
			});
		}
	}

	return {
		rules,
		hasCustomRules: rules.length > 0,
	};
}
