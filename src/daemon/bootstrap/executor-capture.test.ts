// src/daemon/bootstrap/executor-capture.test.ts
//
// Covers the C11 capture-branch state machine inside `executeBatch`. Exercises
// all 5 state-machine branches plus the pre-flight ordering invariant:
//
//   1. SUCCESS + cleanup verified → blind.end + step ok:true with ref
//   2. SUCCESS + cleanup NOT verified → blind stays active + cleanup_failed; STOP
//   3. FAILURE (skip) + cleanup verified → blind.end + step ok:false; continue
//   4. FAILURE (abort) + cleanup verified → blind.end + step ok:false; STOP; status=abandoned
//   5. FAILURE (timeout) + cleanup verified → blind.end + step ok:false; continue
//   6. FAILURE (redirect_blocked at capture time) → cleanup attempted; behaves like timeout
//   7. FAILURE (any) + cleanup NOT verified → blind stays active + cleanup_failed; STOP
//   8. Pre-flight ordering: blind.start + disableObservationDomains + severAgentConnections
//      fire BEFORE openCaptureTarget
//
// Tests stub the CDP transport so no real Chrome is launched. The
// pendingCaptures registry is used live: tests resolve/reject by token to
// simulate UI submissions. The "deadlock-avoiding" register-then-emit-then-await
// ordering is exercised by every successful path — if the executor awaited
// before emitting, the test's resolveByToken would never fire.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { CdpClient, type CdpTransport } from "../chrome/cdp-client.js";
import { encryptVault } from "../../vault/crypto.js";
import { DaemonServices } from "../services.js";
import { BootstrapStore } from "./store.js";
import { executeBatch, type ExecutorDeps } from "./executor.js";
import { ShuttleError } from "../../shared/errors.js";
import type {
  BrowserSession,
  BrowserSessionChild,
} from "./browser-session.js";
import type { ProxyServer } from "../proxy/cdp-proxy.js";
import type { BrowserOps } from "../chrome/internal-ops.js";

// Defense-in-depth: ensure no real browser launches when the file is run via
// `npx tsx --test <file>` (npm-test wrapper sets this globally but file-targeted
// runs bypass it). `setupFixture` below constructs `new DaemonServices()` without
// hubOpenUrlImpl injection — emitBootstrapCaptureStep's spawn-on-detach would
// otherwise launch a real browser tab when no subscriber is attached.
process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";

