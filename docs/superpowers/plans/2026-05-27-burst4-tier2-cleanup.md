# Burst 4 Tier 2 Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 4 remaining Tier 2 finishes flagged across Burst 4 code reviews — items deferred at the time as non-blocking but worth doing before any post-launch plan work begins.

**Architecture:** Each task is independent and touches a narrow surface (1–3 files + tests). No new abstractions; reuses existing patterns from Burst 4 (audit fields, error code registry, TDD).

**Tech Stack:** TypeScript + Node `node:test`, same as the rest of the repo.

---

## Scope

Four tasks, in execution order:

| # | Task | Source review | Why it matters |
|---|---|---|---|
| T1 | Atomic per-runtime loop in `init.ts` (the `TODO(post-launch)`) | A14 review I1 | Today a mid-init mint failure halts with a stack trace + half-installed state. Users have no clear recovery signal. |
| T2 | Split `bootstrap_capture_redirect_blocked` for non-redirect failures | C6 review | The same error code is currently thrown for "host changed" AND "no focused element" / "selection vs field" — overloaded code makes the hint less actionable. |
| T3 | B1 test rigor: ordering-sensitive + throw-injection vault scrub | B1 review I1+I2 | Current tests prove "scrub happened by the time the call resolved" but not "scrub happened BEFORE the next unrelated await" (the actual security invariant). |
| T4 | `root_token_fp` audit field for rotation forensics | A12 review M6 | Post-rotation, audit-log readers can't tell which generation of root a `tokens_mint` row was bound to. Forensics gap. |

---

## File structure

### Files to create
- `docs/superpowers/plans/2026-05-27-burst4-tier2-cleanup.md` (this file)
- `src/daemon/auth/root-token-fingerprint.ts` — pure helper for computing the short fingerprint
- `src/daemon/auth/root-token-fingerprint.test.ts` — tests for the helper

### Files to modify
- `src/cli/commands/init.ts` — wrap the per-runtime mint loop in try/catch + `agent_runtimes_failed`
- `src/cli/commands/init.test.ts` — add T1 failure-isolation test
- `src/daemon/chrome/capture-target-ops.ts` — split 3 throw sites to new error code
- `src/daemon/chrome/capture-target-ops.test.ts` — update tests to assert the new code
- `src/shared/error-codes.ts` — add `bootstrap_capture_field_unreadable`
- `src/shared/error-codes.test.ts` — bump registry count + add dedicated assertion
- `src/vault/vault-key-scrub.test.ts` — add 3 new tests (ordering + throw-injection)
- `src/daemon/audit.ts` — add `root_token_fp?: string` to `DaemonAuditEvent`
- `src/daemon/api/routes/tokens.ts` — stamp `root_token_fp` in both audit emissions
- `src/daemon/api/routes/tokens.test.ts` — assert `root_token_fp` appears in audit row
- `src/daemon/api/routes/daemon-admin.ts` — stamp old + new `root_token_fp` on rotate
- `src/daemon/api/routes/daemon-admin.test.ts` — assert fingerprints recorded across rotate

---

## Task T1: Atomic per-runtime loop in init.ts

**Files:**
- Modify: `src/cli/commands/init.ts` (lines 226-251 — the per-runtime mint loop)
- Test: `src/cli/commands/init.test.ts` (add T1 test using existing `withInitDaemon` harness)

