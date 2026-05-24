import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { assertFocusedTarget, normalizeRef } from "./helpers.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

export function injectCommand(): Command {
  const cmd = new Command("inject")
    .description("Inject a stored secret into the focused browser field via the daemon.")
    .requiredOption("--ref <ref>")
    .option("--to <target>", "Injection target.", "focused-field")
    .option("--domain <domain>")
    .option("--no-wait");
  addApprovalIdOption(cmd);
  return cmd.action(async (options) => {
      assertFocusedTarget(options.to);
      const body: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        wait_for_approval: options.wait !== false,
      };
      if (options.domain !== undefined) body.domain = options.domain;
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/inject", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
