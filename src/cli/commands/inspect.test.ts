import { test } from "node:test";
import assert from "node:assert/strict";

test("inspectCommand description marks the command as deprecated", async () => {
  const { inspectCommand } = await import("./inspect.js");
  const cmd = inspectCommand();
  assert.match(cmd.description(), /deprecated/i);
});
