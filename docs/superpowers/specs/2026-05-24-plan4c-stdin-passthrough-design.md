# Plan 4c — Stdin Pass-Through (Design)

**Status:** drafted via brainstorming; pending spec self-review + user approval.
**Author:** Patryk + Claude (brainstorming session 2026-05-24)
**Predecessor:** Plan 4b (single-window tab reuse) — completed at commit `3c9d377`. Test baseline 923/921/2/0.
**Successor:** Plan 5a (init + native keychain).

---

## Goal

Add `--stdin <ref>` to `secret-shuttle run` so the daemon resolves the ref and pipes the secret value to the spawned child's `stdin` file descriptor — without the CLI process ever seeing the plaintext. Required for CLIs that consume secrets via stdin (`gh auth login --with-token`, `docker login --password-stdin`, `kubectl create secret generic --from-file=-`, etc.).

## Non-goals

- Multi-ref stdin (one ref → one stdin stream per invocation).
- Reading the secret BACK from the child's stdout (that's `reveal-capture`).
- Heredoc / multi-line composition (the user stores whatever bytes they want in the secret value).
- Session pre-approval for `run_stdin` (canonicalizes to `null` like `run`).
- New CLI verb (`--stdin` is a flag on `run`).

## Constraints

- CLI process never holds plaintext. The daemon's spawner owns the entire write to the child's fd 0.
- `assertSecretActionAllowed(record, "use_as_stdin")` gates per-ref (existing Plan 2/3 contract).
- Audit per ref. Stdin ref tagged `action: "run_stdin"`; env-var refs continue as `action: "run"`. `value_visible_to_agent: false` on every audit.
- Masker on child stdout/stderr — the resolved stdin bytes are added to the per-stream masker's known-secrets set alongside resolved env values (defense-in-depth: child echo gets `***`).
- Approval flow + hub: production stdin refs require approval via the hub broker (Plan 4b). The CLI's existing `--session <id>` flag accepts a session id; the matcher refuses (canonical action `null`) and falls back to single-use, identical to `run`.
- Cancellation: CLI Ctrl-C → fetch aborts → daemon SIGTERMs child (5s grace, then SIGKILL). Same as Plan 3 `run`.

---

## Architecture

```
secret-shuttle run [--env-file <f>] [--stdin <ref>] [--session <id>] -- <cmd> [args...]
       │
       ▼
POST /v1/run/resolve
{ cmd, args, env_refs: [...], stdin_ref?: "ss://...", cwd, session_id? }
       │
       ▼
Daemon route:
  1. vault.resolveRefs([stdin_ref?, ...env_refs])
  2. For each: assertSecretActionAllowed(record, "use_as_stdin")
  3. For each production ref: requireApproval({
        action: stdin_ref ? "run_stdin" : "run",
        ref, environment,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        sessionStore: services.sessionStore,
        sessionId? })
  4. spawner({
        cmd, args, cwd,
        env: { ...buildChildEnv(), ...resolvedEnv },
        stdinBytes: resolvedStdinValue ?? undefined,
        knownSecrets: [resolvedStdinValue, ...envValues].filter(Boolean) })
       │
       ▼
Spawner:
  spawn(cmd, args, { stdio: stdinBytes ? ["pipe","pipe","pipe"] : ["ignore","pipe","pipe"] })
  if (stdinBytes) { child.stdin.write(stdinBytes); child.stdin.end(); }
  // child reads stdin → EOF
  // child stdout/stderr → masker → SSE → CLI
```

The CLI process is a pure orchestrator: it sees only the stream of `{stdout|stderr|exit_code|spawn_failed}` events back from the daemon. Plaintext lives in two places: the vault on disk, and the daemon's in-memory `record.value` for the duration of the spawn.

---

## Components

### 1. `src/daemon/audit.ts`

One-line addition: `"run_stdin"` to the `DaemonAuditAction` union.

```typescript
export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | ...
  | "run" | "run_stdin" | "inject_render"
  | ...;
```

### 2. `src/daemon/approvals/store.ts`

