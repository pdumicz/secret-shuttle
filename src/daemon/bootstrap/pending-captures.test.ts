// src/daemon/bootstrap/pending-captures.test.ts
//
// Covers the token→Promise registry for bootstrap captures.
// Properties exercised:
//   - register() is synchronous and returns the Promise the executor awaits.
//   - lookup(token) reflects the latest registration.
//   - Per-step timeout fires the registered Promise's reject AND the
//     onTimeout side-channel callback.
//   - resolveByToken / rejectByToken settle the Promise exactly once and
//     return false on stale/unknown tokens.
//   - Re-register for the same (batchId, secretName) rejects the prior
//     Promise with bootstrap_capture_aborted and clears both indexes.
//   - owner_agent_id round-trips for audit.
import assert from "node:assert/strict";
import test from "node:test";
import { PendingCapturesRegistry } from "./pending-captures.js";
import { ShuttleError } from "../../shared/errors.js";

function baseOpts(overrides: Partial<{
  batchId: string;
  secretName: string;
  capture_token: string;
  target_id: string;
  expected_host: string;
  owner_agent_id: string;
  timeoutMs: number;
  onTimeout: (err: Error) => void;
}> = {}) {
  return {
    batchId: "batch-1",
    secretName: "STRIPE_KEY",
    capture_token: "tok-aaa",
    target_id: "target-1",
    expected_host: "dashboard.stripe.com",
    owner_agent_id: "root",
    timeoutMs: 300_000,
    onTimeout: () => {},
    ...overrides,
  };
}

test("pending-captures: register stores entry; lookup by token returns it", () => {
  const reg = new PendingCapturesRegistry();
  // register() is synchronous — it returns the Promise, it does NOT await it.
  // We can therefore lookup the token immediately after the call returns.
  const before = Date.now();
  const p = reg.register(baseOpts({
    batchId: "b1",
    secretName: "API_KEY",
    capture_token: "tok-1",
    target_id: "tgt-1",
    expected_host: "example.com",
    owner_agent_id: "root.helper-1",
    timeoutMs: 1_000_000,
  }));
  // Silence unhandled-rejection: the Promise lives past test end here.
  p.catch(() => undefined);

  const entry = reg.lookup("tok-1");
  assert.ok(entry, "lookup must return the registered entry");
  assert.equal(entry.capture_token, "tok-1");
  assert.equal(entry.batchId, "b1");
  assert.equal(entry.secretName, "API_KEY");
  assert.equal(entry.target_id, "tgt-1");
  assert.equal(entry.expected_host, "example.com");
  assert.equal(entry.owner_agent_id, "root.helper-1");
  assert.ok(entry.started_at >= before, "started_at should be recent");
  assert.ok(typeof entry.resolve === "function");
  assert.ok(typeof entry.reject === "function");

  // Cleanup so the timer doesn't hold the test runner open.
  reg.rejectByToken("tok-1", new Error("test cleanup"));
});

test("pending-captures: timer fires reject(bootstrap_capture_timeout) AND onTimeout callback after timeoutMs", async () => {
  const t = test.mock.timers;
  t.enable({ apis: ["setTimeout"] });
  try {
    const reg = new PendingCapturesRegistry();
    const seen: { err: Error | null } = { err: null };
    const p = reg.register(baseOpts({
      capture_token: "tok-timeout",
      timeoutMs: 5_000,
      onTimeout: (err) => { seen.err = err; },
    }));

    // Advance past the deadline. The timer callback runs synchronously.
    t.tick(5_001);

    // Promise rejects with bootstrap_capture_timeout.
    await assert.rejects(
      p,
      (err: unknown) => {
        assert.ok(err instanceof ShuttleError);
        assert.equal((err as ShuttleError).code, "bootstrap_capture_timeout");
        return true;
      },
    );

    // onTimeout side-channel called with the same error code.
    assert.ok(seen.err, "onTimeout callback must have been invoked");
    assert.ok(seen.err instanceof ShuttleError);
    assert.equal((seen.err as ShuttleError).code, "bootstrap_capture_timeout");

    // Indexes cleared.
    assert.equal(reg.lookup("tok-timeout"), undefined);
  } finally {
    t.reset();
  }
});

