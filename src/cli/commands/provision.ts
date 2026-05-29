/**
 * `secret-shuttle provision` — unified verb for "make secrets exist in
 * vault + destinations." Replaces the removed `bootstrap` verb and
 * absorbs the un-built `provision` shortcut idea.
 *
 * Mode flags are mutually exclusive: --infer, --yml, --secret,
 * --continue, --list, --abandon. The dispatch lives in a single
 * function that validates flag conflicts and routes to the right
 * handler.
 *
 * See spec §1.
 */
import { Command } from "commander";
import { readFile, writeFile, access, stat } from "node:fs/promises";
import { stringify as yamlStringify } from "yaml";
import { ShuttleError } from "../../shared/errors.js";
import { daemonRequest } from "../../client/daemon-client.js";
import { assertEnvironmentValid, parseSecretRef } from "../../shared/refs.js";
import { ok, outputJson } from "../../shared/result.js";
import { runInfer } from "../provision/infer.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

type Mode = "infer" | "yml" | "secret" | "continue" | "list" | "abandon";

interface ProvisionOpts {
  infer?: boolean;
  yml?: string;
  secret?: string;
  continue?: boolean;
  list?: boolean;
  abandon?: boolean;
  dryRun?: boolean;
  force?: boolean;
  environment?: string;
  from?: string;
  url?: string;
  ref?: string;
  to?: string;
  batch?: string;
  approvalId?: string[];
}

export function provisionCommand(): Command {
  const cmd = new Command("provision")
    .description("Provision a project's secrets in one approval (replaces the removed `bootstrap` verb).")
    // Mode selectors:
    .option("--infer", "Generate a yml from .env.example + framework signals (default for new projects)")
    .option("--yml <file>", "Read an existing secret-shuttle.yml")
    .option("--secret <NAME>", "Single-secret inline (requires --from + --to)")
    .option("--continue", "Resume an approved batch (requires --batch; --approval-id only needed on the first /continue when batch is still pending)")
    .option("--list", "List in-flight batches")
    .option("--abandon", "Abandon a batch (requires --batch)")
    // Parameters:
    .option("--from <kind>", "Source kind: capture, random_32_bytes, random_64_bytes, existing")
    .option("--url <url>", "Capture URL (required when --from=capture)")
    .option("--ref <ss://...>", "Existing ref (required when --from=existing)")
    .option("--to <dest[,dest...]>", "Comma-separated destination shorthands")
    .option("--batch <id>", "Batch id (with --continue or --abandon)")
    .option("--dry-run", "Print planned yml to stdout, no file write, no batch (--infer only)")
    .option("--force", "Overwrite existing yml (--infer) AND force re-push / regenerate at the daemon (--yml/--secret/--infer)")
    .option("--environment <env>", "Target environment for non-prod ref creation (passed to daemon)");
  addApprovalIdOption(cmd);
  cmd.action(async (raw: ProvisionOpts) => {
    // Follow project convention: commands throw; src/cli/index.ts:62 catches
    // ShuttleError, writes JSON to stderr, sets process.exitCode. Do NOT
    // outputJson+process.exit here — that path bypasses the top-level
    // deprecation-warning attachment and writes to stdout instead of stderr.
    const mode = resolveMode(raw);
    await dispatch(mode, raw);
  });
  return cmd;
}

function resolveMode(opts: ProvisionOpts): Mode {
  const selectors: Array<{ flag: string; on: boolean }> = [
    { flag: "--infer", on: !!opts.infer },
    { flag: "--yml", on: !!opts.yml },
    { flag: "--secret", on: !!opts.secret },
    { flag: "--continue", on: !!opts.continue },
    { flag: "--list", on: !!opts.list },
    { flag: "--abandon", on: !!opts.abandon },
  ];
  const active = selectors.filter((s) => s.on).map((s) => s.flag);

  if (active.length > 1) {
    throw new ShuttleError(
      "provision_mode_conflict",
      `Conflicting mode flags: ${active.join(", ")}. Pass exactly one.`,
    );
  }
  if (opts.dryRun && !opts.infer && !active.includes("--infer")) {
    throw new ShuttleError("provision_mode_conflict", "--dry-run is only valid with --infer.");
  }
  if (active.length === 0) {
    // Default: --yml ./secret-shuttle.yml if file exists
    return "yml-default-or-no-mode" as Mode; // resolved in dispatch
  }
  // Narrow active[0] under noUncheckedIndexedAccess. The branches above
  // handle length === 0 (return) and length > 1 (throw), so length === 1
  // is the only path here — but TS doesn't track the array-length invariant.
  // `active` is string[] after the .map(s => s.flag) above.
  const [selector] = active;
  if (selector === undefined) {
    // Logically unreachable; keeps the typechecker quiet without `!`.
    throw new ShuttleError("provision_no_mode", "Unreachable: active selector missing.");
  }
  return selector.replace(/^--/, "") as Mode;
}