One-line addition: `"run_stdin"` to the `ApprovalBinding.action` enum. Binding shape otherwise identical to a `"run"` binding (single `ref`, `environment`, all other fields null).

### 3. `src/daemon/approvals/ui.html`

New entry in the `human[]` map (the inline JS object that maps action → human-readable approval copy):

```javascript
run_stdin: `Resolve secret ${esc(g.ref ?? "")} and pipe its value to the child's stdin. The value is written by the daemon directly to fd 0; the CLI process never sees it. Child stdout/stderr are masked. Recommended for tools that read secrets from stdin (gh auth login --with-token, docker login --password-stdin, kubectl create secret ... --from-file=-).`,
```

### 4. `src/daemon/approvals/session.ts`

No change. `canonicalAction("run_stdin")` returns `null` (same as `"run"`, `"inject_render"`, `"secrets_delete"`, `"secrets_rotate"`, `"blind_end"`). The `CANONICAL_MAP` doesn't list `run_stdin` → `canonicalAction` returns null per the default branch.

### 5. `src/shared/error-codes.ts`

One new code: `stdin_ref_in_env_file → USAGE` (exit 2). For the case where the user accidentally lists the same ref in both `--stdin` and `--env-file`. Failure mode is operator-facing, not transient.

```typescript
stdin_ref_in_env_file: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

### 6. `src/daemon/run/spawner.ts`

Extends the `SpawnInput` interface:

```typescript
export interface SpawnInput {
  // existing fields: cmd, args, cwd, env, knownSecrets, ...
  /** Optional bytes to write to the child's stdin. Written and then the
   *  stream is ended (child reads bytes + EOF). When undefined, fd 0 is
   *  /dev/null as today. The bytes MUST also appear in knownSecrets so
   *  the masker catches any echo on stdout/stderr. */
  stdinBytes?: Buffer;
}
```

Behavior:

```typescript
const child = spawn(input.cmd, input.args, {
  cwd: input.cwd,
  env: input.env,
  stdio: input.stdinBytes !== undefined
    ? ["pipe", "pipe", "pipe"]
    : ["ignore", "pipe", "pipe"],
});

if (input.stdinBytes !== undefined) {
  child.stdin.on("error", (err) => {
    // EPIPE: child closed stdin before reading. Log but don't crash —
    // the child may still complete normally with whatever it read.
    auditStdinWriteFailed(err);
  });
  child.stdin.write(input.stdinBytes);
  child.stdin.end();
}
```

The masker is constructed identically to today — the stdin bytes appear in `knownSecrets` and get masked from stdout/stderr.

### 7. `src/daemon/api/routes/run-resolve.ts`

Extends the body type:

```typescript
interface RunResolveBody {
  cmd: string;
  args?: string[];
  env_refs?: string[];
  stdin_ref?: string;    // NEW
  cwd?: string;
  approval_id?: string;
  session_id?: string;
  wait_for_approval?: boolean;
  force?: boolean;
}
```

Validation:

1. **Body shape:** `stdin_ref` optional. If present, must be a string. Parse via `parseSecretRef` — malformed → throw `bad_request`.

2. **Duplicate-ref guard:** if `stdin_ref !== undefined && env_refs.includes(stdin_ref)`, throw `stdin_ref_in_env_file`. A single ref piped two ways is almost always a mistake.

3. **Resolution batch:** `services.vault.resolveRefs(allRefs)` where `allRefs = stdin_ref ? [stdin_ref, ...env_refs] : env_refs`. Per-ref `assertSecretActionAllowed(record, "use_as_stdin")`. Failures emit per-ref audit + per-ref stream error.

4. **Approval batch:** for each production ref:
   - Env refs build `ApprovalBinding { action: "run", ref, environment: "production" }`.
   - Stdin ref builds `ApprovalBinding { action: "run_stdin", ref, environment: "production" }`.
   - Each calls `requireApproval({ ..., openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef) })`.

5. **Spawn:** pass `stdinBytes: stdinRecord?.value` to the spawner. The known-secrets array includes `stdinRecord?.value` alongside env values.

6. **Per-ref audit:** stdin ref → `{ action: "run_stdin", ok, ref, environment, session_id? }`. Env refs unchanged.

