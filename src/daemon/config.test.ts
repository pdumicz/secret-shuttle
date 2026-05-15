import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { readDaemonConfig } from "./config.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-config-"));
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

test("readDaemonConfig returns null when the file does not exist", async () => {
  await withHome(async () => {
    assert.equal(await readDaemonConfig(), null);
  });
});

test("readDaemonConfig parses chromePath from a valid v1 config", async () => {
  await withHome(async (home) => {
    await writeFile(
      path.join(home, "daemon.config.json"),
      JSON.stringify({ version: 1, chromePath: "/usr/local/bin/google-chrome" }),
    );
    const cfg = await readDaemonConfig();
    assert.equal(cfg?.chromePath, "/usr/local/bin/google-chrome");
  });
});

test("readDaemonConfig rejects unknown versions", async () => {
  await withHome(async (home) => {
    await writeFile(
      path.join(home, "daemon.config.json"),
      JSON.stringify({ version: 99 }),
    );
    await assert.rejects(
      () => readDaemonConfig(),
      (err) => err instanceof ShuttleError && err.code === "unsupported_daemon_config",
    );
  });
});
