# Phase 1 — Plan 4a: Pre-approved sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land §5.7 pre-approved sessions. A human approves a *pattern* once; the daemon mints single-use grants matching that pattern for up to 15 minutes from APPROVAL time. Subsequent agent operations carrying `--session <id>` or `session_id` in the body skip the per-op approval window for matches; non-matching ops fall back to the per-op flow.

**Architecture:** Three load-bearing pieces. (1) `SessionStore` holds session grants with TTL anchored at approval time (not creation), and `get()` flips ALL non-terminal sessions to `expired` past `expires_at` — fixing the granted-sessions-never-expire trap. (2) `SessionPattern` matching is split into **action-specific predicates** that know where each binding's refs live (binding.ref for templates/inject-submit/reveal-capture; binding.template_params.refs comma-string for run; binding.planned_ref for secrets-set). The generic-glob-only matcher would have auto-approved any production ref under run/inject_render/secrets-set sessions because those bindings have `ref: null`. (3) Session approvals get their OWN `/ui/sessions/:id` GET + `/ui/sessions/:id/approve|deny` POST routes per-session-ui-token authenticated (mirroring the existing approval-UI per-URL-token pattern); the route tests use these routes, not direct `services.sessionStore.approve()` mutations.

**Tech Stack:** TypeScript (existing); Node 20+ (existing). No new npm dependencies. Reuses the Plan 1 structured-error contract, the Plan 2 internal-namespace pattern, the Plan 3 approval-store conventions.

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) §5.7 (pre-approved sessions), §3.3 (new endpoints), §3.4 (cross-cutting), §6.1 (Stripe→Vercel walkthrough).

**Sequence with other Phase 1 plans:**

- **Plan 1 ✅** — Foundation.
- **Plan 2 ✅** — CLI surface.
- **Plan 3 ✅** — `run` + `inject` + daemon spawner with masking.
- **Plan 4a (this)** — Pre-approved sessions.
- **Plan 4b** — Single-window approval-UI tab reuse (depends on 4a's `/ui/sessions/:id` routes).
- **Plan 4c** — `run` stdin pass-through.
- **Plan 5a** — `init` rewrite + native-module keychain.
- **Plan 5b** — Docs + npm publish 0.2.0.

This plan was originally the unified "Plan 4" (sessions + tab reuse + stdin). A round-1 design review flagged three session-side P0s (granted sessions don't expire; matchers unsafe for run/inject_render/secrets-set; no session approve/deny UI contract) and recommended splitting. Plans 4b and 4c follow this one.

## Scope reductions called out explicitly

- **Tab reuse is NOT in Plan 4a.** Plan 4a creates pending sessions and surfaces them via the EXISTING `openUrl(/ui/sessions/:id?token=<ui_token>)` spawn — one tab per session-approval, same as today's per-approval flow. The "one tab per daemon lifetime" UX improvement is Plan 4b.
- **Stdin pass-through is NOT in Plan 4a.** Plan 4c.
- **Session pattern globs are literal-prefix + single trailing `*`.** Full glob (`?`, `[...]`, `**`) throws `session_pattern_invalid_glob` at create time. Documented + tested.
- **Destructive actions cannot be put into a session.** `secrets-delete` and `secrets-rotate` ARE NOT in `SessionAction`. The destructive-op routes accept a `session_id` body param (so the CLI flag is uniform across commands), but they will reject any provided session as `session_pattern_no_match` (the supplied session's actions cannot include `secrets-delete`/`secrets-rotate` — there's no such enum value). This keeps destructive ops human-gated per spec design intent while preserving CLI uniformity.
- **No `command_prefix` constraint in v0.2.0 patterns.** The session pattern for `run` restricts refs (each resolved ref must match `ref_glob`) but does NOT validate the child command/argv. Rationale: the agent already supplied the refs to the daemon (env-file parse); restricting to a ref glob is the meaningful security boundary. Adding `command_prefix` is a small future enhancement; out of scope here to keep the matcher contract tight.

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/daemon/approvals/session.ts` | `SessionPattern` type, `SessionAction` enum, `SessionStatus` enum, `SessionGrant` type, `globToRegExp` + `assertSessionPatternValid` + `assertSessionPatternValidGlob`. |
| `src/daemon/approvals/session.test.ts` | Pattern + glob + validation unit tests. |
| `src/daemon/approvals/session-store.ts` | `SessionStore` class — create / get (with expiry transition) / approve (resets expires_at) / deny / revoke / list / incrementUses. |
| `src/daemon/approvals/session-store.test.ts` | Lifecycle tests INCLUDING granted-state-expiry coverage. |
| `src/daemon/approvals/session-matchers.ts` | Action-specific predicates: `templateRunMatches`, `injectSubmitMatches`, `revealCaptureMatches`, `secretsSetMatches`, `runMatches`, `injectRenderMatches`. Plus the top-level `matchesSessionPattern(binding, pattern)` dispatcher. |
| `src/daemon/approvals/session-matchers.test.ts` | Per-predicate tests — proves run/inject_render/secrets-set sessions can't auto-approve unrelated production refs. |
| `src/daemon/api/routes/approvals-session.ts` | `POST /v1/approvals/session` (create + poll), `GET /v1/approvals/sessions` (list), `POST /v1/approvals/sessions/revoke`. |
| `src/daemon/api/routes/approvals-session.test.ts` | Route tests — approve via the HTTP UI route (not by mutating the store). |
| `src/daemon/approvals/session-ui-server.ts` | `GET /ui/sessions/:id?token=<ui_token>` (returns session JSON), `POST /ui/sessions/:id/approve?token=<ui_token>`, `POST /ui/sessions/:id/deny?token=<ui_token>`. Mirrors the existing `ui-server.ts` per-URL-token model. |
| `src/daemon/approvals/session-ui-server.test.ts` | UI route tests: valid token → 200; wrong token → 401; unknown id → 404; approve transitions status. |
| `src/cli/commands/internal-session.ts` | `secret-shuttle internal session create`, `internal session list`, `internal session revoke <id>`. |
| `src/cli/commands/internal-session.test.ts` | CLI structural tests. |

**Files to modify:**

| Path | Change |
|---|---|
| `src/daemon/approvals/store.ts` | Add `findOrMintFromSession(sessionId, binding, sessionStore)` method to `ApprovalStore`. Extend `ApprovalGrant` with optional `session_id?: string`. |
| `src/daemon/approvals/store.test.ts` | Tests for the new method covering each error path. |
| `src/daemon/approvals/require-approval.ts` | Accept optional `sessionId?: string` + `sessionStore?: SessionStore` in `RequireApprovalOptions`. Session fast-path before single-use flow. Falls back on `session_pattern_no_match`; re-throws other session errors. |
| `src/daemon/approvals/require-approval.test.ts` | Tests covering session fast-path success, pattern_no_match fallback, and re-throw cases. |
| `src/daemon/services.ts` | Expose `sessionStore: SessionStore`. |
| `src/daemon/api/router.ts` | Register the new routes. |
| `src/daemon/audit.ts` | Extend `DaemonAuditEvent` with optional `session_id?: string`. |
| `src/shared/error-codes.ts` | Add 7 new entries (see Task C1). |
| `src/shared/error-codes.test.ts` | Bump count 110 → 117; spot-check new codes. |
| `src/cli/commands/internal.ts` | Register the `session` subcommand. |
| `src/daemon/api/routes/templates.ts` | Accept `session_id` in body; pass to `requireApproval`; capture grant.session_id in audit. |
| `src/daemon/api/routes/run-resolve.ts` | Same. |
| `src/daemon/api/routes/inject-render.ts` | Same. |
| `src/daemon/api/routes/secrets.ts` (generate endpoint) | Same. |
| `src/daemon/api/routes/secrets-delete.ts` | Accept `session_id` body field (pass through to requireApproval); the secrets-delete action is NOT a SessionAction, so `findOrMintFromSession` will throw `session_pattern_no_match` and the route will fall back to the single-use flow. Tests pin this. |
| `src/daemon/api/routes/secrets-rotate.ts` | Same as secrets-delete. |
| `src/daemon/api/routes/inject-submit.ts` | Same as templates. |
| `src/daemon/api/routes/reveal-capture.ts` | Same as templates. |
| `src/cli/commands/run.ts` | Add `--session <id>` option; pass through. |
| `src/cli/commands/inject.ts` | Same. |
| `src/cli/commands/secrets/delete.ts` | Same (will be rejected by daemon as no_match; CLI passes through anyway for uniformity). |
| `src/cli/commands/secrets/rotate.ts` | Same. |
| `src/cli/commands/secrets/set.ts` | Same. |
| `src/cli/commands/template-run.ts` | Same. |
| `src/cli/commands/inject-submit.ts` | Same. |
| `src/cli/commands/reveal-capture.ts` | Same. |
| `CHANGELOG.md` | Plan 4a entries. |

**Decision: TTL anchored at APPROVAL time, not creation.** Spec line 388 says "approve up to N operations matching this shape for N minutes". User-visible expectation: when the human clicks approve, the clock starts. Otherwise a human who takes 4 minutes to review the pattern gets a 1-minute usable session — terrible UX. Implementation: `SessionStore.create` sets a short PENDING_TTL (`120_000` ms = 2 minutes for the human to approve); on `approve()`, expires_at is RESET to `now + pattern.ttl_ms`. Both pending and granted states use the same expires_at field; `get()` flips both pending AND granted past expires_at to `expired`.

**Decision: action-specific matcher predicates.** A single ref-glob match against `binding.ref` is unsafe for `run`/`inject_render`/`secrets-set` because those bindings have `ref: null` — the refs live in `template_params.refs` (run/inject_render, comma-joined) or `planned_ref` (secrets-set). The matcher dispatches by canonical SessionAction:

| SessionAction | Binding field(s) inspected | Pattern fields enforced |
|---|---|---|
| `template-run` | `binding.ref`, `binding.destination_domain`, `binding.template_id` | `ref_glob`, `destination_domains`, `template_ids` |
| `inject-submit` | `binding.ref`, `binding.destination_domain` | `ref_glob`, `destination_domains` |
| `reveal-capture` | `binding.ref`, `binding.destination_domain` | `ref_glob`, `destination_domains` |
| `secrets-set` | `binding.planned_ref`, `binding.allowed_domains`, `binding.allowed_actions` | `ref_glob`, `destination_domains` (must be a SUPERSET of allowed_domains), `allowed_actions` (must be a SUPERSET of allowed_actions) |
| `run` | `binding.template_params.refs` (comma-split → each must match `ref_glob`) | `ref_glob` (applied to every ref) |
| `inject_render` | `binding.template_params.refs` (same as run) | `ref_glob` (applied to every ref) |

Note the **superset-not-equal** semantic for secrets-set: the pattern's destination_domains is the SET OF ALLOWED domains for any minted secret; the operation's binding.allowed_domains must be ⊆ pattern.destination_domains. Otherwise an agent could create a session with one narrow domain and then have it auto-approve a secret with a wider domain set.

**Decision: session_id flows through the body, not a header.** Consistent with `approval_id`. CLIs add `--session <id>` and pass the body field.

**Decision: destructive actions cannot be put in a session.** `secrets-delete` and `secrets-rotate` are NOT `SessionAction` values. Their routes accept the `session_id` body param for CLI-uniformity but the matcher will throw `session_pattern_no_match` for any session passed there, triggering the per-op approval fallback. The CLI flag exists on every approval-gated command so users don't have to memorize which commands accept it; the security boundary is enforced at the daemon.

---

## Pre-execution checklist — RUN BEFORE TASK A1

**Same hard gate as Plans 1, 2, 3.** Do not start Task A1 until all three checks pass.

- [ ] **Step 1: Working tree clean.**

```bash
git status --short
```

Expected: empty.

- [ ] **Step 2: Confirm head is downstream of Plan 3.**

```bash
git log --oneline -5
```

Expected: head is on or downstream of `fd7b996` (Plan 3 R8-1 audit precision fix) AND `79a1fa1`'s revert (the deleted unified Plan 4 doc).

- [ ] **Step 3: Build green on HEAD.**

```bash
npm run typecheck
npm test
```

Both must pass on the current HEAD.

Once all three checks pass, proceed.

---

## Part A — SessionPattern + glob + validation

### Task A1: Types + assertSessionPatternValid + globToRegExp

**Files:**
- Create: `src/daemon/approvals/session.ts`
- Create: `src/daemon/approvals/session.test.ts`

**Contract:**

```typescript
export type SessionAction =
  | "template-run"      // ApprovalBinding.action === "template"
  | "inject-submit"     // "inject_submit"
  | "reveal-capture"    // "reveal_capture"
  | "secrets-set"       // "generate"
  | "run"               // "run"
  | "inject_render";    // "inject_render"
  // NOTE: secrets-delete and secrets-rotate are NOT SessionActions.

export interface SessionPattern {
  actions: SessionAction[];
  ref_glob: string;                 // "" = no ref check; otherwise literal prefix + optional single trailing *
  destination_domains: string[];    // empty array = no domain check (for actions without a domain)
  template_ids?: string[];          // optional template_id whitelist
  allowed_actions?: string[];       // optional; only meaningful for secrets-set sessions
  ttl_ms: number;                   // 1_000 ≤ ttl_ms ≤ 900_000 (15 min)
  max_uses?: number;                // 1 ≤ max_uses ≤ 1000
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
  approved_at: number | null;       // null until approve() runs
  expires_at: number;               // PENDING window initially; RESET to now+ttl_ms on approve
  uses: number;
}
```

- [ ] **Step 1: Write failing tests**

Create `src/daemon/approvals/session.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  assertSessionPatternValid,
  canonicalAction,
  type SessionPattern,
} from "./session.js";

function makePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// globToRegExp
test("globToRegExp: literal-only pattern matches exactly", () => {
  const re = globToRegExp("ss://stripe/prod/STRIPE_KEY");
  assert.equal(re.test("ss://stripe/prod/STRIPE_KEY"), true);
  assert.equal(re.test("ss://stripe/prod/OTHER"), false);
});

test("globToRegExp: single trailing * matches any non-empty suffix", () => {
  const re = globToRegExp("ss://stripe/prod/*");
  assert.equal(re.test("ss://stripe/prod/A"), true);
  assert.equal(re.test("ss://stripe/prod/MY-KEY.v2"), true);
  assert.equal(re.test("ss://stripe/prod/"), false); // suffix must be non-empty
  assert.equal(re.test("ss://stripe/prod"), false);
});

test("globToRegExp: regex-special characters in the prefix are escaped", () => {
  const re = globToRegExp("ss://stripe.com/prod/MY-KEY*");
  assert.equal(re.test("ss://stripe.com/prod/MY-KEY-A"), true);
  assert.equal(re.test("ss://stripeXcom/prod/MY-KEY-A"), false); // . was a literal, not any-char
});

test("globToRegExp: ** in glob is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/prod/**"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: ? is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/prod/?"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: bracket character class is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://stripe/[pq]rod/*"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("globToRegExp: * not at the end is rejected", () => {
  assert.throws(
    () => globToRegExp("ss://*/prod/*"),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

// canonicalAction
test("canonicalAction: template → template-run", () => {
  assert.equal(canonicalAction("template"), "template-run");
});

test("canonicalAction: inject_submit → inject-submit", () => {
  assert.equal(canonicalAction("inject_submit"), "inject-submit");
});

test("canonicalAction: secrets_delete returns null (not a SessionAction)", () => {
  assert.equal(canonicalAction("secrets_delete"), null);
});

test("canonicalAction: secrets_rotate returns null (not a SessionAction)", () => {
  assert.equal(canonicalAction("secrets_rotate"), null);
});

test("canonicalAction: unknown action returns null", () => {
  assert.equal(canonicalAction("nope"), null);
});

// assertSessionPatternValid
test("assertSessionPatternValid: minimal valid pattern passes", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern()));
});

test("assertSessionPatternValid: empty actions throws bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl < 1s throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 500 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl > 15min throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 16 * 60 * 1000 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: invalid glob throws session_pattern_invalid_glob", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ref_glob: "ss://stripe/**/x" })),
    (err: Error & { code?: string }) => err.code === "session_pattern_invalid_glob",
  );
});

