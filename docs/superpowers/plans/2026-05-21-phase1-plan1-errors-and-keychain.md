# Phase 1 — Plan 1: Foundation (Structured Errors + Keychain Interface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-cutting foundation that every later Phase 1 plan depends on — structured error shape with `hint` + standardized exit codes (with daemon→CLI preservation), plus a `KeychainAdapter` interface with platform stubs. **No working keychain implementation lands here** — the native-module-backed adapters land in Plan 5a, deliberately, to avoid the argv-leak trap of shell-CLI approaches (`security add-generic-password -w <pw>` is recoverable via `ps auxww` — see spec §5.1).

**Architecture:** Two independent, parallel-shippable changes wired into existing infrastructure.

1. **Structured errors.** Extend `ShuttleError` (gains `hint` field) and `errorToJson` (emits both the legacy `error: { code, message }` block AND flat `error_code` / `message` / `hint` / `exit_code` fields for agents that prefer flat parsing). Default `exitCode` and `hint` come from a central registry (`src/shared/error-codes.ts`) seeded with **real codes** from the current codebase (`secret_not_found`, `missing_param`, `domain_mismatch`, etc. — not aspirational names). Also fix `src/client/daemon-client.ts` so it preserves the daemon's `hint` / `exit_code` through CLI reconstruction (today it drops them).

2. **Keychain interface.** New `src/vault/keychain/` module with a `KeychainAdapter` interface, platform dispatcher, and per-platform stubs that all throw `keychain_not_implemented` with a passphrase-fallback hint. Plan 5a replaces the stubs with native-module-backed implementations (likely `@napi-rs/keyring`). Shipping the interface now unblocks Plans 2–4 from depending on a finished keychain.

**Tech Stack:** TypeScript (existing); Node 20+ (existing); `node:test` (existing test runner). No new npm dependencies in Plan 1.

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) §5.6, §5.1, §3.4.

**Sequence with other Phase 1 plans:**

- **Plan 1 (this):** Foundation — errors (incl. daemon-client preservation) + keychain interface + stubs.
- **Plan 2:** CLI surface — `secrets` group + `status` (rename of `doctor`) + `internal` namespace + help text refactor. Depends on Plan 1.
- **Plan 3:** `run` + `inject` commands (new daemon endpoints + spawner). Depends on Plan 1.
- **Plan 4:** Pre-approved sessions (approvals/session module + UI). Depends on Plan 1.
- **Plan 5a:** `init` rewrite + native-module-backed keychain adapters (macOS / Linux / Windows). Depends on Plans 1–4.
- **Plan 5b:** Docs (SKILL.md, walkthrough, README, cli-reference) + npm publish 0.2.0. Depends on 5a.

---

## File Structure

**Files to create:**
- `src/shared/error-codes.ts` — central registry mapping error code → `{ exitCode, hint(message): string|null }`. Seeded with real current codes from grep of `new ShuttleError(...)` sites.
- `src/shared/error-codes.test.ts` — registry lookup, exit code constants, defaults for unknown codes.
- `src/shared/errors.test.ts` — new shape, hint propagation, exit code propagation, backward-compat shape preservation, flat-field shape.
- `src/vault/keychain/types.ts` — `KeychainAdapter` interface.
- `src/vault/keychain/index.ts` — platform dispatcher, exports `getKeychainAdapter()`.
- `src/vault/keychain/index.test.ts` — dispatcher selects correct platform stub for current platform.
- `src/vault/keychain/darwin.ts` — **stub** throwing `keychain_not_implemented` (Plan 5a replaces with native-module-backed impl).
- `src/vault/keychain/linux.ts` — stub throws `keychain_not_implemented`.
- `src/vault/keychain/windows.ts` — stub throws `keychain_not_implemented`.

**Files to modify:**
- `src/shared/errors.ts` — extend `ShuttleError` (accept `opts` with `exitCode`/`hint`, default from registry); extend `errorToJson` (emit final contract — nested + flat).
- `src/client/daemon-client.ts` — preserve daemon-provided `hint` and `exit_code` through CLI-side reconstruction (Task A6).
- `src/cli/index.ts` — already uses `error.exitCode`; new printer test ensures end-to-end shape preservation.

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

