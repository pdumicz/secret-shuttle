// src/daemon/services.ts
import { ApprovalStore } from "./approvals/store.js";
import { SessionStore } from "./approvals/session-store.js";
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
import { getShuttlePaths } from "../shared/config.js";
import { HubBroker } from "./hub/hub-broker.js";
import { openUrl } from "./approvals/open-url.js";
import type { KeychainAdapter } from "../vault/keychain/types.js";

export interface UnlockSession {
  id: string;
  ui_token: string;
  status: "pending" | "unlocked" | "failed" | "expired";
  message?: string;
  expires_at: number;
  /** P1 post-ship: when true, C2 opportunistic keychain enrollment is suppressed for this session. */
  skip_keychain?: boolean;
}

export class UnlockSessions {
  private readonly map = new Map<string, UnlockSession>();
  create(opts: { skip_keychain?: boolean } = {}): UnlockSession {
    const id = randomUUID();
    const s: UnlockSession = {
      id,
      ui_token: randomUUID(),
      status: "pending",
      expires_at: Date.now() + 5 * 60 * 1000,
      ...(opts.skip_keychain === true ? { skip_keychain: true } : {}),
    };
    this.map.set(id, s);
    return s;
  }
  get(id: string): UnlockSession | undefined {
    return this.map.get(id);
  }
}

export interface DaemonServicesOptions {
  hubBroker?: HubBroker;
  /**
   * Override the `openUrlImpl` used when constructing the DEFAULT
   * HubBroker. This is the hook tests use to prove the default
   * constructor path — without this, the only way to inject a spy
   * would be to construct a HubBroker entirely outside DaemonServices,
   * which doesn't actually exercise the default wiring. Ignored when
   * `hubBroker` is provided.
   */
  hubOpenUrlImpl?: (url: string) => void;
}

export class DaemonServices {
  readonly lock = new LockedVaultState();
  readonly tmpDir: string = getShuttlePaths().daemonTmpPath;
  sweepTimer: NodeJS.Timeout | null = null;
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
          e.kind === "cancelled" ? "approval_cancelled" :
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
  readonly sessionStore = new SessionStore();
  browser: BrowserOps | null = null;
  browserSessionId: string | null = null;
  /** Internal CDP client for the running Chrome process; null before browser start. */
  cdp: CdpClient | null = null;
  cdpProxy: ProxyServer | null = null;
  readonly hubBroker: HubBroker;
  /**
   * Test-only override for the OS keychain adapter.
   * Production leaves this undefined and unlock-session.ts falls back to
   * `getKeychainAdapter()` (the platform-detected real adapter).
   */
  keychain?: KeychainAdapter;

  constructor(opts: DaemonServicesOptions = {}) {
    // Production: real openUrl (which honors SECRET_SHUTTLE_NO_OPEN_URL=1
    // as a no-op for tests). The hubOpenUrlImpl hook lets tests prove
    // this very wiring without bypassing it. Without the explicit
    // `openUrl` here, the broker would queue URLs internally and never
    // open a tab — silently broken in prod.
    this.hubBroker =
      opts.hubBroker ??
      new HubBroker({ openUrlImpl: opts.hubOpenUrlImpl ?? openUrl });
  }
}
