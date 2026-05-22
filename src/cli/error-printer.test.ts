import { test } from "node:test";
import assert from "node:assert/strict";
import { ShuttleError, errorToJson } from "../shared/errors.js";

test("CLI error path: registry-known code emits the full contract (nested + flat)", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err);

  // What stderr will print:
  const printed = JSON.stringify(j, null, 2);
  const parsed = JSON.parse(printed);

  assert.equal(parsed.ok, false);
  // Legacy nested block:
  assert.equal(parsed.error.code, "daemon_not_running");
  assert.equal(parsed.error.message, "Daemon not running");
  // Flat agent-friendly fields:
  assert.equal(parsed.error_code, "daemon_not_running");
  assert.equal(parsed.message, "Daemon not running");
  assert.equal(parsed.hint, "Run: secret-shuttle daemon start");
  assert.equal(parsed.exit_code, 1);
});

test("CLI error path: ShuttleError exit code propagates via .exitCode", () => {
  const err = new ShuttleError("approval_denied", "User denied");
  // process.exitCode would be set to err.exitCode in src/cli/index.ts:57
  assert.equal(err.exitCode, 4);
});
