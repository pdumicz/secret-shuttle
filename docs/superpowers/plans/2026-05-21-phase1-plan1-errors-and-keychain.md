# Phase 1 — Plan 1: Foundation (Structured Errors + macOS Keychain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-cutting foundation that every later Phase 1 plan depends on — structured error shape with `hint` + standardized exit codes, plus an OS keychain abstraction (macOS implementation; Linux + Windows stubbed for now).

**Architecture:** Two independent, parallel-shippable changes wired into existing infrastructure. (1) Extend `ShuttleError` and `errorToJson` to emit `{ ok: false, error: { code, message }, hint, exit_code }` — the legacy `error: { code, message }` block is preserved for backward compatibility; new fields are top-level additions. Default behavior comes from a central registry (`src/shared/error-codes.ts`) keyed by `code`. (2) New `src/vault/keychain/` module with a platform dispatcher and a working `security`-CLI adapter on macOS. Linux/Windows adapters are stubs that throw a typed error with a recovery hint — letting later plans wire in `init` without blocking on full cross-platform support.

**Tech Stack:** TypeScript (existing); Node 20+ (existing); `child_process.spawn` for the macOS `security` CLI; `node:test` (existing test runner).

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) §5.6, §5.1, §3.4.

**Sequence with other Phase 1 plans:**

- **Plan 1 (this):** Foundation — errors + macOS keychain.
- **Plan 2:** CLI surface — `secrets` group + `status` (rename of `doctor`) + `internal` namespace + help text refactor. Depends on Plan 1.
- **Plan 3:** `run` + `inject` commands (new daemon endpoints + spawner). Depends on Plan 1.
- **Plan 4:** Pre-approved sessions (approvals/session module + UI). Depends on Plan 1.
- **Plan 5:** `init` rewrite (interactive setup) + Linux/Windows keychain + docs (SKILL.md, walkthrough, README) + npm publish 0.2.0. Depends on Plans 1–4.

---

## File Structure

**Files to create:**
- `src/shared/error-codes.ts` — central registry mapping error code → `{ exitCode, hintFor(message): string|null }`.
- `src/shared/error-codes.test.ts` — registry lookup + defaults for unknown codes.
- `src/shared/errors.test.ts` — new shape, hint propagation, exit code propagation, backward-compat shape preservation.
- `src/vault/keychain/types.ts` — `KeychainAdapter` interface.
- `src/vault/keychain/index.ts` — platform dispatcher, exports `getKeychainAdapter()`.
- `src/vault/keychain/index.test.ts` — dispatcher selects correct adapter for current platform.
- `src/vault/keychain/darwin.ts` — macOS `security`-CLI adapter (`set`, `get`, `delete`).
- `src/vault/keychain/darwin.test.ts` — round-trip set/get/delete with a unique test service name; skip when not on macOS.
- `src/vault/keychain/linux.ts` — stub throws `keychain_not_implemented`.
- `src/vault/keychain/windows.ts` — stub throws `keychain_not_implemented`.

**Files to modify:**
- `src/shared/errors.ts` — extend `ShuttleError` (accept `opts` with `exitCode`/`hint`, default from registry); extend `errorToJson` (emit new shape).
- `src/cli/index.ts` — update error printer (lines 53–58) to emit new shape and exit with `error.exitCode`.

---

## Part A — Structured Errors

### Task A1: Add `hint` field to ShuttleError + opts-based constructor

**Files:**
- Create: `src/shared/errors.test.ts`
- Modify: `src/shared/errors.ts:1-11`

- [ ] **Step 1: Write the failing test**

Create `src/shared/errors.test.ts` with this content:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ShuttleError } from "./errors.js";

test("ShuttleError exposes code, exitCode, and hint", () => {
  const err = new ShuttleError("some_code", "Some message", { exitCode: 3, hint: "Run: foo" });
  assert.equal(err.code, "some_code");
  assert.equal(err.exitCode, 3);
  assert.equal(err.hint, "Run: foo");
  assert.equal(err.message, "Some message");
});

test("ShuttleError opts default to null hint and exitCode 1", () => {
  const err = new ShuttleError("some_code", "Some message");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, null);
});

