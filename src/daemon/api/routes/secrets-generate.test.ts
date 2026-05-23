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
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-secrets-gen-"));
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
  session_id?: string;
  error_code?: string;
  [k: string]: unknown;
}

/** Read every line of audit.jsonl under SECRET_SHUTTLE_HOME and parse as JSON. */
async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(path.join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

test("POST /v1/secrets/generate: matching secrets-set session → audit carries session_id; uses incremented", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Mint and approve a secrets-set session. allowed_actions REQUIRED non-empty per matcher contract.
    const sg = ctx.services.sessionStore.create({
      actions: ["secrets-set"],
      ref_glob: "ss://local/prod/*",
      destination_domains: ["vercel.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "FOO",
      environment: "production",
      source: "local",
      allowed_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin"], // subset of pattern's allowed_actions
      session_id: sg.id,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const lines = await readAuditLines(ctx.home);
    const gen = [...lines].reverse().find((l) => l.action === "generate");
    assert.ok(gen, "expected at least one generate audit line");
    assert.equal(gen!.ok, true, "success audit must carry ok:true");
    assert.equal(
      gen!.session_id,
      sg.id,
      "success audit must carry session_id of the consumed session",
    );
    const session = ctx.services.sessionStore.get(sg.id)!;
    assert.equal(session.uses, 1, "session.uses should be incremented to 1");
  });
});

test("POST /v1/secrets/generate: failure AFTER mint (secret_exists) records session_id; uses still incremented", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // First, seed an existing production secret (uses a pre-issued single-use approval).
    const seedGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://local/prod/BAR",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin"],
    });
    ctx.services.approvals.approve(seedGrant.id);
    const seed = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "BAR",
      environment: "production",
      source: "local",
      allowed_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin"],
      approval_id: seedGrant.id,
      wait_for_approval: false,
    });
    assert.equal(seed.status, 200, "seed precondition: /v1/secrets/generate failed");
    // Now mint+approve a secrets-set session.
    const sg = ctx.services.sessionStore.create({
      actions: ["secrets-set"],
      ref_glob: "ss://local/prod/*",
      destination_domains: ["vercel.com"],
      allowed_actions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin", "inject_submit"],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);
    // Attempt to overwrite without force — secret_exists throws after mint.
    const r = await call(ctx, "POST", "/v1/secrets/generate", {
      name: "BAR",
      environment: "production",
      source: "local",
      allowed_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin"],
      session_id: sg.id,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "secret_exists");
    const lines = await readAuditLines(ctx.home);
    const gen = [...lines].reverse().find((l) => l.action === "generate" && l.ok === false);
    assert.ok(gen, "expected at least one failure generate audit line");
    assert.equal(
      gen!.session_id,
      sg.id,
      "post-mint failure audit MUST still carry session_id (the session was charged a use)",
    );
    assert.equal(
      gen!.error_code,
      "secret_exists",
      "failure audit must carry the underlying error_code",
    );
    const session = ctx.services.sessionStore.get(sg.id)!;
    assert.equal(
      session.uses,
      1,
      "session.uses must still be 1: session was minted before the post-mint throw",
    );
  });
});
