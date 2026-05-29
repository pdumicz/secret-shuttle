/**
 * Burst 6 §2 — Supabase detector for `provision --infer`.
 *
 * Per-secret detector (unlike the project-wide Vercel/Cloudflare/
 * GitHub Actions detectors in infer.ts). Evaluates a name predicate
 * first; only secrets matching the predicate get a Supabase destination,
 * even when `supabase/config.toml` is present. Prevents over-routing
 * Stripe/cron/other secrets onto Supabase.
 *
 * The cloud `project_ref` (used by `supabase-edge-secret-set`) lives in
 * `.supabase/project.json`'s `ref` field, written by `supabase link
 * --project-ref <ref>`. Without that file, the detector emits a
 * needs_edit message rather than a broken destination.
 *
 * See spec §2 and Burst 6 plan Task 2.2 for the full design rationale.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Additive issue contract for the Supabase detector. This is DISTINCT from
 * `InferGateIssue` (`{ secret; issue }` in infer-gate.ts) for two reasons:
 *   1. Detector issues carry a machine-readable `kind` (the gate's issues
 *      do not).
 *   2. Override-validation issues are NOT bound to a single secret name —
 *      they describe the whole `secret-shuttle.config.json` override — so
 *      they don't fit the gate's per-secret `{ secret }` field.
 * The wiring in runInfer (Task 2.3) maps each SupabaseDetectorIssue into the
 * existing `{ secret, issue }` InferGateIssue shape before merging into
 * `InferResult.issues`. `InferGateIssue` itself is left unchanged.
 */
export interface SupabaseDetectorIssue {
  /** Machine-readable discriminant. Closed union so typo'd kinds fail to
   *  compile and construction sites get exhaustiveness checking. */
  kind: "supabase_not_linked" | "supabase_inferconfig_invalid";
  /** Human-readable needs_edit message. */
  message: string;
}

/** Default name predicate — secret names matching this regex automatically
 *  route to Supabase when a Supabase project is detected on disk. */
export const SUPABASE_NAME_PREDICATE_RE = /^SUPABASE_[A-Z0-9_]+$/;

/** Override-name validation grammar — entries in
 *  `infer.supabaseNames` must match this to be honored. Non-digit leading
 *  character + uppercase letters/digits/underscores only — the env-var-safe
 *  shape secret names normally take. Rejects whitespace, control chars,
 *  lowercase, dots/dashes, and leading digits. */
export const SUPABASE_OVERRIDE_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface InferConfig {
  supabaseNames?: unknown; // validated dynamically — see sanitizeSupabaseOverride
}

/** cwd-invariant Supabase project state, resolved ONCE per `runInfer`
 *  (matching `detectDestinations`' single filesystem probe). Reused for
 *  every secret so an N-secret `.env.example` does not trigger N×
 *  stat/readFile/JSON.parse of the same two files. */
export interface SupabaseProjectState {
  /** `supabase/config.toml` exists. */
  hasConfig: boolean;
  /** `.supabase/project.json`'s `ref`, or null when the file is absent,
   *  malformed, or missing a usable string `ref`. */
  ref: string | null;
}

export interface SupabaseDetectorContext {
  secretName: string;
  /** Pre-resolved once via {@link resolveSupabaseProject}. */
  project: SupabaseProjectState;
  /** Pre-sanitized once via {@link sanitizeSupabaseOverride}. Names here
   *  route to Supabase even when they don't match the default predicate. */
  validOverrideNames: ReadonlySet<string>;
}

export interface SupabaseDetectorResult {
  /** Empty or single-element array. When non-empty, the element is the
   *  `supabase:<scope>` shorthand to be appended to the entry's destinations
   *  list. `<scope>` is the project_ref when one is known, else a sentinel
   *  the user must edit before running `provision`. */
  destinations: string[];
  /** Zero or more needs_edit issues. Post-refactor this only ever contains
   *  the per-secret `supabase_not_linked` issue — the batch-wide override
   *  validation issues are produced once by {@link sanitizeSupabaseOverride}
   *  in the wiring, not per-secret here. */
  issues: SupabaseDetectorIssue[];
}

export interface SanitizedOverride {
  /** Names that passed grammar validation — pass as `validOverrideNames`. */
  validNames: Set<string>;
  /** Issue to surface if any invalid entries were dropped. Null when the
   *  override was either absent, fully valid, or itself non-array (the
   *  non-array path emits a distinct whole-override-dropped issue). */
  invalidEntriesIssue: SupabaseDetectorIssue | null;
  /** Issue to surface when the whole `infer.supabaseNames` value is not an
   *  array. Null otherwise. */
  wholeOverrideDroppedIssue: SupabaseDetectorIssue | null;
}

/**
 * Decide which override-name entries are valid + emit a single needs_edit
 * issue naming any rejected entries. Per spec §2 "infer.supabaseNames
 * validation": individual bad entries drop but valid siblings still take
 * effect; only a non-array `supabaseNames` value drops the whole override.
 *
 * Batch-wide: called ONCE per `runInfer` (the override describes the whole
 * `secret-shuttle.config.json`, not a single secret), so its issues are
 * surfaced once rather than per-secret.
 */
