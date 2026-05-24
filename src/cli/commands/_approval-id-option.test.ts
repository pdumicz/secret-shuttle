import { test } from "node:test";
import assert from "node:assert";
import { Command } from "commander";
import { addApprovalIdOption } from "./_approval-id-option.js";

test("addApprovalIdOption: single --approval-id → [id]", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test", "--approval-id", "abc"]);
  assert.deepStrictEqual(cmd.opts().approvalId, ["abc"]);
});

test("addApprovalIdOption: repeated --approval-id → array of ids", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test", "--approval-id", "a", "--approval-id", "b"]);
  assert.deepStrictEqual(cmd.opts().approvalId, ["a", "b"]);
});

test("addApprovalIdOption: omitted → undefined", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test"]);
  assert.strictEqual(cmd.opts().approvalId, undefined);
});
