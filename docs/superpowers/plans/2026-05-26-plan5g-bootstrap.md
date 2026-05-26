# Plan 5g — `secret-shuttle bootstrap` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `secret-shuttle bootstrap` — read `secret-shuttle.yml`, diff against vault, mint ONE bootstrap-action approval covering the whole plan, return `approval_required`; on `--continue --approval-id`, walk plan + call existing primitives (`secrets generate`, `reveal-capture`, `templates run`) under the bootstrap approval's authority.

**Architecture:** Thin orchestrator over existing primitives. `secret-shuttle.yml` parsed via the `yaml` library. Bootstrap mints a single `ApprovalBinding` of new action `"bootstrap"`. Internal executor reuses existing route handlers' CORE LOGIC (refactored into exported functions) bypassing the inner `requireApprovals` call via a `bootstrap_authority: { batchId }` context. Diff-based idempotency + per-step partial-success enum.

**Tech Stack:** TypeScript strict, ESM (.js suffixes), Node 20+, node:test, `yaml@^2.x` (new dep), existing approval/audit/template primitives.

---

## File structure

**New files:**
- `src/cli/bootstrap/yml.ts` + test — parses + validates `secret-shuttle.yml`.
- `src/cli/bootstrap/destination-shorthand.ts` + test — `vercel:production` → `(template_id, template_params)`.
- `src/cli/commands/bootstrap.ts` + test — CLI entry.
- `src/daemon/bootstrap/plan.ts` + test — diff logic.
- `src/daemon/bootstrap/store.ts` + test — `BootstrapStore` (in-memory + disk persistence).
- `src/daemon/bootstrap/executor.ts` + test — walks plan, calls primitives.
- `src/daemon/api/routes/bootstrap.ts` + test — 4 routes (plan, continue, abandon, list).

**Modified files:**
- `package.json` — add `yaml` dep.
- `src/daemon/approvals/store.ts:16` — extend `ApprovalBinding.action` with `"bootstrap"`.
- `src/daemon/audit.ts:5-15` — add `"bootstrap_plan"`, `"bootstrap_step"` to `DaemonAuditAction` union.
- `src/shared/error-codes.ts` — add 3 codes (`bootstrap_plan_invalid`, `bootstrap_batch_not_found`, `bootstrap_destination_unknown`).
- `src/shared/error-codes.test.ts` — count + lookup tests.
- `src/daemon/api/router.ts` — register `registerBootstrapRoutes`.
- `src/daemon/api/routes/secrets.ts` — extract `generateSecretCore()` exported function; HTTP handler delegates to it.
- `src/daemon/api/routes/reveal-capture.ts` — extract `revealCaptureCore()` exported function; HTTP handler delegates.
- `src/daemon/api/routes/templates.ts` — extract `runTemplateCore()` exported function; HTTP handler delegates.
- `src/cli/index.ts` — register bootstrap command.
- `src/daemon/approvals/ui.html` + `human[]` — bootstrap action copy.
- `src/cli/commands/init.test.ts:264` — rename `does NOT touch keychain` → `does NOT read or write the master key` (pre-work).

---

## Verification commands

Used throughout. Each task ends with these.

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

---

## Task A — Pre-work: init-test wording fix

**File:** `src/cli/commands/init.test.ts`

- [ ] **Step 1**: locate the test:

```bash
grep -n "does NOT touch keychain" src/cli/commands/init.test.ts
```

- [ ] **Step 2**: rename the test title. Current shape:

```ts
test("init: --no-keychain does NOT touch keychain even during the init run (P1 post-ship)", async () => {
```

Change to:

```ts
test("init: --no-keychain does NOT read or write the master key during the init run (P1 post-ship)", async () => {
```

The body asserts the security property correctly (no get/set on the real key); the title just becomes accurate.

- [ ] **Step 3**: verify

```bash
npm test -- src/cli/commands/init.test.ts 2>&1 | tail -10
```

Expected: same tests pass, the renamed one shows under its new title.

- [ ] **Step 4**: commit

```bash
git add src/cli/commands/init.test.ts
git commit -m "$(cat <<'EOF'
test(init): rename --no-keychain test to match what it asserts

The test title said "does NOT touch keychain" but init still calls
/v1/keychain/disable which invokes isAvailable/delete for cleanup.
The actual security property the body asserts is "does NOT read or
write the master key" — rename to match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B — Add `yaml` dependency

- [ ] **Step 1**: install

```bash
npm install yaml --save
```

- [ ] **Step 2**: verify import

```bash
node -e "import('yaml').then(m => console.log('OK:', Object.keys(m).slice(0, 8)))"
```

Expected: prints exports including `parse`, `stringify`, `parseDocument`.

- [ ] **Step 3**: typecheck

```bash
npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 4**: commit

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): add yaml for secret-shuttle.yml parsing

Plan 5g prereq. Bootstrap reads secret-shuttle.yml via the `yaml`
library (eemeli/yaml) — small, well-maintained, used by vite + webpack.
Manual regex parsing rejected as too brittle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C — YAML parser + validator

**Files:**
- Create: `src/cli/bootstrap/yml.ts`
- Create: `src/cli/bootstrap/yml.test.ts`

- [ ] **Step 1**: write failing tests

`src/cli/bootstrap/yml.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { parseBootstrapYml } from "./yml.js";
import { ShuttleError } from "../../shared/errors.js";

test("parseBootstrapYml: valid plan with all source kinds", () => {
  const yml = `
