// Burst 5 §2b Task 2b.7: `secret-shuttle status` calls GET /v1/health
// (src/cli/commands/status.ts) so the active_sessions[] surface lives on the
// health response, NOT the unrelated /v1/status route. These tests pin:
//   1. The health route adds owner-scoped active_sessions[].
//   2. Owner scoping is strict — sessions from agent A are invisible to agent B.
//   3. The CLI's text-mode formatter renders the section when present.
//   4. The formatter omits the section when empty/absent.
//
// Tests 1 and 2 are HTTP-level integration tests using an inline daemon
// harness (modeled on approvals-session.test.ts) so they exercise the real
// route registration + ALS-driven getCurrentAgentId() path. Tests 3 and 4 hit
// the pure formatDoctorText() function — JSON-mode flow-through is implicitly
// verified by test 1 (the field rides through report.health unchanged).
//
// We don't spawn the CLI binary because that would require sandboxed HOME,
// pre-written socket file + agent bearer setup just to assert two regex
// matches. The current shape — HTTP at the route + pure-function rendering —
// keeps the contract testable without subprocess gymnastics.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../daemon/server.js";
import { DaemonServices } from "../../daemon/services.js";
import { registerRoutes } from "../../daemon/api/router.js";
import { withAuthContext } from "../../daemon/auth/auth-context.js";
import { deriveHmac, formatBearer } from "../../daemon/auth/token-derive.js";
import { formatDoctorText, type DoctorReport } from "./status.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-status-active-sessions-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token: deriveHmac requires this length.
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

async function callWithBearer(
  ctx: { port: number },
  bearer: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function agentBearer(rootToken: string, agentId: string): string {
  return formatBearer(agentId, deriveHmac(rootToken, agentId));
}

// Destructure-and-guard so test code typechecks under noUncheckedIndexedAccess
// (length assertions alone don't narrow index access).
function first<T>(arr: readonly T[], label: string): T {
  const [x] = arr;
  assert.ok(x !== undefined, `expected ${label}[0] to exist`);
  return x;
}

interface ActiveSession {
  id: string;
  pattern_summary: string;
  expires_at: string;
  minutes_remaining: number;
}

test("GET /v1/health includes active_sessions[] for the calling agent", async () => {
  await withDaemon(async (ctx) => {
    // Mint and approve a session owned by claude-abc via the store-level ALS
    // (mirrors the approvals-session.test.ts pattern — simpler than the full
    // HTTP create+approve dance, and the route registration is what we're
    // actually testing here).
    let sessionId = "";
    withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
      const s = ctx.services.sessionStore.create({
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 15 * 60 * 1000,
        required_params: { name: "STRIPE_KEY", environment: "production" },
      });
      ctx.services.sessionStore.approve(s.id);
      sessionId = s.id;
    });

    const bearer = agentBearer(ctx.token, "claude-abc");
    const r = await callWithBearer(ctx, bearer, "GET", "/v1/health");
    assert.equal(r.status, 200);

    const active = (r.body as { active_sessions?: ActiveSession[] }).active_sessions;
    assert.ok(Array.isArray(active), "health response should include active_sessions array");
    assert.equal(active.length, 1);

    const session = first(active, "active_sessions");
    assert.equal(session.id, sessionId);
    assert.match(session.pattern_summary, /vercel-env-add/);
    assert.match(session.pattern_summary, /name=STRIPE_KEY/);
    assert.match(session.pattern_summary, /environment=production/);
    assert.equal(typeof session.expires_at, "string");
    assert.equal(typeof session.minutes_remaining, "number");
    assert.ok(session.minutes_remaining > 0, "expected positive minutes_remaining for fresh grant");
  });
});