test("daemon_not_running → transient with daemon-start hint", () => {
  const entry = lookupErrorCode("daemon_not_running");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint("anything"), "Run: secret-shuttle daemon start");
});

test("invalid_ref → usage error, null hint", () => {
  const entry = lookupErrorCode("invalid_ref");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
  assert.equal(entry.hint("anything"), null);
});

test("secret_not_found → not-found exit code (corrects earlier ref_not_found typo)", () => {
  const entry = lookupErrorCode("secret_not_found");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_NOT_FOUND);
});

test("missing_param → usage error (the real code; not missing_required_param)", () => {
  const entry = lookupErrorCode("missing_param");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_USAGE);
});

test("domain_mismatch → permission error", () => {
  const entry = lookupErrorCode("domain_mismatch");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
});

test("approval_denied → permission, null hint", () => {
  const entry = lookupErrorCode("approval_denied");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.equal(entry.hint(""), null);
});

test("browser_not_started → transient with browser-start hint", () => {
  const entry = lookupErrorCode("browser_not_started");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.equal(entry.hint(""), "Run: secret-shuttle browser start");
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

The registry below is seeded with **real codes verified by grepping `new ShuttleError("..."` across `src/`** (around 70 distinct codes; this initial set covers the highest-traffic control-plane ones). Codes that don't appear in the current codebase are intentionally omitted — the audit pass in Plans 2–5 adds the rest.

Create `src/shared/error-codes.ts`:

```typescript
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
};

// Seeded with real codes confirmed via grep of src/ for new ShuttleError("...").
// Plans 2–5 incrementally extend this registry as they touch each command.
const REGISTRY: Record<string, ErrorCodeEntry> = {
  // ── Transient (retry-safe) ─────────────────────────────────────────────────
  daemon_not_running: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start",
  },
  daemon_invalid_response: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle status (then retry)",
  },
  daemon_start_timeout: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle daemon start (verify with: secret-shuttle status)",
  },
  approval_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  unlock_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  compare_rate_limited: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  mark_pick_cancelled: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  template_spawn_failed: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
  browser_not_started: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Run: secret-shuttle browser start",
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
  mark_kind_unsupported: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  handle_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => null },
  handle_kind_mismatch: { exitCode: EXIT_CODE_USAGE, hint: () => null },

  // ── Not found ──────────────────────────────────────────────────────────────
  secret_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  template_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  approval_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  handle_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  no_legacy_vault: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  unlock_session_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  vault_not_initialized: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle init",
  },
  envelope_missing: {
    exitCode: EXIT_CODE_NOT_FOUND,
    hint: () => "Run: secret-shuttle init",
  },
  mark_focused_unavailable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  mark_pick_no_actionable: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  unknown_browser_domain: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },

  // ── Permission ─────────────────────────────────────────────────────────────
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

  // ── Conflict ───────────────────────────────────────────────────────────────
  already_migrated: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  browser_already_started: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
  blind_mode_active: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },

  // ── Keychain (Part B; full implementations come in Plan 5a) ────────────────
  keychain_not_implemented: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock until Plan 5a wires the native keychain adapter.",
  },
  keychain_unavailable: {
    exitCode: EXIT_CODE_TRANSIENT,
    hint: () => "Fall back to passphrase unlock; verify your OS keyring is reachable.",
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
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(errors): central error-codes registry seeded with real current codes"
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

Per the spec's final contract (§5.6), `errorToJson` emits BOTH the legacy nested block AND flat agent-friendly fields: `error_code`, `message`, `hint`, `exit_code`. Backward-compat callers reading `result.error.code` keep working; new agent code can parse the flat top-level fields without traversing a nested object.

- [ ] **Step 1: Add failing tests for output shape**

Append to `src/shared/errors.test.ts`:

```typescript
import { errorToJson } from "./errors.js";

test("errorToJson on ShuttleError emits BOTH legacy nested block AND flat fields", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err) as Record<string, unknown>;
  // Legacy nested block preserved:
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "daemon_not_running", message: "Daemon not running" });
  // Flat agent-friendly fields:
  assert.equal(j.error_code, "daemon_not_running");
  assert.equal(j.message, "Daemon not running");
  assert.equal(j.hint, "Run: secret-shuttle daemon start");
  assert.equal(j.exit_code, 1);
});

