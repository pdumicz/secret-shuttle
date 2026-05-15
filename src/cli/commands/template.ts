import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { normalizeRef } from "./helpers.js";

export function templateCommand(): Command {
  const c = new Command("template").description("Run vetted command templates.");
  c.command("list").action(async () => {
    const r = await daemonRequest("POST", "/v1/templates/list", {});
    outputJson(ok(r as Record<string, unknown>));
  });
  c.command("run <template-id>")
    .requiredOption("--ref <ref>", "Secret ref.")
    .option("--param <key=value>", "Template parameter.", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (id: string, options) => {
      const params: Record<string, string> = {};
      for (const kv of options.param as string[]) {
        const eq = kv.indexOf("=");
        if (eq === -1) continue;
        params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const body: Record<string, unknown> = {
        template_id: id,
        ref: normalizeRef(options.ref),
        params,
        wait_for_approval: options.wait !== false,
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/templates/run", body);
      outputJson(ok(r as Record<string, unknown>));
    });
  return c;
}
