import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_DEFINING_PARAMS,
  destinationDefiningParamsFor,
  validateDestinationDefiningParamsCoverage,
} from "./destination-defining-params.js";
import { TemplateRegistry } from "./registry.js";

test("every shipped template has a registered entry", () => {
  const registry = new TemplateRegistry();
  const ids = registry.list().map((t) => t.id);
  assert.ok(ids.length > 0, "expected at least one shipped template");
  for (const id of ids) {
    assert.ok(
      id in DESTINATION_DEFINING_PARAMS,
      `template ${id} missing destination-defining-params entry`,
    );
  }
});

// Helper that reads via the public accessor so the test code itself
// typechecks under noUncheckedIndexedAccess.
function paramsOrFail(id: string): readonly string[] {
  const v = destinationDefiningParamsFor(id);
  assert.ok(v !== null, `expected ${id} to be registered`);
  return v;
}

test("vercel-env-add declares [name, environment]", () => {
  assert.deepEqual([...paramsOrFail("vercel-env-add")], ["name", "environment"]);
});

test("github-actions-secret-set declares [name, repo]", () => {
  assert.deepEqual([...paramsOrFail("github-actions-secret-set")], ["name", "repo"]);
});

test("cloudflare-secret-put declares [name, env]", () => {
  assert.deepEqual([...paramsOrFail("cloudflare-secret-put")], ["name", "env"]);
});

test("supabase-edge-secret-set declares [name, project_ref]", () => {
  assert.deepEqual([...paramsOrFail("supabase-edge-secret-set")], ["name", "project_ref"]);
});

test("destinationDefiningParamsFor returns null for unregistered template", () => {
  assert.equal(destinationDefiningParamsFor("railway-variable-set"), null);
});

test("destinationDefiningParamsFor reads sessionDefiningParams from each built-in template", () => {
  const r = new TemplateRegistry();
  for (const t of r.list()) {
    if (t.sessionDefiningParams === undefined) continue;
    assert.deepEqual(
      [...(destinationDefiningParamsFor(t.id) ?? [])],
      [...t.sessionDefiningParams],
      `template ${t.id}: accessor must reflect the template's sessionDefiningParams declaration`,
    );
  }
});

test("validator emits zero warnings when every shipped template declares sessionDefiningParams", () => {
  const warnings: string[] = [];
  validateDestinationDefiningParamsCoverage(new TemplateRegistry(), { warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(", ")}`);
});

test("validator emits a warning when a registered template lacks sessionDefiningParams", () => {
  const r = new TemplateRegistry();
  r.register({
    id: "test-no-defining-params",
    description: "test stub",
    binary: "/bin/echo",
    args: [],
    secret_delivery: "stdin",
    required_params: [],
    requires_approval_when_production: false,
    // sessionDefiningParams: undefined — deliberately omitted
  });
  try {
    const warnings: string[] = [];
    validateDestinationDefiningParamsCoverage(r, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1, "expected exactly one warning for the stub");
    assert.match(warnings[0] ?? "", /test-no-defining-params/);
    assert.match(warnings[0] ?? "", /sessionDefiningParams/);
  } finally {
    r.unregister("test-no-defining-params");
  }
});
