import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function secretsListCommand(): Command {
  return new Command("list")
    .description("List secret metadata only. Raw values are never returned.")
    .option("--env <environment>", "Filter by environment (e.g. production, preview, local).")
    .option("--source <source>", "Filter by source (e.g. stripe, supabase, local).")
    .option("--include-deleted", "Also surface soft-deleted entries (deleted_at set).")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (options) => {
      const body: Record<string, unknown> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      if (options.includeDeleted === true) body.include_deleted = true;
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

  # Include soft-deleted entries (admin / audit):
  secret-shuttle secrets list --include-deleted
`);
}
