import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { withAuthContext } from "../../auth/auth-context.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import type { BatchState, PlanEntry } from "../../bootstrap/store.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Mirrors approvals-session.test.ts (A10): 32-byte random root token so agent
// bearers can be derived via deriveHmac + formatBearer.

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bootstrap-owner-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token. The owner-enforcement tests below derive
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

/** Unlock the vault with a fresh passphrase. */
async function unlockVault(ctx: { port: number; token: string }): Promise<void> {
  const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "testpass", set_passphrase: true });
  assert.equal(r.status, 200, `unlock failed: ${JSON.stringify(r.body)}`);
}

/**
 * Build a minimal PlanEntry for seeding BatchState. Uses random_32_bytes
 * (no capture / no existing-vault lookup needed) with a single vercel:production
 * destination. The exact plan shape doesn't matter for owner-enforcement tests —
 * the gate runs before the executor even starts.
 */
function samplePlan(secretName: string): PlanEntry[] {
  return [
    {
      secret: secretName,
      ref: `ss://local/prod/${secretName}`,
      source: { kind: "random_32_bytes" },
      destinations: [
        {
          shorthand: "vercel:production",
          template_id: "vercel-env-add",
          template_params: { name: secretName, environment: "production" },
          domain: "vercel.com",
        },
      ],
    },
  ];
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /v1/bootstrap/plan: stamps owner_agent_id on BatchState from ALS", async () => {
  // /plan reads getCurrentAgentId() from the ALS AuthContext set by the server
  // when it parses the agent bearer. Calling /plan with agent A's bearer must
  // result in a saved BatchState whose owner_agent_id === "claude-aaa".
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  OWNED_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const r = await callWithBearer(ctx, aBearer, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    // Production destination → approval_required → 400 with batch_id in details.
    assert.equal(r.status, 400, `expected 400 approval_required, got ${r.status} body=${JSON.stringify(r.body)}`);
    const details = r.body.details as { batch_id: string } | undefined;
    assert.ok(details !== undefined && typeof details.batch_id === "string", "expected batch_id in details");

    // Verify the persisted BatchState carries owner_agent_id = "claude-aaa".
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(
      state!.owner_agent_id,
      "claude-aaa",
      `expected owner_agent_id="claude-aaa" (from ALS), got: ${state!.owner_agent_id}`,
    );
  });
});

test("POST /v1/bootstrap/continue: non-root cross-owner returns bootstrap_batch_not_found", async () => {
  // Agent A creates a batch; agent B calls /continue with batch_id.
  // Existence non-disclosure: B sees bootstrap_batch_not_found (same code as a
  // truly-missing batch), NOT a different error that would leak existence.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-owner-continue-cross";
    // Seed via store directly under agent A's context. The route doesn't need
    // a real /plan call to test enforcement — only that the BatchState
    // owner_agent_id is set correctly.
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: batchId,
        approval_id: "",
        plan_file_path: "",
        plan: samplePlan("CROSS_OWNER_KEY"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-aaa",
      });
    });

    // Agent B tries to /continue A's batch.
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const r = await callWithBearer(ctx, bBearer, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "bootstrap_batch_not_found",
      `cross-owner /continue must return bootstrap_batch_not_found (existence non-disclosure), got: ${error.code}`,
    );

    // Batch must still exist on disk (B's failed call must not have deleted it).
    const after = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(after !== null, "batch must still exist for owner");
    assert.equal(after!.owner_agent_id, "claude-aaa", "owner must be unchanged");
  });
});

test("POST /v1/bootstrap/abandon: non-root cross-owner returns bootstrap_batch_not_found and does not delete", async () => {
  // Agent A creates batch; agent B calls /abandon → bootstrap_batch_not_found.
  // Batch must NOT be deleted (otherwise B can grief A by enumerating ids).
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-owner-abandon-cross";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: batchId,
        approval_id: "",
        plan_file_path: "",
        plan: samplePlan("ABANDON_OWNER_KEY"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-aaa",
      });
    });

    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const r = await callWithBearer(ctx, bBearer, "POST", "/v1/bootstrap/abandon", {
      batch_id: batchId,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "bootstrap_batch_not_found",
      `cross-owner /abandon must return bootstrap_batch_not_found, got: ${error.code}`,
    );

    // Crucial: batch must still exist (grief protection).
    const after = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(after !== null, "batch must still exist after cross-owner /abandon");

    // Owner CAN still abandon (sanity-check the happy path).
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const ownerR = await callWithBearer(ctx, aBearer, "POST", "/v1/bootstrap/abandon", {
      batch_id: batchId,
    });
    assert.equal(ownerR.status, 200, `owner abandon should succeed, got ${ownerR.status} body=${JSON.stringify(ownerR.body)}`);
    const gone = await ctx.services.bootstrapStore.get(batchId);
    assert.equal(gone, null, "batch must be deleted after owner abandon");
  });
});

