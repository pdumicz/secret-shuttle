import { test } from "node:test";
import assert from "node:assert";
import { computeBootstrapPlan } from "./plan.js";
import type { BootstrapPlan } from "../../cli/bootstrap/yml.js";

interface MockVault {
  has(ref: string): boolean;
}
const emptyVault: MockVault = { has: () => false };

test("computeBootstrapPlan: empty vault, all secrets need creation", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.secret, "API_KEY");
  assert.strictEqual(result[0]!.ref, "ss://local/prod/API_KEY");
});

test("computeBootstrapPlan: secret already in vault → skipped (no --force)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: (ref) => ref === "ss://local/prod/API_KEY" };
  const result = computeBootstrapPlan(parsed, vault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 0);
});

test("computeBootstrapPlan: --force re-plans even when present", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: (ref) => ref === "ss://local/prod/API_KEY" };
  const result = computeBootstrapPlan(parsed, vault, { force: true, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
});

test("computeBootstrapPlan: source: existing always uses given ref", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "FOO", source: { kind: "existing", ref: "ss://upstream/prod/FOO" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.ref, "ss://upstream/prod/FOO");
});

test("computeBootstrapPlan: destination shorthand resolved into ResolvedDestination[]", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production", "github-actions:owner/repo"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result[0]!.destinations.length, 2);
  assert.strictEqual(result[0]!.destinations[0]!.template_id, "vercel-env-add");
  assert.strictEqual(result[0]!.destinations[1]!.template_id, "github-actions-secret-set");
});
