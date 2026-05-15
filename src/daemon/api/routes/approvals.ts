import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerApprovals(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/approvals/poll", (_req, raw) => {
    const b = raw as { id?: string } | null;
    if (b === null || typeof b.id !== "string") throw new ShuttleError("bad_request", "id is required.");
    const g = services.approvals.get(b.id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    return { id: g.id, status: g.status, expires_at: g.expires_at };
  });
}
