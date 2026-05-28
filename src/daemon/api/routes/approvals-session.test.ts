import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { PENDING_TTL_MS } from "../../approvals/session.js";
import { withAuthContext } from "../../auth/auth-context.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { getShuttlePaths } from "../../../shared/config.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-approvals-session-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token. The owner-filtering tests below derive
  // agent HMACs from this, which require a 32-byte key (see token-derive.ts).
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

test("POST /v1/approvals/session: ttl > 60min → session_ttl_exceeds_cap", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "",
        destination_domains: [],
        template_ids: ["any"], // required for template-run; the ttl check is what we're testing
        ttl_ms: 61 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "session_ttl_exceeds_cap");
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

// ---------------------------------------------------------------------------
// Owner-filtered list + owner-checked revoke (Task A10).
//
// Mint sessions directly under each agent's AuthContext via the store
// (simpler than driving the full HTTP create flow which requires UI
// approval to reach the "granted" state). The HTTP GET/revoke routes
// are exercised with agent-derived bearer tokens.
// ---------------------------------------------------------------------------

const SAMPLE_PATTERN = {
  actions: ["template-run"] as const,
  ref_glob: "ss://x/prod/*",
  destination_domains: [] as string[],
  template_ids: ["vercel-env-add"],
  ttl_ms: 60_000,
};

test("GET /v1/approvals/sessions: non-root sees only own sessions", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Mint S_A as agent A, S_B as agent B. Direct store calls under
    // withAuthContext set owner_agent_id; HTTP create would also work
    // but adds approval-flow complexity unrelated to this test.
    let idA = "";
    let idB = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      idA = ctx.services.sessionStore.create({ ...SAMPLE_PATTERN, actions: ["template-run"] }).id;
    });
    await withAuthContext({ agent_id: "claude-bbb", isRoot: false }, () => {
      idB = ctx.services.sessionStore.create({ ...SAMPLE_PATTERN, actions: ["template-run"] }).id;
    });
    // GET as agent A → only S_A.
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const listAsA = await callWithBearer(ctx, aBearer, "GET", "/v1/approvals/sessions");
    assert.equal(listAsA.status, 200);
    const sessionsA = (listAsA.body as { sessions: Array<{ id: string }> }).sessions;
    const idsA = sessionsA.map((s) => s.id);
    assert.ok(idsA.includes(idA), "agent A should see S_A");
    assert.ok(!idsA.includes(idB), "agent A should NOT see S_B");
    assert.equal(sessionsA.length, 1);
    // GET as root → both.
    const listAsRoot = await call(ctx, "GET", "/v1/approvals/sessions");
    assert.equal(listAsRoot.status, 200);
    const sessionsRoot = (listAsRoot.body as { sessions: Array<{ id: string }> }).sessions;
    const idsRoot = sessionsRoot.map((s) => s.id);
    assert.ok(idsRoot.includes(idA), "root should see S_A");
    assert.ok(idsRoot.includes(idB), "root should see S_B");
    assert.equal(sessionsRoot.length, 2);
  });
});

test("POST /v1/approvals/sessions/revoke: non-root cross-owner returns session_not_found", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Agent A creates S. Agent B tries to revoke by id.
    let sessionId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      sessionId = ctx.services.sessionStore.create({
        ...SAMPLE_PATTERN,
        actions: ["template-run"],
      }).id;
    });
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const revokeRes = await callWithBearer(ctx, bBearer, "POST", "/v1/approvals/sessions/revoke", {
      session_id: sessionId,
    });
    assert.equal(revokeRes.status, 400);
    assert.equal((revokeRes.body as { error: { code: string } }).error.code, "session_not_found");
    // S is still alive on subsequent agent-A GET (status pending, not revoked).
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const listAsA = await callWithBearer(ctx, aBearer, "GET", "/v1/approvals/sessions");
    assert.equal(listAsA.status, 200);
    const sessionsA = (listAsA.body as { sessions: Array<{ id: string; status: string }> }).sessions;
    const s = sessionsA.find((x) => x.id === sessionId);
    assert.ok(s, "session should still exist for owner");
    assert.notEqual(s!.status, "revoked");
  });
});

test("POST /v1/approvals/sessions/revoke as root: succeeds across owners", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Agent A creates S; root revokes.
    let sessionId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      sessionId = ctx.services.sessionStore.create({
        ...SAMPLE_PATTERN,
        actions: ["template-run"],
      }).id;
    });
    const revokeRes = await call(ctx, "POST", "/v1/approvals/sessions/revoke", {
      session_id: sessionId,
    });
    assert.equal(revokeRes.status, 200);
    assert.equal((revokeRes.body as { revoked: boolean }).revoked, true);
    // S is gone (status revoked) — confirm via the store directly so we
    // observe state independent of the GET filter.
    const after = ctx.services.sessionStore.get(sessionId)!;
    assert.equal(after.status, "revoked");
  });
});

// ── /v1/approvals/poll owner-enforcement (existence non-disclosure) ─────────

