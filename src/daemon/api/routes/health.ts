import { fileExists, getShuttlePaths } from "../../../shared/config.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerHealth(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("GET", "/v1/health", async () => {
    const paths = getShuttlePaths();
    const unlocked = services.lock.isUnlocked();
    let policyWarnings: string[] | null = null;
    if (unlocked) {
      const secrets = await services.vault.list();
      policyWarnings = secrets
        .filter((s) => s.environment === "production" && s.allowed_domains.length === 0)
        .map((s) => `${s.ref} is production but has no allowed domains (not injectable; re-create with --allow-domain)`);
    }
    const browserStarted = services.browser !== null;
    const proxyActive = services.cdpProxy !== null;
    // After Phases 1-3, this daemon build always supports inject-submit/reveal-capture
    // handles. Encoded as a literal so consumers can branch on capability.
    const handlesSupported = true;
    const marksActive = services.handles.list().length;
    return {
      daemon: true,
      unlocked,
      blind_mode: services.blind.current(),
      browser_started: browserStarted,
      proxy_active: proxyActive,
      vault: {
        envelope_present: await fileExists(paths.envelopePath),
        legacy_key_present: await fileExists(paths.keyPath),
      },
      policy_warnings: policyWarnings,
      agentic_browser: {
        available: browserStarted && proxyActive && handlesSupported,
        browser_started: browserStarted,
        proxy_active: proxyActive,
        handles_supported: handlesSupported,
        marks_active: marksActive,
      },
      version: 2,
    };
  });
}