### 8. `src/cli/commands/run.ts`

Adds one option + body wire:

```typescript
.option("--stdin <ref>", "Secret ref to pipe to the child's stdin. The CLI never sees the value; the daemon writes it directly to the child's fd 0. Composable with --env-file. Approval-gated for production refs.")
// ... existing options including --session, --env-file, --approval-id, --no-wait

// In the action body, after env-file parse:
if (options.stdin !== undefined) {
  body.stdin_ref = options.stdin;
}
```

CLI-side validation: if `--stdin` is supplied, parse the ref via the shared `parseSecretRef` helper for fast feedback before the daemon round-trip. Malformed → exit 2 (usage).

### 9. `src/cli/commands/run.ts` help text

Append to the `addHelpText("after", ...)` epilog:

```
  # Pipe a secret to a CLI that reads from stdin:
  secret-shuttle run --stdin ss://local/prod/DOCKERHUB_TOKEN -- \
    docker login -u myuser --password-stdin docker.io

  # Combine env-file + stdin for tools that need both:
  secret-shuttle run --env-file .env --stdin ss://local/prod/GH_TOKEN -- \
    gh auth login --with-token
```

---

## Data flow

### Cold-start, single stdin op
1. User runs `secret-shuttle run --stdin ss://local/prod/DOCKERHUB_TOKEN -- docker login -u myuser --password-stdin docker.io`.
2. CLI parses `--stdin`, validates ref via `parseSecretRef`. Body: `{ cmd: "docker", args: [...], stdin_ref: "ss://local/prod/DOCKERHUB_TOKEN", env_refs: [], cwd: process.cwd() }`. POST `/v1/run/resolve` (streaming).
3. Daemon route validates body. No duplicate check applies (no env-file). Resolves the single ref. `assertSecretActionAllowed(record, "use_as_stdin")` passes.
4. Production env → builds `ApprovalBinding { action: "run_stdin", ref, environment: "production" }` → `requireApproval` → hub broker surfaces approval URL. User approves in hub iframe.
5. `markUsed(ref)` → audit `{ action: "run_stdin", ok: true, ref, environment: "production", approval_id }`.
6. Spawner: `stdio: ["pipe", "pipe", "pipe"]`. `child.stdin.write(record.value); child.stdin.end()`. Masker initialized with `[record.value]`.
7. Child runs, stdout/stderr streamed back to CLI (masked). Child exits 0. Daemon streams `{exit_code: 0}` event. CLI exits 0.

### Combined env-file + stdin
1. `secret-shuttle run --env-file .env --stdin ss://local/prod/GH_TOKEN -- gh auth login --with-token`.
2. CLI parses env-file: 2 refs. Adds stdin_ref. Body has 3 refs total across `env_refs` + `stdin_ref`.
3. Daemon batch-resolves 3 refs. Three `assertSecretActionAllowed` checks.
4. Three production refs → three `requireApproval` calls (2 with action `"run"`, 1 with action `"run_stdin"`). Hub broker FIFO-queues them; user approves one at a time.
5. Spawn with all 3 secrets in scope. Masker known-secrets has all 3 values.
6. Three audit entries: 2 × `action: "run"`, 1 × `action: "run_stdin"`. Each `value_visible_to_agent: false`.

### --stdin ref also in env-file (user error)
1. Daemon body validation: `env_refs.includes(stdin_ref)` → throw `ShuttleError("stdin_ref_in_env_file", "...")`.
2. Pre-stream HTTP 400 (before resolution starts). CLI exits 2 (USAGE).
3. No audit emitted (no operation occurred).

### Stdin ref `use_as_stdin` removed
1. `assertSecretActionAllowed` fails closed with `action_not_allowed`.
2. Per-ref audit `{ action: "run_stdin", ok: false, ref, environment, error_code: "action_not_allowed" }`.
3. Stream emits `{error_code: "action_not_allowed", message, hint, exit_code, ref}` event. CLI exits 4 (PERMISSION).
4. No spawn occurred (Plan 3 R4-3 pre-spawn audit pattern preserved).

