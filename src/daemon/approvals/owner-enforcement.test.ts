import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { SessionStore } from "./session-store.js";
import { requireApprovals } from "./require-approvals.js";
import { withAuthContext } from "../auth/auth-context.js";
import { ShuttleError } from "../../shared/errors.js";
import type { SessionPattern } from "./session.js";

const binding: ApprovalBinding = {
  action: "generate", ref: null, planned_ref: "ss://local/prod/X", environment: "production",
  destination_domain: null, target_id: null, field_fingerprint: null,
  template_id: null, template_params: null, allowed_domains: ["example.com"],
};

function mintAs(store: ApprovalStore, owner: string, b = binding): string {
  let id = "";
  withAuthContext({ agent_id: owner, isRoot: owner === "root" }, () => {
    id = store.create(b).id;
  });
  // Grants minted in tests are pending; "approve" via the store's approve method.
  store.approve(id);  // <-- use the existing approve(id) method
  return id;
}

test("Stage 0 (supplied-ID lookup): non-root cross-owner returns approval_not_found", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, async () => {
    await assert.rejects(
      () => requireApprovals({
        store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
        openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
      }),
      (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
    );
  });
});

test("Stage final consume: non-root cross-owner still returns approval_not_found (defensive)", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, async () => {
    await assert.rejects(
      () => requireApprovals({
        store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
        openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
      }),
      (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
    );
  });
});

test("Root bypasses owner check: can consume any grant", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "root", isRoot: true }, async () => {
    const grants = await requireApprovals({
      store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
      openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
    });
    assert.equal(grants.length, 1);
  });
});

test("Same-owner consume succeeds", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () => {
    const grants = await requireApprovals({
      store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
      openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
    });
    assert.equal(grants.length, 1);
  });
});

test("Session leftover: cross-owner supplied session_id → session_not_found (no fall-through to mint)", async () => {
  // Mint a session as claude-abc, then try to use it as cursor-xyz.
  // Must throw session_not_found — NOT fall through to mint a new approval
  // (which would leak existence by emitting approval_required).
  const store = new ApprovalStore();
  const sessionStore = new SessionStore();
  // Pattern matching the `binding` above: action=generate → secrets-set
  // session action; planned_ref "ss://local/prod/X" matches ref_glob
  // "ss://local/prod/*"; allowed_domains ["example.com"] must be ⊆
  // pattern.destination_domains.
  const pattern: SessionPattern = {
    actions: ["secrets-set"],
    ref_glob: "ss://local/prod/*",
    destination_domains: ["example.com"],
    allowed_actions: ["inject_into_field", "inject_submit"],
    ttl_ms: 5 * 60 * 1000,
  };
  // The binding lacks `allowed_actions`, so secretsSetMatches would refuse.
  // Add the same scope to the binding so the pattern would match
  // ABSENT the ownership check. This is the critical setup: without
  // owner enforcement, this session WOULD match and silently take effect.
  const sessionBinding: ApprovalBinding = {
    ...binding,
    allowed_actions: ["inject_into_field"],
  };

  let sessionId = "";
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    sessionId = sessionStore.create(pattern).id;
  });
  sessionStore.approve(sessionId);

  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, async () => {
    await assert.rejects(
      () => requireApprovals({
        store, bindings: [sessionBinding], daemonPort: 0, sessionStore,
        openUrlImpl: async () => {}, sessionId, waitMs: 0,
      }),
      (e: unknown) => e instanceof ShuttleError && e.code === "session_not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// Direct store-level guard tests (bypass requireApprovals entirely).
//
// The tests above all enter requireApprovals via the supplied-ID path, which
// throws at Step 0 (Stage 0 lookup). That means the duplicated guards inside
// ApprovalStore.consume / consumeBatch / validateConsumeBatch never run in
// those tests. The tests below exercise each store method DIRECTLY to prove
// the in-store guards work in isolation: cross-owner non-root must throw
// approval_not_found; same-owner and root callers must succeed.
// ---------------------------------------------------------------------------

test("ApprovalStore.consume: cross-owner throws approval_not_found; same-owner & root succeed", () => {
  const store = new ApprovalStore();
  let idCross = "";
  let idSame = "";
  let idRoot = "";
  withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    idCross = store.create(binding).id;
    idSame = store.create(binding).id;
    idRoot = store.create(binding).id;
  });
  store.approve(idCross);
  store.approve(idSame);
  store.approve(idRoot);

  // Cross-owner non-root: must throw approval_not_found (existence non-disclosure).
  assert.throws(
    () => store.consume(idCross, binding, "cursor-xyz"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );

  // Same-owner: succeeds.
  const gSame = store.consume(idSame, binding, "claude-abc");
  assert.equal(gSame.status, "used");

  // Root bypass: succeeds.
  const gRoot = store.consume(idRoot, binding, "root");
  assert.equal(gRoot.status, "used");
});

test("ApprovalStore.consumeBatch: cross-owner throws approval_not_found; same-owner & root succeed", () => {
  const store = new ApprovalStore();
  let idCross = "";
  let idSame = "";
  let idRoot = "";
  withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    idCross = store.create(binding).id;
    idSame = store.create(binding).id;
    idRoot = store.create(binding).id;
  });
  store.approve(idCross);
  store.approve(idSame);
  store.approve(idRoot);

  // Cross-owner non-root: must throw approval_not_found, with no mutations
  // (atomic batch).
  assert.throws(
    () => store.consumeBatch([{ id: idCross, binding }], "cursor-xyz"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );
  // Confirm idCross is still granted (batch did not mutate on failure).
  assert.equal(store.get(idCross)?.status, "granted");

  // Same-owner: succeeds.
  const sameResults = store.consumeBatch([{ id: idSame, binding }], "claude-abc");
  assert.equal(sameResults.length, 1);
  assert.equal(sameResults[0]!.status, "used");

  // Root bypass: succeeds.
  const rootResults = store.consumeBatch([{ id: idRoot, binding }], "root");
  assert.equal(rootResults.length, 1);
  assert.equal(rootResults[0]!.status, "used");
});

test("ApprovalStore.validateConsumeBatch: cross-owner throws approval_not_found; same-owner & root succeed", () => {
  const store = new ApprovalStore();
  let idCross = "";
  let idSame = "";
  let idRoot = "";
  withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    idCross = store.create(binding).id;
    idSame = store.create(binding).id;
    idRoot = store.create(binding).id;
  });
  store.approve(idCross);
  store.approve(idSame);
  store.approve(idRoot);

  // Cross-owner non-root: must throw approval_not_found.
  assert.throws(
    () => store.validateConsumeBatch([{ id: idCross, binding }], "cursor-xyz"),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );

  // validateConsumeBatch is a pure precheck — no mutations even on success.
  // Confirm idCross is still granted (it would be regardless, but assert
  // explicitly for clarity).
  assert.equal(store.get(idCross)?.status, "granted");

  // Same-owner: must NOT throw, must NOT mutate.
  store.validateConsumeBatch([{ id: idSame, binding }], "claude-abc");
  assert.equal(store.get(idSame)?.status, "granted");

  // Root bypass: must NOT throw, must NOT mutate.
  store.validateConsumeBatch([{ id: idRoot, binding }], "root");
  assert.equal(store.get(idRoot)?.status, "granted");
});
