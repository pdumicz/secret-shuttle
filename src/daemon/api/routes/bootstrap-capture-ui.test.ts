// src/daemon/api/routes/bootstrap-capture-ui.test.ts
//
// Covers the C13 tokenized raw UI routes:
//   - POST /ui/bootstrap/capture-step?token=<token>
//   - POST /ui/bootstrap/skip-step?token=<token>
//   - POST /ui/bootstrap/abandon?token=<token>
//
// Each route's auth is the single-use `capture_token` query parameter — there
// is NO bearer token (the routes are registered via addRouteRaw, which
// bypasses the Host + bearer auth gate). The token IS the auth and the
// PendingCapturesRegistry deletes the entry on resolve/reject so a second
// request with the same token returns 404 (single-use invariant).
//
// The capture-step route invokes captureFromTarget (C6), which is the only
// path that interacts with the CDP transport. We supply a ScriptedTransport
// stub that replies to Target.getTargetInfo / attachToTarget / Runtime.evaluate
// in just enough detail to drive captureFromTarget through its happy path.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { CdpClient, type CdpTransport } from "../../chrome/cdp-client.js";
import type { BrowserSession, BrowserSessionChild } from "../../bootstrap/browser-session.js";
import type { ProxyServer } from "../../proxy/cdp-proxy.js";
import type { BrowserOps } from "../../chrome/internal-ops.js";

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Minimal CDP transport stub that drives captureFromTarget through its happy
 * path:
 *   1. Target.getTargetInfo → returns a URL on `dashboard.stripe.com` (the
 *      registered expected_host).
 *   2. Target.attachToTarget → returns a sessionId.
 *   3. Runtime.evaluate → returns a successful focused-field READ_SCRIPT
 *      payload {ok:true, value, source:"focused-field", field, domain}.
 *   4. Target.detachFromTarget → returns {}.
 *
 * Tests can override `targetUrl` to simulate a redirect (host drift), which
 * captureFromTarget rejects with bootstrap_capture_redirect_blocked before
 * any DOM read.
 */
class ScriptedTransport extends EventEmitter implements CdpTransport {
  targetUrl = "https://dashboard.stripe.com/login";
  readResult: {
    ok: boolean;
    value?: string;
    source?: "focused-field" | "selection";
    field?: { tag: string; type: string; name: string; id: string };
    domain?: string;
    reason?: string;
  } = {
    ok: true,
    value: "sk_live_secret",
    source: "focused-field",
    field: { tag: "input", type: "password", name: "key", id: "key" },
    domain: "dashboard.stripe.com",
  };

  close(): void { /* noop */ }

  send(msg: Sent): void {
    const method = msg.method ?? "";
    const reply = (result: unknown): void =>
      queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    switch (method) {
      case "Target.getTargetInfo":
        reply({
          targetInfo: {
            targetId: String(msg.params?.["targetId"] ?? "T-1"),
            type: "page",
            url: this.targetUrl,
            attached: true,
          },
        });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: "S-1" });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      case "Runtime.evaluate":
        reply({ result: { value: this.readResult } });
        return;
      default:
        reply({});
        return;
    }
  }
}

interface Ctx {
  port: number;
  services: DaemonServices;
  transport: ScriptedTransport;
  /** Close handles so we don't leak across tests. */
  server: DaemonServer;
}

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  // Wire a real DaemonServer with the full router so the routes resolve
  // through the same registration path production uses. We provide a real
  // bearer token but the C13 routes are raw → bearer is irrelevant for them.
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));

  // Stub a BrowserSession so /ui/bootstrap/capture-step's call into
  // captureFromTarget has a non-null cdp to dispatch on. ScriptedTransport
  // replies to every CDP method captureFromTarget issues during its happy
  // path; redirect tests override `targetUrl` to drive the failure branch.
  const transport = new ScriptedTransport();
  const cdp = new CdpClient(transport);
  const proxy: ProxyServer = {
    url: "ws://127.0.0.1:0/stub",
    severAgentConnections(): void { /* noop */ },
    async close(): Promise<void> { /* noop */ },
  };
  const child: BrowserSessionChild = {
    kill(): boolean { return true; },
    once(): unknown { return this; },
  };
  const session: BrowserSession = {
    owner: { kind: "bootstrap", batchId: "b1" },
    child,
    cdp,
    proxy,
    browserSessionId: "ws://127.0.0.1:0/stub",
    browser: { available: true } as unknown as BrowserOps,
  };
  services.browserSession = session;

  try {
    return await fn({ port, services, transport, server });
  } finally {
    await server.close();
  }
}

