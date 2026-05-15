import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { writeSocketFile } from "../daemon/socket-file.js";
import { ShuttleError } from "../shared/errors.js";
import { daemonRequest } from "./daemon-client.js";

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
