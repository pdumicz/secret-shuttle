import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatusFromReport } from "./status.js";

test("status: daemon unreachable → ready=false, next_action points at daemon start", () => {
  const report = {
    daemon_reachable: false,
    daemon_error: "ECONNREFUSED",
    socket_file_mode: null,
    socket_file_mode_ok: true,
    health: null,
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle daemon start");
});

test("status: daemon reachable but vault locked → ready=false, next_action=unlock", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: false,
      browser_started: false,
      proxy_active: false,
      blind_mode: null,
      vault: { envelope_present: true, legacy_key_present: false },
      policy_warnings: null,
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle unlock");
});

test("status: vault locked but legacy_key_present → next_action points at migrate", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: false,
      browser_started: false,
      proxy_active: false,
      blind_mode: null,
      vault: { envelope_present: false, legacy_key_present: true },
      policy_warnings: null,
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle migrate secure-vault");
});

test("status: everything green → ready=true, next_action=null", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: true,
      browser_started: true,
      proxy_active: true,
      blind_mode: null,
      vault: { envelope_present: true, legacy_key_present: false },
      policy_warnings: [],
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, true);
  assert.equal(result.next_action, null);
});
