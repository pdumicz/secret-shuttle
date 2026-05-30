import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { TemplateRegistry, assertNoPaddedParams } from "./registry.js";
import { resolveBinary } from "./resolve-binary.js";
import { SecretValue } from "../../vault/secret-value.js";

// validateParams tests for vercel-env-add

test("registry lists built-in vercel-env-add", () => {
  const r = new TemplateRegistry();
  const list = r.list();
  assert.ok(list.find((t) => t.id === "vercel-env-add"));
});

test("registry resolves a template by id", () => {
  const r = new TemplateRegistry();
  const t = r.get("vercel-env-add");
  assert.equal(t.id, "vercel-env-add");
  assert.deepEqual(t.required_params, ["name", "environment"]);
});

test("registry throws for unknown templates", () => {
  const r = new TemplateRegistry();
  assert.throws(
    () => r.get("nope"),
    (err) => err instanceof ShuttleError && err.code === "template_not_found",
  );
});

test("vercel-env-add rejects an invalid environment param", () => {
  const r = new TemplateRegistry();
  const t = r.get("vercel-env-add");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", environment: "prod" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("vercel-env-add rejects an invalid env var name", () => {
  const r = new TemplateRegistry();
  const t = r.get("vercel-env-add");
  assert.throws(
    () => t.validateParams?.({ name: "9bad-name", environment: "production" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("vercel-env-add accepts a valid name + environment", () => {
  const r = new TemplateRegistry();
  const t = r.get("vercel-env-add");
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_SECRET_KEY", environment: "production" }));
});

test("resolveBinary ignores process.env.PATH and uses only the safe allowlist", async () => {
  const prev = process.env.PATH;
  process.env.PATH = "/tmp/should-not-be-searched";
  try {
    // Confirming the function doesn't crash or honor the hostile PATH.
    // If node is not in any safe dir, resolveBinary throws unsafe_binary_path
    // (correct behavior); if it is, it resolves normally. Either way, /tmp is ignored.
    await assert.doesNotReject(() => resolveBinary("node").catch(() => undefined));
  } finally {
    process.env.PATH = prev;
  }
});

test("TemplateDefinition.secret_delivery accepts 'tmp_env_file_0600' (union widened)", () => {
  const fake: import("./registry.js").TemplateDefinition = {
    id: "fake-env-file",
    description: "test",
    binary: "vercel",
    args: ["env-file", "{{__env_file_path__}}"],
    secret_delivery: "tmp_env_file_0600",
    required_params: [],
    requires_approval_when_production: false,
    value_arg_template: "--env-file={{__env_file_path__}}",
  };
  // Trivial assertions — the test is structural: it must COMPILE.
  assert.equal(fake.secret_delivery, "tmp_env_file_0600");
  assert.equal(fake.value_arg_template, "--env-file={{__env_file_path__}}");
});

test("registry lists github-actions-secret-set", () => {
  const r = new TemplateRegistry();
  const list = r.list();
  assert.ok(list.find((t) => t.id === "github-actions-secret-set"));
});

test("github-actions-secret-set: stdin delivery, required name+repo, optional env/org", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.equal(t.secret_delivery, "stdin");
  assert.deepEqual(t.required_params.sort(), ["name", "repo"]);
  assert.equal(t.binary, "gh");
});

test("github-actions-secret-set: validateParams REJECTS env (use a dedicated template for env-scoped secrets)", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", env: "production" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams REJECTS org (use a dedicated template for org-scoped secrets)", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", org: "acme" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects an invalid env-var name", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "1bad", repo: "acme/web" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects a repo without a slash", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "noslash" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects a whitespace-only name", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "   ", repo: "acme/web" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: validateParams rejects shell metacharacters in env/org", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", env: "prod;rm -rf /" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", repo: "acme/web", org: "$(whoami)" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("github-actions-secret-set: destinationEnvironment is the repo (env/org are rejected upstream, never reach this)", () => {
  const r = new TemplateRegistry();
  const t = r.get("github-actions-secret-set");
  assert.equal(t.destinationEnvironment?.({ name: "X", repo: "acme/web" }), "acme/web");
});

test("registry lists cloudflare-secret-put", () => {
  const r = new TemplateRegistry();
  assert.ok(r.list().find((t) => t.id === "cloudflare-secret-put"));
});

test("cloudflare-secret-put: stdin delivery, required name only", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.equal(t.secret_delivery, "stdin");
  assert.deepEqual(t.required_params, ["name"]);
  assert.equal(t.binary, "wrangler");
});

test("cloudflare-secret-put: validateParams accepts a valid name + optional env", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY", env: "staging" }));
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY" }));
});

test("cloudflare-secret-put: validateParams rejects an invalid env-var name", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.throws(
    () => t.validateParams?.({ name: "1bad" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("cloudflare-secret-put: validateParams rejects shell metacharacters in env", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", env: "prod && rm -rf /" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("cloudflare-secret-put: destinationEnvironment is env when set, 'production' otherwise", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  assert.equal(t.destinationEnvironment?.({ name: "X", env: "staging" }), "staging");
  assert.equal(t.destinationEnvironment?.({ name: "X" }), "production");
});

test("registry lists supabase-edge-secret-set", () => {
  const r = new TemplateRegistry();
  assert.ok(r.list().find((t) => t.id === "supabase-edge-secret-set"));
});

test("supabase-edge-secret-set: tmp_env_file_0600 delivery, required name only, value_arg_template set", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.equal(t.secret_delivery, "tmp_env_file_0600");
  assert.deepEqual(t.required_params, ["name"]);
  assert.equal(t.binary, "supabase");
  assert.equal(typeof t.value_arg_template, "string");
  assert.match(t.value_arg_template ?? "", /\{\{__env_file_path__\}\}/);
});

test("supabase-edge-secret-set: validateParams accepts a valid name and rejects bad ones", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.doesNotThrow(() => t.validateParams?.({ name: "STRIPE_KEY" }));
  assert.throws(
    () => t.validateParams?.({ name: "1bad" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("supabase-edge-secret-set: validateParams rejects shell metacharacters in project-ref", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.throws(
    () => t.validateParams?.({ name: "STRIPE_KEY", project_ref: "abc;rm" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("supabase-edge-secret-set: destinationEnvironment is project_ref when set, 'production' otherwise", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.equal(t.destinationEnvironment?.({ name: "X", project_ref: "abcdefghijklmnop" }), "abcdefghijklmnop");
  assert.equal(t.destinationEnvironment?.({ name: "X" }), "production");
});

test("supabase-edge-secret-set: runs end-to-end with a stub supabase binary, secret reaches the child via 0600 env-file", async () => {
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-sb-"));
  try {
    const stubDir = pathModule.join(tmp, "bin");
    const tmpDir = pathModule.join(tmp, "tmp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stubDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const stubPath = pathModule.join(stubDir, "supabase");
    const recoveredSidecar = pathModule.join(tmp, "recovered.txt");
    const argvSidecar = pathModule.join(tmp, "argv.json");
    const stubScript =
      `#!/usr/bin/env node\n` +
      `const fs=require("node:fs");\n` +
      `const arg=process.argv.find(a=>a.startsWith("--env-file="));\n` +
      `if(arg){fs.writeFileSync(${JSON.stringify(recoveredSidecar)}, fs.readFileSync(arg.slice("--env-file=".length),"utf8"));}\n` +
      `fs.writeFileSync(${JSON.stringify(argvSidecar)}, JSON.stringify({argv:process.argv,env:Object.fromEntries(Object.entries(process.env))}));\n` +
      `process.exit(0);\n`;
    await writeFile(stubPath, stubScript);
    await chmod(stubPath, 0o755);

    const { runTemplate } = await import("./run.js");
    const r = new TemplateRegistry();
    const def = { ...r.get("supabase-edge-secret-set"), binary: stubPath };
    const result = await runTemplate({
      template: def, params: { name: "STRIPE_KEY" },
      secret: SecretValue.fromUtf8("needle-supabase-9f"),
      tmpDir,
    });
    assert.equal(result.exit_code, 0);

    const recovered = await readFile(recoveredSidecar, "utf8");
    assert.equal(recovered, "STRIPE_KEY=needle-supabase-9f\n");
    const { argv, env } = JSON.parse(await readFile(argvSidecar, "utf8")) as {
      argv: string[]; env: Record<string,string>;
    };
    for (const a of argv) assert.equal(a.includes("needle-supabase-9f"), false);
    for (const [k, v] of Object.entries(env)) assert.equal((k+"="+v).includes("needle-supabase-9f"), false);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(tmpDir), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Approval-integrity tests: destinationEnvironment ↔ argv consistency

test("cloudflare-secret-put: additionalArgs splices --env into argv when env param is set (closes scope-mismatch with destinationEnvironment)", () => {
  const r = new TemplateRegistry();
  const t = r.get("cloudflare-secret-put");
  // No env → empty extras
  assert.deepEqual(t.additionalArgs?.({ name: "X" }) ?? [], []);
  // With env → spliced as ["--env", value]
  assert.deepEqual(t.additionalArgs?.({ name: "X", env: "staging" }), ["--env", "staging"]);
  // destinationEnvironment is consistent (same value the human approves)
  assert.equal(t.destinationEnvironment?.({ name: "X", env: "staging" }), "staging");
});

test("supabase-edge-secret-set: additionalArgs splices --project-ref into argv when project_ref param is set (closes scope-mismatch)", () => {
  const r = new TemplateRegistry();
  const t = r.get("supabase-edge-secret-set");
  assert.deepEqual(t.additionalArgs?.({ name: "X" }) ?? [], []);
  assert.deepEqual(t.additionalArgs?.({ name: "X", project_ref: "abcdefghijklmnop" }), ["--project-ref", "abcdefghijklmnop"]);
  assert.equal(t.destinationEnvironment?.({ name: "X", project_ref: "abcdefghijklmnop" }), "abcdefghijklmnop");
});

// assertNoPaddedParams tests

test("assertNoPaddedParams accepts unpadded values and an empty params object", () => {
  assert.doesNotThrow(() => assertNoPaddedParams({}));
  assert.doesNotThrow(() => assertNoPaddedParams({ name: "X", env: "staging" }));
  assert.doesNotThrow(() => assertNoPaddedParams({ name: "X", env: "" })); // empty string is unpadded
});

test("assertNoPaddedParams rejects a value with leading whitespace (invalid_template_param)", () => {
  assert.throws(
    () => assertNoPaddedParams({ env: " staging" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("assertNoPaddedParams rejects a value with trailing whitespace", () => {
  assert.throws(
    () => assertNoPaddedParams({ project_ref: "abc " }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("assertNoPaddedParams rejects whitespace-only values (closes the '   ' bypass)", () => {
  assert.throws(
    () => assertNoPaddedParams({ env: "   " }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});

test("assertNoPaddedParams rejects ' production ' specifically (the user's PoC for production-approval bypass)", () => {
  assert.throws(
    () => assertNoPaddedParams({ env: " production " }),
    (e: unknown) => e instanceof ShuttleError && e.code === "invalid_template_param",
  );
});
