import { consumePendingDeprecationWarning } from "./deprecation.js";

export function ok<T extends Record<string, unknown>>(payload: T): T & { ok: true } {
  return {
    ok: true,
    ...payload,
  };
}

export function outputJson(value: unknown): void {
  const warning = consumePendingDeprecationWarning();
  if (warning !== null) {
    // SUCCESS path only: humans see the line on stderr; machines see the
    // `warning` field in the JSON. (The failure path is handled by the CLI
    // catch block — see src/cli/index.ts — which splices the warning into
    // the error JSON without writing the human line, so stderr stays
    // single-document-parseable on failure.)
    process.stderr.write(`${warning.message}\n`);
    if (typeof value === "object" && value !== null) {
      const enriched = { ...(value as Record<string, unknown>), warning };
      process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
