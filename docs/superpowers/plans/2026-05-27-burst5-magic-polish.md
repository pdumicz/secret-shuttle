# Burst 5 — Magic Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven UX gaps (A–G) from the Burst 5 spec — `provision` verb + `--infer`, pre-approved-session UI affordance with strict template-param constraints, SKILL.md layered restructure, `audit --since` agent-facing summary, README/help discoverability, and `failed_partial` resume hint — without changing the security boundary. Ship as v0.3.0 to npm.

**Architecture:** Single-burst delivery in five sequential sections matching the spec's §5 sequencing: §1 (provision + bootstrap removal) → §2a (param-constraint primitive, a Plan 4a contract evolution) → §2b (approval-UI affordance, derivation, body parsing, auto-application) → §4 (audit verb + resume hint + discoverability) → §3 (SKILL.md restructure). Each section is self-contained; section boundaries are natural commit/pause points.

**Tech Stack:** TypeScript strict ESM, Node 20+, Commander 12 CLI, Node built-in test runner (`node --test`), `node:assert/strict`, existing daemon HTTP API on 127.0.0.1, existing batch executor (Plan 5g), existing hub SSE infra (Plan 4b), existing session store (Plan 4a).

**Spec reference:** [docs/superpowers/specs/2026-05-27-burst5-magic-polish-design.md](../specs/2026-05-27-burst5-magic-polish-design.md). Every implementation decision in this plan flows from the spec; when a step seems unclear, read the linked spec section.

---

## Code-Grounding Corrections (read first)

This plan went through two review rounds against the actual codebase. The following API facts override anything the spec or earlier plan drafts implied:

- **Error-code registry shape** (`src/shared/error-codes.ts:9`) is `{ exitCode, hint(message), nextAction?(message) }`. **Messages live in `new ShuttleError("code", "msg")` call sites — NOT in the registry entry.** Constants `EXIT_CODE_USAGE`, `EXIT_CODE_NOT_FOUND`, `EXIT_CODE_CONFLICT` are exported from the same file.
- **Bootstrap route payloads** (`src/daemon/api/routes/bootstrap.ts`): `POST /v1/bootstrap/plan` takes `{ plan_yml, force?, environment? }` (NOT `{ yml }`). The list endpoint is `GET /v1/bootstrap/list` (NOT `/v1/bootstrap/batches`).
- **CLI error path** (`src/cli/index.ts:62`): commands **throw**; the top-level catch writes JSON to **stderr** and sets `process.exitCode`. Do NOT call `outputJson(errorToJson(err))` + `process.exit()` in command actions — that bypasses stderr conventions and deprecation-warning handling.
- **`registerUiRoutes` signature** (`src/daemon/approvals/ui-server.ts:14`) is `(server, store: ApprovalStore)`. To mint sessions from the approve route this burst expands it to take `{ approvals, sessions, bootstrap }` (Task 2b.4). The caller in `src/daemon/api/router.ts:36` updates accordingly.
- **Bootstrap batch_id on `ApprovalGrant`**: lives at `grant.template_params.batch_id` (set by `src/daemon/api/routes/bootstrap.ts:107`), NOT `grant.batch_id`.
- **`SessionStore.revoke(id)`** is the method to flip a session to `revoked` status (`src/daemon/approvals/session-store.ts:69`). There is **no `delete` method**.
- **Session fields**: `uses: number` (incremented on consume) and `max_uses?: number` (optional cap, 1..1000). There is no `uses_remaining`. The max-uses check is `s.max_uses === undefined || s.uses < s.max_uses`.
- **`requireApprovals` option names** (`src/daemon/approvals/require-approvals.ts:12`): `approvalIdsFromClient` (NOT `approval_ids`), `sessionId` (NOT `session_id`), `sessionStore`. The function already implements a two-phase plan/commit architecture — auto-match is a new Phase-1 sub-case that emits `{ kind: "session", binding, sessionId }`, reusing Phase-2's existing session-commit primitive.
- **Session matcher entry point**: `matchesSessionPattern(binding, pattern)` at `src/daemon/approvals/session-matchers.ts:5` — single exported function that dispatches on action. The internal helpers (`templateRunMatches` etc.) are NOT exported. `ApprovalBinding.action` is stored as `"template"` and canonicalized to `"template-run"` by `canonicalAction()`.
- **Template registry**: `TemplateRegistry` class with private `map` and `list()` method (`src/daemon/templates/registry.ts:37`). No module-level `TEMPLATES` constant. Helpers like `validateDestinationDefiningParamsCoverage` take a `TemplateRegistry` instance.
- **`server.addRoute` body**: handlers receive ALREADY-PARSED JSON via `readJsonBody` (see `src/daemon/server.ts:223`). Use `asObject(raw)` + `reqString` / `optString` / `optBool` from `src/daemon/api/validate.ts`, matching the pattern in `bootstrap.ts:31`. **Do not call `JSON.parse(raw)`**.

When a step's code snippet appears to disagree with these facts, the facts win — adjust the snippet inline before applying.

---

## Conventions

- All imports use `.js` extensions even for TypeScript files (ESM requirement).
- All tests use `import { test } from "node:test"` and `import assert from "node:assert/strict"`.
- Test files live alongside their source: `src/foo/bar.ts` → `src/foo/bar.test.ts`.
- Build before testing: `npm run build` then `npm test` (the npm test script runs the build first).
- Commit after every green test pass. Use Conventional Commits format (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Never commit secrets or `.env` files.

---

## File Structure

### §1 — `provision` verb + `--infer` + bootstrap removal

**Create:**
- `src/cli/commands/provision.ts` — main verb dispatch
- `src/cli/provision/infer-rules.ts` — name → source kind table
- `src/cli/provision/infer-gate.ts` — `isInferYmlExecutable` pure function
- `src/cli/provision/infer.ts` — `--infer` mode handler (reads project files, applies rules, generates yml)
- `src/cli/commands/provision.test.ts`
- `src/cli/provision/infer-rules.test.ts`
- `src/cli/provision/infer-gate.test.ts`
- `src/cli/provision/infer.test.ts`

**Delete:**
- `src/cli/commands/bootstrap.ts`
- `src/cli/commands/bootstrap.test.ts` (rename + repurpose contents to `provision.test.ts` where applicable)
- `src/cli/commands/list.ts`, `list.test.ts`
- `src/cli/commands/inspect.ts`, `inspect.test.ts`
- `src/cli/commands/generate.ts`, `generate.test.ts`
- `src/cli/commands/doctor.ts`, `doctor.test.ts`

**Modify:**
- `src/cli/index.ts` — replace `bootstrapCommand`, `listCommand`, `inspectCommand`, `generateCommand`, `doctorCommand` registrations with `provisionCommand`. Add stub for `bootstrap` → `command_renamed` error.
- `src/shared/error-codes.ts` — register `command_renamed`, `infer_no_env_example`, `infer_yml_exists`, `provision_mode_conflict`, `provision_no_mode`, `session_ttl_exceeds_cap`.

### §2a — Param-constraint primitive (Plan 4a evolution)

**Create:**
- `src/daemon/templates/destination-defining-params.ts` — config map + startup validation hook
- `src/daemon/templates/destination-defining-params.test.ts`
- `src/daemon/approvals/session-pattern-required-params-validator.test.ts`

**Modify:**
- `src/daemon/approvals/session.ts` — add `required_params?: Record<string, string>` to `SessionPattern`; extend `assertSessionPatternValid` with the new field's validation rules; raise `TTL_MAX_MS` from `15 * 60 * 1000` to `60 * 60 * 1000`; replace the `bad_request` throw on TTL overflow with `session_ttl_exceeds_cap`.
- `src/daemon/approvals/session-matchers.ts` — extend the template-run matcher with `required_params` strict-equal check.
- `src/daemon/approvals/session-matchers.test.ts` — add coverage for new clause.
- `src/daemon/api/routes/approvals-session.ts` — whitelist `required_params` in `parseSessionPatternFromBody`.
- `src/daemon/api/routes/approvals-session.test.ts` — coverage.
- `src/daemon/approvals/session-ui-server.ts` — add `required_params` to `safePattern`.
- `src/daemon/approvals/session-ui.html` — render `required_params` lines if present.
- `src/daemon/approvals/session-ui-html-drift.test.ts` — assert the rendering element exists.
- `src/cli/commands/internal-session.ts` — add repeatable `--required-param k=v` flag to `create`.
- `src/cli/commands/internal-session.test.ts` — coverage.
- `src/daemon/templates/registry.ts` — add a one-time startup hook that calls `validateDestinationDefiningParamsCoverage()` from the new file and logs warnings.

### §2b — Approval-UI session affordance

**Create:**
- `src/daemon/helpers/bounded-json.ts` — relocated `readBoundedJson` helper with `allowEmpty` option
- `src/daemon/helpers/bounded-json.test.ts`
- `src/daemon/approvals/infer-session-pattern.ts` — pure function: `BatchState.plan` + `DESTINATION_DEFINING_PARAMS` → `{ patterns, excluded }`
- `src/daemon/approvals/infer-session-pattern.test.ts`
- `src/daemon/approvals/session-store-create-for-owner.test.ts`
- `src/daemon/approvals/approval-ui-creates-sessions.test.ts`
- `src/daemon/approvals/approval-ui-session-affordance.test.ts` (HTML drift guard)
- `src/daemon/approvals/require-approvals-auto-match.test.ts`
- `src/cli/commands/status-active-sessions.test.ts`

**Modify:**
- `src/daemon/hub/hub-server.ts` — replace local `readBoundedJson` definition with import from new helper location.
- `src/daemon/approvals/session-store.ts` — add `createForOwner(pattern, owner_agent_id)` method that bypasses `getCurrentAgentId()`.
- `src/daemon/approvals/ui-server.ts` — on POST `/ui/approvals/:id/approve`, read body via `readBoundedJson(req, 1024, { allowEmpty: true })`; when `body.session` is present, derive patterns from the batch's `BatchState.plan`, call `sessionStore.createForOwner` once per pattern, all-or-nothing rollback.
- `src/daemon/approvals/ui.html` — add the session-affordance footer block (default-unchecked checkbox + TTL dropdown + rendered pattern list).
- `src/daemon/approvals/ui-html-drift.test.ts` — extend with affordance assertions.
- `src/daemon/approvals/require-approvals.ts` — when no `approval_id` AND no `session_id` is supplied, perform auto-match lookup; pick most-recently-approved candidate; race-retry once on max_uses exhaustion.
- `src/daemon/api/routes/status.ts` — add `active_sessions[]` field; owner-scoped.
- `src/cli/commands/status.ts` — surface `active_sessions` in text mode.

### §4 — Audit + resume hint + discoverability

**Create:**
- `src/cli/commands/audit.ts`
- `src/cli/commands/audit.test.ts`
- `src/daemon/api/routes/audit-summary.ts`
- `src/daemon/api/routes/audit-summary.test.ts`
- `src/daemon/audit-fields-bootstrap-step.test.ts`
- `src/daemon/audit-fields-template-run-batch-id.test.ts`
- `src/daemon/audit-fields-backwards-compat.test.ts`
- `src/daemon/bootstrap/provision-resume-hint.test.ts`

**Modify:**
- `src/daemon/audit.ts` — add optional fields: `batch_id?: string`, `source_kind?: string`, `destination_shorthands?: string[]`, `destinations_ok_count?: number`, `destinations_failed_count?: number`.
- `src/daemon/bootstrap/executor.ts` — populate the new audit fields on every `bootstrap_step` row; forward `batch_id` to inner cores via context; on `state.status === "failed_partial"`, include `next_action: "secret-shuttle provision --continue --batch <id>"` in the final response.
- All inner core call sites that write `template_run` audit rows under `bootstrapAuthority` — forward `batch_id` from the authority context.
- `src/cli/index.ts` — register `auditCommand()`; update help text with "AGENT QUICKSTART" line.
- `README.md` — add the agent callout block at top.
- `skills/secret-shuttle/SKILL.md` — minor: add a new error-code row for resume hint (G); the full restructure lands in §3.

### §3 — SKILL.md restructure + drift guard

**Modify:**
- `skills/secret-shuttle/SKILL.md` — restructure into layered format (≤60 lines above `---`, reference below).
- `README.md` — verify agent callout still references the new SKILL.md sections accurately.

**Create:**
- `src/cli/commands/skill-md-shape.test.ts` — drift guard asserting top-half line count, presence of `provision` (not `bootstrap`), required error-table rows.

### Other

- `package.json` — bump version to `0.3.0` (last task before publish).
- `CHANGELOG.md` — Burst 5 entry summarizing every section.

---

## §1 — `provision` verb + `--infer` (Days 1–3)

### Task 1.1: Register new error codes

**Files:**
- Modify: `src/shared/error-codes.ts`

- [ ] **Step 1: Read current error-codes file to find the registration block**

Run: `grep -n "register\|export const" src/shared/error-codes.ts | head -20`

- [ ] **Step 2: Add the 6 new codes — matching the real registry shape**

The registry shape (`ErrorCodeEntry` at `src/shared/error-codes.ts:9`) is:
```ts
{ exitCode: number; hint: (message: string) => string | null; nextAction?: (message: string) => string | null }
```
**Messages live in `new ShuttleError("code", "the message")` at call sites — NOT in the registry entry.** Constants `EXIT_CODE_USAGE`, `EXIT_CODE_NOT_FOUND`, `EXIT_CODE_CONFLICT` are exported from the same file (lines 1–7).

Add inside the `REGISTRY` constant, preserving the existing grouping comments (Transient / Usage / Not-found / Permission / Conflict):

```ts
// ── Usage (exit 2) ───────────────────────────────────────────────────────────
command_renamed: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => null,
  // No nextAction — the message itself names the replacement verb.
},
provision_mode_conflict: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Pass exactly one of: --infer, --yml, --secret, --continue, --list, --abandon.",
},
provision_no_mode: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Pass --infer, --yml, --secret, --continue, --list, or --abandon.",
},
session_ttl_exceeds_cap: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Reduce ttl_minutes (max 60).",
},
// ── Not-found (exit 3) ───────────────────────────────────────────────────────
infer_no_env_example: {
  exitCode: EXIT_CODE_NOT_FOUND,
  hint: () => "Create a .env.example listing your secret names, then re-run.",
},
// ── Conflict (exit 5) ────────────────────────────────────────────────────────
infer_yml_exists: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "Re-run with --force to overwrite, or --dry-run to stdout only.",
  nextAction: () => "secret-shuttle provision --infer --force",
},
```

Throw-sites use the constructor for the human-readable message:
```ts
throw new ShuttleError(
  "infer_no_env_example",
  "No .env.example found in current directory. Create one listing your secret names then re-run `secret-shuttle provision --infer`.",
);
```

- [ ] **Step 3: Build and typecheck**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/error-codes.ts
git commit -m "feat(error-codes): register Burst 5 codes (command_renamed, infer_*, provision_*, session_ttl_exceeds_cap)"
```

---

### Task 1.2: Write inference rule table (TDD)

**Files:**
- Create: `src/cli/provision/infer-rules.ts`
- Create: `src/cli/provision/infer-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/provision/infer-rules.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSourceForName, type InferredSource } from "./infer-rules.js";

test("STRIPE_WEBHOOK_SECRET → capture from /webhooks", () => {
  const result = inferSourceForName("STRIPE_WEBHOOK_SECRET");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://dashboard.stripe.com/webhooks",
  });
});

test("STRIPE_SECRET_KEY → capture from /apikeys (non-webhook stripe)", () => {
  const result = inferSourceForName("STRIPE_SECRET_KEY");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://dashboard.stripe.com/apikeys",
  });
});

test("SUPABASE_SERVICE_ROLE → capture from supabase api page", () => {
  const result = inferSourceForName("SUPABASE_SERVICE_ROLE");
  assert.deepEqual(result, {
    kind: "capture",
    url: "https://supabase.com/dashboard/project/_/settings/api",
  });
});

test("OPENAI_API_KEY → capture from platform.openai", () => {
  assert.deepEqual(inferSourceForName("OPENAI_API_KEY"), {
    kind: "capture",
    url: "https://platform.openai.com/api-keys",
  });
});

test("ANTHROPIC_API_KEY → capture from anthropic console", () => {
  assert.deepEqual(inferSourceForName("ANTHROPIC_API_KEY"), {
    kind: "capture",
    url: "https://console.anthropic.com/settings/keys",
  });
});

test("CLERK_PUBLISHABLE_KEY → capture from clerk dashboard", () => {
  assert.deepEqual(inferSourceForName("CLERK_PUBLISHABLE_KEY"), {
    kind: "capture",
    url: "https://dashboard.clerk.com",
  });
});

test("INTERNAL_CRON_SECRET → random_32_bytes (no provider prefix, ends with _SECRET)", () => {
  assert.deepEqual(inferSourceForName("INTERNAL_CRON_SECRET"), { kind: "random_32_bytes" });
});

