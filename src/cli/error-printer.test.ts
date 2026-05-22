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

import { daemonErrorFromPayload } from "../client/daemon-client.js";

test("End-to-end: daemon payload → CLI stderr preserves the full 6-field contract", () => {
  // Simulate exactly what the daemon emits over HTTP for a not-found error:
  const daemonPayload = {
    ok: false,
    error: { code: "secret_not_found", message: "No such ref" },
    error_code: "secret_not_found",
    message: "No such ref",
    hint: "Run: secret-shuttle secrets list",
    exit_code: 3,
  };

  // Client side: reconstruct → re-emit (this is what stderr will print)
  const err = daemonErrorFromPayload(daemonPayload);
  const stderr = JSON.parse(JSON.stringify(errorToJson(err)));

  // Both shapes intact after the full round-trip:
  assert.equal(stderr.ok, false);
  assert.deepEqual(stderr.error, { code: "secret_not_found", message: "No such ref" });
  assert.equal(stderr.error_code, "secret_not_found");
  assert.equal(stderr.message, "No such ref");
  assert.equal(stderr.hint, "Run: secret-shuttle secrets list");
  assert.equal(stderr.exit_code, 3);
});

test("End-to-end: daemon with explicit null hint reaches CLI as null (no registry fallback)", () => {
  // I-2 regression test from the daemon side: if the daemon emits explicit
  // null hint, that explicit suppression must survive the round-trip.
  const daemonPayload = {
    ok: false,
    error: { code: "daemon_not_running", message: "Down" },
    error_code: "daemon_not_running",
    message: "Down",
    hint: null,
    exit_code: 1,
  };
  const err = daemonErrorFromPayload(daemonPayload);
  const stderr = JSON.parse(JSON.stringify(errorToJson(err)));
  assert.equal(stderr.hint, null);
});
