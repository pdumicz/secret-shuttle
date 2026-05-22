import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
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

/** Test harness for soft-delete invariant tests: creates a fresh vault and
 *  seeds it with one or more secrets via the public upsertSecret API. */
async function withVault<T>(
  seedRefs: { name: string; environment: string; source: string; value: string }[],
  fn: (vault: Vault) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-soft-delete-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const key = randomBytes(32);
    const vault = new Vault(() => key);
    await vault.ensureInitialized();
    for (const s of seedRefs) {
      await vault.upsertSecret({
        name: s.name,
        environment: s.environment,
        source: s.source,
        value: s.value,
        allowedDomains: ["example.com"],
      });
    }
    return await fn(vault);
  } finally {
    if (originalHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("getSecret throws secret_not_found for a soft-deleted ref", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");
      await assert.rejects(
        () => vault.getSecret("ss://x/dev/A"),
        (err) => err instanceof ShuttleError && err.code === "secret_not_found",
      );
    },
  );
});

test("inspect throws secret_not_found for a soft-deleted ref (metadata API also blocked)", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");
      await assert.rejects(
        () => vault.inspect("ss://x/dev/A"),
        (err) => err instanceof ShuttleError && err.code === "secret_not_found",
      );
    },
  );
});

test("list excludes deleted by default; includeDeleted surfaces them as AgentSecretMetadata with deleted_at set", async () => {
  await withVault(
    [
      { name: "A", environment: "development", source: "x", value: "val-A" },
      { name: "B", environment: "development", source: "x", value: "val-B" },
    ],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");

      // Default list: deleted entry absent.
      const visible = await vault.list();
      assert.equal(visible.length, 1);
      assert.equal(visible[0]!.ref, "ss://x/dev/B");
      assert.equal(visible[0]!.deleted_at, undefined, "active entry should NOT carry a deleted_at");

      // include-deleted: both entries present; the deleted one carries deleted_at.
      const all = await vault.list({ includeDeleted: true });
      assert.equal(all.length, 2);
      const deleted = all.find((s) => s.ref === "ss://x/dev/A");
      const active = all.find((s) => s.ref === "ss://x/dev/B");
      assert.ok(deleted, "deleted ref should surface with includeDeleted");
      assert.ok(
        typeof deleted!.deleted_at === "string" && deleted!.deleted_at.length > 0,
        "deleted entry must carry a non-empty ISO deleted_at so callers can distinguish it",
      );
      assert.equal(active?.deleted_at, undefined, "active entry must NOT carry a deleted_at");

      // CRITICAL: even with includeDeleted, no `value` field — AgentSecretMetadata
      // shape doesn't have one, but assert defensively in case the type ever drifts.
      for (const entry of all) {
        assert.equal(
          (entry as unknown as { value?: string }).value,
          undefined,
          "AgentSecretMetadata must never expose value, even with includeDeleted",
        );
      }
    },
  );
});

test("softDelete on a non-existent ref throws secret_not_found", async () => {
  await withVault([], async (vault) => {
    await assert.rejects(
      () => vault.softDelete("ss://x/dev/missing"),
      (err) => err instanceof ShuttleError && err.code === "secret_not_found",
    );
  });
});

test("softDelete a second time throws secret_not_found (already deleted)", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");
      await assert.rejects(
        () => vault.softDelete("ss://x/dev/A"),
        (err) => err instanceof ShuttleError && err.code === "secret_not_found",
      );
    },
  );
});

test("markUsed throws secret_not_found for a soft-deleted ref (soft-delete invariant)", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");
      await assert.rejects(
        () => vault.markUsed("ss://x/dev/A"),
        (err) => err instanceof ShuttleError && err.code === "secret_not_found",
      );
    },
  );
});

test("markRotating sets rotating:true on the underlying SecretRecord; not exposed via metadata APIs", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.markRotating("ss://x/dev/A");
      const record = await vault.getSecret("ss://x/dev/A");
      assert.equal(record.rotating, true);
      // AgentSecretMetadata must NOT carry `rotating` — operational state only.
      const meta = await vault.inspect("ss://x/dev/A");
      assert.equal((meta as unknown as { rotating?: boolean }).rotating, undefined);
    },
  );
});

test("markRotating throws secret_not_found for a missing ref", async () => {
  await withVault([], async (vault) => {
    await assert.rejects(
      () => vault.markRotating("ss://x/dev/missing"),
      (err) => err instanceof ShuttleError && err.code === "secret_not_found",
    );
  });
});