test("assertSessionPatternValid: empty ref_glob is allowed (means 'no ref check')", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["run"], // run pattern doesn't need to constrain refs if user wants permissive
    ref_glob: "",
    destination_domains: [],
  })));
});

test("assertSessionPatternValid: max_uses 0 throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ max_uses: 0 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: max_uses > 1000 throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ max_uses: 1001 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-delete in actions throws (not a SessionAction)", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ actions: ["secrets-delete" as never] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: allowed_actions field accepted when present", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
  })));
});
```

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist)

- [ ] **Step 3: Implement**

Create `src/daemon/approvals/session.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";

export type SessionAction =
  | "template-run"
  | "inject-submit"
  | "reveal-capture"
  | "secrets-set"
  | "run"
  | "inject_render";

const VALID_SESSION_ACTIONS: ReadonlySet<SessionAction> = new Set<SessionAction>([
  "template-run",
  "inject-submit",
  "reveal-capture",
  "secrets-set",
  "run",
  "inject_render",
]);

export interface SessionPattern {
  actions: SessionAction[];
  ref_glob: string;
  destination_domains: string[];
  template_ids?: string[];
  allowed_actions?: string[];
  ttl_ms: number;
  max_uses?: number;
}

export const PENDING_TTL_MS = 2 * 60 * 1000;
export const TTL_MIN_MS = 1_000;
export const TTL_MAX_MS = 15 * 60 * 1000;
export const MAX_USES_MAX = 1000;

export type SessionStatus = "pending" | "granted" | "denied" | "expired" | "revoked";

export interface SessionGrant extends SessionPattern {
  id: string;
  ui_token: string;
  status: SessionStatus;
  created_at: number;
  approved_at: number | null;
  expires_at: number;
  uses: number;
}

/**
 * Map ApprovalBinding.action → SessionAction. Returns null for actions that
 * cannot be put into a session (notably secrets-delete and secrets-rotate).
 */
const CANONICAL_MAP: Record<string, SessionAction> = {
  template: "template-run",
  inject_submit: "inject-submit",
  reveal_capture: "reveal-capture",
  generate: "secrets-set",
  run: "run",
  inject_render: "inject_render",
};

export function canonicalAction(action: string): SessionAction | null {
  return CANONICAL_MAP[action] ?? null;
}

