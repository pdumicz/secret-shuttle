// src/daemon/services.ts
import { ApprovalStore } from "./approvals/store.js";
import { LockedVaultState } from "../vault/locked-state.js";
import { Vault } from "../vault/vault.js";
import { DaemonBlindModeState } from "./services-blind.js";
import type { BrowserOps } from "./chrome/internal-ops.js";
import { randomUUID } from "node:crypto";

export interface UnlockSession {
  id: string;
  ui_token: string;
  status: "pending" | "unlocked" | "failed" | "expired";
  message?: string;
  expires_at: number;
}

export class UnlockSessions {
  private readonly map = new Map<string, UnlockSession>();
  create(): UnlockSession {
    const id = randomUUID();
    const s: UnlockSession = {
      id,
      ui_token: randomUUID(),
      status: "pending",
      expires_at: Date.now() + 5 * 60 * 1000,
    };
    this.map.set(id, s);
    return s;
  }
  get(id: string): UnlockSession | undefined {
    return this.map.get(id);
  }
}

export class DaemonServices {
  readonly lock = new LockedVaultState();
  readonly vault = new Vault(() => this.lock.requireKey());
  readonly approvals = new ApprovalStore();
  readonly blind = new DaemonBlindModeState();
  readonly unlockSessions = new UnlockSessions();
  browser: BrowserOps | null = null;
  browserSessionId: string | null = null;
}