version: 1
secrets:
  STRIPE_KEY:
    source: { kind: capture, url: https://stripe.com }
    destinations: [vercel:production]
  CRON_SECRET:
    source: { kind: random_32_bytes }
    destinations: [vercel:production]
  EXISTING_API:
    source: { kind: existing, ref: ss://local/prod/EXISTING_API }
    destinations: [vercel:production]
`;
  const plan = parseBootstrapYml(yml);
  assert.strictEqual(plan.version, 1);
  assert.strictEqual(plan.secrets.length, 3);
  assert.strictEqual(plan.secrets[0].name, "STRIPE_KEY");
  assert.strictEqual(plan.secrets[0].source.kind, "capture");
  if (plan.secrets[0].source.kind === "capture") {
    assert.strictEqual(plan.secrets[0].source.url, "https://stripe.com");
  }
});

test("parseBootstrapYml: rejects unknown version", () => {
  const yml = `version: 99\nsecrets: {}`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects bad env-var name", () => {
  const yml = `
version: 1
secrets:
  lowercase_bad:
    source: { kind: random_32_bytes }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects unknown source.kind", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: mystery }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects capture without url", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: capture }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects existing without ref", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: existing }
    destinations: [vercel:production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects empty destinations", () => {
  const yml = `
version: 1
secrets:
  FOO:
    source: { kind: random_32_bytes }
    destinations: []
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});

test("parseBootstrapYml: rejects malformed yaml", () => {
  const yml = "not: valid: yaml: ::: [";
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_plan_invalid",
  );
});
```

- [ ] **Step 2**: verify failure

```bash
npm test -- src/cli/bootstrap/yml.test.ts 2>&1 | tail -10
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3**: implement

`src/cli/bootstrap/yml.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { ShuttleError } from "../../shared/errors.js";

export type BootstrapSource =
  | { kind: "capture"; url: string }
  | { kind: "random_32_bytes" }
  | { kind: "random_64_bytes" }
  | { kind: "existing"; ref: string };

export interface BootstrapPlanSecret {
  name: string;
  source: BootstrapSource;
  destinations: string[];  // shorthand strings (resolved by destination-shorthand.ts)
}

export interface BootstrapPlan {
  version: 1;
  secrets: BootstrapPlanSecret[];
}

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

function fail(message: string): never {
  throw new ShuttleError("bootstrap_plan_invalid", message);
}

export function parseBootstrapYml(yml: string): BootstrapPlan {
  let parsed: unknown;
  try {
    parsed = parseYaml(yml);
  } catch (e) {
    fail(`yaml parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("top-level must be a mapping");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    fail(`unsupported version: ${String(root.version)} (only version: 1 supported)`);
  }
  const secretsRaw = root.secrets;
  if (secretsRaw === null || typeof secretsRaw !== "object" || Array.isArray(secretsRaw)) {
    fail("`secrets` must be a mapping of name → entry");
  }
  const secrets: BootstrapPlanSecret[] = [];
  for (const [name, entryRaw] of Object.entries(secretsRaw as Record<string, unknown>)) {
    if (!ENV_VAR_NAME.test(name)) {
      fail(`secret name "${name}" must match ${ENV_VAR_NAME}`);
    }
    if (entryRaw === null || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      fail(`secrets.${name}: must be a mapping`);
    }
    const entry = entryRaw as Record<string, unknown>;
    const source = parseSource(name, entry.source);
    const destinations = parseDestinations(name, entry.destinations);
    secrets.push({ name, source, destinations });
  }
  return { version: 1, secrets };
}

function parseSource(secretName: string, raw: unknown): BootstrapSource {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`secrets.${secretName}.source: must be a mapping with { kind }`);
  }
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (kind === "capture") {
    if (typeof s.url !== "string" || s.url.length === 0) {
      fail(`secrets.${secretName}.source: kind=capture requires url`);
    }
    return { kind: "capture", url: s.url };
  }
  if (kind === "random_32_bytes") return { kind: "random_32_bytes" };
  if (kind === "random_64_bytes") return { kind: "random_64_bytes" };
  if (kind === "existing") {
    if (typeof s.ref !== "string" || !s.ref.startsWith("ss://")) {
      fail(`secrets.${secretName}.source: kind=existing requires ref (ss://...)`);
    }
    return { kind: "existing", ref: s.ref };
  }
  fail(`secrets.${secretName}.source.kind: unknown "${String(kind)}" (allowed: capture, random_32_bytes, random_64_bytes, existing)`);
}

function parseDestinations(secretName: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    fail(`secrets.${secretName}.destinations: must be an array`);
  }
  if (raw.length === 0) {
    fail(`secrets.${secretName}.destinations: must have at least one entry`);
  }
  const out: string[] = [];
  for (const d of raw) {
    if (typeof d !== "string" || d.length === 0) {
      fail(`secrets.${secretName}.destinations: entries must be non-empty strings`);
    }
    out.push(d);
  }
  return out;
}
```

- [ ] **Step 4**: verify pass

```bash
npm run typecheck && npm test -- src/cli/bootstrap/yml.test.ts 2>&1 | tail -10
```

Expected: 8 tests pass.

- [ ] **Step 5**: commit

```bash
git add src/cli/bootstrap/yml.ts src/cli/bootstrap/yml.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): yml parser + validator

Plan 5g step 1. parseBootstrapYml() reads secret-shuttle.yml,
validates the schema, and returns a typed BootstrapPlan. All
validation failures throw ShuttleError("bootstrap_plan_invalid", ...).

Validates: version === 1, secret names match ^[A-Z][A-Z0-9_]*$,
source.kind is one of {capture, random_32_bytes, random_64_bytes,
existing}, capture has url, existing has ss:// ref, destinations
is non-empty string array.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task D — Destination shorthand resolver

**Files:**
- Create: `src/cli/bootstrap/destination-shorthand.ts`
- Create: `src/cli/bootstrap/destination-shorthand.test.ts`

- [ ] **Step 1**: write failing tests

```ts
import { test } from "node:test";
import assert from "node:assert";
import { resolveDestinationShorthand } from "./destination-shorthand.js";
import { ShuttleError } from "../../shared/errors.js";

test("vercel:production → vercel-env-add template", () => {
  const r = resolveDestinationShorthand("vercel:production", "API_KEY");
  assert.deepStrictEqual(r, {
    template_id: "vercel-env-add",
    template_params: { name: "API_KEY", environment: "production" },
    domain: "vercel.com",
  });
});

test("vercel:preview", () => {
  const r = resolveDestinationShorthand("vercel:preview", "API_KEY");
  assert.strictEqual(r.template_params.environment, "preview");
});

test("vercel:development", () => {
  const r = resolveDestinationShorthand("vercel:development", "API_KEY");
  assert.strictEqual(r.template_params.environment, "development");
});

test("github-actions:owner/repo → github-actions-secret-set", () => {
  const r = resolveDestinationShorthand("github-actions:acme/widgets", "API_KEY");
  assert.strictEqual(r.template_id, "github-actions-secret-set");
  assert.strictEqual(r.template_params.repo, "acme/widgets");
  assert.strictEqual(r.template_params.name, "API_KEY");
  assert.strictEqual(r.domain, "github.com");
});

test("cloudflare:production → cloudflare-secret-put", () => {
  const r = resolveDestinationShorthand("cloudflare:production", "API_KEY");
  assert.strictEqual(r.template_id, "cloudflare-secret-put");
});

test("supabase:projectref → supabase-edge-secret-set", () => {
  const r = resolveDestinationShorthand("supabase:abcdefg", "API_KEY");
  assert.strictEqual(r.template_id, "supabase-edge-secret-set");
});

test("unknown provider → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("netlify:production", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});

test("malformed shorthand (no colon) → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("just-a-string", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});

test("vercel:invalid-env → bootstrap_destination_unknown", () => {
  assert.throws(
    () => resolveDestinationShorthand("vercel:staging", "API_KEY"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_destination_unknown",
  );
});
```

- [ ] **Step 2**: verify failure

```bash
npm test -- src/cli/bootstrap/destination-shorthand.test.ts 2>&1 | tail -10
```

- [ ] **Step 3**: implement

`src/cli/bootstrap/destination-shorthand.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";

export interface ResolvedDestination {
  template_id: string;
  template_params: Record<string, string>;
  /** Display-only: the provider's primary domain for audit + UI. */
  domain: string;
}

function fail(shorthand: string, reason: string): never {
  throw new ShuttleError(
    "bootstrap_destination_unknown",
    `destination "${shorthand}": ${reason}`,
  );
}

export function resolveDestinationShorthand(shorthand: string, secretName: string): ResolvedDestination {
  const colon = shorthand.indexOf(":");
  if (colon < 1) {
    fail(shorthand, "expected <provider>:<scope> format");
  }
  const provider = shorthand.slice(0, colon);
  const scope = shorthand.slice(colon + 1);
  if (scope.length === 0) {
    fail(shorthand, "scope after : must not be empty");
  }

  switch (provider) {
    case "vercel": {
      if (!["production", "preview", "development"].includes(scope)) {
        fail(shorthand, `vercel scope must be one of: production, preview, development`);
      }
      return {
        template_id: "vercel-env-add",
        template_params: { name: secretName, environment: scope },
        domain: "vercel.com",
      };
    }
    case "github-actions": {
      // Scope is "owner/repo".
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope)) {
        fail(shorthand, "github-actions scope must be owner/repo");
      }
      return {
        template_id: "github-actions-secret-set",
        template_params: { name: secretName, repo: scope },
        domain: "github.com",
      };
    }
    case "cloudflare": {
      return {
        template_id: "cloudflare-secret-put",
        template_params: { name: secretName, environment: scope },
        domain: "cloudflare.com",
      };
    }
    case "supabase": {
      return {
        template_id: "supabase-edge-secret-set",
        template_params: { name: secretName, project_ref: scope },
        domain: "supabase.com",
      };
    }
    default:
      fail(shorthand, `unknown provider "${provider}" (supported: vercel, github-actions, cloudflare, supabase)`);
  }
}
```

- [ ] **Step 4**: verify pass

```bash
npm run typecheck && npm test -- src/cli/bootstrap/destination-shorthand.test.ts 2>&1 | tail -10
```

Expected: 9 tests pass.

- [ ] **Step 5**: commit

```bash
git add src/cli/bootstrap/destination-shorthand.ts src/cli/bootstrap/destination-shorthand.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): destination shorthand resolver

Plan 5g step 2. resolveDestinationShorthand("vercel:production",
"API_KEY") → { template_id: "vercel-env-add", template_params:
{ name: "API_KEY", environment: "production" }, domain: "vercel.com" }.

Mappings for the 4 shipped templates: vercel-env-add, github-actions-
secret-set, cloudflare-secret-put, supabase-edge-secret-set. Unknown
provider or malformed shorthand → ShuttleError("bootstrap_destination_unknown").

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task E — Extend `ApprovalBinding.action` with `"bootstrap"`

**File:** `src/daemon/approvals/store.ts:16`

- [ ] **Step 1**: extend the union

In `src/daemon/approvals/store.ts`, line 16 currently:

```ts
action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render" | "import";
```

Change to:

```ts
action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render" | "import" | "bootstrap";
```

- [ ] **Step 2**: verify typecheck

```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

Expected: clean. Existing tests don't reference `"bootstrap"` action yet, so no regressions.

- [ ] **Step 3**: commit

```bash
git add src/daemon/approvals/store.ts
git commit -m "$(cat <<'EOF'
feat(approvals): extend ApprovalBinding.action with "bootstrap"

Plan 5g step 3. New action discriminator for the bootstrap mega-binding
that covers an entire multi-step plan (whose individual steps run
under the bootstrap approval's authority, not their own inner
approvals).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task F — Audit actions + error codes

**Files:**
- `src/daemon/audit.ts:5-15`
- `src/shared/error-codes.ts`
- `src/shared/error-codes.test.ts`

- [ ] **Step 1**: extend `DaemonAuditAction`

In `src/daemon/audit.ts`, find the union (around lines 4-12 — the `export type DaemonAuditAction =` block). Add `"bootstrap_plan"` and `"bootstrap_step"`:

```ts
export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume"
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
  | "secrets_delete" | "secrets_rotate" | "run" | "run_stdin" | "inject_render"
  | "template_run" | "template_tmp_sweep"
  | "approval_created" | "approval_granted" | "approval_denied"
  | "approval_expired" | "approval_used" | "approval_cancelled" | "approval_mismatch"
  | "import"
  | "bootstrap_plan" | "bootstrap_step";
```

- [ ] **Step 2**: add error codes

In `src/shared/error-codes.ts`, find the EXIT_CODE constants + the registry. Add three new entries:

```ts
bootstrap_plan_invalid: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Edit secret-shuttle.yml to fix the schema error, then re-run.",
  nextAction: () => "secret-shuttle bootstrap",
},
bootstrap_batch_not_found: {
  exitCode: EXIT_CODE_NOT_FOUND,
  hint: () => "The batch was pruned or never existed. Generate a fresh batch:",
  nextAction: () => "secret-shuttle bootstrap",
},
bootstrap_destination_unknown: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Edit secret-shuttle.yml: replace the unknown destination shorthand with one of: vercel:<env>, github-actions:owner/repo, cloudflare:<env>, supabase:<projectref>.",
  nextAction: () => "secret-shuttle bootstrap",
},
```

Place these near other USAGE / NOT_FOUND codes for grouping.

- [ ] **Step 3**: update the registry-count test

In `src/shared/error-codes.test.ts`, find the count-assertion (search for `121` or whatever the previous count was; the most recent fix removed `daemon_start_failed` so count is 120 → 123 after this change). Update the constant.

Add lookup tests:

```ts
test("error-codes: bootstrap_plan_invalid registered with USAGE exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_plan_invalid");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_USAGE);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});

