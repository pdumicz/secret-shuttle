import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DaemonServer } from "./server.js";
import { deriveHmac, formatBearer } from "./auth/token-derive.js";
import { getCurrentAgentId, getAuthContext } from "./auth/auth-context.js";

const ROOT = randomBytes(32).toString("base64url"); // 43 chars

async function fetchWith(
  port: number,
  auth: string | null,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (auth !== null) headers["authorization"] = auth;
  const res = await fetch(`http://127.0.0.1:${port}/v1/whoami`, { method: "POST", headers });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

test("DaemonServer: root bearer resolves AuthContext { agent_id: 'root', isRoot: true }", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => {
    const ctx = getAuthContext();
    return { agent_id: getCurrentAgentId(), is_root: ctx?.isRoot ?? false };
  });
  const { port } = await server.listen(0);
  try {
    const r = await fetchWith(port, `Bearer ${ROOT}`);
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; agent_id: string; is_root: boolean };
    assert.equal(body.agent_id, "root");
    assert.equal(body.is_root, true);
  } finally {
    await server.close();
  }
});

test("DaemonServer: valid agent token resolves agent_id with isRoot=false", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => {
    const ctx = getAuthContext();
    return { agent_id: getCurrentAgentId(), is_root: ctx?.isRoot ?? false };
  });
  const { port } = await server.listen(0);
  try {
    const tok = formatBearer("claude-7f2a", deriveHmac(ROOT, "claude-7f2a"));
    const r = await fetchWith(port, `Bearer ${tok}`);
    assert.equal(r.status, 200);
    const body = r.body as { agent_id: string; is_root: boolean };
    assert.equal(body.agent_id, "claude-7f2a");
    assert.equal(body.is_root, false);
  } finally {
    await server.close();
  }
});

test("DaemonServer: HMAC mismatch returns 401 with error_code=unauthorized", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({}));
  const { port } = await server.listen(0);
  try {
    const bogusHmac = "A".repeat(43);
    const r = await fetchWith(port, `Bearer claude-7f2a.${bogusHmac}`);
    assert.equal(r.status, 401);
    const body = r.body as { error_code?: string };
    assert.equal(body.error_code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("DaemonServer: 'root.<anything>' bearer returns 401 (reserved agent_id)", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({}));
  const { port } = await server.listen(0);
  try {
    const r = await fetchWith(port, `Bearer root.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    assert.equal(r.status, 401);
  } finally {
    await server.close();
  }
});

test("DaemonServer: missing Authorization header → 401", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({}));
  const { port } = await server.listen(0);
  try {
    const r = await fetchWith(port, null);
    assert.equal(r.status, 401);
  } finally {
    await server.close();
  }
});

test("DaemonServer.replaceRootToken: swaps in-memory token; old root rejected, new root accepted", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({ ok: "yes" }));
  const { port } = await server.listen(0);
  try {
    // OLD token works
    let r = await fetchWith(port, `Bearer ${ROOT}`);
    assert.equal(r.status, 200);
    // Hot-swap
    const NEW_ROOT = randomBytes(32).toString("base64url");
    server.replaceRootToken(NEW_ROOT);
    // OLD token now 401
    r = await fetchWith(port, `Bearer ${ROOT}`);
    assert.equal(r.status, 401);
    // NEW root token works
    r = await fetchWith(port, `Bearer ${NEW_ROOT}`);
    assert.equal(r.status, 200);
    // Derived tokens under OLD root are now invalid; under NEW root valid
    const oldDerived = formatBearer("claude-x", deriveHmac(ROOT, "claude-x"));
    r = await fetchWith(port, `Bearer ${oldDerived}`);
    assert.equal(r.status, 401);
    const newDerived = formatBearer("claude-x", deriveHmac(NEW_ROOT, "claude-x"));
    r = await fetchWith(port, `Bearer ${newDerived}`);
    assert.equal(r.status, 200);
  } finally {
    await server.close();
  }
});
