import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ShuttleError } from "../../shared/errors.js";
import { ok, outputJson } from "../../shared/result.js";

export function unlockCommand(): Command {
  return new Command("unlock")
    .description("Unlock the vault through the local Secret Shuttle approval window.")
    .action(async () => {
      const session = await daemonRequest<{ session_id: string; requires_create: boolean }>(
        "POST",
        "/v1/unlock/start",
      );
      process.stderr.write("Approval window opened in your browser. Complete the unlock there.\n");

      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        const poll = await daemonRequest<{ status: string }>("POST", "/v1/unlock/poll", { session_id: session.session_id });
        if (poll.status === "unlocked") {
          outputJson(ok({ unlocked: true }));
          return;
        }
        if (poll.status === "failed") {
          throw new ShuttleError("vault_unlock_failed", "Unlock failed in the UI.");
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new ShuttleError("unlock_timeout", "Timed out waiting for unlock.");
    });
}
