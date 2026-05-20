import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorText } from "./doctor.js";

const baseHealth = {
  unlocked: true,
  browser_started: true,
  proxy_active: true,
  blind_mode: null,
  vault: { envelope_present: true, legacy_key_present: false },
  policy_warnings: [],
};

test("formatDoctorText reports 'agentic flows: available' when health.agentic_browser.available is true", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      ...baseHealth,
      agentic_browser: {
        available: true,
        browser_started: true,
        proxy_active: true,
        handles_supported: true,
        marks_active: 0,
      },
    },
  });
  assert.match(out, /agentic flows:\s+available/);
});

test("formatDoctorText reports 'agentic flows: unavailable (start browser)' when available is false", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      ...baseHealth,
      browser_started: false,
      agentic_browser: {
        available: false,
        browser_started: false,
        proxy_active: false,
        handles_supported: true,
        marks_active: 0,
      },
    },
  });
  assert.match(out, /agentic flows:\s+unavailable \(start browser\)/);
});

test("formatDoctorText defaults to 'unavailable (start browser)' when agentic_browser is missing (older daemon)", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: { ...baseHealth },
  });
  assert.match(out, /agentic flows:\s+unavailable \(start browser\)/);
});

test("formatDoctorText omits the agentic-flows line when health is null (daemon unreachable)", () => {
  const out = formatDoctorText({
    daemon_reachable: false,
    daemon_error: "ECONNREFUSED",
    socket_file_mode: null,
    socket_file_mode_ok: true,
    health: null,
  });
  assert.doesNotMatch(out, /agentic flows:/);
});

test("formatDoctorText reports 'restart browser (proxy down)' when browser is started but proxy is inactive", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      ...baseHealth,
      browser_started: true,
      proxy_active: false,
      agentic_browser: {
        available: false,
        browser_started: true,
        proxy_active: false,
        handles_supported: true,
        marks_active: 0,
      },
    },
  });
  assert.match(out, /agentic flows:\s+unavailable \(restart browser \(proxy down\)\)/);
});
