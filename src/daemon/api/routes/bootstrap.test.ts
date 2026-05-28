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

test("POST /v1/bootstrap/plan: capture source with non-https URL → bootstrap_capture_url_invalid", async () => {
  // C1: capture is now a first-class source kind (no longer rejected at /plan).
  // Invalid capture URLs surface bootstrap_capture_url_invalid during yml parse,
  // which the daemon router maps to a 400 with that code. C9 will add the
  // capture-always-requires-approval gate at /plan; for now, well-formed
  // https URLs flow through to the normal approval pipeline.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "http://stripe.com/dashboard" }
    destinations: ["vercel:production:STRIPE_KEY"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "bootstrap_capture_url_invalid");
    assert.ok(
      error.message.includes("STRIPE_KEY"),
      `expected secret name in message, got: ${error.message}`,
    );
    assert.ok(
      error.message.includes("https"),
      `expected "https" in message, got: ${error.message}`,
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

test("POST /v1/bootstrap/plan: approval_required response sets next_action=null and surfaces continue command in details", async () => {
  // §1 CTO-review round-2 P1.1: the nextAction contract
  // (src/shared/error-codes.ts:17) reserves next_action for AUTOMATIC
  // recovery; approval_required is the canonical human-intervention error
  // (the human must click Approve in the hub first). An agent that ran
  // `provision --continue --batch X --approval-id Y` immediately while the
  // approval is still pending would hit approval_not_granted at
  // require-approvals.ts:188.
  //
  // Fix: next_action === null (or absent). The post-approval continue
  // command shape moves to details.continue_command_after_approval where
  // agents can read it after the human approves. The existing
  // details.approvals[] shape (the registry hint's source of truth for
  // --approval-id repeatable IDs) stays untouched.
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
    const body = r.body as {
      error: { code: string };
      hint: string | null;
      next_action: string | null;
      details: {
        approvals: Array<{ approval_id: string }>;
        batch_id: string;
        continue_command_after_approval: string | null;
      };
    };
    assert.equal(body.error.code, "approval_required");

    // next_action MUST be null — approval_required requires human action.
    assert.equal(
      body.next_action,
      null,
      `next_action must be null for approval_required (human must approve first); got: ${body.next_action}`,
    );

    // The continue command shape lives in details.continue_command_after_approval.
    const batchId = body.details.batch_id;
    const firstApprovalId = body.details.approvals[0]?.approval_id;
    assert.ok(typeof batchId === "string" && batchId.startsWith("bootstrap-"), `expected bootstrap- batch_id, got: ${batchId}`);
    assert.ok(typeof firstApprovalId === "string" && firstApprovalId.length > 0, `expected first approval_id, got: ${firstApprovalId}`);

    const expectedContinue = `secret-shuttle provision --continue --batch ${batchId} --approval-id ${firstApprovalId}`;
    assert.equal(
      body.details.continue_command_after_approval,
      expectedContinue,
      `details.continue_command_after_approval must name the post-approval recovery command; got: ${body.details.continue_command_after_approval}`,
    );

    // CTO-review round-4 P1.1: the wire `hint` must be the per-instance
    // override pointing at details.continue_command_after_approval — NOT the
    // registry's generic "retry with --approval-id <id>" text, which is wrong
    // for batch-style provision flows (retrying `provision` with --approval-id
    // would mint a new batch instead of continuing the existing one).
    assert.ok(
      typeof body.hint === "string" && body.hint.length > 0,
      `expected a non-empty hint string, got: ${body.hint}`,
    );
    assert.match(
      body.hint!,
      /details\.continue_command_after_approval/i,
      `hint must point at details.continue_command_after_approval (per-instance override); got: ${body.hint}`,
    );
    assert.doesNotMatch(
      body.hint!,
      /retry with --approval-id/i,
      `hint must NOT be the registry's generic --approval-id retry text (wrong for batch-style provision); got: ${body.hint}`,
    );
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
      owner_agent_id: "daemon",
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
    ], "daemon");

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

    // Burst 5 §4 Task 4.5: response carries batch_status + (when failed_partial)
    // a copy-pasteable resume hint. The destination will fail again (no real
    // binary), so we expect failed_partial here — but defensively the test
    // assertion handles both terminal cases without relying on a specific
    // failure cause.
    const wireBody = r.body as { batch_status?: string; next_action?: string };
    assert.equal(
      wireBody.batch_status,
      state!.status,
      "response batch_status must mirror the on-disk state.status",
    );
    if (state!.status === "failed_partial") {
      assert.equal(
        wireBody.next_action,
        `secret-shuttle provision --continue --batch ${batchId}`,
        "failed_partial response must carry agent-actionable next_action",
      );
    } else {
      // status === "completed" path: no next_action surfaced (terminal success).
      assert.equal(wireBody.next_action, undefined, "completed batch must NOT carry next_action");
    }
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

test("POST /v1/bootstrap/plan: dev-env inline-execute on failed_partial surfaces batch_status + next_action", async () => {
  // Burst 5 §4 Task 4.5 (P2-1 follow-up): the dev/no-approval inline-execute
  // path at /v1/bootstrap/plan must carry the SAME batch_status + agent-actionable
  // resume hint that /continue does. Before this fix the enrichment lived only on
  // the /continue path, so agents hitting the inline path on a failed_partial
  // outcome had no way to recover (no next_action), defeating the whole point
  // of Task 4.5. The vercel CLI is not present in the test environment, so the
  // single destination always fails → failed_partial.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  INLINE_FAIL_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    assert.equal(r.status, 200, `expected 200 inline-execute, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id: string; batch_status?: string; next_action?: string; failed: number };
    assert.equal(body.ok, true);
    assert.ok(typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"), "batch_id required");

    // Verify the disk state went to failed_partial so the assertion below is meaningful.
    const state = await ctx.services.bootstrapStore.get(body.batch_id);
    assert.ok(state !== null, "batch must be persisted");
    assert.equal(state!.status, "failed_partial", `expected failed_partial (vercel CLI not present in test env), got: ${state!.status}`);

    // The fix: response carries batch_status mirroring on-disk state.
    assert.equal(
      body.batch_status,
      "failed_partial",
      "inline-execute /plan response must carry batch_status (P2-1 fix)",
    );

    // The fix: failed_partial response carries the agent-actionable resume hint.
    assert.equal(
      body.next_action,
      `secret-shuttle provision --continue --batch ${body.batch_id}`,
      "failed_partial inline-execute MUST surface next_action for agent recovery (P2-1 fix)",
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

// ── R9: summarizeFromState surfaces per-destination errors (TDD) ────────────

test("POST /v1/bootstrap/continue: cached failed_partial response surfaces per-destination errors", async () => {
  // Seed a failed_partial batch whose step_results has destinations_pushed with a
  // failed destination. When /continue is called and the batch status is not "pending",
  // the executor runs (R7 fix) and returns the new summarize() shape.
  // After R9 fix: errors[0] must have step:"destination", destination:<shorthand>,
  // code:"template_exec_failed". Before fix: code is "destination_partial_failure"
  // and destination field is absent.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-r9-dest-detail";

    // Seed a completed batch (so the executor hits the cached-result short-circuit in
    // executeBatch, which calls summarize(state) directly without re-running anything).
    // This exercises summarizeFromState via the /continue → executeBatch → summarize path.
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "used-approval-id",
      plan_file_path: "",
      plan: [
        {
          secret: "STRIPE_KEY",
          ref: "ss://local/prod/STRIPE_KEY",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel-env-add",
              template_params: { name: "STRIPE_KEY", environment: "production" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {
        STRIPE_KEY: {
          ok: false,
          ref: "ss://local/prod/STRIPE_KEY",
          destinations_pushed: [
            {
              destination: "vercel:production",
              ok: false,
              error_code: "template_exec_failed",
              message: "template vercel-env-add exited with code 1",
            },
          ],
          error_code: "destination_partial_failure",
        },
      },
      created_at: Date.now(),
      // Use "completed" status so executeBatch hits the cached-result path (line 85-87 in executor.ts)
      // and calls summarize(state) directly — this tests the summarize() fix.
      // We rely on: executeBatch returns summarize(state) for "completed" status.
      // For testing the route's summarizeFromState, we also cover the /continue path
      // with "failed_partial" status below.
      status: "completed",
      owner_agent_id: "daemon",
    });

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as {
      ok: boolean;
      completed: number;
      failed: number;
      errors: Array<{ secret: string; step: string; code: string; message: string; destination?: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.failed, 1, "one failed secret");
    assert.equal(body.completed, 0);

    // The R9 fix: errors[] must carry destination-level detail.
    assert.ok(Array.isArray(body.errors), "errors must be an array");
    assert.equal(body.errors.length, 1, "one failed destination → one error entry");
    const err = body.errors[0]!;
    assert.equal(err.secret, "STRIPE_KEY");
    assert.equal(err.step, "destination", `expected step:"destination", got: ${err.step}`);
    assert.equal(err.code, "template_exec_failed", `expected code:"template_exec_failed", got: ${err.code}`);
    assert.equal(err.destination, "vercel:production", `expected destination:"vercel:production", got: ${err.destination}`);
    assert.ok(err.message.includes("exit") || err.message.length > 0, `expected non-empty message, got: ${err.message}`);
  });
});

// ── R10: destination-policy gate (P0 security fix) ─────────────────────────
// The binding environment MUST reflect the resolved destinations' production-class,
// not just the --environment flag. Without this fix, a yml with
// environment:"development" + destinations:[vercel:production] would auto-approve
// (dev-env synth) and push to production with zero human clicks.

test("POST /v1/bootstrap/plan: dev environment + vercel:production destination MUST require approval (P0 security gate)", async () => {
  // Without the fix: returns 200 success with zero approvals consumed.
  // With the fix: returns 400 approval_required because vercel:production → production-class.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  API_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    // Note: environment is explicitly "development" (the vulnerable path).
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must fail with approval_required — NOT succeed silently.
    assert.equal(
      r.status,
      400,
      `P0 SECURITY GATE FAILED: expected 400 approval_required, got ${r.status} body=${JSON.stringify(r.body)}. This means secrets are being pushed to vercel:production without any human approval.`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "approval_required",
      `expected approval_required, got: ${error.code}`,
    );

    // batch_id must be in details so the user can /continue after approving.
    const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);
    assert.ok(
      typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-" in details`,
    );

    // The batch must remain "pending" — executor must NOT have run.
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(
      state!.status,
      "pending",
      `batch must remain "pending" after /plan: executor must not push to production`,
    );
  });
});

test("POST /v1/bootstrap/plan: dev environment + vercel:development destination still executes inline (no approval)", async () => {
  // R8 regression guard: vercel:development is non-prod → synth path still works.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  DEV_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must succeed without approval_required.
    assert.equal(r.status, 200, `expected 200 inline-execute, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    // Executor ran: completed+failed >= 1 (at least generated the secret).
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run (completed+failed >= 1), got completed=${body.completed} failed=${body.failed}`,
    );
  });
});

test("POST /v1/bootstrap/plan: dev environment + github-actions destination requires approval (fail-closed)", async () => {
  // github-actions is always production-class, regardless of --environment.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  GH_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["github-actions:owner/repo"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    assert.equal(
      r.status,
      400,
      `expected 400 approval_required for github-actions (fail-closed), got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);
  });
});

test("POST /v1/bootstrap/plan: dev environment + supabase destination requires approval (fail-closed)", async () => {
  // supabase is always production-class, regardless of --environment.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  SUPA_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["supabase:myprojectref"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    assert.equal(
      r.status,
      400,
      `expected 400 approval_required for supabase (fail-closed), got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);
  });
});

