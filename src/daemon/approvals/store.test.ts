import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { ApprovalStore, approvalBindingsMatch, type ApprovalBinding } from "./store.js";
import { SessionStore } from "./session-store.js";

const sample = {
  action: "inject" as const,
  ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  environment: "production",
  destination_domain: "vercel.com",
  target_id: "T1",
  field_fingerprint: "sha256:field",
  template_id: null,
  template_params: null,
};

test("store creates a pending grant", () => {
  const s = new ApprovalStore({ ttlMs: 1000 });
  const grant = s.create(sample);
  assert.equal(grant.status, "pending");
  assert.equal(grant.id.length > 0, true);
  assert.equal(s.get(grant.id)?.status, "pending");
});

test("approve flips status; consume marks used", () => {
  const s = new ApprovalStore({ ttlMs: 1000 });
  const g = s.create(sample);
  s.approve(g.id);
  const consumed = s.consume(g.id, sample);
  assert.equal(consumed.status, "used");
  assert.throws(
    () => s.consume(g.id, sample),
    (err) => err instanceof ShuttleError && err.code === "approval_already_used",
  );
});

test("expired grants cannot be consumed", () => {
  let now = 0;
  const s = new ApprovalStore({ ttlMs: 1000, now: () => now });
  const g = s.create(sample);
  s.approve(g.id);
  now = 1_000_000;
  assert.throws(
    () => s.consume(g.id, sample),
    (err) => err instanceof ShuttleError && err.code === "approval_expired",
  );
});

test("consume rejects mismatched bindings", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create(sample);
  s.approve(g.id);
  assert.throws(
    () => s.consume(g.id, { ...sample, destination_domain: "evil.com" }),
    (err) => err instanceof ShuttleError && err.code === "approval_mismatch",
  );
});

test("deny moves status to denied", () => {
  const s = new ApprovalStore({ ttlMs: 1000 });
  const g = s.create(sample);
  s.deny(g.id);
  assert.equal(s.get(g.id)?.status, "denied");
});

test("get returns expired status for pending grants past TTL", () => {
  let now = 0;
  const s = new ApprovalStore({ ttlMs: 100, now: () => now });
  const g = s.create(sample);
  now = 10_000;
  assert.equal(s.get(g.id)?.status, "expired");
});

test("template_params order-insensitive matching", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const binding = {
    ...sample,
    action: "template" as const,
    template_id: "vercel-env-add",
    template_params: { name: "FOO", environment: "production" },
  };
  const g = s.create(binding);
  s.approve(g.id);
  // Same params, different key insertion order
  const swapped = {
    ...sample,
    action: "template" as const,
    template_id: "vercel-env-add",
    template_params: { environment: "production", name: "FOO" },
  };
  assert.doesNotThrow(() => s.consume(g.id, swapped));
});

test("bindings mismatch when allowed_domains differ; order-insensitive when equal", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const base = { ...sample, allowed_domains: ["vercel.com", "stripe.com"] };
  const g = s.create(base);
  s.approve(g.id);
  assert.throws(
    () => s.consume(g.id, { ...sample, allowed_domains: ["evil.com"] }),
    (err) => err instanceof ShuttleError && err.code === "approval_mismatch",
  );
  const g2 = s.create({ ...sample, allowed_domains: ["a.com", "b.com"] });
  s.approve(g2.id);
  assert.doesNotThrow(() => s.consume(g2.id, { ...sample, allowed_domains: ["b.com", "a.com"] }));
});

test("absent, null, and empty allowed_domains are treated as the same (empty) set", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, allowed_domains: null });
  s.approve(g.id);
  assert.doesNotThrow(() => s.consume(g.id, { ...sample })); // sample has no allowed_domains
});

test("display-only fields (page_title/page_url_host) do not affect binding match", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, page_title: "Stripe", page_url_host: "dashboard.stripe.com" });
  s.approve(g.id);
  assert.doesNotThrow(() =>
    s.consume(g.id, { ...sample, page_title: "DIFFERENT", page_url_host: "other" }),
  );
});

// ---------------------------------------------------------------------------
// findOrMintFromSession
// ---------------------------------------------------------------------------

function makeBindingFor(action: ApprovalBinding["action"], extra: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action,
    ref: "ss://x/prod/A",
    environment: "production",
    destination_domain: "vercel.com",
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
    ...extra,
  };
}

test("findOrMintFromSession: unknown id → session_not_found", () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  assert.throws(
    () => store.findOrMintFromSession("nope", makeBindingFor("template"), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("findOrMintFromSession: matched + granted → synthesizes used grant with session_id", () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [], // ignored for template-run
    template_ids: ["vercel-env-add"], // required for template-run
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    destination_domain: null, // current template binding shape (see templates.ts:91)
    template_id: "vercel-env-add",
  });
  const grant = store.findOrMintFromSession(sg.id, binding, sessions);
  assert.equal(grant.status, "used");
  assert.equal(grant.session_id, sg.id);
  assert.equal(grant.id.startsWith(`session:${sg.id}:`), true);
  assert.equal(sessions.get(sg.id)!.uses, 1);
});

