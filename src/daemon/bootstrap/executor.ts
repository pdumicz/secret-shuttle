import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import { writeDaemonAudit } from "../audit.js";
import { attemptRecipeCapture } from "./recipe-capture.js";
import { runBrowserInject } from "./recipe-inject.js";
import { recipeRegistry } from "../recipes/registry.js";
import type { RecipeRegistry } from "../recipes/registry.js";
import {
  openCaptureTarget,
  cleanupCaptureTarget,
} from "../chrome/capture-target-ops.js";
import { disableObservationDomains } from "../chrome/internal-ops.js";
import { canonicalEnvironment } from "../../shared/refs.js";
import { SecretValue } from "../../vault/secret-value.js";
import type { BootstrapStore, BatchState, PlanEntry, ResolvedDestination } from "./store.js";
import type { DaemonServices } from "../services.js";
import type { BootstrapAuthority } from "./authority.js";
import type { CdpClient } from "../chrome/cdp-client.js";
import type {
  GenerateSecretInput,
  GenerateSecretOpts,
  GenerateSecretResult,
} from "../api/routes/secrets.js";
import type {
  RevealCaptureOpts,
  RevealCaptureResult,
} from "../api/routes/reveal-capture.js";
import type {
  RunTemplateInput,
  RunTemplateOpts,
  RunTemplateResult,
} from "../api/routes/templates.js";

export type GenerateCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  input: GenerateSecretInput,
  opts: GenerateSecretOpts,
) => Promise<GenerateSecretResult>;

/**
 * The reveal-capture dep uses `any` for input because the bootstrap capture
 * source (kind: "capture", url) does not map 1:1 to RevealCaptureInput (which
 * requires live browser handles). The real integration will derive its own
 * input shape; tests spy on this with a mock that ignores the shape entirely.
 *
 * NOTE (C11): the executor no longer routes the capture branch through this
 * dep — the full state machine lives in `runCaptureStep` below. The dep is
 * kept on ExecutorDeps for back-compat with existing call sites (and the
 * existing executor.test.ts which still patches it via makeDeps). Once C13
 * lands and the legacy revealCaptureCore-from-bootstrap path is removed, this
 * dep + the import block can be deleted.
 */
export type RevealCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
  opts: RevealCaptureOpts,
) => Promise<RevealCaptureResult>;

export type TemplateCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  input: RunTemplateInput,
  opts: RunTemplateOpts,
) => Promise<RunTemplateResult>;

export interface ExecutorDeps {
  generateSecret: GenerateCore;
  revealCapture: RevealCore;
  runTemplate: TemplateCore;
  services: DaemonServices;
  daemonPortRef: () => number;
  /** Optional recipe registry override for tests; defaults to the module singleton. */
  recipes?: RecipeRegistry;
}

export interface ExecuteResult {
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
}

/**
 * Per-entry context the capture state machine needs. Threaded through
 * `runCaptureStep` so it can register the pending capture, emit the SSE event,
 * record step_results on cleanup failure, and (on abort) set the batch status
 * to "abandoned". These were previously read locally inside the outer loop;
 * the capture branch is the first source kind that needs them.
 */
interface CaptureStepContext {
  state: BatchState;
  batchId: string;
  step_idx: number;   // 1-based for human-facing UIs
  step_total: number;
}

/**
 * Outcome of a capture branch — richer than the legacy "ref or throw" shape
 * because the state machine has 5 distinct branches (success/failure ×
 * verified/not-verified, plus abort which always STOPs).
 *
 *   - SUCCESS+verified  → { kind: "ref", ref } → outer loop runs destinations
 *   - SUCCESS+!verified → { kind: "stopWith", stepResult } → outer loop
 *                         records the result + stops the batch
 *   - FAILURE+verified  → { kind: "continueWith", stepResult }
 *                         → record + go to next entry (R5 retry handles re-attempt)
 *   - FAILURE+!verified → { kind: "stopWith", stepResult }
 *   - FAILURE abort     → { kind: "stopAbandoned", stepResult }
 *
 * The outer loop branches on .kind exactly once; the rest of the state machine
 * is contained inside runCaptureStep so the outer flow stays linear.
 */
