import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptEnvelope, encryptEnvelope, readEnvelope, writeEnvelope } from "./envelope.js";
import { ShuttleError } from "../shared/errors.js";
import { ensureShuttleHome, getShuttlePaths } from "../shared/config.js";

test("encryptEnvelope round-trips the master key under a passphrase", async () => {
  const masterKey = Buffer.alloc(32, 7);
  const envelope = await encryptEnvelope(masterKey, "correct horse battery staple");
  assert.equal(envelope.version, 2);
  assert.equal(envelope.kdf, "scrypt");
  assert.ok(envelope.salt.length > 0);
  assert.ok(envelope.nonce.length > 0);
  assert.ok(envelope.authTag.length > 0);
  assert.ok(envelope.ciphertext.length > 0);

  const recovered = await decryptEnvelope(envelope, "correct horse battery staple");
  assert.deepEqual(recovered, masterKey);
});

test("decryptEnvelope rejects a wrong passphrase", async () => {
  const envelope = await encryptEnvelope(Buffer.alloc(32, 9), "right");
  await assert.rejects(() => decryptEnvelope(envelope, "wrong"), (err) => err instanceof ShuttleError && err.code === "vault_unlock_failed");
});

test("encryptEnvelope uses a fresh salt and nonce each call", async () => {
  const a = await encryptEnvelope(Buffer.alloc(32, 1), "same");
  const b = await encryptEnvelope(Buffer.alloc(32, 1), "same");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("decryptEnvelope refuses a weakened KDF N parameter", async () => {
  const envelope = await encryptEnvelope(Buffer.alloc(32, 3), "pw");
  const downgraded = { ...envelope, kdfParams: { ...envelope.kdfParams, N: 2 } };
  await assert.rejects(
    () => decryptEnvelope(downgraded, "pw"),
    (err) => err instanceof ShuttleError && err.code === "unsupported_envelope",
  );
});

test("readEnvelope returns null when no file exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-env-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    assert.equal(await readEnvelope(), null);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("writeEnvelope round-trips through readEnvelope", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-env-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const env = await encryptEnvelope(Buffer.alloc(32, 4), "pw");
    await writeEnvelope(env);
    const read = await readEnvelope();
    assert.deepEqual(read, env);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("envelope: new envelopes get a UUID id field on encryptEnvelope", async () => {
  const masterKey = randomBytes(32);
  const env = await encryptEnvelope(masterKey, "passphrase-12345");
  assert.ok(typeof env.id === "string", "id field must be a string");
  assert.match(
    env.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "id must be a UUIDv4",
  );
});

test("envelope: encryptEnvelope accepts optional id parameter (preserves on re-encrypt)", async () => {
  const masterKey = randomBytes(32);
  const id = "12345678-1234-4abc-89de-1234567890ab";
  const env = await encryptEnvelope(masterKey, "passphrase-12345", id);
  assert.strictEqual(env.id, id);
});

test("envelope: readEnvelope mints id for legacy envelopes (no id field) and persists it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-env-legacy-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const paths = getShuttlePaths();
    await ensureShuttleHome(paths);
    // Write a legacy envelope (no id field) directly to disk.
    const legacy = {
      version: 2,
      kdf: "scrypt",
      kdfParams: { N: 32768, r: 8, p: 1 },
      salt: "abcdef",
      algorithm: "aes-256-gcm",
      nonce: "012345",
      authTag: "fedcba",
      ciphertext: "0123456789abcdef",
      created_at: new Date().toISOString(),
    };
    await writeFile(paths.envelopePath, JSON.stringify(legacy), { mode: 0o600 });

    const read = await readEnvelope();
    assert.ok(read !== null, "envelope must read successfully");
    assert.ok(typeof read.id === "string", "id must be minted");
    assert.match(read.id, /^[0-9a-f]{8}-/, "id must look like a UUID");

    // Stability check: re-read returns the same id (was persisted to disk).
    const reread = await readEnvelope();
    assert.strictEqual(reread?.id, read.id, "id must be stable across reads");
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
