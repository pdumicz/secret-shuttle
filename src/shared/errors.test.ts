import { test } from "node:test";
import assert from "node:assert/strict";
import { errorToJson, ShuttleError } from "./errors.js";

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

test("ShuttleError defaults exitCode and hint from registry when known code", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, "Run: secret-shuttle daemon start");
});

test("ShuttleError uses registry exitCode but explicit hint when both supplied", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running", {
    hint: "Custom recovery instruction",
  });
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, "Custom recovery instruction");
});

test("ShuttleError unknown code falls back to exitCode 1 / null hint", () => {
  const err = new ShuttleError("totally_unknown", "huh");
  assert.equal(err.exitCode, 1);
  assert.equal(err.hint, null);
});

test("errorToJson on ShuttleError emits BOTH legacy nested block AND flat fields", () => {
  const err = new ShuttleError("daemon_not_running", "Daemon not running");
  const j = errorToJson(err) as Record<string, unknown>;
  // Legacy nested block preserved:
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "daemon_not_running", message: "Daemon not running" });
  // Flat agent-friendly fields:
  assert.equal(j.error_code, "daemon_not_running");
  assert.equal(j.message, "Daemon not running");
  assert.equal(j.hint, "Run: secret-shuttle daemon start");
  assert.equal(j.exit_code, 1);
});

test("errorToJson on ShuttleError with null hint emits hint: null", () => {
  const err = new ShuttleError("invalid_ref", "Bad ref");
  const j = errorToJson(err) as Record<string, unknown>;
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 2);
  assert.equal(j.error_code, "invalid_ref");
  assert.equal(j.message, "Bad ref");
});

test("errorToJson on plain Error emits unexpected_error with both shapes", () => {
  const j = errorToJson(new Error("oh no")) as Record<string, unknown>;
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "oh no" });
  assert.equal(j.error_code, "unexpected_error");
  assert.equal(j.message, "oh no");
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});

test("errorToJson on non-Error emits unexpected_error with default message", () => {
  const j = errorToJson("string thrown") as Record<string, unknown>;
  assert.equal(j.ok, false);
  assert.deepEqual(j.error, { code: "unexpected_error", message: "Unknown error" });
  assert.equal(j.error_code, "unexpected_error");
  assert.equal(j.message, "Unknown error");
  assert.equal(j.hint, null);
  assert.equal(j.exit_code, 1);
});

test("ShuttleError: explicit null hint suppresses registry default", () => {
  const err = new ShuttleError("daemon_not_running", "Down", { hint: null });
  assert.equal(err.hint, null);
});
