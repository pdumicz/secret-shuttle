import { createHash } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";

const AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export function assertAgentIdValid(id: string): void {
  if (!AGENT_ID_RE.test(id) || id === "root") {
    throw new ShuttleError(
      "agent_id_invalid",
      `agent_id ${JSON.stringify(id)} is invalid (must match ${AGENT_ID_RE}, and "root" is reserved).`,
    );
  }
}

export function deriveAutoAgentId(runtime: string, machineId: string): string {
  const digest = createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;
}
