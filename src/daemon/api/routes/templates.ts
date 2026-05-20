import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { resolveBinary } from "../../templates/resolve-binary.js";
import { runTemplate } from "../../templates/run.js";
import { TemplateRegistry, assertNoPaddedParams } from "../../templates/registry.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { ShuttleError } from "../../../shared/errors.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";

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
    // Hoisted so the catch block can include them in the failure audit record.
    let effectiveEnv: string | undefined;
    let destEnv: string | undefined;
    try {
      const tpl = registry.get(b.template_id);
      const secret = await services.vault.getSecret(b.ref);
      assertSecretActionAllowed(secret, "use_as_stdin");

      // Reject padded params before everything else — before validateParams,
      // before destinationEnvironment, before the approval binding is built.
      // Padding creates a raw-vs-trimmed divergence that can bypass the
      // production-approval check (see assertNoPaddedParams in registry.ts).
      assertNoPaddedParams(b.params ?? {});

      // Validate template params before creating the approval grant so a human
      // is never prompted for a structurally invalid request.
      tpl.validateParams?.(b.params ?? {});

      // Compute the effective environment BEFORE binary resolution so the
      // approval gate fires first — even when the secret is development-classed
      // but the template destination is production (e.g. vercel-env-add with
      // environment=production).  The approval_required error must surface before
      // an unsafe_binary_path error when both conditions hold.
      destEnv = tpl.destinationEnvironment?.(b.params ?? {});
      effectiveEnv =
        secret.environment === "production" || destEnv === "production"
          ? "production"
          : secret.environment;

      // Resolve and hash the binary — capture failure instead of throwing so
      // the approval gate can still run first (preserving approval_required
      // before unsafe_binary_path ordering).  This is a read-only filesystem
      // operation; doing it before the gate is safe and required so the human
      // sees the real binary path and hash in the approval UI.
      let absolute: string | null = null;
      let sha256: string | null = null;
      let resolveErr: unknown = null;
      try {
        absolute = await resolveBinary(tpl.binary);
        sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
      } catch (e) {
        resolveErr = e;
      }

      // Build ONE binding carrying the resolved binary details (real values when
      // resolution succeeded, null when it failed).  Using one binding for both
      // grant creation and consumption ensures bindingsMatch always passes on
      // retry — no self-mismatch.
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

      // Single requireApproval call — handles both the initial (no approval_id)
      // and the retry (approval_id supplied) paths.
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Now that the human has approved, surface any binary resolution failure.
      // The request fails closed: approval was already gated, nothing executed.
      if (resolveErr !== null) throw resolveErr;

      const result = await runTemplate({
        template: { ...tpl, binary: absolute as string },
        params: b.params ?? {},
        secret: secret.value,
        expectedSha256: sha256 as string,
        tmpDir: services.tmpDir,
      });
      await services.vault.markUsed(secret.ref);
      await writeDaemonAudit({
        action: "template_run",
        ok: result.exit_code === 0,
        ref: secret.ref,
        environment: effectiveEnv,
        ...(destEnv !== undefined ? { destination_environment: destEnv } : {}),
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
        ...(effectiveEnv !== undefined ? { environment: effectiveEnv } : {}),
        ...(destEnv !== undefined ? { destination_environment: destEnv } : {}),
        ...(b.template_id !== undefined ? { template_id: b.template_id } : {}),
      });
      throw err;
    }
  });
}
