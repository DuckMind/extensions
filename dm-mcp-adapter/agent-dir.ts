import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getConfigDirName(): string {
  const configDir = readDmConfig()?.configDir;
  return typeof configDir === "string" && configDir.trim() ? configDir.trim() : ".dm";
}

export function getAgentDir(): string {
  const piConfig = readDmConfig();
  const name = piConfig?.name;
  const appName = typeof name === "string" && name.trim() ? name.trim() : "dm";
  const configured = process.env[`${appName.toUpperCase()}_CODING_AGENT_DIR`]?.trim()
    ?? (appName === "dm" ? process.env.PI_CODING_AGENT_DIR?.trim() : undefined);
  if (!configured) {
    return join(homedir(), getConfigDirName(), "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

/**
 * What the host calls itself.
 *
 * DM reads `dmConfig` from its own package manifest and uses `DM_PACKAGE_DIR`
 * when supplied. `piConfig` and `PI_PACKAGE_DIR` are read only as compatibility
 * fallbacks for an already installed legacy host; no runtime dependency on an
 * upstream product package is required.
 */
function readDmConfig(): { name?: unknown; configDir?: unknown; clientUri?: unknown } | undefined {
  const dir = process.env.DM_PACKAGE_DIR?.trim() ?? process.env.PI_PACKAGE_DIR?.trim()
  if (!dir) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(resolve(dir), "package.json"), "utf8")) as {
      dmConfig?: { name?: unknown; configDir?: unknown; clientUri?: unknown }
      piConfig?: { name?: unknown; configDir?: unknown; clientUri?: unknown }
    }
    return manifest.dmConfig ?? manifest.piConfig
  } catch {
    return undefined
  }
}

export function getAppName(): string {
  const name = readDmConfig()?.name
  return typeof name === "string" && name.trim() ? name.trim() : "dm"
}

/**
 * Home page the host declares through `dmConfig.clientUri`. The legacy
 * `piConfig` field is read only as a compatibility fallback, so DM does not
 * guess a product URL.
 */
export function getAppClientUri(): string | undefined {
  const uri = readDmConfig()?.clientUri
  return typeof uri === "string" && uri.trim() ? uri.trim() : undefined
}
