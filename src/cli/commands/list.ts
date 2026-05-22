import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { withPendingDeprecationWarning } from "../../shared/deprecation.js";

export function listCommand(): Command {
  return new Command("list")
    .description("(deprecated) Use 'secret-shuttle secrets list' instead.")
    .option("--env <environment>")
    .option("--source <source>")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (options) => {
      withPendingDeprecationWarning("list", "secrets list");
      const body: Record<string, string> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      const r = await daemonRequest("POST", "/v1/secrets/list", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
