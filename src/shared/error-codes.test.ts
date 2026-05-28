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
  // 5g R11 adds 1 more (bootstrap_batch_busy) = 124 total.
  // Burst 4 Task A12 adds 1 more (agent_id_namespace_violation, surfaced by
  // POST /v1/tokens/mint when a non-root caller requests an agent_id outside
  // its own namespace prefix) = 125 total.
  // Burst 4 Task A15 adds 7 more for Phase A per-agent tokens
  // (agent_token_required, agent_token_invalid, agent_id_invalid,
  // machine_id_bad_mode, machine_id_malformed, root_token_bad_mode,
  // root_token_malformed) = 132 total.
  // Burst 4 Task C1 adds 1 more (bootstrap_capture_url_invalid) = 133 total.
  // Burst 4 Task C6 adds 1 more (bootstrap_capture_redirect_blocked) = 134.
  // Burst 4 Task C8 adds 1 more (bootstrap_batch_abandoned) = 135.
  // Burst 4 Task C16 adds 4 more (bootstrap_capture_skipped,
  // bootstrap_capture_timeout, bootstrap_capture_aborted,
  // bootstrap_capture_cleanup_failed) = 139 total.
  // Burst 4 pre-launch review adds 1 more (bootstrap_browser_busy — emitted
  // when two concurrent bootstrap batches try to share the daemon-owned
  // browser) = 140 total.
  // Burst 4 Tier 2 cleanup T2 adds 1 more (bootstrap_capture_field_unreadable —
  // split from bootstrap_capture_redirect_blocked for the three non-redirect
  // "field state unreadable" cases: no_active_element, not_editable, and
  // mode mismatch in either direction) = 141 total.
  // Burst 4 Tier 2 review fix adds 1 more (daemon_rotate_in_progress —
  // emitted by /v1/daemon/rotate when a concurrent rotate is already
  // mid-flight) = 142 total.
  // Burst 5 Task 1.1 adds 8 more (command_renamed, provision_mode_conflict,
  // provision_no_mode, session_ttl_exceeds_cap, infer_no_env_example,
  // infer_yml_exists, audit_window_invalid, audit_batch_not_found) = 150 total.
  // Note: daemon_start_failed was removed (P3.1) — it was registered but never
  // thrown; init startup failures surface daemon_start_timeout instead.
  // Catches accidental duplicate keys, dropped entries, or unreviewed
  // expansions.
  const codes = listKnownErrorCodes();
  assert.equal(codes.length, 150, `expected 150 registry entries, got ${codes.length}`);

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

test("error-codes: bootstrap_capture_url_invalid registered with USAGE exit code + nextAction + hint", () => {
  const entry = lookupErrorCode("bootstrap_capture_url_invalid");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_USAGE);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
  assert.match(
    entry.hint("") ?? "",
    /https/,
    "bootstrap_capture_url_invalid hint should mention https",
  );
});

test("error-codes: bootstrap_capture_redirect_blocked registered with CONFLICT + human-required (no nextAction)", () => {
  // C6 throws this when the bootstrap capture tab has navigated away from the
  // yml-validated expected_host between /plan and the at-capture-time URL
  // re-read. CONFLICT is the right class: the page state isn't what the yml
  // promised, but the user's argv is fine. There is no mechanical recovery —
  // the human has to navigate back, or fix the yml.
  const entry = lookupErrorCode("bootstrap_capture_redirect_blocked");
  assert.ok(entry, "bootstrap_capture_redirect_blocked must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_CONFLICT);
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null, "no automatic recovery — human must navigate");
  assert.match(
    entry.hint("") ?? "",
    /expected host/i,
    "hint should reference the expected host",
  );
});

test("bootstrap_capture_field_unreadable → CONFLICT exit + field-focus hint", () => {
  // T2 split: the three non-redirect failure modes of captureFromTarget
  // (no_active_element, not_editable, mode mismatch) now surface as this
  // code instead of bootstrap_capture_redirect_blocked. The hint must
  // point the user at the focused-field recovery, not the redirect one.
  const entry = lookupErrorCode("bootstrap_capture_field_unreadable");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_CONFLICT);
  assert.match(entry.hint("") ?? "", /focused field/i);
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null, "no automatic recovery — human must focus the field");
});

test("error-codes: bootstrap_browser_busy registered with CONFLICT + null nextAction", () => {
  // Emitted when ensureBootstrapBrowser is called for a batch while a
  // DIFFERENT bootstrap batch already owns the daemon-owned browser. No
  // automatic recovery — the user (or a retry policy) must wait for the
  // in-flight batch to finish, then retry.
  const entry = lookupErrorCode("bootstrap_browser_busy");
  assert.ok(entry, "bootstrap_browser_busy must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_CONFLICT);
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null, "no automatic recovery — caller must wait");
  assert.match(
    entry.hint("") ?? "",
    /another bootstrap batch/i,
    "hint should reference another bootstrap batch holding the browser",
  );
});

test("error-codes: bootstrap_batch_abandoned registered with CONFLICT + null nextAction (C8)", () => {
  const entry = lookupErrorCode("bootstrap_batch_abandoned");
  assert.ok(entry, "bootstrap_batch_abandoned must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_CONFLICT);
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null, "no automatic recovery — user must start a new batch");
  assert.match(
    entry.hint("") ?? "",
    /abandoned/i,
    "hint should reference that the batch was abandoned",
  );
});

test("error-codes: bootstrap_capture_skipped → TRANSIENT exit + retry hint (C16)", () => {
  const entry = lookupErrorCode("bootstrap_capture_skipped");
  assert.ok(entry, "bootstrap_capture_skipped must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.match(entry.hint("") ?? "", /Re-run bootstrap/);
  // No nextAction: re-running bootstrap is the same command the user just
  // invoked, so a literal recovery command would be redundant; the hint
  // already names it.
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null);
});

test("error-codes: bootstrap_capture_timeout → TRANSIENT exit + timeout hint (C16)", () => {
  const entry = lookupErrorCode("bootstrap_capture_timeout");
  assert.ok(entry, "bootstrap_capture_timeout must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.match(entry.hint("") ?? "", /5 minutes/);
  assert.match(entry.hint("") ?? "", /Capture/);
});

test("error-codes: bootstrap_capture_aborted → TRANSIENT exit, null hint (C16)", () => {
  const entry = lookupErrorCode("bootstrap_capture_aborted");
  assert.ok(entry, "bootstrap_capture_aborted must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_TRANSIENT);
  // No hint: the user explicitly aborted, so there's nothing actionable to
  // suggest. Re-running bootstrap is allowed but no nag.
  assert.strictEqual(entry.hint(""), null);
});

test("error-codes: bootstrap_capture_cleanup_failed → CONFLICT exit + nextAction blind-end (C16)", () => {
  const entry = lookupErrorCode("bootstrap_capture_cleanup_failed");
  assert.ok(entry, "bootstrap_capture_cleanup_failed must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_CONFLICT);
  assert.match(entry.hint("") ?? "", /capture browser tab/);
  assert.match(entry.hint("") ?? "", /blind end/);
  // Explicit recovery command so an agent can execute it directly.
  assert.ok(entry.nextAction);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle blind end");
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

