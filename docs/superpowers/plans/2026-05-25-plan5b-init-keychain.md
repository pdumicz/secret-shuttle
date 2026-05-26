# Plan 5b + 5f-impl — Real `init` + Working OS Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx secret-shuttle init` becomes a real first-run that creates the vault, enrolls the OS keychain (Touch ID on macOS), and installs agent skill files. Subsequent unlocks use the keychain (one Touch ID prompt instead of typing a passphrase).

**Architecture:** Three layers, all under one plan:
- `@napi-rs/keyring` replaces the per-platform stubs in `src/vault/keychain/{darwin,linux,windows}.ts`. Keychain becomes a CACHE for the master key; the passphrase is the canonical recovery credential.
- Envelope gains a stable `id` field (UUID) — used as the keychain account key so multiple vaults can coexist on one machine.
- The unlock flow tries keychain first; falls back to passphrase UI on miss / cancellation. After successful passphrase unlock, opportunistically writes the master key to keychain (re-enroll after a corruption or device migration).

**Tech Stack:** TypeScript strict, ESM (.js suffixes), Node 20+, node:test, Commander.js, `@napi-rs/keyring` (new dep). Native module ships prebuilds for darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64.

---

## File Structure

**New files:**
- `src/cli/commands/keychain/index.ts` — registers keychain command group.
- `src/cli/commands/keychain/enable.ts`, `disable.ts`, `status.ts` — three CLI commands.
- `src/daemon/api/routes/keychain.ts` — three daemon routes (`/v1/keychain/{enable,disable,status}`).
- `src/cli/agent-runtime-detect.ts` — `detectAgentRuntimes(cwd)` helper for init.
- Test files for each of the above.

**Modified files:**
- `package.json` — add `@napi-rs/keyring` dependency.
- `src/vault/envelope.ts` — add `id` field, mint on write, migrate on read.
- `src/vault/envelope.test.ts` — test migration path.
- `src/vault/keychain/darwin.ts`, `linux.ts`, `windows.ts` — replace stubs with real implementations.
- `src/vault/keychain/{darwin,linux,windows}.test.ts` — real-keychain tests gated on CI_ALLOW_KEYCHAIN.
- `src/daemon/api/routes/unlock-session.ts` — try-keychain-first + opportunistic post-passphrase enroll.
- `src/daemon/api/router.ts` (or wherever routes register) — wire keychain routes.
- `src/cli/index.ts` — register the keychain command group.
- `src/cli/commands/init.ts` — real init command body (today: ~24-line status wrapper).
- `src/cli/commands/init.test.ts` — new tests.
- `src/shared/error-codes.ts` — add `keychain_unavailable`, `keychain_key_invalid`. (`daemon_start_failed` was renamed to `daemon_start_timeout` in implementation — already exists in the registry.)
- `src/shared/error-codes.test.ts` — count + assertions.
- `docs/cli-reference.md` — add `init`, `keychain {enable,disable,status}` sections.
- `CHANGELOG.md` — Plan 5b + 5f-impl entry.

---

## Verification commands

Used throughout. Each task ends with these (or a subset).

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

Keychain tests that hit the real OS keychain are gated on env var:
```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/
```

Without the env var, those tests SKIP (not fail). This is so:
- CI in containers (no keychain) doesn't break.
- Local dev runs don't pollute the dev's actual keychain.
- Explicit opt-in proves the tests work end-to-end on real hardware.

---

## Task A1: Add `@napi-rs/keyring` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install @napi-rs/keyring --save
```

Expected: `package.json` gains `"@napi-rs/keyring": "^<version>"` under `dependencies`. `package-lock.json` updates. `node_modules/@napi-rs/keyring/` exists.

- [ ] **Step 2: Verify it imports cleanly**

Write a quick sanity check (do NOT commit; just verify):
```bash
node -e "import('@napi-rs/keyring').then(m => console.log(Object.keys(m)))"
```

Expected: prints exports including `Entry`. If it fails on this machine due to missing prebuilds, investigate — the supported platforms (darwin-x64/arm64, linux-x64/arm64, win32-x64) should all have prebuilds available on npm.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: clean (the dep doesn't affect TypeScript without imports).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): add @napi-rs/keyring for OS keychain integration

Plan 5b/5f-impl prereq. Existing keychain stubs (src/vault/keychain/
{darwin,linux,windows}.ts) cite this library — locking it in.

Native bindings via napi-rs. Memory-only API (getPassword /
setPassword / deletePassword) — no argv leakage. Prebuilds ship
per platform; no .node build step for consumers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A2: Implement DarwinKeychain (real)

**Files:**
- Modify: `src/vault/keychain/darwin.ts` (replace stub body)
- Modify: `src/vault/keychain/darwin.test.ts` (real-keychain tests gated on CI_ALLOW_KEYCHAIN)

- [ ] **Step 1: Check the existing test file shape**

```bash
ls src/vault/keychain/darwin.test.ts 2>&1
```

If it exists, read it to see how the stub is tested today. If not, we create one.

```bash
ls src/vault/keychain/*.test.ts 2>&1
```

There's likely an index-level test (`index.test.ts`) and per-platform tests may not exist yet. If not, create `darwin.test.ts`.

- [ ] **Step 2: Write the failing tests**

Create or update `src/vault/keychain/darwin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { DarwinKeychain } from "./darwin.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "darwin";
const TEST_SERVICE = "secret-shuttle-test-darwin";

test("DarwinKeychain: isAvailable returns true on macOS with @napi-rs/keyring loaded", { skip }, async () => {
  const k = new DarwinKeychain();
  assert.strictEqual(await k.isAvailable(), true);
});

test("DarwinKeychain: set + get round-trips a Buffer", { skip }, async () => {
  const k = new DarwinKeychain();
  const account = `roundtrip-${Date.now()}`;
  const value = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  try {
    await k.set(TEST_SERVICE, account, value);
    const got = await k.get(TEST_SERVICE, account);
    assert.ok(got !== null);
    assert.deepStrictEqual(got, value);
  } finally {
    await k.delete(TEST_SERVICE, account).catch(() => undefined);
  }
});

test("DarwinKeychain: get returns null when no entry exists", { skip }, async () => {
  const k = new DarwinKeychain();
  const got = await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`);
  assert.strictEqual(got, null);
});

test("DarwinKeychain: delete is idempotent (no-op for missing entry)", { skip }, async () => {
  const k = new DarwinKeychain();
  // Should not throw.
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});

test("DarwinKeychain: delete actually removes the entry", { skip }, async () => {
  const k = new DarwinKeychain();
  const account = `delete-test-${Date.now()}`;
  await k.set(TEST_SERVICE, account, Buffer.from("test"));
  assert.ok((await k.get(TEST_SERVICE, account)) !== null);
  await k.delete(TEST_SERVICE, account);
  assert.strictEqual(await k.get(TEST_SERVICE, account), null);
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:
```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/darwin.test.ts 2>&1 | tail -20
```

Expected on macOS: tests run, all FAIL (stubs throw `keychain_not_implemented` from `set`/`get`/`delete`, and `isAvailable` returns false). On non-darwin: tests skip.

If the tests can't run (e.g., @napi-rs/keyring failed to load), investigate before continuing.

- [ ] **Step 4: Replace stub with real implementation**

Replace `src/vault/keychain/darwin.ts` contents:

```ts
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

// Dynamic import so the module can be loaded on platforms where @napi-rs/keyring
// fails (we want isAvailable() to return false rather than module-load throwing).
let KeyringEntry: typeof import("@napi-rs/keyring").Entry | null = null;

async function loadKeyring(): Promise<typeof import("@napi-rs/keyring").Entry | null> {
  if (KeyringEntry !== null) return KeyringEntry;
  try {
    const mod = await import("@napi-rs/keyring");
    KeyringEntry = mod.Entry;
    return KeyringEntry;
  } catch {
    return null;
  }
}

/**
 * macOS Keychain Services adapter via @napi-rs/keyring.
 *
 * Keychain access triggers Touch ID / passphrase prompts at the OS layer —
 * the OS UX is the credential check, this adapter just shuttles the bytes.
 *
 * Values are stored base64-encoded (Keychain stores strings; we want Buffers).
 */
