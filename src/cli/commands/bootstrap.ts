import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

export function bootstrapCommand(): Command {
  const cmd = new Command("bootstrap")
    .description("Provision an entire project's secrets in one approval. Reads secret-shuttle.yml.")
    .option("--plan-file <path>", "Path to secret-shuttle.yml.", "./secret-shuttle.yml")
    .option("--continue", "Phase 2: consume approval and execute the plan.")
    .option("--batch <id>", "Batch id (required with --continue and --abandon).")
    .option("--force", "Re-generate / re-push even when secrets already exist.")
    .option("--abandon", "Delete a persisted batch (use with --batch <id>).")
    .option("--list", "List all persisted batches.")
    .option("--environment <env>", "Environment for new refs (default: production).", "production");
  addApprovalIdOption(cmd);
  return cmd.action(async (options: Record<string, unknown>) => {
    // --list path (no batch needed)
    if (options.list === true) {
      const r = await daemonRequest("GET", "/v1/bootstrap/list");
      outputJson(ok(r));
      return;
    }

    // --abandon path
    if (options.abandon === true) {
      if (typeof options.batch !== "string" || options.batch.length === 0) {
        throw new Error("--abandon requires --batch <id>");
      }
      const r = await daemonRequest("POST", "/v1/bootstrap/abandon", { batch_id: options.batch });
      outputJson(ok(r));
      return;
    }

    // --continue path
    if (options.continue === true) {
      if (typeof options.batch !== "string" || options.batch.length === 0) {
        throw new Error("--continue requires --batch <id>");
      }
      const body: Record<string, unknown> = { batch_id: options.batch };
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      const r = await daemonRequest("POST", "/v1/bootstrap/continue", body);
      outputJson(ok(r));
      return;
    }

    // Default: Phase 1 — read yml, post plan.
    const planYml = await readFile(options.planFile as string, "utf-8");
    const body: Record<string, unknown> = {
      plan_yml: planYml,
      force: options.force === true,
      environment: options.environment,
    };
    const r = await daemonRequest("POST", "/v1/bootstrap/plan", body);
    outputJson(ok(r));
  })
  .addHelpText("after", `
Examples:
  # Phase 1: parse secret-shuttle.yml, mint approval.
  secret-shuttle bootstrap
  # → emits approval_required with details.batch_id + details.approvals.

  # Phase 2: after approving in the hub, execute the plan.
  secret-shuttle bootstrap --continue --batch <batch-id> --approval-id <id>

  # Force re-generate / re-push even when secrets exist:
  secret-shuttle bootstrap --force

  # List persisted batches:
  secret-shuttle bootstrap --list

  # Cancel a batch (clean up persisted state):
  secret-shuttle bootstrap --abandon --batch <batch-id>
`);
}
