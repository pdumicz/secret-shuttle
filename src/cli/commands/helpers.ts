import { parseSecretRef } from "../../shared/refs.js";
import { ShuttleError } from "../../shared/errors.js";

export function collectRepeated(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function normalizeRef(ref: string): string {
  return parseSecretRef(ref).ref;
}

export { generateSecretValue } from "../../daemon/helpers/generate-value.js";

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
