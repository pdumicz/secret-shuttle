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
import { ShuttleError } from "../shared/errors.js";

/**
 * A lease handle returned by reserveBootstrapBrowser. Opaque to callers —
 * pass it back to releaseBootstrapBrowser to clear the reservation. Two
 * reservations from the same batch produce DIFFERENT leases (in practice
 * the second one throws bootstrap_batch_busy), so a stale release from a
 * duplicate /continue cannot clear an active lease held by the original.
 *
 * The `handle` is a monotonically-increasing counter from DaemonServices —
 * it is unique within a single daemon process. Across process restarts the
 * counter resets, but reservations don't persist across restarts either,
 * so the invariant ("only the exact lease that holds the slot can release
 * it") holds end-to-end.
 */
export interface BootstrapBrowserLease {
  readonly batchId: string;
  readonly handle: number;
}

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
      // Audit attribution: pass the persisted grant's owner_agent_id explicitly.
      // Raw UI routes (/ui/approvals/:id/approve, etc.) have no ALS context, so
      // writeDaemonAudit's auto-stamp would otherwise fall back to "daemon".
      // The grant's owner is the right attribution for every lifecycle event:
      // it was stamped at create-time from the minter's ALS (A8) and that
      // identity owns the entire lifecycle.
      const ownerAgentId = e.kind === "mismatch" ? e.existingGrant.owner_agent_id : e.grant.owner_agent_id;
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
        actor_agent_id: ownerAgentId,
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

  /**
   * Synchronous reservation tracker for the bootstrap-owned daemon browser.
   * Set by reserveBootstrapBrowser(batchId) BEFORE any async work begins. Two
   * concurrent capture /continue calls would otherwise both pass the
   * pre-approval guard (which only inspects browserSession), both consume
   * their approvals, and both then race into ensureBootstrapBrowser. This
   * reservation closes that race window — synchronous claim BEFORE
   * requireApprovals.
   *
   * Lease shape: { batchId, handle } where handle is a unique counter value
   * issued at reserve-time. releaseBootstrapBrowser is handle-guarded so a
   * stale release from a duplicate /continue (which fast-failed with
   * bootstrap_batch_busy and never got its own lease) cannot clear the
   * active lease held by the original /continue.
   *
   * States:
   *  - null: no batch holds the resource
   *  - { batchId, handle }: held by this lease (either spawning or spawned)
   *
   * Cleared by releaseBootstrapBrowser(lease) — typically in the /continue
   * outer finally, after stopBootstrapBrowser (or skipping if user-owned).
   */
  private bootstrapBrowserReservation: BootstrapBrowserLease | null = null;

  /**
   * Monotonically-increasing counter used to issue unique lease handles.
   * Process-local; resets on daemon restart (which also clears any in-flight
   * reservations, so the uniqueness invariant holds end-to-end).
   */
  private nextReservationHandle = 1;

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
   * Synchronously reserve the bootstrap browser slot. Returns a lease that
   * MUST be passed to releaseBootstrapBrowser to clear the slot.
   *
   * Throws `bootstrap_browser_busy` when a DIFFERENT batch already owns or
   * holds the slot.
   *
   * Throws `bootstrap_batch_busy` when the SAME batch already holds a lease
   * — i.e. a concurrent same-batch /continue. This mirrors the per-batch
   * execution lock model: the executor is already serialized via
   * bootstrapStore.tryAcquireExecutionLock, and we serialize the
   * approval-and-spawn phase here so the lease is never held twice for a
   * single batch. (If we silently re-reserved instead, two same-batch
   * /continue calls would produce a "lease" that points to the original's
   * cycle — and any release from the duplicate would then clear the
   * original's reservation, reopening the cross-batch race.)
   *
   * Pair with `releaseBootstrapBrowser(lease)` in an outer finally. The
   * lease handle is unique, so a stale release from a duplicate /continue
   * (which fast-failed with bootstrap_batch_busy and never got its own
   * lease — passes null to the finally) cannot clear an active lease.
   *
   * Call BEFORE requireApprovals in /continue so the approval is preserved
   * across cross-batch collisions: the synchronous throw happens BEFORE any
   * await, so a losing batch fails BEFORE its approval is consumed.
   */
  reserveBootstrapBrowser(batchId: string): BootstrapBrowserLease {
    // If the slot is held by an active (already-spawned) bootstrap session for
    // a different batch, that's the existing-session collision — same error.
    if (
      this.browserSession?.owner.kind === "bootstrap" &&
      this.browserSession.owner.batchId !== batchId
    ) {
      throw new ShuttleError(
        "bootstrap_browser_busy",
        `Another bootstrap batch (${this.browserSession.owner.batchId}) is already driving the daemon-owned browser. Retry after that batch completes.`,
      );
    }
    // Any active reservation blocks. Same-batch is bootstrap_batch_busy
    // (concurrent /continue on the same batch — serialize at the reservation
    // layer, symmetric with the per-batch execution lock); different-batch
    // is bootstrap_browser_busy.
    if (this.bootstrapBrowserReservation !== null) {
      const other = this.bootstrapBrowserReservation.batchId;
      if (other === batchId) {
        throw new ShuttleError(
          "bootstrap_batch_busy",
          `Batch ${batchId} is already being processed; wait for the current /continue to finish before retrying.`,
        );
      }
      throw new ShuttleError(
        "bootstrap_browser_busy",
        `Another bootstrap batch (${other}) is reserving the daemon-owned browser. Retry after that batch completes.`,
      );
    }
    const lease: BootstrapBrowserLease = { batchId, handle: this.nextReservationHandle++ };
    this.bootstrapBrowserReservation = lease;
    return lease;
  }

  /**
   * Release a previously-issued lease. Handle-guarded: clears the reservation
   * only if THIS exact lease still owns it. A stale release (e.g. a duplicate
   * /continue that fast-failed before the original spawn finished) is a
   * silent no-op — the original's lease is preserved.
   *
   * Idempotent (calling twice with the same lease is a no-op on the second
   * call), and safe to call on a path where no reservation was made (the
   * caller passes null and skips the call, but the function itself would
   * also no-op on a stale lease).
   */
  releaseBootstrapBrowser(lease: BootstrapBrowserLease): void {
    if (
      this.bootstrapBrowserReservation !== null &&
      this.bootstrapBrowserReservation.handle === lease.handle
    ) {
      this.bootstrapBrowserReservation = null;
    }
  }

  /**
   * Ensure a BrowserSession exists for the duration of a bootstrap batch.
   *
   * - If a user-owned session already exists, return it unchanged.
   *   A pre-existing user session is never overwritten or re-owned: a user who
   *   has `browser start`ed gets to keep their session, and the outer
   *   `/continue` finally must NOT stop it.
   * - If a bootstrap-owned session for the SAME batchId already exists,
   *   return it (idempotent reuse — repeated /continue calls within the same
   *   batch are safe).
   * - If a bootstrap-owned session for a DIFFERENT batchId already exists,
   *   throw `bootstrap_browser_busy`. Two concurrent bootstrap batches must
   *   not share Chrome: batch A's `stopBootstrapBrowser` would tear down the
   *   shared session out from under batch B mid-capture, racing the proxy and
   *   crashing in-flight CDP traffic.
   * - If no session exists, spawn one with `owner = { kind: "bootstrap", batchId }`.
   *   The owner tag is what `stopBootstrapBrowser` checks to decide whether it
   *   may kill the session — see `stopBootstrapBrowser` below.
   *
   * Defense-in-depth: also honors `bootstrapBrowserReservation` — if a
   * different batch holds the reservation, throw immediately. /continue is
   * expected to have called `reserveBootstrapBrowser(batchId)` already, so
   * this check is the fallback for callers that forget.
   */
  async ensureBootstrapBrowser(batchId: string): Promise<BrowserSession> {
    // Defense-in-depth: respect a reservation held by a different batch.
    // /continue should have reserved already, but if some other path calls
    // ensureBootstrapBrowser without reserving first, refuse to spawn into
    // a slot another batch is mid-claim on.
    if (
      this.bootstrapBrowserReservation !== null &&
      this.bootstrapBrowserReservation.batchId !== batchId
    ) {
      throw new ShuttleError(
        "bootstrap_browser_busy",
        `Another bootstrap batch (${this.bootstrapBrowserReservation.batchId}) holds the browser reservation. Retry after that batch completes.`,
      );
    }
    if (this.browserSession !== null) {
      // User-owned: reuse unchanged.
      if (this.browserSession.owner.kind === "user") {
        return this.browserSession;
      }
      // Bootstrap-owned with the SAME batchId: idempotent reuse.
      if (this.browserSession.owner.batchId === batchId) {
        return this.browserSession;
      }
      // Bootstrap-owned by a DIFFERENT batch: globally serialize.
      throw new ShuttleError(
        "bootstrap_browser_busy",
        `Another bootstrap batch (${this.browserSession.owner.batchId}) is already driving the daemon-owned browser. Retry after that batch completes.`,
      );
    }
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
