import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Mirrors bootstrap.test.ts: SECRET_SHUTTLE_INSECURE_DEV_MODE=1 so the dev
// synth/grant path works without real production env, NO_OPEN_URL=1 so the
// hub doesn't try to spawn a real UI.

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bootstrap-blind-guard-"));
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
    return await fn({ port, token: "t", services });
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

test("POST /v1/bootstrap/plan: capture plan + active blind → blind_mode_already_active, no batch saved", async () => {
  // C10 /plan guard: if the plan contains a capture step AND blind is already
  // active from a prior operation, /plan must throw blind_mode_already_active
  // BEFORE allocating a batch_id or saving BatchState. A guarded /plan must
  // leave no batch clutter behind — the user fixes their blind state and
  // re-runs cleanly.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Set up: another flow already activated blind for a different domain.
    ctx.services.blind.start("vercel.com", "inject_submit");

    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });

    // Expect 400 with blind_mode_already_active (NOT approval_required).
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "blind_mode_already_active",
      `expected blind_mode_already_active (guard must fire BEFORE approval gate), got: ${error.code}`,
    );

    // Critical invariant: NO batch was saved. The guard fired before
    // bootstrapStore.save, so /list must return zero batches.
    const batches = await ctx.services.bootstrapStore.list();
    assert.equal(
      batches.length,
      0,
      `guarded /plan must NOT persist a batch (got ${batches.length}): ${JSON.stringify(batches)}`,
    );
  });
});

