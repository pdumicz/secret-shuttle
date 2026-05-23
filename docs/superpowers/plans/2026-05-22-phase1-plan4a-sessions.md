# Phase 1 — Plan 4a: Pre-approved sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land §5.7 pre-approved sessions. A human approves a *pattern* once; the daemon mints single-use grants matching that pattern for up to 15 minutes from APPROVAL time. Subsequent agent operations carrying `--session <id>` or `session_id` in the body skip the per-op approval window for matches; non-matching ops fall back to the per-op flow.

**Architecture:** Four load-bearing pieces. (1) `SessionStore` holds session grants with TTL anchored at approval time (not creation), and `get()`/`list()` flip ALL non-terminal sessions to `expired` past `expires_at` — fixing the granted-sessions-never-expire trap. (2) `SessionPattern` matching dispatches by canonical SessionAction to action-specific predicates that read the field where the binding actually stores its ref: `binding.ref` for **template-run** and **inject-submit**; `binding.planned_ref` for **reveal-capture** (the new secret) and **secrets-set**. The matcher canonicalizes destructive actions (secrets-delete, secrets-rotate) AND the deferred actions (run, inject_render) to `null`, refusing them outright. (3) `SessionAction` is scoped to four values in v0.2.0: `template-run`, `inject-submit`, `reveal-capture`, `secrets-set`. `run` and `inject_render` are NOT session-capable in Plan 4a — passing `--session` to those commands still surfaces in the body, but the daemon falls back to the per-op approval flow. (4) Session approvals get a real human-facing HTML page at `GET /ui/session?id=&token=` plus per-session-ui-token-authenticated JSON sub-routes at `GET /ui/sessions/:id` and `POST /ui/sessions/:id/approve|deny`. Route integration tests approve through HTTP, not by mutating the store directly.

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