test("pending-captures: resolveByToken resolves the Promise; second call is no-op (returns false)", async () => {
  const reg = new PendingCapturesRegistry();
  const p = reg.register(baseOpts({
    capture_token: "tok-resolve",
    timeoutMs: 1_000_000,
  }));

  const first = reg.resolveByToken("tok-resolve", {
    value: "sk_live_test",
    field_fingerprint: "fp-abc",
  });
  assert.equal(first, true, "first resolve returns true");

  const settled = await p;
  assert.deepEqual(settled, { value: "sk_live_test", field_fingerprint: "fp-abc" });

  // Token is gone after resolve.
  assert.equal(reg.lookup("tok-resolve"), undefined);

  // A second resolveByToken for the same token must be a no-op.
  const second = reg.resolveByToken("tok-resolve", { value: "x", field_fingerprint: "fp-x" });
  assert.equal(second, false, "second resolve returns false (no entry)");
});

test("pending-captures: rejectByToken rejects with the supplied error; lookup clears", async () => {
  const reg = new PendingCapturesRegistry();
  const p = reg.register(baseOpts({
    capture_token: "tok-reject",
    timeoutMs: 1_000_000,
  }));

  const customErr = new ShuttleError("bootstrap_capture_aborted", "test reject");
  const first = reg.rejectByToken("tok-reject", customErr);
  assert.equal(first, true);

  await assert.rejects(p, (err: unknown) => err === customErr);

  // Lookup returns undefined after reject.
  assert.equal(reg.lookup("tok-reject"), undefined);

  // Unknown token returns false.
  assert.equal(
    reg.rejectByToken("tok-reject", new Error("again")),
    false,
  );
});

test("pending-captures: re-register for same (batchId, secretName) rejects prior with bootstrap_capture_aborted", async () => {
  const reg = new PendingCapturesRegistry();

  const pA = reg.register(baseOpts({
    batchId: "batch-X",
    secretName: "STRIPE_KEY",
    capture_token: "tok-A",
  }));

  // Register a second time with the SAME step key but a different token.
  const pB = reg.register(baseOpts({
    batchId: "batch-X",
    secretName: "STRIPE_KEY",
    capture_token: "tok-B",
  }));

  // Prior promise (pA) must reject with bootstrap_capture_aborted.
  await assert.rejects(
    pA,
    (err: unknown) => {
      assert.ok(err instanceof ShuttleError);
      assert.equal((err as ShuttleError).code, "bootstrap_capture_aborted");
      return true;
    },
  );

  // tok-A is gone from the registry; tok-B is the active one.
  assert.equal(reg.lookup("tok-A"), undefined, "stale token must be invalidated");
  const live = reg.lookup("tok-B");
  assert.ok(live, "new token must be the live entry");
  assert.equal(live.capture_token, "tok-B");
  assert.equal(live.batchId, "batch-X");
  assert.equal(live.secretName, "STRIPE_KEY");

  // Resolve pB so the Promise doesn't dangle past test end.
  reg.resolveByToken("tok-B", { value: "v", field_fingerprint: "fp" });
  const settled = await pB;
  assert.deepEqual(settled, { value: "v", field_fingerprint: "fp" });
});

test("pending-captures: owner_agent_id is recorded and exposed on lookup for audit", () => {
  const reg = new PendingCapturesRegistry();
  const p = reg.register(baseOpts({
    batchId: "audit-batch",
    secretName: "DB_URL",
    capture_token: "tok-audit",
    owner_agent_id: "root.claude-7f2a",
    timeoutMs: 1_000_000,
  }));
  p.catch(() => undefined);

  const entry = reg.lookup("tok-audit");
  assert.ok(entry, "entry must exist");
  assert.equal(
    entry.owner_agent_id,
    "root.claude-7f2a",
    "owner_agent_id round-trips for audit on the C13 raw UI routes",
  );

  // Cleanup.
  reg.rejectByToken("tok-audit", new Error("test cleanup"));
});

test("pending-captures: resolveByToken on unknown token returns false without throwing", () => {
  const reg = new PendingCapturesRegistry();
  // No registrations. Must be a clean no-op.
  assert.equal(
    reg.resolveByToken("never-registered", { value: "x", field_fingerprint: "fp" }),
    false,
  );
});
