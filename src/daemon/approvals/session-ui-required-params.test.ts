import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-session-ui-req-params-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
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
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
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

test("session UI HTML embeds required_params in the safePattern JSON and as a human row", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: ["vercel.com"],
      template_ids: ["vercel-env-add"],
      required_params: { name: "STRIPE_KEY", environment: "production" },
      ttl_ms: 5 * 60 * 1000,
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=${sg.id}&token=${sg.ui_token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // safePattern JSON pretty-print embeds the field key
    assert.match(html, /required_params/);
    // Human-readable row contains the constraint values
    assert.match(html, /name.*STRIPE_KEY/);
    assert.match(html, /environment.*production/);
  });
});

test("session UI HTML omits the required-params row entirely when not constrained", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: ["vercel.com"],
      template_ids: ["vercel-env-add"],
      // no required_params
      ttl_ms: 5 * 60 * 1000,
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=${sg.id}&token=${sg.ui_token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // The placeholder must be substituted (not left literal in the page).
    assert.doesNotMatch(html, /__REQUIRED_PARAMS_LINE__/);
    // Visible "Required params:" row should NOT appear (no constraint).
    assert.doesNotMatch(html, /<strong>Required params:<\/strong>/);
  });
});
