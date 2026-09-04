import { createRequire } from "node:module";
import { getDmHostModule } from "./dm-host-deps.js";

const fallbackRequire = createRequire(import.meta.url);
const yaml =
	getDmHostModule<typeof import("js-yaml")>("js-yaml") ??
	(fallbackRequire("js-yaml") as typeof import("js-yaml"));

export default yaml;
export const dump = yaml.dump;
export const load = yaml.load;
