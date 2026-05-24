# Plan 4c — Stdin Pass-Through Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--stdin <ref>` to `secret-shuttle run` so the daemon resolves the ref and pipes the secret value to the spawned child's stdin (fd 0) — without the CLI process ever seeing the plaintext.

**Architecture:** Extend the existing `POST /v1/run/resolve` body with an optional `stdin_ref`. Daemon's spawner gains an optional `stdinBytes: Buffer` field; when set, it spawns the child with `stdio: ["pipe", "pipe", "pipe"]` and writes the bytes + ends the stream. New `"run_stdin"` action on `DaemonAuditAction` + `ApprovalBinding`. Approval UI gains a `human[].run_stdin` entry.

**Tech Stack:** TypeScript strict, ESM `.js` suffixes, `exactOptionalPropertyTypes`, Node 20+, `node:test`, `node:assert/strict`, Plan 4b hub broker for approval URL surfacing.

**Spec:** `docs/superpowers/specs/2026-05-24-plan4c-stdin-passthrough-design.md` (commit `40c1dd0`).

**Baseline:** 923 tests, 921 pass, 2 skipped, 0 fail at commit `3c9d377`.

**Estimated new tests:** ~25. Final count target: ~948.

---

## Task overview

| Task | What ships |
|---|---|
| A | `"run_stdin"` to `DaemonAuditAction` + `ApprovalBinding.action` + `stdin_ref_in_env_file` error code |
| B | Approval UI `human[].run_stdin` copy + drift test |
| C | `spawner.ts` stdin-write path + masker integration + unit tests |
| D | `run-resolve.ts` route: body extension, duplicate-ref guard, per-ref approval, audit |
| E | `--stdin <ref>` CLI flag, make `--env-file` optional, CLI tests |
| F | E2E test via hub broker (Plan 4b integration) |
| G | CHANGELOG + final verification |

---

## File structure

**Modified files:**
- `src/daemon/audit.ts` — `"run_stdin"` to `DaemonAuditAction` union.
- `src/daemon/approvals/store.ts` — `"run_stdin"` to `ApprovalBinding.action`.
- `src/daemon/approvals/store.test.ts` — assert binding accepts `"run_stdin"`.
- `src/shared/error-codes.ts` — `stdin_ref_in_env_file → USAGE`.
- `src/shared/error-codes.test.ts` — bump count + spot-check.
- `src/daemon/approvals/ui.html` — `human[].run_stdin` map entry.
- `src/daemon/approvals/ui-server.test.ts` — drift assertion on the `human[].run_stdin` copy.
- `src/daemon/run/spawner.ts` — `stdinBytes?: Buffer` field, pipe + EPIPE guard.
- `src/daemon/run/spawner.test.ts` — extend.
- `src/daemon/api/routes/run-resolve.ts` — `stdin_ref?: string` body, duplicate-ref guard, per-ref approval with `"run_stdin"` binding, audit.
- `src/daemon/api/routes/run-resolve.test.ts` — extend with stdin scenarios.
- `src/cli/commands/run.ts` — `--stdin <ref>` flag, optionalize `--env-file`, neither-required guard, help epilog.
- `src/cli/commands/run.test.ts` — structural assertions for `--stdin`.
- `src/daemon/hub/hub-e2e.test.ts` — e2e: production stdin → hub approval → child runs.
- `CHANGELOG.md` — Plan 4c section under `## Unreleased`.

**No new files.** All tests extend existing files (codebase pattern: extend before creating new test files when the route/file already has a test counterpart).

---

## Task A: enum additions + error code

**Files:**
- Modify: `src/daemon/audit.ts`
- Modify: `src/daemon/approvals/store.ts`
- Modify: `src/daemon/approvals/store.test.ts`
- Modify: `src/shared/error-codes.ts`
- Modify: `src/shared/error-codes.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/shared/error-codes.test.ts` (find the existing count-assertion block):

```typescript
test("error-codes: stdin_ref_in_env_file registered with USAGE exit code", () => {
  const entry = ERROR_CODES.stdin_ref_in_env_file;
  assert.ok(entry, "stdin_ref_in_env_file must be registered");
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
  assert.equal(entry.hint(), null);
});
```

Find the existing count assertion (e.g., `assert.equal(codes.length, 118)` from Plan 4a R1) and bump to `119`.

