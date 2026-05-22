import { appendFile } from "node:fs/promises";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";

export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume"
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
  | "secrets_delete" | "secrets_rotate" | "run" | "inject_render"
  | "template_run" | "template_tmp_sweep"
  | "approval_created" | "approval_granted" | "approval_denied"
  | "approval_expired" | "approval_used" | "approval_mismatch";

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
  error_code?: string;
  message?: string;
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
}

export async function writeDaemonAudit(event: DaemonAuditEvent): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
    // Default to false; only emit true when the caller explicitly opted into
    // documenting that this operation surfaced plaintext to the agent
    // (currently: inject_render in stdout-passthrough mode).
    value_visible_to_agent: event.value_visible_to_agent === true,
  });
  await appendFile(paths.auditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}
