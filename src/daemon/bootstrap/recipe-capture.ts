// src/daemon/bootstrap/recipe-capture.ts
//
// Recipe-driven hands-off capture (§5 / §170 / §173).
// Consumes a CaptureRecipe, runs the page-state check + transition gate, and
// returns either a captured value (caller falls through to existing cleanup +
// state-machine) or a ready CaptureStepOutcome that owns the full tab/blind
// lifecycle for the failure case.
//
// Lifecycle split (§5):
//   PAGE_STATE_CODES  → blind.end + leave tab open + stopWith (no secret written)
//   SECRET_BEARING    → best-effort hide → cleanup(close) before blind.end + stopWith
//   CLEANUP_REJECTED  → blind STAYS ACTIVE → bootstrap_capture_cleanup_failed (§170)
//   SUCCESS           → return { kind: "value" }; caller runs cleanup + state machine

import { ShuttleError } from "../../shared/errors.js";
import { writeDaemonAudit } from "../audit.js";
import { captureWithTransitionGate, withDeadline } from "../chrome/secret-gates.js";
import { detectPageState, pageStateError, recheckPageScope, runPreSteps } from "../recipes/page-state.js";
import type { CaptureRecipe } from "../recipes/types.js";
import type { BrowserOps, BackendNodeRef } from "../chrome/internal-ops.js";
import type { CaptureStepOutcome } from "./executor.js";

/** Error codes that belong to the page-state class (§5):
 *  blind.end + leave tab open (no secret was revealed). */
const PAGE_STATE_CODES = new Set([
  "bootstrap_login_required",
  "recipe_page_timeout",
  "recipe_page_unexpected",
]);

export type RecipeCaptureResult =
  | { kind: "value"; value: string; field_fingerprint: string }
  | { kind: "outcome"; outcome: CaptureStepOutcome };

export interface RecipeCaptureCtx {
  browser: BrowserOps;
  cdp: unknown; // CdpClient | null
  target_id: string;
  expectedHost: string;
  services: { blind: { end: () => void } };
  entry: { ref: string };
  /** Injectable for tests; production callers omit this and the real
   *  cleanupCaptureTarget from executor.ts is used via the closure passed by
   *  runCaptureStep. */
  cleanupCaptureTarget?: (target_id: string) => Promise<{ verified: boolean }>;
}

/** Secret-bearing pass-through codes: the raw code is surfaced as-is rather than
 *  wrapped under recipe_capture_failed.  Only recipe_selector_ambiguous for now
 *  (a deterministic structural error — not a transient gate failure). */
const SECRET_BEARING_PASSTHROUGH = new Set(["recipe_selector_ambiguous"]);

