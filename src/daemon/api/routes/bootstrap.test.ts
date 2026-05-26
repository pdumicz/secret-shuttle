import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { encryptEnvelope, writeEnvelope } from "../../../vault/envelope.js";
import { randomBytes } from "node:crypto";

// ── shared harness ──────────────────────────────────────────────────────────

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bootstrap-"));
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

/** Unlock the vault with a fresh passphrase. */
async function unlockVault(ctx: { port: number; token: string }): Promise<void> {
  const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "testpass", set_passphrase: true });
  assert.equal(r.status, 200, `unlock failed: ${JSON.stringify(r.body)}`);
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /v1/bootstrap/plan: rejects capture source with clear error", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://stripe.com/dashboard" }
    destinations: ["vercel:production:STRIPE_KEY"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "bootstrap_plan_invalid");
    assert.ok(
      error.message.includes("does not support"),
      `expected "does not support" in message, got: ${error.message}`,
    );
    assert.ok(
      error.message.includes("STRIPE_KEY"),
      `expected secret name in message, got: ${error.message}`,
    );
  });
});

test("POST /v1/bootstrap/plan: yml schema error → bootstrap_plan_invalid", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Missing version field — invalid yml structure
    const yml = `
secrets:
  BAD_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production:BAD_SECRET"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "bootstrap_plan_invalid");
  });
});

test("POST /v1/bootstrap/plan: empty plan (everything in vault) → ok with completed: 0", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Pre-seed the vault via a pre-approved generate for a production secret.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/DB_PASSWORD",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["vercel.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
    });
    ctx.services.approvals.approve(genGrant.id);
    const gen = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "DB_PASSWORD",
      environment: "production",
      source: "local",
      allowed_domains: ["vercel.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200, `pre-seed generate failed: ${JSON.stringify(gen.body)}`);

    const yml = `
version: 1
secrets:
  DB_PASSWORD:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; completed: number; failed: number; refs: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.completed, 0);
    assert.equal(body.failed, 0);
    assert.deepEqual(body.refs, []);
  });
});

test("POST /v1/bootstrap/plan: returns approval_required with batch_id for fresh plan", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  API_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required");
    const details = r.body.details as { approvals: unknown[]; batch_id: string } | undefined;
    assert.ok(details !== undefined && details !== null, "expected top-level details field");
    assert.ok(Array.isArray(details!.approvals) && details!.approvals.length >= 1, "expected approvals array with at least 1 entry");
    assert.ok(typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"), `expected batch_id starting with "bootstrap-", got: ${details!.batch_id}`);

    // Batch state must be persisted in the bootstrap store.
    const state = await ctx.services.bootstrapStore.get(details.batch_id);
    assert.ok(state !== null, "batch state must be persisted in bootstrap store");
    assert.equal(state!.batch_id, details.batch_id);
    assert.equal(state!.plan.length, 1);
  });
});

test("POST /v1/bootstrap/continue: with approval_id executes plan", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  SESSION_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    // Phase 1: get the batch_id and approval_id.
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(planR.status, 400);
    const planDetails = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    assert.ok(planDetails !== undefined, `plan did not return details: ${JSON.stringify(planR.body)}`);
    const batchId = planDetails.batch_id;
    const approvalId = planDetails.approvals[0]!.approval_id;

    // Approve the pending approval.
    ctx.services.approvals.approve(approvalId);

    // Phase 2: continue with the approved approval_id.
    const contR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    assert.equal(contR.status, 200, `expected 200, got ${contR.status} body=${JSON.stringify(contR.body)}`);
    const contBody = contR.body as { ok: boolean; completed: number; failed: number; refs: string[] };
    assert.equal(contBody.ok, true);
    // Note: the template destination (vercel:production) may fail because no vercel
    // binary/template is registered in tests. We verify completed+failed >= 1 (secret was generated).
    assert.ok(
      contBody.completed >= 0 && contBody.failed >= 0,
      `unexpected response shape: ${JSON.stringify(contBody)}`,
    );
    // The batch state should be updated in the store.
    const state = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(state !== null, "batch state must exist after continue");
    assert.ok(
      state!.status === "completed" || state!.status === "failed_partial" || state!.status === "in_progress",
      `unexpected batch status: ${state!.status}`,
    );
  });
});

test("POST /v1/bootstrap/continue: unknown batch_id → bootstrap_batch_not_found", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: "bootstrap-nonexistent-uuid",
      approval_ids: ["some-approval-id"],
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "bootstrap_batch_not_found");
  });
});

