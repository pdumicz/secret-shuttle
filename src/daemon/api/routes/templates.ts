import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requireApprovals } from "../../approvals/require-approvals.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { resolveBinary } from "../../templates/resolve-binary.js";
import { runTemplate } from "../../templates/run.js";
import { TemplateRegistry, assertNoPaddedParams } from "../../templates/registry.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { ShuttleError } from "../../../shared/errors.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { asObject, optApprovalIds, optBool, optString, optStringRecord, reqString } from "../validate.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import {
  assertBootstrapAuthorityValid,
  type BootstrapAuthority,
} from "../../bootstrap/authority.js";

/**
 * Module-scoped registry instance.  Exported for tests that need to register
 * a stub template (e.g. one whose binary is process.execPath so the binary
 * resolves on the test machine).  All routes share this single instance.
 */
export const registry = new TemplateRegistry();

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

    // Validate request body shape before everything else.  These throws fire
    // outside the try/audit block — matching the inject-submit / reveal-capture
    // pattern, where client-side malformed bodies (bad_request) do not write
    // template_run audit records.  The previous `raw as RunBody` cast could
    // surface a non-string params value as a downstream 500 (e.g. .trim() on
    // a number inside validateParams).
    const o = asObject(raw);
    const templateId = reqString(o, "template_id");
    const ref = reqString(o, "ref");
    const params = optStringRecord(o, "params") ?? {};
    const approvalIds = optApprovalIds(o);
    const waitForApproval = optBool(o, "wait_for_approval");
    const sessionId = optString(o, "session_id");

    // SECURITY: HTTP shell constructs opts WITHOUT propagating any
    // `bootstrap_authority` field. Authority is server-internal only.
    const input: RunTemplateInput = { templateId, ref, params };
    const opts: RunTemplateOpts = {
      ...(approvalIds !== undefined ? { approvalIds } : {}),
      ...(waitForApproval !== undefined ? { waitForApproval } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    return await runTemplateCore(services, daemonPortRef, input, opts);
  });
}

/** Inputs for {@link runTemplateCore}. */
export interface RunTemplateInput {
  templateId: string;
  ref: string;
  params: Record<string, string>;
}

/** Optional opts for {@link runTemplateCore}. */
export interface RunTemplateOpts {
  approvalIds?: string[];
  sessionId?: string;
  waitForApproval?: boolean;
  /**
   * Server-internal: when set, the inner requireApprovals call is replaced
   * with a BootstrapStore validation check. NEVER accepted from HTTP body.
   */
  bootstrapAuthority?: BootstrapAuthority;
}

/** Return shape from {@link runTemplateCore}. Mirrors the route response. */
export interface RunTemplateResult {
  executed: boolean;
  template_id: string;
  secret_ref: string;
  binary_path: string | null;
  binary_sha256: string | null;
  exit_code: number;
  value_visible_to_agent: false;
}

/**
 * Core of the /v1/templates/run route. Exposed so the bootstrap executor
 * (Plan 5g) can push secrets to destinations under a single human-approved
 * bootstrap authority.
 *
 * Behavior preservation: when called WITHOUT `opts.bootstrapAuthority`, this
 * function is equivalent to the previous inline route handler. Same binding,
 * same requireApprovals call, same audit, same return shape.
 *
 * Authority bypass: when called WITH a valid `opts.bootstrapAuthority`, the
 * inner requireApprovals call is replaced with a BootstrapStore validation.
 * Binary resolution still happens (the executor needs the binary present),
 * and runTemplate still executes; audit emits without session_id.
 */
export async function runTemplateCore(
  services: DaemonServices,
  daemonPortRef: () => number,
  input: RunTemplateInput,
  opts: RunTemplateOpts = {},
): Promise<RunTemplateResult> {
  services.lock.requireKey();
  const { templateId, ref, params } = input;
  // Hoisted so the catch block can include them in the failure audit record.
  let effectiveEnv: string | undefined;
  let destEnv: string | undefined;
  // Hoisted OUTSIDE the try so a post-mint failure (e.g. resolveErr
  // re-thrown after requireApprovals consumed the session) still carries
  // grant.session_id into the failure audit.  Optional-chained at use site
  // because grant remains undefined if requireApprovals itself threw
  // (pre-mint failure), in which case no session was consumed and audit
  // MUST NOT carry session_id.
  let grant: ApprovalGrant | undefined;
  try {
    const tpl = registry.get(templateId);
    const secret = await services.vault.getSecret(ref);
    assertSecretActionAllowed(secret, "use_as_stdin");

    // Reject padded params before everything else — before validateParams,
    // before destinationEnvironment, before the approval binding is built.
    // Padding creates a raw-vs-trimmed divergence that can bypass the
    // production-approval check (see assertNoPaddedParams in registry.ts).
    assertNoPaddedParams(params);

    // Validate template params before creating the approval grant so a human
    // is never prompted for a structurally invalid request.
    tpl.validateParams?.(params);

    // Compute the effective environment BEFORE binary resolution so the
    // approval gate fires first — even when the secret is development-classed
    // but the template destination is production (e.g. vercel-env-add with
    // environment=production).  The approval_required error must surface before
    // an unsafe_binary_path error when both conditions hold.
    destEnv = tpl.destinationEnvironment?.(params);
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
    // grant creation and consumption ensures approvalBindingsMatch always passes on
    // retry — no self-mismatch.
    const binding: ApprovalBinding = {
      action: "template",
      ref: secret.ref,
      environment: effectiveEnv,
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: tpl.id,
      template_params: params,
      template_binary_path: absolute,
      template_binary_sha256: sha256,
    };

    if (opts.bootstrapAuthority !== undefined) {
      // Bootstrap executor path: human already approved the bootstrap binding.
      // Validate the authority is for an in-progress batch, then skip the
      // inner requireApprovals call.
      await assertBootstrapAuthorityValid(opts.bootstrapAuthority, services.bootstrapStore);
    } else {
      // Standard HTTP path: single requireApprovals call — handles both the
      // initial (no approval_id) and the retry (approval_id supplied) paths.
      // When sessionId is set and the binding matches the session pattern,
      // the call mints a used grant from the session and the audit emitted
      // below will carry grant.session_id; otherwise the call falls back to
      // the single-use flow and grant.session_id is undefined.
      const grants = await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.approvalIds !== undefined ? { approvalIdsFromClient: opts.approvalIds } : {}),
        ...(opts.waitForApproval === false ? { waitMs: 0 } : {}),
      });
      grant = grants[0]!;
    }

    // Now that the human has approved (or the bootstrap authority validated),
    // surface any binary resolution failure. The request fails closed:
    // approval was already gated, nothing executed.
    if (resolveErr !== null) throw resolveErr;

    const result = await runTemplate({
      template: { ...tpl, binary: absolute as string },
      params,
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
      ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
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
      ref,
      ...(effectiveEnv !== undefined ? { environment: effectiveEnv } : {}),
      ...(destEnv !== undefined ? { destination_environment: destEnv } : {}),
      template_id: templateId,
      // Optional-chain: grant is undefined if requireApprovals itself threw
      // (pre-mint failure — no session consumed → audit MUST NOT carry
      // session_id).  Otherwise grant.session_id is the source session iff
      // the binding matched the session pattern.
      ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
    });
    throw err;
  }
}
