// src/daemon/api/routes/audit-summary.test.ts
//
// Burst 5 §4 Task 4.6 — integration tests for POST /v1/audit/summary.
//
// Inlined harness mirrors src/daemon/api/routes/tokens.test.ts (32-byte root
// token so we can derive per-agent bearers via deriveHmac + formatBearer).
// We avoid a shared test-helpers module per the wider project convention.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { getShuttlePaths } from "../../../shared/config.js";

// ── shared harness ──────────────────────────────────────────────────────────

interface DaemonCtx {
  port: number;
  token: string;
  services: DaemonServices;
  home: string;
}

async function withDaemon<T>(fn: (ctx: DaemonCtx) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-audit-summary-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token — required by deriveHmac (token-derive.ts).
  const rootToken = randomBytes(32).toString("base64url");
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: rootToken, services, home });
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
    headers: {
      Authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function agentBearer(rootToken: string, agentId: string): string {
  return formatBearer(agentId, deriveHmac(rootToken, agentId));
}

// Direct-append helper — bypasses the daemon's writeDaemonAudit so we can
// deterministically place rows with specific actor_agent_id + batch_id
// values into the audit log without staging a full bootstrap run.
async function appendAuditRow(home: string, row: Record<string, unknown>): Promise<void> {
  const paths = getShuttlePaths(home);
  const enriched = { ts: new Date().toISOString(), ...row };
  await appendFile(paths.auditLogPath, `${JSON.stringify(enriched)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /v1/audit/summary: --since returns owner-scoped batches grouped by batch_id", async () => {
  // Caller "claude-alice" should see its own bootstrap_step rows grouped
  // by batch_id. Rows from "claude-bob" must NOT appear in the result.
  await withDaemon(async (ctx) => {
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-alice",
      ref: "ss://local/dev/A",
      batch_id: "alice-batch-1",
      source_kind: "random_32_bytes",
      destination_shorthands: ["vercel:production"],
      destinations_ok_count: 1,
      destinations_failed_count: 0,
    });
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-bob",
      ref: "ss://local/dev/B",
      batch_id: "bob-batch-1",
      source_kind: "random_64_bytes",
      destination_shorthands: ["vercel:production"],
      destinations_ok_count: 1,
      destinations_failed_count: 0,
    });

    const aliceBearer = agentBearer(ctx.token, "claude-alice");
    const r = await callWithBearer(ctx, aliceBearer, "POST", "/v1/audit/summary", {
      since_ms: 5 * 60 * 1000,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as {
      ok: boolean;
      summary: { batches: Array<{ id: string; source: string; steps: unknown[] }> };
    };
    assert.equal(body.ok, true);
    const ids = body.summary.batches.map((b) => b.id).sort();
    assert.deepEqual(ids, ["alice-batch-1"], `bob's batch must NOT appear: got ${JSON.stringify(ids)}`);
  });
});

test("POST /v1/audit/summary: --batch reads BootstrapStore first (source=live)", async () => {
  // Seed a live BatchState directly in the BootstrapStore — the route must
  // prefer this over the audit-log fallback. owner_agent_id matches the caller.
  await withDaemon(async (ctx) => {
    const batchId = "live-batch-xyz";
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "approval-1",
      plan_file_path: "/tmp/plan.yml",
      plan: [
        {
          secret: "FOO",
          ref: "ss://local/dev/FOO",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel",
              template_params: { env: "production", key: "FOO" },
              domain: "vercel.com",
            },
          ],
        },
      ],
      step_results: {
        FOO: {
          ok: true,
          ref: "ss://local/dev/FOO",
          destinations_pushed: [{ destination: "vercel:production", ok: true }],
        },
      },
      created_at: Date.now(),
      status: "completed",
      owner_agent_id: "claude-live",
    });

    const liveBearer = agentBearer(ctx.token, "claude-live");
    const r = await callWithBearer(ctx, liveBearer, "POST", "/v1/audit/summary", {
      batch_id: batchId,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as {
      ok: boolean;
      summary: { batches: Array<{ id: string; source: string; status: string }> };
      details?: { reconstructed_from?: string };
    };
    assert.equal(body.summary.batches.length, 1);
    assert.equal(body.summary.batches[0]?.id, batchId);
    assert.equal(body.summary.batches[0]?.source, "live");
    assert.equal(body.summary.batches[0]?.status, "completed");
    // Live path MUST NOT set the audit-fallback marker.
    assert.equal(body.details?.reconstructed_from, undefined);
  });
});