test("API_TOKEN → random_32_bytes (no provider prefix, ends with _TOKEN)", () => {
  assert.deepEqual(inferSourceForName("API_TOKEN"), { kind: "random_32_bytes" });
});

test("DATABASE_URL → existing placeholder", () => {
  assert.deepEqual(inferSourceForName("DATABASE_URL"), {
    kind: "existing",
    placeholder: true,
  });
});

test("POSTGRES_URL / MYSQL_URL → existing placeholder", () => {
  assert.deepEqual(inferSourceForName("POSTGRES_URL"), { kind: "existing", placeholder: true });
  assert.deepEqual(inferSourceForName("MYSQL_URL"), { kind: "existing", placeholder: true });
});

test("CUSTOM_FEATURE_FLAG_KEY → unknown (no rule matches)", () => {
  assert.deepEqual(inferSourceForName("CUSTOM_FEATURE_FLAG_KEY"), { kind: "unknown" });
});

test("case-insensitive matching", () => {
  assert.deepEqual(inferSourceForName("stripe_secret_key"), {
    kind: "capture",
    url: "https://dashboard.stripe.com/apikeys",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails with "cannot find module './infer-rules.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/provision/infer-rules.ts`:
```ts
/**
 * Maps secret env-var names to a guessed source kind for `provision --infer`.
 *
 * Rules are evaluated in order; the first match wins. Rule matching is
 * case-insensitive. The fallback `{ kind: "unknown" }` indicates the user
 * must edit the generated yml before --continue.
 *
 * See spec §1 for the rule table and rationale.
 */

export type InferredSource =
  | { kind: "capture"; url: string }
  | { kind: "random_32_bytes" }
  | { kind: "random_64_bytes" }
  | { kind: "existing"; placeholder: boolean }
  | { kind: "unknown" };

interface Rule {
  test: (upperName: string) => boolean;
  source: InferredSource;
}

const RULES: readonly Rule[] = [
  // Order matters: webhook variant before generic stripe.
  {
    test: (n) => n.startsWith("STRIPE_") && n.includes("WEBHOOK"),
    source: { kind: "capture", url: "https://dashboard.stripe.com/webhooks" },
  },
  {
    test: (n) => n.startsWith("STRIPE_"),
    source: { kind: "capture", url: "https://dashboard.stripe.com/apikeys" },
  },
  {
    test: (n) => n.startsWith("SUPABASE_"),
    source: { kind: "capture", url: "https://supabase.com/dashboard/project/_/settings/api" },
  },
  {
    test: (n) => n === "OPENAI_API_KEY",
    source: { kind: "capture", url: "https://platform.openai.com/api-keys" },
  },
  {
    test: (n) => n === "ANTHROPIC_API_KEY",
    source: { kind: "capture", url: "https://console.anthropic.com/settings/keys" },
  },
  {
    test: (n) => n.startsWith("CLERK_"),
    source: { kind: "capture", url: "https://dashboard.clerk.com" },
  },
  {
    test: (n) => /^(DATABASE|POSTGRES|MYSQL)_URL$/.test(n),
    source: { kind: "existing", placeholder: true },
  },
  // Generic random fallback: any *_SECRET or *_TOKEN with no provider prefix.
  // Provider-prefixed names that didn't match a specific rule above fall
  // through to "unknown" (safer than auto-randoming a known-provider name).
  {
    test: (n) => /(SECRET|TOKEN)$/.test(n) && !/^(STRIPE|SUPABASE|OPENAI|ANTHROPIC|CLERK)_/.test(n),
    source: { kind: "random_32_bytes" },
  },
];

export function inferSourceForName(name: string): InferredSource {
  const upper = name.toUpperCase();
  for (const rule of RULES) {
    if (rule.test(upper)) return rule.source;
  }
  return { kind: "unknown" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern infer-rules`
Expected: all 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/provision/infer-rules.ts src/cli/provision/infer-rules.test.ts
git commit -m "feat(provision): inference rule table for --infer (8 rules + unknown fallback)"
```

---

### Task 1.3: Write executability gate (TDD)

**Files:**
- Create: `src/cli/provision/infer-gate.ts`
- Create: `src/cli/provision/infer-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/provision/infer-gate.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInferYmlExecutable, type InferredPlanEntry } from "./infer-gate.js";

const ok = (overrides: Partial<InferredPlanEntry> = {}): InferredPlanEntry => ({
  secret: "STRIPE_KEY",
  ref: "ss://stripe/prod/STRIPE_KEY",
  source: { kind: "random_32_bytes" },
  destinations: ["vercel:production"],
  ...overrides,
});

test("fully executable plan → ok: true, no issues", () => {
  const r = isInferYmlExecutable([ok()]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test("source.kind=unknown → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "unknown" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.secret === "STRIPE_KEY" && i.issue.includes("unknown")));
});

test("capture source with missing url → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture" } as any })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("capture") && i.issue.includes("url")));
});

test("capture source with non-https url → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture", url: "http://insecure.example" } })]);
  assert.equal(r.ok, false);
});

test("existing source with placeholder=true → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "existing", placeholder: true, ref: "ss://x/y/Z" } as any })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("placeholder")));
});

test("existing source with real ref → executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "existing", placeholder: false, ref: "ss://local/prod/REAL" } as any })]);
  assert.equal(r.ok, true);
});

test("empty destinations → not executable", () => {
  const r = isInferYmlExecutable([ok({ destinations: [] })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.toLowerCase().includes("destination")));
});

test("destination shorthand with OWNER/REPO placeholder → not executable", () => {
  const r = isInferYmlExecutable([ok({ destinations: ["github-actions:OWNER/REPO"] })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("OWNER/REPO")));
});

test("multiple entries, mixed: collects all issues", () => {
  const r = isInferYmlExecutable([
    ok(),
    ok({ secret: "X", source: { kind: "unknown" } }),
    ok({ secret: "Y", destinations: [] }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 2);
  assert.equal(r.issues[0].secret, "X");
  assert.equal(r.issues[1].secret, "Y");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails with "cannot find module './infer-gate.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/provision/infer-gate.ts`:
```ts
/**
 * Pure function: determines whether a generated `--infer` plan is
 * fully executable (every entry has a non-unknown source, valid url
 * for capture, real ref for existing, non-empty destinations, no
 * literal OWNER/REPO placeholders).
 *
 * Non-executable plans result in `needs_edit: true` from the
 * `provision --infer` command — the file is written but no batch is
 * minted. See spec §1 "Executability gate".
 */

export interface InferredPlanEntry {
  secret: string;
  ref: string;
  source:
    | { kind: "capture"; url?: string }
    | { kind: "random_32_bytes" }
    | { kind: "random_64_bytes" }
    | { kind: "existing"; placeholder: boolean; ref?: string }
    | { kind: "unknown" };
  destinations: string[];
}

export interface InferGateIssue {
  secret: string;
  issue: string;
}

export interface InferGateResult {
  ok: boolean;
  issues: InferGateIssue[];
}

const PLACEHOLDER_DEST = "OWNER/REPO";

export function isInferYmlExecutable(entries: InferredPlanEntry[]): InferGateResult {
  const issues: InferGateIssue[] = [];

  for (const e of entries) {
    if (e.source.kind === "unknown") {
      issues.push({ secret: e.secret, issue: "source: unknown — pick a kind (capture, random_32_bytes, existing)" });
      continue;
    }
    if (e.source.kind === "capture") {
      if (typeof e.source.url !== "string" || e.source.url.length === 0) {
        issues.push({ secret: e.secret, issue: "capture source missing required url" });
        continue;
      }
      if (!e.source.url.startsWith("https://")) {
        issues.push({ secret: e.secret, issue: `capture url must be https (got ${e.source.url})` });
        continue;
      }
    }
    if (e.source.kind === "existing") {
      if (e.source.placeholder === true) {
        issues.push({
          secret: e.secret,
          issue: "existing source has placeholder ref — supply a real ss:// ref or change source kind",
        });
        continue;
      }
    }
    if (!Array.isArray(e.destinations) || e.destinations.length === 0) {
      issues.push({ secret: e.secret, issue: "destinations is empty — add at least one" });
      continue;
    }
    if (e.destinations.some((d) => d.includes(PLACEHOLDER_DEST))) {
      issues.push({ secret: e.secret, issue: `destination contains placeholder OWNER/REPO — fill in real owner/repo` });
      continue;
    }
  }

  return { ok: issues.length === 0, issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern infer-gate`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/provision/infer-gate.ts src/cli/provision/infer-gate.test.ts
git commit -m "feat(provision): isInferYmlExecutable gate — detects unknown/placeholder/empty-destinations"
```

---

### Task 1.4: Write `--infer` mode handler (TDD)

**Files:**
- Create: `src/cli/provision/infer.ts`
- Create: `src/cli/provision/infer.test.ts`

The infer handler:
1. Reads `.env.example` (lines like `KEY=value` or `KEY=`); errors with `infer_no_env_example` if missing.
2. Detects framework signals: `vercel.json` (file exists), `wrangler.toml` (file exists), `.github/workflows/` (dir exists with `git config --get remote.origin.url` for owner/repo).
3. For each env var name, calls `inferSourceForName` from Task 1.2.
4. Composes destinations from detected frameworks.
5. Builds the inferred plan; calls `isInferYmlExecutable` from Task 1.3.
6. Renders yml text (with header comment + TODOs as needed).

- [ ] **Step 1: Write the failing test**

Create `src/cli/provision/infer.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInfer } from "./infer.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-infer-test-"));
}

