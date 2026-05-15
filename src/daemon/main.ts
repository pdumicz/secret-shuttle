// src/daemon/main.ts
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../shared/errors.js";
import { DaemonServer } from "./server.js";
import { DaemonServices } from "./services.js";
import { registerRoutes } from "./api/router.js";
import { writeSocketFile, removeSocketFile } from "./socket-file.js";
import { hasLegacyKeyFile } from "../vault/keychain.js";

async function main(): Promise<void> {
  if (process.getuid !== undefined && process.getuid() === 0) {
    process.stderr.write("Refusing to run as root.\n");
    process.exit(1);
  }
  process.umask(0o077);

  if (await hasLegacyKeyFile()) {
    process.stderr.write("Refusing to start: legacy master-key.json exists.\n");
    process.exit(1);
  }

  const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? randomBytes(32).toString("base64url");
  const services = new DaemonServices();
  const server = new DaemonServer({ token });
  let actualPort = 0;
  registerRoutes(server, services, () => actualPort);
  const { port } = await server.listen(0);
  actualPort = port;
  await writeSocketFile({ port, token, pid: process.pid });

  const shutdown = async () => {
    services.lock.lock();
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
