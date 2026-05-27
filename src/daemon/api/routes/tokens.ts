// src/daemon/api/routes/tokens.ts
//
// POST /v1/tokens/mint — derive a stateless agent token from the current
// root token. The returned token is `${agent_id}.${HMAC_SHA256(root_token,
// agent_id) base64url}` and verifies on the next request against whatever
// root token the daemon is currently holding (see DaemonServer.handle).
//
// Authorization rules:
//   - root caller         → may mint any valid agent_id.
//   - non-root caller "X" → may only mint a child whose id starts with "X."
//                           (i.e. a strict sub-namespace of X). Minting "X"
//                           itself or any sibling like "Y" is rejected with
//                           `agent_id_namespace_violation`.
//
// The mint is stateless — no record of the child token is kept on the daemon.
// Revocation happens only at root-token rotation time (Task A13), which
// invalidates ALL derived tokens simultaneously.
//
// `getRootToken` is a closure rather than a captured string so the route picks
// up the CURRENT root token on every call, surviving any future
// replaceRootToken() hot-swap done by the rotate route.

import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { assertAgentIdValid } from "../../auth/agent-id.js";
import { getAuthContext } from "../../auth/auth-context.js";
import { rootTokenFingerprint } from "../../auth/root-token-fingerprint.js";
import { asObject, reqString } from "../validate.js";
import { writeDaemonAudit } from "../../audit.js";

export function registerTokens(server: DaemonServer, getRootToken: () => string): void {
  server.addRoute("POST", "/v1/tokens/mint", async (_req, raw) => {
    const ctx = getAuthContext();
    // The `unauthorized` early-throw intentionally has no audit because there
    // is no ALS context to identify the caller (matches the existing pattern
    // across the codebase).
    if (ctx === undefined) throw new ShuttleError("unauthorized", "Missing auth context.");
    const o = asObject(raw);
    const requested = reqString(o, "agent_id");
    try {
      // Validate charset + reserved-name rules BEFORE checking namespace so a
      // junk agent_id surfaces the more specific `agent_id_invalid` code.
      assertAgentIdValid(requested);
      if (!ctx.isRoot) {
        const requiredPrefix = `${ctx.agent_id}.`;
        // Must start with "${caller}." AND have at least one character after
        // the dot — minting `${caller}` itself (no trailing dot) or `${caller}.`
        // (empty suffix) both fail.
        if (!requested.startsWith(requiredPrefix) || requested.length === requiredPrefix.length) {
          throw new ShuttleError(
            "agent_id_namespace_violation",
            `Caller ${ctx.agent_id} cannot mint ${requested} — child id must start with "${requiredPrefix}".`,
          );
        }
      }
      const hmac = deriveHmac(getRootToken(), requested);
      const token = formatBearer(requested, hmac);
      await writeDaemonAudit({
        action: "tokens_mint",
        ok: true,
        parent_agent_id: ctx.agent_id,
        child_agent_id: requested,
        root_token_fp: rootTokenFingerprint(getRootToken()),
      });
      return { token, agent_id: requested };
    } catch (err) {
      await writeDaemonAudit({
        action: "tokens_mint",
        ok: false,
        parent_agent_id: ctx.agent_id,
        child_agent_id: requested,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        root_token_fp: rootTokenFingerprint(getRootToken()),
      });
      throw err;
    }
  });
}
