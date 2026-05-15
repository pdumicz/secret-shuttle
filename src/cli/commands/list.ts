import { Command } from "commander";
import { ok, outputJson } from "../../shared/result.js";
import { Vault } from "../../vault/vault.js";

export function listCommand(): Command {
  return new Command("list")
    .description("List secret metadata only.")
    .option("--env <environment>", "Filter by environment.")
    .option("--source <source>", "Filter by source.")
    .action(async (options) => {
      const vault = new Vault();
      const secrets = await vault.list({
        environment: options.env,
        source: options.source,
      });
      outputJson(ok({
        secrets,
        value_visible_to_agent: false,
      }));
    });
}
