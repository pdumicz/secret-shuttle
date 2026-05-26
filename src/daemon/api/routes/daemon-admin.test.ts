// src/daemon/api/routes/daemon-admin.test.ts
//
// Tests for the A13 admin routes:
//   POST /v1/daemon/rotate              — root-only, regenerates root_token,
//                                          hot-swaps in-memory token, rewrites
//                                          socket file. ALL derived agent
//                                          tokens are invalidated because the
//                                          HMAC key changes.
//   POST /v1/daemon/reset-machine-id   — root-only, deletes <SHUTTLE_HOME>/
//                                          machine-id so the next `init`
//                                          re-derives per-runtime agent_ids.
//                                          Does NOT invalidate existing tokens
//                                          (HMAC depends on root token, NOT on
//                                          machine-id).
//
// All tests exercise the real HTTP server (DaemonServer.listen) — no
// shortcuts. SECRET_SHUTTLE_HOME is pointed at a tmpdir for isolation so the
// rotated root-token file does not clobber a developer's real ~/.secret-shuttle.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { readSocketFile, writeSocketFile } from "../../socket-file.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { ensureRootToken } from "../../root-token.js";
import { ensureMachineId } from "../../machine-id.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Same shape as tokens.test.ts (A12) — 32-byte base64url root token so derived
// agent bearers verify against the daemon's in-memory token. The test creates
// a real root-token file under SHUTTLE_HOME so rotateRootToken() has a target
// to atomically replace, then writes a real socket file so the rotate route's
// writeSocketFile() call has a baseline to overwrite (the test asserts on the
// post-rotate file contents).