// ── Scripted CDP transport ──────────────────────────────────────────────────
//
// Captures every method invoked on the transport (sentMethods) and lets each
// test override:
//   - createdTargetId       — id returned by Target.createTarget
//   - postCleanupTargets    — listTargets result AFTER cleanup (drives the
//                             "verified" boolean in cleanupCaptureTarget)
//   - postBlankUrl          — URL returned by Target.getTargetInfo AFTER blank
//   - failBlankNavigate     — when true, Page.navigate to about:blank throws
//
// The transport replies with `{}` for every method we don't explicitly handle
// (safe default — most CDP calls just need to settle).

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class ScriptedTransport extends EventEmitter implements CdpTransport {
  createdTargetId = "T-capture";
  // Three distinct URLs the daemon may see across the capture lifecycle:
  //   - openUrl: post-load URL during openCaptureTarget
  //   - postBlankUrl: after blankTarget — should be "about:blank" for verified clean
  initialUrl = "https://dashboard.stripe.com/login";
  postBlankUrl = "about:blank";
  /**
   * Result of `listTargets` AFTER closeTarget. By default the target is
   * absent → cleanup verifies clean.
   */
  postCleanupTargets: Array<{ targetId: string; type: string; url: string }> = [];
  /**
   * Result of `listTargets` calls in general (when not overridden by
   * postCleanupTargets-based behaviour). Used for the "list during cleanup"
   * paths where the target should appear/disappear depending on the test.
   */
  // Toggles for forcing cleanup-not-verified scenarios.
  alwaysTargetAlive = false;
  // Toggle: when true, fire Page.loadEventFired immediately after Page.enable.
  emitLoadOnEnable = true;
  sentMethods: string[] = [];
  // Order in which sentMethods OR external observers (blind.start,
  // severAgentConnections) were called. Tests assert the pre-flight
  // ordering invariant against this list.
  callOrder: string[] = [];
  // Counter — tracks how many getTargetInfo calls have been made, so we can
  // alternate between "initial" (open) and "post-blank" (cleanup) URLs.
  getTargetInfoCalls = 0;

  close(): void {
    /* no-op */
  }

  send(msg: Sent): void {
    const method = msg.method ?? "";
    this.sentMethods.push(method);
    this.callOrder.push(`cdp:${method}`);
    const reply = (result: unknown): void =>
      queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    switch (method) {
      case "Target.createTarget":
        reply({ targetId: this.createdTargetId });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: "S-1" });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      case "Target.getTargetInfo": {
        this.getTargetInfoCalls += 1;
        const targetId = String(msg.params?.["targetId"] ?? this.createdTargetId);
        // First call (during openCaptureTarget) → initialUrl.
        // Subsequent calls (during cleanup) → postBlankUrl.
        const url = this.getTargetInfoCalls === 1 ? this.initialUrl : this.postBlankUrl;
        reply({ targetInfo: { targetId, type: "page", url, attached: true } });
        return;
      }
      case "Target.getTargets": {
        // First listTargets call inside disableObservationDomains expects a
        // (possibly empty) list of page targets — return empty so the
        // observation-disable loop is a no-op. Second + later calls come
        // from cleanupCaptureTarget's verify-after-close — return
        // postCleanupTargets there.
        if (this.alwaysTargetAlive) {
          reply({ targetInfos: [{ targetId: this.createdTargetId, type: "page", url: "about:blank" }] });
        } else {
          reply({ targetInfos: this.postCleanupTargets });
        }
        return;
      }
      case "Target.closeTarget":
        reply({});
        return;
      case "Page.enable":
        reply({});
        if (this.emitLoadOnEnable) {
          queueMicrotask(() =>
            this.emit("message", {
              method: "Page.loadEventFired",
              params: { timestamp: 1 },
              sessionId: "S-1",
            }),
          );
        }
        return;
      case "Page.navigate":
        reply({ frameId: "F-1" });
        return;
      default:
        reply({});
        return;
    }
  }
}

// ── Test fixture: services + browserSession + vault ─────────────────────────

interface CaptureFixture {
  services: DaemonServices;
  transport: ScriptedTransport;
  store: BootstrapStore;
  /** Spy: severAgentConnections call count + first-call timestamp. */
  proxyCalls: { severCount: number; severedFirstAt: number | null };
  /** Audit events captured in-process (writeDaemonAudit appends to a file;
   * here we drive the test via the home dir + audit log path). */
  homeDir: string;
}

