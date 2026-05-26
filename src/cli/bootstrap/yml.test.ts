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

test("parseBootstrapYml: existing source with missing name segment → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/prod"
    destinations:
      - "vercel:development"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid" && /ss:\/\/local\/prod/.test(e.message),
  );
});

test("parseBootstrapYml: existing source with missing env+name segments → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local"
    destinations:
      - "vercel:development"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: existing source with bare ss:// prefix → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://"
    destinations:
      - "vercel:development"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: existing source with invalid characters in name segment → bootstrap_plan_invalid", () => {
  // The NAME_RE in refs.ts requires names to start with a letter/underscore.
  // A name starting with a digit should fail.
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/prod/9starts-with-digit"
    destinations:
      - "vercel:development"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: existing source with well-formed ref → still passes (regression guard)", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/prod/EXISTING_PROD"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(result.secrets.length, 1);
  assert.strictEqual(result.secrets[0]!.name, "FOO");
  assert.strictEqual(result.secrets[0]!.source.kind, "existing");
  assert.strictEqual((result.secrets[0]!.source as { ref: string }).ref, "ss://local/prod/EXISTING_PROD");
});

test("parseBootstrapYml: existing source — long-form environment 'production' canonicalizes to 'prod' in ref", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/production/EXISTING_PROD"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(result.secrets[0]!.name, "FOO");
  const source = result.secrets[0]!.source;
  assert.strictEqual(source.kind, "existing");
  assert.strictEqual(
    (source as { ref: string }).ref,
    "ss://local/prod/EXISTING_PROD",
    "long-form 'production' must canonicalize to 'prod' in the ss:// ref",
  );
});

test("parseBootstrapYml: existing source — short-form environment 'prod' stays 'prod' (regression guard)", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/prod/EXISTING_PROD"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(
    (result.secrets[0]!.source as { ref: string }).ref,
    "ss://local/prod/EXISTING_PROD",
  );
});

test("parseBootstrapYml: existing source — long-form 'development' canonicalizes to 'dev'", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/development/EXISTING_DEV"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(
    (result.secrets[0]!.source as { ref: string }).ref,
    "ss://local/dev/EXISTING_DEV",
  );
});

test("parseBootstrapYml: existing source — uppercase source host lowercases", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://LOCAL/prod/EXISTING_PROD"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(
    (result.secrets[0]!.source as { ref: string }).ref,
    "ss://local/prod/EXISTING_PROD",
  );
});

test("parseBootstrapYml: existing source — custom env (e.g., 'staging') stays as-is", () => {
  // canonicalEnvironment passes through unrecognized env names verbatim.
  const yml = `
version: 1
secrets:
  FOO:
    source:
      kind: existing
      ref: "ss://local/staging/X"
    destinations:
      - "vercel:development"
`;
  const result = parseBootstrapYml(yml);
  assert.strictEqual(
    (result.secrets[0]!.source as { ref: string }).ref,
    "ss://local/staging/X",
  );
});
