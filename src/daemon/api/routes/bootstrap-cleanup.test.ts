// src/daemon/api/routes/bootstrap-cleanup.test.ts
//
// C12: /continue browser auto-start + outer finally cleanup.
//
// Covers the capture-conditional browser orchestration around executeBatch:
//   - bootstrap-owned Chrome auto-spawn before executor + auto-teardown in finally
//   - pre-existing user session reused and preserved (never torn down)
//   - non-capture plans skip the orchestration entirely
//   - blind auto-resume when finally kills the Chrome and a cleanup-failed step
//     left blind active
//   - concurrent /continue: second call gets bootstrap_batch_busy WITHOUT
//     spawning a second Chrome
//
// No real Chrome is launched. The createBrowserSession factory is stubbed via
// DaemonServicesOptions.createBrowserSessionImpl (the same hook
// browser-session.test.ts uses).

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

// ── stub session helpers (mirrors browser-session.test.ts) ─────────────────

interface StubChild extends BrowserSessionChild {
  killCalls: NodeJS.Signals[];
  exitListeners: Array<(code: number | null) => void>;
  fireExit(): void;
}

function makeStubChild(): StubChild {
  const stub: StubChild = {
    killCalls: [],
    exitListeners: [],
    kill(signal?: NodeJS.Signals): boolean {
      const sig = signal ?? ("SIGTERM" as NodeJS.Signals);
      stub.killCalls.push(sig);
      // Always exit cleanly on SIGTERM so the 3s SIGKILL fallback never fires.
      if (sig === "SIGTERM") {
        queueMicrotask(() => stub.fireExit());
      }
      return true;
    },
    once(event: "exit", listener: (code: number | null) => void): unknown {
      assert.equal(event, "exit");
      stub.exitListeners.push(listener);
      return stub;
    },
    fireExit(): void {
      const ls = stub.exitListeners.splice(0);
      for (const l of ls) l(0);
    },
  };
  return stub;
}

interface StubProxy extends ProxyServer {
  closeCalls: number;
}

function makeStubProxy(): StubProxy {
  const p: StubProxy = {
    url: "ws://127.0.0.1:0/stub",
    severAgentConnections(): void { /* noop */ },
    async close(): Promise<void> {
      p.closeCalls += 1;
    },
    closeCalls: 0,
  };
  return p;
}

interface StubCdp {
  closeCalls: number;
  close(): Promise<void>;
}

function makeStubCdp(): StubCdp & CdpClient {
  const c: StubCdp = {
    closeCalls: 0,
    async close(): Promise<void> {
      c.closeCalls += 1;
    },
  };
  return c as unknown as StubCdp & CdpClient;
}

function makeStubSession(owner: BrowserSession["owner"]): BrowserSession & {
  child: StubChild;
  proxy: StubProxy;
  cdp: StubCdp & CdpClient;
} {
  return {
    owner,
    child: makeStubChild(),
    cdp: makeStubCdp(),
    proxy: makeStubProxy(),
    browserSessionId: "ws://127.0.0.1:0/stub",
    browser: { available: true } as unknown as BrowserOps,
  } as BrowserSession & {
    child: StubChild;
    proxy: StubProxy;
    cdp: StubCdp & CdpClient;
  };
}

// ── test harness ────────────────────────────────────────────────────────────

interface FactoryCall {
  profile: string;
  owner: BrowserSession["owner"];
}

interface WithDaemonOpts {
  /**
   * Optional side effect to run inside the createBrowserSession factory, BEFORE
   * returning the stub session. Used by the cleanup-failed test to simulate
   * the executor's capture state machine activating blind — by the time
   * ensureBootstrapBrowser resolves and the executor runs, blind is on, and
   * the executor's pre-marked-completed step short-circuits without ending it.
   */
  onSpawn?: (services: DaemonServices) => void;
}