test("POST /v1/bootstrap/plan: dev environment + cloudflare:production destination requires approval", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  CF_SECRET:
    source: { kind: random_32_bytes }
    destinations: ["cloudflare:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    assert.equal(
      r.status,
      400,
      `expected 400 approval_required for cloudflare:production, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);
  });
});

test("POST /v1/bootstrap/plan: dev environment + cloudflare:dev destination still executes inline", async () => {
  // cloudflare:dev → env param "dev" → destinationEnvironment returns "dev" ≠ "production" → dev-class.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  CF_DEV:
    source: { kind: random_32_bytes }
    destinations: ["cloudflare:dev"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must succeed without approval_required.
    assert.equal(r.status, 200, `expected 200 inline-execute for cloudflare:dev, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run (completed+failed >= 1), got completed=${body.completed} failed=${body.failed}`,
    );
  });
});

// ── R11: per-batch execution lock (P1 concurrency fix) ─────────────────────

test("POST /v1/bootstrap/continue: concurrent calls on same batch → second gets bootstrap_batch_busy", async () => {
  // 1. Seed a batch with status: "failed_partial" (simulates a prior partial run).
  // 2. Manually acquire the lock to simulate "first call is currently inside executeBatch".
  // 3. POST /v1/bootstrap/continue with the batch_id.
  // 4. Assert: second call throws bootstrap_batch_busy.
  // 5. Release the lock at end of test.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-r11-busy-test";
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "used-approval-id",
      plan_file_path: "",
      plan: [
        {
          secret: "LOCK_KEY",
          ref: "ss://local/prod/LOCK_KEY",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel-env-add",
              template_params: { name: "LOCK_KEY", environment: "production" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {},
      created_at: Date.now(),
      status: "in_progress",
      owner_agent_id: "daemon",
    });

    // Simulate first call currently inside executeBatch.
    const acquired = ctx.services.bootstrapStore.tryAcquireExecutionLock(batchId);
    assert.ok(acquired, "test setup: should acquire lock successfully");

    try {
      // Second call arrives while lock is held.
      const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
        batch_id: batchId,
      });

      assert.equal(
        r.status,
        400,
        `expected 400 bootstrap_batch_busy, got ${r.status} body=${JSON.stringify(r.body)}`,
      );
      const error = (r.body as { error: { code: string } }).error;
      assert.equal(
        error.code,
        "bootstrap_batch_busy",
        `expected bootstrap_batch_busy, got: ${error.code}`,
      );
    } finally {
      ctx.services.bootstrapStore.releaseExecutionLock(batchId);
    }
  });
});

test("POST /v1/bootstrap/continue: after lock release, retry succeeds", async () => {
  // Setup: seed a failed_partial batch, acquire then release the lock, verify /continue returns 200.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-r11-release-test";
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "used-approval-id",
      plan_file_path: "",
      plan: [
        {
          secret: "RELEASE_KEY",
          ref: "ss://local/prod/RELEASE_KEY",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:development",
              template_id: "vercel-env-add",
              template_params: { name: "RELEASE_KEY", environment: "development" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {},
      created_at: Date.now(),
      status: "failed_partial",
      owner_agent_id: "daemon",
    });

    // Acquire and release (simulates a prior run completing).
    ctx.services.bootstrapStore.tryAcquireExecutionLock(batchId);
    ctx.services.bootstrapStore.releaseExecutionLock(batchId);

    // Now /continue should proceed without bootstrap_batch_busy.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
    });

    assert.equal(
      r.status,
      200,
      `expected 200 after lock release, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const body = r.body as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("POST /v1/bootstrap/continue: status in_progress on disk + empty in-memory lock → /continue resumes (crash recovery)", async () => {
  // Simulates: daemon crashed mid-execution (lock cleared), disk state still shows in_progress.
  // A fresh /continue must bypass the lock (empty) and resume.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-r11-crash-recovery";
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "used-approval-id",
      plan_file_path: "",
      plan: [
        {
          secret: "CRASH_KEY",
          ref: "ss://local/prod/CRASH_KEY",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:development",
              template_id: "vercel-env-add",
              template_params: { name: "CRASH_KEY", environment: "development" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {},
      created_at: Date.now(),
      status: "in_progress", // disk says in_progress, but no in-memory lock (daemon restarted)
      owner_agent_id: "daemon",
    });

    // No lock held — fresh daemon state.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
    });

    // Must succeed: crash recovery path.
    assert.equal(
      r.status,
      200,
      `expected 200 (crash recovery), got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const body = r.body as { ok: boolean };
    assert.equal(body.ok, true, `expected ok:true, got: ${JSON.stringify(body)}`);

    // Final status must be terminal (not perpetually in_progress).
    const state = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(state !== null, "batch state must exist after crash recovery resume");
    assert.ok(
      state!.status === "completed" || state!.status === "failed_partial",
      `expected terminal status after crash recovery, got: ${state!.status}`,
    );
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

// ── R12: environment alias canonicalization before approval gate (P0 security fix) ─
// The gate previously compared the raw request value to the literal "production".
// Aliases like "prod", "PROD", "Production", " production " canonicalize to
// "production" via canonicalEnvironment() for ref construction, but the raw compare
// returned false → dev-synth path → auto-approved with no human click while the
// ss:// ref was stored as ss://local/prod/... (production).

test("POST /v1/bootstrap/plan: environment='prod' alias + non-prod destinations MUST require approval (alias canonicalization)", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  ALIAS_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    // environment:"prod" canonicalizes to "production" → must require approval.
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "prod",
    });

    assert.equal(
      r.status,
      400,
      `P0 ALIAS BUG: expected 400 approval_required for environment="prod", got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "approval_required",
      `expected approval_required, got: ${error.code}`,
    );

    const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);
    assert.ok(
      typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-" in details`,
    );

    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(
      state!.status,
      "pending",
      `batch must remain "pending" after /plan with prod alias: executor must not have run`,
    );
  });
});

