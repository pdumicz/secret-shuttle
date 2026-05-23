import { test } from "node:test";
import assert from "node:assert/strict";
import { internalSessionCommand } from "./internal-session.js";

test("internalSessionCommand: has create, list, revoke subcommands", () => {
  const cmd = internalSessionCommand();
  const names = cmd.commands.map((c) => c.name());
  assert.deepEqual(names.sort(), ["create", "list", "revoke"]);
});

test("internal session create: required + repeatable flags", () => {
  const create = internalSessionCommand().commands.find((c) => c.name() === "create")!;
  const longs = create.options.map((o) => o.long);
  assert.ok(longs.includes("--actions"));
  assert.ok(longs.includes("--ref-glob"));
  assert.ok(longs.includes("--destination-domain"));
  assert.ok(longs.includes("--ttl"));
  assert.ok(longs.includes("--max-uses"));
  assert.ok(longs.includes("--no-wait"));
});

test("internal session revoke: positional <session-id>", () => {
  const revoke = internalSessionCommand().commands.find((c) => c.name() === "revoke")!;
  const args = (revoke as unknown as { registeredArguments: Array<{ _name: string }> }).registeredArguments;
  assert.equal(args.length, 1);
});
