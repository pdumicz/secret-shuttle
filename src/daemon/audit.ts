import { appendFile } from "node:fs/promises";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";

export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume"
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
  | "secrets_delete" | "secrets_rotate"
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
}

export async function writeDaemonAudit(event: DaemonAuditEvent): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event, value_visible_to_agent: false });
  await appendFile(paths.auditLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}