The current loop has a `TODO(post-launch)` at line 229. A mid-loop mint failure today throws past the loop, leaves earlier runtimes installed and later runtimes uninstalled, and the init command exits with a stack trace and no summary.

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/init.test.ts`, after the existing T1 cluster (the runtime-config tests), add:

```ts
test("init: one runtime's /v1/tokens/mint failure does not halt the others; summary lists the failure", async () => {
  await withInitDaemon(async (ctx) => {
    // Seed a project that detects BOTH claude AND copilot. (copilot maps to
    // the manual-install branch, so even on the happy path it ends up in
    // pending_manual rather than configured.) We want claude to succeed and
    // demonstrate isolation, but the easier test is to FORCE a mint failure
    // for whichever runtime is iterated first and assert the OTHER still
    // gets through. Use a route-level override on /v1/tokens/mint that
    // rejects the first call, accepts subsequent calls.
    await bootstrapVault(ctx, "p");

    const tmp = await mkdtemp(path.join(os.tmpdir(), "ss-init-failure-"));
    await mkdir(path.join(tmp, ".claude"), { recursive: true });
    await mkdir(path.join(tmp, ".github"), { recursive: true });
    await writeFile(path.join(tmp, ".github", "copilot-instructions.md"), "");

    // Replace /v1/tokens/mint with a one-shot-fail handler. First request
    // returns a structured 400 with code bootstrap_plan_invalid (any code
    // works; the loop must catch it generically). Subsequent requests fall
    // through to the real handler.
    let failed = false;
    ctx.server.replaceRouteForTesting("POST", "/v1/tokens/mint", async (req, raw) => {
      if (!failed) {
        failed = true;
        throw new ShuttleError("agent_token_invalid", "synthetic test failure");
      }
      // Fall back to the actual mint logic — easiest: re-derive HMAC inline.
      const o = raw as { agent_id: string };
      const hmac = deriveHmac(ctx.rootToken, o.agent_id);
      return { token: formatBearer(o.agent_id, hmac), agent_id: o.agent_id };
    });

    const prevCwd = process.cwd();
    process.chdir(tmp);
    let summary: Record<string, unknown> | undefined;
    const origLog = console.log;
    console.log = (s: string) => { summary = JSON.parse(s); };
    try {
      await initCommand().parseAsync(["node", "init"]);
    } finally {
      console.log = origLog;
      process.chdir(prevCwd);
      await rm(tmp, { recursive: true, force: true });
    }

    assert.ok(summary !== undefined, "init must still emit a summary on partial failure");
    const body = (summary as { ok: true; agent_runtimes_failed?: Array<{ runtime: string; error_code: string }> });
    assert.ok(
      Array.isArray(body.agent_runtimes_failed) && body.agent_runtimes_failed.length === 1,
      `agent_runtimes_failed must have exactly 1 entry, got: ${JSON.stringify(body.agent_runtimes_failed)}`,
    );
    assert.equal(body.agent_runtimes_failed![0]!.error_code, "agent_token_invalid");
    // The OTHER runtime must still be reflected in configured or pending_manual
    // (depending on which one failed). agent_runtimes_detected always has both.
    const detected = (body as { agent_runtimes_detected: string[] }).agent_runtimes_detected;
    assert.equal(detected.length, 2, "both runtimes must still be detected even after one failure");
  });
});
```

If `DaemonServer.replaceRouteForTesting` does not exist, fall back to constructing the harness with a custom `mintImpl` injection (mirroring `createBrowserSessionImpl` pattern from C5) — see "Implementation notes" below.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/cli/commands/init.test.ts`
Expected: FAIL — current loop throws past the summary emission; either no summary, or `agent_runtimes_failed` is missing.

- [ ] **Step 3: Modify init.ts**

Replace the inner loop body with a try/catch per runtime + a `failed` accumulator + summary emission of `agent_runtimes_failed`.

```ts
const configured: string[] = [];
const pendingManual: string[] = [];
const failed: Array<{ runtime: string; error_code: string }> = [];
const nextActions: string[] = [];
if (runtimes.length > 0) {
  const machineId = await readMachineId(getSecretShuttleHome());
  if (machineId !== null) {
    for (const runtime of runtimes) {
      try {
        const agentId = deriveAutoAgentId(runtime, machineId);
        const { token } = await daemonRequest<{ token: string; agent_id: string }>(
          "POST",
          "/v1/tokens/mint",
          { agent_id: agentId },
        );
        const result: InstallResult = await installAgentToken(runtime, agentId, token);
        if (result.status === "configured") {
          configured.push(runtime);
        } else {
          pendingManual.push(runtime);
          if (result.manualInstructions !== undefined) {
            nextActions.push(result.manualInstructions);
          }
        }
      } catch (err) {
        // Isolate this runtime's failure: record it and continue with the
        // others. Without this, a mid-loop mint failure would halt init with
        // a stack trace and leave the user with partial state and no signal.
        failed.push({
          runtime,
          error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        });
      }
    }
  }
}
```

Then in the summary, add `agent_runtimes_failed: failed`:

```ts
outputJson(
  ok({
    daemon_running: true,
    daemon_port: port,
    daemon_spawned: daemonSpawned,
    vault_initialized: true,
    vault_just_created: vaultJustCreated,
    keychain_enrolled: keychainEnrolled,
    agent_runtimes_detected: runtimes,
    agent_runtimes_configured: configured,
    agent_runtimes_pending_manual: pendingManual,
    agent_runtimes_failed: failed,  // NEW
    next_actions: nextActions,
    next_action: vaultJustCreated
      ? "secret-shuttle import --env-file .env  # optional: migrate existing secrets"
      : null,
  }),
);
```

Remove the `TODO(post-launch)` comment block (lines 229-232).

