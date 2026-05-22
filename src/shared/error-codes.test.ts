import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupErrorCode, EXIT_CODE_SUCCESS, EXIT_CODE_TRANSIENT, EXIT_CODE_USAGE, EXIT_CODE_NOT_FOUND, EXIT_CODE_PERMISSION, EXIT_CODE_CONFLICT } from "./error-codes.js";

test("EXIT_CODE constants follow Sol convention", () => {
  assert.equal(EXIT_CODE_SUCCESS, 0);
  assert.equal(EXIT_CODE_TRANSIENT, 1);
  assert.equal(EXIT_CODE_USAGE, 2);
  assert.equal(EXIT_CODE_NOT_FOUND, 3);
  assert.equal(EXIT_CODE_PERMISSION, 4);
  assert.equal(EXIT_CODE_CONFLICT, 5);
});

test("daemon_not_running → transient with daemon-start hint", () => {
  const entry = lookupErrorCode("daemon_not_running");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint("anything"), "Run: secret-shuttle daemon start");
});

test("invalid_ref → usage error, null hint", () => {
  const entry = lookupErrorCode("invalid_ref");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
  assert.equal(entry.hint("anything"), null);
});

test("secret_not_found → not-found exit code (corrects earlier ref_not_found typo)", () => {
  const entry = lookupErrorCode("secret_not_found");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_NOT_FOUND);
});

test("missing_param → usage error (the real code; not missing_required_param)", () => {
  const entry = lookupErrorCode("missing_param");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
});

test("domain_mismatch → permission error", () => {
  const entry = lookupErrorCode("domain_mismatch");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
});

test("approval_denied → permission, null hint", () => {
  const entry = lookupErrorCode("approval_denied");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), null);
});

test("browser_not_started → transient with browser-start hint", () => {
  const entry = lookupErrorCode("browser_not_started");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint(""), "Run: secret-shuttle browser start");
});

test("unknown codes return null from lookup", () => {
  const entry = lookupErrorCode("totally_made_up_code");
  assert.equal(entry, null);
});