async function withDaemon<T>(
  fn: (ctx: {
    port: number;
    token: string;
    services: DaemonServices;
    factoryCalls: FactoryCall[];
    spawnedSessions: ReturnType<typeof makeStubSession>[];
  }) => Promise<T>,
  opts: WithDaemonOpts = {},
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bootstrap-cleanup-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  const server = new DaemonServer({ token: "t" });

  const factoryCalls: FactoryCall[] = [];
  const spawnedSessions: ReturnType<typeof makeStubSession>[] = [];
  // services is captured below in the factory closure; declare it first.
  let services!: DaemonServices;
  services = new DaemonServices({
    createBrowserSessionImpl: async (factoryOpts) => {
      factoryCalls.push({ profile: factoryOpts.profile, owner: factoryOpts.owner });
      const s = makeStubSession(factoryOpts.owner);
      spawnedSessions.push(s);
      opts.onSpawn?.(services);
      return s;
    },
  });
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, factoryCalls, spawnedSessions });
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

// ── seed helpers ────────────────────────────────────────────────────────────
//
// We seed BatchState directly so each test can place the batch in the exact
// pre-executor state we want (no real /plan → /continue dance). The executor
// short-circuits per-entry when prior.ok === true, so seeding step_results
// with completed-state entries means we never reach the actual capture state
// machine — what we're testing here is the OUTER browser orchestration around
// executeBatch, not the capture branch itself (that's executor-capture.test.ts).
//
// All seeded batches use owner_agent_id: "daemon" so the dev-mode authority
// (which presents as "daemon") passes the owner check.

interface SeedOpts {
  batchId: string;
  hasCapture: boolean;
  status: import("../../bootstrap/store.js").BatchState["status"];
  /**
   * When true, mark every plan entry as already completed in step_results so
   * the executor short-circuits and we exercise ONLY the wrapping browser
   * orchestration (the unit under test in this file).
   */
  preMarkCompleted: boolean;
}

async function seedBatch(services: DaemonServices, opts: SeedOpts): Promise<void> {
  const captureEntry: import("../../bootstrap/store.js").PlanEntry = {
    secret: "CAP_KEY",
    ref: "ss://local/prod/CAP_KEY",
    source: { kind: "capture", url: "https://dashboard.stripe.com/apikeys" },
    destinations: [
      {
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "CAP_KEY", environment: "production" },
        domain: "vercel.com",
      },
    ],
  };
  const randomEntry: import("../../bootstrap/store.js").PlanEntry = {
    secret: "RND_KEY",
    ref: "ss://local/prod/RND_KEY",
    source: { kind: "random_32_bytes" },
    destinations: [
      {
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "RND_KEY", environment: "production" },
        domain: "vercel.com",
      },
    ],
  };
  const plan: import("../../bootstrap/store.js").PlanEntry[] =
    opts.hasCapture ? [captureEntry] : [randomEntry];

  const step_results: Record<string, import("../../bootstrap/store.js").StepResult> = {};
  if (opts.preMarkCompleted) {
    for (const entry of plan) {
      step_results[entry.secret] = {
        ok: true,
        ref: entry.ref,
        destinations_pushed: entry.destinations.map((d) => ({ destination: d.shorthand, ok: true })),
      };
    }
  }

  await services.bootstrapStore.save({
    batch_id: opts.batchId,
    approval_id: "test-approval-id",
    plan_file_path: "",
    plan,
    step_results,
    created_at: Date.now(),
    status: opts.status,
    owner_agent_id: "daemon",
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

test("capture batch: /continue with NO existing browser auto-starts bootstrap-owned one, torn down by finally", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-c12-spawn-teardown";
    await seedBatch(ctx.services, {
      batchId,
      hasCapture: true,
      status: "completed", // executor's cached-result branch returns summarize(state) immediately
      preMarkCompleted: true,
    });

    assert.equal(ctx.services.browserSession, null, "precondition: no browser before /continue");

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    // status:"completed" + owner match → /continue hits the early
    // `status === "completed"` short-circuit BEFORE the browser orchestration.
    // That path is intentional (cached result, no work to do, no need to
    // spin up a browser). Switch to in_progress so we exercise the new
    // orchestration code path.
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    // The early short-circuit means factory was NOT called and no browser is
    // active. This documents the contract: cached completed batches don't
    // spin Chrome up.
    assert.equal(ctx.factoryCalls.length, 0, "completed-status short-circuit must not call factory");
    assert.equal(ctx.services.browserSession, null, "browserSession must remain null");

    // Now flip status so the lock-protected orchestration block runs.
    const st = await ctx.services.bootstrapStore.get(batchId);
    assert.ok(st !== null);
    st!.status = "in_progress";
    await ctx.services.bootstrapStore.save(st!);

    const r2 = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    assert.equal(r2.status, 200, `expected 200, got ${r2.status} body=${JSON.stringify(r2.body)}`);

    // Factory was called exactly once with bootstrap-ownership tag.
    assert.equal(ctx.factoryCalls.length, 1, "expected exactly 1 factory spawn");
    assert.equal(ctx.factoryCalls[0]!.profile, "bootstrap");
    assert.deepEqual(ctx.factoryCalls[0]!.owner, { kind: "bootstrap", batchId });

    // Spawned session was torn down: child killed, proxy + cdp closed, services.browserSession === null.
    const spawned = ctx.spawnedSessions[0]!;
    assert.equal(spawned.child.killCalls.length, 1, "child.kill should be called once");
    assert.equal(spawned.child.killCalls[0], "SIGTERM", "SIGTERM, not SIGKILL");
    assert.equal(spawned.cdp.closeCalls, 1, "cdp.close called once");
    assert.equal(spawned.proxy.closeCalls, 1, "proxy.close called once");
    assert.equal(ctx.services.browserSession, null, "browserSession must be cleared in finally");

    // Lock must be released so a retry could proceed.
    assert.ok(
      ctx.services.bootstrapStore.tryAcquireExecutionLock(batchId),
      "lock must be released by the finally block",
    );
    ctx.services.bootstrapStore.releaseExecutionLock(batchId);
  });
});