Add an import for `ShuttleError` if not already present.

- [ ] **Step 4: Run test + verify**

Run: `npx tsx --test src/cli/commands/init.test.ts`
Expected: PASS — the failure-isolation test plus all existing init tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts src/cli/commands/init.test.ts
git commit -m "feat(init): isolate per-runtime mint failures (close A14 TODO)

Wrap the per-runtime loop in try/catch + accumulate agent_runtimes_failed:
[{runtime, error_code}] for the summary. Previously a mid-loop /v1/tokens/mint
failure threw past the summary emission, leaving the user with a stack
trace and partial state (some runtimes installed, others not). Now init
ALWAYS emits a summary and the user gets a structured failed[] list to
act on. Removes the lone TODO(post-launch) comment in src/."
```

**Implementation notes:**

- If `DaemonServer.replaceRouteForTesting` doesn't exist, two alternative paths to inject the mint failure:
  - **Option A (preferred):** Override the route by registering a duplicate handler AFTER `registerTokens(server, ...)` in the test harness. The server's last-registered handler wins for the same method+path.
  - **Option B:** Add a test-only `mintImpl?: (req, body) => Promise<unknown>` injection point on `DaemonServicesOptions` (mirroring `createBrowserSessionImpl`). Heavier; only if Option A doesn't work.
- The test imports `ShuttleError`, `deriveHmac`, `formatBearer` from the daemon — check existing imports in init.test.ts and add what's missing.
- The full `npm test` should still be 1395 + 1 = 1396 after this.

---

## Task T2: Split `bootstrap_capture_redirect_blocked` for non-redirect failures

**Files:**
- Modify: `src/daemon/chrome/capture-target-ops.ts` (lines 239, 252, 258 — three non-redirect throw sites)
- Modify: `src/shared/error-codes.ts` (add new code)
- Modify: `src/shared/error-codes.test.ts` (count + dedicated assertion)
- Test: `src/daemon/chrome/capture-target-ops.test.ts` (update existing tests + add coverage)

`bootstrap_capture_redirect_blocked` is currently thrown for FOUR distinct failure modes:
1. **Line 202** — host changed mid-capture (the actual redirect case)
2. **Line 239** — `no_active_element` / `not_editable` / unknown reason from READ_SCRIPT
3. **Line 252** — `focused-field` requested but page has a selection
4. **Line 258** — `selection` requested but page has no selection

Sites 2–4 are "field state unreadable" issues — the page hasn't redirected, the user just hasn't focused the right thing. They deserve a distinct error code so the CLI hint can point to the right recovery action ("focus the field and re-trigger capture") rather than the generic "the host changed".

- [ ] **Step 1: Add the new error code**

In `src/shared/error-codes.ts`, add (alongside the existing capture codes, around the other `bootstrap_capture_*` entries):

```ts
bootstrap_capture_field_unreadable: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "The capture tab is on the expected host, but the focused field is missing or the selection state doesn't match. Click into the field containing the secret (clearing any selection if you requested focused-field, or selecting the text if you requested selection) and re-trigger capture.",
  nextAction: () => null,
},
```

In `src/shared/error-codes.test.ts`, bump the registry count assertion from its current value (find via `grep "expected.*registry entries"`) by 1, and add a dedicated assertion:

```ts
test("bootstrap_capture_field_unreadable → CONFLICT exit + field-focus hint", () => {
  const entry = lookupErrorCode("bootstrap_capture_field_unreadable");
  assert.ok(entry);
  assert.equal(entry.exitCode, EXIT_CODE_CONFLICT);
  assert.match(entry.hint(""), /focused field/i);
});
```

- [ ] **Step 2: Update capture-target-ops.ts**

In `src/daemon/chrome/capture-target-ops.ts`, change THREE throw sites from `bootstrap_capture_redirect_blocked` to `bootstrap_capture_field_unreadable`:

- Line 239 (the `if (!v.ok || v.value === undefined || ...)` block — `no_active_element` / `not_editable` / unknown reason)
- Line 252 (mode `focused-field` but `v.source !== "focused-field"`)
- Line 258 (mode `selection` but `v.source !== "selection"`)

Leave line 202 (the actual host-mismatch check) untouched — that one IS a redirect.

Also update the file-header comment at line 11 if it explicitly cites `bootstrap_capture_redirect_blocked` for the non-redirect cases.

- [ ] **Step 3: Run the registry test to verify**

Run: `npx tsx --test src/shared/error-codes.test.ts`
Expected: PASS — count assertion lands on the bumped value, dedicated assertion passes.

- [ ] **Step 4: Update capture-target-ops tests**

In `src/daemon/chrome/capture-target-ops.test.ts`, find the existing tests that assert the old error code for the non-redirect cases (search for `bootstrap_capture_redirect_blocked` in the test file). Update each to assert `bootstrap_capture_field_unreadable` where appropriate.

Concretely, you should find tests like:
- "no_active_element returns bootstrap_capture_redirect_blocked" → change expected code
- "mode mismatch (selection-when-field-requested) returns bootstrap_capture_redirect_blocked" → change expected code
- "mode mismatch (field-when-selection-requested) returns bootstrap_capture_redirect_blocked" → change expected code

The "redirect / host mismatch" test stays unchanged.

- [ ] **Step 5: Run all targeted tests + full suite**

```bash
npx tsx --test src/daemon/chrome/capture-target-ops.test.ts src/shared/error-codes.test.ts && npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/chrome/capture-target-ops.ts src/daemon/chrome/capture-target-ops.test.ts src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(error-codes): split bootstrap_capture_field_unreadable from redirect_blocked

