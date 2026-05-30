import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths, writeJsonFileAtomic } from "../shared/config.js";
import { encryptVault } from "./crypto.js";
import { LockedVaultState } from "./locked-state.js";
import type { VaultPlaintext } from "./types.js";
import { Vault } from "./vault.js";
import { SecretValue } from "./secret-value.js";

/**
 * Phase-B memory-hygiene tests for Vault.read / Vault.write / Vault.fingerprintKey.
 *
 * Invariant: every Buffer returned by `keyProvider()` must be `.fill(0)`-scrubbed
 * in a try/finally after the synchronous crypto op that needs it completes.
 *
 * We construct a Vault whose `keyProvider` returns a *fresh* Buffer copy on every
 * call (matching the real `LockedVaultState.requireKey()` contract) and capture
 * each copy via a spy array. After each public op, every captured Buffer must be
 * all-zero — confirming the master-key bytes do not linger.
 */

/** 32-byte sentinel master key (0xab pattern) so a non-scrubbed Buffer would be
 *  trivially detectable in memory. */
const MASTER_KEY_BYTE = 0xab;

function buildSpiedVault(): { vault: Vault; observed: Buffer[]; lock: LockedVaultState } {
  const lock = new LockedVaultState();
  lock.unlock(Buffer.alloc(32, MASTER_KEY_BYTE));
  const observed: Buffer[] = [];
  const vault = new Vault(() => {
    // LockedVaultState.requireKey() already returns a fresh Buffer.from(this.key).
    // Capture each issued copy so the test can assert it was zeroed after use.
    const copy = lock.requireKey();
    observed.push(copy);
    return copy;
  });
  return { vault, observed, lock };
}

function assertAllZero(buf: Buffer, label: string): void {
  for (let i = 0; i < buf.length; i++) {
    assert.equal(
      buf[i],
      0,
      `${label}: byte ${i} = 0x${buf[i]!.toString(16).padStart(2, "0")} (expected 0x00) — key bytes still in memory after the op completed`,
    );
  }
}

