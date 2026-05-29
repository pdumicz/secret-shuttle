import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-approvals-sessions-list-rp-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  const rootToken = randomBytes(32).toString("base64url");
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: rootToken, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: { port: number; token: string },
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /v1/approvals/sessions includes required_params per session", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: { name: "STRIPE_KEY", environment: "production" },
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(created.status, 200);
    const sessionId = (created.body as { session_id: string }).session_id;
    const list = await call(ctx, "GET", "/v1/approvals/sessions");
    const sessions = (list.body as { sessions: Array<Record<string, unknown>> }).sessions;
    const s = sessions.find((x) => x.id === sessionId);
    assert.ok(s !== undefined, "session not in list");
    assert.deepEqual(s.required_params, { name: "STRIPE_KEY", environment: "production" });
  });
});

test("listed sessions without required_params are absent — undefined preserved through serialization", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        ttl_ms: 5 * 60 * 1000,
        // no required_params
      },
      wait_for_approval: false,
    });
    assert.equal(created.status, 200);
    const sessionId = (created.body as { session_id: string }).session_id;
    const list = await call(ctx, "GET", "/v1/approvals/sessions");
    const sessions = (list.body as { sessions: Array<Record<string, unknown>> }).sessions;
    const s = sessions.find((x) => x.id === sessionId);
    assert.ok(s !== undefined);
    assert.equal(s.required_params, undefined);
  });
});
