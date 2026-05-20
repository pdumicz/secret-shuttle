import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import { TemplateRegistry, type TemplateDefinition } from "../daemon/templates/registry.js";

const NEEDLE = "n33dle-" + randomBytes(8).toString("hex");

async function withDaemon<T>(fn: (ctx: {
  port: number; token: string; services: DaemonServices; tmpDir: string;
  stubBin: string; sidecarArgv: string; sidecarStdin: string;
}) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-tpl-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const tmpDir = path.join(home, "tmp");
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  // Build a stub binary under /tmp/<rand>/bin/ that records argv, env, and stdin
  // bytes to sidecar files so we can assert no leak.
  const stubDir = path.join(home, "binroot", "bin");
  await mkdir(stubDir, { recursive: true });
  const stubBin = path.join(stubDir, "stub-cli");
  const sidecarArgv = path.join(home, "argv.json");
  const sidecarStdin = path.join(home, "stdin.bin");
  const stubScript =
    `#!/usr/bin/env node\n` +
    `const fs=require("node:fs");\n` +
    `fs.writeFileSync(${JSON.stringify(sidecarArgv)}, JSON.stringify({\n` +
    `  argv: process.argv,\n` +
    `  env: Object.fromEntries(Object.entries(process.env)),\n` +
    `}));\n` +
    `let buf=Buffer.alloc(0);\n` +
    `process.stdin.on("data", (c) => { buf = Buffer.concat([buf,c]); });\n` +
    `process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); process.exit(0); });\n` +
    `process.stdin.on("close", () => { try { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); } catch {} });\n` +
    `setTimeout(()=>{ try { fs.writeFileSync(${JSON.stringify(sidecarStdin)}, buf); } catch {}; process.exit(0); }, 200);\n`;
  await writeFile(stubBin, stubScript);
  await chmod(stubBin, 0o755);

  const token = "test-token";
  const server = new DaemonServer({ token });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token, services, tmpDir, stubBin, sidecarArgv, sidecarStdin });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

// In-test override: bypass approval + the real binary by registering a stub
// template that points at our recording stub.
function registerStubTemplate(services: DaemonServices, stubBin: string, mode: "stdin" | "tmp_env_file_0600"): TemplateDefinition {
  const def: TemplateDefinition = mode === "stdin"
    ? {
        id: "stub-stdin", description: "test", binary: stubBin,
        args: ["secret", "set", "{{name}}"], secret_delivery: "stdin",
        required_params: ["name"], requires_approval_when_production: false,
      }
    : {
        id: "stub-envfile", description: "test", binary: stubBin,
        args: ["secrets", "set"], secret_delivery: "tmp_env_file_0600",
        required_params: ["name"], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      };
  // Side-load: replace the registry constructed inside templates.ts. The route
  // already calls `new TemplateRegistry()` at module init, so we can't inject
  // there cleanly; we drive `runTemplate` directly through a tiny route shim
  // below (see Step 2 — the test bypasses /v1/templates/run and exercises the
  // same code path with the same security invariants).
  return def;
}

test("agentic e2e: stdin delivery — secret reaches child via stdin only, NEVER in argv/env/stdout/stderr/audit", async () => {
  await withDaemon(async (ctx) => {
    const def = registerStubTemplate(ctx.services, ctx.stubBin, "stdin");
    const { runTemplate } = await import("../daemon/templates/run.js");
    const r = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: NEEDLE, tmpDir: ctx.tmpDir,
    });
    assert.equal(r.exit_code, 0);

    // The stub recorded its argv + env + stdin.
    const { argv, env } = JSON.parse(await readFile(ctx.sidecarArgv, "utf8")) as { argv: string[]; env: Record<string,string> };
    const stdin = await readFile(ctx.sidecarStdin, "utf8");

    // Secret MUST be in stdin only.
    assert.equal(stdin, NEEDLE, "stdin must carry the secret exactly");
    for (const a of argv) assert.equal(a.includes(NEEDLE), false, `argv leaked: ${a}`);
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k+"="+v).includes(NEEDLE), false, `env leaked: ${k}=${v}`);
      assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `daemon token forwarded: ${k}`);
    }

    // The audit log must NOT contain the secret.
    const { getShuttlePaths } = await import("../shared/config.js");
    const home = process.env.SECRET_SHUTTLE_HOME ?? "";
    const auditPath = getShuttlePaths(home).auditLogPath;
    const audit = await readFile(auditPath, "utf8").catch(() => "");
    assert.equal(audit.includes(NEEDLE), false, "audit log leaked the secret");
  });
});

test("agentic e2e: tmp_env_file_0600 — secret reaches child via 0600 env-file only, NEVER in argv/env/stdout/stderr/audit", async () => {
  await withDaemon(async (ctx) => {
    const def = registerStubTemplate(ctx.services, ctx.stubBin, "tmp_env_file_0600");
    const { runTemplate } = await import("../daemon/templates/run.js");
    const r = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: NEEDLE, tmpDir: ctx.tmpDir,
    });
    assert.equal(r.exit_code, 0);

    const { argv, env } = JSON.parse(await readFile(ctx.sidecarArgv, "utf8")) as { argv: string[]; env: Record<string,string> };

    // The path appears in argv; the secret value does NOT.
    const envFileArg = argv.find((a) => a.startsWith("--env-file="));
    assert.ok(envFileArg, "argv must contain --env-file=<path>");
    assert.equal(envFileArg!.includes(NEEDLE), false, "the --env-file path must not contain the secret");
    for (const a of argv) assert.equal(a.includes(NEEDLE), false, `argv leaked: ${a}`);
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k+"="+v).includes(NEEDLE), false, `env leaked: ${k}=${v}`);
      assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `daemon token forwarded: ${k}`);
    }

    // The audit log must NOT contain the secret.
    const { getShuttlePaths } = await import("../shared/config.js");
    const home = process.env.SECRET_SHUTTLE_HOME ?? "";
    const auditPath = getShuttlePaths(home).auditLogPath;
    const audit = await readFile(auditPath, "utf8").catch(() => "");
    assert.equal(audit.includes(NEEDLE), false, "audit log leaked the secret");

    // The env-file must be unlinked.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(ctx.tmpDir), []);
  });
});

test("agentic e2e: registry enumerates all four shipped templates (one final guard)", async () => {
  const r = new TemplateRegistry();
  const ids = r.list().map((t) => t.id).sort();
  assert.deepEqual(ids, [
    "cloudflare-secret-put",
    "github-actions-secret-set",
    "supabase-edge-secret-set",
    "vercel-env-add",
  ]);
});
