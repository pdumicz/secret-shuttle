import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "./store.js";
import { SessionStore } from "./session-store.js";
import { withAuthContext } from "../auth/auth-context.js";
import type { ApprovalBinding } from "./store.js";
import type { SessionPattern } from "./session.js";

const binding: ApprovalBinding = {
  action: "generate",
  ref: null,
  planned_ref: "ss://local/dev/X",
  environment: "development",
  destination_domain: null,
  target_id: null,
  field_fingerprint: null,
  template_id: null,
  template_params: null,
  allowed_domains: [],
};

test("ApprovalStore.mint: stamps owner_agent_id from ALS context", async () => {
  const store = new ApprovalStore();
  let id = "";
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    id = store.create(binding).id;
  });
  const grant = store.get(id);
  assert.equal(grant?.owner_agent_id, "claude-abc");
});

test("ApprovalStore.mint: stamps 'root' when ALS is root", async () => {
  const store = new ApprovalStore();
  let id = "";
  await withAuthContext({ agent_id: "root", isRoot: true }, () => {
    id = store.create(binding).id;
  });
  assert.equal(store.get(id)?.owner_agent_id, "root");
});

test("ApprovalStore.mint: stamps 'daemon' if no ALS context (defensive)", () => {
  const store = new ApprovalStore();
  const id = store.create(binding).id;
  assert.equal(store.get(id)?.owner_agent_id, "daemon");
});

test("SessionStore.create: stamps owner_agent_id from ALS context", async () => {
  const store = new SessionStore();
  const pattern: SessionPattern = {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
  };
  let id = "";
  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, () => {
    id = store.create(pattern).id;
  });
  const grant = store.get(id);
  assert.equal(grant?.owner_agent_id, "cursor-xyz");
});

test("SessionStore.create: stamps 'daemon' if no ALS context (defensive)", () => {
  const store = new SessionStore();
  const pattern: SessionPattern = {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
  };
  const id = store.create(pattern).id;
  assert.equal(store.get(id)?.owner_agent_id, "daemon");
});
