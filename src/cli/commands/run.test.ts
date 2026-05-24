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

test("runCommand: --stdin flag accepted", () => {
  const cmd = runCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--stdin"), "should accept --stdin");
});

test("runCommand: --env-file is no longer required (optional with --stdin alternative)", () => {
  const cmd = runCommand();
  const envFile = cmd.options.find((o) => o.long === "--env-file");
  assert.ok(envFile, "--env-file must still be declared");
  // In commander, `.mandatory` reflects whether the flag itself must be
  // supplied (set by `.requiredOption()`). `.required` only reflects whether
  // the option's *argument* is required (`<path>` syntax). Plan 4c flips
  // `--env-file` from mandatory to optional flag — that's `.mandatory`.
  assert.equal(
    (envFile as unknown as { mandatory: boolean }).mandatory,
    false,
    "--env-file must be optional (not mandatory) in Plan 4c",
  );
});

test("runCommand: --stdin flag composable with --env-file (both in option list)", () => {
  const cmd = runCommand();
  const longs = cmd.options.map((o) => o.long);
  assert.ok(longs.includes("--stdin"));
  assert.ok(longs.includes("--env-file"));
});