async function dispatch(mode: Mode | "yml-default-or-no-mode", opts: ProvisionOpts): Promise<void> {
  if (mode === "yml-default-or-no-mode") {
    // ENOENT check ONLY — don't let later daemon-side errors get remapped to
    // provision_no_mode. The outer try would otherwise swallow a real
    // daemon_not_running or vault_locked from runYmlMode.
    let hasYml = false;
    try {
      await access("./secret-shuttle.yml");
      hasYml = true;
    } catch {
      // missing file → fall through
    }
    if (!hasYml) {
      throw new ShuttleError(
        "provision_no_mode",
        "No mode flag and no ./secret-shuttle.yml to default to. Pass --infer, --yml, --secret, --continue, --list, or --abandon.",
      );
    }
    return runYmlMode("./secret-shuttle.yml", opts);
  }

  switch (mode) {
    case "infer": return runInferMode(opts);
    case "yml": return runYmlMode(opts.yml!, opts);
    case "secret": return runSecretMode(opts);
    case "continue": return runContinueMode(opts);
    case "list": return runListMode();
    case "abandon": return runAbandonMode(opts);
    default:
      throw new ShuttleError("bad_request", `Unhandled provision mode: ${mode}`);
  }
}

// Implementations:

async function runInferMode(opts: ProvisionOpts): Promise<void> {
  // CTO-review round-2 P1.2: validate --environment BEFORE building any
  // next_action string that interpolates the value. The infer mode emits
  // recovery strings that include `--environment <env>`, so an unvalidated
  // env would let a malicious value like `staging; ls` survive into the
  // wire next_action.
  validateProvisionScalars(opts);

  const result = await runInfer({ cwd: process.cwd() });

  if (opts.dryRun) {
    outputJson(ok({ mode: "dry_run", yml: result.yml, executable: result.executable, issues: result.issues }));
    return;
  }

  const ymlPath = "./secret-shuttle.yml";
  const exists = await fileExists(ymlPath);
  if (exists && !opts.force) {
    // The recovery command needs --environment to be preserved when the
    // user originally passed --environment <env> alongside --infer.
    // The pre-interpolation validateProvisionScalars() call above
    // guarantees the env value is safe to interpolate into the literal
    // next_action string. infer_yml_exists.nextAction is null in the
    // registry (the static function has no access to runtime opts), so
    // we re-throw with a per-instance nextAction here where
    // `opts.environment` is in scope. Same pattern as the bootstrap-route
    // P1 fix.
    const envSuffix = opts.environment !== undefined ? ` --environment ${opts.environment}` : "";
    throw new ShuttleError(
      "infer_yml_exists",
      "./secret-shuttle.yml already exists. Re-run with --force to overwrite, or --dry-run to print to stdout only.",
      {
        nextAction: `secret-shuttle provision --infer --force${envSuffix}`,
      },
    );
  }

  await writeFile(ymlPath, result.yml, "utf8");

  if (!result.executable) {
    // Preserve --environment in the recovery hint so a subsequent
    // `provision --yml` runs against the same environment the user
    // originally requested. Without this, --environment silently
    // resets to the daemon's default (production). The early
    // validateProvisionScalars() call above guarantees the env value
    // is safe to interpolate into the literal next_action string.
    const envSuffix = opts.environment !== undefined ? ` --environment ${opts.environment}` : "";
    outputJson(ok({
      needs_edit: true,
      yml_path: ymlPath,
      issues: result.issues,
      next_action: `edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml${envSuffix}`,
    }));
    return;
  }

  // Fully executable — mint batch via the existing yml route.
  await runYmlMode(ymlPath, opts);
}

