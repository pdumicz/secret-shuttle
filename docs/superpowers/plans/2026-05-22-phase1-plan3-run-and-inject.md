# Phase 1 — Plan 3: `run` + `inject` commands

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two category-standard process-integration verbs Secret Shuttle is missing — `secret-shuttle run --env-file=<f> -- <cmd>` (subshell injection: secrets reach the child via env vars; daemon spawns the child so plaintext never enters the CLI process) and `secret-shuttle inject -i <template> -o <out>` (template substitution: daemon writes the rendered file at mode 0600).

**Architecture:** Two new daemon endpoints, mirroring the daemon-mediated execution pattern that templates use today. `POST /v1/run/resolve` takes the env-file refs + the command + argv, resolves refs against `Vault.getSecret` (which honors the soft-delete invariant from Plan 2), spawns the child with `shell: false` + a sanitized env block + resolved vars, then streams stdout/stderr back to the CLI as line-delimited JSON over chunked HTTP. `POST /v1/inject/render` takes the template content + output path, resolves embedded `ss://` refs, and writes the rendered file daemon-side with mode 0600. Both endpoints production-gate via the existing `requireApproval` + new `run` / `inject_render` actions in `ApprovalBinding`. The env-file parser is CLI-side (matches `op run` ergonomics) but the template parser is daemon-side (CLI just ships the bytes — keeps secrets out of CLI memory entirely).

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

These are spec items Plan 3 deliberately defers, with rationale:

