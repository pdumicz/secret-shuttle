// src/daemon/hub/route-helpers.ts
import type { DaemonServices } from "../services.js";

/**
 * Build the `openUrlImpl` callback that `requireApproval` (and any
 * direct call site) hands to the hub. The closure captures `services`
 * and a port-ref thunk so the same factory works across daemon
 * restarts (port may shift).
 */
export function makeHubOpenUrlImpl(
  services: DaemonServices,
  daemonPortRef: () => number,
): (url: string) => void {
  return (url: string) => {
    services.hubBroker.surface(url, daemonPortRef());
  };
}
