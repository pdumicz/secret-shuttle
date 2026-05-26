// src/daemon/services.ts
import path from "node:path";
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
import { BootstrapStore } from "./bootstrap/store.js";
import { createBrowserSession as createBrowserSessionReal } from "./bootstrap/browser-session.js";
import type { BrowserSession, BrowserSessionChild } from "./bootstrap/browser-session.js";
import { PendingCapturesRegistry } from "./bootstrap/pending-captures.js";
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
  /**
   * Test-only injection point for the BrowserSession factory used by
   * `ensureBootstrapBrowser`. Production leaves this undefined and
   * the real `createBrowserSession` (which spawns Chrome) is used.
   * Tests pass a stub that returns a hand-rolled BrowserSession so
   * the ownership/reuse behavior can be exercised without launching
   * a real browser.
   */
  createBrowserSessionImpl?: typeof createBrowserSessionReal;
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
  readonly bootstrapStore = new BootstrapStore({
    rootDir: path.join(getShuttlePaths().homeDir, "bootstrap-batches"),
  });
  readonly pendingCaptures = new PendingCapturesRegistry();
  /**
   * Unified BrowserSession — source of truth. Production code constructs this
   * via `createBrowserSession()` (see bootstrap/browser-session.ts). The four
   * accessors below (`browser`, `browserSessionId`, `cdp`, `cdpProxy`) expose
   * the legacy field surfaces backed by this object.
   */
  browserSession: BrowserSession | null = null;

  /**
   * Compatibility accessors backing the unified `browserSession` field. Production
   * code (`/v1/browser/start`, `ensureBootstrapBrowser`) constructs browserSession
   * directly via createBrowserSession(). These accessors exist for test fixtures
   * and back-compat — setting one field composes the current session rather than
   * replacing it.
   */
  get browser(): BrowserOps | null {
    return this.browserSession?.browser ?? null;
  }
  set browser(v: BrowserOps | null) {
    if (v === null) { this.browserSession = null; return; }
    if (this.browserSession !== null) {
      this.browserSession.browser = v;
    } else {
      this.browserSession = {
        owner: { kind: "user" },
        child: null as unknown as BrowserSessionChild,
        cdp: null as unknown as CdpClient,
        proxy: null,
        browserSessionId: "test-stub",
        browser: v,
      };
    }
  }

  get cdp(): CdpClient | null {
    return this.browserSession?.cdp ?? null;
  }
  set cdp(v: CdpClient | null) {
    if (v === null) { this.browserSession = null; return; }
    if (this.browserSession !== null) {
      this.browserSession.cdp = v;
    } else {
      this.browserSession = {
        owner: { kind: "user" },
        child: null as unknown as BrowserSessionChild,
        cdp: v,
        proxy: null,
        browserSessionId: "test-stub",
        browser: null as unknown as BrowserOps,
      };
    }
  }

  get cdpProxy(): ProxyServer | null {
    return this.browserSession?.proxy ?? null;
  }
  set cdpProxy(v: ProxyServer | null) {
    if (v === null) {
      if (this.browserSession !== null) {
        this.browserSession.proxy = null;
      }
      return;
    }
    if (this.browserSession !== null) {
      this.browserSession.proxy = v;
    } else {
      this.browserSession = {
        owner: { kind: "user" },
        child: null as unknown as BrowserSessionChild,
        cdp: null as unknown as CdpClient,
        proxy: v,
        browserSessionId: "test-stub",
        browser: null as unknown as BrowserOps,
      };
    }
  }

  get browserSessionId(): string | null {
    return this.browserSession?.browserSessionId ?? null;
  }
  set browserSessionId(v: string | null) {
    if (v === null) {
      if (this.browserSession !== null) {
        this.browserSession.browserSessionId = "";
      }
      return;
    }
    if (this.browserSession !== null) {
      this.browserSession.browserSessionId = v;
    } else {
      this.browserSession = {
        owner: { kind: "user" },
        child: null as unknown as BrowserSessionChild,
        cdp: null as unknown as CdpClient,
        proxy: null,
        browserSessionId: v,
        browser: null as unknown as BrowserOps,
      };
    }
  }
  readonly hubBroker: HubBroker;
  /**
   * Test-only override for the OS keychain adapter.
   * Production leaves this undefined and unlock-session.ts falls back to
   * `getKeychainAdapter()` (the platform-detected real adapter).
   */
  keychain?: KeychainAdapter;

  /**
   * Factory used by `ensureBootstrapBrowser` to construct a BrowserSession.
   * Defaults to the real `createBrowserSession` (which spawns Chrome).
   * Tests inject a stub via DaemonServicesOptions.createBrowserSessionImpl.
   */
  private readonly createBrowserSessionImpl: typeof createBrowserSessionReal;

  constructor(opts: DaemonServicesOptions = {}) {
    // Production: real openUrl (which honors SECRET_SHUTTLE_NO_OPEN_URL=1
    // as a no-op for tests). The hubOpenUrlImpl hook lets tests prove
    // this very wiring without bypassing it. Without the explicit
    // `openUrl` here, the broker would queue URLs internally and never
    // open a tab — silently broken in prod.
    this.hubBroker =
      opts.hubBroker ??
      new HubBroker({ openUrlImpl: opts.hubOpenUrlImpl ?? openUrl });
    this.createBrowserSessionImpl = opts.createBrowserSessionImpl ?? createBrowserSessionReal;
  }

  /**
   * Ensure a BrowserSession exists for the duration of a bootstrap batch.
   *
   * - If a session is already present (any owner — user or another bootstrap),
   *   return it unchanged. Crucially, a pre-existing user session is never
   *   overwritten or re-owned: a user who has `browser start`ed gets to keep
   *   their session, and the outer `/continue` finally must NOT stop it.
   * - If no session exists, spawn one with `owner = { kind: "bootstrap", batchId }`.
   *   The owner tag is what `stopBootstrapBrowser` checks to decide whether it
   *   may kill the session — see `stopBootstrapBrowser` below.
   */
  async ensureBootstrapBrowser(batchId: string): Promise<BrowserSession> {
    if (this.browserSession !== null) return this.browserSession;
    this.browserSession = await this.createBrowserSessionImpl({
      profile: "bootstrap",
      blind: this.blind,
      owner: { kind: "bootstrap", batchId },
    });
    return this.browserSession;
  }

  /**
   * Stop the BrowserSession iff it is owned by the given bootstrap batch.
   *
   * Returns `{ stopped: true }` only when this call actually killed the
   * session. Returns `{ stopped: false }` when:
   *   - there is no session,
   *   - the session is user-owned (the user's `browser start` survives), or
   *   - the session is owned by a *different* batchId (idempotency guard:
   *     a stale finally from an aborted batch must not kill a fresh one).
   *
   * Cleanup order matches the documented teardown contract:
   *   proxy.close → cdp.close → child.kill(SIGTERM) → wait-or-SIGKILL after 3s.
   * The proxy is severed first so no in-flight agent CDP traffic races the
   * child exit; cdp.close then rejects pending sends; finally the child is
   * given 3s to exit cleanly before SIGKILL.
   */
  async stopBootstrapBrowser(batchId: string): Promise<{ stopped: boolean }> {
    const s = this.browserSession;
    if (s === null || s.owner.kind !== "bootstrap" || s.owner.batchId !== batchId) {
      return { stopped: false };
    }
    await s.proxy?.close().catch(() => undefined);
    await s.cdp.close().catch(() => undefined);
    s.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((r) => { s.child.once("exit", () => r()); }),
      new Promise<void>((r) => setTimeout(() => { s.child.kill("SIGKILL"); r(); }, 3000)),
    ]);
    this.browserSession = null;
    return { stopped: true };
  }
}
