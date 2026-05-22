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

### Added — Plan 3 (run + inject)
- `secret-shuttle run --env-file=<f> -- <cmd>` — subshell injection. The CLI parses a strict dotenv-like file (KEY=VALUE; ss:// refs only at full-value position; no shell expansion), POSTs refs + command + argv + `cwd: process.cwd()` to the daemon, and the daemon spawns the child with the resolved env block in the CLI's working directory. Stdout/stderr are streamed back via line-delimited JSON over chunked HTTP and **masked** through a lookback-buffered byte matcher — resolved secret values are replaced with `***` before bytes cross the HTTP boundary. The child's exit code is the CLI's exit code (and `spawn_failed` exits 127 to match `op run` / `doppler run`). The CLI process never holds plaintext. A CLI Ctrl-C or disconnect SIGTERMs the child (SIGKILL after 5 s grace).
- `secret-shuttle inject -i <tpl> -o <out>` — template substitution. CLI absolutizes `-o` against its cwd and ships the template bytes to `POST /v1/inject/render`. The daemon scans candidate `ss://` refs with a greedy character class, validates each via the canonical `parseSecretRef`, resolves, and writes via an atomic O_EXCL temp file + rename at mode 0600. Output-path safety: realpath of parent must be inside `$HOME`; leaf symlinks refused; symlinked ancestors refused (no directories created outside HOME); relative paths refused; post-mkdir lstat catches same-UID symlink-swap races; final realpath TOCTOU guard immediately before temp-file open. Use `-o -` for stdout-passthrough (documented as "bytes pass through CLI").
- `Vault.resolveRefs(refs[])` — batch deleted-aware ref→`SecretRecord` lookup. Used by both new daemon endpoints; honors the Plan 2 soft-delete invariant (deleted refs throw `secret_not_found`). Returns full records so callers can enforce `assertSecretActionAllowed` and call `markUsed` inline.
- Both new endpoints enforce per-secret `assertSecretActionAllowed(record, "use_as_stdin")` BEFORE any side effect; refs with that action explicitly removed fail closed with `action_not_allowed`. Each resolved ref gets `markUsed` on success and a per-ref audit entry (`{ action: "run" | "inject_render", ok, ref, environment, error_code? }`). Pre-spawn failures (missing ref, action_not_allowed, approval failure) are also audited per ref.
- New approval actions: `run`, `inject_render`. Added to the binding union + UI copy + audit action enum. Production refs in either flow require approval.
- `DaemonServer.addRouteStreaming(method, path, handler)` — auth-checked chunked-response primitive. Identical Host + bearer + 1 MB body cap as `addRoute`; the handler controls the response body. `addRouteRaw` (used by the approval UI's per-URL-token routes) stays unchanged.
- `daemonErrorFromPayload` is now reused by the streaming client (`streamingDaemonRequest` + run-CLI stream-error consumer) so daemon-provided `hint` and `exit_code` survive both pre-stream HTTP errors and in-stream `{ error: ... }` lines.

### Security
- `secret-shuttle run` masks resolved values in child stdout/stderr (spec §5.3). The masker is byte-level, lookback-buffered (`maxLen - 1` bytes), longer-first on overlapping matches. Per-stream (separate stdout and stderr maskers) so a held-back tail never crosses streams. **This is defense-in-depth, not a security guarantee** — a hostile child can still exfiltrate via network or by encoding the secret (base64, hex). Documented in `secret-shuttle run --help`.
- `secret-shuttle inject` writes via `O_CREAT | O_EXCL | O_WRONLY` to a unique temp sibling then renames. The file is never empty or partially written at the final path. Leaf-symlink refusal + parent-realpath inside `$HOME` + post-mkdir lstat + final realpath TOCTOU guard prevent redirected writes even against a same-UID racer.
- Run-route writer methods guard against `res.destroyed || res.writableEnded || responseClosed` before every `res.write` / `res.end` — prevents `ERR_STREAM_WRITE_AFTER_END` on the cancel path (CLI aborts → daemon SIGTERMs child → spawner resolves → `writeExit` would otherwise write to a destroyed socket).

### Changed
- V0 CDP-inject command source file moved from `src/cli/commands/inject.ts` to `src/cli/commands/inject-internal.ts`. **The user-facing command `internal inject` is unchanged.** This is a source-only rename to make room for the new top-level `inject.ts`.

### Known limitations
- `run` does NOT pass stdin through to the child in v0.2.0 — the child sees EOF on read (`stdio: ["ignore", "pipe", "pipe"]`). Spec §5.3 calls for stdin inheritance; Plan 4 ships the bidirectional chunked-HTTP-body wiring needed to make this work. The majority of `run` use cases (`npm start`, `vercel deploy`, `npx <tool>`) don't read interactive stdin.
- `run` children inherit a hardened-PATH baseline (from `buildChildEnv`), not the user's shell PATH. Users who need a custom PATH can put it in the env file: `PATH=/custom/path/here`. Variable expansion (`$PATH`) is not supported.
- Masking can leak if a child encodes the secret (base64, percent-encoding, etc.) before printing. This is by design — masking is the last line of defense, not the only one.
