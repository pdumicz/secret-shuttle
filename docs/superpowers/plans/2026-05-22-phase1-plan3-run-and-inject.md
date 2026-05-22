# Phase 1 — Plan 3: `run` + `inject` commands

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two category-standard process-integration verbs Secret Shuttle is missing — `secret-shuttle run --env-file=<f> -- <cmd>` (subshell injection: secrets reach the child via env vars; daemon spawns the child and masks resolved values in child stdout/stderr before relay so the CLI process never holds plaintext) and `secret-shuttle inject -i <template> -o <out>` (template substitution: daemon writes the rendered file at mode 0600 via atomic O_EXCL temp-file + rename).

**Architecture:** Two new daemon endpoints, mirroring the daemon-mediated execution pattern that templates use today. `POST /v1/run/resolve` takes the env-file refs + the command + argv + CLI's cwd, resolves refs against `Vault.getSecret` (which honors the soft-delete invariant from Plan 2), enforces the per-secret `use_as_stdin` action via `assertSecretActionAllowed`, spawns the child with `shell: false` + a sanitized env block + resolved vars + the CLI's cwd, then streams stdout/stderr back to the CLI as line-delimited JSON over chunked HTTP — masked through a streaming pattern matcher so resolved values are replaced with `***` before the bytes cross the HTTP boundary. `POST /v1/inject/render` takes the template content + an absolute (CLI-canonicalized) output path, resolves embedded `ss://` refs against `parseSecretRef`-validated matches, enforces `use_as_stdin`, and writes the rendered file daemon-side via an atomic `O_CREAT|O_EXCL|O_WRONLY` temp-file + `rename`, refusing leaf-symlink targets and any parent path that `realpath`s outside `$HOME`. Both endpoints production-gate via the existing `requireApproval` + new `run` / `inject_render` actions in `ApprovalBinding`. The env-file parser is CLI-side (matches `op run` ergonomics) but the template parser is daemon-side (CLI just ships the bytes — keeps secrets out of CLI memory entirely). Both new HTTP routes are registered via a new `DaemonServer.addRouteStreaming` primitive that runs the same Host + bearer-token + 1 MB body cap checks as `addRoute` but lets the handler control the response body for chunked output.

**Tech Stack:** TypeScript (existing); Node 20+ (existing); Node's built-in `fetch` with streaming response bodies for the `run` output channel; `child_process.spawn` for the `run` spawner; `fs/promises` with `O_CREAT | O_EXCL` + chmod 0600 for `inject -o <path>`. No new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) §5.3 (run), §5.4 (inject), §3.3 (new daemon endpoints).

**Sequence with other Phase 1 plans:**

- **Plan 1 ✅** — Foundation (structured errors + keychain interface).
- **Plan 2 ✅** — CLI surface (secrets group + status + internal + help + deprecation).
- **Plan 3 (this)** — `run` + `inject` + daemon spawner. Depends on Plans 1+2 for the `secrets get-ref` deleted-aware lookup and the structured error/deprecation contract.
- **Plan 4** — Pre-approved sessions + approval-UI single-window tab reuse + masking of resolved values in `run`'s stdout/stderr (output-pathway hardening pass).
- **Plan 5a** — `init` rewrite + native-module keychain.
- **Plan 5b** — Docs (SKILL.md, walkthrough, README, cli-reference) + npm publish 0.2.0.

## Scope reductions called out explicitly

These are spec items Plan 3 deliberately defers or deviates from, with rationale:

- **Child stdin pass-through in `run`.** Spec §5.3 line 257 says "Child's stdin inherits from CLI's stdin." Implementing this requires bidirectional HTTP-body streaming (CLI sends a chunked request body multiplexing stdin chunks; daemon reads continuously and pipes to `child.stdin`). Node's `fetch` supports half-duplex `ReadableStream` bodies, but the protocol design + tests are a meaningful slice of work that's separable from the rest of `run`. **Plan 3 ships with `child.stdin: "ignore"`** (closed at spawn) and Plan 4 adds the stdin multiplexing alongside the single-window tab-reuse work. The vast majority of `run` use cases (`npm start`, `vercel deploy`, `npx <tool>`) don't read interactive stdin, so this is a non-blocking deviation. CHANGELOG calls it out under "Known limitations" and the spec gets an inline note (see Task E2).
- **Arbitrary binary validation.** `run --` accepts whatever command the user passes (matches `op run` / `doppler run` / `infisical run` ergonomics). The daemon spawns with `shell: false` + scrubbed env, but doesn't validate the binary path, sha256, or that it's an allowlisted vendor CLI — that's the template runner's job (`template run`), not `run`'s. The agent that calls `run` is already trusted with the daemon's full API.
- **PATH inheritance for `run` children.** `buildChildEnv()` returns a hardened-PATH baseline (no user-customized PATH). The user's `npm`, `vercel`, `node`, etc. must be discoverable on the daemon's hardened PATH — which they are, since daemon-spawned templates rely on the same. Users who need a custom PATH can put it in the env file as `PATH=/custom/path:$PATH` (with the caveat that `$PATH` expansion doesn't happen; they need the literal string).

**Explicitly NOT deferred (in scope for Plan 3):**

- **stdout/stderr masking in `run`.** Spec §5.3 lines 257/262/265 require the daemon to mask resolved values in child stdout/stderr before relay. This is a *contract* of the `run` command — without it, any child that prints config (e.g. `node -e "console.log(process.env)"`) leaks raw secrets to the agent. Plan 3 ships a streaming, lookback-buffered byte-level masker (`src/daemon/run/masker.ts`, Task B4) that the daemon route wires through its OutputWriter (Task B5) so resolved values are replaced with `***` before bytes cross the HTTP boundary. Masking is defense-in-depth (a hostile child can still exfiltrate via network), but the daemon-as-bytes-redactor guarantee is the *whole point* of having the daemon spawn the child instead of the CLI.

---

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/cli/run/env-file.ts` | Pure parser: strict dotenv-like `KEY=VALUE` reader. Returns `{ key, value, isRef }[]` |
| `src/cli/run/env-file.test.ts` | Parser unit tests |
| `src/client/streaming-request.ts` | Thin streaming-aware client helper: line-delimited JSON over chunked HTTP. Reuses `daemonErrorFromPayload` from Plan 1 for non-200 reconstruction. |
| `src/client/streaming-request.test.ts` | Streaming client tests (mocks the daemon response stream) |
| `src/daemon/run/spawner.ts` | Spawns child process with resolved env + `cwd` from the request body; streams stdout/stderr/exit through an `OutputWriter` (which is wrapped by the masker before reaching the HTTP response); kills the child on response close/abort |
| `src/daemon/run/spawner.test.ts` | Spawner unit tests (uses Node itself as the child binary fixture) |
| `src/daemon/run/masker.ts` | Streaming byte-level masker: replaces secret values in stdout/stderr chunks with `***`; lookback-buffered for boundary-spanning matches |
| `src/daemon/run/masker.test.ts` | Masker unit tests: boundary spans, multiple secrets, longer-first overlap, flush semantics |
| `src/daemon/api/routes/run-resolve.ts` | `POST /v1/run/resolve` route — resolves refs, enforces `use_as_stdin` action policy, requires approval, builds masker from resolved values, invokes spawner |
| `src/daemon/api/routes/run-resolve.test.ts` | Route integration tests (includes a masking smoke test: child prints env var; resolved value never appears in the stream) |
| `src/daemon/api/routes/inject-render.ts` | `POST /v1/inject/render` route — parses template via `parseSecretRef`-validated matches, enforces `use_as_stdin` per ref, resolves, writes file atomically (or returns content for stdout mode) |
| `src/daemon/api/routes/inject-render.test.ts` | Route integration tests |
| `src/daemon/inject/template.ts` | Pure template parser/renderer: greedy character-class match + `parseSecretRef` validation per candidate. Returns deduped refs + `render` |
| `src/daemon/inject/template.test.ts` | Template parser tests (including negative cases: lowercase still parses since canonical NAME_RE allows mixed-case; invalid suffix chars terminate the match) |
| `src/cli/commands/run.ts` | `secret-shuttle run` CLI command — sends `cwd: process.cwd()` in the body; reconstructs stream errors via `daemonErrorFromPayload` |
| `src/cli/commands/run.test.ts` | CLI structure tests |
| `src/cli/commands/inject.ts` | `secret-shuttle inject` CLI command (new top-level template-substitution command — does NOT collide with `internal inject`, which stays at its Plan 2 name) |
| `src/cli/commands/inject.test.ts` | CLI structure tests |

**Files to modify:**

| Path | Change |
|---|---|
| `src/daemon/server.ts` | Add `addRouteStreaming(method, path, handler)` primitive: identical Host + bearer + 1 MB body cap as `addRoute`, but the handler controls the response body. `addRouteRaw` stays unchanged (it's used by the approval UI's per-URL-token routes). |
| `src/daemon/server.test.ts` | New: streaming-route unauthorized → 401, bad-Host → 400, oversize body → existing `request_too_large` path. |
| `src/vault/vault.ts` | Add `resolveRefs(refs: string[])` helper that calls `getSecret` for each ref and returns a `Map<ref, SecretRecord>` (note: returns the *record*, not the bare value, so callers can do `assertSecretActionAllowed` + `markUsed` inline). Used by both daemon routes for batch resolution + atomic policy enforcement. |
| `src/daemon/approvals/store.ts` | Extend `ApprovalBinding.action` union with `"run"` and `"inject_render"`. |
| `src/daemon/approvals/ui.html` | Add human-readable copy for the two new actions. |
| `src/daemon/audit.ts` | Extend `DaemonAuditAction` to include `"run"` and `"inject_render"`. |
| `src/shared/error-codes.ts` | Add new registry entries: `env_file_parse_error` (USAGE), `env_file_not_found` (NOT_FOUND), `inject_template_parse_error` (USAGE), `inject_output_path_unsafe` (PERMISSION), `inject_output_write_failed` (PERMISSION), `spawn_failed` (TRANSIENT). |
| `src/shared/error-codes.test.ts` | Bump registry count from 104 → 110 and assert the six new entries. |
| `src/daemon/api/router.ts` (or wherever routes are registered) | Register `/v1/run/resolve` (streaming) and `/v1/inject/render` (regular JSON) with `daemonPortRef`. |
| `src/cli/commands/inject.ts` → `src/cli/commands/inject-internal.ts` | **Source-file rename only.** The V0 CDP-inject command file is renamed so a new `inject.ts` can hold the template-substitution command. Exported factory name (`injectCommand`) AND Commander name (`new Command("inject")`) stay unchanged — user-facing `internal inject` is identical to Plan 2. |
| `src/cli/commands/internal.ts` | One-line import-path change: `from "./inject.js"` → `from "./inject-internal.js"`. The `cmd.addCommand(injectCommand())` line is unchanged. |
| `src/cli/index.ts` | Register `runCommand()` and `injectCommand()`. (The top-level `inject` does NOT collide with `internal inject` — Commander resolves them as separate paths in the help/dispatch tree.) |
| `CHANGELOG.md` | Append Plan 3 entries. |

**Decision 4 — the `inject` USER-FACING name does NOT collide.** Earlier drafts of this plan proposed renaming `internal inject` (the V0 CDP-inject command) to `internal inject-v0` to "free" the top-level `inject` name. That's unnecessary at the user surface: Commander dispatches by full path, so `secret-shuttle inject` and `secret-shuttle internal inject` are distinct commands. **The V0 command keeps its Plan 2 / spec §3.3 name `internal inject`.** The ONE thing that does have to change is the source file location, because two command files cannot both be named `inject.ts`. Task D2 Step 1 does a single source-only rename (`src/cli/commands/inject.ts` → `src/cli/commands/inject-internal.ts`) plus a one-line import-path update in `src/cli/commands/internal.ts`. The Commander command name + the exported factory name + the V0 user surface all stay unchanged.

---

## Pre-execution checklist — RUN BEFORE TASK A1

**Same hard gate as Plan 2.** Do not start Task A1 until all three checks pass.

- [ ] **Step 1: Working tree clean.**

```bash
git status --short
```

Expected: empty. If anything appears that isn't in this plan's declared scope, isolate it (commit on a separate branch, stash, or revert) BEFORE starting. Mixing scopes makes per-task reviews unreliable.

- [ ] **Step 2: Confirm head is on top of Plan 2.**

```bash
git log --oneline -5
```

Expected: head is on or downstream of commit `753b27c` (the Plan 2 CHANGELOG fix). If there are unrelated commits interleaved, flag them in the execution report.

- [ ] **Step 3: Build green on HEAD.**

```bash
npm run typecheck
npm test
```

Both must pass on the current HEAD before any Plan 3 work begins. If they fail, the failure isn't caused by Plan 3 — fix or escalate first.

Once all three checks pass, proceed to Task A1.

---

## Part A — Env-file parser

### Task A1: Strict dotenv-like env-file parser

**Files:**
- Create: `src/cli/run/env-file.ts`
- Create: `src/cli/run/env-file.test.ts`

**Behavior** (per spec §5.3 rules):
1. One `KEY=VALUE` per line. Blank lines and `#`-prefixed comments ignored.
2. Keys must match `[A-Z_][A-Z0-9_]*` (POSIX env var convention).
3. `VALUE` is recognized as an `ss://` reference **only if the entire value** (after optional surrounding quotes) matches `^ss://[^/]+/[^/]+/[A-Z_][A-Z0-9_]*$`. Partial-substring matches are NOT resolved.
4. Non-ref values pass through verbatim to the child env.
5. Double-quoted values are unquoted; backslash-escapes are NOT expanded.
6. No `${VAR}` shell-style expansion. Ever.

Returns `{ entries: EnvFileEntry[] }` where `EnvFileEntry = { key: string; value: string; isRef: boolean }`. The `value` field is the raw ref string (e.g. `"ss://stripe/prod/STRIPE_KEY"`) when `isRef: true`, or the verbatim literal when `isRef: false`.

- [ ] **Step 1: Write the failing test**

Create `src/cli/run/env-file.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, type EnvFileEntry } from "./env-file.js";

test("parseEnvFile: empty input returns empty entries", () => {
  const r = parseEnvFile("");
  assert.deepEqual(r.entries, []);
});

test("parseEnvFile: bare KEY=VALUE pair (non-ref)", () => {
  const r = parseEnvFile("PORT=3000\n");
  assert.deepEqual(r.entries, [{ key: "PORT", value: "3000", isRef: false }]);
});

test("parseEnvFile: KEY=ss://... resolves as ref", () => {
  const r = parseEnvFile("STRIPE_KEY=ss://stripe/prod/STRIPE_KEY\n");
  assert.deepEqual(r.entries, [{ key: "STRIPE_KEY", value: "ss://stripe/prod/STRIPE_KEY", isRef: true }]);
});

test("parseEnvFile: comments and blank lines are ignored", () => {
  const r = parseEnvFile("# this is a comment\n\nPORT=3000\n\n# another\nLOG_LEVEL=info\n");
  assert.deepEqual(r.entries, [
    { key: "PORT", value: "3000", isRef: false },
    { key: "LOG_LEVEL", value: "info", isRef: false },
  ]);
});

test("parseEnvFile: double-quoted values are unquoted; backslash NOT expanded", () => {
  const r = parseEnvFile('GREETING="hello \\n world"\n');
  assert.deepEqual(r.entries, [{ key: "GREETING", value: "hello \\n world", isRef: false }]);
});

test("parseEnvFile: partial ss:// substring is NOT a ref", () => {
  // Value contains ss:// but is not the entire value → verbatim non-ref.
  const r = parseEnvFile("MOTD=visit ss://stripe/prod/STRIPE_KEY for keys\n");
  assert.deepEqual(r.entries, [{ key: "MOTD", value: "visit ss://stripe/prod/STRIPE_KEY for keys", isRef: false }]);
});

test("parseEnvFile: invalid key name throws env_file_parse_error", () => {
  assert.throws(
    () => parseEnvFile("lowercase=value\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});

test("parseEnvFile: missing = throws env_file_parse_error", () => {
  assert.throws(
    () => parseEnvFile("NO_EQUALS_HERE\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});

test("parseEnvFile: line number is reported in error message", () => {
  let caught: Error | undefined;
  try {
    parseEnvFile("VALID=1\nINVALID\nSTILL_VALID=2\n");
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(caught);
  assert.match(caught.message, /line 2/i);
});

test("parseEnvFile: ${VAR} expansion is not supported — treated as literal", () => {
  const r = parseEnvFile("FOO=${BAR}_suffix\n");
  assert.deepEqual(r.entries, [{ key: "FOO", value: "${BAR}_suffix", isRef: false }]);
});

test("parseEnvFile: quoted ss:// ref is unquoted and detected as ref", () => {
  const r = parseEnvFile('STRIPE_KEY="ss://stripe/prod/STRIPE_KEY"\n');
  assert.deepEqual(r.entries, [{ key: "STRIPE_KEY", value: "ss://stripe/prod/STRIPE_KEY", isRef: true }]);
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run build && node --test "dist/cli/run/env-file.test.js"
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/cli/run/env-file.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";

export interface EnvFileEntry {
  key: string;
  /** The raw value as seen in the file (unquoted if double-quoted), without shell expansion. */
  value: string;
  /** True iff `value` is a syntactically valid `ss://source/env/name` ref. */
  isRef: boolean;
}

