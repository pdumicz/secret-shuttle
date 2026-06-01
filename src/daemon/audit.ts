import { appendFile } from "node:fs/promises";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";
import { getCurrentAgentId } from "./auth/auth-context.js";

export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume" | "blind_auto_resume_after_browser_stop"
  | "bootstrap_browser_preserved_for_page_state_recovery"
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
  | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render"
  | "template_run" | "template_tmp_sweep"
  | "approval_created" | "approval_granted" | "approval_denied"
  | "approval_expired" | "approval_used" | "approval_cancelled" | "approval_mismatch"
  | "import"
  | "bootstrap_plan" | "bootstrap_step"
  | "tokens_mint"
  | "daemon_rotate" | "daemon_reset_machine_id";

export interface DaemonAuditEvent {
  action: DaemonAuditAction;
  ok: boolean;
  ref?: string;
  planned_ref?: string;
  environment?: string;
  destination_environment?: string;
  domain?: string;
  template_id?: string;
  approval_id?: string;
  /**
   * Set when this operation's approval was minted from a pre-approved session
   * (a SessionGrant in src/daemon/approvals/session-store.ts) rather than from
   * a single-use approval window.  Present on BOTH the success audit and any
   * catch-block failure audit IFF the session was actually consumed
   * (requireApprovals returned a grant carrying session_id) — preserving the
   * contract "session_id appears in audit iff the session was charged a use".
   */
  session_id?: string;
  error_code?: string;
  message?: string;
  /** Discriminates the unlock source: "keychain" when the cached master key was used, absent for passphrase UI. */
  source?: string;
  submitted?: boolean | "unknown";
  captured?: boolean | "unknown";
  success_signal?: string;
  absence_proof?: string;
  blind_mode?: boolean;
  op?: string;
  /**
   * Whether the plaintext secret value was surfaced to the agent in this
   * operation.  Defaults to false for every route.  The only current caller
   * that sets this to true is `inject_render` when `output_path === "-"`
   * (stdout-passthrough mode), because in that case the rendered plaintext is
   * returned in the HTTP response body where the agent can read it.
   */
  value_visible_to_agent?: boolean;
  /**
   * The agent_id that caused this audit event.  Auto-stamped by
   * `writeDaemonAudit` from the ambient ALS AuthContext (set by withAuthContext
   * around every authenticated handler) when undefined.  Falls back to the
   * literal "daemon" outside any request context (lifecycle hooks, background
   * tasks).  Routes that act on a persisted grant (e.g. UI approval clicks)
   * should pass the grant's owner_agent_id explicitly.
   */
  actor_agent_id?: string;
  /**
   * The agent_id of the caller that minted a child token via /v1/tokens/mint
   * (Task A12). Equal to `actor_agent_id` for the same event — recorded as a
   * dedicated field so audit consumers can correlate parent→child trees
   * without parsing actor_agent_id semantics.
   */
  parent_agent_id?: string;
  /**
   * The agent_id minted by /v1/tokens/mint (Task A12). For non-root callers
   * this MUST start with `${parent_agent_id}.` (namespace restriction enforced
   * by the route).
   */
  child_agent_id?: string;
  /**
   * Short fingerprint of the daemon's root token at the time this event was
   * emitted (first 4 bytes / 8 hex chars of SHA-256(root_token)). Stamped by
   * /v1/tokens/mint on every audit row and by /v1/daemon/rotate on the
   * before+after rows. Audit-log consumers can bucket rows by generation
   * without seeing the actual root token bytes.
   */
  root_token_fp?: string;
  /**
   * For daemon_rotate events only: the OLD fingerprint (before the swap).
   * `root_token_fp` carries the NEW fingerprint. Pair lets readers chain
   * the rotation timeline: rows with root_token_fp = X were minted under
   * X; the rotate event with root_token_fp_prev = X + root_token_fp = Y
   * marks the transition.
   */
  root_token_fp_prev?: string;
  /**
   * Set on bootstrap_plan and bootstrap_step rows AND on template_run
   * rows written under bootstrapAuthority. Enables audit consumers
   * to group fine-grained template_run rows under the parent
   * bootstrap_step row via shared batch_id. See Burst 5 §4.
   */
  batch_id?: string;

  /** Set on bootstrap_step rows. The PlanEntry.source.kind. */
  source_kind?: string;

  /** Set on bootstrap_step rows. The human-readable destination shorthands (e.g., "vercel:production"). */
  destination_shorthands?: string[];

  /** Set on bootstrap_step rows. */
  destinations_ok_count?: number;

  /** Set on bootstrap_step rows. */
  destinations_failed_count?: number;
}

/**
 * Discriminates *where* an audit event is emitted from, so the right
 * actor_agent_id can be resolved:
 *  - "request":          inside an authenticated daemon handler — read from ALS.
 *  - "lifecycle":        daemon-side lifecycle hooks (startup, sweeps, etc.).
 *  - "persisted-owner":  routes that act on behalf of a stored grant's owner
 *                        outside any ALS context (e.g. UI approval clicks).
 */
export type AuditActorSite =
  | { site: "request" }
  | { site: "lifecycle" }
  | { site: "persisted-owner"; ownerAgentId: string };

export function getAuditActor(site: AuditActorSite): string {
  switch (site.site) {
    case "request":
      return getCurrentAgentId();
    case "lifecycle":
      return "daemon";
    case "persisted-owner":
      return site.ownerAgentId;
  }
}

export async function writeDaemonAudit(event: DaemonAuditEvent): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  // Auto-stamp actor_agent_id from the ambient ALS AuthContext if not already
  // set by the caller.  Falls back to "daemon" outside any request context.
  const actor_agent_id = event.actor_agent_id ?? getCurrentAgentId();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
    actor_agent_id,
    // Default to false; only emit true when the caller explicitly opted into
    // documenting that this operation surfaced plaintext to the agent
    // (currently: inject_render in stdout-passthrough mode).
    value_visible_to_agent: event.value_visible_to_agent === true,
  });
  await appendFile(paths.auditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}
