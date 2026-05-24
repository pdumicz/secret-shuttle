import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { parseEnvFile } from "../run/env-file.js";
import { streamingDaemonRequest, streamLineDelimitedJson } from "../../client/streaming-request.js";
import { daemonErrorFromPayload } from "../../client/daemon-client.js";
import { ShuttleError } from "../../shared/errors.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

export function runCommand(): Command {
  const cmd = new Command("run")
    .description(
      "Run a command with secrets resolved into its env. " +
        "The daemon spawns the child and masks resolved values in stdout/stderr before relaying.",
    )
    .option(
      "--env-file <path>",
      "Path to env file. Entries: KEY=VALUE; ss:// values are resolved by the daemon. Optional; combine with --stdin or use --stdin alone.",
    )
    .option(
      "--stdin <ref>",
      "Secret ref to pipe to the child's stdin (fd 0). The CLI never sees the value; the daemon writes it directly. Composable with --env-file. Production refs are approval-gated.",
    )
    .option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
    .option("--no-wait", "Return approval_required without waiting.")
    .option(
      "--json",
      "Forward-compat no-op (this command always streams).",
      false,
    )
    .argument("[command...]", "Command and args to run (after `--`).");
  addApprovalIdOption(cmd);
  return cmd.action(async (command: string[], options: Record<string, unknown>) => {
      if (command.length === 0) {
        throw new ShuttleError("missing_param", "Specify the command to run after `--`.");
      }
      if (options.envFile === undefined && options.stdin === undefined) {
        throw new ShuttleError(
          "missing_param",
          "At least one of --env-file or --stdin must be supplied.",
        );
      }

      let entries: Array<{ key: string; value: string; isRef: boolean }> = [];
      let refs: string[] = [];
      if (options.envFile !== undefined) {
        let envFileContent: string;
        try {
          envFileContent = await readFile(options.envFile as string, "utf8");
        } catch {
          throw new ShuttleError(
            "env_file_not_found",
            `env file not found: ${options.envFile as string}`,
          );
        }
        const parsed = parseEnvFile(envFileContent);
        entries = parsed.entries;
        refs = entries.filter((e) => e.isRef).map((e) => e.value);
      }

      const body: Record<string, unknown> = {
        refs,
        env: entries,
        command: command[0],
        // Send everything after the first positional as args.
        args: command.slice(1),
        // Send the CLI's cwd so the child runs in the caller's project, not the daemon's.
        cwd: process.cwd(),
      };
      if (options.stdin !== undefined) body.stdin_ref = options.stdin;
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
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
  # .env file contains refs:
  secret-shuttle run --env-file=.env -- npm start

  # Pipe a secret to a CLI that reads from stdin:
  secret-shuttle run --stdin=ss://local/prod/DOCKERHUB_TOKEN -- \\
    docker login -u myuser --password-stdin docker.io

  # Combine env-file + stdin (tool needs both):
  secret-shuttle run --env-file=.env --stdin=ss://local/prod/GH_TOKEN -- \\
    gh auth login --with-token

  # With pre-issued approval for production refs (after --no-wait round-trip):
  secret-shuttle run --env-file=.env --no-wait --approval-id <id> -- vercel deploy

  # Combined env-file + stdin with multiple approvals (--no-wait + retry):
  secret-shuttle run --env-file=.env --stdin=ss://local/prod/TOKEN --no-wait \\
    -- gh auth login --with-token
  # → emits approval_required; read both ids from details.approvals,
  #   approve them in the hub, then retry with both --approval-id flags:
  secret-shuttle run --env-file=.env --stdin=ss://local/prod/TOKEN --no-wait \\
    --approval-id <env-id> --approval-id <stdin-id> \\
    -- gh auth login --with-token

Notes:
  - Refs are resolved by the daemon, never the CLI. The child gets them
    as env vars (--env-file) or as bytes on fd 0 (--stdin).
  - Non-ref entries in --env-file pass through verbatim.
  - Resolved secret values are best-effort MASKED in the child's
    stdout/stderr before they reach this CLI. A hostile child can still
    exfiltrate via network; masking is defense-in-depth.
  - Production refs require approval. Use --no-wait to receive
    approval ids immediately (single id under error.message JSON, OR
    multiple ids under details.approvals for combined env+stdin).
    Retry with --approval-id <id> (repeatable for each pending approval).
  - The child runs in the CURRENT working directory (this CLI's cwd).
  - --stdin and --env-file cannot reference the SAME ref. Combining
    them returns stdin_ref_in_env_file (exit 2).
`,
    );
}