export interface EnvFileParseResult {
  entries: EnvFileEntry[];
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const REF_RE = /^ss:\/\/[^/]+\/[^/]+\/[A-Z_][A-Z0-9_]*$/;

/**
 * Strict dotenv-like parser. Spec §5.3 rules:
 *   - One KEY=VALUE per line.
 *   - Blank lines and `#`-prefixed comments ignored.
 *   - Keys: [A-Z_][A-Z0-9_]*.
 *   - Values: literal. Double quotes around value are stripped but backslash
 *     escapes are NOT expanded. No `${VAR}` shell expansion.
 *   - A value is recognized as an `ss://` ref only if the ENTIRE value matches
 *     the ref regex. Partial substrings stay literal.
 *
 * Errors: throws ShuttleError("env_file_parse_error", "<line N>: <reason>")
 * for any malformed line.
 */
export function parseEnvFile(content: string): EnvFileParseResult {
  const entries: EnvFileEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      throw new ShuttleError(
        "env_file_parse_error",
        `line ${lineNum}: missing '=' in env-file entry`,
      );
    }
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new ShuttleError(
        "env_file_parse_error",
        `line ${lineNum}: invalid key '${key}' (must match [A-Z_][A-Z0-9_]*)`,
      );
    }
    // Strip surrounding double-quotes (do NOT expand backslash escapes).
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    const isRef = REF_RE.test(value);
    entries.push({ key, value, isRef });
  }
  return { entries };
}
```

- [ ] **Step 4: Run test — expect PASS** (11 tests)

```bash
npm run build && node --test "dist/cli/run/env-file.test.js"
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/run/env-file.ts src/cli/run/env-file.test.ts
git commit -m "feat(cli): strict dotenv-like env-file parser for run command"
```

---

## Part B — Daemon streaming server + spawner endpoint

### Task B0: `DaemonServer.addRouteStreaming` primitive

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/server.test.ts` (add a new file if no test currently covers server.ts directly — search for "DaemonServer" usage in `src/daemon/**/*.test.ts` first)

**Why this task exists:** `/v1/run/resolve` returns chunked stdout/stderr — it can't be wrapped in the standard `{ ok: true, ...result }` JSON envelope that `addRoute` produces. The existing escape hatch `addRouteRaw` **intentionally bypasses Host + bearer checks** because it's used by the approval UI's per-URL-token endpoints (`/ui/approvals/<id>` validates against `grant.ui_token` instead). Reusing `addRouteRaw` for `/v1/run/resolve` would expose an arbitrary-command-execution endpoint that any process on the loopback interface (or any browser tab via a CSRF-style POST) could hit. **Plan 3 introduces a third primitive that keeps the Host + bearer + 1 MB body cap checks but lets the handler control the response body.**

- [ ] **Step 1: Write the failing test**

Create `src/daemon/server.test.ts` (or append to it if it exists). Tests:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { DaemonServer } from "./server.js";

async function setUpServer(): Promise<{ server: DaemonServer; url: string; token: string; stop: () => Promise<void> }> {
  const token = "test-token-1234";
  const server = new DaemonServer({ token });
  const { port } = await server.listen(0);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    token,
    stop: () => server.close(),
  };
}

test("addRouteStreaming: 200 with chunked body when auth + Host valid", async () => {
  const { server, url, token, stop } = await setUpServer();
  server.addRouteStreaming("POST", "/v1/test", async (_req, body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson");
    res.flushHeaders();
    res.write(JSON.stringify({ chunk: 1, echo: body }) + "\n");
    res.write(JSON.stringify({ chunk: 2 }) + "\n");
    res.end();
  });
  try {
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), { chunk: 1, echo: { hello: "world" } });
    assert.deepEqual(JSON.parse(lines[1]!), { chunk: 2 });
  } finally {
    await stop();
  }
});

test("addRouteStreaming: missing bearer token → 401 with structured error (handler NOT invoked)", async () => {
  const { server, url, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 401);
    const json = await r.json() as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "unauthorized");
    assert.equal(json.error_code, "unauthorized");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when bearer missing");
  } finally {
    await stop();
  }
});

test("addRouteStreaming: bad Host header → 400 with structured error", async () => {
  const { server, url, token, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    // The fetch API doesn't easily let us spoof Host, so test by hand-crafting a
    // request via net.connect — or use a node:http client and override headers.
    const { request } = await import("node:http");
    const port = Number(new URL(url).port);
    const responseBody: string = await new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/test",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: "evil.example.com:1234",
          "content-type": "application/json",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.write(JSON.stringify({}));
      req.end();
    });
    const json = JSON.parse(responseBody) as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "bad_host");
    assert.equal(json.error_code, "bad_host");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when Host bad");
  } finally {
    await stop();
  }
});

