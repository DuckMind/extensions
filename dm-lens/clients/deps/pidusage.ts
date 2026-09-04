import { createRequire } from "node:module";
import { getDmHostModule } from "./dm-host-deps.js";

const fallbackRequire = createRequire(import.meta.url);
const pidusageModule =
	getDmHostModule<typeof import("pidusage")>("pidusage") ??
	(fallbackRequire("pidusage") as typeof import("pidusage"));

export default pidusageModule;