test("missing .env.example → infer_no_env_example", async () => {
  const dir = await setupTmp();
  try {
    await assert.rejects(
      runInfer({ cwd: dir }),
      (err: any) => err.error_code === "infer_no_env_example",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with one Stripe key + vercel.json → executable plan", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "STRIPE_SECRET_KEY=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, true);
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /kind: capture/);
    assert.match(r.yml, /dashboard\.stripe\.com\/apikeys/);
    assert.match(r.yml, /vercel:production/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with unknown name → not executable, issues listed", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, false);
    assert.ok(r.issues.some((i) => i.secret === "MY_CUSTOM_FLAG"));
    assert.match(r.yml, /kind: unknown/);
    assert.match(r.yml, /TODO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no framework files → empty destinations + TODO", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "INTERNAL_TOKEN=\n");
    const r = await runInfer({ cwd: dir });
    assert.equal(r.executable, false);
    assert.match(r.yml, /destinations: \[\]/);
    assert.match(r.yml, /TODO: add at least one destination/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(".github/workflows + no git remote → github-actions:OWNER/REPO placeholder + TODO", async () => {
  const dir = await setupTmp();
  try {
    await writeFile(join(dir, ".env.example"), "STRIPE_KEY=\n");
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    const r = await runInfer({ cwd: dir });
    // Plan should include github-actions destination with placeholder
    assert.match(r.yml, /github-actions:OWNER\/REPO/);
    assert.equal(r.executable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env.example with comment lines and blank lines parses correctly", async () => {
  const dir = await setupTmp();
  try {
    const content = [
      "# Stripe",
      "STRIPE_SECRET_KEY=",
      "",
      "# Internal",
      "INTERNAL_CRON_SECRET=",
    ].join("\n");
    await writeFile(join(dir, ".env.example"), content);
    await writeFile(join(dir, "vercel.json"), "{}");
    const r = await runInfer({ cwd: dir });
    assert.match(r.yml, /STRIPE_SECRET_KEY/);
    assert.match(r.yml, /INTERNAL_CRON_SECRET/);
    // Two entries
    assert.equal((r.yml.match(/^  [A-Z]/gm) || []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails on missing `./infer.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/provision/infer.ts`:
```ts
/**
 * `provision --infer` handler. Reads .env.example + framework signals,
 * applies the rule table, returns the rendered yml + executability flag.
 *
 * Pure function (mostly) — only reads files from the supplied `cwd`,
 * never writes. The caller (provision command) decides whether to
 * write the file based on `--dry-run` / `--force` flags.
 *
 * See spec §1 "Inference mode (Item A)".
 */
import { readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ShuttleError } from "../../shared/errors.js";
import { inferSourceForName, type InferredSource } from "./infer-rules.js";
import { isInferYmlExecutable, type InferredPlanEntry, type InferGateIssue } from "./infer-gate.js";

const execp = promisify(exec);

export interface InferOptions {
  cwd: string;
}

export interface InferResult {
  yml: string;
  executable: boolean;
  issues: InferGateIssue[];
  plan: InferredPlanEntry[];
}

export async function runInfer(opts: InferOptions): Promise<InferResult> {
  const envExamplePath = join(opts.cwd, ".env.example");
  let envContent: string;
  try {
    envContent = await readFile(envExamplePath, "utf8");
  } catch {
    throw new ShuttleError(
      "infer_no_env_example",
      "No .env.example found in current directory. Create one listing your secret names then re-run `secret-shuttle provision --infer`.",
    );
  }

  const names = parseEnvExampleNames(envContent);
  const destinations = await detectDestinations(opts.cwd);

  const entries: InferredPlanEntry[] = names.map((name) => {
    const source = inferSourceForName(name);
    return {
      secret: name,
      ref: refFor(name, source),
      source: source as InferredPlanEntry["source"], // existing source pushes placeholder
      destinations: destinations.length > 0 ? [...destinations] : [],
    };
  });

  const gate = isInferYmlExecutable(entries);
  const yml = renderYml(entries, destinations.length === 0);

  return {
    yml,
    executable: gate.ok,
    issues: gate.issues,
    plan: entries,
  };
}

function parseEnvExampleNames(content: string): string[] {
  const names: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }
  return names;
}

async function detectDestinations(cwd: string): Promise<string[]> {
  const out: string[] = [];
  if (await fileExists(join(cwd, "vercel.json"))) {
    out.push("vercel:production");
  }
  if (await fileExists(join(cwd, "wrangler.toml"))) {
    out.push("cloudflare:production");
  }
  if (await dirExists(join(cwd, ".github/workflows"))) {
    const repo = await detectGitOwnerRepo(cwd);
    out.push(repo ? `github-actions:${repo}` : "github-actions:OWNER/REPO");
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function detectGitOwnerRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execp("git config --get remote.origin.url", { cwd, encoding: "utf8" });
    const url = stdout.trim();
    // Match git@github.com:owner/repo.git OR https://github.com/owner/repo(.git)?
    const m = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

function refFor(name: string, source: InferredSource): string {
  if (source.kind === "existing") {
    return `ss://local/prod/${name}`;
  }
  // Convention: vault refs use lower-case provider; "stripe", "supabase", "openai", etc.
  // For random/capture we still pick a reasonable namespace.
  if (source.kind === "capture" && typeof source.url === "string") {
    const host = new URL(source.url).host;
    const providerHint = host.split(".").slice(-2, -1)[0] ?? "local";
    return `ss://${providerHint}/prod/${name}`;
  }
  return `ss://local/prod/${name}`;
}

function renderYml(entries: InferredPlanEntry[], destsEmpty: boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Generated by \`secret-shuttle provision --infer\` on ${today}.`,
    `# Review every line. Anything marked TODO must be filled in before --continue.`,
    `version: 1`,
    `secrets:`,
  ];

  for (const e of entries) {
    lines.push(`  ${e.secret}:`);
    // source
    if (e.source.kind === "unknown") {
      lines.push(`    source: { kind: unknown }  # TODO: change to capture/random_32_bytes/existing`);
    } else if (e.source.kind === "capture") {
      const url = (e.source as any).url;
      if (url) {
        lines.push(`    source: { kind: capture, url: "${url}" }`);
      } else {
        lines.push(`    source: { kind: capture, url: null }  # TODO: set capture URL`);
      }
    } else if (e.source.kind === "existing") {
      const placeholder = (e.source as any).placeholder === true;
      const ref = (e.source as any).ref ?? e.ref;
      if (placeholder) {
        lines.push(`    source: { kind: existing, ref: "${ref}" }  # TODO: fill in real ref or change kind`);
      } else {
        lines.push(`    source: { kind: existing, ref: "${ref}" }`);
      }
    } else {
      // random_32_bytes / random_64_bytes
      lines.push(`    source: { kind: ${e.source.kind} }`);
    }
    // destinations
    if (e.destinations.length === 0) {
      lines.push(`    destinations: []           # TODO: add at least one destination`);
    } else {
      lines.push(`    destinations:`);
      for (const d of e.destinations) {
        if (d.includes("OWNER/REPO")) {
          lines.push(`      - ${d}  # TODO: replace OWNER/REPO with the real github owner/repo`);
        } else {
          lines.push(`      - ${d}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "infer"` (this also runs infer-rules + infer-gate, all should pass).
Expected: all infer tests pass (~ 27 total).

- [ ] **Step 5: Commit**

```bash
git add src/cli/provision/infer.ts src/cli/provision/infer.test.ts
git commit -m "feat(provision): --infer handler reads .env.example + framework signals → rendered yml"
```

---

### Task 1.5: Write `provision` command shell (mode dispatch + flag validation)

**Files:**
- Create: `src/cli/commands/provision.ts`
- Create: `src/cli/commands/provision.test.ts`

The provision command:
1. Registers commander flags for every mode + parameter.
2. Validates that exactly one mode flag is supplied (or defaults to `--yml ./secret-shuttle.yml` if it exists).
3. Dispatches to the appropriate handler.
4. For `--infer`: calls `runInfer`, writes file (unless `--dry-run`), checks gate, mints batch only if executable.

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/provision.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionCommand } from "./provision.js";

test("provisionCommand returns a Command named 'provision'", () => {
  const cmd = provisionCommand();
  assert.equal(cmd.name(), "provision");
});

test("provisionCommand has the expected mode flags", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--infer", "--yml", "--secret", "--continue", "--list", "--abandon", "--dry-run", "--force"]) {
    assert.ok(opts.includes(flag), `expected flag ${flag} in provision options, got: ${opts.join(", ")}`);
  }
});

test("provisionCommand has --from, --url, --ref, --to, --approval-id, --batch", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--from", "--url", "--ref", "--to", "--approval-id", "--batch"]) {
    assert.ok(opts.includes(flag), `expected ${flag}, got: ${opts.join(", ")}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails on missing `./provision.js`.

- [ ] **Step 3: Write the command shell**

Create `src/cli/commands/provision.ts`:
```ts
/**
 * `secret-shuttle provision` — unified verb for "make secrets exist in
 * vault + destinations." Replaces the removed `bootstrap` verb and
 * absorbs the un-built `provision` shortcut idea.
 *
 * Mode flags are mutually exclusive: --infer, --yml, --secret,
 * --continue, --list, --abandon. The dispatch lives in a single
 * function that validates flag conflicts and routes to the right
 * handler.
 *
 * See spec §1.
 */
import { Command } from "commander";
import { writeFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { ShuttleError, errorToJson } from "../../shared/errors.js";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { runInfer } from "../provision/infer.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

type Mode = "infer" | "yml" | "secret" | "continue" | "list" | "abandon";

interface ProvisionOpts {
  infer?: boolean;
  yml?: string;
  secret?: string;
  continue?: boolean;
  list?: boolean;
  abandon?: boolean;
  dryRun?: boolean;
  force?: boolean;
  from?: string;
  url?: string;
  ref?: string;
  to?: string;
  batch?: string;
  approvalId?: string[];
}

export function provisionCommand(): Command {
  const cmd = new Command("provision")
    .description("Provision a project's secrets in one approval (replaces the removed `bootstrap` verb).")
    // Mode selectors:
    .option("--infer", "Generate a yml from .env.example + framework signals (default for new projects)")
    .option("--yml <file>", "Read an existing secret-shuttle.yml")
    .option("--secret <NAME>", "Single-secret inline (requires --from + --to)")
    .option("--continue", "Resume an approved batch (requires --batch + --approval-id)")
    .option("--list", "List in-flight batches")
    .option("--abandon", "Abandon a batch (requires --batch)")
    // Parameters:
    .option("--from <kind>", "Source kind: capture, random_32_bytes, random_64_bytes, existing")
    .option("--url <url>", "Capture URL (required when --from=capture)")
    .option("--ref <ss://...>", "Existing ref (required when --from=existing)")
    .option("--to <dest[,dest...]>", "Comma-separated destination shorthands")
    .option("--batch <id>", "Batch id (with --continue or --abandon)")
    .option("--dry-run", "Print planned yml to stdout, no file write, no batch (--infer only)")
    .option("--force", "Overwrite existing yml (--infer only)");
  addApprovalIdOption(cmd);
  cmd.action(async (raw: ProvisionOpts) => {
    // Follow project convention: commands throw; src/cli/index.ts:62 catches
    // ShuttleError, writes JSON to stderr, sets process.exitCode. Do NOT
    // outputJson+process.exit here — that path bypasses the top-level
    // deprecation-warning attachment and writes to stdout instead of stderr.
    const mode = resolveMode(raw);
    await dispatch(mode, raw);
  });
  return cmd;
}

function resolveMode(opts: ProvisionOpts): Mode {
  const selectors: Array<{ flag: string; on: boolean }> = [
    { flag: "--infer", on: !!opts.infer },
    { flag: "--yml", on: !!opts.yml },
    { flag: "--secret", on: !!opts.secret },
    { flag: "--continue", on: !!opts.continue },
    { flag: "--list", on: !!opts.list },
    { flag: "--abandon", on: !!opts.abandon },
  ];
  const active = selectors.filter((s) => s.on).map((s) => s.flag);

  if (active.length > 1) {
    throw new ShuttleError(
      "provision_mode_conflict",
      `Conflicting mode flags: ${active.join(", ")}. Pass exactly one.`,
    );
  }
  if (opts.dryRun && !opts.infer && !active.includes("--infer")) {
    throw new ShuttleError("provision_mode_conflict", "--dry-run is only valid with --infer.");
  }
  if (active.length === 0) {
    // Default: --yml ./secret-shuttle.yml if file exists
    return "yml-default-or-no-mode" as Mode; // resolved in dispatch
  }
  return active[0].replace(/^--/, "") as Mode;
}

async function dispatch(mode: Mode | "yml-default-or-no-mode", opts: ProvisionOpts): Promise<void> {
  if (mode === "yml-default-or-no-mode") {
    // ENOENT check ONLY — don't let later daemon-side errors get remapped to
    // provision_no_mode. The outer try would otherwise swallow a real
    // daemon_not_running or vault_locked from runYmlMode.
    let hasYml = false;
    try {
      await access("./secret-shuttle.yml");
      hasYml = true;
    } catch {
      // missing file → fall through
    }
    if (!hasYml) {
      throw new ShuttleError(
        "provision_no_mode",
        "No mode flag and no ./secret-shuttle.yml to default to. Pass --infer, --yml, --secret, --continue, --list, or --abandon.",
      );
    }
    return runYmlMode("./secret-shuttle.yml", opts);
  }

  switch (mode) {
    case "infer": return runInferMode(opts);
    case "yml": return runYmlMode(opts.yml!, opts);
    case "secret": return runSecretMode(opts);
    case "continue": return runContinueMode(opts);
    case "list": return runListMode();
    case "abandon": return runAbandonMode(opts);
    default:
      throw new ShuttleError("bad_request", `Unhandled provision mode: ${mode}`);
  }
}

// Implementations:

async function runInferMode(opts: ProvisionOpts): Promise<void> {
  const result = await runInfer({ cwd: process.cwd() });

  if (opts.dryRun) {
    outputJson(ok({ mode: "dry_run", yml: result.yml, executable: result.executable, issues: result.issues }));
    return;
  }

  const ymlPath = "./secret-shuttle.yml";
  const exists = await fileExists(ymlPath);
  if (exists && !opts.force) {
    throw new ShuttleError(
      "infer_yml_exists",
      "./secret-shuttle.yml already exists. Re-run with --force to overwrite, or --dry-run to print to stdout only.",
    );
  }

  await writeFile(ymlPath, result.yml, "utf8");

  if (!result.executable) {
    outputJson(ok({
      needs_edit: true,
      yml_path: ymlPath,
      issues: result.issues,
      next_action: "edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml",
    }));
    return;
  }

  // Fully executable — mint batch via the existing yml route.
  await runYmlMode(ymlPath, opts);
}

async function runYmlMode(ymlPath: string, _opts: ProvisionOpts): Promise<void> {
  // Hands off to the existing bootstrap plan route (server-side route name
  // kept per spec; internal-only). Route body shape per
  // src/daemon/api/routes/bootstrap.ts:32 is `{ plan_yml, force?, environment? }`.
  const ymlText = await import("node:fs/promises").then((m) => m.readFile(ymlPath, "utf8"));
  const r = await daemonRequest("POST", "/v1/bootstrap/plan", { plan_yml: ymlText });
  outputJson(ok(r as Record<string, unknown>));
}

async function runSecretMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.secret || !opts.from || !opts.to) {
    throw new ShuttleError("missing_param", "--secret requires --from <kind> and --to <dest[,dest...]>.");
  }
  // Build a 1-secret yml in-memory.
  const sourceBlock = buildSecretSource(opts);
  const dests = opts.to.split(",").map((d) => d.trim()).filter(Boolean);
  const yml = [
    "version: 1",
    "secrets:",
    `  ${opts.secret}:`,
    `    source: ${sourceBlock}`,
    `    destinations:`,
    ...dests.map((d) => `      - ${d}`),
  ].join("\n") + "\n";
  const r = await daemonRequest("POST", "/v1/bootstrap/plan", { plan_yml: yml });
  outputJson(ok(r as Record<string, unknown>));
}

function buildSecretSource(opts: ProvisionOpts): string {
  switch (opts.from) {
    case "capture":
      if (!opts.url) throw new ShuttleError("missing_param", "--from=capture requires --url <url>.");
      return `{ kind: capture, url: "${opts.url}" }`;
    case "random_32_bytes":
    case "random_64_bytes":
      return `{ kind: ${opts.from} }`;
    case "existing":
      if (!opts.ref) throw new ShuttleError("missing_param", "--from=existing requires --ref <ss://...>.");
      return `{ kind: existing, ref: "${opts.ref}" }`;
    default:
      throw new ShuttleError("bad_request", `Unknown source kind: ${opts.from}.`);
  }
}

async function runContinueMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.batch) throw new ShuttleError("missing_param", "--continue requires --batch <id>.");
  if (!opts.approvalId || opts.approvalId.length === 0) {
    throw new ShuttleError("missing_param", "--continue requires at least one --approval-id <id>.");
  }
  const r = await daemonRequest("POST", "/v1/bootstrap/continue", {
    batch_id: opts.batch,
    approval_ids: opts.approvalId,
  });
  outputJson(ok(r as Record<string, unknown>));
}

async function runListMode(): Promise<void> {
  // Route is GET /v1/bootstrap/list per src/daemon/api/routes/bootstrap.ts:424.
  const r = await daemonRequest("GET", "/v1/bootstrap/list");
  outputJson(ok(r as Record<string, unknown>));
}

async function runAbandonMode(opts: ProvisionOpts): Promise<void> {
  if (!opts.batch) throw new ShuttleError("missing_param", "--abandon requires --batch <id>.");
  const r = await daemonRequest("POST", "/v1/bootstrap/abandon", { batch_id: opts.batch });
  outputJson(ok(r as Record<string, unknown>));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "provisionCommand"`
Expected: 3 tests pass (commander shape).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/provision.ts src/cli/commands/provision.test.ts
git commit -m "feat(cli): provision command shell with mode dispatch + --infer/--yml/--secret/--continue/--list/--abandon"
```

---

### Task 1.6: Register `provision` in CLI index, add `bootstrap` stub, remove deprecated shims

**Files:**
- Modify: `src/cli/index.ts`
- Delete: `src/cli/commands/bootstrap.ts`, `src/cli/commands/bootstrap.test.ts`
- Delete: `src/cli/commands/list.ts`, `src/cli/commands/list.test.ts`
- Delete: `src/cli/commands/inspect.ts`, `src/cli/commands/inspect.test.ts`
- Delete: `src/cli/commands/generate.ts`, `src/cli/commands/generate.test.ts`
- Delete: `src/cli/commands/doctor.ts`, `src/cli/commands/doctor.test.ts`

- [ ] **Step 1: Read current `src/cli/index.ts` to map the changes**

Run: `cat src/cli/index.ts | head -80`

- [ ] **Step 2: Edit `src/cli/index.ts`**

Replace imports of removed verbs and add `provisionCommand` + a `bootstrap` stub that errors. Concretely:

Remove these lines from the imports block:
```ts
import { generateCommand } from "./commands/generate.js";
import { inspectCommand } from "./commands/inspect.js";
import { listCommand } from "./commands/list.js";
import { doctorCommand } from "./commands/doctor.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
```

Add:
```ts
import { provisionCommand } from "./commands/provision.js";
```

Then in the registration block (where `program.addCommand(...)` calls live), remove every `addCommand` for the deleted commands and add:
```ts
import { Command } from "commander";
import { ShuttleError } from "../shared/errors.js";
// ... (existing imports plus `provisionCommand`)

program.addCommand(provisionCommand());

// Stub `bootstrap` so running it surfaces command_renamed via the top-level
// catch in src/cli/index.ts:62 (writes JSON to stderr, sets exitCode).
// DO NOT outputJson + process.exit here — that bypasses the top-level
// deprecation-warning handling and writes to stdout instead of stderr.
const bootstrapStub = new Command("bootstrap")
  .description("Renamed to `provision` in v0.3.0.")
  .allowUnknownOption()
  .action(() => {
    throw new ShuttleError(
      "command_renamed",
      "The `bootstrap` verb was renamed to `provision` in v0.3.0. Re-run with `secret-shuttle provision <same flags>`.",
    );
  });
program.addCommand(bootstrapStub);
```

- [ ] **Step 3: Delete the obsolete command files**

Run:
```bash
rm src/cli/commands/bootstrap.ts src/cli/commands/bootstrap.test.ts
rm src/cli/commands/list.ts src/cli/commands/list.test.ts
rm src/cli/commands/inspect.ts src/cli/commands/inspect.test.ts
rm src/cli/commands/generate.ts src/cli/commands/generate.test.ts
rm src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts
```

- [ ] **Step 4: Build to surface any remaining references**

Run: `npm run build`

If the build complains about other files that still import from those deleted modules (it likely won't, but the `init` command may still call `agentInstallTarget` or similar — fix any such imports). Expected: clean build OR specific lines to fix; fix them and rebuild until green.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all existing tests still pass, plus the new provision tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(cli): drop bootstrap+deprecated shims, register provision, stub bootstrap → command_renamed"
```

---

### Task 1.7: End-to-end smoke for the bootstrap stub error path

**Files:**
- Create: `src/cli/commands/bootstrap-removed.test.ts`

- [ ] **Step 1: Write the test**

Create `src/cli/commands/bootstrap-removed.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execp = promisify(execFile);

const CLI = join(process.cwd(), "dist/cli/index.js");

test("`secret-shuttle bootstrap` exits 2 with command_renamed JSON pointing at provision", async () => {
  let stdout = "";
  let exitCode = 0;
  try {
    const r = await execp("node", [CLI, "bootstrap"]);
    stdout = r.stdout;
  } catch (e: any) {
    stdout = e.stdout ?? "";
    exitCode = e.code ?? 1;
  }
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "command_renamed");
  assert.match(parsed.message, /provision/);
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- --test-name-pattern "command_renamed"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/bootstrap-removed.test.ts
git commit -m "test(cli): bootstrap stub exits 2 with command_renamed (regression guard)"
```

---

## §2a — Param-constraint primitive (Days 4–6)

### Task 2a.1: Add `required_params` to `SessionPattern` interface

**Files:**
- Modify: `src/daemon/approvals/session.ts`

- [ ] **Step 1: Add the field to the interface**

Find the `export interface SessionPattern` block in `src/daemon/approvals/session.ts` (~line 60) and add the optional field at the end (just before the closing brace):

```ts
  required_params?: Record<string, string>;
  // Applies ONLY to the template-run matcher branch. When present and
  // non-empty, the template-run matcher requires the binding's
  // template_params to contain every key here with strict-equal
  // value. When absent/empty, today's matcher behavior is preserved.
  // See Burst 5 spec §2 "Template-param constraint primitive".
```

- [ ] **Step 2: Build to confirm no type breakage**

Run: `npm run build`
Expected: clean build (field is additive optional).

- [ ] **Step 3: Commit**

```bash
git add src/daemon/approvals/session.ts
git commit -m "feat(session): add SessionPattern.required_params optional field (template-run constraint)"
```

---

### Task 2a.2: Extend `assertSessionPatternValid` with `required_params` validation (TDD)

**Files:**
- Modify: `src/daemon/approvals/session.ts`
- Create: `src/daemon/approvals/session-pattern-required-params-validator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/session-pattern-required-params-validator.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSessionPatternValid, type SessionPattern } from "./session.js";

function base(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

test("required_params absent → valid", () => {
  assertSessionPatternValid(base());
});

test("required_params={} (empty object) → valid", () => {
  assertSessionPatternValid(base({ required_params: {} }));
});

test("required_params with string values → valid", () => {
  assertSessionPatternValid(base({ required_params: { name: "STRIPE_KEY", environment: "production" } }));
});

test("required_params as array → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: [] as any })),
    /required_params must be an object/i,
  );
});

test("required_params as null → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: null as any })),
    /required_params must be an object/i,
  );
});

test("required_params with non-string value → bad_request, key named in message", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { name: 123 as any } })),
    /required_params.*name/i,
  );
});

test("required_params with malformed key (contains '/') → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { "bad/key": "v" } })),
    /required_params.*bad\/key/i,
  );
});

test("required_params with nested object value → bad_request", () => {
  assert.throws(
    () => assertSessionPatternValid(base({ required_params: { name: { x: "y" } as any } })),
    /required_params.*name/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: most tests fail (no validation yet).

- [ ] **Step 3: Add validation block to `assertSessionPatternValid` in `src/daemon/approvals/session.ts`**

Find the function (around line 145+) and add a new validation block just before the function returns (after the existing `max_uses` block at line ~265):

```ts
  // ── 9. required_params shape (optional) ──────────────────────────────────────
  if (pattern.required_params !== undefined) {
    if (
      pattern.required_params === null ||
      typeof pattern.required_params !== "object" ||
      Array.isArray(pattern.required_params)
    ) {
      throw new ShuttleError("bad_request", "required_params must be an object (Record<string,string>).");
    }
    const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
    for (const [key, value] of Object.entries(pattern.required_params)) {
      if (!KEY_RE.test(key)) {
        throw new ShuttleError("bad_request", `required_params key '${key}' must match ${KEY_RE}.`);
      }
      if (typeof value !== "string") {
        throw new ShuttleError("bad_request", `required_params value for key '${key}' must be a string.`);
      }
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session.ts src/daemon/approvals/session-pattern-required-params-validator.test.ts
git commit -m "feat(session): assertSessionPatternValid enforces required_params shape (object<string,string>, key regex, value type)"
```

---

### Task 2a.3: Raise TTL cap to 60 min + replace bad_request with session_ttl_exceeds_cap (TDD)

**Files:**
- Modify: `src/daemon/approvals/session.ts`
- Create: `src/daemon/approvals/session-ttl-cap-bump.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/session-ttl-cap-bump.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSessionPatternValid, type SessionPattern } from "./session.js";

function base(ttl_ms: number): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms,
  };
}

test("ttl_ms = 60 minutes (exact cap) accepted", () => {
  assertSessionPatternValid(base(60 * 60 * 1000));
});

test("ttl_ms = 60 minutes + 1 ms rejected with session_ttl_exceeds_cap", () => {
  assert.throws(
    () => assertSessionPatternValid(base(60 * 60 * 1000 + 1)),
    (err: any) => err.code === "session_ttl_exceeds_cap" || /session_ttl_exceeds_cap/.test(String(err)),
  );
});

test("ttl_ms = 15 minutes (old cap) still accepted (below new cap)", () => {
  assertSessionPatternValid(base(15 * 60 * 1000));
});
```

- [ ] **Step 2: Find and update `TTL_MAX_MS`**

Run: `grep -n "TTL_MAX_MS\|900_000" src/daemon/approvals/session.ts`

Update the constant from `15 * 60 * 1000` (or `900_000`) to `60 * 60 * 1000` (3_600_000 ms).

- [ ] **Step 3: Update the throw site to use `session_ttl_exceeds_cap`**

In the existing TTL-bounds block (around line ~252):
```ts
  if (pattern.ttl_ms > TTL_MAX_MS) {
    throw new ShuttleError("bad_request", `ttl_ms cannot exceed ${TTL_MAX_MS}ms (15 minutes).`);
  }
```

Change to:
```ts
  if (pattern.ttl_ms > TTL_MAX_MS) {
    throw new ShuttleError(
      "session_ttl_exceeds_cap",
      `ttl_ms cannot exceed ${TTL_MAX_MS}ms (${Math.round(TTL_MAX_MS / 60_000)} minutes).`,
    );
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "ttl"`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session.ts src/daemon/approvals/session-ttl-cap-bump.test.ts
git commit -m "feat(session): raise TTL cap 15→60 min; new code session_ttl_exceeds_cap replaces bad_request"
```

---

### Task 2a.4: Extend template-run matcher with `required_params` strict-equal check (TDD)

**Files:**
- Modify: `src/daemon/approvals/session-matchers.ts`
- Create: `src/daemon/approvals/session-matcher-required-params.test.ts`

- [ ] **Step 1: Write the failing test**

Real exports (verified):
- `src/daemon/approvals/session-matchers.ts:5` exports `matchesSessionPattern(binding, pattern)` — a single dispatching function. The per-action helpers (`templateRunMatches` etc.) are NOT exported.
- `ApprovalBinding.action` for template-run is stored as the literal string `"template"` and is canonicalized by `canonicalAction()` to `"template-run"` (see `session-matchers.ts:9` and `session.ts:102`).

Create `src/daemon/approvals/session-matcher-required-params.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionPattern } from "./session-matchers.js";
import type { SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

function pattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

// ApprovalBinding.action is stored as "template" (per session-matchers.ts:102)
// and canonicalized to "template-run" by the matcher. Use the stored form
// so the test matches the binding shape constructed by the templates route.
function binding(params: Record<string, string> = { name: "STRIPE_KEY", environment: "production" }): ApprovalBinding {
  return {
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    template_id: "vercel-env-add",
    template_params: params,
    destination_domain: null,
    environment: "production",
    // Add any other required ApprovalBinding fields by mirroring the shape
    // used in session-matchers.test.ts (`makePattern` test fixture there).
  } as ApprovalBinding;
}

test("required_params absent → matcher behaves as today (ref + template_id)", () => {
  assert.equal(matchesSessionPattern(binding(), pattern()), true);
});

test("required_params empty object → same as absent", () => {
  assert.equal(matchesSessionPattern(binding(), pattern({ required_params: {} })), true);
});

test("all required_params keys present and equal → match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding(), p), true);
});

test("one required_params key missing in binding → no match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "STRIPE_KEY" }), p), false);
});

test("one required_params value differs → no match", () => {
  const p = pattern({ required_params: { name: "STRIPE_KEY", environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "STRIPE_KEY", environment: "preview" }), p), false);
});

test("binding has extra params not in required_params → match", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "STRIPE_KEY", environment: "production", extra: "z" }), p), true);
});

