export function ok<T extends Record<string, unknown>>(payload: T): T & { ok: true } {
  return {
    ok: true,
    ...payload,
  };
}

export function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
