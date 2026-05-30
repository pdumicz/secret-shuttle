import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { fingerprintSecret, fingerprintMatches, isLegacyFingerprint } from "./fingerprints.js";

test("fingerprint is keyed HMAC, stable per key, different across keys", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const a = fingerprintSecret(Buffer.from("hunter2", "utf8"), k1);
  assert.ok(a.startsWith("hmac-sha256:"));
  assert.equal(a, fingerprintSecret(Buffer.from("hunter2", "utf8"), k1));
  assert.notEqual(a, fingerprintSecret(Buffer.from("hunter2", "utf8"), k2));
  assert.equal(fingerprintMatches(Buffer.from("hunter2", "utf8"), a, k1), true);
  assert.equal(fingerprintMatches(Buffer.from("wrong", "utf8"), a, k1), false);
});

test("legacy raw-sha256 fingerprints are detectable", () => {
  assert.equal(isLegacyFingerprint("sha256:abc"), true);
  assert.equal(isLegacyFingerprint("hmac-sha256:abc"), false);
});

// Burst 7 §2 (5q). fingerprintSecret/Matches now take Buffer. HMAC over bytes
// is identical to HMAC over the utf8 bytes of the same string, so the digest
// for identical bytes is UNCHANGED — no stored-fingerprint migration. This
// pins that invariant against the new Buffer signature.

test("fingerprintSecret(Buffer) === the pre-change string-form digest for identical bytes", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const plaintext = "the-secret-value";
  // Reconstruct the EXACT pre-change output: "hmac-sha256:" + HMAC over the
  // utf8 bytes of the string.
  const expected = `hmac-sha256:${createHmac("sha256", key).update(plaintext, "utf8").digest("hex")}`;
  const actual = fingerprintSecret(Buffer.from(plaintext, "utf8"), key);
  assert.equal(actual, expected, "Buffer form must equal the legacy string-form digest");
});

test("fingerprintMatches(Buffer) verifies a digest produced from the same bytes", () => {
  const key = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");
  const bytes = Buffer.from("compare-me", "utf8");
  const fp = fingerprintSecret(bytes, key);
  assert.equal(fingerprintMatches(Buffer.from("compare-me", "utf8"), fp, key), true);
  assert.equal(fingerprintMatches(Buffer.from("different", "utf8"), fp, key), false);
});
