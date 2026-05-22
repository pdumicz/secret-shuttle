# Changelog

## Unreleased

### Added
- Structured error contract: every CLI error now emits both the legacy nested `error: { code, message }` block AND flat agent-friendly fields (`error_code`, `message`, `hint`, `exit_code`). `hint` is the literal recovery command (or null when the human must intervene); `exit_code` follows Sol convention (0 success, 1 transient, 2 usage, 3 not-found, 4 permission, 5 conflict).
- `src/shared/error-codes.ts`: central registry seeded with real codes from the current codebase (`secret_not_found`, `missing_param`, `domain_mismatch`, `approval_*`, `browser_not_started`, `vault_unlock_failed`, etc.). The audit of remaining throw sites continues incrementally across Plans 2–5.
- `src/vault/keychain/` module: `KeychainAdapter` interface + platform dispatcher + per-platform stubs (`darwin.ts`, `linux.ts`, `windows.ts`) that throw a typed `keychain_not_implemented` error with a passphrase-fallback hint. Plan 5a replaces the stubs with native-module-backed implementations (likely `@napi-rs/keyring`).

### Changed
- `ShuttleError` constructor now accepts an `opts` object (`{ exitCode, hint }`) in addition to the legacy positional `exitCode` number. Existing call sites continue to work unchanged; defaults flow from the new registry.
- `src/client/daemon-client.ts` now preserves daemon-provided `hint` and `exit_code` through CLI-side reconstruction (previously dropped). Exposes `daemonErrorFromPayload(payload)` for testability. Tolerant of both the nested `error: { code, message }` block and the flat `error_code` / `message` shape.

### Security
- Deliberately did NOT ship a `security`-CLI-based macOS keychain implementation. The `add-generic-password -w <pw>` form puts the password in argv (recoverable via `ps`), contradicting Secret Shuttle's vault-key-never-leaks guarantee. Plan 5a replaces the stub with a native-module adapter that accepts the password through memory.

### Added — Plan 2 (CLI surface)
- `secrets` command group (`list` / `get-ref` / `set` / `delete` / `rotate`). `set` is a rename of `generate`; `--kind paste` is reserved and rejected with a deferral hint. `delete` is a soft-delete with audit trail; the soft-delete invariant is enforced inside `Vault` so every operational consumer (`inject`, `compare`, `template run`, `inject-submit`, `reveal-capture`) inherits it without per-caller changes. `rotate` generates a new ref and marks the old one as `rotating`; the destination re-push plan is empty in this release (audit-log destination synthesis is a follow-up improvement).
- `status` command (rename of `doctor`) emits `ready: boolean` + `next_action: string | null` at the top level so agents can drive a state machine without inspecting nested fields. Existing `doctor` text formatting is preserved inside the `report` field.
- `internal` command group (hidden from default `--help`) absorbs the power-user / deprecated paths: `compare`, `blind`, `capture`, and the V0 `inject`. **`daemon`, `unlock`, and `migrate` stay top-level** — they're the recovery commands surfaced by structured-error hints and `status.next_action`.
- `secret-shuttle help` curated progressive-disclosure entry — grouped one-line index of public commands, ≤30 lines. `help <command>` resolves space-separated command paths (e.g. `help secrets list`) via Commander's `helpInformation()`.
- Per-command `--help` epilogs with copy-pasteable examples for every public command.

### Changed
- Old top-level commands `list`, `inspect`, `generate`, `doctor` remain available as deprecated shims that delegate to their `secrets *` / `status` replacement. JSON output (stdout on success, stderr on failure) always carries a `warning: { message, deprecated, replacement }` field. On success, stderr additionally gets a human-readable `[deprecated] ...` line; on failure, stderr is a single parseable JSON document — no separate human line. Scheduled for removal in v0.3.0.
- `use-as-stdin` command removed (deprecated in 0.1.x; replaced by `template run`).
- `src/daemon/server.ts` pre-handler error paths (`bad_host`, `unauthorized`, `not_found`) now emit the full §5.6 structured-error contract (nested + flat fields) instead of the partial legacy shape.

### Security
- `src/daemon/approvals/open-url.ts`: the default behavior (spawn the platform system opener so approval / unlock URLs auto-open in a browser tab) is unchanged in v0.2.0. The kill switch `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to make `openUrl` fully silent — `npm test` sets it so the suite never pops real tabs. **Known operational issue:** every approval, unlock, and paste call opens a fresh tab, and nothing closes them. Plan 4 ships single-window tab-reuse so one tab serves the daemon's whole lifetime; until then, the per-call tab cost is the accepted trade-off for the security guarantee that the daemon never returns approval URLs to the agent.
- Soft-delete invariant enforced in `Vault`: default reads from `getSecret` / `inspect` / `list` exclude soft-deleted records. The only opt-in is `list({ includeDeleted: true })` which returns `AgentSecretMetadata[]` (no `value` field, ever — wire-level test pins this).
