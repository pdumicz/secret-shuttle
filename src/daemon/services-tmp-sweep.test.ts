import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { getShuttlePaths } from "../shared/config.js";

test("DaemonServices.tmpDir matches getShuttlePaths().daemonTmpPath under SECRET_SHUTTLE_HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-st-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    assert.equal(services.tmpDir, getShuttlePaths(home).daemonTmpPath);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("DaemonServices.sweepTimer starts as null (main.ts sets it; shutdown clears it)", () => {
  const services = new DaemonServices();
  assert.equal(services.sweepTimer, null);
});

test("startup-force sweep deletes every file in tmpDir on daemon start (e2e via lifecycle)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-st-e2e-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "leftover.env"), "OLD=1\n");
    const { startDaemon, stopDaemon } = await import("./lifecycle.js");
    const sf = await startDaemon();
    try {
      // Give the daemon a moment to run its startup sweep.
      await new Promise((r) => setTimeout(r, 500));
      const remaining = await readdir(tmpDir);
      assert.deepEqual(remaining, [], "daemon startup must force-sweep the tmp dir");
      assert.ok(sf.port > 0);
    } finally {
      await stopDaemon();
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
