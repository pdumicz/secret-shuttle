import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { getAuthContext } from "../../auth/auth-context.js";

export function registerApprovals(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/approvals/poll", (_req, raw) => {
    const b = raw as { id?: string } | null;
    if (b === null || typeof b.id !== "string") throw new ShuttleError("bad_request", "id is required.");
    const g = services.approvals.get(b.id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    // Owner enforcement (A9): non-root callers can only poll grants they own.
    // Cross-owner poll returns the SAME code as truly-missing (existence
    // non-disclosure) — defeats foreign-id status probing.
    const ctx = getAuthContext();
    const isRoot = ctx?.isRoot === true;
    if (!isRoot && g.owner_agent_id !== ctx?.agent_id) {
      throw new ShuttleError("approval_not_found", "Unknown approval id.");
    }
    return { id: g.id, status: g.status, expires_at: g.expires_at };
  });
}
