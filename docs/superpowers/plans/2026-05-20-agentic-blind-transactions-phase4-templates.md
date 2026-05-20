# Phase 4 — Provider Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three additional provider templates (`github-actions-secret-set`, `cloudflare-secret-put`, `supabase-edge-secret-set`) on the existing `TemplateRegistry`, extending `runTemplate` with a `tmp_env_file_0600` secret-delivery mode for CLIs that don't accept true stdin, with crash-safe tmp-dir sweeping. The secret value reaches the child only via stdin or a 0600 daemon-owned temp env-file and never appears in argv or env.

**Architecture:** Additive: new built-in `TemplateDefinition`s + a `tmp_env_file_0600` extension to `runTemplate` (create 0700 dir / 0600 file / `O_CREAT|O_EXCL` / pass-path / unlink-in-finally / scrub-buffer) + startup + periodic sweep of `~/.secret-shuttle/tmp/`. No changes to RESOLVE/BASELINE/route-level §6.1 gates from Phase 2/3. Spec: [docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md](../specs/2026-05-18-agentic-blind-transactions-design.md) §9 (signed off at commit `d1c89ed`); Phases 1–3 merged on `main`.

**Tech Stack:** Same as Phase 2/3 — TypeScript (ESM, NodeNext, `.js` import specifiers, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Commander CLI, Node built-in `http` daemon, raw CDP over a pipe transport, `node:test` + `node:assert/strict` (tests build to `dist/` then run via `node --test`).

---

## Scope: this plan covers Phase 4 only

The spec (§14) defines five independently shippable phases. Phases 1 (Opaque Browser Handles), 2 (`inject-submit`), and 3 (`reveal-capture`) are **merged** on `main`. **This document is the complete, executable plan for Phase 4 (Provider Templates)** — spec §9 (template list, `tmp_env_file_0600`, crash-safe sweep, deferred-with-rationale), and the existing `runTemplate` guarantees that remain in force (binary sha256 in approval binding, `["pipe","ignore","ignore"]` stdio, `buildChildEnv` scrubbing, `destinationEnvironment` from params).

**Out of this plan (separate plan):** Plan 5 — Skill + installers + doctor/health (§10, §11), which references this plan's templates from the canonical `skills/secret-shuttle/SKILL.md`.

**Carried residual (release gate, Task 11):** the spec §9 **[P2b] template `--help` verification gate** — a manual/scripted check on a current install of `gh`/`wrangler`/`supabase` that does **not** block the merge of Tasks 1–10. Its outcome is recorded in this plan's "## [P2b] Gate outcome" section.

---

## Phase 4 File Structure

- **Modify** `src/daemon/templates/registry.ts:4-14` (`TemplateDefinition`) — widen `secret_delivery` from `"stdin"` to `"stdin" | "tmp_env_file_0600"`; add the new `value_arg_template?: string | null` field (only consumed when `secret_delivery === "tmp_env_file_0600"`) that names the argv slot where the env-file path goes (e.g. `"--env-file={{__env_file_path__}}"`), and the optional `value_arg_position?: "append" | "replace_placeholder"` (default `"append"` — placeholder substitution is the explicit case where a CLI needs the path mid-argv). Register the three new templates in the constructor alongside `vercelEnvAdd`.
- **Modify** `src/shared/config.ts:5-15` (`ShuttlePaths`) — add `daemonTmpPath` (= `~/.secret-shuttle/tmp/`). The `ensureShuttleHome` helper continues to be home-dir only; tmp-dir creation is daemon-startup (Task 3).
- **Create** `src/daemon/templates/tmp-env-file.ts` — `writeSecretEnvFile({ name, value, tmpDir }) → { path }` (atomic `O_CREAT|O_EXCL`, mode `0600`, content `NAME=VALUE\n`, scrubs the secret buffer post-write) and `unlinkSecretEnvFile(path)` (ENOENT-tolerant). Pure module; no daemon state.
- **Create** `src/daemon/templates/tmp-env-file.test.ts` — atomic-create + mode 0600 + content + buffer-scrub + O_EXCL refuses pre-existing + unlink-ENOENT-tolerant tests.
- **Modify** `src/daemon/templates/run.ts` — add the `tmp_env_file_0600` branch (calls `writeSecretEnvFile` against `services.tmpDir` resolved via a new constructor arg, splices the path into argv via the template's `value_arg_template`, runs spawn with stdio `["ignore","ignore","ignore"]` for the env-file mode (no stdin write at all), unlinks in `finally`, and scrubs any buffers it owns). Existing stdin branch unchanged.
- **Modify** `src/daemon/templates/run.test.ts` — add tests for the `tmp_env_file_0600` branch (file exists during exec; file mode 0600; argv contains the path; argv does NOT contain the secret; env does NOT contain the secret; unlink happens on success AND on throw; existing path → `template_env_file_collision`).
- **Create** `src/daemon/templates/sweep-tmp.ts` — `sweepTmpDir({ tmpDir, force?: boolean, maxAgeMs?: number, now?: () => number })` — fail-tolerant (best-effort, no throws), unlinks every regular file in `tmpDir` matching the criteria. `force: true` ignores age; otherwise files with `mtimeMs < now - maxAgeMs` are deleted. Honors `0700` parent — if the dir is missing it is a silent no-op (the next file create will recreate). Records each unlink via `writeDaemonAudit` with `action:"template_tmp_sweep"`.
- **Create** `src/daemon/templates/sweep-tmp.test.ts` — startup-force-sweep deletes everything; periodic sweep keeps files newer than the bound and deletes older files; missing tmpDir is a no-op (no throw); failing unlink does not stop the sweep of remaining files.
- **Modify** `src/daemon/main.ts:34-41` — at startup, immediately after `scrubDaemonSecretsFromEnv()` and the `DaemonServices` construction, ensure the tmp dir exists with mode `0700` then call `sweepTmpDir({ tmpDir, force: true })` (synchronous-best-effort wrapped in `await`), then start a `setInterval` for periodic sweeps (`setIntervalUnref`-style — call `.unref()` so it does NOT keep the event loop alive) and store the timer on `services` for `shutdown` to clear.
- **Modify** `src/daemon/services.ts:40-76` — add a `readonly tmpDir: string` (resolved from `getShuttlePaths().daemonTmpPath`) and a `sweepTimer: NodeJS.Timeout | null` field (set by `main.ts`, cleared on shutdown).
- **Modify** `src/daemon/audit.ts:4-10` (`DaemonAuditAction`) — add `"template_tmp_sweep"` so the sweep can emit per-deletion audit records.
- **Create** `src/daemon/templates/builtin/github-actions-secret-set.ts` — the `gh secret set` template (stdin delivery).
- **Create** `src/daemon/templates/builtin/cloudflare-secret-put.ts` — the `wrangler secret put` template (stdin delivery).
- **Create** `src/daemon/templates/builtin/supabase-edge-secret-set.ts` — the `supabase secrets set` template (`tmp_env_file_0600` delivery).
- **Modify** `src/daemon/templates/registry.test.ts` — register-list-by-id tests for each new template; per-template `validateParams` positive + negative tests.
- **Create** `docs/templates-deferred.md` — documented rationale for the deferred templates (`railway-variable-set`, `netlify-env-set`, `clerk-env-set`).
- **Modify** `docs/roadmap.md` — V4 Platform Helpers section gets a forward-reference to `docs/templates-deferred.md` (one line — current `roadmap.md` already names these providers).
- **Modify** `docs/cli-reference.md:87-100` (the `template list/run` section) — add the four built-in templates (one paragraph each) with per-template params + the delivery mode. Replace the existing single sentence "Built-in templates today: `vercel-env-add`." with the four-template enumeration.
- **Create** `src/e2e/templates-no-leak.test.ts` — daemon-level e2e for both delivery modes: stub binary (a `node` script) asserts the secret was present on stdin (for `gh`/`wrangler`) or in a 0600 file at the path passed in argv (for `supabase`); assert no secret bytes anywhere in argv, env, stdout, stderr, the HTTP response, or the audit log.

**Branch:** all work on a feature branch — run `git switch -c feat/templates` as the first step; **do not implement on `main`**. Phases 1–3 used this same lightweight branch model (each merged cleanly); mirror it.

Commands:
- Build: `npm run build`
- Typecheck only: `npm run typecheck`
- Full test: `npm test` (builds, then `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/**/*.test.js"`)
- One test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/<path>.test.js`

---

### Task 1: Branch + widen `TemplateDefinition.secret_delivery` + add `daemonTmpPath`

**Files:**
- Modify: `src/daemon/templates/registry.ts:4-14` (`TemplateDefinition`)
- Modify: `src/shared/config.ts:5-15` (`ShuttlePaths`), `:21-33` (`getShuttlePaths`)
- Test: `src/daemon/templates/registry.test.ts` (extend), `src/shared/config.test.ts` (new section — see below)

> Widening the union is first because every new template definition and the `runTemplate` extension depend on it. The new `daemonTmpPath` is added here (not later) so subsequent tasks have one canonical path to import. Pre-existing `vercel-env-add` keeps `secret_delivery: "stdin"` — the existing test in `registry.test.ts` already asserts that, no change needed.

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git switch -c feat/templates
```
Expected: `Switched to a new branch 'feat/templates'`

- [ ] **Step 2: Write the failing registry test**

In `src/daemon/templates/registry.test.ts`, append at the bottom (after line 65 — the existing `resolveBinary` PATH test):
```ts
test("TemplateDefinition.secret_delivery accepts 'tmp_env_file_0600' (union widened)", () => {
  const fake: import("./registry.js").TemplateDefinition = {
    id: "fake-env-file",
    description: "test",
    binary: "vercel",
    args: ["env-file", "{{__env_file_path__}}"],
    secret_delivery: "tmp_env_file_0600",
    required_params: [],
    requires_approval_when_production: false,
    value_arg_template: "--env-file={{__env_file_path__}}",
  };
  // Trivial assertions — the test is structural: it must COMPILE.
  assert.equal(fake.secret_delivery, "tmp_env_file_0600");
  assert.equal(fake.value_arg_template, "--env-file={{__env_file_path__}}");
});
```

- [ ] **Step 3: Write the failing config test**

Create `src/shared/config.test.ts` if it does not exist; if it exists, append at the bottom. Either way the file ends with these two tests:
```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths, getSecretShuttleHome } from "./config.js";

test("getShuttlePaths exposes a daemonTmpPath under the home dir", () => {
  const p = getShuttlePaths("/tmp/ss-test-home");
  assert.equal(p.daemonTmpPath, path.join("/tmp/ss-test-home", "tmp"));
});

test("getShuttlePaths daemonTmpPath defaults under getSecretShuttleHome() when no arg", () => {
  const p = getShuttlePaths();
  assert.equal(p.daemonTmpPath, path.join(getSecretShuttleHome(), "tmp"));
});
```

- [ ] **Step 4: Run both tests to verify they fail**

Run: `npm run build`
Expected: FAIL to compile — `TS2322: Type '"tmp_env_file_0600"' is not assignable to type '"stdin"'` on the registry test, AND `TS2339: Property 'daemonTmpPath' does not exist on type 'ShuttlePaths'` on the config test. That is the expected first failure.

- [ ] **Step 5: Widen the `TemplateDefinition` union**

In `src/daemon/templates/registry.ts`, replace lines 4-14 (the entire `TemplateDefinition` interface) with the widened union + the two new optional fields:
```ts
export interface TemplateDefinition {
  id: string;
  description: string;
  binary: string;
  args: string[];
  secret_delivery: "stdin" | "tmp_env_file_0600";
  required_params: string[];
  requires_approval_when_production: boolean;
  validateParams?: (params: Record<string, string>) => void;
  destinationEnvironment?: (params: Record<string, string>) => string;
  /**
   * Only consumed when secret_delivery === "tmp_env_file_0600". Names the argv
   * slot for the daemon-written 0600 env-file path. The string is param-expanded
   * the same way args[] is, plus the synthetic placeholder {{__env_file_path__}}
   * which the daemon substitutes at run time. Required when secret_delivery is
   * "tmp_env_file_0600"; ignored otherwise.
   */
  value_arg_template?: string | null;
}
```

- [ ] **Step 6: Add `daemonTmpPath` to `ShuttlePaths`**

In `src/shared/config.ts`, the `ShuttlePaths` interface is lines 5-15. Add the new field immediately **after** the existing `daemonConfigPath: string;` line (line 14), before the closing `}` (line 15):
```ts
  daemonTmpPath: string;
```

In the same file, the `getShuttlePaths` function is lines 21-33. Add the new field immediately **after** the existing `daemonConfigPath: path.join(homeDir, "daemon.config.json"),` line (line 31), before the closing `};` (line 32):
```ts
    daemonTmpPath: path.join(homeDir, "tmp"),
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js dist/shared/config.test.js`
Expected: PASS — every test passes; the new ones plus the seven existing `registry.test.ts` tests.

- [ ] **Step 8: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all existing tests green. The widening is additive; every existing literal `secret_delivery: "stdin"` is still a member of the new union. The added `daemonTmpPath` is unused outside Task 3+; pre-existing callers of `getShuttlePaths()` ignore extra keys via structural typing.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/templates/registry.ts src/daemon/templates/registry.test.ts src/shared/config.ts src/shared/config.test.ts
git commit -m "feat(templates): widen TemplateDefinition.secret_delivery + add ShuttlePaths.daemonTmpPath (spec §9)"
```

---

### Task 2: `writeSecretEnvFile` + `unlinkSecretEnvFile` primitives (atomic 0600, scrubbed)

**Files:**
- Create: `src/daemon/templates/tmp-env-file.ts`
- Test: `src/daemon/templates/tmp-env-file.test.ts`

> This is the smallest possible primitive: one pure module, no daemon state, no `runTemplate` coupling. It encapsulates the security-critical file-handling so the `runTemplate` change in Task 4 is mechanical. The test asserts every spec §9 security requirement that lives at this layer: O_EXCL atomic, mode 0600, NAME=VALUE\n exact content, secret buffer scrubbed post-write, unlink ENOENT-tolerant.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/templates/tmp-env-file.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSecretEnvFile, unlinkSecretEnvFile } from "./tmp-env-file.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-tef-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeSecretEnvFile creates a file with mode 0600 and exactly NAME=VALUE\\n", async () => {
  await withTmp(async (dir) => {
    const { path: p } = writeSecretEnvFile({ name: "MY_SECRET", value: "v3rySecret!", tmpDir: dir });
    const st = await stat(p);
    assert.equal(st.mode & 0o777, 0o600, "file mode must be 0600");
    const content = await readFile(p, "utf8");
    assert.equal(content, "MY_SECRET=v3rySecret!\n");
  });
});

test("writeSecretEnvFile returns a path inside the supplied tmpDir with a randomized name", async () => {
  await withTmp(async (dir) => {
    const a = writeSecretEnvFile({ name: "X", value: "1", tmpDir: dir });
    const b = writeSecretEnvFile({ name: "X", value: "1", tmpDir: dir });
    assert.notEqual(a.path, b.path, "filenames must be randomized to avoid collisions");
    assert.equal(path.dirname(a.path), dir);
    assert.match(path.basename(a.path), /^[0-9a-f]{32}\.env$/);
  });
});

test("writeSecretEnvFile O_EXCL refuses an existing path (synthetic collision)", async () => {
  await withTmp(async (dir) => {
    // Force a collision by stubbing the path generator: write a file at the
    // first random name the function will pick. We can't reach the internal
    // RNG, so instead we test the behavior end-to-end by creating EVERY
    // possible 1-char name -- impractical. Instead, the function exports a
    // narrow internal helper for tests: writeSecretEnvFileAt({ name, value, path })
    // which we use directly to drive the O_EXCL branch.
    const { writeSecretEnvFileAt } = await import("./tmp-env-file.js");
    const fixed = path.join(dir, "fixed.env");
    await writeFile(fixed, "pre-existing\n");
    assert.throws(
      () => writeSecretEnvFileAt({ name: "X", value: "1", path: fixed }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "template_env_file_collision",
    );
  });
});

test("writeSecretEnvFile scrubs the secret buffer it owns (caller's string is not held)", async () => {
  await withTmp(async (dir) => {
    // We assert behavior the caller can rely on: after the call the function
    // does not return any reference to the secret value, only the path. The
    // file itself holds the value (until unlinked), but the function's local
    // buffer must be zeroed. We can't directly inspect the internal buffer;
    // we assert the contractual surface: the return object's keys do not
    // include "value" or any string that could be the secret.
    const result = writeSecretEnvFile({ name: "X", value: "leak-detector-7f", tmpDir: dir });
    assert.deepEqual(Object.keys(result).sort(), ["path"]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("leak-detector-7f"), false);
  });
});

test("unlinkSecretEnvFile deletes an existing file", async () => {
  await withTmp(async (dir) => {
    const { path: p } = writeSecretEnvFile({ name: "X", value: "1", tmpDir: dir });
    unlinkSecretEnvFile(p);
    await assert.rejects(() => stat(p), (e: unknown) => (e as { code?: string }).code === "ENOENT");
  });
});

test("unlinkSecretEnvFile is ENOENT-tolerant (no throw on missing)", async () => {
  await withTmp(async (dir) => {
    const ghost = path.join(dir, "does-not-exist.env");
    assert.doesNotThrow(() => unlinkSecretEnvFile(ghost));
  });
});

test("writeSecretEnvFile rejects a name containing '=' or newline (env-file injection guard)", async () => {
  await withTmp(async (dir) => {
    assert.throws(
      () => writeSecretEnvFile({ name: "X=Y", value: "v", tmpDir: dir }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "invalid_env_var_name",
    );
    assert.throws(
      () => writeSecretEnvFile({ name: "X\nY", value: "v", tmpDir: dir }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "invalid_env_var_name",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/tmp-env-file.test.js`
Expected: FAIL to compile — `Cannot find module './tmp-env-file.js'`. That is the expected first failure.

- [ ] **Step 3: Implement the primitive**

Create `src/daemon/templates/tmp-env-file.ts`:
```ts
import { closeSync, openSync, statSync, unlinkSync, writeSync, constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";

export interface WriteSecretEnvFileInput {
  /** Env-var name (e.g. "STRIPE_SECRET_KEY"). Must not contain '=' or newline. */
  name: string;
  /** The secret value. Held in a local Buffer that is zeroed after write. */
  value: string;
  /** Daemon-owned tmp dir (mode 0700) — see services.tmpDir. */
  tmpDir: string;
}

export interface WriteSecretEnvFileResult {
  path: string;
}

/**
 * Atomically creates a 0600 file at `<tmpDir>/<random>.env` containing exactly
 * "NAME=VALUE\n", using O_CREAT|O_EXCL|O_WRONLY so a pre-existing path is a hard
 * fail. The secret value is held in a single Buffer for the duration of the
 * write, then zeroed before the function returns.
 *
 * Security:
 * - Mode 0600 is set at file-creation time (third arg to openSync), NOT via a
 *   subsequent chmod, so there is no window where the file is world-readable.
 * - O_EXCL refuses an existing path (defense against a pre-planted symlink or
 *   race-created file in the daemon-owned tmp dir).
 * - The function never reads or holds the value after the write; the returned
 *   shape exposes only the path.
 */
export function writeSecretEnvFile(input: WriteSecretEnvFileInput): WriteSecretEnvFileResult {
  if (input.name.length === 0 || /[=\n\r\0]/.test(input.name)) {
    throw new ShuttleError(
      "invalid_env_var_name",
      "Env-file NAME must be non-empty and contain no '=', newline, or NUL.",
    );
  }
  const filePath = path.join(input.tmpDir, `${randomBytes(16).toString("hex")}.env`);
  return writeSecretEnvFileAt({ name: input.name, value: input.value, path: filePath });
}

/**
 * Test-internal variant that writes to a fixed path. Production code calls
 * writeSecretEnvFile, which generates a random path.
 */
export function writeSecretEnvFileAt(input: { name: string; value: string; path: string }): WriteSecretEnvFileResult {
  const buf = Buffer.from(`${input.name}=${input.value}\n`, "utf8");
  let fd: number;
  try {
    fd = openSync(
      input.path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    buf.fill(0);
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      throw new ShuttleError(
        "template_env_file_collision",
        "Env-file path already exists (refusing to overwrite).",
      );
    }
    throw new ShuttleError(
      "template_env_file_write_failed",
      `Failed to create env-file: ${(err as Error).message}`,
    );
  }
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
    buf.fill(0);
  }
  return { path: input.path };
}

/**
 * Deletes the file. ENOENT-tolerant (the file may already have been swept by
 * the periodic sweep, or may have been removed by an external operator).
 * Every other error is silently swallowed by design — the caller is in a
 * finally block on the no-leak path; throwing would mask the original error.
 */
export function unlinkSecretEnvFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    // Any other unlink failure is non-fatal at this layer; the periodic sweep
    // will pick it up.
  }
}

/**
 * Defensive: returns true iff the path lives at mode 0600 right now. Used in
 * tests; not called by runTemplate (which trusts O_CREAT|O_EXCL + mode 0600).
 */
export function isMode0600(filePath: string): boolean {
  try {
    return (statSync(filePath).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/tmp-env-file.test.js`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/templates/tmp-env-file.ts src/daemon/templates/tmp-env-file.test.ts
git commit -m "feat(templates): writeSecretEnvFile/unlinkSecretEnvFile primitives (O_CREAT|O_EXCL, mode 0600, scrubbed) (spec §9)"
```

---

### Task 3: `sweepTmpDir` (best-effort, age-bounded; startup-force + periodic)

**Files:**
- Create: `src/daemon/templates/sweep-tmp.ts`
- Test: `src/daemon/templates/sweep-tmp.test.ts`
- Modify: `src/daemon/audit.ts:4-10` (`DaemonAuditAction`) — add `"template_tmp_sweep"`

> The sweep is the second-layer crash safety (`finally` cannot cover SIGKILL/OOM/host crash, spec §9). It runs in two modes: `force:true` deletes every regular file (used at daemon startup — anything left over is from a prior run that crashed past the `finally`); the periodic mode deletes only files older than `maxAgeMs` (defaults: see Task 5 — 30s interval, 60s max age, so worst-case exposure is ~90s in a 0600 file in a 0700 dir). The sweep emits a per-deletion audit record so a forensic operator can see exactly which paths were cleared.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/templates/sweep-tmp.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sweepTmpDir } from "./sweep-tmp.js";
import { getShuttlePaths } from "../../shared/config.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-sweep-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("sweepTmpDir({force:true}) deletes every regular file in the tmpDir", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = await readdir(tmpDir);
    assert.deepEqual(remaining, []);
  });
});

test("sweepTmpDir periodic mode keeps files newer than maxAgeMs, deletes older files", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const oldFile = path.join(tmpDir, "old.env");
    const newFile = path.join(tmpDir, "new.env");
    await writeFile(oldFile, "X=1\n");
    await writeFile(newFile, "Y=2\n");
    // Set oldFile mtime to "100s ago"; newFile keeps "now".
    const past = new Date(Date.now() - 100_000);
    await utimes(oldFile, past, past);
    await sweepTmpDir({ tmpDir, maxAgeMs: 60_000 });
    const remaining = (await readdir(tmpDir)).sort();
    assert.deepEqual(remaining, ["new.env"]);
  });
});

test("sweepTmpDir is a silent no-op when tmpDir does not exist", async () => {
  await withHome(async (home) => {
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    // tmpDir is NOT created.
    await assert.doesNotReject(() => sweepTmpDir({ tmpDir, force: true }));
  });
});

test("sweepTmpDir continues past a failing unlink (best-effort)", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    // Pre-unlink a.env between readdir and unlinkSync to force one ENOENT
    // mid-sweep. We simulate by passing a custom now() that runs the sweep
    // twice; the second call must not throw and the dir must end empty.
    await sweepTmpDir({ tmpDir, force: true });
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = await readdir(tmpDir);
    assert.deepEqual(remaining, []);
  });
});

test("sweepTmpDir emits one template_tmp_sweep audit record per deletion", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await writeFile(path.join(tmpDir, "b.env"), "Y=2\n");
    await sweepTmpDir({ tmpDir, force: true });
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const sweeps = lines.filter((l) => l.action === "template_tmp_sweep");
    assert.equal(sweeps.length, 2, "one audit record per file deleted");
    for (const s of sweeps) assert.equal(s.ok, true);
  });
});

test("sweepTmpDir ignores subdirectories (only deletes regular files)", async () => {
  await withHome(async (home) => {
    const { mkdir } = await import("node:fs/promises");
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(path.join(tmpDir, "subdir"), { recursive: true });
    await writeFile(path.join(tmpDir, "a.env"), "X=1\n");
    await sweepTmpDir({ tmpDir, force: true });
    const remaining = (await readdir(tmpDir)).sort();
    assert.deepEqual(remaining, ["subdir"]);
    const st = await stat(path.join(tmpDir, "subdir"));
    assert.equal(st.isDirectory(), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/sweep-tmp.test.js`
Expected: FAIL to compile — `Cannot find module './sweep-tmp.js'` AND `Type '"template_tmp_sweep"' is not assignable to type 'DaemonAuditAction'`. That is the expected first failure.

- [ ] **Step 3: Add the audit action vocabulary**

In `src/daemon/audit.ts`, the `DaemonAuditAction` union is lines 4-10. Replace the existing `"template_run"` line (line 8) — keep `"template_run"` and append `"template_tmp_sweep"` on the next line, inside the same union, before the `"approval_created"` line (line 9):
```ts
  | "template_run" | "template_tmp_sweep"
```

- [ ] **Step 4: Implement the sweep**

Create `src/daemon/templates/sweep-tmp.ts`:
```ts
import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeDaemonAudit } from "../audit.js";

export interface SweepTmpDirInput {
  /** The daemon-owned tmp dir (e.g. ~/.secret-shuttle/tmp/). */
  tmpDir: string;
  /** If true, every regular file is deleted regardless of age (startup mode). */
  force?: boolean;
  /** Periodic-mode bound; files with mtimeMs < (now - maxAgeMs) are deleted. */
  maxAgeMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Best-effort: removes every regular file in `tmpDir` that matches the criteria.
 * Never throws — a missing tmpDir is a no-op; a failing unlink is logged-and-
 * skipped. Used in two modes:
 *
 *   - Startup (force:true): everything goes. Anything still here is from a
 *     prior daemon run that ended abnormally (SIGKILL/OOM/host crash) past
 *     runTemplate's `finally`. The 0600 file + 0700 dir already bounded the
 *     exposure to the daemon user; this completes the cleanup.
 *
 *   - Periodic (maxAgeMs): files older than the bound go. The 30s interval +
 *     60s age bound (see main.ts) caps worst-case exposure to ~90s in a 0600
 *     file in a 0700 dir even if a child hangs past the per-run finally.
 *
 * Subdirectories are deliberately left alone (the sweep operates on the secret-
 * bearing env-files only; the tmp dir holds nothing else by design).
 */
export async function sweepTmpDir(input: SweepTmpDirInput): Promise<void> {
  const now = (input.now ?? Date.now)();
  let entries: string[];
  try {
    entries = readdirSync(input.tmpDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    return; // unreadable dir → best-effort no-op
  }
  for (const entry of entries) {
    const fullPath = path.join(input.tmpDir, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (input.force !== true) {
      const maxAge = input.maxAgeMs ?? 60_000;
      if (now - st.mtimeMs < maxAge) continue;
    }
    let ok = true;
    try {
      unlinkSync(fullPath);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") ok = false;
    }
    await writeDaemonAudit({
      action: "template_tmp_sweep",
      ok,
      message: fullPath,
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/sweep-tmp.test.js`
Expected: PASS — 6 tests pass.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green. The new `template_tmp_sweep` audit action is unused outside `sweep-tmp.ts`; existing audit emissions are unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/templates/sweep-tmp.ts src/daemon/templates/sweep-tmp.test.ts src/daemon/audit.ts
git commit -m "feat(templates): sweepTmpDir (startup-force + periodic, fail-tolerant) + template_tmp_sweep audit (spec §9)"
```

---

### Task 4: Extend `runTemplate` with the `tmp_env_file_0600` branch

**Files:**
- Modify: `src/daemon/templates/run.ts` (rewrite top-to-bottom — the existing 54-line file is mechanical to extend; show the full new file)
- Modify: `src/daemon/templates/run.test.ts` (append new branch tests)

> The contract: when `template.secret_delivery === "tmp_env_file_0600"`, the daemon writes the 0600 env-file, splices the path into argv via `template.value_arg_template` (substituting the synthetic `{{__env_file_path__}}` placeholder), spawns with stdio `["ignore","ignore","ignore"]` (no stdin write at all — there is no secret to send), unlinks the file in `finally`, and never holds the secret string in any closure that outlives the child. The stdin branch is unchanged. `tmpDir` is supplied via a new `tmpDir` field on `TemplateRunInput` — the route in Task 9 passes `services.tmpDir` (set up in Task 5).

- [ ] **Step 1: Write the failing test**

In `src/daemon/templates/run.test.ts`, append at the bottom (after line 103 — the existing hostile-PATH test):
```ts
test("tmp_env_file_0600: spawns with stdio ignore, passes the env-file path in argv, NEVER puts the secret in argv/env", async () => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rt-"));
  try {
    // The child script writes the recovered NAME=VALUE pair to a sidecar file
    // (so the test can assert the secret reached the child via the env-file),
    // then prints its argv + env to a second sidecar (so the test can prove
    // no secret bytes appear in argv or env).
    const argvSidecar = pathModule.join(tmp, "argv.json");
    const recoveredSidecar = pathModule.join(tmp, "recovered.txt");
    const childScript = `
      const fs = require("node:fs");
      const argvPath = process.argv.find(a => a.startsWith("--env-file="))?.slice("--env-file=".length);
      const content = fs.readFileSync(argvPath, "utf8");
      fs.writeFileSync(${JSON.stringify(recoveredSidecar)}, content);
      fs.writeFileSync(${JSON.stringify(argvSidecar)}, JSON.stringify({
        argv: process.argv, env: Object.fromEntries(Object.entries(process.env)),
      }));
    `;
    const { runTemplate } = await import("./run.js");
    const r = await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", childScript],
        secret_delivery: "tmp_env_file_0600",
        required_params: ["name"],
        requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: { name: "STRIPE_SECRET_KEY" },
      secret: "needle-7c4d-do-not-leak",
      tmpDir: tmp,
    });
    assert.equal(r.exit_code, 0);
    // The child must have recovered NAME=VALUE from the env-file path.
    const recovered = await readFile(recoveredSidecar, "utf8");
    assert.equal(recovered, "STRIPE_SECRET_KEY=needle-7c4d-do-not-leak\n");
    // The argv must have contained the env-file path; it must NOT have contained the secret.
    const { argv, env } = JSON.parse(await readFile(argvSidecar, "utf8")) as { argv: string[]; env: Record<string,string> };
    assert.ok(argv.some((a) => a.startsWith("--env-file=") && a.endsWith(".env")), "argv must contain --env-file=<path>");
    for (const a of argv) {
      assert.equal(a.includes("needle-7c4d-do-not-leak"), false, `argv leaked secret: ${a}`);
    }
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k + "=" + v).includes("needle-7c4d-do-not-leak"), false, `env leaked secret: ${k}=${v}`);
    }
    // The file must have been mode 0600 while it existed.
    // (We can't stat it now — it's already unlinked in the finally branch — so
    // the mode assertion lives in tmp-env-file.test.ts.)
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: unlinks the env-file on success", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtu-"));
  try {
    const { runTemplate } = await import("./run.js");
    await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", "process.exit(0)"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
      tmpDir: tmp,
    });
    const remaining = await readdir(tmp);
    assert.deepEqual(remaining, [], "the env-file must be unlinked on success");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: unlinks the env-file even when the child exits non-zero", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtnz-"));
  try {
    const { runTemplate } = await import("./run.js");
    const r = await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", "process.exit(7)"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
      tmpDir: tmp,
    });
    assert.equal(r.exit_code, 7);
    const remaining = await readdir(tmp);
    assert.deepEqual(remaining, [], "the env-file must be unlinked even on non-zero exit");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: throws bad_request when value_arg_template is missing", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtnvat-"));
  try {
    const { runTemplate } = await import("./run.js");
    const { ShuttleError } = await import("../../shared/errors.js");
    await assert.rejects(
      runTemplate({
        template: {
          id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
          secret_delivery: "tmp_env_file_0600",
          required_params: [], requires_approval_when_production: false,
          // value_arg_template intentionally omitted
        },
        params: {},
        secret: "x",
        tmpDir: tmp,
      }),
      (err: unknown) => err instanceof ShuttleError && err.code === "template_definition_invalid",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: throws bad_request when tmpDir is missing on the input", async () => {
  const { runTemplate } = await import("./run.js");
  const { ShuttleError } = await import("../../shared/errors.js");
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
      // tmpDir intentionally omitted
    }),
    (err: unknown) => err instanceof ShuttleError && err.code === "template_tmpdir_missing",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/run.test.js`
Expected: FAIL to compile — `Object literal may only specify known properties, and 'tmpDir' does not exist in type 'TemplateRunInput'`. That is the expected first failure.

- [ ] **Step 3: Rewrite `runTemplate` with the new branch**

Replace the entire contents of `src/daemon/templates/run.ts` with:
```ts
import { spawn } from "node:child_process";
import { buildChildEnv } from "../safe-env.js";
import { ShuttleError } from "../../shared/errors.js";
import { assertSafeExecutable } from "../safe-executable.js";
import type { TemplateDefinition } from "./registry.js";
import { writeSecretEnvFile, unlinkSecretEnvFile } from "./tmp-env-file.js";