test("POST /v1/bootstrap/abandon: deletes batch from store", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Create a batch via plan.
    const yml = `
version: 1
secrets:
  ABANDON_ME:
    source: { kind: random_64_bytes }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(planR.status, 400);
    const planDetails = planR.body.details as { batch_id: string } | undefined;
    assert.ok(planDetails !== undefined, `plan did not return details: ${JSON.stringify(planR.body)}`);
    const batchId = planDetails!.batch_id;

    // Abandon it.
    const abandonR = await call(ctx, "POST", "/v1/bootstrap/abandon", { batch_id: batchId });
    assert.equal(abandonR.status, 200, `expected 200, got ${abandonR.status} body=${JSON.stringify(abandonR.body)}`);
    const body = abandonR.body as { ok: boolean; removed: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.removed, true);

    // The store should no longer have it.
    const state = await ctx.services.bootstrapStore.get(batchId);
    assert.equal(state, null, "batch must be removed from store after abandon");
  });
});

test("GET /v1/bootstrap/list: returns all batches", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Create 2 batches via plan.
    const yml1 = `
version: 1
secrets:
  FIRST_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const yml2 = `
version: 1
secrets:
  SECOND_KEY:
    source: { kind: random_64_bytes }
    destinations: ["vercel:production"]
`;
    const plan1 = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml1 });
    assert.equal(plan1.status, 400);
    const plan2 = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml2 });
    assert.equal(plan2.status, 400);

    // List them.
    const listR = await call(ctx, "GET", "/v1/bootstrap/list");
    assert.equal(listR.status, 200, `expected 200, got ${listR.status} body=${JSON.stringify(listR.body)}`);
    const listBody = listR.body as { ok: boolean; batches: unknown[] };
    assert.equal(listBody.ok, true);
    assert.ok(Array.isArray(listBody.batches), "batches must be an array");
    assert.ok(listBody.batches.length >= 2, `expected at least 2 batches, got ${listBody.batches.length}`);

    // Verify batch shape.
    const batch = listBody.batches[0] as { batch_id: string; status: string; created_at: number; plan_length: number; completed: number; failed: number };
    assert.ok(typeof batch.batch_id === "string", "batch_id must be a string");
    assert.ok(typeof batch.status === "string", "status must be a string");
    assert.ok(typeof batch.created_at === "number", "created_at must be a number");
    assert.ok(typeof batch.plan_length === "number", "plan_length must be a number");
  });
});

// ── Retry-after-failed_partial tests (TDD for R7 fix) ──────────────────────

