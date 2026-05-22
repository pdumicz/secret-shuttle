import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, symlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";

interface Ctx {
  port: number;
  token: string;
  services: DaemonServices;
  home: string;
}

async function withDaemon<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-inject-"));
  const prevShuttle = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  // Override the system HOME so os.homedir() returns our tempdir. The route's
  // realHome check is meaningful only if HOME matches the tempdir we're writing
  // into — otherwise every file write is "outside HOME" and is rejected.
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, home });
  } finally {
    await server.close();
    if (prevShuttle === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevShuttle;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (process.platform === "win32") {
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: Pick<Ctx, "port" | "token">,
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

async function seedSecret(
  services: DaemonServices,
  opts: {
    source: string;
    environment: string;
    name: string;
    value: string;
    allowedActions?: string[];
  },
): Promise<string> {
  const result = await services.vault.upsertSecret({
    source: opts.source,
    environment: opts.environment,
    name: opts.name,
    value: opts.value,
    allowedDomains: [],
    ...(opts.allowedActions !== undefined ? { allowedActions: opts.allowedActions as never } : {}),
  });
  return result.ref;
}

// -----------------------------------------------------------------------------
// Happy path + atomicity
// -----------------------------------------------------------------------------

test("POST /v1/inject/render: writes file at mode 0600 inside $HOME (atomic temp-file + rename)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "KEY", value: "value",
    });
    const outputDir = path.join(ctx.home, ".secret-shuttle-tests");
    const outputPath = path.join(outputDir, "out.yml");
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: outputPath,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { rendered: boolean }).rendered, true);
    assert.equal((r.body as { refs_count: number }).refs_count, 1);
    // File content matches.
    const content = await readFile(outputPath, "utf8");
    assert.equal(content, "key: value");
    // Mode 0o600.
    const st = await stat(outputPath);
    assert.equal(st.mode & 0o777, 0o600);
    // No leftover temp file alongside.
    const siblings = await readdir(outputDir);
    assert.equal(siblings.filter((n) => n.endsWith(".tmp")).length, 0);
  });
});

test("POST /v1/inject/render: existing output file is overwritten atomically", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "NEW",
    });
    const outputPath = path.join(ctx.home, "config.yml");
    await writeFile(outputPath, "OLD", { mode: 0o600 });
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `v: ${ref}`,
      output_path: outputPath,
    });
    assert.equal(r.status, 200);
    const content = await readFile(outputPath, "utf8");
    assert.equal(content, "v: NEW");
  });
});

// -----------------------------------------------------------------------------
// Stdout passthrough
// -----------------------------------------------------------------------------

test("POST /v1/inject/render with output_path='-' returns rendered content in response body", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: "-",
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { rendered: boolean }).rendered, true);
    assert.equal((r.body as { refs_count: number }).refs_count, 1);
    assert.equal((r.body as { content: string }).content, "key: v");
  });
});

// -----------------------------------------------------------------------------
// Path-safety negatives
// -----------------------------------------------------------------------------

test("POST /v1/inject/render: refuses output_path outside $HOME → inject_output_path_unsafe", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    // /tmp is reliably outside the synthetic $HOME tempdir.
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: "/tmp/escape-out.yml",
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "inject_output_path_unsafe");
  });
});

test("POST /v1/inject/render: refuses relative output_path → inject_output_path_unsafe", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: "./out.yml",
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "inject_output_path_unsafe");
  });
});

