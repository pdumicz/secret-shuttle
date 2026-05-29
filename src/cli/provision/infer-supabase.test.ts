// src/cli/provision/infer-supabase.test.ts
//
// Burst 6 §2 tests for the Supabase per-secret detector.
// Spec §2.4 enumerates the fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSupabaseForSecret } from "./infer-supabase.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-infer-supabase-test-"));
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

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });

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

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_ANON_KEY",
      inferConfig: null,
    });

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

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });

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
    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });
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

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "STRIPE_WEBHOOK_SECRET",
      inferConfig: null,
    });

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

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "DATABASE_SERVICE_KEY", // doesn't match SUPABASE_*
      inferConfig: { supabaseNames: ["DATABASE_SERVICE_KEY"] },
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(g.1) supabaseNames array mixes valid + grammar-invalid entries → invalid dropped per-entry, valid routes", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    // The valid entry MY_VALID_NAME should still route this secret to
    // Supabase. The invalid sibling entries surface a single needs_edit.
    const inferConfig = {
      supabaseNames: [
        "MY_VALID_NAME",       // valid (passes ^[A-Z_][A-Z0-9_]*$)
        "has whitespace",       // invalid (spaces)
        "lowercase",            // invalid (lowercase)
        "1BAD_SECRET",          // invalid (leading digit)
        "dot.in.name",          // invalid (dots)
        "dash-in-name",         // invalid (dashes)
      ],
    };

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "MY_VALID_NAME",
      inferConfig,
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.equal(result.issues.length, 1, "exactly one consolidated issue listing rejected entries");
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /rejected 5 invalid entr/, "message names the count");
    assert.match(msg, /has whitespace/, "message names the whitespace entry");
    assert.match(msg, /1BAD_SECRET/, "message names the leading-digit entry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(g.2) supabaseNames array mixes valid + non-string entries → non-string dropped, valid routes", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const inferConfig = {
      supabaseNames: [
        "MY_VALID_NAME",
        123,
        null,
        { weird: "object" },
      ],
    };

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "MY_VALID_NAME",
      inferConfig: inferConfig as never, // bypass TS — we're testing the runtime guard
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /rejected 3 invalid entr/, "non-string entries counted");
    assert.match(msg, /non-string \(number\)/, "type of 123 named");
    assert.match(msg, /non-string \(object\)/, "type of null + object named (typeof null === 'object')");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("(g.3) supabaseNames value is not an array → whole override dropped, single needs_edit emitted", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const inferConfig = { supabaseNames: "FOO" as never };

    // Default predicate still matches SUPABASE_ names; override is
    // dropped so DATABASE_KEY (which doesn't match the default) gets no
    // Supabase routing.
    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "DATABASE_KEY",
      inferConfig: inferConfig as never,
    });

    assert.deepEqual(result.destinations, [], "override was dropped, default predicate doesn't match");
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /must be an array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
