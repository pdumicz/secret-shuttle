// src/vault/secret-value.test.ts
//
// Burst 7 §2 (5q). SecretValue is the guard-by-construction wrapper: the ONLY
// way to read the bytes is .bytes() (greppable/auditable); every stringify
// path redacts to "[secret]"; dispose() zeros the backing Buffer and a
// subsequent .bytes() throws. (Spec §2 "SecretValue" + Tests.)
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { SecretValue } from "./secret-value.js";

test("redaction: String(), template, JSON.stringify, util.inspect all yield [secret]", () => {
  const sv = SecretValue.fromUtf8("super-secret-value");
  assert.equal(String(sv), "[secret]");
  assert.equal(`${sv}`, "[secret]");
  assert.equal(JSON.stringify(sv), '"[secret]"');
  assert.equal(JSON.stringify({ token: sv }), '{"token":"[secret]"}');
  assert.equal(inspect(sv), "[secret]");
});

test("bytes() round-trips the utf8 input", () => {
  const sv = SecretValue.fromUtf8("hello-world");
  assert.equal(sv.bytes().toString("utf8"), "hello-world");
  assert.equal(sv.byteLength, Buffer.byteLength("hello-world", "utf8"));
});

test("fromBuffer defensively copies (mutating the source does not change the SecretValue)", () => {
  const src = Buffer.from("original", "utf8");
  const sv = SecretValue.fromBuffer(src);
  src.fill(0); // mutate the source after construction
  assert.equal(sv.bytes().toString("utf8"), "original", "SecretValue holds an independent copy");
});

test("dispose() zeros the backing buffer and subsequent bytes() throws", () => {
  const sv = SecretValue.fromUtf8("scrub-me");
  const buf = sv.bytes();
  sv.dispose();
  assert.ok(buf.every((b) => b === 0), "backing buffer zeroed in place");
  assert.throws(() => sv.bytes(), /used after dispose/, "bytes() after dispose throws");
});

test("dispose() is idempotent", () => {
  const sv = SecretValue.fromUtf8("x");
  sv.dispose();
  assert.doesNotThrow(() => sv.dispose(), "second dispose is a no-op");
});

test("equals: true for identical bytes, false for differing, length-mismatch short-circuits", () => {
  const a = SecretValue.fromUtf8("same");
  const b = SecretValue.fromUtf8("same");
  const c = SecretValue.fromUtf8("different");
  const d = SecretValue.fromUtf8("sam"); // shorter — length mismatch path
  assert.equal(a.equals(b), true);
  assert.equal(a.equals(c), false);
  assert.equal(a.equals(d), false);
});
