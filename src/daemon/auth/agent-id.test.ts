import test from "node:test";
import assert from "node:assert/strict";
import { ShuttleError } from "../../shared/errors.js";
import { assertAgentIdValid, deriveAutoAgentId } from "./agent-id.js";

test("assertAgentIdValid accepts valid forms", () => {
  for (const id of ["claude-abc", "cursor.foo", "claude-7f2a.helper-3a", "a", "z0", "x_y", "abc.def.ghi"]) {
    assertAgentIdValid(id);
  }
});

test("assertAgentIdValid rejects 'root' (reserved) with agent_id_invalid", () => {
  assert.throws(
    () => assertAgentIdValid("root"),
    (e: unknown) => e instanceof ShuttleError && e.code === "agent_id_invalid",
  );
});

test("assertAgentIdValid rejects empty / bad-charset / leading-dash / uppercase / too-long", () => {
  for (const id of ["", "-abc", "ABC", "a/b", "x@y", "1abc", "a".repeat(65)]) {
    assert.throws(
      () => assertAgentIdValid(id),
      (e: unknown) => e instanceof ShuttleError && e.code === "agent_id_invalid",
      `expected reject: ${JSON.stringify(id)}`,
    );
  }
});

test("deriveAutoAgentId: deterministic per (machine_id, runtime)", () => {
  const a = deriveAutoAgentId("claude", "machine-abc");
  const b = deriveAutoAgentId("claude", "machine-abc");
  assert.equal(a, b);
});

test("deriveAutoAgentId: different runtime → different id", () => {
  const a = deriveAutoAgentId("claude", "machine-abc");
  const c = deriveAutoAgentId("cursor", "machine-abc");
  assert.notEqual(a, c);
});

test("deriveAutoAgentId: format is <runtime>-<16 hex chars>", () => {
  const id = deriveAutoAgentId("claude", "machine-abc");
  assert.match(id, /^claude-[0-9a-f]{16}$/);
});

test("deriveAutoAgentId: never collides with the 'root' reserved id", () => {
  // 16 hex chars makes accidental collision astronomical, but assertion is still valid.
  const id = deriveAutoAgentId("root", "any-machine");
  assert.notEqual(id, "root");
  assert.match(id, /^root-[0-9a-f]{16}$/);
});