async function withDaemon<T>(
  fn: (ctx: {
    port: number;
    token: string;
    home: string;
    server: DaemonServer;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-daemon-admin-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";

  // The rotate route calls rotateRootToken(home), which writes the new token
  // to <home>/root-token. The file does not need to pre-exist (rotate creates
  // it), but we keep the in-memory token aligned with whatever ensureRootToken
  // produces so a fresh dev daemon would see the same value on next boot.
  const rootToken = await ensureRootToken(home);
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  // Seed the socket file so the rotate route's writeSocketFile call is
  // semantically a rewrite (matches production where startDaemon already
  // wrote a socket file).
  await writeSocketFile({ port, token: rootToken, pid: process.pid });
  try {
    return await fn({ port, token: rootToken, home, server });
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

test("POST /v1/daemon/rotate: root-only, regenerates root_token, in-memory swap", async () => {
  // End-to-end rotate flow:
  //   1. Start daemon with root token R1.
  //   2. POST /v1/daemon/rotate as root → 200 with the standard success
  //      message. The new token is NOT in the response — the client must
  //      re-read the socket file (this is exactly what daemon-client does
  //      via resolveDaemonToken).
  //   3. R1 is now invalid: a subsequent /v1/whoami with R1 → 401.
  //   4. The socket file's `token` field has been replaced with R2; using
  //      R2 against /v1/whoami → 200 with is_root=true.
  //   5. The on-disk root-token file matches the new socket file token
  //      (both produced by the same rotate call).
  await withDaemon(async (ctx) => {
    const r = await callWithBearer(ctx, ctx.token, "POST", "/v1/daemon/rotate");
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /rotated/i, `expected rotation message, got: ${body.message}`);

    // Old token must now be rejected.
    const stale = await callWithBearer(ctx, ctx.token, "GET", "/v1/whoami");
    assert.equal(
      stale.status,
      401,
      `old token must be rejected after rotate, got ${stale.status} body=${JSON.stringify(stale.body)}`,
    );

    // Pull the new token off the socket file (the client contract for rotate).
    const sf = await readSocketFile();
    assert.notEqual(sf, null, "socket file must still exist after rotate");
    assert.notEqual(sf!.token, ctx.token, "socket file token must change after rotate");

    // Cross-check the on-disk root-token file agrees with the socket file.
    const onDisk = (await readFile(path.join(ctx.home, "root-token"), "utf8")).trim();
    assert.equal(
      onDisk,
      sf!.token,
      "root-token file and socket file must agree after rotate",
    );

    // New token works.
    const fresh = await callWithBearer(ctx, sf!.token, "GET", "/v1/whoami");
    assert.equal(
      fresh.status,
      200,
      `new token must be accepted, got ${fresh.status} body=${JSON.stringify(fresh.body)}`,
    );
    const who = fresh.body as { ok: boolean; agent_id: string; is_root: boolean };
    assert.equal(who.is_root, true, "new token resolves to is_root=true");
    assert.equal(who.agent_id, "root");
  });
});

test("POST /v1/daemon/rotate: non-root → unauthorized", async () => {
  // A derived agent token (minted from the current root) is NOT allowed to
  // rotate. The route guards with `ctx?.isRoot !== true` → throws
  // ShuttleError("unauthorized"), which the server serializer maps to HTTP
  // 400 + error.code === "unauthorized". (The bearer is valid; it's the
  // *authorization* that fails, not authentication.)
  await withDaemon(async (ctx) => {
    const childBearer = agentBearer(ctx.token, "claude-some-agent");
    const r = await callWithBearer(ctx, childBearer, "POST", "/v1/daemon/rotate");
    assert.notEqual(r.status, 200, "non-root must NOT succeed in rotating");
    const err = (r.body as { error: { code: string } }).error;
    assert.equal(
      err.code,
      "unauthorized",
      `expected unauthorized, got: ${err.code} body=${JSON.stringify(r.body)}`,
    );

    // Verify rotate did NOT occur: the original root token still works.
    const stillRoot = await callWithBearer(ctx, ctx.token, "GET", "/v1/whoami");
    assert.equal(stillRoot.status, 200, "root token must still be valid after rejected rotate");
  });
});

test("POST /v1/daemon/reset-machine-id: root-only, regenerates file, does NOT invalidate tokens", async () => {
  // Reset-machine-id must NOT affect token validity — the HMAC chain depends
  // on the root token, not the machine-id. The test:
  //   1. Mint an agent bearer T for "claude-7f2a" under the current root R1.
  //   2. T works → /v1/whoami → 200.
  //   3. Ensure a machine-id file exists (so reset has something to delete).
  //   4. POST /v1/daemon/reset-machine-id as root → 200.
  //   5. T STILL works → /v1/whoami → 200 (the invariant).
  //   6. The on-disk machine-id file is gone (the reset effect).
  //   7. Non-root caller is rejected with `unauthorized`.
  await withDaemon(async (ctx) => {
    const childBearer = agentBearer(ctx.token, "claude-7f2a");

    // Sanity: the agent token validates pre-reset.
    const pre = await callWithBearer(ctx, childBearer, "GET", "/v1/whoami");
    assert.equal(pre.status, 200, `pre-reset agent token must work, got ${pre.status}`);

    // Create a machine-id so reset has a file to remove.
    await ensureMachineId(ctx.home);

    // Non-root caller is rejected — exercise this BEFORE the actual reset to
    // confirm the guard ordering (route checks ctx.isRoot before doing any
    // filesystem work).
    const denied = await callWithBearer(ctx, childBearer, "POST", "/v1/daemon/reset-machine-id");
    assert.notEqual(denied.status, 200);
    assert.equal(
      (denied.body as { error: { code: string } }).error.code,
      "unauthorized",
      `non-root reset must be unauthorized, body=${JSON.stringify(denied.body)}`,
    );

    // Real reset, as root.
    const r = await callWithBearer(ctx, ctx.token, "POST", "/v1/daemon/reset-machine-id");
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /machine-id/i);
    // Help text must call out that this does NOT revoke tokens (the whole
    // point of having a separate rotate command). Match `revoc` so the test
    // catches both "revoke" and "revocation".
    assert.match(
      body.message,
      /not.*revoc/i,
      `reset-machine-id message must clarify it does NOT revoke tokens, got: ${body.message}`,
    );

    // The on-disk machine-id file is gone (verify the reset actually
    // happened). readFile should ENOENT.
    let machineIdGone = false;
    try {
      await readFile(path.join(ctx.home, "machine-id"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") machineIdGone = true;
    }
    assert.equal(machineIdGone, true, "machine-id file must be removed by reset");

    // Critical invariant: derived agent token T still validates after reset.
    const post = await callWithBearer(ctx, childBearer, "GET", "/v1/whoami");
    assert.equal(
      post.status,
      200,
      `agent token must survive machine-id reset (HMAC depends on root, not machine-id), got ${post.status} body=${JSON.stringify(post.body)}`,
    );
  });
});
