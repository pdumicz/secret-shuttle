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
  }
  return lines.join("\n") + "\n";
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Report whether the daemon, vault, browser, policy, and local files are in a safe state.")
    .option("--json", "Emit machine-readable JSON.", false)
    .action(async (options) => {
      const paths = getShuttlePaths();
      let socketMode: string | null = null;
      try {
        const st = await stat(paths.daemonSocketPath);
        socketMode = "0" + (st.mode & 0o777).toString(8);
      } catch { socketMode = null; }

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

      if (options.json === true) {
        outputJson(ok(report as unknown as Record<string, unknown>));
        return;
      }
      process.stdout.write(formatDoctorText(report));
    });
}
