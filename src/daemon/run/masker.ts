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
export function createMasker(secrets: readonly string[]): Masker {
  const deduped = [...new Set(secrets.filter((s) => s.length > 0))];
  // Encode each secret to its raw byte buffer once.
  const patterns: Buffer[] = deduped
    .map((s) => Buffer.from(s, "utf8"))
    .sort((a, b) => b.length - a.length);
  const maxLen = patterns.length > 0 ? patterns[0]!.length : 0;
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
      lookback = Buffer.from(scanned.subarray(safeEmitLen));
      return Buffer.from(scanned.subarray(0, safeEmitLen));
    },
    flush(): Buffer {
      const out = Buffer.from(lookback);
      lookback = Buffer.alloc(0);
      // No more bytes are coming, so anything in lookback is final — but
      // since replaceAll already ran on the combined buffer, it's already
      // had any matches stripped. Emit verbatim.
      return out;
    },
  };
}
