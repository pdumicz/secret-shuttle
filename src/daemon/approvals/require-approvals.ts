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
 */
export async function requireApprovals(
  opts: RequireApprovalsOptions,
): Promise<ApprovalGrant[]> {
  if (opts.bindings.length === 0) return [];

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
      // false → fall through; throws bubble out
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
      unusedIds.delete(matchedId);
      plans.push({ kind: "consume", binding, id: matchedId });
      continue;
    }

    // 4. Mint
    plans.push({ kind: "mint", binding });
  }

  // After loop: any leftover unused IDs are mismatches.
  if (unusedIds.size > 0) {
    throw new ShuttleError(
      "approval_mismatch",
      `Supplied approval id(s) did not match any required binding: ${[...unusedIds].join(", ")}`,
    );
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

  // Case A (and tail of Case C): commit non-mint plans + collect grants in order.
  const result: ApprovalGrant[] = [];
  for (const p of plans) {
    if (p.kind === "synth") {
      result.push(synthesizeGrant(p.binding));
    } else if (p.kind === "consume") {
      result.push(opts.store.consume(p.id, p.binding));
    } else if (p.kind === "session") {
      result.push(opts.store.mintFromSession(opts.sessionId!, p.binding, opts.sessionStore!));
    } else if (p.kind === "waited") {
      result.push(p.grant);
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
