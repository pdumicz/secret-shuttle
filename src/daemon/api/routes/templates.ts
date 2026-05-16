import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { resolveBinary } from "../../templates/resolve-binary.js";
import { runTemplate } from "../../templates/run.js";
import { TemplateRegistry } from "../../templates/registry.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { ShuttleError } from "../../../shared/errors.js";

const registry = new TemplateRegistry();

interface RunBody {
  template_id: string;
  ref: string;
  params?: Record<string, string>;
  approval_id?: string;
  wait_for_approval?: boolean;
}

export function registerTemplates(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/templates/list", () => ({
    templates: registry.list().map((t) => ({
      id: t.id,
      description: t.description,
      required_params: t.required_params,
      requires_approval_when_production: t.requires_approval_when_production,
    })),
  }));

  server.addRoute("POST", "/v1/templates/run", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as RunBody;
    try {
      const tpl = registry.get(b.template_id);
      const secret = await services.vault.getSecret(b.ref);

      // Validate template params before creating the approval grant so a human
      // is never prompted for a structurally invalid request.
      tpl.validateParams?.(b.params ?? {});

      // Compute the effective environment BEFORE binary resolution so the
      // approval gate fires first — even when the secret is development-classed
      // but the template destination is production (e.g. vercel-env-add with
      // environment=production).  The approval_required error must surface before
      // an unsafe_binary_path error when both conditions hold.
      const destEnv = tpl.destinationEnvironment?.(b.params ?? {});
      const effectiveEnv =
        secret.environment === "production" || destEnv === "production"
          ? "production"
          : secret.environment;

      // When no pre-issued approval is supplied, run the approval gate BEFORE
      // binary resolution so approval_required fires ahead of unsafe_binary_path.
      // For non-production this call synthesizes a grant instantly (no prompt).
      if (b.approval_id === undefined) {
        await requireApproval({
          store: services.approvals,
          binding: {
            action: "template",
            ref: secret.ref,
            environment: effectiveEnv,
            destination_domain: null,
            target_id: null,
            field_fingerprint: null,
            template_id: tpl.id,
            template_params: b.params ?? {},
            template_binary_path: null,
            template_binary_sha256: null,
          },
          daemonPort: daemonPortRef(),
          ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      }

      // Resolve and hash the binary BEFORE running so the run-time binding
      // (consumed for pre-issued approvals) includes the exact content fingerprint.
      const absolute = await resolveBinary(tpl.binary);
      const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");

      const binding: ApprovalBinding = {
        action: "template",
        ref: secret.ref,
        environment: effectiveEnv,
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: tpl.id,
        template_params: b.params ?? {},
        template_binary_path: absolute,
        template_binary_sha256: sha256,
      };
      // Consume the pre-issued approval (with full binary details) when the
      // caller supplied an approval_id.
      if (b.approval_id !== undefined) {
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          approvalIdFromClient: b.approval_id,
          ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      }

      const result = await runTemplate({
        template: { ...tpl, binary: absolute },
        params: b.params ?? {},
        secret: secret.value,
        expectedSha256: sha256,
      });
      await services.vault.markUsed(secret.ref);
      await writeDaemonAudit({
        action: "template_run",
        ok: result.exit_code === 0,
        ref: secret.ref,
        environment: secret.environment,
        template_id: tpl.id,
      });
      return {
        executed: result.exit_code === 0,
        template_id: result.template_id,
        secret_ref: secret.ref,
        binary_path: absolute,
        binary_sha256: sha256,
        exit_code: result.exit_code,
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "template_run",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
        ...(b.template_id !== undefined ? { template_id: b.template_id } : {}),
      });
      throw err;
    }
  });
}
