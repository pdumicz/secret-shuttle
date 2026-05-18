# Agentic Blind Transactions — Phase 2 (`inject-submit`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon-owned `inject-submit` transaction: under blind mode the daemon injects a stored secret into a pre-marked field, clicks a pre-marked submit control, verifies an approved success marker, proves the raw secret is absent from every observable surface, and auto-resumes observation only when both checks pass.

**Architecture:** Mirrors the existing `POST /v1/secrets/inject` flow (pre-read → enforce domain → refuse if blind active → build binding → `requireApproval` → `blind.start` → `disableObservationDomains` → `severAgentConnections` → operate → pre-write failure ends blind & rethrows, post-write failure stays blind). Phase 1's opaque `BrowserHandleStore` + `revalidateHandle` supply the field/submit targets. New pieces: an extended `ApprovalBinding`, a new `inject_submit` `SecretAction` (fail-closed, no implicit grant), four daemon-internal `BrowserOps` methods (`injectIntoBackendNode`, `clickBackendNode`, `observeText`, `proveAbsence`), a separately-audited `autoResumeBlind` internal path that never weakens `/v1/blind/end`, and a new `POST /v1/secrets/inject-submit` route + CLI. Spec: [docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md](../specs/2026-05-18-agentic-blind-transactions-design.md) (signed off at commit `d1c89ed`).