test("ShuttleError backward-compatible positional exitCode still works", () => {
  // Old call sites use: new ShuttleError(code, message, 2)
  const err = new ShuttleError("some_code", "Some message", 2);
  assert.equal(err.exitCode, 2);
  assert.equal(err.hint, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: FAIL — tests reference `err.hint` which doesn't exist yet.

- [ ] **Step 3: Implement — extend ShuttleError to accept opts**

Edit `src/shared/errors.ts`, replace the existing class with:

```typescript
export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;

  constructor(
    code: string,
    message: string,
    optsOrExitCode: ShuttleErrorOpts | number = {},
  ) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;
    if (typeof optsOrExitCode === "number") {
      // Backward-compat: callers still using `new ShuttleError(code, message, 2)`.
      this.exitCode = optsOrExitCode;
      this.hint = null;
    } else {
      this.exitCode = optsOrExitCode.exitCode ?? 1;
      this.hint = optsOrExitCode.hint ?? null;
    }
  }
}
```

Keep the rest of the file (`assertCondition`, `errorToJson`) untouched — they're updated in later tasks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/shared/errors.test.ts
git commit -m "feat(errors): add hint field to ShuttleError with opts-based constructor"
```

---

### Task A2: Create the error-codes registry

**Files:**
- Create: `src/shared/error-codes.ts`
- Create: `src/shared/error-codes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/error-codes.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupErrorCode, EXIT_CODE_SUCCESS, EXIT_CODE_TRANSIENT, EXIT_CODE_USAGE, EXIT_CODE_NOT_FOUND, EXIT_CODE_PERMISSION, EXIT_CODE_CONFLICT } from "./error-codes.js";

test("EXIT_CODE constants follow Sol convention", () => {
  assert.equal(EXIT_CODE_SUCCESS, 0);
  assert.equal(EXIT_CODE_TRANSIENT, 1);
  assert.equal(EXIT_CODE_USAGE, 2);
  assert.equal(EXIT_CODE_NOT_FOUND, 3);
  assert.equal(EXIT_CODE_PERMISSION, 4);
  assert.equal(EXIT_CODE_CONFLICT, 5);
});

test("registry maps daemon_not_running to transient with hint", () => {
  const entry = lookupErrorCode("daemon_not_running");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint("anything"), "Run: secret-shuttle daemon start");
});

test("registry maps invalid_ref to usage error, null hint", () => {
  const entry = lookupErrorCode("invalid_ref");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
  assert.equal(entry.hint("anything"), null);
});

test("registry maps approval_denied to permission, null hint", () => {
  const entry = lookupErrorCode("approval_denied");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), null);
});

