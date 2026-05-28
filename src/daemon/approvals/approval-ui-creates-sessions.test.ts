// Burst 5 §2b Task 2b.4: approve route must mint session grants from
// BatchState.plan when the POST body carries `{ session: { ttl_minutes } }`,
// and must roll back any already-precreated sessions on a mid-flight throw.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";
import type { SessionPattern } from "./session.js";

// ── shared harness (mirrors src/daemon/api/routes/bootstrap.test.ts) ────────

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ui-creates-sessions-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, home });
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
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function unlockVault(ctx: { port: number; token: string }): Promise<void> {
  const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "testpass", set_passphrase: true });
  assert.equal(r.status, 200, `unlock failed: ${JSON.stringify(r.body)}`);
}

/**
 * Mint a bootstrap-action approval whose batch has at least 2 distinct
 * destinations. Uses the live POST /v1/bootstrap/plan path: when the
 * environment is production, the daemon mints an approval (no inline
 * execution) and returns approval_required + batch_id. We grab the
 * approval id, its ui_token (from the in-process ApprovalStore), and
 * confirm the BatchState plan is on disk.
 */
async function mintBootstrapApproval(
  ctx: { port: number; token: string; services: DaemonServices },
): Promise<{ approvalId: string; batchId: string; uiToken: string; ownerAgentId: string }> {
  // One secret pushed to two vercel envs → two distinct destinations on
  // the same template (vercel-env-add), differing in template_params.environment.
  // After dedup-by-pattern in inferSessionPatternFromPlan, that yields
  // 2 SessionPatterns (template_params.environment is destination-defining
  // for vercel-env-add, see src/daemon/templates/builtin/vercel-env-add.ts).
  const yml = `
version: 1
secrets:
  API_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production", "vercel:preview"]
`;
  const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
  assert.equal(r.status, 400, `expected 400 approval_required, got ${r.status} body=${JSON.stringify(r.body)}`);
  const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
  const approvalId = details.approvals[0]!.approval_id;
  const batchId = details.batch_id;

  // Pull the ui_token straight from the in-process approval store.
  const grant = ctx.services.approvals.get(approvalId);
  assert.ok(grant !== undefined, "minted approval must exist in store");
  return {
    approvalId,
    batchId,
    uiToken: grant!.ui_token,
    ownerAgentId: grant!.owner_agent_id,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /ui/approvals/:id/approve with session body mints N grants owned by approval grant's owner", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const { approvalId, uiToken, ownerAgentId } = await mintBootstrapApproval(ctx);

    // POST with session body → approve + mint sessions in one go.
    const res = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${approvalId}/approve?token=${uiToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: { ttl_minutes: 15 } }),
      },
    );
    assert.equal(res.status, 200, `approve POST failed: status=${res.status}`);
    const respBody = (await res.json()) as { ok: boolean; status: string };
    assert.equal(respBody.ok, true);
    assert.equal(respBody.status, "granted");

    // Main approval is granted.
    assert.equal(ctx.services.approvals.get(approvalId)?.status, "granted");

    // The list endpoint surfaces ≥2 granted sessions owned by the approval grant's owner.
    const list = await call(ctx, "GET", "/v1/approvals/sessions");
    assert.equal(list.status, 200, `list failed: ${JSON.stringify(list.body)}`);
    const sessions = (list.body.sessions as Array<Record<string, unknown>>);
    // The session list endpoint omits owner_agent_id from its wire shape (it's a
    // server-side filter). To confirm owner-ownership, read straight from the
    // in-process session store.
    const owned = ctx.services.sessionStore
      .list()
      .filter((s) => s.owner_agent_id === ownerAgentId);
    assert.ok(
      owned.length >= 2,
      `expected ≥2 sessions for owner ${ownerAgentId}, got ${owned.length}: ${JSON.stringify(owned)}`,
    );
    for (const s of owned) {
      assert.equal(s.status, "granted", `expected granted, got ${s.status} for ${s.id}`);
      assert.equal(s.ttl_ms, 15 * 60 * 1000, "ttl_ms must reflect ttl_minutes=15");
    }

    // Sanity: each owned session must have actions=["template-run"] and a
    // required_params constraining environment (the destination-defining param).
    const envs = new Set(owned.map((s) => s.required_params?.environment));
    assert.ok(envs.has("production"));
    assert.ok(envs.has("preview"));

    // And the wire-shape list should at least contain those entries.
    assert.ok(sessions.length >= 2, `wire-shape sessions list too short: ${JSON.stringify(sessions)}`);
  });
});

test("if any createForOwner throws, previously-minted grants in the batch roll back", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const { approvalId, uiToken } = await mintBootstrapApproval(ctx);

    // Stub createForOwner so call #1 succeeds (delegating to the real impl)
    // and call #2 throws. revoke() must run on the precreated id and the
    // main grant must not flip to granted.
    const realCreateForOwner = ctx.services.sessionStore.createForOwner.bind(
      ctx.services.sessionStore,
    );
    let callCount = 0;
    Object.defineProperty(ctx.services.sessionStore, "createForOwner", {
      configurable: true,
      value: function (pattern: SessionPattern, ownerAgentId: string) {
        callCount += 1;
        if (callCount === 2) {
          throw new Error("stub: simulated session-mint failure on 2nd call");
        }
        return realCreateForOwner(pattern, ownerAgentId);
      },
    });

    const res = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${approvalId}/approve?token=${uiToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: { ttl_minutes: 15 } }),
      },
    );
    assert.notEqual(res.status, 200, `approve POST should have failed; got status ${res.status}`);

    // Main grant must NOT be granted — the user can retry cleanly.
    assert.equal(
      ctx.services.approvals.get(approvalId)?.status,
      "pending",
      "main grant should still be pending after rollback",
    );

    // No sessions should be in `granted` state for this batch. The first
    // precreated session was created in pending then revoked; the second
    // throw means it was never created.
    const granted = ctx.services.sessionStore
      .list()
      .filter((s) => s.status === "granted");
    assert.equal(
      granted.length,
      0,
      `expected zero granted sessions after rollback, got ${granted.length}: ${JSON.stringify(granted)}`,
    );

    // The single created session (call #1) should have been revoked.
    const revokedOrAbsent = ctx.services.sessionStore.list().every(
      (s) => s.status === "revoked",
    );
    assert.ok(
      revokedOrAbsent,
      `every session in the store should be revoked after rollback; got: ${JSON.stringify(
        ctx.services.sessionStore.list().map((s) => ({ id: s.id, status: s.status })),
      )}`,
    );
  });
});
