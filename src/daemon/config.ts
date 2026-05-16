import { readFile } from "node:fs/promises";
import { fileExists, getShuttlePaths } from "../shared/config.js";
import { ShuttleError } from "../shared/errors.js";

export interface DaemonConfig {
  version: 1;
  chromePath?: string;
  chromeSha256?: string;
}

export async function readDaemonConfig(): Promise<DaemonConfig | null> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.daemonConfigPath))) return null;
  const raw = await readFile(paths.daemonConfigPath, "utf8");
  const parsed = JSON.parse(raw) as DaemonConfig;
  if (parsed.version !== 1) {
    throw new ShuttleError("unsupported_daemon_config", "daemon.config.json version must be 1.");
  }
  if (parsed.chromePath !== undefined && typeof parsed.chromePath !== "string") {
    throw new ShuttleError("unsupported_daemon_config", "chromePath must be a string.");
  }
  if (parsed.chromeSha256 !== undefined && typeof parsed.chromeSha256 !== "string") {
    throw new ShuttleError("unsupported_daemon_config", "chromeSha256 must be a string.");
  }
  return parsed;
}