export function sanitizeSupabaseOverride(raw: unknown): SanitizedOverride {
  const validNames = new Set<string>();

  if (raw === undefined || raw === null) {
    return { validNames, invalidEntriesIssue: null, wholeOverrideDroppedIssue: null };
  }

  if (!Array.isArray(raw)) {
    return {
      validNames,
      invalidEntriesIssue: null,
      wholeOverrideDroppedIssue: {
        kind: "supabase_inferconfig_invalid",
        message:
          "secret-shuttle.config.json: `infer.supabaseNames` must be an array of strings. " +
          "Whole override ignored; default SUPABASE_* name predicate is in effect.",
      },
    };
  }

  const rejected: Array<{ index: number; descriptor: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      rejected.push({ index: i, descriptor: `[${i}]: non-string (${typeof entry})` });
      continue;
    }
    if (!SUPABASE_OVERRIDE_NAME_RE.test(entry)) {
      rejected.push({ index: i, descriptor: `[${i}]: ${JSON.stringify(entry)}` });
      continue;
    }
    validNames.add(entry);
  }

  if (rejected.length > 0) {
    return {
      validNames,
      invalidEntriesIssue: {
        kind: "supabase_inferconfig_invalid",
        message:
          "secret-shuttle.config.json: `infer.supabaseNames` rejected " +
          rejected.length +
          " invalid entr" + (rejected.length === 1 ? "y" : "ies") + ": " +
          rejected.map((r) => r.descriptor).join("; ") +
          ". Entry grammar is ^[A-Z_][A-Z0-9_]*$ (uppercase + digits + underscores, " +
          "non-digit first char — no whitespace, control chars, lowercase, dots, " +
          "dashes, or leading digits). Valid entries in the same array still routed.",
      },
      wholeOverrideDroppedIssue: null,
    };
  }

  return { validNames, invalidEntriesIssue: null, wholeOverrideDroppedIssue: null };
}

/** Shared filesystem helper — does the path exist and is it a regular file?
 *  Exported so `infer.ts` (which also probes framework signal files) uses
 *  one definition rather than a byte-identical duplicate. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Read .supabase/project.json defensively. Returns the ref string when
 *  valid, null otherwise. Treats missing file, malformed JSON, missing
 *  `ref` field, and non-string `ref` all as "not linked." */
async function readProjectRef(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, ".supabase/project.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const ref = (parsed as Record<string, unknown>)["ref"];
    if (typeof ref !== "string" || ref.length === 0) {
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}

/**
 * Resolve the cwd-invariant Supabase project state ONCE per `runInfer`.
 * Performs all the filesystem I/O the per-secret predicate used to repeat:
 * the `supabase/config.toml` stat and the `.supabase/project.json` read.
 * The result feeds every {@link detectSupabaseForSecret} call as
 * {@link SupabaseDetectorContext.project}.
 */
export async function resolveSupabaseProject(cwd: string): Promise<SupabaseProjectState> {
  const hasConfig = await fileExists(join(cwd, "supabase/config.toml"));
  const ref = hasConfig ? await readProjectRef(cwd) : null;
  return { hasConfig, ref };
}

/**
 * Pure per-secret predicate over PRE-RESOLVED Supabase state — no filesystem
 * I/O, no override sanitization (both hoisted into the once-per-`runInfer`
 * {@link resolveSupabaseProject} / {@link sanitizeSupabaseOverride} calls).
 *
 * Applies the name predicate (default `SUPABASE_*` regex OR a pre-validated
 * override name), then decides the destination from the on-disk project
 * state. The only issue it can emit is the per-secret `supabase_not_linked`
 * needs_edit message; override-validation issues live in the sanitizer.
 */
export function detectSupabaseForSecret(
  ctx: SupabaseDetectorContext,
): SupabaseDetectorResult {
  // 1. Apply the name predicate. If it fails, this secret isn't a Supabase
  //    target — emit nothing.
  const predicateMatches =
    SUPABASE_NAME_PREDICATE_RE.test(ctx.secretName) ||
    ctx.validOverrideNames.has(ctx.secretName);
  if (!predicateMatches) {
    return { destinations: [], issues: [] };
  }

  // 2. Predicate matched but there's no Supabase project on disk — name
  //    matched yet no signal. Emit nothing.
  if (!ctx.project.hasConfig) {
    return { destinations: [], issues: [] };
  }

  // 3. Project present but not linked (no usable project_ref) — emit
  //    needs_edit + sentinel destination the user must resolve.
  if (ctx.project.ref === null) {
    return {
      destinations: ["supabase:TODO_run_supabase_link_first"],
      issues: [
        {
          kind: "supabase_not_linked",
          message:
            "Supabase target detected (`supabase/config.toml` present) but project not linked. " +
            "Run `supabase link --project-ref <ref>` first, then re-run `secret-shuttle provision --infer`.",
        },
      ],
    };
  }

  // 4. Linked — stamp the resolved project_ref.
  return {
    destinations: [`supabase:${ctx.project.ref}`],
    issues: [],
  };
}
