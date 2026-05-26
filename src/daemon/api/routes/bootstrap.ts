import { randomUUID } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import { writeDaemonAudit } from "../../audit.js";
import { parseBootstrapYml } from "../../../cli/bootstrap/yml.js";
import { computeBootstrapPlan } from "../../bootstrap/plan.js";
import { executeBatch, type ExecutorDeps } from "../../bootstrap/executor.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { BatchState } from "../../bootstrap/store.js";

// Cores from Task I:
import { generateSecretCore } from "./secrets.js";
import { revealCaptureCore } from "./reveal-capture.js";
import { runTemplateCore } from "./templates.js";

export function registerBootstrapRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  // ── POST /v1/bootstrap/plan ──────────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/plan", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const planYml = reqString(o, "plan_yml");
    const force = optBool(o, "force") ?? false;
    const environment = optString(o, "environment") ?? "production";

    // Parse yml — throws bootstrap_plan_invalid on schema errors.
    const parsed = parseBootstrapYml(planYml);

    // Reject capture sources explicitly. Bootstrap v1 cannot drive
    // reveal-capture (which requires a live browser handle marked by the user).
    // Capture support is deferred to a future plan.
    const captureSecrets = parsed.secrets.filter((s) => s.source.kind === "capture");
    if (captureSecrets.length > 0) {
      throw new ShuttleError(
        "bootstrap_plan_invalid",
        `bootstrap v1 does not support source.kind=capture. Affected secrets: ${captureSecrets.map((s) => s.name).join(", ")}. Use 'secret-shuttle reveal-capture' for these secrets manually, then reference them via source.kind=existing in secret-shuttle.yml.`,
      );
    }

    // Pre-fetch all non-deleted vault refs for a synchronous has() check.
    // Default list() excludes deleted secrets, matching upsertSecret's force check semantics.
    const existingRefs = new Set((await services.vault.list()).map((s) => s.ref));

    // Diff against vault — skip secrets already present (unless force).
    const plan = computeBootstrapPlan(
      parsed,
      { has: (ref: string) => existingRefs.has(ref) },
      { force, source: "local", environment },
    );

    // Nothing to do: short-circuit with success.
    if (plan.length === 0) {
      await writeDaemonAudit({ action: "bootstrap_plan", ok: true });
      return { ok: true, completed: 0, failed: 0, refs: [], errors: [] };
    }

    // Build the batch_id and binding before minting. We save state first so
    // /ui can look it up if it needs to render context while the user is deciding.
    const batchId = `bootstrap-${randomUUID()}`;
    const planSummary = plan.map((e) => ({
      name: e.secret,
      source: e.source.kind === "capture" ? `capture:${(e.source as { url: string }).url}` : e.source.kind,
      destinations: e.destinations.map((d) => d.shorthand),
    }));
    const binding: ApprovalBinding = {
      action: "bootstrap",
      ref: null,
      environment: environment === "production" ? "production" : "development",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: {
        batch_id: batchId,
        plan_summary: JSON.stringify(planSummary),
      },
      allowed_domains: Array.from(new Set(plan.flatMap((e) => e.destinations.map((d) => d.domain)))),
    };

    // Save initial batch state (no approval_id yet — filled in below).
    await services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "",
      plan_file_path: "",
      plan,
      step_results: {},
      created_at: Date.now(),
      status: "pending",
    });

    // requireApprovals with waitMs:0 always throws approval_required when the
    // binding needs an approval (production environment). We catch it, enrich
    // with batch_id, persist the minted approval_id, and re-throw.
    try {
      await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        waitMs: 0,
      });
      // If we somehow reach here (e.g., dev-env synth), return success.
      await writeDaemonAudit({ action: "bootstrap_plan", ok: true });
      return { ok: true, completed: 0, failed: 0, refs: [], errors: [] };
    } catch (e) {
      if (e instanceof ShuttleError && e.code === "approval_required") {
        const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> } | undefined;
        const approvalId = details?.approvals[0]?.approval_id ?? "";

        // Update the batch state with the minted approval_id.
        const state = await services.bootstrapStore.get(batchId);
        if (state !== null) {
          state.approval_id = approvalId;
          await services.bootstrapStore.save(state);
        }

        await writeDaemonAudit({ action: "bootstrap_plan", ok: true, approval_id: approvalId });

        // Re-throw with batch_id added to details so the caller knows which
        // batch to pass to /continue.
        throw new ShuttleError("approval_required", e.message, {
          details: { ...details, batch_id: batchId },
        });
      }
      throw e;
    }
  });

  // ── POST /v1/bootstrap/continue ─────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/continue", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const batchId = reqString(o, "batch_id");
    const approvalIds = optApprovalIds(o);

    const state = await services.bootstrapStore.get(batchId);
    if (state === null) {
      throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
    }
    if (state.status === "completed") {
      return { ok: true, ...summarizeFromState(state) };
    }

    // Rebuild the same binding shape that /plan minted, so requireApprovals'
    // equality check passes when consuming the pre-minted approval.
    const planSummary = state.plan.map((e) => ({
      name: e.secret,
      source: e.source.kind === "capture" ? `capture:${(e.source as { url: string }).url}` : e.source.kind,
      destinations: e.destinations.map((d) => d.shorthand),
    }));
    const binding: ApprovalBinding = {
      action: "bootstrap",
      ref: null,
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: {
        batch_id: batchId,
        plan_summary: JSON.stringify(planSummary),
      },
      allowed_domains: Array.from(new Set(state.plan.flatMap((e) => e.destinations.map((d) => d.domain)))),
    };

    // Consume the bootstrap approval.
    await requireApprovals({
      store: services.approvals,
      bindings: [binding],
      daemonPort: daemonPortRef(),
      sessionStore: services.sessionStore,
      openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
      ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
    });

    // Execute the plan.
    const deps: ExecutorDeps = {
      generateSecret: generateSecretCore as ExecutorDeps["generateSecret"],
      revealCapture: revealCaptureCore as ExecutorDeps["revealCapture"],
      runTemplate: runTemplateCore as ExecutorDeps["runTemplate"],
      services,
      daemonPortRef,
    };
    const result = await executeBatch(services.bootstrapStore, batchId, deps);
    return { ok: true, ...result };
  });

  // ── POST /v1/bootstrap/abandon ───────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/abandon", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const batchId = reqString(o, "batch_id");
    await services.bootstrapStore.delete(batchId);
    return { ok: true, removed: true };
  });

  // ── GET /v1/bootstrap/list ───────────────────────────────────────────────
  server.addRoute("GET", "/v1/bootstrap/list", async () => {
    services.lock.requireKey();
    const batches = await services.bootstrapStore.list();
    return {
      ok: true,
      batches: batches.map((s) => ({
        batch_id: s.batch_id,
        status: s.status,
        created_at: s.created_at,
        plan_length: s.plan.length,
        completed: Object.values(s.step_results).filter((r) => r.ok).length,
        failed: Object.values(s.step_results).filter((r) => !r.ok).length,
      })),
    };
  });
}

function summarizeFromState(state: BatchState): {
  completed: number;
  failed: number;
  refs: string[];
  errors: Array<{ secret: string; step: string; code: string; message: string }>;
} {
  let completed = 0;
  let failed = 0;
  const refs: string[] = [];
  const errors: Array<{ secret: string; step: string; code: string; message: string }> = [];
  for (const entry of state.plan) {
    const r = state.step_results[entry.secret];
    if (r === undefined) continue;
    if (r.ok) {
      completed += 1;
      if (r.ref !== undefined) refs.push(r.ref);
    } else {
      failed += 1;
      errors.push({
        secret: entry.secret,
        step: "execute",
        code: r.error_code ?? "unexpected_error",
        message: r.message ?? "",
      });
    }
  }
  return { completed, failed, refs, errors };
}
