import { spawn } from "node:child_process";
import { buildChildEnv } from "../safe-env.js";
import { ShuttleError } from "../../shared/errors.js";
import { assertSafeExecutable } from "../safe-executable.js";
import type { TemplateDefinition } from "./registry.js";
import { writeSecretEnvFile, unlinkSecretEnvFile } from "./tmp-env-file.js";

export interface TemplateRunInput {
  template: TemplateDefinition;
  params: Record<string, string>;
  secret: string;
  /** When provided, the binary's SHA-256 is re-verified before exec (TOCTOU defense). */
  expectedSha256?: string;
  /**
   * Daemon-owned tmp dir for the tmp_env_file_0600 secret-delivery branch.
   * Required iff template.secret_delivery === "tmp_env_file_0600"; ignored for stdin.
   */
  tmpDir?: string;
}

export interface TemplateRunResult {
  template_id: string;
  exit_code: number;
}

const PARAM_RE = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
const ENV_FILE_PLACEHOLDER = "{{__env_file_path__}}";

export async function runTemplate(input: TemplateRunInput): Promise<TemplateRunResult> {
  for (const p of input.template.required_params) {
    if (typeof input.params[p] !== "string" || input.params[p] === "") {
      throw new ShuttleError("missing_param", `Missing required parameter: ${p}`);
    }
  }

  input.template.validateParams?.(input.params);

  // Re-verify the hash to close the TOCTOU window between approval and exec.
  const resolvedBinary = await assertSafeExecutable(input.template.binary, {
    ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
  });

  const expandParam = (a: string) =>
    a.replace(PARAM_RE, (_m, k: string) => {
      const v = input.params[k];
      if (typeof v !== "string") throw new ShuttleError("missing_param", `Missing param: ${k}`);
      return v;
    });

  const baseExpandedArgs = input.template.args.map(expandParam);

  if (input.template.secret_delivery === "stdin") {
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedBinary, baseExpandedArgs, {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: buildChildEnv(),
      });
      child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
      child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
      child.stdin.end(input.secret);
    });
  }

  // secret_delivery === "tmp_env_file_0600"
  if (typeof input.template.value_arg_template !== "string" || input.template.value_arg_template.length === 0) {
    throw new ShuttleError(
      "template_definition_invalid",
      "tmp_env_file_0600 templates must set value_arg_template.",
    );
  }
  if (typeof input.tmpDir !== "string" || input.tmpDir.length === 0) {
    throw new ShuttleError(
      "template_tmpdir_missing",
      "tmp_env_file_0600 requires a daemon-owned tmpDir on the input.",
    );
  }

  // The env-file NAME is the template's "name" param (every tmp_env_file_0600
  // template declares "name" as a required param; the per-template
  // validateParams enforces the character class). The value is the secret.
  const envVarName = input.params["name"] ?? "SECRET";

  const { path: envFilePath } = writeSecretEnvFile({
    name: envVarName,
    value: input.secret,
    tmpDir: input.tmpDir,
  });

  try {
    // Substitute the env-file path placeholder BEFORE param-expansion so that
    // PARAM_RE (which matches [a-z_][a-z0-9_]*) does not try to look up
    // "__env_file_path__" as a user-supplied param.
    const rawValueArg = input.template.value_arg_template.replace(ENV_FILE_PLACEHOLDER, envFilePath);
    const valueArg = expandParam(rawValueArg);
    const finalArgs = [...baseExpandedArgs, valueArg];
    return await new Promise<TemplateRunResult>((resolve, reject) => {
      const child = spawn(resolvedBinary, finalArgs, {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        env: buildChildEnv(),
      });
      child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
      child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
    });
  } finally {
    unlinkSecretEnvFile(envFilePath);
  }
}
