import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { parseEnvFile } from "../run/env-file.js";
import { streamingDaemonRequest, streamLineDelimitedJson } from "../../client/streaming-request.js";
import { daemonErrorFromPayload } from "../../client/daemon-client.js";
import { ShuttleError } from "../../shared/errors.js";

export function runCommand(): Command {
  return new Command("run")
    .description(
      "Run a command with secrets resolved into its env. " +
        "The daemon spawns the child and masks resolved values in stdout/stderr before relaying.",
    )
    .requiredOption(
      "--env-file <path>",
      "Path to env file. Entries: KEY=VALUE; ss:// values are resolved by the daemon.",
    )
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
    .option("--no-wait", "Return approval_required without waiting.")
    .option(
      "--json",
      "Forward-compat no-op (this command always streams).",
      false,
    )
    .argument("[command...]", "Command and args to run (after `--`).")
    .action(async (command: string[], options: Record<string, unknown>) => {
      if (command.length === 0) {
        throw new ShuttleError("missing_param", "Specify the command to run after `--`.");
      }

      let envFileContent: string;
      try {
        envFileContent = await readFile(options.envFile as string, "utf8");
      } catch {
        throw new ShuttleError(
          "env_file_not_found",
          `env file not found: ${options.envFile as string}`,
        );
      }

      const { entries } = parseEnvFile(envFileContent);
      const refs = entries.filter((e) => e.isRef).map((e) => e.value);

      const body: Record<string, unknown> = {
        refs,
        env: entries,
        command: command[0],
        // Send everything after the first positional as args.
        args: command.slice(1),
        // Send the CLI's cwd so the child runs in the caller's project, not the daemon's.
        cwd: process.cwd(),
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.session !== undefined) body.session_id = options.session;
      if (options.wait === false) body.wait_for_approval = false;

      // Wire SIGINT/SIGTERM → AbortController → fetch cancel → daemon
      // res.on("close") → SIGTERM-the-child. Use { once: true } semantics so
      // signal handlers don't accumulate across repeated invocations in tests.
      const controller = new AbortController();
      let cancelledByUser = false;
      const onSignal = (): void => {
        cancelledByUser = true;
        controller.abort();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      let exitCode = 0;
      let streamError: ShuttleError | undefined;

      try {
        const stream = await streamingDaemonRequest("POST", "/v1/run/resolve", body, {
          signal: controller.signal,
        });

        await streamLineDelimitedJson(stream, (line) => {
          if ("stream" in line) {
            const buf = Buffer.from(line.data, "base64");
            if (line.stream === "stdout") process.stdout.write(buf);
            else process.stderr.write(buf);
          } else if ("exit" in line) {
            exitCode = line.exit;
          } else if ("error" in line) {
            // Preserve daemon-provided hint + exit_code via the canonical helper.
            //
            // CRITICAL: only include `hint` / `exit_code` when the stream line
            // actually carries them. daemon-client.ts treats an explicit `null`
            // hint as "suppress the registry default" — so blindly forwarding
            // `hint: null` would override the registry hint for codes like
            // daemon_not_running, where the registry hint is the whole point.
            const payload: Record<string, unknown> = {
              error: { code: line.error.code, message: line.error.message },
              error_code: line.error.code,
              message: line.error.message,
            };
            if (line.error.hint !== undefined) payload.hint = line.error.hint;
            if (line.error.exit_code !== undefined) payload.exit_code = line.error.exit_code;
            streamError = daemonErrorFromPayload(payload);
          }
        });
      } catch (e) {
        // fetch/stream aborted because the user pressed Ctrl-C or sent SIGTERM.
        // POSIX convention: 128 + SIGINT(2) = 130. Any other error rethrows to
        // the CLI top-level error handler.
        if (cancelledByUser) {
          process.exitCode = 130;
          return;
        }
        throw e;
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }

      // If the daemon emitted an `{ error }` stream line, throw it so the
      // CLI top-level handler (index.ts) reads ShuttleError.exitCode and emits
      // the structured JSON. Do this BEFORE applying exitCode.
      if (streamError !== undefined) throw streamError;
      process.exitCode = exitCode;
    })
    .addHelpText(
      "after",
      `
Examples:
  # .env file contains:
  #   STRIPE_KEY=ss://stripe/prod/STRIPE_KEY
  #   PORT=3000
  secret-shuttle run --env-file=.env -- npm start

  # With pre-issued approval for production refs:
  secret-shuttle run --env-file=.env --approval-id <id> -- vercel deploy

Notes:
  - Refs are resolved by the daemon, never the CLI. The child process gets
    them as plain env vars in its env block.
  - Non-ref entries (e.g. PORT=3000) pass through verbatim.
  - Resolved secret values are best-effort MASKED in the child's stdout/stderr
    before they reach this CLI. A hostile child can still exfiltrate via
    network; masking is defense-in-depth.
  - Production refs require approval. Use --no-wait to receive an
    approval_id immediately.
  - The child runs in the CURRENT working directory (this CLI's cwd).
  - Interactive stdin is NOT supported in v0.2.0; the child sees EOF on read.
    Plan 4 adds stdin pass-through.
`,
    );
}
