const BLIND_BLOCKED_PREFIXES = [
  "Page.captureScreenshot",
  "Page.captureSnapshot",
  "Page.printToPDF",
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "DOM.getFlattenedDocument",
  "DOM.getNodeForLocation",
  "DOM.performSearch",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.describeNode",
  "DOMSnapshot",
  "Accessibility",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.queryObjects",
  "Console",
  "Log",
  "Network.getResponseBody",
  "Network.getRequestPostData",
  "Network.takeResponseBodyForInterceptionAsStream",
  "Fetch.getResponseBody",
];

export function isMethodAllowed(method: string, blindModeActive: boolean): boolean {
  if (!blindModeActive) return true;
  for (const prefix of BLIND_BLOCKED_PREFIXES) {
    if (method === prefix || method.startsWith(`${prefix}.`)) return false;
  }
  return true;
}
