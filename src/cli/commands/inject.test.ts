import { test } from "node:test";
import assert from "node:assert/strict";
import { injectCommand } from "./inject.js";

test("injectCommand: takes -i (template input) and -o (output) options", () => {
  const cmd = injectCommand();
  const optionNames = cmd.options.map((o) => o.short).filter(Boolean);
  assert.ok(optionNames.includes("-i"), "should accept -i for template input");
  assert.ok(optionNames.includes("-o"), "should accept -o for output path");
});

test("injectCommand: description mentions template substitution", () => {
  const cmd = injectCommand();
  assert.match(cmd.description(), /template/i);
});

test("injectCommand: --json no-op accepted", () => {
  const cmd = injectCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--json"));
});

test("injectCommand: --session flag accepted", () => {
  const cmd = injectCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
