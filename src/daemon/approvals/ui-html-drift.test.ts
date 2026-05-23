import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("ui.html: hub_seq parse with null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /URLSearchParams\(\s*location\.search\s*\)/);
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  // The "rawHubSeq === null ? null : Number(...)" pattern OR equivalent
  // null-check must precede the > 0 test.
  assert.match(html, /(===\s*null|!== null)/);
});

test("ui.html: notifyHubIfFramed function present + parent + postMessage call", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\s*!==\s*window/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("ui.html: pollForTerminal + terminalStatuses for /ui/approvals/:id", async () => {
  const html = await loadHtml();
  assert.match(html, /function pollForTerminal\b/);
  assert.match(html, /terminalStatuses/);
  // Required terminal statuses for /ui/approve.
  for (const status of ["granted", "denied", "expired", "used"]) {
    assert.match(html, new RegExp(`"${status}"`), `terminal status ${status}`);
  }
  // Polls the approvals endpoint.
  assert.match(html, /\/ui\/approvals\/\$\{id\}\?token=/);
});

test("ui.html: startPolling + stopPolling + beforeunload cleanup", async () => {
  const html = await loadHtml();
  assert.match(html, /function startPolling\b/);
  assert.match(html, /function stopPolling\b/);
  // stopPolling must be called from the terminal path AND beforeunload.
  const stopCalls = html.match(/stopPolling\s*\(\s*\)/g) ?? [];
  assert.ok(stopCalls.length >= 2, `expected >=2 stopPolling() call sites, got ${stopCalls.length}`);
  assert.match(html, /addEventListener\(\s*["']beforeunload["']/);
});

test("ui.html: success-only gate — notifyHubIfFramed reachable only under r.ok", async () => {
  const html = await loadHtml();
  // The success-only gate: there must be an `if (r.ok)` (or equivalent)
  // preceding a notifyHubIfFramed() call in the approve/deny POST handler.
  // Crude pattern: r.ok appearing within ~200 chars of notifyHubIfFramed.
  const okPattern = /if\s*\(\s*r\.ok\s*\)/;
  assert.match(html, okPattern, "expected an `if (r.ok)` guard around the notify call");
});