test("strict equality: 'production' ≠ 'Production'", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "X", environment: "Production" }), p), false);
});

test("strict equality: 'production' ≠ ' production' (whitespace)", () => {
  const p = pattern({ required_params: { environment: "production" } });
  assert.equal(matchesSessionPattern(binding({ name: "X", environment: " production" }), p), false);
});
```

Before writing, run `grep -n "ApprovalBinding\|action:" src/daemon/approvals/session-matchers.test.ts | head -10` to copy the exact binding-fixture shape used there — that file already constructs ApprovalBindings correctly for matcher tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: new param-matching tests fail (matcher doesn't check params yet).

- [ ] **Step 3: Extend the matcher**

Open `src/daemon/approvals/session-matchers.ts`. Find the internal `templateRunMatches(binding, pattern)` helper (the function called from the `case "template-run":` branch of `matchesSessionPattern`). Just BEFORE its final `return true`, insert the param-equality check:

```ts
  // NEW: required_params strict-equal (Burst 5 §2 param-constraint primitive).
  // No-op when required_params is empty/absent — preserves Plan 4a behavior.
  if (pattern.required_params && Object.keys(pattern.required_params).length > 0) {
    const params = binding.template_params ?? {};
    for (const [key, expected] of Object.entries(pattern.required_params)) {
      if (params[key] !== expected) return false;
    }
  }
```

This is inside `templateRunMatches` (internal, not exported). The public `matchesSessionPattern` dispatches to it via `canonicalAction(binding.action)`.

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: all 8 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-matchers.ts src/daemon/approvals/session-matcher-required-params.test.ts
git commit -m "feat(session-matchers): template-run honors required_params strict equality (no-op when empty)"
```

---

### Task 2a.5: Create `DESTINATION_DEFINING_PARAMS` config + startup validation hook (TDD)

**Files:**
- Create: `src/daemon/templates/destination-defining-params.ts`
- Create: `src/daemon/templates/destination-defining-params.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/templates/destination-defining-params.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_DEFINING_PARAMS,
  destinationDefiningParamsFor,
  validateDestinationDefiningParamsCoverage,
} from "./destination-defining-params.js";
import { TemplateRegistry } from "./registry.js";

test("every shipped template has a registered entry", () => {
  const registry = new TemplateRegistry();
  const ids = registry.list().map((t) => t.id);
  assert.ok(ids.length > 0, "expected at least one shipped template");
  for (const id of ids) {
    assert.ok(
      id in DESTINATION_DEFINING_PARAMS,
      `template ${id} missing destination-defining-params entry`,
    );
  }
});

test("vercel-env-add has [name, environment]", () => {
  assert.deepEqual([...DESTINATION_DEFINING_PARAMS["vercel-env-add"]], ["name", "environment"]);
});

test("github-actions-secret-set has [name, repo]", () => {
  assert.deepEqual([...DESTINATION_DEFINING_PARAMS["github-actions-secret-set"]], ["name", "repo"]);
});

test("cloudflare-secret-put has [name, env]", () => {
  assert.deepEqual([...DESTINATION_DEFINING_PARAMS["cloudflare-secret-put"]], ["name", "env"]);
});

test("supabase-edge-secret-set has [name, project_ref]", () => {
  assert.deepEqual([...DESTINATION_DEFINING_PARAMS["supabase-edge-secret-set"]], ["name", "project_ref"]);
});

test("destinationDefiningParamsFor returns null for unregistered template", () => {
  assert.equal(destinationDefiningParamsFor("railway-variable-set"), null);
});

test("validateDestinationDefiningParamsCoverage logs warnings for unregistered shipped templates", () => {
  const warnings: string[] = [];
  validateDestinationDefiningParamsCoverage(new TemplateRegistry(), { warn: (m) => warnings.push(m) });
  // With the four shipped templates fully covered, expect 0 warnings.
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(", ")}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails on missing module.

- [ ] **Step 3: Create the config file**

Create `src/daemon/templates/destination-defining-params.ts`:
```ts
/**
 * Per-template "destination-defining params" config used by the
 * session-derivation path in Burst 5 (§2 "Pattern derivation"). Each
 * entry lists the template_params keys whose values determine WHERE
 * the secret is pushed — `name` is universally destination-defining
 * (the env-var / secret name set at the provider).
 *
 * NEW templates added in future bursts must register here. The
 * `validateDestinationDefiningParamsCoverage` function (called from
 * the daemon startup wiring once the template registry is built)
 * logs a warning if a shipped template has no entry; the CI test
 * fails when a shipped template lands without its entry.
 *
 * See spec §2 "Template-param constraint primitive".
 */
import type { TemplateRegistry } from "./registry.js";

export const DESTINATION_DEFINING_PARAMS: Record<string, readonly string[]> = {
  "vercel-env-add":            ["name", "environment"],
  "github-actions-secret-set": ["name", "repo"],
  "cloudflare-secret-put":     ["name", "env"],
  "supabase-edge-secret-set":  ["name", "project_ref"],
};

/**
 * Returns the destination-defining param keys for a template_id, OR
 * null if the template is not registered. Session derivation uses
 * `null` to mean "exclude this destination from the derivation
 * (fail-closed)."
 */
export function destinationDefiningParamsFor(template_id: string): readonly string[] | null {
  if (template_id in DESTINATION_DEFINING_PARAMS) {
    return DESTINATION_DEFINING_PARAMS[template_id];
  }
  return null;
}

export interface Logger {
  warn(msg: string): void;
}

const defaultLogger: Logger = {
  warn: (msg) => console.warn(`[secret-shuttle] ${msg}`),
};

/**
 * Validate that every shipped template (every entry in the supplied
 * `TemplateRegistry`) has a registered entry in DESTINATION_DEFINING_PARAMS.
 * Called once at daemon startup with the daemon's `services.templates`.
 * Emits a warning line for each missing entry — provision-derived
 * sessions for that template will be excluded (fail-closed).
 */
export function validateDestinationDefiningParamsCoverage(
  registry: TemplateRegistry,
  logger: Logger = defaultLogger,
): void {
  for (const t of registry.list()) {
    if (!(t.id in DESTINATION_DEFINING_PARAMS)) {
      logger.warn(
        `Template '${t.id}' has no entry in DESTINATION_DEFINING_PARAMS. ` +
        `Provision-derived sessions will exclude this template (fail-closed). ` +
        `Add an entry in src/daemon/templates/destination-defining-params.ts.`,
      );
    }
  }
}
```

The function takes a `TemplateRegistry` instance — the real registry is a class with a `list()` method (see `src/daemon/templates/registry.ts:47`). No module-level `TEMPLATES` constant exists. The startup wiring (Task 2a.6) passes the registry from `DaemonServices.templates`.

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "DESTINATION_DEFINING_PARAMS\|destination-defining"`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/templates/destination-defining-params.ts src/daemon/templates/destination-defining-params.test.ts
git commit -m "feat(templates): DESTINATION_DEFINING_PARAMS config + startup coverage validator (4 shipped templates)"
```

---

### Task 2a.6: Wire startup hook in `registry.ts` or daemon `main.ts`

**Files:**
- Modify: `src/daemon/main.ts` (or the daemon's entry point)

- [ ] **Step 1: Find the daemon startup sequence and DaemonServices wiring**

Run: `grep -n "DaemonServices\|new TemplateRegistry\|services\.templates" src/daemon/services.ts src/daemon/main.ts 2>/dev/null | head -15`

- [ ] **Step 2: Add the validator call passing the registry instance**

In whichever file constructs `DaemonServices` (probably `src/daemon/services.ts` or `src/daemon/main.ts` — the grep above will tell you), after the `TemplateRegistry` is instantiated and before the HTTP server begins listening:
```ts
import { validateDestinationDefiningParamsCoverage } from "./templates/destination-defining-params.js";
// ...where `services.templates` (a TemplateRegistry instance) is in scope:
validateDestinationDefiningParamsCoverage(services.templates);
```

If services aren't grouped in a struct yet, pass the registry instance directly: `validateDestinationDefiningParamsCoverage(templateRegistry)`.

- [ ] **Step 3: Build + run + smoke**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node dist/daemon/main.js &`
Then: `sleep 1 && kill %1` (or use the existing daemon-management tooling).

Expected: daemon starts cleanly, no warnings logged (all 4 templates registered correctly).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(daemon): call validateDestinationDefiningParamsCoverage on startup"
```

---

### Task 2a.7: Thread `required_params` through `parseSessionPatternFromBody`

**Files:**
- Modify: `src/daemon/api/routes/approvals-session.ts`
- Create: `src/daemon/api/routes/approvals-session-required-params.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/api/routes/approvals-session-required-params.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Reuse the test harness pattern from the existing approvals-session.test.ts.
// Reference: src/daemon/api/routes/approvals-session.test.ts:76 shows the `call` helper.
import { withDaemonForTest, call } from "../../../test-helpers/daemon.js"; // adjust if helper path differs

test("POST /v1/approvals/session with required_params persists it onto the grant", async () => {
  await withDaemonForTest(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: { name: "STRIPE_KEY", environment: "production" },
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.ok, true);
    const list = await call(ctx, "GET", "/v1/approvals/sessions", null);
    const session = list.sessions.find((s: any) => s.id === r.session_id);
    assert.deepEqual(session.required_params, { name: "STRIPE_KEY", environment: "production" });
  });
});

test("POST /v1/approvals/session with invalid required_params (array) → bad_request from validator", async () => {
  await withDaemonForTest(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: [],
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error_code, "bad_request");
    assert.match(r.message, /required_params must be an object/);
  });
});
```

(If the test-helper path doesn't match, grep `grep -n "withDaemonForTest\|export.*call" src/daemon/api/routes/approvals-session.test.ts` to align.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: persistence test fails (field is dropped in the route's whitelist).

- [ ] **Step 3: Add `required_params` to the whitelist in `parseSessionPatternFromBody`**

Open `src/daemon/api/routes/approvals-session.ts` and find `parseSessionPatternFromBody` (line ~103). It already whitelist-shapes patterns. Add `required_params` to whatever shape the function builds. Concrete diff: where the function copies fields from the body object onto the pattern, add:
```ts
  ...(typeof o.required_params === "object" && o.required_params !== null
    ? { required_params: o.required_params as Record<string, unknown> }
    : {}),
```
(Cast to `Record<string, unknown>` so TypeScript doesn't reject — `assertSessionPatternValid` will narrow & validate.)

If the function constructs the SessionPattern via explicit field assignments, add:
```ts
  required_params: o.required_params !== undefined ? (o.required_params as any) : undefined,
```
…in the appropriate spot.

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "required_params"`
Expected: persistence test passes; invalid-shape test passes (validator rejects).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/approvals-session.ts src/daemon/api/routes/approvals-session-required-params.test.ts
git commit -m "feat(approvals-session): whitelist required_params in body parser; validator enforces shape"
```

---

### Task 2a.8: Thread `required_params` through `session-ui-server.ts` safePattern + HTML

**Files:**
- Modify: `src/daemon/approvals/session-ui-server.ts`
- Modify: `src/daemon/approvals/session-ui.html`
- Create: `src/daemon/approvals/session-ui-required-params.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/session-ui-required-params.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, call } from "../../test-helpers/daemon.js";