test("POST /v1/audit/summary: --batch live state emits status=ok/failed/pending discriminators", async () => {
  // P2-3 regression: mixed-state batch must surface ok / failed / pending as
  // three distinct statuses on each serialized step. Before the fix, the
  // un-attempted (pending) step came through as `ok: false`, which the CLI
  // rendered identically to a real failure ("ERR") — hiding the fact that the
  // executor never tried it. The legacy `ok` boolean is preserved for
  // back-compat (false for both failed and pending), but new readers MUST
  // branch on `status`.
  await withDaemon(async (ctx) => {
    const batchId = "mixed-state-batch";
    await ctx.services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "approval-mixed",
      plan_file_path: "/tmp/mixed.yml",
      plan: [
        {
          secret: "OK_SECRET",
          ref: "ss://local/prod/OK_SECRET",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel-env-add",
              template_params: { name: "OK_SECRET", environment: "production" },
              domain: "vercel.com",
            },
          ],
        },
        {
          secret: "FAIL_SECRET",
          ref: "ss://local/prod/FAIL_SECRET",
          source: { kind: "random_64_bytes" },
          destinations: [
            {
              shorthand: "vercel:production",
              template_id: "vercel-env-add",
              template_params: { name: "FAIL_SECRET", environment: "production" },
              domain: "vercel.com",
            },
          ],
        },
        {
          secret: "PENDING_SECRET",
          ref: "ss://local/prod/PENDING_SECRET",
          source: { kind: "random_32_bytes" },
          destinations: [
            {
              shorthand: "github-actions:prod",
              template_id: "github-actions-secret-set",
              template_params: { name: "PENDING_SECRET", environment: "production" },
              domain: "github.com",
            },
          ],
        },
      ],
      step_results: {
        // Only the first two are attempted; PENDING_SECRET has no entry → pending.
        OK_SECRET: {
          ok: true,
          ref: "ss://local/prod/OK_SECRET",
          destinations_pushed: [{ destination: "vercel:production", ok: true }],
        },
        FAIL_SECRET: {
          ok: false,
          ref: "ss://local/prod/FAIL_SECRET",
          destinations_pushed: [
            {
              destination: "vercel:production",
              ok: false,
              error_code: "template_exec_failed",
              message: "exit 1",
            },
          ],
          error_code: "destination_partial_failure",
        },
      },
      created_at: Date.now(),
      status: "failed_partial",
      owner_agent_id: "claude-mixed",
    });

    const bearer = agentBearer(ctx.token, "claude-mixed");
    const r = await callWithBearer(ctx, bearer, "POST", "/v1/audit/summary", {
      batch_id: batchId,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

    const body = r.body as {
      summary: {
        batches: Array<{
          id: string;
          source: string;
          steps: Array<{ status?: string; ok: boolean; ref?: string; error_code?: string }>;
        }>;
      };
    };
    assert.equal(body.summary.batches.length, 1, "expected exactly one batch");
    const steps = body.summary.batches[0]!.steps;
    assert.equal(steps.length, 3, `expected 3 steps (1 ok, 1 failed, 1 pending), got: ${steps.length}`);

    // Map by ref for deterministic assertions independent of plan ordering.
    const byRef = new Map(steps.map((s) => [s.ref ?? "", s]));
    const okStep = byRef.get("ss://local/prod/OK_SECRET");
    const failStep = byRef.get("ss://local/prod/FAIL_SECRET");
    const pendStep = byRef.get("ss://local/prod/PENDING_SECRET");
    assert.ok(okStep !== undefined, "OK step must be present");
    assert.ok(failStep !== undefined, "FAIL step must be present");
    assert.ok(pendStep !== undefined, "PENDING step must be present");

    // The fix: three distinct status values.
    assert.equal(okStep!.status, "ok", `OK step status must be "ok", got: ${okStep!.status}`);
    assert.equal(failStep!.status, "failed", `FAILED step status must be "failed", got: ${failStep!.status}`);
    assert.equal(pendStep!.status, "pending", `PENDING step status must be "pending" (P2-3 fix), got: ${pendStep!.status}`);

    // Legacy `ok` field still preserved for back-compat: true on ok, false on both fail and pending.
    assert.equal(okStep!.ok, true, "legacy ok must remain true for ok step");
    assert.equal(failStep!.ok, false, "legacy ok must remain false for failed step");
    assert.equal(pendStep!.ok, false, "legacy ok must remain false for pending step (back-compat)");

    // Pending steps MUST NOT carry an error_code — they haven't run.
    assert.equal(pendStep!.error_code, undefined, "pending step must not have error_code");
  });
});

test("POST /v1/audit/summary: --batch falls back to audit log when batch is pruned", async () => {
  // No live state in BootstrapStore — only audit-log rows. Response must
  // carry source=audit and details.reconstructed_from=audit so consumers can
  // detect the fallback case.
  await withDaemon(async (ctx) => {
    const batchId = "pruned-batch";
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-charlie",
      ref: "ss://local/dev/PRUNED",
      batch_id: batchId,
      source_kind: "random_32_bytes",
      destination_shorthands: ["vercel:production"],
      destinations_ok_count: 1,
      destinations_failed_count: 0,
    });

    const charlieBearer = agentBearer(ctx.token, "claude-charlie");
    const r = await callWithBearer(ctx, charlieBearer, "POST", "/v1/audit/summary", {
      batch_id: batchId,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as {
      ok: boolean;
      summary: { batches: Array<{ id: string; source: string }> };
      details?: { reconstructed_from?: string };
    };
    assert.equal(body.summary.batches.length, 1);
    assert.equal(body.summary.batches[0]?.id, batchId);
    assert.equal(body.summary.batches[0]?.source, "audit");
    assert.equal(body.details?.reconstructed_from, "audit");
  });
});

