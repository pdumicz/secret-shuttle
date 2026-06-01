// src/daemon/bootstrap/recipe-capture.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptRecipeCapture } from "./recipe-capture.js";
import type { CaptureRecipe } from "../recipes/types.js";

const recipe: CaptureRecipe = {
  kind: "capture", host: "stripe.test", url: "https://stripe.test/keys",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  reveal_selector: "#reveal", field_selector: "#sk", hide_selector: "#hide", ready_timeout_ms: 50,
};

function makeCtx(over: { present: Set<string>; gateValue?: string; gateThrow?: string; cleanupVerified?: boolean; cleanupThrows?: boolean }) {
  const events: string[] = [];
  const browser = {
    waitForSelector: async (_t: string, s: string) => over.present.has(s),
    selectorMatchCount: async (_t: string, s: string) => (over.present.has(s) ? 1 : 0),
    documentHost: async () => "stripe.test",
    resolveSelectorToHandle: async (_t: string, s: string) => {
      if (!over.present.has(s)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous", name: "ShuttleError" });
      return { target_id: "t", backend_node_id: s === "#hide" ? 99 : 1, fingerprint: "fp" };
    },
    clickBackendNode: async (ref: { backend_node_id: number }) => { events.push(ref.backend_node_id === 99 ? "hide" : "click"); },
    baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
    resolveWithinContainer: async () => {
      if (over.gateThrow) throw Object.assign(new Error(over.gateThrow), { code: over.gateThrow, name: "ShuttleError" });
      return { value: over.gateValue ?? "" };
    },
  } as any;
  const blind = { end: () => events.push("blind.end") };
  const services = {
    blind, vault: { upsertSecret: async () => ({ ref: "ss://x", fingerprint: "fp" }) },
    browserSession: { browser, cdp: {}, proxy: { severAgentConnections: () => undefined } },
  } as any;
  const cleanup = async () => {
    events.push("cleanup(close)");
    if (over.cleanupThrows) throw new Error("close failed");
    return { verified: over.cleanupVerified ?? true };
  };
  return { events, ctx: { browser, cdp: {}, target_id: "t", expectedHost: "stripe.test", services, entry: { secret: "STRIPE_SK", ref: "ss://stripe/prod/STRIPE_SK", destinations: [] }, cleanupCaptureTarget: cleanup } };
}

test("ready + value => kind:value, tab left open for shared cleanup (no blind.end here)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateValue: "sk_live_abc" });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal(r.kind, "value");
  assert.equal((r as any).value, "sk_live_abc");
  assert.ok(!events.includes("blind.end"));
  assert.ok(!events.includes("cleanup(close)"));
});

test("login wall => page-state class: blind.end + tab LEFT OPEN + stopWith", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-login]"]) });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal(r.kind, "outcome");
  assert.equal((r as any).outcome.stepResult.error_code, "bootstrap_login_required");
  assert.ok(events.includes("blind.end"));
  assert.ok(!events.includes("cleanup(close)"));
});

test("no-transition => secret-bearing: hide → cleanup(close) BEFORE blind.end + recipe_capture_failed (reason carried)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateThrow: "reveal_no_transition" });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal((r as any).outcome.stepResult.error_code, "recipe_capture_failed");
  assert.ok((r as any).outcome.stepResult.message.includes("reveal_no_transition"));
  assert.ok(events.indexOf("hide") < events.indexOf("cleanup(close)"));
  assert.ok(events.indexOf("cleanup(close)") < events.indexOf("blind.end"));
});

test("ambiguous reveal selector => secret-bearing: cleanup(close) before blind.end (no hide: never resolved)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#sk", "#hide"]) });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal((r as any).outcome.stepResult.error_code, "recipe_selector_ambiguous");
  assert.ok(!events.includes("hide"));
  assert.ok(events.indexOf("cleanup(close)") < events.indexOf("blind.end"));
});

test("cleanup REJECTS on a secret-bearing failure => treated as unverified: blind ACTIVE, deterministic bootstrap_capture_cleanup_failed (no throw escapes) + cleanup reason preserved", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateThrow: "reveal_no_transition", cleanupThrows: true });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal(r.kind, "outcome");
  assert.ok(events.includes("cleanup(close)"));
  assert.ok(!events.includes("blind.end"));
  assert.equal((r as any).outcome.stepResult.error_code, "bootstrap_capture_cleanup_failed");
  const msg = (r as any).outcome.stepResult.message as string;
  assert.ok(msg.includes("recipe_capture_failed"), `expected recipe code in message, got: ${msg}`);
  assert.ok(msg.includes("close failed"), `expected cleanup rejection text in message, got: ${msg}`);
  assert.ok(msg.includes("blind kept active"), `expected blind-state hint in message, got: ${msg}`);
});
