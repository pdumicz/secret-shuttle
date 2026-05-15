// src/daemon/api/router.ts
import type { DaemonServer } from "../server.js";
import type { DaemonServices } from "../services.js";

export function registerRoutes(
  server: DaemonServer,
  services: DaemonServices,
  _daemonPortRef: () => number,
): void {
  server.addRoute("GET", "/v1/status", () => ({
    unlocked: services.lock.isUnlocked(),
    blind_mode: services.blind.current(),
    version: 2,
  }));
}
