// src/daemon/api/routes/daemon-admin.ts
//
// Root-only daemon administration routes (Task A13):
//
//   POST /v1/daemon/rotate
//     Atomically regenerate <SHUTTLE_HOME>/root-token, rewrite the daemon
//     socket file with the new token + the daemon's current port + pid, then
//     hot-swap the in-memory token via DaemonServer.replaceRootToken().
//     Effect: all previously-derived agent tokens (formatBearer(agentId,
//     HMAC(OLD_ROOT, agentId))) fail verification against the new key on
//     their next request — instant cluster-wide revocation. The response
//     does NOT echo the new token; clients pick it up by re-reading the
//     socket file (matches the existing resolveDaemonToken flow).
//
//   POST /v1/daemon/reset-machine-id
//     Delete <SHUTTLE_HOME>/machine-id so the next `secret-shuttle init`
//     run re-derives a different per-runtime agent_id. Does NOT invalidate
//     any existing tokens — the HMAC chain depends on the root token, not
//     on the machine-id. The success message says this explicitly so an
//     operator who mistakenly believed `reset-machine-id` was a revocation
//     primitive gets corrected at runtime.
//
// Both routes require a root-token bearer (ctx.isRoot === true). A valid
// derived agent token is rejected with `unauthorized` — this is an
// authorization failure, not authentication (auth context exists; the agent
// just isn't allowed to run admin commands).

import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import { getAuthContext } from "../../auth/auth-context.js";
import { rootTokenFingerprint } from "../../auth/root-token-fingerprint.js";
import { rotateRootToken } from "../../root-token.js";
import { resetMachineId } from "../../machine-id.js";
import { writeSocketFile } from "../../socket-file.js";
import { writeDaemonAudit } from "../../audit.js";
import { getShuttlePaths } from "../../../shared/config.js";

export function registerDaemonAdmin(server: DaemonServer, daemonPortRef: () => number): void {
  // Per-server-instance gate that serializes /v1/daemon/rotate. Closed over
  // by the route handler below. Rotate mutates file + socket + in-memory
  // token state in sequence; two concurrent rotates would interleave those
  // writes and could leave them three-way divergent. Defense-in-depth
  // complements the per-call random temp path in rotateRootToken (so even
  // if a stale crash-recovery or test artifact wrote root-token.tmp, the
  // live rotate's temp file would not collide).
  let rotateInProgress = false;

  server.addRoute("POST", "/v1/daemon/rotate", async () => {
    const ctx = getAuthContext();
    if (ctx?.isRoot !== true) {
      // Record the rejected attempt with the caller's actual agent_id so the
      // audit log answers "who tried to rotate" — not just "rotate failed".
      await writeDaemonAudit({
        action: "daemon_rotate",
        ok: false,
        actor_agent_id: ctx?.agent_id ?? "unknown",
        error_code: "unauthorized",
      });
      throw new ShuttleError("unauthorized", "daemon rotate is root-only.");
    }
    // Fail-fast on concurrent rotates. Matches the pattern used by
    // bootstrap_batch_busy / bootstrap_browser_busy — simpler than
    // queueing, and clearer for callers (the second rotate is almost
    // always a duplicate operator click rather than a meaningful retry).
    if (rotateInProgress) {
      await writeDaemonAudit({
        action: "daemon_rotate",
        ok: false,
        actor_agent_id: "root",
        error_code: "daemon_rotate_in_progress",
      });
      throw new ShuttleError(
        "daemon_rotate_in_progress",
        "Another daemon-rotate operation is in progress. Retry after it completes.",
      );
    }
    rotateInProgress = true;

    // Capture the OLD root-token fingerprint BEFORE any mutation so we can
    // record it on BOTH the success and failure audit rows (forensics: lets
    // audit-log readers chain `tokens_mint` rows minted under this generation
    // to the rotate event that retired them).
    const oldFp = rootTokenFingerprint(server.getRootToken());
    try {
      const paths = getShuttlePaths();
      const newToken = await rotateRootToken(paths.homeDir);
      await writeSocketFile({ port: daemonPortRef(), token: newToken, pid: process.pid });
      server.replaceRootToken(newToken);
      const newFp = rootTokenFingerprint(newToken);
      await writeDaemonAudit({
        action: "daemon_rotate",
        ok: true,
        actor_agent_id: "root",
        root_token_fp_prev: oldFp,
        root_token_fp: newFp,
      });
      return {
        ok: true,
        message: "Root token rotated. Re-run `secret-shuttle init` to re-issue per-agent tokens.",
      };
    } catch (err) {
      // We're past the isRoot guard, so actor_agent_id is "root" by construction.
      // root_token_fp_prev is always known (captured before the try). We do NOT
      // stamp root_token_fp on the failure row because the swap may have failed
      // partway through and the "current" token state is ambiguous.
      await writeDaemonAudit({
        action: "daemon_rotate",
        ok: false,
        actor_agent_id: "root",
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        root_token_fp_prev: oldFp,
      });
      throw err;
    } finally {
      // Always release — both success and failure paths must clear the gate
      // so subsequent rotates can proceed.
      rotateInProgress = false;
    }
  });

  server.addRoute("POST", "/v1/daemon/reset-machine-id", async () => {
    const ctx = getAuthContext();
    if (ctx?.isRoot !== true) {
      // Record the rejected attempt with the caller's actual agent_id so the
      // audit log answers "who tried to reset-machine-id".
      await writeDaemonAudit({
        action: "daemon_reset_machine_id",
        ok: false,
        actor_agent_id: ctx?.agent_id ?? "unknown",
        error_code: "unauthorized",
      });
      throw new ShuttleError("unauthorized", "daemon reset-machine-id is root-only.");
    }
    try {
      const paths = getShuttlePaths();
      await resetMachineId(paths.homeDir);
      // reset-machine-id does NOT mutate the root token. Stamping the current
      // (unchanged) fingerprint here keeps the audit row shape consistent with
      // tokens_mint / daemon_rotate and lets audit readers visually confirm
      // the root WAS NOT rotated by this action.
      await writeDaemonAudit({
        action: "daemon_reset_machine_id",
        ok: true,
        actor_agent_id: "root",
        root_token_fp: rootTokenFingerprint(server.getRootToken()),
      });
      return {
        ok: true,
        message:
          "machine-id reset. Re-run `secret-shuttle init` to re-derive per-runtime agent_ids. NOTE: this does NOT revoke existing tokens — use `secret-shuttle daemon rotate` for revocation.",
      };
    } catch (err) {
      // We're past the isRoot guard, so actor_agent_id is "root" by construction.
      // The root token is not mutated by this route, so the fingerprint is
      // unambiguous on failure (same as it was on entry).
      await writeDaemonAudit({
        action: "daemon_reset_machine_id",
        ok: false,
        actor_agent_id: "root",
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        root_token_fp: rootTokenFingerprint(server.getRootToken()),
      });
      throw err;
    }
  });
}
