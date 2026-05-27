import { createHash } from "node:crypto";

/**
 * Short fingerprint of the daemon's root token for audit-log correlation.
 *
 * Returns the first 4 bytes (8 hex chars) of SHA-256(rootToken). Lets audit-
 * log readers bucket entries by which generation of the root they were bound
 * to — useful for forensics after `secret-shuttle daemon rotate`.
 *
 * Non-reversible: the SHA-256 prefix doesn't leak the token bytes. 4 bytes
 * is short enough that adjacent generations are visually distinct in the
 * audit log but long enough (~4 billion possible values) that accidental
 * collisions are vanishingly unlikely across a single daemon's lifetime.
 *
 * Used by /v1/tokens/mint (stamps the active fingerprint on each row) and
 * /v1/daemon/rotate (records both OLD and NEW fingerprints).
 */
export function rootTokenFingerprint(rootToken: string): string {
  return createHash("sha256").update(rootToken).digest("hex").slice(0, 8);
}
