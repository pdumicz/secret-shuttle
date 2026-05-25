import { randomUUID } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionStore } from "./session-store.js";

export type ApprovalLifecycleEvent =
  | { kind: "created"; grant: ApprovalGrant }
  | { kind: "granted"; grant: ApprovalGrant }
  | { kind: "denied"; grant: ApprovalGrant }
  | { kind: "expired"; grant: ApprovalGrant }
  | { kind: "used"; grant: ApprovalGrant }
  | { kind: "mismatch"; binding: ApprovalBinding; existingGrant: ApprovalGrant };

export interface ApprovalBinding {
  action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render";
  ref: string | null;
  planned_ref?: string | null;
  environment: string;
  destination_domain: string | null;
  target_id: string | null;
  field_fingerprint: string | null;
  template_id: string | null;
  template_params: Record<string, string> | null;
  template_binary_path?: string | null;
  template_binary_sha256?: string | null;
  allowed_domains?: string[] | null;
  /** Non-display: part of bindingsMatch (strict equality / stable set). */
  submit_fingerprint?: string | null;
  success_condition?: string | null;
  auto_resume?: boolean | null;
  reveal_fingerprint?: string | null;
  hide_fingerprint?: string | null;
  container_fingerprint?: string | null;
  capture_mode?: "field" | "container" | "focused-after-reveal" | null;
  /** The action scope the human approves (generate). Part of bindingsMatch as a stable set. */
  allowed_actions?: string[] | null;
  /** Display-only context for the human approver. NOT part of bindingsMatch. */
  page_title?: string | null;
  page_url_host?: string | null;
  field_handle_label?: string | null;
  submit_handle_label?: string | null;
  reveal_handle_label?: string | null;
  hide_handle_label?: string | null;
  container_handle_label?: string | null;
}

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired" | "used";

export interface ApprovalGrant extends ApprovalBinding {
  id: string;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  ui_token: string;
  /** Set when this grant was minted from a pre-approved session. */
  session_id?: string;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;

export class ApprovalStore {
  private readonly grants = new Map<string, ApprovalGrant>();
  private readonly ttlMs: number;
  private now: () => number;
  private readonly onEvent: ((event: ApprovalLifecycleEvent) => void) | undefined;
  private sessionMintCounter = 0;

