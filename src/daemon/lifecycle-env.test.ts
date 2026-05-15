import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDaemonStatus, startDaemon, stopDaemon } from "./lifecycle.js";
import { buildDaemonEnv } from "./safe-env.js";

test("daemon does not honor SECRET_SHUTTLE_CHROME_PATH set in the parent environment", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-env-chrome-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevChrome = process.env.SECRET_SHUTTLE_CHROME_PATH;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_CHROME_PATH = "/tmp/should-not-be-in-daemon-env";
  try {
    const env = buildDaemonEnv();
    assert.equal(env.SECRET_SHUTTLE_CHROME_PATH, undefined);
    assert.equal(env.SECRET_SHUTTLE_INSECURE_DEV_MODE, undefined);
  } finally {
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevChrome === undefined) delete process.env.SECRET_SHUTTLE_CHROME_PATH;
    else process.env.SECRET_SHUTTLE_CHROME_PATH = prevChrome;
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon does not honor NODE_OPTIONS set in the parent environment", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-env-"));
  const preloadPath = path.join(home, "preload.cjs");
  // If NODE_OPTIONS=--require <preloadPath> is honored, this preload runs in
  // the daemon process and writes to a signal file.
  const signalPath = path.join(home, "preload-was-loaded");
  await writeFile(
    preloadPath,
    `require("node:fs").writeFileSync(${JSON.stringify(signalPath)}, "leaked");\n`,
  );

  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevOpts = process.env.NODE_OPTIONS;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.NODE_OPTIONS = `--require ${preloadPath}`;

  try {
    await startDaemon();
    const stat = await getDaemonStatus();
    assert.equal(stat.running, true);
    await stopDaemon();
    // Give the daemon a beat to exit.
    await new Promise((r) => setTimeout(r, 300));

    // Signal file must NOT exist — the preload did not run.
    await assert.rejects(() => readFile(signalPath, "utf8"));
  } finally {
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevOpts === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prevOpts;
    await rm(home, { recursive: true, force: true });
  }
});
