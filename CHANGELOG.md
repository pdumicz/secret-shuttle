# Changelog

## Unreleased

### Added (Burst 4 — Pre-launch security hardening)

- **Per-agent token isolation (5m):** HMAC-derived per-agent tokens (`<agent_id>.<hmac>`), persistent root_token + machine-id files under `<SHUTTLE_HOME>` at mode 0600. `secret-shuttle daemon rotate` invalidates all derived tokens; `secret-shuttle daemon reset-machine-id` refreshes agent_id derivation without revocation. `secret-shuttle agent mint --child-id <id>` for manual sub-agent token mint. `secret-shuttle init` now writes per-runtime tokens to `~/.claude/settings.json` and Cursor's user settings (NEVER to repo-committed files); codex/copilot get manual install instructions.
- **AsyncLocalStorage audit context:** every daemon call records `actor_agent_id` automatically. New audit fields `parent_agent_id`, `child_agent_id` for sessions/grants/batches/mint chains.
- **Owner-enforced consumption:** `ApprovalGrant`, `SessionGrant`, `BatchState` all carry `owner_agent_id`. Non-root cross-owner access returns `approval_not_found` / `session_not_found` / `bootstrap_batch_not_found` (existence non-disclosure). Root bypasses every check.
- **Memory hygiene (5o-core, best-effort):** `requireKey()` copies scrubbed synchronously before any async continuation in `Vault.read`/`write`/`fingerprintKey`. Masker patterns + lookback scrubbed on dispose. Child stdin Buffer scrubbed in write callback.
- **Capture-from-URL in bootstrap (5p):** yml `source: { kind: capture, url: "https://..." }` now drives a daemon-owned browser through the URL under a single approval. Strict URL validation (https / no creds / `node:net.isIP` for IPv4+IPv6 / localhost variants). Capture binds to target_id with at-capture-time host re-verification. Tokenized raw UI routes (`/ui/bootstrap/{capture-step,skip-step,abandon}`) coordinate dev clicks without exposing the agent token to the browser. Cleanup state machine auto-resumes blind on verified-clean target close (or after Chrome death for bootstrap-owned browsers).

### Changed — Burst 4 (breaking)

- `secret-shuttle daemon rotate` is now the canonical token revocation operation. Previously every daemon restart silently regenerated the token; now the root_token persists and rotation is explicit.
- `DaemonBlindModeState.start()` throws `blind_mode_already_active` instead of silently overwriting state.
- Bootstrap plans with capture sources always require approval, regardless of `--environment`.

### Known limitations — Burst 4

- `Secret.value` and `CaptureResult.value` remain JS strings, lingering in heap until GC. End-to-end Buffer refactor is the named follow-up plan 5q.
- Per-(machine, runtime) agent_ids — all of a user's projects share the same daemon-perspective identity per runtime. Per-project granularity is opt-in via `secret-shuttle agent mint`; auto-derived per-project support is plan 5s.
- No per-agent token denylist or expiry; revocation is global via `daemon rotate`. Plan 5r covers granular revocation.
- Template binaries (wrangler, vercel, gh, etc.) are validated against argv stability only at template-author time. A future CI guard (plan 5l) will catch major-version bumps that break bootstrap before they ship.

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

