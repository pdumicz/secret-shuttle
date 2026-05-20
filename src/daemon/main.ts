// src/daemon/main.ts
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../shared/errors.js";
import { DaemonServer } from "./server.js";
import { DaemonServices } from "./services.js";
import { registerRoutes } from "./api/router.js";
import { writeSocketFile, removeSocketFile } from "./socket-file.js";
import { hasLegacyKeyFile } from "../vault/keychain.js";
import { writeDaemonAudit } from "./audit.js";
import { safeDaemonPath, scrubDaemonSecretsFromEnv } from "./safe-env.js";

async function main(): Promise<void> {
  if (process.getuid !== undefined && process.getuid() === 0) {
    process.stderr.write("Refusing to run as root.\n");
    process.exit(1);
  }
  process.umask(0o077);

  // Sanitize the environment: replace PATH with a known-safe allowlist and
  // strip dynamic-loader hijack vectors before any user-supplied code can run.
  process.env.PATH = safeDaemonPath();
  delete process.env.LD_PRELOAD;
  delete process.env.DYLD_INSERT_LIBRARIES;
  delete process.env.DYLD_LIBRARY_PATH;
  delete process.env.NODE_OPTIONS;

  if (await hasLegacyKeyFile()) {
    process.stderr.write("Refusing to start: legacy master-key.json exists.\n");
    process.exit(1);
  }

  const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? randomBytes(32).toString("base64url");
  // The token must never reach daemon-spawned children (templates, Chrome).
  scrubDaemonSecretsFromEnv();
  const services = new DaemonServices();
  // Tmp-dir crash-safety (spec §9): ensure 0700 owner-only dir exists, then
  // delete any leftover files from a prior abnormally-ended run, then start a
  // periodic sweep (30s interval, 60s max age) that .unref()s so it never
  // keeps the event loop alive.
  const { mkdirSync, statSync } = await import("node:fs");
  try {
    mkdirSync(services.tmpDir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort; the sweep handles a missing dir as a no-op
  }
  // Fail-closed: if the dir exists with the wrong mode (e.g. an attacker
  // pre-created a world-readable tmp dir), refuse to start.
  try {
    const mode = statSync(services.tmpDir).mode & 0o777;
    if (mode !== 0o700) {
      process.stderr.write(`Refusing to start: ${services.tmpDir} is mode ${mode.toString(8)}, expected 0700.\n`);
      process.exit(1);
    }
  } catch {
    // dir absent → fine; the next file create will recreate via the sweep no-op path
  }
  const { sweepTmpDir } = await import("./templates/sweep-tmp.js");
  await sweepTmpDir({ tmpDir: services.tmpDir, force: true });
  services.sweepTimer = setInterval(() => {
    void sweepTmpDir({ tmpDir: services.tmpDir, maxAgeMs: 60_000 });
  }, 30_000);
  services.sweepTimer.unref();
  const server = new DaemonServer({ token });
  let actualPort = 0;
  registerRoutes(server, services, () => actualPort);
  const { port } = await server.listen(0);
  actualPort = port;
  await writeSocketFile({ port, token, pid: process.pid });

  const shutdown = async () => {
    await writeDaemonAudit({ action: "lock", ok: true, message: "daemon shutdown" });
    services.lock.lock();
    if (services.sweepTimer !== null) {
      clearInterval(services.sweepTimer);
      services.sweepTimer = null;
    }
    await removeSocketFile();
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  if (err instanceof ShuttleError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`${err.message}\n`);
  }
  process.exit(1);
});
