import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { ApprovalStore } from "./store.js";

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