C6 reviewer flagged: bootstrap_capture_redirect_blocked was overloaded
for 4 distinct failure modes — the actual host-changed redirect AND three
\"field state unreadable\" cases (no_active_element, mode mismatch in
either direction). Split out bootstrap_capture_field_unreadable (CONFLICT)
with a hint pointing to the right recovery action (focus the field /
clear or set selection). Redirect_blocked now only fires for real host
changes."
```

---

## Task T3: B1 test rigor — ordering-sensitive + throw-injection vault scrub

**Files:**
- Test: `src/vault/vault-key-scrub.test.ts` (extend with 3 new tests)

B1's reviewer found: the existing tests prove "every captured key copy is zero AFTER the call resolves" but not the precise invariant the spec calls for — "scrub happens BEFORE any unrelated `await`." A refactor that defers `.fill(0)` until the outer promise's `.finally()` would still pass.

The other gap: throw-safety is asserted by reading the try/finally shape; no test injects a throwing crypto stub.

- [ ] **Step 1: Write the failing ordering test for `Vault.read()`**

The `read()` method's invariant: after `decryptVault` runs, the key MUST be scrubbed BEFORE the `await this.write(plaintext)` migration call (if it fires). Test by stubbing `this.write` to capture the observed key state at the moment it's invoked.

Add to `src/vault/vault-key-scrub.test.ts`:

```ts
test("Vault.read: master-key copy is scrubbed BEFORE the migration write fires", async () => {
  const lock = new LockedVaultState();
  const key = Buffer.alloc(32, 0xab);
  lock.unlock(key);
  
  // Seed a vault that triggers migrateFingerprints → recursive write.
  // The migration check is `migrateFingerprints(plaintext)` — a no-op
  // when fingerprints are present. We need to construct a vault whose
  // plaintext has at least one secret WITHOUT a fingerprint, which is
  // the legacy-migration case.
  //
  // Easiest path: use the existing test scaffolding to mint a vault,
  // then hand-edit the plaintext to remove fingerprints, re-encrypt,
  // write. (This mirrors the production legacy-migration path.)
  //
  // Then: stub Vault.write to capture the key's state at invocation time.
  // If the scrub fires BEFORE the write call (correct), the observed
  // outer-key buffer is all zero when write begins. If the scrub fires
  // AFTER (regression), the observed buffer still has 0xab.

  const observedAtWriteTime: Buffer[] = [];
  const vault = new Vault(() => lock.requireKey());
  // Monkey-patch the private write to capture state. (Cast to `any` since
  // it's private — test-only access.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origWrite = (vault as any).write.bind(vault);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vault as any).write = async function (plaintext: VaultPlaintext) {
    // At THIS moment, the outer read() should have already scrubbed its
    // key copy. Capture the spy's most recent buffer and snapshot it.
    if (observedKeys.length > 0) {
      observedAtWriteTime.push(Buffer.from(observedKeys[observedKeys.length - 1]!));
    }
    return origWrite(plaintext);
  };
  
  // ... drive the migration path via vault.list() or vault.getSecret() ...
  
  // After the read completes, ALL observed-at-write-time buffers should be
  // all-zero (proving the outer scrub fired before write was awaited).
  for (const snapshot of observedAtWriteTime) {
    assert.ok(snapshot.every((b) => b === 0), "outer key must be zeroed before migration write");
  }
});
```

**Important:** look at the existing test in `src/vault/vault-key-scrub.test.ts` for the actual fixture setup pattern — the test above is illustrative, not literal. Match the existing helpers (the spy harness, the in-memory vault setup, etc.).

If the migration path is too hard to trigger from a test, an equivalent ordering test: stub `writeJsonFileAtomic` (or equivalent) to be a slow async operation that, before resolving, inspects the most recent observed key buffer and asserts it's all-zero.

- [ ] **Step 2: Write the ordering test for `Vault.write()`**

`write()`'s invariant: `encryptVault(plaintext, key)` is sync, then `key.fill(0)` in finally, THEN `await writeJsonFileAtomic(...)`. Verify the key is zero by the time `writeJsonFileAtomic` is awaited.

Stub `writeJsonFileAtomic` to a slow async function that captures the latest observed key state:

```ts
test("Vault.write: master-key copy is scrubbed BEFORE writeJsonFileAtomic is awaited", async () => {
  const lock = new LockedVaultState();
  const key = Buffer.alloc(32, 0xab);
  lock.unlock(key);

  // ... existing test setup that gets us to a Vault ready to write ...

  // Patch writeJsonFileAtomic via module-level monkey-patch OR via
  // dependency injection if available. The pattern depends on how the
  // file is structured.
  // 
  // If the production code does `await writeJsonFileAtomic(path, data)`
  // imported from a known module, replace that import temporarily with
  // a spy that checks the observed key state.

  let observedAtAwaitTime: Buffer | null = null;
  // ... install spy ...

  await vault.upsertSecret(/* ... */);

  assert.ok(observedAtAwaitTime !== null, "writeJsonFileAtomic must have been awaited");
  assert.ok(observedAtAwaitTime!.every((b) => b === 0), "key must be zeroed before writeJsonFileAtomic");
});
```

**Note:** if monkey-patching the imported `writeJsonFileAtomic` is too invasive, the FALLBACK test is: stub `Vault.write` to a function that calls `encryptVault(plaintext, key)` then awaits a controllable Promise, then checks the spy's observed key before resolving. This is less precise but exercises the same invariant.

If neither approach is practical without restructuring, document the limitation in a code comment in the test file: "ordering invariant verified by code review at vault.ts:281-294 (try/finally placement)" and SKIP the test. The B1 reviewer noted this option as acceptable.

- [ ] **Step 3: Write the throw-injection test**

If `decryptVault` throws (corrupt vault file, wrong key), the finally MUST still fire. Test by writing a corrupt vault file, then calling `vault.list()` (or whatever triggers read), and asserting the captured outer key is all-zero despite the throw.

```ts
test("Vault.read: key copy is scrubbed even when decryptVault throws", async () => {
  const lock = new LockedVaultState();
  const key = Buffer.alloc(32, 0xab);
  lock.unlock(key);
  // ... write a corrupt vault file to the temp SHUTTLE_HOME ...

  const observedKeys: Buffer[] = [];
  const vault = new Vault(() => {
    const c = lock.requireKey();
    observedKeys.push(c);
    return c;
  });

  // Expect the read to throw (decryptVault throws on corrupt ciphertext)
  // but the finally must still have scrubbed.
  await assert.rejects(() => vault.list());

  assert.ok(observedKeys.length > 0, "keyProvider must have been called at least once");
  for (const k of observedKeys) {
    assert.ok(k.every((b) => b === 0), "key must be scrubbed even on decryptVault throw");
  }
});
```

For "corrupt vault file": write a JSON file with valid structure but garbage `ciphertext` bytes. The existing test helpers may have a way to construct this; look at how `vault.test.ts` writes its corrupt-vault fixtures (if any exist).

- [ ] **Step 4: Run all new tests**

```bash
npx tsx --test src/vault/vault-key-scrub.test.ts
```

Expected: 3 new tests pass (or with documented SKIPs if the ordering tests prove impractical).

- [ ] **Step 5: Run full suite**

```bash
npm test && npx tsc --noEmit
```

Expected: 1396 + ~3 new = ~1399 pass (less any SKIPs).

- [ ] **Step 6: Commit**

```bash
git add src/vault/vault-key-scrub.test.ts
git commit -m "test(vault): ordering-sensitive + throw-injection key-scrub coverage (B1 review)

