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

  c.addHelpText("after", `
Examples:
  # Start the daemon-controlled browser (default profile "prod-config"):
  secret-shuttle browser start

  # Start with a specific profile:
  secret-shuttle browser start --profile dev-config

  # Mark the currently focused element as "api-key-field":
  secret-shuttle browser mark focused --as api-key-field

  # Mark an element via the inspect overlay (click to pick):
  secret-shuttle browser mark pick --as submit-button

  # Mark via inspect overlay with a longer wait window:
  secret-shuttle browser mark pick --as reveal-link --timeout-ms 60000

  # List all currently active marks (metadata only — no secret values):
  secret-shuttle browser marks
`);

  return c;
}
