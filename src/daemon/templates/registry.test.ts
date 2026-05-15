import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { TemplateRegistry } from "./registry.js";

test("registry lists built-in vercel-env-add", () => {
  const r = new TemplateRegistry();
  const list = r.list();
  assert.ok(list.find((t) => t.id === "vercel-env-add"));
});

test("registry resolves a template by id", () => {
  const r = new TemplateRegistry();
  const t = r.get("vercel-env-add");
  assert.equal(t.id, "vercel-env-add");
  assert.deepEqual(t.required_params, ["name", "environment"]);
});

test("registry throws for unknown templates", () => {
  const r = new TemplateRegistry();
  assert.throws(
    () => r.get("nope"),
    (err) => err instanceof ShuttleError && err.code === "template_not_found",
  );
});
