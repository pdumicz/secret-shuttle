import { ShuttleError } from "../../../shared/errors.js";
import { disableObservationDomains } from "../../chrome/internal-ops.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

interface StartBody { domain?: string; reason?: string; }

export function registerBlind(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/blind/start", async (_req, raw) => {
    const b = (raw ?? {}) as StartBody;
    if (typeof b.domain !== "string" || typeof b.reason !== "string") {
      throw new ShuttleError("bad_request", "domain and reason are required.");
    }
    const state = services.blind.start(b.domain, b.reason);
    // Best-effort: tell Chrome to stop emitting observation domains on all page
    // targets so pre-enabled subscriptions (Runtime.consoleAPICalled, etc.) stop
    // flowing even for events registered before this blind-start call.
    if (services.cdp !== null) {
      await disableObservationDomains(services.cdp).catch(() => undefined);
    }
    return {
      blind_mode: true,
      domain: state.domain,
      reason: state.reason,
      started_at: state.started_at,
    };
  });
  server.addRoute("POST", "/v1/blind/end", () => services.blind.end());
}
