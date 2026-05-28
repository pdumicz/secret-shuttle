import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionCommand } from "./provision.js";

test("provisionCommand returns a Command named 'provision'", () => {
  const cmd = provisionCommand();
  assert.equal(cmd.name(), "provision");
});

test("provisionCommand has the expected mode flags", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--infer", "--yml", "--secret", "--continue", "--list", "--abandon", "--dry-run", "--force"]) {
    assert.ok(opts.includes(flag), `expected flag ${flag} in provision options, got: ${opts.join(", ")}`);
  }
});

test("provisionCommand has --from, --url, --ref, --to, --approval-id, --batch", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--from", "--url", "--ref", "--to", "--approval-id", "--batch"]) {
    assert.ok(opts.includes(flag), `expected ${flag}, got: ${opts.join(", ")}`);
  }
});
