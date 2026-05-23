import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices; home: string }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-rotate-"));
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

test("POST /v1/secrets/rotate generates a new ref and marks the old as rotating", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "FOO",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });

    const r = await call(ctx, "POST", "/v1/secrets/rotate", { ref: "ss://local/dev/FOO" });
    assert.equal(r.status, 200);
    const body = r.body as {
      rotation_started: boolean;
      old_ref: string;
      new_ref: string;
      plan: unknown[];
      next_action: string;
    };
    assert.equal(body.rotation_started, true);
    assert.equal(body.old_ref, "ss://local/dev/FOO");
    assert.ok(typeof body.new_ref === "string" && body.new_ref.startsWith("ss://local/dev/FOO-rot-"));
    assert.deepEqual(body.plan, []);
    assert.ok(typeof body.next_action === "string" && body.next_action.length > 0);

    // The old ref should still exist, but with rotating: true on the underlying record.
    // Inspect (metadata) should not surface rotating, but getSecret (internal) should.
    const oldRec = await ctx.services.vault.getSecret("ss://local/dev/FOO");
    assert.equal(oldRec.rotating, true);

    // The new ref should exist with a value (no rotating flag).
    const newRec = await ctx.services.vault.getSecret(body.new_ref);
    assert.ok(newRec.value.length > 0);
    assert.equal(newRec.rotating, undefined);
  });
});

test("POST /v1/secrets/rotate returns secret_not_found if old ref does not exist", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/rotate", { ref: "ss://nope/dev/MISSING" });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "secret_not_found");
  });
});

test("POST /v1/secrets/rotate production refs require approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret via a pre-issued generate approval.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PROD_ROT",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
    });
    ctx.services.approvals.approve(genGrant.id);
    const gen = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PROD_ROT",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200);

    // Attempt to rotate without an approval — expect approval_required.
    const r = await call(ctx, "POST", "/v1/secrets/rotate", {
      ref: "ss://local/prod/PROD_ROT",
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("POST /v1/secrets/rotate production refs succeed when a matching approval is supplied", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret first.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PROD_ROT2",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
    });
    ctx.services.approvals.approve(genGrant.id);
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PROD_ROT2",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });

    // Pre-issue an approval matching the secrets_rotate binding.
    const rotGrant = ctx.services.approvals.create({
      action: "secrets_rotate",
      ref: "ss://local/prod/PROD_ROT2",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
    });
    ctx.services.approvals.approve(rotGrant.id);

    const r = await call(ctx, "POST", "/v1/secrets/rotate", {
      ref: "ss://local/prod/PROD_ROT2",
      approval_id: rotGrant.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { rotation_started: boolean }).rotation_started, true);
  });
});

test("POST /v1/secrets/rotate: session pass-through — audit lacks session_id; uses stays at 0", async () => {
  // secrets_rotate is NOT a SessionAction (destructive ops are always human-
  // gated). The route still accepts session_id in the body for CLI uniformity,
  // threads it to requireApproval. The matcher canonicalizes secrets_rotate
  // to null and refuses; requireApproval falls back to the single-use flow.
  // With wait_for_approval:false we surface approval_required. The audit
  // entry MUST NOT carry session_id, and the session use-counter MUST stay at 0.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Seed a production secret via a pre-issued generate approval.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PASSTHROUGH_ROT",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
    });
    ctx.services.approvals.approve(genGrant.id);
    const gen = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "PASSTHROUGH_ROT",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200);

    // Broadest legal pattern still won't match the secrets_rotate binding —
    // canonicalAction returns null. See session-matchers.ts.
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
      ref_glob: "",
      destination_domains: ["any.com"],
      template_ids: ["any"],
      allowed_actions: [
        "capture_from_page",
        "inject_into_field",
        "compare_fingerprint",
        "use_as_stdin",
        "inject_submit",
      ],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);

    const r = await call(ctx, "POST", "/v1/secrets/rotate", {
      ref: "ss://local/prod/PASSTHROUGH_ROT",
      session_id: sg.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");

    // Audit assertion: no session_id field present in the secrets_rotate entry.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const entry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .reverse()
      .find((e) => e.action === "secrets_rotate");
    assert.ok(entry, "expected a secrets_rotate audit entry");
    assert.equal(
      (entry as { session_id?: string }).session_id,
      undefined,
      "pass-through: audit must NOT carry session_id (matcher refused → single-use fallback)",
    );

    // Session was NOT minted — uses stays at 0.
    assert.equal(ctx.services.sessionStore.get(sg.id)!.uses, 0);
  });
});

test("POST /v1/secrets/rotate fails if ref is missing", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/rotate", {});
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "missing_param");
  });
});
