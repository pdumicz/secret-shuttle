// src/daemon/api/routes/status.ts
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerStatus(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("GET", "/v1/status", () => ({
    unlocked: services.lock.isUnlocked(),
    blind_mode: services.blind.current(),
    version: 2,
  }));
}
