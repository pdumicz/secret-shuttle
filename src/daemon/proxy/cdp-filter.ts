/**
 * CDP method filter for blind mode.
 *
 * - When blind mode is OFF: allow everything (Chrome behaves normally for the agent).
 * - When blind mode is ON: default-deny. Only the small allowlist below is forwarded
 *   in either direction. The agent has no legitimate need to observe the page during
 *   the brief blind window — daemon-internal capture/inject runs through its own
 *   CDP connection, not the proxy.
 *
 * The allowlist permits navigation primitives (so the agent can move between pages
 * across blind windows without reconnecting) and Chrome's own lifecycle events
 * (so the agent's view of navigation/target state stays coherent). It does NOT
 * permit any read of DOM, accessibility, runtime state, console, log, network
 * bodies/cookies/resources, screencast, profiler, or storage.
 *
 * This function is used in both directions:
 *   - inbound (agent → Chrome): the method the agent wants to call
 *   - outbound (Chrome → agent): the event name Chrome is emitting
 * The same allowlist applies to both.
 */
const BLIND_ALLOWED_METHODS = new Set<string>([
  // Navigation commands the agent might legitimately need.
  "Page.navigate",
  "Page.reload",
  "Page.bringToFront",
  "Page.handleJavaScriptDialog",
  "Page.close",
  // Target management.
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.createTarget",
  // Input — kept so an agent can still click safe (non-secret) navigation buttons
  // during blind mode. The user-visible approval still gates value-handling.
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  // Lifecycle and navigation events the agent listens to.
  "Page.frameNavigated",
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.lifecycleEvent",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.windowOpen",
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Target.targetCrashed",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
]);

export function isMethodAllowed(method: string, blindModeActive: boolean): boolean {
  if (!blindModeActive) return true;
  return BLIND_ALLOWED_METHODS.has(method);
}
