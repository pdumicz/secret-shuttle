import { spawn } from "node:child_process";

export function openUrl(url: string): void {
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
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}
