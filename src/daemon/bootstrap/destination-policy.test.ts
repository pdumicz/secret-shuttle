import assert from "node:assert/strict";
import test from "node:test";
import { isDestinationProductionClass, planHasProductionDestination, planHasProductionSource, planRequiresHumanPending } from "./destination-policy.js";
import type { ResolvedDestination } from "./store.js";

// ── isDestinationProductionClass unit tests ──────────────────────────────────

test("isDestinationProductionClass: vercel:production → true", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "vercel:production",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "production" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: vercel:development → false", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "vercel:development",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "development" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), false);
});

test("isDestinationProductionClass: vercel:preview → false", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "vercel:preview",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "preview" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), false);
});

test("isDestinationProductionClass: cloudflare:production → true", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "cloudflare:production",
    template_id: "cloudflare-secret-put",
    template_params: { name: "MY_SECRET", env: "production" },
    domain: "cloudflare.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: cloudflare:dev → false", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "cloudflare:dev",
    template_id: "cloudflare-secret-put",
    template_params: { name: "MY_SECRET", env: "dev" },
    domain: "cloudflare.com",
  };
  assert.equal(isDestinationProductionClass(dest), false);
});

test("isDestinationProductionClass: cloudflare with empty env (default prod) → true", () => {
  // No `env` field: cloudflare's destinationEnvironment returns "production" when env is unset/empty.
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "cloudflare:production",
    template_id: "cloudflare-secret-put",
    template_params: { name: "MY_SECRET" }, // no env field
    domain: "cloudflare.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: github-actions:any/repo → true (always)", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "github-actions:owner/repo",
    template_id: "github-actions-secret-set",
    template_params: { name: "MY_SECRET", repo: "owner/repo" },
    domain: "github.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: supabase:any-project → true (always)", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "supabase:myproject",
    template_id: "supabase-edge-secret-set",
    template_params: { name: "MY_SECRET", project_ref: "myproject" },
    domain: "supabase.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: unknown template_id → true (fail closed)", () => {
  const dest: ResolvedDestination = {
    kind: "template",
    shorthand: "unknown:scope",
    template_id: "nonexistent-template-xyz",
    template_params: { name: "MY_SECRET" },
    domain: "unknown.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

// ── planHasProductionDestination unit tests ──────────────────────────────────

test("planHasProductionDestination: mixed plan with one prod dest → true", () => {
  const plan = [
    {
      destinations: [
        {
          kind: "template",
          shorthand: "vercel:development",
          template_id: "vercel-env-add",
          template_params: { name: "A", environment: "development" },
          domain: "vercel.com",
        } as ResolvedDestination,
        {
          kind: "template",
          shorthand: "vercel:production",
          template_id: "vercel-env-add",
          template_params: { name: "A", environment: "production" },
          domain: "vercel.com",
        } as ResolvedDestination,
      ],
    },
  ];
  assert.equal(planHasProductionDestination(plan), true);
});

test("planHasProductionDestination: all-dev plan → false", () => {
  const plan = [
    {
      destinations: [
        {
          kind: "template",
          shorthand: "vercel:development",
          template_id: "vercel-env-add",
          template_params: { name: "A", environment: "development" },
          domain: "vercel.com",
        } as ResolvedDestination,
      ],
    },
    {
      destinations: [
        {
          kind: "template",
          shorthand: "vercel:preview",
          template_id: "vercel-env-add",
          template_params: { name: "B", environment: "preview" },
          domain: "vercel.com",
        } as ResolvedDestination,
      ],
    },
  ];
  assert.equal(planHasProductionDestination(plan), false);
});

test("planHasProductionDestination: empty plan → false", () => {
  assert.equal(planHasProductionDestination([]), false);
});

// ── planHasProductionSource unit tests (R13) ─────────────────────────────────

test("planHasProductionSource: plan with one ss://local/prod/X entry → true", () => {
  const plan = [
    { ref: "ss://local/prod/API_KEY", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), true);
});

test("planHasProductionSource: all entries ss://local/dev/X → false", () => {
  const plan = [
    { ref: "ss://local/dev/API_KEY", destinations: [] },
    { ref: "ss://local/dev/OTHER", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), false);
});

test("planHasProductionSource: mixed prod + dev → true (any-prod)", () => {
  const plan = [
    { ref: "ss://local/dev/A", destinations: [] },
    { ref: "ss://local/prod/B", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), true);
});

test("planHasProductionSource: empty plan → false", () => {
  assert.strictEqual(planHasProductionSource([]), false);
});

test("planHasProductionSource: unparseable ref → true (fail closed)", () => {
  const plan = [
    { ref: "not-a-real-ref", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), true);
});

test("planHasProductionSource: custom env (ss://local/staging/X) → false", () => {
  // Documents that only literal "production" triggers; "staging" and custom
  // envs do not. (They may still trigger the gate via destination class.)
  const plan = [
    { ref: "ss://local/staging/A", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), false);
});

test("planHasProductionSource: ss://upstream/prod/X (non-local source) → true", () => {
  const plan = [
    { ref: "ss://upstream/prod/A", destinations: [] },
  ];
  assert.strictEqual(planHasProductionSource(plan), true);
});

// ── planRequiresHumanPending unit tests (C9) ──────────────────────────────────────

test("planRequiresHumanPending: true when any entry has source.kind === 'capture'", () => {
  const plan = [
    { source: { kind: "random_32_bytes" } },
    { source: { kind: "capture" } },
  ];
  assert.strictEqual(planRequiresHumanPending(plan), true);
});

test("planRequiresHumanPending: false when all entries have other kinds (random/existing)", () => {
  const plan = [
    { source: { kind: "random_32_bytes" } },
    { source: { kind: "random_64_bytes" } },
    { source: { kind: "existing" } },
  ];
  assert.strictEqual(planRequiresHumanPending(plan), false);
});

test("planRequiresHumanPending: empty plan returns false", () => {
  assert.strictEqual(planRequiresHumanPending([]), false);
});

test("isDestinationProductionClass: browser_inject → true (always prod-class, fail-closed)", () => {
  const dest = { kind: "browser_inject" as const, recipe_host: "stripe.com", shorthand: "stripe", domain: "stripe.com" };
  assert.equal(isDestinationProductionClass(dest), true);
});
