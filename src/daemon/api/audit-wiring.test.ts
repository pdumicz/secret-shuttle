import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";

async function withDaemon<T>(fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-audit-wiring-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, home });
  } finally {
    await server.close();
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME; else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE; else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(ctx: { port: number; token: string }, method: string, p: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function readAudit(home: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("unlock + lock + blind start/end emit audit records", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    await call(ctx, "POST", "/v1/blind/end");
    await call(ctx, "POST", "/v1/lock");
    const events = await readAudit(ctx.home);
    const actions = events.map((e) => e["action"]);
    assert.ok(actions.includes("unlock"));
    assert.ok(actions.includes("blind_start"));
    assert.ok(actions.includes("blind_end"));
    assert.ok(actions.includes("lock"));
  });
});

test("approval lifecycle (created, granted, used) is audited; raw values never appear", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Create + approve a grant programmatically.
    const grant = ctx.services.approvals.create({
      action: "generate", ref: null, planned_ref: "ss://local/prod/X",
      environment: "production", destination_domain: null,
      target_id: null, field_fingerprint: null,
      template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);

    // Use it.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "X", environment: "production", source: "local",
      approval_id: grant.id, wait_for_approval: false,
    });

    const events = await readAudit(ctx.home);
    const actions = events.map((e) => e["action"]);
    assert.ok(actions.includes("approval_created"));
    assert.ok(actions.includes("approval_granted"));
    assert.ok(actions.includes("approval_used"));
    // Generated secret value must not appear anywhere in the audit log.
    const audit = JSON.stringify(events);
    assert.equal(audit.includes("whsec_"), false);
    // value field never present
    for (const ev of events) {
      assert.equal("value" in ev, false);
    }
  });
});

test("approval_mismatch is audited on bound-binding failure", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const grant = ctx.services.approvals.create({
      action: "generate", ref: null, planned_ref: "ss://local/prod/Y",
      environment: "production", destination_domain: null,
      target_id: null, field_fingerprint: null,
      template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);
    // Use the wrong name → mismatched planned_ref.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "Z", environment: "production", source: "local",
      approval_id: grant.id, wait_for_approval: false,
    });
    const events = await readAudit(ctx.home);
    const actions = events.map((e) => e["action"]);
    assert.ok(actions.includes("approval_mismatch"));
  });
});
