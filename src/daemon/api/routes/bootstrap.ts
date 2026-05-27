import { randomUUID } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { getAuthContext, getCurrentAgentId } from "../../auth/auth-context.js";
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
import { planHasProductionDestination, planHasProductionSource, planRequiresCapture } from "../../bootstrap/destination-policy.js";
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

    // Parse yml — throws bootstrap_plan_invalid on schema errors and
    // bootstrap_capture_url_invalid on capture-URL-specific failures.
    const parsed = parseBootstrapYml(planYml);

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

    // C10: capture-conditional pre-flight blind guard. Runs AFTER plan compute
    // (so we know if the plan contains a capture step) and BEFORE batchId
    // allocation / bootstrapStore.save — a guarded /plan must leave no batch
    // clutter behind. Non-capture plans skip this guard entirely.
    if (planRequiresCapture(plan)) {
      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
        );
      }
    }

    // Build the batch_id and binding before minting. We save state first so
    // /ui can look it up if it needs to render context while the user is deciding.
    const batchId = `bootstrap-${randomUUID()}`;
    const planSummary = buildPlanSummary(plan);

    // Bootstrap binding gate: production-class if ANY of:
    //   (1) --environment canonicalizes to "production" (R12), OR
    //   (2) any resolved destination is production-class (R10), OR
    //   (3) any plan entry's source ref resolves to production (R13), OR
    //   (4) any plan entry has source.kind === "capture" (C9).
    //
    // (1)-(3) are needed because bootstrap calls inner cores under
    // bootstrapAuthority, which bypasses the inner per-template/per-secret
    // approval gates. The outer bootstrap binding is the only chance to
    // require a human click.
    //
    // (4) is needed because capture is an interactive source — the user has
    // to navigate a browser tab to the source site for the daemon to read
    // the secret. The dev-synth-execute path has no UI surface for that
    // click, so a capture-only dev plan would inline-execute and hang.
    // Routing capture plans through approval gives the user an explicit
    // /continue step and the hub a place to render the capture card.
    const requiresProductionGate =
      canonicalEnvironment(environment) === "production" ||
      planHasProductionDestination(plan) ||
      planHasProductionSource(plan) ||
      planRequiresCapture(plan);
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
      owner_agent_id: getCurrentAgentId(),
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
    // Owner enforcement (A11). MUST run BEFORE the completed short-circuit,
    // the blind-mode guard, requireApprovals, and the executor — otherwise a
    // non-owner could probe approval state, read cached batch results, or
    // skip approval entirely via the in_progress/failed_partial path. Return
    // the same bootstrap_batch_not_found code as a truly-missing batch so
    // existence is not disclosed across agents. Root bypasses.
    const callerAgentId = getCurrentAgentId();
    const callerIsRoot = getAuthContext()?.isRoot === true;
    if (!callerIsRoot && state.owner_agent_id !== callerAgentId) {
      throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
    }
    if (state.status === "completed") {
      return { ok: true, ...summarizeFromState(state) };
    }

    // C10: capture-conditional pre-flight blind guard. Runs AFTER owner check
    // + completed short-circuit, BEFORE requireApprovals — so the minted
    // approval is preserved across the user's `blind end` + retry. Without
    // this ordering, the user would be forced to mint a fresh approval every
    // time they had blind active, which is a terrible UX.
    if (planRequiresCapture(state.plan)) {
      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
        );
      }

      // Pre-approval browser-busy guard (sister to the C10 blind guard). If
      // another bootstrap batch already owns the daemon-spawned Chrome,
      // ensureBootstrapBrowser below WOULD throw bootstrap_browser_busy —
      // but that throw happens AFTER requireApprovals has already consumed
      // this batch's single-use approval. Without this pre-check the user
      // would be forced to mint a fresh approval every time they retry
      // after waiting for batch A to finish. Mirror the C10 ordering: same
      // capture-conditional gate, same "fire before requireApprovals so the
      // approval stays granted" UX invariant.
      //   - null session              → fine (we will spawn below)
      //   - user-owned session        → fine (reused unchanged)
      //   - bootstrap-owned same batch → fine (idempotent reuse on resume)
      //   - bootstrap-owned diff batch → REJECT here
      const session = services.browserSession;
      if (
        session !== null &&
        session.owner.kind === "bootstrap" &&
        session.owner.batchId !== batchId
      ) {
        throw new ShuttleError(
          "bootstrap_browser_busy",
          `Another bootstrap batch (${session.owner.batchId}) is already driving the daemon-owned browser. Retry after that batch completes.`,
        );
      }
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

    // C12: capture plans need a browser session for the duration of the run.
    // hasCapture decides whether the outer try/finally must orchestrate the
    // browser lifecycle. Non-capture plans (random_*, existing) skip this
    // entirely — they don't touch Chrome at all.
    const hasCapture = planRequiresCapture(state.plan);

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
      // Capture-conditional: ensure a browser session is up before we hand off
      // to the executor. No-op when a user-owned session already exists (the
      // user's `browser start` is preserved); otherwise spawn a Chrome with
      // owner:{kind:"bootstrap",batchId} so the finally can identify + tear it
      // down. MUST run AFTER lock acquisition so concurrent /continue callers
      // can't spawn duplicate Chromes for the same batch.
      if (hasCapture) {
        await services.ensureBootstrapBrowser(batchId);
      }

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
      // Capture-conditional teardown: ALWAYS runs before lock release. If a
      // bootstrap-owned Chrome was actually killed AND blind is still active
      // (the executor took the cleanup-failed branch and left blind on so a
      // residual on-page value couldn't be observed), auto-end blind: the
      // rendering process is dead, there is nothing left to observe.
      // stopBootstrapBrowser is a no-op for user-owned sessions, so user
      // `browser start` survives this finally untouched.
      if (hasCapture) {
        const { stopped } = await services.stopBootstrapBrowser(batchId);
        if (stopped && services.blind.current() !== null) {
          services.blind.end();
          await writeDaemonAudit({
            action: "blind_auto_resume_after_browser_stop",
            ok: true,
            actor_agent_id: state.owner_agent_id,
          });
        }
      }
      // Lock release LAST — after browser cleanup. A retry after release must
      // see a clean services.browserSession === null (or the user's session,
      // untouched), not a half-torn-down bootstrap session.
      services.bootstrapStore.releaseExecutionLock(batchId);
    }
  });

  // ── POST /v1/bootstrap/abandon ───────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/abandon", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const batchId = reqString(o, "batch_id");

    // Owner enforcement (A11). Load state first so we can verify ownership
    // before deleting. Both "missing batch" and "cross-owner batch" emit the
    // same bootstrap_batch_not_found error so existence is not disclosed.
    // Root bypasses.
    const state = await services.bootstrapStore.get(batchId);
    const callerAgentId = getCurrentAgentId();
    const callerIsRoot = getAuthContext()?.isRoot === true;
    if (state === null || (!callerIsRoot && state.owner_agent_id !== callerAgentId)) {
      throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
    }

    await services.bootstrapStore.delete(batchId);
    return { ok: true, removed: true };
  });

  // ── GET /v1/bootstrap/list ───────────────────────────────────────────────
  server.addRoute("GET", "/v1/bootstrap/list", async () => {
    services.lock.requireKey();
    const batches = await services.bootstrapStore.list();
    // Owner-filtered (A11): non-root callers only see batches they created;
    // root sees all. Cross-agent batches are silently omitted so non-owners
    // cannot enumerate other agents' batch_ids via /list.
    const callerAgentId = getCurrentAgentId();
    const callerIsRoot = getAuthContext()?.isRoot === true;
    const filtered = callerIsRoot ? batches : batches.filter((s) => s.owner_agent_id === callerAgentId);
    return {
      ok: true,
      batches: filtered.map((s) => ({
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