test("POST /v1/bootstrap/abandon: truly-missing batch_id also returns bootstrap_batch_not_found (existence non-disclosure parity)", async () => {
  // The truly-missing case must produce the SAME error code as the cross-owner
  // case — otherwise an attacker can distinguish "batch exists but you don't
  // own it" from "batch doesn't exist", leaking existence of A's batches.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const r = await callWithBearer(ctx, bBearer, "POST", "/v1/bootstrap/abandon", {
      batch_id: "bootstrap-does-not-exist",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "bootstrap_batch_not_found",
      `truly-missing /abandon must return bootstrap_batch_not_found, got: ${error.code}`,
    );
  });
});

test("POST /v1/bootstrap/abandon: root can abandon any agent's batch (root-bypass parity with /continue)", async () => {
  // Symmetric with the existing /continue root-bypass test. Without this
  // assertion the root-abandon code path (services.ts: !callerIsRoot &&
  // state.owner_agent_id !== callerAgentId) would have zero regression
  // coverage; a future refactor that accidentally tightens the guard to
  // require BOTH root AND owner-match would silently break operator recovery.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-owner-abandon-root";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: batchId,
        approval_id: "",
        plan_file_path: "",
        plan: samplePlan("ABANDON_ROOT_KEY"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-aaa",
      });
    });

    // Root bearer is the bare ctx.token (no agent_id.hmac suffix); the daemon
    // bearer parser routes it through the "no dots" → root path. This is the
    // SAME mechanism the operator uses on the CLI via the socket-file token.
    const r = await callWithBearer(ctx, ctx.token, "POST", "/v1/bootstrap/abandon", {
      batch_id: batchId,
    });
    assert.equal(r.status, 200, `root abandon should succeed, got ${r.status} body=${JSON.stringify(r.body)}`);
    const after = await ctx.services.bootstrapStore.get(batchId);
    assert.equal(after, null, "batch must be deleted after root abandon");
  });
});

test("GET /v1/bootstrap/list: non-root sees only own batches; root sees all", async () => {
  // Seed two batches owned by different agents, then list as A, B, and root.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const idA = "bootstrap-list-owner-A";
    const idB = "bootstrap-list-owner-B";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: idA,
        approval_id: "",
        plan_file_path: "",
        plan: samplePlan("LIST_OWNER_A"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-aaa",
      });
    });
    await withAuthContext({ agent_id: "claude-bbb", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: idB,
        approval_id: "",
        plan_file_path: "",
        plan: samplePlan("LIST_OWNER_B"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-bbb",
      });
    });

    // Agent A: only A's batch.
    const aBearer = agentBearer(ctx.token, "claude-aaa");
    const listA = await callWithBearer(ctx, aBearer, "GET", "/v1/bootstrap/list");
    assert.equal(listA.status, 200);
    const batchesA = (listA.body as { batches: Array<{ batch_id: string }> }).batches;
    const idsA = batchesA.map((b) => b.batch_id);
    assert.ok(idsA.includes(idA), "agent A must see own batch");
    assert.ok(!idsA.includes(idB), "agent A must NOT see B's batch");
    assert.equal(batchesA.length, 1, `agent A should see exactly 1 batch, got ${batchesA.length}`);

    // Agent B: only B's batch.
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const listB = await callWithBearer(ctx, bBearer, "GET", "/v1/bootstrap/list");
    assert.equal(listB.status, 200);
    const batchesB = (listB.body as { batches: Array<{ batch_id: string }> }).batches;
    const idsB = batchesB.map((b) => b.batch_id);
    assert.ok(!idsB.includes(idA), "agent B must NOT see A's batch");
    assert.ok(idsB.includes(idB), "agent B must see own batch");
    assert.equal(batchesB.length, 1, `agent B should see exactly 1 batch, got ${batchesB.length}`);

    // Root: both.
    const listRoot = await call(ctx, "GET", "/v1/bootstrap/list");
    assert.equal(listRoot.status, 200);
    const batchesRoot = (listRoot.body as { batches: Array<{ batch_id: string }> }).batches;
    const idsRoot = batchesRoot.map((b) => b.batch_id);
    assert.ok(idsRoot.includes(idA), "root must see A's batch");
    assert.ok(idsRoot.includes(idB), "root must see B's batch");
    assert.equal(batchesRoot.length, 2, `root should see exactly 2 batches, got ${batchesRoot.length}`);
  });
});

