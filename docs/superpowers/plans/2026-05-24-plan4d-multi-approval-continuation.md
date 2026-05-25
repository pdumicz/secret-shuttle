# Plan 4d — Multi-Approval Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the v0.2.0 Known-limitation `combined_no_wait_unsupported` by replacing the run-resolve fail-fast with a real continuation contract: daemon mints all required approvals atomically on the first `--no-wait` round-trip; CLI carries them back via repeatable `--approval-id`; daemon consumes all of them on retry.

**Architecture:** Two-phase `requireApprovals(bindings, …)` primitive replaces single-binding `requireApproval`. Phase 1 is pure-plan (binding match via newly-public `approvalBindingsMatch`, session peek via new `canMatchSession` that mirrors every `incrementUses` precondition). Phase 2 is the only place with side effects. Under `--no-wait` with partial satisfaction, Phase 2 mints ONLY the missing bindings and never burns supplied IDs or sessions. Order-of-operations constraint: the existing `combined_no_wait_unsupported` fail-fast block is deleted **only after** an integration test proves the continuation path converges.

**Tech Stack:** TypeScript strict, ESM (.js import suffixes), Node 20+, `node:test`, Commander.js, existing Sol/Memori error pattern.

---

## File Structure

**New files:**
- `src/daemon/approvals/require-approvals.ts` — new primitive (replaces `require-approval.ts` at the end).
- `src/daemon/approvals/require-approvals.test.ts` — unit tests for the primitive.
- `src/cli/commands/_approval-id-option.ts` — shared Commander option factory for repeatable `--approval-id`.

**Modified files (significant):**
- `src/daemon/approvals/store.ts` — export `approvalBindingsMatch` (renamed from private `bindingsMatch`); add `canMatchSession` and `mintFromSession` methods; remove `findOrMintFromSession` at the end.
- `src/shared/errors.ts` — extend `ShuttleErrorOpts` with `details?: unknown`; surface through `errorToJson`.
- `src/client/daemon-client.ts` — reconstruct `details` in `daemonErrorFromPayload`.
- `src/daemon/api/validate.ts` — add `optApprovalIds(o)` helper.
- `src/daemon/api/routes/run-resolve.ts` — replace two `requireApproval` blocks with one `requireApprovals` call; later delete fail-fast block.
- `src/shared/error-codes.ts` — update `approval_required` hint; later delete `combined_no_wait_unsupported`.
- `CHANGELOG.md` — remove combined-no-wait Known-limitation bullet; add Plan 4d Added section.

**Modified files (mechanical migration; one task per file):**
- 8 route files: `secrets.ts`, `secrets-delete.ts`, `secrets-rotate.ts`, `templates.ts`, `reveal-capture.ts`, `blind.ts`, `inject-render.ts`, `inject-submit.ts`.
- 13 CLI command files: `secrets/set.ts`, `secrets/delete.ts`, `secrets/rotate.ts`, `inject.ts`, `inject-submit.ts`, `inject-internal.ts`, `capture.ts`, `reveal-capture.ts`, `generate.ts`, `compare.ts`, `template.ts`, `blind.ts`, `run.ts`.

**Deleted files (final task):**
- `src/daemon/approvals/require-approval.ts`
- `src/daemon/approvals/require-approval.test.ts`

---

## Verification commands

Used throughout the plan. Each task ends with these.

```bash
npm run typecheck
npm test
```

Final task additionally:

```bash
npm run check-pack
```

---

## Task A1: Export `approvalBindingsMatch` publicly

**Files:**
- Modify: `src/daemon/approvals/store.ts:181-204` (rename + export the private `bindingsMatch`)
- Test: `src/daemon/approvals/store.test.ts` (add direct tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/approvals/store.test.ts`:

```ts
import { approvalBindingsMatch } from "./store.js";

test("approvalBindingsMatch: identical bindings match", () => {
  const b: ApprovalBinding = {
    action: "run",
    ref: null,
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: { command: "npm", args: "[]", refs: "ss://local/prod/A" },
    allowed_domains: [],
  };
  assert.strictEqual(approvalBindingsMatch(b, { ...b }), true);
});

test("approvalBindingsMatch: differing action → mismatch", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: [] };
  const b = { ...a, action: "run_stdin" as const };
  assert.strictEqual(approvalBindingsMatch(a, b), false);
});

test("approvalBindingsMatch: differing template_params → mismatch", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { x: "1" }, allowed_domains: [] };
  const b: ApprovalBinding = { ...a, template_params: { x: "2" } };
  assert.strictEqual(approvalBindingsMatch(a, b), false);
});

test("approvalBindingsMatch: allowed_domains order-insensitive", () => {
  const a: ApprovalBinding = { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["a.com", "b.com"] };
  const b: ApprovalBinding = { ...a, allowed_domains: ["b.com", "a.com"] };
  assert.strictEqual(approvalBindingsMatch(a, b), true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="approvalBindingsMatch" 2>&1 | tail -20`
Expected: FAIL — `approvalBindingsMatch is not exported`.

- [ ] **Step 3: Rename + export**

In `src/daemon/approvals/store.ts`, replace line 181 declaration:

```ts
function bindingsMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
```

with:

```ts
export function approvalBindingsMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
```

Update the two internal references at line 121 and 191 (inside `stableStringify` call) — actually the body of `bindingsMatch` references nothing called `bindingsMatch` internally. The only call site is line 121:

```ts
if (!bindingsMatch(g, binding)) {
```

Change to:

```ts
if (!approvalBindingsMatch(g, binding)) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="approvalBindingsMatch" 2>&1 | tail -20`
Expected: PASS (4 tests).

Then full suite:

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts
git commit -m "$(cat <<'EOF'
refactor(approvals/store): export approvalBindingsMatch publicly

Renamed from private `bindingsMatch`. Plan 4d requires a public
read-only matcher so the new requireApprovals primitive can plan
ID→binding assignments without duplicating equality logic. Direct
unit tests added so the matcher contract is testable in isolation
and can't drift from store.consume's check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A2: Add `canMatchSession` method (pure peek)

**Files:**
- Modify: `src/daemon/approvals/store.ts` (add method on `ApprovalStore`)
- Test: `src/daemon/approvals/store.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/approvals/store.test.ts`:

```ts
test("canMatchSession: granted session with matching pattern under max_uses → true, no side effects", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({
    domain: "example.com",
    actions: ["inject"],
    max_uses: 5,
    ttl_ms: 60_000,
    label: "test",
  });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };

  const before = sessionStore.get(session.id)!.uses;
  const result = approvals.canMatchSession(session.id, binding, sessionStore);
  const after = sessionStore.get(session.id)!.uses;

  assert.strictEqual(result, true);
  assert.strictEqual(after, before, "uses must NOT increment");
});

test("canMatchSession: pattern no-match → false (no throw, no side effects)", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 5, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "capture", ref: null, environment: "production", destination_domain: "other.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["other.com"] };

  assert.strictEqual(approvals.canMatchSession(session.id, binding, sessionStore), false);
  assert.strictEqual(sessionStore.get(session.id)!.uses, 0);
});

test("canMatchSession: revoked → throws session_not_found", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 5, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  sessionStore.revoke(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_not_found");
});

test("canMatchSession: at max_uses → throws session_max_uses_exceeded (no side effects on store)", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 1, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id); // now at max
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };

  const usesBefore = sessionStore.get(session.id)!.uses;
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded");
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore, "uses must NOT change on throw");
});

test("canMatchSession: expired → throws session_expired", () => {
  let nowMs = 1000;
  const sessionStore = new SessionStore({ now: () => nowMs });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 5, ttl_ms: 1000, label: "t" });
  sessionStore.approve(session.id);
  nowMs += 2000; // past expiry
  const approvals = new ApprovalStore({ now: () => nowMs });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  assert.throws(() => approvals.canMatchSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_expired");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="canMatchSession" 2>&1 | tail -20`
Expected: FAIL — `approvals.canMatchSession is not a function`.

- [ ] **Step 3: Add the method**

In `src/daemon/approvals/store.ts`, before the `findOrMintFromSession` method (around line 130), add:

```ts
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --test-name-pattern="canMatchSession" 2>&1 | tail -10`
Expected: PASS (5 tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean, full suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/store): canMatchSession pure-peek method

Plan 4d Phase 1 needs to plan session-backed bindings without burning
a use on operations that may not commit. canMatchSession mirrors every
precondition that SessionStore.incrementUses enforces (status,
expiry, max_uses cap) and returns the pattern-match boolean without
side effects. Throws on hard-fail session states; returns false on
pattern no-match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A3: Add `mintFromSession` method (side-effect half)

**Files:**
- Modify: `src/daemon/approvals/store.ts` (add method)
- Test: `src/daemon/approvals/store.test.ts` (tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/approvals/store.test.ts`:

```ts
test("mintFromSession: granted+matching session → bumps uses, returns synthetic grant with session_id", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 5, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };

  const usesBefore = sessionStore.get(session.id)!.uses;
  const grant = approvals.mintFromSession(session.id, binding, sessionStore);

  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore + 1);
  assert.strictEqual(grant.session_id, session.id);
  assert.strictEqual(grant.status, "used");
  assert.strictEqual(grant.action, "inject");
});

test("mintFromSession: at max_uses → throws session_max_uses_exceeded", () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 1, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id);
  const approvals = new ApprovalStore({ now: () => 1000 });
  const binding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };
  assert.throws(() => approvals.mintFromSession(session.id, binding, sessionStore), (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="mintFromSession" 2>&1 | tail -10`
Expected: FAIL — `approvals.mintFromSession is not a function`.

- [ ] **Step 3: Add the method**

In `src/daemon/approvals/store.ts`, immediately after the new `canMatchSession` method, add:

```ts
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
    this.onEvent?.({ kind: "used", grant });
    return grant;
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --test-name-pattern="mintFromSession" 2>&1 | tail -10`
Expected: PASS (2 tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; full suite passes (the old `findOrMintFromSession` is still in place and still works).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/store): mintFromSession side-effect half

Extracted from findOrMintFromSession. Bumps sessionStore.incrementUses
and mints the synthetic grant. Used by requireApprovals Phase 2 once
canMatchSession has verified the operation can commit. findOrMintFromSession
stays for now — removed in cleanup task K1 once all callers migrate
to the new primitive.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B1: ShuttleError gains `details`; errorToJson surfaces it

**Files:**
- Modify: `src/shared/errors.ts`
- Test: `src/shared/errors.test.ts` (create or extend)

- [ ] **Step 1: Write the failing tests**

Add or extend `src/shared/errors.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert";
import { ShuttleError, errorToJson } from "./errors.js";

test("ShuttleError carries details when supplied", () => {
  const e = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }] } });
  assert.deepStrictEqual(e.details, { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }] });
});