test("addRouteStreaming: oversize body → request_too_large (handler NOT invoked)", async () => {
  const { server, url, token, stop } = await setUpServer();
  let handlerCalls = 0;
  server.addRouteStreaming("POST", "/v1/test", async (_req, _body, res) => {
    handlerCalls += 1;
    res.statusCode = 200;
    res.end();
  });
  try {
    const huge = "x".repeat(2 * 1024 * 1024); // 2 MB > 1 MB cap
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ blob: huge }),
    });
    const json = await r.json() as Record<string, unknown>;
    assert.equal((json.error as { code: string }).code, "request_too_large");
    assert.equal(handlerCalls, 0, "handler MUST NOT be invoked when body oversize");
  } finally {
    await stop();
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (no `addRouteStreaming` method yet)

```bash
npm run build && node --test "dist/daemon/server.test.js"
```

- [ ] **Step 3: Implement**

Edit `src/daemon/server.ts`. Add a new field, a new registrar, and a new branch in `handle()`:

```typescript
type StreamingHandler = (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => Promise<void> | void;

// ... inside class DaemonServer:

private readonly streamingRoutes = new Map<string, StreamingHandler>();

/**
 * Register a route whose handler controls the response body (e.g. for chunked
 * line-delimited JSON streaming). Identical Host + bearer-token + 1 MB body
 * cap to addRoute — auth runs BEFORE the handler is invoked, so an unauthorized
 * request never reaches `spawn()` or any other side-effectful code.
 *
 * Use this for /v1/run/resolve and similar endpoints. addRouteRaw remains for
 * UI routes that authenticate via a per-URL token (see ui-server.ts).
 */
addRouteStreaming(method: Method, path: string, handler: StreamingHandler): void {
  this.streamingRoutes.set(`${method} ${path}`, handler);
}
```

Then in `handle()` (in `src/daemon/server.ts`), add the streaming-route dispatch AFTER the bearer-token check passes but BEFORE the regular `routes` lookup:

```typescript
// (right after the existing bearer-token timingSafeEqual check — same indentation)

const streamingKey = `${req.method ?? "GET"} ${urlPath}`;
const streamingHandler = this.streamingRoutes.get(streamingKey);
if (streamingHandler !== undefined) {
  const body = req.method === "GET" ? null : await readJsonBody(req);
  await streamingHandler(req, body, res);
  return;
}
```

(This goes between the `if (actual.byteLength !== expected.byteLength || !timingSafeEqual(...))` block and the existing `const key = ...; const handler = this.routes.get(key); ...` block.)

The `readJsonBody` throw paths (oversize, invalid JSON) are caught by the outer `.catch((err) => this.writeError(res, err))` in `listen()` — same path as regular routes, so streaming routes get the same error contract for free.

- [ ] **Step 4: Run — expect PASS** (4 tests)

```bash
npm run build && node --test "dist/daemon/server.test.js"
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts src/daemon/server.test.ts
git commit -m "feat(daemon): addRouteStreaming — auth-checked chunked-response primitive"
```

---

### Task B1: `Vault.resolveRefs(refs)` helper

**Files:**
- Modify: `src/vault/vault.ts`
- Modify: `src/vault/vault.test.ts`

**Behavior:** Given an array of ref strings, return a `Map<string, SecretRecord>` from ref → full record. Uses `getSecret(ref)` (deleted-aware) so soft-deleted refs throw `secret_not_found`. Returns the *record* (not the bare value) so callers can do `assertSecretActionAllowed(record, action)` + `markUsed(ref)` inline without a second vault round-trip. Single-pass — fails fast on the first missing ref. Dedupes input.

- [ ] **Step 1: Append failing tests to `src/vault/vault.test.ts`**

```typescript
test("Vault.resolveRefs returns map of ref→record for active secrets", async () => {
  const vault = await setUpTestVault({
    secrets: [makeSecret("ss://x/dev/A"), makeSecret("ss://x/dev/B")],
  });
  const refs = ["ss://x/dev/A", "ss://x/dev/B"];
  const result = await vault.resolveRefs(refs);
  assert.equal(result.size, 2);
  assert.equal(result.get("ss://x/dev/A")!.ref, "ss://x/dev/A");
  assert.equal(typeof result.get("ss://x/dev/A")!.value, "string");
  assert.ok(Array.isArray(result.get("ss://x/dev/A")!.allowed_actions));
});

test("Vault.resolveRefs dedupes repeated refs", async () => {
  const vault = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  const result = await vault.resolveRefs(["ss://x/dev/A", "ss://x/dev/A", "ss://x/dev/A"]);
  assert.equal(result.size, 1);
});

test("Vault.resolveRefs throws secret_not_found for a soft-deleted ref (invariant propagates)", async () => {
  const vault = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  await vault.softDelete("ss://x/dev/A");
  await assert.rejects(
    () => vault.resolveRefs(["ss://x/dev/A"]),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});

test("Vault.resolveRefs throws secret_not_found for a missing ref", async () => {
  const vault = await setUpTestVault({ secrets: [] });
  await assert.rejects(
    () => vault.resolveRefs(["ss://x/dev/A"]),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});

test("Vault.resolveRefs empty input returns empty map", async () => {
  const vault = await setUpTestVault({ secrets: [] });
  const result = await vault.resolveRefs([]);
  assert.equal(result.size, 0);
});
```

(Use the existing `setUpTestVault` + `makeSecret` helpers per the Plan 2 A5 tests.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — append to the `Vault` class in `src/vault/vault.ts`:

```typescript
/**
 * Resolve a list of ss:// refs to a Map<ref, SecretRecord>. Uses the
 * deleted-aware getSecret() so refs that have been soft-deleted throw
 * secret_not_found. Single-pass — fails fast on the first missing ref.
 * Dedupes input. Callers should do assertSecretActionAllowed + markUsed
 * on each returned record.
 */
async resolveRefs(refs: readonly string[]): Promise<Map<string, SecretRecord>> {
  const result = new Map<string, SecretRecord>();
  for (const ref of refs) {
    if (result.has(ref)) continue; // dedupe
    const record = await this.getSecret(ref);
    result.set(ref, record);
  }
  return result;
}
```

- [ ] **Step 4: Run — expect PASS** (full vault.test.js + the 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/vault/vault.ts src/vault/vault.test.ts
git commit -m "feat(vault): resolveRefs(refs[]) — batch deleted-aware ref→record lookup"
```

---

### Task B2: ApprovalBinding extension + UI copy + audit + registry codes

**Files:**
- Modify: `src/daemon/approvals/store.ts` — add `run` + `inject_render` to action union
- Modify: `src/daemon/approvals/ui.html` — UI copy for both
- Modify: `src/daemon/audit.ts` — extend audit action type
- Modify: `src/shared/error-codes.ts` — add 6 new registry entries
- Modify: `src/shared/error-codes.test.ts` — update count + assert new entries

**SecretAction note.** Both `run` and `inject_render` resolve secrets and inject them into a destination the agent does not need to see directly (process env / rendered file). That's semantically the same as the existing `use_as_stdin` action — and `use_as_stdin` is already in `DEFAULT_ACTIONS` per [src/vault/vault.ts](../../../src/vault/vault.ts), so existing secrets allow these flows by default. **Plan 3 does NOT introduce a new `SecretAction`** — both routes call `assertSecretActionAllowed(record, "use_as_stdin")` per resolved ref. Tightening secrets that have explicitly opted out of `use_as_stdin` continues to work (they fail closed with `action_not_allowed`). The route-level audit action is still `"run"` / `"inject_render"` — that's about *which operation* touched the ref, not which `SecretAction` was checked.

- [ ] **Step 1: Extend `ApprovalBinding.action` union**

Open `src/daemon/approvals/store.ts`. Find the `ApprovalBinding` interface (around line 12). Update the action union:

```typescript
action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate" | "run" | "inject_render";
```

(Two new entries added at the end.)

Run `npm run typecheck` — must pass.

- [ ] **Step 2: Extend `DaemonAuditAction`**

Open `src/daemon/audit.ts`. Find the action type (around line 4). Add `"run"` and `"inject_render"` to it. Place them on the same line as `secrets_delete` / `secrets_rotate` to keep the union tidy:

```typescript
| "secrets_delete" | "secrets_rotate" | "run" | "inject_render"
```

- [ ] **Step 3: Add UI copy for the two new actions**

Open `src/daemon/approvals/ui.html`. Find the action-to-human-copy mapping (search for `case "secrets_delete":` to find the place). Add:

```javascript
case "run":
  return "Resolve secret refs and inject them as env vars for the spawned command (refs visible in this approval; values stay in the daemon; child stdout/stderr are masked before relay).";
case "inject_render":
  return "Resolve secret refs and write the rendered template file (refs visible in this approval; values are written to disk at mode 0600 inside $HOME).";
```

(Adjust to match the file's exact style — read existing entries first.)

- [ ] **Step 4: Add 6 new registry entries**

Open `src/shared/error-codes.ts`. Find the appropriate sections and add:

In the Transient section (exit 1):
```typescript
spawn_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
```

(Why TRANSIENT: `spawn_failed` covers ENOENT/EACCES/EAGAIN. Same exit class as `template_spawn_failed` for consistency.)

In the Usage section (exit 2):
```typescript
env_file_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
inject_template_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

In the Not-found section (exit 3):
```typescript
env_file_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
```

In the Permission section (exit 4):
```typescript
inject_output_path_unsafe: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
inject_output_write_failed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
```

- [ ] **Step 5: Update the registry count test**

Open `src/shared/error-codes.test.ts`. Find the "registry total entry count" test. Update from 104 → 110. Add spot-checks for three of the new codes:

```typescript
assert.ok(lookupErrorCode("env_file_parse_error"));
assert.ok(lookupErrorCode("inject_output_path_unsafe"));
assert.ok(lookupErrorCode("spawn_failed"));
```

- [ ] **Step 6: Run tests — registry test + typecheck pass**

```bash
npm run typecheck
npm run build && node --test "dist/shared/error-codes.test.js"
```

- [ ] **Step 7: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/audit.ts src/daemon/approvals/ui.html \
  src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(approvals): extend ApprovalBinding + audit + registry for run / inject_render"
```

---

### Task B3: Streaming client helper

**Files:**
- Create: `src/client/streaming-request.ts`
- Create: `src/client/streaming-request.test.ts`

**Behavior:** Open a chunked-streaming HTTP POST. Read the response body as a `ReadableStream`. Decode UTF-8 and split into newline-delimited JSON messages. Invoke a callback per parsed line. Throws if the daemon returns non-200 BEFORE the stream opens; once streaming, errors come through as `{ error: { code, message } }` lines.

The protocol:
- `{ "stream": "stdout", "data": "<base64>" }` — child stdout chunk
- `{ "stream": "stderr", "data": "<base64>" }` — child stderr chunk
- `{ "exit": <code> }` — child exited; this is the last message
- `{ "error": { "code": "...", "message": "..." } }` — daemon-side error (e.g. approval denied); also final

- [ ] **Step 1: Write the failing test**

Create `src/client/streaming-request.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamLineDelimitedJson, type StreamLine } from "./streaming-request.js";

/** Helper: construct a fake ReadableStream<Uint8Array> from string chunks. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
}

test("streamLineDelimitedJson: invokes onLine for each newline-terminated JSON line", async () => {
  const stream = makeStream([
    `{"stream":"stdout","data":"aGVsbG8="}\n`,
    `{"stream":"stderr","data":"d29ybGQ="}\n`,
    `{"exit":0}\n`,
  ]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { stream: "stdout", data: "aGVsbG8=" });
  assert.deepEqual(lines[2], { exit: 0 });
});

test("streamLineDelimitedJson: handles lines split across chunk boundaries", async () => {
  const stream = makeStream([
    `{"stream":"stdout","da`,
    `ta":"aGVsbG8="}\n{"exit":0}\n`,
  ]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.data, "aGVsbG8=");
});

test("streamLineDelimitedJson: skips empty lines (between messages)", async () => {
  const stream = makeStream([`{"exit":0}\n\n\n`]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { exit: 0 });
});

test("streamLineDelimitedJson: invalid JSON throws", async () => {
  const stream = makeStream([`not valid json\n`]);
  await assert.rejects(
    () => streamLineDelimitedJson(stream, () => undefined),
    (err) => err instanceof Error && /invalid JSON/i.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// streamingDaemonRequest contract — exercises the live HTTP path against a
// throwaway daemon. Lives in this file because the helper is small enough
// and the test doubles as documentation for the error-preservation contract
// from Plan 1 (daemon-provided hint + exit_code MUST survive non-200 paths).
// ---------------------------------------------------------------------------

import { ShuttleError } from "../shared/errors.js";
import { DaemonServer } from "../daemon/server.js";
import { writeSocketFile, removeSocketFile } from "../daemon/socket-file.js";
import { streamingDaemonRequest } from "./streaming-request.js";

async function withTestDaemon<T>(
  setup: (server: DaemonServer) => void,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = "test-token-streaming";
  const server = new DaemonServer({ token });
  setup(server);
  const { port } = await server.listen(0);
  await writeSocketFile({ port, token, pid: process.pid });
  try {
    return await fn(token);
  } finally {
    await removeSocketFile().catch(() => undefined);
    await server.close();
  }
}

test("streamingDaemonRequest: preserves daemon-provided hint and exit_code on non-200", async () => {
  await withTestDaemon(
    (server) => {
      server.addRouteStreaming("POST", "/v1/run/resolve", async (_req, _body, res) => {
        // Emit a structured-error payload with BOTH nested + flat fields,
        // plus a hint and a custom exit_code — the canonical Plan-1 shape.
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: false,
          error: { code: "secret_not_found", message: "ref missing" },
          error_code: "secret_not_found",
          message: "ref missing",
          hint: "secret-shuttle secrets list",
          exit_code: 3,
        }));
      });
    },
    async () => {
      const err = await streamingDaemonRequest("POST", "/v1/run/resolve", { refs: ["ss://x/dev/A"] })
        .then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ShuttleError);
      assert.equal(err.code, "secret_not_found");
      assert.equal(err.hint, "secret-shuttle secrets list", "hint MUST be preserved from the daemon");
      assert.equal(err.exitCode, 3, "exit_code MUST be preserved from the daemon");
    },
  );
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/client/streaming-request.ts`:

```typescript
import { readSocketFile } from "../daemon/socket-file.js";
import { ShuttleError } from "../shared/errors.js";
import { daemonErrorFromPayload } from "./daemon-client.js";

export type StreamLine =
  | { stream: "stdout"; data: string } // base64
  | { stream: "stderr"; data: string } // base64
  | { exit: number }
  | { error: { code: string; message: string; hint?: string | null; exit_code?: number } };

/**
 * Read a ReadableStream<Uint8Array> as a sequence of newline-terminated JSON
 * messages and invoke `onLine` for each one. Buffers across chunk boundaries.
 * Throws if any line is not valid JSON.
 */
export async function streamLineDelimitedJson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: StreamLine) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nlIdx = buffer.indexOf("\n");
        if (nlIdx === -1) break;
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.trim().length === 0) continue;
        let parsed: StreamLine;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`invalid JSON line from daemon stream: ${line.slice(0, 200)}`);
        }
        onLine(parsed);
      }
    }
    // Flush any trailing line (no terminating newline)
    if (buffer.trim().length > 0) {
      try {
        onLine(JSON.parse(buffer));
      } catch {
        throw new Error(`invalid JSON line from daemon stream: ${buffer.slice(0, 200)}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Open a streaming POST to the daemon. Throws daemon_not_running if no socket.
 * Returns the ReadableStream<Uint8Array> of the response body for the caller
 * to feed into streamLineDelimitedJson().
 */
export async function streamingDaemonRequest(
  method: "POST",
  path: string,
  body: unknown,
): Promise<ReadableStream<Uint8Array>> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running. Run `secret-shuttle daemon start`.");
  }
  const res = await fetch(`http://127.0.0.1:${sf.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${sf.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.body === null) {
    throw new ShuttleError("daemon_invalid_response", "Daemon returned no response body for streaming endpoint.");
  }
  if (!res.ok) {
    // Non-200 — reconstruct via the canonical Plan-1 helper so daemon-provided
    // `hint` and `exit_code` survive (which a manual `new ShuttleError(code, msg)`
    // would silently drop, regressing the contract from src/client/daemon-client.ts).
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ShuttleError("daemon_invalid_response", text);
    }
    throw daemonErrorFromPayload(parsed);
  }
  return res.body;
}
```

- [ ] **Step 4: Run — expect PASS** (5 tests including the hint/exit_code preservation case)

```bash
npm run build && node --test "dist/client/streaming-request.test.js"
```

- [ ] **Step 5: Commit**

```bash
git add src/client/streaming-request.ts src/client/streaming-request.test.ts
git commit -m "feat(client): streaming line-delimited-JSON request helper for run command