test("unknown codes return null from lookup", () => {
  const entry = lookupErrorCode("totally_made_up_code");
  assert.equal(entry, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/shared/error-codes.test.js"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the registry**

Create `src/shared/error-codes.ts`:

```typescript
// Exit code policy per Sol/Memori convention. See spec §5.6.
export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_TRANSIENT = 1;   // retry-safe (network, daemon temporarily down)
export const EXIT_CODE_USAGE = 2;       // bad argv / missing required flag
export const EXIT_CODE_NOT_FOUND = 3;   // ref / template / file missing
export const EXIT_CODE_PERMISSION = 4;  // approval denied / vault locked / domain not allowed
export const EXIT_CODE_CONFLICT = 5;    // ref already exists / rotating

export type ErrorCodeEntry = {
  exitCode: number;
  /**
   * Build a hint string given the error's runtime message. Return null if no
   * actionable recovery command exists (the human has to intervene).
   */
  hint: (message: string) => string | null;
};

// Codes are added incrementally as later plans touch each command. This
// initial set covers the most common control-plane errors; the audit of all
// 204 ShuttleError throw sites happens in Plans 2–5 as each command is
// touched.
const REGISTRY: Record<string, ErrorCodeEntry> = {
  // Transient — retry-safe
  daemon_not_running: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start",
  },
  daemon_request_failed: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle status (then retry)",
  },

  // Usage errors — fix argv, don't retry
  invalid_ref: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  invalid_argument: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  missing_required_param: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  missing_allow_domain: {
    exitCode: EXIT_CODE_USAGE,
    hint: () => "Add: --allow-domain <domain>",
  },
  unsupported_target: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  unsupported_source: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  bad_kind: { exitCode: EXIT_CODE_USAGE, hint: () => null },

  // Not found
  ref_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  template_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  no_legacy_vault: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  agent_target_unknown: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },

  // Permission / blocked
  vault_unlock_failed: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Run: secret-shuttle internal unlock",
  },
  vault_locked: {
    exitCode: EXIT_CODE_PERMISSION,
    hint: () => "Run: secret-shuttle internal unlock",
  },
  approval_denied: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  domain_not_allowed: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  unsupported_envelope: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  passphrase_mismatch: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
  blind_mode_required: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },

  // Conflict
  already_migrated: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  ref_already_exists: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  snippet_ambiguous: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },

  // Keychain (added now; full use comes in Part B + Plan 5)
  keychain_not_implemented: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock via: secret-shuttle internal unlock",
  },
  keychain_unavailable: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock via: secret-shuttle internal unlock",
  },
};

export function lookupErrorCode(code: string): ErrorCodeEntry | null {
  return REGISTRY[code] ?? null;
}

export function listKnownErrorCodes(): string[] {
  return Object.keys(REGISTRY).sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test "dist/shared/error-codes.test.js"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(errors): central error-codes registry with exit-code policy"
```

---

### Task A3: Wire registry into ShuttleError defaults

**Files:**
- Modify: `src/shared/errors.ts` (the constructor from Task A1)
- Modify: `src/shared/errors.test.ts` (add registry-default test)

- [ ] **Step 1: Add a failing test for registry-driven defaults**

Append to `src/shared/errors.test.ts`:

```typescript
test("ShuttleError defaults exitCode and hint from registry when known code", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, "Run: secret-shuttle daemon start");
});

test("ShuttleError uses registry exitCode but explicit hint when both supplied", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running", {
    hint: "Custom recovery instruction",
  });
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, "Custom recovery instruction");
});

test("ShuttleError unknown code falls back to exitCode 1 / null hint", () => {
  const err = new ShuttleError("totally_unknown", "huh");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: 3 new tests FAIL — `err.hint` is null where registry would say `"Run: secret-shuttle daemon start"`.

- [ ] **Step 3: Implement — read registry in constructor**

Edit `src/shared/errors.ts` to import the registry and use it as the default:

```typescript
import { lookupErrorCode } from "./error-codes.js";

export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;

  constructor(
    code: string,
    message: string,
    optsOrExitCode: ShuttleErrorOpts | number = {},
  ) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;

    const registry = lookupErrorCode(code);
    const registryExitCode = registry?.exitCode ?? 1;
    const registryHint = registry?.hint(message) ?? null;

    if (typeof optsOrExitCode === "number") {
      // Backward-compat positional form: explicit exitCode wins; hint from registry.
      this.exitCode = optsOrExitCode;
      this.hint = registryHint;
    } else {
      this.exitCode = optsOrExitCode.exitCode ?? registryExitCode;
      this.hint = optsOrExitCode.hint ?? registryHint;
    }
  }
}
```

Keep `assertCondition` and `errorToJson` untouched here — `errorToJson` is updated in Task A4.

- [ ] **Step 4: Run all error tests to verify they pass**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: PASS (6 tests total — 3 from A1 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/shared/errors.test.ts
git commit -m "feat(errors): ShuttleError reads defaults from error-codes registry"
```

---

### Task A4: Extend `errorToJson` to emit the new shape

**Files:**
- Modify: `src/shared/errors.ts` (the `errorToJson` function)
- Modify: `src/shared/errors.test.ts` (add output-shape tests)

- [ ] **Step 1: Add failing tests for output shape**

Append to `src/shared/errors.test.ts`:

```typescript
import { errorToJson } from "./errors.js";

test("errorToJson on ShuttleError emits legacy + new fields", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err);
  // Legacy fields preserved:
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "daemon_not_running", message: "Daemon not running" });
  // New top-level fields:
  assert.equal(j.hint, "Run: secret-shuttle daemon start");
  assert.equal(j.exit_code, 1);
});

test("errorToJson on ShuttleError with null hint emits hint: null", () => {
  const err = new ShuttleError("invalid_ref", "Bad ref");
  const j = errorToJson(err);
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 2);
});

test("errorToJson on plain Error emits unexpected_error with no hint", () => {
  const j = errorToJson(new Error("oh no"));
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "oh no" });
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});

test("errorToJson on non-Error emits unexpected_error with default message", () => {
  const j = errorToJson("string thrown");
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "Unknown error" });
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: 4 new tests FAIL — `j.hint` and `j.exit_code` undefined.

- [ ] **Step 3: Implement — update `errorToJson`**

In `src/shared/errors.ts`, replace the `errorToJson` function (and keep `assertCondition` as is):

```typescript
export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ShuttleError(code, message);
  }
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof ShuttleError) {
    return {
      ok: false,
      // Legacy shape — preserved for callers parsing { error: { code, message } }.
      error: { code: error.code, message: error.message },
      // New top-level fields per spec §5.6.
      hint: error.hint,
      exit_code: error.exitCode,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: { code: "unexpected_error", message: error.message },
      hint: null,
      exit_code: 1,
    };
  }

  return {
    ok: false,
    error: { code: "unexpected_error", message: "Unknown error" },
    hint: null,
    exit_code: 1,
  };
}
```

- [ ] **Step 4: Run all error tests to verify they pass**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: PASS (10 tests total — 6 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/shared/errors.test.ts
git commit -m "feat(errors): errorToJson emits hint + exit_code (preserves legacy error block)"
```

