import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSessionPatternValid, type SessionPattern } from "./session.js";

function base(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

test("required_params absent → valid", () => {
  assertSessionPatternValid(base());
});

test("required_params={} (empty object) → valid", () => {
  assertSessionPatternValid(base({ required_params: {} }));
});

test("required_params with string values → valid", () => {
  assertSessionPatternValid(base({ required_params: { name: "STRIPE_KEY", environment: "production" } }));
});

test("required_params as array → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: [] as any })),
    /required_params must be an object/i,
  );
});

test("required_params as null → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: null as any })),
    /required_params must be an object/i,
  );
});

test("required_params with non-string value → bad_request, key named in message", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { name: 123 as any } })),
    /required_params.*name/i,
  );
});

test("required_params with malformed key (contains '/') → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { "bad/key": "v" } })),
    /required_params.*bad\/key/i,
  );
});

test("required_params with nested object value → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { name: { x: "y" } as any } })),
    /required_params.*name/i,
  );
});
