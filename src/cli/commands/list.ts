import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function listCommand(): Command {
  return new Command("list")
    .description("List secret metadata only.")
    .option("--env <environment>")
    .option("--source <source>")
    .action(async (options) => {
      const body: Record<string, string> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      const r = await daemonRequest("POST", "/v1/secrets/list", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