Reuses daemonErrorFromPayload (Plan 1) so daemon-provided hint and
exit_code survive non-200 reconstruction — manual reconstruction
would regress the Plan-1 contract."
```

---

### Task B4: Streaming masker

**Files:**
- Create: `src/daemon/run/masker.ts`
- Create: `src/daemon/run/masker.test.ts`

**Why this task exists:** spec §5.3 lines 257/262/265 require the daemon to mask resolved values in child stdout/stderr before relay. Without it, `node -e "console.log(process.env)"` would dump every resolved secret straight to the agent. This module is a pure byte-level streaming pattern matcher used by the spawner in B5.

**Behavior:**
- `createMasker(secrets: string[])` returns `{ process(chunk: Buffer): Buffer; flush(): Buffer }`.
- Replaces every occurrence of each secret (as raw UTF-8 bytes) with the ASCII literal `***`.
- Holds back the trailing `maxLen - 1` bytes between calls so a secret straddling a chunk boundary is still caught when the next chunk arrives. `maxLen` is the byte length of the longest secret.
- Empty secret list → pass-through (no-op).
- Empty-string secrets are filtered out (would otherwise match between every byte).
- Sorts secrets by length DESC before scanning so longer-first wins overlapping matches.
- Deduplicates secrets before scanning.

**Limitations** (documented as defense-in-depth):
- A child that base64-encodes a secret and prints the result bypasses the masker.
- A child that prints a secret with embedded NULs or other escapes bypasses the masker (we match the exact byte sequence stored in the vault).
- Overlapping secrets are masked greedy-longest-first; if two secrets actually overlap (rare) the second one may leak in fragments. Acceptable for v0.2.0.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/run/masker.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMasker } from "./masker.js";

test("createMasker: empty secrets list is pass-through", () => {
  const m = createMasker([]);
  assert.equal(m.process(Buffer.from("hello world")).toString("utf8"), "hello world");
  assert.equal(m.flush().toString("utf8"), "");
});

test("createMasker: replaces a complete match in a single chunk", () => {
  const m = createMasker(["sk_live_abc123"]);
  const out = Buffer.concat([
    m.process(Buffer.from("api: sk_live_abc123 done")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "api: *** done");
});

test("createMasker: replaces a match split across two chunks", () => {
  const m = createMasker(["sk_live_abc123"]);
  const a = m.process(Buffer.from("api: sk_live_"));
  const b = m.process(Buffer.from("abc123 done"));
  const c = m.flush();
  assert.equal(Buffer.concat([a, b, c]).toString("utf8"), "api: *** done");
});

test("createMasker: replaces a match split at every possible boundary", () => {
  const secret = "ABCDEFGH";
  const text = `prefix-${secret}-suffix`;
  for (let split = 0; split <= text.length; split++) {
    const m = createMasker([secret]);
    const a = m.process(Buffer.from(text.slice(0, split)));
    const b = m.process(Buffer.from(text.slice(split)));
    const c = m.flush();
    const out = Buffer.concat([a, b, c]).toString("utf8");
    assert.equal(out, "prefix-***-suffix", `split=${split} should have masked`);
  }
});

test("createMasker: multiple secrets — longer-first wins overlapping matches", () => {
  // "ABCDE" is a superset of "BCD"; longer should match.
  const m = createMasker(["BCD", "ABCDE"]);
  const out = Buffer.concat([
    m.process(Buffer.from("xxABCDExx")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "xx***xx");
});

test("createMasker: replaces multiple non-overlapping matches in one chunk", () => {
  const m = createMasker(["secret1", "secret2"]);
  const out = Buffer.concat([
    m.process(Buffer.from("one=secret1 two=secret2 done")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "one=*** two=*** done");
});

test("createMasker: secret only emitted via flush is still masked", () => {
  // Process a chunk that ends mid-secret; flush must mask the held-back portion.
  // (The held-back portion IS what's NOT been masked yet — but the chunk contained
  // the WHOLE secret, so it was already replaced by the time we hit flush.)
  const m = createMasker(["topsecret"]);
  const a = m.process(Buffer.from("XtopsecretY"));
  const b = m.flush();
  assert.equal(Buffer.concat([a, b]).toString("utf8"), "X***Y");
});

test("createMasker: empty-string secrets are filtered (no spam)", () => {
  const m = createMasker(["", "real"]);
  const out = Buffer.concat([
    m.process(Buffer.from("hello real world")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "hello *** world");
});

test("createMasker: deduplicates repeated secrets", () => {
  const m = createMasker(["dup", "dup", "dup"]);
  const out = Buffer.concat([
    m.process(Buffer.from("a-dup-b")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "a-***-b");
});

test("createMasker: pre-mask boundary lookback is bounded by maxLen-1", () => {
  // After a long no-match chunk, the held-back tail must be at most maxLen-1.
  const m = createMasker(["needle"]);
  const a = m.process(Buffer.from("haystack ".repeat(100)));
  // We can't directly observe the lookback, but after flush the total emitted
  // bytes plus flush bytes MUST equal the input length (no data lost).
  const b = m.flush();
  assert.equal((a.length + b.length), "haystack ".repeat(100).length);
});

test("createMasker: handles multi-byte UTF-8 secrets correctly", () => {
  // Real-world secrets can contain non-ASCII (emoji, Japanese in user-supplied
  // passphrases, etc.). Make sure byte-level matching doesn't confuse code-unit
  // boundaries with byte boundaries.
  const secret = "🔑-秘密-Pa$$"; // 4-byte emoji + 3-byte CJK chars + ASCII
  const m = createMasker([secret]);
  const out = Buffer.concat([
    m.process(Buffer.from(`prefix-${secret}-suffix`, "utf8")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "prefix-***-suffix");
});

test("createMasker: bytes that don't form valid UTF-8 secrets are stored as the vault returned them", () => {
  // The vault stores secret values as JS strings (UTF-16 internally, UTF-8 on
  // the wire). Plain-ASCII secrets are the normal case. This test pins the
  // round-trip for an ASCII-only secret with mixed punctuation/symbols.
  const secret = "sk_test_AbCdEf-0123_456.789~end";
  const m = createMasker([secret]);
  const out = Buffer.concat([
    m.process(Buffer.from(`Authorization: Bearer ${secret}\n`)),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "Authorization: Bearer ***\n");
});
```

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist)

```bash
npm run build && node --test "dist/daemon/run/masker.test.js"
```

- [ ] **Step 3: Implement**

Create `src/daemon/run/masker.ts`:

```typescript
const MASK = Buffer.from("***", "utf8");

export interface Masker {
  /**
   * Consume a chunk. Returns the bytes that are SAFE to emit (i.e. that
   * cannot retroactively become part of a longer match given a future
   * chunk). Holds back up to maxLen-1 trailing bytes internally.
   */
  process(chunk: Buffer): Buffer;

  /**
   * Flush any held-back bytes. Call exactly once at end-of-stream. After
   * flush the masker is unusable.
   */
  flush(): Buffer;
}

/**
 * Build a streaming byte-level masker that replaces every occurrence of any
 * `secrets` entry with `***`. Designed for `secret-shuttle run`'s child
 * stdout/stderr stream: see Task B5. Spec §5.3 defense-in-depth.
 *
 * Algorithm:
 *  1. Filter empty + dedupe + sort by length DESC. maxLen = first.length.
 *  2. On each process(chunk): combine lookback + chunk, then replace each
 *     secret in turn (longest first). Emit everything except the trailing
 *     maxLen-1 bytes (those become the next lookback).
 *  3. On flush(): emit the lookback and reset.
 *
 * Why "longest first": if "ABCDE" and "BCD" both match in "ABCDE", we want
 * the whole "ABCDE" gone, not just "BCD" (which would leave "A*** E" — a
 * partial leak).
 */
export function createMasker(secrets: readonly string[]): Masker {
  const deduped = [...new Set(secrets.filter((s) => s.length > 0))];
  // Encode each secret to its raw byte buffer once.
  const patterns: Buffer[] = deduped
    .map((s) => Buffer.from(s, "utf8"))
    .sort((a, b) => b.length - a.length);
  const maxLen = patterns.length > 0 ? patterns[0]!.length : 0;
  let lookback = Buffer.alloc(0);

  function replaceAll(buf: Buffer): Buffer {
    if (patterns.length === 0) return buf;
    let out = buf;
    for (const p of patterns) {
      // Loop until no more matches (handles repeated occurrences).
      while (true) {
        const idx = out.indexOf(p);
        if (idx === -1) break;
        out = Buffer.concat([out.subarray(0, idx), MASK, out.subarray(idx + p.length)]);
      }
    }
    return out;
  }

  return {
    process(chunk: Buffer): Buffer {
      if (maxLen === 0) return chunk;
      const combined = Buffer.concat([lookback, chunk]);
      const scanned = replaceAll(combined);
      // After replacement, hold back the trailing maxLen-1 bytes — they could
      // still be the prefix of a future match once the next chunk arrives.
      const safeEmitLen = Math.max(0, scanned.length - (maxLen - 1));
      const emit = scanned.subarray(0, safeEmitLen);
      lookback = scanned.subarray(safeEmitLen);
      return Buffer.from(emit); // copy out so callers can't mutate lookback
    },
    flush(): Buffer {
      const out = lookback;
      lookback = Buffer.alloc(0);
      // No more bytes are coming, so anything in lookback is final — but
      // since replaceAll already ran on the combined buffer, it's already
      // had any matches stripped. Emit verbatim.
      return Buffer.from(out);
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS** (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/run/masker.ts src/daemon/run/masker.test.ts
git commit -m "feat(daemon/run): streaming byte-level masker for run stdout/stderr

Lookback-buffered pattern matcher. Replaces resolved secret values
with *** in child output before relay. Spec §5.3 defense-in-depth.
Longer-first overlap resolution. Empty-string filtering. Bounded
lookback (maxLen-1 bytes)."
```

---

### Task B5: Daemon `POST /v1/run/resolve` route + spawner

**Files:**
- Create: `src/daemon/run/spawner.ts`
- Create: `src/daemon/run/spawner.test.ts`
- Create: `src/daemon/api/routes/run-resolve.ts`
- Create: `src/daemon/api/routes/run-resolve.test.ts`
- Modify: `src/daemon/api/router.ts` (or wherever routes register) — register `/v1/run/resolve`

**Spawner behavior:**
- Inputs: `cmd: string`, `args: string[]`, `cwd: string`, `env: NodeJS.ProcessEnv`, `outputWriter`, `signal: AbortSignal | undefined`.
- Spawns `cmd` with `args`, `shell: false`, `env`, `cwd`, and `stdio: ["ignore", "pipe", "pipe"]` (stdin is closed — see scope-reductions note above; pass-through arrives in Plan 4).
- Pipes child stdout/stderr to `outputWriter.writeStdout/writeStderr` as raw `Buffer` chunks; the route owns the masker that wraps the writer.
- On child exit, calls `outputWriter.writeExit(code)` exactly once.
- On spawn error (binary not found, permission denied), calls `outputWriter.writeError({ code: "spawn_failed", ... })` and `writeExit(127)`.
- If the supplied `signal` fires (HTTP response closed by the CLI), SIGTERMs the child; if still alive after 5 s, SIGKILLs. Resolves the promise after the child exits.

**Route behavior:**
- Reads body: `{ refs: string[], env: Array<{ key, value, isRef }>, command: string, args?: string[], cwd: string, approval_id?, wait_for_approval? }`.
- Authenticates via the parent `addRouteStreaming` registrar's Host + bearer check (no per-route auth duplication needed).
- Resolves refs via `services.vault.resolveRefs(refs)` (returns `Map<ref, SecretRecord>`).
- For each resolved record: `assertSecretActionAllowed(record, "use_as_stdin")`. Throws `action_not_allowed` if a secret has opted out.
- Builds approval binding with `action: "run"`. Lists every ref + the command in `template_params` for the UI. Production-gated.
- Builds the resolved-values list `Array.from(resolved.values()).map(r => r.value)` to feed into the masker.
- Builds the final env block: `{ ...buildChildEnv(), ...nonRefs, ...refValues }`.
- Validates `cwd` is an absolute path (CLI is required to send `process.cwd()` — see Task C1). If missing or non-absolute, the route rejects with `missing_param` BEFORE spawning. Never falls back to the daemon's `process.cwd()` and never silently uses `$HOME`.
- Switches into streaming mode (`content-type: application/x-ndjson`, `flushHeaders()`).
- Wraps the response writer in the masker so resolved values are stripped before bytes cross the HTTP boundary.
- Wires `res.on("close", () => abortController.abort())` so a CLI Ctrl-C or socket disconnect kills the child.
- On the child's exit, calls `markUsed(ref)` for every successfully resolved ref and writes one audit entry per ref `{ action: "run", ok: <child_exit === 0>, ref, environment }`. On any pre-spawn failure, writes per-ref audit with `ok: false` + `error_code`.
- Calls `res.end()` after `writeExit`.

- [ ] **Step 1: Write the spawner test FIRST**

Create `src/daemon/run/spawner.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnAndStream, type OutputWriter } from "./spawner.js";

class CollectingWriter implements OutputWriter {
  stdoutChunks: Buffer[] = [];
  stderrChunks: Buffer[] = [];
  exitCode: number | null = null;
  errors: Array<{ code: string; message: string }> = [];

  writeStdout(chunk: Buffer): void {
    this.stdoutChunks.push(chunk);
  }
  writeStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
  }
  writeExit(code: number): void {
    this.exitCode = code;
  }
  writeError(err: { code: string; message: string }): void {
    this.errors.push(err);
  }
  stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }
  stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }
}

test("spawnAndStream: captures stdout from `node -e \"console.log('hi')\"`", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.log('hi')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout(), "hi\n");
  assert.equal(w.errors.length, 0);
});

test("spawnAndStream: captures stderr separately", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.error('oops')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stderr(), "oops\n");
});

test("spawnAndStream: forwards non-zero exit codes", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.exit(42)"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 42);
});

test("spawnAndStream: missing binary writes spawn_failed error + exit 127", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: "/totally/nonexistent/binary",
    args: [],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 127);
  assert.equal(w.errors.length, 1);
  assert.equal(w.errors[0]!.code, "spawn_failed");
});

test("spawnAndStream: env vars are injected verbatim (shell:false; no expansion)", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.log(process.env.HELLO)"],
    env: { HELLO: "world", PATH: process.env.PATH ?? "" },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout().trim(), "world");
});

test("spawnAndStream: cwd is honored — child observes the supplied cwd", async () => {
  const w = new CollectingWriter();
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "spawner-cwd-"));
  try {
    await spawnAndStream({
      cmd: process.execPath,
      args: ["-e", "console.log(process.cwd())"],
      env: { ...process.env },
      cwd: tmpdir,
      outputWriter: w,
    });
    assert.equal(w.exitCode, 0);
    // macOS resolves /var → /private/var; compare via realpath.
    const { realpath } = await import("node:fs/promises");
    const expected = await realpath(tmpdir);
    const got = await realpath(w.stdout().trim());
    assert.equal(got, expected);
  } finally {
    await rm(tmpdir, { recursive: true, force: true });
  }
});

test("spawnAndStream: AbortSignal SIGTERMs a long-running child", async () => {
  const w = new CollectingWriter();
  const controller = new AbortController();
  // Schedule the abort almost immediately. The child sleeps 30s — without
  // cancellation the test would time out.
  setTimeout(() => controller.abort(), 50);
  const start = Date.now();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 30000); console.log('alive')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
    signal: controller.signal,
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10_000, `child should have been killed quickly; took ${elapsed}ms`);
  // Exit code: SIGTERM → 143 on POSIX (128 + 15). Windows may differ.
  assert.notEqual(w.exitCode, 0, "child should NOT exit cleanly when SIGTERMed");
});

