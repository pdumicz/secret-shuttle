import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

function pattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// ApprovalBinding.action is stored as "template" (per session-matchers.ts)
// and canonicalized to "template-run" by the matcher. Use the stored form
// so the test matches the binding shape constructed by the templates route.
// Mirrors makeBinding() in session-matchers.test.ts for all required fields.
function binding(
  params: Record<string, string> | null = { name: "STRIPE_KEY", environment: "production" },
): ApprovalBinding {
  return {
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: "vercel-env-add",
    template_params: params,
    allowed_domains: [],
  };
}

test("required_params absent → matcher behaves as today (ref + template_id)", () => {
  assert.equal(matchesSessionPattern(binding(), pattern()), true);
});

test("required_params empty object → same as absent", () => {
  assert.equal(matchesSessionPattern(binding(), pattern({ required_params: {} })), true);
});

test("all required_params keys present and equal → match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding(), p), true);
});

test("one required_params key missing in binding → no match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "STRIPE_KEY" }), p), false);
});

test("one required_params value differs → no match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "STRIPE_KEY", environment: "preview" }), p), false);
});

test("binding has extra params not in required_params → match", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(
    matchesSessionPattern(
      binding({ name: "STRIPE_KEY", environment: "production", extra: "z" }),
      p,
    ),
    true,
  );
});

test("strict equality: 'production' ≠ 'Production'", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "X", environment: "Production" }), p), false);
});

test("strict equality: 'production' ≠ ' production' (whitespace)", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "X", environment: " production" }), p), false);
});
