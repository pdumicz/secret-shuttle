import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  assertSessionPatternValid,
  canonicalAction,
  type SessionPattern,
} from "./session.js";

function makePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"], // required for template-run patterns
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// globToRegExp
test("globToRegExp: literal-only pattern matches exactly", () => {
  const re = globToRegExp("ss://stripe/prod/STRIPE_KEY");
  assert.equal(re.test("ss://stripe/prod/STRIPE_KEY"), true);
  assert.equal(re.test("ss://stripe/prod/OTHER"), false);
});

test("globToRegExp: single trailing * matches any non-empty suffix", () => {
  const re = globToRegExp("ss://stripe/prod/*");
  assert.equal(re.test("ss://stripe/prod/A"), true);
  assert.equal(re.test("ss://stripe/prod/MY-KEY.v2"), true);
  assert.equal(re.test("ss://stripe/prod/"), false); // suffix must be non-empty
  assert.equal(re.test("ss://stripe/prod"), false);
});

test("globToRegExp: regex-special characters in the prefix are escaped", () => {
  const re = globToRegExp("ss://stripe.com/prod/MY-KEY*");
  assert.equal(re.test("ss://stripe.com/prod/MY-KEY-A"), true);
  assert.equal(re.test("ss://stripeXcom/prod/MY-KEY-A"), false); // . was a literal, not any-char
});

test("globToRegExp: ** in glob is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/prod/**"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: ? is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/prod/?"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: bracket character class is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/[pq]rod/*"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: * not at the end is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://*/prod/*"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

// canonicalAction
test("canonicalAction: template → template-run", () => {
  assert.equal(canonicalAction("template"), "template-run");
});

test("canonicalAction: inject_submit → inject-submit", () => {
  assert.equal(canonicalAction("inject_submit"), "inject-submit");
});

test("canonicalAction: secrets_delete returns null (not a SessionAction)", () => {
  assert.equal(canonicalAction("secrets_delete"), null);
});

test("canonicalAction: secrets_rotate returns null (not a SessionAction)", () => {
  assert.equal(canonicalAction("secrets_rotate"), null);
});

test("canonicalAction: run returns null (deferred from Plan 4a)", () => {
  // run needs a command_prefix constraint to be safe in a session; deferred.
  assert.equal(canonicalAction("run"), null);
});

test("canonicalAction: inject_render returns null (deferred from Plan 4a)", () => {
  // inject_render needs an output_mode constraint to be safe; deferred.
  assert.equal(canonicalAction("inject_render"), null);
});

test("canonicalAction: unknown action returns null", () => {
  assert.equal(canonicalAction("nope"), null);
});

// assertSessionPatternValid
test("assertSessionPatternValid: minimal valid pattern passes", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern()));
});

test("assertSessionPatternValid: empty actions throws bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl < 1s throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 500 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl > 60min throws session_ttl_exceeds_cap", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 61 * 60 * 1000 })),
    (err: Error & { code?: string }) => err.code === "session_ttl_exceeds_cap",
  );
});

test("assertSessionPatternValid: invalid glob throws session_pattern_invalid_glob", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ref_glob: "ss://stripe/**/x" })),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("assertSessionPatternValid: empty ref_glob is allowed (means 'no ref check')", () => {
  // template-run is exempt from destination_domains; here we only need template_ids.
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["template-run"],
    ref_glob: "",
    destination_domains: [],
    template_ids: ["any-template"],
  })));
});

// New round-2 fix: domain-bearing actions REQUIRE non-empty destination_domains.
test("assertSessionPatternValid: inject-submit with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["inject-submit"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: reveal-capture with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["reveal-capture"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: template-run with empty template_ids throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["template-run"],
      destination_domains: [], // exempt
      template_ids: [], // empty — NOT exempt
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: template-run with template_ids undefined throws", () => {
  // exactOptionalPropertyTypes prevents passing `undefined` via makePattern;
  // construct directly so template_ids is genuinely absent.
  const pattern: SessionPattern = {
    actions: ["template-run"],
    ref_glob: "",
    destination_domains: [],
    ttl_ms: 5 * 60 * 1000,
    // template_ids intentionally omitted
  };
  assert.throws(
    () => assertSessionPatternValid(pattern),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

// secrets-set requires allowed_actions (round-4 P1 fix).
test("assertSessionPatternValid: secrets-set with empty allowed_actions throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      allowed_actions: [], // empty
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with allowed_actions undefined throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      // allowed_actions unset
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: allowed_actions entry outside ALL_SECRET_ACTIONS throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin", "nope_invalid"],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with valid allowed_actions passes", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["secrets-set"],
    destination_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
  })));
});

test("assertSessionPatternValid: max_uses 0 throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ max_uses: 0 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: max_uses > 1000 throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ max_uses: 1001 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-delete in actions throws (not a SessionAction)", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ actions: ["secrets-delete" as never] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: allowed_actions field accepted when present", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
  })));
});
