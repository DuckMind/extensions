import { createRequire } from "node:module";
import { getDmHostModule } from "./dm-host-deps.js";

export type { MinimatchOptions } from "minimatch";
export type Minimatch = import("minimatch").Minimatch;

const fallbackRequire = createRequire(import.meta.url);
const minimatchModule =
	getDmHostModule<typeof import("minimatch")>("minimatch") ??
	(fallbackRequire("minimatch") as typeof import("minimatch"));

export const minimatch = minimatchModule.minimatch;
export const Minimatch = minimatchModule.Minimatch;