test("findOrMintFromSession: expired (granted past TTL) → session_expired", () => {
  let nowVal = 1_000_000;
  const sessions = new SessionStore({ now: () => nowVal });
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 1000,
  });
  sessions.approve(sg.id);
  nowVal += 2000;
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
});

test("findOrMintFromSession: revoked → session_not_found", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  sessions.revoke(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("findOrMintFromSession: pending (not approved) → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: denied → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.deny(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: pattern mismatch → session_pattern_no_match", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    ref: "ss://other/prod/A", // outside the glob
    template_id: "vercel-env-add",
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_pattern_no_match",
  );
});

test("findOrMintFromSession: max_uses overflow → session_max_uses_exceeded", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
    max_uses: 2,
  });
  sessions.approve(sg.id);
  const store = new ApprovalStore();
  const binding = makeBindingFor("template", { template_id: "vercel-env-add" });
  store.findOrMintFromSession(sg.id, binding, sessions);
  store.findOrMintFromSession(sg.id, binding, sessions);
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_max_uses_exceeded",
  );
});

test("findOrMintFromSession: secrets_delete binding → session_pattern_no_match (action not allowed in sessions)", () => {
  const sessions = new SessionStore();
  // The broadest legal pattern (all 4 SessionActions + non-empty
  // destination_domains + template_ids + allowed_actions covering the full
  // ALL_SECRET_ACTIONS surface) satisfies assertSessionPatternValid.
  // secrets_delete is NOT a SessionAction; canonicalAction returns null;
  // the matcher refuses outright.
  const sg = sessions.create({
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
  });
  sessions.approve(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("secrets_delete"), sessions),
    (err: Error & { code?: string }) => err.code === "session_pattern_no_match",
  );
});

test("ApprovalBinding accepts run_stdin action", () => {
  // Compile-time assertion: this only matters if the type allows the value.
  // If TS rejects the literal, the test fails at typecheck before runtime.
  const binding: ApprovalBinding = {
    action: "run_stdin",
    ref: "ss://local/prod/X",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
  };
  assert.equal(binding.action, "run_stdin");
});

// ---------------------------------------------------------------------------
// approvalBindingsMatch (public matcher)
// ---------------------------------------------------------------------------

test("approvalBindingsMatch: identical bindings match", () => {
  const b: ApprovalBinding = {
    action: "run",
    ref: null,
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: { command: "npm", args: "[]", refs: "ss://local/prod/A" },
    allowed_domains: [],
  };
  assert.strictEqual(approvalBindingsMatch(b, { ...b }), true);
});

test("approvalBindingsMatch: differing action → mismatch", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: [] };
  const b = { ...a, action: "run_stdin" as const };
  assert.strictEqual(approvalBindingsMatch(a, b), false);
});

test("approvalBindingsMatch: differing template_params → mismatch", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { x: "1" }, allowed_domains: [] };
  const b: ApprovalBinding = { ...a, template_params: { x: "2" } };
  assert.strictEqual(approvalBindingsMatch(a, b), false);
});

test("approvalBindingsMatch: allowed_domains order-insensitive", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["a.com", "b.com"] };
  const b: ApprovalBinding = { ...a, allowed_domains: ["b.com", "a.com"] };
  assert.strictEqual(approvalBindingsMatch(a, b), true);
});

test("approvalBindingsMatch: allowed_actions order-insensitive", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_actions: ["write", "read"] };
  const b: ApprovalBinding = { ...a, allowed_actions: ["read", "write"] };
  assert.strictEqual(approvalBindingsMatch(a, b), true);
});

test("approvalBindingsMatch: null/undefined/empty allowed_domains are equivalent", () => {
  const base: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null };
  const withNull: ApprovalBinding = { ...base, allowed_domains: null };
  const withUndefined: ApprovalBinding = { ...base };
  const withEmpty: ApprovalBinding = { ...base, allowed_domains: [] };
  assert.strictEqual(approvalBindingsMatch(withNull, withUndefined), true);
  assert.strictEqual(approvalBindingsMatch(withNull, withEmpty), true);
  assert.strictEqual(approvalBindingsMatch(withUndefined, withEmpty), true);
});

// ---------------------------------------------------------------------------
// canMatchSession
// ---------------------------------------------------------------------------

test("canMatchSession: granted session with matching pattern under max_uses → true, no side effects", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    actions: ["inject-submit"],
    ref_glob: "",
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });

  const before = sessionStore.get(session.id)!.uses;
  const result = approvals.canMatchSession(session.id, binding, sessionStore);
  const after = sessionStore.get(session.id)!.uses;

  assert.strictEqual(result, true);
  assert.strictEqual(after, before, "uses must NOT increment");
});

