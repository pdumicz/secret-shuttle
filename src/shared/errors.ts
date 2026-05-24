import { lookupErrorCode } from "./error-codes.js";

export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
  /**
   * Structured side-channel data, serialised to the top-level `details` key in
   * errorToJson output. Omitted from JSON when undefined OR null — both cases
   * keep the error shape byte-identical to callers that don't pass details
   * at all. Used by Plan 4d's approval_required to carry the approvals array.
   */
  details?: unknown;
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    optsOrExitCode: ShuttleErrorOpts | number = {},
  ) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;

    const registry = lookupErrorCode(code);
    const registryExitCode = registry?.exitCode ?? 1;
    const registryHint = registry?.hint(message) ?? null;

    if (typeof optsOrExitCode === "number") {
      // Backward-compat positional form: explicit exitCode wins; hint from registry; no details.
      this.exitCode = optsOrExitCode;
      this.hint = registryHint;
      this.details = undefined;
    } else {
      this.exitCode = "exitCode" in optsOrExitCode && optsOrExitCode.exitCode !== undefined
        ? optsOrExitCode.exitCode
        : registryExitCode;
      this.hint = "hint" in optsOrExitCode
        ? (optsOrExitCode.hint ?? null)
        : registryHint;
      this.details = optsOrExitCode.details;
    }
  }
}

export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ShuttleError(code, message);
  }
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof ShuttleError) {
    const base: Record<string, unknown> = {
      ok: false,
      // Legacy nested block — preserved indefinitely for backward compat.
      error: { code: error.code, message: error.message },
      // Flat agent-friendly fields per spec §5.6:
      error_code: error.code,
      message: error.message,
      hint: error.hint,
      exit_code: error.exitCode,
    };
    // Omit details from JSON when undefined OR null — both should produce
    // a byte-identical error shape vs. callers that omit the field entirely.
    // (null is a common footgun: a caller writing { details: null } would
    // otherwise emit details: null into the wire shape, breaking parity.)
    if (error.details !== undefined && error.details !== null) {
      base.details = error.details;
    }
    return base;
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: { code: "unexpected_error", message: error.message },
      error_code: "unexpected_error",
      message: error.message,
      hint: null,
      exit_code: 1,
    };
  }

  return {
    ok: false,
    error: { code: "unexpected_error", message: "Unknown error" },
    error_code: "unexpected_error",
    message: "Unknown error",
    hint: null,
    exit_code: 1,
  };
}
