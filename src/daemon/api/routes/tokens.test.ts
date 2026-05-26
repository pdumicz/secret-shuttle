import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Mirrors approvals-session.test.ts / bootstrap-owner.test.ts (A10/A11):
// 32-byte random root token so agent bearers can be derived via
// deriveHmac + formatBearer. Inlined here per the A12 plan — do NOT extract
// to a shared module yet.

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-tokens-mint-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token. deriveHmac rejects anything else with
  // root_token_malformed (see src/daemon/auth/token-derive.ts).
  const rootToken = randomBytes(32).toString("base64url");
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: rootToken, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: { port: number; token: string },
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await callWithBearer(ctx, ctx.token, method, p, body);
}

async function callWithBearer(
  ctx: { port: number },
  bearer: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function agentBearer(rootToken: string, agentId: string): string {
  return formatBearer(agentId, deriveHmac(rootToken, agentId));
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /v1/tokens/mint: root can mint any agent_id", async () => {
  // Root is unrestricted — minting an entirely unrelated id like
  // "claude-anything" must succeed and produce a token of the form
  // "claude-anything.<hmac>" derived from the daemon's root token.
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/tokens/mint", { agent_id: "claude-anything" });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; token: string; agent_id: string };
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "claude-anything");
    // Token shape: "<agent_id>.<base64url-hmac>", and the hmac is exactly
    // what we'd derive from the same root token + agent_id locally.
    const expectedHmac = deriveHmac(ctx.token, "claude-anything");
    assert.equal(body.token, formatBearer("claude-anything", expectedHmac));
  });
});

test("POST /v1/tokens/mint: non-root can mint a child within its namespace", async () => {
  // Caller "claude-7f2a" mints child "claude-7f2a.helper-3a1b" — the child
  // id starts with the caller's id + ".", which is allowed.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "claude-7f2a.helper-3a1b",
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; token: string; agent_id: string };
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "claude-7f2a.helper-3a1b");
    assert.equal(
      body.token,
      formatBearer("claude-7f2a.helper-3a1b", deriveHmac(ctx.token, "claude-7f2a.helper-3a1b")),
    );
  });
});

test("POST /v1/tokens/mint: non-root CANNOT mint outside namespace", async () => {
  // Caller "claude-7f2a" tries to mint an entirely unrelated id
  // "cursor-deadbeef" — rejected with agent_id_namespace_violation.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "cursor-deadbeef",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "agent_id_namespace_violation",
      `expected agent_id_namespace_violation, got: ${error.code} body=${JSON.stringify(r.body)}`,
    );
  });
});

test("POST /v1/tokens/mint: non-root CANNOT mint own identity again", async () => {
  // Caller "claude-7f2a" tries to mint "claude-7f2a" (itself, no child
  // suffix). The namespace check requires a strict sub-id, so this is
  // rejected with agent_id_namespace_violation — preventing re-issuance
  // of one's own token via a stateless mint loop.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "claude-7f2a",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "agent_id_namespace_violation",
      `expected agent_id_namespace_violation for self-mint, got: ${error.code} body=${JSON.stringify(r.body)}`,
    );
  });
});

test("POST /v1/tokens/mint: returned token validates against current root_token", async () => {
  // End-to-end proof of stateless HMAC validity: take the returned token,
  // use it as the bearer for /v1/whoami, and confirm the server resolves
  // it back to the same agent_id (and is_root === false because it was
  // minted as a derived agent token, not the root).
  await withDaemon(async (ctx) => {
    const mintRes = await call(ctx, "POST", "/v1/tokens/mint", {
      agent_id: "claude-validate-self",
    });
    assert.equal(mintRes.status, 200, `mint failed: ${JSON.stringify(mintRes.body)}`);
    const mint = mintRes.body as { token: string; agent_id: string };

    const whoRes = await callWithBearer(ctx, mint.token, "GET", "/v1/whoami");
    assert.equal(whoRes.status, 200, `whoami failed: ${JSON.stringify(whoRes.body)}`);
    const who = whoRes.body as { ok: boolean; agent_id: string; is_root: boolean };
    assert.equal(who.ok, true);
    assert.equal(
      who.agent_id,
      "claude-validate-self",
      `whoami must echo the minted agent_id, got: ${who.agent_id}`,
    );
    assert.equal(who.is_root, false, "minted agent tokens must NOT be is_root");
  });
});