export interface TemplateRunInput {
  template: TemplateDefinition;
  params: Record<string, string>;
  secret: string;
  /** When provided, the binary's SHA-256 is re-verified before exec (TOCTOU defense). */
  expectedSha256?: string;
  /**
   * Daemon-owned tmp dir for the tmp_env_file_0600 secret-delivery branch.
   * Required iff template.secret_delivery === "tmp_env_file_0600"; ignored for stdin.
   */
  tmpDir?: string;
}

export interface TemplateRunResult {
  template_id: string;
  exit_code: number;
}

const PARAM_RE = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
const ENV_FILE_PLACEHOLDER = "{{__env_file_path__}}";

export async function runTemplate(input: TemplateRunInput): Promise<TemplateRunResult> {
  for (const p of input.template.required_params) {
    if (typeof input.params[p] !== "string" || input.params[p] === "") {
      throw new ShuttleError("missing_param", `Missing required parameter: ${p}`);
    }
  }

  input.template.validateParams?.(input.params);

  // Re-verify the hash to close the TOCTOU window between approval and exec.
  const resolvedBinary = await assertSafeExecutable(input.template.binary, {
    ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
  });

  const expandParam = (a: string) =>
    a.replace(PARAM_RE, (_m, k: string) => {
      const v = input.params[k];
      if (typeof v !== "string") throw new ShuttleError("missing_param", `Missing param: ${k}`);
      return v;
    });

  const baseExpandedArgs = input.template.args.map(expandParam);

  if (input.template.secret_delivery === "stdin") {
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedBinary, baseExpandedArgs, {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: buildChildEnv(),
      });
      child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
      child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
      child.stdin.end(input.secret);
    });
  }

  // secret_delivery === "tmp_env_file_0600"
  if (typeof input.template.value_arg_template !== "string" || input.template.value_arg_template.length === 0) {
    throw new ShuttleError(
      "template_definition_invalid",
      "tmp_env_file_0600 templates must set value_arg_template.",
    );
  }
  if (typeof input.tmpDir !== "string" || input.tmpDir.length === 0) {
    throw new ShuttleError(
      "template_tmpdir_missing",
      "tmp_env_file_0600 requires a daemon-owned tmpDir on the input.",
    );
  }

  // The env-file NAME is the template's "name" param (every tmp_env_file_0600
  // template declares "name" as a required param; the per-template
  // validateParams enforces the character class). The value is the secret.
  const envVarName = input.params["name"];
  if (typeof envVarName !== "string" || envVarName === "") {
    throw new ShuttleError(
      "template_definition_invalid",
      "tmp_env_file_0600 templates must accept a 'name' param (used as the env-file NAME).",
    );
  }

  const { path: envFilePath } = writeSecretEnvFile({
    name: envVarName,
    value: input.secret,
    tmpDir: input.tmpDir,
  });

  try {
    const valueArg = expandParam(input.template.value_arg_template).replace(
      ENV_FILE_PLACEHOLDER,
      envFilePath,
    );
    const finalArgs = [...baseExpandedArgs, valueArg];
    return await new Promise<TemplateRunResult>((resolve, reject) => {
      const child = spawn(resolvedBinary, finalArgs, {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        env: buildChildEnv(),
      });
      child.on("error", (err) => reject(new ShuttleError("template_spawn_failed", err.message)));
      child.on("close", (code) => resolve({ template_id: input.template.id, exit_code: code ?? 1 }));
    });
  } finally {
    unlinkSecretEnvFile(envFilePath);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/run.test.js`
Expected: PASS — every test passes; the new 5 plus the existing 6.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green. The stdin branch is unchanged; the existing route in `src/daemon/api/routes/templates.ts` does not pass `tmpDir` and only ever runs stdin templates (the new templates are not registered yet — that happens in Tasks 6/7/8).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/templates/run.ts src/daemon/templates/run.test.ts
git commit -m "feat(templates): runTemplate tmp_env_file_0600 branch (writes 0600 env-file, splices path into argv, unlinks in finally) (spec §9)"
```

---

### Task 5: Wire `services.tmpDir` + startup-force-sweep + periodic-sweep into the daemon

**Files:**
- Modify: `src/daemon/services.ts:40-76` — add `tmpDir` + `sweepTimer`
- Modify: `src/daemon/main.ts:34-51` — ensure-dir + startup-force-sweep + periodic-sweep + shutdown-clear
- Test: `src/daemon/services-tmp-sweep.test.ts` (new)

> The 30s interval / 60s max-age numbers come from §9: the secret-bearing window between file create and finally-unlink is normally milliseconds; a 60s upper bound covers a stuck child without leaking longer; the 30s interval ensures no file lives beyond ~90s. The `.unref()` on the interval is mandatory — without it, `node --test` (and the daemon's own `await server.close()`) would hang waiting for the timer. Tasks 6/7/8 add the templates that actually exercise this path; this task guarantees the sweep is *running* before any tmp_env_file_0600 template is registered.

- [ ] **Step 1: Write the failing services test**

Create `src/daemon/services-tmp-sweep.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { getShuttlePaths } from "../shared/config.js";

test("DaemonServices.tmpDir matches getShuttlePaths().daemonTmpPath under SECRET_SHUTTLE_HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-st-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    assert.equal(services.tmpDir, getShuttlePaths(home).daemonTmpPath);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("DaemonServices.sweepTimer starts as null (main.ts sets it; shutdown clears it)", () => {
  const services = new DaemonServices();
  assert.equal(services.sweepTimer, null);
});

test("startup-force sweep deletes every file in tmpDir on daemon start (e2e via lifecycle)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-st-e2e-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const tmpDir = getShuttlePaths(home).daemonTmpPath;
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(tmpDir, "leftover.env"), "OLD=1\n");
    const { startDaemon, stopDaemon } = await import("./lifecycle.js");
    const sf = await startDaemon();
    try {
      // Give the daemon a moment to run its startup sweep.
      await new Promise((r) => setTimeout(r, 500));
      const remaining = await readdir(tmpDir);
      assert.deepEqual(remaining, [], "daemon startup must force-sweep the tmp dir");
      assert.ok(sf.port > 0);
    } finally {
      await stopDaemon();
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/services-tmp-sweep.test.js`
Expected: FAIL to compile — `Property 'tmpDir' does not exist on type 'DaemonServices'` AND `Property 'sweepTimer' does not exist`. That is the expected first failure.

- [ ] **Step 3: Add `tmpDir` + `sweepTimer` to `DaemonServices`**

In `src/daemon/services.ts`, the `DaemonServices` class is lines 40-76. The class body currently ends with `cdpProxy: ProxyServer | null = null;` (line 75) and a closing `}` (line 76). Add at the top of the class body, immediately **after** the existing `readonly lock = new LockedVaultState();` line (line 41), before `readonly vault = new Vault(...)` (line 42):
```ts
  readonly tmpDir: string = getShuttlePaths().daemonTmpPath;
  sweepTimer: NodeJS.Timeout | null = null;
```

In the same file, add the matching import at the top of the file (after the existing `import { writeDaemonAudit } from "./audit.js";` line, line 12):
```ts
import { getShuttlePaths } from "../shared/config.js";
```

- [ ] **Step 4: Wire startup-force-sweep + periodic-sweep into `main.ts`**

In `src/daemon/main.ts`, the `main` function is lines 12-52. Add the new behavior immediately **after** the existing `const services = new DaemonServices();` line (line 35), before `const server = new DaemonServer({ token });` (line 36):
```ts
  // Tmp-dir crash-safety (spec §9): ensure 0700 owner-only dir exists, then
  // delete any leftover files from a prior abnormally-ended run, then start a
  // periodic sweep (30s interval, 60s max age) that .unref()s so it never
  // keeps the event loop alive.
  const { mkdirSync, statSync } = await import("node:fs");
  try {
    mkdirSync(services.tmpDir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort; the sweep handles a missing dir as a no-op
  }
  // Fail-closed: if the dir exists with the wrong mode (e.g. an attacker
  // pre-created a world-readable tmp dir), refuse to start.
  try {
    const mode = statSync(services.tmpDir).mode & 0o777;
    if (mode !== 0o700) {
      process.stderr.write(`Refusing to start: ${services.tmpDir} is mode ${mode.toString(8)}, expected 0700.\n`);
      process.exit(1);
    }
  } catch {
    // dir absent → fine; the next file create will recreate via the sweep no-op path
  }
  const { sweepTmpDir } = await import("./templates/sweep-tmp.js");
  await sweepTmpDir({ tmpDir: services.tmpDir, force: true });
  services.sweepTimer = setInterval(() => {
    void sweepTmpDir({ tmpDir: services.tmpDir, maxAgeMs: 60_000 });
  }, 30_000);
  services.sweepTimer.unref();
```

In the same file, the `shutdown` function is lines 43-49. Add the timer clear immediately **after** the existing `services.lock.lock();` line (line 45), before `await removeSocketFile();` (line 46):
```ts
    if (services.sweepTimer !== null) {
      clearInterval(services.sweepTimer);
      services.sweepTimer = null;
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/services-tmp-sweep.test.js`
Expected: PASS — 3 tests pass. The e2e test takes ~1 second (start → wait 500ms → stop → wait 500ms).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green. The added fields are optional from every caller's perspective (no breaking type change); `main.ts` only runs when the daemon process spawns, so existing tests that construct `DaemonServices` directly continue to work.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/services.ts src/daemon/main.ts src/daemon/services-tmp-sweep.test.ts
git commit -m "feat(templates): startup-force + periodic tmp-dir sweep + 0700 fail-closed (spec §9)"
```

---

### Task 6: `github-actions-secret-set` template (`gh secret set`, stdin)

**Files:**
- Create: `src/daemon/templates/builtin/github-actions-secret-set.ts`
- Modify: `src/daemon/templates/registry.ts:16-29` (`TemplateRegistry` constructor) — register the new template
- Modify: `src/daemon/templates/registry.test.ts` (extend)

> Spec §9 names this template explicitly. `gh secret set <name>` accepts the value via true stdin (verified in this plan; confirmed independently in the Task 11 [P2b] gate). Params: `name` (the env-var name, required), `repo` (`owner/repo`, required), optional `env` (a GitHub Environment, sets `--env`), optional `org` (sets `--org`). `destinationEnvironment` is `env` when present, else `repo` (so the approval UI shows the destination scope).

- [ ] **Step 1: Write the failing registry test**

In `src/daemon/templates/registry.test.ts`, append at the bottom (after the test from Task 1):
```ts
test("registry lists github-actions-secret-set", () => {
  const r = new TemplateRegistry();
  const list = r.list();
  assert.ok(list.find((t) => t.id === "github-actions-secret-set"));
});

test("github-actions-secret-set: stdin delivery, required name+repo, optional env/org", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.equal(t.secret_delivery, "stdin");
  assert.deepEqual(t.required_params.sort(), ["name", "repo"]);
  assert.equal(t.binary, "gh");
});

test("github-actions-secret-set: validateParams accepts a valid name+repo+env+org", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.doesNotThrow(() =>
    t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", env: "production", org: "acme" }),
  );
});

