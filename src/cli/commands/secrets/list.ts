import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function secretsListCommand(): Command {
  return new Command("list")
    .description("List secret metadata only. Raw values are never returned.")
    .option("--env <environment>", "Filter by environment (e.g. production, preview, local).")
    .option("--source <source>", "Filter by source (e.g. stripe, supabase, local).")
    .action(async (options) => {
      const body: Record<string, string> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      const r = await daemonRequest("POST", "/v1/secrets/list", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # List all secrets:
  secret-shuttle secrets list

  # Filter by environment:
  secret-shuttle secrets list --env production

  # Filter by source:
  secret-shuttle secrets list --source stripe
`);
}
