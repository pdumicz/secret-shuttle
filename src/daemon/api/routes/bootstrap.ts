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
import type { BatchState, PlanEntry } from "../../bootstrap/store.js";

// Cores from Task I:
import { generateSecretCore } from "./secrets.js";
import { revealCaptureCore } from "./reveal-capture.js";
import { runTemplateCore } from "./templates.js";
import { planHasProductionDestination } from "../../bootstrap/destination-policy.js";
import { canonicalEnvironment } from "../../../shared/refs.js";

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
    const planSummary = buildPlanSummary(plan);

    // Bootstrap binding gate: production-class if EITHER --environment is "production"
    // OR any resolved destination is production-class. The destinations check is the
    // security boundary — without it, a yml with environment:"development" +
    // destinations:[vercel:production] would auto-approve (dev-env synth) and the
    // executor would push to production via bootstrapAuthority, bypassing the inner
    // template approval. The user would see no human-clicked approval for a write
    // to vercel.com/<team>/production.
    const requiresProductionGate =
      canonicalEnvironment(environment) === "production" || planHasProductionDestination(plan);
    const bindingEnvironment = requiresProductionGate ? "production" : "development";

    const binding: ApprovalBinding = {
      action: "bootstrap",
      ref: null,
      environment: bindingEnvironment,
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

    // requireApprovals with waitMs:0 throws approval_required when the binding
    // needs a human approval (production environment). For dev-env bindings it
    // synthesizes a grant and returns without throwing.
    // We catch the throw, enrich with batch_id, persist the minted approval_id,
    // and re-throw. On the no-throw path (dev-env synth) we run the executor
    // inline so the batch reaches a terminal state in a single /plan call.
    try {
      const grants = await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        waitMs: 0,
      });

      // No throw: dev-env synthesized a grant (no human approval needed) or a
      // live session matched. The bootstrap is authorized — run the executor
      // inline so the user gets the result in one call instead of stranding
      // the batch in "pending" forever.
      const grant = grants[0];
      if (grant !== undefined) {
        const fresh = await services.bootstrapStore.get(batchId);
        if (fresh !== null) {
          fresh.approval_id = grant.id ?? "";
          await services.bootstrapStore.save(fresh);
        }
      }

      if (!services.bootstrapStore.tryAcquireExecutionLock(batchId)) {
        throw new ShuttleError(
          "bootstrap_batch_busy",
          `Batch ${batchId} is already executing; wait for the current run to finish, then retry.`,
        );
      }
      let result: Awaited<ReturnType<typeof executeBatch>>;
      try {
        const deps: ExecutorDeps = {
          generateSecret: generateSecretCore as ExecutorDeps["generateSecret"],
          revealCapture: revealCaptureCore as ExecutorDeps["revealCapture"],
          runTemplate: runTemplateCore as ExecutorDeps["runTemplate"],
          services,
          daemonPortRef,
        };
        result = await executeBatch(services.bootstrapStore, batchId, deps);
      } finally {
        services.bootstrapStore.releaseExecutionLock(batchId);
      }

      await writeDaemonAudit({
        action: "bootstrap_plan",
        ok: true,
        ...(grant?.id !== undefined && grant.id !== "no-approval-required" ? { approval_id: grant.id } : {}),
      });
      return { ok: true, batch_id: batchId, ...result };
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

    // The bootstrap approval is single-use, but the executor is idempotent
    // (skips completed steps, reuses prior ref, retries only failed destinations).
    // We only consume the approval on the FIRST /continue call (state.status === "pending").
    // For retries (in_progress / failed_partial), the approval was already consumed
    // in the prior call — the batch_id + the locked-daemon precondition are the
    // authorization for the retry.
    if (state.status === "pending") {
      // Rebuild the same binding shape that /plan minted, so requireApprovals'
      // equality check passes when consuming the pre-minted approval.
      const planSummary = buildPlanSummary(state.plan);
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

      await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
      });
    }
    // else: state.status is "in_progress" or "failed_partial" — the approval was
    // already consumed in a prior /continue call. Skip re-consumption; proceed to
    // executor (idempotent: reuses prior ref, retries only failed destinations).

    // Acquire the in-memory execution lock before entering the executor.
    // If another /continue (or /plan inline) is already inside executeBatch for
    // this batch, the second caller gets bootstrap_batch_busy immediately.
    // The lock is in-memory only — daemon restart clears it, so a crash-recovery
    // /continue (in_progress on disk, no lock held) will always proceed.
    if (!services.bootstrapStore.tryAcquireExecutionLock(batchId)) {
      throw new ShuttleError(
        "bootstrap_batch_busy",
        `Batch ${batchId} is already executing; wait for the current run to finish, then retry.`,
      );
    }
    try {
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
    } finally {
      services.bootstrapStore.releaseExecutionLock(batchId);
    }
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

function buildPlanSummary(plan: PlanEntry[]): Array<{ name: string; source: string; destinations: string[] }> {
  return plan.map((e) => ({
    name: e.secret,
    source:
      e.source.kind === "capture"
        ? `capture:${(e.source as { url: string }).url}`
        : e.source.kind === "existing"
          ? `existing:${e.ref}`
          : e.source.kind,
    destinations: e.destinations.map((d) => d.shorthand),
  }));
}

function summarizeFromState(state: BatchState): {
  completed: number;
  failed: number;
  refs: string[];
  errors: Array<{
    secret: string;
    step: string;
    code: string;
    message: string;
    destination?: string;
  }>;
} {
  let completed = 0;
  let failed = 0;
  const refs: string[] = [];
  const errors: Array<{
    secret: string;
    step: string;
    code: string;
    message: string;
    destination?: string;
  }> = [];
  for (const entry of state.plan) {
    const r = state.step_results[entry.secret];
    if (r === undefined) continue;
    if (r.ok) {
      completed += 1;
      if (r.ref !== undefined) refs.push(r.ref);
    } else {
      failed += 1;
      if (r.destinations_pushed !== undefined && r.destinations_pushed.length > 0) {
        // Destination-level failures: emit one error entry per failed destination.
        for (const dest of r.destinations_pushed) {
          if (!dest.ok) {
            errors.push({
              secret: entry.secret,
              step: "destination",
              code: dest.error_code ?? "unexpected_error",
              message: dest.message ?? "",
              destination: dest.destination,
            });
          }
        }
      } else {
        // Source-step failure (or unexpected error with no destination detail).
        errors.push({
          secret: entry.secret,
          step: "execute",
          code: r.error_code ?? "unexpected_error",
          message: r.message ?? "",
        });
      }
    }
  }
  return { completed, failed, refs, errors };
}