export function globToRegExp(glob: string): RegExp {
  const starIdx = glob.indexOf("*");
  if (starIdx === -1) {
    return new RegExp(`^${escapeRegExp(glob)}$`);
  }
  if (starIdx !== glob.length - 1) {
    throw new ShuttleError(
      "session_pattern_invalid_glob",
      `ref_glob supports literal prefix + optional single trailing '*'. Got: ${glob}`,
    );
  }
  for (const ch of ["?", "[", "]", "{", "}"]) {
    if (glob.includes(ch)) {
      throw new ShuttleError(
        "session_pattern_invalid_glob",
        `ref_glob does not support '${ch}'.`,
      );
    }
  }
  const prefix = glob.slice(0, -1);
  // `.+` so the trailing * matches NON-EMPTY suffix (a bare prefix isn't a match).
  return new RegExp(`^${escapeRegExp(prefix)}.+$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertSessionPatternValid(pattern: SessionPattern): void {
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
  if (typeof pattern.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "ref_glob must be a string.");
  }
  if (pattern.ref_glob.length > 0) {
    globToRegExp(pattern.ref_glob); // throws session_pattern_invalid_glob on malformed
  }
  if (!Array.isArray(pattern.destination_domains)) {
    throw new ShuttleError("bad_request", "destination_domains must be an array.");
  }
  for (const d of pattern.destination_domains) {
    if (typeof d !== "string") {
      throw new ShuttleError("bad_request", "destination_domains entries must be strings.");
    }
  }
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
  if (pattern.allowed_actions !== undefined) {
    if (!Array.isArray(pattern.allowed_actions)) {
      throw new ShuttleError("bad_request", "allowed_actions must be an array.");
    }
    for (const a of pattern.allowed_actions) {
      if (typeof a !== "string") {
        throw new ShuttleError("bad_request", "allowed_actions entries must be strings.");
      }
    }
  }
  if (typeof pattern.ttl_ms !== "number" || !Number.isFinite(pattern.ttl_ms)) {
    throw new ShuttleError("bad_request", "ttl_ms must be a finite number.");
  }
  if (pattern.ttl_ms < TTL_MIN_MS) {
    throw new ShuttleError("bad_request", `ttl_ms must be at least ${TTL_MIN_MS}ms.`);
  }
  if (pattern.ttl_ms > TTL_MAX_MS) {
    throw new ShuttleError("bad_request", `ttl_ms cannot exceed ${TTL_MAX_MS}ms (15 minutes).`);
  }
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
```

- [ ] **Step 4: Run — expect PASS** (~21 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session.ts src/daemon/approvals/session.test.ts
git commit -m "feat(approvals): SessionPattern types + glob + validation

Glob is literal-prefix + optional single trailing *. Validation
rejects destructive actions (secrets-delete, secrets-rotate) at
pattern creation. TTL bounds 1s-15min. max_uses 1-1000. The trailing
* must match a non-empty suffix (no bare-prefix matches)."
```

---

## Part B — Action-specific matcher predicates

### Task B1: session-matchers.ts

**Files:**
- Create: `src/daemon/approvals/session-matchers.ts`
- Create: `src/daemon/approvals/session-matchers.test.ts`

**Contract:**

```typescript
export function matchesSessionPattern(binding: ApprovalBinding, pattern: SessionPattern): boolean;
```

Dispatch by `canonicalAction(binding.action)`:
- `template-run` / `inject-submit` / `reveal-capture` — generic ref+domain matcher. Honors template_ids for template-run.
- `secrets-set` — planned_ref against ref_glob; binding.allowed_domains ⊆ pattern.destination_domains; binding.allowed_actions ⊆ pattern.allowed_actions (when set).
- `run` / `inject_render` — refs come from `binding.template_params.refs` as a comma-joined string; SPLIT it and check EACH against ref_glob. If pattern.ref_glob is empty, accept any refs.
- Unknown action → false.

- [ ] **Step 1: Write failing tests**

Create `src/daemon/approvals/session-matchers.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

function makeBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
    ...overrides,
  };
}

function makePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// =============================================================================
// template-run / inject-submit / reveal-capture (generic ref+domain matcher)
// =============================================================================

test("template-run: ref + domain + template_id all match → true", () => {
  const p = makePattern({ actions: ["template-run"], template_ids: ["vercel-env-add"] });
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("template-run: ref mismatch → false", () => {
  const p = makePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/dev/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: domain mismatch → false", () => {
  const p = makePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "evil.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: template_id constraint violated → false", () => {
  const p = makePattern({ template_ids: ["vercel-env-add"] });
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
    template_id: "github-actions-secret",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("inject-submit: ref+domain match → true", () => {
  const p = makePattern({ actions: ["inject-submit"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("reveal-capture: ref+domain match → true", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

// =============================================================================
// secrets-set (planned_ref + allowed_domains + allowed_actions semantics)
// =============================================================================

test("secrets-set: planned_ref matches glob; allowed_domains ⊆ pattern.destination_domains → true", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com", "github.com"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/NEW_KEY",
    allowed_domains: ["vercel.com"], // ⊆ pattern.destination_domains
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: planned_ref outside glob → false", () => {
  const p = makePattern({ actions: ["secrets-set"] });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/dev/NEW_KEY", // dev not prod
    allowed_domains: ["vercel.com"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_domains contains a domain NOT in pattern → false (NOT superset-allowed)", () => {
  // This is the security-relevant case: the session pre-approves vercel.com,
  // the agent tries to mint a secret that ALSO allows github.com. Refuse —
  // the human approved vercel.com only.
  const p = makePattern({
    actions: ["secrets-set"],
    destination_domains: ["vercel.com"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com", "github.com"], // github.com is wider
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: pattern.allowed_actions set + binding.allowed_actions ⊆ pattern → true", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: pattern.allowed_actions set + binding has wider actions → false", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin", "inject_submit"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// run / inject_render (refs in template_params.refs comma-joined string)
// =============================================================================

test("run: every ref matches glob → true", () => {
  const p = makePattern({
    actions: ["run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [], // run has no destination_domain
  });
  const b = makeBinding({
    action: "run",
    ref: null,
    destination_domain: null,
    template_params: {
      command: "node",
      args: "[]",
      refs: "ss://stripe/prod/STRIPE_KEY,ss://stripe/prod/STRIPE_PUB",
    },
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("run: AT LEAST ONE ref outside glob → false (must be ALL)", () => {
  // This is the security-relevant case for run: an agent's session covers
  // stripe/prod/*, the agent attempts a run that includes ss://stripe/dev/*.
  // Even though most refs match, the one outside the glob means we refuse.
  const p = makePattern({
    actions: ["run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [],
  });
  const b = makeBinding({
    action: "run",
    ref: null,
    destination_domain: null,
    template_params: {
      command: "node",
      args: "[]",
      refs: "ss://stripe/prod/A,ss://stripe/dev/B", // dev/B is outside the pattern
    },
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("run: empty refs string with permissive (empty) glob → true", () => {
  const p = makePattern({ actions: ["run"], ref_glob: "", destination_domains: [] });
  const b = makeBinding({
    action: "run",
    ref: null,
    destination_domain: null,
    template_params: { command: "node", args: "[]", refs: "" },
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("run: empty refs string with non-empty glob → true (no refs to violate the constraint)", () => {
  const p = makePattern({ actions: ["run"], ref_glob: "ss://stripe/prod/*", destination_domains: [] });
  const b = makeBinding({
    action: "run",
    ref: null,
    destination_domain: null,
    template_params: { command: "node", args: "[]", refs: "" },
  });
  // The "every ref matches" semantic is vacuously true when there are no refs.
  assert.equal(matchesSessionPattern(b, p), true);
});

test("run: template_params missing or malformed → false (defensive)", () => {
  const p = makePattern({ actions: ["run"], ref_glob: "ss://x/*", destination_domains: [] });
  const b = makeBinding({
    action: "run",
    ref: null,
    destination_domain: null,
    template_params: null, // unexpected for a run binding
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("inject_render: refs from template_params, same semantic as run", () => {
  const p = makePattern({ actions: ["inject_render"], ref_glob: "ss://x/*", destination_domains: [] });
  const b = makeBinding({
    action: "inject_render",
    ref: null,
    destination_domain: null,
    template_params: { refs: "ss://x/dev/A,ss://x/dev/B", output_path: "/tmp/x" },
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

// =============================================================================
// Action canonicalization + secrets-delete refusal
// =============================================================================

test("matchesSessionPattern: canonicalized action not in pattern.actions → false", () => {
  const p = makePattern({ actions: ["template-run"] }); // template-run only
  const b = makeBinding({ action: "run" }); // run → canonicalizes to "run", not in pattern
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: secrets_delete binding → false even with a permissive pattern", () => {
  // secrets-delete is NOT in SessionAction; canonicalAction returns null;
  // the matcher refuses.
  const p = makePattern({
    actions: ["template-run", "run", "inject-submit", "reveal-capture", "secrets-set", "inject_render"],
    ref_glob: "",
    destination_domains: [],
  });
  const b = makeBinding({ action: "secrets_delete" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: secrets_rotate binding → false even with a permissive pattern", () => {
  const p = makePattern({
    actions: ["template-run", "run", "inject-submit", "reveal-capture", "secrets-set", "inject_render"],
    ref_glob: "",
    destination_domains: [],
  });
  const b = makeBinding({ action: "secrets_rotate" });
  assert.equal(matchesSessionPattern(b, p), false);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/daemon/approvals/session-matchers.ts`:

```typescript
import { canonicalAction, globToRegExp, type SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

export function matchesSessionPattern(
  binding: ApprovalBinding,
  pattern: SessionPattern,
): boolean {
  const canonical = canonicalAction(binding.action);
  if (canonical === null) return false; // includes secrets_delete, secrets_rotate, anything unknown
  if (!pattern.actions.includes(canonical)) return false;

  switch (canonical) {
    case "template-run":
      return templateLikeMatches(binding, pattern, /* checkTemplateId */ true);
    case "inject-submit":
    case "reveal-capture":
      return templateLikeMatches(binding, pattern, /* checkTemplateId */ false);
    case "secrets-set":
      return secretsSetMatches(binding, pattern);
    case "run":
    case "inject_render":
      return refsListMatches(binding, pattern);
  }
}

function templateLikeMatches(
  binding: ApprovalBinding,
  pattern: SessionPattern,
  checkTemplateId: boolean,
): boolean {
  // ref check
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(binding.ref)) return false;
  }
  // domain check
  if (pattern.destination_domains.length > 0) {
    if (binding.destination_domain === null) return false;
    if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  }
  // template_id check (template-run only)
  if (checkTemplateId && pattern.template_ids !== undefined) {
    if (binding.template_id === null) return false;
    if (!pattern.template_ids.includes(binding.template_id)) return false;
  }
  return true;
}

function secretsSetMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  const plannedRef = binding.planned_ref ?? null;
  // planned_ref must match the glob
  if (pattern.ref_glob.length > 0) {
    if (plannedRef === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(plannedRef)) return false;
  }
  // binding.allowed_domains must be a SUBSET of pattern.destination_domains
  // (the human approved a domain set; the agent can't widen it).
  if (pattern.destination_domains.length > 0) {
    const allowed = binding.allowed_domains ?? [];
    const patternSet = new Set(pattern.destination_domains);
    for (const d of allowed) {
      if (!patternSet.has(d)) return false;
    }
  }
  // binding.allowed_actions must be a SUBSET of pattern.allowed_actions
  // (when pattern.allowed_actions is set).
  if (pattern.allowed_actions !== undefined) {
    const bindingActions = binding.allowed_actions ?? [];
    const patternSet = new Set(pattern.allowed_actions);
    for (const a of bindingActions) {
      if (!patternSet.has(a)) return false;
    }
  }
  return true;
}

function refsListMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  // For run / inject_render, refs are in binding.template_params.refs as a
  // comma-joined string. If template_params is null or refs is missing,
  // defensively refuse (the route MUST stash refs in template_params; if it
  // doesn't, we'd be matching with insufficient information).
  if (binding.template_params === null) return false;
  const refsStr = binding.template_params.refs;
  if (typeof refsStr !== "string") return false;
  const refs = refsStr.length === 0 ? [] : refsStr.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
  if (pattern.ref_glob.length > 0) {
    const re = globToRegExp(pattern.ref_glob);
    for (const ref of refs) {
      if (!re.test(ref)) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run — expect PASS** (~20 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-matchers.ts src/daemon/approvals/session-matchers.test.ts
git commit -m "feat(approvals): action-specific session matcher predicates

Closes the P0 'matchers unsafe for run/inject_render/secrets-set'.
Generic ref+domain check (used by template-run/inject-submit/
reveal-capture) is wrong for actions whose binding has ref:null:
  - run/inject_render: refs live in template_params.refs (comma-joined)
  - secrets-set: ref lives in planned_ref; allowed_domains must be ⊆ pattern.destination_domains
The dispatcher routes by canonical action; secrets-delete and
secrets-rotate canonicalize to null and refuse outright."
```

---

## Part C — Error codes

### Task C1: Add 7 new entries

**Files:**
- Modify: `src/shared/error-codes.ts` — add 7 entries.
- Modify: `src/shared/error-codes.test.ts` — bump count 110 → 117; spot-check.

Codes:
- `session_not_found` → `EXIT_CODE_NOT_FOUND` (3); hint null
- `session_expired` → `EXIT_CODE_PERMISSION` (4); hint null
- `session_max_uses_exceeded` → `EXIT_CODE_PERMISSION` (4); hint null
- `session_pattern_no_match` → `EXIT_CODE_PERMISSION` (4); hint null
- `session_unauthorized` → `EXIT_CODE_PERMISSION` (4); hint null
- `session_not_pending` → `EXIT_CODE_CONFLICT` (5); hint null
- `session_pattern_invalid_glob` → `EXIT_CODE_USAGE` (2); hint null

- [ ] **Step 1: Add registry entries in the correct sections** (Transient/Usage/NotFound/Permission/Conflict).

- [ ] **Step 2: Update count test 110 → 117**

```typescript
assert.equal(REGISTRY_ENTRIES, 117);
// Spot-checks:
for (const c of ["session_not_found", "session_expired", "session_max_uses_exceeded", "session_pattern_no_match", "session_pattern_invalid_glob"]) {
  assert.ok(lookupErrorCode(c), `${c} should be registered`);
}
```

- [ ] **Step 3: Run + commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(error-codes): 7 new session-related codes for Plan 4a"
```

---

## Part D — SessionStore

### Task D1: SessionStore with TTL-from-approval semantics

**Files:**
- Create: `src/daemon/approvals/session-store.ts`
- Create: `src/daemon/approvals/session-store.test.ts`

**Contract:** see types in Task A1's contract block.

**Critical invariants** (each one is a P0 fix from the design review):

1. **TTL anchored at APPROVAL.** `create()` sets `expires_at = created_at + PENDING_TTL_MS` (2-minute window for human to click approve). `approve()` RESETS `expires_at = now + pattern.ttl_ms`.
2. **All non-terminal states expire.** `get()` flips both `pending` AND `granted` to `expired` when `now > expires_at`. Today's ApprovalStore only flips pending → expired; for sessions we MUST flip granted → expired too.
3. **`approved_at` is null until approve().** Used by audit for "when did the human grant this?" forensics.
4. **`incrementUses` only on `granted`.** Pending / expired / revoked / denied all throw.

- [ ] **Step 1: Write failing tests**

Create `src/daemon/approvals/session-store.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./session-store.js";
import { type SessionPattern, PENDING_TTL_MS } from "./session.js";

function makePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

function makeStore(now: () => number = () => Date.now()): SessionStore {
  return new SessionStore({ now });
}

// create + initial state
test("SessionStore.create: returns a pending grant with PENDING_TTL_MS as expires_at", () => {
  const start = 1_000_000;
  const store = makeStore(() => start);
  const g = store.create(makePattern({ ttl_ms: 10 * 60 * 1000 }));
  assert.equal(g.status, "pending");
  assert.equal(g.created_at, start);
  assert.equal(g.approved_at, null);
  assert.equal(g.expires_at, start + PENDING_TTL_MS); // PENDING window, NOT pattern.ttl_ms
  assert.equal(g.uses, 0);
  assert.equal(typeof g.id, "string");
  assert.equal(typeof g.ui_token, "string");
  assert.notEqual(g.id, g.ui_token);
});

test("SessionStore.create: runs assertSessionPatternValid", () => {
  const store = makeStore();
  assert.throws(
    () => store.create(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

// pending → expired (existing semantic)
test("SessionStore.get: pending → expired when now > PENDING_TTL_MS past created_at", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern());
  assert.equal(store.get(g.id)!.status, "pending");
  nowVal += PENDING_TTL_MS + 1;
  assert.equal(store.get(g.id)!.status, "expired");
});

// approve() RESETS expires_at to now + pattern.ttl_ms
test("SessionStore.approve: resets expires_at = now + pattern.ttl_ms (TTL anchored at approval)", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const ttl = 10 * 60 * 1000;
  const g = store.create(makePattern({ ttl_ms: ttl }));
  // Human waits 90 seconds (1.5 minutes) before approving.
  nowVal += 90_000;
  store.approve(g.id);
  const after = store.get(g.id)!;
  assert.equal(after.status, "granted");
  assert.equal(after.approved_at, nowVal);
  // expires_at is now PATTERN.ttl_ms from the moment of approval, not creation.
  assert.equal(after.expires_at, nowVal + ttl);
});

// granted → expired (the P0 fix)
test("SessionStore.get: granted → expired when now > expires_at (P0 fix)", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern({ ttl_ms: 60_000 }));
  store.approve(g.id);
  assert.equal(store.get(g.id)!.status, "granted");
  nowVal += 60_001;
  // Without the fix this would still say "granted" forever.
  assert.equal(store.get(g.id)!.status, "expired");
});

// approve() on already-expired pending → session_expired
test("SessionStore.approve: rejects an expired-pending session with session_not_pending", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern());
  nowVal += PENDING_TTL_MS + 1; // pending window elapsed
  assert.throws(
    () => store.approve(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_pending",
  );
});

test("SessionStore.deny: pending → denied", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.deny(g.id);
  assert.equal(store.get(g.id)!.status, "denied");
});

test("SessionStore.revoke: granted → revoked", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  store.revoke(g.id);
  assert.equal(store.get(g.id)!.status, "revoked");
});

test("SessionStore.revoke: unknown id throws session_not_found", () => {
  const store = makeStore();
  assert.throws(
    () => store.revoke("nope"),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("SessionStore.list: insertion order", () => {
  const store = makeStore();
  const a = store.create(makePattern());
  const b = store.create(makePattern());
  const c = store.create(makePattern());
  assert.deepEqual(store.list().map((g) => g.id), [a.id, b.id, c.id]);
});

// incrementUses
test("SessionStore.incrementUses: granted session counts up", () => {
  const store = makeStore();
  const g = store.create(makePattern({ max_uses: 3 }));
  store.approve(g.id);
  store.incrementUses(g.id);
  store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 2);
});

test("SessionStore.incrementUses: throws at max_uses cap", () => {
  const store = makeStore();
  const g = store.create(makePattern({ max_uses: 2 }));
  store.approve(g.id);
  store.incrementUses(g.id);
  store.incrementUses(g.id);
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_max_uses_exceeded",
  );
});

test("SessionStore.incrementUses: max_uses undefined → unlimited", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  for (let i = 0; i < 50; i++) store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 50);
});

test("SessionStore.incrementUses: pending status throws session_not_pending", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_pending",
  );
});

test("SessionStore.incrementUses: expired (granted but expires_at past) throws session_expired", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern({ ttl_ms: 1000 }));
  store.approve(g.id);
  nowVal += 2000;
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
});

test("SessionStore.incrementUses: revoked session throws session_not_found", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  store.revoke(g.id);
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("SessionStore.get: unknown id returns undefined", () => {
  const store = makeStore();
  assert.equal(store.get("nope"), undefined);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/daemon/approvals/session-store.ts`:

```typescript
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
    return [...this.grants.values()];
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
```

- [ ] **Step 4: Run — expect PASS** (~18 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-store.ts src/daemon/approvals/session-store.test.ts
git commit -m "feat(approvals): SessionStore with TTL-anchored-at-approval semantics

Closes P0 'granted sessions never expire'. Two semantic fixes:
  1. expires_at starts at created_at + PENDING_TTL_MS (2min). On
     approve(), expires_at is RESET to now + pattern.ttl_ms. The
     human's clock starts when they click approve.
  2. get() flips both pending AND granted to expired when past
     expires_at — not just pending.
incrementUses honors the transition: a TTL-expired granted session
throws session_expired."
```

---

## Part E — findOrMintFromSession on ApprovalStore

### Task E1: ApprovalStore.findOrMintFromSession

**Files:**
- Modify: `src/daemon/approvals/store.ts` — extend `ApprovalGrant` + add method.
- Modify: `src/daemon/approvals/store.test.ts` — tests.

**Method contract:**

```typescript
findOrMintFromSession(
  sessionId: string,
  binding: ApprovalBinding,
  sessionStore: SessionStore,
): ApprovalGrant;
```

Order of operations:
1. `sessionStore.get(sessionId)`. If undefined OR status === `revoked` → throw `session_not_found`.
2. If status === `expired` → throw `session_expired`.
3. If status === `denied` → throw `session_unauthorized`.
4. If status !== `granted` (still pending) → throw `session_unauthorized`.
5. `matchesSessionPattern(binding, session)`. If false → throw `session_pattern_no_match`.
6. `sessionStore.incrementUses(sessionId)`. Can throw `session_max_uses_exceeded` or `session_expired` (defensive — the get() at step 1 should have caught expiry but the time advances).
7. Synthesize a `status: "used"` grant with `session_id` set. Do NOT insert into `this.grants` — session mints are one-shot. Fire `onEvent({ kind: "used", grant })`.

- [ ] **Step 1: Add `session_id?: string` to `ApprovalGrant`**

In `src/daemon/approvals/store.ts`:

```typescript
export interface ApprovalGrant extends ApprovalBinding {
  id: string;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  ui_token: string;
  /** Set when this grant was minted from a pre-approved session. */
  session_id?: string;
}
```

- [ ] **Step 2: Append tests to `src/daemon/approvals/store.test.ts`**

```typescript
import { SessionStore } from "./session-store.js";
import { matchesSessionPattern } from "./session-matchers.js";

function makeBindingFor(action: ApprovalBinding["action"], extra: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action,
    ref: "ss://x/prod/A",
    environment: "production",
    destination_domain: "vercel.com",
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
    ...extra,
  };
}

test("findOrMintFromSession: unknown id → session_not_found", () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  assert.throws(
    () => store.findOrMintFromSession("nope", makeBindingFor("template"), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("findOrMintFromSession: matched + granted → synthesizes used grant with session_id", () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    destination_domain: "vercel.com",
    template_id: "vercel-env-add",
  });
  const grant = store.findOrMintFromSession(sg.id, binding, sessions);
  assert.equal(grant.status, "used");
  assert.equal(grant.session_id, sg.id);
  assert.equal(grant.id.startsWith(`session:${sg.id}:`), true);
  assert.equal(sessions.get(sg.id)!.uses, 1);
});

test("findOrMintFromSession: expired (granted past TTL) → session_expired", () => {
  let nowVal = 1_000_000;
  const sessions = new SessionStore({ now: () => nowVal });
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 1000,
  });
  sessions.approve(sg.id);
  nowVal += 2000;
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { destination_domain: "vercel.com" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
});

test("findOrMintFromSession: revoked → session_not_found", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  sessions.revoke(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { destination_domain: "vercel.com" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("findOrMintFromSession: pending (not approved) → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { destination_domain: "vercel.com" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: denied → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.deny(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { destination_domain: "vercel.com" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: pattern mismatch → session_pattern_no_match", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    ref: "ss://other/prod/A",
    destination_domain: "vercel.com",
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_pattern_no_match",
  );
});

test("findOrMintFromSession: max_uses overflow → session_max_uses_exceeded", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
    max_uses: 2,
  });
  sessions.approve(sg.id);
  const store = new ApprovalStore();
  const binding = makeBindingFor("template", { destination_domain: "vercel.com" });
  store.findOrMintFromSession(sg.id, binding, sessions);
  store.findOrMintFromSession(sg.id, binding, sessions);
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_max_uses_exceeded",
  );
});

test("findOrMintFromSession: secrets_delete binding → session_pattern_no_match (action not allowed in sessions)", () => {
  const sessions = new SessionStore();
  // Create a permissive session that COULD match in a generic matcher.
  const sg = sessions.create({
    actions: ["template-run", "run", "inject-submit", "reveal-capture", "secrets-set", "inject_render"],
    ref_glob: "",
    destination_domains: [],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("secrets_delete"), sessions),
    (err: Error & { code?: string }) => err.code === "session_pattern_no_match",
  );
});
```

- [ ] **Step 3: Implement**

Add to `src/daemon/approvals/store.ts`:

```typescript
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionStore } from "./session-store.js";

// Inside ApprovalStore class:

private sessionMintCounter = 0;

findOrMintFromSession(
  sessionId: string,
  binding: ApprovalBinding,
  sessionStore: SessionStore,
): ApprovalGrant {
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
  if (!matchesSessionPattern(binding, session)) {
    throw new ShuttleError(
      "session_pattern_no_match",
      "Operation does not match the session pattern.",
    );
  }
  sessionStore.incrementUses(sessionId); // can throw session_max_uses_exceeded or session_expired
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
  this.onEvent?.({ kind: "used", grant });
  return grant;
}
```

- [ ] **Step 4: Run + commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts
git commit -m "feat(approvals): ApprovalStore.findOrMintFromSession

Synthesizes a used grant from a session+binding match. Doesn't
insert into the grant map — session mints are one-shot. Carries
session_id so downstream audit records the source. Returns false
for non-SessionAction bindings (secrets-delete, secrets-rotate)
via the matcher's canonicalAction-returns-null path."
```

---

## Part F — requireApproval session fast-path

### Task F1: Integrate sessions into requireApproval

**Files:**
- Modify: `src/daemon/approvals/require-approval.ts`
- Modify: `src/daemon/approvals/require-approval.test.ts`

**Contract:**

Extend `RequireApprovalOptions`:
```typescript
export interface RequireApprovalOptions {
  // ... existing fields
  sessionId?: string;
  sessionStore?: SessionStore;
}
```

Flow:
1. If env is non-production AND `force !== true` → existing synthesize path (no session check).
2. Else, if `sessionId !== undefined && sessionStore !== undefined`:
   - Try `store.findOrMintFromSession(sessionId, binding, sessionStore)`.
   - On `session_pattern_no_match`: fall back to single-use flow.
   - On any OTHER ShuttleError (session_not_found, session_expired, session_unauthorized, session_max_uses_exceeded): re-throw.
3. Else: existing single-use flow.

- [ ] **Step 1: Append tests**

```typescript
test("requireApproval: matching session → returns session-minted grant; no openUrl call", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  const grant = await requireApproval({
    store,
    sessionStore: sessions,
    sessionId: sg.id,
    binding: {
      action: "template",
      ref: "ss://x/prod/A",
      environment: "production",
      destination_domain: "vercel.com",
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: [],
    },
    daemonPort: 0,
    openUrlImpl: () => { opens += 1; },
  });
  assert.equal(grant.session_id, sg.id);
  assert.equal(grant.status, "used");
  assert.equal(opens, 0);
});

test("requireApproval: session_pattern_no_match falls back to single-use flow", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://OTHER/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "template",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: "vercel.com",
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "approval_required",
  );
  assert.equal(opens, 1, "single-use fallback should have opened a tab");
});

test("requireApproval: session_not_found re-thrown (no fallback)", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: "does-not-exist",
      binding: {
        action: "template",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: "vercel.com",
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
  assert.equal(opens, 0);
});

test("requireApproval: session_expired re-thrown (no fallback)", async () => {
  let nowVal = 1_000_000;
  const sessions = new SessionStore({ now: () => nowVal });
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 1000,
  });
  sessions.approve(sg.id);
  nowVal += 2000;
  const store = new ApprovalStore();
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "template",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: "vercel.com",
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
  assert.equal(opens, 0);
});

test("requireApproval: secrets_delete binding with a session → pattern_no_match → falls back to single-use", async () => {
  // The session cannot include secrets-delete (it's not a SessionAction).
  // Passing session_id with a secrets_delete binding fails the matcher and
  // falls through to single-use.
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run", "run", "inject-submit", "reveal-capture", "secrets-set", "inject_render"],
    ref_glob: "",
    destination_domains: [],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "secrets_delete",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "approval_required",
  );
  assert.equal(opens, 1);
});
```

- [ ] **Step 2: Implement**

```typescript
import type { SessionStore } from "./session-store.js";

export interface RequireApprovalOptions {
  store: ApprovalStore;
  binding: ApprovalBinding;
  daemonPort: number;
  approvalIdFromClient?: string;
  waitMs?: number;
  force?: boolean;
  openUrlImpl?: (url: string) => void;
  sessionId?: string;
  sessionStore?: SessionStore;
}

export async function requireApproval(opts: RequireApprovalOptions): Promise<ApprovalGrant> {
  const needsApproval = opts.force === true || opts.binding.environment === "production";
  if (!needsApproval) {
    return synthesizeGrant(opts.binding);
  }

  // Session fast-path.
  if (opts.sessionId !== undefined && opts.sessionStore !== undefined) {
    try {
      return opts.store.findOrMintFromSession(opts.sessionId, opts.binding, opts.sessionStore);
    } catch (e) {
      if (e instanceof ShuttleError && e.code === "session_pattern_no_match") {
        // Fall through to single-use flow.
      } else {
        throw e;
      }
    }
  }

  // (Existing single-use flow.)
  if (opts.approvalIdFromClient !== undefined) {
    return opts.store.consume(opts.approvalIdFromClient, opts.binding);
  }
  const grant = opts.store.create(opts.binding);
  const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${grant.id}&token=${grant.ui_token}`;
  (opts.openUrlImpl ?? openUrl)(url);
  if (opts.waitMs === 0) {
    throw new ShuttleError(
      "approval_required",
      JSON.stringify({ approval_id: grant.id, expires_at: grant.expires_at }),
    );
  }
  return waitForGrant(opts.store, grant.id, opts.waitMs ?? 2 * 60 * 1000, opts.binding);
}
```

- [ ] **Step 3: Run + commit**

```bash
git add src/daemon/approvals/require-approval.ts src/daemon/approvals/require-approval.test.ts
git commit -m "feat(approvals): requireApproval session fast-path

Tries findOrMintFromSession before single-use. session_pattern_no_match
falls back (the human still has to approve this op). Other session
errors (not_found, expired, unauthorized, max_uses) re-throw — silent
fallback would mask hard problems and make agents loop indefinitely."
```

---

## Part G — Session HTTP routes

### Task G1: `POST /v1/approvals/session` create + poll

**Files:**
- Create: `src/daemon/api/routes/approvals-session.ts`
- Create: `src/daemon/api/routes/approvals-session.test.ts`
- Modify: `src/daemon/services.ts` — expose `sessionStore: SessionStore`.
- Modify: `src/daemon/api/router.ts` — register.

**Behavior:**
- Body: `{ pattern: SessionPattern, wait_for_approval?: boolean }`.
- `parseSessionPatternFromBody(body)` — strict (per-field type checks; throw bad_request).
- `services.sessionStore.create(pattern)` — also runs assertSessionPatternValid.
- Open the session-approval UI: `openUrl("http://127.0.0.1:<port>/ui/sessions/<id>?token=<ui_token>")`.
- If `wait_for_approval === false`: return immediately with `{ session_id, status: "pending", expires_at }`.
- Else: poll the store every 200ms. Return on `granted`. Throw on `denied`, `expired`, or PENDING_TTL elapsing.

- [ ] **Step 1: Wire sessionStore into DaemonServices**

```typescript
// src/daemon/services.ts
import { SessionStore } from "./approvals/session-store.js";

export class DaemonServices {
  // existing fields...
  readonly sessionStore = new SessionStore();
}
```

- [ ] **Step 2: Write failing route tests** (real harness; tests approve through the HTTP UI route — DEFINED in Task H1 — NOT via direct sessionStore mutation)

Create `src/daemon/api/routes/approvals-session.test.ts`. Mirror the harness in `src/daemon/api/routes/secrets-delete.test.ts` (mkdtemp + SECRET_SHUTTLE_HOME + INSECURE_DEV_MODE + registerRoutes + restore).

```typescript
test("POST /v1/approvals/session with wait_for_approval=false returns session_id + status:pending", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["vercel.com"],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    const body = r.body as { session_id: string; status: string; expires_at: number };
    assert.equal(typeof body.session_id, "string");
    assert.equal(body.status, "pending");
    assert.equal(typeof body.expires_at, "number");
    // expires_at is the PENDING window (~2 min), NOT the pattern.ttl_ms.
    const pending = ctx.services.sessionStore.get(body.session_id)!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.expires_at, pending.created_at + PENDING_TTL_MS);
  });
});

test("POST /v1/approvals/session: invalid pattern → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: [], // empty
        ref_glob: "ss://x/*",
        destination_domains: [],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "bad_request");
  });
});

test("POST /v1/approvals/session: invalid glob → session_pattern_invalid_glob", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://*/prod/*",
        destination_domains: [],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "session_pattern_invalid_glob");
  });
});

test("POST /v1/approvals/session: secrets-delete in actions → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["secrets-delete"],
        ref_glob: "ss://x/*",
        destination_domains: [],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "bad_request");
  });
});

test("POST /v1/approvals/session: ttl > 15min → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "",
        destination_domains: [],
        ttl_ms: 16 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "bad_request");
  });
});

test("POST /v1/approvals/session: wait flow — approve via HTTP UI route → returns status:granted", async () => {
  // This test exercises the real HTTP approval path (NOT direct sessionStore.approve()).
  // The session-ui route (Task H1) accepts POST /ui/sessions/:id/approve?token=<ui_token>.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const reqPromise = call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["vercel.com"],
        ttl_ms: 5000,
      },
    });
    // Poll the store for the new pending session, then approve via HTTP.
    let pending: { id: string; ui_token: string } | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pending === undefined) {
      const list = ctx.services.sessionStore.list();
      pending = list.find((s) => s.status === "pending");
      if (pending === undefined) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(pending, "expected a pending session");
    // Approve via HTTP UI route (not by mutating the store).
    const approveRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${pending.id}/approve?token=${pending.ui_token}`,
      { method: "POST" },
    );
    assert.equal(approveRes.status, 200);
    // Now the create call should return with status: granted.
    const r = await reqPromise;
    assert.equal(r.status, 200);
    const body = r.body as { status: string; session_id: string; expires_at: number };
    assert.equal(body.status, "granted");
    // expires_at is now TTL_ms past approval (not creation).
    const granted = ctx.services.sessionStore.get(body.session_id)!;
    assert.equal(granted.expires_at, granted.approved_at! + 5000);
  });
});
```

- [ ] **Step 3: Implement the route**

```typescript
// src/daemon/api/routes/approvals-session.ts
import { ShuttleError } from "../../../shared/errors.js";
import { openUrl } from "../../approvals/open-url.js";
import { assertSessionPatternValid, type SessionPattern, type SessionAction } from "../../approvals/session.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, optBool, reqString } from "../validate.js";

const POLL_INTERVAL_MS = 200;

export function registerApprovalsSessionRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/approvals/session", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const pattern = parseSessionPatternFromBody(o);
    const waitForApproval = optBool(o, "wait_for_approval");
    assertSessionPatternValid(pattern); // belt-and-braces; store.create does it too
    const grant = services.sessionStore.create(pattern);
    openUrl(`http://127.0.0.1:${daemonPortRef()}/ui/sessions/${grant.id}?token=${grant.ui_token}`);
    if (waitForApproval === false) {
      return { session_id: grant.id, status: "pending", expires_at: grant.expires_at };
    }
    // Poll until terminal status or PENDING window elapses.
    while (true) {
      const g = services.sessionStore.get(grant.id);
      if (g === undefined) throw new ShuttleError("session_not_found", "Session vanished.");
      if (g.status === "granted") {
        return { session_id: g.id, status: "granted", expires_at: g.expires_at };
      }
      if (g.status === "denied") throw new ShuttleError("approval_denied", "Session denied.");
      if (g.status === "expired") {
        throw new ShuttleError("approval_timeout", "Timed out waiting for session approval.");
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  });

  server.addRoute("GET", "/v1/approvals/sessions", () => {
    services.lock.requireKey();
    return {
      sessions: services.sessionStore.list().map((g) => ({
        id: g.id,
        status: g.status,
        actions: g.actions,
        ref_glob: g.ref_glob,
        destination_domains: g.destination_domains,
        ...(g.template_ids !== undefined ? { template_ids: g.template_ids } : {}),
        ...(g.allowed_actions !== undefined ? { allowed_actions: g.allowed_actions } : {}),
        ttl_ms: g.ttl_ms,
        ...(g.max_uses !== undefined ? { max_uses: g.max_uses } : {}),
        created_at: g.created_at,
        approved_at: g.approved_at,
        expires_at: g.expires_at,
        uses: g.uses,
      })),
    };
  });

  server.addRoute("POST", "/v1/approvals/sessions/revoke", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const sessionId = reqString(o, "session_id");
    services.sessionStore.revoke(sessionId); // throws session_not_found
    return { revoked: true, session_id: sessionId };
  });
}

function parseSessionPatternFromBody(o: Record<string, unknown>): SessionPattern {
  if (o.pattern === undefined) {
    throw new ShuttleError("missing_param", "pattern is required.");
  }
  if (o.pattern === null || typeof o.pattern !== "object" || Array.isArray(o.pattern)) {
    throw new ShuttleError("bad_request", "pattern must be an object.");
  }
  const p = o.pattern as Record<string, unknown>;
  if (!Array.isArray(p.actions)) {
    throw new ShuttleError("bad_request", "pattern.actions must be an array.");
  }
  for (const a of p.actions) {
    if (typeof a !== "string") {
      throw new ShuttleError("bad_request", "pattern.actions entries must be strings.");
    }
  }
  if (typeof p.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "pattern.ref_glob must be a string.");
  }
  if (!Array.isArray(p.destination_domains)) {
    throw new ShuttleError("bad_request", "pattern.destination_domains must be an array.");
  }
  for (const d of p.destination_domains) {
    if (typeof d !== "string") {
      throw new ShuttleError("bad_request", "pattern.destination_domains entries must be strings.");
    }
  }
  if (p.template_ids !== undefined) {
    if (!Array.isArray(p.template_ids)) {
      throw new ShuttleError("bad_request", "pattern.template_ids must be an array.");
    }
    for (const t of p.template_ids) {
      if (typeof t !== "string") {
        throw new ShuttleError("bad_request", "pattern.template_ids entries must be strings.");
      }
    }
  }
  if (p.allowed_actions !== undefined) {
    if (!Array.isArray(p.allowed_actions)) {
      throw new ShuttleError("bad_request", "pattern.allowed_actions must be an array.");
    }
    for (const a of p.allowed_actions) {
      if (typeof a !== "string") {
        throw new ShuttleError("bad_request", "pattern.allowed_actions entries must be strings.");
      }
    }
  }
  if (typeof p.ttl_ms !== "number") {
    throw new ShuttleError("bad_request", "pattern.ttl_ms must be a number.");
  }
  if (p.max_uses !== undefined && (typeof p.max_uses !== "number" || !Number.isInteger(p.max_uses))) {
    throw new ShuttleError("bad_request", "pattern.max_uses must be an integer.");
  }
  return {
    actions: p.actions as SessionAction[], // assertSessionPatternValid will validate the SessionAction enum
    ref_glob: p.ref_glob,
    destination_domains: p.destination_domains as string[],
    ...(p.template_ids !== undefined ? { template_ids: p.template_ids as string[] } : {}),
    ...(p.allowed_actions !== undefined ? { allowed_actions: p.allowed_actions as string[] } : {}),
    ttl_ms: p.ttl_ms,
    ...(p.max_uses !== undefined ? { max_uses: p.max_uses as number } : {}),
  };
}
```

Register in router.ts: `registerApprovalsSessionRoutes(server, services, daemonPortRef)`.

- [ ] **Step 4: Run + commit**

```bash
git add src/daemon/api/routes/approvals-session.ts src/daemon/api/routes/approvals-session.test.ts \
  src/daemon/api/router.ts src/daemon/services.ts
git commit -m "feat(daemon): POST /v1/approvals/session + list + revoke

Body { pattern: SessionPattern, wait_for_approval? }. Opens
/ui/sessions/:id?token=<ui_token> for human approval. Returns
status:pending immediately when wait_for_approval=false, otherwise
polls until granted / denied / pending-window-expired (approval_timeout).
List + revoke complete the lifecycle."
```

---

## Part H — Session UI approve/deny routes (CLOSES P0 contract gap)

### Task H1: session-ui-server.ts

**Files:**
- Create: `src/daemon/approvals/session-ui-server.ts`
- Create: `src/daemon/approvals/session-ui-server.test.ts`
- Modify: `src/daemon/api/router.ts` — register.

**This task closes the design-review P0** "no session approve/deny HTTP/UI contract". Mirrors `src/daemon/approvals/ui-server.ts` exactly — per-URL-token auth, `addRouteRaw`, simple approve/deny endpoints.

**Routes:**
- `GET /ui/sessions/:id?token=<ui_token>` → returns the session as JSON (for the approval UI to render the pattern).
- `POST /ui/sessions/:id/approve?token=<ui_token>` → calls `sessionStore.approve(id)`.
- `POST /ui/sessions/:id/deny?token=<ui_token>` → calls `sessionStore.deny(id)`.

Each route:
1. Parses id from URL.
2. Validates `token` query param against `sessionStore.get(id)?.ui_token`. Wrong/missing token → 401 with `ui_token_mismatch`.
3. Unknown id → 404 with `session_not_found`.
4. Performs the action; returns JSON.

- [ ] **Step 1: Write failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
// ... harness imports

test("GET /ui/sessions/:id with valid token → 200 with session JSON", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}?token=${sg.ui_token}`);
    assert.equal(r.status, 200);
    const body = await r.json() as { id: string; status: string; actions: string[]; ref_glob: string };
    assert.equal(body.id, sg.id);
    assert.equal(body.status, "pending");
    assert.deepEqual(body.actions, ["template-run"]);
    assert.equal(body.ref_glob, "ss://x/prod/*");
  });
});

test("GET /ui/sessions/:id with WRONG token → 401 ui_token_mismatch", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}?token=WRONG`);
    assert.equal(r.status, 401);
    const body = await r.json() as { error_code: string };
    assert.equal(body.error_code, "ui_token_mismatch");
  });
});

test("GET /ui/sessions/:id unknown id → 404 session_not_found", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/sessions/missing?token=any`);
    assert.equal(r.status, 404);
    const body = await r.json() as { error_code: string };
    assert.equal(body.error_code, "session_not_found");
  });
});

test("POST /ui/sessions/:id/approve transitions status + resets expires_at", async () => {
  let nowVal = 1_000_000;
  const sessions = new SessionStore({ now: () => nowVal });
  // We need to inject the now-mocked SessionStore into the daemon. For
  // simplicity, this test uses the default sessionStore but observes
  // behavior via the daemon — separate from the store-unit test.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    const r = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}/approve?token=${sg.ui_token}`,
      { method: "POST" },
    );
    assert.equal(r.status, 200);
    const granted = ctx.services.sessionStore.get(sg.id)!;
    assert.equal(granted.status, "granted");
    assert.ok(granted.approved_at !== null);
  });
});

test("POST /ui/sessions/:id/deny transitions status", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    const r = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}/deny?token=${sg.ui_token}`,
      { method: "POST" },
    );
    assert.equal(r.status, 200);
    assert.equal(ctx.services.sessionStore.get(sg.id)!.status, "denied");
  });
});

test("POST /ui/sessions/:id/approve with wrong token → 401", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    const r = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}/approve?token=WRONG`,
      { method: "POST" },
    );
    assert.equal(r.status, 401);
  });
});

