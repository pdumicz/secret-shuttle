import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { DaemonBlindModeState } from "./services-blind.js";

test("blind state starts inactive", () => {
  const b = new DaemonBlindModeState();
  assert.equal(b.current(), null);
});

test("assertForDomain throws when blind mode inactive", () => {
  const b = new DaemonBlindModeState();
  assert.throws(
    () => b.assertForDomain("stripe.com"),
    (err) => err instanceof ShuttleError && err.code === "blind_mode_required",
  );
});

test("start activates blind mode for a normalized domain", () => {
  const b = new DaemonBlindModeState();
  const a = b.start("Dashboard.Stripe.com", "test");
  assert.equal(a.domain, "dashboard.stripe.com");
  assert.equal(a.reason, "test");
  assert.equal(b.current()?.domain, "dashboard.stripe.com");
});

test("assertForDomain throws on domain mismatch", () => {
  const b = new DaemonBlindModeState();
  b.start("dashboard.stripe.com", "test");
  assert.throws(
    () => b.assertForDomain("vercel.com"),
    (err) => err instanceof ShuttleError && err.code === "blind_mode_domain_mismatch",
  );
});

test("end clears blind state", () => {
  const b = new DaemonBlindModeState();
  b.start("stripe.com", "r");
  b.end();
  assert.equal(b.current(), null);
});

test("start: throws blind_mode_already_active when state is not null", () => {
  const b = new DaemonBlindModeState();
  b.start("example.com", "inject");
  assert.throws(
    () => b.start("other.com", "reveal_capture"),
    (err) =>
      err instanceof ShuttleError && err.code === "blind_mode_already_active",
  );
  // First active session must remain intact — no silent overwrite.
  assert.equal(b.current()?.domain, "example.com");
  assert.equal(b.current()?.reason, "inject");
});

test("start: error message names both the rejected request and the active session", () => {
  const b = new DaemonBlindModeState();
  b.start("Dashboard.Stripe.com", "inject");
  try {
    b.start("Other.Example.com", "reveal_capture");
    assert.fail("expected start() to throw");
  } catch (err) {
    assert.ok(err instanceof ShuttleError);
    assert.equal(err.code, "blind_mode_already_active");
    // Rejected attempt (normalized domain + reason) is in the message.
    assert.match(err.message, /other\.example\.com/);
    assert.match(err.message, /reveal_capture/);
    // Existing active session (normalized domain + reason) is also named.
    assert.match(err.message, /dashboard\.stripe\.com/);
    assert.match(err.message, /inject/);
  }
});

test("start: succeeds again after end() clears the active window", () => {
  const b = new DaemonBlindModeState();
  b.start("first.example.com", "inject");
  b.end();
  // Must be allowed to start a fresh window after end().
  const next = b.start("second.example.com", "reveal_capture");
  assert.equal(next.domain, "second.example.com");
  assert.equal(next.reason, "reveal_capture");
  assert.equal(b.current()?.domain, "second.example.com");
});