Append to `src/daemon/approvals/store.test.ts`:

```typescript
test("ApprovalBinding accepts run_stdin action", () => {
  // Compile-time assertion: this only matters if the type allows the value.
  // If TS rejects the literal, the test fails at typecheck before runtime.
  const binding: ApprovalBinding = {
    action: "run_stdin",
    ref: "ss://local/prod/X",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
  };
  assert.equal(binding.action, "run_stdin");
});
```

(Import `ApprovalBinding` at the top of the test file if not already.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsc --noEmit`
Expected: typecheck errors on `"run_stdin"` literal (not in union) AND `stdin_ref_in_env_file` (not in registry).

- [ ] **Step 3: Apply enum + registry additions**

Edit `src/daemon/audit.ts` `DaemonAuditAction` union:

```typescript
export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume"
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
  | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render"
  | "template_run" | "template_tmp_sweep"
  | "approval_created" | "approval_granted" | "approval_denied"
  | "approval_expired" | "approval_used" | "approval_mismatch";
```

Edit `src/daemon/approvals/store.ts` `ApprovalBinding.action` field — find the existing union (something like `action: "generate" | "capture" | ...`) and add `"run_stdin"`:

```typescript
action:
  | "generate"
  | "capture"
  | "inject"
  | "inject_submit"
  | "reveal_capture"
  | "compare"
  | "secrets_delete"
  | "secrets_rotate"
  | "run"
  | "run_stdin"   // NEW
  | "inject_render"
  | "template"
  | "blind_end";
```

(The actual current union may differ — grep first: `grep -n "action:" src/daemon/approvals/store.ts | head`.)

Edit `src/shared/error-codes.ts` registry — add new entry near the existing `request_too_large` line:

```typescript
stdin_ref_in_env_file: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="stdin_ref_in_env_file|run_stdin"`
Expected: 2 new tests pass.

Run: `npm test`
Expected: 925 tests (923 + 2), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/audit.ts src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "$(cat <<'EOF'
feat(audit+approvals): add run_stdin action + stdin_ref_in_env_file code

Foundational enum additions for Plan 4c stdin pass-through:
- DaemonAuditAction gains "run_stdin" — distinguishes stdin-pipe from
  env-var (action="run") in the per-ref audit log. Forensically
  precise: a reviewer sees which secret went where.
- ApprovalBinding.action gains "run_stdin" — approval UI human[] map
  can now branch on the new action (Plan 4c Task B copy lands next).
- Error-codes registry gains stdin_ref_in_env_file → USAGE (exit 2).
  Fail-fast 400 when a user lists the same ref in both --stdin and
  --env-file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B: approval UI human[] copy + drift test

**Files:**
- Modify: `src/daemon/approvals/ui.html`
- Modify: `src/daemon/approvals/ui-server.test.ts`

- [ ] **Step 1: Write failing drift test**

Append to `src/daemon/approvals/ui-server.test.ts`:

```typescript
test("ui.html human[].run_stdin: explains stdin pipe + masking", async () => {
  const html = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html"),
    "utf8",
  );
  // The human[] map entry for run_stdin must exist and reference:
  // - "stdin" (what's happening)
  // - "pipe" (the action verb)
  // - "fd 0" or "directly" (clarify CLI doesn't see plaintext)
  // - "masked" (defense-in-depth on child stdout/stderr)
  assert.match(html, /run_stdin\s*:/);
  const runStdinSection = html.match(/run_stdin\s*:\s*`([^`]+)`/);
  assert.ok(runStdinSection, "run_stdin human[] entry must exist as a template literal");
  const copy = runStdinSection![1]!;
  assert.match(copy, /stdin/i, "must mention stdin");
  assert.match(copy, /pipe/i, "must describe piping");
  assert.match(copy, /mask/i, "must mention masking");
});
```

(Add the imports `readFile`, `path`, `fileURLToPath` if not present.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="human\\[\\]\\.run_stdin"`
Expected: FAIL — `run_stdin:` not in ui.html.

- [ ] **Step 3: Add the human[] map entry to `src/daemon/approvals/ui.html`**

Find the existing `human` map (currently lines 30-44, around the `const human = { inject: ..., capture: ..., ... }` block). After the existing `run:` entry (or wherever fits the existing ordering), insert:

```javascript
          run_stdin: `Resolve secret ${esc(g.ref ?? "")} and pipe its value to the child's stdin (fd 0). The daemon writes the bytes directly; the CLI process never sees the plaintext. Child stdout/stderr are masked before relay. Use for tools that read secrets from stdin: gh auth login --with-token, docker login --password-stdin, kubectl create secret ... --from-file=-.`,
```

- [ ] **Step 4: Run drift test**

Run: `npm test -- --test-name-pattern="human\\[\\]\\.run_stdin"`
Expected: PASS.

Run: `npm test`
Expected: 926 tests (was 925 + 1), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/ui.html src/daemon/approvals/ui-server.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/ui): human[].run_stdin copy for stdin pass-through approval

When a production secret is approval-gated for stdin pass-through,
the approval UI now shows specific copy explaining:
- The daemon writes the bytes directly to the child's fd 0.
- The CLI process never sees the plaintext.
- Child stdout/stderr are masked.
- Recommended use cases: gh auth login --with-token, docker login
  --password-stdin, kubectl create secret ... --from-file=-.

Drift-guard test pins the substantive content (stdin/pipe/mask)
to catch accidental rewording that loses the security guarantee.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C: spawner stdin path

**Files:**
- Modify: `src/daemon/run/spawner.ts`
- Modify: `src/daemon/run/spawner.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/daemon/run/spawner.test.ts`:

```typescript
test("spawnAndStream: stdinBytes undefined → child sees EOF on stdin", async () => {
  const writer = makeTestWriter();
  // `cat` exits when stdin closes. With stdio[0]="ignore", child reads EOF immediately.
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "");
});

test("spawnAndStream: stdinBytes provided → child reads exactly those bytes + EOF", async () => {
  const writer = makeTestWriter();
  const payload = Buffer.from("hello-stdin-12345");
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "hello-stdin-12345");
});