test("errorToJson on ShuttleError with null hint emits hint: null", () => {
  const err = new ShuttleError("invalid_ref", "Bad ref");
  const j = errorToJson(err) as Record<string, unknown>;
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 2);
  assert.equal(j.error_code, "invalid_ref");
  assert.equal(j.message, "Bad ref");
});

test("errorToJson on plain Error emits unexpected_error with both shapes", () => {
  const j = errorToJson(new Error("oh no")) as Record<string, unknown>;
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "oh no" });
  assert.equal(j.error_code, "unexpected_error");
  assert.equal(j.message, "oh no");
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});

test("errorToJson on non-Error emits unexpected_error with default message", () => {
  const j = errorToJson("string thrown") as Record<string, unknown>;
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "Unknown error" });
  assert.equal(j.error_code, "unexpected_error");
  assert.equal(j.message, "Unknown error");
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/shared/errors.test.js"`
Expected: 4 new tests FAIL — `j.error_code`, `j.message` (flat), `j.hint`, `j.exit_code` undefined.

- [ ] **Step 3: Implement — update `errorToJson`**

In `src/shared/errors.ts`, replace the `errorToJson` function (keep `assertCondition` as is):

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
      // Legacy nested block — preserved indefinitely for backward compat.
      error: { code: error.code, message: error.message },
      // Flat agent-friendly fields per spec §5.6:
      error_code: error.code,
      message: error.message,
      hint: error.hint,
      exit_code: error.exitCode,
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: { code: "unexpected_error", message: error.message },
      error_code: "unexpected_error",
      message: error.message,
      hint: null,
      exit_code: 1,
    };
  }

  return {
    ok: false,
    error: { code: "unexpected_error", message: "Unknown error" },
    error_code: "unexpected_error",
    message: "Unknown error",
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
git commit -m "feat(errors): errorToJson emits both legacy nested block and flat agent-friendly fields"
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

test("CLI error path: registry-known code emits the full contract (nested + flat)", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err);

  // What stderr will print:
  const printed = JSON.stringify(j, null, 2);
  const parsed = JSON.parse(printed);

  assert.equal(parsed.ok, false);
  // Legacy nested block:
  assert.equal(parsed.error.code, "daemon_not_running");
  assert.equal(parsed.error.message, "Daemon not running");
  // Flat agent-friendly fields:
  assert.equal(parsed.error_code, "daemon_not_running");
  assert.equal(parsed.message, "Daemon not running");
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
Expected: ALL PASS. The new fields are additive; existing assertions that read `result.error.code` continue to match. If a prior test asserts `assert.deepEqual(result, { ok: false, error: {...} })` (entire-object equality), it'll fail — fix by either extending the expected object with the new flat fields or asserting only the legacy fields with `assert.deepEqual(result.error, ...)`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/error-printer.test.ts
git commit -m "test(cli): verify error printer emits both legacy and flat shape"
```

---

### Task A6: Preserve daemon-provided hint + exit_code through CLI reconstruction

**Files:**
- Modify: `src/client/daemon-client.ts:25-35`
- Create: `src/client/daemon-client.test.ts`

**Why:** [src/client/daemon-client.ts:33](../../src/client/daemon-client.ts) currently reconstructs daemon errors as `new ShuttleError(err.code, err.message)`, dropping any `hint` / `exit_code` the daemon sent. The daemon emits the full contract (after Tasks A1–A4); the CLI must forward it. Without this, an agent calling a CLI command that delegates to the daemon (most of them) will get a structured error that's missing the daemon's hint — defeating the point of Plan 1.

- [ ] **Step 1: Write the failing test**

Create `src/client/daemon-client.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ShuttleError } from "../shared/errors.js";

// Local helper that mirrors the logic in daemon-client.ts's payload parser.
// We test the reconstruction by simulating a parsed daemon response and
// asserting the resulting ShuttleError carries hint + exitCode.
function reconstructDaemonError(payload: unknown): ShuttleError {
  // Will be implemented in Task A6 step 3; tests run against the export.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./daemon-client.js");
  return mod.daemonErrorFromPayload(payload);
}

