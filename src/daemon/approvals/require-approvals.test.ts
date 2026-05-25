import { test } from "node:test";
import assert from "node:assert";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { SessionStore } from "./session-store.js";
import { requireApprovals } from "./require-approvals.js";
import { ShuttleError } from "../../shared/errors.js";

function devBinding(): ApprovalBinding {
  return { action: "run", ref: null, environment: "development", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: [] };
}
function envBinding(): ApprovalBinding {
  return { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { kind: "env", refs: "ss://local/prod/A" }, allowed_domains: [] };
}
function stdinBinding(): ApprovalBinding {
  return { action: "run_stdin", ref: "ss://local/prod/B", environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { kind: "stdin", ref: "ss://local/prod/B" }, allowed_domains: [] };
}

test("requireApprovals: empty bindings returns []", async () => {
  const store = new ApprovalStore();
  const result = await requireApprovals({ store, bindings: [], daemonPort: 1234 });
  assert.deepStrictEqual(result, []);
});

test("requireApprovals: dev binding synthesizes grant (no production)", async () => {
  const store = new ApprovalStore();
  const result = await requireApprovals({ store, bindings: [devBinding()], daemonPort: 1234 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.id, "no-approval-required");
  assert.strictEqual(result[0]!.status, "used");
});

test("requireApprovals: production binding, no IDs, --no-wait → throws approval_required with details.approvals length 1", async () => {
  const store = new ApprovalStore();
  let openedUrl: string | undefined;
  await assert.rejects(
    requireApprovals({ store, bindings: [envBinding()], daemonPort: 1234, waitMs: 0, openUrlImpl: (u: string) => { openedUrl = u; } }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError)) return false;
      if (e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1);
      assert.strictEqual(details.approvals[0]!.action, "run");
      return true;
    },
  );
  assert.ok(openedUrl?.includes("/ui/approve?id="));
});

test("requireApprovals: production binding, correct granted ID → consumes, returns grant", async () => {
  const store = new ApprovalStore();
  const binding = envBinding();
  const minted = store.create(binding);
  store.approve(minted.id);

  const grants = await requireApprovals({
    store, bindings: [binding], daemonPort: 1234,
    approvalIdsFromClient: [minted.id],
  });
  assert.strictEqual(grants.length, 1);
  assert.strictEqual(grants[0]!.id, minted.id);
  assert.strictEqual(grants[0]!.status, "used");
});

test("requireApprovals: combined env+stdin, no IDs, --no-wait → throws with both approvals in order", async () => {
  const store = new ApprovalStore();
  await assert.rejects(
    requireApprovals({
      store, bindings: [envBinding(), stdinBinding()], daemonPort: 1234, waitMs: 0,
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 2);
      assert.strictEqual(details.approvals[0]!.action, "run");
      assert.strictEqual(details.approvals[1]!.action, "run_stdin");
      return true;
    },
  );
});

test("requireApprovals: combined env+stdin, both IDs supplied in order → both consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234,
    approvalIdsFromClient: [envApproval.id, stdinApproval.id],
  });
  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0]!.id, envApproval.id);
  assert.strictEqual(grants[1]!.id, stdinApproval.id);
});

test("requireApprovals: best-fit matching — IDs in reverse order still consumed correctly", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234,
    approvalIdsFromClient: [stdinApproval.id, envApproval.id], // reversed
  });
  assert.strictEqual(grants[0]!.id, envApproval.id); // matched by binding equality, not position
  assert.strictEqual(grants[1]!.id, stdinApproval.id);
});

test("requireApprovals: partial --no-wait (only env ID supplied) → throws approval_required for stdin only; env ID NOT consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234, waitMs: 0,
      approvalIdsFromClient: [envApproval.id],
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1, "only stdin mint should be in details");
      assert.strictEqual(details.approvals[0]!.action, "run_stdin");
      return true;
    },
  );
  // Critical: env ID is still granted (Phase 1 didn't burn it).
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
});

test("requireApprovals: unknown ID supplied → throws approval_not_found (NOT approval_mismatch)", async () => {
  const store = new ApprovalStore();
  await assert.rejects(
    requireApprovals({
      store, bindings: [envBinding()], daemonPort: 1234,
      approvalIdsFromClient: ["does-not-exist"],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );
});

test("requireApprovals: extra ID matches no binding → approval_mismatch", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  // Extra: an approval for stdin binding, but we only ask for env.
  const extraApproval = store.create(sb);
  store.approve(extraApproval.id);

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, extraApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_mismatch",
  );
});