async function setupFixture(opts: {
  ownerAgentId?: string;
} = {}): Promise<CaptureFixture> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ss-c11-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = homeDir;

  // Write an unlocked vault directly. We bypass the unlock route since these
  // tests only care about upsertSecret semantics.
  const masterKey = randomBytes(32);
  const initialPlaintext = {
    version: 1 as const,
    secrets: [] as never[],
    fingerprint_key: randomBytes(32).toString("base64"),
  };
  const cipher = encryptVault(initialPlaintext, masterKey);
  await writeFile(path.join(homeDir, "vault.json.enc"), JSON.stringify(cipher), { mode: 0o600 });

  const services = new DaemonServices();
  services.lock.unlock(masterKey);

  // Wire a scripted browserSession. The proxy spy records both call count
  // and the first-call timestamp so test 8 can assert "blind.start happened
  // BEFORE Target.createTarget".
  const transport = new ScriptedTransport();
  const cdp = new CdpClient(transport);

  const proxyCalls = { severCount: 0, severedFirstAt: null as number | null };
  const proxy: ProxyServer = {
    url: "ws://127.0.0.1:0/stub",
    severAgentConnections(): void {
      proxyCalls.severCount += 1;
      if (proxyCalls.severedFirstAt === null) {
        proxyCalls.severedFirstAt = Date.now();
      }
      transport.callOrder.push("proxy:severAgentConnections");
    },
    async close(): Promise<void> { /* noop */ },
  };
  const child: BrowserSessionChild = {
    kill(): boolean { return true; },
    once(): unknown { return this; },
  };
  const session: BrowserSession = {
    owner: { kind: "bootstrap", batchId: "test-batch" },
    child,
    cdp,
    proxy,
    browserSessionId: "ws://127.0.0.1:0/stub",
    browser: { available: true } as unknown as BrowserOps,
  };
  services.browserSession = session;

  // Patch services.blind.start so we can record the order against the
  // pre-flight invariant. We delegate to the real implementation so blind
  // state still tracks correctly.
  const origStart = services.blind.start.bind(services.blind);
  services.blind.start = (domain: string, reason: string): ReturnType<typeof origStart> => {
    transport.callOrder.push("blind:start");
    return origStart(domain, reason);
  };

  const store = new BootstrapStore({ rootDir: path.join(homeDir, "bootstrap-batches") });

  // Cleanup tracking — registered on the global testFixtures list so the
  // afterEach can restore env + rmdir.
  registerCleanup(async () => {
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  return { services, transport, store, proxyCalls, homeDir };
}

// Per-test cleanups. node:test doesn't expose afterEach at file scope without
// before/after; we just push cleanups onto a stack and drain after each test.
const cleanups: Array<() => Promise<void>> = [];
function registerCleanup(fn: () => Promise<void>): void { cleanups.push(fn); }
async function drainCleanups(): Promise<void> {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
}

// Default deps with no-op stub cores. Capture branch bypasses revealCapture
// entirely under C11, so the stub here is just a safety net.
function makeDeps(services: DaemonServices, overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    generateSecret: (async () => ({ generated: true, secret_ref: "x", name: "x", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const })) as ExecutorDeps["generateSecret"],
    revealCapture: (async () => { throw new Error("revealCapture must not be called under C11"); }) as ExecutorDeps["revealCapture"],
    runTemplate: (async () => ({ executed: true, template_id: "vercel-env-add", secret_ref: "x", binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const })) as ExecutorDeps["runTemplate"],
    services,
    daemonPortRef: () => 9876,
    ...overrides,
  };
}

async function saveCapturePlan(store: BootstrapStore, opts: {
  batchId: string;
  secret?: string;
  ref?: string;
  url?: string;
  destinations?: number;
  owner?: string;
}): Promise<void> {
  const secret = opts.secret ?? "STRIPE_KEY";
  const destinations = (opts.destinations ?? 1) > 0
    ? [{ kind: "template" as const, shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }]
    : [];
  await store.save({
    batch_id: opts.batchId,
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret,
      ref: opts.ref ?? "ss://local/prod/STRIPE_KEY",
      source: { kind: "capture", url: opts.url ?? "https://dashboard.stripe.com/login" },
      destinations,
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: opts.owner ?? "daemon",
  });
}

// ── Test 1 — SUCCESS + cleanup verified ─────────────────────────────────────

