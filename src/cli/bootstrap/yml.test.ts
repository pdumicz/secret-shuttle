import { test } from "node:test";
import assert from "node:assert";
import { parseBootstrapYml } from "./yml.js";
import { ShuttleError } from "../../shared/errors.js";

test("parseBootstrapYml: valid plan with all source kinds", () => {
  const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: https://stripe.com }
    destinations: [vercel:production]
  CRON_SECRET:
    source: { kind: random_32_bytes }
    destinations: [vercel:production]
  EXISTING_API:
    source: { kind: existing, ref: ss://local/prod/EXISTING_API }
    destinations: [vercel:production]
`;
  const plan = parseBootstrapYml(yml);
  assert.strictEqual(plan.version, 1);
  assert.strictEqual(plan.secrets.length, 3);
  const first = plan.secrets[0];
  assert.ok(first !== undefined);
  assert.strictEqual(first.name, "STRIPE_KEY");
  assert.strictEqual(first.source.kind, "capture");
  if (first.source.kind === "capture") {
    assert.strictEqual(first.source.url, "https://stripe.com");
  }
});

test("parseBootstrapYml: rejects unknown version", () => {
  const yml = `version: 99\nsecrets: {}`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects bad env-var name", () => {
  const yml = `
version: 1
secrets:
  lowercase_bad:
    source: { kind: random_32_bytes }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects unknown source.kind", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: mystery }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects capture without url", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects existing without ref", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: existing }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects empty destinations", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: random_32_bytes }
    destinations: []
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects malformed yaml", () => {
  const yml = "not: valid: yaml: ::: [";
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});