/**
 * Helper: register a pending capture in the registry so the routes have
 * something to look up / settle. Returns the token AND the Promise the
 * executor would normally await. Tests can await this Promise to assert that
 * a route call settled it with the expected error code.
 */
function registerPending(
  services: DaemonServices,
  opts: {
    token: string;
    batchId?: string;
    secretName?: string;
    targetId?: string;
    expectedHost?: string;
  },
): Promise<{ value: string; field_fingerprint: string }> {
  // Suppress unhandled-rejection: tests that don't explicitly catch this
  // would otherwise log a warning when the route rejects the Promise.
  const p = services.pendingCaptures.register({
    batchId: opts.batchId ?? "b1",
    secretName: opts.secretName ?? "STRIPE_KEY",
    capture_token: opts.token,
    target_id: opts.targetId ?? "T-1",
    expected_host: opts.expectedHost ?? "dashboard.stripe.com",
    owner_agent_id: "root",
    timeoutMs: 60_000,
    onTimeout: () => {},
  });
  p.catch(() => undefined);
  return p;
}

/** POST helper. Does NOT send an Authorization header — the raw routes
 *  must NOT require one (capture_token IS the auth). */
async function post(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    ...init,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { _raw: text }; }
  return { status: res.status, body };
}

// ── Test 1 — capture-step: valid token → captures + resolves pending ────────

test("POST /ui/bootstrap/capture-step?token=<valid>: captures + resolves pending", async () => {
  await withCtx(async (ctx) => {
    const token = "tok-success";
    const pending = registerPending(ctx.services, { token });

    const r = await post(ctx.port, `/ui/bootstrap/capture-step?token=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body["ok"], true);

    // The Promise the executor awaits MUST now resolve with the captured
    // value + fingerprint. This is the load-bearing assertion — proves the
    // route both invoked captureFromTarget AND wired its result back into
    // the pending registry.
    const result = await pending;
    assert.equal(result.value, "sk_live_secret");
    assert.equal(typeof result.field_fingerprint, "string");
    assert.ok(result.field_fingerprint.length > 0, "field_fingerprint must be non-empty");

    // Single-use: token must be gone from the registry.
    assert.equal(ctx.services.pendingCaptures.lookup(token), undefined);
  });
});

// ── Test 2 — capture-step: invalid token → 404 ──────────────────────────────

test("POST /ui/bootstrap/capture-step?token=<invalid>: 404", async () => {
  await withCtx(async (ctx) => {
    const r = await post(ctx.port, "/ui/bootstrap/capture-step?token=does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.body["ok"], false);
    assert.equal(r.body["error_code"], "capture_token_invalid");
  });
});

// ── Test 3 — skip-step: rejects pending with bootstrap_capture_skipped ──────

test("POST /ui/bootstrap/skip-step?token=<valid>: rejects pending with bootstrap_capture_skipped", async () => {
  await withCtx(async (ctx) => {
    const token = "tok-skip";
    const pending = registerPending(ctx.services, { token });

    const r = await post(ctx.port, `/ui/bootstrap/skip-step?token=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body["ok"], true);

    // Pending Promise rejects with bootstrap_capture_skipped.
    await assert.rejects(pending, (err: unknown) => {
      // ShuttleError carries a .code field; the executor's state machine
      // discriminates on this exact string.
      assert.equal((err as { code: string }).code, "bootstrap_capture_skipped");
      return true;
    });

    // Single-use: token must be gone from the registry.
    assert.equal(ctx.services.pendingCaptures.lookup(token), undefined);
  });
});

// ── Test 4 — abandon: rejects with bootstrap_capture_aborted ────────────────

