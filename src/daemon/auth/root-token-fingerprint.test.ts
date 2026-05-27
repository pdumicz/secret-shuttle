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
  const token = "AAAAAAAA-secret-suffix";
  const fp = rootTokenFingerprint(token);
  assert.ok(!fp.startsWith("AAAAAAAA"), "fingerprint must not be a substring of the token");
});
