import { createHash } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";

const AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * IDs reserved by the daemon itself — cannot be claimed by an agent token.
 *
 * - "root": the privileged admin identity.
 * - "daemon": the no-ALS sentinel returned by getCurrentAgentId() when the
 *   request is processed outside withAuthContext (see auth-context.ts). If
 *   "daemon" were allowed as an agent id, a privileged actor could mint a
 *   "daemon"-named token whose auto-matched sessions would collide with the
 *   sentinel in code paths that defensively exclude "daemon" (the /v1/health
 *   active_sessions filter, the require-approvals auto-match guard).
 *   Reserving it closes the conflation between authenticated-as-daemon and
 *   no-auth-context-fallback.
 */
const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(["root", "daemon"]);

export function assertAgentIdValid(id: string): void {
  if (!AGENT_ID_RE.test(id) || RESERVED_AGENT_IDS.has(id)) {
    throw new ShuttleError(
      "agent_id_invalid",
      `agent_id ${JSON.stringify(id)} is invalid (must match ${AGENT_ID_RE}; "root" and "daemon" are reserved).`,
    );
  }
}

export function deriveAutoAgentId(runtime: string, machineId: string): string {
  const digest = createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;
}