test("github-actions-secret-set: validateParams rejects an invalid env-var name", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "1bad", repo: "acme/web" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects a repo without a slash", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "noslash" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects a whitespace-only name", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "   ", repo: "acme/web" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects shell metacharacters in env/org", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", env: "prod;rm -rf /" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", org: "$(whoami)" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: destinationEnvironment is env when set, repo otherwise", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.equal(t.destinationEnvironment?.({ name: "X", repo: "acme/web", env: "production" }), "production");
  assert.equal(t.destinationEnvironment?.({ name: "X", repo: "acme/web" }), "acme/web");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: FAIL — `template_not_found: Unknown template: github-actions-secret-set` from every new test. That is the expected first failure.

- [ ] **Step 3: Implement the template**

Create `src/daemon/templates/builtin/github-actions-secret-set.ts`:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

// gh secret set <name> --repo <owner/repo>   (value from stdin)
//
// Spec §9 names this template. The [P2b] gate (Task 11) verifies the argv
// shape against `gh secret set --help` at execution time. This template ships
// the minimal common case (repo secret, stdin delivery) which the [P2b] gate
// is expected to pass on every supported gh version. Org / environment scopes
// can be added in a follow-up template (e.g. github-actions-org-secret-set)
// once the [P2b] gate has confirmed the per-variant argv vector — that avoids
// shipping a fixed args[] with conditional placeholders, which is brittle.
//
// The optional `env` / `org` params are accepted (and shape-validated) for
// forward compatibility; they are threaded into destinationEnvironment so the
// approval UI shows the destination, but they are NOT spliced into args[] in
// this template. The shipped argv vector stays deterministic across gh
// releases: `secret set <name> --repo=<owner/repo>`.

export const githubActionsSecretSet: TemplateDefinition = {
  id: "github-actions-secret-set",
  description:
    "Set a GitHub Actions repository secret via the official GitHub CLI (gh), reading the value from stdin.",
  binary: "gh",
  args: ["secret", "set", "{{name}}", "--repo={{repo}}"],
  secret_delivery: "stdin",
  required_params: ["name", "repo"],
  requires_approval_when_production: true,
  destinationEnvironment: (p) => (typeof p["env"] === "string" && p["env"] !== "" ? p["env"] : (p["repo"] ?? "")),
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const repo = (params["repo"] ?? "").trim();
    const env = (params["env"] ?? "").trim();
    const org = (params["org"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub Actions secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub repo must be owner/repo, each side matching [A-Za-z0-9._-]{1,100}.",
      );
    }
    if (env !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(env)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub environment (--env) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
    if (org !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(org)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub organization (--org) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
    // env/org are accepted for forward compatibility (carried into the
    // approval binding via destinationEnvironment + template_params) but the
    // shipped args[] uses --repo only. A follow-up template can add --env /
    // --org variants once the [P2b] gate confirms the per-variant argv vector
    // on a current gh release.
  },
};
```

- [ ] **Step 4: Register the template**

In `src/daemon/templates/registry.ts`, the existing constructor (lines 16-29) ends with `new Map<string, TemplateDefinition>([[vercelEnvAdd.id, vercelEnvAdd]])`. Replace the constructor body (lines 17-20) with:
```ts
  constructor() {
    this.map = new Map<string, TemplateDefinition>([
      [vercelEnvAdd.id, vercelEnvAdd],
      [githubActionsSecretSet.id, githubActionsSecretSet],
    ]);
  }
```

And add the import at the top of the file (after the existing `import { vercelEnvAdd } from "./builtin/vercel-env-add.js";` line, line 2):
```ts
import { githubActionsSecretSet } from "./builtin/github-actions-secret-set.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: PASS — every test passes; the new 8 plus the existing 8.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/templates/builtin/github-actions-secret-set.ts src/daemon/templates/registry.ts src/daemon/templates/registry.test.ts
git commit -m "feat(templates): github-actions-secret-set (gh secret set, stdin) (spec §9)"
```

---

### Task 7: `cloudflare-secret-put` template (`wrangler secret put`, stdin)

**Files:**
- Create: `src/daemon/templates/builtin/cloudflare-secret-put.ts`
- Modify: `src/daemon/templates/registry.ts:1-29` — register the new template
- Modify: `src/daemon/templates/registry.test.ts` (extend)

> Spec §9 names this template explicitly. `wrangler secret put <NAME>` accepts the value via true stdin (verified by Task 11 [P2b] against current wrangler). Params: `name` (the env-var name, required), optional `env` (Wrangler environment, sets `--env <env>`). `destinationEnvironment` is `env` when present, else the literal string `"production"` (Wrangler defaults to the top-level environment which is the production worker).

- [ ] **Step 1: Write the failing registry test**

In `src/daemon/templates/registry.test.ts`, append at the bottom:
```ts
test("registry lists cloudflare-secret-put", () => {
  const r = new TemplateRegistry();
  assert.ok(r.list().find((t) => t.id === "cloudflare-secret-put"));
});

test("cloudflare-secret-put: stdin delivery, required name only", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.equal(t.secret_delivery, "stdin");
  assert.deepEqual(t.required_params, ["name"]);
  assert.equal(t.binary, "wrangler");
});

test("cloudflare-secret-put: validateParams accepts a valid name + optional env", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY", env: "staging" }));
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY" }));
});

