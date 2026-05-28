import { test } from "node:test";
import assert from "node:assert/strict";

import { ShuttleError } from "../../shared/errors.js";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { SessionStore } from "./session-store.js";
import { requireApprovals } from "./require-approvals.js";
import { withAuthContext } from "../auth/auth-context.js";

/**
 * Burst 5 §2b Task 2b.6 — daemon-side auto-application of matching owned sessions.
 *
 * Coverage:
 *  1. Happy path — owned active matching session silently satisfies a binding.
 *  2. Expired session is skipped during auto-match → mint.
 *  3. Auto-matched session whose uses exhaust between Phase 1 and Phase 2 is demoted to mint.
 *  4. Explicit --session for non-matching session falls through to mint in Phase 1
 *     (never reaches the resolver).
 *  5. Multi-entry capacity race (keptUsesById regression): 2 bindings share max_uses=2,
 *     1 consumed concurrently → exactly 1 demoted.
 *  6. Session-uses counter is tracked across N bindings in one call (max_uses=1
 *     with 2 bindings → only one plans session).
 */

function templateBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: "vercel-env-add",
    template_params: { name: "STRIPE_KEY", environment: "production" },
    allowed_domains: [],
    ...overrides,
  };
}

test("auto-match: active matching owned session silently satisfies a template-run binding (no sessionId, no approvalIds)", async () => {
  // Owner = "claude-abc". Create session via createForOwner so the test does
  // not depend on AuthContext propagating through requireApprovals.
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      required_params: { name: "STRIPE_KEY", environment: "production" },
      ttl_ms: 15 * 60 * 1000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  const grants = await withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () => {
    return requireApprovals({
      store: approvals,
      sessionStore: sessions,
      daemonPort: 0,
      openUrlImpl: () => {},
      bindings: [templateBinding()],
    });
  });

  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.session_id, sess.id);
  // Session use was consumed.
  assert.equal(sessions.get(sess.id)!.uses, 1);
});

test("auto-match: expired (TTL-elapsed) session is skipped, binding falls through to mint", async () => {
  let nowMs = 1_000_000;
  const sessions = new SessionStore({ now: () => nowMs });
  const approvals = new ApprovalStore({ now: () => nowMs });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);
  // Jump past TTL. Next list() will flip status to "expired".
  nowMs += 120_000;

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: sessions,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding()],
        }),
      ),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_required",
  );

  // Session itself was never consumed (auto-match filtered it out before planning).
  assert.equal(sessions.get(sess.id)!.uses, 0);
});

test("auto-match race: session uses exhausted between Phase 1 and Phase 2 → demoted to mint, no throw", async () => {
  // max_uses=1 session matches the binding. Auto-match plans it in Phase 1.
  // Before Phase 2 commit, simulate a concurrent caller consuming the slot
  // by calling mintFromSession directly. resolveSessionRaces must catch the
  // resulting session_max_uses_exceeded throw and demote the entry to
  // kind:"mint". Under waitMs=0 the demoted binding surfaces as
  // approval_required (NOT session_max_uses_exceeded).
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      max_uses: 1,
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  // Use a sentinel openUrl callback to seize the race window: it fires per
  // Phase-2 mint, but we need a BEFORE-Phase-2 hook. Instead, exhaust the
  // session BEFORE calling requireApprovals — Phase 1's auto-match candidate
  // filter discounts via plannedAutoSessionUsesById, but live uses already at
  // max means the candidate is filtered out and we never reach the race
  // branch. So we need a more surgical setup: plan-then-consume.
  //
  // Approach: use a custom session store that defers uses-exhaustion until
  // AFTER Phase 1. The cleanest path is to subclass `now` such that Phase 1
  // sees uses=0, then bump uses externally between Phase 1 and Phase 2.
  //
  // Since requireApprovals is a single async call with no observable seam
  // between Phase 1 and Phase 2, we exploit the openUrlImpl callback: under
  // --no-wait with mints needed, openUrl fires BEFORE the throw. But our
  // demoted entry IS the mint, so openUrl fires for it. That means by the
  // time openUrl fires, the resolver has already demoted — too late.
  //
  // Cleaner: wrap sessionStore.list (called by both auto-match candidate
  // filter AND resolveSessionRaces' capacity recheck). On the SECOND list()
  // call, mutate session uses to max. This simulates a concurrent caller
  // racing in between Phase 1 and Phase 2.
  let listCallCount = 0;
  const racedSessionStore: SessionStore = new Proxy(sessions, {
    get(target, prop) {
      if (prop === "list") {
        return () => {
          listCallCount += 1;
          if (listCallCount === 2) {
            // Concurrent caller: consume the last remaining use.
            target.incrementUses(sess.id);
          }
          return target.list();
        };
      }
      return Reflect.get(target, prop);
    },
  });

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: racedSessionStore,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding()],
        }),
      ),
    (e: unknown) => {
      if (!(e instanceof ShuttleError)) return false;
      // The race must demote to approval_required, NOT bubble session_max_uses_exceeded.
      return e.code === "approval_required";
    },
  );
});

