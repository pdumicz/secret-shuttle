import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import type {
  BrowserSession,
  BrowserSessionChild,
} from "../../bootstrap/browser-session.js";
import type { CdpClient } from "../../chrome/cdp-client.js";
import type { ProxyServer } from "../../proxy/cdp-proxy.js";
import type { BrowserOps } from "../../chrome/internal-ops.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Mirrors bootstrap.test.ts: SECRET_SHUTTLE_INSECURE_DEV_MODE=1 so the dev
// synth/grant path works without real production env, NO_OPEN_URL=1 so the
// hub doesn't try to spawn a real UI.

// Minimal stub session — C12 makes /continue auto-spawn a browser for capture
// plans, so any test that drives /continue on a capture batch must stub the
// createBrowserSession factory. Without this the real launchChrome would run
// and the test would hang on the headers timeout.
function makeStubSession(owner: BrowserSession["owner"]): BrowserSession {
  const exitListeners: Array<(code: number | null) => void> = [];
  const child: BrowserSessionChild = {
    kill(signal?: NodeJS.Signals): boolean {
      // Fire any registered exit listener so stopBootstrapBrowser's
      // Promise.race resolves on the exit branch instead of the SIGKILL
      // fallback (which would add a 3-second delay).
      if ((signal ?? "SIGTERM") === "SIGTERM") {
        queueMicrotask(() => {
          for (const l of exitListeners.splice(0)) l(0);
        });
      }
      return true;
    },
    once(event: "exit", listener: (code: number | null) => void): unknown {
      assert.equal(event, "exit");
      exitListeners.push(listener);
      return child;
    },
  };
  const cdp = { async close(): Promise<void> { /* noop */ } } as unknown as CdpClient;
  const proxy: ProxyServer = {
    url: "ws://127.0.0.1:0/stub",
    severAgentConnections(): void { /* noop */ },
    async close(): Promise<void> { /* noop */ },
  };
  return {
    owner,
    child,
    cdp,
    proxy,
    browserSessionId: "ws://127.0.0.1:0/stub",
    browser: { available: true } as unknown as BrowserOps,
  };
}

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
  // Stub the browser factory so C12's auto-spawn doesn't actually launch Chrome.
  // We only need a valid BrowserSession shape — the executor will fail at the
  // first CDP call against the stub, which is fine for the tests in this file
  // (they don't assert on executor outcome, only on guard/approval invariants).
  const services = new DaemonServices({
    createBrowserSessionImpl: async (opts) => makeStubSession(opts.owner),
  });
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