test("capture batch: /continue with pre-existing user session reuses it (owner stays 'user', not torn down)", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-c12-user-session-preserve";
    await seedBatch(ctx.services, {
      batchId,
      hasCapture: true,
      status: "in_progress",
      preMarkCompleted: true,
    });

    // Pre-install a user-owned session — simulating an active `browser start`.
    const userSession = makeStubSession({ kind: "user" });
    ctx.services.browserSession = userSession;

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    // Factory was NEVER called: ensureBootstrapBrowser saw existing session and returned it.
    assert.equal(ctx.factoryCalls.length, 0, "factory must NOT spawn when user session is active");

    // User session SURVIVES the finally: child unkilled, proxy + cdp untouched,
    // browserSession still points to userSession, ownership unchanged.
    assert.equal(userSession.child.killCalls.length, 0, "user child must not be killed");
    assert.equal(userSession.cdp.closeCalls, 0, "user cdp must not be closed");
    assert.equal(userSession.proxy.closeCalls, 0, "user proxy must not be closed");
    assert.equal(ctx.services.browserSession, userSession, "browserSession must remain the user session");
    assert.deepEqual(ctx.services.browserSession?.owner, { kind: "user" }, "owner must stay 'user'");
  });
});

test("non-capture batch: /continue does NOT start a browser", async () => {
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-c12-no-capture-no-browser";
    await seedBatch(ctx.services, {
      batchId,
      hasCapture: false,
      status: "in_progress",
      preMarkCompleted: true,
    });

    assert.equal(ctx.services.browserSession, null, "precondition: no browser");

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    // Non-capture plan: NO factory invocation, NO browser ever installed.
    assert.equal(ctx.factoryCalls.length, 0, "non-capture batch must not spawn browser");
    assert.equal(ctx.services.browserSession, null, "browserSession must remain null");

    // Lock released.
    assert.ok(
      ctx.services.bootstrapStore.tryAcquireExecutionLock(batchId),
      "lock must be released",
    );
    ctx.services.bootstrapStore.releaseExecutionLock(batchId);
  });
});

