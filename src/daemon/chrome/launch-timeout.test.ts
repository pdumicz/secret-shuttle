import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { launchChrome } from "./launch.js";

test("launchChrome times out and kills the child when the binary never responds on the CDP pipe", async () => {
  // Create a "fake chrome" that just sleeps forever without speaking CDP.
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-fake-chrome-"));
  const fakeChrome = path.join(dir, "fake-chrome");
  await writeFile(
    fakeChrome,
    `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`,
    { encoding: "utf8" },
  );
  await chmod(fakeChrome, 0o755);

  // Point the daemon at the fake binary via the config file.
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = dir;
  await writeFile(
    path.join(dir, "daemon.config.json"),
    JSON.stringify({ version: 1, chromePath: fakeChrome }),
  );

  try {
    const t0 = Date.now();
    await assert.rejects(
      () => launchChrome({ profile: "test" }),
      (err) => err instanceof ShuttleError && err.code === "chrome_startup_timeout",
    );
    const dt = Date.now() - t0;
    // Should fail fast — well within 30s (the timeout is 10s).
    assert.ok(dt < 30_000, `timeout took too long: ${dt}ms`);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
