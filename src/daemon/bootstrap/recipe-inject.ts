// src/daemon/bootstrap/recipe-inject.ts
import { ShuttleError } from "../../shared/errors.js";
import { disableObservationDomains } from "../chrome/internal-ops.js";
import {
  openCaptureTarget,
  cleanupCaptureTarget,
} from "../chrome/capture-target-ops.js";
import { injectWithSuccessGate } from "../chrome/secret-gates.js";
import { detectPageState, pageStateError, recheckPageScope, runPreSteps } from "../recipes/page-state.js";
import type { InjectRecipe } from "../recipes/types.js";
import type { CdpClient } from "../chrome/cdp-client.js";

const PAGE_STATE_CODES = new Set(["bootstrap_login_required", "recipe_page_timeout", "recipe_page_unexpected"]);
const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000; // mirror inject-submit.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBrowserInject(recipe: InjectRecipe, ref: string, deps: any): Promise<{ ok: boolean; error_code?: string; message?: string }> {
  const { services } = deps;
  const browserSession = services.browserSession;
  if (browserSession === null || browserSession === undefined) {
    return { ok: false, error_code: "bootstrap_plan_invalid", message: "browser_inject requires a browser session." };
  }
  const browser = browserSession.browser;
  const cdp = browserSession.cdp;
  const open: (cdp: CdpClient, url: string) => Promise<{ target_id: string }> = deps.openCaptureTarget ?? openCaptureTarget;
  const cleanup: (cdp: CdpClient, target_id: string) => Promise<{ verified: boolean }> = deps.cleanupCaptureTarget ?? cleanupCaptureTarget;

  services.blind.start(recipe.host, "browser_inject");
  await disableObservationDomains(cdp).catch(() => undefined);
  browserSession.proxy?.severAgentConnections();

  let target_id: string;
  try {
    target_id = (await open(cdp, recipe.url)).target_id;
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

    let gate: { successObserved: boolean; proofPassed: boolean };
    try {
      gate = await injectWithSuccessGate(browser, {
        fieldRef: { target_id: fieldRef.target_id, backend_node_id: fieldRef.backend_node_id },
        submitRef: { target_id: submitRef.target_id, backend_node_id: submitRef.backend_node_id },
        getValue: () => resolved!.value.bytes().toString("utf8"),
        domain: recipe.host,
        successText: recipe.success_text,
        successTimeoutMs: SUCCESS_TIMEOUT_DEFAULT_MS,
      });
    } catch {
      await services.vault.markUsed(ref).catch(() => undefined);
      await cleanup(cdp, target_id).catch(() => undefined);
      services.blind.end();
      return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host} failed before success confirmation; retryable.` };
    }

    await services.vault.markUsed(ref).catch(() => undefined);

    if (gate.successObserved && gate.proofPassed) {
      await cleanup(cdp, target_id).catch(() => undefined);
      services.blind.end();
      return { ok: true };
    }
    const proof = await browser.proveAbsence(resolved!.value.bytes().toString("utf8")).catch(() => ({ passed: false }));
    await cleanup(cdp, target_id).catch(() => undefined);
    services.blind.end();
    return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host}: success text not observed (absence_proof ${proof.passed ? "passed" : "failed"}). Retryable.` };
  } catch (e) {
    const code = e instanceof ShuttleError ? e.code : "recipe_inject_failed";
    if (PAGE_STATE_CODES.has(code)) {
      services.blind.end();
      return { ok: false, error_code: code, message: e instanceof Error ? e.message : String(e) };
    }
    await cleanup(cdp, target_id!).catch(() => undefined);
    services.blind.end();
    return { ok: false, error_code: code, message: e instanceof Error ? e.message : String(e) };
  } finally {
    resolved?.value.dispose();
  }
}
