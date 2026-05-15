// Blocked prefixes apply to both client→Chrome commands and Chrome→client events.
// Event names follow the same "Domain.eventName" shape as method names, so the same
// prefix check covers both.  Add entries here once; isMethodAllowed is the single
// source of truth for the inbound filter (cdp-proxy agent→Chrome) and the outbound
// filter (cdp-proxy Chrome→agent).
const BLIND_BLOCKED_PREFIXES = [
  // Page rendering / capture
  "Page.captureScreenshot",
  "Page.captureSnapshot",
  "Page.printToPDF",
  "Page.startScreencast",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
  // DOM inspection
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "DOM.getFlattenedDocument",
  "DOM.getNodeForLocation",
  "DOM.performSearch",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeStackTraces",
  "DOM.resolveNode",
  "DOM.requestChildNodes",
  "DOMSnapshot",
  // Accessibility tree
  "Accessibility",
  // Runtime / scripting
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.queryObjects",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Runtime.bindingCalled",
  // Console / log streams
  "Console",
  "Log",
  // Network observation
  "Network.getResponseBody",
  "Network.getRequestPostData",
  "Network.takeResponseBodyForInterceptionAsStream",
  "Network.responseReceived",
  "Network.dataReceived",
  "Network.responseReceivedExtraInfo",
  "Network.requestWillBeSentExtraInfo",
  "Fetch.getResponseBody",
  // Tracing / profiler streams that can leak page content
  "Tracing",
  "Profiler",
  "HeapProfiler",
  // Generic IO
  "IO.read",
  // Storage readbacks
  "Storage.getCookies",
  "Storage.getStorageKeyForFrame",
  "Storage.getTrustTokens",
  "Storage.getInterestGroupDetails",
  "IndexedDB.requestData",
  "IndexedDB.getMetadata",
  "Database.executeSQL",
  "DOMStorage.getDOMStorageItems",
];

export function isMethodAllowed(method: string, blindModeActive: boolean): boolean {
  if (!blindModeActive) return true;
  for (const prefix of BLIND_BLOCKED_PREFIXES) {
    if (method === prefix || method.startsWith(`${prefix}.`)) return false;
  }
  return true;
}
