import { test } from "node:test";
import assert from "node:assert/strict";
import { secretsCommand } from "./index.js";

test("secretsCommand registers all five subcommands", () => {
  const cmd = secretsCommand();
  const names = cmd.commands.map((c) => c.name()).sort();
  assert.deepEqual(names, ["delete", "get-ref", "list", "rotate", "set"]);
});

test("secretsCommand has the expected description", () => {
  const cmd = secretsCommand();
  assert.match(cmd.description(), /secret/i);
});

test("secrets list accepts --env and --source options", () => {
  const cmd = secretsCommand();
  const list = cmd.commands.find((c) => c.name() === "list");
  assert.ok(list);
  const optionNames = list.options.map((o) => o.long);
  assert.ok(optionNames.includes("--env"), "list should accept --env");
  assert.ok(optionNames.includes("--source"), "list should accept --source");
});
