import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnOptions } from "node:child_process";
import { openUrl } from "./open-url.js";

test("openUrl invokes the system opener without SECRET_SHUTTLE_* in its env", () => {
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  const prevToken = process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
  const prevMaster = process.env.SECRET_SHUTTLE_MASTER_KEY;
  // The npm-test harness sets SECRET_SHUTTLE_NO_OPEN_URL=1, which short-circuits
  // openUrl. Clear it for this test, and plant secrets to prove they cannot leak.
  delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_DAEMON_TOKEN = "leak-me";
  process.env.SECRET_SHUTTLE_MASTER_KEY = "leak-me-too";
  try {
    let calls = 0;
    let capturedOptions: SpawnOptions | undefined;
    const fakeSpawn = (_cmd: string, _args: readonly string[], options: SpawnOptions) => {
      calls += 1;
      capturedOptions = options;
      return { on: () => undefined, unref: () => undefined };
    };

    openUrl("http://127.0.0.1:9999/ui/approve?id=x&token=y", { spawnImpl: fakeSpawn });

    assert.equal(calls, 1, "system opener should be invoked exactly once");
    assert.ok(capturedOptions, "spawn options should be provided");
    const env = capturedOptions.env;
    assert.equal(
      typeof env,
      "object",
      "openUrl must pass an explicit env (not inherit the daemon's process.env)",
    );
    assert.ok(env);
    for (const k of Object.keys(env)) {
      assert.equal(
        k.startsWith("SECRET_SHUTTLE_"),
        false,
        `${k} leaked into the system-opener env`,
      );
    }
    assert.equal(capturedOptions.stdio, "ignore", "stdio behavior must stay unchanged");
    assert.equal(capturedOptions.detached, true, "detached behavior must stay unchanged");
  } finally {
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    if (prevToken === undefined) delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
    else process.env.SECRET_SHUTTLE_DAEMON_TOKEN = prevToken;
    if (prevMaster === undefined) delete process.env.SECRET_SHUTTLE_MASTER_KEY;
    else process.env.SECRET_SHUTTLE_MASTER_KEY = prevMaster;
  }
});
