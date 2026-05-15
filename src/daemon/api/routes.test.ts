import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import { fingerprintSecret } from "../../vault/fingerprints.js";
import type { BrowserOps, CaptureResult } from "../chrome/internal-ops.js";

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

function stubBrowser(s: { domain: string; target: string; value: string }): BrowserOps {
  const field = { tag: "input", editable: true };
  const fp = `sha256:${s.target}-${s.domain}`;
  const make = (): CaptureResult => ({ value: s.value, domain: s.domain, target_id: s.target, field, field_fingerprint: fp });
  return {
    available: true,
    captureFocused: async () => make(),
    captureSelection: async () => make(),
    injectFocused: async () => ({ domain: s.domain, target_id: s.target, field, field_fingerprint: fp }),
    readFocusedFingerprintAndDomain: async () => {
      const { value, ...rest } = make();
      void value;
      return rest;
    },
    currentDomainAndTarget: async () => ({ domain: s.domain, target_id: s.target }),
  };
}

test("blind start activates state visible via /v1/status; end clears", async () => {
  await withDaemon(async (ctx) => {
    const s = await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    assert.equal(s.status, 200);
    const status = await call(ctx, "GET", "/v1/status");
    const bm = (status.body as { blind_mode?: { domain: string } }).blind_mode;
    assert.equal(bm?.domain, "stripe.com");
    const e = await call(ctx, "POST", "/v1/blind/end");
    assert.equal(e.status, 200);
    const status2 = await call(ctx, "GET", "/v1/status");
    assert.equal((status2.body as { blind_mode: null }).blind_mode, null);
  });
});

test("list and inspect require unlocked vault", async () => {
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/secrets/list", {});
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "vault_locked");
  });
});

test("generate of development secret succeeds without approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "FOO", environment: "development", kind: "random_32_bytes",
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { generated: boolean }).generated, true);
  });
});

test("generate of production secret without approval returns approval_required", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PROD_GEN", environment: "production", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("capture round-trips with pre-issued approval and stubbed browser", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "dashboard.stripe.com", reason: "r" });
    ctx.services.browser = stubBrowser({ domain: "dashboard.stripe.com", target: "T1", value: "whsec_simulated" });

    const grant = ctx.services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T1", field_fingerprint: "sha256:T1-dashboard.stripe.com",
      template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);

    const r = await call(ctx, "POST", "/v1/secrets/capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      allowed_domains: ["dashboard.stripe.com", "vercel.com"], approval_id: grant.id, wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: boolean }).captured, true);
    assert.equal((r.body as { secret_ref: string }).secret_ref, "ss://stripe/prod/STRIPE_WEBHOOK_SECRET");
    // Verify the stored fingerprint matches the value we injected via the stub.
    assert.equal((r.body as { fingerprint: string }).fingerprint, fingerprintSecret("whsec_simulated"));
  });
});

test("inject refuses when target changes after approval (post != pre)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a secret to inject.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "X", environment: "development", source: "local",
      allowed_domains: ["dashboard.example.com"],
    });

    // Browser stub that flips the target between pre and post calls.
    const field = { tag: "input", editable: true };
    let calls = 0;
    ctx.services.browser = {
      available: true,
      captureFocused: async () => ({ value: "", domain: "dashboard.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      captureSelection: async () => ({ value: "", domain: "dashboard.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      injectFocused: async () => ({ domain: "dashboard.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      readFocusedFingerprintAndDomain: async () => {
        calls += 1;
        return { domain: "dashboard.example.com", target_id: calls === 1 ? "T1" : "T-DIFFERENT", field, field_fingerprint: "f" };
      },
      currentDomainAndTarget: async () => ({ domain: "dashboard.example.com", target_id: "T1" }),
    };

    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/X", domain: "dashboard.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "field_changed");
  });
});

test("compare returns matches=true when stubbed value matches stored secret", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Capture a known value via the stub.
    await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    ctx.services.browser = stubBrowser({ domain: "stripe.com", target: "T1", value: "alpha" });
    const grant = ctx.services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/dev/X",
      environment: "development", destination_domain: "stripe.com",
      target_id: "T1", field_fingerprint: "sha256:T1-stripe.com",
      template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);
    await call(ctx, "POST", "/v1/secrets/capture", {
      name: "X", environment: "development", source: "stripe",
      allowed_domains: ["stripe.com"], approval_id: grant.id, wait_for_approval: false,
    });

    const r = await call(ctx, "POST", "/v1/secrets/compare", { ref: "ss://stripe/dev/X" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { matches: boolean }).matches, true);
  });
});

test("approvals/poll returns status of a pending grant", async () => {
  await withDaemon(async (ctx) => {
    const g = ctx.services.approvals.create({
      action: "inject", ref: "ss://x/dev/Y", environment: "development",
      destination_domain: "x.com", target_id: "T1", field_fingerprint: "f",
      template_id: null, template_params: null,
    });
    const r = await call(ctx, "POST", "/v1/approvals/poll", { id: g.id });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, "pending");
  });
});
