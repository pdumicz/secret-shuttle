import { randomUUID } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { getAuthContext, getCurrentAgentId } from "../../auth/auth-context.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import { writeDaemonAudit } from "../../audit.js";
import { parseBootstrapYml } from "../../../cli/bootstrap/yml.js";
import { computeBootstrapPlan } from "../../bootstrap/plan.js";
import { executeBatch, type ExecuteResult, type ExecutorDeps } from "../../bootstrap/executor.js";
import type { DaemonServer } from "../../server.js";
import type { BootstrapBrowserLease, DaemonServices } from "../../services.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { BatchState, BootstrapStore, PlanEntry } from "../../bootstrap/store.js";
import { registry as templateRegistry } from "./templates.js";
import { resolveBinary } from "../../templates/resolve-binary.js";

// Cores from Task I:
import { generateSecretCore } from "./secrets.js";
import { revealCaptureCore } from "./reveal-capture.js";
import { runTemplateCore } from "./templates.js";
import { planHasProductionDestination, planHasProductionSource, planRequiresBootstrapBrowser, planRequiresHumanPending } from "../../bootstrap/destination-policy.js";
import { canonicalEnvironment } from "../../../shared/refs.js";

export function registerBootstrapRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  // ── POST /v1/bootstrap/plan ──────────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/plan", async (_req, raw) => {
    services.lock.assertUnlocked();
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

    // Probe each template's binary once to know if the vendor CLI is available.
    const cliAvail = new Map<string, boolean>();
    for (const t of templateRegistry.list()) {
      let ok = true;
      try { await resolveBinary(t.binary); } catch { ok = false; }
      cliAvail.set(t.id, ok);
    }
    const isCliConfigured = (templateId: string): boolean => cliAvail.get(templateId) ?? true;

    // Diff against vault — skip secrets already present (unless force).
    const plan = computeBootstrapPlan(
      parsed,
      { has: (ref: string) => existingRefs.has(ref) },
      { force, source: "local", environment },
      { isCliConfigured, ...(services.recipes !== undefined ? { recipes: services.recipes } : {}) },
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
    if (planRequiresHumanPending(plan)) {
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
      planRequiresHumanPending(plan);
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
      // Burst 5 §4 Task 4.5 (P2-1 follow-up): inline-execute path must mirror
      // /continue's batch_status + resume hint contract. Without this, agents
      // hitting the dev/no-approval inline path on a failed_partial outcome
      // would miss the agent-actionable `next_action` field they rely on.
      const decorated = await decorateWithBatchStatus(result, services.bootstrapStore, batchId);
      return { ok: true, batch_id: batchId, ...decorated };
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
        // batch to pass to /continue, AND surface the bootstrap-specific
        // continue-command shape in details.continue_command_after_approval.
        //
        // CTO-review round-2 P1.1: next_action MUST be null for
        // approval_required. The nextAction contract (src/shared/error-codes.ts:17)
        // reserves that field for AUTOMATIC recovery — running it immediately
        // while the approval is still pending fails with approval_not_granted
        // at require-approvals.ts:188 (supplied IDs in pending state are
        // rejected). approval_required is the canonical human-intervention
        // error: the human must click Approve in the hub before any recovery
        // command can succeed.
        //
        // Why we still surface the continue command: the registry-level hint
        // at src/shared/error-codes.ts:238-244 only knows about the generic
        // `--approval-id <id>` retry shape, which is correct for run / inject /
        // inject-submit / reveal-capture / template run (where the original
        // command + --approval-id retries the same command). For batch-style
        // bootstrap flows (--yml / --secret / --infer), the recovery is NOT
        // to re-run --yml with --approval-id; it's to call --continue against
        // the already-minted batch. Agents read the recovery shape from
        // details.continue_command_after_approval and run it AFTER the human
        // approves.
        //
        // CTO-review round-4 P1.1: also override the wire `hint`. The registry
        // hint at src/shared/error-codes.ts:238-244 instructs agents to "retry
        // with --approval-id <id>" — correct for single-shot ops (run / inject
        // / reveal-capture / template run) but WRONG for batch-style provision
        // flows. Retrying `provision` with --approval-id would mint a new
        // batch instead of continuing the existing one. The per-instance hint
        // points agents at details.continue_command_after_approval, which
        // carries the correct `--continue --batch X --approval-id Y` shape.
        const continueCommandAfterApproval = approvalId !== ""
          ? `secret-shuttle provision --continue --batch ${batchId} --approval-id ${approvalId}`
          : null;
        throw new ShuttleError("approval_required", e.message, {
          hint: "Approve in the opened hub, then run the command in details.continue_command_after_approval.",
          nextAction: null,
          details: {
            ...details,
            batch_id: batchId,
            continue_command_after_approval: continueCommandAfterApproval,
          },
        });
      }
      throw e;
    }
  });

  // ── POST /v1/bootstrap/continue ─────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/continue", async (_req, raw) => {
    services.lock.assertUnlocked();
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
      return { ok: true, batch_status: "completed", ...summarizeFromState(state) };
    }

    // C10: pre-flight blind guard. Runs AFTER owner check + completed
    // short-circuit, BEFORE requireApprovals — so the minted approval is
    // preserved across the user's `blind end` + retry. Without this
    // ordering, the user would be forced to mint a fresh approval every
    // time they had blind active, which is a terrible UX.
    //
    // Codex round-2 P1: gate must use `planRequiresBootstrapBrowser`, NOT
    // `planRequiresHumanPending`. Browser-only inject plans (e.g.
    // random_32_bytes → vercel.com browser_inject) have a non-human-pending
    // source but still touch Chrome via `runBrowserInject`, which calls
    // `services.blind.start(...)`. If an unrelated blind window is already
    // active, `start` throws, the outer teardown stops the bootstrap-owned
    // Chrome AND calls `services.blind.end()` on the *unrelated* blind state
    // (`bootstrap.ts` finally below). Guarding here with the browser-aware
    // predicate fails BEFORE any browser is spawned or blind is touched.
    if (planRequiresBootstrapBrowser(state.plan)) {
      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
        );
      }
    }

    // C12: bootstrap plans that touch Chrome — either a human-pending source
    // (capture / human_paste) OR a browser_inject destination — need a browser
    // session for the duration of the run. `needsBrowser` decides whether the
    // outer try/finally must orchestrate the browser lifecycle. Pure non-capture
    // template-only plans (random_*/existing → CLI push) skip this entirely.
    //
    // Why both source AND destination matter: the browser-only Vercel inject
    // path can plan a `random_32_bytes` source + a `browser_inject` Vercel
    // destination. The source is not human-pending, but the destination still
    // needs a logged-in bootstrap browser. A source-only check (the old
    // planRequiresHumanPending) would skip the reservation + ensure + teardown
    // for that plan, and runBrowserInject would fail closed with
    // `bootstrap_plan_invalid` because services.browserSession is null.
    const needsBrowser = planRequiresBootstrapBrowser(state.plan);

    // SYNCHRONOUS bootstrap-browser reservation BEFORE requireApprovals.
    //
    // Closes a cross-batch double-spawn race that the previous slot-only
    // precheck couldn't: two batches starting from a null services.browserSession
    // would both pass that precheck (no session present), both consume their
    // approvals in requireApprovals, then both race into ensureBootstrapBrowser
    // whose null-check is awaited (not synchronous). With a slow Chrome-spawn
    // factory, both calls see null, both spawn, last writer wins — leaking
    // one Chrome process and orphaning the losing batch's already-consumed
    // approval (single-use, gone for nothing).
    //
    // reserveBootstrapBrowser runs SYNCHRONOUSLY, so the second caller hits
    // it BEFORE its approval is consumed: the loser fails with
    // bootstrap_browser_busy and its grant is preserved for the user's retry
    // after batch A finishes.
    //
    // LEASE MODEL: reserveBootstrapBrowser returns a unique lease handle.
    // releaseBootstrapBrowser(lease) is handle-guarded — clears the slot
    // ONLY if that exact lease still owns it. This closes a follow-up race:
    // a duplicate same-batch /continue (which now throws bootstrap_batch_busy
    // synchronously) leaves `lease === null` in its scope, so its outer
    // finally is a no-op and the ORIGINAL /continue's lease is preserved.
    // Same-batch concurrent reserve also rejects with bootstrap_batch_busy
    // (symmetric with the per-batch execution lock), so the approval-and-spawn
    // phase is serialized end-to-end.
    //
    // The reservation also rejects when an existing bootstrap session is
    // owned by a different batch — same semantics as the old precheck, just
    // unified through one primitive.
    let lease: BootstrapBrowserLease | null = null;
    if (needsBrowser) {
      lease = services.reserveBootstrapBrowser(batchId);
    }

    try {
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
        // Capture-conditional: ensure a browser session is up before we hand off
        // to the executor. No-op when a user-owned session already exists (the
        // user's `browser start` is preserved); otherwise spawn a Chrome with
        // owner:{kind:"bootstrap",batchId} so the finally can identify + tear it
        // down. MUST run AFTER lock acquisition so concurrent /continue callers
        // can't spawn duplicate Chromes for the same batch. The synchronous
        // reservation above already guards against cross-batch collisions —
        // ensureBootstrapBrowser itself also honors the reservation as
        // defense-in-depth.
        if (needsBrowser) {
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
        // Burst 5 §4 Task 4.5: surface batch_status + an agent-actionable
        // resume hint when the batch ended failed_partial. The executor
        // saved final state before returning (executor.ts:394) so re-read
        // is consistent. Status "completed" and "abandoned" do NOT carry
        // next_action — completed is terminal-success, abandoned is the
        // user's explicit choice to walk away. Shared with the /plan
        // inline-execute path via decorateWithBatchStatus.
        const decorated = await decorateWithBatchStatus(result, services.bootstrapStore, batchId);
        return { ok: true, ...decorated };
      } finally {
        // Capture-conditional teardown: ALWAYS runs before lock release. If a
        // bootstrap-owned Chrome was actually killed AND blind is still active
        // (the executor took the cleanup-failed branch and left blind on so a
        // residual on-page value couldn't be observed), auto-end blind: the
        // rendering process is dead, there is nothing left to observe.
        // stopBootstrapBrowser is a no-op for user-owned sessions, so user
        // `browser start` survives this finally untouched.
        //
        // §5 / §6 page-state recovery preservation: when a recipe attempt ended
        // with a page-state failure (bootstrap_login_required,
        // recipe_page_timeout, recipe_page_unexpected), the executor left the
        // visible provider tab OPEN as the documented recovery surface — the
        // user is told to "log into <host> in the open window" / "check the
        // open window" and re-run --continue. Closing the bootstrap browser
        // here would defeat that contract by killing the tab the user was
        // instructed to act on. Re-read state from disk (the executor saved
        // before returning) and skip teardown when any source step OR any
        // destination push produced one of those codes. Cookies persist in
        // the bootstrap profile, so the user's next /continue reuses the
        // same logged-in session.
        const PAGE_STATE_CODES = new Set([
          "bootstrap_login_required",
          "recipe_page_timeout",
          "recipe_page_unexpected",
        ]);
        const finalState = await services.bootstrapStore.get(batchId);
        const hasPageStateFailure =
          finalState !== null &&
          Object.values(finalState.step_results).some((r) => {
            if (r.error_code !== undefined && PAGE_STATE_CODES.has(r.error_code)) return true;
            return (r.destinations_pushed ?? []).some(
              (d) => d.error_code !== undefined && PAGE_STATE_CODES.has(d.error_code),
            );
          });
        // Codex round-2 P1: page-state preservation is too broad on its own.
        // `recipe-inject.ts` deliberately leaves blind active when a secret-bearing
        // cleanup couldn't be verified (lines 111 / 135 / 155), relying on this
        // teardown to kill the renderer. In a multi-destination entry, one
        // destination can return `bootstrap_login_required` (page-state) while a
        // later destination returns `recipe_inject_failed` with cleanup unverified
        // — and on that path, blind remains ACTIVE. The page-state-only check
        // would skip teardown in that case, leaving a live renderer with a
        // potentially-rendered secret value still on a closed-but-unverified tab,
        // violating the "bootstrap-browser teardown kills the renderer" contract.
        //
        // Rule: if blind is still active after execute, teardown WINS over
        // page-state preservation. The renderer must die so the residual value
        // (if any) cannot be observed by a resumed agent.
        const blindStillActive = services.blind.current() !== null;
        const preservePageState = hasPageStateFailure && !blindStillActive;
        if (needsBrowser && !preservePageState) {
          const { stopped } = await services.stopBootstrapBrowser(batchId);
          if (stopped && services.blind.current() !== null) {
            services.blind.end();
            await writeDaemonAudit({
              action: "blind_auto_resume_after_browser_stop",
              ok: true,
              actor_agent_id: state.owner_agent_id,
            });
          }
        } else if (needsBrowser && preservePageState) {
          // Audit the deliberate skip so it's traceable why the bootstrap
          // browser survived this /continue: the user is mid-recovery.
          await writeDaemonAudit({
            action: "bootstrap_browser_preserved_for_page_state_recovery",
            ok: true,
            actor_agent_id: state.owner_agent_id,
          });
        }
        // Lock release LAST — after browser cleanup. A retry after release must
        // see a clean services.browserSession === null (or the user's session,
        // untouched), not a half-torn-down bootstrap session.
        services.bootstrapStore.releaseExecutionLock(batchId);
      }
    } finally {
      // Release the bootstrap-browser reservation LAST — outer-most finally.
      // Covers both the happy path and any throw inside the try (including
      // requireApprovals failure pre-lock-acquire, lock-acquire failure, and
      // any executor exception).
      //
      // Handle-guarded: releaseBootstrapBrowser clears the slot ONLY if this
      // exact lease still owns it. The `lease !== null` check covers the path
      // where reserveBootstrapBrowser itself threw (cross-batch
      // bootstrap_browser_busy, or same-batch bootstrap_batch_busy from a
      // duplicate concurrent /continue) — in that scope `lease` is null and
      // the finally is a no-op, preserving the active lease held by the
      // original /continue.
      if (lease !== null) {
        services.releaseBootstrapBrowser(lease);
      }
    }
  });

  // ── POST /v1/bootstrap/abandon ───────────────────────────────────────────
  server.addRoute("POST", "/v1/bootstrap/abandon", async (_req, raw) => {
    services.lock.assertUnlocked();
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

    // Codex round-2 P2: stop any bootstrap-owned browser for THIS batch BEFORE
    // deleting state. After a page-state failure the outer /continue finally
    // deliberately keeps the bootstrap browser alive (owner = {kind:"bootstrap",
    // batchId}) so the user can recover (log in / inspect the tab). If they
    // choose to abandon instead, deleting batch state without stopping the
    // browser would leak the Chrome process and orphan its owner tag — the
    // next batch's `reserveBootstrapBrowser` would see a different bootstrap
    // owner and reject with `bootstrap_browser_busy`. `stopBootstrapBrowser`
    // is a no-op when the browser is user-owned or owned by a different batch,
    // so this only kills what this batch actually owns. If blind is still
    // active after that stop, end blind too — the renderer is dead.
    const { stopped } = await services.stopBootstrapBrowser(batchId);
    if (stopped && services.blind.current() !== null) {
      services.blind.end();
      await writeDaemonAudit({
        action: "blind_auto_resume_after_browser_stop",
        ok: true,
        actor_agent_id: state.owner_agent_id,
      });
    }

    await services.bootstrapStore.delete(batchId);
    return { ok: true, removed: true };
  });

  // ── GET /v1/bootstrap/list ───────────────────────────────────────────────
  server.addRoute("GET", "/v1/bootstrap/list", async () => {
    services.lock.assertUnlocked();
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

/**
 * Decorate an ExecuteResult with the post-execute batch_status and a
 * conditional agent-actionable resume hint (next_action).
 *
 * Shared by both /plan inline-execute and /continue: the response shape MUST
 * match across the two paths so agents can rely on `batch_status` to drive
 * their next action — and a failed_partial outcome MUST carry the exact
 * resume command, regardless of which entry point produced it.
 *
 * Re-reads state from the store because the executor mutates state on disk
 * during the run (executor.ts:394 saves before returning) and we want the
 * canonical final status. Status "completed" and "abandoned" do NOT carry
 * next_action: completed is terminal-success and abandoned is the user's
 * explicit choice to walk away.
 */
async function decorateWithBatchStatus(
  result: ExecuteResult,
  bootstrapStore: BootstrapStore,
  batchId: string,
): Promise<ExecuteResult & { batch_status: BatchState["status"]; next_action?: string }> {
  const state = await bootstrapStore.get(batchId);
  const status: BatchState["status"] = state?.status ?? "in_progress";
  return {
    ...result,
    batch_status: status,
    ...(status === "failed_partial"
      ? { next_action: `secret-shuttle provision --continue --batch ${batchId}` }
      : {}),
  };
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
