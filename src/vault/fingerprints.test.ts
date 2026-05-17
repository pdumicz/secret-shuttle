import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { fingerprintSecret, fingerprintMatches, isLegacyFingerprint } from "./fingerprints.js";

test("fingerprint is keyed HMAC, stable per key, different across keys", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const a = fingerprintSecret("hunter2", k1);
  assert.ok(a.startsWith("hmac-sha256:"));
  assert.equal(a, fingerprintSecret("hunter2", k1));
  assert.notEqual(a, fingerprintSecret("hunter2", k2));
  assert.equal(fingerprintMatches("hunter2", a, k1), true);
  assert.equal(fingerprintMatches("wrong", a, k1), false);
});

test("legacy raw-sha256 fingerprints are detectable", () => {
  assert.equal(isLegacyFingerprint("sha256:abc"), true);
  assert.equal(isLegacyFingerprint("hmac-sha256:abc"), false);
});
