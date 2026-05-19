import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

test("ui.html has an inject_submit plain-language sentence with the field/submit labels and domain", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /inject_submit:/);
  assert.match(html, /field_handle_label/);
  assert.match(html, /submit_handle_label/);
});

test("ui.html renders the explicit auto-resume disclosure for inject_submit", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /auto-resume observation only if the secret is verified gone/i);
});

test("ui.html shows the success condition, the submit fingerprint, and an action-scope row", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /success_condition/);
  assert.match(html, /submit_fingerprint/);
  assert.match(html, /allowed_actions/);
});