---

### Task A5: Update CLI error printer to use new shape + exit code

**Files:**
- Modify: `src/cli/index.ts:53-58`

- [ ] **Step 1: Read the current error printer**

Verify lines 53–58 of `src/cli/index.ts` look like this (open the file and confirm; do NOT edit yet):

```typescript
try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorToJson(error), null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
```

The current code already uses `error.exitCode` — good. But the printer emits `errorToJson(error)` which after Task A4 already has the new shape. So the printer needs no logic change; it just needs to be verified against an end-to-end test.

- [ ] **Step 2: Add an end-to-end CLI error test**

Note: there's no current root-level CLI test harness. Add a smoke test that imports the error path and verifies the full output shape.

Append a new file `src/cli/error-printer.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ShuttleError, errorToJson } from "../shared/errors.js";

test("CLI error path: ShuttleError with registry-known code emits full shape", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err);

  // What stderr will print:
  const printed = JSON.stringify(j, null, 2);
  const parsed = JSON.parse(printed);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "daemon_not_running");
  assert.equal(parsed.error.message, "Daemon not running");
  assert.equal(parsed.hint, "Run: secret-shuttle daemon start");
  assert.equal(parsed.exit_code, 1);
});

test("CLI error path: ShuttleError exit code propagates via .exitCode", () => {
  const err = new ShuttleError("approval_denied", "User denied");
  // process.exitCode would be set to err.exitCode in src/cli/index.ts:57
  assert.equal(err.exitCode, 4);
});
```

- [ ] **Step 3: Run test**

Run: `npm run build && node --test "dist/cli/error-printer.test.js"`
Expected: PASS (2 tests).

- [ ] **Step 4: Run the full test suite to verify nothing else broke**

Run: `npm test`
Expected: ALL PASS. If any prior test relied on the OLD `{ ok: false, error: { code, message } }` shape *only* (no other top-level fields), it will still pass because `error` is preserved. If a test asserts the entire object equals the old shape, it'll fail — fix by either adding `hint`/`exit_code` to the assertion or asserting only the legacy fields.

- [ ] **Step 5: Commit**

```bash
git add src/cli/error-printer.test.ts
git commit -m "test(cli): verify error printer emits new shape with hint + exit_code"
```

---

## Part B — macOS Keychain Adapter

### Task B1: Define KeychainAdapter interface

**Files:**
- Create: `src/vault/keychain/types.ts`

- [ ] **Step 1: Define the interface**

Create `src/vault/keychain/types.ts`:

