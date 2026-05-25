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
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-import-"));
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
  error_code?: string;
  [k: string]: unknown;
}

async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(path.join(home, "audit.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

test("import: dev-env entries stored without approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [
        { key: "FOO", value: "foo-val" },
        { key: "BAR", value: "bar-val" },
        { key: "BAZ", value: "baz-val" },
      ],
      source: "local",
      environment: "development",
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; imported: number; refs: string[]; skipped_existing: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.imported, 3);
    assert.equal(body.refs.length, 3);
    assert.ok(body.refs.includes("ss://local/dev/FOO"), "refs must include FOO");
    assert.ok(body.refs.includes("ss://local/dev/BAR"), "refs must include BAR");
    assert.ok(body.refs.includes("ss://local/dev/BAZ"), "refs must include BAZ");
    assert.deepEqual(body.skipped_existing, []);

    // Verify each ref is stored in the vault.
    for (const ref of ["ss://local/dev/FOO", "ss://local/dev/BAR", "ss://local/dev/BAZ"]) {
      const inspect = await call(ctx, "POST", "/v1/secrets/inspect", { ref });
      assert.equal(inspect.status, 200, `expected ${ref} to exist in vault`);
    }

    // Verify audit entries were written.
    const lines = await readAuditLines(ctx.home);
    const importLines = lines.filter((l) => l.action === "import" && l.ok === true);
    assert.equal(importLines.length, 3, "expected 3 successful import audit lines");
  });
});

test("import: production-env requires approval (single batch)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Without approval → approval_required. Use wait_for_approval:false so the
    // test does not block waiting for a human to click.
    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [{ key: "PROD_KEY", value: "prod-val" }],
      source: "local",
      environment: "production",
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("import: production-env succeeds with a pre-approved single-batch approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Pre-mint and approve an "import" binding.
    const grant = ctx.services.approvals.create({
      action: "import",
      ref: null,
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: { source: "local", environment: "production", keys: "PROD_K" },
      allowed_domains: [],
    });
    ctx.services.approvals.approve(grant.id);

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [{ key: "PROD_K", value: "prod-val" }],
      source: "local",
      environment: "production",
      approval_ids: [grant.id],
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; imported: number; refs: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.imported, 1);
    assert.ok(body.refs.includes("ss://local/prod/PROD_K"));
  });
});

test("import: ref already exists → secret_exists", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Seed an existing ref.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "EXISTING",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [{ key: "EXISTING", value: "new-value" }],
      source: "local",
      environment: "development",
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "secret_exists");

    // Verify the failure was audited.
    const lines = await readAuditLines(ctx.home);
    const failLine = lines.reverse().find((l) => l.action === "import" && l.ok === false);
    assert.ok(failLine, "expected a failed import audit line");
    assert.equal(failLine!.error_code, "secret_exists");
  });
});

test("import: --skip-existing skips dupes silently", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Seed one existing ref.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "ALREADY",
      environment: "development",
      source: "local",
      allowed_domains: ["example.com"],
    });

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [
        { key: "ALREADY", value: "new-val" },
        { key: "FRESH_A", value: "val-a" },
        { key: "FRESH_B", value: "val-b" },
      ],
      source: "local",
      environment: "development",
      skip_existing: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; imported: number; skipped_existing: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.imported, 2);
    assert.deepEqual(body.skipped_existing, ["ALREADY"]);
  });
});

test("import: --force overwrites existing refs", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // Seed two existing refs.
    for (const name of ["KEY_A", "KEY_B", "KEY_C"]) {
      await call(ctx, "POST", "/v1/secrets/generate", {
        name,
        environment: "development",
        source: "local",
        allowed_domains: ["example.com"],
      });
    }

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [
        { key: "KEY_A", value: "new-a" },
        { key: "KEY_B", value: "new-b" },
        { key: "KEY_C", value: "new-c" },
      ],
      source: "local",
      environment: "development",
      force: true,
    });

    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; imported: number; refs: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.imported, 3);
    assert.equal(body.refs.length, 3);
  });
});

test("import: empty entries array → ok, imported: 0", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [],
      source: "local",
      environment: "development",
    });

    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; imported: number; refs: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.imported, 0);
    assert.deepEqual(body.refs, []);
  });
});

test("import: malformed entries (missing value) → missing_param", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    const r = await call(ctx, "POST", "/v1/secrets/import", {
      entries: [{ key: "FOO" }],  // missing value
      source: "local",
      environment: "development",
    });

    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "missing_param");
  });
});