async function runYmlMode(ymlPath: string, opts: ProvisionOpts): Promise<void> {
  // CTO-review round-2 P1.2: validate --environment before forwarding to
  // the daemon. Although the daemon body doesn't directly interpolate
  // env into shell, the bootstrap-route approval_required path includes
  // environment in `details.batch_id` / `template_params.batch_id` and
  // any downstream hint construction that splices env into a literal
  // command must be able to trust the value. Reject at the CLI surface.
  validateProvisionScalars(opts);

  // Hands off to the existing bootstrap plan route (server-side route name
  // kept per spec; internal-only). Route body shape per
  // src/daemon/api/routes/bootstrap.ts:32 is `{ plan_yml, force?, environment? }`.
  const ymlText = await readFile(ymlPath, "utf8");
  const body: Record<string, unknown> = { plan_yml: ymlText };
  if (opts.force === true) body.force = true;
  if (opts.environment !== undefined) body.environment = opts.environment;
  const r = await daemonRequest("POST", "/v1/bootstrap/plan", body);
  outputJson(ok(r as Record<string, unknown>));
}

async function runSecretMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.secret || !opts.from || !opts.to) {
    throw new ShuttleError("missing_param", "--secret requires --from <kind> and --to <dest[,dest...]>.");
  }
  // Build a 1-secret yml via the `yaml` package (already a runtime dep —
  // package.json line 59). String interpolation would be vulnerable to
  // injection if --secret/--url/--ref contained YAML metacharacters or
  // newlines; stringify() handles escaping correctly. Validate scalars
  // first (cheap defense-in-depth even with the structured builder).
  // The validator also enforces --environment safety (round-2 P1.2): the
  // env value is forwarded to the daemon body and could be interpolated
  // downstream, so we reject shell metacharacters at the CLI surface.
  validateProvisionScalars(opts);
  const sourceObj = buildSecretSourceObject(opts);
  const dests = opts.to.split(",").map((d) => d.trim()).filter(Boolean);
  if (dests.length === 0) {
    throw new ShuttleError("missing_param", "--to must contain at least one destination shorthand.");
  }
  const planDoc = {
    version: 1,
    secrets: {
      [opts.secret]: {
        source: sourceObj,
        destinations: dests,
      },
    },
  };
  const ymlText: string = yamlStringify(planDoc);
  const body: Record<string, unknown> = { plan_yml: ymlText };
  if (opts.force === true) body.force = true;
  if (opts.environment !== undefined) body.environment = opts.environment;
  const r = await daemonRequest("POST", "/v1/bootstrap/plan", body);
  outputJson(ok(r as Record<string, unknown>));
}