test("session UI HTML embeds required_params in the safePattern JSON", async () => {
  await withDaemonForTest(async (ctx) => {
    // Mint a session via the route and fetch the UI HTML
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: { name: "STRIPE_KEY", environment: "production" },
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    const ui = await call(ctx, "GET", `/ui/session?id=${created.session_id}&token=${created.ui_token}`, null, { raw: true });
    assert.match(ui.body, /required_params/);
    assert.match(ui.body, /name.*STRIPE_KEY/);
    assert.match(ui.body, /environment.*production/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "session UI HTML embeds required_params"`
Expected: FAIL (field not in safePattern).

- [ ] **Step 3: Update `safePattern` in `src/daemon/approvals/session-ui-server.ts`**

Find the `safePattern` JSON construction (line ~44):
```ts
    const safePattern = JSON.stringify({
      actions: grant.actions,
      ref_glob: grant.ref_glob,
      destination_domains: grant.destination_domains,
      template_ids: grant.template_ids,
      allowed_actions: grant.allowed_actions,
      ttl_ms: grant.ttl_ms,
      max_uses: grant.max_uses,
    }, null, 2);
```

Add `required_params: grant.required_params` so the field flows into the rendered HTML:
```ts
    const safePattern = JSON.stringify({
      actions: grant.actions,
      ref_glob: grant.ref_glob,
      destination_domains: grant.destination_domains,
      template_ids: grant.template_ids,
      allowed_actions: grant.allowed_actions,
      required_params: grant.required_params,
      ttl_ms: grant.ttl_ms,
      max_uses: grant.max_uses,
    }, null, 2);
```

- [ ] **Step 4: Update `session-ui.html` to render `required_params` as a human-readable row**

Find the place in `src/daemon/approvals/session-ui.html` that renders the parsed pattern (likely a `<dl>` or similar). Add a row that, when `required_params` is non-empty, shows each key=value pair. Look for the existing pattern-row template; add the new key alongside the others. (If the HTML uses raw `__PATTERN_JSON__` substitution and the JS parses it client-side, locate that JS block and add a rendering step.)

The exact diff depends on the existing HTML structure — read the file first (`cat src/daemon/approvals/session-ui.html | head -80`) and follow the established pattern.

Minimal acceptable rendering: a paragraph or list item containing the literal text `Required params: <k>=<v>, <k>=<v>` when the JSON has a non-empty `required_params` object. The drift-guard test asserts the string `required_params` appears in the HTML and the values are interpolated.

- [ ] **Step 5: Run tests**

Run: `npm test -- --test-name-pattern "session UI"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/approvals/session-ui-server.ts src/daemon/approvals/session-ui.html src/daemon/approvals/session-ui-required-params.test.ts
git commit -m "feat(session-ui): safePattern + HTML expose required_params to operators"
```

---

### Task 2a.9: Add `--required-param k=v` flag to `internal session create` CLI

**Files:**
- Modify: `src/cli/commands/internal-session.ts`
- Modify: `src/cli/commands/internal-session.test.ts` (or create `internal-session-required-params.test.ts`)

- [ ] **Step 1: Write the failing test**

Add to `src/cli/commands/internal-session.test.ts` (or new file):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("internal session create --required-param k=v builds body with required_params", async () => {
  // Find the body-builder helper or factor out the option-parse step
  // so it can be unit-tested without daemon round-trip.
  const { buildSessionCreateBody } = await import("./internal-session.js");
  const body = buildSessionCreateBody({
    actions: ["template-run"],
    refGlob: "ss://stripe/prod/X",
    templateIds: ["vercel-env-add"],
    destinationDomains: ["vercel.com"],
    requiredParam: ["environment=production", "name=STRIPE_KEY"],
    ttlMs: 5 * 60 * 1000,
  });
  assert.deepEqual(body.pattern.required_params, {
    environment: "production",
    name: "STRIPE_KEY",
  });
});

test("--required-param without '=' → throws on CLI side", async () => {
  const { buildSessionCreateBody } = await import("./internal-session.js");
  assert.throws(
    () => buildSessionCreateBody({
      actions: ["template-run"],
      refGlob: "ss://stripe/prod/X",
      templateIds: ["vercel-env-add"],
      destinationDomains: ["vercel.com"],
      requiredParam: ["malformed"],
      ttlMs: 5 * 60 * 1000,
    }),
    /required-param.*malformed/i,
  );
});
```

- [ ] **Step 2: Update the CLI to expose the flag + extract `buildSessionCreateBody`**

Open `src/cli/commands/internal-session.ts`. The `create` subcommand currently has flags like `--actions`, `--ref-glob`, etc. Add:
```ts
  .option("--required-param <k=v...>", "Repeatable: param key=value constraint for template-run patterns")
```

Then extract the body-build step into an exported function `buildSessionCreateBody` (so the test can call it directly):
```ts
export interface SessionCreateInput {
  actions: string[];
  refGlob: string;
  templateIds?: string[];
  destinationDomains?: string[];
  allowedActions?: string[];
  requiredParam?: string[];
  ttlMs: number;
  maxUses?: number;
}

export function buildSessionCreateBody(input: SessionCreateInput): { pattern: Record<string, unknown> } {
  const required_params: Record<string, string> = {};
  for (const kv of input.requiredParam ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--required-param value '${kv}' must be in k=v form`);
    }
    required_params[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const pattern: Record<string, unknown> = {
    actions: input.actions,
    ref_glob: input.refGlob,
    template_ids: input.templateIds,
    destination_domains: input.destinationDomains ?? [],
    allowed_actions: input.allowedActions,
    ttl_ms: input.ttlMs,
    max_uses: input.maxUses,
  };
  if (Object.keys(required_params).length > 0) {
    pattern.required_params = required_params;
  }
  return { pattern };
}
```

Then have the existing action handler call `buildSessionCreateBody(rawOpts)` instead of inlining the body construction.

- [ ] **Step 3: Run tests**

Run: `npm test -- --test-name-pattern "internal session create"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/internal-session.ts src/cli/commands/internal-session.test.ts
git commit -m "feat(internal-session): --required-param k=v repeatable flag for manual session creation"
```

---

### Task 2a.10: Verify GET `/v1/approvals/sessions` returns `required_params`

**Files:**
- Read-only check / one new test:
- Create: `src/daemon/api/routes/approvals-sessions-list-required-params.test.ts`

`SessionGrant extends SessionPattern`, so the list endpoint already returns the field — but a test pins the behavior so a future refactor that whitelists the response doesn't silently drop it.

- [ ] **Step 1: Write the test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, call } from "../../test-helpers/daemon.js";

test("GET /v1/approvals/sessions includes required_params per session", async () => {
  await withDaemonForTest(async (ctx) => {
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: { name: "STRIPE_KEY", environment: "production" },
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    const list = await call(ctx, "GET", "/v1/approvals/sessions", null);
    const s = list.sessions.find((x: any) => x.id === created.session_id);
    assert.ok(s, "session not in list");
    assert.deepEqual(s.required_params, { name: "STRIPE_KEY", environment: "production" });
  });
});

test("listed sessions without required_params parse without error", async () => {
  await withDaemonForTest(async (ctx) => {
    const created = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        ttl_ms: 5 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    const list = await call(ctx, "GET", "/v1/approvals/sessions", null);
    const s = list.sessions.find((x: any) => x.id === created.session_id);
    assert.ok(s);
    assert.equal(s.required_params, undefined);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- --test-name-pattern "approvals-sessions-list"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/approvals-sessions-list-required-params.test.ts
git commit -m "test(approvals-sessions): required_params survives the list endpoint round-trip"
```

---

## §2b — Approval-UI session affordance (Days 7–9)

### Task 2b.1: Relocate `readBoundedJson` to a shared helper with `allowEmpty` option

**Files:**
- Create: `src/daemon/helpers/bounded-json.ts`
- Create: `src/daemon/helpers/bounded-json.test.ts`
- Modify: `src/daemon/hub/hub-server.ts` (import from new location)

- [ ] **Step 1: Write the failing test**

Create `src/daemon/helpers/bounded-json.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readBoundedJson } from "./bounded-json.js";

function reqFrom(text: string): any {
  return Object.assign(Readable.from(Buffer.from(text, "utf8")), { socket: { remoteAddress: "127.0.0.1" } });
}

test("valid JSON within bound parses", async () => {
  const r = await readBoundedJson(reqFrom('{"x":1}'), 1024);
  assert.deepEqual(r, { x: 1 });
});

test("empty body → bad_request by default", async () => {
  await assert.rejects(readBoundedJson(reqFrom(""), 1024), /Empty body/);
});

test("empty body → {} when allowEmpty: true", async () => {
  const r = await readBoundedJson(reqFrom(""), 1024, { allowEmpty: true });
  assert.deepEqual(r, {});
});

test("oversize → request_too_large", async () => {
  await assert.rejects(readBoundedJson(reqFrom("x".repeat(2048)), 1024), /Body exceeds/);
});

test("malformed JSON → bad_request", async () => {
  await assert.rejects(readBoundedJson(reqFrom("{not json"), 1024), /Malformed JSON/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails on missing module.

- [ ] **Step 3: Create the helper**

Create `src/daemon/helpers/bounded-json.ts` by copying the body of the existing function from `src/daemon/hub/hub-server.ts:141` and adding the `allowEmpty` option:
```ts
import { ShuttleError } from "../../shared/errors.js";

export interface BoundedJsonOptions {
  allowEmpty?: boolean;
}

export async function readBoundedJson(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
  opts: BoundedJsonOptions = {},
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new ShuttleError("request_too_large", `Body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  if (total === 0) {
    if (opts.allowEmpty) return {};
    throw new ShuttleError("bad_request", "Empty body.");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ShuttleError("bad_request", "Malformed JSON body.");
  }
}
```

- [ ] **Step 4: Update `hub-server.ts` to import from the new location**

In `src/daemon/hub/hub-server.ts`:
- Delete the local `readBoundedJson` function (line 141+).
- Add at top: `import { readBoundedJson } from "../helpers/bounded-json.js";`
- The call site at line 117 (`payload = await readBoundedJson(req, 1024);`) continues to work — the helper preserves the original signature for the `allowEmpty: false` default.

- [ ] **Step 5: Build and test**

Run: `npm test -- --test-name-pattern "bounded-json\|hub"`
Expected: all bounded-json tests pass + existing hub tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/helpers/bounded-json.ts src/daemon/helpers/bounded-json.test.ts src/daemon/hub/hub-server.ts
git commit -m "refactor(helpers): relocate readBoundedJson to shared helper with allowEmpty option"
```

---

### Task 2b.2: Add `SessionStore.createForOwner(pattern, owner_agent_id)`

**Files:**
- Modify: `src/daemon/approvals/session-store.ts`
- Create: `src/daemon/approvals/session-store-create-for-owner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/session-store-create-for-owner.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./session-store.js";
import type { SessionPattern } from "./session.js";

function p(): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/STRIPE_KEY",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"],
    required_params: { name: "STRIPE_KEY", environment: "production" },
    ttl_ms: 5 * 60 * 1000,
  };
}

test("createForOwner stamps the supplied owner regardless of ambient context", () => {
  const store = new SessionStore({ now: () => 0 });
  const g = store.createForOwner(p(), "claude-abc123");
  assert.equal(g.owner_agent_id, "claude-abc123");
});

test("createForOwner runs validator (rejects malformed required_params)", () => {
  const store = new SessionStore({ now: () => 0 });
  const bad = { ...p(), required_params: [] as any };
  assert.throws(() => store.createForOwner(bad, "claude-abc123"), /required_params must be an object/);
});
```

- [ ] **Step 2: Add the method**

Open `src/daemon/approvals/session-store.ts`. Find `create(pattern: SessionPattern)`. Add a sibling method:
```ts
  /**
   * Create a session pattern with the owner stamped EXPLICITLY rather
   * than from `getCurrentAgentId()`. Used by raw UI routes (which
   * have no ALS context) that act on behalf of a stored grant's
   * owner. Mirrors the AuditActorSite.persisted-owner pattern.
   */
  createForOwner(pattern: SessionPattern, owner_agent_id: string): SessionGrant {
    // Reuse the same construction logic the existing `create()` uses —
    // refactor `create()` to delegate to a private helper that accepts
    // the owner_agent_id, and have `create()` call it with
    // `getCurrentAgentId()` while `createForOwner` calls it with the
    // supplied owner. Single construction path = single set of fields,
    // no drift risk.
    //
    // Concrete refactor: extract a private `createInternal(pattern, owner)`
    // method containing `create()`'s current body (post-assertion). Then:
    //   create(pattern):                this.createInternal(pattern, getCurrentAgentId())
    //   createForOwner(pattern, owner): this.createInternal(pattern, owner)
    //
    // Use the existing SessionGrant shape (session.ts:77 — `uses: number`
    // starts at 0; `max_uses?: number` is optional). Do NOT introduce a
    // synthetic `uses_remaining` field — that doesn't exist in the
    // current model and was a draft-spec artifact.
    assertSessionPatternValid(pattern);
    return this.createInternal(pattern, owner_agent_id);
  }
```

Read `session-store.ts:23` (`create()`) and `session.ts:77` (`SessionGrant` interface) to copy the exact field set in `createInternal`. The new method must NOT add or rename fields.

- [ ] **Step 3: Run tests**

Run: `npm test -- --test-name-pattern "createForOwner"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/approvals/session-store.ts src/daemon/approvals/session-store-create-for-owner.test.ts
git commit -m "feat(session-store): createForOwner stamps owner explicitly (no ALS dependency)"
```

---

### Task 2b.3: Write `inferSessionPatternFromPlan` (TDD)

**Files:**
- Create: `src/daemon/approvals/infer-session-pattern.ts`
- Create: `src/daemon/approvals/infer-session-pattern.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/infer-session-pattern.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSessionPatternFromPlan } from "./infer-session-pattern.js";
import type { PlanEntry } from "../bootstrap/store.js";

function entry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    secret: "STRIPE_KEY",
    ref: "ss://stripe/prod/STRIPE_KEY",
    source: { kind: "random_32_bytes" },
    destinations: [
      {
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "STRIPE_KEY", environment: "production" },
        domain: "vercel.com",
      },
    ],
    ...overrides,
  };
}

test("single PlanEntry → one exact-ref pattern", () => {
  const r = inferSessionPatternFromPlan([entry()]);
  assert.equal(r.patterns.length, 1);
  const p = r.patterns[0];
  assert.equal(p.ref_glob, "ss://stripe/prod/STRIPE_KEY");
  assert.deepEqual(p.required_params, { name: "STRIPE_KEY", environment: "production" });
  assert.deepEqual(p.actions, ["template-run"]);
  assert.deepEqual(p.template_ids, ["vercel-env-add"]);
});

test("same ref pushed to two vercel environments → two patterns with different environment values", () => {
  const e: PlanEntry = entry({
    destinations: [
      { shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "STRIPE_KEY", environment: "production" }, domain: "vercel.com" },
      { shorthand: "vercel:preview",    template_id: "vercel-env-add", template_params: { name: "STRIPE_KEY", environment: "preview"   }, domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 2);
  const envs = r.patterns.map((p) => p.required_params!.environment).sort();
  assert.deepEqual(envs, ["preview", "production"]);
});

test("two refs aliased onto same destination name → two exact-ref patterns (NOT one glob)", () => {
  const a: PlanEntry = { ...entry(), ref: "ss://stripe/prod/X", secret: "X",
    destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "API_KEY", environment: "production" }, domain: "vercel.com" }] };
  const b: PlanEntry = { ...entry(), ref: "ss://stripe/prod/Y", secret: "Y",
    destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: { name: "API_KEY", environment: "production" }, domain: "vercel.com" }] };
  const r = inferSessionPatternFromPlan([a, b]);
  assert.equal(r.patterns.length, 2);
  const refs = r.patterns.map((p) => p.ref_glob).sort();
  assert.deepEqual(refs, ["ss://stripe/prod/X", "ss://stripe/prod/Y"]);
  for (const p of r.patterns) {
    assert.ok(!p.ref_glob.endsWith("*"), `derivation must never emit glob form, got ${p.ref_glob}`);
  }
});