```typescript
/**
 * Adapter interface for OS-level secret storage.
 *
 * Each platform implements this against its native keyring:
 *  - macOS:  `security` CLI → login keychain
 *  - Linux:  `secret-tool` CLI → libsecret
 *  - Windows: PowerShell wincred shim
 *
 * Keys are namespaced by (service, account). For Secret Shuttle's master key,
 * we use service = "secret-shuttle" and account = the daemon's unique vault id
 * (so multiple Secret Shuttle vaults don't collide on one machine).
 */
export interface KeychainAdapter {
  /** Returns true if the underlying keychain is reachable on this machine. */
  isAvailable(): Promise<boolean>;

  /**
   * Store `secret` under (service, account). Overwrites if present.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  set(service: string, account: string, secret: Buffer): Promise<void>;

  /**
   * Retrieve the secret under (service, account). Returns null if not found.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  get(service: string, account: string): Promise<Buffer | null>;

  /**
   * Delete the secret under (service, account). No-op if not present.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  delete(service: string, account: string): Promise<void>;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/vault/keychain/types.ts
git commit -m "feat(keychain): KeychainAdapter interface for OS-level secret storage"
```

---

### Task B2: Implement macOS adapter using `security` CLI

**Files:**
- Create: `src/vault/keychain/darwin.ts`
- Create: `src/vault/keychain/darwin.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/keychain/darwin.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DarwinKeychain } from "./darwin.js";

const SUPPORTED = process.platform === "darwin";
const SERVICE = "secret-shuttle-test";
const ACCOUNT = `test-${process.pid}-${Date.now()}`;

const skipReason = SUPPORTED ? null : "darwin keychain only";

test("DarwinKeychain isAvailable returns true on macOS", { skip: skipReason }, async () => {
  const kc = new DarwinKeychain();
  assert.equal(await kc.isAvailable(), true);
});

test("DarwinKeychain round-trip set → get → delete", { skip: skipReason }, async () => {
  const kc = new DarwinKeychain();
  const payload = Buffer.from("hello world 🌍   bytes", "utf8");

  await kc.set(SERVICE, ACCOUNT, payload);
  const got = await kc.get(SERVICE, ACCOUNT);
  assert.ok(got, "get should return a buffer");
  assert.equal(Buffer.compare(got!, payload), 0, "round-tripped bytes should match");

  await kc.delete(SERVICE, ACCOUNT);
  const after = await kc.get(SERVICE, ACCOUNT);
  assert.equal(after, null, "deleted entry returns null");
});

test("DarwinKeychain get returns null for missing entry", { skip: skipReason }, async () => {
  const kc = new DarwinKeychain();
  const got = await kc.get(SERVICE, `missing-${process.pid}-${Date.now()}`);
  assert.equal(got, null);
});

test("DarwinKeychain set overwrites existing entry", { skip: skipReason }, async () => {
  const kc = new DarwinKeychain();
  const acct = `overwrite-${process.pid}-${Date.now()}`;
  await kc.set(SERVICE, acct, Buffer.from("first"));
  await kc.set(SERVICE, acct, Buffer.from("second"));
  const got = await kc.get(SERVICE, acct);
  assert.equal(got?.toString("utf8"), "second");
  await kc.delete(SERVICE, acct);
});

after(async () => {
  if (!SUPPORTED) return;
  // Best-effort cleanup of all known test accounts.
  const kc = new DarwinKeychain();
  await kc.delete(SERVICE, ACCOUNT).catch(() => undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/vault/keychain/darwin.test.js"`
Expected: FAIL — `DarwinKeychain` not exported.

- [ ] **Step 3: Implement the macOS adapter**

Create `src/vault/keychain/darwin.ts`:

