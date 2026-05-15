import { createHash } from "node:crypto";

export function fingerprintSecret(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function fingerprintMatches(value: string, fingerprint: string): boolean {
  return fingerprintSecret(value) === fingerprint;
}
