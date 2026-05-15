// src/daemon/helpers/generate-value.ts
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";

export function generateSecretValue(kind: string): string {
  switch (kind) {
    case "random_32_bytes":
    case "base64url_32_bytes":
      return randomBytes(32).toString("base64url");
    case "hex_32_bytes":
      return randomBytes(32).toString("hex");
    case "random_64_bytes":
    case "base64url_64_bytes":
      return randomBytes(64).toString("base64url");
    default:
      throw new ShuttleError(
        "unsupported_secret_kind",
        "Supported secret kinds: random_32_bytes, base64url_32_bytes, hex_32_bytes, random_64_bytes, base64url_64_bytes.",
      );
  }
}
