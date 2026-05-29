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
