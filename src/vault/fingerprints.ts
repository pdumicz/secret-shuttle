import { createHmac, timingSafeEqual } from "node:crypto";

export function fingerprintSecret(value: Buffer, key: Buffer): string {
  // HMAC over the raw bytes. Identical output to the prior string form for the
  // same bytes (HMAC(utf8-bytes-of-string) === HMAC(Buffer-of-same-bytes)), so
  // no stored-fingerprint migration is required.
  return `hmac-sha256:${createHmac("sha256", key).update(value).digest("hex")}`;
}

export function fingerprintMatches(value: Buffer, fingerprint: string, key: Buffer): boolean {
  const computed = Buffer.from(fingerprintSecret(value, key), "utf8");
  const given = Buffer.from(fingerprint, "utf8");
  return computed.byteLength === given.byteLength && timingSafeEqual(computed, given);
}

export function isLegacyFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith("sha256:");
}