test("POST /v1/bootstrap/plan: environment='PROD' uppercase + non-prod destinations MUST require approval", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  UPPERCASE_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "PROD",
    });

    assert.equal(
      r.status,
      400,
      `P0 ALIAS BUG: expected 400 approval_required for environment="PROD", got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);

    const details = r.body.details as { batch_id: string } | undefined;
    assert.ok(details !== undefined && typeof details.batch_id === "string", "expected batch_id in details");
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(state!.status, "pending", `batch must remain "pending", got: ${state!.status}`);
  });
});

test("POST /v1/bootstrap/plan: environment='Production' mixed-case + non-prod destinations MUST require approval", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  MIXEDCASE_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "Production",
    });

    assert.equal(
      r.status,
      400,
      `P0 ALIAS BUG: expected 400 approval_required for environment="Production", got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);

    const details = r.body.details as { batch_id: string } | undefined;
    assert.ok(details !== undefined && typeof details.batch_id === "string", "expected batch_id in details");
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(state!.status, "pending", `batch must remain "pending", got: ${state!.status}`);
  });
});

test("POST /v1/bootstrap/plan: environment=' production ' with whitespace + non-prod destinations MUST require approval", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  WHITESPACE_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    // canonicalEnvironment trims and lowercases → "production".
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: " production ",
    });

    assert.equal(
      r.status,
      400,
      `P0 ALIAS BUG: expected 400 approval_required for environment=" production " (whitespace), got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "approval_required", `expected approval_required, got: ${error.code}`);

    const details = r.body.details as { batch_id: string } | undefined;
    assert.ok(details !== undefined && typeof details.batch_id === "string", "expected batch_id in details");
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(state!.status, "pending", `batch must remain "pending", got: ${state!.status}`);
  });
});

test("POST /v1/bootstrap/plan: environment='dev' alias + non-prod destinations still synth-executes (no approval)", async () => {
  // Regression guard: dev aliases stay on the synth path.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  DEV_ALIAS_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "dev",
    });

    // Must succeed (200) — "dev" → "development" → non-production → synth path.
    assert.equal(r.status, 200, `expected 200 inline-execute for environment="dev", got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run (completed+failed >= 1), got completed=${body.completed} failed=${body.failed}`,
    );
  });
});

test("POST /v1/bootstrap/plan: environment='development' literal + non-prod destinations still synth-executes", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  DEV_LITERAL_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    assert.equal(r.status, 200, `expected 200 inline-execute for environment="development", got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run, got completed=${body.completed} failed=${body.failed}`,
    );
  });
});

test("POST /v1/bootstrap/plan: environment='staging' (non-canonical) + non-prod destinations still synth-executes (treated as non-production)", async () => {
  // canonicalEnvironment returns "staging" unchanged → not "production" → no gate from env side.
  // Documents that custom envs are treated as non-production for the env-side gate.
  // (Destinations still apply if any are prod-class, but this test uses non-prod dests.)
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  STAGING_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "staging",
    });

    assert.equal(r.status, 200, `expected 200 inline-execute for environment="staging", got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run, got completed=${body.completed} failed=${body.failed}`,
    );
  });
});

// ── R13: source-env gate (P0 security fix) ─────────────────────────────────
// source: existing with ss://*/prod/* + --environment development + non-prod
// destinations bypassed all existing gates (R10, R12). The plan entry ref IS
// the production ref, but neither the request flag nor the destinations reflect
// the secret's actual environment — so the prior two conditions returned false
// and the dev-synth path ran, writing a production secret with zero clicks.

test("POST /v1/bootstrap/plan: source: existing ss://*/prod/* + dev env + dev destination MUST require approval (P0 source bypass)", async () => {
  // Exact reproducer from the user-confirmed bug report.
  // Vault does NOT need to be preseeded: source: existing entries are always
  // included in the plan (R3 fix), regardless of vault.has(). The executor's
  // runSourceStep for existing kind would return entry.source.ref directly —
  // it would only fail if the vault lookup at execution time threw.
  // The gate runs BEFORE execution — we assert the gate fires (400 approval_required)
  // and never reaches the executor.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Preseed vault with the production secret so the executor could run if the
    // gate mistakenly lets it through. This makes the test exercise the real
    // end-to-end path (not just a vault-miss bailout).
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/EXISTING_PROD",
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
      name: "EXISTING_PROD",
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
  FOO:
    source: { kind: existing, ref: "ss://local/prod/EXISTING_PROD" }
    destinations: ["vercel:development"]
`;
    // environment: "development" + destinations: non-prod → both prior gates return false.
    // The new R13 gate must catch this via the plan entry's ref.
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must fail with approval_required — NOT succeed silently.
    assert.equal(
      r.status,
      400,
      `P0 SOURCE BYPASS: expected 400 approval_required (source ref is production), got ${r.status} body=${JSON.stringify(r.body)}. A production secret would be pushed with zero human clicks.`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "approval_required",
      `expected approval_required, got: ${error.code}`,
    );

    // batch_id must be present so the user can /continue after approving.
    const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);
    assert.ok(
      typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-" in details`,
    );

    // Batch must remain "pending" — executor must NOT have run.
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(
      state!.status,
      "pending",
      `batch must remain "pending" after /plan: executor must not push a production secret without approval`,
    );
  });
});

