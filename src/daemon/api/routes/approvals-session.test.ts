import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { PENDING_TTL_MS } from "../../approvals/session.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-approvals-session-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: { port: number; token: string },
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("POST /v1/approvals/session with wait_for_approval=false returns session_id + status:pending", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [], // ignored for template-run
        template_ids: ["vercel-env-add"],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    const body = r.body as { session_id: string; status: string; expires_at: number };
    assert.equal(typeof body.session_id, "string");
    assert.equal(body.status, "pending");
    assert.equal(typeof body.expires_at, "number");
    // expires_at is the PENDING window (~2 min), NOT the pattern.ttl_ms.
    const pending = ctx.services.sessionStore.get(body.session_id)!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.expires_at, pending.created_at + PENDING_TTL_MS);
  });
});

test("POST /v1/approvals/session: invalid pattern → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: [], // empty
        ref_glob: "ss://x/*",
        destination_domains: [],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("POST /v1/approvals/session: invalid glob → session_pattern_invalid_glob", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://*/prod/*", // ** equivalent — rejected by globToRegExp
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal(
      (r.body as { error: { code: string } }).error.code,
      "session_pattern_invalid_glob",
    );
  });
});

test("POST /v1/approvals/session: secrets-delete in actions → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["secrets-delete"],
        ref_glob: "ss://x/*",
        destination_domains: [],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("POST /v1/approvals/session: ttl > 15min → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "",
        destination_domains: [],
        template_ids: ["any"], // required for template-run; the ttl check is what we're testing
        ttl_ms: 16 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("POST /v1/approvals/session: destination_domains canonicalized at create (VERCEL.COM → vercel.com in GET list)", async () => {
  // Regression for the P2: pattern domains used to be stored raw, so a session
  // created with ["VERCEL.COM"] silently refused bindings carrying the
  // canonical "vercel.com". Now we normalize at parseSessionPatternFromBody —
  // the stored + serialized pattern is the canonical form.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["inject-submit"],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["VERCEL.COM", "  GitHub.com  "],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(created.status, 200);
    const listed = await call(ctx, "GET", "/v1/approvals/sessions");
    assert.equal(listed.status, 200);
    const sessions = (listed.body as { sessions: Array<{ destination_domains: string[] }> }).sessions;
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.destination_domains, ["vercel.com", "github.com"]);
  });
});

test("POST /v1/approvals/session: wait flow — revoke mid-wait → returns session_revoked (no hang)", async () => {
  // Regression for the P1: prior wait loop checked granted/denied/expired
  // but not revoked. SessionStore.get() only flips pending/granted → expired
  // past TTL — a revoked session is stable in the store, so the loop would
  // sleep+repeat forever. Now we throw session_revoked + status 400.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const reqPromise = call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 5000,
      },
    });
    // Poll the store for the new pending session, then revoke via HTTP.
    let pending: { id: string } | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pending === undefined) {
      const list = ctx.services.sessionStore.list();
      pending = list.find((s) => s.status === "pending");
      if (pending === undefined) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(pending, "expected a pending session");
    // Revoke via HTTP (NOT by mutating the store directly — that's the contract being tested).
    const revokeRes = await call(ctx, "POST", "/v1/approvals/sessions/revoke", {
      session_id: pending.id,
    });
    assert.equal(revokeRes.status, 200);
    // Original wait call should now resolve with session_revoked.
    const r = await reqPromise;
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "session_revoked");
  });
});

test("POST /v1/approvals/session: wait flow — approve via HTTP UI route → returns status:granted", async () => {
  // This test exercises the real HTTP approval path (NOT direct sessionStore.approve()).
  // The session-ui route from Part G2 accepts POST /ui/sessions/:id/approve?token=<ui_token>.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const reqPromise = call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 5000,
      },
    });
    // Poll the store for the new pending session, then approve via HTTP.
    let pending: { id: string; ui_token: string } | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pending === undefined) {
      const list = ctx.services.sessionStore.list();
      pending = list.find((s) => s.status === "pending");
      if (pending === undefined) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(pending, "expected a pending session");
    // Approve via HTTP UI route (not by mutating the store).
    const approveRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${pending.id}/approve?token=${pending.ui_token}`,
      { method: "POST" },
    );
    assert.equal(approveRes.status, 200);
    // Now the create call should return with status: granted.
    const r = await reqPromise;
    assert.equal(r.status, 200);
    const body = r.body as { status: string; session_id: string; expires_at: number };
    assert.equal(body.status, "granted");
    // expires_at is now TTL_ms past approval (not creation).
    const granted = ctx.services.sessionStore.get(body.session_id)!;
    assert.equal(granted.expires_at, granted.approved_at! + 5000);
  });
});