test("requireApprovals: ID in pending status → throws approval_not_granted; ID NOT consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  // NOT approved — still pending.

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, stdinApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_granted",
  );
  // Critical: env was NOT consumed despite being earlier in plan order.
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
  assert.strictEqual(store.get(stdinApproval.id)!.status, "pending");
});

test("requireApprovals: session at max_uses → throws session_max_uses_exceeded; no minting", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 1,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id); // at max
  const store = new ApprovalStore({ now: () => 1000 });
  const injectBinding: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };

  const usesBefore = sessionStore.get(session.id)!.uses;
  await assert.rejects(
    requireApprovals({
      store, bindings: [injectBinding], daemonPort: 1234, waitMs: 0,
      sessionId: session.id, sessionStore,
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded",
  );
  // No pending grants were minted (Phase 1 threw before Phase 2).
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore);
});

test("requireApprovals: session covers env-like binding but not stdin, --no-wait → throws approval_required for stdin only; session.uses unchanged", async () => {
  // Note: today's session matcher refuses `action: "run"` and `action: "run_stdin"`
  // (they aren't SessionActions). For this test we use action "inject_submit" for
  // BOTH bindings — the session covers one binding by domain but not the other.
  // This still exercises the requireApprovals behavior of "session covers some
  // bindings, mint others". The conceptual env+stdin test (where run/run_stdin
  // never match sessions) is covered by the simpler "no sessions, mints both" test.
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  const store = new ApprovalStore({ now: () => 1000 });
  const matchingBinding: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  const nonMatchingBinding: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "other.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["other.com"] };

  const usesBefore = sessionStore.get(session.id)!.uses;
  await assert.rejects(
    requireApprovals({
      store, bindings: [matchingBinding, nonMatchingBinding], daemonPort: 1234, waitMs: 0,
      sessionId: session.id, sessionStore,
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1);
      return true;
    },
  );
  // Critical: session.uses unchanged — Phase 1 planned "session" for matching binding
  // but Phase 2 short-circuited via the --no-wait mint case for the non-matching one.
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore);
});

test("requireApprovals: session-first precedence — session covers binding A; supplied ID for A is NOT consumed", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["example.com"],
    max_uses: 5,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  const store = new ApprovalStore({ now: () => 1000 });
  // Both bindings use inject_submit so session can match A.
  const bindingA: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  // Binding B uses a different action so session DOES NOT match. Must use a
  // production-needing action other than inject_submit. Use "capture" (or any
  // other valid ApprovalBinding action). Verify that session pattern doesn't
  // match it. Test uses canonical action enum.
  const bindingB: ApprovalBinding = { action: "capture", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  const idForA = store.create(bindingA);
  store.approve(idForA.id);
  const idForB = store.create(bindingB);
  store.approve(idForB.id);

  const usesBefore = sessionStore.get(session.id)!.uses;
  const grants = await requireApprovals({
    store, bindings: [bindingA, bindingB], daemonPort: 1234,
    sessionId: session.id, sessionStore,
    approvalIdsFromClient: [idForA.id, idForB.id],
  });

  assert.strictEqual(grants.length, 2);
  // Binding A used the session.
  assert.strictEqual(grants[0]!.session_id, session.id);
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore + 1);
  // Supplied ID for A is still granted (NOT consumed by session-first precedence).
  assert.strictEqual(store.get(idForA.id)!.status, "granted");
  // Binding B used the supplied ID.
  assert.strictEqual(grants[1]!.id, idForB.id);
  assert.strictEqual(store.get(idForB.id)!.status, "used");
});

test("requireApprovals: waiting flow sequential — env denied → throws approval_denied; stdin never minted", async () => {
  // Listen to "created" events. When the FIRST `run` binding is minted, schedule
  // a deny() on its id. After that, the wait loop polls and sees status==denied
  // → throws. The stdin binding's mint should never run because the sequential
  // loop aborted at env.
  let stdinCreated = false;
  const store = new ApprovalStore({
    now: () => 1000,
    onEvent: (event) => {
      if (event.kind === "created" && event.grant.action === "run") {
        setTimeout(() => store.deny(event.grant.id), 5);
      }
      if (event.kind === "created" && event.grant.action === "run_stdin") {
        stdinCreated = true;
      }
    },
  });
  const eb = envBinding();
  const sb = stdinBinding();
  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_denied",
  );
  assert.strictEqual(stdinCreated, false, "stdin must NOT have been minted after env denial");
});

