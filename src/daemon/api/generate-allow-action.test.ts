import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import { DEFAULT_ACTIONS } from "../../vault/vault.js";

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-gaa-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("generate with explicit allowed_actions stores exactly those actions", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "K", environment: "development", source: "local",
      allowed_actions: ["inject_into_field"],
    });
    assert.equal(g.status, 200);
    const rec = await services.vault.getSecret("ss://local/dev/K");
    assert.deepEqual(rec.allowed_actions, ["inject_into_field"]);
  });
});

test("generate rejects an unknown action with bad_request", async () => {
  await withDaemon(async ({ port }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "K2", environment: "development", source: "local",
      allowed_actions: ["not_a_real_action"],
    });
    assert.equal(g.status, 400);
    assert.equal((g.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("invalid allowed_actions is rejected BEFORE an approval is opened (production, no-wait)", async () => {
  await withDaemon(async ({ port }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // production + wait_for_approval:false would return approval_required if
    // validation ran AFTER requireApproval. It must return bad_request instead.
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "K4", environment: "production", source: "local",
      allowed_domains: ["example.com"], allowed_actions: ["nope"], wait_for_approval: false,
    });
    assert.equal(g.status, 400);
    assert.equal((g.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("generate without allowed_actions gets the extended default (includes inject_submit)", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(port, "POST", "/v1/secrets/generate", { name: "K3", environment: "development", source: "local" });
    const rec = await services.vault.getSecret("ss://local/dev/K3");
    assert.equal(rec.allowed_actions.includes("inject_submit"), true);
  });
});

function approvalId(g: { body: Record<string, unknown> }): string {
  const msg = (g.body as { error: { message: string } }).error.message;
  return (JSON.parse(msg) as { approval_id: string }).approval_id;
}

test("production generate WITHOUT allowed_actions records the DEFAULT scope on the approval (human sees true scope)", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "P1", environment: "production", source: "local",
      allowed_domains: ["example.com"], wait_for_approval: false,
    });
    assert.equal(g.status, 400);
    assert.equal((g.body as { error: { code: string } }).error.code, "approval_required");
    const grant = services.approvals.get(approvalId(g))!;
    // Effective scope (none supplied → extended default) is on the binding…
    assert.deepEqual(grant.allowed_actions, DEFAULT_ACTIONS);
    // …and the token-gated UI JSON serializes it for the human.
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${grant.id}?token=${grant.ui_token}`);
    assert.deepEqual(((await res.json()) as { allowed_actions: unknown }).allowed_actions, DEFAULT_ACTIONS);
  });
});

test("production force-rotate WITHOUT allowed_actions records the PRESERVED existing scope on the approval", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await services.vault.upsertSecret({
      name: "P2", environment: "production", source: "local",
      value: "v1", allowedDomains: ["example.com"], allowedActions: ["inject_into_field"],
    });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "P2", environment: "production", source: "local",
      allowed_domains: ["example.com"], force: true, wait_for_approval: false,
    });
    assert.equal(g.status, 400);
    const grant = services.approvals.get(approvalId(g))!;
    assert.deepEqual(grant.allowed_actions, ["inject_into_field"]);
  });
});