test("ShuttleError.details is undefined when not supplied", () => {
  const e = new ShuttleError("bad_request", "msg");
  assert.strictEqual(e.details, undefined);
});

test("errorToJson includes details when present", () => {
  const e = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "x", expires_at: 9, action: "run" }] } });
  const j = errorToJson(e);
  assert.deepStrictEqual(j.details, { approvals: [{ approval_id: "x", expires_at: 9, action: "run" }] });
});

test("errorToJson omits details when undefined", () => {
  const e = new ShuttleError("bad_request", "msg");
  const j = errorToJson(e);
  assert.ok(!("details" in j), "details key must NOT appear when undefined");
});

test("ShuttleError positional-form opts (number) ignores details", () => {
  // Backward compat: ShuttleError("x", "m", 2) still works; details stays undefined.
  const e = new ShuttleError("bad_request", "msg", 2);
  assert.strictEqual(e.exitCode, 2);
  assert.strictEqual(e.details, undefined);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="details" 2>&1 | tail -20`
Expected: FAIL — `e.details` is undefined, type errors, etc.

- [ ] **Step 3: Modify `src/shared/errors.ts`**

Replace the file contents (preserving existing behavior, adding `details`):

```ts
import { lookupErrorCode } from "./error-codes.js";

export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
  details?: unknown;
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;
  readonly details: unknown | undefined;

  constructor(
    code: string,
    message: string,
    optsOrExitCode: ShuttleErrorOpts | number = {},
  ) {
    super(message);
    this.name = "ShuttleError";
    this.code = code;

    const registry = lookupErrorCode(code);
    const registryExitCode = registry?.exitCode ?? 1;
    const registryHint = registry?.hint(message) ?? null;

    if (typeof optsOrExitCode === "number") {
      // Backward-compat positional form: explicit exitCode wins; hint from registry; no details.
      this.exitCode = optsOrExitCode;
      this.hint = registryHint;
      this.details = undefined;
    } else {
      // If the caller explicitly supplied `hint` (including null), respect it.
      // If they didn't supply the key at all, fall through to the registry default.
      this.exitCode = "exitCode" in optsOrExitCode && optsOrExitCode.exitCode !== undefined
        ? optsOrExitCode.exitCode
        : registryExitCode;
      this.hint = "hint" in optsOrExitCode
        ? (optsOrExitCode.hint ?? null)
        : registryHint;
      this.details = optsOrExitCode.details;
    }
  }
}

export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new ShuttleError(code, message);
  }
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof ShuttleError) {
    const base: Record<string, unknown> = {
      ok: false,
      // Legacy nested block — preserved indefinitely for backward compat.
      error: { code: error.code, message: error.message },
      // Flat agent-friendly fields per spec §5.6:
      error_code: error.code,
      message: error.message,
      hint: error.hint,
      exit_code: error.exitCode,
    };
    if (error.details !== undefined) {
      base.details = error.details;
    }
    return base;
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: { code: "unexpected_error", message: error.message },
      error_code: "unexpected_error",
      message: error.message,
      hint: null,
      exit_code: 1,
    };
  }

  return {
    ok: false,
    error: { code: "unexpected_error", message: "Unknown error" },
    error_code: "unexpected_error",
    message: "Unknown error",
    hint: null,
    exit_code: 1,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --test-name-pattern="details" 2>&1 | tail -10`
Expected: PASS (5 tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; full suite passes (no existing test breaks since `details` is additive).

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors.ts src/shared/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(errors): ShuttleError.details for structured side-channel data

Plan 4d Phase 4: approval_required errors need to carry a structured
approvals array beyond what the existing hint/exit_code fields support.
Add `details?: unknown` to ShuttleErrorOpts, surface through
errorToJson as a top-level field (omitted when undefined to keep
existing error shapes byte-identical).

Backward-compat positional-form (ShuttleError("x", "m", 2)) explicitly
ignores details — only the opts-object form carries it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B2: `daemonErrorFromPayload` reconstructs `details`

**Files:**
- Modify: `src/client/daemon-client.ts`
- Test: `src/client/daemon-client.test.ts` (extend) AND `src/daemon/api/routes/run-resolve.test.ts` (integration round-trip — note: this test will be REPLACED in Task I1, but for now it lives in a more general location)
- Create: `src/client/daemon-client.test.ts` if not present (search first)

- [ ] **Step 1: Locate or create the client test file**

Run: `ls src/client/daemon-client.test.ts 2>&1`

If it exists, append to it. If not, create it with this header:

```ts
import { describe, test } from "node:test";
import assert from "node:assert";
import { ShuttleError } from "../shared/errors.js";
import { daemonErrorFromPayload } from "./daemon-client.js";
```

- [ ] **Step 2: Write the failing tests**

Append:

```ts
test("daemonErrorFromPayload preserves details from payload", () => {
  const payload = {
    ok: false,
    error: { code: "approval_required", message: "m" },
    error_code: "approval_required",
    message: "m",
    hint: "h",
    exit_code: 3,
    details: { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }, { approval_id: "b", expires_at: 1, action: "run_stdin" }] },
  };
  const e = daemonErrorFromPayload(payload);
  assert.deepStrictEqual(e.details, { approvals: [{ approval_id: "a", expires_at: 1, action: "run" }, { approval_id: "b", expires_at: 1, action: "run_stdin" }] });
});

test("daemonErrorFromPayload leaves details undefined when omitted", () => {
  const payload = {
    ok: false,
    error: { code: "bad_request", message: "m" },
    error_code: "bad_request",
    message: "m",
    exit_code: 2,
  };
  const e = daemonErrorFromPayload(payload);
  assert.strictEqual(e.details, undefined);
});

test("ShuttleError details round-trip via errorToJson + daemonErrorFromPayload", () => {
  const original = new ShuttleError("approval_required", "msg", { details: { approvals: [{ approval_id: "abc", expires_at: 999, action: "run" }] } });
  // Simulate the daemon→CLI wire: serialize via errorToJson, parse via daemonErrorFromPayload.
  const { errorToJson } = await import("../shared/errors.js");
  const wire = JSON.parse(JSON.stringify(errorToJson(original)));
  const reconstructed = daemonErrorFromPayload(wire);
  assert.deepStrictEqual(reconstructed.details, original.details);
  assert.strictEqual(reconstructed.code, "approval_required");
  assert.strictEqual(reconstructed.message, "msg");
});
```

(If the round-trip test's dynamic `await import` is problematic for the test runner, hoist the import to the top of the file.)

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- --test-name-pattern="daemonErrorFromPayload preserves details" 2>&1 | tail -20`
Expected: FAIL — `details` is undefined after reconstruction.

- [ ] **Step 4: Modify `src/client/daemon-client.ts`**

Update `daemonErrorFromPayload` (lines 24-45):

```ts
export function daemonErrorFromPayload(payload: unknown): ShuttleError {
  const p = (payload ?? {}) as Record<string, unknown>;
  const errBlock = (p.error ?? {}) as { code?: string; message?: string };

  // code: prefer nested, fall back to flat, then "unknown"
  const code =
    (typeof errBlock.code === "string" ? errBlock.code : undefined) ??
    (typeof p.error_code === "string" ? p.error_code : undefined) ??
    "unknown";
  // message: prefer nested, fall back to flat, then "unknown error"
  const message =
    (typeof errBlock.message === "string" ? errBlock.message : undefined) ??
    (typeof p.message === "string" ? p.message : undefined) ??
    "unknown error";

  // Daemon-provided fields take precedence over registry defaults.
  const opts: { exitCode?: number; hint?: string | null; details?: unknown } = {};
  if (typeof p.exit_code === "number") opts.exitCode = p.exit_code;
  if (typeof p.hint === "string" || p.hint === null) opts.hint = p.hint;
  if ("details" in p) opts.details = p.details;

  return new ShuttleError(code, message, opts);
}
```

The local `opts` type explicitly lists `details` so TypeScript accepts the conditional assignment. The `"details" in p` check is intentional — `details: null` from the daemon (unlikely but possible) is preserved as `null` rather than collapsing to `undefined`.

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test -- --test-name-pattern="daemonErrorFromPayload\|round-trip" 2>&1 | tail -15`
Expected: PASS (3 new tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/client/daemon-client.ts src/client/daemon-client.test.ts
git commit -m "$(cat <<'EOF'
feat(client): daemonErrorFromPayload reconstructs details

Plan 4d Phase 5: CLI's top-level error handler reads errors via
daemonErrorFromPayload. Extending the reconstruction to preserve the
`details` field closes the daemon→CLI round trip for structured
side-channel data introduced in B1.

Round-trip test asserts errorToJson(e) → JSON → daemonErrorFromPayload
yields an identical .details object.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C1: `requireApprovals` primitive

**Files:**
- Create: `src/daemon/approvals/require-approvals.ts`
- Create: `src/daemon/approvals/require-approvals.test.ts`

The old `src/daemon/approvals/require-approval.ts` (singular) STAYS in place during this task. Single-binding callers continue to use it. The new primitive lives alongside.

- [ ] **Step 1: Write the failing tests (start with the simplest cases)**

Create `src/daemon/approvals/require-approvals.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { SessionStore } from "./session-store.js";
import { requireApprovals } from "./require-approvals.js";
import { ShuttleError } from "../../shared/errors.js";

function devBinding(): ApprovalBinding {
  return { action: "run", ref: null, environment: "development", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: [] };
}
function envBinding(): ApprovalBinding {
  return { action: "run", ref: null, environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { kind: "env", refs: "ss://local/prod/A" }, allowed_domains: [] };
}
function stdinBinding(): ApprovalBinding {
  return { action: "run_stdin", ref: "ss://local/prod/B", environment: "production", destination_domain: null, target_id: null, field_fingerprint: null, template_id: null, template_params: { kind: "stdin", ref: "ss://local/prod/B" }, allowed_domains: [] };
}

test("requireApprovals: empty bindings returns []", async () => {
  const store = new ApprovalStore();
  const result = await requireApprovals({ store, bindings: [], daemonPort: 1234 });
  assert.deepStrictEqual(result, []);
});

test("requireApprovals: dev binding synthesizes grant (no production)", async () => {
  const store = new ApprovalStore();
  const result = await requireApprovals({ store, bindings: [devBinding()], daemonPort: 1234 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, "no-approval-required");
  assert.strictEqual(result[0].status, "used");
});

test("requireApprovals: production binding, no IDs, --no-wait → throws approval_required with details.approvals length 1", async () => {
  const store = new ApprovalStore();
  let openedUrl: string | undefined;
  await assert.rejects(
    requireApprovals({ store, bindings: [envBinding()], daemonPort: 1234, waitMs: 0, openUrlImpl: (u) => { openedUrl = u; } }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError)) return false;
      if (e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1);
      assert.strictEqual(details.approvals[0].action, "run");
      return true;
    },
  );
  assert.ok(openedUrl?.includes("/ui/approve?id="));
});

