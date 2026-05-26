import { test } from "node:test";
import assert from "node:assert";
import { resolveDestinationShorthand } from "./destination-shorthand.js";
import { ShuttleError } from "../../shared/errors.js";

test("vercel:production → vercel-env-add template", () => {
  const r = resolveDestinationShorthand("vercel:production", "API_KEY");
  assert.deepStrictEqual(r, {
    template_id: "vercel-env-add",
    template_params: { name: "API_KEY", environment: "production" },
    domain: "vercel.com",
  });
});

test("vercel:preview", () => {
  const r = resolveDestinationShorthand("vercel:preview", "API_KEY");
  assert.strictEqual(r.template_params.environment, "preview");
});

test("vercel:development", () => {
  const r = resolveDestinationShorthand("vercel:development", "API_KEY");
  assert.strictEqual(r.template_params.environment, "development");
});

test("github-actions:owner/repo → github-actions-secret-set", () => {
  const r = resolveDestinationShorthand("github-actions:acme/widgets", "API_KEY");
  assert.strictEqual(r.template_id, "github-actions-secret-set");
  assert.strictEqual(r.template_params.repo, "acme/widgets");
  assert.strictEqual(r.template_params.name, "API_KEY");
  assert.strictEqual(r.domain, "github.com");
});

test("cloudflare:production → cloudflare-secret-put", () => {
  const r = resolveDestinationShorthand("cloudflare:production", "API_KEY");
  assert.strictEqual(r.template_id, "cloudflare-secret-put");
});

test("supabase:projectref → supabase-edge-secret-set", () => {
  const r = resolveDestinationShorthand("supabase:abcdefg", "API_KEY");
  assert.strictEqual(r.template_id, "supabase-edge-secret-set");
});

test("unknown provider → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("netlify:production", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});

test("malformed shorthand (no colon) → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("just-a-string", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});

test("vercel:invalid-env → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("vercel:staging", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});
