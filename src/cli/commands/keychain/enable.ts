import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainEnableCommand(): Command {
  return new Command("enable")
    .description("Store the master key in the OS keychain so the next unlock uses Touch ID / DPAPI / libsecret instead of the passphrase UI. Requires an unlocked vault.")
    .action(async () => {
      const r = await daemonRequest<{ enrolled: boolean }>("POST", "/v1/keychain/enable");
      outputJson(ok({ enrolled: r.enrolled }));
    })
    .addHelpText("after", `
Examples:
  # Cache the master key (fires Touch ID on macOS, libsecret prompt on Linux, transparent on Windows):
  secret-shuttle keychain enable
`);
}
