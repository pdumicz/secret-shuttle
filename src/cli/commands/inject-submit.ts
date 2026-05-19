import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { normalizeRef } from "./helpers.js";

export function injectSubmitCommand(): Command {
  return new Command("inject-submit")
    .description("Daemon-owned: inject a secret into a marked field, click a marked submit control, verify success, and auto-resume only if the secret is proven gone.")
    .requiredOption("--ref <ref>")
    .requiredOption("--field-handle <label>", "Label of a pre-marked field (mark it before blind mode).")
    .requiredOption("--submit-handle <label>", "Label of a pre-marked submit button/link.")
    .requiredOption("--success-text <text>", "Non-secret marker that proves the save succeeded.")
    .option("--domain <domain>")
    .option("--success-timeout-ms <ms>", "Max wait for the success marker (default 15000, cap 60000).", (v) => parseInt(v, 10))
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      const bodyObj: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        field_handle: options.fieldHandle,
        submit_handle: options.submitHandle,
        success_text: options.successText,
        wait_for_approval: options.wait !== false,
      };
      if (options.domain !== undefined) bodyObj.domain = options.domain;
      if (options.successTimeoutMs !== undefined) bodyObj.success_timeout_ms = options.successTimeoutMs;
      if (options.approvalId !== undefined) bodyObj.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/inject-submit", bodyObj);
      outputJson(ok(r as Record<string, unknown>));
    });
}
