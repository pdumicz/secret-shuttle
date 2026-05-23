import { test } from "node:test";
import assert from "node:assert/strict";
import { revealCaptureCommand } from "./reveal-capture.js";

test("revealCaptureCommand: --session flag accepted", () => {
  const cmd = revealCaptureCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
