// src/daemon/api/router.ts
import type { DaemonServer } from "../server.js";
import type { DaemonServices } from "../services.js";
import { registerUiRoutes } from "../approvals/ui-server.js";
import { registerUnlock } from "./routes/unlock.js";
import { registerStatus } from "./routes/status.js";
import { registerBlind } from "./routes/blind.js";
import { registerSecrets } from "./routes/secrets.js";
import { registerSecretsDeleteRoute } from "./routes/secrets-delete.js";
import { registerSecretsRotateRoute } from "./routes/secrets-rotate.js";
import { registerInjectSubmit } from "./routes/inject-submit.js";
import { registerRevealCapture } from "./routes/reveal-capture.js";
import { registerApprovals } from "./routes/approvals.js";
import { registerBrowser } from "./routes/browser.js";
import { registerTemplates } from "./routes/templates.js";
import { registerUnlockSession } from "./routes/unlock-session.js";
import { registerHealth } from "./routes/health.js";
import { registerRunResolveRoute } from "./routes/run-resolve.js";
import { registerInjectRenderRoute } from "./routes/inject-render.js";

export function registerRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  registerUiRoutes(server, services.approvals);
  registerStatus(server, services);
  registerHealth(server, services);
  registerUnlock(server, services);
  registerUnlockSession(server, services, daemonPortRef);
  registerBlind(server, services, daemonPortRef);
  registerSecrets(server, services, daemonPortRef);
  registerSecretsDeleteRoute(server, services, daemonPortRef);
  registerSecretsRotateRoute(server, services, daemonPortRef);
  registerInjectSubmit(server, services, daemonPortRef);
  registerRevealCapture(server, services, daemonPortRef);
  registerApprovals(server, services);
  registerBrowser(server, services);
  registerTemplates(server, services, daemonPortRef);
  registerRunResolveRoute(server, services, daemonPortRef);
  registerInjectRenderRoute(server, services, daemonPortRef);
}