```typescript
import { spawn } from "node:child_process";
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * macOS Keychain adapter using the bundled `security` CLI.
 *
 * Storage:
 *   security add-generic-password -s <service> -a <account> -w <pw> -U
 *   security find-generic-password -s <service> -a <account> -w
 *   security delete-generic-password -s <service> -a <account>
 *
 * Secret bytes are base64-encoded before storage to handle arbitrary binary
 * (the -w flag accepts arbitrary strings but multi-byte NUL handling is
 * dicey).
 */
export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    const exit = await run("security", ["-h"]);
    return exit.code === 0 || exit.code === 1; // -h often exits non-zero but proves the binary works
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    if (process.platform !== "darwin") {
      throw new ShuttleError("keychain_unavailable", "Darwin keychain only available on macOS");
    }
    const encoded = secret.toString("base64");
    const exit = await run("security", [
      "add-generic-password",
      "-s", service,
      "-a", account,
      "-w", encoded,
      "-U", // update if exists
    ]);
    if (exit.code !== 0) {
      throw new ShuttleError(
        "keychain_unavailable",
        `security add-generic-password exited with code ${exit.code}: ${exit.stderr.trim()}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    if (process.platform !== "darwin") {
      throw new ShuttleError("keychain_unavailable", "Darwin keychain only available on macOS");
    }
    const exit = await run("security", [
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ]);
    if (exit.code === 44 /* errSecItemNotFound */ || /could not be found/i.test(exit.stderr)) {
      return null;
    }
    if (exit.code !== 0) {
      throw new ShuttleError(
        "keychain_unavailable",
        `security find-generic-password exited with code ${exit.code}: ${exit.stderr.trim()}`,
      );
    }
    return Buffer.from(exit.stdout.trim(), "base64");
  }

  async delete(service: string, account: string): Promise<void> {
    if (process.platform !== "darwin") {
      throw new ShuttleError("keychain_unavailable", "Darwin keychain only available on macOS");
    }
    const exit = await run("security", [
      "delete-generic-password",
      "-s", service,
      "-a", account,
    ]);
    if (exit.code === 44 || /could not be found/i.test(exit.stderr)) {
      return; // no-op
    }
    if (exit.code !== 0) {
      throw new ShuttleError(
        "keychain_unavailable",
        `security delete-generic-password exited with code ${exit.code}: ${exit.stderr.trim()}`,
      );
    }
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.on("error", () => {
      resolve({ code: 127, stdout: "", stderr: "spawn failed" });
    });
  });
}
```

Note on `-U` flag: this updates the existing entry instead of failing if present. Avoids needing a separate `update` codepath.

Note on base64: macOS `security` CLI's `-w` flag returns the password on stdout for `find-generic-password`. Encoding as base64 sidesteps any NUL / multi-byte issues.

- [ ] **Step 4: Run tests to verify they pass on macOS**

Run: `npm run build && node --test "dist/vault/keychain/darwin.test.js"`
Expected: PASS (4 tests on macOS, 4 SKIPPED on other platforms).

**Manual verification on macOS:** after the test runs, the test cleanup should have removed entries. To confirm no leftovers:
```bash
security find-generic-password -s secret-shuttle-test
```
Expected output: `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.`

If any leftover entries exist (test crashed mid-run), clean manually:
```bash
security delete-generic-password -s secret-shuttle-test
```

- [ ] **Step 5: Commit**

```bash
git add src/vault/keychain/darwin.ts src/vault/keychain/darwin.test.ts
git commit -m "feat(keychain): macOS adapter via security CLI (base64-encoded payload)"
```

---

### Task B3: Stub Linux and Windows adapters

**Files:**
- Create: `src/vault/keychain/linux.ts`
- Create: `src/vault/keychain/windows.ts`

These are stubs that throw `keychain_not_implemented` — Plan 5 will replace them with `secret-tool` (Linux) and `wincred` (Windows) implementations. Until then, init falls back to passphrase unlock on those platforms (the registry hint will guide the user).

- [ ] **Step 1: Implement Linux stub**

Create `src/vault/keychain/linux.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * Linux keychain adapter — placeholder.
 *
 * Plan 5 will replace this with a secret-tool (libsecret) implementation.
 * Until then, init falls back to passphrase unlock on Linux.
 */
export class LinuxKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5)",
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5)",
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5)",
    );
  }
}
```

- [ ] **Step 2: Implement Windows stub**

Create `src/vault/keychain/windows.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * Windows keychain adapter — placeholder.
 *
 * Plan 5 will replace this with a PowerShell wincred shim implementation.
 * Until then, init falls back to passphrase unlock on Windows.
 */
export class WindowsKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Windows keychain adapter not yet implemented (planned for Plan 5)",
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Windows keychain adapter not yet implemented (planned for Plan 5)",
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Windows keychain adapter not yet implemented (planned for Plan 5)",
    );
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/vault/keychain/linux.ts src/vault/keychain/windows.ts
git commit -m "feat(keychain): Linux + Windows adapter stubs (full impls in Plan 5)"
```

---

### Task B4: Platform dispatcher

**Files:**
- Create: `src/vault/keychain/index.ts`
- Create: `src/vault/keychain/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/vault/keychain/index.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { getKeychainAdapter } from "./index.js";
import { DarwinKeychain } from "./darwin.js";
import { LinuxKeychain } from "./linux.js";
import { WindowsKeychain } from "./windows.js";

