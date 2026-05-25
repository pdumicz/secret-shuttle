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
  | { kind: "mint"; binding: ApprovalBinding }
  | { kind: "waited"; binding: ApprovalBinding; grant: ApprovalGrant };

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

  // Case C: waiting flow + mints needed → sequential mint+wait, per binding.
  if (mintPlans.length > 0) {
    const waitBudget = opts.waitMs ?? DEFAULT_WAIT_MS;
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p === undefined || p.kind !== "mint") continue;
      const g = opts.store.create(p.binding);
      const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
      open(url);
      const granted = await waitForGrant(opts.store, g.id, waitBudget, p.binding);
      plans[i] = { kind: "waited", binding: p.binding, grant: granted };
    }
  }

  // Case A (and tail of Case C): commit all consume plans atomically (one
  // timestamp covers the whole batch — closes Phase 1→Phase 2 TTL TOCTOU
  // where the clock could cross a later approval's expires_at after an
  // earlier consume already committed). Synth/session/waited plans are
  // executed individually in plan order — they don't share the consume
  // race window because synth has no side effects, mintFromSession has
  // its own (separate) race semantics, and waited grants are already
  // consumed.
  const consumeIndices: number[] = [];
  const consumeItems: Array<{ id: string; binding: ApprovalBinding }> = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]!;
    if (p.kind === "consume") {
      consumeIndices.push(i);
      consumeItems.push({ id: p.id, binding: p.binding });
    }
  }
  const consumed = consumeItems.length > 0
    ? opts.store.consumeBatch(consumeItems)
    : [];

  const result: ApprovalGrant[] = new Array(plans.length);
  let consumedIdx = 0;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]!;
    if (p.kind === "synth") {
      result[i] = synthesizeGrant(p.binding);
    } else if (p.kind === "consume") {
      result[i] = consumed[consumedIdx++]!;
    } else if (p.kind === "session") {
      result[i] = opts.store.mintFromSession(opts.sessionId!, p.binding, opts.sessionStore!);
    } else if (p.kind === "waited") {
      result[i] = (p as Extract<Plan, { kind: "waited" }>).grant;
    } else {
      // Should be unreachable: "mint" plans only exist in --no-wait flow which already threw.
      throw new ShuttleError("unexpected_error", `unreachable plan kind: ${(p as Plan).kind}`);
    }
  }
  return result;
}

async function waitForGrant(
  store: ApprovalStore,
  id: string,
  timeoutMs: number,
  binding: ApprovalBinding,
): Promise<ApprovalGrant> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = store.get(id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Approval vanished.");
    // Defensive: if a grant we just minted was somehow consumed externally,
    // surface that immediately rather than spinning to timeout.
    if (g.status === "used") throw new ShuttleError("approval_already_used", "Approval was already used.");
    if (g.status === "granted") {
      return store.consume(id, binding);
    }
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
