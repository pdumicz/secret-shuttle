import { Command } from "commander";
import { startControlledBrowser } from "../../browser/browser-start.js";
import { ok, outputJson } from "../../shared/result.js";

export function browserCommand(): Command {
  const command = new Command("browser").description("Browser helpers for controlled local sessions.");

  command
    .command("start")
    .description("Start Chrome with remote debugging enabled for Secret Shuttle focused-field operations.")
    .option("--port <port>", "Remote debugging port.", "9222")
    .option("--profile <profile>", "Secret Shuttle browser profile name.", "prod-config")
    .option("--chrome-path <path>", "Chrome executable path.")
    .action(async (options) => {
      const result = await startControlledBrowser({
        port: Number(options.port),
        profile: options.profile,
        chromePath: options.chromePath,
      });
      outputJson(ok({
        ...result,
        value_visible_to_agent: false,
      }));
    });

  return command;
}
