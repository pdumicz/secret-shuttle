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
    return {
      daemon: true,
      unlocked,
      blind_mode: services.blind.current(),
      browser_started: services.browser !== null,
      proxy_active: services.cdpProxy !== null,
      vault: {
        envelope_present: await fileExists(paths.envelopePath),
        legacy_key_present: await fileExists(paths.keyPath),
      },
      policy_warnings: policyWarnings,
      version: 2,
    };
  });
}
