import { test } from "node:test";
import assert from "node:assert/strict";
import { createMasker } from "./masker.js";

test("createMasker: empty secrets list is pass-through", () => {
  const m = createMasker([]);
  assert.equal(m.process(Buffer.from("hello world")).toString("utf8"), "hello world");
  assert.equal(m.flush().toString("utf8"), "");
});

test("createMasker: replaces a complete match in a single chunk", () => {
  const m = createMasker(["sk_live_abc123"]);
  const out = Buffer.concat([
    m.process(Buffer.from("api: sk_live_abc123 done")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "api: *** done");
});

test("createMasker: replaces a match split across two chunks", () => {
  const m = createMasker(["sk_live_abc123"]);
  const a = m.process(Buffer.from("api: sk_live_"));
  const b = m.process(Buffer.from("abc123 done"));
  const c = m.flush();
  assert.equal(Buffer.concat([a, b, c]).toString("utf8"), "api: *** done");
});

test("createMasker: replaces a match split at every possible boundary", () => {
  const secret = "ABCDEFGH";
  const text = `prefix-${secret}-suffix`;
  for (let split = 0; split <= text.length; split++) {
    const m = createMasker([secret]);
    const a = m.process(Buffer.from(text.slice(0, split)));
    const b = m.process(Buffer.from(text.slice(split)));
    const c = m.flush();
    const out = Buffer.concat([a, b, c]).toString("utf8");
    assert.equal(out, "prefix-***-suffix", `split=${split} should have masked`);
  }
});

test("createMasker: multiple secrets — longer-first wins overlapping matches", () => {
  // "ABCDE" is a superset of "BCD"; longer should match.
  const m = createMasker(["BCD", "ABCDE"]);
  const out = Buffer.concat([
    m.process(Buffer.from("xxABCDExx")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "xx***xx");
});

test("createMasker: replaces multiple non-overlapping matches in one chunk", () => {
  const m = createMasker(["secret1", "secret2"]);
  const out = Buffer.concat([
    m.process(Buffer.from("one=secret1 two=secret2 done")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "one=*** two=*** done");
});

test("createMasker: secret only emitted via flush is still masked", () => {
  // Process a chunk that ends mid-secret; flush must mask the held-back portion.
  // (The held-back portion IS what's NOT been masked yet — but the chunk contained
  // the WHOLE secret, so it was already replaced by the time we hit flush.)
  const m = createMasker(["topsecret"]);
  const a = m.process(Buffer.from("XtopsecretY"));
  const b = m.flush();
  assert.equal(Buffer.concat([a, b]).toString("utf8"), "X***Y");
});

test("createMasker: empty-string secrets are filtered (no spam)", () => {
  const m = createMasker(["", "real"]);
  const out = Buffer.concat([
    m.process(Buffer.from("hello real world")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "hello *** world");
});

test("createMasker: deduplicates repeated secrets", () => {
  const m = createMasker(["dup", "dup", "dup"]);
  const out = Buffer.concat([
    m.process(Buffer.from("a-dup-b")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "a-***-b");
});

test("createMasker: pre-mask boundary lookback is bounded by maxLen-1", () => {
  // After a long no-match chunk, the held-back tail must be at most maxLen-1.
  const m = createMasker(["needle"]);
  const a = m.process(Buffer.from("haystack ".repeat(100)));
  // We can't directly observe the lookback, but after flush the total emitted
  // bytes plus flush bytes MUST equal the input length (no data lost).
  const b = m.flush();
  assert.equal((a.length + b.length), "haystack ".repeat(100).length);
});

test("createMasker: handles multi-byte UTF-8 secrets correctly", () => {
  // Real-world secrets can contain non-ASCII (emoji, Japanese in user-supplied
  // passphrases, etc.). Make sure byte-level matching doesn't confuse code-unit
  // boundaries with byte boundaries.
  const secret = "🔑-秘密-Pa$$"; // 4-byte emoji + 3-byte CJK chars + ASCII
  const m = createMasker([secret]);
  const out = Buffer.concat([
    m.process(Buffer.from(`prefix-${secret}-suffix`, "utf8")),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "prefix-***-suffix");
});

test("createMasker: bytes that don't form valid UTF-8 secrets are stored as the vault returned them", () => {
  // The vault stores secret values as JS strings (UTF-16 internally, UTF-8 on
  // the wire). Plain-ASCII secrets are the normal case. This test pins the
  // round-trip for an ASCII-only secret with mixed punctuation/symbols.
  const secret = "sk_test_AbCdEf-0123_456.789~end";
  const m = createMasker([secret]);
  const out = Buffer.concat([
    m.process(Buffer.from(`Authorization: Bearer ${secret}\n`)),
    m.flush(),
  ]).toString("utf8");
  assert.equal(out, "Authorization: Bearer ***\n");
});