**Tech Stack:** TypeScript (ESM, NodeNext, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Commander CLI, Node built-in `http` daemon, raw CDP over a pipe transport, `node:test` + `node:assert/strict` (tests build to `dist/` then run via `node --test`).

---

## Scope: this plan covers Phase 2 only

The spec (§14) defines five independently shippable phases. Phase 1 (Opaque Browser Handles) is **merged** (`origin/main` @ `491466e`, tag `phase1-handles-complete`). **This document is the complete, executable plan for Phase 2 (`inject-submit`)** — spec §3.4 (handle use), §4 (`inject-submit`), §5 (Absence Proof), §7 (audited auto-resume), §8 (audit events), the §12 `BrowserOps` slice for `injectIntoBackendNode`/`clickBackendNode`/`proveAbsence` (plus `observeText` for the §4.2-step-11 success wait), §13 test slices, §16 decisions.

**Out of this plan (their own future plans):** Plan 3 — `reveal-capture` (§6, `readBackendNodeValue`/`baselineCandidates`/`resolveWithinContainer`); Plan 4 — Templates (§9); Plan 5 — Skill + installers + doctor/health (§10, §11).

**Carried residual (release gate, Task 11):** the spec §13 **[P2a] Vercel real-page auto-resume validation gate** — a manual/scripted check on the live site, NOT a unit test, recorded as a release gate for the Phase-2 browser flow.

---

## Phase 2 File Structure

- **Modify** `src/vault/types.ts` — add `"inject_submit"` to the `SecretAction` union.
- **Modify** `src/vault/vault.ts` — extend `DEFAULT_ACTIONS` with `inject_submit`; change `upsertSecret` so an overwrite **preserves the existing `allowed_actions`** when the caller omits them (extended default applies to brand-new records only); an explicit caller-supplied `allowedActions` still wins.
- **Create** `src/vault/inject-submit-action.test.ts` — `SecretAction` default/overwrite-preserve/legacy-deny unit tests.
- **Modify** `src/daemon/api/routes/secrets.ts` — accept an optional validated `allowed_actions` in the `generate` route and pass it to `upsertSecret` (the explicit opt-in surface, §4.4); `export` the existing `enforceDomain` so the new route reuses it.
- **Modify** `src/cli/commands/generate.ts` — add a repeatable `--allow-action <action>` flag (explicit opt-in surface, §4.4).
- **Modify** `src/daemon/approvals/store.ts` — add `"inject_submit"` to the `ApprovalBinding.action` union; add non-display `submit_fingerprint`/`success_condition`/`auto_resume` (added to `bindingsMatch`) and display-only `field_handle_label`/`submit_handle_label` (excluded from matching).
- **Create** `src/daemon/approvals/binding-inject-submit.test.ts` — `bindingsMatch` new-field unit tests.
- **Modify** `src/daemon/approvals/ui.html` — add the `inject_submit` plain-language sentence, the prominent auto-resume disclosure line, the success-condition row, and the submit fingerprint in technical details.
- **Create** `src/daemon/approvals/ui-inject-submit.test.ts` — asserts `ui.html` contains the new copy.
- **Modify** `src/daemon/chrome/internal-ops.ts` — add `BackendNodeRef`/`AbsenceProofResult` types; extend `BrowserOps` + `CdpBrowserOps` with `observeText`, `proveAbsence`, `injectIntoBackendNode`, `clickBackendNode`.
- **Create** `src/daemon/chrome/absence-proof.test.ts` — scripted-CDP-transport tests for `proveAbsence`/`observeText`.
- **Create** `src/daemon/chrome/click-backend-node.test.ts` — scripted-CDP-transport tests for `clickBackendNode` (trusted input + occlusion guard) and `injectIntoBackendNode` (focus assertion).
- **Create** `src/daemon/blind-auto-resume.ts` — `autoResumeBlind()` audited internal path (§7).
- **Create** `src/daemon/blind-auto-resume.test.ts` — unit test for the audited path.
- **Modify** `src/daemon/audit.ts` — add `inject_submit`/`blind_auto_resume` actions and the `submitted`/`success_signal`/`absence_proof`/`blind_mode`/`op` fields.
- **Create** `src/daemon/api/routes/inject-submit.ts` — the `POST /v1/secrets/inject-submit` route.
- **Modify** `src/daemon/api/router.ts` — register the new route.
- **Modify** `src/daemon/api/routes.test.ts`, `src/e2e/stripe-to-vercel.test.ts`, `src/daemon/api/browser-handles-routes.test.ts` — extend the three existing `BrowserOps` stubs with the four new methods (kept compiling task-by-task).
- **Create** `src/daemon/api/inject-submit-routes.test.ts` — route behaviour tests.
- **Create** `src/cli/commands/inject-submit.ts` — the `inject-submit` CLI command.
- **Modify** `src/cli/index.ts` — register `injectSubmitCommand()`.
- **Create** `src/e2e/inject-submit-agentic.test.ts` — end-to-end no-raw-secret/no-observed-text agentic path.

**Branch:** all work on a feature branch (`git switch -c feat/inject-submit`) — do not implement on `main`. Phase 1 used this same lightweight branch model (it merged cleanly); mirror it.

Commands:
- Build: `npm run build`
- Typecheck only: `npm run typecheck`
- Full test: `npm test` (builds, then `node --test "dist/**/*.test.js"`)
- One test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/<path>.test.js`

---

### Task 1: Branch + `inject_submit` SecretAction + fail-closed vault defaults

**Files:**
- Modify: `src/vault/types.ts`
- Modify: `src/vault/vault.ts:16-21` (`DEFAULT_ACTIONS`), `src/vault/vault.ts:83` (`allowed_actions` assignment)
- Test: `src/vault/inject-submit-action.test.ts`

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git switch -c feat/inject-submit
```
Expected: `Switched to a new branch 'feat/inject-submit'`

- [ ] **Step 2: Write the failing vault test**

Create `src/vault/inject-submit-action.test.ts`:
```ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Vault } from "./vault.js";

async function withVault<T>(fn: (v: Vault) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-isa-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const key = randomBytes(32);
    const vault = new Vault(() => key);
    await vault.ensureInitialized();
    return await fn(vault);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("a newly created secret gets inject_submit in the extended default action set", async () => {
  await withVault(async (vault) => {
    const meta = await vault.upsertSecret({
      name: "WEBHOOK", environment: "production", source: "stripe",
      value: "whsec_v1", allowedDomains: ["dashboard.stripe.com"],
    });
    assert.equal(meta.allowed_actions.includes("inject_submit"), true);
  });
});

test("a legacy secret whose stored actions lack inject_submit is NOT implicitly granted it", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "LEGACY", environment: "production", source: "stripe",
      value: "whsec_legacy", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin"],
    });
    const rec = await vault.getSecret("ss://stripe/prod/LEGACY");
    assert.equal(rec.allowed_actions.includes("inject_submit"), false);
    assert.equal(rec.allowed_actions.includes("inject_into_field"), true);
  });
});

test("overwrite preserves existing allowed_actions when the caller omits them (no silent widening on force-rotate)", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "ROT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["inject_into_field"],
    });
    // force-rotate WITHOUT specifying allowedActions — must NOT acquire the extended default.
    await vault.upsertSecret({
      name: "ROT", environment: "production", source: "stripe",
      value: "v2", allowedDomains: ["dashboard.stripe.com"], force: true,
    });
    const rec = await vault.getSecret("ss://stripe/prod/ROT");
    assert.deepEqual(rec.allowed_actions, ["inject_into_field"]);
    assert.equal(rec.value, "v2");
  });
});

test("an explicit caller-supplied allowedActions still wins on overwrite (explicit opt-in path)", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "OPT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["inject_into_field"],
    });
    await vault.upsertSecret({
      name: "OPT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"], force: true,
      allowedActions: ["inject_into_field", "inject_submit"],
    });
    const rec = await vault.getSecret("ss://stripe/prod/OPT");
    assert.equal(rec.allowed_actions.includes("inject_submit"), true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/vault/inject-submit-action.test.js`
Expected: FAIL — the first test fails (`inject_submit` not in defaults) and the overwrite-preserve test fails (current code re-applies `DEFAULT_ACTIONS` on overwrite). It may FAIL to compile first: `Type '"inject_submit"' is not assignable to type 'SecretAction'` (`TS2322`) — that is the expected first failure; proceed to Step 4.

- [ ] **Step 4: Add `inject_submit` to the `SecretAction` union**

In `src/vault/types.ts`, replace the `SecretAction` type (lines 3-7):
```ts
export type SecretAction =
  | "capture_from_page"
  | "inject_into_field"
  | "compare_fingerprint"
  | "use_as_stdin"
  | "inject_submit";
```

- [ ] **Step 5: Extend the default set and fix overwrite-preserve**

In `src/vault/vault.ts`, replace the `DEFAULT_ACTIONS` constant (lines 16-21):
```ts
const DEFAULT_ACTIONS: SecretAction[] = [
  "capture_from_page",
  "inject_into_field",
  "compare_fingerprint",
  "use_as_stdin",
  "inject_submit",
];
```

Then in `src/vault/vault.ts`, replace the single line 83 (currently `allowed_actions: input.allowedActions ?? DEFAULT_ACTIONS,`) with:
```ts
      // Explicit caller-supplied actions win. Otherwise: a brand-new record gets
      // the extended default set; an OVERWRITE preserves the prior record's
      // allowed_actions so a force-rotate never silently widens scope (§4.4).
      allowed_actions:
        input.allowedActions ?? (existing !== undefined ? [...existing.allowed_actions] : DEFAULT_ACTIONS),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/vault/inject-submit-action.test.js`
Expected: PASS — 4 tests pass, 0 fail.

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all existing tests still green (the new union member is additive; existing secrets created in other tests now get `inject_submit` in defaults, which no existing assertion forbids).

- [ ] **Step 8: Commit**

```bash
git add src/vault/types.ts src/vault/vault.ts src/vault/inject-submit-action.test.ts
git commit -m "feat(inject-submit): add inject_submit SecretAction; preserve actions on overwrite (spec §4.4)"
```

---

### Task 2: Explicit opt-in surface — `generate` route + CLI `--allow-action`

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts:17-27` (`GenerateBody`), `:104-113` (generate `upsertSecret` call), `:361` (`export function enforceDomain`)
- Modify: `src/cli/commands/generate.ts`
- Test: `src/daemon/api/generate-allow-action.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `src/daemon/api/generate-allow-action.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-gaa-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("generate with explicit allowed_actions stores exactly those actions", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "K", environment: "development", source: "local",
      allowed_actions: ["inject_into_field"],
    });
    assert.equal(g.status, 200);
    const rec = await services.vault.getSecret("ss://local/dev/K");
    assert.deepEqual(rec.allowed_actions, ["inject_into_field"]);
  });
});

test("generate rejects an unknown action with bad_request", async () => {
  await withDaemon(async ({ port }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const g = await call(port, "POST", "/v1/secrets/generate", {
      name: "K2", environment: "development", source: "local",
      allowed_actions: ["not_a_real_action"],
    });
    assert.equal(g.status, 400);
    assert.equal((g.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("generate without allowed_actions gets the extended default (includes inject_submit)", async () => {
  await withDaemon(async ({ port, services }) => {
    await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(port, "POST", "/v1/secrets/generate", { name: "K3", environment: "development", source: "local" });
    const rec = await services.vault.getSecret("ss://local/dev/K3");
    assert.equal(rec.allowed_actions.includes("inject_submit"), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/generate-allow-action.test.js`
Expected: FAIL — first test fails (`allowed_actions` ignored; record has the full default set, not `["inject_into_field"]`).

- [ ] **Step 3: Add the validated passthrough + export `enforceDomain`**

In `src/daemon/api/routes/secrets.ts`, add `use-as-stdin`-style action validation. First add this constant immediately **above** `export function registerSecrets(` (after the `interface CompareBody {…}` block):
```ts
const SECRET_ACTIONS = new Set([
  "capture_from_page",
  "inject_into_field",
  "compare_fingerprint",
  "use_as_stdin",
  "inject_submit",
]);

function validatedActions(raw: unknown): import("../../../vault/types.js").SecretAction[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !SECRET_ACTIONS.has(x))) {
    throw new ShuttleError("bad_request", "allowed_actions: must be an array of known secret actions");
  }
  return raw as import("../../../vault/types.js").SecretAction[];
}
```

In the same file, extend the `GenerateBody` interface (lines 17-27) by adding one field before the closing brace:
```ts
  allowed_actions?: string[];
```

In the generate route, the `upsertSecret` call is `src/daemon/api/routes/secrets.ts:105-113`. Replace that call with:
```ts
      const meta = await services.vault.upsertSecret({
        name: b.name,
        environment: env,
        source: b.source ?? "local",
        value,
        ...(b.description !== undefined ? { description: b.description } : {}),
        allowedDomains: effectiveAllowed,
        ...(validatedActions(b.allowed_actions) !== undefined ? { allowedActions: validatedActions(b.allowed_actions) } : {}),
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
```

Finally, change the `enforceDomain` declaration at `src/daemon/api/routes/secrets.ts:361` from `function enforceDomain(` to:
```ts
export function enforceDomain(current: string, allowed: string[], action: string): void {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/generate-allow-action.test.js`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Add the CLI flag**

In `src/cli/commands/generate.ts`, add `collectRepeated` to the existing import from `./helpers.js` (it is already imported — confirm the import line reads `import { collectRepeated } from "./helpers.js";`; it does). Add the option after the existing `.option("--allow-domain …)` line:
```ts
    .option("--allow-action <action>", "Allowed secret action (repeatable). Omit to use defaults.", collectRepeated, [])
```

In the same file's `.action(async (options) => {` body, add — immediately **after** the `if (domains.length > 0) body.allowed_domains = domains;` line:
```ts
      const actions = options.allowAction as string[];
      if (actions.length > 0) body.allowed_actions = actions;
```

- [ ] **Step 6: Verify the CLI surface compiles**

Run: `npm run build && node dist/cli/index.js generate --help`
Expected: PASS — help lists `--allow-action <action>`; exit code 0.

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/api/routes/secrets.ts src/cli/commands/generate.ts src/daemon/api/generate-allow-action.test.ts
git commit -m "feat(inject-submit): explicit --allow-action opt-in surface; export enforceDomain"
```

---

### Task 3: Extend `ApprovalBinding` + `bindingsMatch`

**Files:**
- Modify: `src/daemon/approvals/store.ts:12-28` (`ApprovalBinding`), `:118-133` (`bindingsMatch`)
- Test: `src/daemon/approvals/binding-inject-submit.test.ts`

- [ ] **Step 1: Write the failing binding test**

Create `src/daemon/approvals/binding-inject-submit.test.ts`:
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalStore, type ApprovalBinding } from "./store.js";

function base(): ApprovalBinding {
  return {
    action: "inject_submit",
    ref: "ss://stripe/prod/WH",
    environment: "production",
    destination_domain: "vercel.com",
    target_id: "T-1",
    field_fingerprint: "sha256:field",
    template_id: null,
    template_params: null,
    submit_fingerprint: "sha256:submit",
    success_condition: "Environment Variable Added",
    auto_resume: true,
    field_handle_label: "value-field",
    submit_handle_label: "submit-button",
  };
}

test("a matching inject_submit binding round-trips through create→consume", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, base());
  assert.equal(used.status, "used");
});

test("a different submit_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), submit_fingerprint: "sha256:OTHER" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different success_condition is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), success_condition: "Something Else" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("display-only handle labels are NOT part of matching", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, { ...base(), field_handle_label: "renamed", submit_handle_label: "renamed2" });
  assert.equal(used.status, "used");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Type '"inject_submit"' is not assignable` and `Object literal may only specify known properties` for `submit_fingerprint` (`TS2322`/`TS2353`). That is the expected first failure.

- [ ] **Step 3: Extend the binding type and matcher**

In `src/daemon/approvals/store.ts`, replace the `ApprovalBinding` interface (lines 12-28) with:
```ts
export interface ApprovalBinding {
  action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit";
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
  /** Non-display: part of bindingsMatch (strict equality). */
  submit_fingerprint?: string | null;
  success_condition?: string | null;
  auto_resume?: boolean | null;
  /** Display-only context for the human approver. NOT part of bindingsMatch. */
  page_title?: string | null;
  page_url_host?: string | null;
  field_handle_label?: string | null;
  submit_handle_label?: string | null;
}
```

In the same file, replace the `bindingsMatch` function (lines 118-133) with:
```ts
function bindingsMatch(a: ApprovalBinding, b: ApprovalBinding): boolean {
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
    (a.submit_fingerprint ?? null) === (b.submit_fingerprint ?? null) &&
    (a.success_condition ?? null) === (b.success_condition ?? null) &&
    (a.auto_resume ?? null) === (b.auto_resume ?? null)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/binding-inject-submit.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — existing approval/binding tests unaffected (new fields are optional and only add equality clauses that are `null === null` for existing bindings).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/binding-inject-submit.test.ts
git commit -m "feat(inject-submit): extend ApprovalBinding (submit_fingerprint/success_condition/auto_resume) + bindingsMatch"
```

---

### Task 4: Approval UI — `inject_submit` plain language + auto-resume disclosure

**Files:**
- Modify: `src/daemon/approvals/ui.html:30-37` (the `human` map), `:54-56` (technical details + warning)
- Test: `src/daemon/approvals/ui-inject-submit.test.ts`

- [ ] **Step 1: Write the failing UI-content test**

Create `src/daemon/approvals/ui-inject-submit.test.ts`:
```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

test("ui.html has an inject_submit plain-language sentence with the field/submit labels and domain", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /inject_submit:/);
  assert.match(html, /field_handle_label/);
  assert.match(html, /submit_handle_label/);
});

test("ui.html renders the explicit auto-resume disclosure for inject_submit", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /auto-resume observation only if the secret is verified gone/i);
});

test("ui.html shows the success condition and the submit fingerprint", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /success_condition/);
  assert.match(html, /submit_fingerprint/);
});
```

> Note: copy `ui.html` into `dist/` is handled by the build (the daemon serves it from source path at runtime; this test reads the **source** `ui.html` next to the compiled test via the same relative layout — `src/daemon/approvals/ui.html`). The test resolves `ui.html` relative to the compiled test file in `dist/daemon/approvals/`, so the build must place `ui.html` there. Confirm in Step 4 that `npm run build` copies it; if it does not, the daemon's existing `ui-server.ts` reveals the canonical path — match it. (Phase-1 `npm run build` already copies `ui.html`; this is verified in Step 4.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/ui-inject-submit.test.js`
Expected: FAIL — `inject_submit:` / disclosure / `success_condition` substrings not present.

- [ ] **Step 3: Add the `inject_submit` copy to `ui.html`**

In `src/daemon/approvals/ui.html`, the `human` map is lines 30-37. Replace the `blind_end:` entry line (currently `          blind_end: \`Resume browser observation for ${esc(g.destination_domain ?? "?")}\`,`) with these two lines (adds `inject_submit` before `blind_end`):
```js
          inject_submit: `Inject secret ${esc(g.ref ?? "")} into <b>${esc(g.field_handle_label ?? "?")}</b> on ${esc(g.destination_domain ?? "?")}, click <b>${esc(g.submit_handle_label ?? "?")}</b>, wait for success, and automatically resume observation only if the secret is verified gone`,
          blind_end: `Resume browser observation for ${esc(g.destination_domain ?? "?")}`,
```

In the same file, replace the technical-details `<details>` block lines 49-55 (from `<details style="margin-top:.5rem">` through its closing `</details>`) with:
```js
          ${g.success_condition ? `<div class="row"><span class="label">Success marker</span><code>${esc(g.success_condition)}</code></div>` : ""}
          <details style="margin-top:.5rem">
            <summary class="label">Technical details</summary>
            ${g.template_binary_path ? `<div class="row"><span class="label">Binary</span><code>${esc(g.template_binary_path)}</code></div>` : ""}
            ${g.template_binary_sha256 ? `<div class="row"><span class="label">Binary sha256</span><code>${esc(g.template_binary_sha256)}</code></div>` : ""}
            ${g.target_id ? `<div class="row"><span class="label">Browser target</span><code>${esc(g.target_id)}</code></div>` : ""}
            ${g.field_fingerprint ? `<div class="row"><span class="label">Field fingerprint</span><code>${esc(g.field_fingerprint)}</code></div>` : ""}
            ${g.submit_fingerprint ? `<div class="row"><span class="label">Submit fingerprint</span><code>${esc(g.submit_fingerprint)}</code></div>` : ""}
          </details>
```

In the same file, replace the `blind_end` warning line (line 56, `${g.action === "blind_end" ? \`<div class="row" style="color:#c33">…</div>\` : ""}`) with:
```js
          ${g.action === "blind_end" ? `<div class="row" style="color:#c33"><b>Approving navigates open pages to about:blank and resumes observation. Approve only if the secret has been saved/submitted and is no longer visible.</b></div>` : ""}
          ${g.action === "inject_submit" ? `<div class="row" style="color:#c33"><b>Approving authorizes the daemon to auto-resume observation only if the secret is verified gone (success marker observed AND the raw secret absent from every observable surface). If either check does not pass, blind mode stays on.</b></div>` : ""}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/ui-inject-submit.test.js`
Expected: PASS — 3 tests pass. (If the test cannot find `dist/daemon/approvals/ui.html`, inspect `package.json` `build` script / `src/daemon/approvals/ui-server.ts` for the canonical served path and adjust the test's `UI` resolution to that path — the assertion content does not change.)

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/approvals/ui.html src/daemon/approvals/ui-inject-submit.test.ts
git commit -m "feat(inject-submit): approval UI plain-language + auto-resume disclosure"
```

---

### Task 5: `BrowserOps` — `observeText` + `proveAbsence` (daemon-only page reads, boolean only)

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (types + `BrowserOps` interface + `CdpBrowserOps`)
- Modify: `src/daemon/api/routes.test.ts`, `src/e2e/stripe-to-vercel.test.ts`, `src/daemon/api/browser-handles-routes.test.ts` (stub fixups — same task to keep the tree green)
- Test: `src/daemon/chrome/absence-proof.test.ts`

- [ ] **Step 1: Write the failing scripted-transport test**

Create `src/daemon/chrome/absence-proof.test.ts`:
```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { CdpBrowserOps } from "./internal-ops.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

class ScriptedTransport extends EventEmitter implements CdpTransport {
  // Configure the single page target's Runtime.evaluate result.
  scanValue: { found?: boolean; inconclusive?: boolean } | undefined = { found: false, inconclusive: false };
  scanThrows = false;
  observeValue: { host?: string; has?: boolean } = { host: "vercel.com", has: true };

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    const fail = (m: string): void => queueMicrotask(() => this.emit("message", { id: msg.id, error: { code: -1, message: m } }));
    switch (msg.method) {
      case "Target.getTargets":
        reply({ targetInfos: [{ targetId: "T-1", type: "page", url: "https://vercel.com/app" }] });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: "S-1" });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      case "Runtime.evaluate": {
        const expr = String(msg.params?.["expression"] ?? "");
        if (this.scanThrows) { fail("evaluate boom"); return; }
        // The absence scan calls the embedded fn with the secret; observeText embeds the needle.
        if (expr.includes("scanDoc") || expr.includes("__ABSENCE__")) {
          reply({ result: { value: this.scanValue } });
        } else {
          reply({ result: { value: this.observeValue } });
        }
        return;
      }
      default:
        reply({});
        return;
    }
  }
}

