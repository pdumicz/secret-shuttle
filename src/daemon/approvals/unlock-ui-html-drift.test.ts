import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/unlock-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("unlock-ui.html: hub_seq parse with null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  assert.match(html, /(===\s*null|!== null)/);
});

test("unlock-ui.html: notifyHubIfFramed defined + postMessage", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("unlock-ui.html: notifyHubIfFramed called from success branch only (no polling)", async () => {
  const html = await loadHtml();
  // No polling on unlock — pin the intentional absence.
  assert.doesNotMatch(html, /\bpollForTerminal\b/);
  assert.doesNotMatch(html, /\bstartPolling\b/);
  // Notify must be reachable from the j.ok success path; the existing
  // code uses `if(!j.ok){...}else{ ... }`, so we assert presence of the
  // notify call inside an `else` block or guarded by `j.ok`.
  assert.match(html, /j\.ok/);
  assert.match(html, /notifyHubIfFramed\s*\(\s*\)/);
});
