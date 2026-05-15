import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { normalizeRef } from "./helpers.js";

export function inspectCommand(): Command {
  return new Command("inspect")
    .description("Inspect secret metadata. Raw values are never returned.")
    .argument("<ref>")
    .action(async (ref: string) => {
      const r = await daemonRequest("POST", "/v1/secrets/inspect", { ref: normalizeRef(ref) });
      outputJson(ok(r as Record<string, unknown>));
    });
}