test("error-codes: bootstrap_batch_not_found registered with NOT_FOUND exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_batch_not_found");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_NOT_FOUND);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});

test("error-codes: bootstrap_destination_unknown registered with USAGE exit code + nextAction", () => {
  const entry = lookupErrorCode("bootstrap_destination_unknown");
  assert.ok(entry);
  assert.strictEqual(entry.exitCode, EXIT_CODE_USAGE);
  assert.strictEqual(entry.nextAction!(""), "secret-shuttle bootstrap");
});
```

- [ ] **Step 4**: verify

```bash
npm run typecheck && npm test -- src/shared/error-codes.test.ts 2>&1 | tail -15
```

Expected: 3 new tests pass; count updated.

- [ ] **Step 5**: commit

```bash
git add src/daemon/audit.ts src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "$(cat <<'EOF'
feat(audit,errors): bootstrap_plan + bootstrap_step audit actions; 3 error codes

Plan 5g step 4. Audit + registry additions for bootstrap:

  Audit (DaemonAuditAction):
    - bootstrap_plan  — emitted on Phase 1 approval mint.
    - bootstrap_step  — emitted per step in Phase 2 execution.

  Errors (registry):
    - bootstrap_plan_invalid (USAGE / exit 2)
    - bootstrap_batch_not_found (NOT_FOUND / exit 3)
    - bootstrap_destination_unknown (USAGE / exit 2)

All three errors include next_action ("secret-shuttle bootstrap")
per Plan 5d pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task G — `BootstrapStore` (state persistence)

**Files:**
- Create: `src/daemon/bootstrap/store.ts`
- Create: `src/daemon/bootstrap/store.test.ts`

- [ ] **Step 1**: write failing tests

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore, type BatchState } from "./store.js";

function makeState(id: string): BatchState {
  return {
    batch_id: id,
    approval_id: "approval-" + id,
    plan_file_path: "/tmp/secret-shuttle.yml",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  };
}

test("BootstrapStore: create + get round-trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  const state = makeState("a");
  await store.save(state);
  const got = await store.get("a");
  assert.deepStrictEqual(got, state);
});

test("BootstrapStore: get(unknown) returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  assert.strictEqual(await store.get("missing"), null);
});

test("BootstrapStore: persists to disk in 0600 file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("b"));
  const files = await readdir(dir);
  assert.ok(files.includes("b.json"));
  const content = JSON.parse(await readFile(path.join(dir, "b.json"), "utf8"));
  assert.strictEqual(content.batch_id, "b");
});

test("BootstrapStore: list returns all states", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("x"));
  await store.save(makeState("y"));
  const list = await store.list();
  const ids = list.map((s) => s.batch_id).sort();
  assert.deepStrictEqual(ids, ["x", "y"]);
});

test("BootstrapStore: delete removes from store + disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("c"));
  await store.delete("c");
  assert.strictEqual(await store.get("c"), null);
  const files = await readdir(dir);
  assert.ok(!files.includes("c.json"));
});

test("BootstrapStore: pruneOlderThan removes stale batches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  const old = makeState("old");
  old.created_at = Date.now() - 48 * 3600 * 1000; // 48h ago
  const fresh = makeState("fresh");
  await store.save(old);
  await store.save(fresh);
  await store.pruneOlderThan(24 * 3600 * 1000); // 24h threshold
  assert.strictEqual(await store.get("old"), null);
  assert.ok((await store.get("fresh")) !== null);
});
```

- [ ] **Step 2**: verify failure

```bash
npm test -- src/daemon/bootstrap/store.test.ts 2>&1 | tail -10
```

- [ ] **Step 3**: implement

`src/daemon/bootstrap/store.ts`:

```ts
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PlanEntry {
  secret: string;
  ref: string;
  source: BootstrapSource;
  destinations: ResolvedDestination[];
}

export interface BootstrapSource {
  kind: "capture" | "random_32_bytes" | "random_64_bytes" | "existing";
  url?: string;       // for capture
  ref?: string;       // for existing
}

export interface ResolvedDestination {
  shorthand: string;
  template_id: string;
  template_params: Record<string, string>;
  domain: string;
}

export interface StepResult {
  ok: boolean;
  ref?: string;
  destinations_pushed?: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>;
  error_code?: string;
  message?: string;
}

export interface BatchState {
  batch_id: string;
  approval_id: string;
  plan_file_path: string;
  plan: PlanEntry[];
  step_results: Record<string, StepResult>; // keyed by secret name
  created_at: number;
  status: "pending" | "in_progress" | "completed" | "failed_partial";
}

export interface BootstrapStoreOpts {
  rootDir: string; // typically `${SHUTTLE_HOME}/bootstrap-batches`
}

export class BootstrapStore {
  private readonly rootDir: string;
  private readonly cache = new Map<string, BatchState>();

  constructor(opts: BootstrapStoreOpts) {
    this.rootDir = opts.rootDir;
  }