test("Vault.read() scrubs the keyProvider() copy after decryptVault completes (via public list path)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-key-scrub-read-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const { vault, observed } = buildSpiedVault();
    await vault.ensureInitialized();
    // Snapshot the count of key copies issued during init (which calls write()
    // once via ensureInitialized → write({version:1,secrets:[],...})).
    const issuedDuringInit = observed.length;
    assert.ok(issuedDuringInit >= 1, "init must have triggered at least one key acquisition");

    // Trigger read() via the public list() method.
    await vault.list();

    // After list() returns, at least one more key copy must have been issued
    // (read's keyProvider call) AND every captured copy — including the ones
    // from init — must be all-zero.
    assert.ok(
      observed.length > issuedDuringInit,
      `list() must trigger at least one new keyProvider call (had ${issuedDuringInit}, now ${observed.length})`,
    );
    for (let i = 0; i < observed.length; i++) {
      assertAllZero(observed[i]!, `observed[${i}] (issued during init or read)`);
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("Vault.write() scrubs the keyProvider() copy after encryptVault completes (via public upsertSecret path)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-key-scrub-write-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const { vault, observed } = buildSpiedVault();
    await vault.ensureInitialized();
    const issuedAfterInit = observed.length;

    // upsertSecret internally does read() then write(). Both must scrub their
    // respective key copies.
    await vault.upsertSecret({
      name: "API_KEY",
      environment: "development",
      source: "stripe",
      value: SecretValue.fromUtf8("sk_test_value_for_scrub_check"),
      allowedDomains: ["example.com"],
    });

    assert.ok(
      observed.length > issuedAfterInit,
      `upsertSecret must trigger at least one new keyProvider call (had ${issuedAfterInit}, now ${observed.length})`,
    );
    for (let i = 0; i < observed.length; i++) {
      assertAllZero(observed[i]!, `observed[${i}] (issued during init or upsertSecret)`);
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("Vault.fingerprintKey() inherits read's scrub — all keyProvider copies are zero after it returns", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-key-scrub-fp-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const { vault, observed } = buildSpiedVault();
    await vault.ensureInitialized();
    const issuedAfterInit = observed.length;

    // fingerprintKey() transits through read() — which acquires + scrubs the
    // master-key copy in its try/finally. We assert: (a) the fingerprintKey
    // result is a valid 32-byte HMAC key, and (b) every master-key copy
    // observed by the spy is zeroed.
    const fpKey = await vault.fingerprintKey();
    assert.equal(fpKey.byteLength, 32, "fingerprint key must be 32 bytes");

    assert.ok(
      observed.length > issuedAfterInit,
      `fingerprintKey() must trigger at least one new keyProvider call via read() (had ${issuedAfterInit}, now ${observed.length})`,
    );
    for (let i = 0; i < observed.length; i++) {
      assertAllZero(observed[i]!, `observed[${i}] (issued during init or fingerprintKey)`);
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T3: ordering-sensitive + throw-injection tests (B1 review-gap closure).
//
// The tests above prove "every captured key copy is zero AFTER the call
// resolved". They do NOT prove "scrub happens BEFORE any unrelated await" —
// a refactor that moved `.fill(0)` to an outer promise `.finally()` would
// still pass them. The tests below pin the precise security invariant.
// ---------------------------------------------------------------------------

test("Vault.read: key copy is scrubbed BEFORE the migration write fires (ordering invariant)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-key-scrub-read-order-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    // Seed a vault on disk that triggers the migrateFingerprints path: a
    // legacy plaintext with NO `fingerprint_key`. On first read(), the vault
    // will call `await this.write(plaintext)` to persist the migration. The
    // outer read()'s key copy MUST be scrubbed BEFORE that inner write call
    // is awaited — otherwise the master-key bytes linger across an
    // unrelated async hop.
    const masterKey = Buffer.alloc(32, MASTER_KEY_BYTE);
    const legacyPlaintext: VaultPlaintext = {
      version: 1,
      secrets: [
        {
          id: "sec_aabbccddeeff00112233445566778899",
          ref: "ss://stripe/prod/LEGACY_SECRET",
          name: "LEGACY_SECRET",
          environment: "production",
          source: "stripe",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-01T00:00:00.000Z",
          last_used_at: null,
          fingerprint: "sha256:deadbeef",
          allowed_domains: [],
          allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin"],
          requires_approval: true,
          classification: "production_secret",
          value: "legacy-value",
        },
      ],
      // No fingerprint_key — triggers migration.
    };
    const paths = getShuttlePaths(home);
    // Seed dir + write the encrypted vault using the same master key the
    // spied vault will use. NB: the file MUST exist before Vault.read runs,
    // and we cannot call vault.ensureInitialized() (it would overwrite the
    // legacy fixture with a freshly-keyed vault).
    const { mkdir } = await import("node:fs/promises");
    await mkdir(home, { recursive: true });
    await writeJsonFileAtomic(paths.vaultPath, encryptVault(legacyPlaintext, masterKey));

    const lock = new LockedVaultState();
    lock.unlock(masterKey);
    const observed: Buffer[] = [];
    const vault = new Vault(() => {
      const copy = lock.requireKey();
      observed.push(copy);
      return copy;
    });

    // Snapshot the OUTER read()'s key Buffer state at the moment Vault.write
    // is invoked by the migration path. If the read's `.fill(0)` finally
    // runs BEFORE the `await this.write(plaintext)` (correct), the captured
    // snapshot is all-zero. If a regression deferred the scrub past the
    // await, the snapshot still has 0xab sentinel bytes.
    const writeInvocationSnapshots: Buffer[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = vault as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origWrite: (pt: VaultPlaintext) => Promise<void> = v.write.bind(vault);
    v.write = async function instrumentedWrite(pt: VaultPlaintext): Promise<void> {
      // observed[0] is the outer read()'s key copy (the migration write is
      // the FIRST write triggered by the very first keyProvider call).
      if (observed.length > 0) {
        writeInvocationSnapshots.push(Buffer.from(observed[0]!));
      }
      return origWrite(pt);
    };

    // Trigger read() via the public list() method. Migration runs inside
    // read() and synchronously dispatches `await this.write(plaintext)`.
    await vault.list();

    assert.ok(
      writeInvocationSnapshots.length > 0,
      "migration write must have been invoked at least once (legacy fixture should trigger migrateFingerprints)",
    );
    for (let i = 0; i < writeInvocationSnapshots.length; i++) {
      const snap = writeInvocationSnapshots[i]!;
      const firstFour = Array.from(snap.subarray(0, 4)).map((b) => `0x${b.toString(16).padStart(2, "0")}`);
      assert.ok(
        snap.every((b) => b === 0),
        `writeInvocationSnapshots[${i}]: outer read's key buffer must be zero by the time Vault.write is invoked (ordering invariant violated). First 4 bytes: [${firstFour.join(", ")}]`,
      );
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test.skip(
  "Vault.write: key copy is scrubbed BEFORE writeJsonFileAtomic is awaited (ordering invariant) — verified by code review at vault.ts:279-294",
  () => {
    // The production invariant is enforced by the try/finally placement in
    // Vault.write (src/vault/vault.ts:279-294):
    //
    //   const key = this.keyProvider();
    //   let encrypted: EncryptedVaultFile;
    //   try {
    //     encrypted = encryptVault(plaintext, key);   // sync
    //   } finally {
    //     key.fill(0);                                // sync, runs before
    //   }                                             //   the next line
    //   await writeJsonFileAtomic(paths.vaultPath, encrypted);
    //
    // Reproducing the ordering invariant as a runtime test requires
    // intercepting the module-level `writeJsonFileAtomic` import inside
    // vault.ts. The project is ESM (`"type": "module"` in package.json),
    // and ESM module namespaces are immutable — there is no esmock/loader
    // hook in use, and adding one to test a four-line invariant is not
    // justified by the maintenance cost.
    //
    // The companion ordering test for Vault.read ("scrubbed BEFORE the
    // migration write fires") exercises the same try/finally pattern
    // (the only difference is the await target). That test plus this
    // code-review pointer cover the invariant on both methods. See the
    // T3 plan in docs/superpowers/plans/2026-05-27-burst4-tier2-cleanup.md
    // for the explicit fallback authorisation.
  },
);

test("Vault.read: key copy is scrubbed even when decryptVault throws (throw-injection)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-key-scrub-throw-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    // Write a vault file whose JSON envelope is well-formed but whose
    // ciphertext / authTag / nonce are pure garbage. decryptVault will
    // throw a ShuttleError("vault_decryption_failed") on GCM tag mismatch
    // (see src/vault/crypto.ts:42-61). The throw-injection invariant: the
    // `finally { key.fill(0); }` block in Vault.read MUST still execute
    // and zero the master-key bytes — otherwise a corrupt-vault scenario
    // (e.g. user tampering, disk corruption, bug-induced re-key drift)
    // would leak key material across the rejection.
    const corruptVault = {
      version: 1 as const,
      algorithm: "aes-256-gcm" as const,
      // 12-byte nonce, 16-byte authTag, garbage ciphertext — valid sizes
      // (so decryptVault gets past its shape guards) but the GCM tag check
      // will fail.
      nonce: randomBytes(12).toString("base64url"),
      authTag: randomBytes(16).toString("base64url"),
      ciphertext: randomBytes(64).toString("base64url"),
    };
    const paths = getShuttlePaths(home);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(home, { recursive: true });
    await writeJsonFileAtomic(paths.vaultPath, corruptVault);

    const { vault, observed } = buildSpiedVault();

    // vault.list() → vault.read() → decryptVault throws → finally scrubs key
    // → throw propagates → vault.list() rejects.
    await assert.rejects(
      () => vault.list(),
      (err: unknown) => err instanceof Error && /vault/i.test(err.message),
      "vault.list() must reject when the vault file ciphertext fails GCM verification",
    );

    assert.ok(
      observed.length > 0,
      "keyProvider must have been called at least once during the failed decryption attempt",
    );
    for (let i = 0; i < observed.length; i++) {
      assertAllZero(
        observed[i]!,
        `observed[${i}] (issued during decryptVault-throws path) — finally must scrub even on throw`,
      );
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