test("daemonErrorFromPayload preserves hint and exit_code from daemon response", () => {
  const payload = {
    ok: false,
    error: { code: "secret_not_found", message: "No such ref" },
    error_code: "secret_not_found",
    message: "No such ref",
    hint: "Run: secret-shuttle secrets list",
    exit_code: 3,
  };
  const err = reconstructDaemonError(payload);
  assert.ok(err instanceof ShuttleError);
  assert.equal(err.code, "secret_not_found");
  assert.equal(err.message, "No such ref");
  assert.equal(err.hint, "Run: secret-shuttle secrets list");
  assert.equal(err.exitCode, 3);
});

test("daemonErrorFromPayload falls back to registry defaults when daemon omits new fields", () => {
  // A daemon running the OLD shape only emits error: {code, message}.
  // The CLI should reconstruct using the registry default for that code.
  const payload = {
    ok: false,
    error: { code: "approval_denied", message: "User denied" },
  };
  const err = reconstructDaemonError(payload);
  assert.equal(err.code, "approval_denied");
  // Registry says approval_denied → exitCode 4, null hint
  assert.equal(err.exitCode, 4);
  assert.equal(err.hint, null);
});

test("daemonErrorFromPayload daemon-provided hint wins over registry default", () => {
  // Daemon sends a more specific hint for a registry-known code.
  const payload = {
    ok: false,
    error: { code: "approval_denied", message: "User denied" },
    hint: "Specific recovery: re-run with --session <id>",
    exit_code: 4,
  };
  const err = reconstructDaemonError(payload);
  assert.equal(err.hint, "Specific recovery: re-run with --session <id>");
  assert.equal(err.exitCode, 4);
});