  async save(state: BatchState): Promise<void> {
    this.cache.set(state.batch_id, state);
    await mkdir(this.rootDir, { recursive: true });
    const filePath = path.join(this.rootDir, `${state.batch_id}.json`);
    await writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async get(batchId: string): Promise<BatchState | null> {
    const cached = this.cache.get(batchId);
    if (cached !== undefined) return cached;
    const filePath = path.join(this.rootDir, `${batchId}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as BatchState;
      this.cache.set(batchId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async list(): Promise<BatchState[]> {
    try {
      const entries = await readdir(this.rootDir);
      const states: BatchState[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -5);
        const s = await this.get(id);
        if (s !== null) states.push(s);
      }
      return states;
    } catch {
      return [];
    }
  }

  async delete(batchId: string): Promise<void> {
    this.cache.delete(batchId);
    try {
      await unlink(path.join(this.rootDir, `${batchId}.json`));
    } catch {
      // not found is fine
    }
  }

  /** Remove batches whose created_at is older than thresholdMs ago. */
  async pruneOlderThan(thresholdMs: number): Promise<void> {
    const deadline = Date.now() - thresholdMs;
    const all = await this.list();
    for (const s of all) {
      if (s.created_at < deadline) {
        await this.delete(s.batch_id);
      }
    }
  }
}
```

- [ ] **Step 4**: verify pass

```bash
npm run typecheck && npm test -- src/daemon/bootstrap/store.test.ts 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5**: commit

```bash
git add src/daemon/bootstrap/store.ts src/daemon/bootstrap/store.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): BootstrapStore — in-memory + disk persistence

Plan 5g step 5. Persists batch state to ${SHUTTLE_HOME}/bootstrap-batches/<id>.json
(mode 0600). In-memory cache fronts the disk. Supports save/get/list/
delete/pruneOlderThan. Used by Phase 2 to resume execution and by
--list/--abandon CLI flags.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task H — Plan computation (diff)

**Files:**
- Create: `src/daemon/bootstrap/plan.ts`
- Create: `src/daemon/bootstrap/plan.test.ts`

- [ ] **Step 1**: write failing tests

```ts
import { test } from "node:test";
import assert from "node:assert";
import { computeBootstrapPlan } from "./plan.js";
import type { BootstrapPlan } from "../../cli/bootstrap/yml.js";

// Mock vault — for tests, we don't need the real Vault class; just the shape we read.
interface MockVault {
  has(ref: string): boolean;
}
const emptyVault: MockVault = { has: () => false };

test("computeBootstrapPlan: empty vault, all secrets need creation", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].secret, "API_KEY");
  assert.strictEqual(result[0].ref, "ss://local/prod/API_KEY");
});

test("computeBootstrapPlan: secret already in vault → skipped (no --force)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: (ref) => ref === "ss://local/prod/API_KEY" };
  const result = computeBootstrapPlan(parsed, vault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 0);
});

test("computeBootstrapPlan: --force re-plans even when present", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production"] },
    ],
  };
  const vault: MockVault = { has: (ref) => ref === "ss://local/prod/API_KEY" };
  const result = computeBootstrapPlan(parsed, vault, { force: true, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
});

test("computeBootstrapPlan: source: existing always uses given ref", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "FOO", source: { kind: "existing", ref: "ss://upstream/prod/FOO" }, destinations: ["vercel:production"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].ref, "ss://upstream/prod/FOO");
});

test("computeBootstrapPlan: destination shorthand resolved into ResolvedDestination[]", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [
      { name: "API_KEY", source: { kind: "random_32_bytes" }, destinations: ["vercel:production", "github-actions:owner/repo"] },
    ],
  };
  const result = computeBootstrapPlan(parsed, emptyVault, { force: false, source: "local", environment: "production" });
  assert.strictEqual(result[0].destinations.length, 2);
  assert.strictEqual(result[0].destinations[0].template_id, "vercel-env-add");
  assert.strictEqual(result[0].destinations[1].template_id, "github-actions-secret-set");
});
```

- [ ] **Step 2**: verify failure

```bash
npm test -- src/daemon/bootstrap/plan.test.ts 2>&1 | tail -10
```

- [ ] **Step 3**: implement

`src/daemon/bootstrap/plan.ts`:

```ts
import type { BootstrapPlan, BootstrapPlanSecret } from "../../cli/bootstrap/yml.js";
import { resolveDestinationShorthand } from "../../cli/bootstrap/destination-shorthand.js";
import type { PlanEntry, ResolvedDestination } from "./store.js";
import { buildSecretRef, canonicalEnvironment } from "../../shared/refs.js";

interface PlanContext {
  /** "local" by default; override per-secret in a future YAML extension. */
  source: string;
  /** "production" / "preview" / "development" — used to construct the ref. */
  environment: string;
  /** If true, include secrets already in vault. */
  force: boolean;
}

interface VaultLike {
  has(ref: string): boolean;
}

/**
 * Compute the diff between secret-shuttle.yml and current vault state.
 * Returns the list of secrets that actually need work.
 */
export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const s of parsed.secrets) {
    const ref = s.source.kind === "existing"
      ? s.source.ref
      : buildSecretRef({ source: ctx.source, environment: canonicalEnvironment(ctx.environment), name: s.name });

    if (!ctx.force && vault.has(ref)) {
      continue;
    }

    const destinations: ResolvedDestination[] = s.destinations.map((shorthand) => {
      const r = resolveDestinationShorthand(shorthand, s.name);
      return {
        shorthand,
        template_id: r.template_id,
        template_params: r.template_params,
        domain: r.domain,
      };
    });

    out.push({
      secret: s.name,
      ref,
      source: { ...s.source },
      destinations,
    });
  }
  return out;
}
```

If `buildSecretRef` or `canonicalEnvironment` don't exist with those names, find the equivalent in `src/shared/refs.ts`:

```bash
grep -E "export function|export const" src/shared/refs.ts
```

Adapt the calls.

- [ ] **Step 4**: verify pass

```bash
npm run typecheck && npm test -- src/daemon/bootstrap/plan.test.ts 2>&1 | tail -10
```

Expected: 5 tests pass.

- [ ] **Step 5**: commit

```bash
git add src/daemon/bootstrap/plan.ts src/daemon/bootstrap/plan.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): computeBootstrapPlan — diff yml vs vault

Plan 5g step 6. computeBootstrapPlan() takes a parsed BootstrapPlan
+ vault state, returns the list of secrets that actually need work.
Secrets already in vault are skipped unless --force. Destination
shorthands resolve to ResolvedDestination[].

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task I — Bootstrap authority bypass (THE DELICATE PART)

**Files:**
- Create: `src/daemon/bootstrap/authority.ts` — context type + validation helper.
- Modify: `src/daemon/api/routes/secrets.ts` — extract `generateSecretCore()` exported function.
- Modify: `src/daemon/api/routes/templates.ts` — extract `runTemplateCore()`.
- Modify: `src/daemon/api/routes/reveal-capture.ts` — extract `revealCaptureCore()`.
- Modify: `src/daemon/services.ts` — `services.bootstrapStore` field.

This task creates the mechanism by which the executor (Task K) reuses existing route logic without going through HTTP and without re-prompting for inner approvals. **Read the entire task before starting** — the refactor pattern is the same across all 3 routes but each has its own quirks.

### Step 1: Add the authority context type

Create `src/daemon/bootstrap/authority.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";
import type { BootstrapStore } from "./store.js";

/**
 * Passed to inner route core functions when called from the bootstrap executor.
 * The executor holds a consumed bootstrap approval; rather than minting an
 * inner approval per step (and triggering inner Touch ID / passphrase / hub
 * prompts), inner routes accept this context as proof of authority and skip
 * their own requireApprovals call.
 *
 * Validity: the batchId must exist in the BootstrapStore AND its status must
 * be "in_progress" (Phase 2 actively executing). Any other state rejects.
 */
export interface BootstrapAuthority {
  batchId: string;
}

export async function assertBootstrapAuthorityValid(
  authority: BootstrapAuthority,
  store: BootstrapStore,
): Promise<void> {
  const state = await store.get(authority.batchId);
  if (state === null) {
    throw new ShuttleError(
      "bootstrap_batch_not_found",
      `bootstrap authority batchId not found: ${authority.batchId}`,
    );
  }
  if (state.status !== "in_progress") {
    throw new ShuttleError(
      "bootstrap_batch_not_found",
      `bootstrap authority batchId ${authority.batchId} is not in_progress (status: ${state.status})`,
    );
  }
}
```

### Step 2: Extract `generateSecretCore()` from `secrets.ts`

Read `src/daemon/api/routes/secrets.ts`. The `/v1/secrets/generate` route handler does:
1. `services.lock.requireKey()`.
2. Parse + validate the body (name, environment, source, kind, allow-domain, etc.).
3. Build an `ApprovalBinding`.
4. `await requireApprovals(...)`.
5. Call `services.vault.generate(...)`.
6. Audit + return.

Extract a CORE function:

```ts
export interface GenerateSecretInput {
  name: string;
  environment: string;
  source: string;
  kind: "random_32_bytes" | "random_64_bytes" | ...;
  allowedDomains: string[];
  allowedActions?: string[];
  // ... whatever shape the existing route accepts ...
}

export interface GenerateSecretOpts {
  bootstrapAuthority?: BootstrapAuthority;
  // ... other context like approvalIds, sessionId — preserve the existing route's options ...
}

export async function generateSecretCore(
  services: DaemonServices,
  daemonPortRef: () => number,
  input: GenerateSecretInput,
  opts: GenerateSecretOpts,
): Promise<{ ref: string; grant?: ApprovalGrant }> {
  services.lock.requireKey();

  // Bootstrap authority bypass: skip the inner requireApprovals if a valid
  // bootstrap context is present. The bootstrap approval (consumed at Phase 2
  // entry) carries the human's authorization for THIS specific step.
  if (opts.bootstrapAuthority !== undefined) {
    await assertBootstrapAuthorityValid(opts.bootstrapAuthority, services.bootstrapStore);
    // Skip inner approval. Go straight to vault.generate.
  } else {
    // Existing requireApprovals call — preserve verbatim.
    const binding: ApprovalBinding = { /* ... */ };
    const grants = await requireApprovals({ /* ... */ });
    // ...
  }

  // Existing post-approval logic: vault.generate, audit, return.
  const generated = await services.vault.generate({ ... });
  // ... audit ...
  return { ref: generated.ref };
}
```

The HTTP handler becomes a thin shell:

```ts
server.addRoute("POST", "/v1/secrets/generate", async (_req, raw) => {
  const o = asObject(raw);
  const input: GenerateSecretInput = {
    name: reqString(o, "name"),
    environment: reqString(o, "environment"),
    // ... parse remaining fields ...
  };
  const opts: GenerateSecretOpts = {
    approvalIds: optApprovalIds(o),
    sessionId: optString(o, "session_id"),
    // bootstrapAuthority is NEVER set from HTTP — only from executor.
  };
  const result = await generateSecretCore(services, daemonPortRef, input, opts);
  return { ok: true, ref: result.ref };
});
```

**Critical:** the HTTP handler MUST NOT accept `bootstrapAuthority` from the request body. The authority is a server-internal capability; allowing it from HTTP would let a caller bypass approvals.

### Step 3: Extract `revealCaptureCore()` from `reveal-capture.ts`

Same pattern. The reveal-capture route's core logic:
1. `services.lock.requireKey()`.
2. Build binding (`action: "reveal_capture"`).
3. `await requireApprovals(...)`.
4. Open browser, drive reveal/capture flow.
5. Commit to vault.

Extract `revealCaptureCore(services, daemonPortRef, input, opts)` with the same `bootstrapAuthority?` opts field. Skip `requireApprovals` when authority is set.

### Step 4: Extract `runTemplateCore()` from `templates.ts`

Same pattern. `/v1/templates/run` core:
1. `services.lock.requireKey()`.
2. Look up template by id; validate params.
3. Build binding (`action: "template"`).
4. `await requireApprovals(...)`.
5. Run template via the template-runner.
6. Audit + return.

Extract `runTemplateCore(services, daemonPortRef, input, opts)`.

### Step 5: Wire `services.bootstrapStore`

In `src/daemon/services.ts`, add:

```ts
import { BootstrapStore } from "./bootstrap/store.js";

export class DaemonServices {
  // ... existing fields ...
  readonly bootstrapStore = new BootstrapStore({
    rootDir: path.join(getShuttlePaths().shuttleHome, "bootstrap-batches"),
  });
}
```

Use the actual config path API. If `getShuttlePaths()` returns `{ shuttleHome }`, use that. Otherwise adapt.

### Step 6: Verify

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

Expected: clean. All existing route tests pass — the refactor is mechanically equivalent for the HTTP path.

**If existing tests fail**, the refactor likely changed an internal signature or skipped a path. Diff carefully against the original route logic. Each Core function MUST behave IDENTICALLY to the original HTTP handler when invoked without `bootstrapAuthority`.

### Step 7: Add unit tests for the bypass

Create `src/daemon/bootstrap/authority.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore } from "./store.js";
import { assertBootstrapAuthorityValid } from "./authority.js";
import { ShuttleError } from "../../shared/errors.js";

test("assertBootstrapAuthorityValid: in_progress batch passes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save({
    batch_id: "x",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "in_progress",
  });
  await assertBootstrapAuthorityValid({ batchId: "x" }, store);
});

