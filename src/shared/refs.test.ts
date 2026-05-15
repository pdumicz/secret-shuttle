import assert from "node:assert/strict";
import test from "node:test";
import { buildSecretRef, parseSecretRef } from "./refs.js";

test("buildSecretRef canonicalizes production refs", () => {
  assert.equal(
    buildSecretRef("Stripe", "production", "STRIPE_WEBHOOK_SECRET"),
    "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  );
});

test("parseSecretRef accepts prod shorthand", () => {
  const parsed = parseSecretRef("ss://stripe/prod/STRIPE_WEBHOOK_SECRET");
  assert.deepEqual(parsed, {
    source: "stripe",
    environment: "production",
    refEnvironment: "prod",
    name: "STRIPE_WEBHOOK_SECRET",
    ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  });
});

test("parseSecretRef normalizes production long form", () => {
  const parsed = parseSecretRef("ss://stripe/production/STRIPE_WEBHOOK_SECRET");
  assert.equal(parsed.ref, "ss://stripe/prod/STRIPE_WEBHOOK_SECRET");
  assert.equal(parsed.environment, "production");
});
