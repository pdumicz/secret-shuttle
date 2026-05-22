import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

test("generateCommand description marks the command as deprecated", async () => {
  const { generateCommand } = await import("./generate.js");
  const cmd = generateCommand();
  assert.match(cmd.description(), /deprecated/i);
});

test("generateCommand subprocess: stderr is a single JSON document with error_code AND warning when daemon is down", async () => {
  // Point SECRET_SHUTTLE_HOME at a fresh tempdir — no daemon socket exists,
  // so the request deterministically fails with daemon_not_running. The
  // shim's deprecation warning must still be spliced into the error JSON,
  // and stderr must remain a single parseable JSON document (no human
  // [deprecated] line — that's reserved for the success path).
  //
  // Use --env local so we don't trip the production --allow-domain
  // requirement before daemon_not_running fires.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shuttle-generate-shim-test-"));
  try {
    const res = spawnSync(
      process.execPath,
      [
        "dist/cli/index.js",
        "generate",
        "--name",
        "DEV_TEST_KEY",
        "--env",
        "local",
      ],
      {
        env: {
          ...process.env,
          SECRET_SHUTTLE_HOME: tmp,
          SECRET_SHUTTLE_NO_OPEN_URL: "1",
        },
        encoding: "utf8",
      },
    );
    const stderr = res.stderr.trim();
    // Single parseable JSON document.
    const parsed = JSON.parse(stderr) as Record<string, unknown>;
    assert.equal(parsed.error_code, "daemon_not_running");
    const warning = parsed.warning as Record<string, unknown>;
    assert.ok(warning, "warning field must be present on the failure path");
    assert.equal(warning.deprecated, "generate");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