test("assertBootstrapAuthorityValid: pending batch → throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save({
    batch_id: "y",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });
  await assert.rejects(
    assertBootstrapAuthorityValid({ batchId: "y" }, store),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});

test("assertBootstrapAuthorityValid: unknown batch → throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await assert.rejects(
    assertBootstrapAuthorityValid({ batchId: "missing" }, store),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});
```

### Step 8: Verify + commit

```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

```bash
git add src/daemon/bootstrap/authority.ts src/daemon/bootstrap/authority.test.ts src/daemon/api/routes/secrets.ts src/daemon/api/routes/templates.ts src/daemon/api/routes/reveal-capture.ts src/daemon/services.ts
git commit -m "$(cat <<'EOF'
refactor(routes): extract core functions; add BootstrapAuthority bypass

Plan 5g step 7 — the keystone for bootstrap. Three route handlers
(/v1/secrets/generate, /v1/secrets/reveal-capture, /v1/templates/run)
now expose their core logic as exported functions
(generateSecretCore, revealCaptureCore, runTemplateCore).

The HTTP handlers become thin shells: parse body → call core.

Cores accept an opts.bootstrapAuthority?: { batchId } context. When
set, the core validates the batchId against the BootstrapStore
(must be status: "in_progress") and SKIPS the inner requireApprovals
call. The human approved the bootstrap binding once at Phase 2 entry;
inner steps run under that authority.

Security invariant: bootstrapAuthority is NEVER set from the HTTP
request body. The HTTP shells construct opts WITHOUT it. Only the
bootstrap executor (next task) calls cores with authority.

services.bootstrapStore added; persists to ${SHUTTLE_HOME}/bootstrap-batches/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task J — Executor

**Files:**
- Create: `src/daemon/bootstrap/executor.ts`
- Create: `src/daemon/bootstrap/executor.test.ts`

- [ ] **Step 1**: write failing tests

The executor is integration-shaped. Tests will need mocked services (`generateSecretCore`, `runTemplateCore`, `revealCaptureCore` swapped for spies) OR a real in-process daemon with a controllable vault. The simpler approach for v1: dependency-inject the core functions so tests can swap them.

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore } from "./store.js";
import { executeBatch, type ExecutorDeps } from "./executor.js";

async function setupStore(): Promise<BootstrapStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-exec-"));
  return new BootstrapStore({ rootDir: dir });
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  const noopCore = async () => ({ ok: true as const, ref: "ss://test/prod/X" });
  return {
    generateSecret: noopCore as any,
    revealCapture: noopCore as any,
    runTemplate: async () => ({ ok: true as const }) as any,
    services: {} as any,
    daemonPortRef: () => 9876,
    ...overrides,
  };
}

test("executeBatch: completes all steps for a 1-secret 1-destination plan", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "b1",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "API_KEY", environment: "production" },
        domain: "vercel.com",
      }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  const result = await executeBatch(store, "b1", makeDeps());

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.failed, 0);
  const final = await store.get("b1");
  assert.strictEqual(final?.status, "completed");
});

test("executeBatch: partial-success records per-step errors", async () => {
  const store = await setupStore();
  // Set up a 2-secret plan; second secret's template push fails.
  await store.save({
    batch_id: "b2",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "OK_KEY", ref: "ss://local/prod/OK_KEY", source: { kind: "random_32_bytes" }, destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
      { secret: "BAD_KEY", ref: "ss://local/prod/BAD_KEY", source: { kind: "random_32_bytes" }, destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let callCount = 0;
  const result = await executeBatch(store, "b2", makeDeps({
    runTemplate: async () => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated push failure");
      }
      return { ok: true as const } as any;
    },
  }));

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.failed, 1);
  const final = await store.get("b2");
  assert.strictEqual(final?.status, "failed_partial");
  assert.strictEqual(final?.step_results["OK_KEY"].ok, true);
  assert.strictEqual(final?.step_results["BAD_KEY"].ok, false);
});

test("executeBatch: re-run skips completed steps (idempotent)", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "b3",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: { API_KEY: { ok: true, ref: "ss://local/prod/API_KEY" } }, // already done
    created_at: Date.now(),
    status: "in_progress",
  });

  let coreCalled = 0;
  await executeBatch(store, "b3", makeDeps({
    generateSecret: async () => { coreCalled++; return { ok: true as const, ref: "ss://local/prod/API_KEY" }; },
  }));

  assert.strictEqual(coreCalled, 0, "completed step must not be re-executed");
});

test("executeBatch: unknown batch throws bootstrap_batch_not_found", async () => {
  const store = await setupStore();
  await assert.rejects(
    executeBatch(store, "missing", makeDeps()),
    (e: any) => e?.code === "bootstrap_batch_not_found",
  );
});
```

- [ ] **Step 2**: verify failure

```bash
npm test -- src/daemon/bootstrap/executor.test.ts 2>&1 | tail -15
```

- [ ] **Step 3**: implement

