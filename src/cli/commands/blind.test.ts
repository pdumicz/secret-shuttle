import { test } from "node:test";
import assert from "node:assert/strict";
import { blindCommand } from "./blind.js";

test("blind end: --session flag accepted", () => {
  const cmd = blindCommand();
  const end = cmd.commands.find((c) => c.name() === "end")!;
  assert.ok(end.options.map((o) => o.long).includes("--session"));
});

test("blind start: --session flag NOT present (start is not approval-gated)", () => {
  const cmd = blindCommand();
  const start = cmd.commands.find((c) => c.name() === "start")!;
  assert.ok(!start.options.map((o) => o.long).includes("--session"));
});
