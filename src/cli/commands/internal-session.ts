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
    .option("--required-param <k=v>", "Repeatable: param key=value constraint for template-run patterns (e.g. --required-param environment=production)", collectRepeated, [])
    .option("--ttl <ms>", "TTL in ms after approval; max 3600000 (60min); default 300000 (5min)", (v) => Number.parseInt(v, 10), 5 * 60 * 1000)
    .option("--max-uses <n>", "Usage cap (1-1000)", (v) => Number.parseInt(v, 10))
    .option("--no-wait", "Return session_id immediately with status:pending")
    .option("--json", "Forward-compat no-op", false)
    .action(async (options) => {
      const body = buildSessionCreateBody({
        actions: (options.actions as string).split(",").map((s) => s.trim()),
        refGlob: options.refGlob as string,
        templateIds: options.templateId as string[],
        destinationDomains: options.destinationDomain as string[],
        allowedActions: options.allowedAction as string[],
        requiredParam: options.requiredParam as string[],
        ttlMs: options.ttl as number,
        ...(options.maxUses !== undefined ? { maxUses: options.maxUses as number } : {}),
        ...(options.wait === false ? { waitForApproval: false } : {}),
      });
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

export interface SessionCreateInput {
  actions: string[];
  refGlob: string;
  templateIds?: string[];
  destinationDomains?: string[];
  allowedActions?: string[];
  requiredParam?: string[];
  ttlMs: number;
  maxUses?: number;
  waitForApproval?: boolean;
}

/**
 * Pure helper: assemble the body for POST /v1/approvals/session from CLI-style
 * input. Exported so unit tests can exercise the --required-param k=v parsing
 * + omit-when-empty conditional spread without a live daemon.
 */
export function buildSessionCreateBody(input: SessionCreateInput): {
  pattern: Record<string, unknown>;
  wait_for_approval?: boolean;
} {
  const required_params: Record<string, string> = {};
  for (const kv of input.requiredParam ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--required-param value '${kv}' must be in k=v form`);
    }
    required_params[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const pattern: Record<string, unknown> = {
    actions: input.actions,
    ref_glob: input.refGlob,
    destination_domains: input.destinationDomains ?? [],
    ttl_ms: input.ttlMs,
  };
  if ((input.templateIds ?? []).length > 0) {
    pattern.template_ids = input.templateIds;
  }
  if ((input.allowedActions ?? []).length > 0) {
    pattern.allowed_actions = input.allowedActions;
  }
  if (input.maxUses !== undefined) {
    pattern.max_uses = input.maxUses;
  }
  if (Object.keys(required_params).length > 0) {
    pattern.required_params = required_params;
  }
  const body: { pattern: Record<string, unknown>; wait_for_approval?: boolean } = { pattern };
  if (input.waitForApproval === false) body.wait_for_approval = false;
  return body;
}
