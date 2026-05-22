import { Command } from "commander";
import { stat } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ok, outputJson } from "../../shared/result.js";
import { formatDoctorText, type DoctorReport } from "./doctor.js";

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
