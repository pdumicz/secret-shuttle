// src/daemon/recipes/page-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPageState, recheckPageScope, runPreSteps } from "./page-state.js";
import type { RecipeBase } from "./types.js";
import { isShuttleError } from "../../shared/errors.js";

const base: RecipeBase = {
  host: "example.com", url: "https://example.com/x", logged_in_probe: "[data-in]",
  page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]", ready_timeout_ms: 50,
};

// Fake BrowserOps recording selector presence; `present` is a set of selectors that "exist".
function fakeBrowser(present: Set<string>, host = "example.com") {
  return {
    waitForSelector: async (_t: string, sel: string) => present.has(sel),
    selectorMatchCount: async (_t: string, sel: string) => (present.has(sel) ? 1 : 0),
    documentHost: async () => host,
    resolveSelectorToHandle: async (_t: string, sel: string) => {
      if (!present.has(sel)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous" });
      return { target_id: _t, backend_node_id: 1, fingerprint: "fp" };
    },
    clickBackendNode: async () => undefined,
  } as any;
}

test("page_ready_probe never appears => timeout", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set()), "t", base), "timeout");
});
test("logged_out_marker present => logged_out", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]", "[data-login]"])), "t", base), "logged_out");
});
test("loaded, not logged-out, logged_in_probe absent => unexpected", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]"])), "t", base), "unexpected");
});
test("loaded + logged_in_probe present => ready", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]", "[data-in]"])), "t", base), "ready");
});

test("recheck aborts recipe_page_unexpected when scope probe lost on same host", async () => {
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-shell]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});
test("recheck aborts bootstrap_login_required when logged_out_marker appears", async () => {
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-shell]", "[data-login]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_login_required");
});
test("recheck aborts recipe_page_timeout when page_ready_probe is lost (full staged check, §142)", async () => {
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-in]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_timeout");
});
test("recheck aborts recipe_page_unexpected when off-host", async () => {
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-in]"]), "evil.com"), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});

test("pre-step click that lands wrong scope aborts before any reveal", async () => {
  const present = new Set(["nav-link", "[data-shell]"]); // logged_in_probe MISSING after the click
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "click", selector: "nav-link" }] };
  await assert.rejects(() => runPreSteps(fakeBrowser(present), "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});

test("pre-step that drops page_ready_probe aborts recipe_page_timeout after the step (§142)", async () => {
  const present = new Set(["nav-link", "[data-in]"]); // [data-shell] MISSING after the click
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "click", selector: "nav-link" }] };
  await assert.rejects(() => runPreSteps(fakeBrowser(present), "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_timeout");
});

test("ambiguous (>1) wait_for selector errors recipe_selector_ambiguous; no reveal runs", async () => {
  const ambiguousBrowser = {
    ...fakeBrowser(new Set(["[data-shell]", "[data-in]"])),
    waitForSelector: async () => true,
    selectorMatchCount: async (_t: string, sel: string) => (sel === "dupes" ? 2 : 1),
  } as any;
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "wait_for", selector: "dupes" }] };
  await assert.rejects(() => runPreSteps(ambiguousBrowser, "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous");
});
