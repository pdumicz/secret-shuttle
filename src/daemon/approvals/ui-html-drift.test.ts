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

test("ui.html: error_code=approval_not_found branch — comparison, cancellation render, and hub drain", async () => {
  const html = await loadHtml();

  // 1. The handler must compare error_code === "approval_not_found" (not just
  //    include the string in a comment or dead code).
  assert.match(
    html,
    /errBody\.error_code\s*===\s*["']approval_not_found["']/,
    "ui.html must compare errBody.error_code === 'approval_not_found' in the polling handler",
  );

  // 2. The branch must call stopPolling() to exit the polling loop.
  assert.match(
    html,
    /error_code\s*===\s*["']approval_not_found["'][^}]*stopPolling\s*\(\s*\)/s,
    "ui.html must call stopPolling() within the approval_not_found branch",
  );

  // 3. The branch must render a visible cancellation status.
  assert.match(
    html,
    /Status:\s*cancelled/i,
    "ui.html must set a 'Status: cancelled' text when error_code=approval_not_found",
  );

  // 4. The branch must drain the hub by calling notifyHubIfFramed().
  assert.match(
    html,
    /error_code\s*===\s*["']approval_not_found["'][^}]*notifyHubIfFramed\s*\(\s*\)/s,
    "ui.html must call notifyHubIfFramed() within the approval_not_found branch to drain the hub broker",
  );
});

test("ui.html: renders bootstrap action with plan_summary parse", async () => {
  const html = await loadHtml();
  // Must handle action === 'bootstrap' by name
  assert.match(html, /["']bootstrap["']/, "ui.html must handle action === 'bootstrap'");
  // Must reference renderBootstrap function
  assert.match(html, /function renderBootstrap\b/, "ui.html must define a renderBootstrap function");
  // Must parse template_params.plan_summary
  assert.match(html, /plan_summary/, "ui.html must reference template_params.plan_summary");
  // Must call esc() on plan content (existing escaper is named esc, not escapeHtml)
  assert.match(html, /esc\s*\(\s*s\.name\s*\)/, "ui.html must escape bootstrap secret names via esc()");
  assert.match(html, /esc\s*\(\s*s\.source\s*\)/, "ui.html must escape bootstrap secret sources via esc()");
  // Must branch on bootstrap action to call renderBootstrap
  assert.match(
    html,
    /g\.action\s*===\s*["']bootstrap["'][^}]*renderBootstrap\s*\(\s*g\s*\)/s,
    "ui.html must call renderBootstrap(g) when action === 'bootstrap'",
  );
});
