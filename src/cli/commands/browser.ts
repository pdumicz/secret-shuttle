import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function browserCommand(): Command {
  const c = new Command("browser").description("Browser session controlled by the daemon.");

  c.command("start")
    .option("--profile <profile>", "Browser profile name.", "prod-config")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/browser/start", { profile: options.profile });
      outputJson(ok(r as Record<string, unknown>));
    });

  const mark = c.command("mark").description("Mark a UI element for the daemon to use under blind mode.");

  mark.command("focused")
    .description("Mark the currently focused element.")
    .requiredOption("--as <label>", "Opaque label to reference this element by.")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/browser/mark", { how: "focused", label: options.as });
      outputJson(ok(r as Record<string, unknown>));
    });

  mark.command("pick")
    .description("Pick an element via the browser's inspect overlay (no page event is dispatched).")
    .requiredOption("--as <label>", "Opaque label to reference this element by.")
    .option("--timeout-ms <ms>", "Max time to wait for the pick (default 30000, cap 120000).", (v) => parseInt(v, 10))
    .action(async (options) => {
      const body: Record<string, unknown> = { how: "pick", label: options.as };
      if (options.timeoutMs !== undefined) body.timeout_ms = options.timeoutMs;
      const r = await daemonRequest("POST", "/v1/browser/mark", body);
      outputJson(ok(r as Record<string, unknown>));
    });

  c.command("marks")
    .description("List active marks (non-secret metadata only).")
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/browser/marks");
      outputJson(ok(r as Record<string, unknown>));
    });

  return c;
}
