import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";
import { assertSafeExecutable } from "../safe-executable.js";
import { readDaemonConfig } from "../config.js";
import { spawnChromePipe, type PipeTransport } from "./pipe-transport.js";
import { CdpClient } from "./cdp-client.js";

export interface ChromeSession {
  child: { kill(signal?: NodeJS.Signals): boolean };
  cdp: CdpClient;
  transport: PipeTransport;
}

const STARTUP_TIMEOUT_MS = 10_000;

// Requires at least one leading alphanumeric so that "." and ".." are rejected.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function launchChrome(opts: { profile: string }): Promise<ChromeSession> {
  // Profile validation FIRST — before any chrome-path resolution so tests
  // don't require Chrome to be installed.
  if (!PROFILE_RE.test(opts.profile)) {
    throw new ShuttleError(
      "invalid_profile",
      "Profile name must be 1-64 chars of [A-Za-z0-9._-] starting with an alphanumeric.",
    );
  }
  const profileRoot = path.join(os.homedir(), ".secret-shuttle", "browser-profiles");
  const profileDir = path.join(profileRoot, opts.profile);
  const resolvedProfile = path.resolve(profileDir);
  if (
    resolvedProfile !== path.join(path.resolve(profileRoot), opts.profile) ||
    !(resolvedProfile === path.resolve(profileRoot) || resolvedProfile.startsWith(`${path.resolve(profileRoot)}${path.sep}`))
  ) {
    throw new ShuttleError("invalid_profile", "Profile path escapes the Secret Shuttle profile root.");
  }

  // Chrome-path resolution after profile validation.
  const config = await readDaemonConfig();
  let chromePath: string;
  if (config?.chromePath !== undefined) {
    chromePath = await assertSafeExecutable(config.chromePath, {
      ...(config.chromeSha256 !== undefined ? { expectedSha256: config.chromeSha256 } : {}),
    });
  } else {
    const def = defaultChromePath();
    if (def === null) {
      throw new ShuttleError(
        "chrome_not_found",
        "Could not find Chrome. Create ~/.secret-shuttle/daemon.config.json with {\"version\":1,\"chromePath\":\"/abs/path\"}.",
      );
    }
    // The platform default path is a well-known system location; still realpath + sanity check it.
    chromePath = await assertSafeExecutable(def).catch(() => def);
  }

  await mkdir(resolvedProfile, { recursive: true });
  const { child, transport } = spawnChromePipe(chromePath, [
    `--user-data-dir=${resolvedProfile}`,
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
