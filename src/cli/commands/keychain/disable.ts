import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainDisableCommand(): Command {
  return new Command("disable")
    .description("Remove the master key from the OS keychain. Subsequent unlocks will require the passphrase UI.")
    .action(async () => {
      const r = await daemonRequest<{ removed: boolean }>("POST", "/v1/keychain/disable");
      outputJson(ok({ removed: r.removed }));
    })
    .addHelpText("after", `
Examples:
  # Remove the cached master key (subsequent unlocks use the passphrase UI):
  secret-shuttle keychain disable
`);
}
