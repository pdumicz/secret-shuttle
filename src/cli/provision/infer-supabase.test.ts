// src/cli/provision/infer-supabase.test.ts
//
// Burst 6 §2 tests for the Supabase per-secret detector.
// Spec §2.4 enumerates the fixtures.
//
// Post-refactor (P2-1): detectSupabaseForSecret is a PURE sync predicate over
// pre-resolved state. Fixtures a–f compose the real pipeline
// (resolveSupabaseProject + sanitizeSupabaseOverride → detectSupabaseForSecret)
// via buildCtx, keeping their original behavioral intent. The override-
// validation fixtures g.1/g.2/g.3 now assert against sanitizeSupabaseOverride
// directly — that's where override validation lives post-refactor — so no
// on-disk project is needed for them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectSupabaseForSecret,
  resolveSupabaseProject,
  sanitizeSupabaseOverride,
  type InferConfig,
  type SupabaseDetectorContext,
} from "./infer-supabase.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-infer-supabase-test-"));
}

/**
 * Compose the real once-per-runInfer resolution (filesystem probe + override
 * sanitization) into the pure detector's context, so each fixture still
 * exercises the full behavior end-to-end through a single call.
 */
async function buildCtx(
  dir: string,
  secretName: string,
  inferConfig: InferConfig | null,
): Promise<SupabaseDetectorContext> {
  const project = await resolveSupabaseProject(dir);
  const override = sanitizeSupabaseOverride(inferConfig?.supabaseNames);
  return { secretName, project, validOverrideNames: override.validNames };
}

test("(a) linked project + SUPABASE_ name → emits supabase destination with project_ref", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst", name: "my-project" }),
    );

    const result = detectSupabaseForSecret(
      await buildCtx(dir, "SUPABASE_SERVICE_ROLE_KEY", null),
    );

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(b) supabase config present, NOT linked + SUPABASE_ name → TODO sentinel + needs_edit", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    // Deliberately NO .supabase/project.json

    const result = detectSupabaseForSecret(
      await buildCtx(dir, "SUPABASE_ANON_KEY", null),
    );

    assert.deepEqual(result.destinations, ["supabase:TODO_run_supabase_link_first"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_not_linked");
    assert.match(result.issues[0]?.message ?? "", /supabase link --project-ref/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(c) supabase config present, project.json is malformed JSON + matching name → same as (b)", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(join(dir, ".supabase/project.json"), "{ this is not valid json");

    const result = detectSupabaseForSecret(
      await buildCtx(dir, "SUPABASE_SERVICE_ROLE_KEY", null),
    );

    assert.deepEqual(result.destinations, ["supabase:TODO_run_supabase_link_first"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_not_linked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(d) no supabase/config.toml → no Supabase destination regardless of name", async () => {
  const dir = await setupTmp();
  try {
    // No supabase/ directory.
    const result = detectSupabaseForSecret(
      await buildCtx(dir, "SUPABASE_SERVICE_ROLE_KEY", null),
    );
    assert.deepEqual(result.destinations, []);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(e) linked + non-matching name (STRIPE_*) → no Supabase destination (predicate gates routing)", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const result = detectSupabaseForSecret(
      await buildCtx(dir, "STRIPE_WEBHOOK_SECRET", null),
    );

    assert.deepEqual(result.destinations, []);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(f) linked + non-matching name listed in infer.supabaseNames → emits Supabase destination", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const result = detectSupabaseForSecret(
      // DATABASE_SERVICE_KEY doesn't match SUPABASE_*; the override routes it.
      await buildCtx(dir, "DATABASE_SERVICE_KEY", {
        supabaseNames: ["DATABASE_SERVICE_KEY"],
      }),
    );

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Override-validation fixtures (g.*) ---------------------------------
// Post-refactor these assert against sanitizeSupabaseOverride directly: that's
// the function that owns override validation now. detectSupabaseForSecret no
// longer derives override issues, so there's nothing on disk to set up.

test("(g.1) supabaseNames array mixes valid + grammar-invalid entries → invalid dropped per-entry, valid routes", () => {
  // The valid entry MY_VALID_NAME survives in validNames (so it would still
  // route a secret to Supabase). The invalid siblings surface one needs_edit.
  const sanitized = sanitizeSupabaseOverride([
    "MY_VALID_NAME", // valid (passes ^[A-Z_][A-Z0-9_]*$)
    "has whitespace", // invalid (spaces)
    "lowercase", // invalid (lowercase)
    "1BAD_SECRET", // invalid (leading digit)
    "dot.in.name", // invalid (dots)
    "dash-in-name", // invalid (dashes)
  ]);

  // Valid entry is retained → routing still works for it.
  assert.ok(sanitized.validNames.has("MY_VALID_NAME"));
  assert.equal(sanitized.validNames.size, 1, "only the valid entry survives");
  // Grammar-invalid entries produce the per-entry consolidated issue (not the
  // whole-override-dropped one).
  assert.equal(sanitized.wholeOverrideDroppedIssue, null);
  assert.notEqual(sanitized.invalidEntriesIssue, null, "one consolidated issue listing rejected entries");
  assert.equal(sanitized.invalidEntriesIssue?.kind, "supabase_inferconfig_invalid");
  const msg = sanitized.invalidEntriesIssue?.message ?? "";
  assert.match(msg, /rejected 5 invalid entr/, "message names the count");
  assert.match(msg, /has whitespace/, "message names the whitespace entry");
  assert.match(msg, /1BAD_SECRET/, "message names the leading-digit entry");
});

test("(g.2) supabaseNames array mixes valid + non-string entries → non-string dropped, valid routes", () => {
  const sanitized = sanitizeSupabaseOverride([
    "MY_VALID_NAME",
    123,
    null,
    { weird: "object" },
  ]);

  assert.ok(sanitized.validNames.has("MY_VALID_NAME"));
  assert.equal(sanitized.validNames.size, 1);
  assert.equal(sanitized.wholeOverrideDroppedIssue, null);
  assert.notEqual(sanitized.invalidEntriesIssue, null);
  assert.equal(sanitized.invalidEntriesIssue?.kind, "supabase_inferconfig_invalid");
  const msg = sanitized.invalidEntriesIssue?.message ?? "";
  assert.match(msg, /rejected 3 invalid entr/, "non-string entries counted");
  assert.match(msg, /non-string \(number\)/, "type of 123 named");
  assert.match(msg, /non-string \(object\)/, "type of null + object named (typeof null === 'object')");
});

test("(g.3) supabaseNames value is not an array → whole override dropped, single needs_edit emitted", () => {
  const sanitized = sanitizeSupabaseOverride("FOO");

  // Override dropped wholesale → no names route, default predicate is in effect.
  assert.equal(sanitized.validNames.size, 0, "override dropped, no names route");
  assert.equal(sanitized.invalidEntriesIssue, null);
  assert.notEqual(sanitized.wholeOverrideDroppedIssue, null);
  assert.equal(sanitized.wholeOverrideDroppedIssue?.kind, "supabase_inferconfig_invalid");
  assert.match(sanitized.wholeOverrideDroppedIssue?.message ?? "", /must be an array/);
});
