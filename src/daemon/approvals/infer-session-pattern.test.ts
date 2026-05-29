import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSessionPatternFromPlan } from "./infer-session-pattern.js";
import type { PlanEntry } from "../bootstrap/store.js";

function entry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    secret: "STRIPE_KEY",
    ref: "ss://stripe/prod/STRIPE_KEY",
    source: { kind: "random_32_bytes" },
    destinations: [
      {
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "STRIPE_KEY", environment: "production" },
        domain: "vercel.com",
      },
    ],
    ...overrides,
  };
}

// Helper: destructure-and-guard so test code typechecks under
// noUncheckedIndexedAccess without `!`-asserts on every index access.
function first<T>(arr: readonly T[], label: string): T {
  const [x] = arr;
  assert.ok(x !== undefined, `expected ${label}[0] to exist`);
  return x;
}

test("single PlanEntry → one exact-ref pattern", () => {
  const r = inferSessionPatternFromPlan([entry()]);
  assert.equal(r.patterns.length, 1);
  const p = first(r.patterns, "patterns");
  assert.equal(p.ref_glob, "ss://stripe/prod/STRIPE_KEY");
  assert.deepEqual(p.required_params, { name: "STRIPE_KEY", environment: "production" });
  assert.deepEqual(p.actions, ["template-run"]);
  assert.deepEqual(p.template_ids, ["vercel-env-add"]);
});

test("same ref pushed to two vercel environments → two patterns with different environment values", () => {
  const e: PlanEntry = entry({
    destinations: [
      { shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "STRIPE_KEY", environment: "production" }, domain: "vercel.com" },
      { shorthand: "vercel:preview",    template_id: "vercel-env-add", template_params: { name: "STRIPE_KEY", environment: "preview"   }, domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 2);
  const envs = r.patterns.map((p) => p.required_params!.environment).sort();
  assert.deepEqual(envs, ["preview", "production"]);
});

test("two refs aliased onto same destination name → two exact-ref patterns (NOT one glob)", () => {
  const a: PlanEntry = { ...entry(), ref: "ss://stripe/prod/X", secret: "X",
    destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "API_KEY", environment: "production" }, domain: "vercel.com" }] };
  const b: PlanEntry = { ...entry(), ref: "ss://stripe/prod/Y", secret: "Y",
    destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "API_KEY", environment: "production" }, domain: "vercel.com" }] };
  const r = inferSessionPatternFromPlan([a, b]);
  assert.equal(r.patterns.length, 2);
  const refs = r.patterns.map((p) => p.ref_glob).sort();
  assert.deepEqual(refs, ["ss://stripe/prod/X", "ss://stripe/prod/Y"]);
  for (const p of r.patterns) {
    assert.ok(!p.ref_glob.endsWith("*"), `derivation must never emit glob form, got ${p.ref_glob}`);
  }
});

test("template not in DESTINATION_DEFINING_PARAMS → destination excluded", () => {
  const e = entry({
    destinations: [
      { shorthand: "railway:production", template_id: "railway-variable-set", template_params: { name: "X" }, domain: "railway.app" },
      { shorthand: "vercel:production",  template_id: "vercel-env-add",       template_params: { name: "STRIPE_KEY", environment: "production" }, domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 1);
  const p = first(r.patterns, "patterns");
  const templateIds = p.template_ids;
  assert.ok(templateIds !== undefined && templateIds.length > 0);
  assert.equal(first(templateIds, "patterns[0].template_ids"), "vercel-env-add");
  assert.equal(r.excluded.length, 1);
  assert.equal(first(r.excluded, "excluded").template_id, "railway-variable-set");
});

test("all destinations unregistered → empty patterns array, excluded list non-empty", () => {
  const e = entry({
    destinations: [
      { shorthand: "railway:production", template_id: "railway-variable-set", template_params: { name: "X" }, domain: "railway.app" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.excluded.length, 1);
});

test("capture-only PlanEntry with no template-run destinations → no patterns", () => {
  const e: PlanEntry = {
    secret: "CAPTURED",
    ref: "ss://stripe/prod/CAPTURED",
    source: { kind: "capture", url: "https://example.com" } as any,
    destinations: [],
  };
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
});

test("registered template with MISSING defining param → excluded with reason missing_defining_params", () => {
  // vercel-env-add registers ["name", "environment"]. If `environment` is
  // missing (config drift / corrupted plan), the destination must be
  // excluded fail-closed — emitting a less-constrained session would
  // silently widen consent.
  const e = entry({
    destinations: [
      { shorthand: "vercel:?", template_id: "vercel-env-add",
        template_params: { name: "STRIPE_KEY" }, // environment missing
        domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.excluded.length, 1);
  const x = first(r.excluded, "excluded");
  assert.equal(x.reason, "missing_defining_params");
  if (x.reason === "missing_defining_params") {
    assert.deepEqual(x.missing_keys, ["environment"]);
  }
});

test("registered template with EMPTY-STRING defining param → also excluded", () => {
  const e = entry({
    destinations: [
      { shorthand: "vercel:?", template_id: "vercel-env-add",
        template_params: { name: "STRIPE_KEY", environment: "" },
        domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.excluded.length, 1);
});