test("POST /ui/sessions/:id/approve on an already-denied session → 409 session_not_pending", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    // Deny first via HTTP.
    await fetch(`http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}/deny?token=${sg.ui_token}`, { method: "POST" });
    // Now try to approve.
    const r = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}/approve?token=${sg.ui_token}`,
      { method: "POST" },
    );
    assert.equal(r.status, 409); // conflict
    const body = await r.json() as { error_code: string };
    assert.equal(body.error_code, "session_not_pending");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/approvals/session-ui-server.ts
import { timingSafeEqual } from "node:crypto";
import { ShuttleError, errorToJson } from "../../shared/errors.js";
import type { DaemonServer } from "../server.js";
import type { SessionStore } from "./session-store.js";

export function registerSessionUiRoutes(server: DaemonServer, sessionStore: SessionStore): void {
  // GET /ui/sessions/:id?token=<ui_token>
  server.addRouteRaw("GET", /^\/ui\/sessions\/[^/]+$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/sessions\/([^/]+)$/);
    if (m === null) {
      writeError(res, 400, new ShuttleError("bad_request", "Bad URL."));
      return;
    }
    const id = m[1] as string;
    const token = url.searchParams.get("token") ?? "";
    const grant = sessionStore.get(id);
    if (grant === undefined) {
      writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
      return;
    }
    if (!tokensMatch(grant.ui_token, token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: grant.id,
      status: grant.status,
      actions: grant.actions,
      ref_glob: grant.ref_glob,
      destination_domains: grant.destination_domains,
      ...(grant.template_ids !== undefined ? { template_ids: grant.template_ids } : {}),
      ...(grant.allowed_actions !== undefined ? { allowed_actions: grant.allowed_actions } : {}),
      ttl_ms: grant.ttl_ms,
      ...(grant.max_uses !== undefined ? { max_uses: grant.max_uses } : {}),
      created_at: grant.created_at,
      approved_at: grant.approved_at,
      expires_at: grant.expires_at,
    }));
  });

  // POST /ui/sessions/:id/approve?token=<ui_token>
  server.addRouteRaw("POST", /^\/ui\/sessions\/[^/]+\/(approve|deny)$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/sessions\/([^/]+)\/(approve|deny)$/);
    if (m === null) {
      writeError(res, 400, new ShuttleError("bad_request", "Bad URL."));
      return;
    }
    const id = m[1] as string;
    const verb = m[2] as "approve" | "deny";
    const token = url.searchParams.get("token") ?? "";
    const grant = sessionStore.get(id);
    if (grant === undefined) {
      writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
      return;
    }
    if (!tokensMatch(grant.ui_token, token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    try {
      if (verb === "approve") sessionStore.approve(id);
      else sessionStore.deny(id);
    } catch (e) {
      // session_not_pending → 409 conflict.
      if (e instanceof ShuttleError && e.code === "session_not_pending") {
        writeError(res, 409, e);
        return;
      }
      writeError(res, 400, e);
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: verb === "approve" ? "granted" : "denied" }));
  });
}

function tokensMatch(expected: string, actual: string): boolean {
  const e = Buffer.from(expected);
  const a = Buffer.from(actual);
  if (a.byteLength !== e.byteLength) return false;
  return timingSafeEqual(a, e);
}

function writeError(res: import("node:http").ServerResponse, status: number, err: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(errorToJson(err)));
}
```

