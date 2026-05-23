import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";

export function injectCommand(): Command {
  return new Command("inject")
    .description("Render a template with ss:// refs resolved; daemon writes the file at mode 0600 inside $HOME.")
    .requiredOption("-i, --input <path>", "Template file containing ss:// refs.")
    .requiredOption("-o, --output <path>", "Output file path (must resolve inside $HOME), or '-' for stdout.")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Forward-compat no-op (always emits JSON).", false)
    .action(async (options) => {
      let template: string;
      try {
        template = await readFile(options.input, "utf8");
      } catch {
        throw new ShuttleError("inject_template_parse_error", `Cannot read template: ${options.input}`);
      }

      // Absolutize the output path against the CLI's cwd BEFORE sending it.
      // The daemon then realpaths the parent and refuses anything outside $HOME.
      // Without absolutizing here, the daemon would resolve relative paths
      // against ITS cwd, which is almost never what the user means.
      const outputArg: string = options.output;
      const outputPathForDaemon =
        outputArg === "-" ? "-" : path.resolve(process.cwd(), outputArg);

      const body: Record<string, unknown> = {
        template,
        output_path: outputPathForDaemon,
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.session !== undefined) body.session_id = options.session;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/inject/render", body);
      const result = r as unknown as { rendered: boolean; refs_count: number; output_path?: string; content?: string };
      if (outputPathForDaemon === "-" && typeof result.content === "string") {
        // Documented "bytes pass through CLI" mode. Print content to stdout
        // and a JSON summary on stderr (so callers piping stdout still get
        // the summary).
        process.stdout.write(result.content);
        process.stderr.write(JSON.stringify(ok({ rendered: true, refs_count: result.refs_count, output_path: "-" }), null, 2) + "\n");
        return;
      }
      outputJson(ok({ rendered: result.rendered, refs_count: result.refs_count, output_path: result.output_path }));
    })
    .addHelpText("after", `
Examples:
  # Render config.yml.tpl into config.yml (mode 0600, daemon-written):
  secret-shuttle inject -i config.yml.tpl -o config.yml

  # Print rendered content to stdout (warning: bytes pass through this CLI):
  secret-shuttle inject -i config.yml.tpl -o -

Template format:
  Any text file containing 'ss://source/env/NAME' refs. The daemon validates
  every candidate via the canonical ref parser (the same one used by the
  vault), so partial matches and trailing punctuation are left as literal text.

Output path security:
  - The CLI absolutizes -o against its cwd before sending.
  - The daemon refuses any output_path whose parent realpath is outside \$HOME.
  - The daemon refuses to write through a leaf symlink.
  - The file is written via an O_EXCL temp file at mode 0600, then renamed.
    No moment when the file is empty or partially-written at the final path.
  - Use '-' for stdout if you need to pipe to another process — note the
    rendered bytes pass through this CLI in that mode.
`);
}