Three new tests close the test-rigor gap B1's reviewer flagged:
- Vault.read scrubs key BEFORE the migration write is awaited (ordering)
- Vault.write scrubs key BEFORE writeJsonFileAtomic is awaited (ordering)
- Vault.read still scrubs when decryptVault throws (throw-injection)

Previous tests only proved 'scrub happened by the time the call
resolved' — a refactor that deferred .fill(0) to an outer promise
.finally() would still pass. These pin the precise invariant: scrub
happens synchronously after the sync crypto op, before any unrelated
await."
```

If one or two of the ordering tests prove impractical (can't reach the production code path without invasive monkey-patching), commit them as SKIP with a comment pointing to the code review check, and reduce the commit message accordingly.

---

## Task T4: `root_token_fp` audit field for rotation forensics

**Files:**
- Create: `src/daemon/auth/root-token-fingerprint.ts`
- Create: `src/daemon/auth/root-token-fingerprint.test.ts`
- Modify: `src/daemon/audit.ts` (add field)
- Modify: `src/daemon/api/routes/tokens.ts` (stamp on success + failure audit emissions)
- Modify: `src/daemon/api/routes/tokens.test.ts` (assert presence)
- Modify: `src/daemon/api/routes/daemon-admin.ts` (stamp old + new on rotate)
- Modify: `src/daemon/api/routes/daemon-admin.test.ts` (assert continuity across rotate)

A12's reviewer noted: after `daemon rotate`, every `tokens_mint` row before the rotation refers to tokens that are now invalid. There's no correlation key in the audit log to tell readers "this row was minted under the OLD root, this one under the NEW." Adding a short fingerprint (4-byte SHA-256 prefix hex = 8 chars) gives audit-log consumers a bucketing primitive without exposing the actual root token.

- [ ] **Step 1: Write the failing test for the fingerprint helper**

```ts
// src/daemon/auth/root-token-fingerprint.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { rootTokenFingerprint } from "./root-token-fingerprint.js";

