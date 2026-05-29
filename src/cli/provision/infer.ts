/**
 * `provision --infer` handler. Reads .env.example + framework signals,
 * applies the rule table, returns the rendered yml + executability flag.
 *
 * Pure function (mostly) — only reads files from the supplied `cwd`,
 * never writes. The caller (provision command) decides whether to
 * write the file based on `--dry-run` / `--force` flags.
 *
 * See spec §1 "Inference mode (Item A)".
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ShuttleError } from "../../shared/errors.js";
import { inferSourceForName, type InferredSource } from "./infer-rules.js";
import { isInferYmlExecutable, type InferredPlanEntry, type InferGateIssue } from "./infer-gate.js";

const execp = promisify(exec);

export interface InferOptions {
  cwd: string;
}

export interface InferResult {
  yml: string;
  executable: boolean;
  issues: InferGateIssue[];
  plan: InferredPlanEntry[];
}

export async function runInfer(opts: InferOptions): Promise<InferResult> {
  const envExamplePath = join(opts.cwd, ".env.example");
  let envContent: string;
  try {
    envContent = await readFile(envExamplePath, "utf8");
  } catch {
    throw new ShuttleError(
      "infer_no_env_example",
      "No .env.example found in current directory. Create one listing your secret names then re-run `secret-shuttle provision --infer`.",
    );
  }

  const names = parseEnvExampleNames(envContent);
  if (names.length === 0) {
    throw new ShuttleError(
      "infer_no_env_example",
      ".env.example exists but contains no usable secret names (lines must be of the form NAME= or NAME=value with NAME matching /^[A-Z][A-Z0-9_]*$/ — uppercase letter first, then uppercase letters, digits, and underscores).",
    );
  }
  const destinations = await detectDestinations(opts.cwd);

  const entries: InferredPlanEntry[] = names.map((name) => {
    const source = inferSourceForName(name);
    return {
      secret: name,
      ref: refFor(name, source),
      source: source as InferredPlanEntry["source"], // existing source pushes placeholder
      destinations: destinations.length > 0 ? [...destinations] : [],
    };
  });

  const gate = isInferYmlExecutable(entries);
  const yml = renderYml(entries);

  return {
    yml,
    executable: gate.ok,
    issues: gate.issues,
    plan: entries,
  };
}

function parseEnvExampleNames(content: string): string[] {
  // Tighter than the dotenv standard:
  // - Names must match yml.ts's strict regex (uppercase + digits + _ only),
  //   so an infer-generated yml will always parse cleanly via
  //   parseBootstrapYml. Without this, mixed-case names slip through
  //   infer and fail at `provision --yml`.
  // - Shell-style `export VAR=` prefix is stripped so common .env.example
  //   formats don't silently drop entries.
  // - Duplicates are deduplicated first-wins; a second occurrence of a
  //   name is silently skipped (a duplicate in .env.example is almost
  //   always copy-paste, not intent). Without dedupe, the yml renderer
  //   emits two same-name keys and parseBootstrapYml throws
  //   "Map keys must be unique" at `provision --yml` time.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Strip optional `export ` prefix
    line = line.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

async function detectDestinations(cwd: string): Promise<string[]> {
  const out: string[] = [];
  if (await fileExists(join(cwd, "vercel.json"))) {
    out.push("vercel:production");
  }
  if (await fileExists(join(cwd, "wrangler.toml"))) {
    out.push("cloudflare:production");
  }
  if (await dirExists(join(cwd, ".github/workflows"))) {
    const repo = await detectGitOwnerRepo(cwd);
    out.push(repo ? `github-actions:${repo}` : "github-actions:OWNER/REPO");
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function detectGitOwnerRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execp("git config --get remote.origin.url", { cwd, encoding: "utf8" });
    const url = stdout.trim();
    // Match git@github.com:owner/repo.git OR https://github.com/owner/repo(.git)?
    const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    if (m === null) return null;
    // Capture groups are `string | undefined` under noUncheckedIndexedAccess.
    // The regex guarantees both groups capture on match; narrow explicitly.
    const owner = m[1];
    const repo = m[2];
    if (owner === undefined || repo === undefined) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

function refFor(name: string, source: InferredSource): string {
  if (source.kind === "existing") {
    return `ss://local/prod/${name}`;
  }
  // Convention: vault refs use lower-case provider; "stripe", "supabase", "openai", etc.
  // For random/capture we still pick a reasonable namespace.
  if (source.kind === "capture" && typeof source.url === "string") {
    const host = new URL(source.url).host;
    const providerHint = host.split(".").slice(-2, -1)[0] ?? "local";
    return `ss://${providerHint}/prod/${name}`;
  }
  return `ss://local/prod/${name}`;
}

function renderYml(entries: InferredPlanEntry[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Generated by \`secret-shuttle provision --infer\` on ${today}.`,
    `# Review every line. Anything marked TODO must be filled in before --continue.`,
    `version: 1`,
    `secrets:`,
  ];

  for (const e of entries) {
    lines.push(`  ${e.secret}:`);
    // source
    if (e.source.kind === "unknown") {
      lines.push(`    source: { kind: unknown }  # TODO: change to capture/random_32_bytes/existing`);
    } else if (e.source.kind === "capture") {
      const url = (e.source as any).url;
      if (url) {
        lines.push(`    source: { kind: capture, url: "${url}" }`);
      } else {
        lines.push(`    source: { kind: capture, url: null }  # TODO: set capture URL`);
      }
    } else if (e.source.kind === "existing") {
      const placeholder = (e.source as any).placeholder === true;
      const ref = (e.source as any).ref ?? e.ref;
      if (placeholder) {
        lines.push(`    source: { kind: existing, ref: "${ref}" }  # TODO: fill in real ref or change kind`);
      } else {
        lines.push(`    source: { kind: existing, ref: "${ref}" }`);
      }
    } else {
      // random_32_bytes / random_64_bytes
      lines.push(`    source: { kind: ${e.source.kind} }`);
    }
    // destinations
    if (e.destinations.length === 0) {
      lines.push(`    destinations: []           # TODO: add at least one destination`);
    } else {
      lines.push(`    destinations:`);
      for (const d of e.destinations) {
        if (d.includes("OWNER/REPO")) {
          lines.push(`      - ${d}  # TODO: replace OWNER/REPO with the real github owner/repo`);
        } else {
          lines.push(`      - ${d}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}
