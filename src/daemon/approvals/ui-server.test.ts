import assert from "node:assert/strict";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { ApprovalStore } from "./store.js";
import { registerUiRoutes } from "./ui-server.js";

const SAMPLE = {
  action: "inject" as const,
  ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  environment: "production",
  destination_domain: "vercel.com",
  target_id: "T1",
  field_fingerprint: "sha256:fp",
  template_id: null,
  template_params: null,
};

async function withServer<T>(fn: (ctx: { store: ApprovalStore; port: number }) => Promise<T>): Promise<T> {
  const server = new DaemonServer({ token: "t" });
  const store = new ApprovalStore({ ttlMs: 60_000 });
  registerUiRoutes(server, store);
  const { port } = await server.listen(0);
  try {
    return await fn({ store, port });
  } finally {
    await server.close();
  }
}

test("GET /ui/approve serves the static HTML", async () => {
  await withServer(async ({ port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/ui/approve`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes("Secret Shuttle"));
  });
});

test("GET /ui/approvals/:id requires matching ui_token", async () => {
  await withServer(async ({ store, port }) => {
    const g = store.create(SAMPLE);
    const bad = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=wrong`);
    assert.equal(bad.status, 400);

    const ok = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as { id: string; status: string };
    assert.equal(body.id, g.id);
    assert.equal(body.status, "pending");
  });
});

test("POST /ui/approvals/:id/approve flips status to granted", async () => {
  await withServer(async ({ store, port }) => {
    const g = store.create(SAMPLE);
    const r = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}/approve?token=${g.ui_token}`, { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(store.get(g.id)?.status, "granted");
  });
});

test("POST /ui/approvals/:id/deny flips status to denied", async () => {
  await withServer(async ({ store, port }) => {
    const g = store.create(SAMPLE);
    const r = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}/deny?token=${g.ui_token}`, { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(store.get(g.id)?.status, "denied");
  });
});

test("POST /ui/approvals/:id/approve with wrong token is rejected", async () => {
  await withServer(async ({ store, port }) => {
    const g = store.create(SAMPLE);
    const r = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}/approve?token=nope`, { method: "POST" });
    assert.equal(r.status, 400);
    assert.equal(store.get(g.id)?.status, "pending");
  });
});
