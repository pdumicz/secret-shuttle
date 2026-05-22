import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { collectRepeated } from "../helpers.js";
import { ShuttleError } from "../../../shared/errors.js";
import { canonicalEnvironment } from "../../../shared/refs.js";

export function secretsSetCommand(): Command {
  return new Command("set")
    .description("Store a new secret in the vault. Returns a ref; the value is never returned to the caller.")
    .requiredOption("--name <name>", "Logical secret name (e.g. STRIPE_WEBHOOK_SECRET).")
    .requiredOption("--env <environment>", "Environment (e.g. production, preview, local).")
    .option("--source <source>", "Source namespace (e.g. stripe, supabase, local).", "local")
    .option("--kind <kind>", "Generation kind: random_32_bytes | random_24_chars | ... (paste not yet supported)", "random_32_bytes")
    .option("--allow-domain <domain>", "Domain allow-list for inject (repeatable).", collectRepeated, [])
    .option("--allow-action <action>", "Allowed action (repeatable).", collectRepeated, [])
    .option("--description <description>", "Free-form description (stored in metadata).")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>", "Pre-issued approval id (skip the approval window).")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Emit machine-readable JSON (default — flag is a no-op for forward compatibility).", false)
    .action(async (options) => {
      // Paste mode is not yet supported. (User-facing copy must NOT mention
      // internal plan numbers — say what works now.)
      if (options.kind === "paste") {
        throw new ShuttleError(
          "unsupported_secret_kind",
          "--kind paste is not yet supported. Use a random kind (e.g. --kind random_32_bytes) or capture from a provider page with 'reveal-capture'.",
        );
      }

      const domains = options.allowDomain as string[];
      if (canonicalEnvironment(options.env) === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        kind: options.kind,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      const actions = options.allowAction as string[];
      if (actions.length > 0) body.allowed_actions = actions;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/generate", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Generate a 32-byte random secret for production:
  secret-shuttle secrets set --name INTERNAL_CRON_SECRET --env production --kind random_32_bytes \\
    --allow-domain vercel.com

  # Generate a 24-char random secret for local dev:
  secret-shuttle secrets set --name DEV_SESSION_KEY --env local --kind random_24_chars

Exit codes:
  0  Success
  2  Usage error (missing required flag, bad --kind, etc.)
  4  Permission (approval denied, vault locked)
  5  Conflict (ref already exists; re-run with --force, or use 'secrets rotate' for explicit rotation)
`);
}