- **stdout/stderr masking in `run`.** Spec §5.3 calls for "best-effort string replacement of resolved values in child stdout/stderr before relay" but explicitly labels it "defense-in-depth, not a security guarantee — child can always exfiltrate via network." Implementing it correctly (handling values split across chunk boundaries; multi-byte UTF-8; binary streams) is non-trivial. **Plan 3 ships unmasked streaming**; masking lands in Plan 4 alongside the single-window tab-reuse work as a coherent output-pathway hardening pass. CHANGELOG documents the trade-off.
- **Arbitrary binary validation.** `run --` accepts whatever command the user passes (matches `op run` / `doppler run` / `infisical run` ergonomics). The daemon spawns with `shell: false` + scrubbed env, but doesn't validate the binary path, sha256, or that it's an allowlisted vendor CLI — that's the template runner's job (`template run`), not `run`'s. The agent that calls `run` is already trusted with the daemon's full API.
- **PATH inheritance for `run` children.** `buildChildEnv()` returns a hardened-PATH baseline (no user-customized PATH). The user's `npm`, `vercel`, `node`, etc. must be discoverable on the daemon's hardened PATH — which they are, since daemon-spawned templates rely on the same. Users who need a custom PATH can put it in the env file as `PATH=/custom/path:$PATH` (with the caveat that `$PATH` expansion doesn't happen; they need the literal string).

---

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/cli/run/env-file.ts` | Pure parser: strict dotenv-like `KEY=VALUE` reader. Returns `{ key, value, isRef }[]` |
| `src/cli/run/env-file.test.ts` | Parser unit tests |
| `src/client/streaming-request.ts` | Thin streaming-aware client helper: line-delimited JSON over chunked HTTP |
| `src/client/streaming-request.test.ts` | Streaming client tests (mocks the daemon response stream) |
| `src/daemon/run/spawner.ts` | Spawns child process with resolved env; streams stdout/stderr/exit to a writable HTTP response |
| `src/daemon/run/spawner.test.ts` | Spawner unit tests (uses a small echo binary fixture) |
| `src/daemon/api/routes/run-resolve.ts` | `POST /v1/run/resolve` route — resolves refs, requires approval, invokes spawner |
| `src/daemon/api/routes/run-resolve.test.ts` | Route integration tests |
| `src/daemon/api/routes/inject-render.ts` | `POST /v1/inject/render` route — parses template, resolves refs, writes file (or returns content for stdout mode) |
| `src/daemon/api/routes/inject-render.test.ts` | Route integration tests |
| `src/daemon/inject/template.ts` | Pure template parser/renderer: scans for `ss://` refs in text, returns refs + offsets for substitution |
| `src/daemon/inject/template.test.ts` | Template parser tests |
| `src/cli/commands/run.ts` | `secret-shuttle run` CLI command |
| `src/cli/commands/run.test.ts` | CLI structure tests |
| `src/cli/commands/inject.ts` | `secret-shuttle inject` CLI command (replaces today's V0 `inject` deprecation shim — that's no longer at top level after Plan 2 anyway; the new `inject` is the template-substitution command) |
| `src/cli/commands/inject.test.ts` | CLI structure tests |

**Files to modify:**

| Path | Change |
|---|---|
| `src/vault/vault.ts` | Add `resolveRefs(refs: string[])` helper that calls `getSecret` for each ref and returns a `Map<ref, value>`. Used by both daemon routes for batch resolution + atomic approval. |
| `src/daemon/approvals/store.ts` | Extend `ApprovalBinding.action` union with `"run"` and `"inject_render"`. |
| `src/daemon/approvals/ui.html` | Add human-readable copy for the two new actions. |
| `src/daemon/audit.ts` | Extend `DaemonAuditAction` to include the two new actions. |
| `src/shared/error-codes.ts` | Add new registry entries: `env_file_parse_error` (USAGE), `env_file_not_found` (NOT_FOUND), `inject_template_parse_error` (USAGE), `inject_output_path_unsafe` (PERMISSION), `inject_output_write_failed` (PERMISSION). |
| `src/shared/error-codes.test.ts` | Bump registry count from 104 → 109 and assert the five new entries. |
| `src/daemon/api/router.ts` (or wherever routes are registered) | Register `/v1/run/resolve` and `/v1/inject/render` with `daemonPortRef`. |
| `src/cli/index.ts` | Register `runCommand()`. (The new `inject` command name collides with the old V0 `inject` that lives under `internal` after Plan 2 — see Decision 4 below.) |
| `src/cli/commands/internal.ts` | Rename the V0 `inject` import to `injectV0Command` (or move under a different internal subcommand name like `inject-v0`) so the new top-level `inject` doesn't collide. |
| `CHANGELOG.md` | Append Plan 3 entries. |

**Decision 4 — handling the `inject` name collision.** The old V0 `inject` command is currently registered as `internal inject` (after Plan 2). The new top-level `secret-shuttle inject` is for template substitution — different operation. Rather than rename either at the user-facing surface, Plan 3 renames the INTERNAL one to `internal inject-v0` (clear historical marker, won't shadow the new public `inject`). The factory function `injectCommand` in `src/cli/commands/inject.ts` is now the NEW behavior; the V0 version lives in a renamed file or accessor.

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

## Part B — Daemon spawner endpoint

### Task B1: `Vault.resolveRefs(refs)` helper

**Files:**
- Modify: `src/vault/vault.ts`
- Modify: `src/vault/vault.test.ts`

**Behavior:** Given an array of ref strings, return a `Map<string, string>` from ref → raw value. Uses `getSecret(ref)` (deleted-aware) so soft-deleted refs throw `secret_not_found`. Single-pass — fails fast on the first missing ref.

- [ ] **Step 1: Append failing tests to `src/vault/vault.test.ts`**

```typescript
test("Vault.resolveRefs returns map of ref→value for active secrets", async () => {
  const vault = await setUpTestVault({
    secrets: [makeSecret("ss://x/dev/A"), makeSecret("ss://x/dev/B")],
  });
  const refs = ["ss://x/dev/A", "ss://x/dev/B"];
  const result = await vault.resolveRefs(refs);
  assert.equal(result.size, 2);
  assert.ok(result.has("ss://x/dev/A"));
  assert.ok(result.has("ss://x/dev/B"));
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

- [ ] **Step 3: Implement** — append to `src/vault/vault.ts`:

```typescript
/**
 * Resolve a list of ss:// refs to a Map<ref, value>. Uses the deleted-aware
 * getSecret() so refs that have been soft-deleted throw secret_not_found.
 * Single-pass — fails fast on the first missing ref.
 */
async resolveRefs(refs: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const ref of refs) {
    if (result.has(ref)) continue; // dedupe
    const record = await this.getSecret(ref);
    result.set(ref, record.value);
  }
  return result;
}
```

- [ ] **Step 4: Run — expect PASS** (full vault.test.js + the 4 new)

- [ ] **Step 5: Commit**

```bash
git add src/vault/vault.ts src/vault/vault.test.ts
git commit -m "feat(vault): resolveRefs(refs[]) — batch deleted-aware ref→value lookup"
```

---

### Task B2: ApprovalBinding extension + UI copy + audit + registry codes

**Files:**
- Modify: `src/daemon/approvals/store.ts` — add `run` + `inject_render` to action union
- Modify: `src/daemon/approvals/ui.html` — UI copy for both
- Modify: `src/daemon/audit.ts` — extend audit action type
- Modify: `src/shared/error-codes.ts` — add 5 new registry entries
- Modify: `src/shared/error-codes.test.ts` — update count + assert new entries

- [ ] **Step 1: Extend `ApprovalBinding.action` union**

Open `src/daemon/approvals/store.ts`. Find the `ApprovalBinding` interface (around line 12). Update the action union:

```typescript
action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate" | "run" | "inject_render";
```

(Two new entries added at the end.)

Run `npm run typecheck` — must pass.

- [ ] **Step 2: Extend `DaemonAuditAction`**

Open `src/daemon/audit.ts`. Find the action type (around line 8 per Plan 2 A5). Add `"run"` and `"inject_render"` to it.

- [ ] **Step 3: Add UI copy for the two new actions**

Open `src/daemon/approvals/ui.html`. Find the action-to-human-copy mapping (search for `case "secrets_delete":` to find the place). Add:

```javascript
case "run":
  return "Resolve secret refs and inject them as env vars for the spawned command (refs visible in this approval; values stay in the daemon).";
case "inject_render":
  return "Resolve secret refs and write the rendered template file (refs visible in this approval; values are written to disk at mode 0600).";
```

(Adjust to match the file's exact style — read existing entries first.)

- [ ] **Step 4: Add 5 new registry entries**

Open `src/shared/error-codes.ts`. Find the appropriate sections and add:

In the Usage section:
```typescript
env_file_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
inject_template_parse_error: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

In the Not found section:
```typescript
env_file_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
```

In the Permission section:
```typescript
inject_output_path_unsafe: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
inject_output_write_failed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
```

- [ ] **Step 5: Update the registry count test**

Open `src/shared/error-codes.test.ts`. Find the "registry total entry count" test. Update from 104 → 109. Add spot-checks for two of the new codes:

```typescript
assert.ok(lookupErrorCode("env_file_parse_error"));
assert.ok(lookupErrorCode("inject_output_path_unsafe"));
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
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/client/streaming-request.ts`:

```typescript
import { readSocketFile } from "../daemon/socket-file.js";
import { ShuttleError } from "../shared/errors.js";

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
    // Non-200 — try to parse as a structured error.
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const errCode = typeof parsed?.error?.code === "string" ? parsed.error.code : "daemon_invalid_response";
      const errMessage = typeof parsed?.error?.message === "string" ? parsed.error.message : text;
      throw new ShuttleError(errCode, errMessage);
    } catch (e) {
      if (e instanceof ShuttleError) throw e;
      throw new ShuttleError("daemon_invalid_response", text);
    }
  }
  return res.body;
}
```

- [ ] **Step 4: Run — expect PASS** (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/client/streaming-request.ts src/client/streaming-request.test.ts
git commit -m "feat(client): streaming line-delimited-JSON request helper for run command"
```

---

### Task B4: Daemon `POST /v1/run/resolve` route + spawner

**Files:**
- Create: `src/daemon/run/spawner.ts`
- Create: `src/daemon/run/spawner.test.ts`
- Create: `src/daemon/api/routes/run-resolve.ts`
- Create: `src/daemon/api/routes/run-resolve.test.ts`
- Modify: `src/daemon/api/router.ts` (or wherever routes register) — register `/v1/run/resolve`
- Modify: `src/daemon/server.ts` — add a `Method = "POST"` raw-route registrar IF the existing `addRoute` API doesn't already support streaming responses

**Spawner behavior:**
- Inputs: `cmd: string`, `args: string[]`, `cwd: string | undefined`, `env: Record<string, string>`, `outputWriter: { writeStdout(chunk): void; writeStderr(chunk): void; writeExit(code): void; writeError(err): void }`.
- Spawns `cmd` with `args`, `shell: false`, `env`, `cwd` (defaults to daemon's cwd if undefined).
- Pipes child stdout/stderr to `outputWriter.writeStdout/writeStderr` (base64-encoded chunks).
- On child exit, calls `outputWriter.writeExit(code)` exactly once.
- On spawn error (binary not found, permission denied), calls `outputWriter.writeError({ code: "spawn_failed", ... })` and `writeExit(127)`.

**Route behavior:**
- Reads body: `{ refs: string[], env: Array<{ key, value, isRef }>, command: string, args?: string[], cwd?: string, approval_id?, wait_for_approval? }`.
- Resolves refs via `services.vault.resolveRefs(refs)`.
- Builds approval binding with `action: "run"`, refs in `allowed_domains: []` (run has no domain — list the refs in `template_params` for visibility instead).
- Calls `requireApproval` (production-gated; non-production auto-approves).
- Builds the final env object: `{ ...buildChildEnv(), ...resolvedNonRefs, ...resolvedRefs }`.
- Sets `res.statusCode = 200`, writes `content-type: application/x-ndjson` (newline-delimited JSON).
- Invokes spawner with an `outputWriter` that writes each line to `res.write(JSON.stringify(line) + "\n")`.
- On exit, `res.end()`.

**The streaming concern:** the existing daemon `addRoute` API likely wraps the handler's return value in a JSON envelope (`res.end(JSON.stringify({ ok: true, ...result }))`). For streaming, you need a "raw response" route registrar. Look at `src/daemon/server.ts:39` — the existing `addRouteRaw(method, pattern, handler)` already exists for routes that need full control of the HTTP response (used by the approval UI). Use it.

- [ ] **Step 1: Write the spawner test FIRST**

Create `src/daemon/run/spawner.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnAndStream, type OutputWriter } from "./spawner.js";

class CollectingWriter implements OutputWriter {
  stdoutChunks: string[] = [];
  stderrChunks: string[] = [];
  exitCode: number | null = null;
  errors: Array<{ code: string; message: string }> = [];

  writeStdout(chunk: Buffer): void {
    this.stdoutChunks.push(chunk.toString("utf8"));
  }
  writeStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk.toString("utf8"));
  }
  writeExit(code: number): void {
    this.exitCode = code;
  }
  writeError(err: { code: string; message: string }): void {
    this.errors.push(err);
  }
}

