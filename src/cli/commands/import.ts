import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { parseEnvFile } from "../run/env-file.js";
import { addApprovalIdOption } from "./_approval-id-option.js";
import { ShuttleError } from "../../shared/errors.js";

export function importCommand(): Command {
  const cmd = new Command("import")
    .description("Import secrets from a .env file into the vault.")
    .requiredOption("--env-file <path>", "Path to the .env file.")
    .option(
      "--source <name>",
      "Vault source for the imported refs (default: local).",
      "local",
    )
    .option(
      "--env <name>",
      "Environment (default: development).",
      "development",
    )
    .option(
      "--force",
      "Overwrite existing refs with the same (source, env, key).",
      false,
    )
    .option(
      "--skip-existing",
      "Skip entries whose ref already exists (do not error).",
      false,
    )
    .option("--session <id>", "Use a pre-approved session id.");
  addApprovalIdOption(cmd);
  return cmd
    .action(async (options) => {
      let content: string;
      try {
        content = await readFile(options.envFile as string, "utf-8");
      } catch {
        throw new ShuttleError(
          "env_file_not_found",
          `Could not read env file: ${options.envFile as string}`,
        );
      }

      const parsed = parseEnvFile(content);

      // Skip entries whose value is already a vault ref (ss://...).
      const entries = parsed.entries.filter((e) => !e.isRef);
      const skipped_already_refs = parsed.entries
        .filter((e) => e.isRef)
        .map((e) => e.key);

      if (skipped_already_refs.length > 0) {
        process.stderr.write(
          `Warning: skipping ${skipped_already_refs.length} entr${skipped_already_refs.length === 1 ? "y" : "ies"} whose value is already a vault ref: ${skipped_already_refs.join(", ")}\n`,
        );
      }

      const body: Record<string, unknown> = {
        entries: entries.map((e) => ({ key: e.key, value: e.value })),
        source: options.source as string,
        environment: options.env as string,
        force: (options.force as boolean) === true,
        skip_existing: (options.skipExisting as boolean) === true,
      };
      if ((options.session as string | undefined) !== undefined) {
        body["session_id"] = options.session as string;
      }
      if ((options.approvalId as string[] | undefined) !== undefined) {
        body["approval_ids"] = options.approvalId as string[];
      }

      const r = await daemonRequest<{
        imported: number;
        skipped: number;
        refs: string[];
        skipped_existing: string[];
      }>("POST", "/v1/secrets/import", body);

      outputJson(
        ok({
          imported: r.imported,
          skipped: r.skipped + skipped_already_refs.length,
          refs: r.refs,
          skipped_existing: r.skipped_existing,
          skipped_already_refs,
        }),
      );
    })
    .addHelpText(
      "after",
      `
Examples:
  # Import .env into the vault as development secrets:
  secret-shuttle import --env-file .env

  # Import as production (requires approval):
  secret-shuttle import --env-file .env.production --env production

  # Skip entries that already exist instead of erroring:
  secret-shuttle import --env-file .env --skip-existing

  # Overwrite entries that already exist:
  secret-shuttle import --env-file .env --force

  # Custom source name (e.g., for a particular provider):
  secret-shuttle import --env-file .env --source stripe --env production

Exit codes:
  0  Success
  2  Usage error (missing required flag, bad env file)
  3  File not found (env file missing)
  4  Permission (approval denied, vault locked)
  5  Conflict (ref already exists; re-run with --force or --skip-existing)
`,
    );
}