- **Tab reuse is NOT in Plan 4a.** Plan 4a opens one tab per session-approval (same as today's per-approval flow). The "one tab per daemon lifetime" UX improvement is Plan 4b. Plan 4a's session-approval URL (`/ui/session?id=&token=`) is the entry the Plan 4b stable-shell will later subsume; the JSON sub-routes (`/ui/sessions/:id`, `/ui/sessions/:id/approve|deny`) survive unchanged.
- **Stdin pass-through is NOT in Plan 4a.** Plan 4c.
- **Session pattern globs are literal-prefix + single trailing `*`.** Full glob (`?`, `[...]`, `**`) throws `session_pattern_invalid_glob` at create time. Documented + tested.
- **`SessionAction` is tightly scoped in v0.2.0.** Round-2 review pointed out that loosely-constrained sessions for `run` (no command_prefix) and `inject_render` (no output-mode check) are too broad — a `run` session could be reused for any child binary; an `inject_render` session could switch from a daemon-written file to `-o -` and expose plaintext. Rather than half-implement those constraints, **`run` and `inject_render` are dropped from `SessionAction` in Plan 4a**. They become CLI-pass-through-only: passing `--session <id>` to `secret-shuttle run` or `secret-shuttle inject` sends the body field, but the daemon's session matcher rejects with `session_pattern_no_match` (because no SessionAction value covers them), and the route falls back to per-op approval. A future plan adds them back with `command_prefix` for run + `output_mode` for inject_render.
- **Destructive actions are not session-capable.** `secrets-delete` and `secrets-rotate` are also excluded from `SessionAction`. Same pass-through-with-fallback semantics as run/inject_render.
- **Final `SessionAction` list:** `template-run`, `inject-submit`, `reveal-capture`, `secrets-set`. Only four. The Stripe → Vercel walkthrough in spec §6.1 (the primary motivating use case) uses exactly these four.

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/daemon/approvals/session.ts` | `SessionPattern` type, `SessionAction` enum, `SessionStatus` enum, `SessionGrant` type, `globToRegExp` + `assertSessionPatternValid` + `assertSessionPatternValidGlob`. |
| `src/daemon/approvals/session.test.ts` | Pattern + glob + validation unit tests. |
| `src/daemon/approvals/session-store.ts` | `SessionStore` class — create / get (with expiry transition) / approve (resets expires_at) / deny / revoke / list / incrementUses. |
| `src/daemon/approvals/session-store.test.ts` | Lifecycle tests INCLUDING granted-state-expiry coverage. |
| `src/daemon/approvals/session-matchers.ts` | Action-specific predicates: `templateRunMatches` (ref + template_ids, NO destination_domains), `injectSubmitMatches` (ref + destination_domain), `revealCaptureMatches` (planned_ref + destination_domain), `secretsSetMatches` (planned_ref + allowed_domains ⊆ pattern + allowed_actions ⊆ pattern). Plus the top-level `matchesSessionPattern(binding, pattern)` dispatcher. `run` and `inject_render` canonicalize to `null` and are refused. |
| `src/daemon/approvals/session-matchers.test.ts` | Per-predicate tests — proves run/inject_render/secrets-set sessions can't auto-approve unrelated production refs. |
| `src/daemon/api/routes/approvals-session.ts` | `POST /v1/approvals/session` (create + poll), `GET /v1/approvals/sessions` (list), `POST /v1/approvals/sessions/revoke`. |
| `src/daemon/api/routes/approvals-session.test.ts` | Route tests — approve via the HTTP UI route (not by mutating the store). |
| `src/daemon/approvals/session-ui.html` | The human-facing HTML approval page template (Task G1). Daemon string-replaces `__SESSION_ID__`, `__UI_TOKEN__`, `__TTL_MINUTES__`, `__PATTERN_JSON__` at serve time. Inline CSS + JS — no external assets. |
| `src/daemon/approvals/session-ui-server.ts` | Three routes: `GET /ui/session?id=<id>&token=<ui_token>` (HTML — this is what `openUrl` opens, Task G1); `GET /ui/sessions/:id?token=<ui_token>` (JSON session data — Task G2); `POST /ui/sessions/:id/approve\|deny?token=<ui_token>` (JSON action endpoints the HTML page posts to — Task G2). Per-URL-token auth, mirrors existing `ui-server.ts` model. |
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
| `src/cli/commands/template.ts` | Same — `--session` on the `run` subcommand (file is `template.ts`, the subcommand is `template run`). |
| `src/cli/commands/blind.ts` | Same — `--session` on the `end` subcommand (blind_end is approval-gated; pass-through fallback). |
| `src/cli/commands/inject-submit.ts` | Same. |
| `src/cli/commands/reveal-capture.ts` | Same. |
| `CHANGELOG.md` | Plan 4a entries. |

**Decision: TTL anchored at APPROVAL time, not creation.** Spec line 388 says "approve up to N operations matching this shape for N minutes". User-visible expectation: when the human clicks approve, the clock starts. Otherwise a human who takes 4 minutes to review the pattern gets a 1-minute usable session — terrible UX. Implementation: `SessionStore.create` sets a short PENDING_TTL (`120_000` ms = 2 minutes for the human to approve); on `approve()`, expires_at is RESET to `now + pattern.ttl_ms`. Both pending and granted states use the same expires_at field; `get()` flips both pending AND granted past expires_at to `expired`.

**Decision: action-specific matcher predicates.** Plan 4a's matcher dispatches by canonical SessionAction. Round-2 review caught two real bugs the unified plan had:
- `reveal-capture` binding has `ref: null` — the new secret's ref lives in `binding.planned_ref` (see `src/daemon/api/routes/reveal-capture.ts:145`). A matcher checking `binding.ref` against the glob would silently auto-approve any ref.
- `template-run` binding has `destination_domain: null` (`src/daemon/api/routes/templates.ts:91`). A pattern with `destination_domains: ["vercel.com"]` would never match any template_run. The security boundary for template-run is `template_id`, not domain — vercel-env-add IS implicitly vercel.com.

The corrected matcher table:

| SessionAction | Binding field(s) inspected | Pattern fields enforced |
|---|---|---|
| `template-run` | `binding.ref`, `binding.template_id` | `ref_glob`, `template_ids` (REQUIRED non-empty); `destination_domains` ignored (current bindings never set it for templates) |
| `inject-submit` | `binding.ref`, `binding.destination_domain` | `ref_glob`, `destination_domains` (REQUIRED non-empty) |
| `reveal-capture` | `binding.planned_ref`, `binding.destination_domain` | `ref_glob`, `destination_domains` (REQUIRED non-empty) |
| `secrets-set` | `binding.planned_ref`, `binding.allowed_domains`, `binding.allowed_actions` | `ref_glob`, `destination_domains` (REQUIRED non-empty; must be a SUPERSET of binding.allowed_domains), `allowed_actions` (REQUIRED non-empty for secrets-set patterns; entries validated against `ALL_SECRET_ACTIONS`; binding.allowed_actions must be ⊆ pattern.allowed_actions) |

Four pattern-validation requirements at session-CREATE time:
- A pattern listing **template-run** MUST set non-empty `template_ids`.
- A pattern listing **inject-submit**, **reveal-capture**, or **secrets-set** MUST set non-empty `destination_domains`.
- A pattern listing **secrets-set** MUST set non-empty `allowed_actions`. Entries are validated against `ALL_SECRET_ACTIONS` from `src/vault/types.ts` (`capture_from_page`, `inject_into_field`, `compare_fingerprint`, `use_as_stdin`, `inject_submit`). Without this rule, a `secrets-set` session could auto-approve a secret whose action set the human never explicitly scoped — the failure mode is "I approved 'create a stripe-prod key' and the agent created one that ALSO permits inject-into-field on github.com later".
- (A pattern with only template-run does NOT need `destination_domains`; it's allowed empty.)

Note the **superset-not-equal** semantic for secrets-set: pattern.destination_domains is the SET OF ALLOWED domains for any minted secret; the operation's binding.allowed_domains must be ⊆ pattern.destination_domains. The agent can't widen the domain set the human approved.

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
  | "secrets-set";      // "generate"
  // NOTE: NOT in v0.2.0 SessionAction:
  //   - "run" and "inject_render": need command_prefix / output_mode constraints; future plan
  //   - "secrets-delete" / "secrets-rotate": destructive ops are always human-gated

export interface SessionPattern {
  actions: SessionAction[];
  ref_glob: string;                 // "" = no ref check; otherwise literal prefix + optional single trailing *
  destination_domains: string[];    // REQUIRED non-empty when actions include inject-submit/reveal-capture/secrets-set
  template_ids?: string[];          // REQUIRED non-empty when actions includes template-run
  allowed_actions?: string[];       // REQUIRED non-empty when actions includes secrets-set; entries validated against ALL_SECRET_ACTIONS
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
    template_ids: ["vercel-env-add"], // required for template-run patterns
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

test("canonicalAction: run returns null (deferred from Plan 4a)", () => {
  // run needs a command_prefix constraint to be safe in a session; deferred.
  assert.equal(canonicalAction("run"), null);
});

test("canonicalAction: inject_render returns null (deferred from Plan 4a)", () => {
  // inject_render needs an output_mode constraint to be safe; deferred.
  assert.equal(canonicalAction("inject_render"), null);
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
  // template-run is exempt from destination_domains; here we only need template_ids.
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["template-run"],
    ref_glob: "",
    destination_domains: [],
    template_ids: ["any-template"],
  })));
});

// New round-2 fix: domain-bearing actions REQUIRE non-empty destination_domains.
test("assertSessionPatternValid: inject-submit with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["inject-submit"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: reveal-capture with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["reveal-capture"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with empty destination_domains throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: [],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: template-run with empty template_ids throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["template-run"],
      destination_domains: [], // exempt
      template_ids: [], // empty — NOT exempt
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: template-run with template_ids undefined throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["template-run"],
      destination_domains: [],
      // template_ids unset
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

// secrets-set requires allowed_actions (round-4 P1 fix).
test("assertSessionPatternValid: secrets-set with empty allowed_actions throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      allowed_actions: [], // empty
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with allowed_actions undefined throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      // allowed_actions unset
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: allowed_actions entry outside ALL_SECRET_ACTIONS throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({
      actions: ["secrets-set"],
      destination_domains: ["vercel.com"],
      allowed_actions: ["use_as_stdin", "nope_invalid"],
    })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: secrets-set with valid allowed_actions passes", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern({
    actions: ["secrets-set"],
    destination_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin", "inject_into_field"],
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
import { ALL_SECRET_ACTIONS } from "../../vault/types.js";

export type SessionAction =
  | "template-run"
  | "inject-submit"
  | "reveal-capture"
  | "secrets-set";

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
  // Shape-check allowed_actions FIRST (array + string entries + enum membership)
  // before the per-action requirement loop touches pattern.allowed_actions.length.
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
  // Per-action requirements (closes round-2 P1 'empty destination_domains for domain-bearing actions').
  for (const action of pattern.actions) {
    if (DOMAIN_REQUIRED.has(action) && pattern.destination_domains.length === 0) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty destination_domains. ` +
          `Use --destination-domain to restrict the session to specific domains.`,
      );
    }
    if (TEMPLATE_IDS_REQUIRED.has(action) &&
        (pattern.template_ids === undefined || pattern.template_ids.length === 0)) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty template_ids. ` +
          `Use --template-id to restrict the session to specific templates.`,
      );
    }
    if (ALLOWED_ACTIONS_REQUIRED.has(action) &&
        (pattern.allowed_actions === undefined || pattern.allowed_actions.length === 0)) {
      throw new ShuttleError(
        "bad_request",
        `Session action '${action}' requires non-empty allowed_actions. ` +
          `Use --allowed-action to scope what the minted secret will permit. ` +
          `Valid values: ${[...VALID_SECRET_ACTIONS].join(", ")}.`,
      );
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
- `template-run` — ref + template_ids only. `destination_domains` is IGNORED (binding sets `destination_domain: null` per templates.ts:91). Pattern MUST set non-empty `template_ids` (enforced at validate time).
- `inject-submit` — ref + destination_domain. Pattern MUST set non-empty `destination_domains`.
- `reveal-capture` — `binding.planned_ref` (not binding.ref — see reveal-capture.ts:148) + destination_domain. Pattern MUST set non-empty `destination_domains`.
- `secrets-set` — planned_ref against ref_glob; binding.allowed_domains ⊆ pattern.destination_domains (subset, not equality); binding.allowed_actions ⊆ pattern.allowed_actions. Pattern MUST set non-empty `destination_domains` AND non-empty `allowed_actions` (entries validated against `ALL_SECRET_ACTIONS`).
- Anything else (including `run`, `inject_render`, `secrets_delete`, `secrets_rotate`) — `canonicalAction` returns null; matcher returns false outright; routes fall back to per-op approval.

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
    template_ids: ["vercel-env-add"], // required for template-run patterns
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// =============================================================================
// template-run / inject-submit / reveal-capture (generic ref+domain matcher)
// =============================================================================

// Helper: template-run patterns require template_ids; inject-submit /
// reveal-capture / secrets-set require destination_domains. Local helper
// makes valid patterns for these tests without needing to repeat the
// requirements in every test.
function templatePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// =============================================================================
// template-run: ref + template_id (destination_domains IGNORED by design;
// see src/daemon/api/routes/templates.ts:91 where binding.destination_domain
// is null)
// =============================================================================

test("template-run: ref + template_id match → true (destination_domain on binding ignored)", () => {
  const p = templatePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: null, // current binding shape — null
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("template-run: ref mismatch → false", () => {
  const p = templatePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/dev/STRIPE_KEY",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: template_id constraint violated → false", () => {
  const p = templatePattern({ template_ids: ["vercel-env-add"] });
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    template_id: "github-actions-secret",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("template-run: template_ids empty in pattern → matcher refuses (defense-in-depth; assertSessionPatternValid catches this at create)", () => {
  // The pattern-level assertSessionPatternValid REQUIRES non-empty
  // template_ids for template-run patterns; but if a malformed pattern
  // somehow bypasses validation, the matcher itself must still refuse.
  const p = { ...templatePattern(), template_ids: [] };
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// inject-submit: ref + destination_domain
// =============================================================================

test("inject-submit: ref+domain match → true", () => {
  const p = makePattern({ actions: ["inject-submit"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("inject-submit: domain mismatch → false", () => {
  const p = makePattern({ actions: ["inject-submit"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "evil.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// reveal-capture: PLANNED_REF (not binding.ref — see reveal-capture.ts:148)
// =============================================================================

test("reveal-capture: planned_ref + domain match → true (binding.ref is null on this action)", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null, // reveal_capture binding has ref:null; planned_ref carries the future ref
    planned_ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("reveal-capture: matcher uses planned_ref, NOT binding.ref (P0 regression fix)", () => {
  // Regression for the round-2 P0: prior matcher used binding.ref which is
  // always null for reveal_capture, so ANY pattern would silently auto-approve.
  // Now we use planned_ref. With a planned_ref OUTSIDE the glob, refuse.
  const p = makePattern({ actions: ["reveal-capture"], ref_glob: "ss://stripe/prod/*" });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://OTHER/prod/STRIPE_KEY", // outside glob
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("reveal-capture: planned_ref missing → false (defensive)", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: null,
    destination_domain: "vercel.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("reveal-capture: domain mismatch → false", () => {
  const p = makePattern({ actions: ["reveal-capture"] });
  const b = makeBinding({
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "evil.com",
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

// =============================================================================
// secrets-set (planned_ref + allowed_domains + allowed_actions semantics)
// =============================================================================

test("secrets-set: planned_ref matches glob; allowed_domains ⊆ pattern.destination_domains; allowed_actions ⊆ pattern.allowed_actions → true", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com", "github.com"],
    allowed_actions: ["use_as_stdin", "inject_into_field"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/NEW_KEY",
    allowed_domains: ["vercel.com"], // ⊆ pattern.destination_domains
    allowed_actions: ["use_as_stdin"], // ⊆ pattern.allowed_actions
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("secrets-set: planned_ref outside glob → false", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/dev/NEW_KEY", // dev not prod
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_domains contains a domain NOT in pattern → false (NOT superset-allowed)", () => {
  // Security-relevant: the session pre-approves vercel.com, the agent tries
  // to mint a secret that ALSO allows github.com. Refuse — the human
  // approved vercel.com only.
  const p = makePattern({
    actions: ["secrets-set"],
    destination_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin"], // required for secrets-set
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com", "github.com"], // github.com is wider
    allowed_actions: ["use_as_stdin"],
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: pattern.allowed_actions + binding.allowed_actions ⊆ pattern → true", () => {
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

test("secrets-set: binding.allowed_actions wider than pattern → false", () => {
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: ["use_as_stdin", "inject_submit"], // wider
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_actions undefined → false (defense in depth)", () => {
  // The generate route populates binding.allowed_actions before requireApproval,
  // so an undefined value here means the binding came from somewhere that
  // doesn't carry the contract. Refuse rather than silently auto-approve a
  // secret with no action scope.
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    // allowed_actions: undefined  ← intentionally omitted
  });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("secrets-set: binding.allowed_actions explicit empty [] → true (deliberately narrow scope)", () => {
  // An empty array is a deliberately narrow scope — the binding wants the
  // secret to allow NO actions. ⊆ pattern.allowed_actions vacuously holds.
  const p = makePattern({
    actions: ["secrets-set"],
    allowed_actions: ["use_as_stdin"],
  });
  const b = makeBinding({
    action: "generate",
    ref: null,
    planned_ref: "ss://stripe/prod/A",
    allowed_domains: ["vercel.com"],
    allowed_actions: [], // explicit empty — narrower than the pattern, OK
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

// =============================================================================
// run / inject_render are NOT SessionActions in Plan 4a — see the pass-through
// refusal tests at the bottom of this file.
// =============================================================================

// =============================================================================
// Action canonicalization + pass-through refusal for non-SessionActions
// =============================================================================

test("matchesSessionPattern: canonicalized action not in pattern.actions → false", () => {
  const p = makePattern({ actions: ["template-run"], template_ids: ["v"] }); // template-run only
  const b = makeBinding({ action: "inject_submit" }); // canonicalizes to inject-submit, not in pattern
  assert.equal(matchesSessionPattern(b, p), false);
});

// Helper: build the broadest pattern that assertSessionPatternValid accepts —
// all four SessionAction values + non-empty destination_domains + template_ids
// + non-empty allowed_actions (covers the entire ALL_SECRET_ACTIONS surface).
// Used by the pass-through refusal tests below to prove that even a maximally
// wide LEGAL pattern still refuses non-SessionAction bindings.
function broadestLegalPattern(): SessionPattern {
  return {
    actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
    ref_glob: "",
    destination_domains: ["any.com"],
    template_ids: ["any"],
    allowed_actions: [
      "capture_from_page",
      "inject_into_field",
      "compare_fingerprint",
      "use_as_stdin",
      "inject_submit",
    ],
    ttl_ms: 60_000,
  };
}

test("matchesSessionPattern: secrets_delete binding → false (not a SessionAction)", () => {
  // secrets-delete is NOT in SessionAction; canonicalAction returns null.
  // Even the broadest legal pattern refuses.
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "secrets_delete" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: secrets_rotate binding → false", () => {
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "secrets_rotate" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: run binding → false (not a SessionAction in Plan 4a)", () => {
  // run is deferred from Plan 4a (needs command_prefix). Same pass-through-
  // refusal as destructive actions.
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "run" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: inject_render binding → false (not a SessionAction in Plan 4a)", () => {
  // inject_render is deferred from Plan 4a (needs output_mode constraint).
  const p = broadestLegalPattern();
  const b = makeBinding({ action: "inject_render" });
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
      return templateRunMatches(binding, pattern);
    case "inject-submit":
      return injectSubmitMatches(binding, pattern);
    case "reveal-capture":
      return revealCaptureMatches(binding, pattern);
    case "secrets-set":
      return secretsSetMatches(binding, pattern);
  }
}

/**
 * template-run: ref + template_id. NO destination_domain check because the
 * template_run route currently sets binding.destination_domain = null
 * (see src/daemon/api/routes/templates.ts:91) — a destination_domains
 * constraint here would never match. The security boundary for template
 * sessions is template_ids; templates have implicit destinations encoded
 * by the template_id (e.g. vercel-env-add → vercel.com).
 */
function templateRunMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(binding.ref)) return false;
  }
  // template_ids is REQUIRED non-empty by assertSessionPatternValid for
  // template-run patterns; checking length > 0 is defense in depth.
  if (pattern.template_ids === undefined || pattern.template_ids.length === 0) return false;
  if (binding.template_id === null) return false;
  if (!pattern.template_ids.includes(binding.template_id)) return false;
  return true;
}

/**
 * inject-submit: ref + destination_domain. Both are populated by the route.
 */
function injectSubmitMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(binding.ref)) return false;
  }
  // destination_domains is REQUIRED non-empty by assertSessionPatternValid.
  if (pattern.destination_domains.length === 0) return false;
  if (binding.destination_domain === null) return false;
  if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  return true;
}

/**
 * reveal-capture: PLANNED_REF (not binding.ref — see
 * src/daemon/api/routes/reveal-capture.ts:148) + destination_domain.
 * The reveal-capture flow MINTS a new secret; binding.ref is null until
 * after the operation completes.
 */
function revealCaptureMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  const plannedRef = binding.planned_ref ?? null;
  if (pattern.ref_glob.length > 0) {
    if (plannedRef === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(plannedRef)) return false;
  }
  if (pattern.destination_domains.length === 0) return false;
  if (binding.destination_domain === null) return false;
  if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  return true;
}

/**
 * secrets-set: planned_ref + allowed_domains ⊆ pattern.destination_domains
 * + allowed_actions ⊆ pattern.allowed_actions.
 * The agent cannot widen what the human approved on either axis.
 */
function secretsSetMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  const plannedRef = binding.planned_ref ?? null;
  if (pattern.ref_glob.length > 0) {
    if (plannedRef === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(plannedRef)) return false;
  }
  // Both REQUIRED non-empty by assertSessionPatternValid. Defense-in-depth: if
  // a pattern slipped past validation without one of these, refuse outright
  // rather than silently auto-approve a too-wide secret.
  if (pattern.destination_domains.length === 0) return false;
  if (pattern.allowed_actions === undefined || pattern.allowed_actions.length === 0) return false;
  const allowedDomains = binding.allowed_domains ?? [];
  const domainPatternSet = new Set(pattern.destination_domains);
  for (const d of allowedDomains) {
    if (!domainPatternSet.has(d)) return false; // binding widens the approved domains
  }
  // Defense-in-depth: refuse if the binding doesn't carry an explicit action
  // scope at all. The generate route populates binding.allowed_actions before
  // requireApproval, so missing-undefined here means the binding came from
  // somewhere that doesn't carry the contract; don't session-approve. An
  // explicit empty array ([]) is allowed — that's a deliberately narrow scope.
  if (binding.allowed_actions === undefined) return false;
  const actionsPatternSet = new Set(pattern.allowed_actions);
  for (const a of binding.allowed_actions) {
    if (!actionsPatternSet.has(a)) return false; // binding widens the approved actions
  }
  return true;
}
```