export type CaptureStepOutcome =
  | { kind: "ref"; ref: string }
  | { kind: "continueWith"; stepResult: import("./store.js").StepResult }
  | { kind: "stopWith"; stepResult: import("./store.js").StepResult }
  | { kind: "stopAbandoned"; stepResult: import("./store.js").StepResult };

/**
 * Walks a bootstrap batch plan, calling the appropriate core function for each
 * PlanEntry's source step and then each destination step, all under a
 * BootstrapAuthority so inner routes skip their own requireApprovals call.
 *
 * - Unknown batch → `bootstrap_batch_not_found`.
 * - Already-completed batch → returns cached summary without re-running.
 * - Transitions to "in_progress" before the walk; saves after each entry.
 * - Per-step errors are recorded in step_results; execution continues past
 *   failures (partial-success semantics).
 * - Final status: "completed" or "failed_partial".
 */
export async function executeBatch(
  store: BootstrapStore,
  batchId: string,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  const state = await store.get(batchId);
  if (state === null) {
    throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
  }
  if (state.status === "completed") {
    return summarize(state);
  }

  state.status = "in_progress";
  await store.save(state);

  const authority: BootstrapAuthority = { batchId };
  const stepTotal = state.plan.length;
  let entryIdx = 0;

  for (const entry of state.plan) {
    entryIdx += 1;
    const prior = state.step_results[entry.secret];
    if (prior?.ok === true) {
      continue;
    }

    // ── Capture branch (C11): the source step is a state machine, not a
    // simple core-fn call. It can SUCCEED + ref (run destinations), SUCCEED
    // + cleanup_failed (record + STOP), or FAIL with skip/timeout/redirect/
    // abort (record + CONTINUE or STOP, depending on whether cleanup verified
    // and whether the failure was an explicit abort). The state machine
    // lives in `runCaptureStep`; the outer loop only branches on its
    // outcome.
    if (entry.source.kind === "capture" && prior?.ref === undefined) {
      const ctx: CaptureStepContext = {
        state,
        batchId,
        step_idx: entryIdx,
        step_total: stepTotal,
      };
      let outcome: CaptureStepOutcome;
      try {
        outcome = await runCaptureStep(entry, deps, ctx);
      } catch (e) {
        // Defensive: runCaptureStep is supposed to translate every failure
        // mode into a CaptureStepOutcome. An unexpected throw here means
        // something we didn't anticipate; record it as a generic source-step
        // failure (matching the pre-C11 catch shape) and continue to the
        // next entry so the batch can finish partial-success.
        const errorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
        const message = e instanceof Error ? e.message : String(e);
        state.step_results[entry.secret] = { ok: false, error_code: errorCode, message };
        await writeDaemonAudit({
          action: "bootstrap_step",
          ok: false,
          ref: entry.ref,
          batch_id: state.batch_id,
          source_kind: entry.source.kind,
          destination_shorthands: entry.destinations.map((d) => d.shorthand),
          destinations_ok_count: 0,
          destinations_failed_count: entry.destinations.length,
          error_code: errorCode,
        });
        await store.save(state);
        continue;
      }

      if (outcome.kind === "ref") {
        // Fall through to the destination-running path with the captured ref.
        // We inline the same merge logic the legacy path uses so capture
        // entries play correctly with the R5 retry semantics (destinations
        // that previously succeeded must not be re-pushed).
        try {
          const ref = outcome.ref;
          const priorDestinations = prior?.destinations_pushed ?? [];
          const successfulPriorByShorthand = new Map<
            string,
            { destination: string; ok: boolean; error_code?: string; message?: string }
          >();
          for (const p of priorDestinations) {
            if (p.ok === true) successfulPriorByShorthand.set(p.destination, p);
          }
          const destinationsToAttempt = entry.destinations.filter(
            (d) => !successfulPriorByShorthand.has(d.shorthand),
          );
          const newAttempts = await runDestinationSteps(destinationsToAttempt, ref, deps, authority);
          const merged: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = entry.destinations.map(
            (d) => successfulPriorByShorthand.get(d.shorthand) ?? newAttempts.find((n) => n.destination === d.shorthand)!,
          );
          const anyDestFailed = merged.some((d) => !d.ok);
          state.step_results[entry.secret] = {
            ok: !anyDestFailed,
            ref,
            destinations_pushed: merged,
            ...(anyDestFailed ? { error_code: "destination_partial_failure" } : {}),
          };
          await writeDaemonAudit({
            action: "bootstrap_step",
            ok: !anyDestFailed,
            ref,
            batch_id: state.batch_id,
            source_kind: entry.source.kind,
            destination_shorthands: entry.destinations.map((d) => d.shorthand),
            destinations_ok_count: merged.filter((d) => d.ok).length,
            destinations_failed_count: merged.filter((d) => !d.ok).length,
          });
        } catch (e) {
          // A destination failure here is recorded the same way the legacy
          // path's catch block did. The ref is preserved so the R5 retry
          // path can skip the source step on the next /continue.
          const errorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
          const message = e instanceof Error ? e.message : String(e);
          state.step_results[entry.secret] = {
            ok: false,
            error_code: errorCode,
            message,
            ref: outcome.ref,
          };
          await writeDaemonAudit({
            action: "bootstrap_step",
            ok: false,
            ref: outcome.ref,
            batch_id: state.batch_id,
            source_kind: entry.source.kind,
            destination_shorthands: entry.destinations.map((d) => d.shorthand),
            destinations_ok_count: 0,
            destinations_failed_count: entry.destinations.length,
            error_code: errorCode,
          });
        }
        await store.save(state);
        continue;
      }

      // continueWith / stopWith / stopAbandoned all record step_result + audit;
      // stopWith and stopAbandoned additionally halt the loop. stopAbandoned
      // also flips state.status — but state.status MUST stay "in_progress"
      // until the loop exits, because the outer finalisation below sets the
      // terminal status. We stash the abandonment intent in a local flag.
      state.step_results[entry.secret] = outcome.stepResult;
      await writeDaemonAudit({
        action: "bootstrap_step",
        ok: false,
        ref: entry.ref,
        batch_id: state.batch_id,
        source_kind: entry.source.kind,
        destination_shorthands: entry.destinations.map((d) => d.shorthand),
        destinations_ok_count: 0,
        destinations_failed_count: entry.destinations.length,
        error_code: outcome.stepResult.error_code ?? "unexpected_error",
      });
      await store.save(state);

      if (outcome.kind === "continueWith") continue;

      // STOP: record terminal state and exit the loop without processing more
      // entries. stopAbandoned sets status=abandoned (C8); stopWith leaves the
      // batch in failed_partial so /continue can retry per R5 once the
      // operator clears blind mode. The outer finalisation block can't run
      // here because we return early, so we set the terminal status inline.
      if (outcome.kind === "stopAbandoned") {
        state.status = "abandoned";
      } else {
        // stopWith — record failed_partial so the batch surface reads as a
        // terminal failure the user can act on (clear blind, retry).
        state.status = "failed_partial";
      }
      await store.save(state);
      return summarize(state);
    }

    try {
      // Reuse prior ref if the source step already completed in an earlier run.
      // This makes destination-only retries safe: we don't re-call
      // generateSecretCore (which would either throw secret_exists or, with
      // --force, clobber a value that downstream destinations may have already
      // consumed correctly).
      const ref =
        prior?.ref !== undefined
          ? prior.ref
          : await runSourceStep(entry, deps, authority);

      // Carry forward any destinations that previously succeeded — they must NOT
      // be re-pushed. Run only the destinations that previously failed or were
      // never attempted.
      const priorDestinations = prior?.destinations_pushed ?? [];
      const successfulPriorByShorthand = new Map<
        string,
        { destination: string; ok: boolean; error_code?: string; message?: string }
      >();
      for (const p of priorDestinations) {
        if (p.ok === true) successfulPriorByShorthand.set(p.destination, p);
      }
      const destinationsToAttempt = entry.destinations.filter(
        (d) => !successfulPriorByShorthand.has(d.shorthand),
      );
      const newAttempts = await runDestinationSteps(destinationsToAttempt, ref, deps, authority);

      // Merge in the ORDER from entry.destinations so downstream consumers see a
      // consistent shape across runs.
      const merged: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = entry.destinations.map(
        (d) => successfulPriorByShorthand.get(d.shorthand) ?? newAttempts.find((n) => n.destination === d.shorthand)!,
      );

      const anyDestFailed = merged.some((d) => !d.ok);
      state.step_results[entry.secret] = {
        ok: !anyDestFailed,
        ref,
        destinations_pushed: merged,
        ...(anyDestFailed ? { error_code: "destination_partial_failure" } : {}),
      };
      await writeDaemonAudit({
        action: "bootstrap_step",
        ok: !anyDestFailed,
        ref,
        batch_id: state.batch_id,
        source_kind: entry.source.kind,
        destination_shorthands: entry.destinations.map((d) => d.shorthand),
        destinations_ok_count: merged.filter((d) => d.ok).length,
        destinations_failed_count: merged.filter((d) => !d.ok).length,
      });
    } catch (e) {
      const errorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      const message = e instanceof Error ? e.message : String(e);
      // If we already had a ref from a prior run, preserve it so subsequent
      // retries can still reuse it (don't reset to the source step on a third try).
      state.step_results[entry.secret] = {
        ok: false,
        error_code: errorCode,
        message,
        ...(prior?.ref !== undefined ? { ref: prior.ref } : {}),
        ...(prior?.destinations_pushed !== undefined ? { destinations_pushed: prior.destinations_pushed } : {}),
      };
      await writeDaemonAudit({
        action: "bootstrap_step",
        ok: false,
        ref: prior?.ref ?? entry.ref,
        batch_id: state.batch_id,
        source_kind: entry.source.kind,
        destination_shorthands: entry.destinations.map((d) => d.shorthand),
        destinations_ok_count: 0,
        destinations_failed_count: entry.destinations.length,
        error_code: errorCode,
      });
    }
    await store.save(state);
  }

  const summary = summarize(state);
  // C11: preserve a terminal "abandoned" status if the capture branch set it.
  // Otherwise classify as completed / failed_partial the usual way. Cast via
  // `as string` so TS doesn't narrow status to the "in_progress" literal
  // assigned at the top of the function — runCaptureStep / its return-early
  // branch may have set it to "abandoned" during the walk.
  if ((state.status as string) !== "abandoned") {
    state.status = summary.failed > 0 ? "failed_partial" : "completed";
  }
  await store.save(state);
  return summary;
}

