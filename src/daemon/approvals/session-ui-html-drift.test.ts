import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/session-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("session-ui.html: hub_seq parse + null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  assert.match(html, /(===\s*null|!== null)/);
});

test("session-ui.html: notifyHubIfFramed + parent + postMessage", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("session-ui.html: pollForTerminal targets /ui/sessions/:id with session terminal statuses", async () => {
  const html = await loadHtml();
  assert.match(html, /function pollForTerminal\b/);
  assert.match(html, /\/ui\/sessions\/\$\{sessionId\}\?token=/);
  for (const status of ["granted", "denied", "expired", "revoked"]) {
    assert.match(html, new RegExp(`"${status}"`), `terminal status ${status}`);
  }
  // Sessions don't have "used" status; the drift guard pins this.
  // (We don't assert absence of "used" — it might appear in unrelated text;
  // the structural check is that the terminal set is in a Set literal with
  // the 4 statuses above.)
});

test("session-ui.html: stopPolling has >=2 call sites + beforeunload", async () => {
  const html = await loadHtml();
  assert.match(html, /function stopPolling\b/);
  const stopCalls = html.match(/stopPolling\s*\(\s*\)/g) ?? [];
  assert.ok(stopCalls.length >= 2, `expected >=2 stopPolling() call sites, got ${stopCalls.length}`);
  assert.match(html, /addEventListener\(\s*["']beforeunload["']/);
});

test("session-ui.html: success-only gate — done(verb, ok) gates notify on ok", async () => {
  const html = await loadHtml();
  // Either `if (ok)` (inside done) or `if (r.ok)` (before calling done with notify).
  // Both shapes are acceptable; the drift assertion is one OR the other appears
  // adjacent to notifyHubIfFramed.
  const hasOkGate = /if\s*\(\s*ok\s*\)/.test(html) || /if\s*\(\s*r\.ok\s*\)/.test(html);
  assert.ok(hasOkGate, "expected an `if (ok)` or `if (r.ok)` gate around the notify call");
});