Register in router.ts: `registerSessionUiRoutes(server, services.sessionStore)`.

- [ ] **Step 3: Run + commit**

```bash
git add src/daemon/approvals/session-ui-server.ts src/daemon/approvals/session-ui-server.test.ts \
  src/daemon/api/router.ts
git commit -m "feat(approvals): /ui/sessions/:id GET + approve/deny routes

Closes the P0 'no session approve/deny UI contract'. Mirrors
ui-server.ts per-URL-token auth pattern. Route tests exercise the
HTTP path (approve via fetch, NOT direct sessionStore.approve
mutation). 409 on session_not_pending; 401 on token mismatch; 404
on unknown id."
```

---

## Part I — Wire `session_id` through every approval-gated route

### Task I1: One commit per route

For each route below, add `session_id` body parsing, pass to `requireApproval`, record `grant.session_id` in the audit entry. The CLI flag is added in Part J.

Routes (one commit each for bisectability):
1. `src/daemon/api/routes/templates.ts`
2. `src/daemon/api/routes/run-resolve.ts`
3. `src/daemon/api/routes/inject-render.ts`
4. `src/daemon/api/routes/secrets.ts` (the generate endpoint)
5. `src/daemon/api/routes/inject-submit.ts`
6. `src/daemon/api/routes/reveal-capture.ts`
7. `src/daemon/api/routes/secrets-delete.ts` — accepts the body field; daemon rejects via pattern_no_match and falls back to single-use
8. `src/daemon/api/routes/secrets-rotate.ts` — same
9. `src/daemon/api/routes/compare.ts`
10. `src/daemon/api/routes/capture.ts`
11. `src/daemon/api/routes/inject.ts` (V0)