test("spawnAndStream: stdin is closed (Plan 3 scope) — child sees EOF on read", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", `
      let bytes = 0;
      process.stdin.on('data', (d) => { bytes += d.length; });
      process.stdin.on('end', () => { console.log('eof', bytes); process.exit(0); });
    `],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout().trim(), "eof 0");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement spawner**

Create `src/daemon/run/spawner.ts`:

```typescript
import { spawn } from "node:child_process";

export interface OutputWriter {
  writeStdout(chunk: Buffer): void;
  writeStderr(chunk: Buffer): void;
  writeExit(code: number): void;
  writeError(err: { code: string; message: string }): void;
}

export interface SpawnInput {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * Absolute path. The route is responsible for validating this is absolute
   * and rejecting requests where the CLI didn't send one — spawnAndStream
   * does not silently fall back to the daemon's process.cwd().
   */
  cwd: string;
  outputWriter: OutputWriter;
  /**
   * Optional. If signaled, the child is SIGTERMed; if still alive after 5s,
   * SIGKILLed. Used by the route to kill the child when the HTTP response is
   * closed by the CLI (Ctrl-C, socket disconnect).
   */
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 5_000;

/**
 * Spawn a child process with shell:false + the supplied env, and stream
 * stdout/stderr/exit through the OutputWriter. Resolves once the child exits
 * AND all output has been forwarded.
 *
 * Spawn errors (binary not found, permission denied) are surfaced via
 * outputWriter.writeError + writeExit(127). This function does NOT throw.
 *
 * stdin: closed (Plan 3 scope). The child sees EOF on read. Plan 4 adds the
 * stdin-pass-through wiring (chunked-request-body multiplexing).
 *
 * Cancellation: if `signal` fires, SIGTERM is sent immediately; if the child
 * is still alive after KILL_GRACE_MS, SIGKILL.
 */
export function spawnAndStream(input: SpawnInput): Promise<void> {
  return new Promise<void>((resolve) => {
    let exited = false;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(input.cmd, input.args, {
        shell: false,
        env: input.env,
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      input.outputWriter.writeError({
        code: "spawn_failed",
        message: e instanceof Error ? e.message : String(e),
      });
      input.outputWriter.writeExit(127);
      resolve();
      return;
    }

    const c = child;

    // Cancellation wiring: SIGTERM on abort, SIGKILL after grace.
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (exited || c.killed) return;
      c.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) c.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    c.stdout?.on("data", (chunk: Buffer) => input.outputWriter.writeStdout(chunk));
    c.stderr?.on("data", (chunk: Buffer) => input.outputWriter.writeStderr(chunk));

    c.on("error", (err: Error) => {
      if (exited) return;
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      input.outputWriter.writeError({ code: "spawn_failed", message: err.message });
      input.outputWriter.writeExit(127);
      resolve();
    });
    c.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      // POSIX convention: signal → 128 + signum. Approximate for common signals.
      const exitCode = code !== null ? code : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1;
      input.outputWriter.writeExit(exitCode);
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run spawner tests — expect PASS** (8 tests)

- [ ] **Step 5: Write the route test**

Create `src/daemon/api/routes/run-resolve.test.ts`. Follow the existing test-harness pattern from [src/daemon/api/routes/secrets-delete.test.ts](../../../src/daemon/api/routes/secrets-delete.test.ts) (Plan 2): use a real `DaemonServer` + ephemeral socket file + vault fixture. The streaming response is consumed via `streamingDaemonRequest` + `streamLineDelimitedJson` from Task B3.

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonServer } from "../../server.js";
import { writeSocketFile, deleteSocketFile } from "../../socket-file.js";
import { streamingDaemonRequest, streamLineDelimitedJson, type StreamLine } from "../../../client/streaming-request.js";
import { registerRunResolveRoute } from "./run-resolve.js";
import { ShuttleError } from "../../../shared/errors.js";

// (Reuse the same harness shape as secrets-delete.test.ts:
//   - in-memory vault stub with seedable secrets
//   - in-memory approval store
//   - lock that returns a key from `requireKey()`
// Don't re-author it here in the plan; copy the helpers from the existing
// test file and adapt the route-under-test wiring.)

test("POST /v1/run/resolve: streams stdout + exit for a simple development-classed run", async () => {
  // Seed: vault has ss://x/dev/HELLO with value "world".
  // Body: { refs: ["ss://x/dev/HELLO"], env: [{ key: "HELLO", value: "ss://x/dev/HELLO", isRef: true }],
  //         command: process.execPath, args: ["-e", "console.log(process.env.HELLO)"], cwd: process.cwd() }
  // Expect: stream contains { stream: "stdout", data: base64("***\n") } and { exit: 0 }.
  // (Note: masking is on by default. The raw value "world" must NOT appear anywhere in the stream.)
});

test("POST /v1/run/resolve: production refs require approval (no approval_id → approval_required)", async () => {
  // Seed: ss://x/prod/SECRET. wait_for_approval: false.
  // Expect: { error: { code: "approval_required" } } in stream and exit > 0.
});

test("POST /v1/run/resolve: non-ref env values pass through verbatim and are NOT masked", async () => {
  // env=[{ key: "PORT", value: "3000", isRef: false }]. Command echoes $PORT.
  // Expect: "3000" appears in the (decoded) stdout (verbatim — non-refs are user-supplied, not secrets).
});

test("POST /v1/run/resolve: missing ref → secret_not_found error response (pre-stream)", async () => {
  // refs=["ss://x/dev/missing"]. The error must surface BEFORE the spawner runs.
  // Expect: HTTP 400 (non-streaming) with structured error_code = "secret_not_found".
});

test("POST /v1/run/resolve: secret with use_as_stdin removed from allowed_actions → action_not_allowed", async () => {
  // Seed a secret whose allowed_actions excludes use_as_stdin.
  // Expect: HTTP 400 with error_code = "action_not_allowed" (pre-stream — fails closed
  // BEFORE the child process is spawned).
});

test("POST /v1/run/resolve: resolved value never appears in the stream (masking guarantee)", async () => {
  // Seed ss://x/dev/HELLO=THE_SECRET_VALUE_DO_NOT_LEAK.
  // Child: `node -e "console.log(process.env.HELLO + ' ' + process.env.HELLO)"`
  // Aggregate all stdout chunks; base64-decode; concat.
  // Assert the literal "THE_SECRET_VALUE_DO_NOT_LEAK" does NOT appear, but "***" does.
});

test("POST /v1/run/resolve: missing cwd or relative cwd is rejected before spawn", async () => {
  // Body has cwd: undefined OR cwd: "./relative".
  // Expect: HTTP 400 with error_code = "missing_param" (cwd is required and must be absolute).
});

test("POST /v1/run/resolve: markUsed is called on the resolved ref after a successful run", async () => {
  // Seed ss://x/dev/HELLO. Snapshot last_used_at before. Issue run. Assert last_used_at changed.
});

test("POST /v1/run/resolve: audit log gains a per-ref entry per run (success path)", async () => {
  // After a successful run with two refs, the audit log has TWO entries with action="run",
  // matching refs, and ok=true (since exit code 0).
});

test("POST /v1/run/resolve: CLI disconnect kills the child (no orphans)", async () => {
  // Start a long-running child (sleep 10s). After 100ms, abort the fetch.
  // Confirm the child process exits within ~6s (SIGTERM with 5s grace, then SIGKILL).
  // Verify via /proc or ps that the child PID is gone (POSIX). Skip on Windows.
});
```

The 1 MB body cap + Host + bearer auth are already covered by Task B0's `DaemonServer.addRouteStreaming` tests — no need to retest them here.

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Implement the route**

Create `src/daemon/api/routes/run-resolve.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { buildChildEnv } from "../../safe-env.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { spawnAndStream, type OutputWriter } from "../../run/spawner.js";
import { createMasker } from "../../run/masker.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optBool, optString, reqString } from "../validate.js";
import path from "node:path";

interface RunResolveBody {
  refs: string[];
  env: Array<{ key: string; value: string; isRef: boolean }>;
  command: string;
  args: string[];
  cwd: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

export function registerRunResolveRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRouteStreaming("POST", "/v1/run/resolve", async (req, raw, res) => {
    // Body parsing + Host + bearer-token + 1 MB cap are enforced by
    // DaemonServer.addRouteStreaming before this handler runs.

    services.lock.requireKey();

    // Validate body shape.
    let body: RunResolveBody;
    try {
      const o = asObject(raw);
      body = {
        refs: Array.isArray(o.refs)
          ? o.refs.filter((r): r is string => typeof r === "string")
          : [],
        env: Array.isArray(o.env)
          ? o.env.filter((e): e is { key: string; value: string; isRef: boolean } =>
              e !== null && typeof e === "object" && typeof (e as { key?: unknown }).key === "string")
          : [],
        command: reqString(o, "command"),
        args: Array.isArray(o.args)
          ? o.args.filter((a): a is string => typeof a === "string")
          : [],
        cwd: reqString(o, "cwd"),
        ...(optString(o, "approval_id") !== undefined ? { approval_id: optString(o, "approval_id")! } : {}),
        ...(optBool(o, "wait_for_approval") !== undefined ? { wait_for_approval: optBool(o, "wait_for_approval")! } : {}),
      };
    } catch (e) {
      // Validation throws before any side effect — safe to surface as pre-stream JSON.
      writeJsonError(res, 400, e);
      return;
    }

    if (!path.isAbsolute(body.cwd)) {
      writeJsonError(res, 400, new ShuttleError("missing_param", "cwd must be an absolute path."));
      return;
    }
    if (body.command.length === 0) {
      writeJsonError(res, 400, new ShuttleError("missing_param", "command is required."));
      return;
    }

    // Resolve every ref. Deleted refs throw secret_not_found here.
    let resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>;
    try {
      resolved = await services.vault.resolveRefs(body.refs);
    } catch (e) {
      // No audit yet — secret resolution failed; no ref-touch occurred.
      writeJsonError(res, 400, e);
      return;
    }

    // Enforce per-secret use_as_stdin action. Fails closed BEFORE the spawner runs.
    try {
      for (const record of resolved.values()) {
        assertSecretActionAllowed(record, "use_as_stdin");
      }
    } catch (e) {
      writeJsonError(res, 400, e);
      return;
    }

    // Determine production gating from canonical ref env (ss://source/env/name).
    const isProduction = Array.from(resolved.values()).some(
      (r) => r.environment === "production",
    );

    if (isProduction) {
      const binding: ApprovalBinding = {
        action: "run",
        ref: null,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        // Stash the ref list + command in template_params for UI display.
        template_params: {
          command: body.command,
          args: JSON.stringify(body.args),
          refs: body.refs.join(","),
        },
        allowed_domains: [],
      };
      try {
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          ...(body.approval_id !== undefined ? { approvalIdFromClient: body.approval_id } : {}),
          ...(body.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      } catch (e) {
        // Approval failed (denied, expired, required-but-no-wait). Audit per ref.
        await auditPerRef(body.refs, resolved, false, e instanceof ShuttleError ? e.code : "unexpected_error");
        writeJsonError(res, 400, e);
        return;
      }
    }

    // Build the child env: hardened-PATH baseline + non-refs + resolved refs.
    const env: NodeJS.ProcessEnv = { ...buildChildEnv() };
    for (const entry of body.env) {
      if (entry.isRef) {
        const record = resolved.get(entry.value);
        if (record === undefined) {
          // Should not happen — resolveRefs would have thrown — but guard anyway.
          await auditPerRef(body.refs, resolved, false, "secret_not_found");
          writeJsonError(res, 400, new ShuttleError("secret_not_found", `Ref ${entry.value} could not be resolved.`));
          return;
        }
        env[entry.key] = record.value;
      } else {
        env[entry.key] = entry.value;
      }
    }

    // Build the masker from the resolved values (NOT the refs — refs are public).
    const masker = createMasker(Array.from(resolved.values()).map((r) => r.value));

    // Switch into streaming response mode.
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("cache-control", "no-store");
    res.flushHeaders();

    const writer: OutputWriter = {
      writeStdout(chunk) {
        const masked = masker.process(chunk);
        if (masked.length > 0) {
          res.write(JSON.stringify({ stream: "stdout", data: masked.toString("base64") }) + "\n");
        }
      },
      writeStderr(chunk) {
        const masked = masker.process(chunk);
        if (masked.length > 0) {
          res.write(JSON.stringify({ stream: "stderr", data: masked.toString("base64") }) + "\n");
        }
      },
      writeExit(code) {
        // Flush any remaining masker bytes (may carry the tail of a partial match).
        const flush = masker.flush();
        if (flush.length > 0) {
          res.write(JSON.stringify({ stream: "stdout", data: flush.toString("base64") }) + "\n");
        }
        res.write(JSON.stringify({ exit: code }) + "\n");
        res.end();
      },
      writeError(err) {
        res.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + "\n");
      },
    };

    // CLI disconnect → abort → SIGTERM child (5s grace) → SIGKILL.
    const abortController = new AbortController();
    res.on("close", () => abortController.abort());

    let childExitCode = 0;
    await spawnAndStream({
      cmd: body.command,
      args: body.args,
      env,
      cwd: body.cwd,
      outputWriter: {
        ...writer,
        writeExit(code) {
          childExitCode = code;
          writer.writeExit(code);
        },
      },
      signal: abortController.signal,
    });

    // markUsed + audit AFTER the child exits. Success criterion: child exit == 0.
    const ok = childExitCode === 0;
    for (const ref of resolved.keys()) {
      await services.vault.markUsed(ref).catch(() => undefined);
    }
    await auditPerRef(body.refs, resolved, ok, ok ? undefined : "child_exit_nonzero");
  });

  async function auditPerRef(
    refs: readonly string[],
    resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>,
    ok: boolean,
    errorCode: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      const record = resolved.get(ref);
      await writeDaemonAudit({
        action: "run",
        ok,
        ref,
        ...(record !== undefined ? { environment: record.environment } : {}),
        ...(errorCode !== undefined ? { error_code: errorCode } : {}),
      });
    }
  }
}

/** Write a JSON error response before streaming has started. */
function writeJsonError(res: ServerResponse, status: number, err: unknown): void {
  if (res.headersSent) return; // Streaming already began — caller mis-ordered the error path.
  // Delegate to the shared error-to-JSON contract.
  // (Cannot import errorToJson here without a circular — re-create inline.)
  const e = err as { code?: string; message?: string; hint?: string | null; exitCode?: number };
  const code = typeof e.code === "string" ? e.code : "unknown";
  const message = typeof e.message === "string" ? e.message : "unknown error";
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    ok: false,
    error: { code, message },
    error_code: code,
    message,
    hint: e.hint ?? null,
    exit_code: e.exitCode ?? null,
  }));
}
```

**Note for the implementer:** the `writeJsonError` helper above duplicates `errorToJson` from `src/shared/errors.ts` to avoid an import cycle. If you find that the existing `errorToJson` is importable here without breaking the build, prefer it — single source of truth.

- [ ] **Step 8: Register the route**

In the route-registration site (`src/daemon/api/router.ts` or wherever `registerSecretsDelete`/etc. live), add:

```typescript
import { registerRunResolveRoute } from "./routes/run-resolve.js";
// ...
registerRunResolveRoute(server, services, daemonPortRef);
```

- [ ] **Step 9: Run route tests — expect PASS** (10 tests)

```bash
npm run build && node --test "dist/daemon/api/routes/run-resolve.test.js"
```

- [ ] **Step 10: Commit**

```bash
git add src/daemon/run/spawner.ts src/daemon/run/spawner.test.ts \
  src/daemon/api/routes/run-resolve.ts src/daemon/api/routes/run-resolve.test.ts \
  src/daemon/api/router.ts
