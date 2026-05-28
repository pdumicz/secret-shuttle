import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";

/**
 * `internal session` — pre-approved session management.
 *
 * A SessionPattern is a SHAPE the human approves once; subsequent operations
 * matching the shape skip per-call approval until TTL or max_uses is hit.
 *
 *   - create  — mint a session pattern; opens the approval UI.
 *   - list    — list all sessions (pending, granted, expired, denied, revoked).
 *   - revoke  — revoke a session; subsequent uses fail with session_not_found.
 */
export function internalSessionCommand(): Command {
  const cmd = new Command("session").description("Pre-approved session management.");

  cmd
    .command("create")
    .description("Mint a session pattern. Opens the approval UI for the human to approve the SHAPE.")
    .requiredOption("--actions <list>", "Comma-separated SessionActions: template-run | inject-submit | reveal-capture | secrets-set")
    .requiredOption("--ref-glob <glob>", "Literal prefix + optional trailing * (e.g. ss://stripe/prod/*). Empty string = no ref check.")
    .option("--destination-domain <domain>", "Allowed destination domain (repeatable)", collectRepeated, [])
    .option("--template-id <id>", "Restrict to specific template_id (repeatable)", collectRepeated, [])
    .option("--allowed-action <action>", "For secrets-set patterns: REQUIRED ⊇ for binding.allowed_actions. Repeatable. Valid: capture_from_page | inject_into_field | compare_fingerprint | use_as_stdin | inject_submit.", collectRepeated, [])
    .option("--ttl <ms>", "TTL in ms after approval; max 3600000 (60min); default 300000 (5min)", (v) => Number.parseInt(v, 10), 5 * 60 * 1000)
    .option("--max-uses <n>", "Usage cap (1-1000)", (v) => Number.parseInt(v, 10))
    .option("--no-wait", "Return session_id immediately with status:pending")
    .option("--json", "Forward-compat no-op", false)
    .action(async (options) => {
      const allowedActions = options.allowedAction as string[];
      const body = {
        pattern: {
          actions: (options.actions as string).split(",").map((s) => s.trim()),
          ref_glob: options.refGlob,
          destination_domains: options.destinationDomain,
          ...((options.templateId as string[]).length > 0 ? { template_ids: options.templateId } : {}),
          ...(allowedActions.length > 0 ? { allowed_actions: allowedActions } : {}),
          ttl_ms: options.ttl,
          ...(options.maxUses !== undefined ? { max_uses: options.maxUses } : {}),
        },
        ...(options.wait === false ? { wait_for_approval: false } : {}),
      };
      const r = await daemonRequest("POST", "/v1/approvals/session", body);
      outputJson(ok(r as Record<string, unknown>));
    });

  cmd
    .command("list")
    .description("List all sessions (pending, granted, expired, denied, revoked).")
    .option("--json", "Forward-compat no-op", false)
    .action(async () => {
      const r = await daemonRequest("GET", "/v1/approvals/sessions");
      outputJson(ok(r as Record<string, unknown>));
    });

  cmd
    .command("revoke")
    .argument("<session-id>", "Session id")
    .description("Revoke a session. Subsequent uses fail with session_not_found.")
    .option("--json", "Forward-compat no-op", false)
    .action(async (sessionId: string) => {
      const r = await daemonRequest("POST", "/v1/approvals/sessions/revoke", { session_id: sessionId });
      outputJson(ok(r as Record<string, unknown>));
    });

  return cmd;
}