- [ ] **Step 4: Run — expect PASS** (~20 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-matchers.ts src/daemon/approvals/session-matchers.test.ts
git commit -m "feat(approvals): action-specific session matcher predicates

Closes the P0 'matchers unsafe for some action shapes'. Each SessionAction
reads from the field where its real route stores the ref:
  - template-run: binding.ref + template_ids (destination_domain is null on
    template bindings; the security boundary is template_id)
  - inject-submit: binding.ref + destination_domain
  - reveal-capture: binding.planned_ref + destination_domain (binding.ref is
    null for this action; refer to src/daemon/api/routes/reveal-capture.ts:148)
  - secrets-set: binding.planned_ref + allowed_domains ⊆ pattern + allowed_actions ⊆ pattern
The dispatcher routes by canonical action; run, inject_render,
secrets_delete, secrets_rotate all canonicalize to null and refuse outright."
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
    template_ids: ["vercel-env-add"], // required for template-run patterns
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

test("SessionStore.list: normalizes expiry — expired-but-untouched sessions show 'expired' (P2 fix)", () => {
  // Round-2 review caught: list() returned raw map values, so a granted
  // session whose expires_at had passed (but whose status field hadn't been
  // touched via get()) would still appear as 'granted' to /v1/approvals/sessions
  // and the CLI. Now list() runs the same expiry transition as get().
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const granted = store.create(makePattern({ ttl_ms: 1000 }));
  store.approve(granted.id);
  const pendingForever = store.create(makePattern()); // long PENDING window
  nowVal += 5000; // past granted's ttl AND past pendingForever's pending TTL? (PENDING_TTL_MS=120_000) → no
  // Bump well past PENDING_TTL_MS for the pending session.
  nowVal += 200_000;
  const listed = store.list();
  const grantedAfter = listed.find((g) => g.id === granted.id)!;
  const pendingAfter = listed.find((g) => g.id === pendingForever.id)!;
  assert.equal(grantedAfter.status, "expired");
  assert.equal(pendingAfter.status, "expired");
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
    destination_domains: [], // ignored for template-run
    template_ids: ["vercel-env-add"], // required for template-run
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    destination_domain: null, // current template binding shape (see templates.ts:91)
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
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 1000,
  });
  sessions.approve(sg.id);
  nowVal += 2000;
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
});