git commit -m "feat(daemon): /v1/run/resolve route + spawner

- Auth-checked streaming via addRouteStreaming (no bypass of Host/bearer/1MB cap)
- assertSecretActionAllowed(record, 'use_as_stdin') per resolved ref
- Per-ref audit (run action) on success/failure; markUsed on success
- Child cwd taken from CLI body (process.cwd()), absolute-path validated
- AbortSignal wired to res.on('close') — SIGTERM/SIGKILL on CLI disconnect
- Stdout/stderr masked through createMasker (spec §5.3) before HTTP relay
- stdin closed (Plan 4 ships stdin pass-through)"
```

---

## Part C — `run` CLI command

### Task C1: `secret-shuttle run --env-file=<f> -- <cmd>`

**Files:**
- Create: `src/cli/commands/run.ts`
- Create: `src/cli/commands/run.test.ts`
- Modify: `src/cli/index.ts` — register `runCommand()`

**Behavior:**
- Reads the env file from disk. Errors with `env_file_not_found` if missing.
- Parses via `parseEnvFile` (Task A1). Errors propagate as `env_file_parse_error`.
- Builds the POST body: `refs` (array of `ss://...` values from ref entries), `env` (entries array), `command` (the first positional after `--`), `args` (remaining positionals), `cwd: process.cwd()` (so the child runs in the caller's project, not the daemon's cwd).
- Calls `streamingDaemonRequest` (Task B3) + `streamLineDelimitedJson` (Task B3) to read the response.
- For each line:
  - `{ stream: "stdout", data: <b64> }` → decode base64, write to `process.stdout`.
  - `{ stream: "stderr", data: <b64> }` → decode base64, write to `process.stderr`.
  - `{ exit: <code> }` → set `process.exitCode = code` and return.
  - `{ error: ... }` → reconstruct via `daemonErrorFromPayload({ error_code: <c>, message: <m>, hint, exit_code })` so daemon-supplied `hint`/`exit_code` survive — same contract as the non-streaming `daemonRequest` path.

**Cancellation:** trap `SIGINT` (Ctrl-C) and `SIGTERM` and `req.destroy()` the underlying fetch — that closes the HTTP socket, which fires `res.on("close")` on the daemon and SIGTERMs the child (see Task B5's spawner).

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/run.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./run.js";

test("runCommand structural shape: takes --env-file and trailing argv", () => {
  const cmd = runCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--env-file"), "should accept --env-file");
});

test("runCommand: --json no-op flag accepted for forward compat", () => {
  const cmd = runCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--json"));
});

test("runCommand: argument is variadic (trailing argv after --)", () => {
  const cmd = runCommand();
  const args = (cmd as unknown as { registeredArguments: Array<{ _name: string; variadic: boolean }> })
    .registeredArguments;
  assert.equal(args.length, 1);
  assert.equal(args[0]!.variadic, true);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/cli/commands/run.ts`:

```typescript
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { parseEnvFile } from "../run/env-file.js";
import { streamingDaemonRequest, streamLineDelimitedJson } from "../../client/streaming-request.js";
import { daemonErrorFromPayload } from "../../client/daemon-client.js";
import { ShuttleError } from "../../shared/errors.js";

export function runCommand(): Command {
  return new Command("run")
    .description("Run a command with secrets resolved into its env. The daemon spawns the child and masks resolved values in stdout/stderr before relaying.")
    .requiredOption("--env-file <path>", "Path to env file. Entries: KEY=VALUE; ss:// values are resolved by the daemon.")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Forward-compat no-op (this command always streams).", false)
    .argument("[command...]", "Command and args to run (after `--`).")
    .action(async (command: string[], options) => {
      if (command.length === 0) {
        throw new ShuttleError("missing_param", "Specify the command to run after `--`.");
      }
      let envFileContent: string;
      try {
        envFileContent = await readFile(options.envFile, "utf8");
      } catch {
        throw new ShuttleError("env_file_not_found", `env file not found: ${options.envFile}`);
      }
      const { entries } = parseEnvFile(envFileContent);
      const refs = entries.filter((e) => e.isRef).map((e) => e.value);
      const body = {
        refs,
        env: entries,
        command: command[0],
        args: command.slice(1),
        // Send the CLI's cwd so the child runs in the caller's project, not the daemon's.
        cwd: process.cwd(),
        ...(options.approvalId !== undefined ? { approval_id: options.approvalId } : {}),
        ...(options.wait === false ? { wait_for_approval: false } : {}),
      };

      const stream = await streamingDaemonRequest("POST", "/v1/run/resolve", body);
      let exitCode = 0;
      let streamError: ShuttleError | undefined;
      await streamLineDelimitedJson(stream, (line) => {
        if ("stream" in line) {
          const buf = Buffer.from(line.data, "base64");
          if (line.stream === "stdout") process.stdout.write(buf);
          else process.stderr.write(buf);
        } else if ("exit" in line) {
          exitCode = line.exit;
        } else if ("error" in line) {
          // Preserve daemon-provided hint + exit_code; reuse Plan 1's helper.
          // Synthesize the canonical payload shape so daemonErrorFromPayload
          // resolves both nested and flat fields consistently.
          streamError = daemonErrorFromPayload({
            error: { code: line.error.code, message: line.error.message },
            error_code: line.error.code,
            message: line.error.message,
            hint: line.error.hint ?? null,
            exit_code: line.error.exit_code,
          });
        }
      });
      if (streamError !== undefined) throw streamError;
      process.exitCode = exitCode;
    })
    .addHelpText("after", `
Examples:
  # .env file contains:
  #   STRIPE_KEY=ss://stripe/prod/STRIPE_KEY
  #   PORT=3000
  secret-shuttle run --env-file=.env -- npm start

  # With pre-issued approval for production refs:
  secret-shuttle run --env-file=.env --approval-id <id> -- vercel deploy

Notes:
  - Refs are resolved by the daemon, never the CLI. The child process gets
    them as plain env vars in its env block.
  - Non-ref entries (e.g. PORT=3000) pass through verbatim.
  - Resolved secret values are best-effort MASKED in the child's stdout/stderr
    before they reach this CLI. A hostile child can still exfiltrate via
    network; masking is defense-in-depth.
  - Production refs require approval. Use --no-wait to receive an
    approval_id immediately.
  - The child runs in the CURRENT working directory (this CLI's cwd).
  - Interactive stdin is NOT supported in v0.2.0; the child sees EOF on read.
    Plan 4 adds stdin pass-through.
`);
}
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

Add import + `program.addCommand(runCommand())` in the appropriate slot (under Process integration, alongside the secrets group).

- [ ] **Step 5: Run CLI tests — expect PASS** (3 tests)

- [ ] **Step 6: Smoke test (with a running daemon + unlocked vault)**

```bash
# This requires a real daemon. For CI / subagent runs, skip the live smoke
# and rely on the route tests above to cover behavior.
echo "PORT=3000" > /tmp/.env
node dist/cli/index.js run --env-file=/tmp/.env -- node -e "console.log(process.env.PORT)"
# Expected output: 3000
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/run.ts src/cli/commands/run.test.ts src/cli/index.ts
git commit -m "feat(cli): run --env-file -- <cmd> — subshell injection via daemon spawner"
```

---

## Part D — `inject` command

### Task D1: Template parser + daemon `POST /v1/inject/render` route

**Files:**
- Create: `src/daemon/inject/template.ts` (template parser/renderer)
- Create: `src/daemon/inject/template.test.ts`
- Create: `src/daemon/api/routes/inject-render.ts`
- Create: `src/daemon/api/routes/inject-render.test.ts`
- Modify: `src/daemon/api/router.ts` — register `/v1/inject/render`

**Template parser behavior:**
- Scan text for candidate `ss://...` substrings using a permissive character class, then validate each candidate with the canonical `parseSecretRef` from [src/shared/refs.ts](../../../src/shared/refs.ts) — this is the single source of truth for ref grammar (`source`, `environment`, `NAME_RE` = `[A-Za-z_][A-Za-z0-9_.-]*`). Candidates that fail validation are left as literal text — they don't get partially substituted.
- Return `{ refs: string[]; render(values: Map<string, string>): string }` — `refs` is the deduped, normalized list (via the same `parseSecretRef` so e.g. `ss://x/prod/...` and `ss://x/production/...` resolve to one entry).
- Render walks the same regex; for each candidate, attempts `parseSecretRef`. If it parses, substitute. If not, emit verbatim.

**Why a two-step (regex match + parseSecretRef validation) rather than one big regex:**
- The canonical NAME_RE allows `_.-` characters. A naive regex like `ss://[^/]+/[^/]+/[\w.-]+` would greedily consume trailing punctuation that's actually file syntax (e.g. `ss://x/dev/KEY.txt` where `.txt` is part of a filename). Validation lets us be greedy on capture and conservative on commit.
- It also means the template parser stays in lockstep with the env-file/vault parser — if NAME_RE changes once, the template parser inherits it for free.

**Route behavior:**
- Reads body: `{ template: string, output_path: string, approval_id?, wait_for_approval? }`.
- Special case: `output_path === "-"` → return the rendered content in the JSON response (`content` field). CLI documented as "bytes pass through CLI" mode.
- File mode: validate `output_path` is absolute (CLI is required to send `path.resolve(cli_cwd, user_arg)` — see Task D2). Reject relative.
- Daemon-side path safety:
  1. `realpath(dirname(output_path))` — resolve all symlinks in the parent directory.
  2. Check that the realpath'd parent is inside `realpath($HOME)`. Refuse otherwise with `inject_output_path_unsafe`.
  3. `lstat(output_path)` — if the leaf exists AND is a symlink, refuse with `inject_output_path_unsafe`. (Writing through a leaf symlink could redirect bytes outside $HOME.)
- Per-ref policy: `assertSecretActionAllowed(record, "use_as_stdin")` for every resolved record. Fails closed if any ref has opted out.
- Atomic write: open a unique sibling temp file (`<canonical>.<8-random-hex>.tmp`) with `O_CREAT | O_EXCL | O_WRONLY` and mode `0o600`. Write content. Close. `rename` to the final path. On any failure, unlink the temp file. Truncate-then-overwrite semantics is REJECTED — it would briefly leave the file empty and could race a reader; rename is atomic on POSIX.
- markUsed + per-ref audit on success (action `"inject_render"`). Per-ref audit on failure with `error_code`.
- Return `{ rendered: true, output_path: <canonical>, refs_count: <N> }` (no plaintext for file mode).

- [ ] **Step 1: Template parser test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplate } from "./template.js";

test("parseTemplate: finds all ss:// refs (deduped)", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY\nother: ss://stripe/prod/STRIPE_KEY\n";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://stripe/production/STRIPE_KEY"]); // canonicalized via parseSecretRef
});

test("parseTemplate: render substitutes refs with provided values", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY";
  const { render } = parseTemplate(t);
  // The MAP key is the CANONICAL ref (matches what was returned in .refs).
  const out = render(new Map([["ss://stripe/production/STRIPE_KEY", "sk_live_abc"]]));
  assert.equal(out, "key: sk_live_abc");
});

test("parseTemplate: render throws if a ref's value is missing", () => {
  const t = "key: ss://x/dev/MISSING";
  const { render } = parseTemplate(t);
  assert.throws(() => render(new Map()), /MISSING/);
});

test("parseTemplate: NAME_RE-valid mixed-case names parse correctly", () => {
  // The canonical NAME_RE allows [A-Za-z_][A-Za-z0-9_.-]*, so lowercase + dashes work.
  const t = "config: ss://x/dev/A_extra-thing.v2";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://x/development/A_extra-thing.v2"]);
});

test("parseTemplate: candidate followed by NAME_RE-invalid suffix → match ends at suffix boundary", () => {
  // Trailing '=' is NOT in NAME_RE; the match stops at A.
  const t = "key: ss://x/dev/A=somethingelse";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://x/development/A"]);
  // ... and the rendered text keeps the '=somethingelse' suffix verbatim:
  const { render } = parseTemplate(t);
  assert.equal(
    render(new Map([["ss://x/development/A", "RESOLVED"]])),
    "key: RESOLVED=somethingelse",
  );
});

test("parseTemplate: candidate that fails parseSecretRef → left as literal (no partial substitution)", () => {
  // ss://x/dev/ followed by nothing — invalid (empty NAME). The candidate fails
  // parseSecretRef and stays as literal text.
  const t = "broken: ss://x/dev/";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, []);
  const { render } = parseTemplate(t);
  assert.equal(render(new Map()), "broken: ss://x/dev/");
});

test("parseTemplate: 'ss://' with no trailing chars is not a match", () => {
  const t = "see: ss:// for refs";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, []);
});

test("parseTemplate: empty template has no refs", () => {
  const { refs } = parseTemplate("");
  assert.deepEqual(refs, []);
});

test("parseTemplate: multiple distinct refs preserved", () => {
  const t = "a: ss://src1/dev/A\nb: ss://src2/prod/B\n";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs.sort(), [
    "ss://src1/development/A",
    "ss://src2/production/B",
  ]);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement template parser**

Create `src/daemon/inject/template.ts`:

```typescript
import { parseSecretRef, type ParsedSecretRef } from "../../shared/refs.js";

/**
 * Permissive candidate scanner: matches `ss://` followed by greedy non-whitespace,
 * non-quote, non-control characters. Each candidate is then validated via the
 * canonical parseSecretRef — invalid candidates are left as literal text.
 *
 * We exclude `>=<"'` and friends from the candidate class so that something like
 *   <key>ss://x/dev/A</key>
 * doesn't gobble the closing tag. NAME_RE characters (letters, digits, _, ., -)
 * are the only ones that may end the candidate. Whitespace, quotes, brackets,
 * commas, semicolons, and `=` all terminate the candidate.
 */
const CANDIDATE_RE = /ss:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z_][A-Za-z0-9_.-]*/g;