test("proveAbsence passes when every page scans clean and conclusive", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: false, inconclusive: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: true });
});

test("proveAbsence fails closed when the secret is present", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: true, inconclusive: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on an inconclusive surface (cross-origin/inaccessible frame)", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: false, inconclusive: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on any evaluate/CDP error", async () => {
  const t = new ScriptedTransport();
  t.scanThrows = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on an empty secret", async () => {
  const ops = new CdpBrowserOps(new CdpClient(new ScriptedTransport()));
  assert.deepEqual(await ops.proveAbsence(""), { passed: false });
});

test("observeText returns true when the marker is in innerText on the bound domain", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "vercel.com", has: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 1_000), true);
});

test("observeText returns false (no throw) when the marker never appears before timeout", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "vercel.com", has: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 300), false);
});

test("observeText ignores matches on a different host", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "evil.example.com", has: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 300), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Property 'proveAbsence' does not exist on type 'CdpBrowserOps'` (`TS2339`). Expected first failure.

- [ ] **Step 3: Add the types + interface methods**

In `src/daemon/chrome/internal-ops.ts`, add immediately **below** the existing `export interface HandleDescriptor { … }` block:
```ts
export interface BackendNodeRef {
  target_id: string;
  backend_node_id: number;
}

export interface AbsenceProofResult {
  passed: boolean;
}
```

In the same file, extend the `BrowserOps` interface — add these two lines immediately after the existing `revalidateHandle(...)` member, before the closing `}`:
```ts
  observeText(domain: string, text: string, timeoutMs: number): Promise<boolean>;
  proveAbsence(secret: string): Promise<AbsenceProofResult>;
```

- [ ] **Step 4: Add the in-page scan scripts + the two `CdpBrowserOps` methods**

In `src/daemon/chrome/internal-ops.ts`, add these two module-level constants immediately **below** the existing `export const NORMALIZE_TO_ACTIONABLE_FN = …;` block:
```ts
// Daemon-only. Runs in the page under the daemon's internal CDP (agent severed).
// Returns ONLY booleans — never the secret, never where it was found (§5.1/§5.3).
// "__ABSENCE__" marker lets the scripted test transport route this expression.
const ABSENCE_SCAN_FN = `function(secret){ /* __ABSENCE__ */
  try {
    if (typeof secret !== "string" || secret === "") return { found:false, inconclusive:true };
    const hit = (s) => typeof s === "string" && s.indexOf(secret) !== -1;
    function scanDoc(doc){
      try {
        const w = doc.defaultView, l = w && w.location;
        if (l && (hit(l.href) || hit(l.search) || hit(l.hash))) return { hit:true };
      } catch (e) { return { inconclusive:true }; }
      let n = 0;
      const stack = doc.documentElement ? [doc.documentElement] : [];
      while (stack.length) {
        const el = stack.pop();
        if (!el) continue;
        if (++n > 200000) return { inconclusive:true };
        if (el.attributes) {
          for (const a of el.attributes) {
            const nm = a.name;
            if (nm === "value" || nm === "placeholder" || nm === "title" || nm === "aria-label" || nm.indexOf("data-") === 0) {
              if (hit(a.value)) return { hit:true };
            }
          }
        }
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && hit(el.value)) return { hit:true };
        try { if (el.isContentEditable && hit(el.innerText)) return { hit:true }; } catch (e) {}
        if (el.shadowRoot) { for (const c of el.shadowRoot.children) stack.push(c); }
        if (el.children) { for (const c of el.children) stack.push(c); }
      }
      try { if (doc.body && hit(doc.body.innerText)) return { hit:true }; } catch (e) {}
      let frames;
      try { frames = doc.querySelectorAll("iframe,frame"); } catch (e) { return { inconclusive:true }; }
      for (const f of frames) {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { return { inconclusive:true }; }
        if (cd === null) return { inconclusive:true };
        const r = scanDoc(cd);
        if (r.hit) return { hit:true };
        if (r.inconclusive) return { inconclusive:true };
      }
      return {};
    }
    const r = scanDoc(document);
    if (r.inconclusive) return { found:false, inconclusive:true };
    return { found: r.hit === true, inconclusive:false };
  } catch (e) { return { found:false, inconclusive:true }; }
}`;

