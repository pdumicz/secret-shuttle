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
  c.command("end").action(async () => {
    const r = await daemonRequest("POST", "/v1/blind/end");
    outputJson(ok(r as Record<string, unknown>));
  });
  return c;
}