export interface ParsedTemplate {
  refs: string[];
  render(values: Map<string, string>): string;
}

function tryParse(candidate: string): ParsedSecretRef | null {
  try {
    return parseSecretRef(candidate);
  } catch {
    return null;
  }
}

export function parseTemplate(template: string): ParsedTemplate {
  const found = new Set<string>();
  for (const m of template.matchAll(CANDIDATE_RE)) {
    const parsed = tryParse(m[0]);
    if (parsed !== null) found.add(parsed.ref);
  }
  const refs = [...found];

  const render = (values: Map<string, string>): string => {
    return template.replaceAll(CANDIDATE_RE, (match) => {
      const parsed = tryParse(match);
      if (parsed === null) return match; // invalid candidate — leave literal
      const v = values.get(parsed.ref);
      if (v === undefined) {
        throw new Error(`template: no value provided for ref ${parsed.ref}`);
      }
      return v;
    });
  };
  return { refs, render };
}
```

- [ ] **Step 4: Template tests pass** (9 tests)

- [ ] **Step 5: Route test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// ... existing harness imports (vault stub, approval store, etc.)
import { registerInjectRenderRoute } from "./inject-render.js";

test("POST /v1/inject/render: writes file at mode 0600 inside $HOME (atomic temp-file + rename)", async () => {
  // Vault: ss://x/dev/KEY=value. POST template="key: ss://x/dev/KEY"
  // output_path = path.join(os.homedir(), ".secret-shuttle-tests", "out.yml").
  // After: file exists, content === "key: value", mode === 0o600.
  // Sibling temp file does NOT exist (cleaned up after rename).
});

test("POST /v1/inject/render: refuses output_path outside $HOME → inject_output_path_unsafe", async () => {
  // output_path = "/tmp/x". Expect inject_output_path_unsafe (parent realpath outside HOME).
});

test("POST /v1/inject/render: refuses relative output_path → inject_output_path_unsafe", async () => {
  // output_path = "./out.yml". Daemon requires absolute path. Expect rejection
  // (CLI's job is to absolutize via path.resolve before POSTing).
});

test("POST /v1/inject/render: refuses leaf-symlink output_path → inject_output_path_unsafe", async () => {
  // Pre-create $HOME/symlink-target -> /tmp/evil. POST output_path = $HOME/symlink-target.
  // Daemon lstat's the leaf, detects the symlink, refuses. The /tmp/evil bytes are unchanged.
});

test("POST /v1/inject/render: refuses parent-with-symlink-outside-HOME via realpath", async () => {
  // Pre-create $HOME/escape -> /tmp/somewhere/. POST output_path = $HOME/escape/file.yml.
  // realpath($HOME/escape) = /tmp/somewhere; that's outside HOME → reject.
});

test("POST /v1/inject/render with output_path='-' returns rendered content in response body", async () => {
  // template="key: ss://x/dev/KEY", output_path="-".
  // Response: { ok: true, rendered: true, refs_count: 1, content: "key: value" }.
});

test("POST /v1/inject/render: production refs require approval", async () => {
  // template has ss://x/prod/KEY; wait_for_approval: false → approval_required.
});

test("POST /v1/inject/render: deleted ref → secret_not_found", async () => {
  // softDelete the ref; render referencing it. Expect secret_not_found.
});

test("POST /v1/inject/render: secret with use_as_stdin removed → action_not_allowed (no file written)", async () => {
  // Seed a secret whose allowed_actions excludes use_as_stdin. Expect action_not_allowed.
  // Verify the output path was NOT created.
});

test("POST /v1/inject/render: markUsed is called on each resolved ref", async () => {
  // Snapshot last_used_at; render; assert it advanced.
});

test("POST /v1/inject/render: audit log gains a per-ref entry per render", async () => {
  // After a 2-ref render, audit has 2 entries with action='inject_render'.
});

test("POST /v1/inject/render: existing output file is atomically overwritten (no partial-write race)", async () => {
  // Pre-create the output file with content "OLD". Render → content "NEW".
  // Verify there was no moment when the file was empty or partially-written
  // (atomic rename guarantees this; the test is mainly that the impl uses rename, not truncate).
});
```

- [ ] **Step 6: Implement the route**

Create `src/daemon/api/routes/inject-render.ts`:

```typescript
import { mkdir, lstat, realpath, rename, rm, writeFile, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { parseTemplate } from "../../inject/template.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optBool, optString, reqString } from "../validate.js";

export function registerInjectRenderRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/inject/render", async (_req, raw) => {
    services.lock.requireKey();

    const o = asObject(raw);
    const template = reqString(o, "template");
    const outputPath = reqString(o, "output_path");
    const approvalId = optString(o, "approval_id");
    const waitForApproval = optBool(o, "wait_for_approval");

    const parsed = parseTemplate(template);

    const resolved = await services.vault.resolveRefs(parsed.refs);
    // Enforce policy per ref BEFORE approval — fail closed without prompting.
    for (const record of resolved.values()) {
      assertSecretActionAllowed(record, "use_as_stdin");
    }

    const isProduction = Array.from(resolved.values()).some((r) => r.environment === "production");

    let auditOk = false;
    let auditErrorCode: string | undefined;
    try {
      if (isProduction) {
        const binding: ApprovalBinding = {
          action: "inject_render",
          ref: null,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: {
            output_path: outputPath,
            refs: parsed.refs.join(","),
          },
          allowed_domains: [],
        };
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
          ...(waitForApproval === false ? { waitMs: 0 } : {}),
        });
      }

      const valuesMap = new Map<string, string>();
      for (const [ref, record] of resolved) {
        valuesMap.set(ref, record.value);
      }
      const rendered = parsed.render(valuesMap);

      if (outputPath === "-") {
        // Stdout-passthrough mode — return content in response body.
        auditOk = true;
        for (const ref of resolved.keys()) {
          await services.vault.markUsed(ref).catch(() => undefined);
        }
        return { rendered: true, refs_count: parsed.refs.length, content: rendered };
      }

      // File mode: must be absolute. CLI sends path.resolve()'d value.
      if (!path.isAbsolute(outputPath)) {
        throw new ShuttleError("inject_output_path_unsafe", `output_path must be absolute: ${outputPath}`);
      }

      // realpath the parent directory and verify it's inside $HOME.
      const home = await realpath(os.homedir());
      const parentDir = path.dirname(outputPath);
      // Create the parent dir if needed (mode 0o700). Do this BEFORE realpath
      // so realpath can resolve a freshly-created parent.
      await mkdir(parentDir, { recursive: true, mode: 0o700 });
      const realParent = await realpath(parentDir);
      const rel = path.relative(home, realParent);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new ShuttleError(
          "inject_output_path_unsafe",
          `Refusing to write outside HOME (parent realpath ${realParent} not inside ${home})`,
        );
      }

      // Leaf symlink check: if the target already exists AND is a symlink, refuse.
      try {
        const st = await lstat(outputPath);
        if (st.isSymbolicLink()) {
          throw new ShuttleError(
            "inject_output_path_unsafe",
            `Refusing to write through a symlink: ${outputPath}`,
          );
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // ENOENT — file doesn't exist yet — fine, proceed.
      }

      // Atomic write: temp file with O_EXCL + 0600, then rename.
      const finalPath = path.join(realParent, path.basename(outputPath));
      const tempPath = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
      let fh: Awaited<ReturnType<typeof open>> | undefined;
      try {
        fh = await open(tempPath, "wx", 0o600);
        await fh.writeFile(rendered, "utf8");
        await fh.close();
        fh = undefined;
        await rename(tempPath, finalPath);
      } catch (e) {
        if (fh !== undefined) await fh.close().catch(() => undefined);
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new ShuttleError(
          "inject_output_write_failed",
          e instanceof Error ? e.message : String(e),
        );
      }

      auditOk = true;
      for (const ref of resolved.keys()) {
        await services.vault.markUsed(ref).catch(() => undefined);
      }
      return { rendered: true, output_path: finalPath, refs_count: parsed.refs.length };
    } catch (e) {
      auditErrorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      throw e;
    } finally {
      // Per-ref audit (success or failure).
      for (const ref of parsed.refs) {
        const record = resolved.get(ref);
        await writeDaemonAudit({
          action: "inject_render",
          ok: auditOk,
          ref,
          ...(record !== undefined ? { environment: record.environment } : {}),
          ...(auditErrorCode !== undefined ? { error_code: auditErrorCode } : {}),
        });
      }
    }
  });
}
```

- [ ] **Step 7: Register route**

Same pattern as the other route registrations (regular `addRoute`, not streaming).

- [ ] **Step 8: Route tests pass** (12 tests)

- [ ] **Step 9: Commit**

```bash
git add src/daemon/inject/template.ts src/daemon/inject/template.test.ts \
  src/daemon/api/routes/inject-render.ts src/daemon/api/routes/inject-render.test.ts \
  src/daemon/api/router.ts
git commit -m "feat(daemon): /v1/inject/render route + template parser

- Template scans candidates with greedy regex; validates each via parseSecretRef
  (single source of truth for ref grammar — matches NAME_RE in shared/refs.ts)
- Per-ref assertSecretActionAllowed('use_as_stdin') enforced BEFORE approval
- Path safety: realpath parent inside \$HOME; leaf-symlink refusal; absolute-path required
- Atomic write: O_EXCL temp file at 0600, then rename (no truncate-then-overwrite)
- markUsed + per-ref audit (inject_render action)"
```

---

### Task D2: `secret-shuttle inject` CLI command

**Files:**
- Create: `src/cli/commands/inject.ts` (new top-level template-substitution command)
- Create: `src/cli/commands/inject.test.ts`

**The user-facing name does NOT collide.** Earlier drafts proposed renaming the V0 command from `internal inject` to `internal inject-v0`. **That user-facing rename is NOT done in Plan 3.** Commander dispatches by full command path — `secret-shuttle inject` and `secret-shuttle internal inject` are distinct entries in the dispatch tree. The V0 inject keeps its Plan 2 / spec §3.3 name at `internal inject`.

**Wait — there IS one source-level rename to do, because two files share the export name `injectCommand`.** The V0 file already lives at `src/cli/commands/inject.ts` and exports `injectCommand`. We need a NEW `src/cli/commands/inject.ts` that exports a different `injectCommand`. The fix is a file-level rename ONLY (CLI surface unchanged):

- Rename `src/cli/commands/inject.ts` → `src/cli/commands/inject-internal.ts`. Inside, keep `injectCommand` as the export AND keep `new Command("inject")` as the Commander name — `internal inject` stays as a user-facing command.
- Update `src/cli/commands/internal.ts` to `import { injectCommand } from "./inject-internal.js"` (path change only — no rename of the symbol, no rename of the Commander command).
- Create the brand-new `src/cli/commands/inject.ts` for template substitution.

**The user-facing surface is unchanged** — `internal inject` still works. Only the source layout shifts so two files don't both want `inject.ts`.

- [ ] **Step 1: Move the V0 inject source file out of the way**

```bash
git mv src/cli/commands/inject.ts src/cli/commands/inject-internal.ts
```

Inside `src/cli/commands/inject-internal.ts`: leave the function name `injectCommand` and the Commander name `new Command("inject")` unchanged.

Edit `src/cli/commands/internal.ts`:
- Change `import { injectCommand } from "./inject.js"` to `import { injectCommand } from "./inject-internal.js"`.
- Leave the registration `cmd.addCommand(injectCommand())` unchanged.

Run `npm run typecheck` — must pass. Run `npm test` — must pass. The user surface is identical: `secret-shuttle internal inject` still resolves to the V0 CDP-inject command.

- [ ] **Step 2: Failing test for the new top-level `inject`**

Create `src/cli/commands/inject.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectCommand } from "./inject.js";

test("injectCommand: takes -i (template input) and -o (output) options", () => {
  const cmd = injectCommand();
  const optionNames = cmd.options.map((o) => o.short).filter(Boolean);
  assert.ok(optionNames.includes("-i"), "should accept -i for template input");
  assert.ok(optionNames.includes("-o"), "should accept -o for output path");
});

test("injectCommand: description mentions template substitution", () => {
  const cmd = injectCommand();
  assert.match(cmd.description(), /template/i);
});

test("injectCommand: --json no-op accepted", () => {
  const cmd = injectCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--json"));
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement the new `inject` command**

Create `src/cli/commands/inject.ts`:

```typescript
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";

