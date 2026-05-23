import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

function makeBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
    ...overrides,
  };
}

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

// =============================================================================
// template-run / inject-submit / reveal-capture (generic ref+domain matcher)
// =============================================================================

// Helper: template-run patterns require template_ids; inject-submit /
// reveal-capture / secrets-set require destination_domains. Local helper
// makes valid patterns for these tests without needing to repeat the
// requirements in every test.
function templatePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// =============================================================================
// template-run: ref + template_id (destination_domains IGNORED by design;
// see src/daemon/api/routes/templates.ts:91 where binding.destination_domain
// is null)
// =============================================================================

test("template-run: ref + template_id match → true (destination_domain on binding ignored)", () => {
  const p = templatePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: null, // current binding shape — null
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("template-run: ref mismatch → false", () => {
  const p = templatePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/dev/STRIPE_KEY",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: template_id constraint violated → false", () => {
  const p = templatePattern({ template_ids: ["vercel-env-add"] });
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    template_id: "github-actions-secret",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: template_ids empty in pattern → matcher refuses (defense-in-depth; assertSessionPatternValid catches this at create)", () => {
  // The pattern-level assertSessionPatternValid REQUIRES non-empty
  // template_ids for template-run patterns; but if a malformed pattern
  // somehow bypasses validation, the matcher itself must still refuse.
  const p = { ...templatePattern(), template_ids: [] };
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// inject-submit: ref + destination_domain
// =============================================================================

test("inject-submit: ref+domain match → true", () => {
  const p = makePattern({ actions: ["inject-submit"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("inject-submit: domain mismatch → false", () => {
  const p = makePattern({ actions: ["inject-submit"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "evil.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("inject-submit: case-insensitive domain match (pattern Vercel.com, binding vercel.com) → true", () => {
  // Regression for the P2: previously matchers used raw includes/Set.has, so
  // a pattern with mixed-case domain refused a normalized binding. Now both
  // sides are normalized at comparison time. Pattern-side canonicalization
  // happens at parseSessionPatternFromBody; the matcher is defense-in-depth.
  const p = makePattern({ actions: ["inject-submit"], destination_domains: ["Vercel.com"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("inject-submit: whitespace + uppercase tolerated on both sides", () => {
  // Weirder variant: leading/trailing whitespace + all-caps on one side.
  // normalizeDomain trims + lowercases, so this matches.
  const p = makePattern({ actions: ["inject-submit"], destination_domains: ["  VERCEL.COM  "] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

// =============================================================================
// reveal-capture: PLANNED_REF (not binding.ref — see reveal-capture.ts:148)
// =============================================================================

test("reveal-capture: planned_ref + domain match → true (binding.ref is null on this action)", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null, // reveal_capture binding has ref:null; planned_ref carries the future ref
    planned_ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("reveal-capture: matcher uses planned_ref, NOT binding.ref (P0 regression fix)", () => {
  // Regression for the round-2 P0: prior matcher used binding.ref which is
  // always null for reveal_capture, so ANY pattern would silently auto-approve.
  // Now we use planned_ref. With a planned_ref OUTSIDE the glob, refuse.
  const p = makePattern({ actions: ["reveal-capture"], ref_glob: "ss://stripe/prod/*" });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://OTHER/prod/STRIPE_KEY", // outside glob
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("reveal-capture: planned_ref missing → false (defensive)", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: null,
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("reveal-capture: domain mismatch → false", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "evil.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// secrets-set (planned_ref + allowed_domains + allowed_actions semantics)
// =============================================================================

test("secrets-set: planned_ref matches glob; allowed_domains ⊆ pattern.destination_domains; allowed_actions ⊆ pattern.allowed_actions → true", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com", "github.com"],
    allowed_actions: ["use_as_stdin", "inject_into_field"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/NEW_KEY",
    allowed_domains: ["vercel.com"], // ⊆ pattern.destination_domains
    allowed_actions: ["use_as_stdin"], // ⊆ pattern.allowed_actions
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: case-insensitive domain subset check (pattern mixed-case, binding lowercase) → true", () => {
  // Regression for the P2: secretsSetMatches builds a Set from
  // pattern.destination_domains and checks binding.allowed_domains against it.
  // Without normalization, a pattern with "Vercel.com" would silently refuse
  // a binding with "vercel.com" (the canonical form bindings actually carry).
  const p = makePattern({
    actions: ["secrets-set"],
    destination_domains: ["Vercel.com", "SUPABASE.io"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/NEW_KEY",
    allowed_domains: ["vercel.com", "supabase.io"],
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: planned_ref outside glob → false", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/dev/NEW_KEY", // dev not prod
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_domains contains a domain NOT in pattern → false (NOT superset-allowed)", () => {
  // Security-relevant: the session pre-approves vercel.com, the agent tries
  // to mint a secret that ALSO allows github.com. Refuse — the human
  // approved vercel.com only.
  const p = makePattern({
    actions: ["secrets-set"],
    destination_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com", "github.com"], // github.com is wider
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: pattern.allowed_actions + binding.allowed_actions ⊆ pattern → true", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: binding.allowed_actions wider than pattern → false", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin", "inject_submit"], // wider
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_actions undefined → false (defense in depth)", () => {
  // The generate route populates binding.allowed_actions before requireApproval,
  // so an undefined value here means the binding came from somewhere that
  // doesn't carry the contract. Refuse rather than silently auto-approve a
  // secret with no action scope.
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    // allowed_actions: undefined  ← intentionally omitted
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_actions explicit [] → true (deliberately narrow scope)", () => {
  // An empty array is a deliberately narrow scope — the binding wants the
  // secret to allow NO actions. ⊆ pattern.allowed_actions vacuously holds.
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: [], // explicit empty — narrower than the pattern, OK
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

// =============================================================================
// run / inject_render are NOT SessionActions in Plan 4a — see the pass-through
// refusal tests at the bottom of this file.
// =============================================================================

// =============================================================================
// Action canonicalization + pass-through refusal for non-SessionActions
// =============================================================================

test("matchesSessionPattern: canonicalized action not in pattern.actions → false", () => {
  const p = makePattern({ actions: ["template-run"], template_ids: ["v"] }); // template-run only
  const b = makeBinding({ action: "inject_submit" }); // canonicalizes to inject-submit, not in pattern
  assert.equal(matchesSessionPattern(b, p), false);
});

// Helper: build the broadest pattern that assertSessionPatternValid accepts —
// all four SessionAction values + non-empty destination_domains + template_ids
// + non-empty allowed_actions (covers the entire ALL_SECRET_ACTIONS surface).
// Used by the pass-through refusal tests below to prove that even a maximally
// wide LEGAL pattern still refuses non-SessionAction bindings.
function broadestLegalPattern(): SessionPattern {
  return {
    actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
    ref_glob: "",
    destination_domains: ["any.com"],
    template_ids: ["any"],
    allowed_actions: [
      "capture_from_page",
      "inject_into_field",
      "compare_fingerprint",
      "use_as_stdin",
      "inject_submit",
    ],
    ttl_ms: 60_000,
  };
}

test("matchesSessionPattern: secrets_delete binding → false (not a SessionAction)", () => {
  // secrets-delete is NOT in SessionAction; canonicalAction returns null.
  // Even the broadest legal pattern refuses.
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "secrets_delete" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: secrets_rotate binding → false", () => {
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "secrets_rotate" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: run binding → false (not a SessionAction in Plan 4a)", () => {
  // run is deferred from Plan 4a (needs command_prefix). Same pass-through-
  // refusal as destructive actions.
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "run" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: inject_render binding → false (not a SessionAction in Plan 4a)", () => {
  // inject_render is deferred from Plan 4a (needs output_mode constraint).
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "inject_render" });
  assert.equal(matchesSessionPattern(b, p), false);
});