### Production approval denied
1. `requireApproval` throws `approval_denied`.
2. Audit `{ action: "run_stdin", ok: false, ref, environment, error_code: "approval_denied" }`.
3. CLI exits 4.

### Cancellation (Ctrl-C)
1. User Ctrl-C → fetch abort → daemon `req.on("close")` fires.
2. Daemon SIGTERMs child. Stdin pipe already closed (write+end completed before child started emitting).
3. 5s grace → SIGKILL if needed.
4. Daemon streams `{exit_code: <signal>}` or just closes if pre-spawn.

### Stdin write race (child closes stdin before reading)
1. Some children (rare) ignore stdin entirely. The daemon's `child.stdin.write` returns false (back-pressure) or fires `error` event with EPIPE.
2. `child.stdin.on("error", ...)` catches and logs a separate audit entry `{ action: "run_stdin", ok: false, ref, error_code: "stdin_write_failed" }`. The main audit (success or whatever exit code) is unaffected.
3. The child continues to run and exits normally. The stdin secret was simply not consumed.

---

## Error handling

Mapping (HTTP/exit-code semantics per Sol/Memori error registry):

| Failure | Code | Layer |
|---|---|---|
| Body `stdin_ref` not a string | `bad_request` (exit 2) | daemon route |
| Body `stdin_ref` malformed `ss://` | `bad_request` (exit 2) | daemon route |
| `stdin_ref` also in `env_refs` | `stdin_ref_in_env_file` (exit 2) | daemon route (NEW code) |
| `stdin_ref` not in vault | `secret_not_found` (exit 3, per-ref stream) | resolve |
| `stdin_ref` `use_as_stdin` removed | `action_not_allowed` (exit 4, per-ref) | assert |
| Production approval denied | `approval_denied` (exit 4) | requireApproval |
| Production approval timed out | `approval_timeout` (exit 4) | requireApproval polling |
| Child binary not found | `spawn_failed` (exit 127, streamed) | spawner |
| Stdin write EPIPE (child ignored stdin) | `stdin_write_failed` (audit only, child continues) | spawner |

Plaintext exposure invariant: `value_visible_to_agent: false` on every audit. Verified by route + drift tests.

---

## Testing

### Layer 1 — spawner unit tests
Extends `src/daemon/run/spawner.test.ts`:
- `stdinBytes === undefined` → child fd 0 is /dev/null (existing baseline).
- `stdinBytes = Buffer.from("secret-value\n")` → child reads exactly those bytes (use `cat` as child; capture stdout; assert equal).
- Masker known-secrets contains the stdin bytes — verify by spawning a child that echoes its stdin and asserting the streamed stdout contains `***` not the raw bytes.
- Child closes stdin before reading → EPIPE caught; auxiliary audit emitted; main audit still records child exit code.
- Cancellation under stdin-piped mode → SIGTERM still fires; child cleaned up.

### Layer 2 — daemon route tests
Extends `src/daemon/api/routes/run-resolve.test.ts`:
- Body validation: malformed `stdin_ref` → 400 `bad_request`.
- `stdin_ref` not in vault → streamed `{error_code: "secret_not_found", ref}` event.
- `stdin_ref` with `use_as_stdin` removed → `action_not_allowed`; no spawn.
- `stdin_ref` also in `env_refs` → 400 `stdin_ref_in_env_file`; no resolve, no audit.
- Production stdin ref → approval flow → grant consumed → audit `action: "run_stdin"`.
- Combined env+stdin (2 env + 1 stdin) → 3 audits (2 × `"run"`, 1 × `"run_stdin"`).
- E2e: stdin ref resolved + child runs + exit code surfaced.

### Layer 3 — CLI tests
Extends `src/cli/commands/run.test.ts`:
- `--stdin <ref>` flag declared and parsed.
- Body construction includes `stdin_ref` field.
- `--stdin` combinable with `--env-file`, `--approval-id`, `--session`, `--no-wait`.
- Malformed `--stdin` ref → CLI-side validation throws before fetch.

