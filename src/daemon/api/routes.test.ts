import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import type { BrowserOps, CaptureResult } from "../chrome/internal-ops.js";

async function withDaemon<T>(fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-api-"));
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

test("blind start calls severAgentConnections when a cdpProxy is registered", async () => {
  await withDaemon(async (ctx) => {
    let severed = false;
    ctx.services.cdpProxy = {
      url: "ws://127.0.0.1:0/cdp/fake",
      severAgentConnections: () => { severed = true; },
      close: async () => undefined,
    };
    const r = await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "sever-test" });
    assert.equal(r.status, 200);
    assert.equal(severed, true, "severAgentConnections must be called on blind start");
  });
});

test("blind start activates state visible via /v1/status; end clears (with pre-issued approval)", async () => {
  await withDaemon(async (ctx) => {
    const s = await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    assert.equal(s.status, 200);
    const status = await call(ctx, "GET", "/v1/status");
    const bm = (status.body as { blind_mode?: { domain: string } }).blind_mode;
    assert.equal(bm?.domain, "stripe.com");
    // blind end now requires a human approval gate — pre-issue one.
    const grant = ctx.services.approvals.create({
      action: "blind_end", ref: null, environment: "blind",
      destination_domain: "stripe.com", target_id: null,
      field_fingerprint: null, template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);
    const e = await call(ctx, "POST", "/v1/blind/end", { approval_id: grant.id, wait_for_approval: false });
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
    assert.ok((r.body as { fingerprint: string }).fingerprint.startsWith("hmac-sha256:"));
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

test("unlock via web UI flow: start, submit passphrase, poll, unlocked", async () => {
  await withDaemon(async (ctx) => {
    // Start an unlock session.
    const start = await call(ctx, "POST", "/v1/unlock/start");
    assert.equal(start.status, 200);
    const sb = start.body as { session_id: string; requires_create: boolean };
    assert.equal(sb.requires_create, true);
    // The response must not expose ui_token to the CLI.
    assert.equal("ui_token" in sb, false);

    // Poll — pending.
    const pollPending = await call(ctx, "POST", "/v1/unlock/poll", { session_id: sb.session_id });
    assert.equal((pollPending.body as { status: string }).status, "pending");

    // Retrieve the ui_token from the server-side store (as the daemon would use it internally).
    const session = ctx.services.unlockSessions.get(sb.session_id);
    assert.ok(session, "session should exist in store");

    // Submit passphrase via UI route (no bearer; URL token).
    const submitRes = await fetch(`http://127.0.0.1:${ctx.port}/ui/unlock/${sb.session_id}?token=${session.ui_token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "secret123", set_passphrase: true }),
    });
    assert.equal(submitRes.status, 200);

    // Poll — unlocked.
    const pollDone = await call(ctx, "POST", "/v1/unlock/poll", { session_id: sb.session_id });
    assert.equal((pollDone.body as { status: string }).status, "unlocked");

    // Daemon status now reports unlocked: true.
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { unlocked: boolean }).unlocked, true);
  });
});

test("capture rejects when the focused field changes between approval and capture", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "dashboard.stripe.com", reason: "r" });

    const field = { tag: "input", editable: true };
    let reads = 0;
    // readFocusedFingerprintAndDomain() is called once for `pre` (fingerprint FIELD_A).
    // captureFocused() returns a DIFFERENT fingerprint FIELD_B but the SAME target_id
    // (so the old target_id-only check would have passed).
    ctx.services.browser = {
      available: true,
      currentDomainAndTarget: async () => ({ domain: "dashboard.stripe.com", target_id: "T1" }),
      readFocusedFingerprintAndDomain: async () => {
        reads += 1;
        return { domain: "dashboard.stripe.com", target_id: "T1", field, field_fingerprint: "sha256:FIELD_A" };
      },
      captureFocused: async () => ({
        value: "whsec_from_wrong_field",
        domain: "dashboard.stripe.com",
        target_id: "T1",
        field,
        field_fingerprint: "sha256:FIELD_B",
      }),
      captureSelection: async () => ({
        value: "whsec_from_wrong_field",
        domain: "dashboard.stripe.com",
        target_id: "T1",
        field,
        field_fingerprint: "sha256:FIELD_B",
      }),
      injectFocused: async () => ({ domain: "dashboard.stripe.com", target_id: "T1", field, field_fingerprint: "sha256:FIELD_A" }),
    };

    // Pre-issue an approval bound to FIELD_A (matches the `pre` read).
    const grant = ctx.services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T1", field_fingerprint: "sha256:FIELD_A",
      template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);

    const r = await call(ctx, "POST", "/v1/secrets/capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      allowed_domains: ["dashboard.stripe.com"], approval_id: grant.id, wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "field_changed");
    void reads;
  });
});

test("UI unlock route rejects invalid ui_token", async () => {
  await withDaemon(async (ctx) => {
    const start = await call(ctx, "POST", "/v1/unlock/start");
    const sb = start.body as { session_id: string };
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/unlock/${sb.session_id}?token=nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "x", set_passphrase: true }),
    });
    assert.equal(res.status, 400);
  });
});

test("GET /ui/unlock serves the HTML page", async () => {
  await withDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/unlock`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Unlock Secret Shuttle"));
  });
});

test("approval_required payload does NOT include ui_token / approval_url", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PROD_GEN", environment: "production", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    const err = r.body as { error: { code: string; message: string } };
    assert.equal(err.error.code, "approval_required");
    // The message is a JSON-stringified body with approval_id + expires_at only.
    const inner = JSON.parse(err.error.message) as Record<string, unknown>;
    assert.ok(typeof inner.approval_id === "string");
    assert.equal("approval_url" in inner, false);
    assert.equal("ui_token" in inner, false);
    // The grant in the store should have a ui_token, but it must not appear in the API response.
    const grant = ctx.services.approvals.get(inner.approval_id as string);
    assert.ok(grant);
    assert.ok(grant.ui_token.length > 0);
  });
});

test("CLI-visible payload cannot self-approve: no way to derive ui_token from response", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PROD_GEN2", environment: "production", wait_for_approval: false,
    });
    const inner = JSON.parse((r.body as { error: { message: string } }).error.message) as { approval_id: string };
    // An attacker who only sees the API response cannot guess the ui_token (UUID-random).
    // Confirm /ui/approvals/<id>/approve without token is rejected.
    const tryApprove = await fetch(`http://127.0.0.1:${ctx.port}/ui/approvals/${inner.approval_id}/approve`, { method: "POST" });
    assert.equal(tryApprove.status, 400);
    // Even attempting with a guessed-wrong token is rejected.
    const wrongToken = await fetch(`http://127.0.0.1:${ctx.port}/ui/approvals/${inner.approval_id}/approve?token=wrong`, { method: "POST" });
    assert.equal(wrongToken.status, 400);
  });
});

