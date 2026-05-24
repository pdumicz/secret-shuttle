import { describe, test } from "node:test";
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