test("POST /ui/bootstrap/abandon?token=<valid>: rejects with bootstrap_capture_aborted", async () => {
  // Note: the status transition to "abandoned" happens in the executor's
  // terminal cleanup from C11, NOT in this route. We verify only that the
  // route rejects the Promise with the correct error code; batch.status is
  // a separate concern owned by the executor's state machine.
  await withCtx(async (ctx) => {
    const token = "tok-abandon";
    const pending = registerPending(ctx.services, { token });

    const r = await post(ctx.port, `/ui/bootstrap/abandon?token=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body["ok"], true);

    await assert.rejects(pending, (err: unknown) => {
      assert.equal((err as { code: string }).code, "bootstrap_capture_aborted");
      return true;
    });

    // Single-use: token must be gone from the registry.
    assert.equal(ctx.services.pendingCaptures.lookup(token), undefined);
  });
});

// ── Test 5 — Tokens are single-use: second use returns 404 ──────────────────

test("Tokens are single-use: second use of the same token returns 404", async () => {
  await withCtx(async (ctx) => {
    const token = "tok-single-use";
    const pending = registerPending(ctx.services, { token });

    // First call consumes the token (skip, since it has no CDP side effects
    // and a simpler assertion path than capture-step).
    const first = await post(ctx.port, `/ui/bootstrap/skip-step?token=${token}`);
    assert.equal(first.status, 200);
    assert.equal(first.body["ok"], true);
    // Drain the rejection so the unhandled-rejection guard doesn't fire.
    await pending.catch(() => undefined);

    // Second call with the SAME token → 404 across all three routes.
    const skip2 = await post(ctx.port, `/ui/bootstrap/skip-step?token=${token}`);
    assert.equal(skip2.status, 404);
    assert.equal(skip2.body["ok"], false);

    const abandon2 = await post(ctx.port, `/ui/bootstrap/abandon?token=${token}`);
    assert.equal(abandon2.status, 404);
    assert.equal(abandon2.body["ok"], false);

    const capture2 = await post(ctx.port, `/ui/bootstrap/capture-step?token=${token}`);
    assert.equal(capture2.status, 404);
    assert.equal(capture2.body["ok"], false);
    assert.equal(capture2.body["error_code"], "capture_token_invalid");
  });
});

// ── Test 6 — Routes do NOT require Authorization header ─────────────────────

test("Routes do NOT require Authorization header (raw routes — token IS the auth)", async () => {
  await withCtx(async (ctx) => {
    // Sanity: a bearer-gated route would 401 without Authorization. Prove
    // that here by hitting the bearer-gated /v1/status path with the same
    // bare-fetch helper — if we ever regress addRouteRaw to require a
    // bearer, this assertion would falsely pass, so we cross-check below.
    const statusNoAuth = await fetch(`http://127.0.0.1:${ctx.port}/v1/status`);
    assert.equal(statusNoAuth.status, 401, "control: bearer-gated route must 401 without Authorization");

    // The capture-step route: 404 (because the token is unknown) WITHOUT
    // the request being rejected upstream at 401. If addRouteRaw silently
    // started requiring a bearer, this would be 401 instead.
    const capture = await post(ctx.port, "/ui/bootstrap/capture-step?token=does-not-exist");
    assert.equal(capture.status, 404, "capture-step must reach the handler, not 401");

    const skip = await post(ctx.port, "/ui/bootstrap/skip-step?token=does-not-exist");
    assert.equal(skip.status, 404, "skip-step must reach the handler, not 401");

    const abandon = await post(ctx.port, "/ui/bootstrap/abandon?token=does-not-exist");
    assert.equal(abandon.status, 404, "abandon must reach the handler, not 401");

    // And a happy-path call with NO Authorization header must work end-to-end.
    const token = "tok-no-auth";
    const pending = registerPending(ctx.services, { token });
    const skipOk = await post(ctx.port, `/ui/bootstrap/skip-step?token=${token}`);
    assert.equal(skipOk.status, 200);
    assert.equal(skipOk.body["ok"], true);
    await pending.catch(() => undefined);
  });
});
