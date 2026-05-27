// src/daemon/bootstrap/browser-session.test.ts
//
// Covers `DaemonServices.ensureBootstrapBrowser` / `stopBootstrapBrowser`:
// owner-tagged spawn, reuse of pre-existing user sessions, owner-guarded stop,
// and the cleanup-order contract (proxy → cdp → SIGTERM → SIGKILL after 3s).
//
// No real Chrome is launched. Tests stub `createBrowserSession` via the
// `createBrowserSessionImpl` test-only injection point on DaemonServices, or
// preload `services.browserSession` directly when only stop-path behavior is
// being exercised.
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonServices } from "../services.js";
import type { BootstrapBrowserLease } from "../services.js";
import { ShuttleError } from "../../shared/errors.js";
import type {
  BrowserSession,
  BrowserSessionChild,
} from "./browser-session.js";
import type { CdpClient } from "../chrome/cdp-client.js";
import type { ProxyServer } from "../proxy/cdp-proxy.js";
import type { BrowserOps } from "../chrome/internal-ops.js";

// Defense-in-depth: ensure no real browser launches when the file is run via
// `npx tsx --test <file>` (npm-test wrapper sets this globally but file-targeted
// runs bypass it). Multiple tests below construct `new DaemonServices()` without
// hubOpenUrlImpl injection — emitBootstrapCaptureStep's spawn-on-detach would
// otherwise launch a real browser tab on those code paths.
process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";

interface StubChild extends BrowserSessionChild {
  killCalls: NodeJS.Signals[];
  exitListeners: Array<(code: number | null) => void>;
  /** Synthesize a clean exit. Resolves any once("exit") listener. */
  fireExit(): void;
}

