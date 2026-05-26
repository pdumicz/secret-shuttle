import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupErrorCode, listKnownErrorCodes, EXIT_CODE_SUCCESS, EXIT_CODE_TRANSIENT, EXIT_CODE_USAGE, EXIT_CODE_NOT_FOUND, EXIT_CODE_PERMISSION, EXIT_CODE_CONFLICT } from "./error-codes.js";

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

test("daemon_invalid_response → transient with daemon-status hint", () => {
  const entry = lookupErrorCode("daemon_invalid_response");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint(""), "Run: secret-shuttle daemon status (then retry)");
});

test("daemon_start_timeout → transient with daemon-start + verify hint", () => {
  const entry = lookupErrorCode("daemon_start_timeout");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(
    entry.hint(""),
    "Run: secret-shuttle daemon start (verify with: secret-shuttle daemon status)",
  );
});

test("unknown codes return null from lookup", () => {
  const entry = lookupErrorCode("totally_made_up_code");
  assert.equal(entry, null);
});

test("approval_required → permission with workflow hint", () => {
  const entry = lookupErrorCode("approval_required");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(
    entry.hint("any"),
    "Approve in the opened hub, then retry with --approval-id <id> (repeatable for each id listed under details.approvals).",
  );
});

test("vault_locked → permission with unlock hint", () => {
  const entry = lookupErrorCode("vault_locked");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), "Run: secret-shuttle unlock");
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

test("secret_exists → conflict with --force hint", () => {
  const entry = lookupErrorCode("secret_exists");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_CONFLICT);
  assert.equal(entry.hint(""), "Re-run with --force to overwrite.");
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
  assert.equal(entry.hint(""), "Run: secret-shuttle migrate secure-vault");
});

test("registry total entry count (sanity check)", () => {
  // 60 from initial A2 seed + 41 added in the P1 coverage fix + 3 added in
  // Plan 2 Task E1 (bad_host, unauthorized, not_found for server.ts
  // pre-handler error paths) = 104 total.
  // Plan 3 Task B2 adds 6 more (spawn_failed, env_file_parse_error,
  // inject_template_parse_error, env_file_not_found, inject_output_path_unsafe,
  // inject_output_write_failed) = 110 total.
  // Plan 4a Task C1 adds 7 more session-related codes = 117 total.
  // Plan 4a post-review P1 adds 1 more (session_revoked) = 118 total.
  // Plan 4c Task A adds 1 more (stdin_ref_in_env_file) = 119 total.
  // Plan 5b/5f Task E adds 1 more (keychain_key_invalid) = 120 total.
  // Plan 5g Tasks E+F adds 3 more (bootstrap_plan_invalid,
  // bootstrap_batch_not_found, bootstrap_destination_unknown) = 123 total.
  // Note: daemon_start_failed was removed (P3.1) — it was registered but never
  // thrown; init startup failures surface daemon_start_timeout instead.
  // Catches accidental duplicate keys, dropped entries, or unreviewed
  // expansions.
  const codes = listKnownErrorCodes();
  assert.equal(codes.length, 123, `expected 123 registry entries, got ${codes.length}`);

  // Spot-check a representative slice — one entry per exit-code class.
  for (const c of ["daemon_not_running", "missing_param", "secret_not_found", "approval_denied", "secret_exists"]) {
    assert.ok(lookupErrorCode(c), `expected '${c}' in registry`);
  }

  // Spot-check new B2 entries.
  assert.ok(lookupErrorCode("env_file_parse_error"));
  assert.ok(lookupErrorCode("inject_output_path_unsafe"));
  assert.ok(lookupErrorCode("spawn_failed"));

  // Spot-check new C1 session entries.
  for (const c of ["session_not_found", "session_expired", "session_max_uses_exceeded", "session_pattern_no_match", "session_pattern_invalid_glob"]) {
    assert.ok(lookupErrorCode(c), `${c} should be registered`);
  }

  // Spot-check post-review session_revoked addition (Plan 4a P1 fix).
  const revoked = lookupErrorCode("session_revoked");
  assert.ok(revoked, "session_revoked should be registered");
  assert.equal(revoked.exitCode, EXIT_CODE_PERMISSION);

  // Spot-check Plan 4c Task A addition.
  const stdinRef = lookupErrorCode("stdin_ref_in_env_file");
  assert.ok(stdinRef, "stdin_ref_in_env_file should be registered");
  assert.equal(stdinRef.exitCode, EXIT_CODE_USAGE);
});

test("error-codes: stdin_ref_in_env_file registered with USAGE exit code", () => {
  const entry = lookupErrorCode("stdin_ref_in_env_file");
  assert.ok(entry, "stdin_ref_in_env_file must be registered");
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
  assert.equal(entry.hint(""), null);
});

test("error-codes: keychain_key_invalid registered with PERMISSION exit code + nextAction", () => {
  const entry = lookupErrorCode("keychain_key_invalid");
  assert.ok(entry, "keychain_key_invalid must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle unlock");
});

test("error-codes: bootstrap_plan_invalid registered with USAGE exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_plan_invalid");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_USAGE);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});

test("error-codes: bootstrap_batch_not_found registered with NOT_FOUND exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_batch_not_found");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_NOT_FOUND);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});

test("error-codes: bootstrap_destination_unknown registered with USAGE exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_destination_unknown");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_USAGE);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});

test("error-codes: daemon_not_running has nextAction (mechanical recovery)", () => {
  const entry = lookupErrorCode("daemon_not_running");
  assert.ok(entry?.nextAction);
  assert.strictEqual(entry!.nextAction!(""), "secret-shuttle daemon start");
});

test("error-codes: vault_locked has nextAction (mechanical recovery)", () => {
  const entry = lookupErrorCode("vault_locked");
  assert.ok(entry?.nextAction);
  assert.strictEqual(entry!.nextAction!(""), "secret-shuttle unlock");
});

test("error-codes: vault_not_initialized has nextAction (mechanical recovery)", () => {
  const entry = lookupErrorCode("vault_not_initialized");
  assert.ok(entry?.nextAction);
  assert.strictEqual(entry!.nextAction!(""), "secret-shuttle init");
});

test("error-codes: approval_denied has no automatic nextAction (human required)", () => {
  const entry = lookupErrorCode("approval_denied");
  const result = entry?.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(result, null);
});

test("error-codes: approval_required has no automatic nextAction (human required)", () => {
  const entry = lookupErrorCode("approval_required");
  const result = entry?.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(result, null);
});

test("error-codes: browser_not_started has nextAction (mechanical recovery)", () => {
  const entry = lookupErrorCode("browser_not_started");
  assert.ok(entry?.nextAction);
  assert.strictEqual(entry!.nextAction!(""), "secret-shuttle browser start");
});

test("error-codes: legacy_key_present has nextAction (mechanical recovery)", () => {
  const entry = lookupErrorCode("legacy_key_present");
  assert.ok(entry?.nextAction);
  assert.strictEqual(entry!.nextAction!(""), "secret-shuttle migrate secure-vault");
});