async function runSourceStep(
  entry: PlanEntry,
  deps: ExecutorDeps,
  authority: BootstrapAuthority,
): Promise<string> {
  if (entry.source.kind === "existing") {
    // No generation needed — the ref already exists in the vault.
    return entry.source.ref!;
  }

  if (entry.source.kind === "random_32_bytes" || entry.source.kind === "random_64_bytes") {
    const result = await deps.generateSecret(
      deps.services,
      deps.daemonPortRef,
      {
        name: entry.secret,
        environment: refEnvFromRef(entry.ref),
        source: refSourceFromRef(entry.ref),
        kind: entry.source.kind,
        allowedDomains: entry.destinations.map((d) => d.domain),
        ...(entry.force === true ? { force: true } : {}),
      },
      { bootstrapAuthority: authority },
    );
    return result.secret_ref;
  }

  if (entry.source.kind === "capture") {
    // C11: capture entries are handled by `runCaptureStep` in the outer loop.
    // This branch is reachable only if a caller invokes runSourceStep directly
    // (e.g. legacy code paths or tests pre-dating C11) — fail closed instead
    // of silently delegating to the now-removed revealCapture dep.
    throw new ShuttleError(
      "bootstrap_plan_invalid",
      `capture source for ${entry.secret} must go through runCaptureStep — caller bypassed the state machine`,
    );
  }

  throw new ShuttleError(
    "bootstrap_plan_invalid",
    `unknown source.kind: ${(entry.source as { kind: string }).kind}`,
  );
}