function makeStubChild(opts: { exitOnSigterm?: boolean } = {}): StubChild {
  const stub: StubChild = {
    killCalls: [],
    exitListeners: [],
    kill(signal?: NodeJS.Signals): boolean {
      const sig = signal ?? ("SIGTERM" as NodeJS.Signals);
      stub.killCalls.push(sig);
      if (opts.exitOnSigterm === true && sig === "SIGTERM") {
        // Defer one tick so the once("exit") listener registered AFTER
        // kill() in stopBootstrapBrowser fires.
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
  /** Set to fire after cdp.close (proves ordering). */
  onCloseStart?: () => void;
}

function makeStubProxy(opts: { onCloseStart?: () => void } = {}): StubProxy {
  const p: StubProxy = {
    url: "ws://127.0.0.1:0/stub",
    severAgentConnections(): void { /* noop */ },
    async close(): Promise<void> {
      p.onCloseStart?.();
      p.closeCalls += 1;
    },
    closeCalls: 0,
    ...(opts.onCloseStart !== undefined ? { onCloseStart: opts.onCloseStart } : {}),
  };
  return p;
}

interface StubCdp {
  closeCalls: number;
  onCloseStart?: () => void;
  close(): Promise<void>;
}

function makeStubCdp(opts: { onCloseStart?: () => void } = {}): StubCdp & CdpClient {
  const c: StubCdp = {
    closeCalls: 0,
    ...(opts.onCloseStart !== undefined ? { onCloseStart: opts.onCloseStart } : {}),
    async close(): Promise<void> {
      c.onCloseStart?.();
      c.closeCalls += 1;
    },
  };
  // Cast through unknown — stopBootstrapBrowser only ever calls `.close()`.
  return c as unknown as StubCdp & CdpClient;
}

function makeStubSession(opts: {
  owner: BrowserSession["owner"];
  child?: StubChild;
  proxy?: StubProxy | null;
  cdp?: StubCdp & CdpClient;
}): BrowserSession & {
  child: StubChild;
  proxy: StubProxy | null;
  cdp: StubCdp & CdpClient;
} {
  const child = opts.child ?? makeStubChild({ exitOnSigterm: true });
  const proxy = opts.proxy === undefined ? makeStubProxy() : opts.proxy;
  const cdp = opts.cdp ?? makeStubCdp();
  return {
    owner: opts.owner,
    child,
    cdp,
    proxy,
    browserSessionId: "ws://127.0.0.1:0/stub",
    browser: { available: true } as unknown as BrowserOps,
  } as BrowserSession & {
    child: StubChild;
    proxy: StubProxy | null;
    cdp: StubCdp & CdpClient;
  };
}

// ---------------------------------------------------------------------------
// ensureBootstrapBrowser
// ---------------------------------------------------------------------------

test("ensureBootstrapBrowser: spawns when absent, tags owner as { bootstrap, batchId }", async () => {
  const spawned = makeStubSession({ owner: { kind: "bootstrap", batchId: "b1" } });
  let calls = 0;
  let capturedBlind: unknown;
  const services: DaemonServices = new DaemonServices({
    createBrowserSessionImpl: async (opts): Promise<BrowserSession> => {
      calls += 1;
      assert.equal(opts.profile, "bootstrap");
      capturedBlind = opts.blind;
      assert.deepEqual(opts.owner, { kind: "bootstrap", batchId: "b1" });
      // Reflect the owner back, like the real factory does.
      return { ...spawned, owner: opts.owner };
    },
  });
  assert.equal(services.browserSession, null);

  const got = await services.ensureBootstrapBrowser("b1");

  assert.equal(calls, 1);
  assert.equal(capturedBlind, services.blind, "factory must receive services.blind");
  assert.equal(services.browserSession, got);
  assert.deepEqual(got.owner, { kind: "bootstrap", batchId: "b1" });
});

test("ensureBootstrapBrowser: reuses pre-existing user session unchanged", async () => {
  const userSession = makeStubSession({ owner: { kind: "user" } });
  let calls = 0;
  const services = new DaemonServices({
    createBrowserSessionImpl: async () => {
      calls += 1;
      throw new Error("must not spawn — user session must be reused");
    },
  });
  services.browserSession = userSession;

  const got = await services.ensureBootstrapBrowser("b1");

  assert.equal(calls, 0, "factory must not be called when a session already exists");
  assert.equal(got, userSession);
  // Ownership must stay user — bootstrap never re-owns a user session.
  assert.deepEqual(services.browserSession?.owner, { kind: "user" });
});

test("ensureBootstrapBrowser: same bootstrap batchId → idempotent reuse", async () => {
  // Repeated /continue calls within the same batch must NOT spawn a second
  // Chrome — the lock-based serialization in /continue prevents parallel
  // executions, but the ensure call itself should still be idempotent within
  // a batch (defensive — covers retry-after-crash flows).
  const session = makeStubSession({ owner: { kind: "bootstrap", batchId: "b1" } });
  let calls = 0;
  const services = new DaemonServices({
    createBrowserSessionImpl: async () => {
      calls += 1;
      throw new Error("must not spawn — same-batch session must be reused");
    },
  });
  services.browserSession = session;

  const got = await services.ensureBootstrapBrowser("b1");

  assert.equal(calls, 0);
  assert.equal(got, session);
});

test("ensureBootstrapBrowser: different bootstrap batchId → throws bootstrap_browser_busy", async () => {
  // Two bootstrap batches racing each other must NOT share Chrome. Batch A's
  // stopBootstrapBrowser would tear down the session out from under batch B
  // mid-capture, racing the proxy/cdp teardown. The cross-batch path throws
  // bootstrap_browser_busy so callers can wait + retry instead of
  // silently corrupting B's state.
  const aSession = makeStubSession({ owner: { kind: "bootstrap", batchId: "batch-A" } });
  let calls = 0;
  const services = new DaemonServices({
    createBrowserSessionImpl: async () => {
      calls += 1;
      throw new Error("must not spawn — cross-batch must be rejected, not silently joined");
    },
  });
  services.browserSession = aSession;

  await assert.rejects(
    () => services.ensureBootstrapBrowser("batch-B"),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "bootstrap_browser_busy");
      // The error message must name the holder so an operator (or retry
      // policy) knows which batch they're waiting on.
      assert.match(err.message, /batch-A/);
      return true;
    },
  );
  assert.equal(calls, 0);
  // The existing session must be left in place; batch A is still running.
  assert.equal(services.browserSession, aSession);
});

// ---------------------------------------------------------------------------
// stopBootstrapBrowser
// ---------------------------------------------------------------------------

test("stopBootstrapBrowser: no-op for user-owned session", async () => {
  const userSession = makeStubSession({ owner: { kind: "user" } });
  const services = new DaemonServices();
  services.browserSession = userSession;

  const result = await services.stopBootstrapBrowser("b1");

  assert.deepEqual(result, { stopped: false });
  assert.equal(services.browserSession, userSession, "user session must be left in place");
  assert.equal(userSession.child.killCalls.length, 0, "kill must not be called");
  assert.equal(userSession.cdp.closeCalls, 0);
  assert.equal(userSession.proxy?.closeCalls, 0);
});

test("stopBootstrapBrowser: returns { stopped: false } when batchId does not match owner.batchId", async () => {
  const otherBatch = makeStubSession({ owner: { kind: "bootstrap", batchId: "OTHER" } });
  const services = new DaemonServices();
  services.browserSession = otherBatch;

  const result = await services.stopBootstrapBrowser("b1");

  assert.deepEqual(result, { stopped: false });
  // Session for the OTHER batch must NOT have been touched.
  assert.equal(services.browserSession, otherBatch);
  assert.equal(otherBatch.child.killCalls.length, 0);
  assert.equal(otherBatch.cdp.closeCalls, 0);
  assert.equal(otherBatch.proxy?.closeCalls, 0);
});

test("stopBootstrapBrowser: kills bootstrap-owned session in proxy → cdp → SIGTERM order", async () => {
  // Track call order across proxy / cdp / kill.
  const order: string[] = [];
  const proxy = makeStubProxy({ onCloseStart: () => order.push("proxy") });
  const cdp = makeStubCdp({ onCloseStart: () => order.push("cdp") });
  const child = makeStubChild({ exitOnSigterm: true });
  // Wrap kill to record order.
  const origKill = child.kill.bind(child);
  child.kill = (sig?: NodeJS.Signals): boolean => {
    order.push(`kill:${sig ?? "SIGTERM"}`);
    return origKill(sig);
  };
  const session = makeStubSession({
    owner: { kind: "bootstrap", batchId: "b1" },
    child,
    proxy,
    cdp,
  });
  const services = new DaemonServices();
  services.browserSession = session;

  const result = await services.stopBootstrapBrowser("b1");

  assert.deepEqual(result, { stopped: true });
  assert.deepEqual(order, ["proxy", "cdp", "kill:SIGTERM"]);
  assert.equal(proxy.closeCalls, 1);
  assert.equal(cdp.closeCalls, 1);
  assert.equal(child.killCalls[0], "SIGTERM");
  // SIGKILL should NOT fire when the child exits in time.
  assert.equal(child.killCalls.includes("SIGKILL" as NodeJS.Signals), false);
  assert.equal(services.browserSession, null, "browserSession must be cleared after stop");
});

test("stopBootstrapBrowser: SIGKILL fallback fires if SIGTERM never exits in time", async () => {
  // exitOnSigterm:false → child never resolves once("exit") on its own.
  const child = makeStubChild({ exitOnSigterm: false });
  const session = makeStubSession({
    owner: { kind: "bootstrap", batchId: "b1" },
    child,
  });
  const services = new DaemonServices();
  services.browserSession = session;

  // Use mock timers so the 3000ms fallback fires deterministically.
  // setTimeout is the API the implementation schedules on; ticking past 3000ms
  // synchronously fires its callback (which calls SIGKILL and resolves the race).
  const t = test.mock.timers;
  t.enable({ apis: ["setTimeout"] });
  try {
    const p = services.stopBootstrapBrowser("b1");
    // Drain the microtask queue so the async chain (proxy.close → cdp.close →
    // SIGTERM → Promise.race) has reached the setTimeout schedule point.
    // Multiple drains are needed because each await suspends one tick.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    // Now the 3s timer is registered — advance past it.
    t.tick(3001);
    const result = await p;
    assert.deepEqual(result, { stopped: true });
    assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  } finally {
    t.reset();
  }
  assert.equal(services.browserSession, null);
});

// ---------------------------------------------------------------------------
// reserveBootstrapBrowser / releaseBootstrapBrowser (LEASE MODEL)
// ---------------------------------------------------------------------------
//
// These synchronous primitives close the cross-batch double-spawn race the
// old slot-only precheck missed. /continue calls reserveBootstrapBrowser
// SYNCHRONOUSLY before requireApprovals so a losing batch fails BEFORE its
// approval is consumed.
//
// Reservation now returns a unique LEASE (batchId + monotonic handle).
// releaseBootstrapBrowser(lease) is handle-guarded — clears the slot ONLY
// if that exact lease still owns it. This prevents a duplicate same-batch
// /continue's outer finally from clearing the ORIGINAL /continue's still-
// active reservation.

test("reserveBootstrapBrowser: throws bootstrap_browser_busy when a different batch holds the reservation", () => {
  const services = new DaemonServices();
  services.reserveBootstrapBrowser("batch-A");
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-B"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError);
      assert.equal(e.code, "bootstrap_browser_busy");
      // Holder name must appear in the message so operators / retry policies
      // can identify which batch they're waiting on.
      assert.match(e.message, /batch-A/);
      return true;
    },
  );
});

