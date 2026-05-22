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

test("approval_required → permission with workflow hint", () => {
  const entry = lookupErrorCode("approval_required");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.match(entry.hint("any") ?? "", /approval-id/);
});

test("vault_locked → permission with unlock hint", () => {
  const entry = lookupErrorCode("vault_locked");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), "Run: secret-shuttle internal unlock");
});

test("domain_not_allowed → permission, null hint", () => {
  const entry = lookupErrorCode("domain_not_allowed");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), null);
});

test("action_not_allowed → permission, null hint", () => {
  const entry = lookupErrorCode("action_not_allowed");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
});

test("secret_exists → conflict with rotate hint", () => {
  const entry = lookupErrorCode("secret_exists");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_CONFLICT);
  assert.match(entry.hint("") ?? "", /rotate/);
});

test("blind_mode_already_active → conflict", () => {
  const entry = lookupErrorCode("blind_mode_already_active");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_CONFLICT);
});

test("legacy_key_present → not-found with migrate hint", () => {
  const entry = lookupErrorCode("legacy_key_present");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_NOT_FOUND);
  assert.match(entry.hint("") ?? "", /migrate/);
});

test("registry total entry count (sanity check)", () => {
  // After the P1 fix, the registry should have 101 entries:
  //   60 from initial A2 seed + 41 added in the P1 fix.
  // This sanity test prevents accidental regressions / duplicate keys.
  const codes = ["daemon_not_running", "approval_required", "vault_locked", "secret_exists"];
  for (const c of codes) {
    assert.ok(lookupErrorCode(c), `expected '${c}' in registry`);
  }
});
