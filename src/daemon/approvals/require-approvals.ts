import { ShuttleError } from "../../shared/errors.js";
import { getCurrentAgentId } from "../auth/auth-context.js";
import { openUrl } from "./open-url.js";
import { matchesSessionPattern } from "./session-matchers.js";
import {
  approvalBindingsMatch,
  type ApprovalBinding,
  type ApprovalGrant,
  type ApprovalStore,
} from "./store.js";
import type { SessionStore } from "./session-store.js";

export interface RequireApprovalsOptions {
  store: ApprovalStore;
  bindings: ApprovalBinding[];
  daemonPort: number;
  approvalIdsFromClient?: string[];
  waitMs?: number;
  force?: boolean;
  /** Hook so tests can disable the system-browser open. */
  openUrlImpl?: (url: string) => void;
  sessionId?: string;
  sessionStore?: SessionStore;
}

type Plan =
  | { kind: "synth"; binding: ApprovalBinding }
  | {
      kind: "session";
      binding: ApprovalBinding;
      sessionId: string;
      /**
       * true when this plan entry came from the daemon-side auto-match path
       * (Phase 1 step 2b — `planFromAutoMatchedSession`). false when the
       * caller explicitly supplied `--session <id>` and Phase 1's step-2
       * peek matched. The resolver (`resolveSessionRaces`) uses this flag
       * to decide whether a hard-failure session-pointer code (revoked /
       * unauthorized) demotes silently to a fresh mint (auto: true) or
       * rethrows so the user who named the session sees the original error
       * (auto: false).
       */
      auto: boolean;
    }
  | { kind: "consume"; binding: ApprovalBinding; id: string }
  | { kind: "mint"; binding: ApprovalBinding };

// Error codes that resolveSessionRaces translates into demotion (kind:"session" →
// kind:"mint") rather than rethrowing. session_max_uses_exceeded is the
// concurrent-consume race; session_expired is the TTL-elapsed twin. Both are
// runtime races: Phase 1's snapshot was valid; Phase 2 saw the world move.
const RACE_DEMOTE_CODES: ReadonlySet<string> = new Set([
  "session_max_uses_exceeded",
  "session_expired",
]);

// Error codes that indicate the session pointer itself became invalid (revoked,
// denied, or unknown) between Phase 1 and Phase 2. For auto-matched entries we
// still demote — auto-match picked the candidate blindly, so any failure should
// fall back to a fresh per-op approval. For explicit (--session) entries we
// rethrow: the user named that session and deserves to see the original error.
const EXPLICIT_HARD_FAIL_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_unauthorized",
]);

const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const POLL_MS = 200;

/**
 * Multi-binding approval gate. See plan-4d spec §2 for the two-phase contract.
 *
 * Phase 1 (pure): plan how each binding will be satisfied — synth (dev), session
 * fast-path peek, supplied-ID match, or mint. No side effects.
 *
 * Phase 2 (commit): execute the plans. Under --no-wait with mints needed, mint
 * just the missing ones and throw approval_required with all of them in
 * `details.approvals`. Supplied IDs are not consumed; sessions are not used.
 *
 * Under waiting flow with mints needed, sequential per-binding: mint, surface
 * to hub, wait for status=granted. The actual consume happens at the end in
 * a single atomic consumeBatch alongside supplied-ID consumes, so a slow user
 * approval on one binding cannot leave an earlier-waited mint consumed while
 * a supplied ID has since expired.
 *
 * Waiting-flow timeout semantics: `waitMs` is the PER-MINT deadline, not
 * the cumulative deadline. With N mint-bindings, the maximum wall-clock
 * wait is N × waitMs. This matches the semantics of the singular
 * requireApproval that this primitive replaces.
 */
