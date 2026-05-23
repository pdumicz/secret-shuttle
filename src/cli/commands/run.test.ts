import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./run.js";

test("runCommand structural shape: takes --env-file and trailing argv", () => {
  const cmd = runCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--env-file"), "should accept --env-file");
});

test("runCommand: --json no-op flag accepted for forward compat", () => {
  const cmd = runCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--json"));
});

test("runCommand: argument is variadic (trailing argv after --)", () => {
  const cmd = runCommand();
  const args = (cmd as unknown as { registeredArguments: Array<{ _name: string; variadic: boolean }> })
    .registeredArguments;
  assert.equal(args.length, 1);
  assert.equal(args[0]!.variadic, true);
});

test("runCommand: --session flag accepted", () => {
  const cmd = runCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