export function injectCommand(): Command {
  return new Command("inject")
    .description("Render a template with ss:// refs resolved; daemon writes the file at mode 0600 inside $HOME.")
    .requiredOption("-i, --input <path>", "Template file containing ss:// refs.")
    .requiredOption("-o, --output <path>", "Output file path (must resolve inside $HOME), or '-' for stdout.")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .option("--json", "Forward-compat no-op (always emits JSON).", false)
    .action(async (options) => {
      let template: string;
      try {
        template = await readFile(options.input, "utf8");
      } catch {
        throw new ShuttleError("inject_template_parse_error", `Cannot read template: ${options.input}`);
      }

      // Absolutize the output path against the CLI's cwd BEFORE sending it.
      // The daemon then realpaths the parent and refuses anything outside $HOME.
      // Without absolutizing here, the daemon would resolve relative paths
      // against ITS cwd, which is almost never what the user means.
      const outputArg: string = options.output;
      const outputPathForDaemon =
        outputArg === "-" ? "-" : path.resolve(process.cwd(), outputArg);

      const body: Record<string, unknown> = {
        template,
        output_path: outputPathForDaemon,
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/inject/render", body);
      const result = r as { rendered: boolean; refs_count: number; output_path?: string; content?: string };
      if (outputPathForDaemon === "-" && typeof result.content === "string") {
        // Documented "bytes pass through CLI" mode. Print content to stdout
        // and a JSON summary on stderr (so callers piping stdout still get
        // the summary).
        process.stdout.write(result.content);
        process.stderr.write(JSON.stringify(ok({ rendered: true, refs_count: result.refs_count, output_path: "-" }), null, 2) + "\n");
        return;
      }
      outputJson(ok({ rendered: result.rendered, refs_count: result.refs_count, output_path: result.output_path }));
    })
    .addHelpText("after", `
Examples:
  # Render config.yml.tpl into config.yml (mode 0600, daemon-written):
  secret-shuttle inject -i config.yml.tpl -o config.yml

  # Print rendered content to stdout (warning: bytes pass through this CLI):
  secret-shuttle inject -i config.yml.tpl -o -

Template format:
  Any text file containing 'ss://source/env/NAME' refs. The daemon validates
  every candidate via the canonical ref parser (the same one used by the
  vault), so partial matches and trailing punctuation are left as literal text.

Output path security:
  - The CLI absolutizes -o against its cwd before sending.
  - The daemon refuses any output_path whose parent realpath is outside \$HOME.
  - The daemon refuses to write through a leaf symlink.
  - The file is written via an O_EXCL temp file at mode 0600, then renamed.
    No moment when the file is empty or partially-written.
  - Use '-' for stdout if you need to pipe to another process — note the
    rendered bytes pass through this CLI in that mode.
`);
}
```

- [ ] **Step 5: Register in `src/cli/index.ts`**

Add `import { injectCommand } from "./commands/inject.js"` (this points at the NEW inject.ts; `internal.ts` imports its V0 version from `./inject-internal.js` per Step 1).

Add `program.addCommand(injectCommand())` alongside the secrets group.

- [ ] **Step 6: Run tests — expect PASS**

```bash
npm run build && node --test "dist/cli/commands/inject.test.js"
```

- [ ] **Step 7: Smoke test**

```bash
echo "key: ss://x/dev/HELLO" > /tmp/tmpl.yml
node dist/cli/index.js inject -i /tmp/tmpl.yml -o -
# Expect rendered content to stdout (if vault has the ref) OR a structured
# error if not. The point is to verify the CLI path works.
```

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/inject.ts src/cli/commands/inject.test.ts src/cli/commands/inject-internal.ts \
  src/cli/commands/internal.ts src/cli/index.ts
git commit -m "feat(cli): inject -i <tpl> -o <out> — template substitution via daemon

V0 CDP-inject command stays at the same user-facing path (\`internal inject\`)
— only the source file is renamed to inject-internal.ts to make room for
the new top-level inject.ts. CLI surface is unchanged for V0 users.

The new top-level \`inject\` substitutes ss:// refs in a template file
and writes the rendered output at mode 0600 via atomic temp-file+rename
(or to stdout for piping). The CLI absolutizes -o against process.cwd()
before sending so the daemon's HOME check is meaningful."
```

---

## Part E — Verification + CHANGELOG

### Task E1: Full suite verification

- [ ] **Step 1:** `npm test` — all pass (expect 605 baseline + ~55-65 new tests across A1, B0-B5, C1, D1-D2 = ~660-670 total).
- [ ] **Step 2:** `npm run typecheck` — pass.
- [ ] **Step 3:** `npm run check-pack` — pass.
- [ ] **Step 4: Smoke tests**

```bash
# Curated help should now list `run` and `inject` under Process integration.
node dist/cli/index.js help | grep -E "run|inject"

# Help for each new command shows examples.
node dist/cli/index.js run --help | tail -20
node dist/cli/index.js inject --help | tail -20

# Internal STILL has the V0 inject at the same name as Plan 2 — no user-facing rename.
node dist/cli/index.js internal --help | grep -E "compare|blind|capture|inject\b"
```

- [ ] **Step 5: Masking guarantee smoke test (manual)**

If a daemon is running and unlocked:

```bash
# Seed a fake "secret" you'll watch for in the output.
node dist/cli/index.js secrets set --source localtest --env dev --name CANARY --value "BLEEDING-CANARY-12345"

# Run a child that prints it. The literal "BLEEDING-CANARY-12345" must NOT appear.
cat <<EOF > /tmp/canary.env
CANARY=ss://localtest/dev/CANARY
EOF
node dist/cli/index.js run --env-file=/tmp/canary.env -- node -e 'console.log("got=" + process.env.CANARY)'
# Expected stdout: "got=***"
# Failing output (regression): "got=BLEEDING-CANARY-12345"

# Cleanup.
node dist/cli/index.js secrets delete --ref ss://localtest/dev/CANARY
rm /tmp/canary.env
```

If the literal value appears, masking is broken. Stop and fix before completing E2.

- [ ] **Step 6:** No commit for E1 (verification only).

### Task E2: CHANGELOG + curated help update

**Files:**
- Modify: `src/cli/commands/help.ts` — add `run` and `inject` to the curated index.
- Modify: `CHANGELOG.md` — append Plan 3 entries.

- [ ] **Step 1: Update `renderTopLevelHelp` in `src/cli/commands/help.ts`**

Add two lines under "Process integration:":

```
Process integration:
  run --env-file=<f> -- <cmd>   Run a command with secrets injected as env vars
  inject -i <tpl> -o <out>      Render a template with ss:// refs into a file
  template list / template run <id>            Vetted CLI integrations
  browser mark / reveal-capture / inject-submit   Browser-mediated flows
```

(Adjust the existing template/browser lines if needed to keep total ≤30 lines.)

Update `help.test.ts` to assert `\brun\b` and `\binject\b` appear in the curated output.

- [ ] **Step 2: Append Plan 3 entry to CHANGELOG**

Under the existing `## Unreleased`:

```markdown
### Added — Plan 3 (run + inject)
- `secret-shuttle run --env-file=<f> -- <cmd>` — subshell injection. The CLI parses a strict dotenv-like file (KEY=VALUE; ss:// refs only at full-value position; no shell expansion), POSTs refs + command + argv + `cwd: process.cwd()` to the daemon, and the daemon spawns the child with the resolved env block in the CLI's working directory. Stdout/stderr are streamed back via line-delimited JSON over chunked HTTP and **masked** through a lookback-buffered byte matcher — resolved secret values are replaced with `***` before bytes cross the HTTP boundary. The child's exit code is the CLI's exit code. The CLI process never holds plaintext. A CLI Ctrl-C or disconnect SIGTERMs the child (SIGKILL after 5 s grace).
- `secret-shuttle inject -i <tpl> -o <out>` — template substitution. CLI absolutizes `-o` against its cwd and ships the template bytes to `POST /v1/inject/render`. The daemon scans candidate `ss://` refs with a greedy character class, validates each via the canonical `parseSecretRef`, resolves, and writes via an atomic O_EXCL temp file + rename at mode 0600. Output-path safety: realpath of parent must be inside `$HOME`; leaf symlinks refused; relative paths refused. Use `-o -` for stdout-passthrough (documented as "bytes pass through CLI").
- `Vault.resolveRefs(refs[])` — batch deleted-aware ref→`SecretRecord` lookup. Used by both new daemon endpoints; honors the Plan 2 soft-delete invariant (deleted refs throw `secret_not_found`). Returns full records so callers can enforce `assertSecretActionAllowed` and call `markUsed` inline.
- Both new endpoints enforce per-secret `assertSecretActionAllowed(record, "use_as_stdin")` BEFORE any side effect; refs with that action explicitly removed fail closed with `action_not_allowed`. Each resolved ref gets `markUsed` on success and a per-ref audit entry (`{ action: "run" | "inject_render", ok, ref, environment, error_code? }`).
- New approval actions: `run`, `inject_render`. Added to the binding union + UI copy + audit action enum. Production refs in either flow require approval.
- `DaemonServer.addRouteStreaming(method, path, handler)` — auth-checked chunked-response primitive. Identical Host + bearer + 1 MB body cap as `addRoute`; the handler controls the response body. `addRouteRaw` (used by the approval UI's per-URL-token routes) stays unchanged.
- `daemonErrorFromPayload` is now reused by the streaming client (`streamingDaemonRequest` + run-CLI stream-error consumer) so daemon-provided `hint` and `exit_code` survive both pre-stream HTTP errors and in-stream `{ error: ... }` lines.

### Security
- `secret-shuttle run` masks resolved values in child stdout/stderr (spec §5.3). The masker is byte-level, lookback-buffered (`maxLen - 1` bytes), longer-first on overlapping matches. **This is defense-in-depth, not a security guarantee** — a hostile child can still exfiltrate via network or by encoding the secret (base64, hex). Documented in `secret-shuttle run --help`.
- `secret-shuttle inject` writes via `O_CREAT | O_EXCL | O_WRONLY` to a unique temp sibling then renames. The file is never empty or partially written at the final path. Leaf-symlink refusal + parent-realpath inside `$HOME` prevent redirected writes.

### Known limitations
- `run` does NOT pass stdin through to the child in v0.2.0 — the child sees EOF on read (`stdio: ["ignore", "pipe", "pipe"]`). Spec §5.3 calls for stdin inheritance; Plan 4 ships the bidirectional chunked-HTTP-body wiring needed to make this work. The majority of `run` use cases (`npm start`, `vercel deploy`, `npx <tool>`) don't read interactive stdin.
- `run` children inherit a hardened-PATH baseline (from `buildChildEnv`), not the user's shell PATH. Users who need a custom PATH can put it in the env file: `PATH=/custom/path/here`. Variable expansion (`$PATH`) is not supported.
- Masking can leak if a child encodes the secret (base64, percent-encoding, etc.) before printing. This is by design — masking is the last line of defense, not the only one.
```

- [ ] **Step 3: Run the help test to confirm the curated output still passes after the edit**

```bash
npm run build && node --test "dist/cli/commands/help.test.js"
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/help.ts src/cli/commands/help.test.ts CHANGELOG.md
git commit -m "docs(changelog): Plan 3 — run + inject commands + curated help update"
```

---

## Self-Review

**1. Spec coverage**

| Spec §11 deliverable | Task |
|---|---|
| `secret-shuttle run --env-file=<f> -- <cmd>` | A1 (parser) + B1 (Vault) + B2 (approval/audit/registry) + B3 (streaming client) + B4 (masker) + B5 (daemon route + spawner) + C1 (CLI) |
| `secret-shuttle inject -i <tpl> -o <out>` | D1 (template parser + daemon route) + D2 (CLI) |
| `POST /v1/run/resolve` + spawner | B5 |
| `POST /v1/inject/render` | D1 |
| Masking of resolved values in `run` stdout/stderr (spec §5.3) | B4 (masker module) + B5 (wired into the route's OutputWriter) |
| Per-secret `use_as_stdin` action enforcement (`assertSecretActionAllowed`) | B5 (run) + D1 (inject) |
| `markUsed` on success | B5 + D1 |
| Per-ref audit (`run` / `inject_render` actions) | B5 + D1 |
| CLI cwd flows into the child (`cwd: process.cwd()`) | C1 (sends) + B5 (validates absolute + spawns with it) |
| Child cancellation on CLI disconnect (SIGTERM → 5s → SIGKILL) | B5 (spawner accepts `AbortSignal`; route wires `res.on("close")`) |
| Approval binding extensions (`run`, `inject_render`) | B2 |
| Approval UI copy | B2 |
| Audit action types | B2 |
| Error-codes registry seeds (incl. `spawn_failed`) | B2 |
| Streaming-route auth-checked primitive (Host + bearer + 1 MB body cap) | B0 |
| `daemonErrorFromPayload` reuse in streaming paths (preserves hint + exit_code) | B3 + C1 |
| Inject path safety (realpath parent inside $HOME; leaf-symlink refusal; atomic O_EXCL temp + rename) | D1 |
| Curated help lists `run` + `inject` | E2 |
| CHANGELOG | E2 |
| **Spec deviation: child stdin pass-through** | DEFERRED to Plan 4. Documented in "Scope reductions" + CHANGELOG "Known limitations". Spec §5.3 line 257 is preserved as the long-term contract; v0.2.0 ships `stdio: ignore` on stdin and the child sees EOF on read. |

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "Similar to Task N", or "add appropriate X". Every code block is complete. Every command shows expected output. Test code snippets are runnable as-is. The earlier "// ... reproduce the bearer check" placeholder is gone — auth is handled by `addRouteStreaming` (Task B0) which the route declares as its registrar type.

**3. Type consistency**

- `EnvFileEntry` defined in A1; consumed in C1 and B5. Same shape across.
- `OutputWriter` defined in B5 (spawner); used in B5 (route) — both writes go through the route's masker-wrapped writer.
- `Masker` defined in B4; consumed in B5 (route).
- `StreamLine` union defined in B3; consumed in C1.
- `ApprovalBinding.action` adds `"run"` and `"inject_render"` in B2; both literals used in B5 and D1.
- `Vault.resolveRefs` defined in B1; returns `Map<string, SecretRecord>` consistently (not bare `Map<string, string>`) so callers can do policy + markUsed inline.
- `parseTemplate` defined in D1; returns `{ refs: string[]; render(values: Map<string, string>): string }` consistently used in D1's route.
- `SecretAction` is **not extended** — both flows use the existing `"use_as_stdin"` action so existing secrets allow them by default.

**4. Scope**

Plan 3 is one coherent process-integration unit. Two new commands sharing a common Vault helper, masker, approval-action pattern, and audit pattern. 11 tasks (A1, B0-B5, C1, D1-D2, E1-E2). Estimated execution time: ~7-9 hours for a fresh subagent doing one task at a time with TDD + verification. Includes a meaningful new server primitive (`addRouteStreaming`), a new client capability (streaming HTTP with error preservation), a new daemon masker module, a new daemon spawner module with cancellation semantics, an atomic-write path-safety harness for inject, and end-to-end approval + policy + markUsed + audit + UI integration.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan3-run-and-inject.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality), review between tasks. Same pattern as Plans 1 and 2.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