**Per-route change pattern:**

```typescript
// In the body-validation block:
const sessionId = optString(o, "session_id");

// Pass to requireApproval:
const grant = await requireApproval({
  store: services.approvals,
  binding,
  daemonPort: daemonPortRef(),
  sessionStore: services.sessionStore,
  ...(sessionId !== undefined ? { sessionId } : {}),
  ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
  ...(waitForApproval === false ? { waitMs: 0 } : {}),
});

// When writing audit:
await writeDaemonAudit({
  action: "template_run",
  ok: ...,
  ref: ...,
  ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
});
```

- [ ] **Step 0: Update DaemonAuditEvent** — add `session_id?: string` to the type in `src/daemon/audit.ts`. ONE commit:

```bash
git add src/daemon/audit.ts
git commit -m "feat(audit): DaemonAuditEvent.session_id field"
```

- [ ] **Step 1-11: One commit per route.** Each commit:
  - Adds `session_id` body param.
  - Passes through to `requireApproval`.
  - Records `session_id` in audit entries.
  - Adds ONE happy-path test that asserts the audit line carries `session_id` AND `sessionStore.get(id).uses` incremented.

Example per-route commit message:

```
feat(routes/templates): accept session_id; audit records source session

If session_id is supplied and the binding matches the session pattern,
requireApproval mints a used grant from the session and skips the per-op
approval window. The grant carries session_id which the route now writes
into the template_run audit entry.
```