test("capture branch: SUCCESS + cleanup verified → blind.end auto + step ok:true with ref", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();
  await saveCapturePlan(fx.store, { batchId: "b-ok-clean" });

  // Drive the UI side: resolve the pending capture once it's registered. The
  // executor's register → emit → await ordering means by the time we read
  // the broker's lastBootstrapCaptureStep payload, the entry IS in the
  // registry — but we have to wait at least one microtask for the
  // synchronous register to finish. Just poll briefly.
  const driveCapture = (async (): Promise<void> => {
    // Wait until the broker has recorded the SSE payload.
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        const ok = fx.services.pendingCaptures.resolveByToken(ev.capture_token, {
          value: "sk_live_secret_42",
          field_fingerprint: "fp:abc",
        });
        assert.equal(ok, true, "resolveByToken must succeed — register fired before emit");
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error("emitBootstrapCaptureStep never fired");
  })();

  const result = await executeBatch(fx.store, "b-ok-clean", makeDeps(fx.services));
  await driveCapture;

  // Step succeeded → blind is no longer active (auto-resumed).
  assert.equal(fx.services.blind.current(), null, "blind must be auto-ended on success+verified");

  // Step result: ok=true + ref.
  const final = await fx.store.get("b-ok-clean");
  const step = final?.step_results["STRIPE_KEY"];
  assert.ok(step, "step result must exist");
  assert.equal(step?.ok, true);
  assert.ok(typeof step?.ref === "string" && step.ref.length > 0, "ref must be set");

  // Destination ran → 1 completed, 0 failed.
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(final?.status, "completed");

  // Vault contains the captured value.
  const records = await fx.services.vault.list();
  assert.ok(records.some((r) => r.name === "STRIPE_KEY"), "captured secret must be in the vault");
});

// ── Clear hub pending event on settle ──────────────────────────────────────

test("capture branch: runCaptureStep clears the broker's pending hub event after settle (success path)", async (t) => {
  // After the await pending settles (any of the five branches), the executor
  // MUST clear the broker's pendingCaptureStep slot via
  // clearBootstrapCaptureStep(capture_token). Otherwise a later hub attach
  // would replay a stale capture event, and the UI's capture-mode iframe-hide
  // would MASK any unrelated `navigate` for a future operation.
  //
  // We verify the clear by attaching a FRESH hub subscriber AFTER the step
  // settles. If the executor cleared correctly, the subscriber receives
  // no bootstrap_capture_step event. If it did NOT clear, the subscriber
  // would receive the stale event.
  t.after(drainCleanups);
  const fx = await setupFixture();
  await saveCapturePlan(fx.store, { batchId: "b-clear-on-settle" });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        fx.services.pendingCaptures.resolveByToken(ev.capture_token, {
          value: "sk_live_clear", field_fingerprint: "fp:clear",
        });
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error("emitBootstrapCaptureStep never fired");
  })();

  await executeBatch(fx.store, "b-clear-on-settle", makeDeps(fx.services));
  await driveCapture;

  // Now attach a fresh subscriber — there must be NO replay of the
  // capture step (it was cleared in the finally of runCaptureStep).
  const events: import("../hub/hub-broker.js").HubEvent[] = [];
  fx.services.hubBroker.attach({
    write: (e) => events.push(e),
    close: () => undefined,
  });
  const replayed = events.find((e) => e.type === "bootstrap_capture_step");
  assert.equal(
    replayed,
    undefined,
    "after runCaptureStep settles, hub attach must NOT replay a stale capture event",
  );
});

// ── Test 2 — SUCCESS + cleanup NOT verified ─────────────────────────────────