### Added — Plan 4a (pre-approved sessions)
- **Pre-approved sessions.** `POST /v1/approvals/session` mints a session pattern that the human approves once via a real HTML page at `/ui/session?id=&token=`. Subsequent operations carrying `session_id` (CLI: `--session <id>`) that match the pattern skip the per-op approval window. Mismatches fall back to the single-use flow transparently. Each minted grant is a discrete one-shot binding under the hood; the audit log shows N distinct operations with `session_id` set, not "1 session". CLI: `secret-shuttle internal session create | list | revoke`. Spec §5.7.
- **SessionAction is scoped to four actions in v0.2.0:** `template-run`, `inject-submit`, `reveal-capture`, `secrets-set`. Destructive actions (`secrets-delete`, `secrets-rotate`) and deferred actions (`run`, `inject_render`) all canonicalize to null and refuse outright; their CLI flags pass through for surface uniformity but the daemon falls back to single-use approval.
- **Action-specific matchers** that read the field where the binding actually stores its ref:
  - `template-run` → `binding.ref` + `template_ids` (binding.destination_domain is null on templates; template_id is the security boundary)
  - `inject-submit` → `binding.ref` + `destination_domain`
  - `reveal-capture` → `binding.planned_ref` (NOT binding.ref — that's null for reveal-capture) + `destination_domain`
  - `secrets-set` → `binding.planned_ref` + `binding.allowed_domains` ⊆ `pattern.destination_domains` (subset; agent can't widen) + `binding.allowed_actions` ⊆ `pattern.allowed_actions` (pattern's `allowed_actions` is REQUIRED non-empty for secrets-set; entries validated against `ALL_SECRET_ACTIONS`).
- **Pattern validation** rejects empty `destination_domains` for inject-submit / reveal-capture / secrets-set, empty `template_ids` for template-run, AND empty `allowed_actions` for secrets-set — the dangerous "match anything" shapes are all refused at create time. `allowed_actions` entries are validated against the canonical `SecretAction` enum.
- **Pattern domains are canonicalized at create.** `destination_domains` is passed through the shared `normalizeDomain` helper at `parseSessionPatternFromBody` so a pattern created with `["VERCEL.COM"]` is stored + listed as `["vercel.com"]` — matches the already-normalized binding-side domains. Matchers also normalize both sides at comparison time as defense-in-depth.
- **UI security headers.** Token-bearing UI responses (HTML at `/ui/session?id=&token=` and JSON at `/ui/sessions/:id`, `/ui/sessions/:id/approve|deny`) set the full hardening set: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. The HTML response additionally sets a real `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'` HTTP header (not just a `<meta>` tag — browsers ignore meta CSP for `frame-ancestors`). Nonce-based CSP that drops `'unsafe-inline'` is a Plan 4b enhancement.
- **TTL anchored at approval, not creation.** `expires_at` starts at `created_at + 2min` (pending window for the human to click). On approve, `expires_at` resets to `now + pattern.ttl_ms`. So a human who takes 90 seconds to read the pattern still gets the full requested session window.
- **Granted sessions expire.** `SessionStore.get()` and `.list()` both flip pending AND granted states to `expired` past `expires_at`. Without this, an approved session would live until revoke or process restart.
- **Destructive actions cannot be put in a session.** `secrets-delete` and `secrets-rotate` are NOT `SessionAction` values; passing them in a session pattern throws `bad_request`. Their CLI commands accept `--session <id>` for surface uniformity, but the daemon rejects with `session_pattern_no_match` and falls back to a fresh per-op approval.
- **Session UI HTTP routes.** New `GET /ui/sessions/:id?token=<ui_token>` and `POST /ui/sessions/:id/approve|deny?token=<ui_token>` mirror the per-URL-token approval-UI pattern. Tests approve via these HTTP routes — never by mutating the store directly.

### Security
- The matcher for `secrets-set` checks `binding.allowed_domains ⊆ pattern.destination_domains` (subset, not equality). An agent can't widen the domain set the human approved.
- The matcher for `secrets-set` similarly checks `binding.allowed_actions ⊆ pattern.allowed_actions`. `pattern.allowed_actions` is REQUIRED non-empty for any pattern listing `secrets-set` (entries validated against `ALL_SECRET_ACTIONS`). The matcher also refuses if `binding.allowed_actions` is undefined — defense in depth: a binding without an explicit action scope is not session-approvable.
- Patterns cannot use full globs — only literal prefix + optional single trailing `*`. Reduces matcher complexity and "I didn't think it would match THAT" surprises.
- TTL is hard-capped at 15 minutes. Beyond that the human re-approves.

### Added — Plan 4b (single-window tab reuse)
- **Persistent hub tab.** The daemon opens exactly one `GET /ui/hub?token=…` tab per process lifetime and reuses it for every approval, session-approval, and unlock URL. Replaces the v0.1.x "one tab per call" behavior. Each operation is rendered inside a same-origin iframe; the per-URL `ui_token` remains the operational security boundary.
- **`HubBroker`** owns the FIFO queue + active operation slot. Daemon-owned (not browser-owned), so a tab close mid-operation never loses queued URLs. Spawn debounce (`SPAWN_TIMEOUT_MS = 5s`) gates burst respawns; once a hub attaches, the in-flight flag clears so a later close + new surface respawns immediately.
- **SSE event protocol.** `GET /ui/hub/stream?token=H` emits `{type:"navigate", url, seq}` events. Each navigate carries an `hub_seq` query param the framed operation page reads from `location.search` and echoes back via `POST /ui/hub/done?token=H {seq}`. `markDone(seq)` is idempotent — duplicate/stale done events are silent no-ops.
- **Displacement.** Opening a second hub tab manually causes the broker to emit `{type:"displaced"}` to the old subscriber + close it. The old tab JS suppresses reconnect via a `terminal=true` flag set BEFORE the explicit `es.close()` (so the close-triggered `onerror` is also suppressed).
- **Reconnect safety.** `EventSource` has built-in auto-reconnect; the hub JS explicitly `es.close()` on every `onerror` and tracks `consecutiveFailures` (reset on the `open` event). Two consecutive failures (no intervening success) lock to a terminal banner; one transient blip recovers.
- **Operation-page polling** (`/ui/approve` and `/ui/session`) every 2s detects daemon-side terminal status (e.g., grant expired via TTL) and fires `notifyHubIfFramed()` so the hub queue advances even when the user has walked away. Unlock UI does NOT poll — unlock is blocking + retry-oriented; the queue waits on either user success (notify) or tab close (SSE drop, activeUrl preserved for reattach).
- **Duplicate-done suppression.** Client-side `doneInFlight` Set + `lastCompletedSeq` high-water mark in the hub JS prevent a duplicate `operation_done` event whose retries exhaust from running the terminal branch after a sibling duplicate already succeeded.
- **`postDone()` retry loop.** 5 attempts with linear backoff (250ms × attempt). `401`/`403`/`400` are terminal (no retry). On exhaustion: `terminal=true`, `es.close()`, banner with in-page Reconnect button. Daemon detach triggers respawn on the next surface; `activeUrl` stays set so a Reconnect click (which re-issues the SSE via the closure-local hubToken) re-attaches and resends the operation.
- **`/ui/hub/done` body cap.** `addRouteRaw` bypasses the daemon's standard 1 MB JSON parser, so the route uses its own `readBoundedJson(req, 1024)` helper. Oversize → `request_too_large` (the existing registered code). Malformed JSON → `bad_request`.
- **CSP relaxation on three operation routes** (`/ui/approve`, `/ui/session`, `/ui/unlock`): `frame-ancestors 'none'` → `frame-ancestors 'self'`. Same-origin embedding only; the daemon binds 127.0.0.1 so the threat surface is the daemon's own pages. Per-URL `ui_token` continues to gate access.
- **Drift-guard tests** for `ui.html`, `session-ui.html`, `unlock-ui.html`, and `hub-ui.html`. Crude text-pattern assertions on inline JS that catch accidental removal of polling, hub_seq parsing, terminal-state cascade, duplicate-done suppression, and `postDone` retry shape.

### Security
- **Two-layer capability model.** The `hub_token` (minted via `randomUUID()` at `HubBroker` construction; held in memory only) grants subscription to `/ui/hub/stream` — the SSE feed that carries each operation's `{type:"navigate", url, seq}` event. Each operation URL inside those events carries its own short-lived `ui_token` that gates the actual approve/deny action. **The two tokens compose:** without `hub_token` an attacker cannot observe operations; without `ui_token` an attacker cannot act on a specific operation. A leaked `hub_token` is roughly equivalent to a leaked daemon bearer token in scope — the attacker can observe everything the daemon surfaces. The model is "two layers, not one stronger than the other."
- **Daemon binds 127.0.0.1.** The threat model assumes hostile local processes that can already enumerate ports. The hub adds no new network surface; it inherits the daemon's localhost-only constraint.
- **`hub_token` stripped from address bar after bootstrap.** On load, `hub-ui.html` reads `params.get("token")` into a closure-local `hubToken` variable then immediately calls `history.replaceState({}, "", "/ui/hub")` so the token is no longer visible in (a) the address bar (screenshot/screenshare leakage), (b) `Referer` headers when fetching `/ui/hub/stream` or `/ui/hub/done`, or (c) `window.parent.location.search` reads from iframe content. The token survives only as a JS closure variable — not reachable via `window.parent.hubToken` because it's never assigned to `window`.
- **Hub status bar shows connection state + daemon port only.** No vault state (would require an authenticated status route — out of scope for v0.2.0), no token preview (would defeat the address-bar strip above).
- **Daemon restart rotates `hub_token`.** Any still-open hub from the prior process gets 401 on next SSE attempt → banner appears. The old hub **cannot self-recover** via its in-page Reconnect button because the closure-local hubToken is now stale (the new daemon process minted a different one). The user closes the stale tab; the next surfaced operation on the new daemon opens a fresh hub with the new token. This is the only recovery path across daemon restarts — daemon-lifetime tokens have no persistence by design.
- **Iframe is `sandbox="allow-scripts allow-same-origin allow-forms"`.** Same-origin is required so the iframe's existing approval/session JS can POST to `/ui/approvals/...` and `/ui/sessions/...`. The CSP `frame-ancestors 'self'` ensures only the daemon's own hub can frame these pages — a same-origin restriction the per-URL `ui_token` further hardens at the action layer.
- **Displaced / disconnected tabs are non-interactive.** When SSE delivers `{type:"displaced"}` OR the reconnect strikes-out, `hub-ui.html` reassigns `iframe.src = "about:blank"` AND a CSS rule hides the iframe element. A displaced tab cannot continue approving operations the user thought were handed off to the new tab.
- `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to silence all tab spawning (including the hub spawn). Tests rely on this; `npm test` sets it.
- **Unlock-blocking semantic** documented: an unlock that never succeeds blocks the hub queue until the user closes the tab. Acceptable for v0.2.0 since unlock is rare and a stuck unlock is operationally visible. An explicit `hub_queue_full` error is deferred to v0.3.

### Added — Plan 4c (stdin pass-through)
- **`secret-shuttle run --stdin <ref>`.** Pipes a secret value to the spawned child's stdin (fd 0). The daemon resolves the ref and writes the bytes directly to the child; the CLI process never holds plaintext. Use for tools that consume secrets from stdin: `gh auth login --with-token`, `docker login --password-stdin`, `kubectl create secret generic --from-file=-`, etc. Composable with `--env-file` in one invocation (the cmd reads N refs as env vars AND 1 ref as stdin).
- **`--env-file` is now optional.** Previously required, now optional when `--stdin` is supplied. At least one of the two flags must be present (or `missing_param`).
- **New audit action `run_stdin`.** Per-ref audit entries for the stdin ref read `{ action: "run_stdin", ok, ref, environment, value_visible_to_agent: false }`. Env-var refs continue to audit as `action: "run"`. Forensically distinguishes which transport carried which secret.
- **New `ApprovalBinding` action `run_stdin`.** Production stdin refs gate through `requireApproval` with this binding. The approval UI's `human[]` map gains a `run_stdin` entry explaining the stdin pipe + daemon-side write + masking.
- **New error code `stdin_ref_in_env_file → USAGE` (exit 2).** Fail-fast 400 when the same ref appears in both `--stdin` and `--env-file`. Almost always a user mistake; distinct code so the CLI can surface a precise hint.
- **Masking applies to stdin bytes too.** The resolved stdin value is added to the per-stream masker's known-secrets set, so any echo by the child on stdout/stderr is masked to `***` before relay.
- **`SessionAction` unchanged.** `run_stdin` canonicalizes to `null` (same as `run`, `inject_render`). Production stdin refs always go through per-op approval via the hub broker. The CLI's existing `--session <id>` flag accepts a value for surface uniformity; the matcher refuses and falls back to single-use.
- **Cancellation, hub integration, child stdout/stderr streaming, env-file parsing, masker, audit semantics — all inherited unchanged from Plan 3 and Plan 4b.** Plan 4c is purely additive.

### Security
- The stdin bytes never cross the CLI ↔ daemon HTTP boundary as part of the request body. They live only inside the daemon process (resolved from the vault) and are written directly to the child's fd 0 via Node's `child.stdin.write` API.
- EPIPE on stdin write (child closed stdin before reading) is swallowed silently. The child runs to completion; the secret is simply unconsumed. No partial-write or retry semantics.
- The `stdin_ref_in_env_file` error prevents the user from accidentally piping the same secret two ways — defense-in-depth against doubled exposure surface.
- `value_visible_to_agent: false` is asserted in the route tests on every audit entry. The CLI process never reads the resolved bytes.

### Known limitations
- `run` stdin pass-through is **one-shot, not interactive** (Plan 4c): the daemon writes the supplied `--stdin <ref>` value to fd 0 then closes the stream, so the child reads exactly those bytes followed by EOF. Interactive TTY-driven stdin (passwords typed live during the child's runtime, line-by-line prompts) is not supported. The majority of stdin-consuming CLIs use the one-shot pattern (`gh auth login --with-token`, `docker login --password-stdin`, `kubectl create secret … --from-file=-`) so this covers the common case; truly interactive stdin would need bidirectional chunked-HTTP-body wiring and is deferred.
- `run` children inherit a hardened-PATH baseline (from `buildChildEnv`), not the user's shell PATH. Users who need a custom PATH can put it in the env file: `PATH=/custom/path/here`. Variable expansion (`$PATH`) is not supported.
- Masking can leak if a child encodes the secret (base64, percent-encoding, etc.) before printing. This is by design — masking is the last line of defense, not the only one.

### Added — Plan 4d (multi-approval continuation)

- **Multi-approval continuation.** Operations that gate on multiple `ApprovalBinding`s (currently only `run --env-file <prod> --stdin <prod>`) now work end-to-end under `--no-wait`. The daemon mints all required approvals atomically on the first round-trip and returns them via the new `details.approvals` array. The CLI carries them back via repeatable `--approval-id <id>` flags. Closes the combined `--env-file` (prod) + `--stdin` (prod) + `--no-wait` Known-limitation that was documented after Plan 4c.

- **`ShuttleError.details`.** `ShuttleError` now carries an optional `details` field, propagated through `errorToJson` and reconstructed by `daemonErrorFromPayload`. Used by `approval_required` to surface the `approvals` array; available for any future error code that needs structured side-channel data.

- **`--approval-id <id>` is repeatable** on every approval-gated command, via the shared `addApprovalIdOption` factory.

### Changed — Plan 4d

- **Internal: `require-approval.ts` → `require-approvals.ts`.** Single primitive `requireApprovals(bindings, …)` replaces the old `requireApproval(binding, …)`. All approval-gated routes updated. Single-binding callers pass `[binding]`. No behavioral change for single-approval operations.

- **Internal: `ApprovalStore.findOrMintFromSession` split.** `canMatchSession` (pure peek; includes `max_uses` precondition) + `mintFromSession` (side-effect) replace the combined method. The new primitive's Phase 1 / Phase 2 invariant relies on this split — sessions are only used when the entire operation is guaranteed to commit.

- **Wire format: `approval_ids` is now canonical.** `approval_id` (singular) in request bodies is a deprecated alias for `approval_ids: [approval_id]`. Sending both → `bad_request`. The singular form will be dropped in a future release.

- **Wire format: `approval_required` carries `details.approvals`.** For multi-approval operations, `error.details.approvals` is an array of `{approval_id, expires_at, action}`. The legacy singular `approval_id` field in `error.message` (JSON-encoded) is kept for one release as the cross-version alias; it points at the first approval.

- **`approval_required` registry hint** updated to mention repeatable `--approval-id` and the `details.approvals` field.

### Removed — Plan 4d

- **`combined_no_wait_unsupported` error code** (added in Plan 4c post-ship `460e750`). The multi-approval continuation path replaces the fail-fast.

- **`src/daemon/approvals/require-approval.ts`** and its test file, once all callers were migrated to `require-approvals.ts`.

### Plan 5b + 5f-impl — Real init + working OS keychain unlock

**Added:**

- `secret-shuttle init` is now a real first-run command. Starts the daemon if not running, opens the passphrase UI to create the vault if needed, enrolls the OS keychain (Touch ID on macOS) for passwordless subsequent unlocks, and installs Secret Shuttle skill files into every detected agent runtime (`.claude/`, `AGENTS.md`, `.cursor/`, `.github/copilot-instructions.md`). Flags: `--no-keychain`, `--no-agent-install`. Idempotent — re-running on a fully set-up project is a fast no-op.

- Real OS keychain integration via `@napi-rs/keyring` AsyncEntry: macOS Keychain Services (Touch ID), Linux libsecret (Secret Service / gnome-keyring), Windows Credential Manager (DPAPI). Previous Plan 1 stubs replaced with working implementations.

- `secret-shuttle keychain enable / disable / status` — explicit control over keychain enrollment for users who want to opt in/out outside the init flow.

- Daemon routes: `POST /v1/keychain/enable`, `POST /v1/keychain/disable`, `GET /v1/keychain/status`.

- Envelope file gains a stable `id` field (UUID). Used as the keychain account key (`("secret-shuttle", <vault_id>)`), so multiple Secret Shuttle vaults can coexist on one machine via different `SHUTTLE_HOME` dirs without collision. Legacy envelopes are transparently upgraded on first read.

- Error codes: `keychain_key_invalid` (cached key didn't unlock the vault — falls back to passphrase). Includes `next_action` (Plan 5d pattern). The `daemon_start_timeout` code (existing) covers init startup failures — no new daemon init code was added.

**Changed:**

- `POST /v1/unlock/start` tries the OS keychain before the passphrase UI. On macOS this fires Touch ID. On any keychain failure (no entry, cancelled, invalid key, unavailable), falls through to the existing passphrase UI seamlessly.

- After a successful passphrase unlock, the daemon opportunistically writes the master key to the keychain — handles device-migration and keychain-corruption recovery without explicit user action.

- `agent install` flow extracted: `readBundledSkill()` (and `agentInstallTarget` if you extracted it) is now exported from `src/cli/commands/agent.ts` so `init` can reuse the same skill-install logic.

**Internal:**

- `DaemonServices` gains an optional `keychain?: KeychainAdapter` field for test injection. Production uses the platform-detected adapter via `getKeychainAdapter()`.

- The keychain fast-path's catch block is narrowed: only `vault_decryption_failed` and `invalid_master_key` are treated as expected key-validation failures. Other errors (filesystem, audit-write) are audited then re-thrown so they surface to the caller instead of silently routing to the passphrase UI.

### Plan 5g — `secret-shuttle bootstrap`

**Added:**

- `secret-shuttle bootstrap` — provision an entire project's secrets in one approval. Reads `secret-shuttle.yml`, computes the diff vs. the vault, mints a single bootstrap-action approval covering the whole plan, returns `approval_required`. On `--continue --batch <id> --approval-id <id>`, walks the plan and calls existing primitives (generate / template run) under the bootstrap approval's authority — no inner approvals needed.

- Supports `random_32_bytes`, `random_64_bytes`, and `existing` source kinds. Destination shorthands: `vercel:<env>`, `github-actions:<owner/repo>`, `cloudflare:<env>`, `supabase:<project>` — mapping to the four shipped templates.

- Diff-based idempotency: secrets already in the vault are skipped (override with `--force`). Partial-success enum on failure; retry with same `--batch <id>` is idempotent and resumes from the failed step.

- `bootstrap --list` and `bootstrap --abandon --batch <id>` for batch state management.

- New error codes: `bootstrap_plan_invalid`, `bootstrap_batch_not_found`, `bootstrap_destination_unknown` (all with `next_action`).

- New audit actions: `bootstrap_plan`, `bootstrap_step`.

- New approval binding action: `"bootstrap"`. Hub UI renders the plan summary as a multi-secret card with one [Approve] / [Deny] pair.

**Changed:**

- Internal: three route handlers (`/v1/secrets/generate`, `/v1/secrets/reveal-capture`, `/v1/templates/run`) refactored to expose their core logic as exported functions (`generateSecretCore`, `revealCaptureCore`, `runTemplateCore`). HTTP shells unchanged externally; the bootstrap executor calls the cores directly with a `bootstrapAuthority` context that bypasses inner `requireApprovals` when valid. **Security invariant**: `bootstrapAuthority` is server-internal — HTTP shells NEVER accept it from request bodies.

**Internal:**

- `BootstrapStore` persists batch state to `${SHUTTLE_HOME}/bootstrap-batches/<id>.json` (mode 0600).
- `yaml@^2.x` added as a runtime dependency.

**Known limitations (v1):**

- `source: { kind: capture, url }` is **not yet supported** in bootstrap. `reveal-capture` requires a live browser handle (a marked field), which bootstrap can't construct from a URL alone. The bootstrap route rejects capture sources at plan time with a clear error. Workaround: run `secret-shuttle reveal-capture` manually for these secrets, then reference them via `source: { kind: existing, ref: ss://... }` in the yml.
