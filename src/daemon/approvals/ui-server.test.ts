import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("GET /ui/approvals/:id includes template_params in JSON", async () => {
  await withServer(async ({ store, port }) => {
    const g = store.create({
      action: "template" as const,
      ref: "ss://local/prod/STRIPE_SECRET",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: "vercel-env-add",
      template_params: { name: "STRIPE_KEY", environment: "production" },
      template_binary_path: "/usr/local/bin/vercel",
      template_binary_sha256: "abc123",
    });
    const r = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    assert.equal(r.status, 200);
    const body = await r.json() as {
      template_params: Record<string, string> | null;
      template_id: string | null;
    };
    assert.deepEqual(body.template_params, { name: "STRIPE_KEY", environment: "production" });
    assert.equal(body.template_id, "vercel-env-add");
  });
});

test("GET /ui/approve sets CSP with frame-ancestors 'self'", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/ui/approve`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  });
});

test("ui.html human[].run_stdin: explains stdin pipe + masking", async () => {
  const html = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html"),
    "utf8",
  );
  // The human[] map entry for run_stdin must exist and reference:
  // - "stdin" (what's happening)
  // - "pipe" (the action verb)
  // - "fd 0" or "directly" (clarify CLI doesn't see plaintext)
  // - "masked" (defense-in-depth on child stdout/stderr)
  assert.match(html, /run_stdin\s*:/);
  const runStdinSection = html.match(/run_stdin\s*:\s*`([^`]+)`/);
  assert.ok(runStdinSection, "run_stdin human[] entry must exist as a template literal");
  const copy = runStdinSection![1]!;
  assert.match(copy, /stdin/i, "must mention stdin");
  assert.match(copy, /pipe/i, "must describe piping");
  assert.match(copy, /mask/i, "must mention masking");
});
