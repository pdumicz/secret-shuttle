// Exit code policy per Sol/Memori convention. See spec §5.6.
export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_TRANSIENT = 1;   // retry-safe (network, daemon temporarily down)
export const EXIT_CODE_USAGE = 2;       // bad argv / missing required flag
export const EXIT_CODE_NOT_FOUND = 3;   // ref / template / file missing
export const EXIT_CODE_PERMISSION = 4;  // approval denied / vault locked / domain mismatch
export const EXIT_CODE_CONFLICT = 5;    // ref already exists / already running

export type ErrorCodeEntry = {
  exitCode: number;
  /**
   * Build a hint string given the error's runtime message. Return null if no
   * actionable recovery command exists (the human has to intervene).
   */
  hint: (message: string) => string | null;
};

// Seeded with real codes confirmed via grep of src/ for new ShuttleError("...").
// Plans 2–5 incrementally extend this registry as they touch each command.
const REGISTRY: Record<string, ErrorCodeEntry> = {
  // ── Transient (retry-safe) ─────────────────────────────────────────────────
  daemon_not_running: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start",
  },
  daemon_invalid_response: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon status (then retry)",
  },
  daemon_start_timeout: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start (verify with: secret-shuttle daemon status)",
  },
  approval_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  unlock_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  compare_rate_limited: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_cancelled: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  template_spawn_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  browser_not_started: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle browser start",
  },
  auto_resume_precondition: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  blank_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  chrome_startup_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  click_hit_test_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  click_no_box: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  click_occluded: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  click_offscreen: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  inject_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  inject_focus_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  reveal_baseline_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  reveal_no_transition: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  reveal_resolve_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },

  // ── Usage (fix argv; don't retry) ──────────────────────────────────────────
  invalid_ref: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_json: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  bad_request: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  missing_param: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  missing_allow_domain: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Add: --allow-domain <domain>",
  },
  unsupported_target: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_source: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_daemon_config: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_envelope: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_vault: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_key_storage: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_profile: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_template_param: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  request_too_large: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  mark_kind_unsupported: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  handle_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  handle_kind_mismatch: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_env_var_name: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_environment: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_name: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_source: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_vault: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  removed_in_secure_mode: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  template_definition_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_repository_host: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_secret_kind: { exitCode: EXIT_CODE_USAGE, hint: () => null },

  // ── Not found ──────────────────────────────────────────────────────────────
  not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  secret_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  template_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  approval_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  handle_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  no_legacy_vault: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  unlock_session_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  vault_not_initialized: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle init",
  },
  envelope_missing: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle init",
  },
  mark_focused_unavailable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  mark_pick_no_actionable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  unknown_browser_domain: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  chrome_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  legacy_key_present: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle migrate secure-vault",
  },
  package_json_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  repository_field_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  skill_bundled_file_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  template_tmpdir_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },

  // ── Permission ─────────────────────────────────────────────────────────────
  bad_host: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  unauthorized: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  vault_unlock_failed: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Re-run unlock (passphrase entered in browser window).",
  },
  invalid_master_key: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  invalid_passphrase: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  passphrase_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_denied: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_expired: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_already_used: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_not_granted: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_not_pending: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  domain_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  unsafe_binary_path: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  binary_hash_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  ui_token_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  inject_focus_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  field_changed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  reveal_read_failed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  action_not_allowed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  approval_required: {
    exitCode: EXIT_CODE_PERMISSION,
    // The thrown message is JSON: {approval_id, expires_at}. The hint
    // tells the agent how to recover.
    hint: () => "Approve in the daemon UI, then re-run with --approval-id <id> (id is in the message JSON).",
  },
  blind_mode_domain_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  blind_mode_required: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  domain_not_allowed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  handle_target_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  reveal_not_contained: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  vault_decryption_failed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  vault_locked: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Run: secret-shuttle unlock",
  },

  // ── Conflict ───────────────────────────────────────────────────────────────
  already_migrated: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  browser_already_started: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  blind_mode_active: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  blind_mode_already_active: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  secret_exists: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "Re-run with --force to overwrite.",
  },
  snippet_ambiguous: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  template_env_file_collision: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  template_env_file_write_failed: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },

  // ── Keychain (Part B; full implementations come in Plan 5a) ────────────────
  keychain_not_implemented: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock until Plan 5a wires the native keychain adapter.",
  },
  keychain_unavailable: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock; verify your OS keyring is reachable.",
  },
};

export function lookupErrorCode(code: string): ErrorCodeEntry | null {
  return REGISTRY[code] ?? null;
}

export function listKnownErrorCodes(): string[] {
  return Object.keys(REGISTRY).sort();
}
