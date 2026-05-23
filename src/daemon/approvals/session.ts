import { ShuttleError } from "../../shared/errors.js";
import { ALL_SECRET_ACTIONS } from "../../vault/types.js";

export type SessionAction =
  | "template-run"
  | "inject-submit"
  | "reveal-capture"
  | "secrets-set";
  // NOTE: NOT in v0.2.0 SessionAction:
  //   - "run" and "inject_render": need command_prefix / output_mode constraints; future plan
  //   - "secrets-delete" / "secrets-rotate": destructive ops are always human-gated

const VALID_SESSION_ACTIONS: ReadonlySet<SessionAction> = new Set<SessionAction>([
  "template-run",
  "inject-submit",
  "reveal-capture",
  "secrets-set",
]);

/**
 * Actions in SessionAction that REQUIRE non-empty pattern.destination_domains
 * at pattern-creation time. template-run is excluded because templates have
 * implicit destinations encoded by template_id (e.g. vercel-env-add → vercel.com)
 * and the binding does not set binding.destination_domain.
 */
const DOMAIN_REQUIRED: ReadonlySet<SessionAction> = new Set<SessionAction>([
  "inject-submit",
  "reveal-capture",
  "secrets-set",
]);

/**
 * Actions in SessionAction that REQUIRE non-empty pattern.template_ids
 * at pattern-creation time. Only template-run.
 */
const TEMPLATE_IDS_REQUIRED: ReadonlySet<SessionAction> = new Set<SessionAction>([
  "template-run",
]);

/**
 * Actions that REQUIRE non-empty pattern.allowed_actions at pattern-creation
 * time. Only secrets-set. Without this the matcher would auto-approve a
 * secret whose action set the human never explicitly scoped (e.g. the
 * pattern "create a stripe prod key for vercel.com" would default-grant
 * the FULL DEFAULT_ACTIONS set on the new secret, including inject_submit
 * which the human never authorized for vercel.com).
 */
const ALLOWED_ACTIONS_REQUIRED: ReadonlySet<SessionAction> = new Set<SessionAction>([
  "secrets-set",
]);

/**
 * Canonical SecretAction set, derived from ALL_SECRET_ACTIONS so this file
 * does not silently drift when a new SecretAction is added to the vault
 * type system. ALL_SECRET_ACTIONS itself is the source of truth in
 * src/vault/types.ts.
 */
const VALID_SECRET_ACTIONS = new Set<string>(ALL_SECRET_ACTIONS);

export interface SessionPattern {
  actions: SessionAction[];
  ref_glob: string;                // "" = no ref check; otherwise literal prefix + optional single trailing *
  destination_domains: string[];   // REQUIRED non-empty when actions include inject-submit/reveal-capture/secrets-set
  template_ids?: string[];         // REQUIRED non-empty when actions includes template-run
  allowed_actions?: string[];      // REQUIRED non-empty when actions includes secrets-set; entries validated against ALL_SECRET_ACTIONS
  ttl_ms: number;                  // 1_000 ≤ ttl_ms ≤ 900_000 (15 min)
  max_uses?: number;               // 1 ≤ max_uses ≤ 1000
}

export const PENDING_TTL_MS = 2 * 60 * 1000; // 2 minutes for human to approve
export const TTL_MIN_MS = 1_000;
export const TTL_MAX_MS = 15 * 60 * 1000;
export const MAX_USES_MAX = 1000;

export type SessionStatus = "pending" | "granted" | "denied" | "expired" | "revoked";

export interface SessionGrant extends SessionPattern {
  id: string;
  ui_token: string;
  status: SessionStatus;
  created_at: number;
  approved_at: number | null;      // null until approve() runs
  expires_at: number;              // PENDING window initially; RESET to now+ttl_ms on approve
  uses: number;
}

/**
 * Map ApprovalBinding.action → SessionAction. Returns null for actions that
 * cannot be put into a session. In Plan 4a that includes:
 *   - "secrets_delete" / "secrets_rotate" (destructive — always human-gated)
 *   - "run" / "inject_render" (broad in current binding shape — need
 *     command_prefix / output_mode constraints; future plan)
 */
const CANONICAL_MAP: Record<string, SessionAction> = {
  template: "template-run",
  inject_submit: "inject-submit",
  reveal_capture: "reveal-capture",
  generate: "secrets-set",
};

export function canonicalAction(action: string): SessionAction | null {
  return CANONICAL_MAP[action] ?? null;
}

