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
      this.exitCode = optsOrExitCode.exitCode ?? registryExitCode;
      this.hint = optsOrExitCode.hint ?? registryHint;
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
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "unexpected_error",
        message: error.message,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "unexpected_error",
      message: "Unknown error",
    },
  };
}
