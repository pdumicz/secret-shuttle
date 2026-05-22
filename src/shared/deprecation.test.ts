import { test } from "node:test";
import assert from "node:assert/strict";
import { withPendingDeprecationWarning, consumePendingDeprecationWarning } from "./deprecation.js";

test("withPendingDeprecationWarning sets pending; consume retrieves once", () => {
  consumePendingDeprecationWarning(); // start clean
  withPendingDeprecationWarning("list", "secrets list");
  const w = consumePendingDeprecationWarning();
  assert.deepEqual(w, {
    message: "[deprecated] 'list' is now 'secrets list'. Will be removed in v0.3.0.",
    deprecated: "list",
    replacement: "secrets list",
  });
  // Second consume returns null.
  assert.equal(consumePendingDeprecationWarning(), null);
});

test("withPendingDeprecationWarning does NOT write to stderr (consumer owns emission)", () => {
  // Critical contract: the failure-path consumer (CLI catch) must NOT cause
  // a duplicate stderr human line. The setter never writes stderr; only the
  // success-path consumer (outputJson) writes the human line on stderr.
  // Capture stderr to prove it.
  consumePendingDeprecationWarning(); // start clean
  const captured: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    withPendingDeprecationWarning("list", "secrets list");
  } finally {
    process.stderr.write = origWrite;
  }
  assert.deepEqual(captured, [], "withPendingDeprecationWarning must not write to stderr");
  consumePendingDeprecationWarning(); // clean up
});

test("consume without set returns null", () => {
  consumePendingDeprecationWarning(); // reset
  assert.equal(consumePendingDeprecationWarning(), null);
});

test("a deprecation warning set but never consumed by outputJson is cleared by error-path consume", () => {
  // Simulates a deprecated action that throws before reaching outputJson.
  // The CLI error handler must consume the pending warning so it doesn't
  // leak across CLI invocations (in-process tests can reveal this leak).
  consumePendingDeprecationWarning(); // start clean
  withPendingDeprecationWarning("list", "secrets list");
  // (No outputJson call — simulate the throw.)
  // The CLI error handler would now consume:
  const w = consumePendingDeprecationWarning();
  assert.ok(w !== null);
  assert.equal(w.deprecated, "list");
  // And a second consume returns null (no leak):
  assert.equal(consumePendingDeprecationWarning(), null);
});
