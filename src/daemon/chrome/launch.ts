import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";
import { spawnChromePipe, type PipeTransport } from "./pipe-transport.js";
import { CdpClient } from "./cdp-client.js";

export interface ChromeSession {
  child: { kill(signal?: NodeJS.Signals): boolean };
  cdp: CdpClient;
  transport: PipeTransport;
}

export async function launchChrome(opts: { profile: string }): Promise<ChromeSession> {
  const chromePath = process.env.SECRET_SHUTTLE_CHROME_PATH ?? defaultChromePath();
  if (chromePath === null) {
    throw new ShuttleError("chrome_not_found", "Could not find Chrome. Set SECRET_SHUTTLE_CHROME_PATH on the daemon process to a trusted absolute path.");
  }
  const profileDir = path.join(os.homedir(), ".secret-shuttle", "browser-profiles", opts.profile);
  await mkdir(profileDir, { recursive: true });
  const { child, transport } = spawnChromePipe(chromePath, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  const cdp = new CdpClient(transport);
  await cdp.send("Browser.getVersion");
  return { child, cdp, transport };
}

function defaultChromePath(): string | null {
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES;
    return pf === undefined ? null : path.join(pf, "Google", "Chrome", "Application", "chrome.exe");
  }
  return "google-chrome";
}