`src/daemon/bootstrap/executor.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";
import { writeDaemonAudit } from "../audit.js";
import type { BootstrapStore, BatchState, PlanEntry, StepResult } from "./store.js";
import type { DaemonServices } from "../services.js";
import type { BootstrapAuthority } from "./authority.js";

/**
 * Dependency-injected core function references. Production wires in the
 * real generateSecretCore/revealCaptureCore/runTemplateCore (extracted in
 * Task I). Tests can substitute spies.
 */
export interface ExecutorDeps {
  generateSecret: (services: DaemonServices, daemonPortRef: () => number, input: GenerateInput, opts: GenerateOpts) => Promise<{ ref: string }>;
  revealCapture: (services: DaemonServices, daemonPortRef: () => number, input: RevealInput, opts: RevealOpts) => Promise<{ ref: string }>;
  runTemplate: (services: DaemonServices, daemonPortRef: () => number, input: TemplateInput, opts: TemplateOpts) => Promise<{ exitCode: number }>;
  services: DaemonServices;
  daemonPortRef: () => number;
}

// Adapt these to the actual signatures Task I produces.
interface GenerateInput { name: string; environment: string; source: string; kind: string; allowedDomains: string[]; }
interface GenerateOpts { bootstrapAuthority?: BootstrapAuthority }
interface RevealInput { ref: string; url: string; }
interface RevealOpts { bootstrapAuthority?: BootstrapAuthority }
interface TemplateInput { templateId: string; ref: string; params: Record<string, string>; }
interface TemplateOpts { bootstrapAuthority?: BootstrapAuthority }

export interface ExecuteResult {
  completed: number;
  failed: number;
  refs: string[];
  errors: Array<{ secret: string; step: string; code: string; message: string }>;
}

export async function executeBatch(
  store: BootstrapStore,
  batchId: string,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  const state = await store.get(batchId);
  if (state === null) {
    throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
  }
  if (state.status === "completed") {
    // Idempotent return of the cached result.
    return summarize(state);
  }

  state.status = "in_progress";
  await store.save(state);

  const authority: BootstrapAuthority = { batchId };

  for (const entry of state.plan) {
    if (state.step_results[entry.secret]?.ok === true) {
      continue; // already done — idempotent re-run skip
    }

    try {
      const ref = await runSourceStep(entry, deps, authority);
      const destinationsPushed = await runDestinationSteps(entry, ref, deps, authority);
      state.step_results[entry.secret] = {
        ok: true,
        ref,
        destinations_pushed: destinationsPushed,
      };
      await writeDaemonAudit({ action: "bootstrap_step", ok: true, ref });
    } catch (e) {
      state.step_results[entry.secret] = {
        ok: false,
        error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
        message: e instanceof Error ? e.message : String(e),
      };
      await writeDaemonAudit({
        action: "bootstrap_step",
        ok: false,
        ref: entry.ref,
        error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
      });
    }
    await store.save(state);
  }

  const summary = summarize(state);
  state.status = summary.failed > 0 ? "failed_partial" : "completed";
  await store.save(state);
  return summary;
}

async function runSourceStep(entry: PlanEntry, deps: ExecutorDeps, authority: BootstrapAuthority): Promise<string> {
  if (entry.source.kind === "existing") {
    return entry.source.ref!;
  }
  if (entry.source.kind === "random_32_bytes" || entry.source.kind === "random_64_bytes") {
    const result = await deps.generateSecret(
      deps.services,
      deps.daemonPortRef,
      {
        name: entry.secret,
        environment: "production", // parse from entry.ref if needed
        source: "local",
        kind: entry.source.kind,
        allowedDomains: entry.destinations.map((d) => d.domain),
      },
      { bootstrapAuthority: authority },
    );
    return result.ref;
  }
  if (entry.source.kind === "capture") {
    const result = await deps.revealCapture(
      deps.services,
      deps.daemonPortRef,
      { ref: entry.ref, url: entry.source.url! },
      { bootstrapAuthority: authority },
    );
    return result.ref;
  }
  throw new ShuttleError("bootstrap_plan_invalid", `unknown source.kind: ${(entry.source as any).kind}`);
}

async function runDestinationSteps(
  entry: PlanEntry,
  ref: string,
  deps: ExecutorDeps,
  authority: BootstrapAuthority,
): Promise<Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>> {
  const results: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = [];
  for (const dest of entry.destinations) {
    try {
      await deps.runTemplate(
        deps.services,
        deps.daemonPortRef,
        {
          templateId: dest.template_id,
          ref,
          params: dest.template_params,
        },
        { bootstrapAuthority: authority },
      );
      results.push({ destination: dest.shorthand, ok: true });
    } catch (e) {
      results.push({
        destination: dest.shorthand,
        ok: false,
        error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

function summarize(state: BatchState): ExecuteResult {
  let completed = 0;
  let failed = 0;
  const refs: string[] = [];
  const errors: Array<{ secret: string; step: string; code: string; message: string }> = [];
  for (const entry of state.plan) {
    const r = state.step_results[entry.secret];
    if (r === undefined) continue;
    if (r.ok) {
      completed += 1;
      if (r.ref !== undefined) refs.push(r.ref);
    } else {
      failed += 1;
      errors.push({
        secret: entry.secret,
        step: "execute",
        code: r.error_code ?? "unexpected_error",
        message: r.message ?? "",
      });
    }
  }
  return { completed, failed, refs, errors };
}
```

The exact `GenerateInput` / `RevealInput` / `TemplateInput` shapes must match Task I's extracted core function signatures. Adapt to match.

- [ ] **Step 4**: verify pass

```bash
npm run typecheck && npm test -- src/daemon/bootstrap/executor.test.ts 2>&1 | tail -15
```

Expected: 4 tests pass.

- [ ] **Step 5**: commit

```bash
git add src/daemon/bootstrap/executor.ts src/daemon/bootstrap/executor.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): executor — walks plan, calls core functions

Plan 5g step 8. executeBatch(store, batchId, deps) iterates the
batch's plan, calls source + destination steps for each secret via
DI'd core functions, records per-step results, returns enum.

Skips already-completed steps on re-run (idempotent). On per-step
failure: records error, continues to next entry, sets final status
to "failed_partial" if any failed.

Audit emits bootstrap_step per entry. Dependency-injected core
functions for testability — production wires generateSecretCore /
revealCaptureCore / runTemplateCore (Task I extracts).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task K — Bootstrap routes

**Files:**
- Create: `src/daemon/api/routes/bootstrap.ts`
- Create: `src/daemon/api/routes/bootstrap.test.ts`
- Modify: `src/daemon/api/router.ts`

Four routes: plan, continue, abandon, list.

### Step 1: Write failing route tests

```ts
import { test } from "node:test";
import assert from "node:assert";
// Use the existing route-test harness pattern (look at how
// secrets-import.test.ts or run-resolve.test.ts set up an in-process
// daemon for tests).

test("POST /v1/bootstrap/plan: returns approval_required + batch_id for cold plan", async () => {
  // Set up in-process daemon, unlocked vault, empty bootstrap store.
  // POST { plan_yml: "<valid yml>" }.
  // Expect 400 + error_code: approval_required + details.approvals[0].action: "bootstrap"
  //   AND details.batch_id is a uuid-shaped string.
});

test("POST /v1/bootstrap/plan: yml invalid → bootstrap_plan_invalid", async () => {
  // POST { plan_yml: "bad: yaml: ::" }.
  // Expect 400 + error_code: bootstrap_plan_invalid.
});

test("POST /v1/bootstrap/plan: empty plan (everything in vault) → ok with completed: 0", async () => {
  // Pre-seed vault with all yml secrets.
  // POST → 200 + { ok: true, completed: 0, failed: 0 }. No approval needed since nothing to do.
});

test("POST /v1/bootstrap/continue: with approval_id executes plan", async () => {
  // First POST plan → get batch_id + approval_id.
  // services.approvals.approve(approval_id).
  // Second POST { batch_id, approval_ids: [approval_id] } → 200 + summary enum.
});

test("POST /v1/bootstrap/continue: unknown batch_id → bootstrap_batch_not_found", async () => {
  // POST { batch_id: "nonexistent", approval_ids: ["x"] }.
  // Expect bootstrap_batch_not_found.
});

test("POST /v1/bootstrap/abandon: deletes batch from store", async () => {
  // Create batch.
  // POST { batch_id } → 200 + { ok: true, removed: true }.
  // bootstrapStore.get(batch_id) returns null.
});

test("GET /v1/bootstrap/list: returns all batches", async () => {
  // Create 2 batches via /v1/bootstrap/plan.
  // GET → 200 + { ok: true, batches: [...] } (length 2).
});
```

### Step 2: Implement the routes

`src/daemon/api/routes/bootstrap.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ShuttleError } from "../../../shared/errors.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import { writeDaemonAudit } from "../../audit.js";
import { parseBootstrapYml } from "../../../cli/bootstrap/yml.js";
import { computeBootstrapPlan } from "../../bootstrap/plan.js";
import { executeBatch, type ExecutorDeps } from "../../bootstrap/executor.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import type { ApprovalBinding } from "../../approvals/store.js";

// Import the extracted core functions:
import { generateSecretCore } from "./secrets.js";
import { revealCaptureCore } from "./reveal-capture.js";
import { runTemplateCore } from "./templates.js";

