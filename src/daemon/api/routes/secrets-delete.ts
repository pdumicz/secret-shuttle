import type { IncomingMessage } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";

interface DeleteBody {
  ref?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
  session_id?: string;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerSecretsDeleteRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/secrets/delete", async (_req, body) => {
    services.lock.requireKey();
    const b = (body ?? {}) as DeleteBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    // Hoisted OUTSIDE the try so the catch-block audit can carry session_id
    // when applicable. secrets_delete is NOT a SessionAction — destructive
    // ops are always human-gated — so the matcher refuses and requireApproval
    // falls back to single-use; grant.session_id is therefore always
    // undefined and the conditional spread evaluates to nothing. We still
    // wire the spread to preserve a single audit shape across all routes.
    let grant: ApprovalGrant | undefined;
    try {
      // Use the public getSecret() — it throws secret_not_found for both
      // missing AND already-soft-deleted refs (per the invariant). This
      // doubles as our existence check + production-or-not branch input.
      const record = await services.vault.getSecret(b.ref);

      // Production-gated.
      if (record.environment === "production") {
        const binding: ApprovalBinding = {
          action: "secrets_delete",
          ref: b.ref,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: null,
          allowed_domains: record.allowed_domains,
        };
        grant = await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          ...(b.session_id !== undefined ? { sessionId: b.session_id } : {}),
          ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
          ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      }

      const result = await services.vault.softDelete(b.ref);
      await writeDaemonAudit({
        action: "secrets_delete",
        ok: true,
        ref: result.ref,
        environment: record.environment,
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      return { deleted: true, ref: result.ref, deleted_at: result.deleted_at };
    } catch (err) {
      await writeDaemonAudit({
        action: "secrets_delete",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      throw err;
    }
  });
}
