import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";

export function secretsDeleteCommand(): Command {
  return new Command("delete")
    .description("Soft-delete a secret. Audit trail preserved. Production refs require approval.")
    .argument("<ref>", "Secret ref to delete (e.g. ss://stripe/prod/STRIPE_KEY).")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (ref: string, options) => {
      const body: Record<string, unknown> = { ref: normalizeRef(ref) };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/secrets/delete", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Soft-delete a secret (audit trail kept):
  secret-shuttle secrets delete ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Notes:
  - Soft delete sets a 'deleted_at' field on the vault record. The record
    stays in the vault file but is filtered from default 'secrets list' output.
  - Production refs require approval. Use --no-wait to receive an approval_id
    immediately and supply it via --approval-id once approved.
`);
}