test("POST /v1/inject/render: refuses leaf-symlink output_path → inject_output_path_unsafe", async () => {
  if (process.platform === "win32") return; // symlink semantics differ on Windows
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    const outside = await mkdtemp(path.join(os.tmpdir(), "ss-inject-target-"));
    const outsideFile = path.join(outside, "evil-target");
    await writeFile(outsideFile, "ORIGINAL", { mode: 0o600 });
    const leafSymlink = path.join(ctx.home, "leaf-symlink");
    await symlink(outsideFile, leafSymlink);
    try {
      const r = await call(ctx, "POST", "/v1/inject/render", {
        template: `key: ${ref}`,
        output_path: leafSymlink,
      });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error_code: string }).error_code, "inject_output_path_unsafe");
      // The symlink target was untouched.
      assert.equal(await readFile(outsideFile, "utf8"), "ORIGINAL");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("POST /v1/inject/render: refuses parent-with-symlink-outside-HOME via realpath", async () => {
  if (process.platform === "win32") return;
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    // $HOME/escape -> /tmp/outside (a REAL existing dir)
    const outside = await mkdtemp(path.join(os.tmpdir(), "ss-inject-out-"));
    const escape = path.join(ctx.home, "escape");
    await symlink(outside, escape);
    try {
      const r = await call(ctx, "POST", "/v1/inject/render", {
        template: `key: ${ref}`,
        output_path: path.join(escape, "out.yml"),
      });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error_code: string }).error_code, "inject_output_path_unsafe");
      assert.equal((await readdir(outside)).length, 0, "no files should have been written outside HOME");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("POST /v1/inject/render: refuses symlinked ANCESTOR (no directory created outside HOME)", async () => {
  // Regression for the "mkdir before realpath" bug. The fixed implementation
  // walks ancestors with lstat first and refuses without creating anything.
  if (process.platform === "win32") return;
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "K", value: "v",
    });
    const outside = await mkdtemp(path.join(os.tmpdir(), "ss-inject-side-"));
    const escape = path.join(ctx.home, "escape");
    await symlink(outside, escape);
    try {
      const r = await call(ctx, "POST", "/v1/inject/render", {
        template: `key: ${ref}`,
        output_path: path.join(escape, "deep", "nested", "out.yml"),
      });
      assert.equal(r.status, 400);
      assert.equal((r.body as { error_code: string }).error_code, "inject_output_path_unsafe");
      // The naive impl would have created /tmp/outside/deep/nested/ before failing.
      assert.equal((await readdir(outside)).length, 0, "naive mkdir leaked dirs outside HOME");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Approval + policy + audit
// -----------------------------------------------------------------------------

test("POST /v1/inject/render: production refs require approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "production", name: "K", value: "v",
    });
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: path.join(ctx.home, "out.yml"),
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "approval_required");
  });
});

test("POST /v1/inject/render: deleted ref → secret_not_found", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "DEL", value: "v",
    });
    await ctx.services.vault.softDelete(ref);
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: path.join(ctx.home, "out.yml"),
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "secret_not_found");
  });
});

test("POST /v1/inject/render: use_as_stdin removed → action_not_allowed (no file written)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "NS", value: "v",
      allowedActions: ["inject_into_field"], // excludes use_as_stdin
    });
    const outputPath = path.join(ctx.home, "should-not-exist.yml");
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `key: ${ref}`,
      output_path: outputPath,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "action_not_allowed");
    // Confirm file was NOT created.
    let existed = false;
    try {
      await stat(outputPath);
      existed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    assert.equal(existed, false, "policy failure must not leave a file on disk");
  });
});

test("POST /v1/inject/render: markUsed is called on each resolved ref", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "MU", value: "v",
    });
    const before = (await ctx.services.vault.inspect(ref)).last_used_at;
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `k: ${ref}`,
      output_path: path.join(ctx.home, "mu.yml"),
    });
    assert.equal(r.status, 200);
    const after = (await ctx.services.vault.inspect(ref)).last_used_at;
    assert.notEqual(after, before);
    assert.ok(after !== null);
  });
});

test("POST /v1/inject/render: audit log gains a per-ref entry per render", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const refA = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "A", value: "a",
    });
    const refB = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "B", value: "b",
    });
    await call(ctx, "POST", "/v1/inject/render", {
      template: `a: ${refA}\nb: ${refB}\n`,
      output_path: path.join(ctx.home, "audit-test.yml"),
    });
    // Audit file is named `audit.jsonl` (see src/shared/config.ts:31). The
    // canonical helper is getShuttlePaths(home).auditLogPath; we inline the
    // join here to keep the test independent of shared/config imports.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const renderEntries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "inject_render");
    assert.equal(renderEntries.length, 2, "one audit entry per resolved ref");
    const refsAudited = new Set(renderEntries.map((e) => e.ref));
    assert.ok(refsAudited.has(refA));
    assert.ok(refsAudited.has(refB));
    for (const e of renderEntries) {
      assert.equal(e.ok, true);
      assert.equal(e.value_visible_to_agent, false, "file-mode must not mark value_visible_to_agent true");
    }
  });
});

test("POST /v1/inject/render with output_path='-' marks the audit entry value_visible_to_agent: true", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "VIS", value: "visible",
    });
    const r = await call(ctx, "POST", "/v1/inject/render", {
      template: `val: ${ref}`,
      output_path: "-",
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { content: string }).content, "val: visible");
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const renderEntries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "inject_render");
    assert.ok(renderEntries.length >= 1, "expected at least one inject_render audit entry");
    for (const e of renderEntries) {
      assert.equal(e.value_visible_to_agent, true, "stdout passthrough must mark value_visible_to_agent true");
    }
  });
});
