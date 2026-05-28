import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSourceForName, type InferredSource } from "./infer-rules.js";

test("STRIPE_WEBHOOK_SECRET → capture from /webhooks", () => {
  const result = inferSourceForName("STRIPE_WEBHOOK_SECRET");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://dashboard.stripe.com/webhooks",
  });
});

test("STRIPE_SECRET_KEY → capture from /apikeys (non-webhook stripe)", () => {
  const result = inferSourceForName("STRIPE_SECRET_KEY");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://dashboard.stripe.com/apikeys",
  });
});

test("SUPABASE_SERVICE_ROLE → capture from supabase api page", () => {
  const result = inferSourceForName("SUPABASE_SERVICE_ROLE");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://supabase.com/dashboard/project/_/settings/api",
  });
});

test("OPENAI_API_KEY → capture from platform.openai", () => {
  assert.deepEqual(inferSourceForName("OPENAI_API_KEY"), {
    kind: "capture",
    url: "https://platform.openai.com/api-keys",
  });
});

test("ANTHROPIC_API_KEY → capture from anthropic console", () => {
  assert.deepEqual(inferSourceForName("ANTHROPIC_API_KEY"), {
    kind: "capture",
    url: "https://console.anthropic.com/settings/keys",
  });
});

test("CLERK_PUBLISHABLE_KEY → capture from clerk dashboard", () => {
  assert.deepEqual(inferSourceForName("CLERK_PUBLISHABLE_KEY"), {
    kind: "capture",
    url: "https://dashboard.clerk.com",
  });
});

test("INTERNAL_CRON_SECRET → random_32_bytes (no provider prefix, ends with _SECRET)", () => {
  assert.deepEqual(inferSourceForName("INTERNAL_CRON_SECRET"), { kind: "random_32_bytes" });
});

test("API_TOKEN → random_32_bytes (no provider prefix, ends with _TOKEN)", () => {
  assert.deepEqual(inferSourceForName("API_TOKEN"), { kind: "random_32_bytes" });
});

test("DATABASE_URL → existing placeholder", () => {
  assert.deepEqual(inferSourceForName("DATABASE_URL"), {
    kind: "existing",
    placeholder: true,
  });
});

test("POSTGRES_URL / MYSQL_URL → existing placeholder", () => {
  assert.deepEqual(inferSourceForName("POSTGRES_URL"), { kind: "existing", placeholder: true });
  assert.deepEqual(inferSourceForName("MYSQL_URL"), { kind: "existing", placeholder: true });
});

test("CUSTOM_FEATURE_FLAG_KEY → unknown (no rule matches)", () => {
  assert.deepEqual(inferSourceForName("CUSTOM_FEATURE_FLAG_KEY"), { kind: "unknown" });
});

test("MYSECRET (no underscore separator) → unknown (regex requires _SECRET/_TOKEN suffix)", () => {
  // Regression guard for the tightened fallback regex. The spec table is
  // `*_SECRET` / `*_TOKEN` — names without the underscore separator must
  // fall through to `unknown` rather than being silently auto-randomed.
  assert.deepEqual(inferSourceForName("MYSECRET"), { kind: "unknown" });
  assert.deepEqual(inferSourceForName("BIGTOKEN"), { kind: "unknown" });
});

test("case-insensitive matching", () => {
  assert.deepEqual(inferSourceForName("stripe_secret_key"), {
    kind: "capture",
    url: "https://dashboard.stripe.com/apikeys",
  });
});