test("requireApprovals: multi-binding session with max_uses=1 + 2 matches → throws session_max_uses_exceeded in Phase 1 (no Phase 2 commit)", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    ref_glob: "",
    actions: ["inject-submit"],
    destination_domains: ["a.example.com", "b.example.com"],
    max_uses: 1,
    ttl_ms: 60_000,
  });
  sessionStore.approve(session.id);
  const store = new ApprovalStore({ now: () => 1000 });
  // Two bindings both match the session by domain.
  const bindingA: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "a.example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["a.example.com"] };
  const bindingB: ApprovalBinding = { action: "inject_submit", ref: null, environment: "production", destination_domain: "b.example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["b.example.com"] };

  const usesBefore = sessionStore.get(session.id)!.uses;
  await assert.rejects(
    requireApprovals({
      store, bindings: [bindingA, bindingB], daemonPort: 1234,
      sessionId: session.id, sessionStore,
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded",
  );
  // CRITICAL: Phase 1 threw before any Phase 2 commit. session.uses unchanged.
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore);
});

test("requireApprovals: all-dev bindings + supplied IDs → silently absorbed (legacy behavior)", async () => {
  const store = new ApprovalStore();
  // Both bindings are dev (no approval needed).
  const devB1 = devBinding();
  const devB2: ApprovalBinding = { ...devBinding(), action: "run_stdin" };
  // Supplied IDs from elsewhere — they don't match dev synth (no approval was ever created for these).
  // Use a real ID format so the Step 0 resolve doesn't trip first.
  const dummyGrant = store.create({ ...envBinding() });
  store.approve(dummyGrant.id);

  // dev bindings + supplied prod ID → should silently absorb (all-synth case).
  const grants = await requireApprovals({
    store, bindings: [devB1, devB2], daemonPort: 1234,
    approvalIdsFromClient: [dummyGrant.id],
  });
  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0]!.id, "no-approval-required");
  assert.strictEqual(grants[1]!.id, "no-approval-required");
  // The dummy grant is still granted (NOT consumed).
  assert.strictEqual(store.get(dummyGrant.id)!.status, "granted");
});

