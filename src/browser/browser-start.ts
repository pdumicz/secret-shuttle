import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

export interface BrowserStartOptions {
  port: number;
  profile: string;
  chromePath?: string;
}

export interface BrowserStartResult {
  started: true;
  cdp_url: string;
  profile_dir: string;
  pid: number | null;
}

export async function startControlledBrowser(options: BrowserStartOptions): Promise<BrowserStartResult> {
  const chromePath = options.chromePath ?? defaultChromePath();
  if (chromePath === null) {
    throw new ShuttleError(
      "chrome_not_found",
      "Could not find Chrome. Pass --chrome-path or start Chrome manually with --remote-debugging-port.",
    );
  }

  const profileDir = path.join(os.homedir(), ".secret-shuttle", "browser-profiles", options.profile);
  await mkdir(profileDir, { recursive: true });

  const child = spawn(chromePath, [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    started: true,
    cdp_url: `http://127.0.0.1:${options.port}`,
    profile_dir: profileDir,
    pid: child.pid ?? null,
  };
}

function defaultChromePath(): string | null {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES;
    if (programFiles !== undefined) {
      return path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe");
    }
    return null;
  }

  return "google-chrome";
}
