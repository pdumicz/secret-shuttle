import assert from "node:assert/strict";
import test from "node:test";
import { isMethodAllowed } from "./cdp-filter.js";

test("normal mode allows navigation and reads", () => {
  assert.equal(isMethodAllowed("Page.navigate", false), true);
  assert.equal(isMethodAllowed("Page.captureScreenshot", false), true);
  assert.equal(isMethodAllowed("DOM.getDocument", false), true);
  assert.equal(isMethodAllowed("Runtime.evaluate", false), true);
});

test("blind mode blocks observation methods", () => {
  assert.equal(isMethodAllowed("Page.captureScreenshot", true), false);
  assert.equal(isMethodAllowed("Page.captureSnapshot", true), false);
  assert.equal(isMethodAllowed("DOM.getDocument", true), false);
  assert.equal(isMethodAllowed("DOM.getOuterHTML", true), false);
  assert.equal(isMethodAllowed("Accessibility.getFullAXTree", true), false);
  assert.equal(isMethodAllowed("Runtime.evaluate", true), false);
  assert.equal(isMethodAllowed("Runtime.callFunctionOn", true), false);
  assert.equal(isMethodAllowed("Console.enable", true), false);
  assert.equal(isMethodAllowed("Log.entryAdded", true), false);
  assert.equal(isMethodAllowed("Network.getResponseBody", true), false);
  assert.equal(isMethodAllowed("Fetch.getResponseBody", true), false);
});

test("blind mode allows navigation primitives", () => {
  assert.equal(isMethodAllowed("Page.navigate", true), true);
  assert.equal(isMethodAllowed("Page.reload", true), true);
  assert.equal(isMethodAllowed("Target.attachToTarget", true), true);
  assert.equal(isMethodAllowed("Input.dispatchKeyEvent", true), true);
});

test("blind mode blocks Page.startScreencast and screencast events", () => {
  assert.equal(isMethodAllowed("Page.startScreencast", true), false);
  assert.equal(isMethodAllowed("Page.screencastFrame", true), false);
  assert.equal(isMethodAllowed("Page.screencastVisibilityChanged", true), false);
});

test("blind mode blocks Runtime event streams", () => {
  assert.equal(isMethodAllowed("Runtime.consoleAPICalled", true), false);
  assert.equal(isMethodAllowed("Runtime.exceptionThrown", true), false);
  assert.equal(isMethodAllowed("Runtime.bindingCalled", true), false);
});

test("blind mode blocks Profiler / HeapProfiler / Tracing", () => {
  assert.equal(isMethodAllowed("Profiler.enable", true), false);
  assert.equal(isMethodAllowed("HeapProfiler.startSampling", true), false);
  assert.equal(isMethodAllowed("Tracing.start", true), false);
});

test("blind mode blocks Network event streams + body reads", () => {
  assert.equal(isMethodAllowed("Network.responseReceived", true), false);
  assert.equal(isMethodAllowed("Network.dataReceived", true), false);
  assert.equal(isMethodAllowed("Fetch.getResponseBody", true), false);
});

test("blind mode blocks Storage / IndexedDB / DOMStorage readbacks", () => {
  assert.equal(isMethodAllowed("Storage.getCookies", true), false);
  assert.equal(isMethodAllowed("IndexedDB.requestData", true), false);
  assert.equal(isMethodAllowed("DOMStorage.getDOMStorageItems", true), false);
});
