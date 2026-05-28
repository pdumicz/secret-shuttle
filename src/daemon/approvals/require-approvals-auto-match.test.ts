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
 *  3. Auto-matched session whose kept-capacity check fails (sibling planned-use
 *     accounting) is demoted to mint via the keptUsesById branch.
 *  4. Explicit --session for non-matching session falls through to mint in Phase 1
 *     (never reaches the resolver).
 *  5. Multi-entry capacity race (keptUsesById regression): 2 bindings share max_uses=2,
 *     1 consumed concurrently → exactly 1 demoted via the keptUsesById branch.
 *  6. Session-uses counter is tracked across N bindings in one call (max_uses=1
 *     with 2 bindings → only one plans session).
 *  7. Race that surfaces inside `canMatchSession` (session_max_uses_exceeded
 *     thrown synchronously by the resolver's pure peek) → demoted via the
 *     catch branch of resolveSessionRaces (P1 race-fix coverage).
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

test("auto-match race (keptUsesById branch): kept-capacity check sees concurrent burn → demoted to mint, no throw", async () => {
  // max_uses=1 session matches the binding. Auto-match plans it in Phase 1.
  // Before Phase 2 commit, simulate a concurrent caller consuming the slot
  // by intercepting the resolver's `sessionStore.get` call for the kept-
  // capacity check. resolveSessionRaces must observe the post-burn state
  // there and demote via the keptUsesById branch (NOT the catch branch —
  // canMatchSession had already returned `true` before the burn fired).
  // Under waitMs=0 the demoted binding surfaces as approval_required
  // (NOT session_max_uses_exceeded).
  //
  // Distinction vs the canMatchSession-throws test below: that one burns
  // BEFORE the resolver's canMatchSession call so the synchronous throw
  // is caught at the resolver's try/catch. This test burns AFTER
  // canMatchSession but BEFORE the kept-check `sessionStore.get`, hitting
  // the capacity-aware demotion branch instead.
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

  // Get-call sequence with one binding through requireApprovals:
  //   - Phase 1 auto-match uses sessionStore.list(), not get.
  //   - Resolver pass 1 (pre-Phase-2):
  //       get-1: inside canMatchSession (store.ts) — uses=0 here, returns true.
  //       get-2: inside resolver's kept-capacity check (require-approvals.ts).
  // Burn before get-2 returns so the kept-capacity check sees uses=1,
  // alreadyKept=0, 1+0+1=2 > max_uses=1 → demote via the keptUsesById branch.
  let getCallCount = 0;
  let hasBurned = false;
  const racedSessionStore: SessionStore = new Proxy(sessions, {
    get(target, prop) {
      if (prop === "get") {
        return (id: string) => {
          getCallCount += 1;
          if (getCallCount === 2 && !hasBurned) {
            hasBurned = true;
            // Concurrent caller: consume the last remaining use.
            target.incrementUses(sess.id);
          }
          return target.get(id);
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

  // Get-call sequence with two bindings through requireApprovals:
  //   - Phase 1 auto-match uses sessionStore.list() per binding (2 list calls).
  //   - Resolver pass 1 (pre-Phase-2), entry 0:
  //       get-1: canMatchSession (uses=0, returns true).
  //       get-2: kept-capacity check (uses=0, alreadyKept=0, 0+0+1=1 ≤ 2 → keep).
  //   - Resolver pass 1, entry 1:
  //       get-3: canMatchSession.
  //       get-4: kept-capacity check.
  // Burn before get-3 returns so entry 1's canMatchSession sees uses=1
  // (still 1 < 2, returns true), and entry 1's kept-check sees uses=1,
  // alreadyKept=1, 1+1+1=3 > 2 → demote via the keptUsesById branch.
  let getCallCount = 0;
  let hasBurned = false;
  const racedSessionStore: SessionStore = new Proxy(sessions, {
    get(target, prop) {
      if (prop === "get") {
        return (id: string) => {
          getCallCount += 1;
          if (getCallCount === 3 && !hasBurned) {
            hasBurned = true;
            target.incrementUses(sess.id);
          }
          return target.get(id);
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

test("auto-match race (in-try resolver, waiting flow): session burned during Case C's waitForGranted await → demoted and approval_required surfaces (NOT session_max_uses_exceeded)", async () => {
  // This exercises the P1 race-fix path: the in-try `resolveSessionRaces`
  // call inside the try block after Case C's `waitForGranted` await.
  // Without it, a concurrent caller consuming the auto-matched session
  // during the await would cause Phase 2's `mintFromSession` (Step 3) to
  // throw an opaque `session_max_uses_exceeded` to the user, violating
  // the auto-match contract ("silent demotion to fresh approval").
  //
  // Setup: 2 bindings, waitMs > 0 (waiting flow).
  //   - binding[0] (template-run): auto-matches session S (max_uses=1, uses=0).
  //   - binding[1] (inject): doesn't match S's pattern → planned as mint.
  // Phase 1 plans [session(S, auto:true), mint].
  // First resolver: S keeps (uses=0).
  // Case C: mints binding[1], surfaces to hub. While we await
  // status=granted, a concurrent caller burns S (uses=0→1).
  // Post-await, plans[1] becomes kind:"consume" with the new id.
  // In-try resolver: canMatchSession throws session_max_uses_exceeded for
  // S → demoted to kind:"mint". Demotion-count > 0 → mint fresh, throw
  // approval_required. The outer catch invalidates waitingFlowMintedIds
  // (the inject mint), so binding[1]'s granted-but-not-consumed mint is
  // not left as a reusable authorization.
  const sessions = new SessionStore({ now: () => 1_000_000 });

  // Build the inject binding by hand — different action, distinct pattern
  // from the session's actions:["template-run"], so binding[1] cannot
  // auto-match S and falls through to mint.
  const injectBinding: ApprovalBinding = {
    action: "inject",
    ref: "ss://stripe/prod/STRIPE_KEY",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
  };

  let injectApprovalId: string | undefined;
  const approvals = new ApprovalStore({
    now: () => 1_000_000,
    onEvent: (event) => {
      // Trigger when the Case C mint for the inject binding is created.
      // First, simulate a concurrent caller burning the auto-matched
      // session (this is the race we're testing). Then schedule the
      // approve so waitForGranted resolves.
      if (event.kind === "created" && event.grant.action === "inject") {
        injectApprovalId = event.grant.id;
        // Concurrent caller burns the session use BEFORE the wait
        // resolves. The in-try resolver runs AFTER the wait, so it
        // observes uses=1 against max_uses=1.
        sessions.incrementUses(sess.id);
        setTimeout(() => approvals.approve(event.grant.id), 5);
      }
    },
  });

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
          waitMs: 1000,
          openUrlImpl: () => {},
          bindings: [templateBinding(), injectBinding],
        }),
      ),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; action: string }> };
      // The DEMOTED binding (originally auto-matched template-run) must
      // appear in the fresh approvals list — that's the "silent demotion
      // to fresh approval" contract.
      return details.approvals.length === 1 && details.approvals[0]!.action === "template";
    },
  );

  // Catch-block invalidate: the Case C inject mint (already granted but
  // never committed via consumeBatch) must be removed from the store, so
  // it cannot be re-used as a live authorization.
  assert.ok(injectApprovalId, "test must have observed the inject mint");
  assert.strictEqual(
    approvals.get(injectApprovalId!),
    undefined,
    "the waiting-flow inject mint must be invalidated after the in-try resolver demoted the auto-matched session",
  );

  // Session uses: 1 from the concurrent burn only. The demoted entry
  // never made it to Step 3's mintFromSession.
  assert.equal(sessions.get(sess.id)!.uses, 1);
});

test("auto-match race (catch branch): resolveSessionRaces catches session_max_uses_exceeded thrown by canMatchSession and demotes auto entry", async () => {
  // Sibling test to test 3 (keptUsesById branch). Burns the session use
  // BEFORE the resolver's canMatchSession call so the synchronous throw
  // (store.ts:335 — `session.uses >= session.max_uses`) is caught by
  // resolveSessionRaces' try/catch and the entry is demoted. Without
  // this distinction, test 3 alone left the catch branch uncovered:
  // its proxy fired the burn AFTER canMatchSession had already returned
  // true, so only the keptUsesById branch ran.
  //
  // Mechanism: proxy sessionStore.get and fire the burn on the FIRST
  // get call (which is the get inside canMatchSession during the
  // resolver pass — Phase 1's auto-match candidate filter uses list(),
  // not get()). The burn happens BEFORE target.get returns, so the
  // session canMatchSession sees has uses=1, hitting the max_uses
  // throw inside store.ts. resolveSessionRaces' try/catch then catches
  // session_max_uses_exceeded (a RACE_DEMOTE_CODES member) and demotes.
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

  let getCallCount = 0;
  let hasBurned = false;
  const racedSessionStore: SessionStore = new Proxy(sessions, {
    get(target, prop) {
      if (prop === "get") {
        return (id: string) => {
          getCallCount += 1;
          if (getCallCount === 1 && !hasBurned) {
            hasBurned = true;
            // Concurrent caller burns the session BEFORE canMatchSession's
            // own get-and-check runs. canMatchSession then synchronously
            // throws session_max_uses_exceeded inside the resolver's try.
            target.incrementUses(sess.id);
          }
          return target.get(id);
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
      // Catch branch must demote to approval_required, NOT bubble
      // session_max_uses_exceeded to the caller.
      return e.code === "approval_required";
    },
  );

  // Session uses: 1 from the concurrent burn only. The auto-matched entry
  // was demoted before it could increment.
  assert.equal(sessions.get(sess.id)!.uses, 1);
});