test("canMatchSession: pattern no-match → false (no throw, no side effects)", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ actions: ["inject-submit"], ref_glob: "", destination_domains: ["example.com"], max_uses: 5, ttl_ms: 60_000 });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  // inject_submit with a destination_domain not in the session pattern → no match
  const binding = makeBindingFor("inject_submit", { destination_domain: "other.com", allowed_domains: ["other.com"] });

  assert.strictEqual(approvals.canMatchSession(session.id, binding, sessionStore), false);
  assert.strictEqual(sessionStore.get(session.id)!.uses, 0);
});

test("canMatchSession: revoked → throws session_not_found", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ actions: ["inject-submit"], ref_glob: "", destination_domains: ["example.com"], max_uses: 5, ttl_ms: 60_000 });
  sessionStore.approve(session.id);
  sessionStore.revoke(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_not_found");
});

test("canMatchSession: at max_uses → throws session_max_uses_exceeded (no side effects on store)", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ actions: ["inject-submit"], ref_glob: "", destination_domains: ["example.com"], max_uses: 1, ttl_ms: 60_000 });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id); // now at max
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });

  const usesBefore = sessionStore.get(session.id)!.uses;
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded");
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore, "uses must NOT change on throw");
});

test("canMatchSession: expired → throws session_expired", () => {
  let nowMs = 1000;
  const sessionStore = new SessionStore({ now: () => nowMs });
  const session = sessionStore.create({ actions: ["inject-submit"], ref_glob: "", destination_domains: ["example.com"], max_uses: 5, ttl_ms: 1000 });
  sessionStore.approve(session.id);
  nowMs += 2000; // past expiry
  const approvals = new ApprovalStore();
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_expired");
});

test("canMatchSession: pending (not yet approved) → throws session_not_pending (matches incrementUses)", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  // Create session but DO NOT approve — status stays "pending".
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 60_000,
  });
  const approvals = new ApprovalStore();
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });
  assert.throws(
    () => approvals.canMatchSession(session.id, binding, sessionStore),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_not_pending",
  );
});

// ---------------------------------------------------------------------------
// mintFromSession
// ---------------------------------------------------------------------------

test("mintFromSession: granted+matching session → bumps uses, returns synthetic grant with session_id", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });

  const usesBefore = sessionStore.get(session.id)!.uses;
  const grant = approvals.mintFromSession(session.id, binding, sessionStore);

  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore + 1);
  assert.strictEqual(grant.session_id, session.id);
  assert.strictEqual(grant.status, "used");
  assert.strictEqual(grant.action, "inject_submit");
});

test("mintFromSession: at max_uses (race) → throws session_max_uses_exceeded", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 1,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id); // pretend concurrent request burned it
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });
  assert.throws(
    () => approvals.mintFromSession(session.id, binding, sessionStore),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded",
  );
});

// ---------------------------------------------------------------------------
// fireMismatch
// ---------------------------------------------------------------------------

test("fireMismatch: fires onEvent without consuming the grant", () => {
  const events: string[] = [];
  const store = new ApprovalStore({ onEvent: (e) => events.push(e.kind) });
  const binding = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const otherBinding = makeBindingFor("inject_submit", { destination_domain: "b.com", allowed_domains: ["b.com"] });
  const grant = store.create(binding);
  store.approve(grant.id);

  // Clear earlier events.
  events.length = 0;

  store.fireMismatch(grant.id, otherBinding);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0], "mismatch");
  // Grant is still granted (not consumed).
  assert.strictEqual(store.get(grant.id)!.status, "granted");
});

test("fireMismatch: unknown id is a no-op", () => {
  const events: string[] = [];
  const store = new ApprovalStore({ onEvent: (e) => events.push(e.kind) });
  const binding = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  store.fireMismatch("does-not-exist", binding);
  assert.strictEqual(events.length, 0);
});

test("fireMismatch: used/expired grant doesn't fire", () => {
  const events: string[] = [];
  const store = new ApprovalStore({ onEvent: (e) => events.push(e.kind) });
  const binding = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const grant = store.create(binding);
  store.approve(grant.id);
  store.consume(grant.id, binding); // grant.status = "used"
  events.length = 0;
  store.fireMismatch(grant.id, binding);
  assert.strictEqual(events.length, 0, "no event for used grant");
});

test("mintFromSession: session_expired race (TTL elapses between peek and commit) → throws session_expired", () => {
  let nowMs = 1000;
  const sessionStore = new SessionStore({ now: () => nowMs });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 1000,
  });
  sessionStore.approve(session.id);
  nowMs += 2000; // TTL elapsed — incrementUses will flip status to expired
  const approvals = new ApprovalStore({ now: () => nowMs });
  const binding = makeBindingFor("inject_submit", { destination_domain: "example.com", allowed_domains: ["example.com"] });
  assert.throws(
    () => approvals.mintFromSession(session.id, binding, sessionStore),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_expired",
  );
});