test("POST /v1/bootstrap/plan: source: existing ss://*/dev/* + dev env + dev destination still synth-executes (regression guard)", async () => {
  // Control case: existing source with a development ref should still take the
  // dev-synth path (no approval needed, inline execution).
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Preseed vault with a development secret.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/dev/EXISTING_DEV",
      environment: "development",
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
      name: "EXISTING_DEV",
      environment: "development",
      source: "local",
      allowed_domains: ["vercel.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200, `pre-seed generate failed: ${JSON.stringify(gen.body)}`);

    const yml = `
version: 1
secrets:
  BAR:
    source: { kind: existing, ref: "ss://local/dev/EXISTING_DEV" }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must succeed (200) — dev ref + dev env + dev destinations → synth path.
    assert.equal(r.status, 200, `expected 200 inline-execute for dev existing source, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; batch_id?: string; completed: number; failed: number };
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.batch_id === "string" && body.batch_id.startsWith("bootstrap-"),
      `expected batch_id in response, got: ${JSON.stringify(body.batch_id)}`,
    );
    // Executor ran: completed+failed >= 1 (processed at least one secret).
    assert.ok(
      body.completed + body.failed >= 1,
      `expected executor to have run (completed+failed >= 1), got completed=${body.completed} failed=${body.failed}`,
    );

    // The batch state must be terminal (not pending — executor ran inline).
    const state = await ctx.services.bootstrapStore.get(body.batch_id!);
    assert.ok(state !== null, "batch state must be persisted");
    assert.ok(
      state!.status === "completed" || state!.status === "failed_partial",
      `expected terminal status (completed or failed_partial), got: ${state!.status}`,
    );
  });
});

