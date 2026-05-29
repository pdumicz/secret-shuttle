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
// Burst 6 §2: per-secret Supabase routing. The detector emits its own
// additive SupabaseDetectorIssue ({ kind; message }); the wiring below maps
// each into the existing InferGateIssue ({ secret; issue }) contract.
// resolveSupabaseProject + sanitizeSupabaseOverride do all the cwd-invariant
// work ONCE before the per-secret loop; detectSupabaseForSecret is then a
// pure sync predicate over that pre-resolved state. fileExists is shared
// here too (one definition, not a per-file duplicate).
import {
  detectSupabaseForSecret,
  fileExists,
  resolveSupabaseProject,
  sanitizeSupabaseOverride,
  type InferConfig,
} from "./infer-supabase.js";

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
  const inferConfig = await loadInferConfig(opts.cwd);

  // Burst 6 §2: resolve all cwd-invariant Supabase state ONCE, before the
  // per-secret loop (mirroring detectDestinations' single filesystem probe).
  // - resolveSupabaseProject: the supabase/config.toml stat + project.json read.
  // - sanitizeSupabaseOverride: validates secret-shuttle.config.json's
  //   infer.supabaseNames. Its issues are batch-wide (they describe the whole
  //   override, not one secret), so they're surfaced ONCE here rather than
  //   re-derived inside every per-secret call.
  const supabaseProject = await resolveSupabaseProject(opts.cwd);
  const supabaseOverride = sanitizeSupabaseOverride(inferConfig?.supabaseNames);

  const entries: InferredPlanEntry[] = [];
  // Per-secret Supabase issues (only ever `supabase_not_linked`). On an
  // unlinked project every matching secret emits the SAME message, which is
  // noise — dedupe by `kind::message` via an O(1) Set lookup (not the old
  // O(n²) .some() scan). Batch-wide override issues are added once below and
  // bypass this dedupe.
  const supabaseIssues: InferGateIssue[] = [];
  const seenIssueKeys = new Set<string>();

  // Batch-wide override-validation issues, surfaced once.
  for (const issue of [
    supabaseOverride.wholeOverrideDroppedIssue,
    supabaseOverride.invalidEntriesIssue,
  ]) {
    if (issue === null) continue;
    // No secret owns a whole-override issue; attribute it to the config file.
    supabaseIssues.push({
      secret: "secret-shuttle.config.json",
      issue: `[${issue.kind}] ${issue.message}`,
    });
  }

  for (const name of names) {
    const source = inferSourceForName(name);
    // Burst 6 §2: per-secret Supabase routing. The project-wide detectors
    // above contribute their string[] uniformly; Supabase appends per-secret
    // only when the name predicate matches. Pure sync call over pre-resolved
    // state — no filesystem I/O per secret.
    const supa = detectSupabaseForSecret({
      secretName: name,
      project: supabaseProject,
      validOverrideNames: supabaseOverride.validNames,
    });

    // Map the detector-native SupabaseDetectorIssue to the existing
    // InferGateIssue { secret; issue } contract, folding `kind` into the
    // human-readable string so no information is lost. Dedupe identical
    // per-secret messages.
    for (const issue of supa.issues) {
      const key = `${issue.kind}::${issue.message}`;
      if (seenIssueKeys.has(key)) continue;
      seenIssueKeys.add(key);
      supabaseIssues.push({ secret: name, issue: `[${issue.kind}] ${issue.message}` });
    }

    entries.push({
      secret: name,
      ref: refFor(name, source),
      source: source as InferredPlanEntry["source"], // existing source pushes placeholder
      destinations: [
        ...(destinations.length > 0 ? destinations : []),
        ...supa.destinations,
      ],
    });
  }

  const gate = isInferYmlExecutable(entries);
  const yml = renderYml(entries);

  return {
    yml,
    // If supabase-derived needs_edit issues exist, the yml isn't fully
    // executable until the user resolves them (e.g., runs `supabase link`).
    executable: gate.ok && supabaseIssues.length === 0,
    issues: [...gate.issues, ...supabaseIssues],
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

// Burst 6 §2: optional opt-in override for Supabase routing.
async function loadInferConfig(cwd: string): Promise<InferConfig | null> {
  try {
    const raw = await readFile(join(cwd, "secret-shuttle.config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const root = parsed as Record<string, unknown>;
    const infer = root["infer"];
    if (infer === undefined || infer === null || typeof infer !== "object" || Array.isArray(infer)) {
      return null;
    }
    // Pass through whatever shape is at `infer` — detectSupabaseForSecret
    // sanitizes inside (and emits needs_edit issues for invalid entries).
    return infer as InferConfig;
  } catch {
    return null;
  }
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