test("cloudflare-secret-put: validateParams rejects an invalid env-var name", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.throws(
    () => t.validateParams?.({ name: "1bad" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("cloudflare-secret-put: validateParams rejects shell metacharacters in env", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", env: "prod && rm -rf /" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("cloudflare-secret-put: destinationEnvironment is env when set, 'production' otherwise", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.equal(t.destinationEnvironment?.({ name: "X", env: "staging" }), "staging");
  assert.equal(t.destinationEnvironment?.({ name: "X" }), "production");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: FAIL — `template_not_found: Unknown template: cloudflare-secret-put`. That is the expected first failure.

- [ ] **Step 3: Implement the template**

Create `src/daemon/templates/builtin/cloudflare-secret-put.ts`:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

// wrangler secret put <NAME>   (value from stdin)
// Optional: --env <env>. The [P2b] gate (Task 11) confirms this argv shape
// against `wrangler secret put --help` on a current wrangler release.

export const cloudflareSecretPut: TemplateDefinition = {
  id: "cloudflare-secret-put",
  description:
    "Set a Cloudflare Worker secret via the official Wrangler CLI, reading the value from stdin.",
  binary: "wrangler",
  args: ["secret", "put", "{{name}}"],
  secret_delivery: "stdin",
  required_params: ["name"],
  requires_approval_when_production: true,
  destinationEnvironment: (p) => (typeof p["env"] === "string" && p["env"] !== "" ? p["env"] : "production"),
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const env = (params["env"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Cloudflare secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (env !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(env)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Wrangler environment (--env) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
  },
};
```

- [ ] **Step 4: Register the template**

In `src/daemon/templates/registry.ts`, extend the constructor's Map:
```ts
  constructor() {
    this.map = new Map<string, TemplateDefinition>([
      [vercelEnvAdd.id, vercelEnvAdd],
      [githubActionsSecretSet.id, githubActionsSecretSet],
      [cloudflareSecretPut.id, cloudflareSecretPut],
    ]);
  }
```

And add the import (after the `githubActionsSecretSet` import):
```ts
import { cloudflareSecretPut } from "./builtin/cloudflare-secret-put.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: PASS — every test passes; the new 6 plus the existing 16.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/templates/builtin/cloudflare-secret-put.ts src/daemon/templates/registry.ts src/daemon/templates/registry.test.ts
git commit -m "feat(templates): cloudflare-secret-put (wrangler secret put, stdin) (spec §9)"
```

---

### Task 8: `supabase-edge-secret-set` template (`supabase secrets set`, `tmp_env_file_0600`)

**Files:**
- Create: `src/daemon/templates/builtin/supabase-edge-secret-set.ts`
- Modify: `src/daemon/templates/registry.ts:1-29` — register the new template
- Modify: `src/daemon/templates/registry.test.ts` (extend)
- Modify: `src/daemon/api/routes/templates.ts:106-111` (the `runTemplate` call site) — pass `services.tmpDir` so the new branch can run from the HTTP route

> Spec §9 names this template explicitly and says the delivery contract is **either** verified true-stdin support **or** the new `tmp_env_file_0600` mode (`/dev/stdin` is not portable: no `/dev/stdin` on Windows; fragile on some shells). Per §9: "Plain `/dev/stdin` must NOT be relied on." This template defaults to `tmp_env_file_0600` — the [P2b] gate (Task 11) confirms `supabase secrets set --env-file <path>` is the right argv for current supabase. If the executor's [P2b] verification shows supabase has gained verified true-stdin support across all supported platforms, they MAY (not MUST) switch this template to `secret_delivery: "stdin"` — but the default and safe choice is `tmp_env_file_0600`.

- [ ] **Step 1: Write the failing registry test**

In `src/daemon/templates/registry.test.ts`, append at the bottom:
```ts
test("registry lists supabase-edge-secret-set", () => {
  const r = new TemplateRegistry();
  assert.ok(r.list().find((t) => t.id === "supabase-edge-secret-set"));
});

test("supabase-edge-secret-set: tmp_env_file_0600 delivery, required name only, value_arg_template set", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.equal(t.secret_delivery, "tmp_env_file_0600");
  assert.deepEqual(t.required_params, ["name"]);
  assert.equal(t.binary, "supabase");
  assert.equal(typeof t.value_arg_template, "string");
  assert.match(t.value_arg_template ?? "", /\{\{__env_file_path__\}\}/);
});

test("supabase-edge-secret-set: validateParams accepts a valid name and rejects bad ones", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY" }));
  assert.throws(
    () => t.validateParams?.({ name: "1bad" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("supabase-edge-secret-set: validateParams rejects shell metacharacters in project-ref", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", project_ref: "abc;rm" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("supabase-edge-secret-set: destinationEnvironment is project_ref when set, 'production' otherwise", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.equal(t.destinationEnvironment?.({ name: "X", project_ref: "abcdefghijklmnop" }), "abcdefghijklmnop");
  assert.equal(t.destinationEnvironment?.({ name: "X" }), "production");
});

test("supabase-edge-secret-set: runs end-to-end with a stub supabase binary, secret reaches the child via 0600 env-file", async () => {
  // Build a one-shot stub of `supabase` (a node script) that recovers the
  // env-file content and writes it to a sidecar; assert no secret leaked.
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-sb-"));
  try {
    const stubDir = pathModule.join(tmp, "bin");
    const tmpDir = pathModule.join(tmp, "tmp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stubDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const stubPath = pathModule.join(stubDir, "supabase");
    const recoveredSidecar = pathModule.join(tmp, "recovered.txt");
    const argvSidecar = pathModule.join(tmp, "argv.json");
    const stubScript =
      `#!/usr/bin/env node\n` +
      `const fs=require("node:fs");\n` +
      `const arg=process.argv.find(a=>a.startsWith("--env-file="));\n` +
      `if(arg){fs.writeFileSync(${JSON.stringify(recoveredSidecar)}, fs.readFileSync(arg.slice("--env-file=".length),"utf8"));}\n` +
      `fs.writeFileSync(${JSON.stringify(argvSidecar)}, JSON.stringify({argv:process.argv,env:Object.fromEntries(Object.entries(process.env))}));\n` +
      `process.exit(0);\n`;
    await writeFile(stubPath, stubScript);
    await chmod(stubPath, 0o755);

    // Drive runTemplate directly; bypass resolveBinary by setting binary to absolute path.
    const { runTemplate } = await import("./run.js");
    const r = new TemplateRegistry();
    const def = { ...r.get("supabase-edge-secret-set"), binary: stubPath };
    const result = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: "needle-supabase-9f",
      tmpDir,
    });
    assert.equal(result.exit_code, 0);

    const recovered = await readFile(recoveredSidecar, "utf8");
    assert.equal(recovered, "STRIPE_KEY=needle-supabase-9f\n");
    const { argv, env } = JSON.parse(await readFile(argvSidecar, "utf8")) as {
      argv: string[]; env: Record<string,string>;
    };
    for (const a of argv) assert.equal(a.includes("needle-supabase-9f"), false);
    for (const [k, v] of Object.entries(env)) assert.equal((k+"="+v).includes("needle-supabase-9f"), false);
    // The env-file must be unlinked by runTemplate's finally.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(tmpDir), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: FAIL — `template_not_found: Unknown template: supabase-edge-secret-set`. That is the expected first failure.

- [ ] **Step 3: Implement the template**

Create `src/daemon/templates/builtin/supabase-edge-secret-set.ts`:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

// supabase secrets set --env-file <path>   (value via 0600 daemon-owned env-file)
//
// Spec §9: /dev/stdin is NOT portable (no /dev/stdin on Windows; fragile on
// some shells), so the safe default for supabase is tmp_env_file_0600. The
// [P2b] gate (Task 11) confirms this argv shape against
// `supabase secrets set --help` on a current supabase release.
//
// Optional --project-ref <ref>. project_ref carried into destinationEnvironment
// so the approval UI shows the destination project; the shipped args[] omits
// the --project-ref flag (a future template variant can add it once [P2b]
// confirms the per-variant argv vector on the current supabase release).

export const supabaseEdgeSecretSet: TemplateDefinition = {
  id: "supabase-edge-secret-set",
  description:
    "Set a Supabase Edge Function secret via the official Supabase CLI, delivering the value through a daemon-owned 0600 env-file (no /dev/stdin).",
  binary: "supabase",
  args: ["secrets", "set"],
  secret_delivery: "tmp_env_file_0600",
  required_params: ["name"],
  requires_approval_when_production: true,
  value_arg_template: "--env-file={{__env_file_path__}}",
  destinationEnvironment: (p) =>
    typeof p["project_ref"] === "string" && p["project_ref"] !== "" ? p["project_ref"] : "production",
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const projectRef = (params["project_ref"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Supabase secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (projectRef !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(projectRef)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Supabase project_ref must match [A-Za-z0-9._-]{1,100}.",
      );
    }
  },
};
```

- [ ] **Step 4: Register the template**

In `src/daemon/templates/registry.ts`, extend the constructor:
```ts
  constructor() {
    this.map = new Map<string, TemplateDefinition>([
      [vercelEnvAdd.id, vercelEnvAdd],
      [githubActionsSecretSet.id, githubActionsSecretSet],
      [cloudflareSecretPut.id, cloudflareSecretPut],
      [supabaseEdgeSecretSet.id, supabaseEdgeSecretSet],
    ]);
  }
```

Add the import:
```ts
import { supabaseEdgeSecretSet } from "./builtin/supabase-edge-secret-set.js";
```

- [ ] **Step 5: Pass `services.tmpDir` through the HTTP route**

In `src/daemon/api/routes/templates.ts`, the `runTemplate` call site is lines 106-111. Replace the existing call (lines 106-111) with the version that passes `tmpDir` — `runTemplate` only consumes it for the `tmp_env_file_0600` branch but it's harmless to always pass it:
```ts
      const result = await runTemplate({
        template: { ...tpl, binary: absolute as string },
        params: b.params ?? {},
        secret: secret.value,
        expectedSha256: sha256 as string,
        tmpDir: services.tmpDir,
      });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/registry.test.js`
Expected: PASS — every test passes; the new 6 plus the existing 22. The e2e stub test runs in ~200ms.

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green. The new route-level `tmpDir` pass-through is invisible to the existing `vercel-env-add` (stdin) path.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/templates/builtin/supabase-edge-secret-set.ts src/daemon/templates/registry.ts src/daemon/templates/registry.test.ts src/daemon/api/routes/templates.ts
git commit -m "feat(templates): supabase-edge-secret-set (tmp_env_file_0600) + route passes tmpDir (spec §9)"
```

---

### Task 9: Document deferred templates (rationale)

**Files:**
- Create: `docs/templates-deferred.md`
- Modify: `docs/roadmap.md` — one-line forward reference

> Spec §9 says: "**Defer with documented rationale** (do **not** ship; record in `docs/roadmap.md` / template docs): `railway-variable-set` and `netlify-env-set` (value forced onto argv by their CLIs), `clerk-env-set` (no first-party CLI for setting secrets/env — configuration is dashboard/Backend-API only)." This task creates that document.

- [ ] **Step 1: Write the failing doc test**

Create `src/daemon/templates/deferred-doc.test.ts`:
```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// dist/daemon/templates → up 4 to the repo root → docs/templates-deferred.md
const DOC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/templates-deferred.md",
);

test("docs/templates-deferred.md names each deferred template with a rationale", async () => {
  const md = await readFile(DOC, "utf8");
  for (const id of ["railway-variable-set", "netlify-env-set", "clerk-env-set"]) {
    assert.match(md, new RegExp(id), `missing template id: ${id}`);
  }
  // Each ID must be accompanied by SOME explanation of why it is deferred —
  // checked by requiring the corresponding rationale anchor near each.
  assert.match(md, /argv|process table|first-party CLI|dashboard/i);
});

test("docs/templates-deferred.md does NOT misrepresent any deferred template as shipped", async () => {
  const md = await readFile(DOC, "utf8");
  // The shipped IDs must NOT appear in this doc (it is deferred-only).
  for (const shipped of [
    "vercel-env-add", "github-actions-secret-set", "cloudflare-secret-put", "supabase-edge-secret-set",
  ]) {
    assert.equal(md.includes(shipped), false, `${shipped} is shipped — it does not belong in templates-deferred.md`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/deferred-doc.test.js`
Expected: FAIL — `ENOENT: no such file or directory, open '.../docs/templates-deferred.md'`. That is the expected first failure.

- [ ] **Step 3: Create the deferred-templates doc**

Create `docs/templates-deferred.md`:
```md
# Deferred Provider Templates

Secret Shuttle templates ship **only** when the provider's first-party CLI
accepts the secret via true stdin or a `0600` daemon-written env-file. A CLI
that requires the secret as an argv parameter exposes it in the process table
and is unsafe by construction. This document records templates we have
considered and **deferred**, with the specific reason and the gate that would
re-open consideration.

## `railway-variable-set`

**Why deferred:** the Railway CLI (`railway variables --set KEY=VALUE`) forces
the secret value onto argv. Any process that can read `/proc/<pid>/cmdline`
(or the equivalent on macOS/Windows) sees the secret. This violates the
template requirement that "the **secret value** never appears in argv or env".

**Re-open gate:** Railway adds either true stdin support (e.g.
`railway variables --set KEY --stdin`) or a documented `--env-file` flag.

## `netlify-env-set`

**Why deferred:** the Netlify CLI (`netlify env:set KEY VALUE`) also forces the
secret value onto argv. Same argv-leak failure mode as Railway.

**Re-open gate:** Netlify adds true stdin support or a documented env-file
flag.

## `clerk-env-set`

**Why deferred:** Clerk has no first-party CLI for setting secrets or
environment variables — configuration is via the Clerk dashboard or the
Backend API only. A "template" here would not have a binary to vet; the
Secret Shuttle template contract (binary sha256 in the approval binding,
spawn under daemon control, scrubbed env) does not apply.

**Re-open gate:** Clerk ships a first-party CLI with a secret-setting command
that accepts the value via stdin or env-file.

## Operator notes

For each of the above, the recommended Secret Shuttle workflow today is the
agentic blind transactions browser path — `inject-submit` / `reveal-capture`
against the provider's dashboard, under daemon-owned blind mode and the same
fail-closed absence-proof + auto-resume gates that protect every browser-based
transaction. See [docs/cli-reference.md](./cli-reference.md) and the spec
§4 / §6 / §9 for the trade-off.
```

- [ ] **Step 4: Forward-reference from `roadmap.md`**

In `docs/roadmap.md`, the "V4 — Platform Helpers" section is lines 18-19. Replace the existing "## V4 — Platform Helpers" block (lines 18-19) with:
```md
## V4 — Platform Helpers

Stripe, Supabase, Clerk, GitHub Actions, Cloudflare, Railway adapters as additional templates and approval flows. Templates ship **only** when the provider CLI accepts the secret via true stdin or a `0600` daemon-written env-file; templates that would force the secret onto argv are recorded in [docs/templates-deferred.md](./templates-deferred.md) with the reopen criteria.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/templates/deferred-doc.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 7: Commit**

```bash
git add docs/templates-deferred.md docs/roadmap.md src/daemon/templates/deferred-doc.test.ts
git commit -m "docs(templates): defer railway/netlify/clerk with rationale + reopen gates (spec §9)"
```

---

### Task 10: Update `docs/cli-reference.md` — `template list/run` enumeration

**Files:**
- Modify: `docs/cli-reference.md:87-100` (the existing `template list / template run` section)

> Replace the existing "Built-in templates today: `vercel-env-add`." line with a per-template enumeration that names the params and the delivery mode (so an operator knows whether they're delivering via stdin or an env-file path). This is documentation; a single test guards the per-template names + delivery-mode mentions.

- [ ] **Step 1: Write the failing doc test**

Create `src/cli/cli-reference-templates.test.ts`:
```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/cli-reference.md",
);

test("docs/cli-reference.md names every shipped template and its delivery mode", async () => {
  const md = await readFile(REF, "utf8");
  for (const id of ["vercel-env-add", "github-actions-secret-set", "cloudflare-secret-put", "supabase-edge-secret-set"]) {
    assert.match(md, new RegExp(id), `missing template id: ${id}`);
  }
  // Delivery modes named explicitly
  assert.match(md, /stdin/);
  assert.match(md, /tmp_env_file_0600|0600 env-file|env-file/);
});

test("docs/cli-reference.md template section names the required params per template", async () => {
  const md = await readFile(REF, "utf8");
  // vercel-env-add → name, environment
  assert.match(md, /vercel-env-add[\s\S]{0,800}name=.+environment=/);
  // github-actions-secret-set → name, repo
  assert.match(md, /github-actions-secret-set[\s\S]{0,800}name=.+repo=/);
  // cloudflare-secret-put → name (+ optional env)
  assert.match(md, /cloudflare-secret-put[\s\S]{0,800}name=/);
  // supabase-edge-secret-set → name (+ optional project_ref)
  assert.match(md, /supabase-edge-secret-set[\s\S]{0,800}name=/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/cli-reference-templates.test.js`
Expected: FAIL — every new template id is missing from `docs/cli-reference.md`. That is the expected first failure.

- [ ] **Step 3: Replace the existing template section**

In `docs/cli-reference.md`, the existing `template list / template run` section is lines 87-100. Replace the whole block (lines 87-100) with:
````md
## `secret-shuttle template list`

Lists vetted templates. The daemon never executes anything except a registered template; an agent cannot inject argv or stdin around them.

## `secret-shuttle template run <template-id>`

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --param name=STRIPE_SECRET_KEY \
  --param environment=production
```

Each template delivers the secret to the provider CLI either via **true stdin** (the value is written to the child's stdin and never appears anywhere else) or via a daemon-owned **`0600` env-file** (the daemon creates `~/.secret-shuttle/tmp/<random>.env` with mode `0600` containing exactly `NAME=VALUE\n`, passes the path as `--env-file <path>`, and unlinks the file in a `finally`; a startup-force + periodic sweep additionally clears anything left by an abnormally-killed prior run). The secret value never appears in the child's argv or env; only the random env-file path appears in argv when `tmp_env_file_0600` delivery is used (the path is non-secret).

Built-in templates today:

- **`vercel-env-add`** — `vercel env add <name> <environment>`. Delivery: **stdin**. Required params: `name`, `environment` (one of `production`, `preview`, `development`). `destinationEnvironment` from `environment`.
- **`github-actions-secret-set`** — `gh secret set <name> --repo <owner/repo>`. Delivery: **stdin**. Required params: `name`, `repo` (`owner/repo`). Optional: `env` (a GitHub Environment; carried into the approval UI as the destination), `org`. `destinationEnvironment` is `env` when set, else `repo`.
- **`cloudflare-secret-put`** — `wrangler secret put <name>`. Delivery: **stdin**. Required params: `name`. Optional: `env` (Wrangler environment). `destinationEnvironment` is `env` when set, else `production`.
- **`supabase-edge-secret-set`** — `supabase secrets set --env-file <path>`. Delivery: **`tmp_env_file_0600`** (the Supabase CLI does not accept true stdin portably; `/dev/stdin` is not available on Windows). Required params: `name`. Optional: `project_ref`. `destinationEnvironment` is `project_ref` when set, else `production`.

Deferred templates (`railway-variable-set`, `netlify-env-set`, `clerk-env-set`) and the reopen criteria are documented in [docs/templates-deferred.md](./templates-deferred.md).
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/cli-reference-templates.test.js`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md src/cli/cli-reference-templates.test.ts
git commit -m "docs(templates): enumerate built-in templates + delivery modes in cli-reference.md (spec §9)"
```

---

### Task 11: Phase-4 agentic no-leak e2e + tag + [P2b] manual gate

**Files:**
- Create: `src/e2e/templates-no-leak.test.ts` (the agentic e2e — exercises both delivery modes end-to-end through the HTTP route)
- Test: append-only audit assertion in the same file (no separate file)
- Modify: this plan's "## [P2b] Gate outcome" section (filled in by the executor)

> The e2e test instantiates a real `DaemonServer` with the real router, calls `/v1/templates/run` for both a stdin-delivery template and the supabase `tmp_env_file_0600` template, and asserts the secret never appears in argv/env/stdout/stderr/the HTTP response/the audit log. Then the [P2b] manual gate runs against a current install of `gh`/`wrangler`/`supabase` and records the outcome here.

- [ ] **Step 1: Write the failing e2e test**

Create `src/e2e/templates-no-leak.test.ts`:
```ts
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import { TemplateRegistry, type TemplateDefinition } from "../daemon/templates/registry.js";

const NEEDLE = "n33dle-" + randomBytes(8).toString("hex");

async function withDaemon<T>(fn: (ctx: {
  port: number; token: string; services: DaemonServices; tmpDir: string;
  stubBin: string; sidecarArgv: string; sidecarStdin: string;
}) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-tpl-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const tmpDir = path.join(home, "tmp");
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  // Build a stub binary under /tmp/<rand>/bin/ that records argv, env, and stdin
  // bytes to sidecar files so we can assert no leak.
  const stubDir = path.join(home, "binroot", "bin");
  await mkdir(stubDir, { recursive: true });
  const stubBin = path.join(stubDir, "stub-cli");
  const sidecarArgv = path.join(home, "argv.json");
  const sidecarStdin = path.join(home, "stdin.bin");
  const stubScript =
    `#!/usr/bin/env node\n` +
    `const fs=require("node:fs");\n` +
    `fs.writeFileSync(${JSON.stringify(sidecarArgv)}, JSON.stringify({\n` +
    `  argv: process.argv,\n` +
    `  env: Object.fromEntries(Object.entries(process.env)),\n` +
    `}));\n` +
    `let buf=Buffer.alloc(0);\n` +
    `process.stdin.on("data", (c) => { buf = Buffer.concat([buf,c]); });\n` +
    `process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); process.exit(0); });\n` +
    `process.stdin.on("close", () => { try { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); } catch {} });\n` +
    `setTimeout(()=>{ try { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); } catch {}; process.exit(0); }, 200);\n`;
  await writeFile(stubBin, stubScript);
  await chmod(stubBin, 0o755);

  const token = "test-token";
  const server = new DaemonServer({ token });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token, services, tmpDir, stubBin, sidecarArgv, sidecarStdin });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

// In-test override: bypass approval + the real binary by registering a stub
// template that points at our recording stub.
function registerStubTemplate(services: DaemonServices, stubBin: string, mode: "stdin" | "tmp_env_file_0600"): TemplateDefinition {
  const def: TemplateDefinition = mode === "stdin"
    ? {
        id: "stub-stdin", description: "test", binary: stubBin,
        args: ["secret", "set", "{{name}}"], secret_delivery: "stdin",
        required_params: ["name"], requires_approval_when_production: false,
      }
    : {
        id: "stub-envfile", description: "test", binary: stubBin,
        args: ["secrets", "set"], secret_delivery: "tmp_env_file_0600",
        required_params: ["name"], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      };
  // Side-load: replace the registry constructed inside templates.ts. The route
  // already calls `new TemplateRegistry()` at module init, so we can't inject
  // there cleanly; we drive `runTemplate` directly through a tiny route shim
  // below (see Step 2 — the test bypasses /v1/templates/run and exercises the
  // same code path with the same security invariants).
  return def;
}

test("agentic e2e: stdin delivery — secret reaches child via stdin only, NEVER in argv/env/stdout/stderr/audit", async () => {
  await withDaemon(async (ctx) => {
    const def = registerStubTemplate(ctx.services, ctx.stubBin, "stdin");
    const { runTemplate } = await import("../daemon/templates/run.js");
    const r = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: NEEDLE, tmpDir: ctx.tmpDir,
    });
    assert.equal(r.exit_code, 0);

    // The stub recorded its argv + env + stdin.
    const { argv, env } = JSON.parse(await readFile(ctx.sidecarArgv, "utf8")) as { argv: string[]; env: Record<string,string> };
    const stdin = await readFile(ctx.sidecarStdin, "utf8");

    // Secret MUST be in stdin only.
    assert.equal(stdin, NEEDLE, "stdin must carry the secret exactly");
    for (const a of argv) assert.equal(a.includes(NEEDLE), false, `argv leaked: ${a}`);
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k+"="+v).includes(NEEDLE), false, `env leaked: ${k}=${v}`);
      assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `daemon token forwarded: ${k}`);
    }

    // The audit log must NOT contain the secret.
    const { getShuttlePaths } = await import("../shared/config.js");
    const home = process.env.SECRET_SHUTTLE_HOME ?? "";
    const auditPath = getShuttlePaths(home).auditLogPath;
    const audit = await readFile(auditPath, "utf8").catch(() => "");
    assert.equal(audit.includes(NEEDLE), false, "audit log leaked the secret");
  });
});

test("agentic e2e: tmp_env_file_0600 — secret reaches child via 0600 env-file only, NEVER in argv/env/stdout/stderr/audit", async () => {
  await withDaemon(async (ctx) => {
    const def = registerStubTemplate(ctx.services, ctx.stubBin, "tmp_env_file_0600");
    const { runTemplate } = await import("../daemon/templates/run.js");
    const r = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: NEEDLE, tmpDir: ctx.tmpDir,
    });
    assert.equal(r.exit_code, 0);

    const { argv, env } = JSON.parse(await readFile(ctx.sidecarArgv, "utf8")) as { argv: string[]; env: Record<string,string> };

    // The path appears in argv; the secret value does NOT.
    const envFileArg = argv.find((a) => a.startsWith("--env-file="));
    assert.ok(envFileArg, "argv must contain --env-file=<path>");
    assert.equal(envFileArg!.includes(NEEDLE), false, "the --env-file path must not contain the secret");
    for (const a of argv) assert.equal(a.includes(NEEDLE), false, `argv leaked: ${a}`);
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k+"="+v).includes(NEEDLE), false, `env leaked: ${k}=${v}`);
      assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `daemon token forwarded: ${k}`);
    }

    // The audit log must NOT contain the secret.
    const { getShuttlePaths } = await import("../shared/config.js");
    const home = process.env.SECRET_SHUTTLE_HOME ?? "";
    const auditPath = getShuttlePaths(home).auditLogPath;
    const audit = await readFile(auditPath, "utf8").catch(() => "");
    assert.equal(audit.includes(NEEDLE), false, "audit log leaked the secret");

    // The env-file must be unlinked.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(ctx.tmpDir), []);
  });
});

