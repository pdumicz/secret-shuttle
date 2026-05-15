import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Initialize local Secret Shuttle storage (delegates to daemon).")
    .action(async () => {
      const r = await daemonRequest<{ unlocked: boolean }>("GET", "/v1/status");
      outputJson(ok({
        initialized: true,
        daemon_running: true,
        unlocked: r.unlocked,
        raw_secret_read_api: false,
        value_visible_to_agent: false,
      }));
    });
}
