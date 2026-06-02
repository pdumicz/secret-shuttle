import { test } from "node:test";
import assert from "node:assert";
import { parseBootstrapYml } from "./yml.js";
import { ShuttleError, isShuttleError } from "../../shared/errors.js";

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
    assert.strictEqual(first.source.expected_host, "stripe.com");
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

// ── C1: strict capture URL validation ───────────────────────────────────────

test("parseBootstrapYml: capture source — http URL → bootstrap_capture_url_invalid", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture, url: "http://stripe.com/webhooks" }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) =>
      e instanceof ShuttleError &&
      e.code === "bootstrap_capture_url_invalid" &&
      /https/.test(e.message),
  );
});

test("parseBootstrapYml: capture source — embedded credentials → bootstrap_capture_url_invalid", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture, url: "https://user:pass@stripe.com/webhooks" }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) =>
      e instanceof ShuttleError &&
      e.code === "bootstrap_capture_url_invalid" &&
      /credentials/.test(e.message),
  );
});

test("parseBootstrapYml: capture source — localhost variants all rejected", () => {
  // Every localhost-flavored host must surface bootstrap_capture_url_invalid.
  // Note: `127.0.0.1` is an IP literal, so it fails the isIP check first
  // (different error message text), but the code is the same.
  const variants: Array<{ url: string; expectedSubstring: RegExp }> = [
    { url: "https://localhost/x", expectedSubstring: /localhost/ },
    { url: "https://localhost./x", expectedSubstring: /localhost/ },
    { url: "https://foo.localhost/x", expectedSubstring: /localhost/ },
    { url: "https://127.0.0.1/x", expectedSubstring: /IP literal/ },
  ];
  for (const { url, expectedSubstring } of variants) {
    const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture, url: "${url}" }
    destinations: [vercel:production]
`;
    assert.throws(
      () => parseBootstrapYml(yml),
      (e: unknown) =>
        e instanceof ShuttleError &&
        e.code === "bootstrap_capture_url_invalid" &&
        expectedSubstring.test(e.message),
      `expected ${url} to be rejected with bootstrap_capture_url_invalid matching ${expectedSubstring}`,
    );
  }
});

test("parseBootstrapYml: capture source — IP literals (v4 and v6) all rejected", () => {
  const variants = [
    "https://192.168.1.1/x",
    "https://[::1]/x",
    "https://[2001:db8::1]/x",
  ];
  for (const url of variants) {
    const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture, url: "${url}" }
    destinations: [vercel:production]
`;
    assert.throws(
      () => parseBootstrapYml(yml),
      (e: unknown) =>
        e instanceof ShuttleError &&
        e.code === "bootstrap_capture_url_invalid" &&
        /IP literal/.test(e.message),
      `expected ${url} to be rejected as an IP literal`,
    );
  }
});

test("parseBootstrapYml: capture source — expected_host is lowercased + trailing-dot stripped", () => {
  const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://Dashboard.Stripe.com./" }
    destinations: [vercel:production]
`;
  const plan = parseBootstrapYml(yml);
  const source = plan.secrets[0]!.source;
  assert.strictEqual(source.kind, "capture");
  if (source.kind === "capture") {
    assert.strictEqual(source.expected_host, "dashboard.stripe.com");
    // url field stays VERBATIM — only expected_host is canonicalized.
    assert.strictEqual(source.url, "https://Dashboard.Stripe.com./");
  }
});

test("parseBootstrapYml: capture source — well-formed https URL accepted with expected_host set", () => {
  const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/webhooks/we_abc/signing_secret" }
    destinations: [vercel:production]
`;
  const plan = parseBootstrapYml(yml);
  assert.strictEqual(plan.secrets.length, 1);
  const source = plan.secrets[0]!.source;
  assert.strictEqual(source.kind, "capture");
  if (source.kind === "capture") {
    assert.strictEqual(
      source.url,
      "https://dashboard.stripe.com/webhooks/we_abc/signing_secret",
    );
    assert.strictEqual(source.expected_host, "dashboard.stripe.com");
  }
});

// ── Destination string/object form (Task 3) ──────────────────────────────────

test("destination string form back-compat: parses to { shorthand } with url_params omitted", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - vercel:production
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0]!.destinations[0]!;
  assert.equal(dest.shorthand, "vercel:production");
  assert.equal("url_params" in dest, false, "url_params must be OMITTED (not {}) for string form");
});

test("destination object form: parses with url_params", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:preview
        url_params: { team: acme, project: my-app }
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0]!.destinations[0]!;
  assert.equal(dest.shorthand, "vercel:preview");
  assert.deepEqual(dest.url_params, { team: "acme", project: "my-app" });
});

test("destination object without url_params: same shape as string form (url_params absent)", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0]!.destinations[0]!;
  assert.equal(dest.shorthand, "vercel:production");
  assert.equal("url_params" in dest, false);
});

test("destination object with unknown extra key → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        bogus: yes
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object missing shorthand → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - url_params: { team: acme }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as non-string (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as empty string → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: ""
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// Shorthand member: full non-string rejection matrix (spec §9 calls these out by name).
test("destination object shorthand as boolean → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: true
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as null → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: null
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as list → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: [vercel, production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as mapping → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: { provider: vercel, env: production }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// Shorthand member: full non-string rejection matrix when the destination entry is
// itself a YAML shorthand (the string-form back-compat path). The parser must reject
// list / mapping / number / boolean / null at the entry level too, not just inside
// the object form. (Empty-string string entry is already covered by the
// "string entries must be non-empty" check in parseDestinations.)
test("destination entry as bare number (e.g. `- 42`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare boolean (e.g. `- true`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - true
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare null (e.g. `- ~`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - ~
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare list → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - [vercel, production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params as non-mapping (string) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: "not a mapping"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with non-string value (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: 42 }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with non-string value (boolean) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: true }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// url_params top-level: must be a mapping. String is covered above; add number, list.
test("url_params as non-mapping (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params as non-mapping (list) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: [team, project]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// url_params member: full non-string rejection matrix (spec §9). Number + boolean
// already covered above; add null, nested mapping, list.
test("url_params member with null value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: null }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with nested mapping value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: { nested: acme } }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with list value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: [a, b] }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});
