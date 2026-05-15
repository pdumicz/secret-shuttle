import { randomBytes } from "node:crypto";
import { parseSecretRef } from "../../shared/refs.js";
import { ShuttleError } from "../../shared/errors.js";

export function collectRepeated(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function normalizeRef(ref: string): string {
  return parseSecretRef(ref).ref;
}

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

export function assertFocusedTarget(target: string): void {
  if (target !== "focused-field") {
    throw new ShuttleError("unsupported_target", "V0 only supports --to focused-field.");
  }
}

export function assertCaptureSource(source: string): asserts source is "focused-field" | "selection" {
  if (source !== "focused-field" && source !== "selection") {
    throw new ShuttleError("unsupported_source", "V0 only supports --from focused-field or --from selection.");
  }
}