export function registerBootstrapRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/bootstrap/plan", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const planYml = reqString(o, "plan_yml");
    const force = optBool(o, "force") ?? false;
    const environment = optString(o, "environment") ?? "production";

    // 1. Parse yml.
    const parsed = parseBootstrapYml(planYml);

    // 2. Diff against vault.
    const plan = computeBootstrapPlan(
      parsed,
      {
        has: (ref) => {
          try {
            services.vault.getSecret(ref);
            return true;
          } catch {
            return false;
          }
        },
      },
      { force, source: "local", environment },
    );

    // 3. Nothing to do: short-circuit with success.
    if (plan.length === 0) {
      await writeDaemonAudit({ action: "bootstrap_plan", ok: true });
      return { ok: true, completed: 0, failed: 0, refs: [], errors: [] };
    }

    // 4. Mint approval. Action: "bootstrap"; template_params carry plan summary.
    const batchId = `bootstrap-${randomUUID()}`;
    const planSummary = plan.map((e) => ({
      name: e.secret,
      source: e.source.kind === "capture" ? `capture:${e.source.url}` : e.source.kind,
      destinations: e.destinations.map((d) => d.shorthand),
    }));
    const binding: ApprovalBinding = {
      action: "bootstrap",
      ref: null,
      environment: environment === "production" ? "production" : "development",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: {
        batch_id: batchId,
        plan_summary: JSON.stringify(planSummary),
      },
      allowed_domains: Array.from(new Set(plan.flatMap((e) => e.destinations.map((d) => d.domain)))),
    };

    // Save state BEFORE minting approval (so the batch exists if the approval-mint UI page tries to load).
    await services.bootstrapStore.save({
      batch_id: batchId,
      approval_id: "", // filled in after approval mint
      plan_file_path: "",
      plan,
      step_results: {},
      created_at: Date.now(),
      status: "pending",
    });

    // 5. requireApprovals with waitMs: 0 — always returns approval_required (this is Phase 1).
    try {
      await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        waitMs: 0,
      });
      // Should never reach here — waitMs: 0 with no IDs throws approval_required.
      throw new ShuttleError("unexpected_error", "bootstrap Phase 1 expected approval_required");
    } catch (e) {
      if (e instanceof ShuttleError && e.code === "approval_required") {
        // Extract the minted approval_id from e.details.
        const details = e.details as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> } | undefined;
        const approvalId = details?.approvals[0]?.approval_id ?? "";
        // Update batch state with the approval_id.
        const state = await services.bootstrapStore.get(batchId);
        if (state !== null) {
          state.approval_id = approvalId;
          await services.bootstrapStore.save(state);
        }
        await writeDaemonAudit({ action: "bootstrap_plan", ok: true, approval_id: approvalId });
        // Add batch_id to details and re-throw.
        const enhancedDetails = {
          ...details,
          batch_id: batchId,
        };
        throw new ShuttleError("approval_required", e.message, { details: enhancedDetails });
      }
      throw e;
    }
  });

  server.addRoute("POST", "/v1/bootstrap/continue", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const batchId = reqString(o, "batch_id");
    const approvalIds = optApprovalIds(o);

    const state = await services.bootstrapStore.get(batchId);
    if (state === null) {
      throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
    }
    if (state.status === "completed") {
      // Idempotent return of cached result.
      return summarizeFromState(state);
    }

    // Consume the approval for the bootstrap binding (recreate the binding by reading state).
    const binding: ApprovalBinding = await rebuildBindingFromState(state);
    const grants = await requireApprovals({
      store: services.approvals,
      bindings: [binding],
      daemonPort: daemonPortRef(),
      sessionStore: services.sessionStore,
      openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
      ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
    });

    // Authority granted. Walk plan.
    const deps: ExecutorDeps = {
      generateSecret: generateSecretCore,
      revealCapture: revealCaptureCore,
      runTemplate: runTemplateCore,
      services,
      daemonPortRef,
    };
    const result = await executeBatch(services.bootstrapStore, batchId, deps);
    return { ok: true, ...result };
  });

  server.addRoute("POST", "/v1/bootstrap/abandon", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const batchId = reqString(o, "batch_id");
    await services.bootstrapStore.delete(batchId);
    return { ok: true, removed: true };
  });

  server.addRoute("GET", "/v1/bootstrap/list", async () => {
    services.lock.requireKey();
    const batches = await services.bootstrapStore.list();
    return {
      ok: true,
      batches: batches.map((s) => ({
        batch_id: s.batch_id,
        status: s.status,
        created_at: s.created_at,
        plan_length: s.plan.length,
        completed: Object.values(s.step_results).filter((r) => r.ok).length,
        failed: Object.values(s.step_results).filter((r) => !r.ok).length,
      })),
    };
  });
}

function summarizeFromState(state: any) {
  // Same summary shape as executeBatch's return.
  // ... (mirror summarize() in executor.ts, or import + reuse)
}

async function rebuildBindingFromState(state: any): Promise<ApprovalBinding> {
  // Reconstruct the same binding shape that /v1/bootstrap/plan minted,
  // so requireApprovals's binding-equality check passes on consume.
  return {
    action: "bootstrap",
    ref: null,
    environment: "production", // read from state if needed
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: {
      batch_id: state.batch_id,
      plan_summary: JSON.stringify(/* same as plan route */),
    },
    allowed_domains: /* same as plan route */,
  };
}
```

The skeleton has gaps (`summarizeFromState`, `rebuildBindingFromState`) — fill in by reading the existing patterns. The key invariant: the binding rebuilt in `continue` MUST match exactly what `plan` minted, or `requireApprovals.consume` rejects with `approval_mismatch`.

### Step 3: Wire into router

```ts
// src/daemon/api/router.ts:
import { registerBootstrapRoutes } from "./routes/bootstrap.js";

// in registerRoutes():
registerBootstrapRoutes(server, services, daemonPortRef);
```

### Step 4: Verify

```bash
npm run typecheck && npm test -- src/daemon/api/routes/bootstrap.test.ts 2>&1 | tail -20
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

Expected: typecheck clean, all 7 new tests pass, full suite 0 failures.

### Step 5: Commit

```bash
git add src/daemon/api/routes/bootstrap.ts src/daemon/api/routes/bootstrap.test.ts src/daemon/api/router.ts
git commit -m "$(cat <<'EOF'
feat(routes/bootstrap): /v1/bootstrap/{plan,continue,abandon,list}

Plan 5g step 9. Four routes for the bootstrap two-phase flow:

  POST /v1/bootstrap/plan: parse yml, diff vs vault, mint single
    bootstrap-action approval covering the whole plan, save batch
    state, throw approval_required with details.{approvals, batch_id}.

  POST /v1/bootstrap/continue: consume approval, walk plan via the
    executor (Task J), return per-step success/failure enum.
    Idempotent re-run.

  POST /v1/bootstrap/abandon: delete batch from store.

  GET  /v1/bootstrap/list: list all persisted batches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task L — Hub UI rendering for `bootstrap` action

**Files:**
- Modify: `src/daemon/approvals/ui.html` (or the `human[]` copy table — whichever the hub UI uses).
- Modify: `src/daemon/approvals/ui-html-drift.test.ts` (if a drift guard exists).

The hub UI renders approval cards via a `human[].<action>` copy table. Find it:

```bash
grep -n "human\[\]\|action ===\|run_stdin" src/daemon/approvals/ui.html | head -20
```

Add a `bootstrap` entry. The card shows:
- Header: "Bootstrap (N secrets)".
- Per-secret rows: name + source + destinations (from `template_params.plan_summary`).
- One [Approve] [Deny] button pair.

### Step 1: Inspect existing rendering

```bash
sed -n '<line range where human[] copy lives>' src/daemon/approvals/ui.html
```

Identify the pattern. The existing actions render via key-value substitutions on `template_params`. For bootstrap, the renderer needs to PARSE `template_params.plan_summary` (a JSON string) and render the array.

### Step 2: Add bootstrap renderer

Within the ui.html script section, add:

```js
function renderBootstrap(binding) {
  const summary = JSON.parse(binding.template_params.plan_summary);
  const rows = summary.map(s => `
    <li>
      <strong>${escapeHtml(s.name)}</strong> — source: ${escapeHtml(s.source)}
      → ${s.destinations.map(escapeHtml).join(", ")}
    </li>
  `).join("");
  return `
    <h2>Bootstrap (${summary.length} secrets)</h2>
    <ul class="bootstrap-secrets">${rows}</ul>
  `;
}

// In the action dispatch:
if (binding.action === "bootstrap") {
  return renderBootstrap(binding);
}
```

(Adapt to the actual file structure. The pattern is "given a binding, produce HTML for the card body".)

### Step 3: Drift guard

If `ui-html-drift.test.ts` exists, add an assertion:

```ts
test("ui.html: renders bootstrap action with plan_summary parse", () => {
  const html = readFileSync("src/daemon/approvals/ui.html", "utf-8");
  assert.ok(html.includes("renderBootstrap") || html.includes("bootstrap"), "ui.html must handle the bootstrap action");
  assert.match(html, /plan_summary/, "must reference template_params.plan_summary");
});
```

### Step 4: Verify + commit

```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
```

```bash
git add src/daemon/approvals/ui.html src/daemon/approvals/ui-html-drift.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/ui): render bootstrap action as multi-secret card

