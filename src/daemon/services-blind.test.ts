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
