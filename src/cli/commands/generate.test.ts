import { test } from "node:test";
import assert from "node:assert/strict";

test("generateCommand description marks the command as deprecated", async () => {
  const { generateCommand } = await import("./generate.js");
  const cmd = generateCommand();
  assert.match(cmd.description(), /deprecated/i);
});