  constructor(opts: { ttlMs?: number; now?: () => number; onEvent?: (event: ApprovalLifecycleEvent) => void } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  create(binding: ApprovalBinding): ApprovalGrant {
    const id = randomUUID();
    const created = this.now();
    const grant: ApprovalGrant = {
      ...binding,
      id,
      status: "pending",
      created_at: created,
      expires_at: created + this.ttlMs,
      ui_token: randomUUID(),
    };
    this.grants.set(id, grant);
    this.onEvent?.({ kind: "created", grant });
    return grant;
  }

  get(id: string): ApprovalGrant | undefined {
    const g = this.grants.get(id);
    if (g === undefined) return undefined;
    if (g.status === "pending" && this.now() > g.expires_at) {
      g.status = "expired";
      this.onEvent?.({ kind: "expired", grant: g });
    }
    return g;
  }

  approve(id: string): void {
    const g = this.requirePending(id);
    g.status = "granted";
    this.onEvent?.({ kind: "granted", grant: g });
  }

  deny(id: string): void {
    const g = this.requirePending(id);
    g.status = "denied";
    this.onEvent?.({ kind: "denied", grant: g });
  }

  consume(id: string, binding: ApprovalBinding): ApprovalGrant {
    const g = this.grants.get(id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    if (g.status === "used") throw new ShuttleError("approval_already_used", "Approval was already used.");
    if (g.status !== "granted") throw new ShuttleError("approval_not_granted", "Approval not granted.");
    if (this.now() > g.expires_at) {
      g.status = "expired";
      throw new ShuttleError("approval_expired", "Approval expired.");
    }
    if (!approvalBindingsMatch(g, binding)) {
      this.onEvent?.({ kind: "mismatch", binding, existingGrant: g });
      throw new ShuttleError("approval_mismatch", "Approval does not match the requested action.");
    }
    g.status = "used";
    this.onEvent?.({ kind: "used", grant: g });
    return g;
  }

  /**
   * Atomic multi-consume. Mirrors consume(id, binding) but validates ALL
   * items against a SINGLE timestamp before any mutation. Closes the
   * Phase 1→Phase 2 TOCTOU window in requireApprovals: per-plan consume()
   * re-reads this.now() per call, so an approval whose expires_at falls
   * between consume(A) and consume(B) yields a partial commit (A used,
   * B failed).
   *
   * Semantics:
   *   - Empty items: return [].
   *   - Duplicate ids in items: throw bad_request (caller bug — Phase 1
   *     should have deduped via the unusedIds Set).
   *   - Any item fails precondition (not found / not granted / expired /
   *     mismatch): throw IMMEDIATELY, no mutations performed.
   *   - All items pass: mark each used in input order, fire "used" events,
   *     return grants in input order.
   *
   * The timestamp is captured once at the start of validation. The mutation
   * pass cannot fail (every check already passed against that timestamp).
   */
  consumeBatch(items: Array<{ id: string; binding: ApprovalBinding }>): ApprovalGrant[] {
    if (items.length === 0) return [];

    // Detect duplicate IDs upfront.
    const seen = new Set<string>();
    for (const { id } of items) {
      if (seen.has(id)) {
        throw new ShuttleError("bad_request", `consumeBatch: duplicate id ${id}`);
      }
      seen.add(id);
    }

    // Capture clock ONCE for the whole batch.
    const now = this.now();

    // Phase A: validate all preconditions. No mutations.
    for (const { id, binding } of items) {
      const g = this.grants.get(id);
      if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
      if (g.status === "used") throw new ShuttleError("approval_already_used", "Approval was already used.");
      if (g.status !== "granted") throw new ShuttleError("approval_not_granted", "Approval not granted.");
      if (now > g.expires_at) throw new ShuttleError("approval_expired", "Approval expired.");
      if (!approvalBindingsMatch(g, binding)) {
        this.onEvent?.({ kind: "mismatch", binding, existingGrant: g });
        throw new ShuttleError("approval_mismatch", "Approval does not match the requested action.");
      }
    }

    // Phase B: all preconditions pass — mutate in order.
    const results: ApprovalGrant[] = [];
    for (const { id } of items) {
      const g = this.grants.get(id)!;
      g.status = "used";
      this.onEvent?.({ kind: "used", grant: g });
      results.push(g);
    }
    return results;
  }

  /**
   * Pure precheck mirroring consumeBatch's validation phase. Captures
   * this.now() once, validates all items (existence, status, TTL,
   * binding match). Throws on the first failure. No mutations.
   *
   * Used by requireApprovals Phase 2 to verify all consume preconditions
   * BEFORE committing other mutations (session mintFromSession), so a
   * later consume failure can't leave session-counter changes orphaned.
   *
   * Within a single sync execution, validateConsumeBatch followed by
   * consumeBatch will see the same this.now() (Node's single-threaded
   * event loop). The atomic-batch invariant is preserved.
   */
  validateConsumeBatch(items: Array<{ id: string; binding: ApprovalBinding }>): void {
    if (items.length === 0) return;

    const seen = new Set<string>();
    for (const { id } of items) {
      if (seen.has(id)) {
        throw new ShuttleError("bad_request", `validateConsumeBatch: duplicate id ${id}`);
      }
      seen.add(id);
    }

    const now = this.now();
    for (const { id, binding } of items) {
      const g = this.grants.get(id);
      if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
      if (g.status === "used") throw new ShuttleError("approval_already_used", "Approval was already used.");
      if (g.status !== "granted") throw new ShuttleError("approval_not_granted", "Approval not granted.");
      if (now > g.expires_at) throw new ShuttleError("approval_expired", "Approval expired.");
      if (!approvalBindingsMatch(g, binding)) {
        this.onEvent?.({ kind: "mismatch", binding, existingGrant: g });
        throw new ShuttleError("approval_mismatch", "Approval does not match the requested action.");
      }
    }
  }

  /**
   * Exposed for Phase 1 of requireApprovals: callers use this to check
   * whether a `granted` approval's TTL has elapsed before planning a
   * consume. Without this, an expired-but-status-granted approval would
   * pass Phase 1 and fail mid-Phase 2 (after earlier consumes have
   * already committed — breaking the two-phase invariant).
   *
   * Wraps `this.now()` (the test-injectable clock).
   */
  nowMs(): number {
    return this.now();
  }

  /**
   * Pure peek: does this session permit `binding`?
   * Returns true on match; false on pattern no-match. Throws on hard-fail
   * session states (revoked / expired / denied / not-pending). Mirrors EVERY
   * precondition SessionStore.incrementUses enforces, including max_uses,
   * so Phase 1 of requireApprovals can be sure that a planned "session"
   * binding can actually commit in Phase 2 without raising session_max_uses_exceeded.
   *
   * IMPORTANT: must NOT call sessionStore.incrementUses (would burn a use
   * for a binding that may never be committed).
   */
  canMatchSession(
    sessionId: string,
    binding: ApprovalBinding,
    sessionStore: SessionStore,
  ): boolean {
    const session = sessionStore.get(sessionId);
    if (session === undefined || session.status === "revoked") {
      throw new ShuttleError("session_not_found", "Unknown session id.");
    }
    if (session.status === "expired") {
      throw new ShuttleError("session_expired", "Session has expired.");
    }
    if (session.status === "denied") {
      throw new ShuttleError("session_unauthorized", "Session was denied.");
    }
    if (session.status !== "granted") {
      throw new ShuttleError(
        "session_unauthorized",
        `Session is not granted (status: ${session.status}).`,
      );
    }
    if (session.max_uses !== undefined && session.uses >= session.max_uses) {
      throw new ShuttleError(
        "session_max_uses_exceeded",
        `Session ${sessionId} reached its max_uses cap of ${session.max_uses}.`,
      );
    }
    return matchesSessionPattern(binding, session);
  }

  /**
   * Side-effect half of the session fast-path. ASSUMES canMatchSession
   * returned true for the same (sessionId, binding) — but re-checks
   * incrementUses-specific failures in case of a race (concurrent request
   * crossed the use cap between Phase 1 and Phase 2).
   *
   * Bumps sessionStore.incrementUses, mints a synthetic ApprovalGrant
   * (status: "used", session_id: <sessionId>) — same shape today's
   * findOrMintFromSession returns. Use only when committing a binding
   * via the session fast-path.
   *
   * Throws: session_max_uses_exceeded or session_expired (race — session
   * TTL elapsed between Phase 1 and Phase 2), or any error
   * sessionStore.incrementUses propagates.
   */
  mintFromSession(
    sessionId: string,
    binding: ApprovalBinding,
    sessionStore: SessionStore,
  ): ApprovalGrant {
    sessionStore.incrementUses(sessionId); // can throw session_max_uses_exceeded or session_expired in races
    this.sessionMintCounter += 1;
    const now = this.now();
    const grant: ApprovalGrant = {
      ...binding,
      id: `session:${sessionId}:${this.sessionMintCounter}`,
      status: "used",
      created_at: now,
      expires_at: now,
      ui_token: "",
      session_id: sessionId,
    };
    // Synthetic grant: skips pending/granted lifecycle — emit "used" directly.
    this.onEvent?.({ kind: "used", grant });
    return grant;
  }

  /**
   * Pure side-effect: fire onEvent({kind: "mismatch"}) for a grant that
   * doesn't match the expected binding, WITHOUT consuming or mutating any
   * state. Used by requireApprovals's leftover-ID path so the audit log
   * records the mismatch event without the risk that store.consume would
   * accidentally succeed (and burn an approval) for a binding that happens
   * to match.
   *
   * If the id is unknown or already consumed/expired/denied, this is a
   * no-op (no event fired). The store still emits a meaningful "mismatch"
   * event only when there's an actual grant to mismatch against.
   */
  fireMismatch(id: string, againstBinding: ApprovalBinding): void {
    const g = this.grants.get(id);
    if (g === undefined) return;
    // Only fire mismatch for grants that are valid candidates (granted/pending).
    // For used/denied/expired, the mismatch is moot — the grant wouldn't have
    // been consumable anyway.
    if (g.status !== "granted" && g.status !== "pending") return;
    this.onEvent?.({ kind: "mismatch", binding: againstBinding, existingGrant: g });
  }

  private requirePending(id: string): ApprovalGrant {
    const g = this.get(id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    if (g.status !== "pending") throw new ShuttleError("approval_not_pending", "Approval is not pending.");
    return g;
  }
}

/**
 * Returns true when two ApprovalBindings represent the same approval intent.
 *
 * Comparison notes:
 * - `template_params` keys are compared in sorted order (insertion order ignored).
 * - `allowed_domains` and `allowed_actions` are compared as order-insensitive sets.
 * - Null/undefined and empty arrays are equivalent for the set-typed fields.
 * - Display-only fields (`page_title`, `page_url_host`, `*_handle_label`) are excluded.
 */
export function approvalBindingsMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return (
    a.action === b.action &&
    a.ref === b.ref &&
    (a.planned_ref ?? null) === (b.planned_ref ?? null) &&
    a.environment === b.environment &&
    a.destination_domain === b.destination_domain &&
    a.target_id === b.target_id &&
    a.field_fingerprint === b.field_fingerprint &&
    a.template_id === b.template_id &&
    stableStringify(a.template_params) === stableStringify(b.template_params) &&
    (a.template_binary_path ?? null) === (b.template_binary_path ?? null) &&
    (a.template_binary_sha256 ?? null) === (b.template_binary_sha256 ?? null) &&
    domainSet(a.allowed_domains) === domainSet(b.allowed_domains) &&
    domainSet(a.allowed_actions) === domainSet(b.allowed_actions) &&
    (a.submit_fingerprint ?? null) === (b.submit_fingerprint ?? null) &&
    (a.success_condition ?? null) === (b.success_condition ?? null) &&
    (a.auto_resume ?? null) === (b.auto_resume ?? null) &&
    (a.reveal_fingerprint ?? null) === (b.reveal_fingerprint ?? null) &&
    (a.hide_fingerprint ?? null) === (b.hide_fingerprint ?? null) &&
    (a.container_fingerprint ?? null) === (b.container_fingerprint ?? null) &&
    (a.capture_mode ?? null) === (b.capture_mode ?? null)
  );
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, obj[k]])));
}

/** Stable, order-insensitive JSON of a string set (null/undefined ⇒ []). Used for allowed_domains and allowed_actions. */
function domainSet(v: string[] | null | undefined): string {
  return JSON.stringify([...(v ?? [])].sort());
}
