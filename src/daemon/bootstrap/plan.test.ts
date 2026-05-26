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

test("computeBootstrapPlan: source: existing — included even when ref IS in the vault (no --force)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "FOO", source: { kind: "existing", ref: "ss://upstream/prod/FOO" }, destinations: ["vercel:production"] },
    ],
  };
  // The existing ref IS in the vault — that's the whole point of "existing".
  const vault: MockVault = { has: (ref) => ref === "ss://upstream/prod/FOO" };
  const result = computeBootstrapPlan(parsed, vault, { force: false, source: "local", environment: "production" });
  // Regression: previously this returned 0 entries because vault.has() filtered it out.
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.ref, "ss://upstream/prod/FOO");
  assert.strictEqual(result[0]!.destinations.length, 1);
});

test("computeBootstrapPlan: source: existing — included when ref is NOT in vault (still emits destinations)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "FOO", source: { kind: "existing", ref: "ss://upstream/prod/FOO" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, { has: () => false }, { force: false, source: "local", environment: "production" });
  // The executor will fail at source-step time with a vault lookup error — that
  // is correct fail-loud behavior. The planner's job is to surface the
  // requested work, not to silently drop it.
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.ref, "ss://upstream/prod/FOO");
});

test("computeBootstrapPlan: --force sets force: true on entries that would be filtered", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: (ref) => ref === "ss://local/prod/API_KEY" };
  const result = computeBootstrapPlan(parsed, vault, { force: true, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.force, true);
});

test("computeBootstrapPlan: --force on a secret that is NOT in the vault → force omitted (no-op)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, { has: () => false }, { force: true, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.force, undefined);
});

test("computeBootstrapPlan: --force is irrelevant for source: existing", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "FOO", source: { kind: "existing", ref: "ss://upstream/prod/FOO" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: () => true };
  const result = computeBootstrapPlan(parsed, vault, { force: true, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.force, undefined, "force never set on existing-source entries");
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
