const MASK = Buffer.from("***", "utf8");

export interface Masker {
  /**
   * Consume a chunk. Returns the bytes that are SAFE to emit (i.e. that
   * cannot retroactively become part of a longer match given a future
   * chunk). Holds back up to maxLen-1 trailing bytes internally.
   */
  process(chunk: Buffer): Buffer;

  /**
   * Flush any held-back bytes. Call exactly once at end-of-stream. After
   * flush the masker is unusable.
   */
  flush(): Buffer;

  /**
   * Zero out all internal Buffers holding secret bytes (the pattern buffers
   * and the current lookback). After dispose() the masker is unusable —
   * subsequent process() / flush() calls behave as if there were no secrets
   * (i.e. they pass input through unchanged or return empty), but MUST NOT
   * leak previously-held secret bytes. Idempotent: safe to call more than once.
   *
   * Defense-in-depth: even though Node will GC the buffers eventually, raw
   * secret bytes can linger in heap for an unbounded time and can be exposed
   * by core dumps, heap snapshots, or process introspection. Scrub eagerly.
   */
  dispose(): void;

  /**
   * Test-only introspection of the internal buffers. Do NOT use in
   * production code; this exists so masker-scrub.test.ts can assert that
   * dispose() / flush() actually zero the underlying bytes.
   */
  __testing_inspect(): { patterns: readonly Buffer[]; lookback: Buffer };
}

/**
 * Build a streaming byte-level masker that replaces every occurrence of any
 * `secrets` entry with `***`. Designed for `secret-shuttle run`'s child
 * stdout/stderr stream: see Task B5. Spec §5.3 defense-in-depth.
 *
 * Algorithm:
 *  1. Filter empty + dedupe + sort by length DESC. maxLen = first.length.
 *  2. On each process(chunk): combine lookback + chunk, then replace each
 *     secret in turn (longest first). Emit everything except the trailing
 *     maxLen-1 bytes (those become the next lookback).
 *  3. On flush(): emit the lookback and reset.
 *
 * Why "longest first": if "ABCDE" and "BCD" both match in "ABCDE", we want
 * the whole "ABCDE" gone, not just "BCD" (which would leave "A*** E" — a
 * partial leak).
 */
export function createMasker(secrets: readonly Buffer[]): Masker {
  // Burst 7 §2 (5q): inputs are raw secret BYTES — the secret never enters the
  // masker as a string (spec line 225), so the dedupe key cannot be a
  // reversible string copy (.toString(...) is forbidden). Dedupe by BYTE
  // comparison and defensive-copy each accepted pattern.
  const patterns: Buffer[] = [];
  for (const b of secrets) {
    if (b.length === 0) continue;
    if (patterns.some((p) => p.equals(b))) continue; // byte-compare dedupe, no string key
    patterns.push(Buffer.from(b)); // defensive copy of the accepted bytes
  }
  patterns.sort((a, b) => b.length - a.length);
  let maxLen = patterns.length > 0 ? patterns[0]!.length : 0;
  let lookback = Buffer.alloc(0);

  function replaceAll(buf: Buffer): Buffer {
    if (patterns.length === 0) return buf;
    let out = buf;
    for (const p of patterns) {
      // Loop until no more matches (handles repeated occurrences).
      while (true) {
        const idx = out.indexOf(p);
        if (idx === -1) break;
        out = Buffer.concat([out.subarray(0, idx), MASK, out.subarray(idx + p.length)]);
      }
    }
    return out;
  }

  return {
    process(chunk: Buffer): Buffer {
      if (maxLen === 0) return chunk;
      const combined = Buffer.concat([lookback, chunk]);
      const scanned = replaceAll(combined);
      // After replacement, hold back the trailing maxLen-1 bytes — they could
      // still be the prefix of a future match once the next chunk arrives.
      const safeEmitLen = Math.max(0, scanned.length - (maxLen - 1));
      const newLookback = Buffer.from(scanned.subarray(safeEmitLen));
      // Scrub the OLD lookback before reassigning. It may contain partial
      // secret bytes carried over from the previous chunk boundary; once we
      // drop the reference those bytes would linger until GC.
      lookback.fill(0);
      lookback = newLookback;
      return Buffer.from(scanned.subarray(0, safeEmitLen));
    },
    flush(): Buffer {
      const out = Buffer.from(lookback);
      // Scrub the OLD lookback before reassigning to an empty buffer. The
      // returned `out` is an independent copy, so this does not zero what
      // the caller sees.
      lookback.fill(0);
      lookback = Buffer.alloc(0);
      // No more bytes are coming, so anything in lookback is final — but
      // since replaceAll already ran on the combined buffer, it's already
      // had any matches stripped. Emit verbatim.
      return out;
    },
    dispose(): void {
      // Zero every pattern buffer in place.
      for (const p of patterns) p.fill(0);
      // Zero the current lookback in place.
      lookback.fill(0);
      // Render the masker unusable: clear the patterns array so replaceAll
      // becomes a no-op, force maxLen to 0 so process() short-circuits to
      // pass-through, and reset lookback to a fresh empty buffer.
      patterns.length = 0;
      maxLen = 0;
      lookback = Buffer.alloc(0);
    },
    __testing_inspect() {
      return { patterns, lookback };
    },
  };
}
