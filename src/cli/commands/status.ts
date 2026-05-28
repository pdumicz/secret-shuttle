import { Command } from "commander";
import { stat } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ok, outputJson } from "../../shared/result.js";

export interface DoctorReport {
  daemon_reachable: boolean;
  daemon_error: string | null;
  socket_file_mode: string | null;
  socket_file_mode_ok: boolean;
  health: Record<string, unknown> | null;
}

/** Pure formatter for the text-mode output. Exported for unit testing. */
export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`daemon:        ${report.daemon_reachable ? "reachable" : "NOT reachable"}`);
  if (report.socket_file_mode !== null) {
    lines.push(`socket mode:   ${report.socket_file_mode}${report.socket_file_mode_ok ? " (ok)" : " (EXPECTED 0600)"}`);
  }
  const health = report.health;
  if (health !== null) {
    lines.push(`unlocked:      ${health.unlocked}`);
    lines.push(`browser:       ${health.browser_started ? "started" : "not started"}`);
    lines.push(`proxy:         ${health.proxy_active ? "active" : "inactive"}`);
    lines.push(`blind mode:    ${health.blind_mode === null ? "off" : "ON"}`);
    const v = health.vault as { envelope_present: boolean; legacy_key_present: boolean };
    lines.push(`vault:         envelope=${v.envelope_present} legacy_key=${v.legacy_key_present}${v.legacy_key_present ? " (RUN: secret-shuttle migrate secure-vault)" : ""}`);
    const warns = health.policy_warnings as string[] | null;
    if (warns === null) lines.push(`policy:        (vault locked — unlock to audit)`);
    else if (warns.length === 0) lines.push(`policy:        ok`);
    else { lines.push(`policy:        ${warns.length} warning(s):`); for (const w of warns) lines.push(`  - ${w}`); }
    // Phase 5 — agentic-flows line (spec §11). Missing field ⇒ unavailable
    // (defensive: an older daemon predates the agentic_browser block).
    const ab = (health.agentic_browser as Record<string, unknown> | undefined) ?? undefined;
    const available = ab !== undefined && ab.available === true;
    if (available) {
      lines.push(`agentic flows: available`);
    } else {
      // Differentiate the cause when the agentic_browser block is present.
      // If the field is absent (older daemon), fall back to the generic advice.
      let advice: string;
      if (ab !== undefined) {
        const browserStarted = ab.browser_started === true;
        const proxyActive = ab.proxy_active === true;
        if (!browserStarted) advice = "start browser";
        else if (!proxyActive) advice = "restart browser (proxy down)";
        else advice = "unavailable";
      } else {
        advice = "start browser";
      }
      lines.push(`agentic flows: unavailable (${advice})`);
    }
    // Burst 5 §2b Task 2b.7: surface the caller's owner-scoped active
    // sessions from the /v1/health body. Older daemons predate the field,
    // so missing/empty arrays render no section (defensive read).
    const activeSessions = (health as Record<string, unknown>)["active_sessions"] as
      | Array<{ id: string; pattern_summary: string; minutes_remaining: number }>
      | undefined;
    if (activeSessions !== undefined && activeSessions.length > 0) {
      lines.push(`active sessions:`);
      for (const s of activeSessions) {
        // Surface the full id on the same block so the user can revoke
        // without copy-paste from a separate list endpoint. The UI's
        // session-affordance notice tells users they can revoke via
        // `secret-shuttle internal session revoke <id>` — that command
        // accepts only exact ids (no prefix matching at the store layer,
        // see session-store.ts:69), so we render the full id verbatim.
        lines.push(`  - ${s.pattern_summary} (expires in ${s.minutes_remaining} min)`);
        lines.push(`    revoke: secret-shuttle internal session revoke ${s.id}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export interface StatusResult {
  ready: boolean;
  next_action: string | null;
  report: DoctorReport;
}

/**
 * Derive the `ready` boolean + `next_action` from a DoctorReport. Pure
 * function — exported for unit testing.
 */
export function computeStatusFromReport(report: DoctorReport): { ready: boolean; next_action: string | null } {
  if (!report.daemon_reachable) {
    return { ready: false, next_action: "secret-shuttle daemon start" };
  }
  const health = report.health;
  if (health === null) {
    return { ready: false, next_action: "secret-shuttle daemon start" };
  }
  const vault = health.vault as { envelope_present: boolean; legacy_key_present: boolean } | undefined;
  if (vault?.legacy_key_present === true) {
    return { ready: false, next_action: "secret-shuttle migrate secure-vault" };
  }
  if (health.unlocked !== true) {
    return { ready: false, next_action: "secret-shuttle unlock" };
  }
  return { ready: true, next_action: null };
}

export function statusCommand(): Command {
  return new Command("status")
    .description("Report daemon, vault, browser, and policy health. Emits ready+next_action for agents.")
    .option("--json", "Emit machine-readable JSON.", false)
    .action(async (options) => {
      const paths = getShuttlePaths();
      let socketMode: string | null = null;
      try {
        const st = await stat(paths.daemonSocketPath);
        socketMode = "0" + (st.mode & 0o777).toString(8);
      } catch {
        socketMode = null;
      }

      let health: Record<string, unknown> | null = null;
      let daemonError: string | null = null;
      try {
        health = (await daemonRequest("GET", "/v1/health")) as Record<string, unknown>;
      } catch (e) {
        daemonError = e instanceof Error ? e.message : String(e);
      }

      const report: DoctorReport = {
        daemon_reachable: health !== null,
        daemon_error: daemonError,
        socket_file_mode: socketMode,
        socket_file_mode_ok: socketMode === null || socketMode === "0600",
        health,
      };

      const { ready, next_action } = computeStatusFromReport(report);
      const result: StatusResult = { ready, next_action, report };

      if (options.json === true || !process.stdout.isTTY) {
        outputJson(ok(result as unknown as Record<string, unknown>));
        return;
      }

      // Text mode: lead with ready + next_action, then the doctor-style report.
      process.stdout.write(`ready:         ${ready}\n`);
      if (next_action !== null) {
        process.stdout.write(`next_action:   ${next_action}\n`);
      }
      process.stdout.write("\n");
      process.stdout.write(formatDoctorText(report));
    })
    .addHelpText("after", `
Examples:
  # Human-readable health summary:
  secret-shuttle status

  # Machine-readable JSON (default when stdout is not a TTY):
  secret-shuttle status --json

Output shape (JSON):
  {
    "ok": true,
    "ready": true | false,
    "next_action": "secret-shuttle <command>" | null,
    "report": { daemon_reachable, daemon_error, socket_file_mode, health }
  }
`);
}
