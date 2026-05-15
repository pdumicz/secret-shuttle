import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function browserCommand(): Command {
  const c = new Command("browser").description("Browser session controlled by the daemon.");
  c.command("start")
    .option("--profile <profile>", "Browser profile name.", "prod-config")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/browser/start", { profile: options.profile });
      outputJson(ok(r as Record<string, unknown>));
    });
  return c;
}
