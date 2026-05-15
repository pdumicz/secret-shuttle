import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { resolveBinary } from "../../templates/resolve-binary.js";
import { runTemplate } from "../../templates/run.js";
import { TemplateRegistry } from "../../templates/registry.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

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
    const tpl = registry.get(b.template_id);
    const secret = await services.vault.getSecret(b.ref);

    const binding: ApprovalBinding = {
      action: "template",
      ref: secret.ref,
      environment: secret.environment,
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: tpl.id,
      template_params: b.params ?? {},
    };
    await requireApproval({
      store: services.approvals,
      binding,
      daemonPort: daemonPortRef(),
      ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
      ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
    });

    const absolute = await resolveBinary(tpl.binary);
    const result = await runTemplate({
      template: { ...tpl, binary: absolute },
      params: b.params ?? {},
      secret: secret.value,
    });
    await services.vault.markUsed(secret.ref);
    return {
      executed: result.exit_code === 0,
      template_id: result.template_id,
      secret_ref: secret.ref,
      exit_code: result.exit_code,
      value_visible_to_agent: false,
    };
  });
}