export async function requireApprovals(
  opts: RequireApprovalsOptions,
): Promise<ApprovalGrant[]> {
  if (opts.bindings.length === 0) return [];

  // Capture caller identity ONCE for the whole call. Used at every stage
  // to verify owner_agent_id on grants and sessions. Root bypasses every
  // ownership check (admin). The synth-grant path uses getCurrentAgentId()
  // separately for stamping its owner.
  const callerAgentId = getCurrentAgentId();
  const isRoot = callerAgentId === "root";

  // Pre-scan: would every binding be planned as synth? (dev/non-force).
  // The old singular requireApproval returned synthesizeGrant for dev-env
  // without ever looking at approvalIdFromClient. Preserve that
  // back-compat: all-synth calls skip Step 0's ID resolution entirely, so a
  // stale --approval-id (e.g., daemon restart between --no-wait calls) is
  // silently ignored on dev calls instead of throwing approval_not_found.
  // The mixed dev+prod case still goes through Step 0 (a prod binding might
  // need the supplied ID, and an unknown ID supplied for a prod call is a
  // legitimate approval_not_found).
  const allSynth =
    opts.force !== true &&
    opts.bindings.every((b) => b.environment !== "production");
  if (allSynth) {
    return opts.bindings.map((b) => synthesizeGrant(b));
  }

  // Session ownership precheck — once per call, BEFORE per-binding session
  // peek loop. Non-root caller supplying a session_id owned by a different
  // agent must see session_not_found (NOT fall through to mint, which would
  // emit approval_required and leak existence of the session). Sessions
  // that don't exist hit the same code via canMatchSession's own
  // session_not_found path; we converge to a single error code.
  if (opts.sessionId !== undefined && opts.sessionStore !== undefined && !isRoot) {
    const sess = opts.sessionStore.get(opts.sessionId);
    if (sess !== undefined && sess.owner_agent_id !== callerAgentId) {
      throw new ShuttleError("session_not_found", `Unknown session id: ${opts.sessionId}`);
    }
  }

  // Phase 1 Step 0: resolve every supplied ID. Unknown IDs are approval_not_found.
  // Owner mismatch (non-root) returns the same code — existence-non-disclosure.
  const suppliedIds = [...(opts.approvalIdsFromClient ?? [])];
  for (const id of suppliedIds) {
    const peek = opts.store.get(id);
    if (peek === undefined) {
      throw new ShuttleError("approval_not_found", `Unknown approval id: ${id}`);
    }
    if (!isRoot && peek.owner_agent_id !== callerAgentId) {
      throw new ShuttleError("approval_not_found", `Unknown approval id: ${id}`);
    }
  }

  // Phase 1: per-binding plan.
  const unusedIds = new Set(suppliedIds);
  const plans: Plan[] = [];
  // Track how many session-fast-path mints we're planning for the current
  // sessionId. canMatchSession reads session.uses live but doesn't know about
  // sibling bindings we've already planned in this call. Without tracking,
  // Phase 1 could plan N session bindings against a max_uses=N-1 session, and
  // Phase 2 would fail mid-loop on the Nth mintFromSession — breaking the
  // two-phase invariant.
  let plannedSessionUses = 0;
  // Burst 5 §2b Task 2b.6: per-sessionId planned-use counter for the
  // auto-match path. Distinct from the scalar `plannedSessionUses` above
  // because auto-match can pick a different sessionId per binding within
  // the same call. Without this, two bindings could both auto-match the
  // same max_uses=1 session in Phase 1 and the second mintFromSession
  // in Phase 2 would throw.
  const plannedAutoSessionUsesById = new Map<string, number>();

  for (const binding of opts.bindings) {
    // 1. Synth path
    const needsApproval = opts.force === true || binding.environment === "production";
    if (!needsApproval) {
      plans.push({ kind: "synth", binding });
      continue;
    }

    // 2. Session peek
    if (opts.sessionId !== undefined && opts.sessionStore !== undefined) {
      if (opts.store.canMatchSession(opts.sessionId, binding, opts.sessionStore)) {
        // Additionally check that planning ONE MORE session use won't blow past max_uses.
        // canMatchSession reads session.uses live; plannedSessionUses tracks the sibling
        // bindings already planned as "session" in this Phase 1 walk.
        const session = opts.sessionStore.get(opts.sessionId)!;
        if (session.max_uses !== undefined && session.uses + plannedSessionUses + 1 > session.max_uses) {
          throw new ShuttleError(
            "session_max_uses_exceeded",
            `Session ${opts.sessionId} would exceed its max_uses cap of ${session.max_uses} (already at ${session.uses}, ${plannedSessionUses + 1} planned for this operation).`,
          );
        }
        plannedSessionUses += 1;
        // Session takes precedence. If the client also supplied an ID matching
        // this binding, silently discard it from unusedIds so it doesn't trigger
        // approval_mismatch — but do NOT consume it (status stays "granted").
        for (const id of unusedIds) {
          const peek = opts.store.get(id);
          if (peek !== undefined && approvalBindingsMatch(peek, binding)) {
            unusedIds.delete(id);
            break;
          }
        }
        plans.push({ kind: "session", binding, sessionId: opts.sessionId, auto: false });
        continue;
      }
      // canMatchSession contract: returns false on pattern no-match
      // (fall through to supplied-ID path); throws on hard-fail session
      // states (revoked / expired / denied / at-max-uses) which bubble
      // out of requireApprovals entirely.
    }

    // 2b. Auto-match owned active session (Burst 5 §2b Task 2b.6).
    // Only runs when the caller did NOT supply an explicit sessionId (the
    // explicit path is more specific and takes precedence). Excluded for:
    //   - "root" tokens — they bypass owner filtering; auto-matching would
    //     let an admin token silently consume agent-owned slots.
    //   - "daemon" — the no-ALS sentinel from getCurrentAgentId(). Also
    //     reserved at the agent-id assertion level (see agent-id.ts), so
    //     no real agent can present this id — but defense in depth: if a
    //     handler ever skipped withAuthContext, auto-match would silently
    //     attribute the call to the sentinel and could leak sessions.
    if (
      opts.sessionStore !== undefined &&
      opts.sessionId === undefined &&
      callerAgentId !== "root" &&
      callerAgentId !== "daemon"
    ) {
      const autoPlan = planFromAutoMatchedSession(
        binding,
        opts.sessionStore,
        callerAgentId,
        plannedAutoSessionUsesById,
      );
      if (autoPlan !== null) {
        // Session-first precedence mirror of the explicit path above: if the
        // client also supplied an ID matching this binding, silently drop it
        // from unusedIds so it doesn't trigger approval_mismatch in the
        // leftover-ID check. Do NOT consume it (status stays "granted").
        for (const id of unusedIds) {
          const peek = opts.store.get(id);
          if (peek !== undefined && approvalBindingsMatch(peek, binding)) {
            unusedIds.delete(id);
            break;
          }
        }
        plans.push(autoPlan);
        continue;
      }
    }

    // 3. Supplied-ID match
    // Defense-in-depth: Step 0 already gated ownership on every supplied ID,
    // but re-check here so a tainted leftover from a different agent (in
    // case Step 0 was ever relaxed) silently skips matching instead of
    // disclosing existence via approval_mismatch downstream.
    let matchedId: string | undefined;
    for (const id of unusedIds) {
      const peek = opts.store.get(id);
      if (peek === undefined) continue; // resolved in step 0
      if (!isRoot && peek.owner_agent_id !== callerAgentId) continue; // skip cross-owner
      if (approvalBindingsMatch(peek, binding)) {
        matchedId = id;
        break;
      }
    }
    if (matchedId !== undefined) {
      const peek = opts.store.get(matchedId)!;
      // Status checks BEFORE planning consume (prevents Phase 2 partial commit).
      if (peek.status === "used") {
        throw new ShuttleError("approval_already_used", "Approval was already used.");
      }
      if (peek.status === "denied") {
        throw new ShuttleError("approval_denied", "Approval was denied.");
      }
      if (peek.status === "expired") {
        throw new ShuttleError("approval_expired", "Approval expired.");
      }
      if (peek.status !== "granted") {
        // pending or anything else non-terminal: client supplied an unapproved id.
        throw new ShuttleError("approval_not_granted", "Approval not granted.");
      }
      // Phase 1 TTL check: ApprovalStore.get() only expires pending grants, not
      // granted ones. A granted-but-past-TTL grant would pass Phase 1 here, get
      // planned as consume, then fail mid-Phase 2 — burning any earlier consumes.
      // Catch the expiry here so Phase 1 short-circuits cleanly.
      if (opts.store.nowMs() > peek.expires_at) {
        throw new ShuttleError("approval_expired", "Approval expired.");
      }
      unusedIds.delete(matchedId);
      plans.push({ kind: "consume", binding, id: matchedId });
      continue;
    }

    // 4. Mint
    plans.push({ kind: "mint", binding });
  }

  // After loop: handle leftover unused IDs.
  if (unusedIds.size > 0) {
    // Legacy back-compat: if EVERY binding is synth (all dev/non-force), the
    // supplied IDs were never going to be consumed — the singular
    // requireApproval also ignored approvalIdFromClient on the synth path.
    // Silently absorb so CLIs that mechanically include --approval-id on
    // dev-env calls don't error. This is safe because there is no prod
    // binding that could have been the intended target.
    const allSynth = plans.every((p) => p.kind === "synth");
    if (allSynth) {
      // Done — drop the leftovers.
    } else {
      // Mixed (or all-prod). The leftover IDs were intended for SOME prod
      // binding that didn't claim them. Fire mismatch audit events, then throw.
      const representativeBinding = opts.bindings[0]!;
      for (const id of unusedIds) {
        opts.store.fireMismatch(id, representativeBinding);
      }
      throw new ShuttleError(
        "approval_mismatch",
        `Supplied approval id(s) did not match any required binding: ${[...unusedIds].join(", ")}`,
      );
    }
  }

  // Burst 5 §2b Task 2b.6: race resolution. Runs AFTER Phase 1 planning is
  // complete and BEFORE mintPlans is computed, so demoted entries flow into
  // the mint loop the same as originally-planned mints. After this call,
  // every remaining plans[i].kind === "session" entry is safely committable.
  if (opts.sessionStore !== undefined) {
    resolveSessionRaces(plans, opts.sessionStore, opts.store);
  }

  // Phase 2: commit.
  const mintPlans = plans.filter((p): p is Extract<Plan, { kind: "mint" }> => p.kind === "mint");
  const open = opts.openUrlImpl ?? openUrl;

  // Case B: --no-wait + mints needed → atomic mint, throw with all approvals.
  if (mintPlans.length > 0 && opts.waitMs === 0) {
    const pending: Array<{ approval_id: string; expires_at: number; action: string }> = [];
    for (const p of mintPlans) {
      const g = opts.store.create(p.binding);
      const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
      open(url);
      pending.push({ approval_id: g.id, expires_at: g.expires_at, action: p.binding.action });
    }
    // Legacy message field: pin to first approval for backward-compat parsers.
    const first = pending[0];
    if (first === undefined) {
      throw new ShuttleError("unexpected_error", "pending array empty despite mintPlans.length > 0");
    }
    const legacyPayload = JSON.stringify({
      approval_id: first.approval_id,
      expires_at: first.expires_at,
    });
    throw new ShuttleError(
      "approval_required",
      legacyPayload,
      { details: { approvals: pending } },
    );
  }

  // Track waiting-flow mints so we can invalidate them if anything fails
  // before the final consumeBatch. Without this, a partially-approved waiting
  // flow (e.g., mint A approved, mint B denied) would leave A in "granted"
  // state — a live reusable authorization for an operation that just failed.
  // Case B (--no-wait) mints are intentionally NOT tracked here — the client
  // needs them to approve in the hub and retry.
  const waitingFlowMintedIds: string[] = [];
  try {
    // Case C: waiting flow + mints needed. Per-binding sequence:
    //   1. store.create — mint a pending approval.
    //   2. openUrlImpl — surface to the hub.
    //   3. waitForGranted — poll until status=granted (no consume).
    //   4. Convert plan to "consume" with the new id. The actual consume
    //      happens later in the final atomic batch alongside supplied-ID
    //      consumes, so a slow user wait on one binding can't leave a
    //      previously-waited mint consumed while a supplied ID has
    //      since expired.
    if (mintPlans.length > 0) {
      const waitBudget = opts.waitMs ?? DEFAULT_WAIT_MS;
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        if (p === undefined || p.kind !== "mint") continue;
        const g = opts.store.create(p.binding);
        waitingFlowMintedIds.push(g.id);
        const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
        open(url);
        await waitForGranted(opts.store, g.id, waitBudget);
        plans[i] = { kind: "consume", binding: p.binding, id: g.id };
      }
    }

    // Final commit ordering — closes both the Phase 2 internal TOCTOU window
    // (consumes burning before later commits fail) AND the session+consume
    // partial-commit race:
    //   1. Validate ALL consume preconditions (no mutation). Captures one
    //      timestamp shared with the eventual consumeBatch — within a single
    //      sync execution, both calls see the same this.now().
    //   2. Re-peek every session via canMatchSession (no mutation). This is
    //      pure; throws bubble out and bypass any commits.
    //   3. Commit sessions sequentially via mintFromSession (each call bumps
    //      incrementUses). If a concurrent request burned a use between
    //      Phase 1 and now, mintFromSession throws — but NO consume has been
    //      committed yet, so no supplied approval is burned. Worst-case
    //      partial commit at this point is "first N sessions bumped, session
    //      N+1 racing throws" — bounded blast radius, no permanently-used approvals.
    //   4. Commit consumes atomically via consumeBatch. Cannot fail (step 1
    //      already validated against the same sync timestamp).

    // Burst 5 §2b Task 2b.6 race-fix (P1 from code review): re-run the
    // resolver INSIDE the try block to catch races that opened during
    // Case C's `waitForGranted` awaits. The earlier resolver call (just
    // before Phase 2) covers the Phase 1 → planning boundary, but Case C
    // yields the event loop on every mint-and-wait — a concurrent
    // requireApprovals call can consume an auto-matched session in that
    // window. Without this second pass, the affected entry would surface
    // as an opaque `session_max_uses_exceeded` from Step 3's
    // `mintFromSession`, violating the auto-match contract ("silent
    // demotion to fresh approval"). By re-running here, any newly-raced
    // session entry is demoted to kind:"mint"; we then surface those as
    // `approval_required` (matching Case B's --no-wait shape) and let
    // the outer catch invalidate the Case C waiting-flow mints.
    //
    // Edge case — Case C had no mints: `waitingFlowMintedIds` is empty,
    // no awaits happened, and the second resolver call is a redundant
    // (but safe) no-op over the same set of session entries. The
    // demotion branch below is only reachable when Case C actually
    // yielded the event loop.
    if (opts.sessionStore !== undefined) {
      const sessionEntriesBefore = plans.filter((p) => p.kind === "session").length;
      resolveSessionRaces(plans, opts.sessionStore, opts.store);
      const sessionEntriesAfter = plans.filter((p) => p.kind === "session").length;
      if (sessionEntriesAfter < sessionEntriesBefore) {
        // At least one auto-matched session demoted to a fresh mint after
        // Case C's await. By this point ALL original mints have been
        // converted to kind:"consume" (line 357 in Case C), so any
        // kind:"mint" entries in plans are exclusively the freshly-demoted
        // ones. Mint pending approvals for them and throw
        // approval_required so the caller can re-prompt the user — same
        // shape as Case B (--no-wait). The outer catch (line ~441 below)
        // invalidates `waitingFlowMintedIds` so Case C's already-granted
        // mints don't leak as reusable authorizations.
        const freshMints = plans.filter(
          (p): p is Extract<Plan, { kind: "mint" }> => p.kind === "mint",
        );
        const pending: Array<{ approval_id: string; expires_at: number; action: string }> = [];
        for (const p of freshMints) {
          const g = opts.store.create(p.binding);
          const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
          open(url);
          pending.push({ approval_id: g.id, expires_at: g.expires_at, action: p.binding.action });
        }
        // Defensive: demotion count > 0 should imply freshMints.length > 0,
        // but build a safe error if that invariant is ever broken.
        const first = pending[0];
        if (first === undefined) {
          throw new ShuttleError(
            "unexpected_error",
            "session demotion observed but no fresh mints produced",
          );
        }
        const legacyPayload = JSON.stringify({
          approval_id: first.approval_id,
          expires_at: first.expires_at,
        });
        throw new ShuttleError("approval_required", legacyPayload, {
          details: { approvals: pending },
        });
      }
    }

    // Gather consume items (includes supplied-ID consumes AND waited mints
    // from Case C — both have plan.kind === "consume" by this point).
    const consumeItems: Array<{ id: string; binding: ApprovalBinding }> = [];
    for (const p of plans) {
      if (p.kind === "consume") {
        consumeItems.push({ id: p.id, binding: p.binding });
      }
    }

    // Step 1: validate consumes.
    opts.store.validateConsumeBatch(consumeItems, callerAgentId);

    // Step 2: re-peek sessions. canMatchSession is pure; it throws on
    // session_not_found/expired/unauthorized/max_uses_exceeded and returns
    // a boolean for pattern-match. Phase 1 already established pattern-match,
    // so a fresh `false` here would indicate state drift between Phase 1 and
    // Phase 2 (extremely unlikely in single-tick Node; defensive guard).
    //
    // Note: `resolveSessionRaces` (called above) has already demoted any
    // throw-prone entries to kind:"mint". This belt-and-suspenders pass
    // catches matcher drift between Phase 1 and the resolver — should be
    // unreachable in healthy code.
    for (const p of plans) {
      if (p.kind === "session") {
        const ok = opts.store.canMatchSession(p.sessionId, p.binding, opts.sessionStore!);
        if (!ok) {
          throw new ShuttleError(
            "session_pattern_no_match",
            "Session pattern stopped matching between Phase 1 and Phase 2 (concurrent state change?).",
          );
        }
      }
    }

    // Step 3: commit sessions.
    const sessionGrants = new Map<number, ApprovalGrant>(); // plan index → grant
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      if (p.kind === "session") {
        sessionGrants.set(i, opts.store.mintFromSession(p.sessionId, p.binding, opts.sessionStore!));
      }
    }

    // Step 4: commit consumes atomically.
    const consumed = consumeItems.length > 0 ? opts.store.consumeBatch(consumeItems, callerAgentId) : [];

    // Build results in plan order.
    const result: ApprovalGrant[] = new Array(plans.length);
    let consumedIdx = 0;
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      if (p.kind === "synth") {
        result[i] = synthesizeGrant(p.binding);
      } else if (p.kind === "consume") {
        result[i] = consumed[consumedIdx++]!;
      } else if (p.kind === "session") {
        result[i] = sessionGrants.get(i)!;
      } else {
        // p.kind === "mint" — unreachable, all mints became "consume" in Case C.
        throw new ShuttleError("unexpected_error", `unreachable plan kind at commit: ${(p as Plan).kind}`);
      }
    }
    return result;
  } catch (e) {
    // Any throw from Case C's mint+wait, the validate phase, the session
    // re-peek, mintFromSession, or consumeBatch — invalidate the waiting-flow
    // mints. invalidate is idempotent (no-op for unknown / already-consumed
    // ids) and safe in a catch block. Re-throw the original error.
    for (const id of waitingFlowMintedIds) {
      try {
        opts.store.invalidate(id);
      } catch {
        // Swallow — invalidate should never throw, but if a custom subclass
        // does, we still need to surface the ORIGINAL error.
      }
    }
    throw e;
  }
}