export async function attemptRecipeCapture(
  recipe: CaptureRecipe,
  ctx: RecipeCaptureCtx,
): Promise<RecipeCaptureResult> {
  const { browser, cdp, target_id, expectedHost, services, entry } = ctx;
  // The real cleanupCaptureTarget is injected by runCaptureStep as a closure
  // so we never import the private executor function directly.
  const cleanup = ctx.cleanupCaptureTarget ?? (async (_tid: string) => ({ verified: false }));
  const captureMode: "field" | "container" = recipe.field_selector !== undefined ? "field" : "container";
  const targetSelector = recipe.field_selector ?? recipe.container_selector!;

  // Stash hideRef so the failure catch can attempt a best-effort hide (§173)
  // before closing the tab.  Resolved only once we reach the pre-reveal phase —
  // if reveal_selector itself fails, hideRef stays undefined and no hide is attempted.
  let hideRef: (BackendNodeRef & { fingerprint: string }) | undefined;

  try {
    // ── §4 Page-state detection (staged: page_ready_probe → logged_out_marker → logged_in_probe) ──
    const state = await detectPageState(browser, target_id, recipe);
    if (state !== "ready") throw pageStateError(state, recipe);

    // ── §1 Pre-steps (navigation only, single-match-or-throw) ──
    await runPreSteps(browser, target_id, recipe);

    // ── §4 Full staged scope recheck after pre-steps ──
    await recheckPageScope(browser, target_id, recipe);

    // ── Resolve handles ── (all must resolve to exactly one element)
    const revealRef = await browser.resolveSelectorToHandle(target_id, recipe.reveal_selector);
    const targetRef = await browser.resolveSelectorToHandle(target_id, targetSelector);
    hideRef = recipe.hide_selector !== undefined
      ? await browser.resolveSelectorToHandle(target_id, recipe.hide_selector)
      : undefined;

    // ── Sample baseline BEFORE reveal ──
    const baselinePre = await browser.baselineCandidates(targetRef);

    // ── Reveal + transition gate + hide (via captureWithTransitionGate) ──
    const revealDeadlineMs = Number(process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS) || 30_000;
    const gate = await withDeadline(
      captureWithTransitionGate(browser, cdp as never, {
        revealRef: { target_id: revealRef.target_id, backend_node_id: revealRef.backend_node_id },
        targetRef: { target_id: targetRef.target_id, backend_node_id: targetRef.backend_node_id },
        captureMode,
        ...(hideRef !== undefined
          ? { hideRef: { target_id: hideRef.target_id, backend_node_id: hideRef.backend_node_id } }
          : {}),
        baselinePre,
      }),
      revealDeadlineMs,
      "recipe_capture_timeout",
    );

    if (gate.value === "") {
      throw new ShuttleError(
        "recipe_capture_failed",
        `Recipe capture for ${recipe.host} produced no hidden→readable transition.`,
      );
    }

    // SUCCESS — return the value; caller owns cleanup + blind.end via the
    // existing executor state machine (tab left open here).
    return { kind: "value", value: gate.value, field_fingerprint: targetRef.fingerprint };
  } catch (e) {
    // Duck-type the code so test mocks that patch `.code` on a plain Error
    // (rather than constructing a real ShuttleError) are handled correctly.
    const rawCode =
      e instanceof ShuttleError
        ? e.code
        : typeof (e as { code?: unknown }).code === "string"
          ? (e as { code: string }).code
          : "recipe_capture_failed";
    const rawMessage = e instanceof Error ? e.message : String(e);

    // ── Page-state class (§5): no secret was on the page ──
    // blind.end + leave tab OPEN (no cleanup here); caller keeps the tab for
    // possible user inspection.
    if (PAGE_STATE_CODES.has(rawCode)) {
      services.blind.end();
      await writeDaemonAudit({
        action: "blind_auto_resume",
        ok: false,
        ref: entry.ref,
        domain: expectedHost,
        op: "recipe-capture",
        error_code: rawCode,
        message: rawMessage,
      });
      return {
        kind: "outcome",
        outcome: { kind: "stopWith", stepResult: { ok: false, error_code: rawCode, message: rawMessage } },
      };
    }

    // ── Secret-bearing class: a reveal was attempted (or a selector ambiguity
    //    on the reveal itself). Close the tab before resuming blind. ──
    const code = SECRET_BEARING_PASSTHROUGH.has(rawCode) ? rawCode : "recipe_capture_failed";
    // Preserve the original code in the message when we wrap under recipe_capture_failed.
    const message = rawCode === code ? rawMessage : `${rawCode}: ${rawMessage}`;

    // §173: best-effort hide BEFORE closing the tab.  Only attempted when
    // hideRef was successfully resolved (i.e. the error happened post-reveal).
    // If reveal_selector itself threw (reveal ambiguous), hideRef is undefined
    // and no hide is attempted.
    if (hideRef !== undefined) {
      await browser
        .clickBackendNode({ target_id: hideRef.target_id, backend_node_id: hideRef.backend_node_id })
        .catch(() => undefined);
    }

    // ── Cleanup (§170): a throwing cleanup must not propagate; blind decision
    //    follows the verified flag, not the cleanup error. ──
    const cleanupResult = await cleanup(target_id).then(
      (r) => ({ verified: r.verified, cleanupReason: null as string | null }),
      (err: unknown) => ({
        verified: false,
        cleanupReason: err instanceof Error ? err.message : String(err),
      }),
    );

    if (cleanupResult.verified) {
      // Tab clean → safe to auto-resume blind.
      services.blind.end();
      await writeDaemonAudit({
        action: "blind_auto_resume",
        ok: false,
        ref: entry.ref,
        domain: expectedHost,
        op: "recipe-capture",
        error_code: code,
        message,
      });
      return {
        kind: "outcome",
        outcome: { kind: "stopWith", stepResult: { ok: false, error_code: code, message } },
      };
    }

    // §170: cleanup failed or rejected → blind STAYS ACTIVE.  Record both the
    // recipe failure code AND the cleanup rejection text so operators can triage.
    const cleanupDetail =
      cleanupResult.cleanupReason !== null
        ? `cleanup rejected: ${cleanupResult.cleanupReason}`
        : "tab not verified clean";
    const cleanupFailedMessage = `${code}: ${cleanupDetail}; blind kept active.`;
    await writeDaemonAudit({
      action: "blind_auto_resume",
      ok: false,
      ref: entry.ref,
      domain: expectedHost,
      op: "recipe-capture",
      error_code: "bootstrap_capture_cleanup_failed",
      message: cleanupFailedMessage,
    });
    return {
      kind: "outcome",
      outcome: {
        kind: "stopWith",
        stepResult: {
          ok: false,
          error_code: "bootstrap_capture_cleanup_failed",
          message: cleanupFailedMessage,
        },
      },
    };
  }
}
