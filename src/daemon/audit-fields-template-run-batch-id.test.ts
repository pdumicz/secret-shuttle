// src/daemon/audit-fields-template-run-batch-id.test.ts
//
// Burst 5 §4 — Task 4.3 regression: template_run audit rows must carry
// `batch_id` ONLY when emitted under a bootstrapAuthority. Standalone
// template_run rows (no authority) must NOT carry the field, so consumers
// (the new `audit` CLI verb in §4 Task 4.6) can group bootstrap-driven rows
// under their parent batch without false-positive grouping of standalone
// per-secret operations.
//
// The test calls `runTemplateCore` directly: success path with a stubbed
// template binary + a real BootstrapAuthority for an in-progress batch.
// Pattern cribbed from src/daemon/api/routes/templates.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "./server.js";
import { DaemonServices } from "./services.js";
import { registerRoutes } from "./api/router.js";
import { registry } from "./api/routes/templates.js";
import { runTemplateCore } from "./api/routes/templates.js";
import { DEFAULT_ACTIONS } from "../vault/vault.js";
import type { TemplateDefinition } from "./templates/registry.js";
import type { BootstrapAuthority } from "./bootstrap/authority.js";
import type { BatchState } from "./bootstrap/store.js";

const STUB_OK_ID = "test-batch-id-stub-ok";
const STUB_OK: TemplateDefinition = {
  id: STUB_OK_ID,
  description: "test stub (success path)",
  binary: process.execPath,
  args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
  secret_delivery: "stdin",
  required_params: [],
  requires_approval_when_production: false,
};

interface AuditLine {
  action: string;
  ok?: boolean;
  ref?: string;
  template_id?: string;
  batch_id?: string;
  session_id?: string;
  [k: string]: unknown;
}

async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(path.join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-audit-tplrun-batch-"));
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
    return await fn({ port, token: "t", services, home });
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

async function seedProdSecret(
  ctx: { port: number; token: string; services: DaemonServices },
  name: string,
): Promise<string> {
  const genGrant = ctx.services.approvals.create({
    action: "generate",
    ref: null,
    planned_ref: `ss://local/prod/${name}`,
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: ["vercel.com"],
    allowed_actions: [...DEFAULT_ACTIONS],
  });
  ctx.services.approvals.approve(genGrant.id);
  await call(ctx, "POST", "/v1/secrets/generate", {
    name,
    environment: "production",
    source: "local",
    allowed_domains: ["vercel.com"],
    allowed_actions: [...DEFAULT_ACTIONS],
    approval_id: genGrant.id,
    wait_for_approval: false,
  });
  return `ss://local/prod/${name}`;
}

test("template_run audit row UNDER bootstrapAuthority carries batch_id", async () => {
  registry.register(STUB_OK);
  try {
    await withDaemon(async (ctx) => {
      await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
      const ref = await seedProdSecret(ctx, "TPL_BATCH_OK");

      // Persist an in-progress batch so assertBootstrapAuthorityValid
      // accepts the authority we pass to runTemplateCore.
      const batchId = "b-audit-template-run-1";
      const batchState: BatchState = {
        batch_id: batchId,
        approval_id: "a",
        plan_file_path: "/tmp/plan.yml",
        plan: [],
        step_results: {},
        created_at: Date.now(),
        status: "in_progress",
        owner_agent_id: "claude-test",
      };
      await ctx.services.bootstrapStore.save(batchState);

      const authority: BootstrapAuthority = { batchId };
      const result = await runTemplateCore(
        ctx.services,
        () => ctx.port,
        { templateId: STUB_OK_ID, ref, params: {} },
        { bootstrapAuthority: authority },
      );
      assert.equal(result.executed, true, "stub template must execute to ok:true");

      const lines = await readAuditLines(ctx.home);
      const tplLine = [...lines].reverse().find((l) => l.action === "template_run");
      assert.ok(tplLine, "expected at least one template_run audit line");
      assert.equal(tplLine.ok, true);
      assert.equal(
        tplLine.batch_id,
        batchId,
        "template_run under bootstrapAuthority MUST carry parent batch_id",
      );
    });
  } finally {
    registry.unregister(STUB_OK_ID);
  }
});

test("template_run audit row from a standalone HTTP call does NOT carry batch_id", async () => {
  registry.register(STUB_OK);
  try {
    await withDaemon(async (ctx) => {
      await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
      await seedProdSecret(ctx, "TPL_BATCH_STANDALONE");

      // Session-only path: mint + approve a session so the standalone
      // requireApprovals call resolves without a fresh approval prompt.
      // No bootstrapAuthority is passed.
      const sg = ctx.services.sessionStore.create({
        actions: ["template-run"],
        ref_glob: "ss://local/prod/*",
        destination_domains: [],
        template_ids: [STUB_OK_ID],
        ttl_ms: 60_000,
      });
      ctx.services.sessionStore.approve(sg.id);

      const r = await call(ctx, "POST", "/v1/templates/run", {
        template_id: STUB_OK_ID,
        ref: "ss://local/prod/TPL_BATCH_STANDALONE",
        params: {},
        session_id: sg.id,
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);

      const lines = await readAuditLines(ctx.home);
      const tplLine = [...lines].reverse().find((l) => l.action === "template_run");
      assert.ok(tplLine, "expected at least one template_run audit line");
      assert.equal(tplLine.ok, true);
      assert.equal(
        tplLine.batch_id,
        undefined,
        "standalone template_run MUST NOT carry batch_id (would falsely group with a bootstrap)",
      );
      // session_id SHOULD still be present (Plan 4a contract).
      assert.equal(tplLine.session_id, sg.id, "standalone session-driven row still carries session_id");
    });
  } finally {
    registry.unregister(STUB_OK_ID);
  }
});
