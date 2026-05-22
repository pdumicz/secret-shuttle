import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Command } from "commander";
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

test("doctorCommand description marks the command as deprecated", async () => {
  const { doctorCommand } = await import("./doctor.js");
  const cmd = doctorCommand();
  assert.match(cmd.description(), /deprecated/i);
});

test("doctorCommand text-mode action emits [deprecated] human line to stderr (I-1 fix)", async () => {
  // The bug: the text-mode branch bypassed outputJson, which is the normal
  // consume site for the pending deprecation warning. Without the fix, users
  // running `secret-shuttle doctor` (no --json) saw no migration signal.
  //
  // Setup: point SECRET_SHUTTLE_HOME at an empty tempdir so the daemon
  // request fails cleanly (caught by the action; daemon_reachable=false).
  // The action then falls through to the text-mode branch, which is the
  // path under test.
  const { doctorCommand } = await import("./doctor.js");
  const { consumePendingDeprecationWarning } = await import("../../shared/deprecation.js");
  consumePendingDeprecationWarning(); // start clean (no leak from prior tests)

  const tmp = await mkdtemp(path.join(os.tmpdir(), "shuttle-doctor-test-"));
  const origHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = tmp;

  // Capture stdout (to silence the report) and stderr (to assert on).
  const stderrChunks: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  const origStdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((_chunk: unknown) => true) as typeof process.stdout.write;

  try {
    const program = new Command("secret-shuttle");
    program.addCommand(doctorCommand());
    await program.parseAsync(["doctor"], { from: "user" });
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
    if (origHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  }

  const err = stderrChunks.join("");
  // Exact human-line format set by withPendingDeprecationWarning:
  //   "[deprecated] 'doctor' is now 'status'. Will be removed in v0.3.0."
  assert.match(err, /\[deprecated\] 'doctor' is now 'status'/);
  // The pending warning must be consumed (not leaked to the next caller).
  assert.equal(consumePendingDeprecationWarning(), null);
});
