import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubBroker } from "./hub-broker.js";
import { DaemonServer } from "../server.js";
import { registerHubRoutes } from "./hub-server.js";

async function withHubDaemon<T>(
  fn: (ctx: { port: number; broker: HubBroker; server: DaemonServer }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-hub-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "t" });
  // HubBroker.openUrlImpl is required (Task A1); a no-op opener is fine
  // here because Task B1's tests only exercise the route surface, not the
  // surface()-driven spawn path.
  const broker = new HubBroker({ openUrlImpl: () => undefined });
  registerHubRoutes(server, broker);
  const { port } = await server.listen(0);
  try {
    return await fn({ port, broker, server });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("GET /ui/hub with valid token → 200, text/html, hardening + CSP headers", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub?token=${encodeURIComponent(ctx.broker.hubToken())}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes("Secret Shuttle Hub") || html.includes("hub"), "expected hub HTML");
  });
});

test("GET /ui/hub with wrong token → 401 ui_token_mismatch", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub?token=WRONG`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "ui_token_mismatch");
  });
});

test("GET /ui/hub missing token → 400 bad_request", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  });
});
