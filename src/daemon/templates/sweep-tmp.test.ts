import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sweepTmpDir } from "./sweep-tmp.js";
import { getShuttlePaths } from "../../shared/config.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-sweep-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("sweepTmpDir({force:true}) deletes every regular file in the tmpDir", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = await readdir(tmpDir);
    assert.deepEqual(remaining, []);
  });
});

test("sweepTmpDir periodic mode keeps files newer than maxAgeMs, deletes older files", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const oldFile = path.join(tmpDir, "old.env");
    const newFile = path.join(tmpDir, "new.env");
    await writeFile(oldFile, "X=1\n");
    await writeFile(newFile, "Y=2\n");
    const past = new Date(Date.now() - 100_000);
    await utimes(oldFile, past, past);
    await sweepTmpDir({ tmpDir, maxAgeMs: 60_000 });
    const remaining = (await readdir(tmpDir)).sort();
    assert.deepEqual(remaining, ["new.env"]);
  });
});

test("sweepTmpDir is a silent no-op when tmpDir does not exist", async () => {
  await withHome(async (home) => {
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await assert.doesNotReject(() => sweepTmpDir({ tmpDir, force: true }));
  });
});

test("sweepTmpDir continues past a failing unlink (best-effort)", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    await sweepTmpDir({ tmpDir, force: true });
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = await readdir(tmpDir);
    assert.deepEqual(remaining, []);
  });
});

test("sweepTmpDir emits one template_tmp_sweep audit record per deletion", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    await sweepTmpDir({ tmpDir, force: true });
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const sweeps = lines.filter((l) => l.action === "template_tmp_sweep");
    assert.equal(sweeps.length, 2, "one audit record per file deleted");
    for (const s of sweeps) assert.equal(s.ok, true);
  });
});

test("sweepTmpDir ignores subdirectories (only deletes regular files)", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(tmpDir, "subdir"), { recursive: true });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = (await readdir(tmpDir)).sort();
    assert.deepEqual(remaining, ["subdir"]);
    const st = await stat(path.join(tmpDir, "subdir"));
    assert.equal(st.isDirectory(), true);
  });
});