test("spawnAndStream: captures stdout from `node -e \"console.log('hi')\"`", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.log('hi')"],
    env: { ...process.env },
    cwd: undefined,
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdoutChunks.join(""), "hi\n");
  assert.equal(w.errors.length, 0);
});

test("spawnAndStream: captures stderr separately", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.error('oops')"],
    env: { ...process.env },
    cwd: undefined,
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stderrChunks.join(""), "oops\n");
});

test("spawnAndStream: forwards non-zero exit codes", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.exit(42)"],
    env: { ...process.env },
    cwd: undefined,
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
    cwd: undefined,
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
    env: { HELLO: "world" },
    cwd: undefined,
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdoutChunks.join("").trim(), "world");
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
  cwd: string | undefined;
  outputWriter: OutputWriter;
}

/**
 * Spawn a child process with shell:false + the supplied env, and stream
 * stdout/stderr/exit through the OutputWriter. Resolves once the child exits
 * AND all output has been forwarded.
 *
 * Spawn errors (binary not found, permission denied) are surfaced via
 * outputWriter.writeError + writeExit(127). This function does NOT throw.
 */
export function spawnAndStream(input: SpawnInput): Promise<void> {
  return new Promise<void>((resolve) => {
    let exited = false;
    let child;
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

    child.stdout.on("data", (chunk: Buffer) => input.outputWriter.writeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => input.outputWriter.writeStderr(chunk));
    child.on("error", (err: Error) => {
      if (exited) return;
      exited = true;
      input.outputWriter.writeError({ code: "spawn_failed", message: err.message });
      input.outputWriter.writeExit(127);
      resolve();
    });
    child.on("close", (code: number | null) => {
      if (exited) return;
      exited = true;
      input.outputWriter.writeExit(code ?? 0);
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run spawner tests — expect PASS** (5 tests)

- [ ] **Step 5: Write the route test**

Create `src/daemon/api/routes/run-resolve.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonServer } from "../../server.js";
import { writeSocketFile } from "../../socket-file.js";
import { streamLineDelimitedJson, type StreamLine } from "../../../client/streaming-request.js";
import { registerRunResolveRoute } from "./run-resolve.js";
// ... follow the existing harness pattern from secrets-delete.test.ts

test("POST /v1/run/resolve: streams stdout + exit for a simple command", async () => {
  // Set up an ephemeral daemon, vault with one ref ss://x/dev/HELLO=world,
  // register the run-resolve route, call it with refs=["ss://x/dev/HELLO"]
  // and command=node args=["-e", "console.log(process.env.HELLO)"].
  // Read the streaming response. Expect to see:
  //   { stream: "stdout", data: base64("world\n") }
  //   { exit: 0 }
});

test("POST /v1/run/resolve: production refs require approval", async () => {
  // Vault has ss://x/prod/SECRET. Call without --approval-id.
  // Expect a non-200 response OR a stream that contains { error: { code: "approval_required" } } and exit > 0.
});

test("POST /v1/run/resolve: non-ref values pass through verbatim", async () => {
  // env=[{ key: "PORT", value: "3000", isRef: false }]. Resolve resolves nothing.
  // Command echoes $PORT. Expect "3000" in stdout.
});

test("POST /v1/run/resolve: missing ref → secret_not_found error line", async () => {
  // refs=["ss://x/dev/missing"]. Expect { error: { code: "secret_not_found" } } in stream.
});
```

**Note for the implementer:** the test harness needs to handle the streaming response. Use `streamingDaemonRequest` from Task B3 + `streamLineDelimitedJson`. The test fixtures (`withDaemonAndVault` etc.) follow the existing Plan 2 patterns in `secrets-delete.test.ts`.

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Implement the route**

Create `src/daemon/api/routes/run-resolve.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { ShuttleError, errorToJson } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { buildChildEnv } from "../../safe-env.js";
import type { DaemonServices } from "../../services.js";
import { spawnAndStream, type OutputWriter } from "../../run/spawner.js";

interface RunResolveBody {
  refs?: string[];
  env?: Array<{ key: string; value: string; isRef: boolean }>;
  command?: string;
  args?: string[];
  cwd?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

interface RawRouteRegistrar {
  addRouteRaw: (
    method: "POST",
    pattern: RegExp,
    handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => Promise<void> | void,
  ) => void;
}

export function registerRunResolveRoute(
  server: RawRouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRouteRaw("POST", /^\/v1\/run\/resolve$/, async (req, _bodyIgnored, res) => {
    let body: RunResolveBody;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunResolveBody;
    } catch {
      writeErrorResponse(res, 400, new ShuttleError("invalid_json", "Request body is not valid JSON."));
      return;
    }
    // Authenticate via bearer header (raw routes bypass server-level auth)
    const auth = (req.headers["authorization"] ?? "") as string;
    // ... reproduce the bearer check from server.ts (the raw route registrar is
    // intentionally bypassing the per-route check; we still need to authorize).
    // Look at how src/daemon/approvals/ui-server.ts handles its raw route's
    // per-request token check for the pattern.

    services.lock.requireKey();

    if (typeof body.command !== "string" || body.command.length === 0) {
      writeErrorResponse(res, 400, new ShuttleError("missing_param", "command is required."));
      return;
    }
    const refs = Array.isArray(body.refs) ? body.refs : [];
    const envEntries = Array.isArray(body.env) ? body.env : [];

    let resolved: Map<string, string>;
    try {
      resolved = await services.vault.resolveRefs(refs);
    } catch (e) {
      writeErrorResponse(res, 400, e);
      return;
    }

    // Determine environment for approval gating. If any resolved ref is
    // production, the whole run is production-gated.
    const isProduction = refs.some((ref) => {
      // Refs are ss://source/env/name — parse env field.
      const parts = ref.split("/");
      return parts[3] === "production" || parts[3] === "prod";
    });

    if (isProduction) {
      const binding: ApprovalBinding = {
        action: "run",
        ref: null,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        // Stash the ref list + command in template_params so the approval UI
        // can display what's being approved.
        template_params: {
          command: body.command,
          args: JSON.stringify(body.args ?? []),
          refs: refs.join(","),
        },
        allowed_domains: [],
      };
      try {
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          approvalIdFromClient: body.approval_id,
          waitMs: body.wait_for_approval === false ? 0 : undefined,
        });
      } catch (e) {
        writeErrorResponse(res, 200, e); // 200 to avoid pre-stream HTTP error path
        return;
      }
    }

    // Build final env block.
    const env: NodeJS.ProcessEnv = { ...buildChildEnv() };
    for (const entry of envEntries) {
      if (entry.isRef) {
        const value = resolved.get(entry.value);
        if (value === undefined) {
          writeErrorResponse(res, 400, new ShuttleError(
            "secret_not_found",
            `Ref ${entry.value} could not be resolved.`,
          ));
          return;
        }
        env[entry.key] = value;
      } else {
        env[entry.key] = entry.value;
      }
    }

    // Switch into streaming response mode.
    res.statusCode = 200;
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("cache-control", "no-store");
    // Flush headers
    res.flushHeaders();

    const writer: OutputWriter = {
      writeStdout(chunk) {
        res.write(JSON.stringify({ stream: "stdout", data: chunk.toString("base64") }) + "\n");
      },
      writeStderr(chunk) {
        res.write(JSON.stringify({ stream: "stderr", data: chunk.toString("base64") }) + "\n");
      },
      writeExit(code) {
        res.write(JSON.stringify({ exit: code }) + "\n");
        res.end();
      },
      writeError(err) {
        res.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + "\n");
      },
    };

    await spawnAndStream({
      cmd: body.command,
      args: body.args ?? [],
      env,
      cwd: body.cwd,
      outputWriter: writer,
    });
  });
}

/** Write a JSON error response when streaming hasn't started yet. */
function writeErrorResponse(res: ServerResponse, status: number, err: unknown): void {
  const payload = errorToJson(err);
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
  }
  res.end(JSON.stringify(payload));
}
```

**Implementer notes:**
- The bearer-token authentication for `addRouteRaw` is a real concern — look at how the existing approval-UI raw route (`src/daemon/approvals/ui-server.ts`) does it (it uses a per-request token in the URL). For `/v1/run/resolve` we have no such per-request token; instead the registrar needs to do the bearer check. **Option A:** modify `addRouteRaw` to accept a `{ requireBearer: true }` option. **Option B:** do the bearer check inside the route handler (duplicate the logic from `server.ts`).
- The cleaner path is Option A — extend `addRouteRaw` so the server-level bearer auth still runs even for raw routes. Investigate the existing API at `src/daemon/server.ts:32-39` and pick whichever fits the existing convention.

- [ ] **Step 8: Register the route**

In the route-registration site (whichever file handles route wiring), add:

```typescript
import { registerRunResolveRoute } from "./routes/run-resolve.js";
// ...
registerRunResolveRoute(server, services, daemonPortRef);
```

- [ ] **Step 9: Run route tests — expect PASS** (4 tests)

- [ ] **Step 10: Commit**

```bash
git add src/daemon/run/spawner.ts src/daemon/run/spawner.test.ts \
  src/daemon/api/routes/run-resolve.ts src/daemon/api/routes/run-resolve.test.ts \
  src/daemon/api/router.ts src/daemon/server.ts
git commit -m "feat(daemon): /v1/run/resolve route + spawner; streams stdout/stderr via ndjson"
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
- Builds the POST body: `refs` (array of `ss://...` values from ref entries), `env` (entries array), `command` (the first positional after `--`), `args` (remaining positionals).
- Calls `streamingDaemonRequest` (Task B3) + `streamLineDelimitedJson` (Task B3) to read the response.
- For each line:
  - `{ stream: "stdout", data: <b64> }` → decode base64, write to `process.stdout`.
  - `{ stream: "stderr", data: <b64> }` → decode base64, write to `process.stderr`.
  - `{ exit: <code> }` → set `process.exitCode = code` and return.
  - `{ error: ... }` → throw `ShuttleError(code, message)`.

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
import { ShuttleError } from "../../shared/errors.js";

export function runCommand(): Command {
  return new Command("run")
    .description("Run a command with secrets resolved into its env. Secrets never enter the CLI process.")
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
          streamError = new ShuttleError(line.error.code, line.error.message);
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
  - Production refs require approval. Use --no-wait to receive an
    approval_id immediately.
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
- Scan text for `ss://source/env/name` substrings (same regex as the env-file ref).
- Return `{ refs: string[]; render(values: Map<string, string>): string }` — `refs` is the deduped list; `render` substitutes.

**Route behavior:**
- Reads body: `{ template: string, output_path: string, approval_id?, wait_for_approval? }`.
- Special case: `output_path === "-"` → stream the rendered content back in the response body as plaintext (CLI documented as "bytes pass through CLI" mode).
- Otherwise: canonicalize the output path. If it's not inside `$HOME`, throw `inject_output_path_unsafe`.
- Parse template → resolve refs via `Vault.resolveRefs` → render.
- Write file at `output_path` with mode 0600 (use `O_CREAT | O_WRONLY | O_TRUNC` + chmod, or open with `mode: 0o600`).
- Return `{ rendered: true, output_path: <canonical>, refs_count: <N> }` (no plaintext).

- [ ] **Step 1: Template parser test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplate } from "./template.js";

test("parseTemplate: finds all ss:// refs (deduped)", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY\nother: ss://stripe/prod/STRIPE_KEY\n";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://stripe/prod/STRIPE_KEY"]);
});

test("parseTemplate: render substitutes refs with provided values", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY";
  const { render } = parseTemplate(t);
  const out = render(new Map([["ss://stripe/prod/STRIPE_KEY", "sk_live_abc"]]));
  assert.equal(out, "key: sk_live_abc");
});

test("parseTemplate: render throws if a ref's value is missing", () => {
  const t = "key: ss://x/dev/MISSING";
  const { render } = parseTemplate(t);
  assert.throws(() => render(new Map()), /MISSING/);
});

test("parseTemplate: refs are matched only at word boundaries (no partial)", () => {
  const t = "no match: ss://x/dev/A_extra";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://x/dev/A_extra"]); // valid ref, matches in full
});

test("parseTemplate: empty template has no refs", () => {
  const { refs } = parseTemplate("");
  assert.deepEqual(refs, []);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement template parser**

Create `src/daemon/inject/template.ts`:

```typescript
const REF_RE = /ss:\/\/[^/\s]+\/[^/\s]+\/[A-Z_][A-Z0-9_]*/g;

export interface ParsedTemplate {
  refs: string[];
  render(values: Map<string, string>): string;
}

export function parseTemplate(template: string): ParsedTemplate {
  const found = new Set<string>();
  for (const m of template.matchAll(REF_RE)) {
    found.add(m[0]);
  }
  const refs = [...found];
  const render = (values: Map<string, string>): string => {
    return template.replaceAll(REF_RE, (match) => {
      const v = values.get(match);
      if (v === undefined) {
        throw new Error(`template: no value provided for ref ${match}`);
      }
      return v;
    });
  };
  return { refs, render };
}
```

- [ ] **Step 4: Template tests pass**

- [ ] **Step 5: Route test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
// ... existing harness imports
import { registerInjectRenderRoute } from "./inject-render.js";

test("POST /v1/inject/render: writes file at mode 0600 inside $HOME", async () => {
  // Vault has ss://x/dev/KEY=value. POST template="key: ss://x/dev/KEY"
  // output_path inside $HOME. Verify file exists, content matches, mode is 0600.
});

test("POST /v1/inject/render: refuses output_path outside $HOME → inject_output_path_unsafe", async () => {
  // POST output_path="/tmp/x" (outside HOME). Expect inject_output_path_unsafe error.
});

test("POST /v1/inject/render with output_path=- returns rendered content in response body", async () => {
  // POST template="key: ss://x/dev/KEY", output_path="-".
  // Expect response { rendered: true, content: "key: value" }.
});

test("POST /v1/inject/render: production refs require approval", async () => {
  // template has ss://x/prod/KEY. Expect approval_required without --approval-id.
});

test("POST /v1/inject/render: deleted ref → secret_not_found", async () => {
  // Vault has ss://x/dev/A; softDelete it; render template referencing A.
  // Expect secret_not_found.
});
```

- [ ] **Step 6: Implement the route**

Create `src/daemon/api/routes/inject-render.ts`:

```typescript
import type { IncomingMessage } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";
import { parseTemplate } from "../../inject/template.js";

interface InjectRenderBody {
  template?: string;
  output_path?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerInjectRenderRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/inject/render", async (_req, body) => {
    const b = (body ?? {}) as InjectRenderBody;
    if (typeof b.template !== "string") {
      throw new ShuttleError("missing_param", "template is required.");
    }
    if (typeof b.output_path !== "string" || b.output_path.length === 0) {
      throw new ShuttleError("missing_param", "output_path is required (use '-' for stdout mode).");
    }
    services.lock.requireKey();

    const parsed = parseTemplate(b.template);

    // Determine if production gating applies — any ref in production.
    const isProduction = parsed.refs.some((ref) => {
      const parts = ref.split("/");
      return parts[3] === "production" || parts[3] === "prod";
    });

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
          output_path: b.output_path,
          refs: parsed.refs.join(","),
        },
        allowed_domains: [],
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        approvalIdFromClient: b.approval_id,
        waitMs: b.wait_for_approval === false ? 0 : undefined,
      });
    }

    const resolved = await services.vault.resolveRefs(parsed.refs);
    const rendered = parsed.render(resolved);

    if (b.output_path === "-") {
      // Stdout-passthrough mode: return content in response body.
      // CLI documented as "bytes pass through CLI" mode.
      return { rendered: true, refs_count: parsed.refs.length, content: rendered };
    }

    // File mode: canonicalize + safety check + write 0600.
    const home = os.homedir();
    const canonical = path.resolve(b.output_path);
    if (!canonical.startsWith(home + path.sep) && canonical !== home) {
      throw new ShuttleError(
        "inject_output_path_unsafe",
        `Refusing to write outside HOME: ${canonical}`,
      );
    }

    try {
      await mkdir(path.dirname(canonical), { recursive: true, mode: 0o700 });
      await writeFile(canonical, rendered, { encoding: "utf8", mode: 0o600 });
      await chmod(canonical, 0o600); // belt-and-suspenders
    } catch (e) {
      throw new ShuttleError(
        "inject_output_write_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    return { rendered: true, output_path: canonical, refs_count: parsed.refs.length };
  });
}
```

- [ ] **Step 7: Register route**

Same pattern as the other route registrations.

- [ ] **Step 8: Route tests pass**

- [ ] **Step 9: Commit**

```bash
git add src/daemon/inject/template.ts src/daemon/inject/template.test.ts \
  src/daemon/api/routes/inject-render.ts src/daemon/api/routes/inject-render.test.ts \
  src/daemon/api/router.ts
git commit -m "feat(daemon): /v1/inject/render route + template parser; 0600 file write"
```

---

### Task D2: `secret-shuttle inject` CLI command

**Files:**
- Create: `src/cli/commands/inject.ts` (the new top-level command for template substitution — DIFFERENT from V0 inject which lives at `internal inject-v0`)
- Create: `src/cli/commands/inject.test.ts`
- Modify: `src/cli/commands/internal.ts` — rename the V0 `inject` import to avoid the name collision

**The collision and rename:**
- The old V0 `inject` command (focused-field inject for the browser CDP flow) is currently `internal inject` after Plan 2.
- The new top-level `inject` is for template substitution.
- They cannot share the same export name.
- Solution: keep the V0 command file at `src/cli/commands/inject.ts` was the old name; rename its file to `src/cli/commands/inject-v0.ts` and rename the export to `injectV0Command`. Then create the new `src/cli/commands/inject.ts` with `injectCommand` for template substitution.
- Update `src/cli/commands/internal.ts` to import `injectV0Command` from `./inject-v0.js`, and register it as `internal inject-v0` (NOT `internal inject` — avoids confusion).

- [ ] **Step 1: Rename V0 inject to disambiguate**

```bash
git mv src/cli/commands/inject.ts src/cli/commands/inject-v0.ts
```

Edit `src/cli/commands/inject-v0.ts`:
- Rename the exported function: `injectCommand` → `injectV0Command`.
- Rename the Commander command name: `new Command("inject")` → `new Command("inject-v0")` (so `internal inject-v0` is the invocation).

Edit `src/cli/commands/internal.ts`:
- Change `import { injectCommand } from "./inject.js"` to `import { injectV0Command } from "./inject-v0.js"`.
- Change `cmd.addCommand(injectCommand())` to `cmd.addCommand(injectV0Command())`.

Run `npm run typecheck` — must pass. Run `npm test` — must pass.

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
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";

export function injectCommand(): Command {
  return new Command("inject")
    .description("Render a template with ss:// refs resolved; daemon writes the file at mode 0600.")
    .requiredOption("-i, --input <path>", "Template file containing ss:// refs.")
    .requiredOption("-o, --output <path>", "Output file path (must be inside $HOME), or '-' for stdout.")
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
      const body: Record<string, unknown> = {
        template,
        output_path: options.output,
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/inject/render", body);
      // For stdout mode the response includes "content"; print it to stdout
      // and emit a JSON summary on a separate line. The CLI explicitly handles
      // the documented "bytes pass through CLI" mode.
      const result = r as { rendered: boolean; refs_count: number; output_path?: string; content?: string };
      if (options.output === "-" && typeof result.content === "string") {
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
  Any text file containing 'ss://source/env/NAME' refs. The daemon resolves
  them and substitutes inline. Refs are recognized as word-like tokens —
  the value following 'ss://' must be a valid ss-ref (slash-separated
  source/env/NAME).

Output path security:
  The daemon refuses to write outside your $HOME directory (path is
  canonicalized; '..' segments resolved). Use '-' for stdout if you need
  to pipe to another process — but note the rendered bytes pass through
  this CLI in that mode.
`);
}
```

- [ ] **Step 5: Register in `src/cli/index.ts`**

Add `import { injectCommand } from "./commands/inject.js"` (this points at the NEW inject.ts, not the renamed inject-v0.ts).

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
git add src/cli/commands/inject.ts src/cli/commands/inject.test.ts src/cli/commands/inject-v0.ts \
  src/cli/commands/internal.ts src/cli/index.ts
git commit -m "feat(cli): inject -i <tpl> -o <out> — template substitution via daemon

Disambiguates from the V0 CDP-inject command (now \`internal inject-v0\`).
The new top-level \`inject\` substitutes ss:// refs in a template file
and writes the rendered output at mode 0600 (or to stdout for piping)."
```

