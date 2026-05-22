export interface DeprecationWarning {
  message: string;
  deprecated: string;
  replacement: string;
}

let pending: DeprecationWarning | null = null;

/**
 * Mark a deprecation warning to be emitted with the next outputJson() call.
 *
 * Contract:
 *  - On success path (outputJson is reached): outputJson writes the human
 *    line to stderr AND splices `warning` into the JSON output on stdout.
 *  - On failure path (an error is thrown before outputJson): the CLI's catch
 *    block in src/cli/index.ts consumes the pending warning, splices it
 *    into the error JSON, and writes ONLY the error JSON to stderr. NO
 *    human line is written on the failure path, so stderr stays a single
 *    parseable JSON document for machine consumers.
 *
 * This function only flips the in-process flag — it does NOT write anything
 * to stderr or stdout. The two consume sites (outputJson and the CLI catch)
 * decide what to emit and where.
 */
export function withPendingDeprecationWarning(oldName: string, newName: string): void {
  const warning: DeprecationWarning = {
    message: `[deprecated] '${oldName}' is now '${newName}'. Will be removed in v0.3.0.`,
    deprecated: oldName,
    replacement: newName,
  };
  pending = warning;
}

/** Pull and clear the pending warning (or null if none). */
export function consumePendingDeprecationWarning(): DeprecationWarning | null {
  const w = pending;
  pending = null;
  return w;
}