test("POST /v1/audit/summary: cross-owner --batch lookup → audit_batch_not_found (non-disclosure)", async () => {
  // Bob's batch lives in the audit log; Alice tries to query it. Must
  // return audit_batch_not_found (same code as 'truly missing') so
  // existence is not disclosed cross-owner.
  await withDaemon(async (ctx) => {
    const batchId = "bobs-private-batch";
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-bob",
      ref: "ss://local/dev/SECRET",
      batch_id: batchId,
      source_kind: "random_32_bytes",
    });

    const aliceBearer = agentBearer(ctx.token, "claude-alice");
    const r = await callWithBearer(ctx, aliceBearer, "POST", "/v1/audit/summary", {
      batch_id: batchId,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "audit_batch_not_found");
  });
});

test("POST /v1/audit/summary: non-root caller sees --all silently ignored", async () => {
  // Alice passes include_all_actors=true but is not root. She must still
  // see only her own rows — Bob's batch is filtered out.
  await withDaemon(async (ctx) => {
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-alice",
      ref: "ss://local/dev/A",
      batch_id: "alice-batch-2",
      source_kind: "random_32_bytes",
    });
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-bob",
      ref: "ss://local/dev/B",
      batch_id: "bob-batch-2",
      source_kind: "random_32_bytes",
    });

    const aliceBearer = agentBearer(ctx.token, "claude-alice");
    const r = await callWithBearer(ctx, aliceBearer, "POST", "/v1/audit/summary", {
      since_ms: 5 * 60 * 1000,
      include_all_actors: true, // <-- non-root, silently ignored
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { summary: { batches: Array<{ id: string }> } };
    const ids = body.summary.batches.map((b) => b.id).sort();
    assert.deepEqual(
      ids,
      ["alice-batch-2"],
      `non-root --all must NOT include other agents' batches: got ${JSON.stringify(ids)}`,
    );
  });
});

test("POST /v1/audit/summary: root --all returns rows for ALL agents", async () => {
  // Root passes include_all_actors=true. Both Alice's and Bob's batches
  // must appear in the response.
  await withDaemon(async (ctx) => {
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-alice",
      ref: "ss://local/dev/A",
      batch_id: "alice-batch-3",
      source_kind: "random_32_bytes",
    });
    await appendAuditRow(ctx.home, {
      action: "bootstrap_step",
      ok: true,
      actor_agent_id: "claude-bob",
      ref: "ss://local/dev/B",
      batch_id: "bob-batch-3",
      source_kind: "random_32_bytes",
    });

    // Root bearer is the raw root token (no agent suffix).
    const r = await callWithBearer(ctx, ctx.token, "POST", "/v1/audit/summary", {
      since_ms: 5 * 60 * 1000,
      include_all_actors: true,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { summary: { batches: Array<{ id: string }> } };
    const ids = body.summary.batches.map((b) => b.id).sort();
    assert.deepEqual(
      ids,
      ["alice-batch-3", "bob-batch-3"],
      `root --all must include all agents' batches: got ${JSON.stringify(ids)}`,
    );
  });
});

test("POST /v1/audit/summary: standalone (no-batch) rows surface as individual_ops, system actions filtered", async () => {
  // unlock + inject rows belong in individual_ops; tokens_mint must NOT
  // appear (system plumbing is filtered from the user-facing view).
  await withDaemon(async (ctx) => {
    await appendAuditRow(ctx.home, {
      action: "unlock",
      ok: true,
      actor_agent_id: "claude-dora",
    });
    await appendAuditRow(ctx.home, {
      action: "inject",
      ok: false,
      actor_agent_id: "claude-dora",
      ref: "ss://local/dev/X",
      error_code: "destination_partial_failure",
    });
    await appendAuditRow(ctx.home, {
      action: "tokens_mint",
      ok: true,
      actor_agent_id: "claude-dora",
    });

    const doraBearer = agentBearer(ctx.token, "claude-dora");
    const r = await callWithBearer(ctx, doraBearer, "POST", "/v1/audit/summary", {
      since_ms: 5 * 60 * 1000,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as {
      summary: { individual_ops: Array<{ action: string }> };
    };
    const actions = body.summary.individual_ops.map((o) => o.action).sort();
    assert.deepEqual(
      actions,
      ["inject", "unlock"],
      `tokens_mint must be filtered out: got ${JSON.stringify(actions)}`,
    );
  });
});

test("POST /v1/audit/summary: invalid --batch on non-existent id → audit_batch_not_found", async () => {
  await withDaemon(async (ctx) => {
    const charlieBearer = agentBearer(ctx.token, "claude-charlie");
    const r = await callWithBearer(ctx, charlieBearer, "POST", "/v1/audit/summary", {
      batch_id: "does-not-exist",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(error.code, "audit_batch_not_found");
  });
});
