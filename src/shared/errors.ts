import { lookupErrorCode } from "./error-codes.js";

export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;

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
      // Backward-compat positional form: explicit exitCode wins; hint from registry.
      this.exitCode = optsOrExitCode;
      this.hint = registryHint;
    } else {
      // If the caller explicitly supplied `hint` (including null), respect it.
      // If they didn't supply the key at all, fall through to the registry default.
      this.exitCode = "exitCode" in optsOrExitCode && optsOrExitCode.exitCode !== undefined
        ? optsOrExitCode.exitCode
        : registryExitCode;
      this.hint = "hint" in optsOrExitCode
        ? (optsOrExitCode.hint ?? null)
        : registryHint;
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
    return {
      ok: false,
      // Legacy nested block — preserved indefinitely for backward compat.
      error: { code: error.code, message: error.message },
      // Flat agent-friendly fields per spec §5.6:
      error_code: error.code,
      message: error.message,
      hint: error.hint,
      exit_code: error.exitCode,
    };
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
