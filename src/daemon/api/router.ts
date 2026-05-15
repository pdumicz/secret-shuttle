// src/daemon/api/router.ts
import type { DaemonServer } from "../server.js";
import type { DaemonServices } from "../services.js";
import { registerUiRoutes } from "../approvals/ui-server.js";
import { registerUnlock } from "./routes/unlock.js";
import { registerStatus } from "./routes/status.js";
import { registerBlind } from "./routes/blind.js";
import { registerSecrets } from "./routes/secrets.js";
import { registerApprovals } from "./routes/approvals.js";

export function registerRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  registerUiRoutes(server, services.approvals);
  registerStatus(server, services);
  registerUnlock(server, services);
  registerBlind(server, services);
  registerSecrets(server, services, daemonPortRef);
  registerApprovals(server, services);
}
