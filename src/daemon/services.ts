// src/daemon/services.ts
import { ApprovalStore } from "./approvals/store.js";
import { LockedVaultState } from "../vault/locked-state.js";
import { Vault } from "../vault/vault.js";
import { DaemonBlindModeState } from "./services-blind.js";
import type { BrowserOps } from "./chrome/internal-ops.js";

export class DaemonServices {
  readonly lock = new LockedVaultState();
  readonly vault = new Vault(() => this.lock.requireKey());
  readonly approvals = new ApprovalStore();
  readonly blind = new DaemonBlindModeState();
  browser: BrowserOps | null = null;
  browserSessionId: string | null = null;
}