---

## Part E — Verification + CHANGELOG

### Task E1: Full suite verification

- [ ] **Step 1:** `npm test` — all pass (expect 605 baseline + ~25-30 new tests = ~630+ total).
- [ ] **Step 2:** `npm run typecheck` — pass.
- [ ] **Step 3:** `npm run check-pack` — pass.
- [ ] **Step 4: Smoke tests**

```bash
# Curated help should now list `run` and `inject` under Process integration.
node dist/cli/index.js help | grep -E "run|inject"

# Help for each new command shows examples.
node dist/cli/index.js run --help | tail -15
node dist/cli/index.js inject --help | tail -15

# Internal still has the V0 inject under a renamed name.
node dist/cli/index.js internal --help | grep -E "compare|blind|capture|inject-v0"
```

Note: the curated `help` text needs to be updated to list `run` and `inject`. Look at `src/cli/commands/help.ts` and add them under Process integration. This is a SMALL doc edit; bundle with Task E2.

- [ ] **Step 5:** No commit for E1 (verification only).

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
- `secret-shuttle run --env-file=<f> -- <cmd>` — subshell injection. The CLI parses a strict dotenv-like file (KEY=VALUE; ss:// refs only at full-value position; no shell expansion), POSTs refs + command + argv to the daemon, and the daemon spawns the child with the resolved env block. Stdout/stderr are streamed back via line-delimited JSON over chunked HTTP; the child's exit code is the CLI's exit code. The CLI process never holds plaintext.
- `secret-shuttle inject -i <tpl> -o <out>` — template substitution. CLI reads the template file and ships its bytes to `POST /v1/inject/render`; the daemon parses ss:// refs, resolves them, and writes the rendered file at mode 0600. The output path is canonicalized and refused if outside `$HOME`. Use `-o -` for stdout-passthrough (documented as "bytes pass through CLI").
- `Vault.resolveRefs(refs[])` — batch deleted-aware ref→value lookup. Used by both new daemon endpoints; honors the Plan 2 soft-delete invariant (deleted refs throw `secret_not_found`).
- New approval actions: `run`, `inject_render`. Added to the union + UI copy + audit. Production refs in either flow require approval.

### Changed
- The V0 CDP-inject command (`internal inject`) is renamed to `internal inject-v0` to free the top-level `inject` name for the new template-substitution command. Scripts that called `internal inject` need to update.

### Known limitations
- `run` does NOT mask resolved secret values in the child's stdout/stderr. Per spec §5.3 masking is "defense-in-depth, not a security guarantee — child can always exfiltrate via network." Masking lands in Plan 4 alongside the single-window tab-reuse work as a coherent output-pathway hardening pass.
- `run` children inherit a hardened-PATH baseline (from `buildChildEnv`), not the user's shell PATH. Users who need a custom PATH can put it in the env file: `PATH=/custom/path/here`. Variable expansion (`$PATH`) is not supported.
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
| `secret-shuttle run --env-file=<f> -- <cmd>` | A1 (parser) + B1 (Vault) + B2 (approval) + B3 (streaming) + B4 (daemon route + spawner) + C1 (CLI) |
| `secret-shuttle inject -i <tpl> -o <out>` | D1 (template parser + daemon route) + D2 (CLI) |
| `POST /v1/run/resolve` + spawner | B4 |
| `POST /v1/inject/render` | D1 |
| Approval binding extensions (`run`, `inject_render`) | B2 |
| Approval UI copy | B2 |
| Audit action types | B2 |
| Error-codes registry seeds | B2 |
| Curated help lists `run` + `inject` | E2 |
| CHANGELOG | E2 |
| Masking of resolved values in `run` output | NOT in Plan 3 — Plan 4 |

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "Similar to Task N", or "add appropriate X". Every code block is complete. Every command shows expected output. Test code snippets are runnable as-is.

**3. Type consistency**

- `EnvFileEntry` defined in A1; consumed in C1 and B4. Same shape across.
- `OutputWriter` defined in B4 (spawner); used in B4 (route).
- `StreamLine` union defined in B3; consumed in C1.
- `ApprovalBinding.action` adds `"run"` and `"inject_render"` in B2; both literals used in B4 and D1.
- `Vault.resolveRefs` defined in B1; consumed in B4 and D1. Returns `Map<string, string>` consistently.
- `parseTemplate` defined in D1; returns `{ refs: string[]; render(values: Map<string, string>): string }` consistently used in D1's route.

**4. Scope**

Plan 3 is one coherent process-integration unit. Two new commands sharing a common Vault helper and approval-action pattern. 10 tasks. Estimated execution time: ~5-7 hours for a fresh subagent doing one task at a time with TDD + verification. Includes a meaningful new client capability (streaming HTTP), a new daemon spawner module, and end-to-end approval + audit + UI integration.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan3-run-and-inject.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality), review between tasks. Same pattern as Plans 1 and 2.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