test("POST /v1/bootstrap/plan: non-capture plan + active blind → guard does NOT fire", async () => {
  // C10 /plan guard is capture-conditional. A non-capture plan (e.g.,
  // random_32_bytes sources) must NOT trip blind_mode_already_active even
  // when blind is active. Other gates (approval_required, etc.) may still
  // fire — we only assert that the blind guard specifically did not fire.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    ctx.services.blind.start("vercel.com", "inject_submit");

    const yml = `
version: 1
secrets:
  RANDOM_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const r = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });

    // The result may be approval_required (production destination), but it
    // must NOT be blind_mode_already_active — the guard is capture-only.
    const error = (r.body as { error?: { code: string } }).error;
    if (error !== undefined) {
      assert.notEqual(
        error.code,
        "blind_mode_already_active",
        `non-capture plan must NOT trip the blind guard, got: ${error.code}`,
      );
    }
  });
});

test("POST /v1/bootstrap/continue: capture plan + active blind → guard fires BEFORE approval consume; approval preserved", async () => {
  // C10 /continue guard — THE key invariant test. After the guard fires:
  //   1. The batch state is UNCHANGED (still "pending"),
  //   2. The approval is UNCONSUMED (still "granted", not "used"),
  //   3. A subsequent `blind end` + /continue with the SAME approval_id
  //      succeeds without minting a new approval.
  //
  // Without this ordering invariant, the user is forced to re-mint after
  // every blind collision, which is a terrible UX. The guard MUST run
  // before requireApprovals so the approval is preserved across the retry.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Phase 1: create a capture batch — gets approval_required + batch_id.
    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(planR.status, 400, `expected 400 approval_required from /plan, got ${planR.status} body=${JSON.stringify(planR.body)}`);
    const details = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchId = details.batch_id;
    const approvalId = details.approvals[0]!.approval_id;

    // Phase 2: approve the pending approval (still in "granted" state).
    ctx.services.approvals.approve(approvalId);
    assert.equal(
      ctx.services.approvals.get(approvalId)!.status,
      "granted",
      "approval should be granted after approve()",
    );

    // Phase 3: activate blind (collision setup — another operation has
    // already started blind, e.g., for an unrelated inject_submit).
    ctx.services.blind.start("example.com", "inject_submit");

    // Phase 4: call /continue — must throw blind_mode_already_active.
    const blockedR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    assert.equal(blockedR.status, 400, `expected 400 blind_mode_already_active, got ${blockedR.status} body=${JSON.stringify(blockedR.body)}`);
    const blockedErr = (blockedR.body as { error: { code: string } }).error;
    assert.equal(
      blockedErr.code,
      "blind_mode_already_active",
      `expected blind_mode_already_active (guard must fire BEFORE requireApprovals), got: ${blockedErr.code}`,
    );

    // INVARIANT 1: batch state unchanged (still "pending").
    const stateAfterBlock = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(stateAfterBlock !== null, "batch must still exist after blocked /continue");
    assert.equal(
      stateAfterBlock!.status,
      "pending",
      `batch must remain "pending" after blocked /continue (executor must not have started), got: ${stateAfterBlock!.status}`,
    );

    // INVARIANT 2: approval UNCONSUMED — still "granted", not "used".
    // This is the critical UX invariant: the user can retry after `blind end`
    // without minting a fresh approval.
    const grantAfterBlock = ctx.services.approvals.get(approvalId);
    assert.ok(grantAfterBlock !== undefined, "approval must still exist");
    assert.equal(
      grantAfterBlock!.status,
      "granted",
      `INVARIANT VIOLATION: approval status must be "granted" (unconsumed) after /continue blind guard fired. Got: ${grantAfterBlock!.status}. This means the guard ran AFTER requireApprovals — the user would be forced to mint a new approval after every blind end.`,
    );

    // Phase 5: user runs `blind end` (clears active blind).
    ctx.services.blind.end();
    assert.equal(ctx.services.blind.current(), null, "blind must be cleared after end()");

    // Phase 6: retry /continue with the SAME approval_id — must succeed.
    // The executor will attempt to run the capture step; in the test harness
    // there's no real browser, so it will fail with some other code — but
    // critically NOT with approval_already_used or blind_mode_already_active.
    const retryR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    // Either 200 (somehow succeeded) or 400 with a NON-approval / NON-blind error.
    // The specific downstream error from the executor (e.g., browser startup
    // failure in test harness) is not the point of this test — the point is
    // that the approval is REUSABLE after the blind collision.
    const retryErr = (retryR.body as { error?: { code: string } }).error;
    if (retryErr !== undefined) {
      assert.notEqual(
        retryErr.code,
        "approval_already_used",
        `RETRY MUST REUSE APPROVAL: got approval_already_used, meaning the original /continue consumed the approval despite the blind guard. The guard ordering invariant is violated.`,
      );
      assert.notEqual(
        retryErr.code,
        "approval_not_granted",
        `RETRY MUST REUSE APPROVAL: got approval_not_granted, meaning the approval is no longer in "granted" state. The guard ordering invariant is violated.`,
      );
      assert.notEqual(
        retryErr.code,
        "blind_mode_already_active",
        `blind was ended — the guard must not fire on retry, got: ${retryErr.code}`,
      );
    }
  });
});

test("POST /v1/bootstrap/continue: non-capture plan + active blind → guard does NOT fire", async () => {
  // C10 /continue guard is capture-conditional. For a non-capture batch
  // (random_32_bytes sources), the guard must NOT fire even with blind
  // active — the executor doesn't drive any capture, so blind state is
  // orthogonal.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    // Phase 1: create a non-capture batch.
    const yml = `
version: 1
secrets:
  RANDOM_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    assert.equal(planR.status, 400, `expected 400 approval_required from /plan, got ${planR.status}`);
    const details = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchId = details.batch_id;
    const approvalId = details.approvals[0]!.approval_id;

    // Approve and activate blind.
    ctx.services.approvals.approve(approvalId);
    ctx.services.blind.start("example.com", "inject_submit");

    // Call /continue. May fail downstream (executor errors), but must NOT
    // fail with blind_mode_already_active — this is a non-capture plan.
    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    const err = (r.body as { error?: { code: string } }).error;
    if (err !== undefined) {
      assert.notEqual(
        err.code,
        "blind_mode_already_active",
        `non-capture batch must NOT trip the blind guard, got: ${err.code}`,
      );
    }
  });
});
