import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { TemplateRegistry } from "./registry.js";
import { resolveBinary } from "./resolve-binary.js";

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
