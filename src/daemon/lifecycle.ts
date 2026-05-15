// src/daemon/lifecycle.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError } from "../shared/errors.js";
import { readSocketFile, removeSocketFile, type SocketFile } from "./socket-file.js";
import { hasLegacyKeyFile } from "../vault/keychain.js";
import { buildDaemonEnv } from "./safe-env.js";

export async function startDaemon(): Promise<SocketFile> {
  if (await hasLegacyKeyFile()) {
    throw new ShuttleError(
      "legacy_key_present",
      "Refusing to start: ~/.secret-shuttle/master-key.json exists. Run `secret-shuttle migrate secure-vault` first.",
    );
  }

  const existing = await readSocketFile();
  if (existing !== null && pidAlive(existing.pid)) {
    return existing;
  }
  await removeSocketFile();

  const daemonScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "main.js",
  );

  const cleanEnv = buildDaemonEnv();
  cleanEnv.SECRET_SHUTTLE_DAEMON_TOKEN = randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: cleanEnv,
  });
  child.unref();

  return waitForSocket(15_000);
}

export async function stopDaemon(): Promise<void> {
  const sf = await readSocketFile();
  if (sf === null) return;
  try {
    process.kill(sf.pid, "SIGTERM");
  } catch {
    // ignore — process already gone
  }
  await removeSocketFile();
}

export async function getDaemonStatus(): Promise<
  | { running: false }
  | { running: true; port: number; pid: number; unlocked?: boolean }
> {
  const sf = await readSocketFile();
  if (sf === null || !pidAlive(sf.pid)) {
    return { running: false };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${sf.port}/v1/status`, {
      headers: { Authorization: `Bearer ${sf.token}` },
    });
    if (!res.ok) return { running: true, port: sf.port, pid: sf.pid };
    const body = (await res.json()) as { unlocked?: boolean };
    return { running: true, port: sf.port, pid: sf.pid, unlocked: body.unlocked === true };
  } catch {
    return { running: true, port: sf.port, pid: sf.pid };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForSocket(timeoutMs: number): Promise<SocketFile> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sf = await readSocketFile();
    if (sf !== null) return sf;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new ShuttleError("daemon_start_timeout", "Daemon did not start in time.");
}
