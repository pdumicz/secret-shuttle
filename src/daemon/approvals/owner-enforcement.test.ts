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
