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

test("secrets get-ref accepts a positional ref argument", () => {
  const cmd = secretsCommand();
  const getRef = cmd.commands.find((c) => c.name() === "get-ref");
  assert.ok(getRef);
  const argNames = (getRef as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
});

test("secrets set requires --name and --env", () => {
  const cmd = secretsCommand();
  const set = cmd.commands.find((c) => c.name() === "set");
  assert.ok(set);
  const required = set.options.filter((o) => o.required).map((o) => o.long);
  assert.ok(required.includes("--name"), "set should require --name");
  assert.ok(required.includes("--env"), "set should require --env");
});

test("secrets set rejects --kind paste with a clear error (paste mode deferred to Plan 4)", () => {
  const cmd = secretsCommand();
  const set = cmd.commands.find((c) => c.name() === "set");
  assert.ok(set);
  const kind = set.options.find((o) => o.long === "--kind");
  assert.ok(kind);
});

test("secrets delete takes a positional <ref> argument", () => {
  const cmd = secretsCommand();
  const del = cmd.commands.find((c) => c.name() === "delete");
  assert.ok(del);
  const argNames = (del as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
});

test("secrets rotate takes a positional <ref> argument and --kind option", () => {
  const cmd = secretsCommand();
  const rot = cmd.commands.find((c) => c.name() === "rotate");
  assert.ok(rot);
  const argNames = (rot as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
  const optionNames = rot.options.map((o) => o.long);
  assert.ok(optionNames.includes("--kind"));
});

test("secrets set: --session flag accepted", () => {
  const cmd = secretsCommand();
  const set = cmd.commands.find((c) => c.name() === "set");
  assert.ok(set);
  assert.ok(set.options.map((o) => o.long).includes("--session"));
});

test("secrets delete: --session flag accepted", () => {
  const cmd = secretsCommand();
  const del = cmd.commands.find((c) => c.name() === "delete");
  assert.ok(del);
  assert.ok(del.options.map((o) => o.long).includes("--session"));
});
