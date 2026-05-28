// src/daemon/api/router.ts
import type { DaemonServer } from "../server.js";
import type { DaemonServices } from "../services.js";
import { registerUiRoutes } from "../approvals/ui-server.js";
import { registerSessionUiRoutes } from "../approvals/session-ui-server.js";
import { registerUnlock } from "./routes/unlock.js";
import { registerStatus } from "./routes/status.js";
import { registerBlind } from "./routes/blind.js";
import { registerSecrets } from "./routes/secrets.js";
import { registerSecretsDeleteRoute } from "./routes/secrets-delete.js";
import { registerSecretsRotateRoute } from "./routes/secrets-rotate.js";
import { registerInjectSubmit } from "./routes/inject-submit.js";
import { registerRevealCapture } from "./routes/reveal-capture.js";
import { registerApprovals } from "./routes/approvals.js";
import { registerApprovalsSessionRoutes } from "./routes/approvals-session.js";
import { registerBrowser } from "./routes/browser.js";
import { registerTemplates, registry as templateRegistry } from "./routes/templates.js";
import { validateDestinationDefiningParamsCoverage } from "../templates/destination-defining-params.js";
import { registerUnlockSession } from "./routes/unlock-session.js";
import { registerHealth } from "./routes/health.js";
import { registerRunResolveRoute } from "./routes/run-resolve.js";
import { registerInjectRenderRoute } from "./routes/inject-render.js";
import { registerSecretsImportRoute } from "./routes/secrets-import.js";
import { registerKeychainRoutes } from "./routes/keychain.js";
import { registerHubRoutes } from "../hub/hub-server.js";
import { registerBootstrapRoutes } from "./routes/bootstrap.js";
import { registerBootstrapCaptureUi } from "./routes/bootstrap-capture-ui.js";
import { registerTokens } from "./routes/tokens.js";
import { registerWhoami } from "./routes/whoami.js";
import { registerDaemonAdmin } from "./routes/daemon-admin.js";

export function registerRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  registerUiRoutes(server, {
    approvals: services.approvals,
    sessions: services.sessionStore,
    bootstrap: services.bootstrapStore,
  });
  registerSessionUiRoutes(server, services.sessionStore);
  registerHubRoutes(server, services.hubBroker);
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
  registerApprovalsSessionRoutes(server, services, daemonPortRef);
  registerBrowser(server, services);
  registerTemplates(server, services, daemonPortRef);
  // Burst 5 §2 (Task 2a.6): emit a startup warning for any shipped
  // template that lacks `sessionDefiningParams`. Provision-derived
  // sessions exclude such templates (fail-closed); the warning makes
  // the misconfiguration visible.
  validateDestinationDefiningParamsCoverage(templateRegistry);
  registerRunResolveRoute(server, services, daemonPortRef);
  registerInjectRenderRoute(server, services, daemonPortRef);
  registerSecretsImportRoute(server, services, daemonPortRef);
  registerKeychainRoutes(server, services);
  registerBootstrapRoutes(server, services, daemonPortRef);
  registerBootstrapCaptureUi(server, services);
  // /v1/tokens/mint reads the CURRENT root token on every call via a closure,
  // so a future replaceRootToken() hot-swap (Task A13) takes effect on the
  // next mint without re-registering the route.
  registerTokens(server, () => server.getRootToken());
  registerWhoami(server);
  registerDaemonAdmin(server, daemonPortRef);
}