/**
 * Wait for an approval to reach status="granted". Does NOT consume — that
 * happens later in the unified Phase 2 commit, batched with supplied-ID
 * consumes for atomicity.
 *
 * Throws if status transitions to denied/expired/used during the wait,
 * or if the grant disappears, or if the deadline passes.
 */
async function waitForGranted(
  store: ApprovalStore,
  id: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = store.get(id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Approval vanished.");
    if (g.status === "used") throw new ShuttleError("approval_already_used", "Approval was already used.");
    if (g.status === "granted") return;
    if (g.status === "denied") throw new ShuttleError("approval_denied", "Approval denied.");
    if (g.status === "expired") throw new ShuttleError("approval_expired", "Approval expired.");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new ShuttleError("approval_timeout", "Timed out waiting for approval.");
}

function synthesizeGrant(binding: ApprovalBinding): ApprovalGrant {
  const now = Date.now();
  return {
    ...binding,
    id: "no-approval-required",
    status: "used",
    created_at: now,
    expires_at: now,
    ui_token: "",
    owner_agent_id: getCurrentAgentId(),
  };
}

/**
 * Burst 5 §2b Task 2b.6: find an owned active session whose pattern matches
 * `binding`. Returns a plan entry (kind:"session", auto:true) on hit, or null
 * if no candidate matches. Bumps `plannedSessionUsesById` for the picked
 * session BEFORE returning, so subsequent bindings in the same call see
 * the decremented capacity.
 *
 * Candidate filter:
 *  - Owned by `ownerAgentId` (never root — that guard lives at the call site).
 *  - status === "granted" — `sessionStore.list()` normalizes expiry on every
 *    call (session-store.ts:91-104), so any granted-but-past-TTL grant is
 *    already flipped to "expired" by the time we read it. We rely on this
 *    rather than a separate `expires_at > now` check; that means the helper
 *    uses the SessionStore's injected clock, which matters for tests with
 *    fake clocks (the alternative — `Date.now()` here — would skip valid
 *    sessions whose fake-clock TTL is in the future relative to the real one).
 *  - max_uses cap accounting for sibling-binding plans in the same call.
 *
 * Selection: newest-first (`approved_at` DESC). Deterministic tie-breaker
 * within the same approved-at via the underlying Map insertion order.
 */
function planFromAutoMatchedSession(
  binding: ApprovalBinding,
  sessionStore: SessionStore,
  ownerAgentId: string,
  plannedSessionUsesById: Map<string, number>,
): Plan | null {
  const candidates = sessionStore
    .list()
    .filter((s) => s.owner_agent_id === ownerAgentId)
    .filter((s) => s.status === "granted")
    .filter((s) => {
      if (s.max_uses === undefined) return true;
      const planned = plannedSessionUsesById.get(s.id) ?? 0;
      return s.uses + planned < s.max_uses;
    })
    .slice() // copy before sort (list() returns readonly)
    .sort((a, b) => (b.approved_at ?? 0) - (a.approved_at ?? 0));

  for (const candidate of candidates) {
    if (matchesSessionPattern(binding, candidate)) {
      plannedSessionUsesById.set(
        candidate.id,
        (plannedSessionUsesById.get(candidate.id) ?? 0) + 1,
      );
      return { kind: "session", binding, sessionId: candidate.id, auto: true };
    }
  }
  return null;
}

/**
 * Burst 5 §2b Task 2b.6: resolve session-race conditions between Phase 1
 * planning and Phase 2 commit. Iterates `plans` in place; any kind:"session"
 * entry whose backing session has become unusable (TTL elapsed, max_uses
 * exhausted by a concurrent caller, or sibling entries within this same
 * call would push us over the cap) is rewritten to kind:"mint" so the
 * existing mint-and-wait loop handles it like any fresh-approval need.
 *
 * Semantics differ by `auto` flag:
 *  - auto entries: ALL hard-failure codes demote silently (auto-match picked
 *    the candidate blindly; falling back to fresh approval is correct).
 *  - explicit (--session) entries: only race codes
 *    (session_max_uses_exceeded, session_expired) demote; pointer-validity
 *    codes (session_not_found, session_unauthorized) rethrow so the user
 *    who named the session sees the original error.
 *
 * The pattern-mismatch (`canMatchSession` returns false) branch is a
 * defensive guard against matcher drift between Phase 1 and the resolver
 * — Phase 1 only emits kind:"session" for bindings that matched, so this
 * branch should be unreachable in healthy code.
 */
function resolveSessionRaces(
  plans: Plan[],
  sessionStore: SessionStore,
  store: ApprovalStore,
): void {
  // Multi-entry capacity tracking. canMatchSession only inspects live
  // `session.uses` against `max_uses`; it does NOT know about sibling
  // entries in the same `plans` array that ALSO plan to consume the
  // session. Without per-sessionId kept-uses tracking, two bindings against
  // a max_uses=2 session could both pass canMatchSession after a concurrent
  // caller had consumed one slot (uses=1, cap=2), and the SECOND
  // mintFromSession in Phase 2 would throw session_max_uses_exceeded after
  // the first already incremented uses.
  const keptUsesById = new Map<string, number>();

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (p === undefined || p.kind !== "session") continue;

    let stillMatches: boolean;
    try {
      stillMatches = store.canMatchSession(p.sessionId, p.binding, sessionStore);
    } catch (err) {
      const code = err instanceof ShuttleError ? err.code : undefined;
      if (code !== undefined && RACE_DEMOTE_CODES.has(code)) {
        // Race (uses exhausted, TTL elapsed) — demote for BOTH auto and explicit.
        plans[i] = { kind: "mint", binding: p.binding };
        continue;
      }
      if (p.auto && code !== undefined && EXPLICIT_HARD_FAIL_CODES.has(code)) {
        // Auto-matched candidate became revoked / denied between Phase 1 and
        // now. The user didn't name this specific session; quietly demote.
        plans[i] = { kind: "mint", binding: p.binding };
        continue;
      }
      // Explicit user-named session with a hard-failure state (or unknown
      // error): rethrow so the user sees the original error code.
      throw err;
    }

    if (!stillMatches) {
      // Defensive guard against matcher drift between Phase 1 and the
      // resolver. Should be unreachable: Phase 1 only emits kind:"session"
      // for bindings that already matched (either via the explicit-sessionId
      // canMatchSession check or the auto-match matchesSessionPattern hit).
      plans[i] = { kind: "mint", binding: p.binding };
      continue;
    }

    // Sibling-aware capacity check. canMatchSession verified
    // `session.uses < session.max_uses` against live state; this additional
    // check folds in the kept-this-pass sibling entries to close the
    // multi-entry race. Uses sessionStore.get(id) (O(1)) rather than
    // list().find() (O(n)) — both flip expired-past-TTL grants, but get()
    // skips materializing the entire list.
    const session = sessionStore.get(p.sessionId);
    if (session !== undefined && session.max_uses !== undefined) {
      const alreadyKept = keptUsesById.get(p.sessionId) ?? 0;
      if (session.uses + alreadyKept + 1 > session.max_uses) {
        plans[i] = { kind: "mint", binding: p.binding };
        continue;
      }
    }
    keptUsesById.set(p.sessionId, (keptUsesById.get(p.sessionId) ?? 0) + 1);
  }
}