test("cleanup-failed + bootstrap-owned browser → Chrome killed → blind auto-resumes after stop", async () => {
  // Models the cleanup-failed branch in the capture state machine: when the
  // capture target couldn't be verified clean, the executor leaves blind
  // active so a residual on-page value can't be observed. The OUTER finally
  // then SIGTERMs Chrome — once the rendering process is gone, there is
  // nothing left to observe, so finally must auto-end blind and audit the
  // resume event.
  //
  // We activate blind inside the createBrowserSession factory (via onSpawn)
  // to simulate the executor activating it. /continue's pre-flight C10 guard
  // runs BEFORE the lock acquisition and browser spawn, so blind is still
  // null at that point — the guard passes — and by the time the executor's
  // pre-marked-completed step short-circuits, blind is on (but the executor
  // never gets a chance to end it because the entry was pre-completed).
  // The outer finally is then responsible for the auto-resume.
  const batchId = "bootstrap-c12-cleanup-failed-resume";
  await withDaemon(
    async (ctx) => {
      await unlockVault(ctx);

      await seedBatch(ctx.services, {
        batchId,
        hasCapture: true,
        status: "in_progress",
        preMarkCompleted: true,
      });

      assert.equal(ctx.services.blind.current(), null, "precondition: blind not active (C10 guard passes)");

      const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
      assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

      // Bootstrap Chrome was spawned (no pre-existing session) and torn down.
      assert.equal(ctx.factoryCalls.length, 1, "bootstrap browser must be spawned");
      assert.deepEqual(ctx.factoryCalls[0]!.owner, { kind: "bootstrap", batchId });
      assert.equal(ctx.spawnedSessions[0]!.child.killCalls[0], "SIGTERM");
      assert.equal(ctx.services.browserSession, null, "browserSession cleared");

      // KEY ASSERTION: blind auto-ended after the Chrome kill.
      assert.equal(
        ctx.services.blind.current(),
        null,
        "blind must auto-end after bootstrap Chrome is killed",
      );
    },
    {
      // Simulate the executor's pre-flight: activate blind during the spawn,
      // mimicking the capture state machine's blind.start at runCaptureStep
      // step 1. The pre-marked step_result means the executor will skip the
      // capture entry on this run, so blind is never blind.end()'d by the
      // executor — the FINALLY must do it.
      onSpawn: (services) => {
        services.blind.start("dashboard.stripe.com", "bootstrap-capture");
      },
    },
  );
});

test("cleanup-failed + user-owned browser → Chrome stays → blind stays active (manual recovery)", async () => {
  // Inverse of the previous test: when a user session is in play,
  // stopBootstrapBrowser returns { stopped: false } (user session is
  // preserved). Blind must NOT be auto-resumed — the rendering process is
  // still alive and the user must take an explicit recovery action
  // (`blind end` after they're done with their tab).
  //
  // No onSpawn hook needed: with a pre-existing user session, the factory is
  // never called. We activate blind through a different injection point: we
  // wrap the services.blind state via direct mutation BEFORE /continue (after
  // the C10 pre-flight check would have run — we use a non-capture batch
  // first, then swap in capture... actually simpler: since the C10 guard
  // requires blind to be off at /continue entry, we wait until the request is
  // in flight to set blind. The simplest reliable way: monkey-patch
  // services.bootstrapStore.tryAcquireExecutionLock to activate blind right
  // after it succeeds (simulating "executor activated blind, then took the
  // cleanup-failed branch"). This works because the lock is acquired AFTER
  // the C10 guard and BEFORE the finally cleanup.
  const batchId = "bootstrap-c12-cleanup-failed-user-session";
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    await seedBatch(ctx.services, {
      batchId,
      hasCapture: true,
      status: "in_progress",
      preMarkCompleted: true,
    });

    // Pre-install user session.
    const userSession = makeStubSession({ kind: "user" });
    ctx.services.browserSession = userSession;

    // Inject blind activation between lock acquire and executor finish.
    // We wrap tryAcquireExecutionLock to activate blind right after success.
    const originalAcquire = ctx.services.bootstrapStore.tryAcquireExecutionLock.bind(
      ctx.services.bootstrapStore,
    );
    ctx.services.bootstrapStore.tryAcquireExecutionLock = (id: string): boolean => {
      const ok = originalAcquire(id);
      if (ok) {
        ctx.services.blind.start("dashboard.stripe.com", "bootstrap-capture");
      }
      return ok;
    };

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    // User session untouched.
    assert.equal(userSession.child.killCalls.length, 0, "user child must not be killed");
    assert.equal(ctx.services.browserSession, userSession, "user session preserved");

    // KEY ASSERTION: blind STAYS active — the rendering process is still alive.
    assert.ok(
      ctx.services.blind.current() !== null,
      "blind must NOT auto-end when user session is preserved (manual recovery only)",
    );
  });
});

