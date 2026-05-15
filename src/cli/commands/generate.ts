import { Command } from "commander";
import { writeAuditEvent } from "../../logging/logger.js";
import { ok, outputJson } from "../../shared/result.js";
import { loadOrCreateMasterKey } from "../../vault/keychain.js";
import { Vault } from "../../vault/vault.js";
import { collectRepeated, generateSecretValue } from "./helpers.js";

export function generateCommand(): Command {
  return new Command("generate")
    .description("Generate and store a new secret locally. The raw value is never printed.")
    .requiredOption("--name <name>", "Secret name, for example INTERNAL_CRON_SECRET.")
    .requiredOption("--env <environment>", "Environment, for example production.")
    .option("--source <source>", "Secret source namespace.", "local")
    .option("--kind <kind>", "Secret kind.", "random_32_bytes")
    .option("--allow-domain <domain>", "Allowed destination domain. Can be repeated.", collectRepeated, [])
    .option("--description <description>", "Non-secret description.")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .action(async (options) => {
      const value = generateSecretValue(options.kind);
      const key = await loadOrCreateMasterKey();
      const vault = new Vault(() => key);
      const metadata = await vault.upsertSecret({
        name: options.name,
        environment: options.env,
        source: options.source,
        value,
        description: options.description,
        allowedDomains: options.allowDomain,
        force: options.force,
      });
      await writeAuditEvent({
        action: "generate",
        ok: true,
        ref: metadata.ref,
        environment: metadata.environment,
      });
      outputJson(ok({
        generated: true,
        secret_ref: metadata.ref,
        name: metadata.name,
        environment: metadata.environment,
        source: metadata.source,
        fingerprint: metadata.fingerprint,
        value_visible_to_agent: false,
      }));
    });
}