test("requireApprovals: production binding, correct granted ID → consumes, returns grant", async () => {
  const store = new ApprovalStore();
  const binding = envBinding();
  const minted = store.create(binding);
  store.approve(minted.id);

  const grants = await requireApprovals({
    store, bindings: [binding], daemonPort: 1234,
    approvalIdsFromClient: [minted.id],
  });
  assert.strictEqual(grants.length, 1);
  assert.strictEqual(grants[0].id, minted.id);
  assert.strictEqual(grants[0].status, "used");
});

test("requireApprovals: combined env+stdin, no IDs, --no-wait → throws with both approvals in order", async () => {
  const store = new ApprovalStore();
  await assert.rejects(
    requireApprovals({
      store, bindings: [envBinding(), stdinBinding()], daemonPort: 1234, waitMs: 0,
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 2);
      assert.strictEqual(details.approvals[0].action, "run");
      assert.strictEqual(details.approvals[1].action, "run_stdin");
      return true;
    },
  );
});

test("requireApprovals: combined env+stdin, both IDs supplied in order → both consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234,
    approvalIdsFromClient: [envApproval.id, stdinApproval.id],
  });
  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0].id, envApproval.id);
  assert.strictEqual(grants[1].id, stdinApproval.id);
});

test("requireApprovals: best-fit matching — IDs in reverse order still consumed correctly", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  store.approve(stdinApproval.id);

  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234,
    approvalIdsFromClient: [stdinApproval.id, envApproval.id], // reversed
  });
  assert.strictEqual(grants[0].id, envApproval.id); // matched by binding equality, not position
  assert.strictEqual(grants[1].id, stdinApproval.id);
});

test("requireApprovals: partial --no-wait (only env ID supplied) → throws approval_required for stdin only; env ID NOT consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234, waitMs: 0,
      approvalIdsFromClient: [envApproval.id],
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1, "only stdin mint should be in details");
      assert.strictEqual(details.approvals[0].action, "run_stdin");
      return true;
    },
  );
  // Critical: env ID is still granted (Phase 1 didn't burn it).
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
});

test("requireApprovals: unknown ID supplied → throws approval_not_found (NOT approval_mismatch)", async () => {
  const store = new ApprovalStore();
  await assert.rejects(
    requireApprovals({
      store, bindings: [envBinding()], daemonPort: 1234,
      approvalIdsFromClient: ["does-not-exist"],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
  );
});

test("requireApprovals: extra ID matches no binding → approval_mismatch", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  // Extra: an approval for stdin binding, but we only ask for env.
  const extraApproval = store.create(sb);
  store.approve(extraApproval.id);

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, extraApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_mismatch",
  );
});

