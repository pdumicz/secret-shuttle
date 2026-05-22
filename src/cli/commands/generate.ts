import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";
import { ShuttleError } from "../../shared/errors.js";
import { canonicalEnvironment } from "../../shared/refs.js";
import { withPendingDeprecationWarning } from "../../shared/deprecation.js";

export function generateCommand(): Command {
  return new Command("generate")
    .description("(deprecated) Use 'secret-shuttle secrets set' instead.")
    .requiredOption("--name <name>")
    .requiredOption("--env <environment>")
    .option("--source <source>", "Secret source namespace.", "local")
    .option("--kind <kind>", "Secret kind.", "random_32_bytes")
    .option("--allow-domain <domain>", "Allowed destination domain.", collectRepeated, [])
    .option("--allow-action <action>", "Allowed secret action (repeatable). Omit to use defaults.", collectRepeated, [])
    .option("--description <description>")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (options) => {
      withPendingDeprecationWarning("generate", "secrets set");
      const domains = options.allowDomain as string[];
      if (canonicalEnvironment(options.env) === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        kind: options.kind,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      const actions = options.allowAction as string[];
      if (actions.length > 0) body.allowed_actions = actions;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/generate", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
