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
  const consumed = s.consume(g.id, sample, "daemon");
  assert.equal(consumed.status, "used");
  assert.throws(
    () => s.consume(g.id, sample, "daemon"),
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
    () => s.consume(g.id, sample, "daemon"),
    (err) => err instanceof ShuttleError && err.code === "approval_expired",
  );
});

test("consume rejects mismatched bindings", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create(sample);
  s.approve(g.id);
  assert.throws(
    () => s.consume(g.id, { ...sample, destination_domain: "evil.com" }, "daemon"),
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
  assert.doesNotThrow(() => s.consume(g.id, swapped, "daemon"));
});

test("bindings mismatch when allowed_domains differ; order-insensitive when equal", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const base = { ...sample, allowed_domains: ["vercel.com", "stripe.com"] };
  const g = s.create(base);
  s.approve(g.id);
  assert.throws(
    () => s.consume(g.id, { ...sample, allowed_domains: ["evil.com"] }, "daemon"),
    (err) => err instanceof ShuttleError && err.code === "approval_mismatch",
  );
  const g2 = s.create({ ...sample, allowed_domains: ["a.com", "b.com"] });
  s.approve(g2.id);
  assert.doesNotThrow(() => s.consume(g2.id, { ...sample, allowed_domains: ["b.com", "a.com"] }, "daemon"));
});

test("absent, null, and empty allowed_domains are treated as the same (empty) set", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, allowed_domains: null });
  s.approve(g.id);
  assert.doesNotThrow(() => s.consume(g.id, { ...sample }, "daemon")); // sample has no allowed_domains
});

test("display-only fields (page_title/page_url_host) do not affect binding match", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, page_title: "Stripe", page_url_host: "dashboard.stripe.com" });
  s.approve(g.id);
  assert.doesNotThrow(() =>
    s.consume(g.id, { ...sample, page_title: "DIFFERENT", page_url_host: "other" }, "daemon"),
  );
});

// ---------------------------------------------------------------------------
// shared test helper
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
// invalidate (terminal-state no-op behavior)
// ---------------------------------------------------------------------------

test("invalidate: denied grant is a no-op (terminal state preserved, no duplicate event)", () => {
  const events: string[] = [];
  const store = new ApprovalStore({
    onEvent: (e) => events.push(e.kind),
  });
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  store.deny(g.id);
  events.length = 0;

  store.invalidate(g.id);
  // No new event. Terminal state (denied) is preserved — no "cancelled" emitted.
  assert.strictEqual(events.length, 0);
  // The grant stays in the store with status=denied (invalidate didn't remove it).
  assert.strictEqual(store.get(g.id)?.status, "denied");
});

test("invalidate: used grant is a no-op", () => {
  const events: string[] = [];
  const store = new ApprovalStore({
    onEvent: (e) => events.push(e.kind),
  });
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  store.approve(g.id);
  store.consume(g.id, b, "daemon");
  events.length = 0;

  store.invalidate(g.id);
  assert.strictEqual(events.length, 0);
  // The grant remains in the store as used (consume doesn't delete; invalidate didn't either).
  assert.strictEqual(store.get(g.id)?.status, "used");
});

test("invalidate: expired grant is a no-op", () => {
  let nowMs = 1000;
  const events: string[] = [];
  const store = new ApprovalStore({
    ttlMs: 100,
    now: () => nowMs,
    onEvent: (e) => events.push(e.kind),
  });
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  // Don't approve — let it expire.
  nowMs = 1500;
  store.get(g.id); // triggers pending → expired transition; fires "expired" event
  events.length = 0;

  store.invalidate(g.id);
  assert.strictEqual(events.length, 0);
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

test("canMatchSession: pending (not yet approved) → throws session_unauthorized (matches pre-4d findOrMintFromSession + spec)", () => {
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
    (e: unknown) => e instanceof ShuttleError && e.code === "session_unauthorized",
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
  store.consume(grant.id, binding, "daemon"); // grant.status = "used"
  events.length = 0;
  store.fireMismatch(grant.id, binding);
  assert.strictEqual(events.length, 0, "no event for used grant");
});

// ---------------------------------------------------------------------------
// consumeBatch
// ---------------------------------------------------------------------------

test("consumeBatch: empty items returns []", () => {
  const store = new ApprovalStore();
  assert.deepStrictEqual(store.consumeBatch([], "daemon"), []);
});

test("consumeBatch: all granted in order → consumes all atomically", () => {
  const store = new ApprovalStore();
  const b1 = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const b2 = makeBindingFor("inject_submit", { destination_domain: "b.com", allowed_domains: ["b.com"] });
  const g1 = store.create(b1);
  store.approve(g1.id);
  const g2 = store.create(b2);
  store.approve(g2.id);

  const out = store.consumeBatch([{ id: g1.id, binding: b1 }, { id: g2.id, binding: b2 }], "daemon");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0]!.id, g1.id);
  assert.strictEqual(out[1]!.id, g2.id);
  assert.strictEqual(store.get(g1.id)!.status, "used");
  assert.strictEqual(store.get(g2.id)!.status, "used");
});