test("GET /v1/health active_sessions is owner-scoped (agent B never sees agent A's session)", async () => {
  await withDaemon(async (ctx) => {
    // Agent A creates+approves a session.
    withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const s = ctx.services.sessionStore.create({
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 60_000,
      });
      ctx.services.sessionStore.approve(s.id);
    });

    // Agent B hits /v1/health. They MUST NOT see agent A's session.
    const bBearer = agentBearer(ctx.token, "claude-bbb");
    const r = await callWithBearer(ctx, bBearer, "GET", "/v1/health");
    assert.equal(r.status, 200);

    const active = (r.body as { active_sessions?: ActiveSession[] }).active_sessions;
    assert.ok(Array.isArray(active));
    assert.equal(active.length, 0, "agent B must not see agent A's session");
  });
});

test("GET /v1/health active_sessions excludes pending sessions (only granted+unexpired surface)", async () => {
  await withDaemon(async (ctx) => {
    // Mint a session but DON'T approve it: it stays pending.
    withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
      ctx.services.sessionStore.create({
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 60_000,
      });
    });

    const bearer = agentBearer(ctx.token, "claude-abc");
    const r = await callWithBearer(ctx, bearer, "GET", "/v1/health");
    assert.equal(r.status, 200);

    const active = (r.body as { active_sessions?: ActiveSession[] }).active_sessions;
    assert.ok(Array.isArray(active));
    assert.equal(active.length, 0, "pending sessions must not be surfaced");
  });
});

test("GET /v1/health: root caller sees no active_sessions (root never owns sessions)", async () => {
  await withDaemon(async (ctx) => {
    // Agent A creates+approves a session. The root caller should still see
    // an empty list — root is never the owner of an agent-minted session.
    withAuthContext({ agent_id: "claude-aaa", isRoot: false }, () => {
      const s = ctx.services.sessionStore.create({
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
        ttl_ms: 60_000,
      });
      ctx.services.sessionStore.approve(s.id);
    });

    // ctx.token is the ROOT bearer.
    const r = await callWithBearer(ctx, ctx.token, "GET", "/v1/health");
    assert.equal(r.status, 200);

    const active = (r.body as { active_sessions?: ActiveSession[] }).active_sessions;
    assert.ok(Array.isArray(active));
    assert.equal(active.length, 0, "root caller must not own any agent sessions");
  });
});

// ── formatDoctorText (text-mode CLI rendering) ──────────────────────────────

function baseHealth(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    unlocked: true,
    browser_started: false,
    proxy_active: false,
    blind_mode: null,
    vault: { envelope_present: true, legacy_key_present: false },
    policy_warnings: [],
    agentic_browser: {
      available: false,
      browser_started: false,
      proxy_active: false,
      handles_supported: true,
      marks_active: 0,
    },
    ...extra,
  };
}

test("formatDoctorText renders 'active sessions:' section when health.active_sessions is non-empty", () => {
  const report: DoctorReport = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: baseHealth({
      active_sessions: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          pattern_summary: "template-run on ss://stripe/prod/STRIPE_KEY via vercel-env-add (name=STRIPE_KEY, environment=production)",
          expires_at: new Date(Date.now() + 12 * 60_000).toISOString(),
          minutes_remaining: 12,
        },
      ],
    }),
  };
  const text = formatDoctorText(report);
  assert.match(text, /active sessions:/);
  assert.match(text, /vercel-env-add/);
  assert.match(text, /name=STRIPE_KEY/);
  assert.match(text, /expires in 12 min/);
});

test("formatDoctorText omits 'active sessions:' section when array is empty", () => {
  const report: DoctorReport = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: baseHealth({ active_sessions: [] }),
  };
  const text = formatDoctorText(report);
  assert.doesNotMatch(text, /active sessions:/);
});

test("formatDoctorText omits 'active sessions:' section when field is absent (older daemon)", () => {
  const report: DoctorReport = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    // No active_sessions field at all — defensive: an older daemon predates
    // this field. The CLI must still render cleanly.
    health: baseHealth({}),
  };
  const text = formatDoctorText(report);
  assert.doesNotMatch(text, /active sessions:/);
});
