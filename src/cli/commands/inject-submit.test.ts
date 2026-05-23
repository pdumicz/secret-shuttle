import { test } from "node:test";
import assert from "node:assert/strict";
import { injectSubmitCommand } from "./inject-submit.js";

test("injectSubmitCommand: --session flag accepted", () => {
  const cmd = injectSubmitCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
