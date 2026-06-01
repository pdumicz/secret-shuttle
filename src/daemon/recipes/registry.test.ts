import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipeRegistry } from "./registry.js";
import type { CaptureRecipe, InjectRecipe } from "./types.js";

const cap: CaptureRecipe = {
  kind: "capture", host: "example.com", url: "https://example.com/keys",
  logged_in_probe: "[data-x]", reveal_selector: "#r", field_selector: "#f",
};
const inj: InjectRecipe = {
  kind: "inject", host: "example.com", url: "https://example.com/env",
  logged_in_probe: "[data-y]", field_selector: "#v", submit_selector: "#s", success_text: "Saved",
};

test("registry keys by canonical host per direction", () => {
  const r = new RecipeRegistry();
  r.registerCapture(cap);
  r.registerInject(inj);
  assert.equal(r.getCapture("example.com"), cap);
  assert.equal(r.getInject("example.com"), inj);
  assert.equal(r.getCapture("EXAMPLE.COM."), cap); // canonicalized lookup
  assert.equal(r.getInject("nope.com"), undefined);
  assert.equal(r.getCapture("example.com")?.kind, "capture"); // direction isolation
});
