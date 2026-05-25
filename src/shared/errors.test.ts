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

test("ShuttleError carries details when supplied", () => {
  const e = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }] } });
  assert.deepStrictEqual(e.details, { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }] });
});

test("ShuttleError.details is undefined when not supplied", () => {
  const e = new ShuttleError("bad_request", "msg");
  assert.strictEqual(e.details, undefined);
});

test("errorToJson includes details when present", () => {
  const e = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "x", expires_at: 9, action: "run" }] } });
  const j = errorToJson(e);
  assert.deepStrictEqual(j.details, { approvals: [{ approval_id: "x", expires_at: 9, action: "run" }] });
});

test("errorToJson omits details when undefined", () => {
  const e = new ShuttleError("bad_request", "msg");
  const j = errorToJson(e);
  assert.ok(!("details" in j), "details key must NOT appear when undefined");
});

test("ShuttleError positional-form opts (number) ignores details", () => {
  const e = new ShuttleError("bad_request", "msg", 2);
  assert.strictEqual(e.exitCode, 2);
  assert.strictEqual(e.details, undefined);
});

test("errorToJson omits details when null (treats null same as undefined)", () => {
  const e = new ShuttleError("bad_request", "msg", { details: null });
  const j = errorToJson(e);
  assert.ok(!("details" in j), "details key must NOT appear when null");
});

test("errorToJson emits details when explicit empty object", () => {
  const e = new ShuttleError("bad_request", "msg", { details: {} });
  const j = errorToJson(e);
  assert.deepStrictEqual(j.details, {});
});

test("ShuttleError populates nextAction from registry", () => {
  const e = new ShuttleError("daemon_not_running", "msg");
  assert.strictEqual(e.nextAction, "secret-shuttle daemon start");
});

test("ShuttleError nextAction is null for human-required errors", () => {
  const e = new ShuttleError("approval_denied", "msg");
  assert.strictEqual(e.nextAction, null);
});

test("errorToJson always includes next_action (null when none)", () => {
  const e1 = new ShuttleError("daemon_not_running", "msg");
  assert.strictEqual(errorToJson(e1).next_action, "secret-shuttle daemon start");
  const e2 = new ShuttleError("approval_denied", "msg");
  assert.strictEqual(errorToJson(e2).next_action, null);
});

test("ShuttleError opts.nextAction overrides registry", () => {
  const e = new ShuttleError("daemon_not_running", "msg", { nextAction: "custom action" });
  assert.strictEqual(e.nextAction, "custom action");
});

test("ShuttleError opts.nextAction: null explicitly overrides registry to null", () => {
  const e = new ShuttleError("daemon_not_running", "msg", { nextAction: null });
  assert.strictEqual(e.nextAction, null);
});

test("ShuttleError nextAction is null for unknown code", () => {
  const e = new ShuttleError("totally_unknown", "msg");
  assert.strictEqual(e.nextAction, null);
});

test("ShuttleError positional-form (number exitCode) still gets nextAction from registry", () => {
  const e = new ShuttleError("daemon_not_running", "msg", 1);
  assert.strictEqual(e.nextAction, "secret-shuttle daemon start");
});

test("errorToJson on plain Error includes next_action: null", () => {
  const j = errorToJson(new Error("oh no"));
  assert.strictEqual(j.next_action, null);
});

test("errorToJson on non-Error includes next_action: null", () => {
  const j = errorToJson("string thrown");
  assert.strictEqual(j.next_action, null);
});
