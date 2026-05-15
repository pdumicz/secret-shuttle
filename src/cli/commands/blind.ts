import { Command } from "commander";
import { writeAuditEvent } from "../../logging/logger.js";
import { endBlindMode, startBlindMode } from "../../policy/blind-mode.js";
import { ok, outputJson } from "../../shared/result.js";

export function blindCommand(): Command {
  const command = new Command("blind").description("Manage cooperative blind mode state.");

  command
    .command("start")
    .description("Start cooperative blind mode after stopping browser observation.")
    .requiredOption("--domain <domain>", "Domain where the sensitive moment is happening.")
    .requiredOption("--reason <reason>", "Human-readable reason.")
    .action(async (options) => {
      const state = await startBlindMode({
        domain: options.domain,
        reason: options.reason,
      });
      await writeAuditEvent({ action: "blind_start", ok: true, domain: state.domain });
      outputJson(ok({
        blind_mode: true,
        domain: state.domain,
        reason: state.reason,
        started_at: state.started_at,
        screenshots: state.screenshots,
        dom_observation: state.dom_observation,
        clipboard: state.clipboard,
      }));
    });

  command
    .command("end")
    .description("End cooperative blind mode.")
    .action(async () => {
      const result = await endBlindMode();
      await writeAuditEvent({ action: "blind_end", ok: true });
      outputJson(ok(result));
    });

  return command;
}