test("rootTokenFingerprint: returns 8-char hex prefix of SHA-256(rootToken)", () => {
  const fp = rootTokenFingerprint("abcdef0123456789");
  assert.equal(typeof fp, "string");
  assert.match(fp, /^[0-9a-f]{8}$/);
});

test("rootTokenFingerprint: deterministic — same input yields same output", () => {
  const a = rootTokenFingerprint("test-token-1");
  const b = rootTokenFingerprint("test-token-1");
  assert.equal(a, b);
});

test("rootTokenFingerprint: different inputs yield different outputs", () => {
  const a = rootTokenFingerprint("test-token-1");
  const b = rootTokenFingerprint("test-token-2");
  assert.notEqual(a, b);
});

test("rootTokenFingerprint: does not embed the input bytes in the output", () => {
  // The fingerprint must NOT reveal the root token. A naive .slice(0, 8) would.
  const token = "AAAAAAAA-secret-suffix";
  const fp = rootTokenFingerprint(token);
  assert.ok(!fp.startsWith("AAAAAAAA"), "fingerprint must not be a substring of the token");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/daemon/auth/root-token-fingerprint.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement the helper**

```ts
// src/daemon/auth/root-token-fingerprint.ts
import { createHash } from "node:crypto";

/**
 * Short fingerprint of the daemon's root token for audit-log correlation.
 *
 * Returns the first 4 bytes (8 hex chars) of SHA-256(rootToken). Lets audit-
 * log readers bucket entries by which generation of the root they were bound
 * to — useful for forensics after `secret-shuttle daemon rotate`.
 *
 * Non-reversible: the SHA-256 prefix doesn't leak the token bytes. 4 bytes
 * is short enough that adjacent generations are visually distinct in the
 * audit log but long enough (~4 billion possible values) that accidental
 * collisions are vanishingly unlikely across a single daemon's lifetime.
 *
 * Used by /v1/tokens/mint (stamps the active fingerprint on each row) and
 * /v1/daemon/rotate (records both OLD and NEW fingerprints).
 */
export function rootTokenFingerprint(rootToken: string): string {
  return createHash("sha256").update(rootToken).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Verify the helper test passes**

Run: `npx tsx --test src/daemon/auth/root-token-fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the audit field**

In `src/daemon/audit.ts`, add to the `DaemonAuditEvent` interface near the other token-related fields:

```ts
/**
 * Short fingerprint of the daemon's root token at the time this event was
 * emitted (first 4 bytes / 8 hex chars of SHA-256(root_token)). Stamped by
 * /v1/tokens/mint on every audit row and by /v1/daemon/rotate on the
 * before+after rows. Audit-log consumers can bucket rows by generation
 * without seeing the actual root token bytes.
 */
root_token_fp?: string;

/**
 * For daemon_rotate events only: the OLD fingerprint (before the swap).
 * `root_token_fp` carries the NEW fingerprint. Pair lets readers chain
 * the rotation timeline: rows with root_token_fp = X were minted under
 * X; the rotate event with root_token_fp_prev = X + root_token_fp = Y
 * marks the transition.
 */
root_token_fp_prev?: string;
```

- [ ] **Step 6: Wire `root_token_fp` into `tokens.ts`**

In `src/daemon/api/routes/tokens.ts`, both audit emissions (success + failure path from the previous I1 fix) should include `root_token_fp: rootTokenFingerprint(getRootToken())`. Add the import:

```ts
import { rootTokenFingerprint } from "../../auth/root-token-fingerprint.js";
```

Then update the audit calls:

```ts
// Success path:
await writeDaemonAudit({
  action: "tokens_mint",
  ok: true,
  parent_agent_id: ctx.agent_id,
  child_agent_id: requested,
  root_token_fp: rootTokenFingerprint(getRootToken()),  // NEW
});

// Failure path (in the catch):
await writeDaemonAudit({
  action: "tokens_mint",
  ok: false,
  parent_agent_id: ctx.agent_id,
  child_agent_id: requested,
  error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
  root_token_fp: rootTokenFingerprint(getRootToken()),  // NEW
});
```

- [ ] **Step 7: Wire old + new fingerprints into `daemon-admin.ts`**

In `src/daemon/api/routes/daemon-admin.ts`, the `/v1/daemon/rotate` route currently writes `daemon_rotate` audit with `ok: true`. Capture the OLD fingerprint BEFORE `replaceRootToken`, the NEW fingerprint AFTER:

```ts
// Inside POST /v1/daemon/rotate, after the isRoot check + paths resolution,
// BEFORE the actual rotation:
const oldFp = rootTokenFingerprint(/* the current root token; read via server.getRootToken() */);

try {
  const paths = getShuttlePaths();
  const newToken = await rotateRootToken(paths.homeDir);
  await writeSocketFile({ port: daemonPortRef(), token: newToken, pid: process.pid });
  server.replaceRootToken(newToken);
  const newFp = rootTokenFingerprint(newToken);
  await writeDaemonAudit({
    action: "daemon_rotate",
    ok: true,
    actor_agent_id: "root",
    root_token_fp_prev: oldFp,  // NEW
    root_token_fp: newFp,       // NEW
  });
  return { ok: true, message: "..." };
} catch (err) {
  await writeDaemonAudit({
    action: "daemon_rotate",
    ok: false,
    actor_agent_id: "root",
    error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
    root_token_fp_prev: oldFp,  // NEW — known even on failure
  });
  throw err;
}
```

Look at the current state of `daemon-admin.ts` (it has try/catch + failure audit from a previous review-fix round). Adapt to match the existing structure — don't rewrite, just add the field.

For the non-root rejection audit path at the TOP of the handler (the path that fires BEFORE `try { ... }` because the failure-audit was added there in an earlier review round), DO NOT include `root_token_fp` — there's no rotation context yet. The field is optional, so omitting it is fine.

Same for the non-root rejection on `reset-machine-id` — leave it without `root_token_fp` (the action doesn't change the root token).

For the success path of `reset-machine-id`, you CAN add `root_token_fp: rootTokenFingerprint(server.getRootToken())` so audit readers can confirm the root WAS NOT rotated by this action (the fingerprint stays the same before/after). Optional polish; do it if the audit shape gains clarity, skip if it's noise.

- [ ] **Step 8: Update tokens.test.ts**

In `src/daemon/api/routes/tokens.test.ts`, find an existing test that asserts the audit log after a successful mint. Extend the assertion to check `root_token_fp` is an 8-char hex string. If no such test exists, add one:

```ts
test("POST /v1/tokens/mint: audit row carries root_token_fp", async () => {
  await withDaemon(async (ctx) => {
    // ... mint a token as root ...
    const r = await call(ctx, "POST", "/v1/tokens/mint", { agent_id: "claude-abc" });
    assert.equal(r.status, 200);
    // Read the latest audit line; assert tokens_mint row has root_token_fp = 8-hex.
    const auditPath = path.join(process.env.SECRET_SHUTTLE_HOME!, "audit.log");
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    const row = JSON.parse(lines[lines.length - 1]!);
    assert.equal(row.action, "tokens_mint");
    assert.match(row.root_token_fp, /^[0-9a-f]{8}$/);
  });
});
```

Look at how other audit-reading tests in the test suite (e.g., the A12 followup audit test in `approvals-session.test.ts`) handle the audit log path + polling — match that pattern.

- [ ] **Step 9: Update daemon-admin.test.ts**

Add a test that exercises the rotation continuity invariant:

```ts
test("POST /v1/daemon/rotate: audit row carries old + new root_token_fp", async () => {
  await withDaemon(async (ctx) => {
    // Capture the fingerprint BEFORE rotate.
    const fpBefore = rootTokenFingerprint(ctx.token);

    const r = await call(ctx, "POST", "/v1/daemon/rotate");
    assert.equal(r.status, 200);

    // Read the audit log; find the daemon_rotate row.
    const lines = (await readFile(/* audit path */, "utf8")).trim().split("\n");
    const rotateRow = lines.map(JSON.parse).find((row: { action: string }) => row.action === "daemon_rotate");
    assert.ok(rotateRow !== undefined);
    assert.equal(rotateRow.root_token_fp_prev, fpBefore, "old fingerprint matches captured pre-rotate value");
    assert.match(rotateRow.root_token_fp, /^[0-9a-f]{8}$/);
    assert.notEqual(rotateRow.root_token_fp, rotateRow.root_token_fp_prev, "fingerprints must differ across rotate");
  });
});
```

- [ ] **Step 10: Run all touched tests + full suite**

```bash
npx tsx --test src/daemon/auth/root-token-fingerprint.test.ts src/daemon/api/routes/tokens.test.ts src/daemon/api/routes/daemon-admin.test.ts && npm test && npx tsc --noEmit
```

Expected: all PASS. Test count: 1399 + ~4 new = ~1403.

- [ ] **Step 11: Commit**

```bash
git add src/daemon/auth/root-token-fingerprint.ts src/daemon/auth/root-token-fingerprint.test.ts src/daemon/audit.ts src/daemon/api/routes/tokens.ts src/daemon/api/routes/tokens.test.ts src/daemon/api/routes/daemon-admin.ts src/daemon/api/routes/daemon-admin.test.ts
git commit -m "feat(audit): root_token_fp on tokens_mint + daemon_rotate (A12 M6)

8-char SHA-256 prefix of the root token, stamped on every tokens_mint
audit row and on daemon_rotate (with prev + new fingerprints). Lets
audit-log readers bucket mint rows by which generation of the root
they were bound to, and chain the rotation timeline without seeing
the actual root token bytes.

Non-reversible (SHA-256 prefix), 4 bytes wide — adjacent generations
visually distinct in the log, collisions vanishingly unlikely across
a single daemon's lifetime."
```

---

## Self-review

### Spec coverage

- **T1 (atomic per-runtime loop):** Step 1 writes failing test; Step 3 implements; Step 4 verifies; Step 5 commits. TODO comment removed.
- **T2 (split error code):** Step 1 adds new code + registry test; Step 2 updates throw sites; Steps 3-5 verify; Step 6 commits.
- **T3 (ordering tests):** Steps 1-3 add 3 tests (ordering for read, ordering for write, throw-injection). Steps 4-5 verify. Step 6 commits. SKIP fallback documented inline.
- **T4 (root_token_fp):** Steps 1-4 fingerprint helper + tests. Step 5 audit field. Step 6 tokens.ts wiring. Step 7 daemon-admin wiring (with carve-out for non-root rejection path). Steps 8-10 tests + verify. Step 11 commits.

### Placeholder scan

- All `TODO(post-launch)` references in the plan are accounted for (T1 closes the only one).
- No "fill in later" / "similar to Task N" / "appropriate error handling" — every code block is concrete.
- One acknowledged conditional: T3 ordering tests have a documented SKIP fallback if monkey-patching proves impractical. This is intentional, not a placeholder.

### Type consistency

- `agent_runtimes_failed: Array<{runtime: string, error_code: string}>` — used in T1 step 3 (init.ts summary) and T1 step 1 (test assertion). Matches.
- `root_token_fp: string` — defined in T4 step 5 (audit.ts), consumed in T4 steps 6, 7. Matches.
- `root_token_fp_prev: string` — defined in T4 step 5, consumed in T4 step 7 + step 9 test assertion. Matches.
- `rootTokenFingerprint(rootToken: string): string` — defined in T4 step 3, called in T4 steps 6, 7, 9. Matches.
- `bootstrap_capture_field_unreadable` — defined in T2 step 1 (error-codes.ts), thrown at T2 step 2 sites, asserted in T2 step 4. Matches.

---

## Execution handoff

The plan is ready. The user already directed: "use superpowers and subagents." Proceed via `superpowers:subagent-driven-development` — fresh subagent per task with two-stage review (spec compliance → code quality). Skip the formal review for T3 if its tests are mostly SKIP-with-comment (no review value).
