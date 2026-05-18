// src/daemon/services.ts
import { ApprovalStore } from "./approvals/store.js";
import { LockedVaultState } from "../vault/locked-state.js";
import { Vault } from "../vault/vault.js";
import { DaemonBlindModeState } from "./services-blind.js";
import { BrowserHandleStore } from "./browser-handles.js";
import { RateLimiter } from "./rate-limit.js";
import type { BrowserOps } from "./chrome/internal-ops.js";
import type { CdpClient } from "./chrome/cdp-client.js";
import type { ProxyServer } from "./proxy/cdp-proxy.js";
import { randomUUID } from "node:crypto";
import { writeDaemonAudit } from "./audit.js";

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
  readonly approvals = new ApprovalStore({
    onEvent: (e) => {
      void writeDaemonAudit({
        action:
          e.kind === "created" ? "approval_created" :
          e.kind === "granted" ? "approval_granted" :
          e.kind === "denied" ? "approval_denied" :
          e.kind === "expired" ? "approval_expired" :
          e.kind === "used" ? "approval_used" :
          "approval_mismatch",
        ok: e.kind === "granted" || e.kind === "used" || e.kind === "created",
        approval_id: e.kind === "mismatch" ? e.existingGrant.id : e.grant.id,
        ...(e.kind === "mismatch" ? {
          ...(e.binding.ref !== null && e.binding.ref !== undefined ? { ref: e.binding.ref } : {}),
          environment: e.binding.environment,
        } : {
          ...(e.grant.ref !== null && e.grant.ref !== undefined ? { ref: e.grant.ref } : {}),
          environment: e.grant.environment,
          ...(e.grant.template_id !== null && e.grant.template_id !== undefined ? { template_id: e.grant.template_id } : {}),
          ...(e.grant.destination_domain !== null && e.grant.destination_domain !== undefined ? { domain: e.grant.destination_domain } : {}),
        }),
      });
    },
  });
  readonly blind = new DaemonBlindModeState();
  readonly handles = new BrowserHandleStore();
  readonly compareLimiter = new RateLimiter(5, 60_000);
  readonly unlockSessions = new UnlockSessions();
  browser: BrowserOps | null = null;
  browserSessionId: string | null = null;
  /** Internal CDP client for the running Chrome process; null before browser start. */
  cdp: CdpClient | null = null;
  cdpProxy: ProxyServer | null = null;
}
