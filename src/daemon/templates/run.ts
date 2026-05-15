import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";
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
  await assertSafeBinary(input.template.binary);

  // Re-verify the hash to close the TOCTOU window between approval and exec.
  if (input.expectedSha256 !== undefined) {
    const actual = createHash("sha256").update(await readFile(input.template.binary)).digest("hex");
    if (actual !== input.expectedSha256) {
      throw new ShuttleError("binary_hash_mismatch", "Template binary changed since approval.");
    }
  }

  const expandedArgs = input.template.args.map((a) =>
    a.replace(PARAM_RE, (_m, k: string) => {
      const v = input.params[k];
      if (typeof v !== "string") throw new ShuttleError("missing_param", `Missing param: ${k}`);
      return v;
    }),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(input.template.binary, expandedArgs, {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
    child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
    child.stdin.end(input.secret);
  });
}

async function assertSafeBinary(binary: string): Promise<void> {
  if (!path.isAbsolute(binary)) {
    throw new ShuttleError("unsafe_binary_path", "Template binary must be an absolute path.");
  }
  const resolved = path.resolve(binary);
  const cwd = path.resolve(process.cwd());
  if (resolved.startsWith(`${cwd}${path.sep}`) || resolved === cwd) {
    throw new ShuttleError("unsafe_binary_path", "Template binary must not live under the current workspace.");
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new ShuttleError("unsafe_binary_path", "Template binary is not a regular file.");
    if ((info.mode & 0o002) !== 0) {
      throw new ShuttleError("unsafe_binary_path", "Template binary is world-writable.");
    }
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    throw new ShuttleError("unsafe_binary_path", "Template binary not found.");
  }
}
