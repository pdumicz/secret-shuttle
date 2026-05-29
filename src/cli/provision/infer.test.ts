import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInfer } from "./infer.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-infer-test-"));
}

test("missing .env.example → infer_no_env_example", async () => {
  const dir = await setupTmp();
  try {
    await assert.rejects(
      runInfer({ cwd: dir }),
      (err: any) => err.code === "infer_no_env_example",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(".env.example exists but contains no usable names (comments/blanks only) → infer_no_env_example", async () => {
  // Distinct from the "missing file" case: file present, but parseEnvExampleNames
  // returns []. Without this guard, runInfer would proceed to render a yml with
  // `secrets:` and nothing under it, which the daemon then rejects as
  // bootstrap_plan_invalid — a less actionable error.
  const dir = await setupTmp();
  try {
    const content = [
      "# These are notes only",
      "",
      "# No actual assignments",
      "  ",
    ].join("\n");
    await writeFile(join(dir, ".env.example"), content);
    await assert.rejects(
      runInfer({ cwd: dir }),
      (err: any) => err.code === "infer_no_env_example",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with one Stripe key + vercel.json → executable plan", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "STRIPE_SECRET_KEY=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, true);
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /kind: capture/);
    assert.match(r.yml, /dashboard\.stripe\.com\/apikeys/);
    assert.match(r.yml, /vercel:production/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with unknown name → not executable, issues listed", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, false);
    assert.ok(r.issues.some((i) => i.secret === "MY_CUSTOM_FLAG"));
    assert.match(r.yml, /kind: unknown/);
    assert.match(r.yml, /TODO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no framework files → empty destinations + TODO", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "INTERNAL_TOKEN=\n");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, false);
    assert.match(r.yml, /destinations: \[\]/);
    assert.match(r.yml, /TODO: add at least one destination/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(".github/workflows + no git remote → github-actions:OWNER/REPO placeholder + TODO", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "STRIPE_KEY=\n");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    const r = await runInfer({ cwd: dir });
    // Plan should include github-actions destination with placeholder
    assert.match(r.yml, /github-actions:OWNER\/REPO/);
    assert.equal(r.executable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with comment lines and blank lines parses correctly", async () => {
  const dir = await setupTmp();
  try {
    const content = [
      "# Stripe",
      "STRIPE_SECRET_KEY=",
      "",
      "# Internal",
      "INTERNAL_CRON_SECRET=",
    ].join("\n");
    await writeFile(join(dir, ".env.example"), content);
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /INTERNAL_CRON_SECRET/);
    // Two entries
    assert.equal((r.yml.match(/^  [A-Z]/gm) || []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with `export VAR=` prefix is parsed correctly", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "export STRIPE_SECRET_KEY=\nexport INTERNAL_TOKEN=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /INTERNAL_TOKEN/);
    assert.equal((r.yml.match(/^  [A-Z]/gm) ?? []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with lowercase or mixed-case names is silently skipped (yml.ts rejects them downstream)", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "lowercase_name=\nMixedCase=\nSTRIPE_SECRET_KEY=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    // Only the uppercase name survives the strict regex.
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.doesNotMatch(r.yml, /lowercase_name/);
    assert.doesNotMatch(r.yml, /MixedCase/);
    assert.equal((r.yml.match(/^  [A-Z]/gm) ?? []).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with duplicate names dedupes first-wins (does not emit a yml that breaks the parser)", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "STRIPE_SECRET_KEY=\nSTRIPE_SECRET_KEY=\nINTERNAL_TOKEN=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /INTERNAL_TOKEN/);
    // Exactly two entries (not three).
    assert.equal((r.yml.match(/^  [A-Z]/gm) ?? []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runInfer: mixed Vercel + Supabase project routes Supabase to matching names, Vercel to all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-infer-mixed-"));
  try {
    // Mixed signals: vercel.json (project-wide Vercel) + a linked Supabase project.
    await writeFile(join(dir, "vercel.json"), "{}\n");
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );
    // .env.example mixes a Supabase-predicate name with a non-matching one,
    // plus a config-override name to prove the escape hatch end-to-end.
    // NOTE: the override name must still infer a *known* source, or the gate
    // marks the plan non-executable (`unknown` source → needs_edit issue).
    // `DATABASE_SERVICE_SECRET` ends in `_SECRET` with no provider prefix, so
    // the generic random rule (`infer-rules.ts`) gives it `random_32_bytes` —
    // a known source — keeping `issues === []` / `executable === true` true.
    await writeFile(
      join(dir, ".env.example"),
      "SUPABASE_SERVICE_ROLE_KEY=\nSTRIPE_WEBHOOK_SECRET=\nDATABASE_SERVICE_SECRET=\n",
    );
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_SECRET"] } }),
    );

    const result = await runInfer({ cwd: dir });

    const bySecret = new Map(result.plan.map((e) => [e.secret, e.destinations]));
    // Supabase name → both Vercel (project-wide) AND Supabase (per-secret, ref-stamped).
    assert.deepEqual(bySecret.get("SUPABASE_SERVICE_ROLE_KEY"), [
      "vercel:production",
      "supabase:abcdefghijklmnopqrst",
    ]);
    // Non-matching name → Vercel only (predicate gates Supabase out).
    assert.deepEqual(bySecret.get("STRIPE_WEBHOOK_SECRET"), ["vercel:production"]);
    // Override name → Vercel + Supabase (escape hatch works through the wiring).
    assert.deepEqual(bySecret.get("DATABASE_SERVICE_SECRET"), [
      "vercel:production",
      "supabase:abcdefghijklmnopqrst",
    ]);
    // No needs_edit issues (project is linked, override is valid).
    assert.deepEqual(result.issues, []);
    assert.equal(result.executable, true);
    // The rendered yml carries the Supabase destination too.
    assert.match(result.yml, /supabase:abcdefghijklmnopqrst/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
