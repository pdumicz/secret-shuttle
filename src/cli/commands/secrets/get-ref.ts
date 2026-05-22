import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";

export function secretsGetRefCommand(): Command {
  return new Command("get-ref")
    .description("Show metadata for a stored secret. Raw values are never returned.")
    .argument("<ref>", "Secret ref (e.g. ss://stripe/prod/STRIPE_KEY).")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (ref: string) => {
      const r = await daemonRequest("POST", "/v1/secrets/inspect", { ref: normalizeRef(ref) });
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Show metadata for a specific ref:
  secret-shuttle secrets get-ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Note: the raw secret value is never returned by this command. Output includes
the ref, fingerprint, allowed domains/actions, and timestamps — that's it.
`);
}
