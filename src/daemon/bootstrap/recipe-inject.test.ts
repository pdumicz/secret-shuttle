// src/daemon/bootstrap/recipe-inject.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserInject } from "./recipe-inject.js";
import { disableObservationDomains } from "../chrome/internal-ops.js";
import type { InjectRecipe } from "../recipes/types.js";

const recipe: InjectRecipe = {
  kind: "inject", host: "vercel.test", url: "https://vercel.test/env",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  field_selector: "#val", submit_selector: "#save", success_text: "Saved", ready_timeout_ms: 50,
};

const dest = { kind: "browser_inject" as const, recipe_host: recipe.host, shorthand: "vercel:production", domain: "vercel.test" };

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
    proveAbsence: async () => { events.push("proveAbsence"); return { passed: over.proofPassed ?? false }; },
  } as any;
  const blind = { start: () => events.push("blind.start"), end: () => events.push("blind.end") };
  const services = {
    blind,
    vault: { resolveSecret: async () => ({ value: { bytes: () => Buffer.from("v_secret"), dispose: () => undefined } }), markUsed: async () => { events.push("markUsed"); } },
    browserSession: {
      browser,
      cdp: {},
      proxy: {
        severAgentConnections: () => { events.push("severAgentConnections"); },
      },
    },
  } as any;
  const deps = {
    services,
    daemonPortRef: () => 1,
    openCaptureTarget: async (_cdp: unknown, _url: string) => { events.push("open"); return { target_id: over.openTargetId ?? "t" }; },
    cleanupCaptureTarget: async () => { events.push("cleanup(close)"); return { verified: true }; },
    disableObservationDomains: async (cdp: unknown) => { events.push("disableObservationDomains"); return disableObservationDomains(cdp as any).catch(() => undefined); },
  } as any;
  return { events, deps };
}

test("success => ok, tab closed, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: true, proofPassed: true });
  const r = await runBrowserInject(recipe, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, true);
  assert.ok(events.includes("cleanup(close)") && events.includes("blind.end"));
});

test("no success_text => recipe_inject_failed, proveAbsence run, blind ended, retryable", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: false });
  const r = await runBrowserInject(recipe, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_inject_failed");
  assert.ok(events.includes("blind.end"));
  assert.ok(events.includes("proveAbsence"));
});

test("login wall => bootstrap_login_required, tab LEFT OPEN, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-login]"]) });
  const r = await runBrowserInject(recipe, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.error_code, "bootstrap_login_required");
  assert.ok(!events.includes("cleanup(close)"));
  assert.ok(events.includes("blind.end"));
});

test("inject/click throw => recipe_inject_failed, markUsed fired, tab closed, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), injectThrow: true });
  const r = await runBrowserInject(recipe, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_inject_failed");
  // §6: markUsed must fire before cleanup so the secret is invalidated even on throw
  assert.ok(events.includes("markUsed"));
  // tab is disposable — cleanup must run
  assert.ok(events.includes("cleanup(close)"));
  // blind always ended before return
  assert.ok(events.includes("blind.end"));
});

test("url_params substitution: open() sees the interpolated URL", async () => {
  // Recipe URL carries placeholders; dest supplies url_params; open() should be called
  // with the substituted URL.
  const recipeWithPlaceholders: InjectRecipe = {
    ...recipe,
    url: "https://vercel.test/{team}/{project}/env",
  };
  let openedWith: string | undefined;
  const { events, deps } = makeDeps({
    present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]),
    successObserved: true,
    proofPassed: true,
  });
  // Wrap the deps.openCaptureTarget to capture the URL it was called with.
  const originalOpen = deps.openCaptureTarget;
  deps.openCaptureTarget = async (cdp: unknown, url: string) => {
    openedWith = url;
    return originalOpen(cdp, url);
  };
  const destWithParams = {
    kind: "browser_inject" as const,
    recipe_host: recipe.host,
    shorthand: "vercel:production",
    domain: "vercel.test",
    url_params: { team: "acme", project: "my-app" },
  };
  const r = await runBrowserInject(recipeWithPlaceholders, destWithParams, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, true);
  assert.equal(openedWith, "https://vercel.test/acme/my-app/env");
});

test("missing url_params: fail-closed with recipe_url_params_missing + ZERO side-effects", async () => {
  const recipeWithPlaceholders: InjectRecipe = {
    ...recipe,
    url: "https://vercel.test/{team}/{project}/env",
  };
  // makeDeps must record EVERY side-effect surface runBrowserInject reaches before
  // the open() call: blind.start, disableObservationDomains, severAgentConnections,
  // openCaptureTarget. The spec (§5 / interpolation-first guarantee) requires
  // interpolation to throw BEFORE any of these fire. See the makeDeps update in
  // Step 0 below — recordable markers are: "blind.start", "blind.end", "open",
  // "severAgentConnections", "disableObservationDomains", "cleanup(close)",
  // "inject", "submit", "proveAbsence", "markUsed".
  const { events, deps } = makeDeps({ present: new Set() });
  const destMissingParams = {
    kind: "browser_inject" as const,
    recipe_host: recipe.host,
    shorthand: "vercel:production",
    domain: "vercel.test",
    // url_params intentionally omitted
  };
  const r = await runBrowserInject(recipeWithPlaceholders, destMissingParams, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_url_params_missing");
  assert.match(r.message ?? "", /team/); // both missing placeholders named in the message
  assert.match(r.message ?? "", /project/);
  // CRITICAL: zero browser side-effects on the interpolation-fail path. Assert
  // absence for EVERY surface reached before open() in recipe-inject.ts. The spec
  // requires absence of: blind.start, disableObservationDomains (CDP filter),
  // severAgentConnections (proxy sever), openCaptureTarget (tab open), and any
  // downstream marker. Listing them explicitly — not "etc." — so a regression that
  // adds a new pre-interpolation side-effect surface fails this test loudly.
  assert.equal(events.includes("blind.start"), false, "blind.start must NOT fire on interpolation failure");
  assert.equal(events.includes("blind.end"), false, "blind.end must NOT fire on interpolation failure");
  assert.equal(events.includes("disableObservationDomains"), false, "CDP observation filter must NOT be installed");
  assert.equal(events.includes("severAgentConnections"), false, "proxy sever must NOT be invoked");
  assert.equal(events.includes("open"), false, "openCaptureTarget must NOT fire");
  assert.equal(events.includes("cleanup(close)"), false, "cleanup must NOT fire (no target was opened)");
  assert.equal(events.includes("inject"), false, "secret must NOT have been written into the page");
  assert.equal(events.includes("submit"), false, "save must NOT have been clicked");
});
