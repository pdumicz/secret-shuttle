import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { registry } from "./templates.js";
import { DEFAULT_ACTIONS } from "../../../vault/vault.js";
import type { TemplateDefinition } from "../../templates/registry.js";

/**
 * Stub template that resolves on every Node test machine: binary is
 * process.execPath (node), args run `process.stdin … process.exit(0)` so the
 * template completes with exit_code 0 regardless of the secret passed on
 * stdin. The success-path test below uses this to drive a real run of
 * /v1/templates/run through to ok:true so we can verify the audit carries
 * session_id and the SessionStore use counter advances.
 *
 * Lives in the module-scoped registry (shared with templates.ts at module
 * load); we register it on first import here and clean up after each test
 * via UNREG below.
 */
const STUB_OK_ID = "test-session-stub-ok";
const STUB_OK: TemplateDefinition = {
  id: STUB_OK_ID,
  description: "test stub (success path)",
  binary: process.execPath,
  args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
  secret_delivery: "stdin",
  required_params: [],
  requires_approval_when_production: false,
};

const UNREG = (): void => {
  registry.unregister(STUB_OK_ID);
};

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-templates-"));
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

interface AuditLine {
  action: string;
  ok?: boolean;
  ref?: string;
  environment?: string;
  template_id?: string;
  session_id?: string;
  error_code?: string;
  [k: string]: unknown;
}

/** Read every line of audit.jsonl under SECRET_SHUTTLE_HOME and parse as
 *  JSON. Used to assert which audit records the route wrote on a given
 *  request. */
async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(path.join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

/** Seed a production secret named `name` via a pre-issued generate approval. */
async function seedProdSecret(
  ctx: { port: number; token: string; services: DaemonServices },
  name: string,
): Promise<void> {
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
  const gen = await call(ctx, "POST", "/v1/secrets/generate", {
    name,
    environment: "production",
    source: "local",
    allowed_domains: ["vercel.com"],
    allowed_actions: [...DEFAULT_ACTIONS],
    approval_id: genGrant.id,
    wait_for_approval: false,
  });
  assert.equal(gen.status, 200, "seedProdSecret precondition: /v1/secrets/generate failed");
}

test("POST /v1/templates/run: matching session mints grant → audit carries session_id; sessionStore.uses incremented", async () => {
  registry.register(STUB_OK);
  try {
    await withDaemon(async (ctx) => {
      await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
      await seedProdSecret(ctx, "TPL_SESS_OK");

      // Mint and approve a template-run session that covers our stub template.
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
        ref: "ss://local/prod/TPL_SESS_OK",
        params: {},
        session_id: sg.id,
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert.equal((r.body as { executed: boolean }).executed, true);

      // Audit: the most-recent template_run line carries session_id with ok:true.
      const lines = await readAuditLines(ctx.home);
      const tplLine = [...lines].reverse().find((l) => l.action === "template_run");
      assert.ok(tplLine, "expected at least one template_run audit line");
      assert.equal(tplLine!.ok, true, "success audit must carry ok:true");
      assert.equal(
        tplLine!.session_id,
        sg.id,
        "success audit must carry session_id of the consumed session",
      );

      // Session usage counter advanced exactly once.
      const session = ctx.services.sessionStore.get(sg.id)!;
      assert.equal(session.uses, 1, "session.uses should be incremented to 1");
    });
  } finally {
    UNREG();
  }
});

test("POST /v1/templates/run: failure AFTER session mint still records session_id; uses still incremented", async () => {
  // For this test we exploit the resolveErr path with the real built-in
  // vercel-env-add template. The `vercel` binary is intentionally not added
  // to the daemon's SAFE_DIRS allowlist for binary resolution, so
  // resolveBinary("vercel") throws unsafe_binary_path. The route captures
  // that throw BEFORE requireApproval (so the session IS minted and the use
  // counter IS incremented), then re-throws it AFTER, hitting the catch
  // block. This is the contract Plan 4a Task I1 requires: the failure audit
  // must carry session_id whenever the session was charged a use.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await seedProdSecret(ctx, "TPL_SESS_FAIL");

    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://local/prod/*",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);

    const r = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "vercel-env-add",
      ref: "ss://local/prod/TPL_SESS_FAIL",
      params: { name: "TPL_SESS_FAIL", environment: "production" },
      session_id: sg.id,
    });
    // Must NOT have succeeded: resolveErr (unsafe_binary_path) is re-thrown
    // after the session mint.
    assert.notEqual(
      r.status,
      200,
      `expected failure (vercel binary absent), got 200 body=${JSON.stringify(r.body)}`,
    );
    assert.equal(
      (r.body as { error: { code: string } }).error.code,
      "unsafe_binary_path",
      "post-mint failure must surface as unsafe_binary_path (resolveErr re-thrown)",
    );

    // Audit: the most-recent template_run line carries session_id with ok:false.
    const lines = await readAuditLines(ctx.home);
    const tplLine = [...lines].reverse().find((l) => l.action === "template_run");
    assert.ok(tplLine, "expected at least one template_run audit line");
    assert.equal(tplLine!.ok, false, "failure audit must carry ok:false");
    assert.equal(
      tplLine!.session_id,
      sg.id,
      "post-mint failure audit MUST still carry session_id (the session was charged a use)",
    );
    assert.equal(
      tplLine!.error_code,
      "unsafe_binary_path",
      "failure audit must carry the underlying error_code",
    );

    // Session usage counter still advanced — the mint was real.
    const session = ctx.services.sessionStore.get(sg.id)!;
    assert.equal(
      session.uses,
      1,
      "session.uses must still be 1: session was minted before the post-mint throw",
    );
  });
});
