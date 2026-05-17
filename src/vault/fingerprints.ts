import { createHmac, timingSafeEqual } from "node:crypto";

export function fingerprintSecret(value: string, key: Buffer): string {
  return `hmac-sha256:${createHmac("sha256", key).update(value, "utf8").digest("hex")}`;
}

export function fingerprintMatches(value: string, fingerprint: string, key: Buffer): boolean {
  const computed = Buffer.from(fingerprintSecret(value, key), "utf8");
  const given = Buffer.from(fingerprint, "utf8");
  return computed.byteLength === given.byteLength && timingSafeEqual(computed, given);
}

export function isLegacyFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith("sha256:");
}