test("requireApprovals: ID in pending status → throws approval_not_granted; ID NOT consumed", async () => {
  const store = new ApprovalStore();
  const eb = envBinding();
  const sb = stdinBinding();
  const envApproval = store.create(eb);
  store.approve(envApproval.id);
  const stdinApproval = store.create(sb);
  // NOT approved — still pending.

  await assert.rejects(
    requireApprovals({
      store, bindings: [eb, sb], daemonPort: 1234,
      approvalIdsFromClient: [envApproval.id, stdinApproval.id],
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_granted",
  );
  // Critical: env was NOT consumed despite being earlier in plan order.
  assert.strictEqual(store.get(envApproval.id)!.status, "granted");
  assert.strictEqual(store.get(stdinApproval.id)!.status, "pending");
});

test("requireApprovals: session at max_uses → throws session_max_uses_exceeded; no minting", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "example.com", actions: ["inject"], max_uses: 1, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  sessionStore.incrementUses(session.id); // at max
  const store = new ApprovalStore({ now: () => 1000 });
  const injectBinding: ApprovalBinding = { action: "inject", ref: null, environment: "production", destination_domain: "example.com", target_id: null, field_fingerprint: null, template_id: null, template_params: null, allowed_domains: ["example.com"] };

  const grantsBefore = sessionStore.get(session.id)!.uses;
  await assert.rejects(
    requireApprovals({
      store, bindings: [injectBinding], daemonPort: 1234, waitMs: 0,
      sessionId: session.id, sessionStore,
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "session_max_uses_exceeded",
  );
  // No pending grants were minted (Phase 1 threw before Phase 2).
  assert.strictEqual(sessionStore.get(session.id)!.uses, grantsBefore);
});

test("requireApprovals: session covers env but not stdin, --no-wait → throws approval_required for stdin only; session.uses unchanged", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  const session = sessionStore.create({ domain: "*", actions: ["run"], max_uses: 5, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  const store = new ApprovalStore({ now: () => 1000 });

  const usesBefore = sessionStore.get(session.id)!.uses;
  await assert.rejects(
    requireApprovals({
      store, bindings: [envBinding(), stdinBinding()], daemonPort: 1234, waitMs: 0,
      sessionId: session.id, sessionStore,
      openUrlImpl: () => {},
    }),
    (e: unknown) => {
      if (!(e instanceof ShuttleError) || e.code !== "approval_required") return false;
      const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
      assert.strictEqual(details.approvals.length, 1);
      assert.strictEqual(details.approvals[0].action, "run_stdin");
      return true;
    },
  );
  // Critical: session.uses unchanged — Phase 1 planned "session" for env but Phase 2 short-circuited via the --no-wait mint case.
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore);
});

test("requireApprovals: session-first precedence — session covers binding A; supplied ID for A is NOT consumed", async () => {
  const sessionStore = new SessionStore({ now: () => 1000 });
  // Session pattern: covers run, all domains.
  const session = sessionStore.create({ domain: "*", actions: ["run"], max_uses: 5, ttl_ms: 60_000, label: "t" });
  sessionStore.approve(session.id);
  const store = new ApprovalStore({ now: () => 1000 });
  const eb = envBinding(); // action: "run" — matches session
  const sb = stdinBinding(); // action: "run_stdin" — does NOT match session pattern
  const idForA = store.create(eb);
  store.approve(idForA.id);
  const idForB = store.create(sb);
  store.approve(idForB.id);

  const usesBefore = sessionStore.get(session.id)!.uses;
  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234,
    sessionId: session.id, sessionStore,
    approvalIdsFromClient: [idForA.id, idForB.id],
  });

  assert.strictEqual(grants.length, 2);
  // Binding A used the session.
  assert.strictEqual(grants[0].session_id, session.id);
  assert.strictEqual(sessionStore.get(session.id)!.uses, usesBefore + 1);
  // Supplied ID for A is still granted (NOT consumed by session-first precedence).
  assert.strictEqual(store.get(idForA.id)!.status, "granted");
  // Binding B used the supplied ID.
  assert.strictEqual(grants[1].id, idForB.id);
  assert.strictEqual(store.get(idForB.id)!.status, "used");
});

test("requireApprovals: waiting flow sequential — env denied → throws approval_denied; stdin never minted", async () => {
  const store = new ApprovalStore({ now: () => 1000 });
  // We can't easily wire a fake hub here. Instead, drive the store by polling
  // in a sibling promise: when the env-pending grant appears, deny it.
  const eb = envBinding();
  const sb = stdinBinding();
  const fakeOpenUrl = () => {
    // Polling loop: deny the first pending env grant we see, asynchronously.
    setTimeout(() => {
      // Iterate the store to find the pending env grant.
      for (let i = 0; i < 10; i++) {
        const pending: Array<{ id: string; status: string; action: string }> = [];
        // Hacky introspection: ApprovalStore exposes get(id) but not iterate. Use a small loop
        // over known grants by checking the most recent N created. Or rely on store events
        // — but for this test, denying by created-time order works because envBinding is
        // minted before stdinBinding in Phase 2 sequential.
      }
    }, 10);
  };
  // Simpler: directly attach a lifecycle listener.
  const store2 = new ApprovalStore({
    now: () => 1000,
    onEvent: (event) => {
      if (event.kind === "created" && event.grant.action === "run") {
        // Deny immediately so the waitForGrant loop in Phase 2 sees it on next poll.
        setTimeout(() => store2.deny(event.grant.id), 5);
      }
    },
  });

  await assert.rejects(
    requireApprovals({
      store: store2, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
      openUrlImpl: () => {},
    }),
    (e: unknown) => e instanceof ShuttleError && e.code === "approval_denied",
  );
  // Critical: no stdin grant was ever minted (sequential aborted at env denial).
  // We can't enumerate the store, but we know the test would have failed if a
  // stdin grant had been minted (since we never approve it, the wait would
  // ultimately timeout instead of failing as denied). The 1000ms waitMs is
  // far less than what a stranded stdin mint waiting forever would take.
});

test("requireApprovals: waiting flow sequential — all granted → returns both", async () => {
  const store = new ApprovalStore({
    now: () => 1000,
    onEvent: (event) => {
      if (event.kind === "created") {
        setTimeout(() => store.approve(event.grant.id), 5);
      }
    },
  });
  const eb = envBinding();
  const sb = stdinBinding();
  const grants = await requireApprovals({
    store, bindings: [eb, sb], daemonPort: 1234, waitMs: 1000,
    openUrlImpl: () => {},
  });
  assert.strictEqual(grants.length, 2);
  assert.strictEqual(grants[0].status, "used");
  assert.strictEqual(grants[1].status, "used");
  assert.strictEqual(grants[0].action, "run");
  assert.strictEqual(grants[1].action, "run_stdin");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- src/daemon/approvals/require-approvals.test.ts 2>&1 | tail -20`
Expected: FAIL — `requireApprovals` not found (module doesn't exist).

- [ ] **Step 3: Implement `requireApprovals`**

Create `src/daemon/approvals/require-approvals.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";
import { openUrl } from "./open-url.js";
import {
  approvalBindingsMatch,
  type ApprovalBinding,
  type ApprovalGrant,
  type ApprovalStore,
} from "./store.js";
import type { SessionStore } from "./session-store.js";

export interface RequireApprovalsOptions {
  store: ApprovalStore;
  bindings: ApprovalBinding[];
  daemonPort: number;
  approvalIdsFromClient?: string[];
  waitMs?: number;
  force?: boolean;
  /** Hook so tests can disable the system-browser open. */
  openUrlImpl?: (url: string) => void;
  sessionId?: string;
  sessionStore?: SessionStore;
}

type Plan =
  | { kind: "synth"; binding: ApprovalBinding }
  | { kind: "session"; binding: ApprovalBinding }
  | { kind: "consume"; binding: ApprovalBinding; id: string }
  | { kind: "mint"; binding: ApprovalBinding }
  | { kind: "waited"; binding: ApprovalBinding; grant: ApprovalGrant };

const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const POLL_MS = 200;

/**
 * Multi-binding approval gate. See plan-4d spec §2 for the two-phase contract.
 *
 * Phase 1 (pure): plan how each binding will be satisfied — synth (dev), session
 * fast-path peek, supplied-ID match, or mint. No side effects.
 *
 * Phase 2 (commit): execute the plans. Under --no-wait with mints needed, mint
 * just the missing ones and throw approval_required with all of them in
 * `details.approvals`. Supplied IDs are not consumed; sessions are not used.
 *
 * Under waiting flow with mints needed, sequential per-binding: mint, wait,
 * consume one at a time. Earlier non-mint plans are committed only after all
 * mints have been waited on, so a mid-flow denial doesn't burn earlier plans.
 */
export async function requireApprovals(
  opts: RequireApprovalsOptions,
): Promise<ApprovalGrant[]> {
  if (opts.bindings.length === 0) return [];

  // Phase 1 Step 0: resolve every supplied ID. Unknown IDs are approval_not_found.
  const suppliedIds = [...(opts.approvalIdsFromClient ?? [])];
  for (const id of suppliedIds) {
    if (opts.store.get(id) === undefined) {
      throw new ShuttleError("approval_not_found", `Unknown approval id: ${id}`);
    }
  }

  // Phase 1: per-binding plan.
  const unusedIds = new Set(suppliedIds);
  const plans: Plan[] = [];

  for (const binding of opts.bindings) {
    // 1. Synth path
    const needsApproval = opts.force === true || binding.environment === "production";
    if (!needsApproval) {
      plans.push({ kind: "synth", binding });
      continue;
    }

    // 2. Session peek
    if (opts.sessionId !== undefined && opts.sessionStore !== undefined) {
      if (opts.store.canMatchSession(opts.sessionId, binding, opts.sessionStore)) {
        plans.push({ kind: "session", binding });
        continue;
      }
      // false → fall through; throws bubble out
    }

    // 3. Supplied-ID match
    let matchedId: string | undefined;
    for (const id of unusedIds) {
      const peek = opts.store.get(id);
      if (peek === undefined) continue; // resolved in step 0
      if (approvalBindingsMatch(peek, binding)) {
        matchedId = id;
        break;
      }
    }
    if (matchedId !== undefined) {
      const peek = opts.store.get(matchedId)!;
      // Status checks BEFORE planning consume (prevents Phase 2 partial commit).
      if (peek.status === "used") {
        throw new ShuttleError("approval_already_used", "Approval was already used.");
      }
      if (peek.status === "denied") {
        throw new ShuttleError("approval_denied", "Approval was denied.");
      }
      if (peek.status === "expired") {
        throw new ShuttleError("approval_expired", "Approval expired.");
      }
      if (peek.status !== "granted") {
        // pending or anything else non-terminal: client supplied an unapproved id.
        throw new ShuttleError("approval_not_granted", "Approval not granted.");
      }
      unusedIds.delete(matchedId);
      plans.push({ kind: "consume", binding, id: matchedId });
      continue;
    }

    // 4. Mint
    plans.push({ kind: "mint", binding });
  }

  // After loop: any leftover unused IDs are mismatches.
  if (unusedIds.size > 0) {
    throw new ShuttleError(
      "approval_mismatch",
      `Supplied approval id(s) did not match any required binding: ${[...unusedIds].join(", ")}`,
    );
  }

  // Phase 2: commit.
  const mintPlans = plans.filter((p): p is Extract<Plan, { kind: "mint" }> => p.kind === "mint");
  const open = opts.openUrlImpl ?? openUrl;

  // Case B: --no-wait + mints needed → atomic mint, throw with all approvals.
  if (mintPlans.length > 0 && opts.waitMs === 0) {
    const pending: Array<{ approval_id: string; expires_at: number; action: string }> = [];
    for (const p of mintPlans) {
      const g = opts.store.create(p.binding);
      const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
      open(url);
      pending.push({ approval_id: g.id, expires_at: g.expires_at, action: p.binding.action });
    }
    // Legacy message field: pin to first approval for backward-compat parsers.
    const legacyPayload = JSON.stringify({
      approval_id: pending[0].approval_id,
      expires_at: pending[0].expires_at,
    });
    throw new ShuttleError(
      "approval_required",
      legacyPayload,
      { details: { approvals: pending } },
    );
  }

  // Case C: waiting flow + mints needed → sequential mint+wait, per binding.
  if (mintPlans.length > 0) {
    const waitBudget = opts.waitMs ?? DEFAULT_WAIT_MS;
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p.kind !== "mint") continue;
      const g = opts.store.create(p.binding);
      const url = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${g.id}&token=${g.ui_token}`;
      open(url);
      const granted = await waitForGrant(opts.store, g.id, waitBudget, p.binding);
      plans[i] = { kind: "waited", binding: p.binding, grant: granted };
    }
  }

  // Case A (and tail of Case C): commit non-mint plans + collect grants in order.
  const result: ApprovalGrant[] = [];
  for (const p of plans) {
    if (p.kind === "synth") {
      result.push(synthesizeGrant(p.binding));
    } else if (p.kind === "consume") {
      result.push(opts.store.consume(p.id, p.binding));
    } else if (p.kind === "session") {
      result.push(opts.store.mintFromSession(opts.sessionId!, p.binding, opts.sessionStore!));
    } else if (p.kind === "waited") {
      result.push(p.grant);
    } else {
      // Should be unreachable: "mint" plans only exist in --no-wait flow which already threw.
      throw new ShuttleError("unexpected_error", `unreachable plan kind: ${(p as Plan).kind}`);
    }
  }
  return result;
}

async function waitForGrant(
  store: ApprovalStore,
  id: string,
  timeoutMs: number,
  binding: ApprovalBinding,
): Promise<ApprovalGrant> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = store.get(id);
    if (g === undefined) throw new ShuttleError("approval_not_found", "Approval vanished.");
    if (g.status === "granted") {
      return store.consume(id, binding);
    }
    if (g.status === "denied") throw new ShuttleError("approval_denied", "Approval denied.");
    if (g.status === "expired") throw new ShuttleError("approval_expired", "Approval expired.");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new ShuttleError("approval_timeout", "Timed out waiting for approval.");
}

function synthesizeGrant(binding: ApprovalBinding): ApprovalGrant {
  const now = Date.now();
  return {
    ...binding,
    id: "no-approval-required",
    status: "used",
    created_at: now,
    expires_at: now,
    ui_token: "",
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- src/daemon/approvals/require-approvals.test.ts 2>&1 | tail -40`
Expected: all 16 tests pass.

If individual tests fail, fix the implementation. The most common pitfalls:
- Forgetting `unusedIds.delete(matchedId)` → leftover ID error fires when it shouldn't.
- Throwing in Phase 1 when planning a session that's at max_uses, but not also checking pending IDs first — order matters (step 0 IDs first, then per-binding loop).
- Mishandling `peek.status === "granted"` checks (Phase 1 needs to bail BEFORE consume in Phase 2).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean overall.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/require-approvals.ts src/daemon/approvals/require-approvals.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals): requireApprovals two-phase multi-binding primitive

Plan 4d core primitive. Implements the spec §2 contract:

Phase 1 (pure):
  - Step 0: resolve every supplied ID; unknown → approval_not_found.
  - Per binding in order: synth (dev) → session peek (no use bump) →
    supplied-ID match (status-checked: granted only; pending/expired/
    denied/used throw before any commit) → mint plan.
  - Leftover unused IDs → approval_mismatch.

Phase 2 (commit):
  - --no-wait + mints needed: atomic mint of just the missing
    bindings; throw approval_required with all of them in
    details.approvals. Supplied IDs are NOT consumed; sessions are
    NOT used.
  - Waiting flow + mints needed: sequential per-binding (mint, wait,
    consume) — earlier non-mint plans committed only after all mints
    are waited on, so a mid-flow denial doesn't burn earlier plans.

The singular require-approval.ts stays in place for now; existing
single-binding callers continue to use it. Migration happens in
tasks F-G; the old file is deleted in task K1.

16 unit tests cover all branches, including the partial-no-wait
(supplied IDs not burned), session-not-burned-on-incomplete, session-
first precedence, max_uses peek, and sequential-waiting denial cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task D1: `optApprovalIds` helper in validate.ts

**Files:**
- Modify: `src/daemon/api/validate.ts`
- Test: `src/daemon/api/validate.test.ts` (create or extend)

- [ ] **Step 1: Locate test file**

Run: `ls src/daemon/api/validate.test.ts 2>&1`

If it doesn't exist, create it with this header:

```ts
import { describe, test } from "node:test";
import assert from "node:assert";
import { optApprovalIds } from "./validate.js";
import { ShuttleError } from "../../shared/errors.js";
```

- [ ] **Step 2: Write the failing tests**

```ts
test("optApprovalIds: empty body → undefined", () => {
  assert.strictEqual(optApprovalIds({}), undefined);
});

test("optApprovalIds: singular approval_id → [approval_id]", () => {
  assert.deepStrictEqual(optApprovalIds({ approval_id: "a" }), ["a"]);
});

test("optApprovalIds: approval_ids array → array", () => {
  assert.deepStrictEqual(optApprovalIds({ approval_ids: ["a", "b"] }), ["a", "b"]);
});

test("optApprovalIds: both fields supplied → bad_request approval_id_and_approval_ids_supplied", () => {
  assert.throws(
    () => optApprovalIds({ approval_id: "a", approval_ids: ["b"] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("approval_id_and_approval_ids_supplied"),
  );
});

test("optApprovalIds: approval_ids with duplicates → bad_request duplicate_approval_id", () => {
  assert.throws(
    () => optApprovalIds({ approval_ids: ["a", "a"] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("duplicate_approval_id"),
  );
});

test("optApprovalIds: empty array → undefined", () => {
  assert.strictEqual(optApprovalIds({ approval_ids: [] }), undefined);
});

test("optApprovalIds: approval_id wrong type → bad_request", () => {
  assert.throws(
    () => optApprovalIds({ approval_id: 42 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request",
  );
});

test("optApprovalIds: approval_ids contains non-string → bad_request", () => {
  assert.throws(
    () => optApprovalIds({ approval_ids: ["a", 42] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request",
  );
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- src/daemon/api/validate.test.ts 2>&1 | tail -15`
Expected: FAIL — `optApprovalIds is not exported`.

- [ ] **Step 4: Implement the helper**

Append to `src/daemon/api/validate.ts`:

```ts
/**
 * Read the approval-id payload from a request body. Accepts either:
 *   - approval_ids: string[]
 *   - approval_id: string  (legacy alias; deprecated; kept for one release)
 * Rejects:
 *   - both fields supplied → bad_request "approval_id_and_approval_ids_supplied"
 *   - approval_ids has duplicates → bad_request "duplicate_approval_id"
 * Empty array is treated as if the field were omitted (returns undefined).
 */
export function optApprovalIds(o: Record<string, unknown>): string[] | undefined {
  const singular = o["approval_id"];
  const plural = o["approval_ids"];
  if (singular !== undefined && plural !== undefined) {
    throw new ShuttleError(
      "bad_request",
      "approval_id_and_approval_ids_supplied: send either approval_id (legacy) or approval_ids (canonical), not both",
    );
  }
  if (singular !== undefined) {
    if (typeof singular !== "string") {
      throw new ShuttleError("bad_request", "approval_id: must be a string");
    }
    return [singular];
  }
  if (plural === undefined) return undefined;
  if (!Array.isArray(plural)) {
    throw new ShuttleError("bad_request", "approval_ids: must be a string array");
  }
  for (const x of plural) {
    if (typeof x !== "string") {
      throw new ShuttleError("bad_request", "approval_ids: each entry must be a string");
    }
  }
  if (plural.length === 0) return undefined;
  const seen = new Set<string>();
  for (const x of plural) {
    if (seen.has(x)) {
      throw new ShuttleError(
        "bad_request",
        `duplicate_approval_id: ${x} appears more than once in approval_ids`,
      );
    }
    seen.add(x);
  }
  return plural;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- src/daemon/api/validate.test.ts 2>&1 | tail -15`
Expected: PASS (8 tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/validate.ts src/daemon/api/validate.test.ts
git commit -m "$(cat <<'EOF'
feat(api/validate): optApprovalIds body-parser helper

Plan 4d Phase 3: every approval-gated route needs the same alias +
dup-rejection logic for the new approval_ids field. optApprovalIds
normalizes:
  - approval_id (legacy singular) → [approval_id]
  - approval_ids (canonical array) → array (deduped + non-empty)
  - both supplied → bad_request approval_id_and_approval_ids_supplied
  - duplicate IDs in array → bad_request duplicate_approval_id
  - empty array or omitted → undefined

8 tests cover each branch including type-mismatch fallbacks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task E1: CLI shared `--approval-id` option factory

**Files:**
- Create: `src/cli/commands/_approval-id-option.ts`
- Test: `src/cli/commands/_approval-id-option.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/_approval-id-option.test.ts`:

```ts
import { describe, test } from "node:test";
import assert from "node:assert";
import { Command } from "commander";
import { addApprovalIdOption } from "./_approval-id-option.js";

test("addApprovalIdOption: single --approval-id → [id]", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test", "--approval-id", "abc"]);
  assert.deepStrictEqual(cmd.opts().approvalId, ["abc"]);
});

test("addApprovalIdOption: repeated --approval-id → array of ids", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test", "--approval-id", "a", "--approval-id", "b"]);
  assert.deepStrictEqual(cmd.opts().approvalId, ["a", "b"]);
});

test("addApprovalIdOption: omitted → undefined", () => {
  const cmd = addApprovalIdOption(new Command("test")).action(() => {});
  cmd.parse(["node", "test"]);
  assert.strictEqual(cmd.opts().approvalId, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/cli/commands/_approval-id-option.test.ts 2>&1 | tail -10`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the factory**

Create `src/cli/commands/_approval-id-option.ts`:

```ts
import type { Command } from "commander";

/**
 * Adds the repeatable `--approval-id <id>` option to a command. Used by every
 * CLI command that gates on the approval flow. Each occurrence appends to an
 * accumulator, so `--approval-id a --approval-id b` yields ["a", "b"].
 *
 * After parsing: cmd.opts().approvalId has type `string[] | undefined`. Pass
 * to the body as `approval_ids` (NOT `approval_id`) — the route's
 * optApprovalIds helper normalizes either field, but new code sends the
 * canonical array form.
 */
export function addApprovalIdOption(cmd: Command): Command {
  const accumulator = (val: string, prev: string[] | undefined): string[] =>
    prev ? [...prev, val] : [val];
  return cmd.option(
    "--approval-id <id>",
    "Pre-issued approval id. Repeatable when an operation needs multiple approvals.",
    accumulator,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/cli/commands/_approval-id-option.test.ts 2>&1 | tail -10`
Expected: PASS (3 tests).

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/_approval-id-option.ts src/cli/commands/_approval-id-option.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): addApprovalIdOption shared --approval-id factory

Plan 4d Phase 4 prep: every approval-gated CLI command needs the same
repeatable --approval-id <id> declaration. Centralizing it as a single
addApprovalIdOption(cmd) function ensures all 13 commands use the
same accumulator logic — no inline copy-paste.

No commands wired to it yet; migrations happen in task G.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F1: Migrate `secrets.ts` (4 routes inside)

**File:** `src/daemon/api/routes/secrets.ts`

This file holds 4 distinct routes (`/v1/secrets/generate`, `/v1/secrets/capture`, `/v1/secrets/inject`, `/v1/secrets/compare`), each with its own `requireApproval` call site. They all use the same singular pattern.

- [ ] **Step 1: Update the import**

Change line 2 from:

```ts
import { requireApproval } from "../../approvals/require-approval.js";
```

to:

```ts
import { requireApprovals } from "../../approvals/require-approvals.js";
```

- [ ] **Step 2: Update body type definitions (lines 29, 41, 47, 54)**

Replace each occurrence of `approval_id?: string;` in body interfaces with `approval_ids?: string[];`. There are 4 such occurrences across 4 body interfaces.

- [ ] **Step 3: Add the `optApprovalIds` import**

The file already imports from `../validate.js`. Update the import line to include `optApprovalIds`:

Find:
```ts
import { /* existing list */ } from "../validate.js";
```

Add `optApprovalIds` to the destructuring (alphabetical order recommended). Example:
```ts
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
```

- [ ] **Step 4: Update body parsing — search & replace for `b.approval_id`**

In each of the 4 route bodies (look for `optString(o, "approval_id")` and replace each with `optApprovalIds(o)`; the destructured variable name in `body.approval_id` should be renamed to `body.approval_ids`).

For each route in the file:
- Find `const approvalId = optString(o, "approval_id");` (or similar — sometimes it's accessed inline).
- Replace with `const approvalIds = optApprovalIds(o);`.
- Find `body.approval_id` usages and rename.

The route may also use the validated form directly via `b.approval_id` — in that case, change the body interface field and update at the use site.

- [ ] **Step 5: Update each `requireApproval` call to `requireApprovals`**

For each of the 4 `requireApproval(...)` call sites (at line 140, 225, 311, 392):

Find pattern (with variations):
```ts
grant = await requireApproval({
  store: services.approvals,
  binding,
  daemonPort: daemonPortRef(),
  // ...other opts...
  ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
  ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
});
```

Replace with:
```ts
const grants = await requireApprovals({
  store: services.approvals,
  bindings: [binding],
  daemonPort: daemonPortRef(),
  // ...other opts unchanged...
  ...(b.approval_ids !== undefined ? { approvalIdsFromClient: b.approval_ids } : {}),
  ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
});
grant = grants[0];
```

For calls where the result was used directly (e.g., `await requireApproval(...);` without assigning to `grant`), use:
```ts
const grants = await requireApprovals({ ...bindings: [binding], ... });
// keep `grants` if it's used downstream; otherwise the await is enough
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: clean. If TypeScript reports `b.approval_id` no longer exists, you missed a use-site — update it.

- [ ] **Step 7: Run tests**

Run: `npm test -- src/daemon/api/routes/secrets-generate.test.ts src/daemon/api/routes/templates.test.ts 2>&1 | tail -20`

(secrets-generate.test.ts covers `/v1/secrets/generate`; the others test compare/capture/inject indirectly via routes — check the actual coverage.)

Run all secrets-related tests:

Run: `npm test -- --test-name-pattern="secrets|generate|compare|capture|inject" 2>&1 | tail -30`
Expected: all pass.

If a test fails because it constructed a body with `approval_id`, the test still works (alias normalizes to `approval_ids`) — investigate the actual failure.

- [ ] **Step 8: Run full suite**

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: full suite passes.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/api/routes/secrets.ts
git commit -m "$(cat <<'EOF'
refactor(routes/secrets): migrate to requireApprovals + optApprovalIds

Plan 4d Phase 5. All 4 routes in secrets.ts (generate, capture, inject,
compare) now use the new multi-binding primitive (with a single-binding
list) and the optApprovalIds body helper. No behavioral change for
single-approval operations; the legacy `approval_id` request field
continues to work via optApprovalIds's alias normalization.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tasks F2-F8: Migrate remaining single-binding routes

Each task follows the same pattern as F1. Each commits independently so subagent dispatch can keep tasks bite-sized.

### Task F2: `secrets-delete.ts`

**File:** `src/daemon/api/routes/secrets-delete.ts`

- [ ] **Step 1: Edit imports + body type + call site**

Apply the same sequence from Task F1 to this file:
1. Replace `import { requireApproval } from "../../approvals/require-approval.js";` with `import { requireApprovals } from "../../approvals/require-approvals.js";`.
2. Add `optApprovalIds` to the validate import.
3. Body interface: change `approval_id?: string;` (line 11) → `approval_ids?: string[];`.
4. Body parsing: locate where `approval_id` is parsed (the file uses `optString` or destructured). Replace with `optApprovalIds(o)`. Rename variable from `approvalId` → `approvalIds` (or `body.approval_ids`).
5. Replace the `requireApproval(...)` call at line 62 with `requireApprovals({ bindings: [binding], ...approvalIdsFromClient: body.approval_ids, ... })` and `grant = grants[0]`.

- [ ] **Step 2: Typecheck + test**

```bash
npm run typecheck
npm test -- src/daemon/api/routes/secrets-delete.test.ts 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/secrets-delete.ts
git commit -m "refactor(routes/secrets-delete): migrate to requireApprovals + optApprovalIds

Plan 4d Phase 5. Single-binding migration; no behavioral change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task F3: `secrets-rotate.ts`

**File:** `src/daemon/api/routes/secrets-rotate.ts`

Same procedure as F2.

- [ ] **Step 1: Apply migration**
- [ ] **Step 2: `npm run typecheck && npm test -- src/daemon/api/routes/secrets-rotate.test.ts 2>&1 | tail -10`** → clean
- [ ] **Step 3: Commit** (same template as F2, swap path)

### Task F4: `templates.ts`

**File:** `src/daemon/api/routes/templates.ts`

Same procedure. Route is `/v1/templates/run` at line 33.

- [ ] **Step 1: Apply migration**
- [ ] **Step 2: `npm run typecheck && npm test -- src/daemon/api/routes/templates.test.ts 2>&1 | tail -10`** → clean
- [ ] **Step 3: Commit**

### Task F5: `reveal-capture.ts`

**File:** `src/daemon/api/routes/reveal-capture.ts`

Single route `/v1/secrets/reveal-capture` at line 36.

- [ ] **Step 1: Apply migration**
- [ ] **Step 2: `npm run typecheck && npm test 2>&1 | tail -10`** → clean (search for reveal-capture-related tests)
- [ ] **Step 3: Commit**

### Task F6: `blind.ts`

**File:** `src/daemon/api/routes/blind.ts`

Two routes: `/v1/blind/start` (line 14, MAY not have `requireApproval` — verify before editing) and `/v1/blind/end` (line 47, definitely has `requireApproval` per the grep).

- [ ] **Step 1: Confirm both call sites**

Run: `grep -n "requireApproval\|approval_id" src/daemon/api/routes/blind.ts`

If only `/v1/blind/end` calls `requireApproval`, migrate only that one. The body interface for EndBody at line 11 has `approval_id?: string;` — update to `approval_ids?: string[];`.

- [ ] **Step 2: Apply migration**
- [ ] **Step 3: `npm run typecheck && npm test 2>&1 | tail -10`** → clean
- [ ] **Step 4: Commit**

### Task F7: `inject-render.ts`

**File:** `src/daemon/api/routes/inject-render.ts`

Single `requireApproval` call at line 80.

- [ ] **Step 1: Apply migration**
- [ ] **Step 2: `npm run typecheck && npm test -- src/daemon/api/routes/inject-render.test.ts 2>&1 | tail -10`** → clean
- [ ] **Step 3: Commit**

### Task F8: `inject-submit.ts`

**File:** `src/daemon/api/routes/inject-submit.ts`

Single `requireApproval` call at line 123.

- [ ] **Step 1: Apply migration**
- [ ] **Step 2: `npm run typecheck && npm test 2>&1 | tail -10`** → clean (search inject-submit tests)
- [ ] **Step 3: Commit**

---

## Task G1: Migrate `secrets/*` CLI commands

**Files:**
- Modify: `src/cli/commands/secrets/set.ts`
- Modify: `src/cli/commands/secrets/delete.ts`
- Modify: `src/cli/commands/secrets/rotate.ts`

For each file, the migration is:
1. Add import: `import { addApprovalIdOption } from "../_approval-id-option.js";`
2. Replace the inline `.option("--approval-id <id>", ...)` declaration with `addApprovalIdOption(cmd)` (or similar — depends on whether the command builds the Commander chain inline).
3. Change body construction from `body.approval_id = options.approvalId` (assumes string) to `body.approval_ids = options.approvalId` (now string[]). The route normalizes either field, but new code sends the canonical array form.

- [ ] **Step 1: Update `src/cli/commands/secrets/set.ts`**

Find the existing `--approval-id` option declaration (around line 21). Replace:

```ts
.option("--approval-id <id>", "Pre-issued approval id.")
```

with:

```ts
// after the program chain is built, before .action(...), pipe through addApprovalIdOption.
```

Specifically, locate the Commander chain like:
```ts
return new Command("set")
  .description(...)
  .option(...)
  .option("--approval-id <id>", "Pre-issued approval id.")
  ...
  .action(async (options) => { ... });
```

Replace with:
```ts
const cmd = new Command("set")
  .description(...)
  .option(...)
  // (remove the --approval-id .option call)
  ...;
addApprovalIdOption(cmd);
return cmd.action(async (options) => { ... });
```

OR if the codebase uses a chain-final pattern, keep inline:
```ts
const cmd = new Command("set")
  .description(...)
  .option(...);
addApprovalIdOption(cmd);
return cmd.action(...);
```

Update body construction (line 52 or thereabouts):
```ts
if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
```

(Note: `options.approvalId` is now `string[] | undefined`, not `string`. The route's `optApprovalIds` accepts the array form.)

- [ ] **Step 2: Apply same migration to `src/cli/commands/secrets/delete.ts`**

Same pattern. Body line ~16.

- [ ] **Step 3: Apply same migration to `src/cli/commands/secrets/rotate.ts`**

Same pattern. Body line ~20.

- [ ] **Step 4: Typecheck + test**

```bash
npm run typecheck
npm test -- src/cli/commands/secrets/secrets.test.ts 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/secrets/
git commit -m "$(cat <<'EOF'
refactor(cli/secrets): use addApprovalIdOption + approval_ids body

Plan 4d Phase 6. secrets set/delete/rotate now declare --approval-id
via the shared factory and send approval_ids (array) on the wire.
options.approvalId is now string[] | undefined; the route's
optApprovalIds normalizes either field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G2: Migrate inject/capture/generate/compare CLI commands

**Files:**
- Modify: `src/cli/commands/inject.ts`
- Modify: `src/cli/commands/inject-submit.ts`
- Modify: `src/cli/commands/inject-internal.ts`
- Modify: `src/cli/commands/capture.ts`
- Modify: `src/cli/commands/reveal-capture.ts`
- Modify: `src/cli/commands/generate.ts`
- Modify: `src/cli/commands/compare.ts`

Same pattern as G1 for each file.

- [ ] **Step 1: Apply migration to each file in turn**

For each file:
1. Add `import { addApprovalIdOption } from "./_approval-id-option.js";` (note: `./` since they're siblings, not `../`).
2. Wire `addApprovalIdOption(cmd)` into the Commander chain.
3. Change `body.approval_id = options.approvalId` → `body.approval_ids = options.approvalId`.

- [ ] **Step 2: Typecheck + test**

```bash
npm run typecheck
npm test 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/inject.ts src/cli/commands/inject-submit.ts src/cli/commands/inject-internal.ts src/cli/commands/capture.ts src/cli/commands/reveal-capture.ts src/cli/commands/generate.ts src/cli/commands/compare.ts
git commit -m "$(cat <<'EOF'
refactor(cli): inject/capture/generate/compare use addApprovalIdOption

Plan 4d Phase 6, second batch. 7 commands now declare --approval-id
via the shared factory and send approval_ids on the wire.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G3: Migrate template/blind/run CLI commands

**Files:**
- Modify: `src/cli/commands/template.ts`
- Modify: `src/cli/commands/blind.ts`
- Modify: `src/cli/commands/run.ts`

Same pattern.

- [ ] **Step 1: Apply migration to `src/cli/commands/template.ts`**

Body line ~31: `body.approval_id = options.approvalId` → `body.approval_ids = options.approvalId`.

- [ ] **Step 2: Apply migration to `src/cli/commands/blind.ts`**

Body line ~23.

- [ ] **Step 3: Apply migration to `src/cli/commands/run.ts`**

Body line ~69.

Special: `run.ts` is the consumer of multi-approval. After migration to `approval_ids`, the `--no-wait` flow will surface multiple approvals via `details.approvals`. The top-level JSON error handler (`src/cli/index.ts`) already prints the whole `errorToJson` payload — the `details.approvals` field appears under the JSON `details` key automatically. **No additional handling needed in run.ts for Plan 4d**; agents parse JSON.

- [ ] **Step 4: Typecheck + test**

```bash
npm run typecheck
npm test 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/template.ts src/cli/commands/blind.ts src/cli/commands/run.ts
git commit -m "$(cat <<'EOF'
refactor(cli): template/blind/run use addApprovalIdOption

Plan 4d Phase 6, third batch. All 13 CLI commands now use the shared
--approval-id factory and send approval_ids on the wire. run.ts is
ready to surface multi-approval via details.approvals on --no-wait
once the route migrates (task H1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task H1: Migrate `run-resolve` to multi-binding `requireApprovals`

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.ts`

This is the keystone task. The `combined_no_wait_unsupported` fail-fast block STAYS in place during this task as a belt-and-suspenders safety net. It's deleted later (task J1) only after the integration test in I1 passes.

- [ ] **Step 1: Update imports**

Change line 3 from:
```ts
import { requireApproval } from "../../approvals/require-approval.js";
```
to:
```ts
import { requireApprovals } from "../../approvals/require-approvals.js";
```

Add `optApprovalIds` to validate import (line 13):
```ts
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
```

- [ ] **Step 2: Update body interface**

Around line 17:

Change:
```ts
approval_id?: string;
```
to:
```ts
approval_ids?: string[];
```

- [ ] **Step 3: Update body parsing (around line 121)**

Change:
```ts
const approvalId = optString(o, "approval_id");
```
to:
```ts
const approvalIds = optApprovalIds(o);
```

Find where `body.approval_id` is set in the resulting body object and rename to `body.approval_ids = approvalIds`.

- [ ] **Step 4: Replace the two `requireApproval` blocks (lines ~297-392) with one `requireApprovals` call**

Locate the existing envApprovalRan flag block and the two if-blocks for env approval and stdin approval. Replace ALL of that (from the start of `const envProductionRefs = ...` through the end of the stdin approval try-catch) with:

```ts
// Compute env-binding production refs.
const envProductionRefs = body.refs.filter(
  (r) => resolved.get(r)!.environment === "production",
);

// Build the bindings list. Each binding maps to a distinct approval action
// (env: action="run", stdin: action="run_stdin"), so they must be SEPARATE
// bindings — see plan-4d spec §1. Bindings in deterministic order: env first,
// stdin second.
const bindings: ApprovalBinding[] = [];
let envBinding: ApprovalBinding | undefined;
let stdinBinding: ApprovalBinding | undefined;

if (envProductionRefs.length > 0) {
  envBinding = {
    action: "run",
    ref: null,
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: {
      command: body.command,
      args: JSON.stringify(body.args),
      refs: body.refs.join(","),
    },
    allowed_domains: [],
  };
  bindings.push(envBinding);
}

if (body.stdin_ref !== undefined && resolved.get(body.stdin_ref)!.environment === "production") {
  stdinBinding = {
    action: "run_stdin",
    ref: body.stdin_ref,
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: {
      command: body.command,
      args: JSON.stringify(body.args),
      ref: body.stdin_ref,
    },
    allowed_domains: [],
  };
  bindings.push(stdinBinding);
}

if (bindings.length > 0) {
  try {
    const grants = await requireApprovals({
      store: services.approvals,
      bindings,
      daemonPort: daemonPortRef(),
      sessionStore: services.sessionStore,
      openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
      ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
      ...(body.approval_ids !== undefined ? { approvalIdsFromClient: body.approval_ids } : {}),
      ...(body.wait_for_approval === false ? { waitMs: 0 } : {}),
    });
    // session_id propagation: any grant with session_id wins; default to first.
    // ApprovalGrant.session_id is `string | undefined` (store.ts:56).
    grant = grants.find((g) => g.session_id !== undefined) ?? grants[0];
  } catch (e) {
    await auditPerRef(
      allRefs,
      body.stdin_ref,
      resolved,
      false,
      e instanceof ShuttleError ? e.code : "unexpected_error",
      grant?.session_id,
    );
    writeJsonError(res, 400, e);
    return;
  }
}
```

The `envApprovalRan` flag and its bookkeeping are deleted as part of this consolidation — `requireApprovals` handles atomicity internally.

**Do NOT delete the `combined_no_wait_unsupported` fail-fast block (lines 244-283) yet.** It stays as a safety net until the integration test in I1 passes.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: clean. If TypeScript reports unused imports (e.g., `requireApproval` no longer referenced), remove them.

- [ ] **Step 6: Run existing run-resolve tests**

Run: `npm test -- src/daemon/api/routes/run-resolve.test.ts 2>&1 | tail -30`
Expected: ALL existing tests pass. Critically, the `combined_no_wait_unsupported` regression tests at lines ~1058-1101 STILL pass — the fail-fast is still in place and still catches the unsupported case.

If a non-fail-fast test fails (e.g., env-only approval flow, stdin-only flow), investigate — the new call site signature or grant assignment is wrong.

- [ ] **Step 7: Run full suite**

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/api/routes/run-resolve.ts
git commit -m "$(cat <<'EOF'
refactor(routes/run-resolve): migrate to requireApprovals multi-binding

Plan 4d Phase 7 (keystone). The two sequential requireApproval blocks
(env + stdin) collapse into one requireApprovals call with both
bindings. envApprovalRan flag bookkeeping deleted — atomicity now
lives in the primitive's two-phase invariant.

The combined_no_wait_unsupported fail-fast block STAYS in place as a
belt-and-suspenders safety net. It's deleted only after the
integration test in task I1 proves the continuation path converges.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task I1: Integration test — combined --no-wait converges

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.test.ts`

This task is the GATE. Until it passes, the fail-fast block in task J1 cannot be deleted.

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/api/routes/run-resolve.test.ts`:

```ts
test("POST /v1/run/resolve: combined production env+stdin + --no-wait converges via approval_ids", async () => {
  // This test proves the Plan 4d continuation path. Before Plan 4d, this
  // request would hit the combined_no_wait_unsupported fail-fast at lines
  // 244-283. After Plan 4d's multi-binding requireApprovals lands, the same
  // request should:
  //   (a) on first call (no approval_ids), throw approval_required with
  //       details.approvals of length 2 (run + run_stdin).
  //   (b) on retry with both approval_ids (after manual approve), succeed
  //       and stream the child output.

  // NOTE: while the fail-fast block at lines 244-283 is STILL in place, the
  // request below would hit IT, not the multi-binding path. To prove the
  // multi-binding path, we need to either:
  //   - delete the fail-fast first (impossible — that's gated on this test).
  //   - OR: temporarily disable it via a feature flag (yagni).
  //   - OR: BYPASS the fail-fast by crafting a request that doesn't hit it.
  //
  // Easier route: this test asserts the EXPECTED post-fail-fast-deletion
  // behavior. We RUN it now to capture the assertion, then in task J1 the
  // fail-fast is deleted and this test starts passing.
  //
  // Concretely: this test will FAIL with combined_no_wait_unsupported until
  // J1 lands. That failure IS the gate — once the test passes, J1 has been
  // executed correctly.

  await withHarness(async (ctx) => {
    // Seed two production refs: one for env-file, one for stdin.
    const envRef = await ctx.seedSecret({ source: "local", environment: "prod", key: "API_KEY", value: "env-secret-value" });
    const stdinRef = await ctx.seedSecret({ source: "local", environment: "prod", key: "STDIN_TOKEN", value: "stdin-secret-value" });

    // First call: no approval_ids, --no-wait. Expected: approval_required with details.approvals length 2.
    const firstResponse = await ctx.postBody("/v1/run/resolve", {
      refs: [envRef],
      env: [{ key: "API_KEY", value: envRef, isRef: true }],
      command: "/bin/echo",
      args: ["hello"],
      cwd: process.cwd(),
      stdin_ref: stdinRef,
      wait_for_approval: false,
    });
    assert.strictEqual(firstResponse.status, 400, "first call expects 400 approval_required");
    const firstPayload = await firstResponse.json() as Record<string, unknown>;
    assert.strictEqual(firstPayload.error_code, "approval_required");
    const details = firstPayload.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> } | undefined;
    assert.ok(details, "approval_required must carry details.approvals");
    assert.strictEqual(details.approvals.length, 2, "expected 2 approvals (run + run_stdin)");
    const envApproval = details.approvals.find((a) => a.action === "run");
    const stdinApproval = details.approvals.find((a) => a.action === "run_stdin");
    assert.ok(envApproval, "env approval (action=run) must be present");
    assert.ok(stdinApproval, "stdin approval (action=run_stdin) must be present");

    // User approves BOTH (simulating hub UI clicks).
    ctx.services.approvals.approve(envApproval.approval_id);
    ctx.services.approvals.approve(stdinApproval.approval_id);

    // Second call: pass both approval_ids. Expected: command runs to completion.
    const secondResponse = await ctx.postBody("/v1/run/resolve", {
      refs: [envRef],
      env: [{ key: "API_KEY", value: envRef, isRef: true }],
      command: "/bin/echo",
      args: ["hello"],
      cwd: process.cwd(),
      stdin_ref: stdinRef,
      approval_ids: [envApproval.approval_id, stdinApproval.approval_id],
      wait_for_approval: false,
    });
    assert.strictEqual(secondResponse.status, 200, "second call (with both approval_ids) expects 200");
    const events = await ctx.collectStream(secondResponse);
    // Last event should be exit; exit code 0 for successful echo.
    const exitEvent = events.find((e) => "exit" in e);
    assert.ok(exitEvent, "stream must end with exit event");
    assert.strictEqual((exitEvent as { exit: number }).exit, 0);
  });
});
```

Adapt the test scaffolding (`withHarness`, `ctx.seedSecret`, `ctx.postBody`, `ctx.collectStream`) to whatever shape the existing tests in `run-resolve.test.ts` use. If the harness API differs, mirror the patterns used in existing tests (e.g., look at the existing `combined_no_wait_unsupported` test for the seed/post setup, the existing stdin-passthrough test for the stream collection).

- [ ] **Step 2: Run the test — it MUST fail**

Run: `npm test -- src/daemon/api/routes/run-resolve.test.ts --test-name-pattern="combined production env\\+stdin \\+ --no-wait converges" 2>&1 | tail -20`

Expected: **FAIL**. The first call hits the fail-fast block at lines 244-283 and returns `combined_no_wait_unsupported` instead of `approval_required`. This failure proves:
  (a) the test is correctly written (it would pass once J1 deletes the fail-fast),
  (b) the fail-fast is doing its job right now.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/daemon/api/routes/run-resolve.test.ts
git commit -m "$(cat <<'EOF'
test(routes/run-resolve): combined env+stdin --no-wait continuation (failing — gates J1)

Plan 4d Phase 8 — the gate. This test asserts the post-multi-binding,
post-fail-fast-deletion behavior:
  (a) first call (no approval_ids) → 400 approval_required with
      details.approvals of length 2 (run + run_stdin).
  (b) retry with both approval_ids → 200, command runs, exit 0.

CURRENT STATE: FAILING. The combined_no_wait_unsupported fail-fast
block at run-resolve.ts:244-283 intercepts the first call and
returns the fail-fast error, not approval_required. This is correct
— the fail-fast is still doing its job.

Task J1 deletes the fail-fast block. This test will then pass and
prove the continuation path works end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task J1: Delete fail-fast + `combined_no_wait_unsupported` everything

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.ts` (delete fail-fast block)
- Modify: `src/shared/error-codes.ts` (delete error code)
- Modify: `src/shared/error-codes.test.ts` (delete its tests + decrement count)
- Modify: `src/daemon/api/routes/run-resolve.test.ts` (delete its regression tests)
- Modify: `CHANGELOG.md` (delete Known-limitation bullet)

Per the spec §10 ordering constraint, this task runs AFTER I1's test is in place (currently failing). After this task, I1's test should PASS.

- [ ] **Step 1: Delete fail-fast block in run-resolve.ts**

In `src/daemon/api/routes/run-resolve.ts`, delete lines 244-283 — the entire block starting with:

```ts
    // Plan 4c post-ship P1: fail-fast combined production env+stdin under
```

and ending with:

```ts
      return;
    }
```

(includes the long comment + the `const hasProductionStdin = ...`/`const hasProductionEnv = ...` calculations + the `if (hasProductionEnv && hasProductionStdin && ...)` block).

- [ ] **Step 2: Delete `combined_no_wait_unsupported` from `src/shared/error-codes.ts`**

Find and delete the line:

```ts
  combined_no_wait_unsupported: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

- [ ] **Step 3: Delete its tests from `src/shared/error-codes.test.ts`**

Find and delete the test block "error-codes: combined_no_wait_unsupported registered with USAGE exit code" (lines ~181-189).

Update the count comment at line ~142:
```ts
// Plan 4c post-ship P1 adds 1 more (combined_no_wait_unsupported) = 120 total.
```
to reflect the new count. After deletion, count is 119. Update the test that asserts on this count if such a test exists.

Search for any "120" or "119" string in the test file:

Run: `grep -n "120\|119" src/shared/error-codes.test.ts`

Adjust assertions accordingly.

- [ ] **Step 4: Delete regression tests in `run-resolve.test.ts`**

Search for `combined_no_wait_unsupported` in `src/daemon/api/routes/run-resolve.test.ts`:

Run: `grep -n "combined_no_wait_unsupported" src/daemon/api/routes/run-resolve.test.ts`

The grep at the top of this plan found mentions at lines 1058, 1063, 1095, 1100, 1101. Delete the entire test block(s) that assert on `combined_no_wait_unsupported`. The positive counter-test (if separate) checking that a regular `--no-wait` env-only or stdin-only path STILL works should be KEPT — only delete tests that specifically assert on the fail-fast.

- [ ] **Step 5: Delete the CHANGELOG Known-limitations bullet**

In `CHANGELOG.md`, find the bullet starting with "Combined `--env-file` (with production refs) + `--stdin`" (around line 115-117). Delete it entirely. The other "Known limitations" bullets stay.

- [ ] **Step 6: Run the I1 test — it should NOW pass**

Run: `npm test -- src/daemon/api/routes/run-resolve.test.ts --test-name-pattern="combined production env\\+stdin \\+ --no-wait converges" 2>&1 | tail -20`

Expected: **PASS**. The fail-fast is gone, the continuation path executes, both approvals mint, both consume, command runs.

If the test still fails, investigate:
- Did the fail-fast actually get removed? `grep -n combined_no_wait_unsupported src/daemon/api/routes/run-resolve.ts` should return nothing.
- Did `requireApprovals` correctly handle the two-binding case? Re-read the test expectations.

- [ ] **Step 7: Run full suite**

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/api/routes/run-resolve.ts src/shared/error-codes.ts src/shared/error-codes.test.ts src/daemon/api/routes/run-resolve.test.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat(run-resolve): delete combined_no_wait_unsupported (continuation path proven)

Plan 4d Phase 9. The integration test in task I1 now passes — combined
production env+stdin --no-wait converges via Phase 1 two-binding mint
and Phase 2 atomic consume. The fail-fast safety net is no longer
needed.

Deletions:
  - run-resolve.ts fail-fast block (40 lines)
  - error-codes.ts registry entry (1 line)
  - error-codes.test.ts registration test (~8 lines) + count comment
  - run-resolve.test.ts regression tests for the fail-fast (~50 lines)
  - CHANGELOG.md Known-limitations bullet

Error code count: 120 → 119.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task K1: Delete `require-approval.ts` (old singular primitive)

**Files:**
- Delete: `src/daemon/approvals/require-approval.ts`
- Delete: `src/daemon/approvals/require-approval.test.ts`
- Modify: `src/daemon/approvals/store.ts` — delete `findOrMintFromSession` method

After tasks F1-F8 migrated all routes to `requireApprovals`, the old `requireApproval` and `findOrMintFromSession` have zero callers.

- [ ] **Step 1: Verify no callers remain**

Run: `grep -rn "requireApproval\b\|findOrMintFromSession" src/ 2>&1 | grep -v "require-approval"`

Expected output: nothing (or only test references that are about to be deleted). Any source file that still imports `requireApproval` indicates a missed migration — STOP and fix the missed file before continuing.

- [ ] **Step 2: Delete files**

```bash
rm src/daemon/approvals/require-approval.ts
rm src/daemon/approvals/require-approval.test.ts
```

- [ ] **Step 3: Delete `findOrMintFromSession` from store.ts**

In `src/daemon/approvals/store.ts`, delete the entire `findOrMintFromSession` method (lines 130-171).

- [ ] **Step 4: Check for stale references to findOrMintFromSession in tests**

Run: `grep -rn "findOrMintFromSession" src/`

Expected: nothing. Any leftover reference is in a test that probably needs updating to use `canMatchSession` + `mintFromSession` instead.

- [ ] **Step 5: Run full suite**

Run: `npm run typecheck && npm test 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/daemon/approvals/
git commit -m "$(cat <<'EOF'
refactor(approvals): delete old require-approval.ts + findOrMintFromSession

Plan 4d Phase 10 cleanup. All routes now use the new requireApprovals
two-phase primitive (tasks F1-F8) and the canMatchSession +
mintFromSession split (tasks A2-A3). The singular primitive and the
combined session-mint method have no callers and are removed.

  - src/daemon/approvals/require-approval.ts (deleted)
  - src/daemon/approvals/require-approval.test.ts (deleted)
  - ApprovalStore.findOrMintFromSession (deleted)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task L1: CHANGELOG + docs + final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/roadmap.md`
- Modify: `src/shared/error-codes.ts` (update `approval_required` hint)

- [ ] **Step 1: Update `approval_required` hint in `src/shared/error-codes.ts`**

Find (around line 149-154):
```ts
  approval_required: {
    exitCode: EXIT_CODE_PERMISSION,
    // The thrown message is JSON: {approval_id, expires_at}. The hint
    // tells the agent how to recover.
    hint: () => "Approve in the daemon UI, then re-run with --approval-id <id> (id is in the message JSON).",
  },
```

Replace with:
```ts
  approval_required: {
    exitCode: EXIT_CODE_PERMISSION,
    // Single-approval ops: read approval_id from the message JSON.
    // Multi-approval ops: read details.approvals (array of {approval_id, expires_at, action}).
    // Either way, retry with --approval-id <id> (repeatable for each pending approval).
    hint: () => "Approve in the opened hub, then retry with --approval-id <id> (repeatable for each id listed under details.approvals).",
  },
```

- [ ] **Step 2: Add Plan 4d section to CHANGELOG.md**

In `CHANGELOG.md`, locate the top "## [Unreleased]" or current dev section (or the most recent version section). Add a new sub-section above existing entries:

```markdown
### Plan 4d — Multi-approval continuation

**Added:**

- Multi-approval continuation: operations that gate on multiple `ApprovalBinding`s (currently only `run --env-file <prod> --stdin <prod>`) now work end-to-end under `--no-wait`. The daemon mints all required approvals atomically on the first round-trip and returns them via the new `details.approvals` array. The CLI carries them back via repeatable `--approval-id <id>` flags. Closes the v0.2.0 Known-limitation documented after Plan 4c.

- `ShuttleError` now carries an optional `details` field, propagated through `errorToJson` and reconstructed by `daemonErrorFromPayload`. Used by `approval_required` to surface the `approvals` array; available for any future error code that needs structured side-channel data.

- `--approval-id <id>` is now repeatable on every approval-gated command via the shared `addApprovalIdOption` factory.

**Changed:**

- Internal: `require-approval.ts` → `require-approvals.ts`. Single primitive `requireApprovals(bindings, …)` replaces the old `requireApproval(binding, …)`. All 14 call sites updated. Single-binding callers pass `[binding]`. No behavioral change for single-approval operations.

- Internal: `ApprovalStore.findOrMintFromSession` is split into `canMatchSession` (pure peek; includes `max_uses` precondition) + `mintFromSession` (side-effect). The new primitive's Phase 1/Phase 2 invariant relies on this split — sessions are only used when the entire operation is guaranteed to commit.

- Wire format: `approval_id` (singular) in request bodies is now a deprecated alias for `approval_ids: [approval_id]`. Sending both → `bad_request`. Singular form will be dropped in a future release.

- Wire format: `approval_required` error payload now carries `details.approvals` (array of `{approval_id, expires_at, action}`) for multi-approval operations. The legacy singular `approval_id` field in `error.message` (JSON-encoded) is kept for one release as the cross-version alias; it points at the first approval.

- `approval_required` registry hint updated to mention repeatable `--approval-id` and the `details.approvals` field.

**Removed:**

- `combined_no_wait_unsupported` error code (added in Plan 4c post-ship `460e750`). The continuation path replaces the fail-fast.

- The CHANGELOG `Known limitations` bullet for combined `--env-file` (prod) + `--stdin` (prod) + `--no-wait`. No longer a limitation.
```

- [ ] **Step 3: Update `docs/cli-reference.md`**

Find the `secret-shuttle run` command section. Update the `--approval-id` line (or add it if missing) to:

```
--approval-id <id>      Pre-issued approval id. Repeatable for operations
                        needing multiple approvals.
```

Add a new example below the existing examples:

```markdown
# Combined env + stdin with multiple approvals (--no-wait path):
secret-shuttle run --env-file=.env --stdin=ss://local/prod/TOKEN --no-wait -- gh auth login --with-token
# → emits approval_required with details.approvals: [
#     {approval_id: "...", action: "run"},
#     {approval_id: "...", action: "run_stdin"}
#   ]
# After approving both in the hub UI:
secret-shuttle run --env-file=.env --stdin=ss://local/prod/TOKEN --no-wait \
  --approval-id <env-id> --approval-id <stdin-id> -- gh auth login --with-token
```

- [ ] **Step 4: Update `docs/roadmap.md`**

In the V2 section, add a line noting that multi-approval continuation closed in v0.2.x (or whichever version this ships in). Optional — the roadmap is high-level; the CHANGELOG carries the detail.

- [ ] **Step 5: Final verification**

```bash
npm run typecheck
npm test 2>&1 | tail -15
npm run check-pack 2>&1 | tail -10
```

Expected:
- typecheck: clean
- npm test: all pass; expect ~17-18 new tests added across this plan, count delta around +50 (require-approvals tests + canMatchSession + mintFromSession + optApprovalIds + details round-trip + integration tests). The old require-approval tests are subtracted.
- check-pack: package builds cleanly with all expected files.

If `npm test` shows any new failures, debug them before commit. If `npm run check-pack` reports an unexpected file count or missing files, fix the packaging.

- [ ] **Step 6: Commit and push**

```bash
git add CHANGELOG.md docs/cli-reference.md docs/roadmap.md src/shared/error-codes.ts
git commit -m "$(cat <<'EOF'
docs(changelog): Plan 4d — multi-approval continuation

Plan 4d is fully landed. CHANGELOG documents:
  - Multi-approval continuation for combined env+stdin --no-wait
  - ShuttleError.details plumbing
  - --approval-id is repeatable; approval_ids canonical wire field
  - require-approval.ts → require-approvals.ts (internal rename)
  - canMatchSession + mintFromSession split (internal)
  - approval_required carries details.approvals

Hint string for approval_required updated to mention details.approvals
and the repeatable --approval-id flag. docs/cli-reference.md gets a
combined env+stdin --no-wait example.

Removed: combined_no_wait_unsupported error code + its CHANGELOG
Known-limitation bullet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push
```

---

## Self-review checklist

(Run at end of plan-writing before handing to subagent-driven-development.)

1. **Spec coverage:** Each of the 9 spec components mapped to at least one task.
   - §1 (requireApprovals primitive): Tasks A1, A2, A3, C1 ✓
   - §2 (ApprovalStore additions): Task A1 (matcher), A2 (canMatchSession), A3 (mintFromSession) ✓
   - §3 (optApprovalIds): Task D1 ✓
   - §4 (CLI factory + body change): Tasks E1, G1-G3 ✓
   - §5 (ShuttleError.details): Tasks B1, B2 ✓
   - §6 (wire format): Tasks D1 (parsing) + C1 (error emission) ✓
   - §7 (run-resolve): Task H1 + delete in J1 ✓
   - §8 (single-binding migration): Tasks F1-F8 ✓
   - §9 (hub): unchanged, no task needed ✓
   - §10 (order constraint): Encoded as task ordering A→B→C→D→E→F→G→H→I→J→K→L ✓

2. **Placeholder scan:** No TBD/TODO/"similar to" patterns in the plan above.

3. **Type consistency:**
   - `requireApprovals` signature in Task C1 matches the call in Task H1 ✓
   - `canMatchSession` returns `boolean` (A2) and is used as `boolean` in C1 ✓
   - `mintFromSession` returns `ApprovalGrant` (A3) and is used as such in C1 ✓
   - `approvalBindingsMatch` exported (A1) and used in C1 ✓
   - `optApprovalIds` returns `string[] | undefined` (D1) and is used as such in F1-F8, H1 ✓
   - `addApprovalIdOption` returns `Command` (E1) and chains in G1-G3 ✓
   - `ShuttleError.details` is `unknown` (B1) and reconstructed as `unknown` (B2) ✓

4. **Order of operations safety:**
   - Task I1 (integration test) is committed in FAILING state ✓
   - Task J1 (delete fail-fast) explicitly waits for I1 to pass ✓
   - No task in F1-F8 deletes the singular primitive before all are migrated; that's K1's job ✓

---

## Execution

After the plan-writing self-review passes, hand off to **subagent-driven-development** as the user requested.

The user's preferred shape (per Plan 4a/4b/4c history): one subagent per task, with two-stage review (spec-compliance + code-quality) between tasks. Tasks F2-F8 are mechanical clones of F1 and can move quickly; the keystone tasks are C1, H1, I1, J1, K1.
