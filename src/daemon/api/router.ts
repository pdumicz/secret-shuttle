// src/daemon/api/router.ts
import type { DaemonServer } from "../server.js";
import type { DaemonServices } from "../services.js";
import { registerUiRoutes } from "../approvals/ui-server.js";
import { registerUnlock } from "./routes/unlock.js";
import { registerStatus } from "./routes/status.js";

export function registerRoutes(
  server: DaemonServer,
  services: DaemonServices,
  _daemonPortRef: () => number,
): void {
  registerUiRoutes(server, services.approvals);
  registerStatus(server, services);
  registerUnlock(server, services);
}
