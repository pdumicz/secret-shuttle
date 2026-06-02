// src/daemon/bootstrap/recipe-inject.ts
import { ShuttleError } from "../../shared/errors.js";
import { disableObservationDomains } from "../chrome/internal-ops.js";
import {
  openCaptureTarget,
  cleanupCaptureTarget,
} from "../chrome/capture-target-ops.js";
import { injectWithSuccessGate } from "../chrome/secret-gates.js";
import { detectPageState, pageStateError, recheckPageScope, runPreSteps } from "../recipes/page-state.js";
import { interpolateUrl } from "../recipes/url-template.js";
import type { InjectRecipe } from "../recipes/types.js";
import type { CdpClient } from "../chrome/cdp-client.js";
import type { ResolvedDestination } from "./store.js";

type BrowserInjectDest = Extract<ResolvedDestination, { kind: "browser_inject" }>;

const PAGE_STATE_CODES = new Set(["bootstrap_login_required", "recipe_page_timeout", "recipe_page_unexpected"]);
const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000; // mirror inject-submit.ts

/**
 * Run `cleanupCaptureTarget`, never throw, and decide what to do with blind.
 *
 * Mirrors the verified-aware cleanup the capture-recipe path in
 * `recipe-capture.ts` already performs. A throwing cleanup is treated as
 * `verified: false` (fail-closed) — the same semantics the helper itself
 * documents. When `verified === true` the caller may end blind; when not, the
 * caller MUST leave blind active so a residual on-page value can't be observed
 * by a resumed agent. Returns the reason string for audit/diagnostic use when
 * cleanup itself rejected (otherwise `null`).
 */