- [ ] **Step 12: After all 11 routes**, verify:

```bash
git log --oneline | head -15  # ~11 small commits + 1 audit-type commit
npm test  # all pass
```

---

## Part J — CLI: `internal session` + `--session <id>` on approval-gated commands

### Task J1: `secret-shuttle internal session create / list / revoke`

**Files:**
- Create: `src/cli/commands/internal-session.ts`
- Create: `src/cli/commands/internal-session.test.ts`
- Modify: `src/cli/commands/internal.ts` — register.

- [ ] **Step 1: Write structural tests**

```typescript
test("internalSessionCommand: has create, list, revoke subcommands", () => {
  const cmd = internalSessionCommand();
  const names = cmd.commands.map((c) => c.name());
  assert.deepEqual(names.sort(), ["create", "list", "revoke"]);
});

test("internal session create: required + repeatable flags", () => {
  const create = internalSessionCommand().commands.find((c) => c.name() === "create")!;
  const longs = create.options.map((o) => o.long);
  assert.ok(longs.includes("--actions"));
  assert.ok(longs.includes("--ref-glob"));
  assert.ok(longs.includes("--destination-domain"));
  assert.ok(longs.includes("--ttl"));
  assert.ok(longs.includes("--max-uses"));
  assert.ok(longs.includes("--no-wait"));
});

test("internal session revoke: positional <session-id>", () => {
  const revoke = internalSessionCommand().commands.find((c) => c.name() === "revoke")!;
  const args = (revoke as unknown as { registeredArguments: Array<{ _name: string }> }).registeredArguments;
  assert.equal(args.length, 1);
});
```

- [ ] **Step 2: Implement**

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";

