import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { writeSocketFile } from "../daemon/socket-file.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";
import { daemonErrorFromPayload, daemonRequest } from "./daemon-client.js";

async function withEphemeralDaemon<T>(fn: (ctx: { token: string; port: number }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-client-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "tok" });
  server.addRoute("GET", "/v1/ping", () => ({ pong: true }));
  server.addRoute("POST", "/v1/echo", (_req, body) => ({ body }));
  server.addRoute("POST", "/v1/fail", () => {
    throw new ShuttleError("on_purpose", "boom");
  });
  const { port } = await server.listen(0);
  await writeSocketFile({ port, token: "tok", pid: process.pid });
  try {
    return await fn({ token: "tok", port });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("daemonRequest GET succeeds against the daemon", async () => {
  await withEphemeralDaemon(async () => {
    const r = await daemonRequest<{ pong: boolean }>("GET", "/v1/ping");
    assert.equal(r.pong, true);
  });
});

test("daemonRequest POST forwards body and returns parsed result", async () => {
  await withEphemeralDaemon(async () => {
    const r = await daemonRequest<{ body: { hi: number } }>("POST", "/v1/echo", { hi: 5 });
    assert.deepEqual(r.body, { hi: 5 });
  });
});

test("daemonRequest throws ShuttleError when the daemon returns ok:false", async () => {
  await withEphemeralDaemon(async () => {
    await assert.rejects(
      () => daemonRequest("POST", "/v1/fail", {}),
      (err) => err instanceof ShuttleError && err.code === "on_purpose",
    );
  });
});

test("daemonRequest throws daemon_not_running when no socket file exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-client-none-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    await assert.rejects(
      () => daemonRequest("GET", "/v1/ping"),
      (err) => err instanceof ShuttleError && err.code === "daemon_not_running",
    );
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("daemonErrorFromPayload preserves hint and exit_code from daemon response", () => {
  const payload = {
    ok: false,
    error: { code: "secret_not_found", message: "No such ref" },
    error_code: "secret_not_found",
    message: "No such ref",
    hint: "Run: secret-shuttle secrets list",
    exit_code: 3,
  };
  const err = daemonErrorFromPayload(payload);
  assert.ok(err instanceof ShuttleError);
  assert.equal(err.code, "secret_not_found");
  assert.equal(err.message, "No such ref");
  assert.equal(err.hint, "Run: secret-shuttle secrets list");
  assert.equal(err.exitCode, 3);
});

test("daemonErrorFromPayload falls back to registry defaults when daemon omits new fields", () => {
  const payload = {
    ok: false,
    error: { code: "approval_denied", message: "User denied" },
  };
  const err = daemonErrorFromPayload(payload);
  assert.equal(err.code, "approval_denied");
  // Registry says approval_denied → exitCode 4, null hint
  assert.equal(err.exitCode, 4);
  assert.equal(err.hint, null);
});

test("daemonErrorFromPayload daemon-provided hint wins over registry default", () => {
  const payload = {
    ok: false,
    error: { code: "approval_denied", message: "User denied" },
    hint: "Specific recovery: re-run with --session <id>",
    exit_code: 4,
  };
  const err = daemonErrorFromPayload(payload);
  assert.equal(err.hint, "Specific recovery: re-run with --session <id>");
  assert.equal(err.exitCode, 4);
});

test("daemonErrorFromPayload missing error block falls back to 'unknown'", () => {
  const payload = { ok: false };
  const err = daemonErrorFromPayload(payload);
  assert.equal(err.code, "unknown");
  assert.equal(err.message, "unknown error");
});

test("daemonErrorFromPayload uses flat error_code/message when nested error block is missing", () => {
  // A daemon that emits ONLY the flat shape (no nested error block) should still
  // round-trip through the client. Cheap robustness — see user review note.
  const payload = {
    ok: false,
    error_code: "vault_not_initialized",
    message: "Vault not initialized",
    hint: "Run: secret-shuttle init",
    exit_code: 3,
  };
  const err = daemonErrorFromPayload(payload);
  assert.equal(err.code, "vault_not_initialized");
  assert.equal(err.message, "Vault not initialized");
  assert.equal(err.hint, "Run: secret-shuttle init");
  assert.equal(err.exitCode, 3);
});

test("daemonErrorFromPayload preserves details from payload", () => {
  const payload = {
    ok: false,
    error: { code: "approval_required", message: "m" },
    error_code: "approval_required",
    message: "m",
    hint: "h",
    exit_code: 3,
    details: { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }, { approval_id: "b", expires_at: 1, action: "run_stdin" }] },
  };
  const e = daemonErrorFromPayload(payload);
  assert.deepStrictEqual(e.details, { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }, { approval_id: "b", expires_at: 1, action: "run_stdin" }] });
});

test("daemonErrorFromPayload leaves details undefined when omitted", () => {
  const payload = {
    ok: false,
    error: { code: "bad_request", message: "m" },
    error_code: "bad_request",
    message: "m",
    exit_code: 2,
  };
  const e = daemonErrorFromPayload(payload);
  assert.strictEqual(e.details, undefined);
});

test("ShuttleError details round-trip via errorToJson + JSON wire + daemonErrorFromPayload", () => {
  const original = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "abc", expires_at: 999, action: "run" }] } });
  // Simulate the daemon→CLI wire: serialize via errorToJson, parse via daemonErrorFromPayload.
  const wire = JSON.parse(JSON.stringify(errorToJson(original)));
  const reconstructed = daemonErrorFromPayload(wire);
  assert.deepStrictEqual(reconstructed.details, original.details);
  assert.strictEqual(reconstructed.code, "approval_required");
  assert.strictEqual(reconstructed.message, "msg");
});