test("reserveBootstrapBrowser: same batchId concurrent reservation throws bootstrap_batch_busy", () => {
  // LEASE MODEL CHANGE: same-batch re-reserve is no longer idempotent. A
  // duplicate /continue while another /continue for the same batch is
  // already mid-flight throws bootstrap_batch_busy, symmetric with the
  // per-batch execution lock model. This prevents two same-batch /continue
  // calls from both "holding" the slot, where a stale release from the
  // duplicate would clear the active lease held by the original.
  const services = new DaemonServices();
  services.reserveBootstrapBrowser("batch-A");
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-A"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError);
      assert.equal(e.code, "bootstrap_batch_busy");
      return true;
    },
  );
});

test("reserveBootstrapBrowser: returns a unique lease handle per reservation", () => {
  // Sanity check on lease uniqueness: after release + re-reserve, the new
  // lease's handle differs from the prior one. (Same batchId, different
  // cycle → different handle.) This is what makes releaseBootstrapBrowser
  // safe under duplicate /continue scenarios.
  const services = new DaemonServices();
  const leaseA1 = services.reserveBootstrapBrowser("batch-A");
  services.releaseBootstrapBrowser(leaseA1);
  const leaseA2 = services.reserveBootstrapBrowser("batch-A");
  assert.notEqual(leaseA1.handle, leaseA2.handle, "lease handle must be unique per reservation");
  assert.equal(leaseA1.batchId, "batch-A");
  assert.equal(leaseA2.batchId, "batch-A");
  services.releaseBootstrapBrowser(leaseA2);
});