/**
 * Capture branch state machine (C11). See CaptureStepOutcome for the five
 * possible outcomes. The function is responsible for:
 *
 *   1. Pre-flight: blind.start + disableObservationDomains + severAgentConnections
 *      BEFORE openCaptureTarget (so a navigation racing the open can't leak
 *      observation events).
 *   2. Open the capture target via C6's `openCaptureTarget`.
 *   3. Mint the capture_token (32 random bytes, base64url).
 *   4. **Synchronously** register a pending-captures entry → Promise.
 *   5. Emit the bootstrap-capture-step SSE event (HubBroker stub for C11; the
 *      real wire format lands in C14).
 *   6. Await the Promise. Resolves with { value, field_fingerprint } on UI
 *      submission; rejects on skip/timeout/abort/redirect.
 *   7. Always cleanup via cleanupCaptureTarget (blank → verify → close → verify).
 *   8. Branch on (outcome, verified):
 *      - success + verified  → blind.end, audit blind_auto_resume, vault upsert,
 *                              return { kind:"ref", ref }
 *      - success + !verified → leave blind active, audit blind_remained_active,
 *                              return { kind:"stopWith", cleanup_failed }
 *      - failure (skip/timeout/redirect) + verified → blind.end, continue
 *      - failure abort + verified → blind.end, stopAbandoned
 *      - failure any + !verified → leave blind active, stopWith (and
 *                                   stopAbandoned if the failure was abort)
 *
 * The CRITICAL ORDERING is register → emit → await:
 *   - The UI cannot resolve the Promise without seeing the capture_token,
 *     which it receives via the SSE event.
 *   - If we awaited BEFORE emitting, the UI would never see the event and
 *     the Promise would deadlock until the 5-minute registry timeout fired.
 *   - If we emitted BEFORE registering, the UI could POST to the
 *     tokenized raw routes (C13) before the entry existed in the registry,
 *     racing into a 404.
 *
 * register() is synchronous (returns the Promise immediately, see C7
 * pending-captures.ts) so the three steps land in this exact order
 * deterministically.
 */
