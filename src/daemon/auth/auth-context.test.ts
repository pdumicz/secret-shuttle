import test from "node:test";
import assert from "node:assert/strict";
import {
  authContext,
  withAuthContext,
  getAuthContext,
  getCurrentAgentId,
  type AuthContext,
} from "./auth-context.js";

test("withAuthContext / getAuthContext: propagates through async boundaries", async () => {
  const ctx: AuthContext = { agent_id: "claude-abc", isRoot: false };
  await withAuthContext(ctx, async () => {
    assert.deepEqual(getAuthContext(), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(getCurrentAgentId(), "claude-abc");
  });
});

test("getAuthContext outside a withAuthContext call returns undefined", () => {
  assert.equal(getAuthContext(), undefined);
});

test("getCurrentAgentId outside any context returns 'daemon' sentinel for audit", () => {
  assert.equal(getCurrentAgentId(), "daemon");
});

test("root context: isRoot=true, agent_id='root'", async () => {
  await withAuthContext({ agent_id: "root", isRoot: true }, () => {
    const ctx = getAuthContext();
    assert.equal(ctx?.isRoot, true);
    assert.equal(ctx?.agent_id, "root");
    assert.equal(getCurrentAgentId(), "root");
  });
});

test("nested withAuthContext: inner context shadows outer", async () => {
  await withAuthContext({ agent_id: "outer", isRoot: false }, async () => {
    assert.equal(getCurrentAgentId(), "outer");
    await withAuthContext({ agent_id: "inner", isRoot: false }, () => {
      assert.equal(getCurrentAgentId(), "inner");
    });
    // After the inner block exits, the outer context is restored.
    assert.equal(getCurrentAgentId(), "outer");
  });
});

test("withAuthContext: returns the value the callback returns", async () => {
  const result = await withAuthContext({ agent_id: "x", isRoot: false }, () => 42);
  assert.equal(result, 42);
});

test("authContext is the exported AsyncLocalStorage instance", () => {
  // Smoke check: the exported instance can store/retrieve a value via .run().
  let stored: AuthContext | undefined;
  authContext.run({ agent_id: "via-direct-run", isRoot: false }, () => {
    stored = authContext.getStore();
  });
  assert.equal(stored?.agent_id, "via-direct-run");
});
