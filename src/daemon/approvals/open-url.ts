import { spawn, type SpawnOptions } from "node:child_process";
import { buildChildEnv } from "../safe-env.js";

interface SpawnedChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChild;

export function openUrl(url: string, opts?: { spawnImpl?: SpawnFn }): void {
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