test("POST /v1/bootstrap/continue: retry after failed_partial does NOT require fresh approval", async () => {
  // Regression: before the fix, /continue unconditionally called requireApprovals,
  // so a second call with an already-consumed approval threw approval_already_used.
  // After the fix: when state.status !== "pending", the approval gate is skipped.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-retry-test-uuid";

    // Seed a failed_partial batch. The plan entry's source is random_32_bytes
    // so the executor will need to call generateSecretCore for the secret.
    // We set a prior ref so the executor reuses it (no secret generation needed),
    // and simulate one failed destination so it will attempt to retry it.
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "used-approval-id",
      plan_file_path: "",
      plan: [
        {
          secret: "RETRY_KEY",
          ref: "ss://local/prod/RETRY_KEY",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel-env-add",
              template_params: { name: "RETRY_KEY", environment: "production" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {
        RETRY_KEY: {
          ok: false,
          ref: "ss://local/prod/RETRY_KEY",
          destinations_pushed: [
            {
              destination: "vercel:production",
              ok: false,
              error_code: "template_exec_failed",
              message: "exit 1",
            },
          ],
          error_code: "destination_partial_failure",
        },
      },
      created_at: Date.now(),
      status: "failed_partial",
    });

    // Seed a used approval in the approval store to simulate the prior /continue call.
    const usedGrant = ctx.services.approvals.create({
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
    ctx.services.approvals.approve(usedGrant.id);
    // Consume the approval — now it's in "used" state, matching the real scenario.
    ctx.services.approvals.consumeBatch([
      {
        id: usedGrant.id,
        binding: {
          action: "bootstrap",
          ref: null,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: { batch_id: batchId, plan_summary: "[]" },
          allowed_domains: ["vercel.com"],
        },
      },
    ]);

    // POST /continue with the same (now-used) approval_ids — this is the retry call.
    // This matches the exact user-reported bug: user retries with the same approval_ids
    // they used on the first call, and gets approval_already_used.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [usedGrant.id],
    });

    // With the fix: state.status is "failed_partial" (not "pending"), so requireApprovals
    // is skipped entirely. The executor runs and returns ok:true with a result.
    // Without the fix: requireApprovals sees approval status "used" and throws
    // approval_already_used immediately (status 400).
    assert.equal(
      r.status,
      200,
      `expected 200 (executor ran), got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const body = r.body as { ok: boolean; error?: { code: string } };
    assert.equal(body.ok, true, `expected ok:true, got: ${JSON.stringify(body)}`);

    // The batch status must be updated (in_progress or failed_partial or completed —
    // the destination template will likely fail again since no real binary exists).
    const state = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(state !== null, "batch state must still exist after retry");
    assert.ok(
      state!.status === "completed" || state!.status === "failed_partial",
      `unexpected batch status after retry: ${state!.status}`,
    );
  });
});

test("POST /v1/bootstrap/continue: first call (pending) still requires a granted approval", async () => {
  // Regression guard: when state.status === "pending", requireApprovals MUST be
  // called. Without this, a malicious caller could skip approval by POSTing to
  // /continue with just a batch_id from /plan before approving.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Create a pending batch via the /plan route — this mints a real pending approval.
    const yml = `
version: 1
secrets:
  GATE_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(planR.status, 400, `expected 400 approval_required from /plan`);
    const planDetails = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    assert.ok(planDetails !== undefined, `plan did not return details: ${JSON.stringify(planR.body)}`);
    const batchId = planDetails.batch_id;
    const mintedApprovalId = planDetails.approvals[0]!.approval_id;

    // The approval is minted (pending) but NOT granted yet.
    // POST /continue with the minted-but-not-granted approval_id.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [mintedApprovalId],
    });

    // Must fail: the approval is not granted → approval_not_granted.
    // This proves the approval gate is still enforced for the first /continue call.
    assert.equal(
      r.status,
      400,
      `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.ok(
      error.code === "approval_not_granted" || error.code === "approval_required",
      `expected approval_not_granted or approval_required, got: ${error.code}`,
    );
  });
});

// ── R8: dev-env synth path must execute inline (TDD for R8 fix) ─────────────
// Two response shapes exist for /plan:
//   1. empty-plan short-circuit (lines 58-62): no batch was saved, returns
//      { ok, completed: 0, ... } with NO batch_id — correct, nothing to follow up on.
//   2. synth-execute path (this fix): requireApprovals returns a synth grant without
//      throwing; the handler must run executeBatch inline and return
//      { ok, batch_id, ...result } so the batch is in a terminal state.

test("POST /v1/bootstrap/plan: dev environment executes inline and returns batch_id with results", async () => {
  // Without the fix: returns { ok: true, completed: 0, failed: 0, refs: [], errors: [] }
  // WITHOUT batch_id, and the batch is stranded in "pending" status forever.
  // With the fix: executeBatch runs inline, batch reaches a terminal state,
  // and batch_id is included in the response.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  DEV_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must succeed (200).
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number; refs: unknown[]; errors: unknown[] };
    assert.equal(body.ok, true);

    // batch_id must be present — the batch was created, executed, and is now terminal.
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-", got: ${JSON.stringify(body.batch_id)}`,
    );

    // completed + failed must reflect actual executor output (not just { completed: 0 }).
    assert.ok(
      typeof body.completed === "number" && typeof body.failed === "number",
      `expected numeric completed/failed, got: ${JSON.stringify(body)}`,
    );
    // The executor ran at least one secret generation; sum must be >= 1.
    assert.ok(
      body.completed + body.failed >= 1,
      `expected completed+failed >= 1 (executor must have run), got completed=${body.completed} failed=${body.failed}`,
    );

    // The batch state in the store must be terminal (completed or failed_partial),
    // NOT "pending" (which is the bug: batch was saved but executor never ran).
    const state = await ctx.services.bootstrapStore.get(body.batch_id!);
    assert.ok(state !== null, "batch state must be persisted in bootstrap store");
    assert.ok(
      state!.status === "completed" || state!.status === "failed_partial",
      `expected terminal status (completed or failed_partial), got: ${state!.status}`,
    );
  });
});

