import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnOptions } from "node:child_process";
import { openUrl } from "./open-url.js";

function withEnv<T>(envOverrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(envOverrides)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("openUrl default behavior: prints to stderr, does NOT spawn a browser opener", () => {
  return withEnv(
    {
      SECRET_SHUTTLE_NO_OPEN_URL: undefined,
      SECRET_SHUTTLE_OPEN_URL: undefined,
    },
    () => {
      let calls = 0;
      const fakeSpawn = (_cmd: string, _args: readonly string[], _options: SpawnOptions) => {
        calls += 1;
        return { on: () => undefined, unref: () => undefined };
      };
      const captured: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        captured.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
        return true;
      }) as typeof process.stderr.write;
      try {
        openUrl("http://127.0.0.1:9999/ui/approve?id=x&token=y", { spawnImpl: fakeSpawn });
      } finally {
        process.stderr.write = origWrite;
      }
      assert.equal(calls, 0, "default must NOT spawn a system opener");
      const stderrText = captured.join("");
      assert.match(stderrText, /http:\/\/127\.0\.0\.1:9999\/ui\/approve\?id=x&token=y/,
        "default must print the URL to stderr so humans can click/copy it");
    },
  );
});

test("openUrl with SECRET_SHUTTLE_NO_OPEN_URL=1 is fully silent (no spawn, no stderr)", () => {
  return withEnv(
    {
      SECRET_SHUTTLE_NO_OPEN_URL: "1",
      SECRET_SHUTTLE_OPEN_URL: undefined,
    },
    () => {
      let calls = 0;
      const fakeSpawn = (_cmd: string, _args: readonly string[], _options: SpawnOptions) => {
        calls += 1;
        return { on: () => undefined, unref: () => undefined };
      };
      const captured: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        captured.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
        return true;
      }) as typeof process.stderr.write;
      try {
        openUrl("http://127.0.0.1:9999/ui/approve?id=x&token=y", { spawnImpl: fakeSpawn });
      } finally {
        process.stderr.write = origWrite;
      }
      assert.equal(calls, 0, "NO_OPEN_URL=1 must NOT spawn");
      assert.equal(captured.join(""), "", "NO_OPEN_URL=1 must not write to stderr either");
    },
  );
});

test("openUrl with SECRET_SHUTTLE_OPEN_URL=1 (opt-in) invokes the system opener without SECRET_SHUTTLE_* in its env", () => {
  return withEnv(
    {
      SECRET_SHUTTLE_NO_OPEN_URL: undefined,
      SECRET_SHUTTLE_OPEN_URL: "1",
      SECRET_SHUTTLE_DAEMON_TOKEN: "leak-me",
      SECRET_SHUTTLE_MASTER_KEY: "leak-me-too",
    },
    () => {
      let calls = 0;
      let capturedOptions: SpawnOptions | undefined;
      const fakeSpawn = (_cmd: string, _args: readonly string[], options: SpawnOptions) => {
        calls += 1;
        capturedOptions = options;
        return { on: () => undefined, unref: () => undefined };
      };

      openUrl("http://127.0.0.1:9999/ui/approve?id=x&token=y", { spawnImpl: fakeSpawn });

      assert.equal(calls, 1, "system opener should be invoked exactly once when opted in");
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
    },
  );
});
