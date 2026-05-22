import { test } from "node:test";
import assert from "node:assert/strict";

test("listCommand description marks the command as deprecated", async () => {
  const { listCommand } = await import("./list.js");
  const cmd = listCommand();
  assert.match(cmd.description(), /deprecated/i);
});
