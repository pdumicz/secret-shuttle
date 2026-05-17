import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths, writeJsonFileAtomic } from "../shared/config.js";
import { encryptVault } from "./crypto.js";
import { fingerprintMatches } from "./fingerprints.js";
import { Vault } from "./vault.js";

test("vault stores encrypted secrets and returns metadata only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-test-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;

  try {
    const key = randomBytes(32);
    const vault = new Vault(() => key);
    await vault.ensureInitialized();
    const metadata = await vault.upsertSecret({
      name: "STRIPE_WEBHOOK_SECRET",
      environment: "production",
      source: "stripe",
      value: "whsec_test_secret_value_123456789",
      allowedDomains: ["dashboard.stripe.com", "vercel.com"],
    });

    assert.equal(metadata.ref, "ss://stripe/prod/STRIPE_WEBHOOK_SECRET");
    assert.equal(metadata.value_visible_to_agent, false);
    assert.equal("value" in metadata, false);

    const listed = await vault.list({ environment: "production" });
    assert.equal(listed.length, 1);
    assert.equal("value" in listed[0]!, false);

    const paths = getShuttlePaths(home);
    const rawVaultFile = await readFile(paths.vaultPath, "utf8");
    assert.equal(rawVaultFile.includes("whsec_test_secret_value_123456789"), false);
    assert.equal(rawVaultFile.includes("STRIPE_WEBHOOK_SECRET"), false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy sha256 fingerprint is transparently migrated to hmac-sha256 on first read and file is not rewritten on second read", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-migrate-test-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;

  try {
    const key = randomBytes(32);
    const secretValue = "s3cr3t-value";

    // Seed a vault on disk with a legacy sha256: fingerprint (no fingerprint_key).
    const legacyPlaintext = {
      version: 1 as const,
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
          allowed_actions: ["capture_from_page" as const, "inject_into_field" as const, "compare_fingerprint" as const, "use_as_stdin" as const],
          requires_approval: true,
          classification: "production_secret" as const,
          value: secretValue,
        },
      ],
    };

    const paths = getShuttlePaths(home);
    await writeJsonFileAtomic(paths.vaultPath, encryptVault(legacyPlaintext, key));

    // First read: migration should re-key the fingerprint.
    const vault = new Vault(() => key);
    const metadata = await vault.inspect("ss://stripe/prod/LEGACY_SECRET");

    assert.ok(
      metadata.fingerprint.startsWith("hmac-sha256:"),
      `expected hmac-sha256: prefix, got: ${metadata.fingerprint}`,
    );
    assert.notEqual(metadata.fingerprint, "sha256:deadbeef");

    // The re-keyed fingerprint must validate against the vault's per-vault key.
    const fpKey = await vault.fingerprintKey();
    assert.equal(fingerprintMatches(secretValue, metadata.fingerprint, fpKey), true);

    // Idempotence: a second read must NOT rewrite the vault file.
    const statAfterFirstRead = await stat(paths.vaultPath);
    const contentAfterFirstRead = await readFile(paths.vaultPath, "utf8");

    await vault.inspect("ss://stripe/prod/LEGACY_SECRET");

    const contentAfterSecondRead = await readFile(paths.vaultPath, "utf8");
    assert.equal(
      contentAfterSecondRead,
      contentAfterFirstRead,
      "vault file must not be rewritten on second read when already migrated",
    );
    // mtime must not advance (allow 1 ms tolerance for filesystem granularity).
    const statAfterSecondRead = await stat(paths.vaultPath);
    assert.ok(
      statAfterSecondRead.mtimeMs <= statAfterFirstRead.mtimeMs + 1,
      "vault mtime must not advance after idempotent second read",
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
