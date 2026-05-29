import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./session-store.js";
import type { SessionPattern } from "./session.js";

function p(): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    required_params: { name: "STRIPE_KEY", environment: "production" },
    ttl_ms: 5 * 60 * 1000,
  };
}

test("createForOwner stamps the supplied owner regardless of ambient context", () => {
  const store = new SessionStore({ now: () => 0 });
  const g = store.createForOwner(p(), "claude-abc123");
  assert.equal(g.owner_agent_id, "claude-abc123");
});

test("createForOwner runs validator (rejects malformed required_params)", () => {
  const store = new SessionStore({ now: () => 0 });
  const bad = { ...p(), required_params: [] as any };
  assert.throws(
    () => store.createForOwner(bad, "claude-abc123"),
    /required_params must be an object/,
  );
});

test("createForOwner returns a grant with the canonical SessionGrant shape", () => {
  const store = new SessionStore({ now: () => 1_000_000 });
  const g = store.createForOwner(p(), "claude-xyz");
  // Canonical fields per session.ts SessionGrant interface
  assert.equal(typeof g.id, "string");
  assert.equal(typeof g.ui_token, "string");
  assert.equal(g.status, "pending");
  assert.equal(g.created_at, 1_000_000);
  assert.equal(g.approved_at, null);
  assert.equal(typeof g.expires_at, "number");
  assert.equal(g.uses, 0);
  assert.equal(g.owner_agent_id, "claude-xyz");
  // Pattern fields copied through
  assert.deepEqual(g.actions, ["template-run"]);
  assert.equal(g.ref_glob, "ss://stripe/prod/STRIPE_KEY");
});

test("createForOwner-created grant remains retrievable via store.get", () => {
  const store = new SessionStore({ now: () => 0 });
  const g = store.createForOwner(p(), "claude-abc123");
  const got = store.get(g.id);
  assert.equal(got?.owner_agent_id, "claude-abc123");
});
