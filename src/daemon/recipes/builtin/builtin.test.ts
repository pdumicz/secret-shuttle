import { test } from "node:test";
import assert from "node:assert/strict";
import { stripeCapture } from "./stripe-capture.js";
import { vercelInject } from "./vercel-inject.js";
import { RecipeRegistry } from "../registry.js";
import { registerBuiltinRecipes } from "./index.js";

for (const r of [stripeCapture, vercelInject]) {
  test(`${r.host} (${r.kind}) defines all three probes + dogfood date`, () => {
    assert.ok(r.page_ready_probe, "page_ready_probe required");
    assert.ok(r.logged_out_marker, "logged_out_marker required");
    assert.ok(r.logged_in_probe, "logged_in_probe required");
    assert.ok(r.verified_against_real_page, "verified_against_real_page (dogfood date) required");
  });
}

test("registerBuiltinRecipes wires both directions by host", () => {
  const reg = new RecipeRegistry();
  registerBuiltinRecipes(reg);
  assert.equal(reg.getCapture(stripeCapture.host)?.kind, "capture");
  assert.equal(reg.getInject(vercelInject.host)?.kind, "inject");
});
