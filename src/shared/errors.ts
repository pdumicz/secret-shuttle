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
    if (typeof optsOrExitCode === "number") {
      // Backward-compat: callers still using `new ShuttleError(code, message, 2)`.
      this.exitCode = optsOrExitCode;
      this.hint = null;
    } else {
      this.exitCode = optsOrExitCode.exitCode ?? 1;
      this.hint = optsOrExitCode.hint ?? null;
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
