import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionCreateBody, internalSessionCommand } from "./internal-session.js";

test("internalSessionCommand: has create, list, revoke subcommands", () => {
  const cmd = internalSessionCommand();
  const names = cmd.commands.map((c) => c.name());
  assert.deepEqual(names.sort(), ["create", "list", "revoke"]);
});

test("internal session create: required + repeatable flags", () => {
  const create = internalSessionCommand().commands.find((c) => c.name() === "create")!;
  const longs = create.options.map((o) => o.long);
  assert.ok(longs.includes("--actions"));
  assert.ok(longs.includes("--ref-glob"));
  assert.ok(longs.includes("--destination-domain"));
  assert.ok(longs.includes("--required-param"));
  assert.ok(longs.includes("--ttl"));
  assert.ok(longs.includes("--max-uses"));
  assert.ok(longs.includes("--no-wait"));
});

test("internal session revoke: positional <session-id>", () => {
  const revoke = internalSessionCommand().commands.find((c) => c.name() === "revoke")!;
  const args = (revoke as unknown as { registeredArguments: Array<{ _name: string }> }).registeredArguments;
  assert.equal(args.length, 1);
});

test("internal session create --required-param k=v builds body with required_params", () => {
  const body = buildSessionCreateBody({
    actions: ["template-run"],
    refGlob: "ss://stripe/prod/X",
    templateIds: ["vercel-env-add"],
    destinationDomains: ["vercel.com"],
    requiredParam: ["environment=production", "name=STRIPE_KEY"],
    ttlMs: 5 * 60 * 1000,
  });
  assert.deepEqual(body.pattern.required_params, {
    environment: "production",
    name: "STRIPE_KEY",
  });
});

test("internal session create with no --required-param omits the field entirely", () => {
  const body = buildSessionCreateBody({
    actions: ["template-run"],
    refGlob: "ss://stripe/prod/X",
    templateIds: ["vercel-env-add"],
    destinationDomains: ["vercel.com"],
    requiredParam: [],
    ttlMs: 5 * 60 * 1000,
  });
  assert.ok(!("required_params" in body.pattern));
});

test("--required-param value preserves '=' inside the value (only first '=' splits)", () => {
  const body = buildSessionCreateBody({
    actions: ["template-run"],
    refGlob: "",
    templateIds: ["t"],
    requiredParam: ["url=https://example.com/path?a=b&c=d"],
    ttlMs: 60_000,
  });
  assert.deepEqual(body.pattern.required_params, {
    url: "https://example.com/path?a=b&c=d",
  });
});

test("--required-param without '=' → throws on CLI side", () => {
  assert.throws(
    () => buildSessionCreateBody({
      actions: ["template-run"],
      refGlob: "ss://stripe/prod/X",
      templateIds: ["vercel-env-add"],
      destinationDomains: ["vercel.com"],
      requiredParam: ["malformed"],
      ttlMs: 5 * 60 * 1000,
    }),
    /required-param.*malformed/i,
  );
});

test("--required-param with leading '=' (empty key) is rejected", () => {
  // indexOf('=') === 0 falls into the `<= 0` rejection branch — empty keys
  // would round-trip through validator as invalid anyway, but failing fast
  // at the CLI gives a clearer error than waiting for the daemon to 400.
  assert.throws(
    () => buildSessionCreateBody({
      actions: ["template-run"],
      refGlob: "",
      templateIds: ["t"],
      requiredParam: ["=value"],
      ttlMs: 60_000,
    }),
    /required-param.*=value/i,
  );
});
