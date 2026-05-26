import { test } from "node:test";
import assert from "node:assert/strict";
import { createMasker } from "./masker.js";

/**
 * Task B2 — Defense-in-depth tests for masker.dispose() and flush()
 * self-sanitization. The masker holds raw secret bytes in two places:
 *
 *  1. The `patterns` array — Buffers built from each secret string.
 *  2. The `lookback` Buffer — up to (maxLen-1) trailing bytes from the most
 *     recent process() call, which may be a partial prefix of a secret
 *     that's about to be split across chunks.
 *
 * Both must be zeroed in place when the masker is disposed so the bytes
 * don't linger in heap until GC (where they can be exposed by core dumps
 * or heap snapshots). flush() must also zero its old lookback before
 * reassigning, since flush is the "stream ended" signal.
 */

test("masker.dispose(): zeros every pattern Buffer in place", () => {
  const secret1 = "sk_live_abcdef0123456789";
  const secret2 = "topsecretpassword";
  const m = createMasker([secret1, secret2]);

  // Pump some unrelated data through so the masker is exercised at least once.
  m.process(Buffer.from("hello world\n"));

  // Snapshot references to the internal pattern buffers BEFORE dispose so we
  // can still inspect them after dispose() empties the array.
  const { patterns: patternsBefore } = m.__testing_inspect();
  const patternRefs = [...patternsBefore];
  assert.equal(patternRefs.length, 2, "expected two pattern buffers");

  // Sanity: each pattern buffer holds the expected secret bytes BEFORE dispose.
  const allBytesBeforeNonZero = patternRefs.every((p) => p.some((b) => b !== 0));
  assert.equal(allBytesBeforeNonZero, true, "patterns should be non-zero pre-dispose");

  m.dispose();

  // Every byte in every pattern buffer MUST be zero.
  for (const p of patternRefs) {
    for (let i = 0; i < p.length; i++) {
      assert.equal(p[i], 0, `pattern byte ${i} should be zero after dispose`);
    }
  }
});

test("masker.dispose(): zeros the lookback Buffer in place", () => {
  // Use a long secret so process() leaves bytes in lookback.
  const secret = "needle_secret_value";
  const m = createMasker([secret]);

  // Feed a chunk that ends with a prefix of the secret. The masker will hold
  // back up to maxLen-1 bytes — and since maxLen >= our input, ALL bytes
  // we just fed get parked in lookback awaiting more data.
  const partialPrefix = "needle_se"; // 9 bytes — a real prefix of `secret`
  m.process(Buffer.from(partialPrefix));

  const { lookback: lookbackRef } = m.__testing_inspect();
  // Confirm the prefix is actually parked in lookback (else the test is moot).
  assert.equal(lookbackRef.length > 0, true, "lookback should be non-empty pre-dispose");
  assert.equal(
    lookbackRef.toString("utf8").includes("needle_se"),
    true,
    "lookback should contain the partial prefix",
  );

  m.dispose();

  // The captured reference's bytes MUST all be zero now.
  for (let i = 0; i < lookbackRef.length; i++) {
    assert.equal(lookbackRef[i], 0, `lookback byte ${i} should be zero after dispose`);
  }

  // And the masker's CURRENT lookback should be empty (fresh Buffer.alloc(0)).
  const { lookback: lookbackAfter } = m.__testing_inspect();
  assert.equal(lookbackAfter.length, 0, "current lookback should be empty after dispose");
});

test("masker.flush(): zeros the OLD lookback before reassigning", () => {
  const secret = "needle_secret_value";
  const m = createMasker([secret]);

  // Park a partial-prefix in lookback.
  const partialPrefix = "needle_se";
  m.process(Buffer.from(partialPrefix));

  // Grab a reference to the lookback Buffer BEFORE flush — this is the
  // buffer that flush() must scrub before swapping to Buffer.alloc(0).
  const { lookback: oldLookback } = m.__testing_inspect();
  assert.equal(oldLookback.length > 0, true, "expected non-empty pre-flush lookback");

  // flush() returns an independent copy of the lookback contents — we still
  // need to see those bytes downstream, just not in the masker's heap slot.
  const flushed = m.flush();
  assert.equal(
    flushed.toString("utf8"),
    partialPrefix,
    "flush() must return the held-back bytes to the caller",
  );

  // The OLD lookback buffer MUST be zeroed in place.
  for (let i = 0; i < oldLookback.length; i++) {
    assert.equal(oldLookback[i], 0, `old lookback byte ${i} should be zero after flush`);
  }
});

test("masker.dispose(): is idempotent and does not leak previously-held secret bytes", () => {
  // After dispose(), calling dispose() again must not throw, and subsequent
  // process()/flush() calls must not leak any bytes that the masker was
  // holding BEFORE dispose (i.e. the lookback contents and the pattern
  // contents). Per the contract, the masker is unusable after dispose — it
  // is allowed to pass new input through unchanged; the guarantee is only
  // that previously-held secret material doesn't surface.
  const secret = "sk_live_idempotent";
  const m = createMasker([secret]);
  // Park a partial-prefix in lookback so there's real secret material held
  // internally at the moment of dispose.
  m.process(Buffer.from(`prefix-sk_live_idemp`));

  m.dispose();
  // Second dispose() is a no-op (idempotent contract).
  m.dispose();

  // Calling process() with neutral input must not throw AND must not
  // resurrect any of the previously-held lookback bytes.
  const neutral = Buffer.from("hello world\n");
  const out = m.process(neutral);
  assert.equal(
    out.includes(Buffer.from("sk_live_idemp")),
    false,
    "process() after dispose() must not surface previously-held lookback bytes",
  );

  // flush() must not throw and must not return any previously-held bytes.
  const tail = m.flush();
  assert.equal(
    tail.includes(Buffer.from("sk_live_idemp")),
    false,
    "flush() after dispose() must not surface previously-held lookback bytes",
  );
});
