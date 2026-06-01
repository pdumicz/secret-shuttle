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
  /**
   * Return a literal shell command an agent can run for automatic recovery,
   * or null when the error requires human intervention. Always a concrete
   * command string (no prose, no placeholders). Omit the key entirely OR
   * return null for human-required / ambiguous errors.
   */
  nextAction?: (message: string) => string | null;
};

// Seeded with real codes confirmed via grep of src/ for new ShuttleError("...").
// Plans 2–5 incrementally extend this registry as they touch each command.
const REGISTRY: Record<string, ErrorCodeEntry> = {
  // ── Transient (retry-safe) ─────────────────────────────────────────────────
  daemon_not_running: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start",
    nextAction: () => "secret-shuttle daemon start",
  },
  daemon_invalid_response: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon status (then retry)",
    nextAction: () => "secret-shuttle daemon status",
  },
  daemon_start_timeout: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start (verify with: secret-shuttle daemon status)",
    nextAction: () => "secret-shuttle daemon status",
  },
  approval_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  unlock_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  compare_rate_limited: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_cancelled: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  template_spawn_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  spawn_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  browser_not_started: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle browser start",
    nextAction: () => "secret-shuttle browser start",
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
  agent_token_required: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Re-run `secret-shuttle init` to install the agent token, or unset SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN.",
    nextAction: () => "secret-shuttle init",
  },

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
  stdin_ref_in_env_file: { exitCode: EXIT_CODE_USAGE, hint: () => null },
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
  env_file_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  inject_template_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  session_pattern_invalid_glob: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  bootstrap_plan_invalid: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Edit secret-shuttle.yml to fix the schema error, then re-run.",
    // No nextAction: the recovery command depends on which provision mode was
    // running (--yml <path>, --infer, --secret), and the registry has no way
    // to know which one. The human-readable message at the throw-site names
    // the relevant file/mode; the agent reads that and retries with the
    // right command.
    nextAction: () => null,
  },
  bootstrap_capture_url_invalid: {
    exitCode: EXIT_CODE_USAGE,
    hint: () =>
      "source.url for kind=capture must be https, must not embed credentials, must not be an IP literal or localhost. Edit secret-shuttle.yml and re-run.",
    // No nextAction: see bootstrap_plan_invalid above — mode-dependent.
    nextAction: () => null,
  },
  bootstrap_capture_skipped: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Re-run `secret-shuttle provision --continue --batch <id>` to retry the skipped secret.",
  },
  bootstrap_capture_timeout: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "5 minutes elapsed without a capture. Re-run `secret-shuttle provision --continue --batch <id>` and click Capture promptly.",
  },
  bootstrap_capture_aborted: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => null,
  },
  bootstrap_destination_unknown: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Edit secret-shuttle.yml: replace the unknown destination shorthand with one of: vercel:<env>, github-actions:owner/repo, cloudflare:<env>, supabase:<projectref>.",
    // No nextAction: see bootstrap_plan_invalid above — mode-dependent.
    nextAction: () => null,
  },
  agent_id_namespace_violation: {
    exitCode: EXIT_CODE_USAGE,
    hint: () =>
      "Non-root callers can only mint children under their own agent_id prefix (e.g., caller \"claude-7f2a\" can mint \"claude-7f2a.helper-3a1b\"). Re-run with --child-id starting with your own agent_id followed by a dot.",
  },
  agent_id_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  command_renamed: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => null,
    // No nextAction: a bare `secret-shuttle provision` would itself fail
    // with provision_no_mode, so chaining it as a "recovery" command would
    // produce a second error. The bootstrap-stub throw-site (Task 1.6)
    // names the replacement verb in the human-readable message; the agent
    // reads that and picks the correct mode flag.
  },
  provision_mode_conflict: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Pass exactly one of: --infer, --yml, --secret, --continue, --list, --abandon.",
  },
  provision_no_mode: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Pass --infer, --yml, --secret, --continue, --list, or --abandon.",
  },
  session_ttl_exceeds_cap: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Reduce ttl_minutes (max 60).",
  },

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
    nextAction: () => "secret-shuttle init",
  },
  envelope_missing: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle init",
    nextAction: () => "secret-shuttle init",
  },
  mark_focused_unavailable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  mark_pick_no_actionable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  unknown_browser_domain: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  chrome_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  legacy_key_present: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle migrate secure-vault",
    nextAction: () => "secret-shuttle migrate secure-vault",
  },
  package_json_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  repository_field_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  skill_bundled_file_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  skill_frontmatter_invalid: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  template_tmpdir_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  env_file_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  session_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  bootstrap_batch_not_found: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "The batch was pruned or never existed. The right recovery depends on context — generate a fresh plan, or look up the batch first.",
    nextAction: () => null,
  },
  infer_no_env_example: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Create a .env.example listing your secret names, then re-run.",
  },

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
    // Single-approval ops: read approval_id from the message JSON.
    // Multi-approval ops: read details.approvals (array of {approval_id, expires_at, action}).
    // Either way, retry with --approval-id <id> (repeatable for each pending approval).
    hint: () => "Approve in the opened hub, then retry with --approval-id <id> (repeatable for each id listed under details.approvals).",
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
    nextAction: () => "secret-shuttle unlock",
  },
  inject_output_path_unsafe: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  inject_output_write_failed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  session_expired: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  session_max_uses_exceeded: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  session_pattern_no_match: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  session_revoked: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  session_unauthorized: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  agent_token_invalid: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "The agent token did not validate. Re-run `secret-shuttle init` after the daemon owner has rotated.",
    nextAction: () => "secret-shuttle init",
  },

  // ── Conflict ───────────────────────────────────────────────────────────────
  already_migrated: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  browser_already_started: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  blind_mode_active: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  blind_mode_already_active: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  bootstrap_batch_busy: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "The batch is already executing. Wait for the current run to finish, then retry.",
    nextAction: () => null, // retrying immediately is wrong; the user should wait
  },
  bootstrap_capture_redirect_blocked: {
    // CONFLICT (not USAGE): the user's argv is fine — the page state isn't
    // what the yml said it would be. The recovery is for the human to
    // navigate the capture tab back to the expected host and re-trigger
    // capture; the daemon can't fix this automatically.
    exitCode: EXIT_CODE_CONFLICT,
    hint: () =>
      "The capture tab is no longer on the host declared in secret-shuttle.yml. Navigate back to the expected host (or fix the yml) and retry the capture step.",
    nextAction: () => null,
  },
  bootstrap_capture_field_unreadable: {
    // CONFLICT: the capture tab IS on the expected host (no redirect), but
    // the page state doesn't match what the executor needs to read — either
    // no element is focused, the focused element isn't a text field, or the
    // mode (focused-field vs selection) doesn't match the actual page state.
    // The recovery is human: click into the right field / set or clear the
    // selection, then re-trigger capture.
    exitCode: EXIT_CODE_CONFLICT,
    hint: () =>
      "The capture tab is on the expected host, but the focused field is missing or the selection state doesn't match. Click into the field containing the secret (clearing any selection if you requested focused-field, or selecting the text if you requested selection) and re-trigger capture.",
    nextAction: () => null,
  },
  bootstrap_capture_cleanup_failed: {
    // CONFLICT: cleanup verification could not confirm the bootstrap-owned
    // capture tab is closed, so the daemon halts and asks the human to
    // close it manually then `blind end` to release the residual blind
    // mode the executor left active for safety. nextAction is the explicit
    // recovery command so agents can execute it without prose-parsing.
    exitCode: EXIT_CODE_CONFLICT,
    hint: () =>
      "The capture browser tab could not be verified closed. Close it manually if open, then run `secret-shuttle blind end`.",
    nextAction: () => "secret-shuttle blind end",
  },
  bootstrap_batch_abandoned: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "This batch was abandoned. Start a new one with `secret-shuttle provision --yml ./secret-shuttle.yml` (or `--infer`).",
    nextAction: () => null,
  },
  bootstrap_browser_busy: {
    // CONFLICT: another bootstrap batch already owns the daemon-owned browser.
    // Two concurrent capture batches must not share Chrome — batch A's
    // teardown would race batch B's in-flight capture. The recovery is to
    // wait for the in-flight batch to finish, then retry.
    exitCode: EXIT_CODE_CONFLICT,
    hint: () =>
      "Another bootstrap batch owns the daemon-owned browser. Wait for it to finish, then retry.",
    nextAction: () => null,
  },
  daemon_rotate_in_progress: {
    // CONFLICT: another /v1/daemon/rotate call is mid-flight. Rotate mutates
    // file + socket + in-memory token state in sequence, and two concurrent
    // rotates would interleave those writes (and also race on the shared
    // root-token.tmp path). Fail-fast and let the second caller retry once
    // the in-flight rotate releases.
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "Retry after the in-flight rotate completes.",
    nextAction: () => null,
  },
  secret_exists: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "Re-run with --force to overwrite.",
  },
  snippet_ambiguous: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  template_env_file_collision: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  template_env_file_write_failed: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  session_not_pending: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  machine_id_bad_mode: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "<SHUTTLE_HOME>/machine-id exists with the wrong mode. `chmod 600` it, or delete the file to regenerate.",
  },
  machine_id_malformed: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "<SHUTTLE_HOME>/machine-id content is not a 43-char base64url-no-pad string. Delete it to regenerate, or restore from a backup.",
  },
  root_token_bad_mode: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "<SHUTTLE_HOME>/root-token exists with the wrong mode. `chmod 600` it.",
  },
  root_token_malformed: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "<SHUTTLE_HOME>/root-token content is not a 43-char base64url-no-pad string. Delete it to regenerate (note: this also invalidates all derived agent tokens).",
  },
  infer_yml_exists: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "Re-run with --force to overwrite, or --dry-run to stdout only.",
    // No nextAction in the registry: the correct recovery command depends
    // on whether the user originally passed --environment <env>. The static
    // registry function has no access to runtime opts, so the recovery
    // string is constructed at the throw-site in runInferMode (src/cli/
    // commands/provision.ts) where opts.environment is in scope. Matches
    // the P1.1 round-19 precedent (bootstrap_plan_invalid,
    // bootstrap_capture_url_invalid, bootstrap_destination_unknown).
    nextAction: () => null,
  },

  // ── Audit-route codes ──────────────────────────────────────────────────────
  audit_window_invalid: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Pass --since with format Ns/Nm/Nh/Nd (e.g., 5m, 1h, 1d).",
  },
  audit_batch_not_found: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => null,
  },

  // ── Keychain (Part B; full implementations come in Plan 5a) ────────────────
  keychain_not_implemented: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock until Plan 5a wires the native keychain adapter.",
    nextAction: () => "secret-shuttle unlock",
  },
  keychain_unavailable: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock; verify your OS keyring is reachable.",
    nextAction: () => "secret-shuttle unlock",
  },
  keychain_key_invalid: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Cached keychain entry doesn't unlock the vault. Run: secret-shuttle unlock",
    nextAction: () => "secret-shuttle unlock",
  },

  // ── Recipe capture/inject (per-provider hands-off magic) ────────────────────
  recipe_selector_ambiguous: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "A recipe selector matched 0 or >1 elements; manual capture/inject needed.",
  },
  recipe_capture_failed: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Recipe ran but the transition gate yielded no value.",
  },
  bootstrap_login_required: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Log into the provider in the open Secret Shuttle browser tab, then re-run --continue.",
  },
  recipe_page_timeout: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "The recipe page never finished loading (bad URL / changed DOM / network).",
  },
  recipe_page_unexpected: {
    exitCode: EXIT_CODE_CONFLICT,
    hint: () => "Page loaded but the logged-in scope probe was absent (wrong project/team, permission, or onboarding). Inspect the visible tab.",
  },
  recipe_inject_failed: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Recipe inject submitted but the success text was not observed; retryable.",
  },
  recipe_not_found: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "No recipe is registered for this provider host/direction.",
  },

};

export function lookupErrorCode(code: string): ErrorCodeEntry | null {
  return REGISTRY[code] ?? null;
}

export function listKnownErrorCodes(): string[] {
  return Object.keys(REGISTRY).sort();
}
