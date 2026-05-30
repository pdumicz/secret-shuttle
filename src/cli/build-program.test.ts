import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { buildProgram } from "./build-program.js";

test("buildProgram returns the configured secret-shuttle command tree", () => {
  const program = buildProgram();
  assert.ok(program instanceof Command);
  assert.equal(program.name(), "secret-shuttle");

  const top = program.commands.map((c) => c.name()).sort();
  for (const expected of [
    "agent", "audit", "bootstrap", "browser", "daemon", "help", "import",
    "init", "inject", "inject-submit", "internal", "keychain", "migrate",
    "provision", "reveal-capture", "run", "secrets", "status", "template",
    "unlock",
  ]) {
    assert.ok(top.includes(expected), `expected top-level command \`${expected}\``);
  }
});

test("buildProgram is side-effect-free: fresh instance per call, no argv parse", () => {
  const a = buildProgram();
  const b = buildProgram();
  assert.notEqual(a, b, "each call must return an independent Command instance");
  // Commander populates `.args` only during parse(); a freshly built program has none.
  assert.deepEqual(a.args, [], "buildProgram must not parse argv");
});
