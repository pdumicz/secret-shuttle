import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSessionPatternValid, type SessionPattern } from "./session.js";

function base(ttl_ms: number): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms,
  };
}

test("ttl_ms = 60 minutes (exact cap) accepted", () => {
  assertSessionPatternValid(base(60 * 60 * 1000));
});

test("ttl_ms = 60 minutes + 1 ms rejected with session_ttl_exceeds_cap", () => {
  assert.throws(
    () => assertSessionPatternValid(base(60 * 60 * 1000 + 1)),
    (err: any) => err.code === "session_ttl_exceeds_cap" || /session_ttl_exceeds_cap/.test(String(err)),
  );
});

test("ttl_ms = 15 minutes (old cap) still accepted (below new cap)", () => {
  assertSessionPatternValid(base(15 * 60 * 1000));
});
