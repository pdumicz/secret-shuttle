import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function browserCommand(): Command {
  const c = new Command("browser").description("Browser session controlled by the daemon.");
  c.command("start")
    .option("--profile <profile>", "Browser profile name.", "prod-config")
    .option("--chrome-path <path>")
    .action(async (options) => {
      const body: Record<string, unknown> = { profile: options.profile };
      if (options.chromePath !== undefined) body.chrome_path = options.chromePath;
      const r = await daemonRequest("POST", "/v1/browser/start", body);
      outputJson(ok(r as Record<string, unknown>));
    });
  return c;
}
