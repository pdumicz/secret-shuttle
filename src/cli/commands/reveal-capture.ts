import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";
import { ShuttleError } from "../../shared/errors.js";
import { canonicalEnvironment } from "../../shared/refs.js";

export function revealCaptureCommand(): Command {
  return new Command("reveal-capture")
    .description("Daemon-owned: click a marked reveal control, capture the revealed secret (field/container/focused-after-reveal), hide it, and auto-resume only if the secret is proven gone.")
    .requiredOption("--name <name>")
    .requiredOption("--env <environment>")
    .requiredOption("--source <source>")
    .requiredOption("--reveal-handle <label>", "Label of a pre-marked reveal button/link.")
    .option("--field-handle <label>", "Stable field marked before reveal (mode `field`).")
    .option("--container-handle <label>", "Stable ancestor marked before reveal (mode `container`).")
    .option("--capture <strategy>", "Only `focused-after-reveal` (requires --container-handle).")
    .option("--hide-handle <label>", "Optional pre-marked hide button/link; else all pages are blanked.")
    .option("--domain <domain>")
    .option("--allow-domain <domain>", "Allowed domain (repeatable).", collectRepeated, [])
    .option("--description <description>")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      const domains = options.allowDomain as string[];
      if (canonicalEnvironment(options.env) === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const bodyObj: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        reveal_handle: options.revealHandle,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (options.fieldHandle !== undefined) bodyObj.field_handle = options.fieldHandle;
      if (options.containerHandle !== undefined) bodyObj.container_handle = options.containerHandle;
      if (options.capture !== undefined) bodyObj.capture = options.capture;
      if (options.hideHandle !== undefined) bodyObj.hide_handle = options.hideHandle;
      if (options.domain !== undefined) bodyObj.domain = options.domain;
      if (domains.length > 0) bodyObj.allowed_domains = domains;
      if (options.description !== undefined) bodyObj.description = options.description;
      if (options.approvalId !== undefined) bodyObj.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/reveal-capture", bodyObj);
      outputJson(ok(r as Record<string, unknown>));
    });
}