test("POST /v1/bootstrap/continue: capture plan + cross-batch bootstrap browser → bootstrap_browser_busy fires BEFORE approval consume; approval preserved", async () => {
  // Sister test to the C10 blind-guard ordering invariant. The pre-approval
  // browser-busy guard MUST fire BEFORE requireApprovals consumes the batch's
  // single-use approval — otherwise the user is stranded with a "used"
  // approval after a concurrency collision and must mint a fresh one to retry.
  //
  // Invariants verified:
  //   1. /continue throws bootstrap_browser_busy (not approval_required, not
  //      approval_already_used, not the post-lock ensureBootstrapBrowser path).
  //   2. Batch state UNCHANGED (still "pending"), no executor side effects.
  //   3. Approval still status="granted" (unconsumed). Subsequent retry after
  //      batch A completes can reuse the SAME approval_id.
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
    assert.equal(planR.status, 400, `expected 400 approval_required, got ${planR.status}`);
    const details = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchId = details.batch_id;
    const approvalId = details.approvals[0]!.approval_id;

    // Phase 2: approve.
    ctx.services.approvals.approve(approvalId);
    assert.equal(
      ctx.services.approvals.get(approvalId)!.status,
      "granted",
      "approval should be granted after approve()",
    );

    // Phase 3: simulate "batch A is already driving the daemon-owned browser"
    // by directly installing a bootstrap-owned BrowserSession with a different
    // batchId. The new pre-approval guard inspects services.browserSession and
    // must reject before requireApprovals.
    ctx.services.browserSession = makeStubSession({ kind: "bootstrap", batchId: "bootstrap-other-batch-A" });

    // Phase 4: call /continue — must throw bootstrap_browser_busy.
    const blockedR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    assert.equal(
      blockedR.status,
      400,
      `expected 400 bootstrap_browser_busy, got ${blockedR.status} body=${JSON.stringify(blockedR.body)}`,
    );
    const blockedErr = (blockedR.body as { error: { code: string } }).error;
    assert.equal(
      blockedErr.code,
      "bootstrap_browser_busy",
      `expected bootstrap_browser_busy (pre-approval guard), got: ${blockedErr.code}`,
    );

    // INVARIANT 1: batch state unchanged (still "pending").
    const stateAfterBlock = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(stateAfterBlock !== null, "batch must still exist after blocked /continue");
    assert.equal(
      stateAfterBlock!.status,
      "pending",
      `batch must remain "pending" after blocked /continue, got: ${stateAfterBlock!.status}`,
    );

    // INVARIANT 2: approval UNCONSUMED — still "granted", not "used".
    // This is the entire point of the pre-approval ordering.
    const grantAfterBlock = ctx.services.approvals.get(approvalId);
    assert.ok(grantAfterBlock !== undefined, "approval must still exist");
    assert.equal(
      grantAfterBlock!.status,
      "granted",
      `INVARIANT VIOLATION: approval must remain "granted" (unconsumed) after the cross-batch browser-busy guard fired. Got: ${grantAfterBlock!.status}. This means the new guard ran AFTER requireApprovals — defeating the whole point of placing it BEFORE.`,
    );

    // Phase 5: simulate "batch A finished" by clearing browserSession.
    ctx.services.browserSession = null;

    // Phase 6: retry with the SAME approval_id — must NOT see approval_already_used.
    // Downstream errors (executor failure in the stub harness) are fine; what
    // we're testing is that the approval is REUSABLE.
    const retryR = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    const retryErr = (retryR.body as { error?: { code: string } }).error;
    if (retryErr !== undefined) {
      assert.notEqual(
        retryErr.code,
        "approval_already_used",
        `RETRY MUST REUSE APPROVAL: got approval_already_used. Pre-approval guard failed to preserve approval.`,
      );
      assert.notEqual(
        retryErr.code,
        "approval_not_granted",
        `RETRY MUST REUSE APPROVAL: got approval_not_granted.`,
      );
      assert.notEqual(
        retryErr.code,
        "bootstrap_browser_busy",
        `batch A's session was cleared — guard must not fire on retry.`,
      );
    }
  });
});

test("POST /v1/bootstrap/continue: capture plan + user-owned browser → guard does NOT fire (user session is reused)", async () => {
  // The new browser-busy guard is bootstrap-owned-cross-batch SPECIFIC:
  // a user-owned BrowserSession means the user pre-emptively ran
  // `browser start`, and ensureBootstrapBrowser will reuse it unchanged.
  // The guard must NOT fire on user-owned sessions — that would break the
  // common bootstrap-after-browser-start workflow.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    const details = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchId = details.batch_id;
    const approvalId = details.approvals[0]!.approval_id;

    ctx.services.approvals.approve(approvalId);

    // User-owned session: must be tolerated by the new guard.
    ctx.services.browserSession = makeStubSession({ kind: "user" });

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    const err = (r.body as { error?: { code: string } }).error;
    if (err !== undefined) {
      assert.notEqual(
        err.code,
        "bootstrap_browser_busy",
        `user-owned session must NOT trip the cross-batch guard, got: ${err.code}`,
      );
    }
  });
});