test("spawnAndStream: stdinBytes empty Buffer → child reads EOF immediately", async () => {
  const writer = makeTestWriter();
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: Buffer.alloc(0),
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "");
});

test("spawnAndStream: child that ignores stdin and exits early still completes (EPIPE swallowed)", async () => {
  const writer = makeTestWriter();
  // `true` is a POSIX no-op that exits 0 immediately without reading stdin.
  // If our stdin write produces an unhandled EPIPE, this test would fail
  // with an uncaught exception.
  const payload = Buffer.from("never-read");
  await spawnAndStream({
    cmd: "true",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });
  assert.equal(writer.exit, 0);
});
```

(`makeTestWriter` is the existing helper in spawner.test.ts that records writeStdout/writeStderr/writeExit/writeError. If not present, define a minimal one at the top of the test file.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="spawnAndStream.*stdin"`
Expected: typecheck error (`stdinBytes` not in `SpawnInput`).

- [ ] **Step 3: Extend `src/daemon/run/spawner.ts`**

Add the field to the interface:

```typescript
export interface SpawnInput {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  outputWriter: OutputWriter;
  signal?: AbortSignal;
  /**
   * Optional bytes to write to the child's stdin. When set:
   *  - The child is spawned with stdio[0] = "pipe" (instead of "ignore").
   *  - The daemon writes the bytes synchronously, then calls .end() to
   *    flush + send EOF.
   *  - EPIPE (child closed stdin before reading) is swallowed; the
   *    promise still resolves on child exit. The route-layer audit
   *    can be extended to record stdin_write_failed if needed.
   * The CLI never sees these bytes; only the daemon process holds them.
   */
  stdinBytes?: Buffer;
}
```

Update the `spawn(...)` call to use the pipe stdio:

```typescript
      child = spawn(input.cmd, input.args, {
        shell: false,
        env: input.env,
        cwd: input.cwd,
        stdio: input.stdinBytes !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
```

After the `c.stderr?.on("data", ...)` line, add the stdin write:

```typescript
    // If stdin bytes were supplied, write+end the stream. EPIPE is
    // swallowed: a child that ignores stdin (or exits before reading)
    // produces this signal, but we don't want to crash the spawn for
    // it — the child still runs to completion.
    if (input.stdinBytes !== undefined && c.stdin !== null) {
      c.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") return;
        // Non-EPIPE errors should still bubble through writeError but
        // not crash the daemon. Log via outputWriter so the route can
        // surface as a structured stream event.
        input.outputWriter.writeError({
          code: "stdin_write_failed",
          message: err.message,
        });
      });
      c.stdin.write(input.stdinBytes);
      c.stdin.end();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="spawnAndStream"`