test("explicit --session for non-matching session falls through to mint in Phase 1 (resolver never sees it)", async () => {
  // Session pattern targets a different template than the binding requests.
  // Phase 1's explicit-sessionId canMatchSession returns false → no
  // kind:"session" entry is pushed. Resolver is therefore a no-op for this
  // entry. Under --no-wait, the binding mints fresh and the call throws
  // approval_required (not session_*).
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      // Different template_id — won't match the binding's `vercel-env-add`.
      template_ids: ["fly-secrets-set"],
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: sessions,
          sessionId: sess.id,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding()],
        }),
      ),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_required",
  );

  // Session itself was never consumed.
  assert.equal(sessions.get(sess.id)!.uses, 0);
});

test("multi-entry capacity race: 2 bindings share max_uses=2 session, 1 consumed concurrently → exactly 1 demoted", async () => {
  // Regression guard for `keptUsesById`. N=2 bindings against max_uses=2
  // session. Phase 1 plans 2 session entries (both pass the discount filter
  // because 0 + 0 + 1 ≤ 2 and 0 + 1 + 1 ≤ 2). BEFORE Phase 2 (intercepted
  // via list() proxy on the second call), a concurrent caller burns 1 slot.
  // Resolver sees: canMatchSession passes for entry 1 (1 < 2) — keep, kept=1.
  // For entry 2: canMatchSession still passes (1 < 2), but
  // sess.uses(1) + alreadyKept(1) + 1 = 3 > max_uses(2) → demote entry 2.
  // Final outcome: 1 session-commit + 1 mint-needed → approval_required
  // with exactly 1 entry in details.approvals.
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      max_uses: 2,
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  let listCallCount = 0;
  const racedSessionStore: SessionStore = new Proxy(sessions, {
    get(target, prop) {
      if (prop === "list") {
        return () => {
          listCallCount += 1;
          // First two list() calls during Phase 1 (one per binding's auto-match
          // candidate filter). On the THIRD list() call (first resolver visit),
          // simulate the concurrent burn.
          if (listCallCount === 3) {
            target.incrementUses(sess.id);
          }
          return target.list();
        };
      }
      return Reflect.get(target, prop);
    },
  });

  // Both bindings identical pattern → both auto-match.
  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: racedSessionStore,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding(), templateBinding()],
        }),
      ),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; action: string }> };
      // Exactly 1 binding demoted to mint.
      return details.approvals.length === 1;
    },
  );

  // Session uses: 1 from the concurrent burn only. The kept session entry
  // is planned for commit but doesn't run because --no-wait short-circuits
  // on the demoted mint (same Phase 2 short-circuit as the test below).
  // What we ARE verifying here is the keptUsesById accounting in
  // resolveSessionRaces — which the details.approvals.length===1 assertion
  // above proves: 1 entry survived, 1 was demoted.
  assert.equal(sessions.get(sess.id)!.uses, 1);
});

test("session-uses counter tracked across N bindings in one call (max_uses=1, 2 bindings → 1 session, 1 mint)", async () => {
  // Phase 1's plannedAutoSessionUsesById Map prevents the second binding's
  // candidate filter from picking the same session whose only slot is
  // already claimed by binding[0]. Binding[1] falls through to mint.
  // No race, resolver is a no-op for the session entry.
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      max_uses: 1,
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: sessions,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding(), templateBinding()],
        }),
      ),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; action: string }> };
      // Exactly 1 binding requires fresh approval — the other was satisfied by session auto-match.
      return details.approvals.length === 1;
    },
  );

  // Critical: under --no-wait with mixed session + mint plans, Phase 2
  // short-circuits at the mint-and-throw path BEFORE committing the
  // session (matches the existing "session covers env-like but not stdin"
  // test in require-approvals.test.ts). The session is still PLANNED for
  // commit; it just doesn't increment here. The waiting-flow path would
  // commit it. We're verifying the Phase 1 planning logic (capacity
  // accounting) — which the details.approvals.length===1 assertion above
  // proves: binding[0] was planned as session (NOT in approvals[]), only
  // binding[1] minted.
  assert.equal(sessions.get(sess.id)!.uses, 0);
});

test("auto-match: root caller does NOT auto-match (would silently consume other agents' sessions)", async () => {
  // Defense-in-depth: callerAgentId === "root" guard. Even though the session
  // is owned by claude-abc, root bypasses owner filters at the store level —
  // letting auto-match run for root would let an admin token silently
  // consume the agent's slot. Guard refuses.
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      ttl_ms: 60_000,
    },
    "claude-abc",
  );
  sessions.approve(sess.id);

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "root", isRoot: true }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: sessions,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding()],
        }),
      ),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_required",
  );

  // Session untouched.
  assert.equal(sessions.get(sess.id)!.uses, 0);
});

test("auto-match: session owned by a different agent is NOT consumed (owner filter)", async () => {
  // Session belongs to claude-xyz. Caller is claude-abc. Without owner
  // filter, auto-match would silently use someone else's slot. Filter
  // refuses → binding falls through to mint.
  const sessions = new SessionStore({ now: () => 1_000_000 });
  const approvals = new ApprovalStore({ now: () => 1_000_000 });
  const sess = sessions.createForOwner(
    {
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      ttl_ms: 60_000,
    },
    "claude-xyz",
  );
  sessions.approve(sess.id);

  await assert.rejects(
    () =>
      withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () =>
        requireApprovals({
          store: approvals,
          sessionStore: sessions,
          daemonPort: 0,
          waitMs: 0,
          openUrlImpl: () => {},
          bindings: [templateBinding()],
        }),
      ),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_required",
  );

  assert.equal(sessions.get(sess.id)!.uses, 0);
});
