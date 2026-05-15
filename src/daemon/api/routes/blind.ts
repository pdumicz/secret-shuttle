import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

interface StartBody { domain?: string; reason?: string; }

export function registerBlind(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/blind/start", (_req, raw) => {
    const b = (raw ?? {}) as StartBody;
    if (typeof b.domain !== "string" || typeof b.reason !== "string") {
      throw new ShuttleError("bad_request", "domain and reason are required.");
    }
    const state = services.blind.start(b.domain, b.reason);
    return {
      blind_mode: true,
      domain: state.domain,
      reason: state.reason,
      started_at: state.started_at,
    };
  });
  server.addRoute("POST", "/v1/blind/end", () => services.blind.end());
}
