import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainStatusCommand(): Command {
  return new Command("status")
    .description("Report keychain availability + enrollment state.")
    .action(async () => {
      const r = await daemonRequest<{ available: boolean; enrolled: boolean; opted_out: boolean; vault_id: string | null }>(
        "GET",
        "/v1/keychain/status",
      );
      outputJson(ok({
        available: r.available,
        enrolled: r.enrolled,
        opted_out: r.opted_out,
        vault_id: r.vault_id,
      }));
    })
    .addHelpText("after", `
Examples:
  # Check whether the keychain is available + whether the master key is cached:
  secret-shuttle keychain status
  # → { ok: true, available: true, enrolled: true, vault_id: "..." }
`);
}