Plan 5g step 10. The bootstrap approval binding carries
template_params.plan_summary (JSON-encoded array of secrets with
sources + destinations). ui.html parses it and renders a card
listing each secret with its source + destinations, plus a single
[Approve]/[Deny] pair.

Drift guard added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task M — CLI command

**Files:**
- Create: `src/cli/commands/bootstrap.ts`
- Create: `src/cli/commands/bootstrap.test.ts`
- Modify: `src/cli/index.ts`

### Step 1: Implement

`src/cli/commands/bootstrap.ts`:

```ts
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { addApprovalIdOption } from "./_approval-id-option.js";

export function bootstrapCommand(): Command {
  const cmd = new Command("bootstrap")
    .description("Provision an entire project's secrets in one approval. Reads secret-shuttle.yml.")
    .option("--plan-file <path>", "Path to secret-shuttle.yml.", "./secret-shuttle.yml")
    .option("--continue", "Phase 2: consume approval and execute the plan.")
    .option("--batch <id>", "Batch id (required with --continue).")
    .option("--force", "Re-generate / re-capture / re-push even when secrets already exist.")
    .option("--abandon <id>", "Delete a persisted batch.")
    .option("--list", "List all persisted batches.")
    .option("--environment <env>", "Environment for new refs (default: production).", "production");
  addApprovalIdOption(cmd);

  return cmd.action(async (options: Record<string, unknown>) => {
    // --list path
    if (options.list === true) {
      const r = await daemonRequest("GET", "/v1/bootstrap/list");
      outputJson(ok(r));
      return;
    }

    // --abandon path
    if (typeof options.abandon === "string") {
      const r = await daemonRequest("POST", "/v1/bootstrap/abandon", { batch_id: options.abandon });
      outputJson(ok(r));
      return;
    }

    // --continue path
    if (options.continue === true) {
      if (typeof options.batch !== "string") {
        throw new Error("--continue requires --batch <id>");
      }
      const body: Record<string, unknown> = { batch_id: options.batch };
      if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
      const r = await daemonRequest("POST", "/v1/bootstrap/continue", body);
      outputJson(ok(r));
      return;
    }

    // Phase 1: read yml, post plan.
    const planYml = await readFile(options.planFile as string, "utf-8");
    const body: Record<string, unknown> = {
      plan_yml: planYml,
      force: options.force === true,
      environment: options.environment,
    };
    const r = await daemonRequest("POST", "/v1/bootstrap/plan", body);
    outputJson(ok(r));
  })
  .addHelpText("after", `
Examples:
  # Phase 1: generate the plan, mint approval.
  secret-shuttle bootstrap

  # Phase 2: after approving in the hub, execute the plan.
  secret-shuttle bootstrap --continue --batch <batch-id> --approval-id <approval-id>

  # List persisted batches:
  secret-shuttle bootstrap --list

  # Cancel a batch (clean up persisted state):
  secret-shuttle bootstrap --abandon <batch-id>
`);
}
```

### Step 2: Register in CLI index

```ts
// src/cli/index.ts:
import { bootstrapCommand } from "./commands/bootstrap.js";

// in the registration block:
program.addCommand(bootstrapCommand());
```

### Step 3: Verify

```bash
npm run typecheck && npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
npm run build && node dist/cli/index.js bootstrap --help 2>&1 | head -20
```

Expected: bootstrap command appears with all flags.

### Step 4: Commit

```bash
git add src/cli/commands/bootstrap.ts src/cli/commands/bootstrap.test.ts src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli/bootstrap): secret-shuttle bootstrap command

Plan 5g step 11. CLI surface for the bootstrap flow:

  secret-shuttle bootstrap
    → Phase 1: read secret-shuttle.yml, post plan, get back
      approval_required with batch_id.
  secret-shuttle bootstrap --continue --batch <id> --approval-id <id>
    → Phase 2: consume approval, execute plan, return enum.
  secret-shuttle bootstrap --list
    → list all persisted batches.
  secret-shuttle bootstrap --abandon <id>
    → delete a persisted batch.

Flags: --plan-file, --force, --environment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task N — Help + docs + CHANGELOG + final verification

**Files:**
- `src/cli/commands/help.ts` — add bootstrap to curated list.
- `docs/cli-reference.md` — bootstrap section.
- `SKILL.md` — replace primitives-only example with bootstrap as primary path.
- `CHANGELOG.md` — Plan 5g section.

### Step 1: Curated help

```bash
grep -n "secrets\|run\|init\|keychain" src/cli/commands/help.ts | head -10
```

Add bootstrap with a one-line description:

```ts
{ name: "bootstrap", desc: "Provision an entire project's secrets in one approval (reads secret-shuttle.yml)." },
```

### Step 2: cli-reference.md

Add a `bootstrap` section near `init` and the other high-level commands. Mirror the existing section style. Include the yml example, the Phase 1/Phase 2 flow, --list, --abandon.

### Step 3: SKILL.md

The current SKILL.md likely shows `secrets set` / `template run` examples. Add a bootstrap example as the PRIMARY path; keep primitives below as the fallback.

### Step 4: CHANGELOG

```markdown
### Plan 5g — `secret-shuttle bootstrap`

**Added:**

- `secret-shuttle bootstrap` — provision an entire project's secrets in one approval. Reads `secret-shuttle.yml`, computes the diff vs. the vault, mints a single bootstrap-action approval covering the whole plan, returns `approval_required`. On `--continue --batch <id> --approval-id <id>`, walks the plan and calls existing primitives (generate / reveal-capture / template run) under the bootstrap approval's authority — no inner approvals needed.

- Supports four source kinds (`capture`, `random_32_bytes`, `random_64_bytes`, `existing`) and four destination shorthand families (`vercel:<env>`, `github-actions:<owner/repo>`, `cloudflare:<env>`, `supabase:<project>`).

- Partial-success semantics + diff-based idempotency. Re-running on a fully-set-up project is a fast no-op. Re-running after a partial failure retries only the failed steps.

- `bootstrap --list` and `bootstrap --abandon <id>` for batch state management.

- New error codes: `bootstrap_plan_invalid`, `bootstrap_batch_not_found`, `bootstrap_destination_unknown` (all with `next_action`).

- New audit actions: `bootstrap_plan`, `bootstrap_step`.

- New approval binding action: `"bootstrap"`. Hub UI renders the plan summary as a multi-secret card.

**Changed:**

- Internal: three route handlers (`/v1/secrets/generate`, `/v1/secrets/reveal-capture`, `/v1/templates/run`) refactored to expose their core logic as exported functions (`generateSecretCore`, `revealCaptureCore`, `runTemplateCore`). HTTP shells are unchanged externally; the executor uses the cores directly with a `bootstrapAuthority` context that bypasses inner `requireApprovals` calls.

**Internal:**

- `BootstrapStore` persists batch state to `${SHUTTLE_HOME}/bootstrap-batches/<id>.json` (mode 0600). 24h prune on daemon start.
```

### Step 5: Final verification

```bash
npm run typecheck
npm test 2>&1 | grep -E "^ℹ tests|^ℹ pass|^ℹ fail|^ℹ skipped" | tail -5
npm run check-pack 2>&1 | tail -5
```

Expected: clean.

### Step 6: Commit + push

```bash
git add src/cli/commands/help.ts docs/cli-reference.md SKILL.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): Plan 5g — secret-shuttle bootstrap

CHANGELOG entry, cli-reference section, SKILL.md update, and curated
help listing for the new bootstrap command.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push 2>&1 | tail -3
git log --oneline origin/main..HEAD  # empty
```

---

## Self-review

**Spec coverage:**
- §1 yml format → Task C ✓
- §2 bootstrap binding → Task E (action union) + Task K (binding shape in route) ✓
- §3 hub UI → Task L ✓
- §4 BootstrapStore → Task G ✓
- §5 executor → Task J ✓
- §6 bootstrap authority bypass → Task I ✓
- §7 CLI surface → Task M ✓
- §8 audit → Task F ✓
- §9 error registry → Task F ✓
- §10 test plan → covered across tasks ✓
- §11 CHANGELOG + docs → Task N ✓

**Placeholder scan:** no TBD/TODO patterns.

**Type consistency:**
- `BootstrapPlan` / `PlanEntry` / `ResolvedDestination` types defined in yml.ts and store.ts; used consistently across plan.ts and executor.ts.
- `BootstrapAuthority` defined in authority.ts; used in executor.ts and the three Core functions.
- `ExecutorDeps` signatures must match Task I's extracted core function signatures (call out in Task J).

**Init-test wording fix**: Task A (pre-work).

---

**End of plan.**
