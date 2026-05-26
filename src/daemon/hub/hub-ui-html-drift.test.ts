import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HUB_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/hub/hub-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HUB_HTML, "utf8");
}

test("hub-ui.html: postDone retry shape", async () => {
  const html = await loadHtml();
  assert.match(html, /function postDone\b/);
  assert.match(html, /MAX_ATTEMPTS\s*=\s*5\b/);
  // Retry loop must wrap the fetch in try/catch.
  assert.match(html, /for\s*\(let attempt[\s\S]+?try\s*\{[\s\S]+?\}\s*catch/);
  // HTTP terminal breaks.
  assert.match(html, /401/);
  assert.match(html, /403/);
  assert.match(html, /400/);
  assert.match(html, /\bbreak\b/);
  // Success exit.
  assert.match(html, /r\.ok/);
});

test("hub-ui.html: terminal-branch teardown closes SSE", async () => {
  const html = await loadHtml();
  assert.match(html, /terminal\s*=\s*true/);
  // es?.close() OR es.close() (different syntaxes are fine).
  assert.match(html, /es\??\.close\s*\(/);
  assert.match(html, /showBanner\s*\(/);
});

test("hub-ui.html: displaced/disconnected hides the iframe and points it at about:blank", async () => {
  const html = await loadHtml();
  // CSS rule must hide #op when status is disconnected OR displaced.
  // Crude check: both selector forms appear paired with `#op` and `display: none`.
  assert.match(html, /#status\.(disconnected|displaced)[^{]*~\s*#op[^{]*\{[^}]*display\s*:\s*none/);
  // JS must also reassign iframe.src to about:blank when entering a
  // terminal-state banner (defense in depth against CSS bypass).
  assert.match(html, /iframe\.src\s*=\s*["']about:blank["']/);
});

test("hub-ui.html: message-handler suppresses post-terminal events", async () => {
  const html = await loadHtml();
  assert.match(html, /if\s*\(terminal\)\s*return/);
});

test("hub-ui.html: open listener resets consecutiveFailures", async () => {
  const html = await loadHtml();
  assert.match(html, /addEventListener\(\s*["']open["']/);
  assert.match(html, /consecutiveFailures\s*=\s*0/);
});

test("hub-ui.html: duplicate-done suppression scaffolding", async () => {
  const html = await loadHtml();
  assert.match(html, /\bdoneInFlight\b/);
  assert.match(html, /\blastCompletedSeq\b/);
  assert.match(html, /function shouldPostDone\b/);
  // postDone must wrap work in try/finally to clean state.
  assert.match(html, /try\s*\{[\s\S]+?\}\s*finally\s*\{[\s\S]+?doneInFlight\.delete/);
  assert.match(html, /lastCompletedSeq\s*=\s*Math\.max/);
});

test("hub-ui.html: window message origin + source guards", async () => {
  const html = await loadHtml();
  assert.match(html, /ev\.origin\s*!==\s*location\.origin/);
  assert.match(html, /ev\.source\s*!==\s*iframe\.contentWindow/);
});

test("hub-ui.html: iframe sandbox attribute is restrictive", async () => {
  const html = await loadHtml();
  assert.match(html, /<iframe[^>]*sandbox=["']allow-scripts allow-same-origin allow-forms["']/);
});

test("hub-ui.html: strips hub_token from URL after bootstrap (history.replaceState)", async () => {
  const html = await loadHtml();
  // Defense against token leakage via address bar, screenshots,
  // Referer headers, and window.parent.location.search reads from
  // iframe content. The token must be read into a closure-local
  // variable, then immediately replaced via history.replaceState.
  assert.match(html, /history\.replaceState\s*\(\s*\{\s*\}\s*,\s*["']["']\s*,\s*["']\/ui\/hub["']\s*\)/);
});

test("hub-ui.html: bootstrap_capture_step coordinator card renders with Capture/Skip/Abandon buttons", async () => {
  const html = await loadHtml();
  assert.match(html, /function renderCaptureStep\b/);
  assert.match(html, /\/ui\/bootstrap\/capture-step\?token=/);
  assert.match(html, /\/ui\/bootstrap\/skip-step\?token=/);
  assert.match(html, /\/ui\/bootstrap\/abandon\?token=/);
});

test("hub-ui.html: in-page recovery (takeOver) replaces reload-based recovery", async () => {
  const html = await loadHtml();
  // Because history.replaceState strips the token, a bare reload would
  // hit /ui/hub with no token and 400. The recovery path must be a
  // takeOver() function reachable from a button inside the banner.
  assert.match(html, /function takeOver\b/);
  // takeOver must reset the terminal-state flag, clear the strikes
  // counter, and re-issue the SSE connection via connect().
  assert.match(html, /terminal\s*=\s*false/);
  assert.match(html, /consecutiveFailures\s*=\s*0/);
  assert.match(html, /takeOver[\s\S]{0,800}?connect\s*\(\s*\)/);
  // Banner must wire a click listener on its own button onto takeOver.
  assert.match(html, /addEventListener\(\s*["']click["']\s*,\s*takeOver\s*\)/);
  // Banner text in terminal states must NOT instruct the user to reload —
  // doing so would lead them into the 400 trap. Crude assertion: no
  // showBanner call inside the JS contains the substring "Reload".
  // (Comments mentioning Reload as the failure mode being avoided are OK.)
  const showBannerCalls = html.match(/showBanner\([^)]+\)/g) ?? [];
  for (const call of showBannerCalls) {
    assert.doesNotMatch(call, /Reload/i, `showBanner call must not instruct a reload: ${call}`);
  }
});
