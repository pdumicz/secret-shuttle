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
 * Default behavior: spawn the platform system opener (`open` on macOS,
 * `xdg-open` on Linux, `cmd /c start` on Windows) so the URL opens in a
 * browser tab automatically. This is required for the standard daemon
 * flow because `secret-shuttle daemon start` launches the daemon with
 * `stdio: ignore` (see src/daemon/lifecycle.ts) — any stderr fallback
 * would vanish to /dev/null and users would have no way to approve or
 * unlock.
 *
 * The legacy kill-switch `SECRET_SHUTTLE_NO_OPEN_URL=1` is honored — it
 * makes openUrl a complete no-op. The `npm test` wrapper sets it so the
 * test suite never opens real browser tabs.
 *
 * Plan 4 ships a single-window tab-reuse flow to eliminate the tab-spam
 * vector (one tab per approval/unlock) without breaking the spawn-by-
 * default contract this function depends on.
 */
export function openUrl(url: string, opts?: { spawnImpl?: SpawnFn }): void {
  // Kill switch — completely silent. Used by `npm test` so the suite
  // doesn't pop browser tabs on every approval flow under test.
  if (process.env.SECRET_SHUTTLE_NO_OPEN_URL === "1") {
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