test("releaseBootstrapBrowser: handle-guarded (stale release from duplicate /continue does not clear active lease)", () => {
  // The exact race the lease model closes:
  //
  // /continue A reserves(batch-A) → leaseA. /continue A is still mid-spawn.
  // /continue B (also batch-A) tries to reserve and would throw
  // bootstrap_batch_busy synchronously. If B somehow held a stale "lease"
  // (e.g. from a fabricated handle), passing it to release MUST NOT clear
  // A's reservation.
  const services = new DaemonServices();
  const leaseA = services.reserveBootstrapBrowser("batch-A");

  // Simulate a stale lease (different handle, same batchId).
  const staleLease: BootstrapBrowserLease = { batchId: "batch-A", handle: leaseA.handle + 999 };
  services.releaseBootstrapBrowser(staleLease); // no-op

  // The original lease's batch is still reserved — different-batch reserve
  // still blocked.
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-B"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_browser_busy",
  );

  // Real release with the correct lease clears the slot.
  services.releaseBootstrapBrowser(leaseA);
  const leaseB = services.reserveBootstrapBrowser("batch-B"); // succeeds
  services.releaseBootstrapBrowser(leaseB);
});

test("releaseBootstrapBrowser: idempotent (no-op when no reservation exists)", () => {
  // Outer-finally release on a path where the reservation was already
  // cleared (or never made) must not blow up. The function silently no-ops
  // when there's no reservation OR the handle doesn't match.
  const services = new DaemonServices();
  const phantomLease: BootstrapBrowserLease = { batchId: "batch-A", handle: 42 };
  services.releaseBootstrapBrowser(phantomLease);
  services.releaseBootstrapBrowser(phantomLease);
});

test("releaseBootstrapBrowser: double-release of the same lease is a no-op on the second call", () => {
  // Calling release(lease) twice with the same lease: first call clears the
  // slot, second call is a no-op (lease.handle no longer matches
  // bootstrapBrowserReservation, which is now null).
  const services = new DaemonServices();
  const leaseA = services.reserveBootstrapBrowser("batch-A");
  services.releaseBootstrapBrowser(leaseA);
  services.releaseBootstrapBrowser(leaseA); // must not blow up
  // Slot is free — a fresh reserve succeeds.
  const leaseB = services.reserveBootstrapBrowser("batch-B");
  services.releaseBootstrapBrowser(leaseB);
});

test("reserveBootstrapBrowser: throws when an existing bootstrap session is from a different batch", () => {
  // The pre-spawn collision path: services.browserSession already holds a
  // bootstrap session for batch-A. reserveBootstrapBrowser for batch-B must
  // refuse — same semantics as the legacy slot-only precheck.
  const services = new DaemonServices();
  services.browserSession = makeStubSession({ owner: { kind: "bootstrap", batchId: "batch-A" } });
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-B"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError);
      assert.equal(e.code, "bootstrap_browser_busy");
      assert.match(e.message, /batch-A/);
      return true;
    },
  );
});

