import { spawn } from "node:child_process";
import { ShuttleError } from "../../shared/errors.js";
import { assertSafeExecutable } from "../safe-executable.js";
import type { TemplateDefinition } from "./registry.js";

export interface TemplateRunInput {
  template: TemplateDefinition;
  params: Record<string, string>;
  secret: string;
  /** When provided, the binary's SHA-256 is re-verified before exec (TOCTOU defense). */
  expectedSha256?: string;
}

export interface TemplateRunResult {
  template_id: string;
  exit_code: number;
}

const PARAM_RE = /\{\{([a-z_][a-z0-9_]*)\}\}/g;

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

  const expandedArgs = input.template.args.map((a) =>
    a.replace(PARAM_RE, (_m, k: string) => {
      const v = input.params[k];
      if (typeof v !== "string") throw new ShuttleError("missing_param", `Missing param: ${k}`);
      return v;
    }),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedBinary, expandedArgs, {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
    child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
    child.stdin.end(input.secret);
  });
}