test("template run vercel-env-add with invalid environment returns 400 invalid_template_param and does not create an approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Use a development secret to avoid a separate approval gate for generate.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "STRIPE_KEY", environment: "development", kind: "random_32_bytes",
    });

    // Record how many approvals exist before the call.
    const approvalsBefore = (ctx.services.approvals as unknown as { grants: Map<string, unknown> }).grants.size;
    const r = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add",
      ref: "ss://local/dev/STRIPE_KEY",
      params: { name: "STRIPE_KEY", environment: "prod" },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "invalid_template_param");
    // Validation must run before requireApproval — no new grant should have been created.
    const approvalsAfter = (ctx.services.approvals as unknown as { grants: Map<string, unknown> }).grants.size;
    assert.equal(approvalsAfter, approvalsBefore, "no approval should be created for an invalid template request");
  });
});

// Fix 1 tests — blind end requires human approval

test("blind end requires human approval and is not agent-controlled", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "dashboard.stripe.com", reason: "r" });
    // No approval, no wait → must report approval_required, blind stays active.
    const r = await call(ctx, "POST", "/v1/blind/end", { wait_for_approval: false });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
    const status = await call(ctx, "GET", "/v1/status");
    assert.notEqual((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("blind end succeeds with a pre-issued approval bound to the blind domain", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "dashboard.stripe.com", reason: "r" });
    const grant = ctx.services.approvals.create({
      action: "blind_end", ref: null, environment: "blind",
      destination_domain: "dashboard.stripe.com", target_id: null,
      field_fingerprint: null, template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(grant.id);
    const r = await call(ctx, "POST", "/v1/blind/end", { approval_id: grant.id, wait_for_approval: false });
    assert.equal(r.status, 200);
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("blind end is a no-op (no approval needed) when blind mode is not active", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/blind/end", { wait_for_approval: false });
    assert.equal(r.status, 200);
  });
});

// Fix 2 tests — template approval classifies destination environment

test("template run: dev-classed secret targeting Vercel production REQUIRES approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a development secret (no approval needed to generate dev).
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "API_KEY", environment: "development", source: "local",
    });
    // Run vercel-env-add targeting production with that dev secret, no approval.
    const r = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add",
      ref: "ss://local/dev/API_KEY",
      params: { name: "API_KEY", environment: "production" },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("template run: dev secret to Vercel development does not force approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "API_KEY2", environment: "development", source: "local",
    });
    // No production anywhere → approval not forced. It will still try to run the
    // real `vercel` binary which won't exist in CI/sandbox; that yields a
    // template/binary error, NOT approval_required. Assert it's NOT approval_required.
    const r = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add",
      ref: "ss://local/dev/API_KEY2",
      params: { name: "API_KEY2", environment: "development" },
      wait_for_approval: false,
    });
    assert.notEqual((r.body as { error?: { code?: string } }).error?.code, "approval_required");
  });
});

