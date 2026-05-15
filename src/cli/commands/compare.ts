import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { assertCaptureSource, normalizeRef } from "./helpers.js";

export function compareCommand(): Command {
  return new Command("compare")
    .description("Compare selected text or focused field against a stored secret via the daemon.")
    .requiredOption("--ref <ref>")
    .option("--with <source>", "focused-field or selection.", "focused-field")
    .option("--domain <domain>")
    .action(async (options) => {
      assertCaptureSource(options.with);
      const body: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        with: options.with,
      };
      if (options.domain !== undefined) body.domain = options.domain;
      const r = await daemonRequest("POST", "/v1/secrets/compare", body);
      outputJson(ok(r as Record<string, unknown>));
    });
}