test("getKeychainAdapter returns DarwinKeychain on darwin", { skip: process.platform !== "darwin" ? "not darwin" : null }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof DarwinKeychain);
});

test("getKeychainAdapter returns LinuxKeychain on linux", { skip: process.platform !== "linux" ? "not linux" : null }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof LinuxKeychain);
});

test("getKeychainAdapter returns WindowsKeychain on win32", { skip: process.platform !== "win32" ? "not win32" : null }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof WindowsKeychain);
});

test("getKeychainAdapter respects platform override", () => {
  const dk = getKeychainAdapter({ platformOverride: "darwin" });
  assert.ok(dk instanceof DarwinKeychain);
  const lk = getKeychainAdapter({ platformOverride: "linux" });
  assert.ok(lk instanceof LinuxKeychain);
  const wk = getKeychainAdapter({ platformOverride: "win32" });
  assert.ok(wk instanceof WindowsKeychain);
});

test("getKeychainAdapter on unsupported platform falls back to stub-style adapter", () => {
  const adapter = getKeychainAdapter({ platformOverride: "freebsd" as NodeJS.Platform });
  // Should be a stub-shaped adapter (isAvailable returns false). We don't
  // require a specific class — just that it implements the interface and
  // refuses operations.
  assert.equal(typeof adapter.isAvailable, "function");
  assert.equal(typeof adapter.set, "function");
  assert.equal(typeof adapter.get, "function");
  assert.equal(typeof adapter.delete, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/vault/keychain/index.test.js"`
Expected: FAIL — `getKeychainAdapter` not exported.

- [ ] **Step 3: Implement the dispatcher**

Create `src/vault/keychain/index.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";
import { DarwinKeychain } from "./darwin.js";
import { LinuxKeychain } from "./linux.js";
import { WindowsKeychain } from "./windows.js";

export type { KeychainAdapter } from "./types.js";

export type GetKeychainOptions = {
  /** Override the detected platform — used in tests. */
  platformOverride?: NodeJS.Platform;
};

/**
 * Return the platform-appropriate keychain adapter.
 *
 * On supported platforms (darwin, linux, win32), returns a concrete adapter
 * — note Linux and Windows are stubs until Plan 5.
 *
 * On unsupported platforms, returns an UnsupportedKeychain that mirrors the
 * stub behavior (isAvailable → false; ops throw keychain_not_implemented).
 */
export function getKeychainAdapter(opts: GetKeychainOptions = {}): KeychainAdapter {
  const platform = opts.platformOverride ?? process.platform;
  switch (platform) {
    case "darwin":
      return new DarwinKeychain();
    case "linux":
      return new LinuxKeychain();
    case "win32":
      return new WindowsKeychain();
    default:
      return new UnsupportedKeychain(platform);
  }
}

class UnsupportedKeychain implements KeychainAdapter {
  constructor(private readonly platform: string) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test "dist/vault/keychain/index.test.js"`
Expected: PASS (5 tests; 3 of the platform-specific ones SKIPPED depending on host).

- [ ] **Step 5: Commit**

```bash
git add src/vault/keychain/index.ts src/vault/keychain/index.test.ts
git commit -m "feat(keychain): platform dispatcher with override for tests"
```

---

## Part C — Verification & Plan-Level Integration

### Task C1: Full test suite passes

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: All tests pass (existing tests + new ones).

If any existing test fails:
- If it's because of the new error shape (`hint` / `exit_code` added), update the assertion to expect the new fields or `assert.partialDeepEqual` only the legacy fields.
- If it's something else, stop and investigate. The new code should be additive only.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run pack check**

Run: `npm run check-pack`
Expected: PASS — verifies the published package would include the new files.

---

### Task C2: Update CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (create if missing)

- [ ] **Step 1: Append a top entry**

If `CHANGELOG.md` doesn't exist, create it. Add this at the top:

```markdown
# Changelog

## Unreleased

### Added
- Structured error shape: every CLI error now includes `hint` (literal recovery command, or null) and `exit_code` (0/1/2/3/4/5 per Sol convention) as top-level fields alongside the legacy `error: { code, message }` block. Exit codes follow industry convention: 1 transient, 2 usage, 3 not-found, 4 permission, 5 conflict.
- `src/shared/error-codes.ts` central registry mapping ~25 known error codes to their exit code and hint generator.
- `src/vault/keychain/` module: pluggable OS-keychain adapter interface with a working macOS implementation (via the bundled `security` CLI). Linux and Windows stubs throw a typed `keychain_not_implemented` error with a passphrase-fallback hint; full implementations land in Plan 5.

### Changed
- `ShuttleError` constructor now accepts an `opts` object (`{ exitCode, hint }`) in addition to the legacy positional `exitCode` number. Existing call sites continue to work unchanged.
- `errorToJson` output now includes `hint` and `exit_code` at top level. The legacy `error: { code, message }` block is preserved.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): foundation pass — structured errors + macOS keychain"
```

---

## Self-Review

**1. Spec coverage**

Reviewing spec §5.6 (Structured errors) and §5.1/§3.4 (keychain abstraction):

- ✅ `ShuttleError` extended with `hint` + `exitCode` (Task A1)
- ✅ Central registry `src/shared/error-codes.ts` with code → {exitCode, hintGenerator} (Task A2)
- ✅ `errorToJson` emits new shape (Task A4) — top-level `hint` + `exit_code`, legacy `error: { code, message }` preserved
- ✅ CLI error printer uses new shape + sets exit code (Task A5 — minimal change, existing code already used `error.exitCode`)
- ✅ Exit code policy 0/1/2/3/4/5 with named constants (Task A2)
- ✅ Keychain abstraction (Task B1)
- ✅ macOS implementation (Task B2)
- ✅ Linux + Windows stubs with typed error (Task B3)
- ✅ Platform dispatcher with override for tests (Task B4)
- ✅ CHANGELOG entry (Task C2)

**Audit of all 204 `throw new ShuttleError` sites:** explicitly deferred to Plans 2–5 (noted in Task A2 and in the plan header). The registry's default behavior (unknown code → exit code 1, null hint) means existing throw sites work unchanged; this plan only adds the *infrastructure* for richer errors. Each subsequent plan audits the throw sites in the files it touches.

**Backward-compat check:** the spec text in §5.6 has a small ambiguity (the `StructuredError` TypeScript type shows `error: string` but the prose says backward-compat preserves `error: { code, message }`). This plan resolves it in favor of backward-compat: `error` stays a nested object; `hint` and `exit_code` are net-new top-level siblings. Any existing client reading `result.error.code` continues to work.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "Similar to Task N", or "add appropriate X". Every code block is complete. Every command shows expected output.

**3. Type consistency**

- `KeychainAdapter` interface members (`isAvailable`, `set`, `get`, `delete`) — match exactly across `types.ts` (Task B1), `darwin.ts` (B2), `linux.ts`/`windows.ts` (B3), `index.ts` (B4), and all tests.
- `ShuttleErrorOpts` defined in Task A1, referenced consistently in A3.
- `lookupErrorCode` (Task A2) → consumed in `ShuttleError` constructor (A3) → consistent signature `(code: string) => ErrorCodeEntry | null`.
- Exit code constants (`EXIT_CODE_TRANSIENT` etc.) named consistently in A2 and tests.
- Method called `lookupErrorCode` in A2 and A3 — not `getErrorCode` or `findErrorCode`. Consistent.

**4. Scope**

This plan is foundation only — no user-facing command changes. Working, testable software at the end: a registry, an extended error class, a macOS keychain adapter. Independent of all subsequent plans (Plans 2–5 will consume what's built here). Estimated execution: ~2–3 hours for a fresh subagent doing one task at a time with verification.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-phase1-plan1-errors-and-keychain.md`.

This is **Plan 1 of 5** for Phase 1. The full Phase 1 sequence is:

- **Plan 1 (this):** Foundation — structured errors + macOS keychain.
- **Plan 2:** CLI surface — `secrets` group + `status` + `internal` namespace + per-command help text.
- **Plan 3:** `run` + `inject` commands + daemon spawner.
- **Plan 4:** Pre-approved sessions + approval-UI checkbox.
- **Plan 5:** `init` rewrite + Linux/Windows keychain + docs + npm publish 0.2.0.

After this plan implements, Plans 2–4 can be drafted in parallel (they share Plan 1's foundation but have no cross-dependencies). Plan 5 sequences last (depends on 1–4).
