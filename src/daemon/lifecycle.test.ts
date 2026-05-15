import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDaemonStatus, startDaemon, stopDaemon } from "./lifecycle.js";

test("startDaemon → status → stopDaemon round-trips", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-life-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const sf = await startDaemon();
    assert.ok(sf.port > 0);
    const stat = await getDaemonStatus();
    assert.equal(stat.running, true);
    if (stat.running) {
      assert.equal(stat.unlocked, false);
    }
    await stopDaemon();
    // Give it a moment to die.
    await new Promise((r) => setTimeout(r, 500));
    const stat2 = await getDaemonStatus();
    assert.equal(stat2.running, false);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("startDaemon refuses to start when legacy master-key.json is present", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-life-legacy-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "master-key.json"), JSON.stringify({
    version: 1, algorithm: "aes-256-gcm", key: "x".repeat(43),
    storage: "local-file", warning: "x",
  }));
  try {
    await assert.rejects(
      () => startDaemon(),
      (err) => err instanceof Error && /legacy_key_present/.test((err as { code?: string }).code ?? ""),
    );
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