test("POST /v1/bootstrap/continue: non-capture plan + cross-batch bootstrap browser → guard does NOT fire", async () => {
  // The new browser-busy guard is capture-conditional, mirroring the C10
  // blind guard. Non-capture plans (random_32_bytes) don't need the
  // browser at all — services.ensureBootstrapBrowser is never called for
  // them, so the cross-batch collision is harmless. Guard must skip.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const yml = `
version: 1
secrets:
  RANDOM_KEY:
    source: { kind: random_32_bytes }
    destinations: ["vercel:production"]
`;
    const planR = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml });
    const details = planR.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchId = details.batch_id;
    const approvalId = details.approvals[0]!.approval_id;

    ctx.services.approvals.approve(approvalId);

    // Cross-batch bootstrap session present, but this batch is non-capture.
    ctx.services.browserSession = makeStubSession({ kind: "bootstrap", batchId: "bootstrap-other-batch-X" });

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", {
      batch_id: batchId,
      approval_ids: [approvalId],
    });
    const err = (r.body as { error?: { code: string } }).error;
    if (err !== undefined) {
      assert.notEqual(
        err.code,
        "bootstrap_browser_busy",
        `non-capture plan must NOT trip the cross-batch guard, got: ${err.code}`,
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

// ── Concurrent /continue race: synchronous reservation preserves loser's approval ──

test("POST /v1/bootstrap/continue: concurrent capture plans from two batches → loser fails with bootstrap_browser_busy BEFORE approval consume; only ONE Chrome spawn", async () => {
  // CRITICAL race-condition guard for the cross-batch double-spawn:
  //
  // Before the synchronous reserveBootstrapBrowser, the pre-approval guard
  // only inspected services.browserSession. If two batches started while
  // browserSession === null, both passed the precheck, both consumed
  // approvals in requireApprovals, then both raced into
  // ensureBootstrapBrowser — whose null-check is awaited (not synchronous).
  // With a slow Chrome-spawn factory, both calls saw null, both spawned,
  // last writer won — leaking one Chrome process and stranding the loser
  // with a consumed approval (single-use, gone for nothing).
  //
  // The fix: reserveBootstrapBrowser runs SYNCHRONOUSLY at /continue entry,
  // BEFORE requireApprovals. The second batch's reservation call throws
  // BEFORE its approval is consumed — the grant stays "granted" and the
  // user can retry it after batch A completes.
  //
  // This test fires two /continue calls in parallel with a deliberately slow
  // browser factory and asserts:
  //   1. Exactly ONE batch's approval was consumed (winner).
  //   2. The other batch's approval is still "granted" (loser preserved).
  //   3. The factory was called exactly ONCE (no duplicate Chrome).
  //   4. The losing /continue returned bootstrap_browser_busy.
  //
  // Re-implement withDaemon inline so we can control the factory timing
  // via a deferred-resolution Promise.

  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bootstrap-race-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  const server = new DaemonServer({ token: "t" });

  // Deferred-resolution factory: the first call to createBrowserSession
  // blocks on `factoryReleaseSignal` until the test signals release. While
  // it's blocked, the second /continue is hitting reserveBootstrapBrowser.
  // The synchronous reservation throws on the second call, so the second
  // /continue NEVER reaches requireApprovals.
  let factoryCallCount = 0;
  let resolveFactoryRelease: (() => void) = (): void => {
    // Replaced below before any await — this default exists only to satisfy
    // TS's definite-assignment narrowing (Promise executor runs synchronously
    // but TS can't see that across the assignment).
  };
  const factoryReleaseSignal = new Promise<void>((r) => { resolveFactoryRelease = r; });

  const services = new DaemonServices({
    createBrowserSessionImpl: async (opts) => {
      factoryCallCount += 1;
      // First (and only) factory call: pause until the test signals release.
      // This keeps the first /continue inside ensureBootstrapBrowser long
      // enough that the second /continue runs to completion (and is rejected
      // by the synchronous reservation).
      await factoryReleaseSignal;
      return makeStubSession(opts.owner);
    },
  });
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));

  try {
    const ctx = { port, token: "t", services };
    await unlockVault(ctx);

    // Phase 1: create TWO capture batches.
    const yml = (n: string): string => `
version: 1
secrets:
  ${n}:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations: ["vercel:production"]
`;
    const planA = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml("STRIPE_A") });
    assert.equal(planA.status, 400, `expected 400 approval_required for batch A, got ${planA.status}`);
    const detailsA = planA.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchIdA = detailsA.batch_id;
    const approvalIdA = detailsA.approvals[0]!.approval_id;

    const planB = await call(ctx, "POST", "/v1/bootstrap/plan", { plan_yml: yml("STRIPE_B") });
    assert.equal(planB.status, 400, `expected 400 approval_required for batch B, got ${planB.status}`);
    const detailsB = planB.body.details as { approvals: Array<{ approval_id: string }>; batch_id: string };
    const batchIdB = detailsB.batch_id;
    const approvalIdB = detailsB.approvals[0]!.approval_id;

    // Phase 2: approve BOTH approvals.
    ctx.services.approvals.approve(approvalIdA);
    ctx.services.approvals.approve(approvalIdB);
    assert.equal(ctx.services.approvals.get(approvalIdA)!.status, "granted");
    assert.equal(ctx.services.approvals.get(approvalIdB)!.status, "granted");

    // Phase 3: fire both /continue calls in parallel.
    //
    // One of them will:
    //   a. SYNCHRONOUSLY reserve → enter requireApprovals → consume approval →
    //      acquire execution lock → call ensureBootstrapBrowser → block on
    //      our slow factory.
    //
    // The other one will:
    //   b. SYNCHRONOUSLY attempt to reserve → throw bootstrap_browser_busy
    //      immediately, BEFORE requireApprovals.
    //
    // Both promises will eventually settle. We release the factory only
    // AFTER both /continue requests have returned a response — by that time,
    // the loser has already failed with bootstrap_browser_busy and its
    // approval is preserved.
    //
    // Note: because both /continue calls go over HTTP and have to be parsed
    // by the same daemon, there's an implicit ordering — one parses first,
    // gets the reservation, and the other parses second. The route handler's
    // synchronous reserveBootstrapBrowser is the actual ordering point.

    const inflightA = call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchIdA, approval_ids: [approvalIdA] });
    const inflightB = call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchIdB, approval_ids: [approvalIdB] });

    // Wait a beat so the second request gets dispatched and its reservation
    // attempt throws. Then we release the factory so the winner can complete.
    // We can't use a precise sync barrier here without instrumentation, so
    // poll until ONE of the inflight calls has settled OR a brief delay
    // elapses (the loser should fail almost instantly).
    //
    // Strategy: race the inflight responses against a small grace timer.
    // When either has settled (typically the loser, which short-circuits),
    // release the factory so the winner finishes too.
    const firstSettler = await Promise.race([
      inflightA.then(() => "a" as const),
      inflightB.then(() => "b" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
    ]);
    // Whichever settled first, release the factory so the winner can complete.
    // (If "timeout", we may have hit a deadlock; release anyway so things move.)
    void firstSettler;
    resolveFactoryRelease();

    const [respA, respB] = await Promise.all([inflightA, inflightB]);

    // Phase 4: assert race outcomes.
    const errA = (respA.body as { error?: { code: string } }).error;
    const errB = (respB.body as { error?: { code: string } }).error;

    // Identify winner and loser by response. The loser MUST have failed with
    // bootstrap_browser_busy.
    const aIsLoser = errA?.code === "bootstrap_browser_busy";
    const bIsLoser = errB?.code === "bootstrap_browser_busy";
    assert.ok(
      aIsLoser !== bIsLoser,
      `exactly ONE of the two /continue calls must lose with bootstrap_browser_busy. ` +
      `A: status=${respA.status} err=${JSON.stringify(errA)}. ` +
      `B: status=${respB.status} err=${JSON.stringify(errB)}.`,
    );

    const loserBatchId = aIsLoser ? batchIdA : batchIdB;
    const winnerBatchId = aIsLoser ? batchIdB : batchIdA;
    const loserApprovalId = aIsLoser ? approvalIdA : approvalIdB;
    const winnerApprovalId = aIsLoser ? approvalIdB : approvalIdA;

    // INVARIANT 1: factory called exactly ONCE (no duplicate spawn).
    assert.equal(
      factoryCallCount,
      1,
      `factory must be called exactly ONCE — only the winner spawns Chrome. Got: ${factoryCallCount}`,
    );

    // INVARIANT 2: loser's approval is PRESERVED — still "granted", not "used".
    // This is the load-bearing assertion. Without the synchronous reservation,
    // the loser would have consumed its approval inside requireApprovals
    // before failing on ensureBootstrapBrowser.
    const loserGrant = ctx.services.approvals.get(loserApprovalId);
    assert.ok(loserGrant !== undefined, "loser's approval must still exist");
    assert.equal(
      loserGrant!.status,
      "granted",
      `INVARIANT VIOLATION: loser's approval status must be "granted" (unconsumed) after losing the race. ` +
      `Got: ${loserGrant!.status}. This means the synchronous reservation did NOT close the race window — ` +
      `the loser consumed its approval before failing.`,
    );

    // INVARIANT 3: loser's batch is still "pending" (no executor side effects).
    const loserState = await ctx.services.bootstrapStore.get(loserBatchId);
    assert.ok(loserState !== null, "loser's batch must still exist");
    assert.equal(
      loserState!.status,
      "pending",
      `loser's batch must remain "pending" after losing the race, got: ${loserState!.status}`,
    );

    // INVARIANT 4: winner's approval IS consumed (status "used"). The winner
    // ran requireApprovals to completion. The executor itself may have
    // failed downstream (stub session can't actually drive CDP), but the
    // approval-consume DID happen.
    const winnerGrant = ctx.services.approvals.get(winnerApprovalId);
    assert.ok(winnerGrant !== undefined, "winner's approval must still exist");
    assert.equal(
      winnerGrant!.status,
      "used",
      `winner's approval must be "used" after requireApprovals consumed it, got: ${winnerGrant!.status}`,
    );

    // Sanity: at least one of the two batches' work paths reached the
    // browser-orchestration block, so the winner identification is correct.
    void winnerBatchId; // marker — winner asserted via factoryCallCount + approval status
  } finally {
    // If the factory was never released, release it now so any in-flight
    // promises don't dangle.
    resolveFactoryRelease();
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
});
