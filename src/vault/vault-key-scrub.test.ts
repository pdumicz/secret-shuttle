import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LockedVaultState } from "./locked-state.js";
import { Vault } from "./vault.js";

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
      value: "sk_test_value_for_scrub_check",
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
