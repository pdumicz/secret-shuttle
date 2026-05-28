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
