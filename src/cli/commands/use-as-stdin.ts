import { spawn } from "node:child_process";
import { Command } from "commander";
import { writeAuditEvent } from "../../logging/logger.js";
import { redactKnownSecrets } from "../../logging/redactor.js";
import { requireApproval } from "../../policy/approvals.js";
import { assertSecretActionAllowed } from "../../policy/policy.js";
import { ok, outputJson } from "../../shared/result.js";
import { loadOrCreateMasterKey } from "../../vault/keychain.js";
import { Vault } from "../../vault/vault.js";
import { normalizeRef } from "./helpers.js";

const OUTPUT_LIMIT = 64 * 1024;

export function useAsStdinCommand(): Command {
  return new Command("use-as-stdin")
    .description("Run a command with a secret supplied on stdin. The raw value is never printed.")
    .requiredOption("--ref <ref>", "Secret Shuttle ref.")
    .requiredOption("--command <command>", "Command to run. Do not include the secret in the command string.")
    .option("--confirm-production <word>", "Non-interactive production approval. Must be PRODUCTION.")
    .option("--show-output", "Include redacted stdout/stderr in the JSON result.", false)
    .option("--no-newline", "Do not append a trailing newline to stdin.")
    .action(async (options) => {
      const ref = normalizeRef(options.ref);
      const key = await loadOrCreateMasterKey();
      const vault = new Vault(() => key);
      const secret = await vault.getSecret(ref);
      assertSecretActionAllowed(secret, "use_as_stdin");

      await requireApproval({
        secret,
        action: "use-as-stdin",
        destination: options.command,
        confirmProduction: options.confirmProduction,
      });

      const execution = await runCommandWithSecretStdin({
        command: options.command,
        secret: secret.value,
        appendNewline: options.newline,
        showOutput: options.showOutput,
      });

      await vault.markUsed(secret.ref);
      await writeAuditEvent({
        action: "use_as_stdin",
        ok: execution.exit_code === 0,
        ref: secret.ref,
        environment: secret.environment,
      });

      outputJson(ok({
        executed: execution.exit_code === 0,
        exit_code: execution.exit_code,
        secret_ref: secret.ref,
        secret_value_visible: false,
        ...(options.showOutput
          ? {
              stdout: redactKnownSecrets(execution.stdout, [secret.value]),
              stderr: redactKnownSecrets(execution.stderr, [secret.value]),
              output_truncated: execution.output_truncated,
            }
          : {}),
      }));
    });
}

async function runCommandWithSecretStdin(input: {
  command: string;
  secret: string;
  appendNewline: boolean;
  showOutput: boolean;
}): Promise<{ exit_code: number; stdout: string; stderr: string; output_truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (!input.showOutput) {
        return;
      }
      if (stdout.length < OUTPUT_LIMIT) {
        stdout += chunk.toString("utf8");
      } else {
        outputTruncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (!input.showOutput) {
        return;
      }
      if (stderr.length < OUTPUT_LIMIT) {
        stderr += chunk.toString("utf8");
      } else {
        outputTruncated = true;
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exit_code: code ?? 1,
        stdout,
        stderr,
        output_truncated: outputTruncated,
      });
    });

    child.stdin.end(input.appendNewline ? `${input.secret}\n` : input.secret);
  });
}
