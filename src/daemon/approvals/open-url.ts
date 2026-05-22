import { spawn, type SpawnOptions } from "node:child_process";
import { buildChildEnv } from "../safe-env.js";

interface SpawnedChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChild;

/**
 * Surface a URL the human must interact with (approval, unlock, etc.).
 *
 * Default behavior (as of 2026-05-22): print the URL to stderr. The previous
 * "spawn `open <url>` for every call" default was unusable in practice —
 * it accumulated browser tabs without bound (one per approval, one per
 * unlock, one per paste, …). Plan 4 ships a proper single-window tab-reuse
 * flow; until then, printing is the safe default.
 *
 * Set `SECRET_SHUTTLE_OPEN_URL=1` to opt back into the legacy auto-open
 * spawn path. The legacy kill-switch `SECRET_SHUTTLE_NO_OPEN_URL=1` is
 * still honored — it makes openUrl a complete no-op (useful for fully
 * silent test runs).
 */
export function openUrl(url: string, opts?: { spawnImpl?: SpawnFn }): void {
  // Hard mute (legacy kill switch) — completely silent. Used by `npm test`.
  if (process.env.SECRET_SHUTTLE_NO_OPEN_URL === "1") {
    return;
  }
  // Default: print, don't spawn. Opt-in to the legacy auto-open via
  // SECRET_SHUTTLE_OPEN_URL=1.
  if (process.env.SECRET_SHUTTLE_OPEN_URL !== "1") {
    process.stderr.write(`[approval] open this URL to respond: ${url}\n`);
    return;
  }
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  const doSpawn: SpawnFn =
    opts?.spawnImpl ?? ((command, cmdArgs, options) => spawn(command, cmdArgs, options));
  const child = doSpawn(cmd, args, { stdio: "ignore", detached: true, env: buildChildEnv() });
  child.on("error", () => undefined);
  child.unref();
}
