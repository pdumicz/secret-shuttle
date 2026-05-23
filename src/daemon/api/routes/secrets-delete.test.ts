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
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-delete-"));
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

test("POST /v1/secrets/delete soft-deletes a development ref and reports the timestamp", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a development secret (no approval required).
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "FOO",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });

    const r = await call(ctx, "POST", "/v1/secrets/delete", { ref: "ss://local/dev/FOO" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { deleted: boolean }).deleted, true);
    assert.equal((r.body as { ref: string }).ref, "ss://local/dev/FOO");
    const deletedAt = (r.body as { deleted_at: string }).deleted_at;
    assert.ok(typeof deletedAt === "string" && deletedAt.length > 0, "deleted_at should be a non-empty ISO string");

    // After delete, getSecret should report secret_not_found from the daemon side.
    const followUp = await call(ctx, "POST", "/v1/secrets/inspect", { ref: "ss://local/dev/FOO" });
    assert.equal(followUp.status, 400);
    assert.equal((followUp.body as { error: { code: string } }).error.code, "secret_not_found");
  });
});

test("POST /v1/secrets/delete returns secret_not_found if ref does not exist", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/delete", { ref: "ss://nope/dev/MISSING" });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "secret_not_found");
  });
});

test("POST /v1/secrets/delete production refs require approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret via a pre-issued generate approval.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PROD_DEL",
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
      name: "PROD_DEL",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200);

    // Now attempt to delete without an approval — expect approval_required.
    const r = await call(ctx, "POST", "/v1/secrets/delete", {
      ref: "ss://local/prod/PROD_DEL",
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("POST /v1/secrets/delete: session pass-through — audit lacks session_id; uses stays at 0", async () => {
  // secrets_delete is NOT a SessionAction (destructive ops are always human-
  // gated). The route still accepts session_id in the body for CLI uniformity,
  // threads it to requireApproval. The matcher canonicalizes secrets_delete
  // to null and refuses; requireApproval falls back to the single-use flow.
  // With wait_for_approval:false we surface approval_required. The audit
  // entry MUST NOT carry session_id, and the session use-counter MUST stay at 0.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Seed a production secret via a pre-issued generate approval.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PASSTHROUGH",
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
      name: "PASSTHROUGH",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });
    assert.equal(gen.status, 200);

    // Broadest legal pattern still won't match the secrets_delete binding —
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

    const r = await call(ctx, "POST", "/v1/secrets/delete", {
      ref: "ss://local/prod/PASSTHROUGH",
      session_id: sg.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");

    // Audit assertion: no session_id field present in the secrets_delete entry.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const entry = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .reverse()
      .find((e) => e.action === "secrets_delete");
    assert.ok(entry, "expected a secrets_delete audit entry");
    assert.equal(
      (entry as { session_id?: string }).session_id,
      undefined,
      "pass-through: audit must NOT carry session_id (matcher refused → single-use fallback)",
    );

    // Session was NOT minted — uses stays at 0.
    assert.equal(ctx.services.sessionStore.get(sg.id)!.uses, 0);
  });
});

test("POST /v1/secrets/delete production refs succeed when a matching approval is supplied", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret first.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/PROD_DEL2",
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
      name: "PROD_DEL2",
      environment: "production",
      source: "local",
      allowed_domains: ["example.com"],
      approval_id: genGrant.id,
      wait_for_approval: false,
    });

    // Pre-issue an approval matching the secrets_delete binding.
    const delGrant = ctx.services.approvals.create({
      action: "secrets_delete",
      ref: "ss://local/prod/PROD_DEL2",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
    });
    ctx.services.approvals.approve(delGrant.id);

    const r = await call(ctx, "POST", "/v1/secrets/delete", {
      ref: "ss://local/prod/PROD_DEL2",
      approval_id: delGrant.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { deleted: boolean }).deleted, true);
  });
});

test("/v1/secrets/list with include_deleted: true returns metadata only and tags deleted entries", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed two development secrets, then delete one.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "ACTIVE",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "DEL",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });
    await call(ctx, "POST", "/v1/secrets/delete", { ref: "ss://local/dev/DEL" });

    const r = await call(ctx, "POST", "/v1/secrets/list", { include_deleted: true });
    assert.equal(r.status, 200);
    const body = r.body as {
      secrets: Array<{ ref: string; value?: string; deleted_at?: string }>;
      value_visible_to_agent: boolean;
    };
    assert.equal(body.value_visible_to_agent, false, "list endpoint contract: value is never visible to agents");
    assert.ok(body.secrets.length >= 2, "should include both active and deleted entries");

    // No raw value field, ever, regardless of include_deleted.
    for (const item of body.secrets) {
      assert.equal(
        item.value,
        undefined,
        "the list endpoint must never serialize value, even with include_deleted",
      );
    }

    // Deleted entries must be distinguishable from active ones via deleted_at.
    const deleted = body.secrets.filter((s) => s.deleted_at !== undefined);
    const active = body.secrets.filter((s) => s.deleted_at === undefined);
    assert.ok(deleted.length >= 1, "at least one entry must carry deleted_at");
    assert.ok(active.length >= 1, "at least one entry must NOT carry deleted_at");
    assert.ok(
      deleted.some((s) => s.ref === "ss://local/dev/DEL"),
      "the deleted ref should appear in include_deleted output",
    );
  });
});

test("/v1/secrets/list without include_deleted omits deleted entries entirely", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "ACTIVE",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "DEL",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });
    await call(ctx, "POST", "/v1/secrets/delete", { ref: "ss://local/dev/DEL" });

    const r = await call(ctx, "POST", "/v1/secrets/list", {});
    assert.equal(r.status, 200);
    const body = r.body as { secrets: Array<{ ref: string; deleted_at?: string }> };
    for (const item of body.secrets) {
      assert.equal(item.deleted_at, undefined, "default list must not include any entry with deleted_at set");
    }
    assert.ok(
      !body.secrets.some((s) => s.ref === "ss://local/dev/DEL"),
      "deleted ref must NOT appear without include_deleted",
    );
  });
});