Expected: all spawnAndStream tests pass (existing + 4 new).

Run: `npm test`
Expected: 930 tests (was 926 + 4), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/run/spawner.ts src/daemon/run/spawner.test.ts
git commit -m "$(cat <<'EOF'
feat(spawner): stdin-write path for stdin pass-through

SpawnInput gains stdinBytes?: Buffer. When set:
- stdio[0] flips from "ignore" to "pipe".
- The daemon writes the bytes to the child's stdin, then calls .end()
  to flush + send EOF. The child reads exactly those bytes.
- EPIPE (child closed stdin before reading) is swallowed silently.
  Other stdin errors surface via outputWriter.writeError as
  stdin_write_failed.
- Backward compatible: omitting stdinBytes keeps today's behavior
  (fd 0 = /dev/null, child sees EOF immediately).

The CLI process never holds plaintext — the daemon owns the entire
write. The masker (constructed at the route layer) gets the stdin
bytes in its known-secrets set alongside resolved env values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task D: run-resolve route extension

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.ts`
- Modify: `src/daemon/api/routes/run-resolve.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/daemon/api/routes/run-resolve.test.ts`:

```typescript
test("POST /v1/run/resolve: stdin_ref resolves and child reads it", async () => {
  await withRunDaemon(async (ctx) => {
    await ctx.unlock();
    await ctx.seedSecret({
      name: "STDIN_TOKEN",
      environment: "development",
      source: "local",
      value: "hello-from-stdin",
      allowedActions: ["use_as_stdin"],
    });
    const stream = await ctx.streamRun({
      cmd: "cat",
      args: [],
      stdin_ref: "ss://local/dev/STDIN_TOKEN",
      cwd: ctx.cwd,
    });
    const lines = await collectStream(stream);
    const stdout = lines
      .filter((l) => "stream" in l && l.stream === "stdout")
      .map((l) => Buffer.from((l as { data: string }).data, "base64").toString())
      .join("");
    // The cat output should equal the secret value (masked to *** by the
    // per-stream masker before relay).
    assert.equal(stdout, "***");
    const exitLine = lines.find((l) => "exit" in l);
    assert.equal((exitLine as { exit: number }).exit, 0);
  });
});

