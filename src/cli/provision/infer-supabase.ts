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
  /** Machine-readable discriminant: "supabase_not_linked" |
   *  "supabase_inferconfig_invalid". */
  kind: string;
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

export interface SupabaseDetectorContext {
  cwd: string;
  secretName: string;
  inferConfig: InferConfig | null;
}

export interface SupabaseDetectorResult {
  /** Empty or single-element array. When non-empty, the element is the
   *  `supabase:<scope>` shorthand to be appended to the entry's destinations
   *  list. `<scope>` is the project_ref when one is known, else a sentinel
   *  the user must edit before running `provision`. */
  destinations: string[];
  /** Zero or more needs_edit issues. The wiring maps these to the existing
   *  `{ secret, issue }` InferGateIssue shape before surfacing in InferResult. */
  issues: SupabaseDetectorIssue[];
}

interface SanitizedOverride {
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
 */
function sanitizeSupabaseOverride(raw: unknown): SanitizedOverride {
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

async function fileExists(p: string): Promise<boolean> {
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

export async function detectSupabaseForSecret(
  ctx: SupabaseDetectorContext,
): Promise<SupabaseDetectorResult> {
  // 1. Sanitize the override list (emit issues for any invalid entries).
  const sanitized = sanitizeSupabaseOverride(ctx.inferConfig?.supabaseNames);
  const overrideIssues: SupabaseDetectorIssue[] = [];
  if (sanitized.wholeOverrideDroppedIssue !== null) {
    overrideIssues.push(sanitized.wholeOverrideDroppedIssue);
  }
  if (sanitized.invalidEntriesIssue !== null) {
    overrideIssues.push(sanitized.invalidEntriesIssue);
  }

  // 2. Apply the name predicate. If predicate fails, emit no destination
  //    (but still surface override-validation issues so the user sees them).
  const predicateMatches =
    SUPABASE_NAME_PREDICATE_RE.test(ctx.secretName) ||
    sanitized.validNames.has(ctx.secretName);
  if (!predicateMatches) {
    return { destinations: [], issues: overrideIssues };
  }

  // 3. Predicate matched. Check for Supabase project on disk.
  const hasConfig = await fileExists(join(ctx.cwd, "supabase/config.toml"));
  if (!hasConfig) {
    // No Supabase project — name matched but no signal. Emit nothing.
    return { destinations: [], issues: overrideIssues };
  }

  // 4. Resolve project_ref. When absent/malformed, emit needs_edit + sentinel.
  const ref = await readProjectRef(ctx.cwd);
  if (ref === null) {
    return {
      destinations: ["supabase:TODO_run_supabase_link_first"],
      issues: [
        ...overrideIssues,
        {
          kind: "supabase_not_linked",
          message:
            "Supabase target detected (`supabase/config.toml` present) but project not linked. " +
            "Run `supabase link --project-ref <ref>` first, then re-run `secret-shuttle provision --infer`.",
        },
      ],
    };
  }

  return {
    destinations: [`supabase:${ref}`],
    issues: overrideIssues,
  };
}
