import type { IncomingMessage } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";

interface RotateBody {
  ref?: string;
  kind?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerSecretsRotateRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/secrets/rotate", async (_req, body) => {
    services.lock.requireKey();
    const b = (body ?? {}) as RotateBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    try {
      // Public getSecret enforces the soft-delete invariant: rotating an
      // already-deleted ref is secret_not_found, which is correct.
      const oldRecord = await services.vault.getSecret(b.ref);
      const kind = typeof b.kind === "string" ? b.kind : "random_32_bytes";

      // Production-gated. ApprovalBinding.action gained "secrets_rotate" in A5.
      if (oldRecord.environment === "production") {
        const binding: ApprovalBinding = {
          action: "secrets_rotate",
          ref: b.ref,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: null,
          allowed_domains: oldRecord.allowed_domains,
        };
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
          ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      }

      // Generate the new secret via the shared Vault.generate() helper. Same
      // value-generation code path as /v1/secrets/generate — no duplication.
      const rotSuffix = `-rot-${Date.now().toString(36)}`;
      const newName = oldRecord.name + rotSuffix;
      const newRecord = await services.vault.generate({
        name: newName,
        environment: oldRecord.environment,
        source: oldRecord.source,
        kind,
        allowed_domains: oldRecord.allowed_domains,
        allowed_actions: oldRecord.allowed_actions,
        description: `Rotation of ${b.ref} on ${new Date().toISOString()}`,
      });

      await services.vault.markRotating(b.ref);

      await writeDaemonAudit({
        action: "secrets_rotate",
        ok: true,
        ref: b.ref,
        environment: oldRecord.environment,
      });

      return {
        rotation_started: true,
        old_ref: b.ref,
        new_ref: newRecord.ref,
        plan: [], // Empty in this release; destination synthesis from audit log is a follow-up.
        next_action: `Re-push the new secret to all destinations of ${b.ref}, then run: secret-shuttle secrets delete ${b.ref}`,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "secrets_rotate",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
      });
      throw err;
    }
  });
}
