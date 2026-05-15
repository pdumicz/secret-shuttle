import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";

export function generateCommand(): Command {
  return new Command("generate")
    .description("Generate and store a new secret via the daemon.")
    .requiredOption("--name <name>")
    .requiredOption("--env <environment>")
    .option("--source <source>", "Secret source namespace.", "local")
    .option("--kind <kind>", "Secret kind.", "random_32_bytes")
    .option("--allow-domain <domain>", "Allowed destination domain.", collectRepeated, [])
    .option("--description <description>")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (options) => {
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        kind: options.kind,
        allowed_domains: options.allowDomain,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/generate", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
