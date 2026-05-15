import { Command } from "commander";
import { ok, outputJson } from "../../shared/result.js";
import { loadOrCreateMasterKey } from "../../vault/keychain.js";
import { Vault } from "../../vault/vault.js";
import { normalizeRef } from "./helpers.js";

export function inspectCommand(): Command {
  return new Command("inspect")
    .description("Inspect secret metadata. Raw values are never returned.")
    .argument("<ref>", "Secret Shuttle ref, for example ss://stripe/prod/STRIPE_WEBHOOK_SECRET.")
    .action(async (ref: string) => {
      const key = await loadOrCreateMasterKey();
      const vault = new Vault(() => key);
      const metadata = await vault.inspect(normalizeRef(ref));
      outputJson(ok({
        secret: metadata,
        value_visible_to_agent: false,
      }));
    });
}