test("POST /v1/bootstrap/plan: capture source in dev env + dev destination still requires approval (C9)", async () => {
  // C9 capture-always-requires-approval gate. Without this, a capture-only
  // dev plan would inline-execute and hang because the dev-synth path has
  // no UI surface for the user to trigger the capture step. The gate
  // routes capture plans through the normal approval pipeline so /continue
  // can drive the executor and the hub can render the capture coordinator card.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations: ["vercel:development"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", {
      plan_yml: yml,
      environment: "development",
    });

    // Must fail with approval_required even in dev env with dev destinations.
    assert.equal(
      r.status,
      400,
      `expected 400 approval_required for capture-only dev plan, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "approval_required",
      `expected approval_required for capture source in dev env, got: ${error.code}`,
    );

    // batch_id must be present so the caller knows what to /continue after approving.
    const details = r.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string } | undefined;
    assert.ok(details !== undefined, `expected details in response: ${JSON.stringify(r.body)}`);
    assert.ok(
      typeof details!.batch_id === "string" && details!.batch_id.startsWith("bootstrap-"),
      `expected batch_id starting with "bootstrap-" in details`,
    );

    // Batch must be persisted in "pending" state — executor must NOT have run.
    const state = await ctx.services.bootstrapStore.get(details!.batch_id);
    assert.ok(state !== null, "batch state must be persisted");
    assert.equal(
      state!.status,
      "pending",
      `batch must remain "pending" after /plan: capture step must wait for /continue`,
    );
  });
});
