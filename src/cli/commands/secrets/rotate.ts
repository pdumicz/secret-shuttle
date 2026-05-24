import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";
import { addApprovalIdOption } from "../_approval-id-option.js";

export function secretsRotateCommand(): Command {
  const cmd = new Command("rotate")
    .description("Rotate a secret. Generates a new ref, marks the old one as rotating. Caller re-pushes and then deletes the old.")
    .argument("<ref>", "Secret ref to rotate.")
    .option("--kind <kind>", "Generation kind for the new secret.", "random_32_bytes")
    .option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false);
  addApprovalIdOption(cmd);
  return cmd.action(async (ref: string, options) => {
      const body: Record<string, unknown> = {
        ref: normalizeRef(ref),
        kind: options.kind,
      };
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      if (options.session !== undefined) body.session_id = options.session;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/secrets/rotate", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Rotate a webhook secret:
  secret-shuttle secrets rotate ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Output (excerpt):
  {
    "ok": true,
    "rotation_started": true,
    "old_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
    "new_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET-rot-<id>",
    "plan": [],
    "next_action": "Re-push the new secret to all destinations ..."
  }

Workflow (full rotation):
  1. Run 'secrets rotate <ref>' — returns new_ref.
  2. Push new_ref to every destination (Vercel env, GitHub Actions, etc.)
     via 'template run' or 'inject-submit'.
  3. Once all pushes succeed, run 'secrets delete <old-ref>'.

Note: 'plan' is empty in this release. A future release will read the audit
log to suggest specific re-push commands per destination.
`);
}
