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
