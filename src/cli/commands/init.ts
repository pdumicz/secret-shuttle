import { Command } from "commander";
import { writeAuditEvent } from "../../logging/logger.js";
import { ok, outputJson } from "../../shared/result.js";
import { loadOrCreateMasterKey } from "../../vault/keychain.js";
import { Vault } from "../../vault/vault.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Initialize local Secret Shuttle storage.")
    .action(async () => {
      const key = await loadOrCreateMasterKey();
      const vault = new Vault(() => key);
      const result = await vault.ensureInitialized();
      await writeAuditEvent({ action: "init", ok: true });
      outputJson(ok({
        initialized: true,
        created: result.created,
        vault_path: result.vaultPath,
        raw_secret_read_api: false,
        value_visible_to_agent: false,
      }));
    });
}