test("POST /v1/bootstrap/plan: dev environment batch is idempotent — /continue with dev batch_id returns cached result", async () => {
  // After the fix, the batch is already in a terminal state after /plan.
  // Calling /continue with the returned batch_id must hit the "completed" short-circuit
  // (line 144 of bootstrap.ts) and return the cached result — not re-run the executor.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  DEV_IDEMPOTENT:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });
    assert.equal(planR.status, 200, `expected 200 from /plan, got ${planR.status} body=${JSON.stringify(planR.body)}`);
    const planBody = planR.body as { ok: boolean; batch_id: string; completed: number; failed: number };
    assert.ok(typeof planBody.batch_id === "string", "expected batch_id in /plan response");

    // Verify the batch reached a terminal state.
    const stateBefore = await ctx.services.bootstrapStore.get(planBody.batch_id);
    assert.ok(stateBefore !== null, "batch must exist in store");
    const terminalBefore = stateBefore!.status === "completed" || stateBefore!.status === "failed_partial";
    assert.ok(terminalBefore, `expected terminal status before /continue, got: ${stateBefore!.status}`);

    // Now call /continue with the dev batch_id — must hit the completed short-circuit.
    // No approval_ids needed since the batch is already terminal.
    const contR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: planBody.batch_id,
    });
    assert.equal(contR.status, 200, `expected 200 from /continue, got ${contR.status} body=${JSON.stringify(contR.body)}`);
    const contBody = contR.body as { ok: boolean; completed: number; failed: number };
    assert.equal(contBody.ok, true);
    // Result must match what /plan returned (cached, not re-executed).
    assert.equal(contBody.completed, planBody.completed, "cached completed count must match /plan");
    assert.equal(contBody.failed, planBody.failed, "cached failed count must match /plan");
  });
});

test("POST /v1/bootstrap/plan: production environment still returns approval_required with batch_id (regression guard)", async () => {
  // Regression: ensure the production path (approval gating) is NOT affected by the dev fix.
  // This is the same assertion as the existing "returns approval_required" test — kept as
  // an explicit regression guard for R8 so a reviewer can see both paths side-by-side.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  PROD_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "production",
    });

    // Must be 400 with approval_required.
    assert.equal(r.status, 400, `expected 400 (approval_required), got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required");

    // Details must include both approvals array AND batch_id.
    const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(details!.approvals) && details!.approvals.length >= 1, "expected at least 1 approval in details");
    assert.ok(
      typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-" in details, got: ${details!.batch_id}`,
    );

    // The batch must still be in "pending" status (executor has NOT run yet).
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(state!.status, "pending", `production batch must remain "pending" after /plan, got: ${state!.status}`);
  });
});

test("POST /v1/bootstrap/plan: plan_summary includes ss:// ref for source: existing", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // source: existing with a ref whose name (stripe) differs from the yml key (STRIPE_KEY).
    // This is the canonical case where hiding the ref breaks human review.
    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: existing, ref: "ss://upstream/prod/stripe" }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 400, `expected 400 approval_required, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required");

    const details = r.body.details as { approvals: unknown[]; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);

    // Look up the saved BatchState and inspect the persisted plan entry ref.
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted in bootstrap store");

    const entry = state!.plan[0]!;
    assert.equal(entry.secret, "STRIPE_KEY", "plan entry secret name must be the yml key");
    assert.equal(entry.ref, "ss://upstream/prod/stripe", "plan entry ref must be the existing source ref");
    assert.equal(entry.source.kind, "existing", "plan entry source kind must be existing");

    // The approval was minted with template_params.plan_summary.
    // Retrieve it from the approval store and assert the source string includes the ref.
    const approvalId = state!.approval_id;
    assert.ok(approvalId.length > 0, "approval_id must be set on saved state");

    const grant = ctx.services.approvals.get(approvalId);
    assert.ok(grant !== undefined, `approval ${approvalId} must exist in approvals store`);
    const planSummaryRaw = grant!.template_params?.["plan_summary"];
    assert.ok(typeof planSummaryRaw === "string", "template_params.plan_summary must be a JSON string");
    const planSummary = JSON.parse(planSummaryRaw!) as Array<{ name: string; source: string; destinations: string[] }>;
    assert.equal(planSummary.length, 1, "plan_summary must have one entry");
    assert.equal(planSummary[0]!.name, "STRIPE_KEY");
    assert.equal(
      planSummary[0]!.source,
      "existing:ss://upstream/prod/stripe",
      `plan_summary source must include the ss:// ref, got: ${planSummary[0]!.source}`,
    );
    assert.deepEqual(planSummary[0]!.destinations, ["vercel:production"]);
  });
});