test("template not in DESTINATION_DEFINING_PARAMS → destination excluded", () => {
  const e = entry({
    destinations: [
      { shorthand: "railway:production", template_id: "railway-variable-set", template_params: { name: "X" }, domain: "railway.app" },
      { shorthand: "vercel:production",  template_id: "vercel-env-add",       template_params: { name: "STRIPE_KEY", environment: "production" }, domain: "vercel.com" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 1);
  assert.equal(r.patterns[0].template_ids![0], "vercel-env-add");
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].template_id, "railway-variable-set");
});

test("all destinations unregistered → empty patterns array, excluded list non-empty", () => {
  const e = entry({
    destinations: [
      { shorthand: "railway:production", template_id: "railway-variable-set", template_params: { name: "X" }, domain: "railway.app" },
    ],
  });
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
  assert.equal(r.excluded.length, 1);
});

test("capture-only PlanEntry with no template-run destinations → no patterns", () => {
  const e: PlanEntry = {
    secret: "CAPTURED",
    ref: "ss://stripe/prod/CAPTURED",
    source: { kind: "capture", url: "https://example.com" } as any,
    destinations: [],
  };
  const r = inferSessionPatternFromPlan([e]);
  assert.equal(r.patterns.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: build fails on missing module.

- [ ] **Step 3: Write the derivation function**

Create `src/daemon/approvals/infer-session-pattern.ts`:
```ts
/**
 * Derive session patterns from a BatchState.plan for the
 * approval-UI session affordance. Pure function. See Burst 5 spec
 * §2 "Pattern derivation."
 *
 * Invariants:
 * - Every emitted pattern's `ref_glob` is an exact ref (no trailing *).
 *   See spec §2 "No glob collapsing in derivation."
 * - Destinations whose template_id is NOT in DESTINATION_DEFINING_PARAMS
 *   are excluded (fail-closed).
 * - One pattern per (ref, destination-shape) tuple.
 */
import type { PlanEntry, ResolvedDestination } from "../bootstrap/store.js";
import type { SessionPattern } from "./session.js";
import { destinationDefiningParamsFor } from "../templates/destination-defining-params.js";

export interface InferSessionPatternResult {
  patterns: SessionPattern[];
  excluded: Array<{ secret: string; ref: string; destination: ResolvedDestination; reason: "template_unregistered"; template_id: string }>;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — overridden by ui body at create time

export function inferSessionPatternFromPlan(plan: PlanEntry[], ttl_ms: number = DEFAULT_TTL_MS): InferSessionPatternResult {
  const patterns: SessionPattern[] = [];
  const excluded: InferSessionPatternResult["excluded"] = [];

  for (const entry of plan) {
    for (const dest of entry.destinations) {
      const definingKeys = destinationDefiningParamsFor(dest.template_id);
      if (definingKeys === null) {
        excluded.push({ secret: entry.secret, ref: entry.ref, destination: dest, reason: "template_unregistered", template_id: dest.template_id });
        continue;
      }
      const required_params: Record<string, string> = {};
      for (const k of definingKeys) {
        const v = dest.template_params[k];
        if (typeof v === "string") required_params[k] = v;
      }
      const pattern: SessionPattern = {
        actions: ["template-run"],
        ref_glob: entry.ref, // ALWAYS exact ref — no globbing
        destination_domains: [dest.domain],
        template_ids: [dest.template_id],
        ttl_ms,
        ...(Object.keys(required_params).length > 0 ? { required_params } : {}),
      };
      patterns.push(pattern);
    }
  }

  // Dedup: same SessionPattern shape emitted twice → keep one.
  const seen = new Set<string>();
  const deduped: SessionPattern[] = [];
  for (const p of patterns) {
    const key = JSON.stringify(p);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  return { patterns: deduped, excluded };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "infer-session-pattern"`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/infer-session-pattern.ts src/daemon/approvals/infer-session-pattern.test.ts
git commit -m "feat(approvals): inferSessionPatternFromPlan — exact-ref derivation from BatchState.plan, fail-closed for unregistered templates"
```

---

### Task 2b.4: Approval UI route reads body, mints sessions, all-or-nothing rollback

**Files:**
- Modify: `src/daemon/approvals/ui-server.ts`
- Create: `src/daemon/approvals/approval-ui-creates-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/approval-ui-creates-sessions.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, mintBootstrapApproval, call } from "../../test-helpers/daemon.js";

test("POST /ui/approvals/:id/approve with session body mints N grants owned by approval grant's owner", async () => {
  await withDaemonForTest(async (ctx) => {
    // Use the existing helper to mint a bootstrap-action approval that
    // corresponds to a multi-destination plan (e.g., one secret pushed
    // to both vercel:production and vercel:preview).
    const { approvalId, batchId, uiToken, ownerAgentId } = await mintBootstrapApproval(ctx, {
      plan: /* 1 secret × 2 destinations */ "...",
    });
    const r = await call(ctx, "POST", `/ui/approvals/${approvalId}/approve?token=${uiToken}`, {
      session: { ttl_minutes: 15 },
    });
    assert.equal(r.ok, true);
    const list = await call(ctx, "GET", "/v1/approvals/sessions", null);
    const owned = list.sessions.filter((s: any) => s.owner_agent_id === ownerAgentId);
    assert.ok(owned.length >= 2, `expected ≥2 sessions for owner ${ownerAgentId}, got ${owned.length}`);
  });
});

test("if any createForOwner throws, previously-minted grants in the batch roll back", async () => {
  // Inject a stub SessionStore.createForOwner that throws on the 2nd call;
  // assert no grants persist.
  // Implementation detail — see test-helper docs or the mock pattern used
  // by other store tests.
});
```

(The `mintBootstrapApproval` helper may need to be added to `src/test-helpers/daemon.ts` — use the existing test scaffolding pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "approval-ui-creates-sessions"`
Expected: FAIL (route doesn't mint sessions yet).

- [ ] **Step 3: Expand `registerUiRoutes` to accept the dependencies it now needs**

Today's signature (`src/daemon/approvals/ui-server.ts:14`) is `registerUiRoutes(server, store: ApprovalStore)`. The new session-minting path needs `SessionStore` and `BootstrapStore` too. Update both the signature and the caller in `src/daemon/api/router.ts:36`:

```ts
// src/daemon/approvals/ui-server.ts
import type { SessionStore } from "./session-store.js";
import type { BootstrapStore } from "../bootstrap/store.js";

export interface ApprovalsUiDeps {
  approvals: ApprovalStore;
  sessions: SessionStore;
  bootstrap: BootstrapStore;
}

export function registerUiRoutes(server: DaemonServer, deps: ApprovalsUiDeps): void {
  // (replace internal `store` references with `deps.approvals`)
  // ...
}
```

```ts
// src/daemon/api/router.ts — at line 36, where registerUiRoutes is called:
registerUiRoutes(server, {
  approvals: services.approvals,
  sessions: services.sessionStore,
  bootstrap: services.bootstrap,
});
```

(Verify exact field names by running `grep -n "approvals:\|sessionStore:\|bootstrap:" src/daemon/services.ts` and matching what DaemonServices actually exposes.)

- [ ] **Step 4: Update the POST `/ui/approvals/:id/approve|deny` handler**

Find the existing handler (around line 74 of `ui-server.ts`). The approve branch needs to:
1. Read the optional `{ session: { ttl_minutes } }` body via `readBoundedJson(req, 1024, { allowEmpty: true })` from the relocated helper (Task 2b.1).
2. After recording the approval grant (existing behavior), if the session affordance was checked, derive patterns from the batch's plan and mint sessions.

```ts
    // BURST 5: read optional session-on-approve body. allowEmpty:true so a
    // legacy approve POST with no body still works (the existing UI form
    // sends an empty POST when the checkbox is unchecked).
    const sessionBody = await readBoundedJson(req, 1024, { allowEmpty: true }) as { session?: { ttl_minutes?: number } };

    const sessionRequest = sessionBody.session;
    if (sessionRequest && typeof sessionRequest === "object") {
      const ttl_minutes = sessionRequest.ttl_minutes;
      if (![5, 15, 30, 60].includes(ttl_minutes as number)) {
        throw new ShuttleError("bad_request", `ttl_minutes must be one of 5, 15, 30, 60; got ${ttl_minutes}.`);
      }
      const ttl_ms = (ttl_minutes as number) * 60 * 1000;

      // The bootstrap batch_id is stored at grant.template_params.batch_id
      // (set by the bootstrap route at src/daemon/api/routes/bootstrap.ts:107),
      // NOT a top-level grant.batch_id.
      const batchId = grant.template_params?.batch_id;
      if (typeof batchId === "string") {
        const batch = await deps.bootstrap.get(batchId);
        if (batch !== null) {
          const { patterns } = inferSessionPatternFromPlan(batch.plan, ttl_ms);

          // All-or-nothing rollback. SessionStore exposes `revoke(id)`
          // (src/daemon/approvals/session-store.ts:69) — there is NO delete()
          // method. revoke flips status to "revoked" so the grant becomes
          // immediately unconsumable, which is the correct rollback semantics.
          const createdIds: string[] = [];
          try {
            for (const pattern of patterns) {
              const sess = deps.sessions.createForOwner(pattern, grant.owner_agent_id);
              createdIds.push(sess.id);
              // Auto-approve — patterns came from the card the user just
              // approved, so they go straight to status: granted.
              deps.sessions.approve(sess.id);
            }
          } catch (err) {
            for (const id of createdIds) {
              try { deps.sessions.revoke(id); } catch { /* swallow — best-effort rollback */ }
            }
            throw err;
          }
        }
      }
    }
```

Import additions at top of file:
```ts
import { readBoundedJson } from "../helpers/bounded-json.js";
import { inferSessionPatternFromPlan } from "./infer-session-pattern.js";
```

Notes:
- `grant.template_params.batch_id` — verified via `grep -n "batch_id\|template_params" src/daemon/api/routes/bootstrap.ts | head -10` (line 107 sets it on the binding).
- `SessionStore.revoke(id)` (NOT `delete`) — see `src/daemon/approvals/session-store.ts:69`.
- `SessionStore.approve(id)` is the existing method that flips status `pending → granted` and resets `expires_at` to `now + ttl_ms`.

- [ ] **Step 5: Run tests**

Run: `npm test -- --test-name-pattern "approval-ui-creates-sessions"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/approvals/ui-server.ts src/daemon/api/router.ts src/daemon/approvals/approval-ui-creates-sessions.test.ts
git commit -m "feat(approval-ui): approve route mints session grants from BatchState.plan (DI expanded; all-or-nothing rollback via revoke)"
```

---

### Task 2b.5: Add the session-affordance footer to `ui.html` + drift-guard test

**Files:**
- Modify: `src/daemon/approvals/ui.html`
- Modify: `src/daemon/approvals/ui-html-drift.test.ts`

- [ ] **Step 1: Read current ui.html**

Run: `wc -l src/daemon/approvals/ui.html && grep -n "form\|button\|approve\|deny" src/daemon/approvals/ui.html | head -20`

- [ ] **Step 2: Add the affordance HTML**

In `src/daemon/approvals/ui.html`, locate the approve/deny button form. Just above it, conditionally render the affordance when the approval action is `bootstrap` AND the derived pattern set is non-empty.

Server-side: the approval-card template gets two new substitution tokens:
- `__SESSION_AFFORDANCE_HTML__` — server-rendered chunk containing the checkbox + dropdown + pattern list (or empty string when not applicable).
- `__SESSION_EXCLUDED_HTML__` — server-rendered notice for excluded destinations (or empty string).

For an initial drop, hard-code the HTML structure in `ui-server.ts` where the template is loaded and substituted:
```html
<fieldset id="session-affordance" style="margin: 1em 0; padding: 0.75em; border: 1px solid #ddd;">
  <label>
    <input type="checkbox" id="session-on-approve" name="session_on_approve" />
    Also approve any matching shape for the next
    <select name="ttl_minutes" id="ttl-minutes">
      <option value="5">5 min</option>
      <option value="15" selected>15 min</option>
      <option value="30">30 min</option>
      <option value="60">60 min</option>
    </select>
  </label>
  <p>This would let the same secret(s) be pushed again to the exact destinations below, within the time window:</p>
  <ul id="session-pattern-list">
    __PATTERN_LINES_HTML__
  </ul>
  <p>Different env-var names, environments, repos, or projects are NOT covered.</p>
  <p style="font-size: 90%;">
    Revoke any time: <code>secret-shuttle internal session revoke &lt;session-id&gt;</code>
  </p>
</fieldset>
```

And in `ui-server.ts` where the template is substituted, derive `__PATTERN_LINES_HTML__` from `inferSessionPatternFromPlan(batch.plan)` (call it server-side at GET-time for the approval card). Each line:
```html
<li><code>{template_id}</code> &nbsp; <code>{ref_glob}</code> &nbsp; {required_params as k=v list}</li>
```

For excluded destinations, render a separate `<p>` block above the buttons.

The approve form's POST body now needs the checkbox state. The simplest implementation: client-side JS reads the checkbox + dropdown and includes `{ session: { ttl_minutes: N } }` in the POST body when checked. Existing forms in `ui.html` likely already use JS for the POST — find that block and extend it.

- [ ] **Step 3: Update the drift-guard test**

Extend `src/daemon/approvals/ui-html-drift.test.ts`:
```ts
test("ui.html contains session-affordance container", async () => {
  const html = await readFile("src/daemon/approvals/ui.html", "utf8");
  assert.match(html, /id="session-affordance"/);
  assert.match(html, /name="session_on_approve"/);
  assert.match(html, /name="ttl_minutes"/);
  assert.match(html, /__PATTERN_LINES_HTML__/);
});
```

- [ ] **Step 4: Run tests + visual inspection**

Run: `npm test -- --test-name-pattern "ui-html-drift"`
Expected: PASS.

Optional: run the daemon and hit `/ui/approvals/:id?token=...` in a browser to confirm the affordance renders.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/ui.html src/daemon/approvals/ui-html-drift.test.ts
git commit -m "feat(approval-ui): session-affordance footer with checkbox + ttl dropdown + pattern list"
```

---

### Task 2b.6: Daemon-side auto-application of matching sessions

**Files:**
- Modify: `src/daemon/approvals/require-approvals.ts`
- Create: `src/daemon/approvals/require-approvals-auto-match.test.ts`

**Architecture note (read before writing code):** `requireApprovals` already has a two-phase plan/commit shape (see `src/daemon/approvals/require-approvals.ts:55-80` and the function header comment at lines 34-54). Phase 1 builds an array of `Plan` entries — one of `{kind: "synth"}`, `{kind: "session"}`, `{kind: "consume", id}`, or `{kind: "mint"}`. Phase 2 commits them. The auto-match logic adds a new sub-case to Phase 1's per-binding planning step: before falling through to `kind: "mint"`, look for a matching owned active session and plan it as `kind: "session"` (the existing kind, which is already wired to phase 2 via `mintFromSession`).

Real option names (verified):
- `opts.approvalIdsFromClient` (NOT `approval_ids`)
- `opts.sessionId` (NOT `session_id`)
- `opts.sessionStore` (already optional on the options interface)
- Session fields: `uses: number` (incremented), `max_uses?: number` (cap) — NOT `uses_remaining`. The matcher's max-uses check is `s.max_uses === undefined || s.uses < s.max_uses`.

Reuse existing primitives:
- `matchesSessionPattern(binding, pattern)` from `session-matchers.ts:5` — pure boolean.
- The session-consume side effect during commit goes through whatever the existing `kind: "session"` branch does (`mintFromSession` / `consumeFromSession`-equivalent). Do NOT re-invent the mint path.

- [ ] **Step 1: Write the failing test**

Create `src/daemon/approvals/require-approvals-auto-match.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Use the existing test scaffolding from require-approvals.test.ts and
// session-store.test.ts. If a higher-level `withDaemonForTest` helper does
// not exist in src/test-helpers/, run:
//   grep -rn "function withDaemonForTest\|export async function with" src/
// to find the canonical name and import accordingly. The plan-level test
// description below assumes the existing pattern works at the
// requireApprovals unit level (test imports requireApprovals + constructs
// in-memory ApprovalStore / SessionStore stubs as the existing
// require-approvals.test.ts does at the top of that file).
import { requireApprovals } from "./require-approvals.js";
import { ApprovalStore } from "./store.js";
import { SessionStore } from "./session-store.js";
import { withAuthContext } from "../auth/auth-context.js";

test("active matching session silently satisfies a template-run requireApprovals call", async () => {
  const approvals = new ApprovalStore();
  const sessions = new SessionStore({ now: () => 1_000_000 });

  // Set up: mint + approve a matching session for agent claude-abc
  await withAuthContext({ agent_id: "claude-abc" }, async () => {
    const sess = sessions.createForOwner({
      actions: ["template-run"],
      ref_glob: "ss://stripe/prod/STRIPE_KEY",
      destination_domains: ["vercel.com"],
      template_ids: ["vercel-env-add"],
      required_params: { name: "STRIPE_KEY", environment: "production" },
      ttl_ms: 15 * 60 * 1000,
    }, "claude-abc");
    sessions.approve(sess.id);

    // Call requireApprovals with NO approvalIdsFromClient, NO sessionId.
    // Auto-match should plan it as kind:"session" in phase 1 and proceed.
    const grants = await requireApprovals({
      store: approvals,
      sessionStore: sessions,
      daemonPort: 0,
      openUrlImpl: () => {},
      bindings: [{
        action: "template",  // stored as "template" — canonicalAction maps to "template-run"
        ref: "ss://stripe/prod/STRIPE_KEY",
        template_id: "vercel-env-add",
        template_params: { name: "STRIPE_KEY", environment: "production" },
        destination_domain: null,
        environment: "production",
      } as any],
    });
    assert.equal(grants.length, 1);
  });
});

test("expired session skipped during auto-match — falls through to approval prompt", async () => {
  // Construct a session whose expires_at is in the past; requireApprovals
  // without --no-wait should now block on a fresh mint (test by passing
  // waitMs: 1 and asserting approval_timeout, or by using --no-wait
  // semantics and asserting approval_required).
});

test("max_uses race retry-once: session is consumed mid-plan → fall through to mint", async () => {
  // Mint a session with max_uses: 1. Consume it via a parallel call (or
  // bump `uses` directly on the grant). The new requireApprovals call
  // should see the candidate, attempt to plan it as kind:"session", and
  // when mintFromSession throws (or returns null) because uses === max_uses,
  // retry the candidate lookup once and then fall through to kind:"mint".
});
```

- [ ] **Step 2: Add the auto-match logic — fit into the existing two-phase architecture**

Open `src/daemon/approvals/require-approvals.ts`. Phase 1 builds an array of `Plan` entries (one per binding) — `synth` / `session` / `consume` / `mint`. The existing `session` kind is selected when `opts.sessionId` is supplied and matches. Auto-match adds the `session` kind *without* requiring an explicit `sessionId` — selected by scanning owned-active sessions whose pattern matches the binding.

Locate the per-binding planning step in Phase 1 (after the `approvalIdsFromClient` matching attempt, before the `synth`/`mint` fallback). Insert an auto-match attempt that returns a `{ kind: "session", binding, sessionId }` plan entry if a candidate matches. Phase 2 already handles the `session` kind via the same `mintFromSession` (or equivalent) primitive used when `opts.sessionId` is supplied — reuse it.

```ts
import { matchesSessionPattern } from "./session-matchers.js";
// (use `callerAgentId` already captured at line 64; do not re-read getCurrentAgentId())

function planFromAutoMatchedSession(
  binding: ApprovalBinding,
  sessionStore: SessionStore,
  ownerAgentId: string,
  now: number,
): Plan | null {
  // Candidate filter — owner-scoped, granted, not expired, has uses left
  const candidates = sessionStore.list()
    .filter((s) => s.owner_agent_id === ownerAgentId)
    .filter((s) => s.status === "granted")
    .filter((s) => s.expires_at > now)
    .filter((s) => s.max_uses === undefined || s.uses < s.max_uses)
    .sort((a, b) => (b.approved_at ?? 0) - (a.approved_at ?? 0));

  for (const candidate of candidates) {
    if (matchesSessionPattern(binding, candidate)) {
      // Return a `session` plan referencing this candidate. The retry-once
      // on max_uses race happens at commit time (Phase 2): if mintFromSession
      // throws because uses raced to max_uses, Phase 2 re-runs the
      // auto-match lookup once (skipping `candidate.id`) and either picks a
      // sibling candidate or falls through to kind:"mint" for this binding.
      return { kind: "session", binding, sessionId: candidate.id };
    }
  }
  return null;
}
```

Wiring point: in the existing per-binding planning loop in Phase 1, after the "supplied ID" branch and before the synth/mint default, add:
```ts
  // BURST 5 §2: auto-match owned active session when no explicit sessionId
  if (
    opts.sessionStore !== undefined &&
    opts.sessionId === undefined &&
    callerAgentId !== "root"  // root requests skip session auto-match — keep predictable behavior for admin tooling
  ) {
    const autoPlan = planFromAutoMatchedSession(binding, opts.sessionStore, callerAgentId, Date.now());
    if (autoPlan !== null) {
      plan.push(autoPlan);
      continue;  // next binding
    }
  }
```

Phase 2 race handling: in the commit step where `kind: "session"` is consumed (existing code), wrap the `mintFromSession` call. If it throws because `uses === max_uses` (race condition — another caller used the last slot since we planned), re-run `planFromAutoMatchedSession` excluding the exhausted candidate. If the second attempt returns a plan, consume that. Otherwise fall through to fresh-mint for this binding (re-enter Phase 1's `kind: "mint"` path for just this binding — implementation detail: build a `kind: "mint"` plan entry on the fly and commit it via the existing mint-and-wait code path).

(If the existing commit code does not cleanly support per-binding re-planning, the simplest fix is to surface a structured "race" outcome from the session commit and have the outer caller retry once. Document whichever approach lands in the implementation commit.)

- [ ] **Step 3: Run tests**

Run: `npm test -- --test-name-pattern "require-approvals-auto-match"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/approvals/require-approvals.ts src/daemon/approvals/require-approvals-auto-match.test.ts
git commit -m "feat(require-approvals): auto-match owned active sessions (most-recent-approved first, race-retry once)"
```

---

### Task 2b.7: `status` surfaces `active_sessions[]` (owner-scoped)

**Files:**
- Modify: `src/daemon/api/routes/status.ts`
- Modify: `src/cli/commands/status.ts`
- Create: `src/cli/commands/status-active-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/status-active-sessions.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, asAgent, call } from "../../test-helpers/daemon.js";

test("status --json includes active_sessions[] for the calling agent", async () => {
  await withDaemonForTest(async (ctx) => {
    await asAgent(ctx, "claude-abc", async () => {
      const s = await ctx.sessionStore.createForOwner({
        actions: ["template-run"],
        ref_glob: "ss://stripe/prod/STRIPE_KEY",
        destination_domains: ["vercel.com"],
        template_ids: ["vercel-env-add"],
        required_params: { name: "STRIPE_KEY", environment: "production" },
        ttl_ms: 15 * 60 * 1000,
      }, "claude-abc");
      ctx.sessionStore.approve(s.id);

      const status = await call(ctx, "GET", "/v1/status", null);
      assert.ok(Array.isArray(status.active_sessions));
      assert.equal(status.active_sessions.length, 1);
      assert.equal(status.active_sessions[0].id, s.id);
      assert.match(status.active_sessions[0].pattern_summary, /vercel-env-add/);
      assert.match(status.active_sessions[0].pattern_summary, /name=STRIPE_KEY/);
    });
  });
});

test("status active_sessions is owner-scoped (agent does not see other agents' sessions)", async () => {
  await withDaemonForTest(async (ctx) => {
    await asAgent(ctx, "claude-abc", async () => {
      await ctx.sessionStore.createForOwner({/* ... */} as any, "cursor-xyz"); // different owner
    });
    await asAgent(ctx, "claude-abc", async () => {
      const status = await call(ctx, "GET", "/v1/status", null);
      assert.equal(status.active_sessions.length, 0);
    });
  });
});
```

- [ ] **Step 2: Add the field to the status route**

Open `src/daemon/api/routes/status.ts`. Find where the status response is built. Add:
```ts
  const currentAgent = getCurrentAgentId();
  const active_sessions = currentAgent
    ? sessionStore.list()
        .filter((s) => s.owner_agent_id === currentAgent)
        .filter((s) => s.status === "granted")
        .filter((s) => s.expires_at > Date.now())
        .map((s) => ({
          id: s.id,
          pattern_summary: summarizePattern(s),
          expires_at: new Date(s.expires_at).toISOString(),
          minutes_remaining: Math.round((s.expires_at - Date.now()) / 60_000),
        }))
    : [];
  // ...add to response: { ...existing, active_sessions }
```

With helper:
```ts
function summarizePattern(s: SessionGrant): string {
  const action = s.actions[0] ?? "unknown";
  const refish = s.ref_glob || "*";
  const tmpl = s.template_ids?.[0] ? ` via ${s.template_ids[0]}` : "";
  const params = s.required_params
    ? ` (${Object.entries(s.required_params).map(([k, v]) => `${k}=${v}`).join(", ")})`
    : "";
  return `${action} on ${refish}${tmpl}${params}`;
}
```

- [ ] **Step 3: Update `src/cli/commands/status.ts` text mode**

In the text rendering, add a section showing active sessions:
```ts
if (status.active_sessions?.length) {
  lines.push(`Active sessions:`);
  for (const s of status.active_sessions) {
    lines.push(`  - ${s.pattern_summary} (expires in ${s.minutes_remaining} min)`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "active_sessions"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/status.ts src/cli/commands/status.ts src/cli/commands/status-active-sessions.test.ts
git commit -m "feat(status): surface owner-scoped active_sessions[] with pattern_summary + minutes_remaining"
```

---

## §4 — Audit + resume hint (Day 10)

### Task 4.1: Add durable audit fields to `DaemonAuditEvent`

**Files:**
- Modify: `src/daemon/audit.ts`

- [ ] **Step 1: Add fields**

In `src/daemon/audit.ts`, find the `DaemonAuditEvent` interface (around line 18). Add at the end (before closing brace):
```ts
  /**
   * Set on bootstrap_plan and bootstrap_step rows AND on template_run
   * rows written under bootstrapAuthority. Enables audit consumers
   * to group fine-grained template_run rows under the parent
   * bootstrap_step row via shared batch_id. See Burst 5 §4.
   */
  batch_id?: string;

  /** Set on bootstrap_step rows. The PlanEntry.source.kind. */
  source_kind?: string;

  /** Set on bootstrap_step rows. The human-readable destination shorthands (e.g., "vercel:production"). */
  destination_shorthands?: string[];

  /** Set on bootstrap_step rows. */
  destinations_ok_count?: number;

  /** Set on bootstrap_step rows. */
  destinations_failed_count?: number;
```

- [ ] **Step 2: Build to confirm types**

Run: `npm run build`
Expected: clean build (additive).

- [ ] **Step 3: Commit**

```bash
git add src/daemon/audit.ts
git commit -m "feat(audit): add durable fields batch_id, source_kind, destination_shorthands, *_count to DaemonAuditEvent"
```

---

### Task 4.2: Populate new audit fields in `bootstrap/executor.ts`

**Files:**
- Modify: `src/daemon/bootstrap/executor.ts`
- Create: `src/daemon/audit-fields-bootstrap-step.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/audit-fields-bootstrap-step.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
// Use the existing audit-test harness — see src/daemon/audit.test.ts
import { withTempShuttleHome, runMiniBootstrap } from "../test-helpers/audit.js";

test("bootstrap_step audit rows carry batch_id, source_kind, destination_shorthands, ok/failed counts", async () => {
  await withTempShuttleHome(async (paths) => {
    // Run a synthetic provision batch that has 1 entry pushing to 2 destinations
    const { batchId } = await runMiniBootstrap(/* ... */);
    const log = await readFile(paths.auditLog, "utf8");
    const rows = log.trim().split("\n").map((l) => JSON.parse(l));
    const stepRow = rows.find((r) => r.action === "bootstrap_step");
    assert.ok(stepRow, "expected at least one bootstrap_step row");
    assert.equal(stepRow.batch_id, batchId);
    assert.ok(["random_32_bytes", "random_64_bytes", "capture", "existing"].includes(stepRow.source_kind));
    assert.ok(Array.isArray(stepRow.destination_shorthands));
    assert.equal(typeof stepRow.destinations_ok_count, "number");
    assert.equal(typeof stepRow.destinations_failed_count, "number");
  });
});
```

- [ ] **Step 2: Update every `writeDaemonAudit({ action: "bootstrap_step", ... })` call in `src/daemon/bootstrap/executor.ts`**

Run: `grep -n 'bootstrap_step' src/daemon/bootstrap/executor.ts`

At each site, add the new fields. The executor already has access to `entry` (PlanEntry) and `state` (BatchState) at every call site. Example transform (line ~188+):
```ts
state.step_results[entry.secret] = { ok: false, error_code: errorCode, message };
await writeDaemonAudit({
  action: "bootstrap_step",
  ok: false,
  ref: entry.ref,
  batch_id: state.batch_id,
  source_kind: entry.source.kind,
  destination_shorthands: entry.destinations.map((d) => d.shorthand),
  destinations_ok_count: 0,
  destinations_failed_count: entry.destinations.length,
  error_code: errorCode,
  message,
});
```

For success rows (e.g., line ~228):
```ts
await writeDaemonAudit({
  action: "bootstrap_step",
  ok: !anyDestFailed,
  ref: entry.ref,
  batch_id: state.batch_id,
  source_kind: entry.source.kind,
  destination_shorthands: entry.destinations.map((d) => d.shorthand),
  destinations_ok_count: merged.filter((d) => d.ok).length,
  destinations_failed_count: merged.filter((d) => !d.ok).length,
});
```

Do this at every `bootstrap_step` audit call in `executor.ts`. Use the same fields for each — the per-call values come from local `entry` + `state` variables.

- [ ] **Step 3: Run tests**

Run: `npm test -- --test-name-pattern "audit-fields-bootstrap-step"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/executor.ts src/daemon/audit-fields-bootstrap-step.test.ts
git commit -m "feat(executor): bootstrap_step audit rows carry batch_id + source_kind + destination_shorthands + counts"
```

---

### Task 4.3: Forward `batch_id` to inner `template_run` audit rows under `bootstrapAuthority`

**Files:**
- Modify: every core function called from `executor.ts` that writes a `template_run` audit row (search for them):
- Create: `src/daemon/audit-fields-template-run-batch-id.test.ts`

- [ ] **Step 1: Identify call sites**

Run: `grep -rn 'action: "template_run"' src/daemon/`

- [ ] **Step 2: Pass `batch_id` from authority context to each writeDaemonAudit call**

For every `template_run` audit call that's inside a code path reached under `bootstrapAuthority`, accept a `batch_id?: string` parameter and include it on the audit row.

Concrete pattern: where `runTemplateCore` (or equivalent) is called from the executor, the executor already has `state.batch_id` and passes `bootstrapAuthority: { batchId }`. The core function needs to thread that through to its audit write.

- [ ] **Step 3: Write the test**

Create `src/daemon/audit-fields-template-run-batch-id.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withTempShuttleHome, runMiniBootstrap, runStandaloneTemplate } from "../test-helpers/audit.js";

test("template_run rows under bootstrapAuthority carry batch_id", async () => {
  await withTempShuttleHome(async (paths) => {
    const { batchId } = await runMiniBootstrap(/* ... */);
    const log = await readFile(paths.auditLog, "utf8");
    const rows = log.trim().split("\n").map((l) => JSON.parse(l));
    const tmplRow = rows.find((r) => r.action === "template_run");
    assert.ok(tmplRow);
    assert.equal(tmplRow.batch_id, batchId);
  });
});

test("standalone template_run (no bootstrap) does NOT have batch_id", async () => {
  await withTempShuttleHome(async (paths) => {
    await runStandaloneTemplate(/* ... */);
    const log = await readFile(paths.auditLog, "utf8");
    const tmplRow = log.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.action === "template_run");
    assert.ok(tmplRow);
    assert.equal(tmplRow.batch_id, undefined);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern "template-run-batch-id"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(audit): inner template_run rows under bootstrapAuthority forward batch_id"
```

---

### Task 4.4: Backward compat — older audit rows without new fields parse cleanly

**Files:**
- Create: `src/daemon/audit-fields-backwards-compat.test.ts`

- [ ] **Step 1: Write the test**

Create `src/daemon/audit-fields-backwards-compat.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";

const OLD_ROW = JSON.stringify({
  ts: "2026-05-26T00:00:00Z",
  action: "bootstrap_step",
  ok: true,
  ref: "ss://stripe/prod/STRIPE_KEY",
});

test("a synthetic legacy audit row parses as JSON", () => {
  const row = JSON.parse(OLD_ROW);
  assert.equal(row.action, "bootstrap_step");
  assert.equal(row.batch_id, undefined);
  assert.equal(row.source_kind, undefined);
});

// More tests live in the audit-summary route test (§4 Task 4.6) verifying
// the summary surface shows "—" or "(unknown)" for missing values.
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- --test-name-pattern "backwards-compat"
git add src/daemon/audit-fields-backwards-compat.test.ts
git commit -m "test(audit): legacy rows without new fields parse cleanly (regression guard)"
```

---

### Task 4.5: `failed_partial` batch response carries `next_action`

**Files:**
- Modify: `src/daemon/bootstrap/executor.ts`
- Create: `src/daemon/bootstrap/provision-resume-hint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/bootstrap/provision-resume-hint.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, runFailingBatch } from "../../test-helpers/daemon.js";

test("a batch ending failed_partial includes next_action: provision --continue --batch <id>", async () => {
  await withDaemonForTest(async (ctx) => {
    const { response, batchId } = await runFailingBatch(ctx /* plan one passing + one failing step */);
    assert.equal(response.batch_status, "failed_partial");
    assert.equal(response.next_action, `secret-shuttle provision --continue --batch ${batchId}`);
  });
});

test("an abandoned batch does NOT include next_action", async () => {
  // Abandon a batch, observe the abandon route response has no next_action
});

test("an expired-approval batch sets details.requires_new_approval=true and omits next_action", async () => {
  // Set the approval to expired, drive /continue, observe details.requires_new_approval
});
```

- [ ] **Step 2: Update `executor.ts` final response builder**

Find the location where the executor returns the final response (look for the `state.status = "failed_partial"` line). After building the response object, conditionally add:
```ts
const response: Record<string, unknown> = { /* existing fields */ };

if (state.status === "failed_partial" && !state.abandoned) {
  // Resume-hint case
  if (!state.approval_expired) {
    response.next_action = `secret-shuttle provision --continue --batch ${state.batch_id}`;
  } else {
    response.details = response.details ?? {};
    (response.details as any).requires_new_approval = true;
  }
}
```

(Field names depend on the actual `BatchState` — adjust accordingly.)

- [ ] **Step 3: Run tests**

Run: `npm test -- --test-name-pattern "resume-hint"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/executor.ts src/daemon/bootstrap/provision-resume-hint.test.ts
git commit -m "feat(executor): failed_partial response carries next_action (provision --continue --batch <id>)"
```

---

### Task 4.6: New `audit` CLI verb + `/v1/audit/summary` route

**Files:**
- Create: `src/cli/commands/audit.ts`
- Create: `src/cli/commands/audit.test.ts`
- Create: `src/daemon/api/routes/audit-summary.ts`
- Create: `src/daemon/api/routes/audit-summary.test.ts`
- Modify: `src/cli/index.ts` (register `auditCommand`)
- Modify: `src/daemon/api/routes.ts` or wherever routes are registered (mount `audit-summary.ts`)

- [ ] **Step 1: Write the CLI command shell**

Create `src/cli/commands/audit.ts`:
```ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";

function parseDuration(input: string): number {
  const m = input.match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new ShuttleError("audit_window_invalid", `Invalid --since '${input}'. Format: Ns/Nm/Nh/Nd.`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[unit];
}

export function auditCommand(): Command {
  const cmd = new Command("audit")
    .description("Summarize recent secret-shuttle activity for the calling agent.")
    .option("--since <duration>", "Window (e.g., 5m, 1h, 1d, 7d)")
    .option("--batch <id>", "Show one specific batch")
    .option("--all", "Root-only: include actions by all agents")
    .option("--json", "Machine-readable output", false)
    .action(async (opts: { since?: string; batch?: string; all?: boolean; json?: boolean }) => {
      const body: Record<string, unknown> = {};
      if (opts.since) body.since_ms = parseDuration(opts.since);
      if (opts.batch) body.batch_id = opts.batch;
      if (opts.all) body.include_all_actors = true;

      const r = await daemonRequest("POST", "/v1/audit/summary", body);
      if (opts.json) {
        outputJson(ok(r as Record<string, unknown>));
        return;
      }
      // Render text mode (humans read this; agents pass --json)
      process.stdout.write(renderText(r));
    });
  return cmd;
}

function renderText(r: any): string {
  // Implementation: pretty-print batches + standalone ops as in spec §4 "Output (text format)"
  const lines: string[] = [];
  lines.push(`Audit summary — ${r.since ?? "all available"}`);
  lines.push("─".repeat(45));
  for (const batch of r.summary.batches ?? []) {
    lines.push(`batch ${batch.id} (${batch.action ?? "?"})`);
    for (const step of batch.steps ?? []) {
      const mark = step.ok ? "✓" : "✗";
      const dests = (step.destinations ?? []).join(", ");
      lines.push(`  ${mark} ${step.ref ?? "?"}  ${step.source_kind ?? "(unknown)"} → ${dests || "(none)"}`);
      if (!step.ok && step.error_code) lines.push(`    error: ${step.error_code}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
```

- [ ] **Step 2: Write the route**

Create `src/daemon/api/routes/audit-summary.ts`:
```ts
import { readFile } from "node:fs/promises";
import type { DaemonServer } from "../../server.js";
import { ShuttleError } from "../../../shared/errors.js";
import { getCurrentAgentId } from "../../auth/auth-context.js";
import { getShuttlePaths } from "../../../shared/config.js";
import type { BootstrapStore } from "../../bootstrap/store.js";
import { asObject, optBool, optString } from "../validate.js";

export function registerAuditSummaryRoute(server: DaemonServer, deps: { bootstrapStore: BootstrapStore }): void {
  // server.addRoute handlers receive ALREADY-PARSED JSON via readJsonBody
  // (see src/daemon/server.ts:223). Use the existing asObject/req-helpers
  // pattern from src/daemon/api/routes/bootstrap.ts:31.
  server.addRoute("POST", "/v1/audit/summary", async (_req, raw) => {
    const o = asObject(raw);
    const actorAgent = getCurrentAgentId();
    const includeAll = optBool(o, "include_all_actors") === true && actorAgent === "root";
    const sinceMs = typeof o.since_ms === "number" ? o.since_ms : null;
    const batchIdReq = optString(o, "batch_id") ?? null;

    if (batchIdReq) {
      const live = await deps.bootstrapStore.get(batchIdReq);
      if (live !== null && (includeAll || live.owner_agent_id === actorAgent)) {
        return { ok: true, summary: { batches: [serializeBatchFromState(live)], individual_ops: [] } };
      }
      // Fallback: reconstruct from audit log
      const rows = await readAuditRows();
      const matching = rows.filter((r) => r.batch_id === batchIdReq);
      if (matching.length === 0 || (!includeAll && !matching.some((r) => r.actor_agent_id === actorAgent))) {
        throw new ShuttleError("audit_batch_not_found", `Batch ${batchIdReq} not found.`);
      }
      return { ok: true, summary: { batches: [reconstructBatchFromRows(matching)], individual_ops: [] }, details: { reconstructed_from: "audit" } };
    }

    // --since path
    const cutoff = sinceMs !== null ? Date.now() - sinceMs : 0;
    const rows = (await readAuditRows()).filter((r) => Date.parse(r.ts) >= cutoff);
    const scoped = includeAll ? rows : rows.filter((r) => r.actor_agent_id === actorAgent);
    const batches = groupByBatchId(scoped);
    const individual_ops = scoped.filter((r) => !r.batch_id && isUserFacingAction(r.action));

    return {
      ok: true,
      since: sinceMs !== null ? `${Math.round(sinceMs / 60_000)}m` : "all",
      now: new Date().toISOString(),
      summary: { batches, individual_ops },
    };
  });
}

async function readAuditRows(): Promise<any[]> {
  const paths = getShuttlePaths();
  try {
    const content = await readFile(paths.auditLog, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function serializeBatchFromState(state: any): any { /* shape per spec §4 JSON example */ return state; }
function reconstructBatchFromRows(rows: any[]): any { /* group by batch_id, fold counts */ return { id: rows[0].batch_id, steps: rows.filter((r) => r.action === "bootstrap_step") }; }
function groupByBatchId(rows: any[]): any[] { const m = new Map<string, any[]>(); for (const r of rows) { if (!r.batch_id) continue; (m.get(r.batch_id) ?? m.set(r.batch_id, []).get(r.batch_id))!.push(r); } return [...m.values()].map(reconstructBatchFromRows); }
function isUserFacingAction(a: string): boolean { return !["tokens_mint", "daemon_rotate", "daemon_reset_machine_id"].includes(a); }
```

(Refine the helpers to produce the JSON shape the spec §4 example shows.)

- [ ] **Step 3: Register the route + the CLI verb**

In `src/daemon/api/routes.ts` (or the file where routes are mounted), add:
```ts
import { registerAuditSummaryRoute } from "./routes/audit-summary.js";
// ...
registerAuditSummaryRoute(server, { bootstrapStore });
```

In `src/cli/index.ts`:
```ts
import { auditCommand } from "./commands/audit.js";
// ...
program.addCommand(auditCommand());
```

- [ ] **Step 4: Write the route test**

Create `src/daemon/api/routes/audit-summary.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaemonForTest, asAgent, runMiniBootstrap, call } from "../../../test-helpers/daemon.js";

test("audit --since returns owner-scoped batches grouped by batch_id", async () => {
  await withDaemonForTest(async (ctx) => {
    await asAgent(ctx, "claude-abc", async () => {
      await runMiniBootstrap(ctx /* plan */);
      const r = await call(ctx, "POST", "/v1/audit/summary", { since_ms: 5 * 60 * 1000 });
      assert.ok(r.summary.batches.length >= 1);
    });
  });
});

test("audit --batch <id> reads BootstrapStore first; audit log fallback when pruned", async () => {
  // Create a batch, then delete from BootstrapStore, then query; assert reconstructed_from=audit
});

test("audit --batch <other-owner>'s-batch → audit_batch_not_found (non-disclosure)", async () => { /* ... */ });
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --test-name-pattern "audit"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(audit): new --since/--batch summary verb + /v1/audit/summary route (owner-scoped, JSON + text)"
```

---

### Task 4.7: Discoverability — README header + `--help` no-args agent quickstart

**Files:**
- Modify: `README.md`
- Modify: `src/cli/index.ts` (description / help text)
- Create: `src/cli/commands/cli-help-discoverability.test.ts`

- [ ] **Step 1: Add the README callout**

Open `README.md`. Just above the existing `# Secret Shuttle` heading (line 1), add a blockquote:
```markdown
> **Reading this as an AI coding agent?** Your starting point is [skills/secret-shuttle/SKILL.md](skills/secret-shuttle/SKILL.md) (raw URL: `https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md`). The SKILL is your operational manual; this README is for humans.

```

- [ ] **Step 2: Update `src/cli/index.ts` description**

Find the existing `program.description(...)` or `program.name(...)` call. Update or add:
```ts
program
  .name("secret-shuttle")
  .description("Local-daemon CLI for AI coding agents.\nAGENT QUICKSTART: read skills/secret-shuttle/SKILL.md or run `secret-shuttle help`.");
```

- [ ] **Step 3: Write the test**

Create `src/cli/commands/cli-help-discoverability.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execp = promisify(execFile);
const CLI = join(process.cwd(), "dist/cli/index.js");

test("--help mentions AGENT QUICKSTART + SKILL.md", async () => {
  const r = await execp("node", [CLI, "--help"]);
  assert.match(r.stdout, /AGENT QUICKSTART/);
  assert.match(r.stdout, /SKILL\.md/);
});
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- --test-name-pattern "AGENT QUICKSTART\|cli-help"
git add README.md src/cli/index.ts src/cli/commands/cli-help-discoverability.test.ts
git commit -m "feat(cli, docs): agent-quickstart callout in README and --help no-args"
```

---

## §3 — SKILL.md restructure + drift guard (Days 11–13)

### Task 3.1: Restructure SKILL.md to layered format

**Files:**
- Modify: `skills/secret-shuttle/SKILL.md`

- [ ] **Step 1: Read current SKILL.md to understand what exists**

Run: `wc -l skills/secret-shuttle/SKILL.md`

- [ ] **Step 2: Rewrite above-the-fold (target ≤60 lines before `---`)**

Replace the top of the file with the layered structure per spec §3 "Above-the-fold draft":
- Tagline (2 lines)
- 30-second quickstart (~15 lines code)
- Core verbs (~15 lines bullet list)
- What you see / never see (~5 lines)
- Error recovery (~15 lines table with 7-8 most-common codes)
- Horizontal rule `---` separator

The below-the-fold (`## Reference (read on demand)`) keeps the existing authentication, ownership, blind discipline, capture flow, low-level surface sections from the current SKILL.md — verbatim except for:
- Remove every mention of `bootstrap` verb (replaced by `provision`)
- Remove mentions of `list`, `inspect`, `generate`, `doctor` shims (deleted in §1)
- Update any `--help` examples to reflect new verb names

Use the spec §3 illustrative draft as the structural template. Replace `<batch_id>` and `<approval_id>` placeholders with `<batch_id_from_prior_step>` / `<approval_id_from_prior_step>` and ensure prose names them as "ids the previous step returned" (per §3 "Above-the-fold structure rules").

- [ ] **Step 3: Verify total line count above the fold ≤ 60**

Run: `grep -n "^---$" skills/secret-shuttle/SKILL.md | head -1`
Expected: the first `---` line number is ≤ 65 (some slack for blank lines).

- [ ] **Step 4: Commit**

```bash
git add skills/secret-shuttle/SKILL.md
git commit -m "docs(skill): layered restructure — quickstart + core verbs + errors above the fold (≤60 lines)"
```

---

### Task 3.2: Drift-guard test for SKILL.md shape

**Files:**
- Create: `src/cli/commands/skill-md-shape.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_PATH = join(process.cwd(), "skills/secret-shuttle/SKILL.md");

test("SKILL.md above-the-fold is ≤ 65 lines (≤60 + slack)", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  const lines = content.split("\n");
  const fenceIdx = lines.findIndex((l) => l.trim() === "---" && lines.indexOf(l) > 0);
  assert.ok(fenceIdx > 0 && fenceIdx <= 65, `above-the-fold spans ${fenceIdx} lines (target ≤65)`);
});

test("SKILL.md quickstart uses `provision` not `bootstrap`", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  assert.match(content, /provision --infer/);
  assert.doesNotMatch(content, /^\s*secret-shuttle bootstrap\b/m);
});

test("SKILL.md error table includes top-tier codes", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  for (const code of [
    "daemon_not_running",
    "vault_locked",
    "approval_required",
    "secret_not_found",
    "infer_no_env_example",
  ]) {
    assert.match(content, new RegExp(code), `error table missing ${code}`);
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- --test-name-pattern "skill-md-shape"
git add src/cli/commands/skill-md-shape.test.ts
git commit -m "test(skill): drift guard — line count, provision-not-bootstrap, top error codes"
```

---

## Pre-Publish & Burst Wrap-up

### Task W.1: Dogfood pass

**Files:** ad-hoc

- [ ] **Step 1: Create a throwaway test project**

```bash
mkdir /tmp/ss-dogfood-$$
cd /tmp/ss-dogfood-$$
echo "STRIPE_WEBHOOK_SECRET=" > .env.example
echo "INTERNAL_CRON_SECRET=" >> .env.example
echo "DATABASE_URL=" >> .env.example
echo "{}" > vercel.json
```

- [ ] **Step 2: Run `provision --infer --dry-run` and inspect**

```bash
secret-shuttle provision --infer --dry-run
```

Verify:
- Generated yml contains 3 entries
- `STRIPE_WEBHOOK_SECRET` has capture source pointing at `/webhooks`
- `INTERNAL_CRON_SECRET` is random_32_bytes
- `DATABASE_URL` is existing with a TODO comment
- Destinations include `vercel:production`

- [ ] **Step 3: Hand the SKILL.md URL to a fresh Claude/Cursor session and watch**

Save notes to `docs/dogfood/2026-05-XX-burst5-notes.md` — friction points become v0.3.1 backlog.

- [ ] **Step 4: Commit notes**

```bash
git add docs/dogfood/
git commit -m "docs(dogfood): Burst 5 — fresh-agent walkthrough notes"
```

---

### Task W.2: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a Burst 5 section to the top of CHANGELOG.md**

Use the spec's §0/§5/§9 as the source of truth — summarize what shipped per section, list new error codes, breaking changes (bootstrap removal, deprecated shims removal, TTL cap raise), and known limitations.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(CHANGELOG): Burst 5 — Magic Polish (provision verb, session affordance, audit, SKILL restructure)"
```

---

### Task W.3: Version bump + npm publish

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Edit `package.json`:
```diff
- "version": "0.1.1",
+ "version": "0.3.0",
```

(0.2.x was the previous shipped baseline per the spec; 0.3.0 is this burst's target.)

- [ ] **Step 2: Run the full test suite + check-pack**

```bash
npm run check-pack
```

Expected: green build, green tests, packing succeeds, files included match the `package.json` `files` whitelist.

- [ ] **Step 3: Tag and publish (only when ready to ship)**

```bash
git add package.json
git commit -m "chore: bump to 0.3.0 (Burst 5)"
git tag v0.3.0
npm publish --access public
git push origin main --tags
```

- [ ] **Step 4: Verify install from clean state**

```bash
cd /tmp && npx secret-shuttle@0.3.0 --help
```

Expected: AGENT QUICKSTART line + verb list including `provision`, `audit`.

---

## Self-Review Notes

**Spec coverage check (run after writing this plan):**
- §1 (provision + --infer + bootstrap removal) — Tasks 1.1–1.7 ✓
- §2 Template-param primitive — Tasks 2a.1–2a.10 ✓
- §2 Approval-UI affordance — Tasks 2b.1–2b.7 ✓
- §3 SKILL.md restructure — Tasks 3.1–3.2 ✓
- §4 audit + resume + discoverability — Tasks 4.1–4.7 ✓
- §5 Implementation order — mirrored in the plan structure ✓
- §6 Test posture — every TDD task has a test step ✓
- §7 Out of scope — not built (correctly) ✓
- §8 Risks — config-drift coverage via Task 2a.5 startup hook + Task 2a.6 wiring ✓
- §9 Success criteria — exercised in Task W.1 dogfood pass ✓

**Known intentional placeholders in this plan:**
- Test-harness helper imports (e.g., `withDaemonForTest`, `mintBootstrapApproval`) reference helpers that may not yet exist in `src/test-helpers/`. If they don't, the first task that uses one should add a minimal scaffolding step. Grep first; if the helper exists under a different path, fix the import. If it doesn't, factor it out from existing test patterns in `src/daemon/api/routes/*.test.ts`.
- Some "find the existing X" steps direct the engineer to grep before editing — this is intentional because the precise line numbers will shift as the burst progresses.
- The `runMiniBootstrap` / `runFailingBatch` helpers in §4 tests need to be defined alongside the audit tests when first introduced — see existing patterns in `src/daemon/bootstrap/executor.test.ts`.

These are not free-form TODOs; they are bounded discovery steps the engineer performs before touching a specific known line.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-burst5-magic-polish.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