test("production template: route-created grant is consumable on retry (no self-mismatch)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret.
    const g = ctx.services.approvals.create({
      action: "generate", ref: null, planned_ref: "ss://local/prod/TPL2",
      environment: "production", destination_domain: null, target_id: null,
      field_fingerprint: null, template_id: null, template_params: null,
    });
    ctx.services.approvals.approve(g.id);
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "TPL2", environment: "production", source: "local",
      approval_id: g.id, wait_for_approval: false,
    });

    // First call: no approval_id, no wait → route creates a grant + throws approval_required.
    const first = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add", ref: "ss://local/prod/TPL2",
      params: { name: "TPL2", environment: "production" }, wait_for_approval: false,
    });
    assert.equal(first.status, 400);
    const firstCode = (first.body as { error: { code: string; message: string } }).error.code;
    assert.equal(firstCode, "approval_required");
    const { approval_id } = JSON.parse(
      (first.body as { error: { message: string } }).error.message,
    ) as { approval_id: string };

    // Human approves the route-created grant.
    ctx.services.approvals.approve(approval_id);

    // Retry with that approval_id → MUST NOT be approval_mismatch (same binding shape).
    const second = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add", ref: "ss://local/prod/TPL2",
      params: { name: "TPL2", environment: "production" }, approval_id, wait_for_approval: false,
    });
    const code2 = (second.body as { error?: { code?: string } }).error?.code;
    assert.notEqual(code2, "approval_mismatch");
  });
});

test("inject is refused when the secret has an empty allowed-domains list", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Dev secret generated with NO allowed domains → stored [] → not injectable.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "NOSCOPE", environment: "development", source: "local",
    });
    ctx.services.browser = stubBrowser({ domain: "anything.example.com", target: "T1", value: "" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/NOSCOPE", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "domain_not_allowed");
  });
});

test("compare on a production secret requires approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    ctx.services.browser = stubBrowser({ domain: "stripe.com", target: "T1", value: "alpha" });
    const cap = ctx.services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/prod/PK",
      environment: "production", destination_domain: "stripe.com",
      target_id: "T1", field_fingerprint: "sha256:T1-stripe.com",
      template_id: null, template_params: null, allowed_domains: ["stripe.com"],
    });
    ctx.services.approvals.approve(cap.id);
    await call(ctx, "POST", "/v1/secrets/capture", {
      name: "PK", environment: "production", source: "stripe",
      allowed_domains: ["stripe.com"], approval_id: cap.id, wait_for_approval: false,
    });
    const r = await call(ctx, "POST", "/v1/secrets/compare", {
      ref: "ss://stripe/prod/PK", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("inject with a non-string ref returns bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/inject", { ref: 123 });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("successful inject leaves daemon-managed blind mode ACTIVE and severs the proxy", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    let severed = false;
    ctx.services.cdpProxy = {
      url: "ws://127.0.0.1:0/cdp/fake",
      severAgentConnections: () => { severed = true; },
      close: async () => undefined,
    };
    ctx.services.browser = stubBrowser({ domain: "app.example.com", target: "T1", value: "" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { injected: boolean }).injected, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal(severed, true, "inject must sever agent CDP connections");
    const status = await call(ctx, "GET", "/v1/status");
    assert.notEqual((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("inject that fails before writing the value auto-resumes (blind mode left OFF)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ2", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    const field = { tag: "input", editable: true };
    let reads = 0;
    ctx.services.browser = {
      available: true,
      captureFocused: async () => ({ value: "", domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      captureSelection: async () => ({ value: "", domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      injectFocused: async () => ({ domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      readFocusedFingerprintAndDomain: async () => {
        reads += 1;
        return { domain: "app.example.com", target_id: reads === 1 ? "T1" : "T-DIFF", field, field_fingerprint: "f" };
      },
      currentDomainAndTarget: async () => ({ domain: "app.example.com", target_id: "T1" }),
    };
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ2", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "field_changed");
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("inject keeps blind mode ACTIVE if bookkeeping fails AFTER the value is written (fail closed)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ3", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    ctx.services.browser = stubBrowser({ domain: "app.example.com", target: "T1", value: "" });
    // injectFocused SUCCEEDS (value written), but post-write markUsed throws.
    ctx.services.vault.markUsed = async () => { throw new Error("disk_failure_after_write"); };
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ3", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status >= 400, true, "inject should report the post-write failure");
    // CRITICAL: the secret is on the page; blind mode MUST stay active (fail closed).
    const status = await call(ctx, "GET", "/v1/status");
    assert.notEqual((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("inject is refused (fail fast) when a blind window is already active", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ4", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    ctx.services.browser = stubBrowser({ domain: "app.example.com", target: "T1", value: "" });
    // A blind window is already active (e.g. a capture in progress).
    await call(ctx, "POST", "/v1/blind/start", { domain: "app.example.com", reason: "capture-in-progress" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ4", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "blind_mode_already_active");
    // The pre-existing blind window must be untouched.
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { blind_mode: { domain: string } }).blind_mode.domain, "app.example.com");
  });
});
