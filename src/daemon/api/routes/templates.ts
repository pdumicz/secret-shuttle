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

      // Resolve and hash the binary BEFORE creating the approval grant so the
      // human sees exactly which file will run and its content fingerprint.
      const absolute = await resolveBinary(tpl.binary);
      const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");

      const binding: ApprovalBinding = {
        action: "template",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: tpl.id,
        template_params: b.params ?? {},
        template_binary_path: absolute,
        template_binary_sha256: sha256,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

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