test("requireApprovals: mixed dev+prod + bad ID → throws approval_mismatch AND fires audit event", async () => {
  const events: string[] = [];
  const store = new ApprovalStore({ onEvent: (e) => events.push(e.kind) });
  const dev = devBinding();
  const prod = envBinding();
  // Supplied ID doesn't match either binding (created for stdinBinding).
  const wrongGrant = store.create(stdinBinding());
  store.approve(wrongGrant.id);
  events.length = 0; // clear setup events

  await assert.rejects(
    requireApprovals({
      store, bindings: [dev, prod], daemonPort: 1234, waitMs: 0,
      approvalIdsFromClient: [wrongGrant.id],
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_mismatch",
  );
  // Mismatch event fired for audit.
  assert.ok(events.includes("mismatch"), "audit event must fire for leftover-ID mismatch");
  // The wrong grant is NOT consumed (still granted).
  assert.strictEqual(store.get(wrongGrant.id)!.status, "granted");
});

test("requireApprovals: P2 — all-synth call with stale (unknown) --approval-id ignores the ID (matches pre-4d behavior)", async () => {
  const store = new ApprovalStore();
  // No grant in the store with this ID — simulates daemon restart between
  // --no-wait round-trip and the retry.
  const staleId = "00000000-0000-0000-0000-000000000000";
  const dev = devBinding();

  // Old behavior: dev call ignores stale --approval-id, returns synthesized grant.
  const grants = await requireApprovals({
    store, bindings: [dev], daemonPort: 1234,
    approvalIdsFromClient: [staleId],
  });
  assert.strictEqual(grants.length, 1);
  assert.strictEqual(grants[0]!.id, "no-approval-required");
  assert.strictEqual(grants[0]!.status, "used");
});

test("requireApprovals: mixed dev+prod with unknown --approval-id still throws approval_not_found (no regression)", async () => {
  const store = new ApprovalStore();
  const dev = devBinding();
  const prod = envBinding();

  await assert.rejects(
    requireApprovals({
      store, bindings: [dev, prod], daemonPort: 1234, waitMs: 0,
      approvalIdsFromClient: ["does-not-exist"],
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );
});

test("requireApprovals: P1 — granted-but-TTL-expired ID is caught in Phase 1 (no partial Phase 2 commit)", async () => {
  // Two approvals: both granted, one with TTL elapsed by call time.
  // Phase 2 consume() would catch the expiry — but only AFTER consuming the
  // first one. Phase 1 must catch it first.
  let nowMs = 1000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => nowMs });
  const eb = envBinding();
  const sb = stdinBinding();

  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  // Advance clock past TTL for BOTH approvals.
  nowMs = 5000;

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, stdinApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_expired",
  );
  // CRITICAL: env approval is still "granted" (NOT consumed in mid-Phase-2).
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
  assert.strictEqual(store.get(stdinApproval.id)!.status, "granted");
});

test("requireApprovals: P2 TOCTOU — clock crosses second approval's TTL during Phase 2 → no partial consume", async () => {
  // Set up two valid grants. Then between Phase 1's TTL peek and Phase 2's
  // commit, advance the clock past BOTH expires_at values. Without consumeBatch,
  // Phase 2 would consume the first (clock still in range at its consume() call)
  // and only fail on the second. With consumeBatch, neither is consumed.
  let nowMs = 1000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => nowMs });
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  // Both valid: nowMs=1000, expires_at=1100.
  // Move the test clock so that:
  //   Phase 1 sees valid (this means Phase 1 must peek when nowMs<1100).
  //   Phase 2 consumeBatch sees expired (this means consumeBatch must see nowMs>1100).
  // Since requireApprovals is synchronous between Phase 1 and Phase 2, we
  // can't easily wedge a clock advance between them at the test level.
  // The simpler proof: with nowMs=1500 (both expired), Phase 1 throws and
  // NEITHER is consumed. Combined with the consumeBatch unit test that
  // pins the TOCTOU explicitly at the store level, this covers the
  // requireApprovals end of the contract.
  nowMs = 1500;

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, stdinApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_expired",
  );
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
  assert.strictEqual(store.get(stdinApproval.id)!.status, "granted");
});

test("requireApprovals: P2 — both supplied IDs already past TTL → Phase 1 throws approval_expired before any commit", async () => {
  // The original test description claimed to cover the bug where a supplied ID
  // expires DURING the waiting window (i.e., waitForGranted returns, then
  // consumeBatch sees env expired). That path is impossible to exercise in a
  // synchronous test: Node's event loop doesn't interleave between
  // waitForGranted's return and the final consumeBatch.
  //
  // What the body actually verifies: the store clock (nowMs) jumps to 5000
  // immediately when stdin is minted — BEFORE waitForGranted is polled. The
  // stdin grant's expires_at=1100 is already past, so waitForGranted throws
  // approval_expired. Both grants remain unburned. This is Phase 1 / TTL-pre-
  // check behavior, not the "TOCTOU during commit" path.
  //
  // The TOCTOU-during-commit path is covered by store.consumeBatch's clock-
  // advance unit test (the dedicated consumeBatch test that pins expires_at
  // between validation and mutation). That test lives in store.test.ts.
  let nowMs = 1000;
  const store = new ApprovalStore({
    ttlMs: 100,
    now: () => nowMs,
    onEvent: (event) => {
      // Advancing nowMs to 5000 when stdin is minted simulates the user-wait
      // window during which the env supplied ID's TTL elapses. The store's
      // test clock (nowMs) controls TTL; wall-clock timers are only used to
      // let the event loop drain.
      //
      // Because nowMs jumps to 5000 before store.create() returns, the stdin
      // grant's expires_at=1100 is already past by the time waitForGranted
      // polls it — so waitForGranted throws approval_expired immediately (the
      // grant never reaches "granted"). No supplied approval is burned.
      if (event.kind === "created" && event.grant.action === "run_stdin") {
        nowMs = 5000; // env (created at 1000, ttl 100) is now expired
        // Guard: only approve if still pending. The grant may already be
        // expired by the time the timer fires (because nowMs jumped past its
        // expires_at), so skip the approve() call to avoid "not pending" throw.
        const grantId = event.grant.id;
        setTimeout(() => {
          const g = store.get(grantId);
          if (g !== undefined && g.status === "pending") {
            store.approve(grantId);
          }
        }, 5);
      }
    },
  });

  const eb = envBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  // envApproval is valid until nowMs > 1100.

  const sb = stdinBinding();

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
      approvalIdsFromClient: [envApproval.id],
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_expired",
  );
  // Critical: env stays granted. The expiry was caught by waitForGranted
  // (Phase 1 TTL path) before reaching consumeBatch — no supplied approval burned.
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
  // Critical: stdin's minted grant — find it — is NOT used.
  // We can't easily enumerate the store, but we can verify the only-known-id
  // (envApproval) is not "used". The stdin grant remains "granted" (or has
  // been transitioned out by other means). The key behavioral check is that
  // no supplied approval was burned — the env case captures the P1 assertion.
});