test("POST /v1/run/resolve: stdin_ref malformed → bad_request before resolve", async () => {
  await withRunDaemon(async (ctx) => {
    await ctx.unlock();
    const r = await ctx.fetchRaw({
      cmd: "cat",
      args: [],
      stdin_ref: "not-an-ss-url",
      cwd: ctx.cwd,
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  });
});

test("POST /v1/run/resolve: stdin_ref also in env_refs → stdin_ref_in_env_file", async () => {
  await withRunDaemon(async (ctx) => {
    await ctx.unlock();
    await ctx.seedSecret({
      name: "DUPED",
      environment: "development",
      source: "local",
      value: "x",
      allowedActions: ["use_as_stdin"],
    });
    const r = await ctx.fetchRaw({
      cmd: "true",
      args: [],
      refs: ["ss://local/dev/DUPED"],
      env: [{ key: "DUPED", value: "ss://local/dev/DUPED", isRef: true }],
      stdin_ref: "ss://local/dev/DUPED",
      cwd: ctx.cwd,
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "stdin_ref_in_env_file");
  });
});

test("POST /v1/run/resolve: stdin_ref with use_as_stdin removed → action_not_allowed", async () => {
  await withRunDaemon(async (ctx) => {
    await ctx.unlock();
    await ctx.seedSecret({
      name: "NO_STDIN",
      environment: "development",
      source: "local",
      value: "x",
      allowedActions: ["inject_into_field"], // excludes use_as_stdin
    });
    const stream = await ctx.streamRun({
      cmd: "cat",
      args: [],
      stdin_ref: "ss://local/dev/NO_STDIN",
      cwd: ctx.cwd,
    });
    const lines = await collectStream(stream);
    const err = lines.find((l) => "error" in l) as { error: { code: string } } | undefined;
    assert.ok(err);
    assert.equal(err!.error.code, "action_not_allowed");
  });
});

test("POST /v1/run/resolve: stdin-only audit emits action=run_stdin", async () => {
  await withRunDaemon(async (ctx) => {
    await ctx.unlock();
    await ctx.seedSecret({
      name: "AUD",
      environment: "development",
      source: "local",
      value: "v",
      allowedActions: ["use_as_stdin"],
    });
    await collectStream(await ctx.streamRun({
      cmd: "true",
      args: [],
      stdin_ref: "ss://local/dev/AUD",
      cwd: ctx.cwd,
    }));
    const audit = await ctx.readAudit();
    const stdinLine = audit.find((e) => e.action === "run_stdin");
    assert.ok(stdinLine, "audit must contain a run_stdin entry");
    assert.equal(stdinLine.ok, true);
    assert.equal(stdinLine.ref, "ss://local/dev/AUD");
    assert.equal(stdinLine.environment, "development");
    assert.equal(stdinLine.value_visible_to_agent, false);
  });
});
```

(These tests reference test helpers like `withRunDaemon`, `streamRun`, `fetchRaw`, `seedSecret`, `readAudit`, `collectStream` — verify they exist in `run-resolve.test.ts` or import from the existing test harness file. If `stdin_ref` isn't yet a recognized body field, the body shape will need an inline cast.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="stdin_ref"`
Expected: tests fail (route doesn't accept `stdin_ref`; duplicate-guard not implemented).

- [ ] **Step 3: Extend `src/daemon/api/routes/run-resolve.ts`**

Find the body validation block (around the existing `const refs = optStringArray(o, "refs")` lines). Add:

```typescript
    const stdinRef = optString(o, "stdin_ref");
    if (stdinRef !== undefined) {
      // Validate ss:// shape before any vault work.
      const parsed = parseSecretRef(stdinRef);
      if (parsed === null) {
        throw new ShuttleError("bad_request", "stdin_ref must be a valid ss:// reference.");
      }
      // Duplicate guard: same ref in both --stdin and --env-file is almost
      // certainly a user mistake. Fail closed with a distinct code so the
      // CLI can surface a clear hint.
      if (refs.includes(stdinRef)) {
        throw new ShuttleError(
          "stdin_ref_in_env_file",
          `stdin_ref ${stdinRef} also appears in env refs. Use one mechanism, not both.`,
        );
      }
    }
```

Update the resolution batch to include `stdin_ref`:

```typescript
    const allRefs = stdinRef !== undefined ? [stdinRef, ...refs] : refs;
    const resolved = await services.vault.resolveRefs(allRefs);
```

(The existing `resolveRefs` deduplication will silently skip duplicates if the guard above is bypassed somehow — defense in depth.)

For each ref, the existing `assertSecretActionAllowed(record, "use_as_stdin")` already runs (Plan 3 contract). Stdin ref inherits the same check — no new code.

For per-ref approval, the existing loop builds `ApprovalBinding { action: "run", ref, environment }`. Extend to discriminate:

```typescript
    for (const ref of allRefs) {
      const record = resolved.get(ref)!;
      if (record.environment !== "production") continue;
      const action = ref === stdinRef ? "run_stdin" : "run";
      const binding: ApprovalBinding = {
        action,
        ref,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
      };
      let grant: ApprovalGrant | undefined;
      try {
        grant = await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
          ...(waitForApproval === false ? { waitMs: 0 } : {}),
        });
      } catch (e) {
        // Per-ref audit on failure (Plan 3 R4-3 pattern).
        await writeDaemonAudit({
          action,
          ok: false,
          ref,
          environment: record.environment,
          error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
          ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
        throw e;
      }
      await writeDaemonAudit({
        action,
        ok: true,
        ref,
        environment: record.environment,
        ...(grant.approval_id !== undefined ? { approval_id: grant.approval_id } : {}),
        ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
    }
```

(The exact shape depends on the existing loop — preserve it; the only changes are `action = ref === stdinRef ? "run_stdin" : "run"` and the binding's `action` field carries that value.)

Update the spawner call:

```typescript
    await spawnAndStream({
      cmd,
      args,
      env: { ...buildChildEnv(), ...resolvedEnv },
      cwd,
      outputWriter: maskedWriter,
      signal: abortController.signal,
      ...(stdinRef !== undefined
        ? { stdinBytes: Buffer.from(resolved.get(stdinRef)!.value, "utf8") }
        : {}),
    });
```

Update the masker's known-secrets set to include the stdin value:

```typescript
    const knownSecrets: string[] = [];
    for (const [ref, record] of resolved) knownSecrets.push(record.value);
    // (resolved already contains the stdin ref's value if present)
    const maskedWriter = wrapWithMasker(rawWriter, knownSecrets);
```

(Verify by reading the existing masker setup — it likely already iterates over `resolved`; if so, no change needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="stdin"`
Expected: 5 new route tests pass.

Run: `npm test`
Expected: 935 tests (was 930 + 5), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/run-resolve.ts src/daemon/api/routes/run-resolve.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): /v1/run/resolve accepts stdin_ref

Extends the run-resolve route body with optional stdin_ref. Behavior:
- Validated via parseSecretRef; malformed → 400 bad_request.
- Duplicate guard: same ref in both env_refs and stdin_ref →
  400 stdin_ref_in_env_file (distinct from generic bad_request so
  the CLI can hint precisely).
- Batch-resolved alongside env refs in one vault.resolveRefs call.
- assertSecretActionAllowed(record, "use_as_stdin") gates per-ref
  (existing Plan 3 contract).
- Production stdin ref builds ApprovalBinding { action: "run_stdin" }
  for requireApproval. Env refs unchanged at action: "run".
- Per-ref audit: stdin ref emits action="run_stdin"; env refs
  unchanged. Both with value_visible_to_agent: false.
- The resolved stdin bytes are passed to spawnAndStream as
  stdinBytes; the masker's known-secrets set includes them so
  child stdout/stderr echo is masked.

Five new route tests cover: e2e cat-read (masked to ***), malformed
ref → bad_request, duplicate → stdin_ref_in_env_file, use_as_stdin
removed → action_not_allowed, audit emits action="run_stdin".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task E: CLI flag

**Files:**
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/commands/run.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/cli/commands/run.test.ts`:

```typescript
test("runCommand: --stdin flag accepted", () => {
  const cmd = runCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--stdin"), "should accept --stdin");
});

test("runCommand: --env-file is no longer required (optional with --stdin alternative)", () => {
  const cmd = runCommand();
  const envFile = cmd.options.find((o) => o.long === "--env-file");
  assert.ok(envFile, "--env-file must still be declared");
  assert.equal(envFile!.required, false, "--env-file must be optional in Plan 4c");
});

test("runCommand: --stdin flag composable with --env-file (both in option list)", () => {
  const cmd = runCommand();
  const longs = cmd.options.map((o) => o.long);
  assert.ok(longs.includes("--stdin"));
  assert.ok(longs.includes("--env-file"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="runCommand: --stdin|--env-file is no longer required"`
Expected: tests fail (no `--stdin` option; `--env-file` is requiredOption).

- [ ] **Step 3: Edit `src/cli/commands/run.ts`**

Change `--env-file` from required to optional:

```typescript
.option(
  "--env-file <path>",
  "Path to env file. Entries: KEY=VALUE; ss:// values are resolved by the daemon. Optional; combine with --stdin or use --stdin alone.",
)
```

(Note: `.requiredOption` → `.option`. The action body must now check whether `options.envFile` is defined before reading it.)

Add the `--stdin` option (after `--env-file`):

```typescript
.option(
  "--stdin <ref>",
  "Secret ref to pipe to the child's stdin (fd 0). The CLI never sees the value; the daemon writes it directly. Composable with --env-file. Production refs are approval-gated.",
)
```

Update the action body. Find the existing env-file read block and wrap it in a conditional:

```typescript
    .action(async (command: string[], options: Record<string, unknown>) => {
      if (command.length === 0) {
        throw new ShuttleError("missing_param", "Specify the command to run after `--`.");
      }
      if (options.envFile === undefined && options.stdin === undefined) {
        throw new ShuttleError(
          "missing_param",
          "At least one of --env-file or --stdin must be supplied.",
        );
      }

      let entries: Array<{ key: string; value: string; isRef: boolean }> = [];
      let refs: string[] = [];
      if (options.envFile !== undefined) {
        let envFileContent: string;
        try {
          envFileContent = await readFile(options.envFile as string, "utf8");
        } catch {
          throw new ShuttleError(
            "env_file_not_found",
            `env file not found: ${options.envFile as string}`,
          );
        }
        const parsed = parseEnvFile(envFileContent);
        entries = parsed.entries;
        refs = entries.filter((e) => e.isRef).map((e) => e.value);
      }

      const body: Record<string, unknown> = {
        refs,
        env: entries,
        command: command[0],
        args: command.slice(1),
        cwd: process.cwd(),
      };
      if (options.stdin !== undefined) body.stdin_ref = options.stdin;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.session !== undefined) body.session_id = options.session;
      if (options.wait === false) body.wait_for_approval = false;

      // ... rest of action body unchanged
```

Update the help epilog to document the new flag. Find the `.addHelpText("after", ...)` block. Replace the `Notes:` section to reflect that stdin pass-through is supported (remove the "Interactive stdin is NOT supported" line):

```typescript
    .addHelpText(
      "after",
      `
Examples:
  # .env file contains refs:
  secret-shuttle run --env-file=.env -- npm start

  # Pipe a secret to a CLI that reads from stdin:
  secret-shuttle run --stdin=ss://local/prod/DOCKERHUB_TOKEN -- \\
    docker login -u myuser --password-stdin docker.io

  # Combine env-file + stdin (tool needs both):
  secret-shuttle run --env-file=.env --stdin=ss://local/prod/GH_TOKEN -- \\
    gh auth login --with-token

  # With pre-issued approval for production refs:
  secret-shuttle run --env-file=.env --approval-id <id> -- vercel deploy

Notes:
  - Refs are resolved by the daemon, never the CLI. The child gets them
    as env vars (--env-file) or as bytes on fd 0 (--stdin).
  - Non-ref entries in --env-file pass through verbatim.
  - Resolved secret values are best-effort MASKED in the child's
    stdout/stderr before they reach this CLI. A hostile child can still
    exfiltrate via network; masking is defense-in-depth.
  - Production refs require approval. Use --no-wait to receive an
    approval_id immediately.
  - The child runs in the CURRENT working directory (this CLI's cwd).
  - --stdin and --env-file cannot reference the SAME ref. Combining
    them returns stdin_ref_in_env_file (exit 2).
`,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="runCommand"`
Expected: all run-command tests pass.

Run: `npm test`
Expected: 938 tests (was 935 + 3), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/run.ts src/cli/commands/run.test.ts
git commit -m "$(cat <<'EOF'
feat(cli/run): --stdin flag for stdin pass-through

- New --stdin <ref> option. The daemon resolves the ref and pipes
  the bytes to the spawned child's fd 0; the CLI never sees the
  plaintext.
- --env-file changes from required to optional. A user may now
  invoke `run --stdin <ref> -- <cmd>` without an env-file, or
  combine both flags in one invocation.
- New guard: at least one of --env-file or --stdin must be
  supplied. Otherwise → missing_param.
- Help epilog updated with stdin examples and the Plan 4c notes.
  Removed the obsolete "Interactive stdin is NOT supported" line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F: E2E via hub broker

**Files:**
- Modify: `src/daemon/hub/hub-e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/hub/hub-e2e.test.ts`:

```typescript
test("e2e: production stdin op → hub surface → approve → child reads value", async () => {
  await withE2EDaemon(async (ctx) => {
    // Seed a production secret with use_as_stdin allowed.
    await ctx.unlock();
    await ctx.seedSecret({
      name: "PROD_STDIN",
      environment: "production",
      source: "local",
      value: "prod-secret-value",
      allowedActions: ["use_as_stdin"],
      allowedDomains: ["docker.io"],
    });

    // Start the run-resolve request. Don't await yet — the daemon will
    // block on requireApproval until we approve via the hub.
    const responsePromise = ctx.streamRun({
      cmd: "cat",
      args: [],
      stdin_ref: "ss://local/prod/PROD_STDIN",
      cwd: ctx.cwd,
    });

    // Poll the broker for a pending operation.
    let pending: { url: string; seq: number } | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pending === undefined) {
      // The broker accumulates surfaces; capture the first one.
      const state = ctx.broker.peekState();
      if (state.activeUrl !== null && state.activeSeq !== null) {
        pending = { url: state.activeUrl, seq: state.activeSeq };
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(pending, "expected a pending operation URL in the hub broker");

    // The pending URL must reference the per-URL approval id+token. Approve
    // it via the existing /ui/approvals/:id/approve route.
    const url = new URL(pending!.url);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    assert.ok(id && token, "approval URL must carry id + token");
    const approveRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${id}/approve?token=${encodeURIComponent(token!)}`,
      { method: "POST" },
    );
    assert.equal(approveRes.status, 200);

    // Now await the run-resolve stream; daemon should resume + spawn + exit.
    const lines = await collectStream(await responsePromise);
    const exit = lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exit?.exit, 0);

    // The cat child read the secret value and echoed it; the masker
    // converted it to *** before relay.
    const stdout = lines
      .filter((l) => "stream" in l && l.stream === "stdout")
      .map((l) => Buffer.from((l as { data: string }).data, "base64").toString())
      .join("");
    assert.equal(stdout, "***");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="e2e: production stdin"`
Expected: fails until the test harness supports the new fields (likely passes immediately if all prior tasks committed correctly; if so, this test serves as the integration check).

- [ ] **Step 3: If `withE2EDaemon`/`streamRun` need extensions, add them**

If the harness in `hub-e2e.test.ts` doesn't have `seedSecret`/`streamRun`/`collectStream`, either extend or import from the existing run-resolve test harness. Verify by reading the existing hub-e2e tests' shape.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="e2e: production stdin"`
Expected: PASS.

Run: `npm test`
Expected: 939 tests (was 938 + 1), 0 fail, 2 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/hub/hub-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(hub): e2e production stdin pass-through via hub broker

Full integration check exercising:
- Plan 4c stdin_ref route extension.
- Plan 4c "run_stdin" ApprovalBinding action.
- Plan 4b hub broker surfacing the approval URL.
- Plan 3 per-ref masking on child stdout.
- Plan 2 use_as_stdin per-ref enforcement.

Seeds a production secret, triggers the run-resolve request, finds
the broker's activeUrl, approves via /ui/approvals/:id/approve,
awaits the stream completion, asserts exit 0 and that the child's
echo of the secret was masked to *** before relay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run final verification**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: 939 tests, 937 pass, 2 skipped, 0 fail.

Run: `npm run check-pack`
Expected: clean.

If anything fails, STOP, investigate, and report.

- [ ] **Step 2: Append CHANGELOG entry**

Open `CHANGELOG.md`. Find the `## Unreleased` section. After the existing `### Added — Plan 4b (single-window tab reuse)` block (and its `### Security` block), add:

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): Plan 4c — stdin pass-through

Adds the user-facing summary for Plan 4c: --stdin flag on `run`,
new run_stdin audit + binding action, stdin_ref_in_env_file error
code, masking extension to stdin bytes. --env-file becomes optional;
at least one of --env-file or --stdin required.

Security section captures: stdin bytes never cross CLI/daemon HTTP
boundary, EPIPE handling, dup-guard rationale, value_visible_to_agent
invariant.

Closes Plan 4c. Predecessor: Plan 4b (commit 3c9d377).
Successor: Plan 5a (init + native keychain).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**
- `--stdin <ref>` flag → Task E.
- `stdin_ref` body field → Task D.
- Spawner stdin path → Task C.
- `run_stdin` audit action → Task A.
- `run_stdin` ApprovalBinding action → Task A.
- `stdin_ref_in_env_file` error code → Task A.
- Approval UI human[] copy → Task B.
- Masking integration → Task C + Task D (route passes stdin bytes to masker's known-secrets).
- Hub broker surfacing → Task F (e2e).
- CHANGELOG → Task G.

All spec sections covered. No gaps.

**Placeholder scan:** no TBD / "implement later" / "Similar to Task N" patterns. Every step has complete code.

**Type consistency:** `SpawnInput.stdinBytes`, `ApprovalBinding.action: "run_stdin"`, `DaemonAuditAction: "run_stdin"`, `stdin_ref` field name, `stdin_ref_in_env_file` error code — all consistent across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-plan4c-stdin-passthrough.md`.

**Execution mode:** Subagent-driven-development (matches Plan 4a + 4b pattern). Fresh subagent per task + two-stage review (spec compliance, then code quality). Ready to proceed.
