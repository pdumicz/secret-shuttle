// src/daemon/recipes/page-state.ts
import { canonicalHost } from "./host.js";
import { ShuttleError } from "../../shared/errors.js"; // match the real path/export
import type { BrowserOps } from "../chrome/internal-ops.js";
import type { RecipeBase } from "./types.js";

export type PageState = "ready" | "logged_out" | "timeout" | "unexpected";

/** §4 staged detection, evaluated in order, BEFORE resolving any recipe selector. */
export async function detectPageState(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<PageState> {
  if (recipe.page_ready_probe !== undefined) {
    const ready = await browser.waitForSelector(targetId, recipe.page_ready_probe, recipe.ready_timeout_ms ?? 10_000);
    if (!ready) return "timeout";
  }
  if (recipe.logged_out_marker !== undefined) {
    if ((await browser.selectorMatchCount(targetId, recipe.logged_out_marker)) >= 1) return "logged_out";
  }
  if ((await browser.selectorMatchCount(targetId, recipe.logged_in_probe)) >= 1) return "ready";
  return "unexpected";
}

/** Map the initial detection enum to the §Error-codes ShuttleError (page-state class). */
export function pageStateError(state: Exclude<PageState, "ready">, recipe: RecipeBase): ShuttleError {
  if (state === "timeout") return new ShuttleError("recipe_page_timeout", `Page never loaded: ${recipe.host} ${recipe.url}.`);
  if (state === "logged_out") return new ShuttleError("bootstrap_login_required", `Log into ${recipe.host} in the open window, then re-run --continue.`);
  return new ShuttleError("recipe_page_unexpected", `Loaded ${recipe.host} but the expected scope was not found (wrong project/team, permission, or onboarding). Inspect the open tab.`);
}

/** §1/§4: full staged page-state revalidation. Runs after each pre-step and immediately
 *  before reveal/inject. This reruns the SAME staged §4 check `detectPageState` performs
 *  (page_ready_probe → logged_out_marker → logged_in_probe) plus a live host check, and
 *  maps any non-`ready` outcome to its distinct page-state-class ShuttleError via
 *  `pageStateError`. It does NOT collapse to a bare logged_in_probe presence test — spec
 *  §142 requires the full staged check (incl. page_ready_probe) after each pre-step so a
 *  page that drifted to a non-loaded/timeout state is surfaced as `recipe_page_timeout`,
 *  not a misleading scope/login error. */
export async function recheckPageScope(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<void> {
  const host = canonicalHost(await browser.documentHost(targetId));
  if (host !== canonicalHost(recipe.host)) {
    throw new ShuttleError("recipe_page_unexpected", `Recipe drifted off-host: now ${host}, expected ${canonicalHost(recipe.host)}.`);
  }
  const state = await detectPageState(browser, targetId, recipe);
  if (state !== "ready") throw pageStateError(state, recipe);
}

/** §1: run pre_steps (navigation only). Each click AND each wait_for is
 *  single-match-or-throw (recipe_selector_ambiguous) — a pre-step never guesses among
 *  matches (spec §103: every pre-step click/wait_for selector must resolve to exactly
 *  one element). After EACH step the full §4 staged scope re-check runs so a same-host
 *  scope drift (or a page-ready loss) aborts before any secret action. Idempotent/
 *  re-runnable by contract (authors' responsibility). */
export async function runPreSteps(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<void> {
  for (const step of recipe.pre_steps ?? []) {
    if (step.action === "wait") {
      await new Promise((r) => setTimeout(r, Math.max(0, step.ms)));
    } else if (step.action === "wait_for") {
      const ok = await browser.waitForSelector(targetId, step.selector, step.timeout_ms ?? 10_000);
      if (!ok) throw new ShuttleError("recipe_selector_ambiguous", `pre-step wait_for never matched: ${step.selector}`);
      const count = await browser.selectorMatchCount(targetId, step.selector);
      if (count !== 1) throw new ShuttleError("recipe_selector_ambiguous", `pre-step wait_for selector matched ${count} elements (need exactly 1): ${step.selector}`);
    } else {
      const ref = await browser.resolveSelectorToHandle(targetId, step.selector);
      await browser.clickBackendNode({ target_id: ref.target_id, backend_node_id: ref.backend_node_id });
    }
    await recheckPageScope(browser, targetId, recipe); // §4 staged re-check after each step
  }
}
