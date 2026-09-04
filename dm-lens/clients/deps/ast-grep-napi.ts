import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDmHostModule, getDmHostModulePath } from "./dm-host-deps.js";

export type * from "@ast-grep/napi";
export type AstGrepNapi = typeof import("@ast-grep/napi");

const fallbackRequire = createRequire(import.meta.url);

export function loadAstGrepNapi(): Promise<AstGrepNapi> {
	const bundled = getDmHostModule<AstGrepNapi>("@ast-grep/napi");
	if (bundled) return Promise.resolve(bundled);
	const bundledPath = getDmHostModulePath("@ast-grep/napi");
	if (bundledPath) return import(pathToFileURL(bundledPath).href) as Promise<AstGrepNapi>;
	try {
		return import(pathToFileURL(fallbackRequire.resolve("@ast-grep/napi")).href) as Promise<AstGrepNapi>;
	} catch {
		return import("@ast-grep/napi");
	}
}