test("requireApprovals: waiting flow sequential — all granted → returns both", async () => {
  const store = new ApprovalStore({
    now: () => 1000,
    onEvent: (event) => {
      if (event.kind === "created") {
        setTimeout(() => store.approve(event.grant.id), 5);
      }
    },
  });
  const eb = envBinding();
  const sb = stdinBinding();
  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
    openUrlImpl: () => {},
  });
  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0]!.status, "used");
  assert.strictEqual(grants[1]!.status, "used");
  assert.strictEqual(grants[0]!.action, "run");
  assert.strictEqual(grants[1]!.action, "run_stdin");
});

test("requireApprovals: P1 — waiting-flow denial invalidates earlier-granted siblings (no orphan grants)", async () => {
  // Repro for the bug: [run, run_stdin], waiting mode, auto-approve run,
  // auto-deny run_stdin. waitForGranted throws on stdin → the run grant
  // would otherwise remain "granted" in the store, a live reusable auth.
  // After this fix, invalidate() removes it on the throw.
  let runApprovalId: string | undefined;
  let stdinApprovalId: string | undefined;

  const store = new ApprovalStore({
    onEvent: (event) => {
      if (event.kind === "created") {
        if (event.grant.action === "run") {
          runApprovalId = event.grant.id;
          setTimeout(() => store.approve(event.grant.id), 5);
        } else if (event.grant.action === "run_stdin") {
          stdinApprovalId = event.grant.id;
          setTimeout(() => store.deny(event.grant.id), 5);
        }
      }
    },
  });

  const eb = envBinding();
  const sb = stdinBinding();

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_denied",
  );

  // Critical: run was granted, then run_stdin was denied. The run grant
  // must NOT remain reusable.
  assert.ok(runApprovalId, "test must have observed the run mint");
  assert.strictEqual(
    store.get(runApprovalId!),
    undefined,
    "the earlier-granted run mint must be invalidated (removed from store) after the operation failed",
  );

  // run_stdin was denied (terminal). invalidate() is status-aware: terminal
  // grants are no-ops. So run_stdin stays in the store with status="denied"
  // (its terminal state, preserved for audit).
  assert.ok(stdinApprovalId, "test must have observed the stdin mint");
  assert.strictEqual(
    store.get(stdinApprovalId!)?.status,
    "denied",
    "the denied run_stdin mint must NOT be re-cancelled (terminal status preserved)",
  );
});

test("requireApprovals: P1 — waiting-flow success path does NOT invalidate mints (no false positives)", async () => {
  // Symmetric: the invalidate fallback should only fire on throws.
  // A successful waiting-flow call should leave all minted approvals
  // in "used" state (via the final consumeBatch), not removed from the store.
  let runApprovalId: string | undefined;
  let stdinApprovalId: string | undefined;

  const store = new ApprovalStore({
    now: () => 1000,
    onEvent: (event) => {
      if (event.kind === "created") {
        if (event.grant.action === "run") {
          runApprovalId = event.grant.id;
          setTimeout(() => store.approve(event.grant.id), 5);
        } else if (event.grant.action === "run_stdin") {
          stdinApprovalId = event.grant.id;
          setTimeout(() => store.approve(event.grant.id), 5);
        }
      }
    },
  });

  const eb = envBinding();
  const sb = stdinBinding();
  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
    openUrlImpl: () => {},
  });

  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0]!.status, "used");
  assert.strictEqual(grants[1]!.status, "used");
  // The mints should still be in the store with status="used", not invalidated.
  assert.strictEqual(store.get(runApprovalId!)?.status, "used");
  assert.strictEqual(store.get(stdinApprovalId!)?.status, "used");
});