### Layer 4 — audit + binding + UI drift
- `audit.ts`: new test asserts `"run_stdin"` is in `DaemonAuditAction`.
- `store.ts`: new test asserts `"run_stdin"` accepted as `ApprovalBinding.action`.
- `ui.html` drift test (new): assert `human[].run_stdin` is defined with non-empty copy mentioning "stdin" and "pipe".

### Layer 5 — error codes
Extends `error-codes.test.ts`:
- `stdin_ref_in_env_file` registered with `EXIT_CODE_USAGE`.
- Count bumped from 118 (post-Plan-4a) to 119.

### Layer 6 — e2e via hub
New file or extension of `hub-e2e.test.ts`:
- Trigger production stdin op → broker surfaces URL via hub → fake subscriber receives navigate(URL with hub_seq) → approve → child runs → stream completes → markDone advances hub.

---

## Acceptance criteria

- `secret-shuttle run --stdin ss://path -- some-cli` resolves the ref, pipes to child fd 0, child reads bytes + EOF.
- `secret-shuttle run --env-file e --stdin ss://p -- cli` injects env vars AND pipes stdin in one invocation.
- Production refs require hub-surfaced approval; CLI never holds plaintext.
- Audit log distinguishes env-var injection (`action: "run"`) from stdin pass-through (`action: "run_stdin"`).
- Same ref in both `--stdin` and `--env-file` → fail-fast 400 with `stdin_ref_in_env_file`.
- Child stdout/stderr masking includes the stdin value.
- Cancellation (Ctrl-C) cleans up the child same as Plan 3 `run`.
- `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to suppress hub spawn (Plan 4b inheritance).
- Test suite passes with ~25 new tests across spawner/route/CLI/drift/error-codes/e2e layers. Final ~948.
- CHANGELOG documents the new flag, the `run_stdin` audit action, the `stdin_ref_in_env_file` error code, and the unchanged hub/cancellation/masking behavior.

---

## File summary

**Modified files:**
- `src/daemon/audit.ts` — add `"run_stdin"` to `DaemonAuditAction`.
- `src/daemon/approvals/store.ts` — add `"run_stdin"` to `ApprovalBinding.action`.
- `src/daemon/approvals/ui.html` — add `human[].run_stdin` entry.
- `src/shared/error-codes.ts` — add `stdin_ref_in_env_file → USAGE`.
- `src/shared/error-codes.test.ts` — bump count + spot-check.
- `src/daemon/run/spawner.ts` — `stdinBytes` field + pipe + EPIPE guard.
- `src/daemon/run/spawner.test.ts` — extend.
- `src/daemon/api/routes/run-resolve.ts` — body extension + validation + approval + audit.
- `src/daemon/api/routes/run-resolve.test.ts` — extend.
- `src/cli/commands/run.ts` — `--stdin` flag + body wire + help epilog.
- `src/cli/commands/run.test.ts` — extend.
- `src/daemon/hub/hub-e2e.test.ts` — extend with stdin e2e.
- `CHANGELOG.md` — Plan 4c section under `## Unreleased`.

**New files:**
- `src/daemon/approvals/ui-html-stdin-drift.test.ts` (or extend existing `ui-server.test.ts` with a `human[].run_stdin` assertion — pick whichever existing test file is closest in shape).

---

## Out-of-scope items explicitly deferred

- **Multi-ref stdin** (multiple refs concatenated into stdin). No real-world use case; would also complicate masking + audit per-ref accounting. Future enhancement only if a workflow requires it.
- **Session pre-approval for `run_stdin`.** Same reason as `run`: child-spawn flows are too broad for session pattern matching to be useful. If sessions for child-spawn become a real need, both `run` and `run_stdin` would gain SessionAction support together.
- **Bidirectional stdin (interactive password prompts).** Would require a TTY pipe + interaction protocol between CLI and daemon. Out of scope.
- **`secret-shuttle stdin` as a top-level verb.** `--stdin` flag on `run` is the canonical surface. The verb could be added later as alias-only sugar if discoverability becomes an issue.
- **Stdin with non-`run` flows** (e.g., `inject --stdin ...`). Inject is a file-write operation; stdin doesn't compose. Distinct concerns.