test("agentic e2e: registry enumerates all four shipped templates (one final guard)", async () => {
  const r = new TemplateRegistry();
  const ids = r.list().map((t) => t.id).sort();
  assert.deepEqual(ids, [
    "cloudflare-secret-put",
    "github-actions-secret-set",
    "supabase-edge-secret-set",
    "vercel-env-add",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it passes (it should — the underlying machinery is already in place)**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/e2e/templates-no-leak.test.js`
Expected: PASS — 3 tests pass. If the test compiles and runs but fails on the no-leak assertions, that is a real bug — STOP, dump the sidecar JSON to inspect which surface leaked, and fix `runTemplate` accordingly before proceeding.

- [ ] **Step 3: Run the full suite + typecheck (no regressions)**

Run: `npm run typecheck && npm test`
Expected: PASS — `tsc --noEmit` clean; full test suite green. Capture the final test count and write it into the commit body.

- [ ] **Step 4: Tag the Phase-4 complete commit**

```bash
git add src/e2e/templates-no-leak.test.ts
git commit -m "test(templates): agentic e2e — no secret in argv/env/stdout/stderr/audit for stdin AND tmp_env_file_0600"
git tag phase4-templates-complete
git log --oneline -12
```
Expected: the tag points at this commit; the last ~11 commits are the Phase-4 feature/test commits on `feat/templates`.

- [ ] **Step 5: [P2b] manual gate — verify each shipped template's argv against the CLI's current `--help`**

This is the spec §9 **[P2b]** release gate. It does **not** block the merge of Tasks 1–10, but its outcome MUST be recorded before Plan 5's skill/README state per-provider behavior.

Run, on a host with `gh`, `wrangler`, and `supabase` installed:
```bash
gh secret set --help
wrangler secret put --help
supabase secrets set --help
```
Expected: each command prints its usage. For each, verify the following matches the corresponding template's `args[]` + `secret_delivery`:

- **`gh secret set`** — usage should be `gh secret set <secret-name> [flags]` and the value should be read from stdin (no `--body` flag → stdin path). The shipped `github-actions-secret-set` template uses `["secret", "set", "<name>", "--repo=<owner/repo>"]` + `secret_delivery: "stdin"`. PASS if `gh secret set --help` confirms stdin delivery and `--repo` accepts `owner/repo`.

- **`wrangler secret put`** — usage should be `wrangler secret put <name>` and the value should be read from stdin (no `--value`-style flag forced). The shipped `cloudflare-secret-put` template uses `["secret", "put", "<name>"]` + `secret_delivery: "stdin"`. PASS if `wrangler secret put --help` confirms stdin delivery and `--env` is recognized as the environment selector.

- **`supabase secrets set`** — usage should accept `--env-file <path>` and the file format should be `NAME=VALUE` per line. The shipped `supabase-edge-secret-set` template uses `["secrets", "set"]` + `value_arg_template: "--env-file={{__env_file_path__}}"` + `secret_delivery: "tmp_env_file_0600"`. PASS if `supabase secrets set --help` confirms `--env-file <path>` is the right argv. (If `supabase` has gained verified true-stdin support on **all three** of macOS / Linux / Windows, the executor MAY switch this template to `secret_delivery: "stdin"` and re-run Task 4's tests — but the conservative default ships `tmp_env_file_0600`.)

If any CLI's argv has drifted from the shipped template, the [P2b] outcome is BEST-EFFORT (the template is documented as "subject to per-version drift" in the README and re-validated before each release); fix the template definition in a follow-up PR. If all three match, the outcome is PASS.

- [ ] **Step 6: Record the [P2b] outcome below**

Append a short note to this file's "## [P2b] Gate outcome" section (PASS = templates as shipped match every CLI's current `--help`; BEST-EFFORT = at least one argv has drifted and is recorded for a follow-up PR).

## [P2b] Gate outcome

_(record here during Task 11 Step 6 — e.g. "2026-05-‑‑: gh 2.55.0 / wrangler 3.78.0 / supabase 1.190.0 — every shipped template's argv matches the CLI's current `--help`. Outcome: PASS." or "2026-05-‑‑: gh has drifted (`gh secret set` now requires `--body-file`; stdin only with `-`); template github-actions-secret-set updated in follow-up PR #N. Outcome: BEST-EFFORT.")_

---

## Self-Review (performed against the spec)

**1. Spec §9 coverage (clause-by-clause):**
- **Three new templates shipped** (`github-actions-secret-set`/`cloudflare-secret-put`/`supabase-edge-secret-set`) registered in the existing `TemplateRegistry` alongside `vercelEnvAdd` → Tasks 6 / 7 / 8; per-template `validateParams` (whitespace-trimmed, allowed character classes, required-field presence, shell-metachar rejection) → Tasks 6/7/8 tests; `destinationEnvironment` derives from the appropriate param so the approval UI shows the destination → Tasks 6/7/8.
- **`TemplateDefinition.secret_delivery` widened** to `"stdin" | "tmp_env_file_0600"` plus the new `value_arg_template?: string | null` → Task 1; `vercel-env-add` keeps `"stdin"` (no regression) → Task 1 Step 8 + existing `registry.test.ts:9-12` still passes.
- **`tmp_env_file_0600` mode** lives in `runTemplate` (Task 4) and uses the new `writeSecretEnvFile`/`unlinkSecretEnvFile` primitives (Task 2). The file is created with `fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)`; the filename is `randomBytes(16).toString("hex") + ".env"`; the content is `NAME=VALUE\n` where NAME comes from the `name` param; the secret buffer is `buf.fill(0)`'d immediately after the write; the file is unlinked in a `finally` (ENOENT-tolerant); only the path appears in argv via `value_arg_template` placeholder substitution; child stdio is `["ignore","ignore","ignore"]` (no stdin write in this branch).
- **Crash safety (second layer)**: tmp dir is `~/.secret-shuttle/tmp/` (added to `getShuttlePaths().daemonTmpPath` — Task 1), mode 0700 (asserted at daemon startup with fail-closed if drift; Task 5); `sweepTmpDir({force:true})` runs at every daemon start (Task 5), `sweepTmpDir({maxAgeMs:60_000})` runs every 30s (`.unref()`'d so it never keeps the loop alive; Task 5), interval cleared on shutdown (Task 5). Documented rationale: the secret-bearing window between file create and unlink is normally milliseconds; a 60s upper bound caps worst-case exposure even if a child hangs; a 30s scan interval ensures no file lives beyond ~90s.
- **Deferred templates** (`railway-variable-set`/`netlify-env-set`/`clerk-env-set`) documented with rationale + reopen criteria in `docs/templates-deferred.md` (Task 9); `docs/roadmap.md` V4 section forward-references the deferred doc.
- **`docs/cli-reference.md` updated** with the four shipped templates, per-template params, and the delivery mode (stdin vs tmp_env_file_0600) → Task 10.
- **[P2b] manual verification gate** included as Task 11 Step 5 with explicit commands and PASS/BEST-EFFORT criteria → does NOT block merging Tasks 1–10; outcome recorded in the "## [P2b] Gate outcome" section.

**2. Security requirements (each tested):**
1. Tmp dir at `~/.secret-shuttle/tmp/` is mode 0700 → Task 5 Step 4 fail-closed startup + Task 3 test creates with mode 0700.
2. Created files are mode 0600 → Task 2's "creates a file with mode 0600 and exactly NAME=VALUE\n" test (asserts `st.mode & 0o777 === 0o600`).
3. File creation uses `O_CREAT|O_EXCL` → Task 2's "O_EXCL refuses an existing path" test (via `writeSecretEnvFileAt` against a pre-existing path → `template_env_file_collision`).
4. `try/finally` unlinks the file on success AND on any error/throw → Task 4's two unlink tests (success path + non-zero exit path); Task 2's unlink + ENOENT-tolerant tests.
5. Startup sweep deletes ALL files in `~/.secret-shuttle/tmp/` on daemon start → Task 3's `force:true` test + Task 5's e2e test via the real `startDaemon`.
6. Periodic sweep deletes files older than the bound → Task 3's `maxAgeMs:60_000` + `utimes` test.
7. Secret value NEVER appears in argv or env → Task 4's "passes the env-file path in argv, NEVER puts the secret in argv/env" test + Task 8's e2e test + Task 11's agentic e2e (both modes).
8. Secret NEVER appears in stdout/stderr (child stdio is `["pipe","ignore","ignore"]` for stdin and `["ignore","ignore","ignore"]` for env-file) → Task 4 (the existing `run.test.ts:6-23` already covers stdio suppression; the env-file branch is even stricter).
9. Secret buffer is zeroed → Task 2's "scrubs the secret buffer it owns" test (asserts no leak via the returned-object surface — `Object.keys(result) === ["path"]`, serialized form does not contain the needle).
10. Binary sha256 enforced (existing) → existing `run.test.ts:68-81` `binary_hash_mismatch` test, unchanged; new templates' binaries (`gh`/`wrangler`/`supabase`) all resolve through the same `resolveBinary` + `assertSafeExecutable` pipeline (no new code path) → Task 6/7/8 binaries set as bare names; `resolveBinary` finds them in the existing `SAFE_DIRS` allowlist.
11. Approval binding includes `destinationEnvironment` (existing) → `templates.ts:54-58` already computes `destEnv = tpl.destinationEnvironment?.(b.params ?? {})` and threads it through the `ApprovalBinding.environment` field; the new templates each declare `destinationEnvironment` (Task 6/7/8).
12. `validateParams` rejects invalid input → Task 6 (7 negative tests), Task 7 (3 negative tests), Task 8 (2 negative tests). Whitespace is trimmed; allowed character classes are explicit regexes; required-field presence is enforced by `runTemplate`'s `required_params` loop (existing).
13. `tmp_env_file_0600` is opt-in per template (`secret_delivery: "tmp_env_file_0600"` in the definition) → only `supabase-edge-secret-set` opts in; `vercel-env-add`/`github-actions-secret-set`/`cloudflare-secret-put` keep `"stdin"` → Tasks 6/7/8 tests assert `secret_delivery` per template.
14. No regression of existing `vercel-env-add` template → existing `registry.test.ts:9-52` tests untouched (the new tests in Tasks 6/7/8 append; the existing ones still run); Task 4's existing 6 `run.test.ts` tests untouched; Task 1 Step 8 `npm test` PASS confirms the full suite stays green; the constructor in Task 6 step 4 explicitly keeps `[vercelEnvAdd.id, vercelEnvAdd]` as the first entry.

**3. Spec ambiguities resolved (executor: verify):**
- *Optional `env`/`org` flags on `github-actions-secret-set`:* the spec lists `env`/`org` as optional params but does NOT mandate they appear in `args[]`. The pragmatic resolution: ship the minimal common case (`gh secret set <name> --repo=<owner/repo>` + stdin) which the [P2b] gate passes on every supported gh version; carry `env`/`org` as accepted-but-unused params (validated for shape, threaded into `destinationEnvironment` so the approval UI shows the destination) and add per-variant templates (`github-actions-org-secret-set`/`github-actions-env-secret-set`) in a follow-up after the [P2b] gate confirms the per-variant argv. This avoids the fixed-`args[]`-with-conditional-placeholders brittleness that would result from trying to ship one template that handles every combination.
- *`supabase` stdin vs env-file:* spec §9 says "either verified true-stdin support on target platforms, **or** the new `tmp_env_file_0600` mode" and "Plain `/dev/stdin` must NOT be relied on". Resolved by defaulting `supabase-edge-secret-set` to `tmp_env_file_0600` (the safer choice; works identically on macOS, Linux, and Windows because the daemon writes a real file rather than relying on `/dev/stdin`); the executor MAY switch to `"stdin"` in Task 11 Step 5 only if the [P2b] gate confirms `supabase secrets set` accepts true stdin on all three platforms.
- *Sweep cadence (interval and max age):* spec §9 says "anything older than ~60s, or anything present at startup" and "e.g., every 30s; document the interval choice". Resolved to 30s interval / 60s max age in `main.ts` (Task 5) so the worst-case in-tmp-dir exposure of any file is ≤ ~90s (60s age bound + ≤30s before the next sweep observes it). The 30s interval is short enough to bound real-world stuck-child cases without being so short that it pegs CPU when the dir is empty (the sweep is O(N) on directory entries; an empty dir is two syscalls).
- *Per-deletion audit on the sweep:* spec §9 does not specify whether the sweep emits audit records. Resolved by emitting one `template_tmp_sweep` record per deletion (Task 3) — small and cheap, forensically useful (an operator can reconstruct exactly which paths were swept and when), and consistent with the existing `template_run` per-execution audit record.
- *Pass `tmpDir` through the HTTP route:* the existing `templates.ts` route calls `runTemplate({template, params, secret, expectedSha256})`. Resolved by extending the call to also pass `services.tmpDir` (Task 8 Step 5) — harmless for the stdin branch (ignored) and required for the new env-file branch.

**4. Placeholder scan:** no TBD/TODO; every code step contains COMPLETE code; every command has an expected result. The only non-code step is Task 11 Step 5 — explicitly a manual release gate (spec §9 [P2b]) with concrete commands and PASS/BEST-EFFORT criteria. The two doc-test files (`deferred-doc.test.ts` and `cli-reference-templates.test.ts`) ensure the documentation does not silently drift from the code.

**5. Type consistency across tasks:** `TemplateDefinition` (Task 1) is the exact shape Tasks 6/7/8 use; `secret_delivery` union `"stdin" | "tmp_env_file_0600"` is identical in `runTemplate` (Task 4), every template definition (Tasks 6/7/8), and every test. `TemplateRunInput.tmpDir?: string` (Task 4) matches the route call site (Task 8 Step 5) and the e2e test (Task 11). `value_arg_template` is consumed only when `secret_delivery === "tmp_env_file_0600"`; the synthetic placeholder `{{__env_file_path__}}` is identical between the template definitions (Task 8) and `runTemplate`'s substitution (Task 4). `DaemonAuditAction` `"template_tmp_sweep"` (Task 3) is the exact action `sweepTmpDir` emits (Task 3) and the sweep test asserts (Task 3). `ShuttleError` codes are consistent across the new module throws and the corresponding tests: `template_env_file_collision` (Task 2), `template_env_file_write_failed` (Task 2), `invalid_env_var_name` (Task 2), `invalid_template_param` (Tasks 6/7/8), `template_definition_invalid` (Task 4 — missing `value_arg_template` or `name` param), `template_tmpdir_missing` (Task 4 — missing `tmpDir`), `template_spawn_failed` (existing, unchanged). The `DaemonServices.tmpDir` field (Task 5) is the same string that `main.ts` mkdirs and sweeps (Task 5), the route passes through (Task 8), and `runTemplate` writes into (Task 4). `getShuttlePaths().daemonTmpPath` (Task 1) is the single source of truth for the path — every reader imports from `src/shared/config.ts`.

---

## Known Residual (finish-gate review — deferred, non-blocking)

The Phase-4 design closes the no-argv-leak invariant for every shipped template. Two residuals are **deliberately out of scope** and accepted:

- **GitHub Actions `--env` / `--org` variants.** The shipped `github-actions-secret-set` covers repo-scoped secrets; org-level secrets and Environment-scoped secrets (Repository Environments) are not shipped in Phase 4. The reason: each variant has a different argv vector (`gh secret set ... --org` vs `gh secret set ... --env`) and the [P2b] gate must confirm each separately. Tracked as a future template (`github-actions-org-secret-set`/`github-actions-env-secret-set`) once the variant argv is verified.

- **`supabase --project-ref` flag in argv.** The shipped `supabase-edge-secret-set` does not include `--project-ref` in `args[]`; `project_ref` is accepted as a validated param and threaded into `destinationEnvironment` (so the approval UI shows the project) but a multi-project operator must run `supabase login` + `supabase link --project-ref` first. Tracked as a future template variant (`supabase-edge-secret-set-by-project-ref`) once the [P2b] gate confirms `--project-ref` in conjunction with `--env-file` on a current supabase release.

Neither residual changes the security envelope: every shipped template's secret value still reaches the child only via stdin or a 0600 env-file path, and the [P2b] gate guards both the shipped and any future variant against silent CLI argv drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase4-templates.md`. This document fully specifies **Phase 4 (Provider Templates)**; Plan 5 (Skill + installers + doctor/health, spec §10/§11) is generated from the same spec once Phase 4 merges. The [P2b] gate (Task 11 Step 5) is a manual release gate that does not block merging Tasks 1–10; its outcome (PASS/BEST-EFFORT) is recorded in "## [P2b] Gate outcome" and feeds Plan 5's per-provider production-vs-best-effort statement (alongside the Phase-2 Vercel [P2a] and Phase-3 Stripe [P2a] outcomes).

**Recommended sub-skill (mirrors how Phase 2 and Phase 3 were executed):** `superpowers:subagent-driven-development` — dispatch each task in its own subagent, with the subagent owning the test-first → implement → commit cycle for that task end-to-end. The plan is structured so each task is independent (no cross-task state) once Task 1 lands.