test("consumeBatch: TOCTOU — clock crosses second TTL during the call → throws approval_expired with NEITHER consumed", () => {
  // Set up: g1 valid forever (within test); g2 has tight TTL.
  // Pin nowMs so that at consumeBatch entry, g2 is JUST past its expires_at.
  // The bug being closed: per-plan consume would have consumed g1 first
  // (clock < g1.expires_at), then read clock again for g2 and seen
  // clock > g2.expires_at. Atomic batch captures clock ONCE and refuses to
  // mutate.
  let nowMs = 1000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => nowMs });
  const b1 = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const b2 = makeBindingFor("inject_submit", { destination_domain: "b.com", allowed_domains: ["b.com"] });
  // Both created at nowMs=1000 with ttl=100 → expires_at=1100.
  const g1 = store.create(b1);
  const g2 = store.create(b2);
  store.approve(g1.id);
  store.approve(g2.id);

  // Cross BOTH TTLs.
  nowMs = 1500;

  assert.throws(
    () => store.consumeBatch([{ id: g1.id, binding: b1 }, { id: g2.id, binding: b2 }], "daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_expired",
  );
  // Critical: NEITHER consumed.
  assert.strictEqual(store.get(g1.id)!.status, "granted");
  assert.strictEqual(store.get(g2.id)!.status, "granted");
});

test("consumeBatch: duplicate id → bad_request, no mutations", () => {
  const store = new ApprovalStore();
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  store.approve(g.id);
  assert.throws(
    () => store.consumeBatch([{ id: g.id, binding: b }, { id: g.id, binding: b }], "daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request",
  );
  assert.strictEqual(store.get(g.id)!.status, "granted");
});

test("consumeBatch: one mismatch → throws approval_mismatch with NEITHER consumed", () => {
  const store = new ApprovalStore();
  const b1 = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const b2 = makeBindingFor("inject_submit", { destination_domain: "b.com", allowed_domains: ["b.com"] });
  const g1 = store.create(b1);
  store.approve(g1.id);
  const g2 = store.create(b2);
  store.approve(g2.id);
  // Pass g2 against b1's binding shape — should mismatch.
  assert.throws(
    () => store.consumeBatch([{ id: g1.id, binding: b1 }, { id: g2.id, binding: b1 }], "daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_mismatch",
  );
  assert.strictEqual(store.get(g1.id)!.status, "granted");
  assert.strictEqual(store.get(g2.id)!.status, "granted");
});

// ---------------------------------------------------------------------------
// validateConsumeBatch
// ---------------------------------------------------------------------------

test("validateConsumeBatch: passes when all granted + within TTL, no mutations", () => {
  const store = new ApprovalStore();
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  store.approve(g.id);
  // Should not throw, should not mutate.
  store.validateConsumeBatch([{ id: g.id, binding: b }], "daemon");
  assert.strictEqual(store.get(g.id)!.status, "granted");
});

test("validateConsumeBatch: throws approval_expired when past TTL, no mutations", () => {
  let nowMs = 1000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => nowMs });
  const b = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const g = store.create(b);
  store.approve(g.id);
  nowMs = 1500;
  assert.throws(
    () => store.validateConsumeBatch([{ id: g.id, binding: b }], "daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_expired",
  );
  assert.strictEqual(store.get(g.id)!.status, "granted");
});

test("validateConsumeBatch: throws approval_mismatch but does NOT consume", () => {
  const store = new ApprovalStore();
  const b1 = makeBindingFor("inject_submit", { destination_domain: "a.com", allowed_domains: ["a.com"] });
  const b2 = makeBindingFor("inject_submit", { destination_domain: "b.com", allowed_domains: ["b.com"] });
  const g = store.create(b1);
  store.approve(g.id);
  assert.throws(
    () => store.validateConsumeBatch([{ id: g.id, binding: b2 }], "daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_mismatch",
  );
  assert.strictEqual(store.get(g.id)!.status, "granted");
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