// Cheap input validation BEFORE serialization / interpolation — never let
// attacker-controlled newlines / colons / YAML directives reach the yaml
// writer untouched, and never let shell metacharacters reach a literal
// next_action recovery string.
//
// CTO-review round-2 P1.2 rename: previously validateSecretScalars (scoped
// to --secret / --url / --ref). Now also validates --environment whenever
// set, in any provision mode that forwards it to the daemon or interpolates
// it into a next_action string. Call sites: runInferMode, runYmlMode,
// runSecretMode. The --secret / --url / --ref checks only fire when the
// corresponding flag is set — the function is safe to call from modes that
// don't accept those flags.
function validateProvisionScalars(opts: ProvisionOpts): void {
  // --environment: delegate to the canonical assertEnvironmentValid()
  // helper in src/shared/refs.ts. Round-2 used a parallel regex
  // /^[a-zA-Z0-9_-]+$/, which diverged from the shared ENV_RE
  // (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) used by buildSecretRef/parseSecretRef:
  // it rejected valid dotted envs (qa.us-east) and accepted invalid
  // leading-hyphen envs (-bad). Centralising on the shared grammar
  // restores a single source of truth and keeps the shell-injection
  // guarantee (the shared regex still rejects every shell metacharacter,
  // since it limits chars to [a-zA-Z0-9._-] and forbids a leading dash).
  if (opts.environment !== undefined) {
    assertEnvironmentValid(opts.environment);
  }

  // env-var NAME (only when --secret is in play): must match yml parser's
  // stricter constraint (src/cli/bootstrap/yml.ts:23) — UPPERCASE start,
  // then [A-Z0-9_]. The previous /^[A-Za-z_][A-Za-z0-9_]*$/ was looser
  // than the yml parser, letting `--secret myKey ...` pass the CLI gate
  // then fail with bootstrap_plan_invalid at the daemon. Aligning here
  // surfaces the failure at the CLI surface with a focused message.
  if (opts.secret !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(opts.secret)) {
    throw new ShuttleError("bad_request", `--secret name must match /^[A-Z][A-Z0-9_]*$/ (UPPERCASE letters, digits, underscore; must start with a letter); got '${opts.secret}'.`);
  }
  if (opts.url !== undefined) {
    // Must be https; no embedded credentials; no whitespace. Strict URL
    // validation also runs server-side at /v1/bootstrap/plan (Burst 4 §3)
    // but failing early in the CLI yields a clearer error.
    let u: URL;
    try { u = new URL(opts.url); } catch { throw new ShuttleError("bad_request", `--url is not a valid URL: ${opts.url}`); }
    if (u.protocol !== "https:") throw new ShuttleError("bad_request", `--url must be https; got ${u.protocol}`);
    if (u.username !== "" || u.password !== "") throw new ShuttleError("bad_request", "--url must not contain embedded credentials.");
  }
  if (opts.ref !== undefined) {
    // Use the canonical parser (src/shared/refs.ts:65) instead of a parallel
    // regex. The previous regex /^ss:\/\/[a-z0-9_-]+\/[a-z0-9_-]+\/[A-Za-z_]
    // [A-Za-z0-9_]*$/ rejected dotted source/env/name components that the
    // canonical SOURCE_RE / ENV_RE / NAME_RE accept (e.g.,
    // `ss://my.source/prod/UPSTREAM_SECRET`). parseSecretRef throws
    // ShuttleError with code `invalid_ref` on bad input; surfacing that to
    // the user gives a more accurate error than a regex mismatch message
    // and eliminates the drift between CLI and server-side validation.
    parseSecretRef(opts.ref);
  }
}

function buildSecretSourceObject(opts: ProvisionOpts): Record<string, string> {
  switch (opts.from) {
    case "capture":
      if (!opts.url) throw new ShuttleError("missing_param", "--from=capture requires --url <url>.");
      return { kind: "capture", url: opts.url };
    case "random_32_bytes":
    case "random_64_bytes":
      return { kind: opts.from };
    case "existing":
      if (!opts.ref) throw new ShuttleError("missing_param", "--from=existing requires --ref <ss://...>.");
      return { kind: "existing", ref: opts.ref };
    default:
      throw new ShuttleError("bad_request", `Unknown source kind: ${opts.from}.`);
  }
}

async function runContinueMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.batch) throw new ShuttleError("missing_param", "--continue requires --batch <id>.");
  // approval_ids only required on the FIRST /continue (when batch_status is
  // still "pending"). Retries for in_progress / failed_partial are authorized
  // by batch_id alone — see src/daemon/api/routes/bootstrap.ts:285.
  const body: Record<string, unknown> = { batch_id: opts.batch };
  if (opts.approvalId !== undefined && opts.approvalId.length > 0) {
    body.approval_ids = opts.approvalId;
  }
  const r = await daemonRequest("POST", "/v1/bootstrap/continue", body);
  outputJson(ok(r as Record<string, unknown>));
}

async function runListMode(): Promise<void> {
  // Route is GET /v1/bootstrap/list per src/daemon/api/routes/bootstrap.ts:424.
  const r = await daemonRequest("GET", "/v1/bootstrap/list");
  outputJson(ok(r as Record<string, unknown>));
}

async function runAbandonMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.batch) throw new ShuttleError("missing_param", "--abandon requires --batch <id>.");
  const r = await daemonRequest("POST", "/v1/bootstrap/abandon", { batch_id: opts.batch });
  outputJson(ok(r as Record<string, unknown>));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