const OBSERVE_TEXT_FN = `function(needle){
  try {
    const t = (document.body && document.body.innerText) || "";
    return { host: location.host, has: typeof needle === "string" && needle !== "" && t.indexOf(needle) !== -1 };
  } catch (e) { return { host:"", has:false }; }
}`;
```

In the same file, add these two methods to the `CdpBrowserOps` class immediately **after** the existing `async revalidateHandle(...) { … }` method (before the class's closing `}`):
```ts
  async proveAbsence(secret: string): Promise<AbsenceProofResult> {
    if (secret === "") return { passed: false };
    let targets: { targetInfos: { targetId: string; type: string }[] };
    try {
      targets = await this.cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    } catch {
      return { passed: false };
    }
    for (const t of targets.targetInfos.filter((x) => x.type === "page")) {
      let sessionId = "";
      try {
        const a = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        sessionId = a.sessionId;
        const r = await this.cdp.send<{ result: { value?: { found?: boolean; inconclusive?: boolean } }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression: `(${ABSENCE_SCAN_FN})(${JSON.stringify(secret)})`, returnByValue: true, awaitPromise: false },
          sessionId,
        );
        if (r.exceptionDetails !== undefined) return { passed: false };
        const v = r.result.value;
        if (v === undefined || v.inconclusive === true || v.found !== false) return { passed: false };
      } catch {
        return { passed: false };
      } finally {
        if (sessionId !== "") await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
    }
    return { passed: true };
  }

  async observeText(domain: string, text: string, timeoutMs: number): Promise<boolean> {
    const norm = domain.toLowerCase();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      let targets: { targetInfos: { targetId: string; type: string }[] };
      try {
        targets = await this.cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      } catch {
        return false;
      }
      for (const t of targets.targetInfos.filter((x) => x.type === "page")) {
        let sessionId = "";
        try {
          const a = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
          sessionId = a.sessionId;
          const r = await this.cdp.send<{ result: { value?: { host?: string; has?: boolean } } }>(
            "Runtime.evaluate",
            { expression: `(${OBSERVE_TEXT_FN})(${JSON.stringify(text)})`, returnByValue: true, awaitPromise: false },
            sessionId,
          );
          const v = r.result.value;
          if (v !== undefined && typeof v.host === "string") {
            const h = v.host.toLowerCase();
            if ((h === norm || h.endsWith(`.${norm}`)) && v.has === true) return true;
          }
        } catch {
          // ignore this target for this poll round
        } finally {
          if (sessionId !== "") await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        }
      }
      if (Date.now() >= deadline) return false;
      await new Promise((res) => setTimeout(res, 200));
    }
  }
```

- [ ] **Step 5: Fix the three existing `BrowserOps` stubs (keep the tree green)**

In `src/daemon/api/routes.test.ts`, in `stubBrowser`, add immediately after the `revalidateHandle: async () => undefined,` line (inside the returned object):
```ts
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
```

In `src/e2e/stripe-to-vercel.test.ts`, in `stubBrowser`, add immediately after its `revalidateHandle: async () => undefined,` line:
```ts
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
```

In `src/daemon/api/browser-handles-routes.test.ts`, in `stub`, add immediately after its `revalidateHandle: async () => undefined,` line:
```ts
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
```

- [ ] **Step 6: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/chrome/absence-proof.test.js`
Expected: PASS — 8 tests pass.

Run: `npm test`
Expected: PASS — all existing tests green (the three stub fixups satisfy the extended interface).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/absence-proof.test.ts src/daemon/api/routes.test.ts src/e2e/stripe-to-vercel.test.ts src/daemon/api/browser-handles-routes.test.ts
git commit -m "feat(inject-submit): proveAbsence + observeText (daemon-only, boolean-only) + stub fixups"
```

---

### Task 6: `BrowserOps` — `injectIntoBackendNode` + `clickBackendNode` (trusted input + occlusion guard)

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (`BrowserOps` interface + `CdpBrowserOps` + a `polygonArea` helper)
- Modify: `src/daemon/api/routes.test.ts`, `src/e2e/stripe-to-vercel.test.ts`, `src/daemon/api/browser-handles-routes.test.ts` (stub fixups)
- Test: `src/daemon/chrome/click-backend-node.test.ts`

- [ ] **Step 1: Write the failing scripted-transport test**

Create `src/daemon/chrome/click-backend-node.test.ts`:
```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { CdpBrowserOps } from "./internal-ops.js";
import { ShuttleError } from "../../shared/errors.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

class ClickTransport extends EventEmitter implements CdpTransport {
  quads: number[][] = [[10, 10, 30, 10, 30, 30, 10, 30]]; // 20x20 square, center (20,20)
  hitBackendNodeId = 55;          // what DOM.getNodeForLocation returns
  containsResult = false;         // ancestor.contains(hitNode) result
  mouseEvents: string[] = [];

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    switch (msg.method) {
      case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
      case "Target.detachFromTarget":
      case "DOM.scrollIntoViewIfNeeded":
      case "Runtime.releaseObject": reply({}); return;
      case "DOM.getContentQuads": reply({ quads: this.quads }); return;
      case "DOM.getBoxModel":
        reply({ model: { content: [10, 10, 30, 10, 30, 30, 10, 30], width: 20, height: 20 } });
        return;
      case "DOM.getNodeForLocation": reply({ backendNodeId: this.hitBackendNodeId }); return;
      case "DOM.resolveNode": reply({ object: { objectId: `obj-${Math.random()}` } }); return;
      case "Runtime.callFunctionOn": reply({ result: { value: this.containsResult } }); return;
      case "Input.dispatchMouseEvent":
        this.mouseEvents.push(String(msg.params?.["type"]));
        reply({});
        return;
      default: reply({}); return;
    }
  }
}

test("clickBackendNode dispatches trusted move→press→release when the point hits the handle node", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 55;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 });
  assert.deepEqual(t.mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("clickBackendNode passes when the hit node is a DESCENDANT of the handle (icon/text button inner span)", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 999;     // inner span
  t.containsResult = true;       // handle.contains(span) === true
  const ops = new CdpBrowserOps(new CdpClient(t));
  await ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 });
  assert.deepEqual(t.mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("clickBackendNode fails closed when the point is occluded (hit node not contained)", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 999;
  t.containsResult = false;      // an overlay covers the button
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "click_occluded",
  );
  assert.deepEqual(t.mouseEvents, []);
});

test("clickBackendNode fails closed on a zero-area / missing box", async () => {
  const t = new ClickTransport();
  t.quads = []; // no content quads
  // Override getBoxModel to a zero box for this case:
  const origSend = t.send.bind(t);
  t.send = (msg: Sent) => {
    if (msg.method === "DOM.getBoxModel") {
      queueMicrotask(() => t.emit("message", { id: msg.id, result: { model: { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 } } }));
      return;
    }
    origSend(msg);
  };
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "click_no_box",
  );
});

