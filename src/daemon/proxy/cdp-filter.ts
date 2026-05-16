/**
 * CDP method/event filter for the agent-facing proxy.
 *
 * - Blind mode OFF: allow everything (Chrome behaves normally for the agent).
 * - Blind mode ON: TOTAL BLACKOUT. Forward nothing in either direction.
 *
 * Rationale: while a secret is on screen the agent has no legitimate use for the
 * CDP proxy. `blind start` / `secrets.capture` / `secrets.inject` / `blind end`
 * are HTTP calls; daemon-internal capture/injection runs over the daemon's own
 * CDP connection, never this proxy. Allowing even "navigation" lets an agent run
 * `Page.navigate({url:"javascript:..."})` to exfiltrate the visible secret, and
 * allowing "lifecycle events" leaks URL/title/dialog/window-name payloads. The
 * only safe rule during the blind window is: pass nothing.
 *
 * Used in both directions (inbound agent->Chrome method calls, outbound
 * Chrome->agent events). The same rule applies to both.
 */
export function isMethodAllowed(_method: string, blindModeActive: boolean): boolean {
  return !blindModeActive;
}
