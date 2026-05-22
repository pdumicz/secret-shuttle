import { test } from "node:test";
import assert from "node:assert/strict";
import { ShuttleError } from "./errors.js";

test("ShuttleError exposes code, exitCode, and hint", () => {
  const err = new ShuttleError("some_code", "Some message", { exitCode: 3, hint: "Run: foo" });
  assert.equal(err.code, "some_code");
  assert.equal(err.exitCode, 3);
  assert.equal(err.hint, "Run: foo");
  assert.equal(err.message, "Some message");
});

test("ShuttleError opts default to null hint and exitCode 1", () => {
  const err = new ShuttleError("some_code", "Some message");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, null);
});

test("ShuttleError backward-compatible positional exitCode still works", () => {
  // Old call sites use: new ShuttleError(code, message, 2)
  const err = new ShuttleError("some_code", "Some message", 2);
  assert.equal(err.exitCode, 2);
  assert.equal(err.hint, null);
});

test("ShuttleError partial opts: explicit hint, default exitCode", () => {
  const err = new ShuttleError("some_code", "Some message", { hint: "Try foo" });
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, "Try foo");
});

test("ShuttleError partial opts: explicit exitCode, default hint", () => {
  const err = new ShuttleError("some_code", "Some message", { exitCode: 4 });
  assert.equal(err.exitCode, 4);
  assert.equal(err.hint, null);
});
