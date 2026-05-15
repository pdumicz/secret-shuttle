import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";

async function withDaemon<T>(fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-api-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(ctx: { port: number; token: string }, method: string, p: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("status starts locked", async () => {
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "GET", "/v1/status");
    assert.equal(r.status, 200);
    assert.equal((r.body as { unlocked: boolean }).unlocked, false);
    assert.equal((r.body as { version: number }).version, 2);
  });
});

test("unlock with set_passphrase creates envelope and unlocks", async () => {
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "hunter2", set_passphrase: true });
    assert.equal(r.status, 200);
    assert.equal((r.body as { unlocked: boolean }).unlocked, true);
    assert.equal((r.body as { created: boolean }).created, true);

    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { unlocked: boolean }).unlocked, true);
  });
});

test("unlock without set_passphrase when no envelope exists throws envelope_missing", async () => {
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/unlock", { passphrase: "x" });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "envelope_missing");
  });
});

test("unlock with wrong passphrase after creation fails", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "right", set_passphrase: true });
    const locked = await call(ctx, "POST", "/v1/lock");
    assert.equal(locked.status, 200);

    const wrong = await call(ctx, "POST", "/v1/unlock", { passphrase: "wrong" });
    assert.equal(wrong.status, 400);
    assert.equal((wrong.body as { error: { code: string } }).error.code, "vault_unlock_failed");
  });
});

test("unlock with the right passphrase after lock unlocks again", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "right", set_passphrase: true });
    await call(ctx, "POST", "/v1/lock");
    const reopen = await call(ctx, "POST", "/v1/unlock", { passphrase: "right" });
    assert.equal(reopen.status, 200);
    assert.equal((reopen.body as { unlocked: boolean }).unlocked, true);
    assert.equal((reopen.body as { created: boolean }).created, false);
  });
});

test("lock removes the unlock state", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const lock = await call(ctx, "POST", "/v1/lock");
    assert.equal(lock.status, 200);
    assert.equal((lock.body as { unlocked: boolean }).unlocked, false);
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { unlocked: boolean }).unlocked, false);
  });
});
