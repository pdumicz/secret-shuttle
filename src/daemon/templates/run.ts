import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { buildChildEnv } from "../safe-env.js";
import { ShuttleError } from "../../shared/errors.js";
import { assertSafeExecutable } from "../safe-executable.js";
import type { TemplateDefinition } from "./registry.js";
import { assertNoPaddedParams } from "./registry.js";
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

/**
 * Test-only hook. When set, the stdin-delivery branch invokes this with the
 * local secretBuf and the child's stdin stream so tests can (a) assert that
 * the Buffer is zeroed after the write, (b) inject errors on stdin to exercise
 * the error/close fallback path. NEVER set this outside of tests.
 */
let __testStdinObserver: ((buf: Buffer, stdin: Writable) => void) | undefined;
export function __setStdinObserverForTesting(
  fn: ((buf: Buffer, stdin: Writable) => void) | undefined,
): void {
  __testStdinObserver = fn;
}

export async function runTemplate(input: TemplateRunInput): Promise<TemplateRunResult> {
  for (const p of input.template.required_params) {
    if (typeof input.params[p] !== "string" || input.params[p] === "") {
      throw new ShuttleError("missing_param", `Missing required parameter: ${p}`);
    }
  }

  // Reject padded params (closes the production-approval-bypass class).
  // Called here as defense in depth — the templates route ALSO calls this
  // before destinationEnvironment / binding / approval, so the approval UI
  // never sees the misleading padded destination. This call is the runtime
  // backstop in case runTemplate is invoked outside the route.
  assertNoPaddedParams(input.params);

  // Defense-in-depth: freeze params so a buggy/malicious template callback
  // (validateParams, destinationEnvironment, additionalArgs) cannot mutate
  // the object and create a divergence between what the human approved
  // (destinationEnvironment) and what the child actually receives (argv /
  // env-file NAME). The whole point of this layer is that the human's
  // consent matches the executed action. Object.freeze in ESM throws on
  // mutation attempts (strict mode), so this is the catch-mutation primitive.
  Object.freeze(input.params);

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
  const additionalArgs = input.template.additionalArgs?.(input.params) ?? [];
  if (!Array.isArray(additionalArgs) || !additionalArgs.every((a) => typeof a === "string")) {
    throw new ShuttleError(
      "template_definition_invalid",
      "additionalArgs must return string[].",
    );
  }

  if (input.template.secret_delivery === "stdin") {
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedBinary, [...baseExpandedArgs, ...additionalArgs], {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: buildChildEnv(),
      });
      child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
      child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));

      // Hold the bytes-to-write in a local Buffer so they're zeroable. (input.secret
      // is a string today — the immutable plaintext copy lingers until GC; the
      // Buffer-throughout refactor is Phase 5q. Until then, zeroing the Buffer that
      // child.stdin actually flushes is the best we can do here.)
      //
      // The PRIMARY scrub is the .end(buf, cb) callback: Node may retain the same
      // Buffer reference until the write completes, so zeroing BEFORE the callback
      // could clobber not-yet-flushed bytes. error/close fallbacks handle abnormal
      // termination (child crashes pre-write, stdin pipe errors). The scrub helper
      // is idempotent so triple-fire (error + close + cb) is safe.
      const secretBuf = Buffer.from(input.secret, "utf8");
      let scrubbed = false;
      const scrub = (): void => {
        if (scrubbed) return;
        scrubbed = true;
        secretBuf.fill(0);
      };
      child.stdin.once("error", scrub);
      child.stdin.once("close", scrub);
      // Hand the Buffer (and stdin handle) to the test observer BEFORE .end()
      // so tests can either retain a reference for post-resolve assertions, or
      // synthesize an error on the stdin to exercise the fallback path.
      __testStdinObserver?.(secretBuf, child.stdin);
      child.stdin.end(secretBuf, () => { scrub(); });
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
  const envVarName = input.params["name"];
  if (typeof envVarName !== "string" || envVarName === "") {
    throw new ShuttleError(
      "template_definition_invalid",
      "tmp_env_file_0600 templates must accept a 'name' param (used as the env-file NAME).",
    );
  }

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
    const finalArgs = [...baseExpandedArgs, ...additionalArgs, valueArg];
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