test("POST /v1/bootstrap/continue: owner check fires BEFORE approval consume — cross-owner with unapproved approval returns bootstrap_batch_not_found (not approval_not_granted)", async () => {
  // Ordering proof: agent A creates a "pending" batch with a real
  // (but unapproved) approval. If the owner check ran AFTER requireApprovals,
  // agent B's /continue would yield "approval_not_granted" (the approval is
  // still pending). With the owner check running FIRST, B gets
  // "bootstrap_batch_not_found".
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-owner-ordering";

    // Mint a real (pending, unapproved) approval owned by agent A.
    let approvalId = "";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const grant = ctx.services.approvals.create({
        action: "bootstrap",
        ref: null,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: { batch_id: batchId, plan_summary: "[]" },
        allowed_domains: ["vercel.com"],
      });
      approvalId = grant.id;
      // Intentionally NOT approving — leaves grant in status "pending".
    });

    // Seed the batch in "pending" so /continue takes the approval path.
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: batchId,
        approval_id: approvalId,
        plan_file_path: "",
        plan: samplePlan("ORDERING_KEY"),
        step_results: {},
        created_at: Date.now(),
        status: "pending",
        owner_agent_id: "claude-aaa",
      });
    });

    // Agent B calls /continue with A's batch_id + A's still-pending approval_id.
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const r = await callWithBearer(ctx, bBearer, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    // Critical: must be bootstrap_batch_not_found, NOT approval_not_granted
    // (which would prove the owner check ran AFTER the approval lookup).
    assert.equal(
      error.code,
      "bootstrap_batch_not_found",
      `ORDERING BUG: owner check must fire BEFORE requireApprovals. Expected bootstrap_batch_not_found, got: ${error.code}. This means cross-owner callers can probe approval state.`,
    );

    // Sanity: the approval is still in "pending" status (B's call must not
    // have touched it — proving the approval consume path was not reached).
    const stillPending = ctx.services.approvals.get(approvalId);
    assert.ok(stillPending !== undefined, "approval must still exist");
    assert.equal(stillPending!.status, "pending", `approval must still be "pending" (untouched by B's call), got: ${stillPending!.status}`);
  });
});

test("POST /v1/bootstrap/continue: root can resume any batch (root bypass)", async () => {
  // Regression guard: root must bypass owner enforcement everywhere.
  // Use a terminal status so the executor short-circuit returns cached results
  // without needing approval/execution dependencies.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-owner-root-bypass";
    await withAuthContext({ agent_id: "claude-aaa", isRoot: false }, async () => {
      await ctx.services.bootstrapStore.save({
        batch_id: batchId,
        approval_id: "used-approval-id",
        plan_file_path: "",
        plan: samplePlan("ROOT_BYPASS_KEY"),
        step_results: {
          ROOT_BYPASS_KEY: { ok: true, ref: "ss://local/prod/ROOT_BYPASS_KEY" },
        },
        created_at: Date.now(),
        // "completed" → /continue takes the cached short-circuit, no approval
        // consume or executor run, so we isolate the owner-bypass behavior.
        status: "completed",
        owner_agent_id: "claude-aaa",
      });
    });

    // Root /continue must succeed across owner.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
    });
    assert.equal(r.status, 200, `root /continue must bypass owner, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean };
    assert.equal(body.ok, true);
  });
});
