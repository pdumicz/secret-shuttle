// src/daemon/api/routes/whoami.ts
//
// GET /v1/whoami — return the caller's identity as resolved by the bearer-token
// parser. The route handler runs inside withAuthContext (see DaemonServer.handle),
// so the AuthContext is always present here — but we still guard with a
// defensive check so any misregistration outside the bearer-gate is rejected
// with `unauthorized` rather than crashing on an undefined ALS read.
//
// Returned shape: { agent_id, is_root }. The DaemonServer wrapper splices
// `ok: true` into the response automatically (see server.ts dispatchHandler).
//
// Used by A12 tests to prove that a freshly-minted agent token resolves to
// the expected agent_id on the next request — i.e. that the HMAC derivation
// in /v1/tokens/mint matches the server-side check in DaemonServer.handle.

import type { DaemonServer } from "../../server.js";
import { getAuthContext } from "../../auth/auth-context.js";
import { ShuttleError } from "../../../shared/errors.js";

export function registerWhoami(server: DaemonServer): void {
  server.addRoute("GET", "/v1/whoami", () => {
    const ctx = getAuthContext();
    if (ctx === undefined) throw new ShuttleError("unauthorized", "Missing auth context.");
    return { agent_id: ctx.agent_id, is_root: ctx.isRoot };
  });
}