test("findOrMintFromSession: revoked → session_not_found", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  sessions.revoke(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("findOrMintFromSession: pending (not approved) → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: denied → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.deny(sg.id);
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { template_id: "vercel-env-add" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("findOrMintFromSession: pattern mismatch → session_pattern_no_match", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    ref: "ss://other/prod/A", // outside the glob
    template_id: "vercel-env-add",
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
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
    max_uses: 2,
  });
  sessions.approve(sg.id);
  const store = new ApprovalStore();
  const binding = makeBindingFor("template", { template_id: "vercel-env-add" });
  store.findOrMintFromSession(sg.id, binding, sessions);
  store.findOrMintFromSession(sg.id, binding, sessions);
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_max_uses_exceeded",
  );
});

test("findOrMintFromSession: secrets_delete binding → session_pattern_no_match (action not allowed in sessions)", () => {
  const sessions = new SessionStore();
  // The broadest legal pattern (all 4 SessionActions + non-empty
  // destination_domains + template_ids + allowed_actions covering the full
  // ALL_SECRET_ACTIONS surface) satisfies assertSessionPatternValid.
  // secrets_delete is NOT a SessionAction; canonicalAction returns null;
  // the matcher refuses outright.
  const sg = sessions.create({
    actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
    ref_glob: "",
    destination_domains: ["any.com"],
    template_ids: ["any"],
    allowed_actions: [
      "capture_from_page",
      "inject_into_field",
      "compare_fingerprint",
      "use_as_stdin",
      "inject_submit",
    ],
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
    destination_domains: [],
    template_ids: ["vercel-env-add"],
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
      destination_domain: null, // current template-run binding shape (templates.ts:91)
      target_id: null,
      field_fingerprint: null,
      template_id: "vercel-env-add",
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
    destination_domains: [],
    template_ids: ["vercel-env-add"],
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
        ref: "ss://x/prod/A", // outside pattern.ref_glob
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
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
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
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
    destination_domains: [],
    template_ids: ["vercel-env-add"],
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
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
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
  // The session can't include secrets-delete (it's not a SessionAction).
  // Passing session_id with a secrets_delete binding canonicalizes to null,
  // matcher returns false → pattern_no_match → falls through to single-use.
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  // Broadest legal pattern: all 4 SessionActions + non-empty destination_domains
  // + template_ids + allowed_actions covering the full ALL_SECRET_ACTIONS set.
  const sg = sessions.create({
    actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
    ref_glob: "",
    destination_domains: ["any.com"],
    template_ids: ["any"],
    allowed_actions: [
      "capture_from_page",
      "inject_into_field",
      "compare_fingerprint",
      "use_as_stdin",
      "inject_submit",
    ],
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

## Part H — Session HTTP routes (depends on Part G's `/ui/sessions/...` routes)

### Task H1: `POST /v1/approvals/session` create + poll

**Files:**
- Create: `src/daemon/api/routes/approvals-session.ts`
- Create: `src/daemon/api/routes/approvals-session.test.ts`
- Modify: `src/daemon/services.ts` — expose `sessionStore: SessionStore`.
- Modify: `src/daemon/api/router.ts` — register.

**Ordering note:** This part depends on Part G (which now ships before H). G provides `/ui/session?id=&token=` (HTML), `/ui/sessions/:id` (JSON), and `/ui/sessions/:id/approve|deny` routes. The integration test in H1 ("wait flow") approves through the HTTP `/ui/sessions/:id/approve` route, so that route must exist.

**Behavior:**
- Body: `{ pattern: SessionPattern, wait_for_approval?: boolean }`.
- `parseSessionPatternFromBody(body)` — strict (per-field type checks; throw bad_request).
- `services.sessionStore.create(pattern)` — also runs assertSessionPatternValid.
- Open the human-facing HTML approval page: `openUrl("http://127.0.0.1:<port>/ui/session?id=<id>&token=<ui_token>")`. (The HTML page is the Task G1 route; the JSON sub-routes `/ui/sessions/:id` etc. are NOT what the browser opens.)
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

- [ ] **Step 2: Write failing route tests** (real harness; tests approve through the HTTP UI route — DEFINED in Part G earlier in this plan — NOT via direct sessionStore mutation)

Create `src/daemon/api/routes/approvals-session.test.ts`. Mirror the harness in `src/daemon/api/routes/secrets-delete.test.ts` (mkdtemp + SECRET_SHUTTLE_HOME + INSECURE_DEV_MODE + registerRoutes + restore).

```typescript
test("POST /v1/approvals/session with wait_for_approval=false returns session_id + status:pending", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [], // ignored for template-run
        template_ids: ["vercel-env-add"],
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
        ref_glob: "ss://*/prod/*", // ** equivalent — rejected by globToRegExp
        destination_domains: [],
        template_ids: ["vercel-env-add"],
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
        template_ids: ["any"], // required for template-run; the ttl check is what we're testing
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
  // The session-ui route from Part G2 accepts POST /ui/sessions/:id/approve?token=<ui_token>.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const reqPromise = call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: [],
        template_ids: ["vercel-env-add"],
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
    // Open the HTML approval page (not the JSON sub-route). The HTML page
    // POSTs to /ui/sessions/:id/approve|deny on button click.
    openUrl(`http://127.0.0.1:${daemonPortRef()}/ui/session?id=${grant.id}&token=${grant.ui_token}`);
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

Body { pattern: SessionPattern, wait_for_approval? }. Opens the HTML
approval page /ui/session?id=<id>&token=<ui_token> (created in Part G).
Returns status:pending immediately when wait_for_approval=false,
otherwise polls until granted / denied / pending-window-expired
(approval_timeout). List + revoke complete the lifecycle."
```

---

## Part G — Session UI (HTML approval page + JSON sub-routes)

### Task G1: HTML approval page — `GET /ui/session?id=<id>&token=<ui_token>`

Round-2 review caught that the unified plan opened `/ui/sessions/:id?token=...` in the browser, but that endpoint returned JSON, not HTML. **A human can't approve a JSON blob.** Plan 4a (revised) splits the surface:
- `GET /ui/session?id=<id>&token=<ui_token>` — **HTML** approval page (rendered by the daemon with the pattern embedded). This is what `openUrl` opens.
- `GET /ui/sessions/:id?token=<ui_token>` — **JSON** session data (for API consumers + the HTML page if it wants to refresh).
- `POST /ui/sessions/:id/approve|deny?token=<ui_token>` — JSON action endpoints; the HTML page posts to these on button click.

**Files:**
- Create: `src/daemon/approvals/session-ui.html` — Plain HTML template; the daemon string-replaces placeholders at serve time.
- Modify: `src/daemon/approvals/session-ui-server.ts` (created in Task G2 alongside the JSON routes) — register `GET /ui/session` here too.

**HTML page contract:**
- Self-contained HTML + inline `<style>` + inline `<script>` (no external assets — daemon is offline-friendly).
- Page renders the pattern in plain language: actions list, ref_glob, destination_domains, template_ids if any, ttl (in minutes), max_uses.
- Two buttons: "Approve for N minutes" and "Deny". Each posts to `/ui/sessions/<id>/approve|deny?token=<token>` and shows a post-action message.
- Daemon-side template substitution: `__SESSION_ID__`, `__UI_TOKEN__`, `__PATTERN_JSON__` (the SessionGrant minus `ui_token` and sensitive fields, JSON-stringified, HTML-escaped for `<script>` embedding).
- Cache-Control: no-store. Content-Security-Policy: `default-src 'self'; frame-ancestors 'none'`. The inline script needs `'unsafe-inline'` for v0.2.0; a nonce-based CSP is a Plan 4b enhancement.

- [ ] **Step 1: Write the HTML template + the GET /ui/session handler**

Create `src/daemon/approvals/session-ui.html` (sketch — implementer fills in the actual styling; the contract is the substitution markers + the form behavior):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Secret Shuttle — Session approval</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'">
  <meta name="referrer" content="no-referrer">
  <style>/* ... minimal CSS — readable on light backgrounds ... */</style>
</head>
<body>
  <main>
    <h1>Approve session</h1>
    <p class="warn">
      The agent is asking you to <strong>auto-approve up to N operations</strong>
      matching the pattern below, for the next <strong id="ttl-mins">__TTL_MINUTES__ minutes</strong> after you click <em>Approve</em>.
    </p>
    <pre id="pattern-json">__PATTERN_JSON__</pre>
    <p>If anything looks wrong, click <em>Deny</em>.</p>
    <div class="actions">
      <button id="approve">Approve for __TTL_MINUTES__ minutes</button>
      <button id="deny">Deny</button>
    </div>
    <p id="status"></p>
  </main>
  <script>
    (() => {
      const sessionId = "__SESSION_ID__";
      const uiToken = "__UI_TOKEN__";
      const url = (verb) => `/ui/sessions/${encodeURIComponent(sessionId)}/${verb}?token=${encodeURIComponent(uiToken)}`;
      const status = document.getElementById("status");
      function done(verb, ok) {
        document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        status.textContent = ok ? `Session ${verb}. You can close this tab.` : `Failed to ${verb}; refresh and try again.`;
      }
      document.getElementById("approve").addEventListener("click", async () => {
        const r = await fetch(url("approve"), { method: "POST" });
        done("approved", r.ok);
      });
      document.getElementById("deny").addEventListener("click", async () => {
        const r = await fetch(url("deny"), { method: "POST" });
        done("denied", r.ok);
      });
    })();
  </script>
</body>
</html>
```

- [ ] **Step 2: Write tests for the HTML route**

```typescript
test("GET /ui/session?id=&token= returns HTML with pattern embedded", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: [],
      template_ids: ["vercel-env-add"],
      ttl_ms: 300_000,
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=${sg.id}&token=${sg.ui_token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.ok(html.includes("Secret Shuttle"));
    assert.ok(html.includes("template-run")); // pattern visible
    assert.ok(html.includes("vercel-env-add"));
    assert.ok(html.includes(sg.id)); // session id embedded for the form
    // Token-bearing HTML pages MUST set these four headers. The meta tag in
    // the HTML body is not sufficient — browsers ignore meta CSP for
    // frame-ancestors enforcement.
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  });
});

test("GET /ui/session with wrong token → 401", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "",
      destination_domains: [],
      template_ids: ["any"],
      ttl_ms: 60_000,
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=${sg.id}&token=WRONG`);
    assert.equal(res.status, 401);
  });
});

test("GET /ui/session unknown id → 404", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=missing&token=any`);
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 3: Implement** — add the HTML route to `session-ui-server.ts` (file created in G2):

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "session-ui.html",
);

// (Inside registerSessionUiRoutes — register BEFORE the JSON routes so the regex
// for /ui/session matches first.)
server.addRouteRaw("GET", /^\/ui\/session(?:\?.*)?$/, async (req, _body, res) => {
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (id.length === 0 || token.length === 0) {
    writeError(res, 400, new ShuttleError("bad_request", "Missing id or token."));
    return;
  }
  const grant = sessionStore.get(id);
  if (grant === undefined) {
    writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
    return;
  }
  if (!tokensMatch(grant.ui_token, token)) {
    writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
    return;
  }
  const template = await readFile(HTML_PATH, "utf8");
  const safePattern = JSON.stringify({
    actions: grant.actions,
    ref_glob: grant.ref_glob,
    destination_domains: grant.destination_domains,
    template_ids: grant.template_ids,
    allowed_actions: grant.allowed_actions,
    ttl_ms: grant.ttl_ms,
    max_uses: grant.max_uses,
  }, null, 2);
  const html = template
    .replaceAll("__SESSION_ID__", htmlEscape(grant.id))
    .replaceAll("__UI_TOKEN__", htmlEscape(grant.ui_token))
    .replaceAll("__TTL_MINUTES__", String(Math.round(grant.ttl_ms / 60_000)))
    .replaceAll("__PATTERN_JSON__", htmlEscape(safePattern));
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  // Real CSP HTTP header — the <meta http-equiv> inside the HTML is widely
  // ignored for `frame-ancestors` enforcement; only the HTTP header counts.
  // Inline script is permitted via 'unsafe-inline' for v0.2.0; a nonce-based
  // CSP is a Plan 4b enhancement once the stable-shell UI lands.
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'",
  );
  res.end(html);
});

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

The same HTTP-header set (Cache-Control + Referrer-Policy + X-Content-Type-Options) is applied to the **JSON** sub-routes in Task G2 (`/ui/sessions/:id`, `/ui/sessions/:id/approve`, `/ui/sessions/:id/deny`). Those routes don't need `Content-Security-Policy` (they return JSON, not HTML), but they DO need the other three because the URL still carries a token. See G2's `writeError` helper update below.

- [ ] **Step 4: Verify the HTML serves**

```bash
npm run build && node --test "dist/daemon/approvals/session-ui-server.test.js"
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-ui.html src/daemon/approvals/session-ui-server.ts src/daemon/approvals/session-ui-server.test.ts
git commit -m "feat(approvals): GET /ui/session HTML approval page

Closes P0 'no human-usable session approval page'. The daemon
serves an HTML form at /ui/session?id=&token= that renders the
pattern in plain language and posts to /ui/sessions/:id/approve|deny
JSON endpoints on button click. Inline CSP + Cache-Control:no-store
+ Referrer-Policy:no-referrer."
```

---

### Task G2: JSON sub-routes — `/ui/sessions/:id` GET + `/ui/sessions/:id/approve|deny` POST

**Files:**
- Modify: `src/daemon/approvals/session-ui-server.ts` (created in G1) — append the JSON routes.
- Create: `src/daemon/approvals/session-ui-server.test.ts` (or extend G1's test file).
- Modify: `src/daemon/api/router.ts` — register.

Per-URL-token auth (mirrors `src/daemon/approvals/ui-server.ts`).

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

test("GET /ui/sessions/:id with valid token → 200 with session JSON + hardening headers", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
      ttl_ms: 60_000,
    });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/sessions/${sg.id}?token=${sg.ui_token}`);
    assert.equal(r.status, 200);
    const body = await r.json() as { id: string; status: string; actions: string[]; ref_glob: string };
    assert.equal(body.id, sg.id);
    assert.equal(body.status, "pending");
    assert.deepEqual(body.actions, ["template-run"]);
    assert.equal(body.ref_glob, "ss://x/prod/*");
    // Token-bearing JSON routes MUST set the hardening triplet.
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });
});

