import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { addApprovalIdOption } from "./_approval-id-option.js";
import { parseBootstrapYml, type BootstrapPlan } from "../bootstrap/yml.js";

/**
 * Inspect a locally-parsed bootstrap plan and, if it contains any
 * `kind: capture` sources, print a one-line stderr hint pointing the user at
 * the hub. The hub is where the per-step capture coordinator cards render
 * (see C13/C14): each capture step surfaces a "Capture" / "Skip" / "Abandon"
 * card the user must click. Without this hint, an agent driving bootstrap
 * sees only the approval URL and may not realise additional interactive
 * steps follow.
 *
 * Best-effort: any parse failure is swallowed (the real parse + structured
 * error happens server-side). stderr-only so the stdout JSON contract stays
 * machine-parseable.
 */
function maybePrintCaptureHint(planYml: string): void {
  let parsed: BootstrapPlan;
  try {
    parsed = parseBootstrapYml(planYml);
  } catch {
    // Bad yml; the daemon will report the real error. Don't pre-empt it
    // with a confusing hint.
    return;
  }
  const hasCapture = parsed.secrets.some((s) => s.source.kind === "capture");
  if (!hasCapture) return;
  process.stderr.write(
    "Bootstrap plan contains capture-from-URL steps. Watch the hub window for per-step Capture / Skip / Abandon prompts after approving.\n",
  );
}

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
      // Opportunistically read the plan file so we can surface the capture-
      // flow hint to the user during /continue too. The daemon does not echo
      // back source kinds on /continue (only completed/failed/refs/errors),
      // so without local parsing we have nothing to gate the hint on. Any
      // failure here (file removed, mid-edit, etc.) is silent — the real
      // plan-of-record lives in the daemon's BatchState and we don't want to
      // block --continue on a missing yml.
      try {
        const planYml = await readFile(options.planFile as string, "utf-8");
        maybePrintCaptureHint(planYml);
      } catch {
        // ignore — see above
      }
      const body: Record<string, unknown> = { batch_id: options.batch };
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      const r = await daemonRequest("POST", "/v1/bootstrap/continue", body);
      outputJson(ok(r));
      return;
    }

    // Default: Phase 1 — read yml, post plan.
    const planYml = await readFile(options.planFile as string, "utf-8");
    // Pre-flight stderr hint: if the yml contains a capture source, tell the
    // user they'll see per-step capture cards in the hub. The hint fires
    // BEFORE the daemon call so the user sees it even when /plan throws
    // approval_required (the common case — capture plans always require
    // approval per C9), and the existing error-printer formats the approval
    // URL on its own line below the hint.
    maybePrintCaptureHint(planYml);
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