async function runCaptureStep(
  entry: PlanEntry,
  deps: ExecutorDeps,
  ctx: CaptureStepContext,
): Promise<CaptureStepOutcome> {
  const url = entry.source.url;
  if (typeof url !== "string" || url === "") {
    throw new ShuttleError(
      "bootstrap_plan_invalid",
      `capture source for ${entry.secret} has no url`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ShuttleError(
      "bootstrap_capture_url_invalid",
      `capture source url is not a valid URL: ${url}`,
    );
  }
  const expectedHost = parsed.hostname.toLowerCase().replace(/\.$/, "");

  const { services } = deps;
  const browserSession = services.browserSession;
  if (browserSession === null) {
    // The /continue route (C12) is responsible for ensuring a browser session
    // exists before invoking the executor. If we hit here, the caller skipped
    // that contract.
    throw new ShuttleError(
      "bootstrap_plan_invalid",
      `bootstrap capture for ${entry.secret} requires a browser session — none active`,
    );
  }
  const cdp = browserSession.cdp;

  // ── Step 1: pre-flight ──────────────────────────────────────────────────
  // blind.start FIRST so any racing CDP events are dropped by the proxy from
  // this moment forward. disableObservationDomains second, severAgentConnections
  // third. ORDER MATTERS — the spec calls this out explicitly. Inject/inject_submit
  // in api/routes use the identical sequence (see secrets.ts:433-437).
  services.blind.start(expectedHost, "bootstrap-capture");
  await disableObservationDomains(cdp).catch(() => undefined);
  browserSession.proxy?.severAgentConnections();

  // ── Step 2: open capture target ─────────────────────────────────────────
  // From here on, ANY exit path MUST run cleanupCaptureTarget. We track the
  // target_id so the cleanup helper can blank → close it. If openCaptureTarget
  // itself throws, no target exists yet — fail closed without cleanup.
  let target_id: string;
  try {
    const opened = await openCaptureTarget(cdp, url);
    target_id = opened.target_id;
  } catch (e) {
    // No target opened → no cleanup needed. But we DID start blind mode in
    // step 1, so we must end it before propagating: this open failure is a
    // pre-write fault (no secret can be on the page) and the spec's
    // safe-to-auto-resume rule applies (mirrors secrets.ts inject's
    // pre-write catch at line 446-451). The outer catch in executeBatch will
    // record the error code and continue to the next plan entry.
    services.blind.end();
    throw e;
  }

  // Declarations shared by both recipe and human-pending paths.  Moved up so
  // the recipe branch can set `captured` and fall through to the same cleanup
  // + state machine below.
  let captured: { value: string; field_fingerprint: string } | null = null;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;

  // ── Step 3 (recipe path): attempt hands-off recipe capture ──────────────
  // If a recipe exists for this host AND the source kind is "capture" (not
  // human_paste, which Task 10 adds), run the recipe state machine.  On an
  // outcome (page-state or secret-bearing failure), attemptRecipeCapture owns
  // the tab/blind lifecycle and returns a ready CaptureStepOutcome.  On a
  // value, fall through to Steps 6-7 so cleanup + vault upsert reuse the
  // existing vetted path.
  const captureRecipe = (deps.recipes ?? recipeRegistry).getCapture(expectedHost);
  if (entry.source.kind === "capture" && captureRecipe !== undefined) {
    const r = await attemptRecipeCapture(captureRecipe, {
      browser: browserSession.browser,
      cdp,
      target_id,
      expectedHost,
      services,
      entry,
      // Inject the real cleanupCaptureTarget as a closure so recipe-capture.ts
      // does not need to import the private function.
      cleanupCaptureTarget: (tid: string) => cleanupCaptureTarget(cdp, tid),
    });
    if (r.kind === "outcome") return r.outcome;
    captured = { value: r.value, field_fingerprint: r.field_fingerprint };
  } else {
    // ── Step 3-5: register → emit → await (human-pending / no-recipe path) ──
    const capture_token = randomBytes(32).toString("base64url");

    // The registry timeout is 5 minutes per the spec (and the C7 default in
    // the tests). When it fires it rejects the Promise with bootstrap_capture_timeout.
    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    // SYNCHRONOUS register: returns the Promise without awaiting. This is what
    // makes the "register THEN emit THEN await" ordering tractable — there is
    // no microtask between register's return and the SSE emit, so the UI
    // cannot race the registry.
    const pending = services.pendingCaptures.register({
      batchId: ctx.batchId,
      secretName: entry.secret,
      capture_token,
      target_id,
      expected_host: expectedHost,
      owner_agent_id: ctx.state.owner_agent_id,
      timeoutMs: FIVE_MINUTES_MS,
      onTimeout: () => {
        // Side-channel hook for audit-on-timeout. We don't need extra work here
        // because the registry rejects the Promise we await — the failure path
        // below covers the timeout case the same way as any other rejection.
      },
    });

    services.hubBroker.emitBootstrapCaptureStep({
      batch_id: ctx.batchId,
      secret_name: entry.secret,
      url,
      step_idx: ctx.step_idx,
      step_total: ctx.step_total,
      capture_token,
    }, deps.daemonPortRef());

    try {
      captured = await pending;
    } catch (e) {
      captured = null;
      if (e instanceof ShuttleError) {
        failureCode = e.code;
        failureMessage = e.message;
      } else {
        failureCode = "bootstrap_capture_aborted";
        failureMessage = e instanceof Error ? e.message : String(e);
      }
    } finally {
      // Drop the pending hub event regardless of outcome — this is the single
      // authoritative settle point for ALL FIVE state-machine branches
      // (success+verified, success+cleanup_failed, skip, timeout, abort,
      // redirect). Token-guarded inside the broker so a rapid-fire next emit
      // (different capture_token) is not accidentally cleared.
      //
      // Without this, a stale capture_step event would replay on hub
      // reattach and the UI's capture-mode iframe-hide would MASK any fresh
      // `navigate` event for an unrelated operation. The previous "Option C
      // (don't clear)" trade-off only considered stale button presses 404'ing
      // — it missed the iframe-mask interaction.
      services.hubBroker.clearBootstrapCaptureStep(capture_token);
    }
  }

  // ── Step 6: cleanup ─────────────────────────────────────────────────────
  const { verified } = await cleanupCaptureTarget(cdp, target_id);

  // ── Step 7: state machine ───────────────────────────────────────────────
  if (captured !== null && verified) {
    // SUCCESS + verified → safe to auto-resume blind and write to the vault.
    services.blind.end();
    await writeDaemonAudit({
      action: "blind_auto_resume",
      ok: true,
      ref: entry.ref,
      domain: expectedHost,
      op: "bootstrap-capture",
      success_signal: "bootstrap_capture_verified_clean",
    });
    const meta = await services.vault.upsertSecret({
      name: entry.secret,
      environment: refEnvFromRef(entry.ref),
      source: refSourceFromRef(entry.ref),
      // Bootstrap capture string boundary — wrap into a SecretValue the vault
      // OWNS + disposes (Burst 7 §2 / 5q).
      value: SecretValue.fromUtf8(captured.value),
      allowedDomains: entry.destinations.map((d) => d.domain),
      ...(entry.force === true ? { force: true } : {}),
    });
    return { kind: "ref", ref: meta.ref };
  }

  if (captured !== null && !verified) {
    // SUCCESS + cleanup not verified → blind stays active; record + STOP.
    await writeDaemonAudit({
      action: "blind_auto_resume",
      ok: false,
      ref: entry.ref,
      domain: expectedHost,
      op: "bootstrap-capture",
      error_code: "bootstrap_capture_cleanup_failed",
      message: `target ${target_id} could not be verified clean after capture`,
    });
    return {
      kind: "stopWith",
      stepResult: {
        ok: false,
        // Intentionally OMIT ref: even though capture succeeded, the failed
        // cleanup means we did NOT write the value to the vault (we never
        // got to the vault.upsertSecret branch), so there is no ref to
        // surface. A future retry must re-do the capture from scratch.
        error_code: "bootstrap_capture_cleanup_failed",
        message: `Capture for ${entry.secret} succeeded but the source tab could not be verified clean; blind mode kept active.`,
      },
    };
  }

  // From here on, captured === null. failureCode/Message are set.
  const code = failureCode ?? "bootstrap_capture_aborted";
  const message = failureMessage ?? "";

  if (!verified) {
    // FAILURE + cleanup not verified → blind stays active, record cleanup_failed.
    // If the underlying failure was an abort, propagate the abandoned status
    // through stopAbandoned; otherwise it's a stopWith.
    await writeDaemonAudit({
      action: "blind_auto_resume",
      ok: false,
      ref: entry.ref,
      domain: expectedHost,
      op: "bootstrap-capture",
      error_code: "bootstrap_capture_cleanup_failed",
      message: `failure ${code} + cleanup not verified; target ${target_id}`,
    });
    const stepResult: import("./store.js").StepResult = {
      ok: false,
      error_code: "bootstrap_capture_cleanup_failed",
      message: `Capture for ${entry.secret} failed (${code}) and the source tab could not be verified clean; blind mode kept active.`,
    };
    if (code === "bootstrap_capture_aborted") {
      return { kind: "stopAbandoned", stepResult };
    }
    return { kind: "stopWith", stepResult };
  }

  // FAILURE + verified. Branch on the failure reason: abort STOPs (with
  // abandoned status); everything else CONTINUEs (R5 retry rules govern
  // re-attempt on the next /continue).
  services.blind.end();
  if (code === "bootstrap_capture_aborted") {
    await writeDaemonAudit({
      action: "blind_auto_resume",
      ok: true,
      ref: entry.ref,
      domain: expectedHost,
      op: "bootstrap-capture",
      error_code: code,
      message,
    });
    return {
      kind: "stopAbandoned",
      stepResult: {
        ok: false,
        error_code: code,
        message,
      },
    };
  }
  await writeDaemonAudit({
    action: "blind_auto_resume",
    ok: true,
    ref: entry.ref,
    domain: expectedHost,
    op: "bootstrap-capture",
    error_code: code,
    message,
  });
  return {
    kind: "continueWith",
    stepResult: {
      ok: false,
      error_code: code,
      message,
    },
  };
}

async function runDestinationSteps(
  destinations: ResolvedDestination[],
  ref: string,
  deps: ExecutorDeps,
  authority: BootstrapAuthority,
): Promise<Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>> {
  const results: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = [];
  for (const dest of destinations) {
    if (dest.kind === "browser_inject") {
      const recipe = (deps.recipes ?? recipeRegistry).getInject(dest.recipe_host);
      if (recipe === undefined) {
        results.push({ destination: dest.shorthand, ok: false, error_code: "recipe_not_found", message: `no inject recipe for ${dest.recipe_host}` });
        continue;
      }
      const r = await runBrowserInject(recipe, ref, deps);
      results.push({ destination: dest.shorthand, ok: r.ok, ...(r.error_code ? { error_code: r.error_code } : {}), ...(r.message ? { message: r.message } : {}) });
      continue;
    }
    // dest.kind === "template" — existing CLI push (unchanged)
    try {
      const result = await deps.runTemplate(
        deps.services,
        deps.daemonPortRef,
        {
          templateId: dest.template_id,
          ref,
          params: dest.template_params,
        },
        { bootstrapAuthority: authority },
      );
      if (result.exit_code !== 0) {
        results.push({
          destination: dest.shorthand,
          ok: false,
          error_code: "template_exec_failed",
          message: `template ${dest.template_id} exited with code ${result.exit_code}`,
        });
      } else {
        results.push({ destination: dest.shorthand, ok: true });
      }
    } catch (e) {
      results.push({
        destination: dest.shorthand,
        ok: false,
        error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** Extract vault source name from a ss:// ref (ss://<source>/<env>/<name>). */
function refSourceFromRef(ref: string): string {
  const m = ref.match(/^ss:\/\/([^/]+)\/[^/]+\/[^/]+$/);
  return m?.[1] ?? "local";
}

/**
 * Extract environment from a ss:// ref and expand short aliases.
 * ss://<source>/<env>/<name> — maps prod→production, dev→development, etc.
 */
function refEnvFromRef(ref: string): string {
  const m = ref.match(/^ss:\/\/[^/]+\/([^/]+)\/[^/]+$/);
  const short = m?.[1];
  // Canonicalise via the shared helper so we accept every alias that
  // vault.upsertSecret + canonicalEnvironment recognise.
  return canonicalEnvironment(short ?? "production");
}

function summarize(state: BatchState): ExecuteResult {
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