async function cleanupAndEndBlind(
  cleanup: (cdp: CdpClient, targetId: string) => Promise<{ verified: boolean }>,
  cdp: CdpClient,
  targetId: string,
  endBlind: () => void,
): Promise<{ verified: boolean; cleanupReason: string | null }> {
  const result = await cleanup(cdp, targetId).then(
    (r) => ({ verified: r.verified, cleanupReason: null as string | null }),
    (err: unknown) => ({
      verified: false,
      cleanupReason: err instanceof Error ? err.message : String(err),
    }),
  );
  if (result.verified) {
    // Tab proven closed/blank — safe to resume.
    endBlind();
  }
  // If unverified: caller's outer cleanup leaves blind active. The bootstrap
  // browser teardown (stopBootstrapBrowser in bootstrap.ts /continue finally)
  // will kill the rendering process and the post-stop hook there ends blind.
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBrowserInject(recipe: InjectRecipe, dest: BrowserInjectDest, ref: string, deps: any): Promise<{ ok: boolean; error_code?: string; message?: string }> {
  // INTERPOLATE FIRST — before any side-effect. Convert the helper's throw into a
  // structured per-destination failure so the destination loop continues.
  let interpolatedUrl: string;
  try {
    interpolatedUrl = interpolateUrl(recipe.url, dest.url_params ?? {});
  } catch (e) {
    if (e instanceof ShuttleError && e.code === "recipe_url_params_missing") {
      return { ok: false, error_code: e.code, message: e.message };
    }
    throw e;
  }

  const { services } = deps;
  const browserSession = services.browserSession;
  if (browserSession === null || browserSession === undefined) {
    return { ok: false, error_code: "bootstrap_plan_invalid", message: "browser_inject requires a browser session." };
  }
  const browser = browserSession.browser;
  const cdp = browserSession.cdp;
  const open: (cdp: CdpClient, url: string) => Promise<{ target_id: string }> = deps.openCaptureTarget ?? openCaptureTarget;
  const cleanup: (cdp: CdpClient, target_id: string) => Promise<{ verified: boolean }> = deps.cleanupCaptureTarget ?? cleanupCaptureTarget;
  const disableObservationDomainsImpl: (cdp: CdpClient) => Promise<void> = deps.disableObservationDomains ?? disableObservationDomains;

  services.blind.start(recipe.host, "browser_inject");
  await disableObservationDomainsImpl(cdp).catch(() => undefined);
  browserSession.proxy?.severAgentConnections();

  let target_id: string;
  try {
    target_id = (await open(cdp, interpolatedUrl)).target_id;
  } catch (e) {
    services.blind.end();
    return { ok: false, error_code: e instanceof ShuttleError ? e.code : "unexpected_error", message: e instanceof Error ? e.message : String(e) };
  }

  let resolved: { value: { bytes: () => Buffer; dispose: () => void } } | undefined;
  try {
    const state = await detectPageState(browser, target_id, recipe);
    if (state !== "ready") {
      services.blind.end();
      const err = pageStateError(state, recipe);
      return { ok: false, error_code: err.code, message: err.message };
    }
    await runPreSteps(browser, target_id, recipe);
    await recheckPageScope(browser, target_id, recipe);

    const fieldRef = await browser.resolveSelectorToHandle(target_id, recipe.field_selector);
    const submitRef = await browser.resolveSelectorToHandle(target_id, recipe.submit_selector);

    resolved = await services.vault.resolveSecret(ref);

    // Single factory — all three sinks (gate's inject, gate's proveAbsence, and the
    // no-success-text proveAbsence below) call through here so bytes() is exercised
    // consistently and the getValue contract in InjectGateArgs is honoured.
    const getValue = () => resolved!.value.bytes().toString("utf8");

    let gate: { successObserved: boolean; proofPassed: boolean };
    try {
      gate = await injectWithSuccessGate(browser, {
        fieldRef: { target_id: fieldRef.target_id, backend_node_id: fieldRef.backend_node_id },
        submitRef: { target_id: submitRef.target_id, backend_node_id: submitRef.backend_node_id },
        getValue,
        domain: recipe.host,
        successText: recipe.success_text,
        successTimeoutMs: SUCCESS_TIMEOUT_DEFAULT_MS,
      });
    } catch {
      // Inject/click failed or timed out — secret may be on page. §6: close tab + try
      // to end blind, but honor cleanupCaptureTarget(...).verified. If cleanup couldn't
      // prove the tab is closed/blank, blind STAYS ACTIVE so the caller's bootstrap
      // browser teardown can kill the rendering process before the agent resumes.
      await services.vault.markUsed(ref).catch(() => undefined);
      const { verified, cleanupReason } = await cleanupAndEndBlind(cleanup, cdp, target_id, () => services.blind.end());
      const cleanupSuffix = !verified
        ? ` (cleanup unverified${cleanupReason !== null ? `: ${cleanupReason}` : ""}; blind kept active for bootstrap-browser teardown)`
        : "";
      return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host} failed before success confirmation; retryable.${cleanupSuffix}` };
    }

    await services.vault.markUsed(ref).catch(() => undefined);

    if (gate.successObserved && gate.proofPassed) {
      // Success path: tab MUST be proven closed/blank before blind ends. An
      // unverified cleanup means the rendered value could still be on the page;
      // blind STAYS ACTIVE (fail-closed) and the outer bootstrap-browser
      // teardown kills the renderer + auto-resumes blind via the post-stop hook.
      const { verified, cleanupReason } = await cleanupAndEndBlind(cleanup, cdp, target_id, () => services.blind.end());
      if (verified) return { ok: true };
      return {
        ok: false,
        error_code: "bootstrap_capture_cleanup_failed",
        message: `Inject to ${recipe.host} succeeded but post-inject cleanup did not verify the tab clean${cleanupReason !== null ? `: ${cleanupReason}` : ""}; blind kept active for bootstrap-browser teardown.`,
      };
    }
    // submit ran but no success_text — proveAbsence (best-effort), then close + honor verified.
    const proof = await browser.proveAbsence(getValue()).catch(() => ({ passed: false }));
    const { verified, cleanupReason } = await cleanupAndEndBlind(cleanup, cdp, target_id, () => services.blind.end());
    const cleanupSuffix = !verified
      ? ` (cleanup unverified${cleanupReason !== null ? `: ${cleanupReason}` : ""}; blind kept active for bootstrap-browser teardown)`
      : "";
    return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host}: success text not observed (absence_proof ${proof.passed ? "passed" : "failed"}). Retryable.${cleanupSuffix}` };
  } catch (e) {
    const code = e instanceof ShuttleError ? e.code : "recipe_inject_failed";
    if (PAGE_STATE_CODES.has(code)) {
      // §6 page-state class: nothing was typed, leave the visible tab OPEN as the
      // documented recovery surface (the user is told to log in / inspect the
      // open window). End blind so the agent can resume onto pages OTHER than the
      // page-state tab (the visible recovery tab will be killed by the outer
      // bootstrap-browser teardown only if no page-state failure remains).
      services.blind.end();
      return { ok: false, error_code: code, message: e instanceof Error ? e.message : String(e) };
    }
    // Selector ambiguous / other secret-bearing failures: nothing was typed, but
    // the page may have rendered a sensitive value before resolution. Close the
    // tab and honor cleanup.verified — unverified leaves blind active so the
    // bootstrap-browser teardown can kill the renderer first.
    const { verified, cleanupReason } = await cleanupAndEndBlind(cleanup, cdp, target_id!, () => services.blind.end());
    const baseMessage = e instanceof Error ? e.message : String(e);
    const cleanupSuffix = !verified
      ? ` (cleanup unverified${cleanupReason !== null ? `: ${cleanupReason}` : ""}; blind kept active for bootstrap-browser teardown)`
      : "";
    return { ok: false, error_code: code, message: `${baseMessage}${cleanupSuffix}` };
  } finally {
    resolved?.value.dispose();
  }
}
