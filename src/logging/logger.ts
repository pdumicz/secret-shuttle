import { appendFile } from "node:fs/promises";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";

export type AuditAction =
  | "init"
  | "blind_start"
  | "blind_end"
  | "generate"
  | "capture"
  | "inject"
  | "compare"
  | "use_as_stdin";

export interface AuditEvent {
  action: AuditAction;
  ref?: string;
  domain?: string;
  environment?: string;
  ok: boolean;
  message?: string;
}

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
    value_visible_to_agent: false,
  });
  await appendFile(paths.auditLogPath, `${line}\n`, {
    encoding: "utf8",
    mode: 0o600,
  }).catch(() => undefined);
}
