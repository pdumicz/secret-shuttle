import { createHmac } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import { assertAgentIdValid } from "./agent-id.js";

/**
 * Compute the HMAC for an agent token.
 *
 * Validates that the supplied root_token decodes to exactly 32 bytes; rejects
 * with root_token_malformed otherwise (prevents accidental misuse with a
 * short/long key that would silently still produce an HMAC).
 */
export function deriveHmac(rootTokenB64url: string, agentId: string): string {
  const key = Buffer.from(rootTokenB64url, "base64url");
  if (key.byteLength !== 32) {
    throw new ShuttleError(
      "root_token_malformed",
      `root_token must be a base64url-no-pad 32-byte value (decoded ${key.byteLength} bytes).`,
    );
  }
  return createHmac("sha256", key).update(agentId).digest("base64url");
}

export function formatBearer(agentId: string, hmacB64url: string): string {
  return `${agentId}.${hmacB64url}`;
}

export type ParsedBearer =
  | { kind: "root"; token: string }
  | { kind: "agent"; agentId: string; hmac: string };

/**
 * Parse the value of an `Authorization: Bearer <X>` header (with the "Bearer "
 * prefix already stripped) into either a root-token candidate (no dots) or an
 * agent token (split on the LAST dot — agent_id may contain dots for hierarchy).
 *
 * Reject reserved agent_id "root" and any malformed agent_id with
 * agent_token_invalid (a separate code from agent_id_invalid because the
 * caller supplied a malformed BEARER, not a malformed mint-time id).
 */
export function parseBearer(bearer: string): ParsedBearer {
  const lastDot = bearer.lastIndexOf(".");
  if (lastDot === -1) {
    return { kind: "root", token: bearer };
  }
  const agentId = bearer.slice(0, lastDot);
  const hmac = bearer.slice(lastDot + 1);
  if (agentId === "root") {
    throw new ShuttleError("agent_token_invalid", "agent_id 'root' is reserved");
  }
  try {
    assertAgentIdValid(agentId);
  } catch {
    throw new ShuttleError("agent_token_invalid", "bearer contains a malformed agent_id");
  }
  return { kind: "agent", agentId, hmac };
}
