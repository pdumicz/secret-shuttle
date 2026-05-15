// src/daemon/approvals/require-approval.ts
import { ShuttleError } from "../../shared/errors.js";
import { openUrl } from "./open-url.js";
import type { ApprovalBinding, ApprovalGrant, ApprovalStore } from "./store.js";

export interface RequireApprovalOptions {
  store: ApprovalStore;
  binding: ApprovalBinding;
  daemonPort: number;
  approvalIdFromClient?: string;
  waitMs?: number;
  /** Hook so tests can disable the system-browser open. */
  openUrlImpl?: (url: string) => void;
}

export async function requireApproval(opts: RequireApprovalOptions): Promise<ApprovalGrant> {
  const needsApproval = opts.binding.environment === "production";
  if (!needsApproval) {
    return synthesizeGrant(opts.binding);
  }

  if (opts.approvalIdFromClient !== undefined) {
    return opts.store.consume(opts.approvalIdFromClient, opts.binding);
  }

  const grant = opts.store.create(opts.binding);
  const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${grant.id}&token=${grant.ui_token}`;
  (opts.openUrlImpl ?? openUrl)(url);

  if (opts.waitMs === 0) {
    throw new ShuttleError(
      "approval_required",
      JSON.stringify({ approval_id: grant.id, approval_url: url, expires_at: grant.expires_at }),
    );
  }

  return waitForGrant(opts.store, grant.id, opts.waitMs ?? 2 * 60 * 1000, opts.binding);
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
    await new Promise((r) => setTimeout(r, 200));
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
