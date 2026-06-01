// src/daemon/bootstrap/recipe-inject.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserInject } from "./recipe-inject.js";
import type { InjectRecipe } from "../recipes/types.js";

const recipe: InjectRecipe = {
  kind: "inject", host: "vercel.test", url: "https://vercel.test/env",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  field_selector: "#val", submit_selector: "#save", success_text: "Saved", ready_timeout_ms: 50,
};

function makeDeps(over: { present: Set<string>; successObserved?: boolean; proofPassed?: boolean; injectThrow?: boolean; openTargetId?: string }) {
  const events: string[] = [];
  const browser = {
    waitForSelector: async (_t: string, s: string) => over.present.has(s),
    selectorMatchCount: async (_t: string, s: string) => (over.present.has(s) ? 1 : 0),
    documentHost: async () => "vercel.test",
    resolveSelectorToHandle: async (_t: string, s: string) => {
      if (!over.present.has(s)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous", name: "ShuttleError" });
      return { target_id: "t", backend_node_id: 1, fingerprint: "fp" };
    },
    injectIntoBackendNode: async () => { if (over.injectThrow) throw new Error("inject boom"); events.push("inject"); return {} as any; },
    clickBackendNode: async () => { events.push("submit"); },
    observeText: async () => over.successObserved ?? false,
    proveAbsence: async () => ({ passed: over.proofPassed ?? false }),
  } as any;
  const blind = { start: () => events.push("blind.start"), end: () => events.push("blind.end") };
  const services = {
    blind,
    vault: { resolveSecret: async () => ({ value: { bytes: () => Buffer.from("v_secret"), dispose: () => undefined } }), markUsed: async () => undefined },
    browserSession: { browser, cdp: {}, proxy: { severAgentConnections: () => undefined } },
  } as any;
  return { events, deps: { services, daemonPortRef: () => 1, openCaptureTarget: async () => ({ target_id: over.openTargetId ?? "t" }), cleanupCaptureTarget: async () => { events.push("cleanup(close)"); return { verified: true }; } } as any };
}

test("success => ok, tab closed, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: true, proofPassed: true });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, true);
  assert.ok(events.includes("cleanup(close)") && events.includes("blind.end"));
});

test("no success_text => recipe_inject_failed, proveAbsence run, blind ended, retryable", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: false });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_inject_failed");
  assert.ok(events.includes("blind.end"));
});

test("login wall => bootstrap_login_required, tab LEFT OPEN, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-login]"]) });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.error_code, "bootstrap_login_required");
  assert.ok(!events.includes("cleanup(close)"));
  assert.ok(events.includes("blind.end"));
});
