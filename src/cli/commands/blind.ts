import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function blindCommand(): Command {
  const c = new Command("blind").description("Manage daemon-owned blind mode state.");
  c.command("start")
    .requiredOption("--domain <domain>")
    .requiredOption("--reason <reason>")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/blind/start", {
        domain: options.domain,
        reason: options.reason,
      });
      outputJson(ok(r as Record<string, unknown>));
    });
  c.command("end")
    .option("--approval-id <id>")
    .option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
    .option("--no-wait")
    .action(async (options) => {
      const body: Record<string, unknown> = { wait_for_approval: options.wait !== false };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.session !== undefined) body.session_id = options.session;
      const r = await daemonRequest("POST", "/v1/blind/end", body);
      outputJson(ok(r as Record<string, unknown>));
    });
  return c;
}