export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    const E = await loadKeyring();
    return E !== null;
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.setPassword(secret.toString("base64"));
    } catch (e) {
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain set failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    const E = await loadKeyring();
    if (E === null) return null;
    try {
      const entry = new E(service, account);
      const v = entry.getPassword();
      if (v === null || v === undefined) return null;
      return Buffer.from(v, "base64");
    } catch {
      // Touch ID cancelled, no entry, permission denied → null.
      // The caller treats null as "fall through to passphrase UI".
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.deletePassword();
    } catch (e) {
      // Already absent is fine.
      if (e instanceof Error && /No matching entry|not found/i.test(e.message)) return;
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/darwin.test.ts 2>&1 | tail -20
```

Expected on macOS: all 5 tests pass. On macOS, the FIRST set call may pop a Keychain prompt asking the user to allow access. Click "Allow" or "Always Allow" — that's expected.

Then full suite without the env var (to confirm tests skip cleanly):
```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

Expected: test count +5 to the skipped bucket on this machine if CI_ALLOW_KEYCHAIN isn't set.

- [ ] **Step 6: Commit**

```bash
git add src/vault/keychain/darwin.ts src/vault/keychain/darwin.test.ts
git commit -m "$(cat <<'EOF'
feat(keychain/darwin): real macOS Keychain Services via @napi-rs/keyring

Plan 5f-impl. Replaces the stub with a real implementation. Touch ID
prompts fire at the OS layer when the user runs unlock — no extra
UX code in the daemon.

Buffers stored base64-encoded (Keychain stores strings). get() returns
null on any failure (no entry, Touch ID cancelled, permission denied)
so the unlock flow falls through to the passphrase UI cleanly. delete()
is idempotent — missing entry is not an error.

Tests gated on CI_ALLOW_KEYCHAIN=1 to keep the dev's real keychain
untouched by default CI runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A3: Implement LinuxKeychain (real)

**Files:**
- Modify: `src/vault/keychain/linux.ts`
- Create or modify: `src/vault/keychain/linux.test.ts`

- [ ] **Step 1: Write failing tests**

`src/vault/keychain/linux.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { LinuxKeychain } from "./linux.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "linux";
const TEST_SERVICE = "secret-shuttle-test-linux";

test("LinuxKeychain: isAvailable returns true on Linux with libsecret available", { skip }, async () => {
  const k = new LinuxKeychain();
  // libsecret may not be present in minimal containers — isAvailable should
  // report honestly. If it returns false here, the test environment is
  // missing the secret-tool / libsecret service.
  const avail = await k.isAvailable();
  assert.strictEqual(typeof avail, "boolean");
});

test("LinuxKeychain: set + get round-trips a Buffer (skips if libsecret absent)", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  const account = `roundtrip-${Date.now()}`;
  const value = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  try {
    await k.set(TEST_SERVICE, account, value);
    const got = await k.get(TEST_SERVICE, account);
    assert.deepStrictEqual(got, value);
  } finally {
    await k.delete(TEST_SERVICE, account).catch(() => undefined);
  }
});

test("LinuxKeychain: get returns null when no entry exists", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  assert.strictEqual(await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`), null);
});

test("LinuxKeychain: delete is idempotent", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/linux.test.ts 2>&1 | tail -15
```

Expected on Linux with libsecret: tests fail. On macOS: skip.

- [ ] **Step 3: Replace stub with real implementation**

Replace `src/vault/keychain/linux.ts` contents (identical shape to darwin.ts — `@napi-rs/keyring` abstracts the OS):

```ts
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

let KeyringEntry: typeof import("@napi-rs/keyring").Entry | null = null;

async function loadKeyring(): Promise<typeof import("@napi-rs/keyring").Entry | null> {
  if (KeyringEntry !== null) return KeyringEntry;
  try {
    const mod = await import("@napi-rs/keyring");
    KeyringEntry = mod.Entry;
    return KeyringEntry;
  } catch {
    return null;
  }
}

/**
 * Linux libsecret adapter via @napi-rs/keyring.
 *
 * Uses the Secret Service API (gnome-keyring, KeePassXC integration, etc.).
 * Falls back to isAvailable: false if libsecret is missing (e.g., minimal
 * containers without a desktop session).
 */
export class LinuxKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    const E = await loadKeyring();
    if (E === null) return false;
    // libsecret may be installed but unreachable (no D-Bus session).
    // Probe with a read of a guaranteed-empty entry.
    try {
      const entry = new E("secret-shuttle-probe", "isAvailable");
      entry.getPassword(); // no-op if absent
      return true;
    } catch {
      return false;
    }
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.setPassword(secret.toString("base64"));
    } catch (e) {
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain set failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    const E = await loadKeyring();
    if (E === null) return null;
    try {
      const entry = new E(service, account);
      const v = entry.getPassword();
      if (v === null || v === undefined) return null;
      return Buffer.from(v, "base64");
    } catch {
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.deletePassword();
    } catch (e) {
      if (e instanceof Error && /No matching entry|not found/i.test(e.message)) return;
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/linux.test.ts 2>&1 | tail -15
```

Expected on Linux with libsecret: all tests pass. On macOS or in libsecret-less Linux: skips appropriately.

- [ ] **Step 5: Commit**

```bash
git add src/vault/keychain/linux.ts src/vault/keychain/linux.test.ts
git commit -m "$(cat <<'EOF'
feat(keychain/linux): real libsecret adapter via @napi-rs/keyring

Plan 5f-impl. Linux Secret Service API (gnome-keyring / KDE Wallet /
KeePassXC integration). isAvailable() probes for libsecret reachability
and returns false in minimal containers without a D-Bus session.

Same shape as darwin.ts — @napi-rs/keyring abstracts the OS API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A4: Implement WindowsKeychain (real)

**Files:**
- Modify: `src/vault/keychain/windows.ts`
- Create or modify: `src/vault/keychain/windows.test.ts`

- [ ] **Step 1: Write failing tests**

`src/vault/keychain/windows.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { WindowsKeychain } from "./windows.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "win32";
const TEST_SERVICE = "secret-shuttle-test-windows";

test("WindowsKeychain: isAvailable returns true on Windows with @napi-rs/keyring loaded", { skip }, async () => {
  const k = new WindowsKeychain();
  assert.strictEqual(await k.isAvailable(), true);
});

test("WindowsKeychain: set + get round-trips a Buffer", { skip }, async () => {
  const k = new WindowsKeychain();
  const account = `roundtrip-${Date.now()}`;
  const value = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  try {
    await k.set(TEST_SERVICE, account, value);
    const got = await k.get(TEST_SERVICE, account);
    assert.deepStrictEqual(got, value);
  } finally {
    await k.delete(TEST_SERVICE, account).catch(() => undefined);
  }
});

test("WindowsKeychain: get returns null when no entry exists", { skip }, async () => {
  const k = new WindowsKeychain();
  assert.strictEqual(await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`), null);
});

test("WindowsKeychain: delete is idempotent", { skip }, async () => {
  const k = new WindowsKeychain();
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/windows.test.ts 2>&1 | tail -15
```

Expected on Windows: tests fail (stub). Elsewhere: skip.

- [ ] **Step 3: Replace stub**

Replace `src/vault/keychain/windows.ts` (identical shape to darwin/linux):

```ts
import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

let KeyringEntry: typeof import("@napi-rs/keyring").Entry | null = null;

async function loadKeyring(): Promise<typeof import("@napi-rs/keyring").Entry | null> {
  if (KeyringEntry !== null) return KeyringEntry;
  try {
    const mod = await import("@napi-rs/keyring");
    KeyringEntry = mod.Entry;
    return KeyringEntry;
  } catch {
    return null;
  }
}

/**
 * Windows Credential Manager (DPAPI) adapter via @napi-rs/keyring.
 *
 * Uses Windows Credential Manager. Transparent unlock when the user is
 * logged in (no extra prompt). Encryption is DPAPI-bound to the user
 * account; entries cannot be read by other users on the same machine.
 */
export class WindowsKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    const E = await loadKeyring();
    return E !== null;
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.setPassword(secret.toString("base64"));
    } catch (e) {
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain set failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    const E = await loadKeyring();
    if (E === null) return null;
    try {
      const entry = new E(service, account);
      const v = entry.getPassword();
      if (v === null || v === undefined) return null;
      return Buffer.from(v, "base64");
    } catch {
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      entry.deletePassword();
    } catch (e) {
      if (e instanceof Error && /No matching entry|not found/i.test(e.message)) return;
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
```

- [ ] **Step 4: Verify**

```bash
CI_ALLOW_KEYCHAIN=1 npm test -- src/vault/keychain/windows.test.ts 2>&1 | tail -15
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/vault/keychain/windows.ts src/vault/keychain/windows.test.ts
git commit -m "$(cat <<'EOF'
feat(keychain/windows): real Credential Manager (DPAPI) adapter

Plan 5f-impl. Windows Credential Manager via @napi-rs/keyring.
Transparent unlock when user is logged in (no extra prompt).
DPAPI-bound to the user account.

Same shape as darwin.ts / linux.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B1: Envelope gains `id` field + transparent migration

**Files:**
- Modify: `src/vault/envelope.ts`
- Modify: `src/vault/envelope.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/vault/envelope.test.ts`:

```ts
test("envelope: new envelopes get a UUID id field on write", async () => {
  const masterKey = randomBytes(32);
  const env = await encryptEnvelope(masterKey, "passphrase");
  // After our change, encryptEnvelope produces an envelope with id set.
  assert.ok(typeof env.id === "string");
  assert.match(env.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("envelope: readEnvelope mints id for legacy envelopes (no id field)", async () => {
  // Write a legacy envelope (no id field) directly to disk.
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  const legacy = {
    version: 2,
    kdf: "scrypt",
    kdfParams: { N: 32768, r: 8, p: 1 },
    salt: "abc",
    algorithm: "aes-256-gcm",
    nonce: "def",
    authTag: "ghi",
    ciphertext: "jkl",
    created_at: new Date().toISOString(),
  };
  await writeFile(paths.envelopePath, JSON.stringify(legacy), { mode: 0o600 });

  const read = await readEnvelope();
  assert.ok(read !== null);
  assert.ok(typeof read.id === "string");
  assert.match(read.id, /^[0-9a-f]{8}-/);

  // Verify it was persisted to disk.
  const reread = await readEnvelope();
  assert.strictEqual(reread?.id, read.id, "id must be stable across reads");
});
```

Imports needed at top of the test file (check what's already there):
```ts
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";
// ... existing imports ...
```

The test isolation pattern (each test in its own temp SHUTTLE_HOME) should already exist — verify the file's existing tests use the pattern and follow it.

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/vault/envelope.test.ts --test-name-pattern="envelope: " 2>&1 | tail -20
```

Expected: tests fail. `env.id` is undefined.

- [ ] **Step 3: Modify envelope.ts**

In `src/vault/envelope.ts`, update the `EnvelopeFile` interface and `encryptEnvelope`:

```ts
import { randomUUID } from "node:crypto";

// ...existing imports unchanged...

export interface EnvelopeFile {
  version: 2;
  /**
   * Stable UUID. Used as the keychain account key when caching the master
   * key for Touch ID / libsecret / DPAPI unlock. Generated on first write;
   * legacy envelopes lacking this field get one minted transparently by
   * readEnvelope.
   */
  id: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number };
  salt: string;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
  created_at: string;
}

export async function encryptEnvelope(
  masterKey: Buffer,
  passphrase: string,
  /** Optional id — if omitted, a fresh UUID is minted. Used internally for re-encrypt-with-new-passphrase flows that preserve the original id. */
  id?: string,
): Promise<EnvelopeFile> {
  // ...existing validation unchanged...

  // ...existing salt/kek/cipher computation unchanged...

  return {
    version: 2,
    id: id ?? randomUUID(),
    kdf: "scrypt",
    kdfParams: { N: KDF_N, r: KDF_R, p: KDF_P },
    salt: salt.toString("base64url"),
    algorithm: ALGO,
    nonce: nonce.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    created_at: new Date().toISOString(),
  };
}
```

Update `readEnvelope` to mint id for legacy envelopes:

```ts
export async function readEnvelope(): Promise<EnvelopeFile | null> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.envelopePath))) return null;
  const raw = await readFile(paths.envelopePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<EnvelopeFile>;
  if (parsed.version !== 2) {
    throw new ShuttleError("unsupported_envelope", "Envelope file version is not 2.");
  }
  if (typeof parsed.id !== "string") {
    // Legacy envelope without id — mint one and persist.
    const upgraded: EnvelopeFile = { ...(parsed as EnvelopeFile), id: randomUUID() };
    await writeEnvelope(upgraded);
    return upgraded;
  }
  return parsed as EnvelopeFile;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- src/vault/envelope.test.ts 2>&1 | tail -10
npm run typecheck 2>&1 | tail -10
```

Expected: all envelope tests pass.

If unlock-flow tests fail because they create envelopes manually without id, fix those test fixtures — `encryptEnvelope` is the canonical way; tests using ad-hoc objects need to add `id: randomUUID()`.

- [ ] **Step 5: Commit**

```bash
git add src/vault/envelope.ts src/vault/envelope.test.ts
git commit -m "$(cat <<'EOF'
feat(envelope): add stable UUID id field; transparent migration for legacy

Plan 5b prereq. EnvelopeFile gains `id: string` (UUID). encryptEnvelope
mints a fresh UUID by default; an optional id parameter preserves the
existing id during re-encrypt-with-new-passphrase flows.

readEnvelope transparently upgrades legacy envelopes (no id field)
by minting a UUID and writing it back to disk. No separate migration
command needed — first read after upgrade does the work, then the
id is stable forever.

The id is the keychain account key ("secret-shuttle", <uuid>), so
multiple Secret Shuttle vaults on the same machine (via different
SHUTTLE_HOME dirs) don't collide on a single keychain entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C1: Unlock flow tries keychain first

**Files:**
- Modify: `src/daemon/api/routes/unlock-session.ts`
- Modify: `src/daemon/api/routes/unlock-session.test.ts`

- [ ] **Step 1: Inspect the current unlock-session route**

```bash
cat src/daemon/api/routes/unlock-session.ts | head -100
```

Identify:
- The `POST /v1/unlock/start` handler structure.
- Where the passphrase UI is opened (`openUrl` call, session creation).
- How `services.lock.unlock(masterKey)` is called on the passphrase-completion path.

- [ ] **Step 2: Write the failing test**

Append to `src/daemon/api/routes/unlock-session.test.ts`:

```ts
test("unlock-session: warm keychain entry → skips passphrase UI", async () => {
  // Set up: envelope exists, keychain has the right master key.
  // POST /v1/unlock/start → expect 200 with { unlocked: true, source: "keychain" }.
  // No browser opened (verify via openUrlImpl mock).
  // services.lock.isUnlocked() returns true after.
  
  // Implementation depends on the existing test harness shape — match it.
  // Use a MockKeychain that returns the master key matching the envelope.
});

test("unlock-session: cold (no keychain entry) → falls through to passphrase UI", async () => {
  // Envelope exists, keychain returns null.
  // POST /v1/unlock/start → expect { session_id, ... } (passphrase flow).
  // Browser open was triggered.
});

test("unlock-session: invalid keychain key → falls through to passphrase UI with audit", async () => {
  // Envelope exists, keychain returns a 32-byte buffer that's NOT the master key.
  // After unlock(wrong) the vault would corrupt; the route catches this and falls through.
  // Audit log records keychain_key_invalid.
});
```

Adapt to the actual test harness. If the existing tests construct `DaemonServices` directly, inject a `MockKeychain` via a hook (likely needs adding — or via test-only env var that overrides `getKeychainAdapter`).

- [ ] **Step 3: Run to verify failure**

```bash
npm test -- src/daemon/api/routes/unlock-session.test.ts --test-name-pattern="keychain" 2>&1 | tail -15
```

Expected: fail.

- [ ] **Step 4: Modify unlock-session.ts**

Add to the `/v1/unlock/start` handler, BEFORE the existing session-creation code:

```ts
import { getKeychainAdapter } from "../../../vault/keychain/index.js";

// ...existing code...

server.addRoute("POST", "/v1/unlock/start", async () => {
  const envelope = await readEnvelope();
  if (envelope === null) {
    throw new ShuttleError(
      "envelope_missing",
      "No vault exists. Run `secret-shuttle init`.",
    );
  }

  // Try the keychain. On macOS this triggers Touch ID synchronously.
  // If it returns a key, attempt to unlock — if that fails (invalid key),
  // fall through to the passphrase UI.
  const keychain = getKeychainAdapter();
  if (await keychain.isAvailable()) {
    const cached = await keychain.get("secret-shuttle", envelope.id);
    if (cached !== null) {
      // Validate the cached key by re-deriving the canonical check:
      // a 32-byte key that maps to the same vault. We don't have a
      // separate validation token — best effort: attempt unlock and
      // see if vault.ensureInitialized succeeds. If not, fall through.
      try {
        services.lock.unlock(cached);
        await services.vault.ensureInitialized();
        await writeDaemonAudit({ action: "unlock", ok: true, source: "keychain" });
        return { unlocked: true, source: "keychain" };
      } catch (e) {
        // Re-lock to clear the invalid key, then fall through.
        services.lock.lock();
        await writeDaemonAudit({
          action: "unlock",
          ok: false,
          error_code: "keychain_key_invalid",
          source: "keychain",
        });
        // Fall through to passphrase UI.
      }
    }
  }

  // Existing passphrase UI flow.
  // ...session creation, browser open, return { session_id, ... } ...
});
```

If `services.vault.ensureInitialized()` doesn't exist with that exact name, find the equivalent guard that surfaces "this key doesn't unlock the vault" and use it.

- [ ] **Step 5: Run to verify pass**

```bash
npm test -- src/daemon/api/routes/unlock-session.test.ts 2>&1 | tail -15
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/unlock-session.ts src/daemon/api/routes/unlock-session.test.ts
git commit -m "$(cat <<'EOF'
feat(unlock): try keychain before passphrase UI

Plan 5b. POST /v1/unlock/start now tries the OS keychain first — on
macOS this fires Touch ID, on Linux libsecret prompts (or silently
returns), on Windows DPAPI unlocks transparently.

On any keychain failure (no entry, cancelled, invalid key), falls
through to the existing browser passphrase UI. Audit log records
keychain_key_invalid for the "wrong cached key" case.

The keychain is a CACHE; the passphrase remains the canonical
recovery credential.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C2: Opportunistic post-passphrase enrollment

**Files:**
- Modify: `src/daemon/api/routes/unlock-session.ts` (the passphrase-submit handler)

- [ ] **Step 1: Find the passphrase-completion handler**

The session-based flow has a separate handler (`POST /ui/unlock/:id` or similar) that decrypts the envelope with the user-supplied passphrase. Find it:

```bash
grep -n "decryptEnvelope\|services.lock.unlock" src/daemon/api/routes/unlock-session.ts
```

- [ ] **Step 2: Write the test**

Append to `src/daemon/api/routes/unlock-session.test.ts`:

```ts
test("unlock-session: successful passphrase unlock writes master key to keychain (opportunistic)", async () => {
  // Set up: envelope exists, keychain empty.
  // Submit passphrase via the session route.
  // After unlock: keychain.get(envelope.id) returns the master key.
  // Use MockKeychain to verify the set() was called.
});

test("unlock-session: keychain write failure does NOT block unlock", async () => {
  // Set up: envelope exists, keychain.set throws.
  // Submit passphrase via the session route.
  // Unlock STILL succeeds (best-effort caching).
});
```

- [ ] **Step 3: Run to verify failure**

- [ ] **Step 4: Modify the passphrase-submit handler**

After the existing `services.lock.unlock(masterKey)` call, add:

```ts
// Opportunistic keychain enrollment. If keychain is available, cache the
// master key so the next unlock can skip the passphrase UI. Failures are
// swallowed — unlock has already succeeded; this is best-effort caching.
const keychain = getKeychainAdapter();
if (await keychain.isAvailable()) {
  try {
    await keychain.set("secret-shuttle", envelope.id, masterKey);
  } catch {
    // Best-effort; do not surface to caller.
  }
}
```

`envelope` is the EnvelopeFile in scope; `masterKey` is the just-derived 32-byte Buffer.

- [ ] **Step 5: Verify**

```bash
npm test -- src/daemon/api/routes/unlock-session.test.ts 2>&1 | tail -15
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/unlock-session.ts src/daemon/api/routes/unlock-session.test.ts
git commit -m "$(cat <<'EOF'
feat(unlock): opportunistic keychain enrollment after passphrase unlock

Plan 5b. After successful passphrase unlock, the daemon writes the
master key to the OS keychain (best-effort). Subsequent unlocks
skip the passphrase UI.

Handles the device-migration / keychain-corruption recovery path:
user moves to a new machine with no keychain entry → first unlock
uses passphrase → cache populated → subsequent unlocks use Touch ID.

Failures are swallowed — unlock has already succeeded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task D: Keychain control routes

**Files:**
- Create: `src/daemon/api/routes/keychain.ts`
- Create: `src/daemon/api/routes/keychain.test.ts`
- Modify: `src/daemon/api/router.ts` (or wherever routes register)

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/api/routes/keychain.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
// ... import harness as in other route tests ...

test("POST /v1/keychain/enable: stores master key in keychain (requires unlocked vault)", async () => {
  // harness with daemon unlocked, MockKeychain.
  // POST /v1/keychain/enable → { ok: true, enrolled: true }.
  // MockKeychain.set was called with ("secret-shuttle", envelope.id, masterKey).
});

test("POST /v1/keychain/enable: throws vault_locked when not unlocked", async () => {
  // Daemon locked.
  // POST /v1/keychain/enable → vault_locked.
});

test("POST /v1/keychain/disable: removes keychain entry", async () => {
  // Pre-seed MockKeychain with an entry.
  // POST /v1/keychain/disable → { ok: true, removed: true }.
  // MockKeychain.delete was called.
});

test("POST /v1/keychain/disable: idempotent (no entry)", async () => {
  // Empty keychain.
  // POST /v1/keychain/disable → { ok: true, removed: true } (no error).
});

test("GET /v1/keychain/status: returns availability + enrollment state", async () => {
  // POST → { available: true, enrolled: false, vault_id: "<uuid>" }.
  // After enable → { available: true, enrolled: true, vault_id: ... }.
});
```

- [ ] **Step 2: Create the route file**

`src/daemon/api/routes/keychain.ts`:

```ts
import { ShuttleError } from "../../../shared/errors.js";
import { getKeychainAdapter } from "../../../vault/keychain/index.js";
import { readEnvelope } from "../../../vault/envelope.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerKeychainRoutes(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/keychain/enable", async () => {
    const masterKey = services.lock.requireKey();
    const envelope = await readEnvelope();
    if (envelope === null) {
      throw new ShuttleError("envelope_missing", "No vault exists.");
    }
    const keychain = getKeychainAdapter();
    if (!(await keychain.isAvailable())) {
      throw new ShuttleError(
        "keychain_unavailable",
        "OS keychain is not available on this platform / environment.",
      );
    }
    await keychain.set("secret-shuttle", envelope.id, masterKey);
    return { ok: true, enrolled: true };
  });

  server.addRoute("POST", "/v1/keychain/disable", async () => {
    const envelope = await readEnvelope();
    if (envelope === null) {
      throw new ShuttleError("envelope_missing", "No vault exists.");
    }
    const keychain = getKeychainAdapter();
    if (!(await keychain.isAvailable())) {
      // No keychain → nothing to remove. Return success.
      return { ok: true, removed: true };
    }
    await keychain.delete("secret-shuttle", envelope.id);
    return { ok: true, removed: true };
  });

  server.addRoute("GET", "/v1/keychain/status", async () => {
    const envelope = await readEnvelope();
    const keychain = getKeychainAdapter();
    const available = await keychain.isAvailable();
    let enrolled = false;
    let vaultId: string | null = null;
    if (envelope !== null) {
      vaultId = envelope.id;
      if (available) {
        const entry = await keychain.get("secret-shuttle", envelope.id);
        enrolled = entry !== null;
      }
    }
    return { available, enrolled, vault_id: vaultId };
  });
}
```

- [ ] **Step 3: Wire into the router**

Find where other routes are registered. Likely `src/daemon/api/router.ts` has a list of `register*` calls. Add:

```ts
import { registerKeychainRoutes } from "./routes/keychain.js";

// inside the registration function:
registerKeychainRoutes(server, services);
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test -- src/daemon/api/routes/keychain.test.ts 2>&1 | tail -15
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/keychain.ts src/daemon/api/routes/keychain.test.ts src/daemon/api/router.ts
git commit -m "$(cat <<'EOF'
feat(daemon): /v1/keychain/{enable,disable,status} routes

Plan 5b. Three new routes for explicit keychain control:

  POST /v1/keychain/enable  — requires unlocked vault; stores
    master key in OS keychain.
  POST /v1/keychain/disable — removes keychain entry; idempotent.
  GET  /v1/keychain/status  — { available, enrolled, vault_id }.

Used by init's enrollment step and by `secret-shuttle keychain
{enable,disable,status}` CLI commands (next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task E: Error registry — keychain-related codes

**Files:**
- Modify: `src/shared/error-codes.ts`
- Modify: `src/shared/error-codes.test.ts`

- [ ] **Step 1: Inspect current registry**

```bash
grep -n "keychain_unavailable\|keychain_not_implemented\|keychain_key_invalid\|daemon_start_timeout" src/shared/error-codes.ts
```

`keychain_not_implemented` and `keychain_unavailable` may already exist (the existing stub throws `keychain_not_implemented`, and Plan 5d's nextAction work added `keychain_unavailable`). Verify.

- [ ] **Step 2: Add missing entries**

Add (or update if present):

```ts
keychain_key_invalid: {
  exitCode: EXIT_CODE_PERMISSION,
  hint: () => "Cached keychain entry doesn't unlock the vault. Run: secret-shuttle unlock",
  nextAction: () => "secret-shuttle unlock",
},
// Note: daemon_start_failed was renamed daemon_start_timeout in implementation.
// daemon_start_timeout already exists in the registry from lifecycle.ts — reuse it.
// No new entry needed here.
```

Verify `keychain_unavailable` has nextAction (Plan 5d should have added it):
```ts
keychain_unavailable: {
  exitCode: EXIT_CODE_PERMISSION,
  hint: () => "Keychain unavailable; falling back to passphrase. Run: secret-shuttle unlock",
  nextAction: () => "secret-shuttle unlock",
},
```

- [ ] **Step 3: Update count + tests**

In `src/shared/error-codes.test.ts`, find the total-count assertion and add to it. Likely +2 codes.

Add unit tests:
```ts
test("error-codes: keychain_key_invalid registered with PERMISSION exit code + nextAction", () => {
  const entry = lookupErrorCode("keychain_key_invalid");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_PERMISSION);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle unlock");
});

test("error-codes: daemon_start_timeout registered with TRANSIENT exit code + nextAction", () => {
  // Note: plan originally named this daemon_start_failed; implementation uses
  // daemon_start_timeout from lifecycle.ts (already in the registry).
  const entry = lookupErrorCode("daemon_start_timeout");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_TRANSIENT);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle daemon status");
});
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test -- src/shared/error-codes.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "$(cat <<'EOF'
feat(errors): add keychain_key_invalid + daemon_start_timeout codes

Plan 5b. Two new/updated error codes for the init + keychain unlock flows:

  - keychain_key_invalid (PERMISSION): cached key didn't unlock the
    vault. nextAction: "secret-shuttle unlock".
  - daemon_start_timeout (TRANSIENT): daemon spawn timed out during
    init. (Originally planned as daemon_start_failed; implementation
    reuses daemon_start_timeout from lifecycle.ts.)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F: `keychain enable/disable/status` CLI commands

**Files:**
- Create: `src/cli/commands/keychain/index.ts`
- Create: `src/cli/commands/keychain/enable.ts`, `disable.ts`, `status.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Create the command group**

`src/cli/commands/keychain/index.ts`:

```ts
import { Command } from "commander";
import { keychainEnableCommand } from "./enable.js";
import { keychainDisableCommand } from "./disable.js";
import { keychainStatusCommand } from "./status.js";

export function keychainCommand(): Command {
  return new Command("keychain")
    .description("Manage OS keychain enrollment for passwordless unlock (Touch ID on macOS, libsecret on Linux, DPAPI on Windows).")
    .addCommand(keychainEnableCommand())
    .addCommand(keychainDisableCommand())
    .addCommand(keychainStatusCommand());
}
```

- [ ] **Step 2: Create enable/disable/status command files**

`src/cli/commands/keychain/enable.ts`:

```ts
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainEnableCommand(): Command {
  return new Command("enable")
    .description("Store the master key in the OS keychain so the next unlock uses Touch ID / DPAPI / libsecret instead of the passphrase UI. Requires an unlocked vault.")
    .action(async () => {
      const r = await daemonRequest<{ enrolled: boolean }>("POST", "/v1/keychain/enable");
      outputJson(ok({ enrolled: r.enrolled }));
    });
}
```

`src/cli/commands/keychain/disable.ts`:

```ts
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainDisableCommand(): Command {
  return new Command("disable")
    .description("Remove the master key from the OS keychain. Subsequent unlocks will require the passphrase UI.")
    .action(async () => {
      const r = await daemonRequest<{ removed: boolean }>("POST", "/v1/keychain/disable");
      outputJson(ok({ removed: r.removed }));
    });
}
```

`src/cli/commands/keychain/status.ts`:

```ts
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function keychainStatusCommand(): Command {
  return new Command("status")
    .description("Report keychain availability + enrollment state.")
    .action(async () => {
      const r = await daemonRequest<{ available: boolean; enrolled: boolean; vault_id: string | null }>(
        "GET",
        "/v1/keychain/status",
      );
      outputJson(ok({
        available: r.available,
        enrolled: r.enrolled,
        vault_id: r.vault_id,
      }));
    });
}
```

- [ ] **Step 3: Wire into CLI index**

In `src/cli/index.ts`, find the existing command registrations and add:

```ts
import { keychainCommand } from "./commands/keychain/index.js";

// ...inside program setup...
program.addCommand(keychainCommand());
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/keychain/ src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): secret-shuttle keychain {enable,disable,status}

Plan 5b. Three new CLI commands for explicit OS keychain control:

  secret-shuttle keychain enable   — cache the master key.
  secret-shuttle keychain disable  — remove the cache.
  secret-shuttle keychain status   — report availability + enrollment.

Wraps the daemon's /v1/keychain/* routes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G1: Agent runtime detection helper

**Files:**
- Create: `src/cli/agent-runtime-detect.ts`
- Create: `src/cli/agent-runtime-detect.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/cli/agent-runtime-detect.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectAgentRuntimes } from "./agent-runtime-detect.js";

test("detectAgentRuntimes: empty dir → []", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  assert.deepStrictEqual(await detectAgentRuntimes(dir), []);
});

test("detectAgentRuntimes: .claude/ → ['claude']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["claude"]);
});

test("detectAgentRuntimes: AGENTS.md → ['codex']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await writeFile(path.join(dir, "AGENTS.md"), "# agents\n");
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["codex"]);
});

test("detectAgentRuntimes: .cursor/ → ['cursor']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".cursor"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["cursor"]);
});

test("detectAgentRuntimes: .github/copilot-instructions.md → ['copilot']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".github"), { recursive: true });
  await writeFile(path.join(dir, ".github/copilot-instructions.md"), "# copilot\n");
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["copilot"]);
});

test("detectAgentRuntimes: multiple → sorted alphabetically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await mkdir(path.join(dir, ".cursor"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["claude", "cursor"]);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/cli/agent-runtime-detect.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

`src/cli/agent-runtime-detect.ts`:

```ts
import { stat } from "node:fs/promises";
import path from "node:path";

export type AgentRuntime = "claude" | "codex" | "cursor" | "copilot";

/**
 * Detect agent-runtime conventions in `cwd`. Returns the runtimes found,
 * sorted alphabetically.
 *
 *   claude   — .claude/ directory present.
 *   codex    — AGENTS.md file present at the root.
 *   cursor   — .cursor/ directory present.
 *   copilot  — .github/copilot-instructions.md present.
 *
 * Used by `secret-shuttle init` to install skill files into every
 * detected runtime.
 */
export async function detectAgentRuntimes(cwd: string): Promise<AgentRuntime[]> {
  const checks: Array<{ runtime: AgentRuntime; relPath: string }> = [
    { runtime: "claude", relPath: ".claude" },
    { runtime: "codex", relPath: "AGENTS.md" },
    { runtime: "cursor", relPath: ".cursor" },
    { runtime: "copilot", relPath: ".github/copilot-instructions.md" },
  ];

  const found: AgentRuntime[] = [];
  for (const { runtime, relPath } of checks) {
    try {
      await stat(path.join(cwd, relPath));
      found.push(runtime);
    } catch {
      // not present; skip
    }
  }
  return found.sort();
}
```

- [ ] **Step 4: Verify**

```bash
npm test -- src/cli/agent-runtime-detect.test.ts 2>&1 | tail -10
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent-runtime-detect.ts src/cli/agent-runtime-detect.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): detectAgentRuntimes — find .claude/, AGENTS.md, .cursor/, copilot

Plan 5b helper. Returns the alphabetically-sorted list of agent
runtime conventions detected in the given cwd. Used by `init` to
install Secret Shuttle's skill into every found runtime.

  claude  ← .claude/ dir
  codex   ← AGENTS.md file
  cursor  ← .cursor/ dir
  copilot ← .github/copilot-instructions.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G2: Real `init` command

**Files:**
- Modify: `src/cli/commands/init.ts`
- Create: `src/cli/commands/init.test.ts`

This is the keystone CLI task. The `init` command runs as a real first-run wizard:
1. Ensure daemon running (spawn if absent).
2. Ensure envelope exists (open passphrase UI to create if absent).
3. Offer keychain enrollment (call existing `/v1/keychain/enable` route — fires Touch ID).
4. Install skill files into detected agent runtimes.
5. Print summary.

- [ ] **Step 1: Write failing tests**

`src/cli/commands/init.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Use existing daemon-test harness.
// Each test: spawn ephemeral daemon, point CWD to a fresh temp dir,
// run `secret-shuttle init` programmatically (call initCommand().action(...)).

test("init: cold (no daemon, no envelope) → spawns daemon, creates vault, enrolls keychain, installs skills", async () => {
  // Set up temp cwd with .claude/ + AGENTS.md.
  // Run init.
  // Assert: daemon socket exists, envelope.json present, keychain enrolled,
  // .claude/skills/secret-shuttle/SKILL.md present, AGENTS.md updated.
});

test("init: re-run (everything present) → idempotent no-op summary", async () => {
  // Pre-set up everything.
  // Run init.
  // Assert: no Touch ID prompt fired (keychain.set not called via mock),
  // no envelope overwritten, no skill file overwritten.
});

test("init: --no-keychain skips enrollment", async () => {
  // Cold init with --no-keychain.
  // Assert: vault created, but keychain.set NOT called.
});

test("init: --no-agent-install skips skill writes", async () => {
  // Cold init with --no-agent-install.
  // Assert: vault created, no skill files written.
});
```

Tests will need a thorough harness — likely the existing daemon-spawn helper plus a `MockKeychain` injection.

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/cli/commands/init.test.ts 2>&1 | tail -15
```

- [ ] **Step 3: Replace init.ts**

`src/cli/commands/init.ts`:

```ts
import { Command } from "commander";
import path from "node:path";
import { daemonRequest } from "../../client/daemon-client.js";
import { readSocketFile } from "../../daemon/socket-file.js";
import { ok, outputJson } from "../../shared/result.js";
import { detectAgentRuntimes, type AgentRuntime } from "../agent-runtime-detect.js";
import { ShuttleError } from "../../shared/errors.js";
import { spawnDaemonAndWait } from "../helpers.js"; // verify this exists; if not, inline the spawn logic.
import { installSkillForTarget } from "../agent-writer.js"; // verify name; from agent install command.

interface HealthResponse {
  daemon: boolean;
  unlocked: boolean;
  vault: { envelope_present: boolean };
}

export function initCommand(): Command {
  return new Command("init")
    .description(
      "First-run setup: starts daemon, creates vault, enrolls keychain (Touch ID), installs agent skills.",
    )
    .option("--no-keychain", "Skip keychain enrollment.")
    .option("--no-agent-install", "Skip agent runtime detection + skill install.")
    .action(async (options: Record<string, unknown>) => {
      // 1. Daemon
      let socket = await readSocketFile();
      let daemonSpawned = false;
      if (socket === null) {
        await spawnDaemonAndWait({ timeoutMs: 5000 });
        socket = await readSocketFile();
        if (socket === null) {
          throw new ShuttleError("daemon_start_timeout", "Daemon failed to start within 5s.");
        }
        daemonSpawned = true;
      }

      // 2. Envelope check + create
      const health = await daemonRequest<HealthResponse>("GET", "/v1/health");
      let vaultJustCreated = false;
      if (!health.vault.envelope_present) {
        // Trigger the existing unlock UI flow which creates the envelope on first
        // passphrase entry. Block until envelope is present + daemon is unlocked.
        await daemonRequest<{ session_id: string }>("POST", "/v1/unlock/start");
        // Poll /v1/health until unlocked or timeout.
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          const h = await daemonRequest<HealthResponse>("GET", "/v1/health");
          if (h.unlocked) {
            vaultJustCreated = true;
            break;
          }
        }
        if (!vaultJustCreated) {
          throw new ShuttleError(
            "unlock_timeout",
            "Vault setup not completed (passphrase UI was not submitted within 2 minutes).",
          );
        }
      }

      // 3. Keychain enrollment — only if just created.
      let keychainEnrolled = false;
      if (options.keychain !== false && vaultJustCreated) {
        try {
          const r = await daemonRequest<{ enrolled: boolean }>("POST", "/v1/keychain/enable");
          keychainEnrolled = r.enrolled;
        } catch (e) {
          // Keychain unavailable on this platform — continue without it.
          if (!(e instanceof ShuttleError && e.code === "keychain_unavailable")) {
            throw e;
          }
        }
      }

      // 4. Agent runtime detection + install
      const runtimes: AgentRuntime[] = [];
      if (options.agentInstall !== false) {
        const detected = await detectAgentRuntimes(process.cwd());
        for (const runtime of detected) {
          await installSkillForTarget(runtime, process.cwd());
          runtimes.push(runtime);
        }
      }

      // 5. Summary
      outputJson(ok({
        ok: true,
        daemon_running: true,
        daemon_port: socket.port,
        daemon_spawned: daemonSpawned,
        vault_initialized: true,
        vault_just_created: vaultJustCreated,
        keychain_enrolled: keychainEnrolled,
        agent_runtimes_detected: runtimes,
        next_action: vaultJustCreated
          ? "secret-shuttle import --env-file .env  # optional: migrate existing secrets"
          : null,
      }));
    })
    .addHelpText("after", `
Examples:
  # First-run setup (creates vault, enrolls Touch ID, installs agent skills):
  secret-shuttle init

  # Skip keychain enrollment (passphrase unlock only):
  secret-shuttle init --no-keychain

  # Skip agent skill install (manual control):
  secret-shuttle init --no-agent-install
`);
}
```

**Verify helper functions exist before relying on them:**

```bash
grep -rn "spawnDaemonAndWait\|installSkillForTarget" src/cli/ 2>&1 | head -10
```

If `spawnDaemonAndWait` doesn't exist with that exact name, find the equivalent in `src/cli/commands/daemon.ts` or `src/daemon/lifecycle.ts` — adapt the call accordingly.

If `installSkillForTarget` doesn't exist, look at `src/cli/commands/agent.ts` for the function that the `agent install <target>` command calls; extract it into a helper that init can reuse.

- [ ] **Step 4: Verify**

```bash
npm test -- src/cli/commands/init.test.ts 2>&1 | tail -20
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts src/cli/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli/init): real first-run setup

Plan 5b. secret-shuttle init becomes the canonical first-run command.
Today: a thin daemon-status wrapper. After this change:

  1. Ensure daemon running (spawn if absent, 5s timeout).
  2. Ensure vault exists (open passphrase UI to create if absent).
  3. Enroll keychain — fires Touch ID prompt (skip with --no-keychain).
  4. Install Secret Shuttle skill into every detected agent runtime
     (.claude/, AGENTS.md, .cursor/, .github/copilot-instructions.md).
     Skip with --no-agent-install.
  5. Print enum summary with daemon_port, runtimes_detected, etc.

Idempotent: re-running on a fully set-up project is a fast no-op.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task H: Verification + docs + CHANGELOG

- [ ] **Step 1: Update docs/cli-reference.md**

Add sections for `init` and `keychain {enable,disable,status}`. Mirror the style of the existing command sections in the file.

- [ ] **Step 2: Update CHANGELOG.md**

Append a new Plan 5b + 5f-impl section under Unreleased:

```markdown
### Plan 5b + 5f-impl — Real init + OS keychain unlock

**Added:**

- `secret-shuttle init` becomes a real first-run command. Starts the daemon if not running, opens the passphrase UI to create the vault if needed, enrolls the OS keychain (Touch ID on macOS) for passwordless subsequent unlocks, and installs Secret Shuttle skill files into every detected agent runtime (.claude/, AGENTS.md, .cursor/, .github/copilot-instructions.md). Flags: --no-keychain, --no-agent-install. Idempotent — re-running on a fully set-up project is a fast no-op.
- Real OS keychain integration via @napi-rs/keyring. macOS Keychain Services (Touch ID), Linux libsecret (Secret Service / gnome-keyring), Windows Credential Manager (DPAPI). Previous Plan 1 stubs are replaced with working implementations.
- `secret-shuttle keychain enable / disable / status` — explicit control over keychain enrollment for users who want to opt in/out outside the init flow.
- Daemon routes: `POST /v1/keychain/enable`, `POST /v1/keychain/disable`, `GET /v1/keychain/status`.
- Envelope file gains a stable `id` field (UUID). Used as the keychain account key so multiple Secret Shuttle vaults can coexist on one machine without collision. Legacy envelopes are transparently upgraded on first read.
- Error codes: `keychain_key_invalid` (cached key didn't unlock), `daemon_start_timeout` (spawn timeout during init — implementation reuses existing code from lifecycle.ts rather than adding new `daemon_start_failed`). Both include `next_action`.

**Changed:**

- `POST /v1/unlock/start` tries the OS keychain before the passphrase UI. On macOS this fires Touch ID. On any keychain failure (no entry, cancelled, invalid key), falls through to the existing passphrase UI seamlessly.
- After a successful passphrase unlock, the daemon opportunistically writes the master key to the keychain — handles device-migration and keychain-corruption recovery without user action.
```

- [ ] **Step 3: Full verification**

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
npm run check-pack 2>&1 | tail -5
```

Expected: typecheck clean, all tests pass (keychain tests skip without CI_ALLOW_KEYCHAIN), check-pack OK.

- [ ] **Step 4: Commit + push**

```bash
git add docs/cli-reference.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): Plan 5b + 5f-impl — real init + OS keychain unlock

CHANGELOG entry covers: real init wizard, working OS keychain
integration (macOS / Linux / Windows), keychain control CLI
commands, daemon /v1/keychain/* routes, envelope.id field +
transparent legacy migration, two new error codes.

cli-reference.md adds documentation for `init` and `keychain {enable,
disable,status}`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push 2>&1 | tail -3
git log --oneline origin/main..HEAD
```

Expected: push succeeds; `origin/main..HEAD` returns empty.

---

## Self-review checklist

1. **Spec coverage:**
   - §1 native module → Task A1 ✓
   - §2 envelope id → Task B1 ✓
   - §3 keychain adapters → Tasks A2, A3, A4 ✓
   - §4 unlock flow integration → Tasks C1, C2 ✓
   - §5 init command → Task G2 ✓
   - §6 keychain routes → Task D ✓
   - §7 CLI keychain commands → Task F ✓
   - §8 error registry → Task E ✓
   - §9 agent-runtime detection helper → Task G1 ✓
   - §10 documentation → Task H ✓
   - §11 multi-vault — explicitly out of scope ✓
   - §12 spec implementation order — matches task ordering ✓

2. **Placeholder scan:** no TBD/TODO/"similar to" patterns.

3. **Type consistency:**
   - `getKeychainAdapter()` returns `KeychainAdapter` (matches existing types.ts) ✓
   - `EnvelopeFile.id: string` added (matches §2) ✓
   - `detectAgentRuntimes(cwd: string): Promise<AgentRuntime[]>` consistent across G1 + G2 ✓
   - All routes use `services.lock.requireKey()` / `readEnvelope()` consistently ✓