export function globToRegExp(glob: string): RegExp {
  // Reject forbidden glob metacharacters unconditionally (applies to both
  // literal and wildcard patterns).
  for (const ch of ["?", "[", "]", "{", "}"]) {
    if (glob.includes(ch)) {
      throw new ShuttleError(
        "session_pattern_invalid_glob",
        `ref_glob does not support '${ch}'.`,
      );
    }
  }

  const starIdx = glob.indexOf("*");
  if (starIdx === -1) {
    // Literal-only glob: match exactly.
    return new RegExp(`^${escapeRegExp(glob)}$`);
  }
  if (starIdx !== glob.length - 1) {
    // * must be at the end (and only one * allowed).
    throw new ShuttleError(
      "session_pattern_invalid_glob",
      `ref_glob supports literal prefix + optional single trailing '*'. Got: ${glob}`,
    );
  }
  const prefix = glob.slice(0, -1);
  // `.+` so the trailing * matches a NON-EMPTY suffix (bare prefix is not a match).
  return new RegExp(`^${escapeRegExp(prefix)}.+$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertSessionPatternValid(pattern: SessionPattern): void {
  // ── 1. actions array shape + enum membership ────────────────────────────────
  if (!Array.isArray(pattern.actions) || pattern.actions.length === 0) {
    throw new ShuttleError("bad_request", "Session pattern must include at least one action.");
  }
  for (const a of pattern.actions) {
    if (!VALID_SESSION_ACTIONS.has(a)) {
      throw new ShuttleError(
        "bad_request",
        `Session pattern action '${a}' is not a valid SessionAction. ` +
          `secrets-delete and secrets-rotate require fresh per-op approval and cannot be put in a session.`,
      );
    }
  }

  // ── 2. ref_glob shape + validity ────────────────────────────────────────────
  if (typeof pattern.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "ref_glob must be a string.");
  }
  if (pattern.ref_glob.length > 0) {
    globToRegExp(pattern.ref_glob); // throws session_pattern_invalid_glob on malformed
  }

  // ── 3. destination_domains shape ────────────────────────────────────────────
  if (!Array.isArray(pattern.destination_domains)) {
    throw new ShuttleError("bad_request", "destination_domains must be an array.");
  }
  for (const d of pattern.destination_domains) {
    if (typeof d !== "string") {
      throw new ShuttleError("bad_request", "destination_domains entries must be strings.");
    }
  }

  // ── 4. template_ids shape (when present) ────────────────────────────────────
  if (pattern.template_ids !== undefined) {
    if (!Array.isArray(pattern.template_ids)) {
      throw new ShuttleError("bad_request", "template_ids must be an array.");
    }
    for (const t of pattern.template_ids) {
      if (typeof t !== "string") {
        throw new ShuttleError("bad_request", "template_ids entries must be strings.");
      }
    }
  }

  // ── 5. allowed_actions shape + enum membership (BEFORE per-action loop) ─────
  // Shape-check FIRST (array + string entries + enum membership) before the
  // per-action requirement loop touches pattern.allowed_actions.length — the
  // loop must not see a non-array.
  if (pattern.allowed_actions !== undefined) {
    if (!Array.isArray(pattern.allowed_actions)) {
      throw new ShuttleError("bad_request", "allowed_actions must be an array.");
    }
    for (const a of pattern.allowed_actions) {
      if (typeof a !== "string") {
        throw new ShuttleError("bad_request", "allowed_actions entries must be strings.");
      }
      if (!VALID_SECRET_ACTIONS.has(a)) {
        throw new ShuttleError(
          "bad_request",
          `allowed_actions entry '${a}' is not a valid SecretAction. ` +
            `Valid values: ${[...VALID_SECRET_ACTIONS].join(", ")}.`,
        );
      }
    }
  }

  // ── 6. Per-action requirements ───────────────────────────────────────────────
  // (Closes round-2 P1: empty destination_domains for domain-bearing actions.)
  for (const action of pattern.actions) {
    if (DOMAIN_REQUIRED.has(action) && pattern.destination_domains.length === 0) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty destination_domains. ` +
          `Use --destination-domain to restrict the session to specific domains.`,
      );
    }
    if (
      TEMPLATE_IDS_REQUIRED.has(action) &&
      (pattern.template_ids === undefined || pattern.template_ids.length === 0)
    ) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty template_ids. ` +
          `Use --template-id to restrict the session to specific templates.`,
      );
    }
    if (
      ALLOWED_ACTIONS_REQUIRED.has(action) &&
      (pattern.allowed_actions === undefined || pattern.allowed_actions.length === 0)
    ) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty allowed_actions. ` +
          `Use --allowed-action to scope what the minted secret will permit. ` +
          `Valid values: ${[...VALID_SECRET_ACTIONS].join(", ")}.`,
      );
    }
  }

  // ── 7. ttl_ms bounds ────────────────────────────────────────────────────────
  if (typeof pattern.ttl_ms !== "number" || !Number.isFinite(pattern.ttl_ms)) {
    throw new ShuttleError("bad_request", "ttl_ms must be a finite number.");
  }
  if (pattern.ttl_ms < TTL_MIN_MS) {
    throw new ShuttleError("bad_request", `ttl_ms must be at least ${TTL_MIN_MS}ms.`);
  }
  if (pattern.ttl_ms > TTL_MAX_MS) {
    throw new ShuttleError("bad_request", `ttl_ms cannot exceed ${TTL_MAX_MS}ms (15 minutes).`);
  }

  // ── 8. max_uses bounds (optional) ───────────────────────────────────────────
  if (pattern.max_uses !== undefined) {
    if (typeof pattern.max_uses !== "number" || !Number.isInteger(pattern.max_uses)) {
      throw new ShuttleError("bad_request", "max_uses must be an integer.");
    }
    if (pattern.max_uses < 1) {
      throw new ShuttleError("bad_request", "max_uses must be at least 1.");
    }
    if (pattern.max_uses > MAX_USES_MAX) {
      throw new ShuttleError("bad_request", `max_uses cannot exceed ${MAX_USES_MAX}.`);
    }
  }
}
