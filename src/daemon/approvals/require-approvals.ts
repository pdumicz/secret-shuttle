import { ShuttleError } from "../../shared/errors.js";
import { openUrl } from "./open-url.js";
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
  | { kind: "session"; binding: ApprovalBinding }
  | { kind: "consume"; binding: ApprovalBinding; id: string }
  | { kind: "mint"; binding: ApprovalBinding };

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
 * Under waiting flow with mints needed, sequential per-binding: mint, wait,
 * consume one at a time. Earlier non-mint plans are committed only after all
 * mints have been waited on, so a mid-flow denial doesn't burn earlier plans.
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

  // Phase 1 Step 0: resolve every supplied ID. Unknown IDs are approval_not_found.
  const suppliedIds = [...(opts.approvalIdsFromClient ?? [])];
  for (const id of suppliedIds) {
    if (opts.store.get(id) === undefined) {
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
        plans.push({ kind: "session", binding });
        continue;
      }
      // canMatchSession contract: returns false on pattern no-match
      // (fall through to supplied-ID path); throws on hard-fail session
      // states (revoked / expired / denied / at-max-uses) which bubble
      // out of requireApprovals entirely.
    }

    // 3. Supplied-ID match
    let matchedId: string | undefined;
    for (const id of unusedIds) {
      const peek = opts.store.get(id);
      if (peek === undefined) continue; // resolved in step 0
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

    // Gather consume items (includes supplied-ID consumes AND waited mints
    // from Case C — both have plan.kind === "consume" by this point).
    const consumeItems: Array<{ id: string; binding: ApprovalBinding }> = [];
    for (const p of plans) {
      if (p.kind === "consume") {
        consumeItems.push({ id: p.id, binding: p.binding });
      }
    }

    // Step 1: validate consumes.
    opts.store.validateConsumeBatch(consumeItems);

    // Step 2: re-peek sessions. canMatchSession is pure; it throws on
    // session_not_found/expired/unauthorized/max_uses_exceeded and returns
    // a boolean for pattern-match. Phase 1 already established pattern-match,
    // so a fresh `false` here would indicate state drift between Phase 1 and
    // Phase 2 (extremely unlikely in single-tick Node; defensive guard).
    for (const p of plans) {
      if (p.kind === "session") {
        const ok = opts.store.canMatchSession(opts.sessionId!, p.binding, opts.sessionStore!);
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
        sessionGrants.set(i, opts.store.mintFromSession(opts.sessionId!, p.binding, opts.sessionStore!));
      }
    }

    // Step 4: commit consumes atomically.
    const consumed = consumeItems.length > 0 ? opts.store.consumeBatch(consumeItems) : [];

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
  };
}
