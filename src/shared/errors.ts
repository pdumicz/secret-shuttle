export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;
    this.exitCode = exitCode;
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
