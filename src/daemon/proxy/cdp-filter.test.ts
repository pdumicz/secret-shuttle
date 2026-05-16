import assert from "node:assert/strict";
import test from "node:test";
import { isMethodAllowed } from "./cdp-filter.js";

test("blind mode OFF: everything is allowed", () => {
  for (const m of [
    "Page.navigate", "Page.captureScreenshot", "DOM.getDocument",
    "Runtime.evaluate", "Network.getCookies", "Target.createTarget",
    "Page.frameNavigated", "SomeFuture.method",
  ]) {
    assert.equal(isMethodAllowed(m, false), true);
  }
});

test("blind mode ON: total blackout, nothing is allowed (commands)", () => {
  for (const m of [
    "Page.navigate", "Page.reload", "Target.attachToTarget",
    "Target.createTarget", "Input.dispatchKeyEvent", "Input.insertText",
  ]) {
    assert.equal(isMethodAllowed(m, true), false);
  }
});

test("blind mode ON: total blackout, nothing is allowed (events)", () => {
  for (const m of [
    "Page.frameNavigated", "Page.loadEventFired", "Page.lifecycleEvent",
    "Page.javascriptDialogOpening", "Page.windowOpen",
    "Target.targetCreated", "Target.targetInfoChanged",
  ]) {
    assert.equal(isMethodAllowed(m, true), false);
  }
});

test("blind mode ON: observation/exfiltration methods are blocked (regression)", () => {
  for (const m of [
    "Page.captureScreenshot", "DOM.getDocument", "Accessibility.getFullAXTree",
    "Runtime.evaluate", "Console.enable", "Log.entryAdded",
    "Network.getResponseBody", "Network.getCookies", "Fetch.getResponseBody",
    "Page.getResourceContent", "Page.startScreencast", "Profiler.enable",
  ]) {
    assert.equal(isMethodAllowed(m, true), false);
  }
});
