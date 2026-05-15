import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";
import { readDaemonConfig } from "../config.js";
import { spawnChromePipe, type PipeTransport } from "./pipe-transport.js";
import { CdpClient } from "./cdp-client.js";

export interface ChromeSession {
  child: { kill(signal?: NodeJS.Signals): boolean };
  cdp: CdpClient;
  transport: PipeTransport;
}

const STARTUP_TIMEOUT_MS = 10_000;

export async function launchChrome(opts: { profile: string }): Promise<ChromeSession> {
  const config = await readDaemonConfig();
  const chromePath = config?.chromePath ?? defaultChromePath();
  if (chromePath === null) {
    throw new ShuttleError(
      "chrome_not_found",
      "Could not find Chrome. Either install Chrome at its default location or write " +
        '{"version":1,"chromePath":"/abs/path/to/Chrome"} into ~/.secret-shuttle/daemon.config.json.',
    );
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
  try {
    await Promise.race([
      cdp.send("Browser.getVersion"),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new ShuttleError(
                "chrome_startup_timeout",
                `Chrome did not respond within ${STARTUP_TIMEOUT_MS}ms.`,
              ),
            ),
          STARTUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    try {
      child.kill();
    } catch {
      // best-effort
    }
    throw err;
  }
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