test("reserveBootstrapBrowser: tolerates a pre-existing user-owned session (no throw)", () => {
  // User-owned sessions are never re-owned by bootstrap — ensureBootstrapBrowser
  // reuses them in place. The reservation must not fight that: a bootstrap
  // batch should still be able to claim the slot for accounting purposes
  // even when a user session is in residence (so cross-batch reservation
  // collisions still work).
  const services = new DaemonServices();
  services.browserSession = makeStubSession({ owner: { kind: "user" } });
  const lease = services.reserveBootstrapBrowser("batch-A"); // must not throw
  // And a second batch is still rejected via the reservation.
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-B"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_browser_busy",
  );
  services.releaseBootstrapBrowser(lease);
});

test("ensureBootstrapBrowser: respects reservation held by a different batch (defense-in-depth)", async () => {
  // Direct ensureBootstrapBrowser callers that forget to reserve first must
  // still be blocked. /continue is expected to reserve, but the throw inside
  // ensureBootstrapBrowser is the fallback safety net.
  let factoryCalls = 0;
  const services = new DaemonServices({
    createBrowserSessionImpl: async (): Promise<BrowserSession> => {
      factoryCalls += 1;
      throw new Error("factory must not be called when a different batch holds the reservation");
    },
  });
  services.reserveBootstrapBrowser("batch-A");
  await assert.rejects(
    () => services.ensureBootstrapBrowser("batch-B"),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "bootstrap_browser_busy");
      assert.match(e.message, /batch-A/);
      return true;
    },
  );
  assert.equal(factoryCalls, 0, "factory must not be invoked when reservation blocks");
  // services.browserSession must still be clean — no half-spawned session left behind.
  assert.equal(services.browserSession, null);
});

test("ensureBootstrapBrowser: own batch's reservation does NOT block its own spawn", async () => {
  // The expected /continue flow: reserve(batchId) → ensure(batchId) → ... .
  // The reservation must not block the same batch from progressing.
  const spawned = makeStubSession({ owner: { kind: "bootstrap", batchId: "batch-A" } });
  let factoryCalls = 0;
  const services = new DaemonServices({
    createBrowserSessionImpl: async (opts): Promise<BrowserSession> => {
      factoryCalls += 1;
      return { ...spawned, owner: opts.owner };
    },
  });
  services.reserveBootstrapBrowser("batch-A");

  const got = await services.ensureBootstrapBrowser("batch-A");

  assert.equal(factoryCalls, 1);
  assert.equal(services.browserSession, got);
  assert.deepEqual(got.owner, { kind: "bootstrap", batchId: "batch-A" });
});

test("releaseBootstrapBrowser: a fast-failing duplicate same-batch /continue does NOT clear the original lease", () => {
  // The EXACT scenario the reviewer described:
  //
  // 1. /continue A reserves(batch-X) → leaseA (handle=1).
  // 2. /continue B (also batch-X) attempts to reserve → throws
  //    bootstrap_batch_busy. B's caller scope has lease=null.
  // 3. B's outer finally: `if (lease !== null) release(lease)` — skipped.
  // 4. A is still mid-spawn. A's leaseA is preserved.
  // 5. /continue C (batch-Y) tries to reserve → blocked by A's lease.
  //
  // Without the lease model (old batchId-keyed release): B's finally would
  // call release(batchId=X), which under the prior idempotent semantics
  // would clear the reservation. /continue C would then succeed, racing A
  // into ensureBootstrapBrowser and reopening the cross-batch double-spawn
  // window.
  const services = new DaemonServices();
  const leaseA = services.reserveBootstrapBrowser("batch-X");

  // B fails to reserve.
  let bError: unknown;
  let bLease: BootstrapBrowserLease | null = null;
  try {
    bLease = services.reserveBootstrapBrowser("batch-X");
  } catch (e) {
    bError = e;
  }
  assert.ok(bError instanceof ShuttleError);
  assert.equal((bError as ShuttleError).code, "bootstrap_batch_busy");
  assert.equal(bLease, null, "B did not receive a lease — its finally must be a no-op");

  // B's finally: release whatever lease it got (which is null, so no-op).
  if (bLease !== null) services.releaseBootstrapBrowser(bLease);

  // Cross-batch reserve still blocked by A's lease — the critical invariant.
  assert.throws(
    () => services.reserveBootstrapBrowser("batch-Y"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError);
      assert.equal(e.code, "bootstrap_browser_busy");
      assert.match(e.message, /batch-X/, "A's batch must still appear as the holder");
      return true;
    },
  );

  // Cleanup: A finishes, releases its lease, and the slot is free.
  services.releaseBootstrapBrowser(leaseA);
  const leaseY = services.reserveBootstrapBrowser("batch-Y");
  services.releaseBootstrapBrowser(leaseY);
});
