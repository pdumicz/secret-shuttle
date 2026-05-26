import test from "node:test";
import assert from "node:assert/strict";
import { getAuditActor } from "./audit.js";
import { withAuthContext } from "./auth/auth-context.js";

test("getAuditActor: standard request site reads agent_id from ALS", async () => {
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    assert.equal(getAuditActor({ site: "request" }), "claude-abc");
  });
});

test("getAuditActor: lifecycle site is 'daemon'", () => {
  assert.equal(getAuditActor({ site: "lifecycle" }), "daemon");
});

test("getAuditActor: persisted-owner site reads provided owner", () => {
  assert.equal(getAuditActor({ site: "persisted-owner", ownerAgentId: "cursor-xyz" }), "cursor-xyz");
});

test("getAuditActor: request site without ALS context falls back to 'daemon'", () => {
  assert.equal(getAuditActor({ site: "request" }), "daemon");
});
