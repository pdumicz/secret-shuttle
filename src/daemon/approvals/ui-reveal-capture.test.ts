import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

test("ui.html has a reveal_capture plain-language sentence with the reveal/field-or-container labels, planned_ref, capture_mode and domain", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /reveal_capture:/);
  assert.match(html, /reveal_handle_label/);
  assert.match(html, /capture_mode/);
});

test("ui.html renders the explicit auto-resume disclosure for reveal_capture", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /reveal_capture/);
  assert.match(html, /auto-resume observation only if the secret is verified gone/i);
});

test("ui.html shows the capture mode in the body, plus reveal/hide/container fingerprints in technical details", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /Capture mode/);
  assert.match(html, /reveal_fingerprint/);
  assert.match(html, /hide_fingerprint/);
  assert.match(html, /container_fingerprint/);
});
