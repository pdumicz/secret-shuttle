import test from "node:test";
import assert from "node:assert/strict";
import { ShuttleError } from "../shared/errors.js";
import { resolveDaemonToken } from "./auth-token.js";

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const orig: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    orig[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("env SECRET_SHUTTLE_AGENT_TOKEN wins over socket fallback", async () => {
  await withEnv(
    {
      SECRET_SHUTTLE_AGENT_TOKEN: "claude-abc.someHmacValueLong",
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: undefined,
    },
    async () => {
      const r = await resolveDaemonToken({
        port: 0,
        readSocketTokenFn: async () => "rootTok",
      });
      assert.equal(r.scope, "agent");
      assert.equal(r.bearer, "claude-abc.someHmacValueLong");
      assert.equal(r.agentId, "claude-abc");
    },
  );
});

test("REQUIRE_AGENT_TOKEN=1 + missing AGENT_TOKEN → throws agent_token_required", async () => {
  await withEnv(
    {
      SECRET_SHUTTLE_AGENT_TOKEN: undefined,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    },
    async () => {
      await assert.rejects(
        () => resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" }),
        (e: unknown) => e instanceof ShuttleError && e.code === "agent_token_required",
      );
    },
  );
});

test("no agent env, no require → fall back to socket root token", async () => {
  await withEnv(
    {
      SECRET_SHUTTLE_AGENT_TOKEN: undefined,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: undefined,
    },
    async () => {
      const r = await resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" });
      assert.equal(r.scope, "root");
      assert.equal(r.bearer, "rootTok");
      assert.equal(r.agentId, undefined);
    },
  );
});

test("REQUIRE_AGENT_TOKEN=1 + present AGENT_TOKEN → uses the agent token (no fail-closed)", async () => {
  await withEnv(
    {
      SECRET_SHUTTLE_AGENT_TOKEN: "claude-xyz.someHmac",
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    },
    async () => {
      const r = await resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" });
      assert.equal(r.scope, "agent");
      assert.equal(r.agentId, "claude-xyz");
    },
  );
});

test("malformed agent token (no dot) treated as agent scope without agentId — token is forwarded as-is", async () => {
  // The validation of bearer shape happens on the daemon side via parseBearer
  // (Task A4). The client resolver doesn't re-parse — it just forwards.
  // We DON'T set agentId when no dot is present (no name to extract).
  await withEnv(
    { SECRET_SHUTTLE_AGENT_TOKEN: "no-dot-token", SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: undefined },
    async () => {
      const r = await resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" });
      assert.equal(r.scope, "agent");
      assert.equal(r.bearer, "no-dot-token");
      assert.equal(r.agentId, undefined);
    },
  );
});
