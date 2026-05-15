import assert from "node:assert/strict";
import test from "node:test";
import { isMethodAllowed } from "./cdp-filter.js";

test("non-blind mode allows everything", () => {
  assert.equal(isMethodAllowed("Page.navigate", false), true);
  assert.equal(isMethodAllowed("Page.captureScreenshot", false), true);
  assert.equal(isMethodAllowed("DOM.getDocument", false), true);
  assert.equal(isMethodAllowed("Runtime.evaluate", false), true);
  assert.equal(isMethodAllowed("Network.getCookies", false), true);
});

test("blind mode allows navigation primitives", () => {
  assert.equal(isMethodAllowed("Page.navigate", true), true);
  assert.equal(isMethodAllowed("Page.reload", true), true);
  assert.equal(isMethodAllowed("Target.attachToTarget", true), true);
  assert.equal(isMethodAllowed("Input.dispatchKeyEvent", true), true);
  assert.equal(isMethodAllowed("Input.dispatchMouseEvent", true), true);
});

test("blind mode allows lifecycle/navigation events", () => {
  assert.equal(isMethodAllowed("Page.frameNavigated", true), true);
  assert.equal(isMethodAllowed("Page.loadEventFired", true), true);
  assert.equal(isMethodAllowed("Target.targetCreated", true), true);
});

test("blind mode blocks observation methods (denylist regression)", () => {
  assert.equal(isMethodAllowed("Page.captureScreenshot", true), false);
  assert.equal(isMethodAllowed("Page.captureSnapshot", true), false);
  assert.equal(isMethodAllowed("Page.printToPDF", true), false);
  assert.equal(isMethodAllowed("DOM.getDocument", true), false);
  assert.equal(isMethodAllowed("DOM.getOuterHTML", true), false);
  assert.equal(isMethodAllowed("Accessibility.getFullAXTree", true), false);
  assert.equal(isMethodAllowed("Runtime.evaluate", true), false);
  assert.equal(isMethodAllowed("Runtime.callFunctionOn", true), false);
  assert.equal(isMethodAllowed("Console.enable", true), false);
  assert.equal(isMethodAllowed("Log.entryAdded", true), false);
  assert.equal(isMethodAllowed("Network.getResponseBody", true), false);
  assert.equal(isMethodAllowed("Fetch.getResponseBody", true), false);
  assert.equal(isMethodAllowed("Page.startScreencast", true), false);
  assert.equal(isMethodAllowed("Profiler.enable", true), false);
  assert.equal(isMethodAllowed("HeapProfiler.startSampling", true), false);
  assert.equal(isMethodAllowed("Tracing.start", true), false);
});

test("blind mode blocks previously-missed read APIs (Network.getCookies, Page.getResourceContent, etc.)", () => {
  assert.equal(isMethodAllowed("Network.getCookies", true), false);
  assert.equal(isMethodAllowed("Network.getAllCookies", true), false);
  assert.equal(isMethodAllowed("Page.getResourceContent", true), false);
  assert.equal(isMethodAllowed("Page.getResourceTree", true), false);
  assert.equal(isMethodAllowed("Page.getFrameTree", true), false);
  assert.equal(isMethodAllowed("Page.getNavigationHistory", true), false);
  assert.equal(isMethodAllowed("Fetch.takeResponseBodyAsStream", true), false);
  assert.equal(isMethodAllowed("Fetch.continueRequest", true), false);
  assert.equal(isMethodAllowed("Storage.getCookies", true), false);
  assert.equal(isMethodAllowed("DOMSnapshot.captureSnapshot", true), false);
  // Unknown / future methods are denied by default.
  assert.equal(isMethodAllowed("SomeFutureDomain.somethingExotic", true), false);
});

test("blind mode denies anything not explicitly allowlisted (default-deny)", () => {
  assert.equal(isMethodAllowed("CSS.getStyleSheetText", true), false);
  assert.equal(isMethodAllowed("Animation.getCurrentTime", true), false);
  assert.equal(isMethodAllowed("WebAudio.getRealtimeData", true), false);
});