test("capture branch: SUCCESS + cleanup NOT verified → blind stays active + cleanup_failed; STOP", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();
  // Force cleanup to fail: alwaysTargetAlive=true means listTargets always
  // reports the target as still present, so close-verify fails.
  fx.transport.alwaysTargetAlive = true;
  fx.transport.postBlankUrl = "about:blank"; // blank itself "succeeds" per URL — but close verify will fail

  // Two-secret plan so we can assert the second secret is NOT processed.
  await fx.store.save({
    batch_id: "b-ok-dirty",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
      { secret: "SECOND_SECRET", ref: "ss://local/prod/SECOND_SECRET", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        fx.services.pendingCaptures.resolveByToken(ev.capture_token, {
          value: "sk_live_dirty", field_fingerprint: "fp:dirty",
        });
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  const result = await executeBatch(fx.store, "b-ok-dirty", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/SECOND_SECRET", name: "SECOND_SECRET", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  // Blind stays active — capture succeeded but the page may still show the value.
  assert.notEqual(fx.services.blind.current(), null, "blind must remain active on cleanup_failed");

  const final = await fx.store.get("b-ok-dirty");
  const step = final?.step_results["STRIPE_KEY"];
  assert.equal(step?.ok, false);
  assert.equal(step?.error_code, "bootstrap_capture_cleanup_failed");

  // Executor STOPPED → second entry never ran.
  assert.equal(generateCalled, 0, "executor must STOP — subsequent entries must not execute");
  assert.equal(final?.step_results["SECOND_SECRET"], undefined);
  // Batch summary reflects only the one failed entry, and the batch is in a
  // terminal failed_partial state so /continue can retry per R5.
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.equal(final?.status, "failed_partial");
});

// ── Test 3 — FAILURE (skip) + cleanup verified ──────────────────────────────

test("capture branch: FAILURE (skip) + cleanup verified → blind.end + step ok:false; executor continues", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();

  await fx.store.save({
    batch_id: "b-skip-clean",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEXT_SECRET", ref: "ss://local/prod/NEXT_SECRET", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        // SKIP: reject with a non-abort error code → falls into the "continue" branch.
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_skipped", "user skipped"));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  const result = await executeBatch(fx.store, "b-skip-clean", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEXT_SECRET", name: "NEXT_SECRET", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  // Blind ended (auto-resume).
  assert.equal(fx.services.blind.current(), null, "blind must be ended on skip + verified");

  const final = await fx.store.get("b-skip-clean");
  const step = final?.step_results["STRIPE_KEY"];
  assert.equal(step?.ok, false);
  assert.equal(step?.error_code, "bootstrap_capture_skipped");

  // Executor CONTINUED to NEXT_SECRET.
  assert.equal(generateCalled, 1, "skip is a continue — next entry must execute");
  assert.equal(final?.step_results["NEXT_SECRET"]?.ok, true);
  // Final status is failed_partial (the skip counts as a failed entry).
  assert.equal(final?.status, "failed_partial");
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);
});

// ── Test 4 — FAILURE (abort) + cleanup verified ─────────────────────────────

test("capture branch: FAILURE (abort) + cleanup verified → blind.end + step ok:false; STOP; status=abandoned", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();

  await fx.store.save({
    batch_id: "b-abort-clean",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEVER_RUN", ref: "ss://local/prod/NEVER_RUN", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_aborted", "user aborted"));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  await executeBatch(fx.store, "b-abort-clean", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEVER_RUN", name: "NEVER_RUN", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  // Blind ended (auto-resume): cleanup verified.
  assert.equal(fx.services.blind.current(), null, "blind must be ended on abort + verified");

  const final = await fx.store.get("b-abort-clean");
  const step = final?.step_results["STRIPE_KEY"];
  assert.equal(step?.ok, false);
  assert.equal(step?.error_code, "bootstrap_capture_aborted");

  // Executor STOPPED.
  assert.equal(generateCalled, 0, "abort STOPs — second entry must not execute");
  assert.equal(final?.step_results["NEVER_RUN"], undefined);
  // Status is abandoned (C8).
  assert.equal(final?.status, "abandoned");
});

// ── Test 5 — FAILURE (timeout) + cleanup verified ───────────────────────────

test("capture branch: FAILURE (timeout) + cleanup verified → blind.end + step ok:false; continue", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();

  await fx.store.save({
    batch_id: "b-timeout-clean",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEXT_SECRET", ref: "ss://local/prod/NEXT_SECRET", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        // Reject with the same error code the C7 timer produces.
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_timeout", "5 minutes elapsed without a capture."));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  await executeBatch(fx.store, "b-timeout-clean", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEXT_SECRET", name: "NEXT_SECRET", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  assert.equal(fx.services.blind.current(), null);
  const final = await fx.store.get("b-timeout-clean");
  assert.equal(final?.step_results["STRIPE_KEY"]?.error_code, "bootstrap_capture_timeout");
  // Executor CONTINUED.
  assert.equal(generateCalled, 1, "timeout is a continue — next entry must execute");
  assert.equal(final?.step_results["NEXT_SECRET"]?.ok, true);
});

// ── Test 6 — FAILURE (redirect_blocked at capture time) → behaves like timeout ──

test("capture branch: FAILURE (redirect_blocked) → cleanup attempted; behaves like timeout (continue)", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();

  await fx.store.save({
    batch_id: "b-redirect",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEXT_SECRET", ref: "ss://local/prod/NEXT_SECRET", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        // The C13 raw UI route rejects with redirect_blocked when the
        // at-capture-time host check fails. Surface the same code here.
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_redirect_blocked", "host drifted at capture"));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  await executeBatch(fx.store, "b-redirect", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEXT_SECRET", name: "NEXT_SECRET", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  assert.equal(fx.services.blind.current(), null);
  const final = await fx.store.get("b-redirect");
  assert.equal(final?.step_results["STRIPE_KEY"]?.error_code, "bootstrap_capture_redirect_blocked");
  // Cleanup was attempted — at least one Target.closeTarget call observed.
  assert.ok(fx.transport.sentMethods.includes("Target.closeTarget"), "cleanup must call Target.closeTarget");
  // Behaves like timeout: continue to next entry.
  assert.equal(generateCalled, 1, "redirect_blocked is a continue — next entry must execute");
  assert.equal(final?.step_results["NEXT_SECRET"]?.ok, true);
});

// ── Test 6b — FAILURE (field_unreadable at capture time) → behaves like redirect ──

// Pins the contract that bootstrap_capture_field_unreadable hits the same
// executor branch as bootstrap_capture_redirect_blocked (see executor.ts:725 —
// the "FAILURE + verified, non-abort" branch CONTINUEs). The C13 UI route
// comment in bootstrap-capture-ui.ts calls this out explicitly ("behaves like
// redirect"); this test stops a future refactor from accidentally segregating
// the two codes without anyone noticing.
test("capture branch: FAILURE (field_unreadable) → cleanup attempted; behaves like redirect (continue)", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();

  await fx.store.save({
    batch_id: "b-field-unreadable",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEXT_SECRET", ref: "ss://local/prod/NEXT_SECRET", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        // The C13 raw UI route rejects with field_unreadable when host is
        // correct but the focused field / selection state does not match.
        // Surface the same code here.
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_field_unreadable", "no focused field on the capture tab"));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  await executeBatch(fx.store, "b-field-unreadable", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEXT_SECRET", name: "NEXT_SECRET", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  assert.equal(fx.services.blind.current(), null);
  const final = await fx.store.get("b-field-unreadable");
  assert.equal(final?.step_results["STRIPE_KEY"]?.error_code, "bootstrap_capture_field_unreadable");
  // Cleanup was attempted — at least one Target.closeTarget call observed.
  assert.ok(fx.transport.sentMethods.includes("Target.closeTarget"), "cleanup must call Target.closeTarget");
  // Behaves like redirect: continue to next entry.
  assert.equal(generateCalled, 1, "field_unreadable is a continue — next entry must execute");
  assert.equal(final?.step_results["NEXT_SECRET"]?.ok, true);
});

// ── Test 7 — FAILURE (any) + cleanup NOT verified → STOP ────────────────────

test("capture branch: FAILURE (any) + cleanup NOT verified → blind stays active + cleanup_failed; STOP", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();
  // Force cleanup to fail.
  fx.transport.alwaysTargetAlive = true;

  await fx.store.save({
    batch_id: "b-fail-dirty",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "STRIPE_KEY", ref: "ss://local/prod/STRIPE_KEY", source: { kind: "capture", url: "https://dashboard.stripe.com/login" }, destinations: [] },
      { secret: "NEVER_RUN", ref: "ss://local/prod/NEVER_RUN", source: { kind: "random_32_bytes" }, destinations: [] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        fx.services.pendingCaptures.rejectByToken(ev.capture_token, new ShuttleError("bootstrap_capture_timeout", "timed out"));
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  let generateCalled = 0;
  await executeBatch(fx.store, "b-fail-dirty", makeDeps(fx.services, {
    generateSecret: (async () => { generateCalled += 1; return { generated: true, secret_ref: "ss://local/prod/NEVER_RUN", name: "NEVER_RUN", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; }) as ExecutorDeps["generateSecret"],
  }));
  await driveCapture;

  // Blind stays active.
  assert.notEqual(fx.services.blind.current(), null);

  const final = await fx.store.get("b-fail-dirty");
  const step = final?.step_results["STRIPE_KEY"];
  assert.equal(step?.error_code, "bootstrap_capture_cleanup_failed", "non-verified cleanup overrides the original failure code");

  // Executor STOPPED.
  assert.equal(generateCalled, 0, "STOP — next entry must NOT execute");
  assert.equal(final?.step_results["NEVER_RUN"], undefined);
  // Non-abort failure + dirty cleanup is a terminal failed_partial, not
  // abandoned — only the explicit abort case transitions to abandoned.
  assert.equal(final?.status, "failed_partial");
});

// ── Test 8 — Pre-flight ordering ────────────────────────────────────────────

test("capture branch: blind.start + disableObservationDomains + severAgentConnections fire BEFORE openCaptureTarget", async (t) => {
  t.after(drainCleanups);
  const fx = await setupFixture();
  await saveCapturePlan(fx.store, { batchId: "b-order" });

  const driveCapture = (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
      if (ev !== null) {
        fx.services.pendingCaptures.resolveByToken(ev.capture_token, { value: "v", field_fingerprint: "fp" });
        return;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  })();

  await executeBatch(fx.store, "b-order", makeDeps(fx.services));
  await driveCapture;

  // Required preconditions for the ordering assertion:
  //   - blind:start must appear BEFORE the first Target.createTarget call.
  //   - severAgentConnections must appear BEFORE Target.createTarget.
  //   - disableObservationDomains (which we observe as Target.getTargets +
  //     a series of Target.attachToTarget for page targets) must appear
  //     BEFORE Target.createTarget. With our scripted transport returning
  //     an empty page-target list, the observation loop is a no-op — the
  //     SINGLE Target.getTargets call before createTarget is sufficient
  //     proof that disableObservationDomains executed.
  const blindStart = fx.transport.callOrder.indexOf("blind:start");
  const sever = fx.transport.callOrder.indexOf("proxy:severAgentConnections");
  const firstCreateTarget = fx.transport.callOrder.indexOf("cdp:Target.createTarget");
  const firstGetTargets = fx.transport.callOrder.indexOf("cdp:Target.getTargets");

  assert.notEqual(blindStart, -1, "blind:start must have been called");
  assert.notEqual(sever, -1, "severAgentConnections must have been called");
  assert.notEqual(firstCreateTarget, -1, "Target.createTarget must have been called");
  assert.notEqual(firstGetTargets, -1, "Target.getTargets must have been called (disableObservationDomains)");

  assert.ok(blindStart < firstCreateTarget, "blind.start must come BEFORE openCaptureTarget");
  assert.ok(firstGetTargets < firstCreateTarget, "disableObservationDomains must come BEFORE openCaptureTarget");
  assert.ok(sever < firstCreateTarget, "severAgentConnections must come BEFORE openCaptureTarget");

  // Additional invariant — register comes before emit, and the SSE event
  // carries the token. We can't observe register directly (it's in the
  // PendingCapturesRegistry), but the fact that resolveByToken succeeded
  // proves the registry entry existed when the event payload was read.
  const ev = fx.services.hubBroker.lastBootstrapCaptureStep;
  assert.ok(ev !== null, "emit must have recorded the SSE payload");
  assert.ok(typeof ev?.capture_token === "string" && (ev?.capture_token ?? "").length > 0, "capture_token must be present in the SSE payload");
});
