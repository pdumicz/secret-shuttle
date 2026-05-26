import assert from "node:assert/strict";
import test from "node:test";
import { isDestinationProductionClass, planHasProductionDestination } from "./destination-policy.js";
import type { ResolvedDestination } from "./store.js";

// ── isDestinationProductionClass unit tests ──────────────────────────────────

test("isDestinationProductionClass: vercel:production → true", () => {
  const dest: ResolvedDestination = {
    shorthand: "vercel:production",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "production" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: vercel:development → false", () => {
  const dest: ResolvedDestination = {
    shorthand: "vercel:development",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "development" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), false);
});

test("isDestinationProductionClass: vercel:preview → false", () => {
  const dest: ResolvedDestination = {
    shorthand: "vercel:preview",
    template_id: "vercel-env-add",
    template_params: { name: "MY_SECRET", environment: "preview" },
    domain: "vercel.com",
  };
  assert.equal(isDestinationProductionClass(dest), false);
});

test("isDestinationProductionClass: cloudflare:production → true", () => {
  const dest: ResolvedDestination = {
    shorthand: "cloudflare:production",
    template_id: "cloudflare-secret-put",
    template_params: { name: "MY_SECRET", env: "production" },
    domain: "cloudflare.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: cloudflare:dev → false", () => {
  const dest: ResolvedDestination = {
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
    shorthand: "cloudflare:production",
    template_id: "cloudflare-secret-put",
    template_params: { name: "MY_SECRET" }, // no env field
    domain: "cloudflare.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: github-actions:any/repo → true (always)", () => {
  const dest: ResolvedDestination = {
    shorthand: "github-actions:owner/repo",
    template_id: "github-actions-secret-set",
    template_params: { name: "MY_SECRET", repo: "owner/repo" },
    domain: "github.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: supabase:any-project → true (always)", () => {
  const dest: ResolvedDestination = {
    shorthand: "supabase:myproject",
    template_id: "supabase-edge-secret-set",
    template_params: { name: "MY_SECRET", project_ref: "myproject" },
    domain: "supabase.com",
  };
  assert.equal(isDestinationProductionClass(dest), true);
});

test("isDestinationProductionClass: unknown template_id → true (fail closed)", () => {
  const dest: ResolvedDestination = {
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
          shorthand: "vercel:development",
          template_id: "vercel-env-add",
          template_params: { name: "A", environment: "development" },
          domain: "vercel.com",
        } as ResolvedDestination,
        {
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