test("normal completion + bootstrap-owned browser → Chrome cleanly stopped; blind already ended", async () => {
  // Documents the happy path: executor ran the capture state machine to
  // success+verified, which already called blind.end() inside the executor.
  // Finally must still SIGTERM Chrome, but blind is already null so no
  // auto-resume audit event is emitted.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-c12-normal-completion";
    await seedBatch(ctx.services, {
      batchId,
      hasCapture: true,
      status: "in_progress",
      preMarkCompleted: true,
    });

    // Blind is NOT active — executor already cleaned up.
    assert.equal(ctx.services.blind.current(), null, "precondition: blind already ended");

    const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    // Chrome spawned, torn down cleanly. SIGTERM, no SIGKILL.
    assert.equal(ctx.factoryCalls.length, 1);
    assert.equal(ctx.spawnedSessions[0]!.child.killCalls.length, 1);
    assert.equal(ctx.spawnedSessions[0]!.child.killCalls[0], "SIGTERM");
    assert.equal(ctx.services.browserSession, null);

    // Blind stays null (no auto-resume needed).
    assert.equal(ctx.services.blind.current(), null, "blind must remain null");
  });
});

test("concurrent /continue: second caller gets bootstrap_batch_busy WITHOUT spawning a second browser", async () => {
  // Regression guard: the lock must be acquired BEFORE ensureBootstrapBrowser
  // is called, so the second concurrent caller short-circuits with
  // bootstrap_batch_busy and never touches the createBrowserSession factory.
  // If lock and browser-spawn were transposed, the second caller would
  // duplicate-spawn Chrome.
  await withDaemon(async (ctx) => {
    await unlockVault(ctx);

    const batchId = "bootstrap-c12-concurrent-no-double-spawn";
    await seedBatch(ctx.services, {
      batchId,
      hasCapture: true,
      status: "in_progress",
      preMarkCompleted: true,
    });

    // Hold the lock to simulate "first call is currently inside executeBatch".
    const acquired = ctx.services.bootstrapStore.tryAcquireExecutionLock(batchId);
    assert.ok(acquired, "test setup: lock must be acquirable");

    try {
      const r = await call(ctx, "POST", "/v1/bootstrap/continue", { batch_id: batchId });
      assert.equal(r.status, 400, `expected 400 bootstrap_batch_busy, got ${r.status}`);
      const error = (r.body as { error: { code: string } }).error;
      assert.equal(error.code, "bootstrap_batch_busy");

      // KEY ASSERTION: factory was NOT called. The second caller bailed at the
      // lock-check and never reached ensureBootstrapBrowser.
      assert.equal(
        ctx.factoryCalls.length,
        0,
        "factory must NOT be called when bootstrap_batch_busy fires (no duplicate Chrome)",
      );
      assert.equal(ctx.services.browserSession, null, "no browser must be installed");
    } finally {
      ctx.services.bootstrapStore.releaseExecutionLock(batchId);
    }
  });
});