test("GET /ui/sessions/:id with WRONG token → 401 ui_token_mismatch", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
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
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
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
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
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
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
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
      destination_domains: [], // ignored for template-run
      template_ids: ["vercel-env-add"],
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
    setHardeningHeaders(res);
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
    setHardeningHeaders(res);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: verb === "approve" ? "granted" : "denied" }));
  });
}

/**
 * Set Cache-Control, Referrer-Policy, and X-Content-Type-Options on every
 * token-bearing UI response (HTML or JSON). Token-bearing means the request
 * URL carries `?token=<ui_token>`; browser caches or referrers leaking that
 * token would let a different process or page replay the action.
 */
function setHardeningHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}

function tokensMatch(expected: string, actual: string): boolean {
  const e = Buffer.from(expected);
  const a = Buffer.from(actual);
  if (a.byteLength !== e.byteLength) return false;
  return timingSafeEqual(a, e);
}

function writeError(res: import("node:http").ServerResponse, status: number, err: unknown): void {
  if (res.writableEnded) return;
  setHardeningHeaders(res);
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

**Two categories** (the round-2 P2 finding required this distinction):

**Session-capable routes** (matcher CAN auto-mint; happy-path test asserts audit `session_id` set AND `sessionStore.get(id).uses` incremented):
1. `src/daemon/api/routes/templates.ts` — action `template` → SessionAction `template-run`
2. `src/daemon/api/routes/secrets.ts` — generate endpoint, action `generate` → SessionAction `secrets-set`
3. `src/daemon/api/routes/inject-submit.ts` — action `inject_submit` → SessionAction `inject-submit`
4. `src/daemon/api/routes/reveal-capture.ts` — action `reveal_capture` → SessionAction `reveal-capture`

**Pass-through routes** (matcher returns null/no-match; CLI flag still accepted for surface uniformity, daemon falls back to single-use; test asserts audit entry does NOT carry `session_id` AND `sessionStore.get(id).uses` stayed at 0):
5. `src/daemon/api/routes/run-resolve.ts` — action `run` → null
6. `src/daemon/api/routes/inject-render.ts` — action `inject_render` → null
7. `src/daemon/api/routes/secrets-delete.ts` — action `secrets_delete` → null
8. `src/daemon/api/routes/secrets-rotate.ts` — action `secrets_rotate` → null
9. `src/daemon/api/routes/blind.ts` — action `blind_end` → null. Confirmed approval-gated at [blind.ts:71](../../../src/daemon/api/routes/blind.ts).

**Explicitly excluded from Plan 4a** (no `session_id` body parsing; daemon route unchanged; CLI command does NOT get `--session`):
- `secrets.ts` V0 endpoints: `/v1/secrets/capture` (action `"capture"`), `/v1/secrets/inject` (action `"inject"`), `/v1/secrets/compare` (action `"compare"`). The CLI commands `secret-shuttle internal capture / inject / compare` are V0 / deprecated; they remain functionally unchanged in Plan 4a. (Their actions also aren't in `SessionAction`, so even if we wired them as pass-through they would only ever fall back. Not worth the touch surface.)
- `browser.ts` — does not currently call `requireApproval`. No change.

**The surface rule:** Plan 4a wires session-id body pass-through on **every approval-gated daemon route that isn't a V0 deprecation candidate** (9 routes). The CLI commands that target those 9 routes (also 9, listed in Task J2) gain `--session`. V0 internal commands (`internal compare`, `internal capture`, `internal inject`) do NOT get `--session`; their daemon endpoints stay unchanged. This keeps the rule "every modern approval-gated command supports sessions; V0 commands don't".

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

- [ ] **Step 1-4: One commit per session-capable route.** Each of the four session-capable routes (`templates.ts`, `secrets.ts` generate endpoint, `inject-submit.ts`, `reveal-capture.ts`) gets its own commit. Each commit:
  - Adds `session_id` body param.
  - Passes through to `requireApproval` with `sessionStore: services.sessionStore`.
  - Hoists `let grant: ApprovalGrant | undefined;` OUTSIDE the try block; assigns it from the `requireApproval` return value INSIDE the try; references `grant?.session_id` in BOTH the success audit AND the catch-block failure audit. This is what guarantees the failure audit carries `session_id` whenever the session was consumed but the op then threw.
  - Adds TWO tests (both required):
    (1) **Success path** — session matches; operation succeeds. Asserts:
      (a) the audit line carries `session_id`,
      (b) the audit line has `ok: true`,
      (c) `sessionStore.get(id).uses` was incremented to 1.
    (2) **Failure-AFTER-mint path** — the operation must fail at a point AFTER `requireApproval` returns (so the session is genuinely consumed). Asserts:
      (a) the audit line STILL carries `session_id`,
      (b) the audit line has `ok: false`,
      (c) `sessionStore.get(id).uses` was incremented to 1.

**CRITICAL — the failure must come AFTER `requireApproval` returns.** Most routes do work BEFORE the approval call (ref resolution, policy checks, etc.). Failures there consume nothing — they happen before mint. The R5 draft suggested `softDelete`-ing the secret to trigger `secret_not_found`, but for `templates.ts` the resolve happens at line 48, BEFORE `requireApproval` at line 106 — that's a pre-mint failure and would NOT exercise the audit contract we want. Per-route post-mint failure paths to use instead:

  - **`templates.ts`** — exploit the `resolveErr` path: register a template whose `binary` resolves to a path that doesn't exist on disk. The route captures `resolveErr` BEFORE `requireApproval` (line 80-85) but RE-THROWS it AFTER (line 116: `if (resolveErr !== null) throw resolveErr;`). Session is consumed at the requireApproval call; the throw happens after.
  - **`secrets.ts` generate endpoint** — call generate with a planned_ref that already exists in the vault and `force: false`. `services.vault.upsertSecret` throws `secret_exists` AFTER the approval call. (Verify the call order: validation + planned_ref construction happens before requireApproval; the actual upsert call is after.)
  - **`inject-submit.ts`** — mock the browser submit dispatcher to throw on the post-approval submit call. (Don't try to flip `assertSecretActionAllowed("inject_submit")` state between mint and submit — that check currently runs BEFORE `requireApproval` at [inject-submit.ts:44](../../../src/daemon/api/routes/inject-submit.ts), so it's a pre-mint failure.) The test should show the failure point is AFTER `requireApproval` returns — a mocked browser RPC rejection is the cleanest hook.
  - **`reveal-capture.ts`** — same shape as inject-submit: the actual capture step happens after `requireApproval`; mock the browser capture dispatcher to throw after the mint completes.

  When in doubt, the implementer can grep the route file for `requireApproval` and verify every operation BELOW that line is a candidate for post-mint failure; everything ABOVE happens before mint and is irrelevant to this test.

**Code pattern for the route's grant + audit handling:**

```typescript
let grant: ApprovalGrant | undefined;
let auditErrorCode: string | undefined;
try {
  // ... pre-approval work (resolve, validate, etc.) — may throw, but those
  //     throws happen BEFORE mint and so don't carry session_id.
  grant = await requireApproval({
    store: services.approvals,
    binding,
    daemonPort: daemonPortRef(),
    sessionStore: services.sessionStore,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
    ...(waitForApproval === false ? { waitMs: 0 } : {}),
  });
  // ... post-approval work — anything that throws here MUST audit with session_id.
  const result = await doTheThing();
  await writeDaemonAudit({
    action: "template_run",
    ok: true,
    ref: ...,
    ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
  });
  return result;
} catch (e) {
  auditErrorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
  await writeDaemonAudit({
    action: "template_run",
    ok: false,
    ref: ...,
    error_code: auditErrorCode,
    // CRITICAL: grant?.session_id, not grant.session_id — grant may be
    // undefined here if requireApproval itself threw (pre-mint failure).
    // The optional chain preserves the contract: session_id appears in audit
    // iff the session was actually consumed.
    ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
  });
  throw e;
}
```

Example commit message for a session-capable route:

```
feat(routes/templates): accept session_id; audit records source session on both paths

If session_id is supplied and the binding matches the session pattern,
requireApproval mints a used grant from the session and skips the per-op
approval window. The grant is hoisted outside the try block so its
session_id flows into BOTH the success audit AND the catch-block failure
audit. New post-mint failure test (exploit resolveErr by registering a
template whose binary resolves to a nonexistent path) proves the failure
audit carries session_id when the session was consumed but the op then
threw after mint.
```

- [ ] **Step 5-9: One commit per pass-through route.** Each of the five pass-through routes gets its own commit:
  5. `run-resolve.ts` (action `run` → canonicalizes to null)
  6. `inject-render.ts` (action `inject_render` → null)
  7. `secrets-delete.ts` (action `secrets_delete` → null)
  8. `secrets-rotate.ts` (action `secrets_rotate` → null)
  9. `blind.ts` (action `blind_end` → null; approval gate at [blind.ts:71](../../../src/daemon/api/routes/blind.ts))

  Each commit:
  - Adds `session_id` body param.
  - Passes through to `requireApproval` with `sessionStore: services.sessionStore`.
  - The route's `writeDaemonAudit` call STILL receives `grant.session_id` (which will be undefined on the fallback path) — preserves the single audit shape.
  - Adds ONE test that asserts:
    (a) the audit line does NOT carry `session_id` (the matcher refused → single-use was used or required), AND
    (b) `sessionStore.get(id).uses` stayed at 0.

The pass-through test typically uses `wait_for_approval: false` so it gets `approval_required` back, then checks the audit + session state.

Example commit message for a pass-through route:

```
feat(routes/secrets-delete): pass-through session_id; daemon refuses non-SessionAction

secrets-delete is NOT a SessionAction (destructive ops are always human-
gated). The route still accepts session_id in the body for CLI uniformity,
threads it to requireApproval. The matcher canonicalizes secrets_delete to
null and refuses; requireApproval falls back to the single-use flow. The
audit entry does NOT receive session_id on this path.
```

For the `blind end` commit specifically, note that the CLI surface is `secret-shuttle internal blind end --session <id>`; the daemon route is `POST /v1/blind/end` (or whatever the existing path is — verify via grep). Same pass-through semantics as the other four.

- [ ] **Step 10: After all 9 routes**, verify:

```bash
git log --oneline | head -10  # ~9 per-route commits + 1 audit-type commit
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
    .requiredOption("--actions <list>", "Comma-separated SessionActions: template-run | inject-submit | reveal-capture | secrets-set")
    .requiredOption("--ref-glob <glob>", "Literal prefix + optional trailing * (e.g. ss://stripe/prod/*). Empty string = no ref check.")
    .option("--destination-domain <domain>", "Allowed destination domain (repeatable)", collectRepeated, [])
    .option("--template-id <id>", "Restrict to specific template_id (repeatable)", collectRepeated, [])
    .option("--allowed-action <action>", "For secrets-set patterns: REQUIRED ⊇ for binding.allowed_actions. Repeatable. Valid: capture_from_page | inject_into_field | compare_fingerprint | use_as_stdin | inject_submit.", collectRepeated, [])
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

Commands (9 total) — one per modern approval-gated daemon route from Part I:
- `src/cli/commands/run.ts` (run → pass-through)
- `src/cli/commands/inject.ts` (inject_render → pass-through)
- `src/cli/commands/secrets/set.ts` (generate → secrets-set, session-capable)
- `src/cli/commands/secrets/delete.ts` (secrets_delete → pass-through)
- `src/cli/commands/secrets/rotate.ts` (secrets_rotate → pass-through)
- `src/cli/commands/template.ts` (template_run via `template run` subcommand → session-capable). NOTE: the file is `template.ts`, not `template-run.ts` (earlier draft was wrong). The `--session` flag goes on the `run` subcommand specifically.
- `src/cli/commands/inject-submit.ts` (inject_submit → session-capable)
- `src/cli/commands/reveal-capture.ts` (reveal_capture → session-capable)
- `src/cli/commands/blind.ts` — `--session` on the `end` subcommand only (blind_end → pass-through). Confirmed at [blind.ts:71](../../../src/daemon/api/routes/blind.ts).

**Explicitly NOT added** (V0 / deprecated):
- `src/cli/commands/compare.ts` (internal compare; V0)
- `src/cli/commands/capture.ts` (internal capture; V0 — replaced by `reveal-capture`)
- `src/cli/commands/inject-internal.ts` (internal inject; V0 — replaced by `inject-submit`)

These three V0 commands stay unchanged. If a user invokes them with a session, they'd hit a daemon endpoint that doesn't parse the field. That's acceptable for v0.2.0 since V0 is slated for removal anyway. Documented in the CHANGELOG known-limitations.

Add ONE structural test per command:

```typescript
test("runCommand: --session flag accepted", () => {
  const cmd = runCommand();
  assert.ok(cmd.options.map((o) => o.long).includes("--session"));
});
```

After all 9 commands, run full suite + commit each. Single trailing aggregate verify commit:

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
# Prereq: daemon running + vault unlocked + a production-classed secret seeded
# at ss://local/prod/X that allows the template's required actions.

# 1. Create a template-run session. For template-run, --template-id is REQUIRED
#    and --destination-domain is IGNORED (templates have implicit destinations
#    encoded by template_id — vercel-env-add is implicitly vercel.com).
secret-shuttle internal session create \
  --actions template-run \
  --ref-glob "ss://local/prod/*" \
  --template-id vercel-env-add \
  --ttl 300000 \
  --no-wait
# → returns { session_id, status: "pending", expires_at }
# → /ui/session?id=&token= opens in browser with session details.

# 2. Approve in the browser UI.

# 3. Verify session list shows status:granted + uses:0.
secret-shuttle internal session list

# 4. Run the template under the session — should NOT open a new approval tab.
secret-shuttle template run vercel-env-add \
  --ref ss://local/prod/X \
  --param environment=production \
  --param project_id=prj_test \
  --session <id>
# (Required params depend on the actual template's validateParams.)

# 5. Verify uses incremented to 1.
secret-shuttle internal session list

# 6. Try a NON-matching op (different template_id) under the same session →
#    pattern_no_match → falls back to single-use approval window.
secret-shuttle template run github-actions-secret --ref ss://local/prod/X --session <id> --no-wait
# → approval_required (per-op flow kicked in; uses still 1).

# 7. Try a non-matching ref under the same session → same fallback.
secret-shuttle template run vercel-env-add --ref ss://OTHER/prod/Y --session <id> --no-wait

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
- **Pre-approved sessions.** `POST /v1/approvals/session` mints a session pattern that the human approves once via a real HTML page at `/ui/session?id=&token=`. Subsequent operations carrying `session_id` (CLI: `--session <id>`) that match the pattern skip the per-op approval window. Mismatches fall back to the single-use flow transparently. Each minted grant is a discrete one-shot binding under the hood; the audit log shows N distinct operations with `session_id` set, not "1 session". CLI: `secret-shuttle internal session create | list | revoke`. Spec §5.7.
- **SessionAction is scoped to four actions in v0.2.0:** `template-run`, `inject-submit`, `reveal-capture`, `secrets-set`. Destructive actions (`secrets-delete`, `secrets-rotate`) and deferred actions (`run`, `inject_render`) all canonicalize to null and refuse outright; their CLI flags pass through for surface uniformity but the daemon falls back to single-use approval.
- **Action-specific matchers** that read the field where the binding actually stores its ref:
  - `template-run` → `binding.ref` + `template_ids` (binding.destination_domain is null on templates; template_id is the security boundary)
  - `inject-submit` → `binding.ref` + `destination_domain`
  - `reveal-capture` → `binding.planned_ref` (NOT binding.ref — that's null for reveal-capture) + `destination_domain`
  - `secrets-set` → `binding.planned_ref` + `binding.allowed_domains` ⊆ `pattern.destination_domains` (subset; agent can't widen) + `binding.allowed_actions` ⊆ `pattern.allowed_actions` (pattern's `allowed_actions` is REQUIRED non-empty for secrets-set; entries validated against `ALL_SECRET_ACTIONS`).
- **Pattern validation** rejects empty `destination_domains` for inject-submit / reveal-capture / secrets-set, empty `template_ids` for template-run, AND empty `allowed_actions` for secrets-set — the dangerous "match anything" shapes are all refused at create time. `allowed_actions` entries are validated against the canonical `SecretAction` enum.
- **UI security headers.** Token-bearing UI responses (HTML at `/ui/session?id=&token=` and JSON at `/ui/sessions/:id`, `/ui/sessions/:id/approve|deny`) set the full hardening set: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. The HTML response additionally sets a real `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'` HTTP header (not just a `<meta>` tag — browsers ignore meta CSP for `frame-ancestors`). Nonce-based CSP that drops `'unsafe-inline'` is a Plan 4b enhancement.
- **TTL anchored at approval, not creation.** `expires_at` starts at `created_at + 2min` (pending window for the human to click). On approve, `expires_at` resets to `now + pattern.ttl_ms`. So a human who takes 90 seconds to read the pattern still gets the full requested session window.
- **Granted sessions expire.** `SessionStore.get()` and `.list()` both flip pending AND granted states to `expired` past `expires_at`. Without this, an approved session would live until revoke or process restart.
- **Destructive actions cannot be put in a session.** `secrets-delete` and `secrets-rotate` are NOT `SessionAction` values; passing them in a session pattern throws `bad_request`. Their CLI commands accept `--session <id>` for surface uniformity, but the daemon rejects with `session_pattern_no_match` and falls back to a fresh per-op approval.
- **Session UI HTTP routes.** New `GET /ui/sessions/:id?token=<ui_token>` and `POST /ui/sessions/:id/approve|deny?token=<ui_token>` mirror the per-URL-token approval-UI pattern. Tests approve via these HTTP routes — never by mutating the store directly.

### Security
- The matcher for `secrets-set` checks `binding.allowed_domains ⊆ pattern.destination_domains` (subset, not equality). An agent can't widen the domain set the human approved.
- The matcher for `secrets-set` similarly checks `binding.allowed_actions ⊆ pattern.allowed_actions`. `pattern.allowed_actions` is REQUIRED non-empty for any pattern listing `secrets-set` (entries validated against `ALL_SECRET_ACTIONS`). The matcher also refuses if `binding.allowed_actions` is undefined — defense in depth: a binding without an explicit action scope is not session-approvable.
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
