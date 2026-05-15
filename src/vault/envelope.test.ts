import assert from "node:assert/strict";
import test from "node:test";
import { decryptEnvelope, encryptEnvelope } from "./envelope.js";
import { ShuttleError } from "../shared/errors.js";

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