export function internalSessionCommand(): Command {
  const cmd = new Command("session").description("Pre-approved session management.");

  cmd
    .command("create")
    .description("Mint a session pattern. Opens the approval UI for the human to approve the SHAPE.")
    .requiredOption("--actions <list>", "Comma-separated SessionActions: template-run | inject-submit | reveal-capture | secrets-set | run | inject_render")
    .requiredOption("--ref-glob <glob>", "Literal prefix + optional trailing * (e.g. ss://stripe/prod/*). Empty string = no ref check.")
    .option("--destination-domain <domain>", "Allowed destination domain (repeatable)", collectRepeated, [])
    .option("--template-id <id>", "Restrict to specific template_id (repeatable)", collectRepeated, [])
    .option("--allowed-action <action>", "For secrets-set: required ⊇ for binding.allowed_actions (repeatable)", collectRepeated, [])
    .option("--ttl <ms>", "TTL in ms after approval; max 900000 (15min); default 300000 (5min)", (v) => Number.parseInt(v, 10), 5 * 60 * 1000)
    .option("--max-uses <n>", "Usage cap (1-1000)", (v) => Number.parseInt(v, 10))
    .option("--no-wait", "Return session_id immediately with status:pending")
    .option("--json", "Forward-compat no-op", false)
    .action(async (options) => {
      const allowedActions = options.allowedAction as string[];
      const body = {
        pattern: {
          actions: (options.actions as string).split(",").map((s) => s.trim()),
          ref_glob: options.refGlob,
          destination_domains: options.destinationDomain,
          ...((options.templateId as string[]).length > 0 ? { template_ids: options.templateId } : {}),
          ...(allowedActions.length > 0 ? { allowed_actions: allowedActions } : {}),
          ttl_ms: options.ttl,
          ...(options.maxUses !== undefined ? { max_uses: options.maxUses } : {}),
        },
        ...(options.wait === false ? { wait_for_approval: false } : {}),
      };
      const r = await daemonRequest("POST", "/v1/approvals/session", body);
      outputJson(ok(r as Record<string, unknown>));
    });

  cmd
    .command("list")
    .description("List all sessions (pending, granted, expired, denied, revoked).")
    .option("--json", "Forward-compat no-op", false)
    .action(async () => {
      const r = await daemonRequest("GET", "/v1/approvals/sessions");
      outputJson(ok(r as Record<string, unknown>));
    });

  cmd
    .command("revoke")
    .argument("<session-id>", "Session id")
    .description("Revoke a session. Subsequent uses fail with session_not_found.")
    .option("--json", "Forward-compat no-op", false)
    .action(async (sessionId: string) => {
      const r = await daemonRequest("POST", "/v1/approvals/sessions/revoke", { session_id: sessionId });
      outputJson(ok(r as Record<string, unknown>));
    });

  return cmd;
}
```

Register in `internal.ts`:

```typescript
import { internalSessionCommand } from "./internal-session.js";
// ...
cmd.addCommand(internalSessionCommand());
```

- [ ] **Step 3: Run + commit**

```bash
git add src/cli/commands/internal-session.ts src/cli/commands/internal-session.test.ts src/cli/commands/internal.ts
git commit -m "feat(cli): internal session create/list/revoke"
```

### Task J2: Add `--session <id>` to approval-gated CLI commands

One commit per command. For each command, add the flag and pass through to the body:

```typescript
.option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
// ...
body.session_id = options.session;  // when present
```

Commands (11 total):
- `src/cli/commands/run.ts`
- `src/cli/commands/inject.ts`
- `src/cli/commands/secrets/set.ts`
- `src/cli/commands/secrets/delete.ts`
- `src/cli/commands/secrets/rotate.ts`
- `src/cli/commands/template-run.ts` (or wherever template-run lives)
- `src/cli/commands/inject-submit.ts`
- `src/cli/commands/reveal-capture.ts`
- `src/cli/commands/compare.ts` (under internal/)
- `src/cli/commands/capture.ts` (under internal/)
- `src/cli/commands/inject-internal.ts` (V0)

Add ONE structural test per command:

```typescript
test("runCommand: --session flag accepted", () => {
  const cmd = runCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
```

After all 11 commands, run full suite + commit each. Single trailing aggregate verify commit:

```bash
git log --oneline | head -15  # ~11 small commits
npm test  # all pass
```

---

## Part K — Verify + CHANGELOG

### Task K1: Full suite verification

- [ ] **Step 1**: `npm test` — expect ~707 baseline + ~70 new tests (A1: 21 + B1: 20 + D1: 18 + E1: 9 + F1: 5 + G: 5 + H: 7 + I: ~11 + J: 4 ≈ 100 new; total ~807).
- [ ] **Step 2**: `npm run typecheck` — clean.
- [ ] **Step 3**: `npm run check-pack` — clean.
- [ ] **Step 4**: Manual smoke:

```bash
# 1. Daemon running + vault unlocked.
# 2. Create a session.
secret-shuttle internal session create \
  --actions template-run \
  --ref-glob "ss://local/prod/*" \
  --destination-domain vercel.com \
  --ttl 300000 \
  --no-wait
# → returns { session_id, status: "pending", expires_at }
# → approval UI opens with session details.

# 3. Approve in UI.

# 4. Verify session list.
secret-shuttle internal session list

# 5. Run a template under the session — should NOT open a new approval tab.
secret-shuttle template run vercel-env-add --ref ss://local/prod/X --param environment=production --session <id>

# 6. Verify uses incremented.
secret-shuttle internal session list

# 7. Try a NON-matching op under the same session — should open a normal approval tab (single-use fallback).
secret-shuttle template run vercel-env-add --ref ss://OTHER/prod/Y --session <id> --no-wait
# → approval_required (per-op flow kicked in).

# 8. Revoke and verify subsequent uses fail with session_not_found.
secret-shuttle internal session revoke <id>
secret-shuttle template run vercel-env-add --ref ss://local/prod/X --session <id> --no-wait
# → session_not_found.
```

- [ ] **Step 5**: No commit (verification only).

### Task K2: CHANGELOG + curated help update

**Files:**
- Modify: `src/cli/commands/help.ts` — one-line mention.
- Modify: `CHANGELOG.md` — Plan 4a entries.

- [ ] **Step 1: CHANGELOG**

```markdown
### Added — Plan 4a (pre-approved sessions)
- **Pre-approved sessions.** `POST /v1/approvals/session` mints a session pattern that the human approves once. Subsequent operations carrying `session_id` (CLI: `--session <id>`) that match the pattern skip the per-op approval window. Mismatches fall back to the single-use flow transparently. Each minted grant is a discrete one-shot binding under the hood; the audit log shows N distinct operations with `session_id` set, not "1 session". CLI: `secret-shuttle internal session create | list | revoke`. Spec §5.7.
- **Action-specific matchers.** The session pattern's `ref_glob` is applied to:
  - binding.ref for template-run, inject-submit, reveal-capture
  - binding.planned_ref for secrets-set
  - every ref in binding.template_params.refs for run and inject_render (every ref must match)
  Generic-glob matching against binding.ref would have unsafely auto-approved any production ref under run/inject_render/secrets-set sessions; this fix scopes correctly per action.
- **TTL anchored at approval, not creation.** `expires_at` starts at `created_at + 2min` (pending window for the human to click). On approve, `expires_at` resets to `now + pattern.ttl_ms`. So a human who takes 90 seconds to read the pattern still gets the full requested session window.
- **Granted sessions expire.** `SessionStore.get()` flips both pending AND granted states to `expired` past `expires_at`. Without this, an approved session would live until revoke or process restart.
- **Destructive actions cannot be put in a session.** `secrets-delete` and `secrets-rotate` are NOT `SessionAction` values; passing them in a session pattern throws `bad_request`. Their CLI commands accept `--session <id>` for surface uniformity, but the daemon rejects with `session_pattern_no_match` and falls back to a fresh per-op approval.
- **Session UI HTTP routes.** New `GET /ui/sessions/:id?token=<ui_token>` and `POST /ui/sessions/:id/approve|deny?token=<ui_token>` mirror the per-URL-token approval-UI pattern. Tests approve via these HTTP routes — never by mutating the store directly.

### Security
- The matcher for `secrets-set` checks `binding.allowed_domains ⊆ pattern.destination_domains` (subset, not equality). An agent can't widen the domain set the human approved.
- The matcher for `secrets-set` similarly checks `binding.allowed_actions ⊆ pattern.allowed_actions` when `pattern.allowed_actions` is set.
- Patterns cannot use full globs — only literal prefix + optional single trailing `*`. Reduces matcher complexity and "I didn't think it would match THAT" surprises.
- TTL is hard-capped at 15 minutes. Beyond that the human re-approves.
```

- [ ] **Step 2: Curated help**

Add one line under "Advanced":

```
  internal session create / list / revoke    Pre-approved batch sessions
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/help.ts CHANGELOG.md
git commit -m "docs(changelog): Plan 4a — pre-approved sessions"
```

---

## Self-Review

**1. Spec coverage**

| Spec §11 deliverable | Task |
|---|---|
| Pre-approved sessions (§5.7) | A1 (types+glob) + B1 (matchers) + C1 (registry) + D1 (store) + E1 (mint) + F1 (requireApproval) + G1 (HTTP routes) + H1 (UI routes) |
| Session pattern: actions, ref_glob, destination_domains, template_ids, ttl_ms, max_uses | A1 + B1 |
| Approval flow: human approves shape once; subsequent ops auto-mint | F1 (require-approval session fast-path) |
| Each minted op has its own audit entry with session_id | Audit type update (Part I step 0) + per-route wiring (I1-11) |
| Approval UI for session creation | H1 (GET/approve/deny routes) — Plan 4b ships the actual HTML for the stable-shell case |
| Internal session CLI | J1 |
| `--session <id>` on every approval-gated CLI command | J2 |
| Audit captures session_id | I0 + I1-11 |

**2. Placeholder scan**

No TBD, no "Similar to Task N", no "implement details". Every test is concrete. Every code block is complete. The `ui-server.ts` writeError helper used in Task H1 is referenced as if importable; if the actual file structures it differently, the implementer follows the existing pattern.

**3. Type consistency**

- `SessionAction` defined in A1; consumed in A1 (assert), B1 (matchers), D1 (store), E1 (audit), F1 (requireApproval), G1 (route), H1 (UI), J1 (CLI).
- `SessionPattern` defined in A1; consumed in A1, B1, D1, G1, H1, J1.
- `SessionGrant` defined in A1 (`extends SessionPattern`); consumed in D1, G1, H1.
- `ApprovalGrant.session_id?: string` added in E1; consumed in I0+ audit wiring.
- `DaemonAuditEvent.session_id?: string` added in I0; consumed in I1-11.
- `findOrMintFromSession` defined in E1; consumed in F1.
- `matchesSessionPattern` defined in B1; consumed in E1 (findOrMintFromSession), F1 (indirectly via E1).

**4. Scope**

Plan 4a is sessions ONLY. Tab reuse is Plan 4b. Stdin pass-through is Plan 4c. ~22 tasks; ~100 new tests; one commit per logical unit (per-route wiring is one commit each).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan4a-sessions.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality), same pattern as Plans 1, 2, and 3.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
