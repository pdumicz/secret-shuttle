import { test } from "node:test";
import assert from "node:assert/strict";
import { templateCommand } from "./template.js";

test("template run: --session flag accepted", () => {
  const tplCmd = templateCommand();
  const run = tplCmd.commands.find((c) => c.name() === "run")!;
  assert.ok(run.options.map((o) => o.long).includes("--session"));
});