test("injectIntoBackendNode focuses the node, asserts activeElement, then writes via the existing path", async () => {
  class InjectTransport extends EventEmitter implements CdpTransport {
    activeBackend = 77;
    send(msg: Sent): void {
      const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
      switch (msg.method) {
        case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
        case "Target.detachFromTarget":
        case "DOM.focus":
        case "Runtime.releaseObject": reply({}); return;
        case "Runtime.evaluate": {
          const expr = String(msg.params?.["expression"] ?? "");
          if (expr.includes("document.activeElement") && msg.params?.["returnByValue"] === false) {
            reply({ result: { objectId: "ae-1" } });
          } else {
            reply({ result: { value: { ok: true, field: { tag: "input", editable: true }, domain: "vercel.com" } } });
          }
          return;
        }
        case "DOM.requestNode": reply({ nodeId: 1 }); return;
        case "DOM.describeNode": reply({ node: { backendNodeId: this.activeBackend } }); return;
        default: reply({}); return;
      }
    }
  }
  const t = new InjectTransport();
  t.activeBackend = 77;
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.injectIntoBackendNode({ target_id: "T-1", backend_node_id: 77 }, "whsec_value");
  assert.equal(r.domain, "vercel.com");
  assert.equal(r.target_id, "T-1");

  const t2 = new InjectTransport();
  t2.activeBackend = 999; // focus landed elsewhere
  const ops2 = new CdpBrowserOps(new CdpClient(t2));
  await assert.rejects(
    () => ops2.injectIntoBackendNode({ target_id: "T-1", backend_node_id: 77 }, "whsec_value"),
    (e: unknown) => e instanceof ShuttleError && e.code === "inject_focus_mismatch",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Property 'clickBackendNode' does not exist on type 'CdpBrowserOps'` (`TS2339`). Expected first failure.

- [ ] **Step 3: Extend the interface and implement on `CdpBrowserOps`**

In `src/daemon/chrome/internal-ops.ts`, extend the `BrowserOps` interface — add these two lines immediately after the `proveAbsence(...)` member added in Task 5, before the closing `}`:
```ts
  injectIntoBackendNode(ref: BackendNodeRef, value: string): Promise<InjectResult>;
  clickBackendNode(ref: BackendNodeRef): Promise<void>;
```

In the same file, add this module-level helper immediately **below** the existing `function handleFingerprint(...) { … }`:
```ts
function polygonArea(xs: number[], ys: number[]): number {
  let a = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    a += (xs[i] ?? 0) * (ys[j] ?? 0) - (xs[j] ?? 0) * (ys[i] ?? 0);
  }
  return Math.abs(a) / 2;
}
```

In the same file, add these three methods to the `CdpBrowserOps` class immediately **after** the `async observeText(...) { … }` method added in Task 5 (before the class's closing `}`):
```ts
  async injectIntoBackendNode(ref: BackendNodeRef, value: string): Promise<InjectResult> {
    const sessionId = await this.attach(ref.target_id);
    try {
      await this.cdp.send("DOM.focus", { backendNodeId: ref.backend_node_id }, sessionId);
      const ev = await this.cdp.send<{ result: { objectId?: string } }>(
        "Runtime.evaluate",
        { expression: "document.activeElement", returnByValue: false },
        sessionId,
      );
      const objectId = ev.result.objectId;
      if (objectId === undefined) throw new ShuttleError("inject_focus_failed", "Focus did not land on an element.");
      let activeBackend: number;
      try {
        const rn = await this.cdp.send<{ nodeId: number }>("DOM.requestNode", { objectId }, sessionId);
        const d = await this.cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId: rn.nodeId }, sessionId);
        activeBackend = d.node.backendNodeId;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
      }
      if (activeBackend !== ref.backend_node_id) {
        throw new ShuttleError("inject_focus_mismatch", "Focused element is not the marked field.");
      }
      const r = await this.cdp.send<{ result: { value: { ok: boolean; field?: FieldDescriptor; domain?: string; reason?: string } } }>(
        "Runtime.evaluate",
        { expression: WRITE_SCRIPT(value), returnByValue: true, awaitPromise: false },
        sessionId,
      );
      const res = r.result.value;
      if (!res.ok || res.field === undefined || res.domain === undefined) {
        throw new ShuttleError("inject_failed", res.reason ?? "Could not write to the marked field.");
      }
      const fp = fieldFingerprint(res.domain.toLowerCase(), ref.target_id, ref.backend_node_id, res.field);
      return { domain: res.domain.toLowerCase(), target_id: ref.target_id, field: res.field, field_fingerprint: fp };
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  private async isDescendantOf(sessionId: string, ancestorBackendNodeId: number, candidateBackendNodeId: number): Promise<boolean> {
    const a = await this.cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: ancestorBackendNodeId }, sessionId);
    try {
      const d = await this.cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: candidateBackendNodeId }, sessionId);
      try {
        const r = await this.cdp.send<{ result: { value: boolean } }>(
          "Runtime.callFunctionOn",
          {
            objectId: a.object.objectId,
            returnByValue: true,
            arguments: [{ objectId: d.object.objectId }],
            functionDeclaration: "function(other){ return this.contains(other); }",
          },
          sessionId,
        );
        return r.result.value === true;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: d.object.objectId }, sessionId).catch(() => undefined);
      }
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: a.object.objectId }, sessionId).catch(() => undefined);
    }
  }

  async clickBackendNode(ref: BackendNodeRef): Promise<void> {
    const sessionId = await this.attach(ref.target_id);
    try {
      await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backend_node_id }, sessionId).catch(() => undefined);
      const cq = await this.cdp
        .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: ref.backend_node_id }, sessionId)
        .catch(() => ({ quads: [] as number[][] }));
      let point: { x: number; y: number } | null = null;
      for (const q of cq.quads) {
        if (q.length === 8) {
          const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
          const ys = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
          if (polygonArea(xs, ys) > 1) {
            point = { x: (xs[0] + xs[1] + xs[2] + xs[3]) / 4, y: (ys[0] + ys[1] + ys[2] + ys[3]) / 4 };
            break;
          }
        }
      }
      if (point === null) {
        const bm = await this.cdp
          .send<{ model?: { content: number[]; width: number; height: number } }>("DOM.getBoxModel", { backendNodeId: ref.backend_node_id }, sessionId)
          .catch(() => ({} as { model?: { content: number[]; width: number; height: number } }));
        const m = bm.model;
        if (m === undefined || m.width <= 0 || m.height <= 0 || m.content.length < 8) {
          throw new ShuttleError("click_no_box", "Submit control has no visible box.");
        }
        const c = m.content;
        point = {
          x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4,
          y: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4,
        };
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
        throw new ShuttleError("click_offscreen", "Submit control is off-screen.");
      }
      const hit = await this.cdp
        .send<{ backendNodeId?: number }>("DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false }, sessionId)
        .catch(() => ({} as { backendNodeId?: number }));
      const hitBackend = hit.backendNodeId;
      if (hitBackend === undefined) throw new ShuttleError("click_hit_test_failed", "Could not hit-test the submit point.");
      if (hitBackend !== ref.backend_node_id) {
        const contained = await this.isDescendantOf(sessionId, ref.backend_node_id, hitBackend).catch(() => false);
        if (!contained) throw new ShuttleError("click_occluded", "Submit point is covered by another element.");
      }
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
```

- [ ] **Step 4: Fix the three existing `BrowserOps` stubs (keep the tree green)**

In `src/daemon/api/routes.test.ts`, in `stubBrowser`, add immediately after the `proveAbsence: async () => ({ passed: true }),` line added in Task 5:
```ts
    injectIntoBackendNode: async () => ({ domain: s.domain, target_id: s.target, field, field_fingerprint: fp }),
    clickBackendNode: async () => undefined,
```

In `src/e2e/stripe-to-vercel.test.ts`, in `stubBrowser`, add immediately after its `proveAbsence: async () => ({ passed: true }),` line:
```ts
    injectIntoBackendNode: async () => ({ domain: state.domain, target_id: state.target, field, field_fingerprint: fingerprint }),
    clickBackendNode: async () => undefined,
```

In `src/daemon/api/browser-handles-routes.test.ts`, in `stub`, add immediately after its `proveAbsence: async () => ({ passed: true }),` line:
```ts
    injectIntoBackendNode: async () => ({ domain: base.domain, target_id: base.target_id, field: { tag: "input", editable: true }, field_fingerprint: base.handle_fingerprint }),
    clickBackendNode: async () => undefined,
```

- [ ] **Step 5: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/chrome/click-backend-node.test.js`
Expected: PASS — 5 tests pass.

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/click-backend-node.test.ts src/daemon/api/routes.test.ts src/e2e/stripe-to-vercel.test.ts src/daemon/api/browser-handles-routes.test.ts
git commit -m "feat(inject-submit): injectIntoBackendNode + clickBackendNode (trusted input, occlusion guard)"
```

---

### Task 7: Audited internal auto-resume path + audit vocabulary

**Files:**
- Modify: `src/daemon/audit.ts:4-24`
- Create: `src/daemon/blind-auto-resume.ts`
- Test: `src/daemon/blind-auto-resume.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/blind-auto-resume.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { autoResumeBlind } from "./blind-auto-resume.js";
import { getShuttlePaths } from "../shared/config.js";

test("autoResumeBlind ends blind WITHOUT approval/blank and writes a distinct blind_auto_resume audit record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ar-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("vercel.com", "inject_submit");
    assert.notEqual(services.blind.current(), null);

    await autoResumeBlind(services, {
      op: "inject_submit", domain: "vercel.com",
      success_signal: "text_matched", absence_proof: "passed",
    });

    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rec = lines.find((l) => l.action === "blind_auto_resume");
    assert.ok(rec, "a blind_auto_resume record must exist");
    assert.equal(rec!.ok, true);
    assert.equal(rec!.domain, "vercel.com");
    assert.equal(rec!.op, "inject_submit");
    assert.equal(rec!.success_signal, "text_matched");
    assert.equal(rec!.absence_proof, "passed");
    // It must NOT be a blind_end record (the human path is separate & unchanged).
    assert.equal(lines.some((l) => l.action === "blind_end"), false);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind refuses (throws) if its preconditions are not both passed", async () => {
  const services = new DaemonServices();
  services.blind.start("vercel.com", "inject_submit");
  await assert.rejects(
    () => autoResumeBlind(services, {
      op: "inject_submit", domain: "vercel.com",
      success_signal: "text_matched",
      // @ts-expect-error intentionally wrong to prove the guard
      absence_proof: "inconclusive",
    }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "auto_resume_precondition",
  );
  assert.notEqual(services.blind.current(), null); // stays blind
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Cannot find module './blind-auto-resume.js'` (`TS2307`). Expected first failure.

- [ ] **Step 3: Extend the audit vocabulary**

In `src/daemon/audit.ts`, replace the `DaemonAuditAction` type (lines 4-10) with:
```ts
export type DaemonAuditAction =
  | "init" | "unlock" | "lock"
  | "blind_start" | "blind_end" | "blind_auto_resume"
  | "generate" | "capture" | "inject" | "inject_submit" | "compare"
  | "template_run"
  | "approval_created" | "approval_granted" | "approval_denied"
  | "approval_expired" | "approval_used" | "approval_mismatch";
```

In the same file, replace the `DaemonAuditEvent` interface (lines 12-24) with:
```ts
export interface DaemonAuditEvent {
  action: DaemonAuditAction;
  ok: boolean;
  ref?: string;
  planned_ref?: string;
  environment?: string;
  destination_environment?: string;
  domain?: string;
  template_id?: string;
  approval_id?: string;
  error_code?: string;
  message?: string;
  submitted?: boolean | "unknown";
  success_signal?: string;
  absence_proof?: string;
  blind_mode?: boolean;
  op?: string;
}
```

- [ ] **Step 4: Create the audited auto-resume path**

Create `src/daemon/blind-auto-resume.ts`:
```ts
import { ShuttleError } from "../shared/errors.js";
import { writeDaemonAudit } from "./audit.js";
import type { DaemonServices } from "./services.js";

export interface AutoResumeArgs {
  op: "inject_submit" | "reveal_capture";
  domain: string;
  success_signal: "text_matched";
  absence_proof: "passed";
}

/**
 * Spec §7. NOT a call to /v1/blind/end and must never weaken it.
 * Asserts the success+proof preconditions, then ends blind directly — WITHOUT a
 * human approval and WITHOUT blankAllPages (the absence proof already established
 * the secret is gone; the page is the proven-clean post-transaction state). Writes
 * its OWN audit record under the distinct `blind_auto_resume` action. Never
 * carries the secret or observed text.
 */
export async function autoResumeBlind(services: DaemonServices, args: AutoResumeArgs): Promise<void> {
  if (args.success_signal !== "text_matched" || args.absence_proof !== "passed") {
    throw new ShuttleError(
      "auto_resume_precondition",
      "autoResumeBlind requires success_signal=text_matched AND absence_proof=passed.",
    );
  }
  services.blind.end();
  await writeDaemonAudit({
    action: "blind_auto_resume",
    ok: true,
    domain: args.domain,
    op: args.op,
    success_signal: args.success_signal,
    absence_proof: args.absence_proof,
  });
}
```

- [ ] **Step 5: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/blind-auto-resume.test.js`
Expected: PASS — 2 tests pass.

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/audit.ts src/daemon/blind-auto-resume.ts src/daemon/blind-auto-resume.test.ts
git commit -m "feat(inject-submit): separately-audited autoResumeBlind path (spec §7) + audit vocabulary"
```

---

### Task 8: The `POST /v1/secrets/inject-submit` route

**Files:**
- Create: `src/daemon/api/routes/inject-submit.ts`
- Modify: `src/daemon/api/router.ts`
- Test: `src/daemon/api/inject-submit-routes.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `src/daemon/api/inject-submit-routes.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import { getShuttlePaths } from "../../shared/config.js";
import type { BrowserOps } from "../chrome/internal-ops.js";

function stub(over: Partial<BrowserOps> = {}): BrowserOps {
  const inj = { domain: "vercel.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "vercel.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
    ...over,
  };
}

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices; home: string }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-is-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services, home });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SECRET = "whsec_must_never_leak_value";

async function setup(services: DaemonServices, port: number, opts: { allowedActions?: string[] } = {}) {
  await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
  await services.vault.upsertSecret({
    name: "WH", environment: "production", source: "stripe", value: SECRET,
    allowedDomains: ["vercel.com"],
    ...(opts.allowedActions !== undefined ? { allowedActions: opts.allowedActions as never } : {}),
  });
  services.handles.put({
    label: "value-field", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 11, handle_fingerprint: "sha256:field", element_kind: "field",
  });
  services.handles.put({
    label: "submit-btn", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
  });
}

function body(extra: Record<string, unknown> = {}) {
  return {
    ref: "ss://stripe/prod/WH", domain: "vercel.com",
    field_handle: "value-field", submit_handle: "submit-btn",
    success_text: "Environment Variable Added",
    wait_for_approval: false, ...extra,
  };
}

test("inject-submit requires approval even though no approval_id is supplied (force:true)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("a legacy secret without inject_submit is denied (no implicit grant from inject_into_field)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port, { allowedActions: ["inject_into_field"] });
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "action_not_allowed");
  });
});

test("refuses if blind mode is already active (no clobber)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.blind.start("vercel.com", "other");
    const g = services.approvals.create({ ...bindingFor(), });
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "blind_mode_already_active");
  });
});

function bindingFor(over: Record<string, unknown> = {}) {
  return {
    action: "inject_submit" as const, ref: "ss://stripe/prod/WH", environment: "production",
    destination_domain: "vercel.com", target_id: "T-1", field_fingerprint: "sha256:field",
    template_id: null, template_params: null, allowed_domains: ["vercel.com"],
    submit_fingerprint: "sha256:submit", success_condition: "Environment Variable Added",
    auto_resume: true, field_handle_label: "value-field", submit_handle_label: "submit-btn",
    ...over,
  };
}

test("success + absence proof passed → blind_mode:false, submitted:true, and a blind_auto_resume audit record", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { absence_proof: string }).absence_proof, "passed");
    assert.equal((r.body as { success_signal: string }).success_signal, "text_matched");
    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), true);
    assert.equal(log.includes(SECRET), false);
  });
});

test("success observed but absence inconclusive → stays blind, manual_recovery_required, no auto-resume audit", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: false }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.equal("success_signal" in r.body, false);
    assert.equal("absence_proof" in r.body, false);
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("pre-write handle revalidation failure (post-approval) ends blind and errors — safe, nothing written", async () => {
  await withDaemon(async ({ port, services }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => { calls += 1; if (calls > 2) throw Object.assign(new Error("gone"), { code: "handle_invalid" }); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_invalid");
    assert.equal(services.blind.current(), null); // blind ended (safe — pre-write)
  });
});

test("post-write failure (click throws) keeps blind active and returns submitted:unknown", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ clickBackendNode: async () => { throw new Error("click boom"); } });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.notEqual(services.blind.current(), null);
  });
});

test("no raw secret and no observed text appears in any response", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    const s = JSON.stringify(r.body);
    assert.equal(s.includes(SECRET), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/inject-submit-routes.test.js`
Expected: FAIL — every test fails with status 404 (route `/v1/secrets/inject-submit` not registered).

- [ ] **Step 3: Implement the route**

Create `src/daemon/api/routes/inject-submit.ts`:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { domainMatches } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { asObject, reqString } from "../validate.js";
import { disableObservationDomains } from "../../chrome/internal-ops.js";
import { enforceDomain } from "./secrets.js";
import { autoResumeBlind } from "../../blind-auto-resume.js";

interface InjectSubmitBody {
  ref: string;
  domain?: string;
  field_handle: string;
  submit_handle: string;
  success_text: string;
  success_timeout_ms?: number;
  approval_id?: string;
  wait_for_approval?: boolean;
}

const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000;
const SUCCESS_TIMEOUT_CAP_MS = 60_000;

export function registerInjectSubmit(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/inject-submit", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const ref = reqString(o, "ref");
    const fieldHandleLabel = reqString(o, "field_handle");
    const submitHandleLabel = reqString(o, "submit_handle");
    const successText = reqString(o, "success_text");
    const b = raw as InjectSubmitBody;
    let blindStarted = false;
    try {
      if (services.browser === null) {
        throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      }
      const secret = await services.vault.getSecret(ref);
      assertSecretActionAllowed(secret, "inject_submit");

      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is already active; run `secret-shuttle blind end` before inject-submit.",
        );
      }

      const fieldHandle = services.handles.get(fieldHandleLabel);
      if (fieldHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${fieldHandleLabel}.`);
      const submitHandle = services.handles.get(submitHandleLabel);
      if (submitHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${submitHandleLabel}.`);

      // Revalidate while observation is still safe (§3.4).
      await services.browser.revalidateHandle(fieldHandle);
      await services.browser.revalidateHandle(submitHandle);
      if (fieldHandle.element_kind !== "field") {
        throw new ShuttleError("handle_kind_mismatch", "field_handle must be a field.");
      }
      if (submitHandle.element_kind !== "button" && submitHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "submit_handle must be a button or link.");
      }

      const domain = fieldHandle.domain;
      if (b.domain !== undefined && !domainMatches(domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Field handle domain ${domain} != ${b.domain}.`);
      }
      enforceDomain(domain, secret.allowed_domains, "inject-submit");

      let successTimeoutMs = SUCCESS_TIMEOUT_DEFAULT_MS;
      const tms = o["success_timeout_ms"];
      if (typeof tms === "number" && Number.isFinite(tms)) {
        successTimeoutMs = Math.min(Math.max(1_000, Math.floor(tms)), SUCCESS_TIMEOUT_CAP_MS);
      }

      const binding: ApprovalBinding = {
        action: "inject_submit",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: domain,
        target_id: fieldHandle.target_id,
        field_fingerprint: fieldHandle.handle_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
        submit_fingerprint: submitHandle.handle_fingerprint,
        success_condition: successText,
        auto_resume: true,
        field_handle_label: fieldHandle.label,
        submit_handle_label: submitHandle.label,
        ...(fieldHandle.page_title !== "" ? { page_title: fieldHandle.page_title } : {}),
        ...(fieldHandle.page_url_host !== "" ? { page_url_host: fieldHandle.page_url_host } : {}),
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        force: true,
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window: black out the agent BEFORE the value can
      // ever reach the page (mirrors /v1/secrets/inject).
      services.blind.start(domain, "inject_submit");
      blindStarted = true;
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      // Re-revalidate post-approval, pre-write. Failure here = nothing written →
      // safe to end blind and rethrow (mirrors current inject pre-write path).
      try {
        await services.browser.revalidateHandle(fieldHandle);
        await services.browser.revalidateHandle(submitHandle);
      } catch (preWriteErr) {
        services.blind.end();
        throw preWriteErr;
      }

      // From here the secret is on the page. A failure MUST NOT auto-resume:
      // blind stays ACTIVE; respond fail-closed (submitted:"unknown").
      try {
        await services.browser.injectIntoBackendNode(
          { target_id: fieldHandle.target_id, backend_node_id: fieldHandle.backend_node_id },
          secret.value,
        );
        await services.browser.clickBackendNode({
          target_id: submitHandle.target_id,
          backend_node_id: submitHandle.backend_node_id,
        });
      } catch {
        await services.vault.markUsed(secret.ref).catch(() => undefined);
        await writeDaemonAudit({
          action: "inject_submit", ok: false, ref: secret.ref, environment: secret.environment,
          domain, submitted: "unknown", blind_mode: true,
        });
        return {
          submitted: "unknown", secret_ref: secret.ref, domain,
          blind_mode: true, next: "manual_recovery_required", value_visible_to_agent: false,
        };
      }

      let successObserved = false;
      try {
        successObserved = await services.browser.observeText(domain, successText, successTimeoutMs);
      } catch {
        successObserved = false;
      }
      let proofPassed = false;
      if (successObserved) {
        try {
          proofPassed = (await services.browser.proveAbsence(secret.value)).passed;
        } catch {
          proofPassed = false;
        }
      }
      await services.vault.markUsed(secret.ref);

      if (successObserved && proofPassed) {
        await autoResumeBlind(services, {
          op: "inject_submit", domain, success_signal: "text_matched", absence_proof: "passed",
        });
        await writeDaemonAudit({
          action: "inject_submit", ok: true, ref: secret.ref, environment: secret.environment,
          domain, submitted: true, success_signal: "text_matched", absence_proof: "passed", blind_mode: false,
        });
        return {
          submitted: true, secret_ref: secret.ref, domain,
          success_signal: "text_matched", absence_proof: "passed",
          blind_mode: false, value_visible_to_agent: false,
        };
      }

      await writeDaemonAudit({
        action: "inject_submit", ok: true, ref: secret.ref, environment: secret.environment,
        domain, submitted: "unknown", blind_mode: true,
      });
      return {
        submitted: "unknown", secret_ref: secret.ref, domain,
        blind_mode: true, next: "manual_recovery_required", value_visible_to_agent: false,
      };
    } catch (err) {
      // Errors before blind.start (handle/kind/domain/approval) → blind never
      // started. The pre-write path already ended blind & is rethrowing here.
      void blindStarted;
      await writeDaemonAudit({
        action: "inject_submit",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(ref !== undefined ? { ref } : {}),
      });
      throw err;
    }
  });
}
```

> Note on the post-write catch: `injectIntoBackendNode`/`clickBackendNode` failures are treated as "secret may be on the page" — blind stays ACTIVE and the route returns the fail-closed 200 body (NOT a thrown error), exactly per spec §4.2 step 10. `observeText`/`proveAbsence` errors are swallowed to `false` (spec §5.3: any CDP/evaluate error or timeout ⇒ inconclusive ⇒ stay blind), never a 4xx. Only pre-`blind.start` failures and the pre-write revalidation failure produce a thrown error (4xx); the pre-write path ends blind first (safe — nothing written).

- [ ] **Step 4: Register the route**

In `src/daemon/api/router.ts`, add the import after the existing `import { registerSecrets } from "./routes/secrets.js";` line:
```ts
import { registerInjectSubmit } from "./routes/inject-submit.js";
```

In the same file, add this line immediately **after** the existing `registerSecrets(server, services, daemonPortRef);` call:
```ts
  registerInjectSubmit(server, services, daemonPortRef);
```

- [ ] **Step 5: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/inject-submit-routes.test.js`
Expected: PASS — 8 tests pass.

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/inject-submit.ts src/daemon/api/router.ts src/daemon/api/inject-submit-routes.test.ts
git commit -m "feat(inject-submit): POST /v1/secrets/inject-submit route (mirrors inject; auto-resume on proof)"
```

---

### Task 9: CLI — `secret-shuttle inject-submit`

**Files:**
- Create: `src/cli/commands/inject-submit.ts`
- Modify: `src/cli/index.ts:1-41`

- [ ] **Step 1: Implement the CLI command**

Create `src/cli/commands/inject-submit.ts`:
```ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { normalizeRef } from "./helpers.js";

export function injectSubmitCommand(): Command {
  return new Command("inject-submit")
    .description("Daemon-owned: inject a secret into a marked field, click a marked submit control, verify success, and auto-resume only if the secret is proven gone.")
    .requiredOption("--ref <ref>")
    .requiredOption("--field-handle <label>", "Label of a pre-marked field (mark it before blind mode).")
    .requiredOption("--submit-handle <label>", "Label of a pre-marked submit button/link.")
    .requiredOption("--success-text <text>", "Non-secret marker that proves the save succeeded.")
    .option("--domain <domain>")
    .option("--success-timeout-ms <ms>", "Max wait for the success marker (default 15000, cap 60000).", (v) => parseInt(v, 10))
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      const bodyObj: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        field_handle: options.fieldHandle,
        submit_handle: options.submitHandle,
        success_text: options.successText,
        wait_for_approval: options.wait !== false,
      };
      if (options.domain !== undefined) bodyObj.domain = options.domain;
      if (options.successTimeoutMs !== undefined) bodyObj.success_timeout_ms = options.successTimeoutMs;
      if (options.approvalId !== undefined) bodyObj.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/inject-submit", bodyObj);
      outputJson(ok(r as Record<string, unknown>));
    });
}
```

- [ ] **Step 2: Register the command**

In `src/cli/index.ts`, add the import after the existing `import { injectCommand } from "./commands/inject.js";` line:
```ts
import { injectSubmitCommand } from "./commands/inject-submit.js";
```

In the same file, add this line immediately **after** the existing `program.addCommand(injectCommand());` line:
```ts
program.addCommand(injectSubmitCommand());
```

- [ ] **Step 3: Verify the CLI surface compiles**

Run: `npm run build && node dist/cli/index.js inject-submit --help`
Expected: PASS — help lists `--ref`, `--field-handle`, `--submit-handle`, `--success-text`, `--domain`, `--success-timeout-ms`, `--approval-id`, `--no-wait`; exit code 0.

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/inject-submit.ts src/cli/index.ts
git commit -m "feat(inject-submit): secret-shuttle inject-submit CLI command"
```

---

### Task 10: Full Phase-2 verification + agentic no-leak e2e

**Files:**
- Create: `src/e2e/inject-submit-agentic.test.ts`

- [ ] **Step 1: Write the end-to-end agentic test**

Create `src/e2e/inject-submit-agentic.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import type { BrowserOps } from "../daemon/chrome/internal-ops.js";

const SECRET = "whsec_e2e_simulated_value_must_not_leak";
const SUCCESS_TEXT = "Environment Variable Added";

function stubBrowser(): BrowserOps {
  const inj = { domain: "vercel.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "vercel.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
  };
}

test("agentic inject-submit end-to-end leaks neither the raw secret nor observed success text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-is-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));

  const call = async (method: string, p: string, b?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { Authorization: "Bearer t", "content-type": "application/json" },
      ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const responses: { status: number; body: Record<string, unknown> }[] = [];

  try {
    services.browser = stubBrowser();
    responses.push(await call("POST", "/v1/unlock", { passphrase: "p", set_passphrase: true }));
    await services.vault.upsertSecret({
      name: "WH", environment: "production", source: "stripe", value: SECRET, allowedDomains: ["vercel.com"],
    });
    // Agent marks the field + submit BEFORE blind mode (Phase 1 surface).
    services.handles.put({
      label: "value-field", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 11, handle_fingerprint: "sha256:field", element_kind: "field",
    });
    services.handles.put({
      label: "submit-btn", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
    });

    const g = services.approvals.create({
      action: "inject_submit", ref: "ss://stripe/prod/WH", environment: "production",
      destination_domain: "vercel.com", target_id: "T-1", field_fingerprint: "sha256:field",
      template_id: null, template_params: null, allowed_domains: ["vercel.com"],
      submit_fingerprint: "sha256:submit", success_condition: SUCCESS_TEXT, auto_resume: true,
      field_handle_label: "value-field", submit_handle_label: "submit-btn",
    });
    services.approvals.approve(g.id);
    const r = await call("POST", "/v1/secrets/inject-submit", {
      ref: "ss://stripe/prod/WH", domain: "vercel.com",
      field_handle: "value-field", submit_handle: "submit-btn",
      success_text: SUCCESS_TEXT, approval_id: g.id, wait_for_approval: false,
    });
    responses.push(r);
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);

    responses.push(await call("GET", "/v1/status"));

    for (const resp of responses) {
      const s = JSON.stringify(resp.body);
      assert.equal(s.includes(SECRET), false, `raw secret leaked: ${s}`);
      assert.equal(s.includes(SUCCESS_TEXT), false, `observed success text leaked: ${s}`);
    }
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
});
```

> The success text MUST NOT appear in any response. It is the human-approved marker shown only in the approval UI and the approval grant — never echoed by the route. The grant is fetched via the UI route (token-gated, not these `/v1/...` responses), so this assertion holds; if a future change surfaces `success_condition` in a `/v1` response this test fails by design.

- [ ] **Step 2: Run the new e2e, then typecheck + the entire suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/e2e/inject-submit-agentic.test.js`
Expected: PASS — 1 test passes.

Run: `npm run typecheck && npm test`
Expected: PASS — zero TypeScript errors; every `node --test` file passes, 0 failures (Phase-1 + Phase-2 suites).

- [ ] **Step 3: Commit + checkpoint tag**

```bash
git add src/e2e/inject-submit-agentic.test.ts
git commit -m "test(inject-submit): agentic e2e — no raw secret, no observed success text in any response"
git tag phase2-inject-submit-complete
git log --oneline -12
```
Expected: the tag points at this commit; the last ~9 commits are the Phase-2 feature/test commits on `feat/inject-submit`.

---

### Task 11: [P2a] Vercel real-page auto-resume validation gate (carried residual — manual)

**Files:** none (manual/scripted release gate; record the outcome in this plan's notes and feed it to Plan 5's skill/README copy — NOT a unit test).

This is the spec §13 **[P2a]** release gate for the Phase-2 browser flow. The absence proof stays conservatively fail-closed regardless; this gate measures whether auto-resume *succeeds in practice* on the real Vercel env-var-add flow. It is not a code unit test and does not block the merge of Tasks 1–10, but its outcome MUST be recorded before Plan 5 states (per provider) whether the browser flow is "production" or "best-effort (template-primary)".

- [ ] **Step 1: Start a real daemon + browser and create a test secret**

Run:
```bash
node dist/cli/index.js daemon start
node dist/cli/index.js unlock           # set a passphrase in the opened window if first run
node dist/cli/index.js browser start
node dist/cli/index.js generate --name SS_TEST_WEBHOOK --env production --source test --allow-domain vercel.com
```
Expected: `started: true` with a `proxy_url`; `generated: true`.

- [ ] **Step 2: Prepare the Vercel page and mark the controls (observation still safe)**

In the daemon browser, navigate to a Vercel project's *Environment Variables → Add* form. Focus the value field, then in a second terminal:
```bash
node dist/cli/index.js browser mark focused --as value-field
node dist/cli/index.js browser mark pick --as submit-btn --timeout-ms 60000   # click "Save" while pending
node dist/cli/index.js browser marks
```
Expected: `marks` lists `value-field` (`element_kind: field`) and `submit-btn` (`element_kind: button`), both `valid: true`.

- [ ] **Step 3: Run the real inject-submit and observe the exit**

Run:
```bash
node dist/cli/index.js inject-submit \
  --ref ss://test/prod/SS_TEST_WEBHOOK \
  --domain vercel.com \
  --field-handle value-field \
  --submit-handle submit-btn \
  --success-text "Added" \
  --success-timeout-ms 20000
```
Approve in the opened UI window. Observe the JSON result.
Expected (gate PASS): `{ "submitted": true, "absence_proof": "passed", "blind_mode": false, … }` and `node dist/cli/index.js blind end` is a no-op (already resumed). Confirm a `blind_auto_resume` line (not `blind_end`) in `~/.secret-shuttle/audit.log`.
Expected (gate BEST-EFFORT): `{ "submitted": "unknown", "blind_mode": true, "next": "manual_recovery_required" }` — typically because Vercel wraps the field in a cross-origin iframe or canvas-renders it (absence proof correctly inconclusive). The proof behaved correctly; the flow is simply best-effort on this site.

- [ ] **Step 4: Record the outcome + tear down**

Append a short note to this file's "## [P2a] Gate outcome" section below (PASS = production browser flow for Vercel; BEST-EFFORT = Plan 5 documents `template run` as primary for Vercel and the skill says so). Then:
```bash
node dist/cli/index.js blind end || true
pkill -f "secret-shuttle" || true
```
Expected: daemon/browser stopped; outcome recorded.

## [P2a] Gate outcome

_(record here during Task 11 — e.g. "2026-05-‑‑: Vercel env-var add → submitted:true, absence_proof:passed, auto-resumed. Browser flow = PRODUCTION.")_

---

## Self-Review (performed against the spec)

**1. Spec coverage (Phase 2 scope):**
- §3.4 revalidation-before-use → Task 8 (pre-approval + post-approval-pre-write `revalidateHandle` on both handles; kind gating).
- §4.1 CLI → Task 9. §4.2 route 14-step flow → Task 8 (lock/browser; refuse-if-blind; `assertSecretActionAllowed("inject_submit")`; revalidate-while-safe + domain enforce; deterministic binding; `requireApproval force:true`; `blind.start`→`disableObservationDomains`→`severAgentConnections`; pre-write re-revalidate fail-closed+safe; inject→click; success wait; absence proof; auto-resume decision; `markUsed`+audit). §4.3 enum-only responses → Task 8 route + Task 10 leak assertion. §4.4 distinct `inject_submit` SecretAction, no implicit grant, overwrite-preserve, explicit opt-in → Tasks 1–2 (+ Task 8 legacy-deny route test).
- §5 Absence Proof (surfaces, pass condition, fail-closed matrix) → Task 5 `proveAbsence` + tests (present / inconclusive / evaluate-error / empty-secret). §5.4 documented limitation already ships in `threat-model.md` from prior hardening (no Phase-2 doc change required; raw-only match is what `proveAbsence` implements).
- §6.4 binding/UI additions that apply to §4 (`submit_fingerprint`, `success_condition`, `auto_resume`, display-only labels; UI auto-resume disclosure) → Tasks 3–4. (`reveal_*`/`container_*`/`capture_mode` binding fields are Plan 3 — intentionally not added here; `bindingsMatch` for those lands with Plan 3.)
- §7 separately-audited `autoResumeBlind` (no approval, no `blankAllPages`, distinct `blind_auto_resume` action, `/v1/blind/end` untouched) → Task 7 + Task 8 wiring + Task 8 test asserting no `blind_end` record.
- §8 audit events `inject_submit` + `blind_auto_resume` → Task 7 vocabulary + Task 8 emissions. (`browser_mark` shipped in Phase 1; `reveal_capture` is Plan 3.)
- §12 `injectIntoBackendNode` (DOM.focus + activeElement assertion + WRITE_SCRIPT), `clickBackendNode` (trusted Input at hit-tested box; descendant/occlusion guard; fail-closed on no/zero box), `proveAbsence` (`{passed}` only) + the §4.2-step-11 success observer (`observeText`, boolean only) → Tasks 5–6.
- §13 test slices: `inject_submit` SecretAction (Task 1), route tests incl. force/blind-lifecycle/pre-write-safe/post-write-stays/auto-resume+audit/inconclusive (Task 8), `clickBackendNode` trusted-input + occlusion (Task 6), absence proof present/inconclusive/error (Task 5), approval binding/UI (Tasks 3–4), negative/security e2e (Task 10), [P2a] gate (Task 11).
- §14 build order phase 2 → this whole plan. §15 acceptance criteria (Vercel add without observing/clicking; stay-blind-if-unproven; no raw secrets; UI plain language; [P2a]) → Tasks 8/5/10/4/11. §16 decisions (always force-approval; distinct SecretAction fail-closed; trusted CDP Input not JS .click(); auto-resume bypasses blank; raw-only proof) → Tasks 1/6/7/8.

**2. Placeholder scan:** no TBD/TODO; every code step contains complete code; every command has an expected result. The only non-code step is Task 11 — explicitly a manual release gate (spec §13 [P2a]), with concrete commands and PASS/BEST-EFFORT criteria, not a hand-wave. The `ui.html`→`dist` path uncertainty in Task 4 is bounded with a concrete fallback (inspect `ui-server.ts` for the canonical path) rather than left open.

**3. Type consistency:** `SecretAction` (Task 1, +`inject_submit`) ↔ `validatedActions`/`SECRET_ACTIONS` (Task 2) ↔ `assertSecretActionAllowed(secret,"inject_submit")` (Task 8). `ApprovalBinding` new fields `submit_fingerprint`/`success_condition`/`auto_resume`/`field_handle_label`/`submit_handle_label` (Task 3) are exactly the keys the route builds (Task 8) and the UI reads (Task 4) and the binding test asserts (Task 3). `BackendNodeRef { target_id; backend_node_id }`/`AbsenceProofResult { passed }` (Task 5) are the exact shapes `injectIntoBackendNode`/`clickBackendNode` (Task 6) and the route call sites (Task 8) use; `BrowserHandle` (Phase 1) exposes `target_id`/`backend_node_id`/`handle_fingerprint`/`element_kind`/`page_title`/`page_url_host`/`label`/`domain` which the route consumes. `AutoResumeArgs` (Task 7) `success_signal:"text_matched"`/`absence_proof:"passed"` match the route's only auto-resume call (Task 8) and the audit fields added in Task 7. The three `BrowserOps` stubs gain the four methods in the same tasks that extend the interface (Tasks 5–6), so the tree is green at every commit. `enforceDomain` is `export`ed in Task 2 and imported by the route in Task 8.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-agentic-blind-transactions-phase2-inject-submit.md`. This document fully specifies **Phase 2 (`inject-submit`)**; Plans 3–5 are generated from the same spec once their predecessor merges.
