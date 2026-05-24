import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { assertCaptureSource, normalizeRef } from "./helpers.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

export function compareCommand(): Command {
  const cmd = new Command("compare")
    .description("Compare selected text or focused field against a stored secret via the daemon.")
    .requiredOption("--ref <ref>")
    .option("--with <source>", "focused-field or selection.", "focused-field")
    .option("--domain <domain>")
    .option("--no-wait");
  addApprovalIdOption(cmd);
  return cmd.action(async (options) => {
      assertCaptureSource(options.with);
      const body: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        with: options.with,
        wait_for_approval: options.wait !== false,
      };
      if (options.domain !== undefined) body.domain = options.domain;
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/compare", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