test("markRotating throws secret_not_found for a soft-deleted ref (soft-delete invariant)", async () => {
  await withVault(
    [{ name: "A", environment: "development", source: "x", value: "val-A" }],
    async (vault) => {
      await vault.softDelete("ss://x/dev/A");
      await assert.rejects(
        () => vault.markRotating("ss://x/dev/A"),
        (err) => err instanceof ShuttleError && err.code === "secret_not_found",
      );
    },
  );
});

test("generate produces a SecretRecord with a value and is callable without going through approvals", async () => {
  await withVault([], async (vault) => {
    const rec = await vault.generate({
      name: "GEN_NEW",
      environment: "development",
      source: "stripe",
      kind: "random_32_bytes",
      allowed_domains: ["example.com"],
    });
    assert.equal(rec.ref, "ss://stripe/dev/GEN_NEW");
    assert.equal(typeof rec.value, "string");
    assert.ok(rec.value.length > 0);
    assert.equal(rec.environment, "development");
  });
});

// ---------------------------------------------------------------------------
// resolveRefs test helpers
// ---------------------------------------------------------------------------

/** Parse a ref like "ss://source/env/NAME" into upsert fields.
 *  Handles canonical env abbreviations (dev, prod, stg, test). */
function makeSecret(ref: string): { name: string; environment: string; source: string; value: string } {
  const m = ref.match(/^ss:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`makeSecret: cannot parse ref "${ref}"`);
  const [, source, env, name] = m as [string, string, string, string];
  const envMap: Record<string, string> = {
    dev: "development",
    prod: "production",
    stg: "staging",
    test: "test",
  };
  return { name, environment: envMap[env] ?? env, source, value: `val-${name}` };
}

/** Create a fresh ephemeral vault, seed it with the given secrets, return
 *  the Vault instance. The caller is responsible for cleanup — use inside
 *  try/finally or pair with afterEach. For tests that stay short, embed in
 *  the test body directly (see usages below). */
async function setUpTestVault(opts: {
  secrets: ReturnType<typeof makeSecret>[];
}): Promise<{ vault: Vault; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-resolvefs-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const key = randomBytes(32);
  const vault = new Vault(() => key);
  await vault.ensureInitialized();
  for (const s of opts.secrets) {
    await vault.upsertSecret({ ...s, allowedDomains: ["example.com"] });
  }
  return {
    vault,
    cleanup: async () => {
      if (originalHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
      else process.env.SECRET_SHUTTLE_HOME = originalHome;
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRefs tests
// ---------------------------------------------------------------------------

test("Vault.resolveRefs returns map of ref→record for active secrets", async () => {
  const { vault, cleanup } = await setUpTestVault({
    secrets: [makeSecret("ss://x/dev/A"), makeSecret("ss://x/dev/B")],
  });
  try {
    const refs = ["ss://x/dev/A", "ss://x/dev/B"];
    const result = await vault.resolveRefs(refs);
    assert.equal(result.size, 2);
    assert.equal(result.get("ss://x/dev/A")!.ref, "ss://x/dev/A");
    assert.equal(typeof result.get("ss://x/dev/A")!.value, "string");
    assert.ok(Array.isArray(result.get("ss://x/dev/A")!.allowed_actions));
  } finally {
    await cleanup();
  }
});

test("Vault.resolveRefs dedupes repeated refs", async () => {
  const { vault, cleanup } = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  try {
    const result = await vault.resolveRefs(["ss://x/dev/A", "ss://x/dev/A", "ss://x/dev/A"]);
    assert.equal(result.size, 1);
  } finally {
    await cleanup();
  }
});

test("Vault.resolveRefs throws secret_not_found for a soft-deleted ref (invariant propagates)", async () => {
  const { vault, cleanup } = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  try {
    await vault.softDelete("ss://x/dev/A");
    await assert.rejects(
      () => vault.resolveRefs(["ss://x/dev/A"]),
      (err) => err instanceof ShuttleError && err.code === "secret_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("Vault.resolveRefs throws secret_not_found for a missing ref", async () => {
  const { vault, cleanup } = await setUpTestVault({ secrets: [] });
  try {
    await assert.rejects(
      () => vault.resolveRefs(["ss://x/dev/A"]),
      (err) => err instanceof ShuttleError && err.code === "secret_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("Vault.resolveRefs empty input returns empty map", async () => {
  const { vault, cleanup } = await setUpTestVault({ secrets: [] });
  try {
    const result = await vault.resolveRefs([]);
    assert.equal(result.size, 0);
  } finally {
    await cleanup();
  }
});
