import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { normalizeRef } from "./helpers.js";
import { withPendingDeprecationWarning } from "../../shared/deprecation.js";

export function inspectCommand(): Command {
  return new Command("inspect")
    .description("(deprecated) Use 'secret-shuttle secrets get-ref' instead.")
    .argument("<ref>")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (ref: string) => {
      withPendingDeprecationWarning("inspect", "secrets get-ref");
      const r = await daemonRequest("POST", "/v1/secrets/inspect", { ref: normalizeRef(ref) });
      outputJson(ok(r as Record<string, unknown>));
    });
}
