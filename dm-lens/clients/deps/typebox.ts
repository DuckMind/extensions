import { createRequire } from "node:module";
import { getDmHostModule } from "./dm-host-deps.js";

const fallbackRequire = createRequire(import.meta.url);
const typebox =
	getDmHostModule<typeof import("typebox")>("typebox") ??
	(fallbackRequire("typebox") as typeof import("typebox"));

export const Type = typebox.Type;