test("POST /v1/approvals/poll: non-root cross-owner → approval_not_found (existence non-disclosure)", async () => {
  // Pre-fix: any caller could poll any approval id and learn its status. Now
  // non-root callers can only poll grants they own; cross-owner poll returns
  // the SAME approval_not_found error as a truly missing id — mirrors the
  // semantics ApprovalStore.consume/consumeBatch already enforce (A9).
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Agent A mints a grant. We stamp the grant's owner via the store-level
    // ALS (the public route surface would do the same via per-agent bearer).
    let grantId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const g = ctx.services.approvals.create({
        action: "inject",
        ref: "ss://x/dev/Y",
        environment: "development",
        destination_domain: "x.com",
        target_id: "T1",
        field_fingerprint: "f",
        template_id: null,
        template_params: null,
      });
      grantId = g.id;
    });

    // Agent B polls A's grant via a derived bearer → must look identical to
    // a missing id from B's perspective (existence non-disclosure).
    const bBearer = agentBearer(ctx.token, "cursor-bbb");
    const r = await callWithBearer(ctx, bBearer, "POST", "/v1/approvals/poll", { id: grantId });
    assert.equal(r.status, 400, "non-root cross-owner must hit error mapper");
    assert.equal(
      (r.body as { error: { code: string } }).error.code,
      "approval_not_found",
      "owner mismatch must return the same code as truly-missing — leaks no existence info",
    );
  });
});

test("POST /v1/approvals/poll: same-owner non-root → 200 with status", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    let grantId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const g = ctx.services.approvals.create({
        action: "inject",
        ref: "ss://x/dev/Y",
        environment: "development",
        destination_domain: "x.com",
        target_id: "T1",
        field_fingerprint: "f",
        template_id: null,
        template_params: null,
      });
      grantId = g.id;
    });
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const r = await callWithBearer(ctx, aBearer, "POST", "/v1/approvals/poll", { id: grantId });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, "pending");
    assert.equal((r.body as { id: string }).id, grantId);
  });
});

test("ApprovalStore onEvent audit attributes events to the grant's owner_agent_id (not 'daemon')", async () => {
  // Regression for the P2 finding: raw UI approve/deny routes have no ALS
  // context, so writeDaemonAudit's auto-stamp would fall back to
  // actor_agent_id: "daemon". The grant's persisted owner_agent_id is the
  // correct attribution and is now passed explicitly from the onEvent
  // callback in DaemonServices.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Capture the audit path NOW (before any await could let a parallel test
    // file shift SECRET_SHUTTLE_HOME). writeDaemonAudit reads getShuttlePaths
    // synchronously at call time, so as long as the .approve() call happens
    // while our env is current, the audit lands here.
    const auditPath = getShuttlePaths().auditLogPath;

    // Mint a grant as "claude-abc". The create event already fires here
    // under withAuthContext, but the critical event is the GRANT one which
    // we trigger next OUTSIDE any auth context to simulate the raw UI route.
    let grantId = "";
    await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
      const g = ctx.services.approvals.create({
        action: "inject",
        ref: "ss://x/dev/Y",
        environment: "development",
        destination_domain: "x.com",
        target_id: "T1",
        field_fingerprint: "f",
        template_id: null,
        template_params: null,
      });
      grantId = g.id;
    });

    // Drive the grant lifecycle from OUTSIDE any withAuthContext — mirrors
    // the raw /ui/approvals/:id/approve route which has no bearer parse.
    ctx.services.approvals.approve(grantId);

    // Poll the audit log for the expected record. The onEvent callback is
    // void-bound (fire-and-forget) so we must wait for the appendFile to
    // settle. Polling avoids a magic-number sleep.
    let granted: Record<string, unknown> | undefined;
    let created: Record<string, unknown> | undefined;
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((r) => setImmediate(r));
      const log = await readFile(auditPath, "utf8").catch(() => "");
      const records = log
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      granted = records.find((r) => r.action === "approval_granted" && r.approval_id === grantId);
      created = records.find((r) => r.action === "approval_created" && r.approval_id === grantId);
      if (granted !== undefined && created !== undefined) break;
    }
    assert.ok(granted, "an approval_granted record must exist for the grant");
    assert.equal(
      granted!.actor_agent_id,
      "claude-abc",
      "actor must be the grant's owner_agent_id (not 'daemon')",
    );
    // The create event also fires (under ALS for "claude-abc"). Both should
    // carry the same actor; the regression is about the GRANT event written
    // outside the ALS context.
    assert.ok(created);
    assert.equal(created!.actor_agent_id, "claude-abc");
  });
});

test("POST /v1/approvals/poll: root → 200 with status across owners", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    let grantId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const g = ctx.services.approvals.create({
        action: "inject",
        ref: "ss://x/dev/Y",
        environment: "development",
        destination_domain: "x.com",
        target_id: "T1",
        field_fingerprint: "f",
        template_id: null,
        template_params: null,
      });
      grantId = g.id;
    });
    // call() uses the root token → isRoot: true should bypass owner check.
    const r = await call(ctx, "POST", "/v1/approvals/poll", { id: grantId });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, "pending");
  });
});
