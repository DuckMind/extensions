/**
 * Literal text an ast-grep rule cannot match without (#4496).
 *
 * Most native `findAll` calls in a project scan go to rules that match
 * nothing, and each call pays rule compilation before it reads the tree. A
 * rule part that must match a node contributes the literals that node's text
 * must contain, and a node's text is a slice of the file. So a file missing
 * one of those literals cannot match, and the evaluator skips the call.
 *
 * Only parts that must match contribute: `pattern` words, plain-literal
 * `regex`, `has`/`inside`/`follows`/`precedes`, `all`, `any` (one branch),
 * and `matches` through the rule's own `utils`. `not`, `kind`, object
 * patterns and anything unrecognized contribute nothing, so the rule runs.
 */

import type { YamlRule, YamlRuleCondition } from "./yaml-rule-parser.js";

/** `true`: no literal is required. A string must appear in the text. */
type Requirement =
	| true
	| string
	| { and: Requirement[] }
	| { or: Requirement[] };
type Utils = YamlRule["utils"];

// Identifier-shaped words; `$`-prefixed ones are metavariables.
const PATTERN_WORD = /\$?[A-Za-z_]\w*/g;
// A regex with no metacharacter other than leading `^`, trailing `$` and `\.`.
const LITERAL_REGEX = /^\^?((?:[A-Za-z0-9_"'`:\- =!<>/@#%&,;~]|\\\.)+)\$?$/;
const RELATIONAL_KEYS = ["has", "inside", "follows", "precedes"] as const;

/** Literals the node's own text must contain. YAML shapes are unchecked. */
function ownLiterals(node: YamlRuleCondition): string[] {
	const literals: string[] = [];
	if (typeof node.pattern === "string") {
		for (const word of node.pattern.match(PATTERN_WORD) ?? []) {
			if (!word.startsWith("$")) literals.push(word);
		}
	}
	const regex = typeof node.regex === "string" ? node.regex : "";
	const literal = LITERAL_REGEX.exec(regex)?.[1];
	if (literal) literals.push(literal.replaceAll(String.raw`\.`, "."));
	return literals;
}

function anyOf(branches: Requirement[]): Requirement {
	if (branches.length === 0 || branches.includes(true)) return true;
	return { or: branches };
}

function requirementOf(
	node: YamlRuleCondition | undefined,
	utils: Utils,
	resolving: ReadonlySet<string>,
): Requirement {
	if (!node || typeof node !== "object") return true;
	const of = (child: YamlRuleCondition | undefined) =>
		requirementOf(child, utils, resolving);
	const parts: Requirement[] = [
		...ownLiterals(node),
		...RELATIONAL_KEYS.map((key) => of(node[key])),
		...(Array.isArray(node.all) ? node.all.map(of) : []),
		Array.isArray(node.any) ? anyOf(node.any.map(of)) : true,
	];
	const name = node.matches;
	if (
		typeof name === "string" &&
		utils != null &&
		Object.hasOwn(utils, name) &&
		!resolving.has(name)
	) {
		parts.push(
			requirementOf(utils[name], utils, new Set([...resolving, name])),
		);
	}
	const required = parts.filter((part) => part !== true);
	return required.length === 0 ? true : { and: required };
}

function satisfied(requirement: Requirement, text: string): boolean {
	if (requirement === true) return true;
	if (typeof requirement === "string") return text.includes(requirement);
	if ("and" in requirement) {
		return requirement.and.every((part) => satisfied(part, text));
	}
	return requirement.or.some((part) => satisfied(part, text));
}

// Keyed by the loaders' cached rule objects, so entries die with the cache.
const requirements = new WeakMap<YamlRule, Requirement>();

/** False only when `text` lacks a literal every match of `rule` needs. */
export function ruleCanMatchText(rule: YamlRule, text: string): boolean {
	let requirement = requirements.get(rule);
	if (requirement === undefined) {
		requirement = requirementOf(rule.rule, rule.utils, new Set());
		requirements.set(rule, requirement);
	}
	return satisfied(requirement, text);
}
