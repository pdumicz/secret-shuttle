import { randomUUID } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import {
  assertSessionPatternValid,
  PENDING_TTL_MS,
  type SessionGrant,
  type SessionPattern,
} from "./session.js";

export interface SessionStoreOptions {
  now?: () => number;
}

export class SessionStore {
  private readonly grants = new Map<string, SessionGrant>();
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  create(pattern: SessionPattern): SessionGrant {
    assertSessionPatternValid(pattern);
    const created = this.now();
    const grant: SessionGrant = {
      ...pattern,
      id: randomUUID(),
      ui_token: randomUUID(),
      status: "pending",
      created_at: created,
      approved_at: null,
      expires_at: created + PENDING_TTL_MS, // PENDING window; reset on approve
      uses: 0,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /**
   * Returns the grant for `id`, transitioning ANY non-terminal status to
   * "expired" when now > expires_at. Critical: this includes "granted" —
   * a granted session that has reached its TTL is no longer valid.
   */
  get(id: string): SessionGrant | undefined {
    const g = this.grants.get(id);
    if (g === undefined) return undefined;
    if ((g.status === "pending" || g.status === "granted") && this.now() > g.expires_at) {
      g.status = "expired";
    }
    return g;
  }

  approve(id: string): void {
    const g = this.requirePending(id);
    const now = this.now();
    g.status = "granted";
    g.approved_at = now;
    // Reset expires_at: TTL is anchored at APPROVAL time, not creation.
    g.expires_at = now + g.ttl_ms;
  }

  deny(id: string): void {
    const g = this.requirePending(id);
    g.status = "denied";
  }

  revoke(id: string): void {
    // Don't go through get() — we want to revoke even if expired.
    const g = this.grants.get(id);
    if (g === undefined) throw new ShuttleError("session_not_found", "Unknown session id.");
    g.status = "revoked";
  }

  list(): readonly SessionGrant[] {
    // Normalize expiry on each grant before returning. Without this, expired-
    // but-untouched sessions would still display as pending or granted in the
    // list endpoint (P2 fix from round-2 review).
    const now = this.now();
    const result: SessionGrant[] = [];
    for (const g of this.grants.values()) {
      if ((g.status === "pending" || g.status === "granted") && now > g.expires_at) {
        g.status = "expired";
      }
      result.push(g);
    }
    return result;
  }

  /**
   * Bump the use counter for a granted session. Throws:
   * - session_not_found if the session doesn't exist or was revoked.
   * - session_expired if the granted session is past its expires_at.
   * - session_not_pending if the session is pending/denied (use was attempted before approval or after denial).
   * - session_max_uses_exceeded if max_uses is set and we'd cross it.
   */
  incrementUses(id: string): void {
    const g = this.get(id); // flips granted → expired if past TTL
    if (g === undefined) throw new ShuttleError("session_not_found", "Unknown session id.");
    if (g.status === "revoked") {
      throw new ShuttleError("session_not_found", "Session was revoked.");
    }
    if (g.status === "expired") {
      throw new ShuttleError("session_expired", "Session has expired.");
    }
    if (g.status !== "granted") {
      throw new ShuttleError(
        "session_not_pending",
        `Session is not granted (status: ${g.status}).`,
      );
    }
    if (g.max_uses !== undefined && g.uses >= g.max_uses) {
      throw new ShuttleError(
        "session_max_uses_exceeded",
        `Session ${id} reached its max_uses cap of ${g.max_uses}.`,
      );
    }
    g.uses += 1;
  }

  private requirePending(id: string): SessionGrant {
    const g = this.get(id);
    if (g === undefined) throw new ShuttleError("session_not_found", "Unknown session id.");
    if (g.status !== "pending") {
      throw new ShuttleError(
        "session_not_pending",
        `Session is not pending (status: ${g.status}).`,
      );
    }
    return g;
  }
}
