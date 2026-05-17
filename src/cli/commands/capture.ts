import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { assertCaptureSource, collectRepeated } from "./helpers.js";
import { ShuttleError } from "../../shared/errors.js";

export function captureCommand(): Command {
  return new Command("capture")
    .description("Capture a secret via the daemon. The raw value is never returned.")
    .requiredOption("--name <name>")
    .requiredOption("--env <environment>")
    .requiredOption("--source <source>")
    .option("--from <source>", "focused-field or selection.", "focused-field")
    .option("--allow-domain <domain>", "Allowed domain.", collectRepeated, [])
    .option("--description <description>")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      assertCaptureSource(options.from);
      const domains = options.allowDomain as string[];
      if (options.env === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        from: options.from,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/capture", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