test("daemonErrorFromPayload missing error block falls back to 'unknown'", () => {
  const payload = { ok: false };
  const err = reconstructDaemonError(payload);
  assert.equal(err.code, "unknown");
  assert.equal(err.message, "unknown error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test "dist/client/daemon-client.test.js"`
Expected: FAIL — `daemonErrorFromPayload` not exported.

- [ ] **Step 3: Implement — extract and extend the reconstruction logic**

Replace the contents of `src/client/daemon-client.ts` with:

```typescript
import { ShuttleError } from "../shared/errors.js";
import { readSocketFile } from "../daemon/socket-file.js";

async function endpoint(): Promise<{ url: string; token: string }> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running. Run `secret-shuttle daemon start`.");
  }
  return { url: `http://127.0.0.1:${sf.port}`, token: sf.token };
}

// Exported for tests. Reconstructs a ShuttleError from a daemon JSON payload,
// preserving daemon-provided hint and exit_code if present. Falls back to
// registry defaults when the daemon emits the legacy shape only.
export function daemonErrorFromPayload(payload: unknown): ShuttleError {
  const p = (payload ?? {}) as Record<string, unknown>;
  const errBlock = (p.error ?? {}) as { code?: string; message?: string };
  const code = typeof errBlock.code === "string" ? errBlock.code : "unknown";
  const message = typeof errBlock.message === "string" ? errBlock.message : "unknown error";

  // Daemon-provided fields take precedence over registry defaults.
  const opts: { exitCode?: number; hint?: string | null } = {};
  if (typeof p.exit_code === "number") opts.exitCode = p.exit_code;
  if (typeof p.hint === "string" || p.hint === null) opts.hint = p.hint;

  return new ShuttleError(code, message, opts);
}

export async function daemonRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T & { ok: true }> {
  const { url, token } = await endpoint();
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let payload: { ok: boolean } & Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ShuttleError("daemon_invalid_response", text);
  }
  if (!payload.ok) {
    throw daemonErrorFromPayload(payload);
  }
  return payload as T & { ok: true };
}
```

Note on the `require` in the test: we use it because `daemonErrorFromPayload` needs to be inspected post-build via the `dist/` output. If the test framework setup uses ESM-only loading and `require` fails, switch the test to `import { daemonErrorFromPayload } from "./daemon-client.js"` and remove the local helper. Either form is acceptable; pick whichever the existing test harness supports (check `src/cli/agent.test.ts` for the convention).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test "dist/client/daemon-client.test.js"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: ALL PASS. No existing test should depend on the old (buggy) behavior of dropping hint/exit_code — it was a silent omission, not a feature.

- [ ] **Step 6: Commit**

```bash
git add src/client/daemon-client.ts src/client/daemon-client.test.ts
git commit -m "fix(client): preserve daemon-provided hint and exit_code through CLI reconstruction"
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

### Task B2: macOS adapter — Plan 1 stub

**Files:**
- Create: `src/vault/keychain/darwin.ts`

**Why a stub, not the real `security` CLI implementation:** `security add-generic-password -s <svc> -a <acct> -w <password>` puts the password in argv, recoverable via `ps auxww` by any process running as the user. That contradicts Secret Shuttle's "vault key never leaks" promise (see spec §5.1). The real adapter — using a native NAPI module that accepts the password through memory rather than argv — lands in Plan 5a. Plan 1 ships a stub identical in shape to the Linux/Windows stubs so all platform code paths are uniform.

No test file for the stub; it's exercised through the dispatcher tests in Task B4 alongside the linux/windows stubs.

- [ ] **Step 1: Implement the macOS stub**

Create `src/vault/keychain/darwin.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * macOS keychain adapter — placeholder.
 *
 * Plan 5a will replace this with a native-module-backed implementation
 * (likely @napi-rs/keyring) that uses Keychain Services through memory
 * rather than argv. The shell-CLI approach (`security add-generic-password
 * -w <pw>`) is rejected because the password is recoverable via `ps`.
 *
 * Until Plan 5a lands, init falls back to passphrase unlock on macOS.
 */
export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/vault/keychain/darwin.ts
git commit -m "feat(keychain): macOS adapter stub (real native-module impl in Plan 5a)"
```

---

### Task B3: Stub Linux and Windows adapters

**Files:**
- Create: `src/vault/keychain/linux.ts`
- Create: `src/vault/keychain/windows.ts`

These are stubs that throw `keychain_not_implemented`. **Plan 5a** replaces all three platform adapters (darwin, linux, windows) with native-module-backed implementations (likely `@napi-rs/keyring`, which covers Keychain Services / libsecret / Windows Credential Manager from one library). Until 5a, init falls back to passphrase unlock; the registry hint guides the user.

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
 * On supported platforms (darwin, linux, win32), returns the per-platform
 * class — note **all three are stubs in Plan 1**; Plan 5a replaces their
 * internals with native-module-backed implementations.
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
- Structured error contract: every CLI error now emits both the legacy nested `error: { code, message }` block AND flat agent-friendly fields (`error_code`, `message`, `hint`, `exit_code`). `hint` is the literal recovery command (or null when the human must intervene); `exit_code` follows Sol convention (0 success, 1 transient, 2 usage, 3 not-found, 4 permission, 5 conflict).
- `src/shared/error-codes.ts`: central registry seeded with real codes from the current codebase (`secret_not_found`, `missing_param`, `domain_mismatch`, `approval_*`, `browser_not_started`, `vault_unlock_failed`, etc.). The audit of remaining throw sites continues incrementally across Plans 2–5.
- `src/vault/keychain/` module: `KeychainAdapter` interface + platform dispatcher + per-platform stubs (`darwin.ts`, `linux.ts`, `windows.ts`) that throw a typed `keychain_not_implemented` error with a passphrase-fallback hint. Plan 5a replaces the stubs with native-module-backed implementations (likely `@napi-rs/keyring`).

### Changed
- `ShuttleError` constructor now accepts an `opts` object (`{ exitCode, hint }`) in addition to the legacy positional `exitCode` number. Existing call sites continue to work unchanged; defaults flow from the new registry.
- `src/client/daemon-client.ts` now preserves daemon-provided `hint` and `exit_code` through CLI-side reconstruction (previously dropped). Exposes `daemonErrorFromPayload(payload)` for testability.

### Security
- Deliberately did NOT ship a `security`-CLI-based macOS keychain implementation. The `add-generic-password -w <pw>` form puts the password in argv (recoverable via `ps`), contradicting Secret Shuttle's vault-key-never-leaks guarantee. Plan 5a replaces the stub with a native-module adapter that accepts the password through memory.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Plan 1 — structured errors + keychain interface"
```

---

## Self-Review

**1. Spec coverage (revised post P0–P2 review)**

Reviewing spec §5.6 (Structured errors) and §5.1/§3.4 (keychain abstraction):

- ✅ `ShuttleError` extended with `hint` + `exitCode` (Task A1)
- ✅ Central registry `src/shared/error-codes.ts` with code → {exitCode, hint(message)}, **seeded with real codes** from the current codebase (Task A2)
- ✅ `errorToJson` emits the **final contract** — legacy nested `error: { code, message }` block AND flat `error_code` / `message` / `hint` / `exit_code` fields (Task A4)
- ✅ **Daemon-client preserves daemon-provided `hint` + `exit_code`** through CLI reconstruction (Task A6 — fixes the P1 issue flagged in review)
- ✅ CLI error printer uses new shape + sets exit code (Task A5 — minimal change, existing code already used `error.exitCode`)
- ✅ Exit code policy 0/1/2/3/4/5 with named constants (Task A2)
- ✅ Keychain abstraction interface (Task B1)
- ✅ macOS stub (Task B2 — **not** the real `security`-CLI impl, which leaks the password via argv; real native-module impl deferred to Plan 5a per P0 review)
- ✅ Linux + Windows stubs (Task B3)
- ✅ Platform dispatcher with override for tests (Task B4)
- ✅ CHANGELOG entry (Task C2)

**Audit of all 204 `throw new ShuttleError` sites:** explicitly deferred to Plans 2–5 (noted in Task A2 and in the plan header). The registry's default behavior (unknown code → exit code 1, null hint) means existing throw sites work unchanged; this plan only adds the *infrastructure* for richer errors. Each subsequent plan audits the throw sites in the files it touches.

**Backward-compat check:** the spec's §5.6 TypeScript type and prose were reconciled in the post-review amendment — `error` stays a nested object (preserving every existing caller of `result.error.code`), and `error_code` / `message` / `hint` / `exit_code` are net-new flat top-level siblings.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "Similar to Task N", or "add appropriate X". Every code block is complete. Every command shows expected output. No NUL bytes (P2 fix verified).

**3. Type consistency**

- `KeychainAdapter` interface members (`isAvailable`, `set`, `get`, `delete`) — match exactly across `types.ts` (Task B1), `darwin.ts` (B2), `linux.ts`/`windows.ts` (B3), `index.ts` (B4), and all tests.
- `ShuttleErrorOpts` defined in Task A1, referenced consistently in A3.
- `lookupErrorCode` (Task A2) → consumed in `ShuttleError` constructor (A3) → consistent signature `(code: string) => ErrorCodeEntry | null`.
- `daemonErrorFromPayload` (Task A6) calls into `ShuttleError` (A1/A3) using the `opts` form — consistent.
- Exit code constants (`EXIT_CODE_TRANSIENT` etc.) named consistently in A2 and tests.
- All registry codes match real codes confirmed by grep of `new ShuttleError("...")` in `src/` (P1 fix verified).

**4. Scope**

Foundation only — no user-facing command changes. Working, testable software at the end: a registry, an extended error class, an end-to-end-preserving daemon client, a keychain interface + stubs. Independent of all subsequent plans. Estimated execution: ~2–3 hours for a fresh subagent doing one task at a time with verification.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-phase1-plan1-errors-and-keychain.md`.

This is **Plan 1 of 5** for Phase 1. The full Phase 1 sequence is:

- **Plan 1 (this):** Foundation — structured errors (incl. daemon-client preservation) + keychain interface + platform stubs.
- **Plan 2:** CLI surface — `secrets` group + `status` + `internal` namespace + per-command help text.
- **Plan 3:** `run` + `inject` commands + daemon spawner.
- **Plan 4:** Pre-approved sessions + approval-UI checkbox.
- **Plan 5a:** `init` rewrite + native-module-backed keychain adapters (macOS / Linux / Windows).
- **Plan 5b:** Docs (SKILL.md, walkthrough, README, cli-reference) + npm publish 0.2.0.

After this plan implements, Plans 2–4 can be drafted in parallel (they share Plan 1's foundation but have no cross-dependencies). Plan 5a sequences after 1–4; Plan 5b sequences last.
