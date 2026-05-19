# Agentic Blind Transactions — Phase 3 (`reveal-capture`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon-owned `reveal-capture` transaction: the daemon owns its blind window (like `inject-submit`), clicks a pre-marked reveal control, resolves the now-visible secret element via one of three approved capture modes (`field` / `container` / `focused-after-reveal`) using a pre-reveal hashed baseline + a single safe→revealed transition + a DOM-containment proof, stores the value (which never leaves the daemon), hides/blanks the page, proves the raw secret is absent from every observable surface, and auto-resumes observation only when the value was captured non-empty AND hide/blank succeeded AND the absence proof passed.

**Architecture:** Mirrors the merged `POST /v1/secrets/inject-submit` route (`src/daemon/api/routes/inject-submit.ts`) exactly: `requireKey` → require browser → refuse if blind already active → revalidate handles while observation safe → **pre-reveal baseline** → deterministic binding → `requireApproval({force:true})` → `blind.start` → `disableObservationDomains` → `severAgentConnections` → pre-reveal/pre-action re-revalidate (failure ends blind & rethrows — nothing revealed, safe) → from the reveal click onward the secret may be exposed → any failure stays blind, enum-only `captured:"unknown"`, best-effort bounded `blankAllPages` neutralization → auto-resume only on the triple precondition. New pieces: an extended `ApprovalBinding` (`reveal_fingerprint`/`hide_fingerprint`/`container_fingerprint`/`capture_mode` non-display + display-only `reveal_handle_label`/`hide_handle_label`/`container_handle_label`), the `reveal_capture` audit action + `captured` field, three daemon-internal `BrowserOps` methods (`readBackendNodeValue`, `baselineCandidates`, `resolveWithinContainer`) plus a `Baseline` type, an extended `AutoResumeArgs.success_signal` union (the merged `autoResumeBlind` already supports `op:"reveal_capture"`), and a new `POST /v1/secrets/reveal-capture` route + CLI. The existing hardened `proveAbsence` (Phase 2, covers open shadow roots / script/style/template / per-document nav guard / bounded) is **reused, not reimplemented**. Spec: [docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md](../specs/2026-05-18-agentic-blind-transactions-design.md) (signed off at commit `d1c89ed`); Phases 1 & 2 merged on `main` @ `427dbe0`.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import specifiers, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Commander CLI, Node built-in `http` daemon, raw CDP over a pipe transport, `node:test` + `node:assert/strict` (tests build to `dist/` then run via `node --test`). The suite is currently **295 tests green** (`npm test` → `fail 0`); Phase 3 adds more.

---

## Scope: this plan covers Phase 3 only

The spec (§14) defines five independently shippable phases. Phase 1 (Opaque Browser Handles) and Phase 2 (`inject-submit`) are **merged** (`main` @ `427dbe0`, tag `phase2-inject-submit-complete`). **This document is the complete, executable plan for Phase 3 (`reveal-capture`)** — spec §6 (capture model, three modes, pre-reveal baseline, post-reveal resolution order, route 13-step flow, response, §6.4 binding/UI), §7 (the already-merged audited auto-resume — verified, extended for the reveal-capture signal), §8 (audit `reveal_capture`), the §12 `BrowserOps` slice for `readBackendNodeValue`/`baselineCandidates`/`resolveWithinContainer` (+ `proveAbsence` REUSED from Phase 2), §13 test slices, §14 phase 3, §15/§16 decisions.

**Out of this plan (their own future plans):** Plan 4 — Templates (§9, `tmp_env_file_0600`); Plan 5 — Skill + installers + doctor/health (§10, §11), which states per-provider production-vs-best-effort using the **[P2a]** gate outcomes (Vercel from Phase 2, Stripe from this plan's Task 11).

**Carried residual (release gate, Task 11):** the spec §13/§14 **[P2a] Stripe webhook-secret reveal-capture real-page validation gate** — a manual/scripted check on the live `dashboard.stripe.com`, NOT a unit test, that does **not** block the merge of Tasks 1–10. Its outcome feeds Plan 5's per-provider statement.

---

## Phase 3 File Structure

- **Modify** `src/daemon/approvals/store.ts:12-36` (`ApprovalBinding`), `:126-145` (`bindingsMatch`) — add non-display `reveal_fingerprint`/`hide_fingerprint`/`container_fingerprint`/`capture_mode` (added to `bindingsMatch` via strict equality) and display-only `reveal_handle_label`/`hide_handle_label`/`container_handle_label` (excluded from matching, like the existing `*_handle_label`). `submit_fingerprint`/`success_condition`/`auto_resume`/`allowed_actions`/`field_handle_label`/`submit_handle_label` ALREADY exist from Phase 2.
- **Create** `src/daemon/approvals/binding-reveal-capture.test.ts` — `bindingsMatch` new-field unit tests (each new non-display field mismatches; display-only labels do not; the `capture_mode` `false`-vs-absent / value edge).
- **Modify** `src/daemon/approvals/ui-server.ts:46-52` (the grant→JSON projection) — serialize the 7 new fields so the live UI shows real values (Phase-2 lesson: a static-HTML test alone passes while the runtime shows `?`). The single existing `allowed_actions`/`submit_fingerprint`/`success_condition`/`*_handle_label` lines (Phase 2) must NOT be duplicated.
- **Modify** `src/daemon/approvals/ui.html:30-39` (the `human` map), `:52` (Success-marker row area / `capture_mode` body row), `:53-60` (technical-details fingerprints), `:61-62` (the prominent auto-resume disclosure) — add the `reveal_capture` plain-language sentence, the `Capture mode` main-body row, the reveal/hide/container fingerprints in technical details, and extend the existing prominent auto-resume disclosure pattern to `reveal_capture`.
- **Create** `src/daemon/approvals/ui-reveal-capture.test.ts` — static-HTML test for the new copy.
- **Create** `src/daemon/approvals/ui-grant-json-reveal-capture.test.ts` — runtime `/ui/approvals/:id` JSON test proving `ui-server.ts` serializes the new fields with real values.
- **Modify** `src/daemon/chrome/internal-ops.ts` — add the `Baseline` type; extend `BrowserOps` + `CdpBrowserOps` with `readBackendNodeValue`, `baselineCandidates`, `resolveWithinContainer`; add module-level in-page scan fns `BASELINE_SCAN_FN` + `RESOLVE_SCAN_FN` (boolean/hash-only egress; the raw value is read exactly once at the end and goes only to `upsertSecret`). Reuse the EXISTING `proveAbsence`/`boundedSend`/`isDescendantOf` — do NOT add a new absence scan.
- **Modify** `src/daemon/api/routes.test.ts`, `src/e2e/stripe-to-vercel.test.ts`, `src/daemon/api/browser-handles-routes.test.ts`, `src/daemon/api/inject-submit-routes.test.ts` — extend **ALL** `BrowserOps` object literals (the named `stubBrowser`/`stub` factories AND every inline literal — `routes.test.ts` has four) with the 3 new methods, in the SAME task that extends the interface (keep the tree green per commit; Phase-2 stub-fixup discipline).
- **Create** `src/daemon/chrome/baseline-resolve.test.ts` — scripted-CDP-transport tests for `readBackendNodeValue`/`baselineCandidates`/`resolveWithinContainer` (the `ScriptedTransport` precedent) PLUS DOM-shim tests driving the real `BASELINE_SCAN_FN`/`RESOLVE_SCAN_FN`/predicate/transition/containment via `new Function` (the `runScan` precedent in `src/daemon/chrome/absence-proof.test.ts`).
- **Modify** `src/daemon/audit.ts:7` (`DaemonAuditAction`) — add `"reveal_capture"`; add `captured?: boolean | "unknown"` to `DaemonAuditEvent` (`success_signal`/`absence_proof`/`blind_mode`/`op` already exist from Phase 2).
- **Modify** `src/daemon/blind-auto-resume.ts:5-10,21` — widen `AutoResumeArgs.success_signal` to `"text_matched" | "secret_captured"` and accept either in the precondition (the merged `op` union already includes `"reveal_capture"`). Additive/backward compatible with the inject-submit caller (which still passes `"text_matched"`).
- **Create** `src/daemon/blind-auto-resume-reveal.test.ts` — unit test: `op:"reveal_capture"` + `success_signal:"secret_captured"` resumes & audits; a non-`passed` proof refuses (stays blind).
- **Create** `src/daemon/api/routes/reveal-capture.ts` — the `POST /v1/secrets/reveal-capture` route (own-blind-window; all 3 modes; fail-closed; deadline-wrapped reveal→resolve→read→hide; blank fallback; triple-precondition auto-resume). Mirrors `inject-submit.ts` incl. its module-scope `withDeadline` helper.
- **Modify** `src/daemon/api/router.ts:9,28` — register the new route after `registerInjectSubmit`.
- **Create** `src/daemon/api/reveal-capture-routes.test.ts` — route behaviour tests (all 3 modes; predicate/transition/containment fail-closed matrix; readable-sibling success; no-leak).
- **Create** `src/cli/commands/reveal-capture.ts` — the `reveal-capture` CLI command.
- **Modify** `src/cli/index.ts:11,33` — register `revealCaptureCommand()` after `injectSubmitCommand()`.
- **Create** `src/e2e/reveal-capture-agentic.test.ts` — end-to-end no-raw-secret/no-observed-text agentic path.

**Branch:** all work on a feature branch — run `git switch -c feat/reveal-capture` as the first step; **do not implement on `main`**. Phases 1 & 2 used this same lightweight branch model (both merged cleanly); mirror it.

Commands:
- Build: `npm run build`
- Typecheck only: `npm run typecheck`
- Full test: `npm test` (builds, then `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/**/*.test.js"`)
- One test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/<path>.test.js`

---

### Task 1: Branch + extend `ApprovalBinding` + `bindingsMatch`

**Files:**
- Modify: `src/daemon/approvals/store.ts:12-36` (`ApprovalBinding`), `:126-145` (`bindingsMatch`)
- Test: `src/daemon/approvals/binding-reveal-capture.test.ts`

> The binding task is first because the `ui-server.ts`/`ui.html` task (Task 2) and the route (Task 8) build/serialize these fields, which must exist on `ApprovalBinding` first. The Phase-2 `action` union already includes `"inject_submit"`; `reveal_capture` is added here.

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git switch -c feat/reveal-capture
```
Expected: `Switched to a new branch 'feat/reveal-capture'`

- [ ] **Step 2: Write the failing binding test**

Create `src/daemon/approvals/binding-reveal-capture.test.ts`:
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalStore, type ApprovalBinding } from "./store.js";

function base(): ApprovalBinding {
  return {
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://stripe/prod/WH",
    environment: "production",
    destination_domain: "dashboard.stripe.com",
    target_id: "T-1",
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: ["dashboard.stripe.com"],
    reveal_fingerprint: "sha256:reveal",
    hide_fingerprint: "sha256:hide",
    container_fingerprint: "sha256:container",
    capture_mode: "container",
    auto_resume: true,
    reveal_handle_label: "reveal-button",
    hide_handle_label: "hide-button",
    container_handle_label: "secret-card",
  };
}

test("a matching reveal_capture binding round-trips through create→approve→consume", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, base());
  assert.equal(used.status, "used");
});

test("a different reveal_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), reveal_fingerprint: "sha256:OTHER" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different container_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), container_fingerprint: "sha256:OTHER" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different capture_mode is an approval_mismatch (mode is part of the approved plan)", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), capture_mode: "focused-after-reveal" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different hide_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), hide_fingerprint: "sha256:OTHER" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("absent vs explicit-null hide_fingerprint both normalize to the same match (no-hide-handle case)", () => {
  const store = new ApprovalStore();
  const noHide: ApprovalBinding = { ...base() };
  delete (noHide as Record<string, unknown>).hide_fingerprint;
  delete (noHide as Record<string, unknown>).hide_handle_label;
  const g = store.create(noHide);
  store.approve(g.id);
  const used = store.consume(g.id, { ...noHide, hide_fingerprint: null });
  assert.equal(used.status, "used");
});

test("display-only reveal/hide/container handle labels are NOT part of matching", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, {
    ...base(),
    reveal_handle_label: "renamed-r",
    hide_handle_label: "renamed-h",
    container_handle_label: "renamed-c",
  });
  assert.equal(used.status, "used");
});

test("field-mode binding: field_fingerprint participates, container_fingerprint absent", () => {
  const store = new ApprovalStore();
  const fieldBinding: ApprovalBinding = {
    ...base(),
    capture_mode: "field",
    field_fingerprint: "sha256:thefield",
    container_fingerprint: null,
    container_handle_label: null,
    field_handle_label: "secret-field",
  };
  const g = store.create(fieldBinding);
  store.approve(g.id);
  assert.equal(store.consume(g.id, { ...fieldBinding }).status, "used");

  const g2 = store.create(fieldBinding);
  store.approve(g2.id);
  assert.throws(
    () => store.consume(g2.id, { ...fieldBinding, field_fingerprint: "sha256:OTHER" }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Object literal may only specify known properties, and 'reveal_fingerprint' does not exist in type 'ApprovalBinding'` (and `hide_fingerprint`/`container_fingerprint`/`capture_mode`/`reveal_handle_label`/`hide_handle_label`/`container_handle_label`) (`TS2353`). That is the expected first failure.

- [ ] **Step 4: Extend the binding type and matcher**

In `src/daemon/approvals/store.ts`, the `ApprovalBinding` interface is lines 12-36. The Phase-2 non-display block ends with `auto_resume?` (line 28) and `allowed_actions?` (line 30); the display-only block ends with `submit_handle_label?` (line 35). Add the new non-display fields immediately **after** the existing `auto_resume?: boolean | null;` line (line 28), before the `allowed_actions` comment:
```ts
  reveal_fingerprint?: string | null;
  hide_fingerprint?: string | null;
  container_fingerprint?: string | null;
  capture_mode?: "field" | "container" | "focused-after-reveal" | null;
```
Then add the new display-only fields immediately **after** the existing `submit_handle_label?: string | null;` line (line 35), before the interface's closing `}`:
```ts
  reveal_handle_label?: string | null;
  hide_handle_label?: string | null;
  container_handle_label?: string | null;
```

In the same file, the `bindingsMatch` function is lines 126-145. Add the four new non-display equality checks immediately **after** the existing `(a.auto_resume ?? null) === (b.auto_resume ?? null)` line (line 143), before the closing `);` — strict equality, consistent with `submit_fingerprint`/`success_condition`/`auto_resume`:
```ts
    && (a.reveal_fingerprint ?? null) === (b.reveal_fingerprint ?? null)
    && (a.hide_fingerprint ?? null) === (b.hide_fingerprint ?? null)
    && (a.container_fingerprint ?? null) === (b.container_fingerprint ?? null)
    && (a.capture_mode ?? null) === (b.capture_mode ?? null)
```
> The display-only `reveal_handle_label`/`hide_handle_label`/`container_handle_label` are deliberately NOT added to `bindingsMatch` — exactly like the existing display-only `field_handle_label`/`submit_handle_label`/`page_title`/`page_url_host`. The `?? null` normalization makes absent vs explicit-`null` equal (the no-hide-handle case), matching the existing helpers.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/binding-reveal-capture.test.js`
Expected: PASS — 8 tests pass.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all existing tests green (the new fields are optional; `(undefined ?? null) === (undefined ?? null)` holds for every pre-existing binding, including all Phase-2 `inject_submit` and `generate` bindings).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/binding-reveal-capture.test.ts
git commit -m "feat(reveal-capture): extend ApprovalBinding (reveal/hide/container fingerprints + capture_mode) + bindingsMatch (spec §6.4)"
```

---

### Task 2: Approval UI — serialize the new fields + `reveal_capture` plain language + auto-resume disclosure

**Files:**
- Modify: `src/daemon/approvals/ui-server.ts:46-52` (the grant→JSON projection — **the actual runtime fix**; without it `ui.html` reads `undefined` and shows `?`)
- Modify: `src/daemon/approvals/ui.html:30-39` (the `human` map), `:52` (Capture mode body row), `:53-60` (technical details), `:61-62` (auto-resume disclosure)
- Test: `src/daemon/approvals/ui-reveal-capture.test.ts` (static HTML), `src/daemon/approvals/ui-grant-json-reveal-capture.test.ts` (runtime JSON — proves serialization)

> The static-HTML test alone is insufficient (Phase-2 lesson): it passes even if `ui-server.ts` never serializes the new fields, so at runtime the approval UI would silently show `?` for the labels and omit the reveal/hide/container fingerprints. Both the serializer change **and** a JSON-level test are required.

- [ ] **Step 1: Write the failing static-HTML test AND the runtime JSON test**

Create `src/daemon/approvals/ui-reveal-capture.test.ts`:
```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

test("ui.html has a reveal_capture plain-language sentence with the reveal/field-or-container labels, planned_ref, capture_mode and domain", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /reveal_capture:/);
  assert.match(html, /reveal_handle_label/);
  assert.match(html, /capture_mode/);
});

test("ui.html renders the explicit auto-resume disclosure for reveal_capture", async () => {
  const html = await readFile(UI, "utf8");
  // The shared disclosure copy is gated on inject_submit OR reveal_capture.
  assert.match(html, /reveal_capture/);
  assert.match(html, /auto-resume observation only if the secret is verified gone/i);
});

test("ui.html shows the capture mode in the body, plus reveal/hide/container fingerprints in technical details", async () => {
  const html = await readFile(UI, "utf8");
  assert.match(html, /Capture mode/);
  assert.match(html, /reveal_fingerprint/);
  assert.match(html, /hide_fingerprint/);
  assert.match(html, /container_fingerprint/);
});
```

Create `src/daemon/approvals/ui-grant-json-reveal-capture.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-uijr-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
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
    await rm(home, { recursive: true, force: true });
  }
}

test("the UI grant JSON serializes the reveal_capture display + match fields (real values, not ?)", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/WH",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T-1", field_fingerprint: null, template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
      container_fingerprint: "sha256:container", capture_mode: "container",
      auto_resume: true, reveal_handle_label: "reveal-button",
      hide_handle_label: "hide-button", container_handle_label: "secret-card",
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.reveal_handle_label, "reveal-button");
    assert.equal(j.hide_handle_label, "hide-button");
    assert.equal(j.container_handle_label, "secret-card");
    assert.equal(j.reveal_fingerprint, "sha256:reveal");
    assert.equal(j.hide_fingerprint, "sha256:hide");
    assert.equal(j.container_fingerprint, "sha256:container");
    assert.equal(j.capture_mode, "container");
  });
});

test("the UI grant JSON keeps the absent reveal_capture optionals as null (no-hide-handle / field mode)", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/WH",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T-1", field_fingerprint: "sha256:thefield", template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", capture_mode: "field",
      auto_resume: true, reveal_handle_label: "reveal-button", field_handle_label: "secret-field",
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.capture_mode, "field");
    assert.equal(j.field_fingerprint, "sha256:thefield");
    assert.equal(j.hide_fingerprint, null);
    assert.equal(j.container_fingerprint, null);
    assert.equal(j.hide_handle_label, null);
    assert.equal(j.container_handle_label, null);
  });
});
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/ui-reveal-capture.test.js dist/daemon/approvals/ui-grant-json-reveal-capture.test.js`
Expected: FAIL — the static test fails on the missing substrings (`reveal_capture:`, `capture_mode`, `Capture mode`, `reveal_fingerprint`, `hide_fingerprint`, `container_fingerprint`); the JSON test fails because `ui-server.ts` does not yet serialize `reveal_fingerprint`/`hide_fingerprint`/`container_fingerprint`/`capture_mode`/`reveal_handle_label`/`hide_handle_label`/`container_handle_label` (those keys are absent/`undefined` in the response, so `j.reveal_handle_label` is `undefined` not `"reveal-button"`).

- [ ] **Step 3: Serialize the new fields in `ui-server.ts`**

In `src/daemon/approvals/ui-server.ts`, the grant JSON projection object is the `JSON.stringify({ … })` at lines 32-55. The Phase-2 fields `allowed_actions`/`submit_fingerprint`/`success_condition`/`field_handle_label`/`submit_handle_label` are already present (lines 46-50). Add these seven lines immediately **after** the existing `submit_handle_label: grant.submit_handle_label ?? null,` line (line 50), **before** the `page_title:` line (line 51) — do NOT duplicate any existing line:
```ts
      reveal_fingerprint: grant.reveal_fingerprint ?? null,
      hide_fingerprint: grant.hide_fingerprint ?? null,
      container_fingerprint: grant.container_fingerprint ?? null,
      capture_mode: grant.capture_mode ?? null,
      reveal_handle_label: grant.reveal_handle_label ?? null,
      hide_handle_label: grant.hide_handle_label ?? null,
      container_handle_label: grant.container_handle_label ?? null,
```

- [ ] **Step 4: Add the copy to `ui.html`**

In `src/daemon/approvals/ui.html`, the `human` map is lines 30-39 (`inject_submit:` is line 37, `blind_end:` line 38). Add the `reveal_capture` entry immediately **after** the existing `inject_submit:` line (line 37), before the `blind_end:` line — every interpolated value MUST stay `esc()`-wrapped (it is spliced raw into `<p><b>${human}</b></p>`, mirroring the existing `inject_submit` line's note on line 36):
```js
          reveal_capture: `Click <b>${esc(g.reveal_handle_label ?? "?")}</b> on ${esc(g.destination_domain ?? "?")}, capture the revealed secret into ${esc(g.planned_ref ?? "")} (from <b>${esc(g.field_handle_label ?? g.container_handle_label ?? "?")}</b>, mode <code>${esc(g.capture_mode ?? "?")}</code>), hide it, and automatically resume observation only if the secret is verified gone`,
```

In the same file, immediately **after** the existing `Success marker` row (line 52, the `${g.success_condition ? \`<div class="row">…Success marker…</div>\` : ""}` line), add a `Capture mode` main-body row (non-secret, part of the approved plan, like the success-condition row):
```js
          ${g.capture_mode ? `<div class="row"><span class="label">Capture mode</span><code>${esc(g.capture_mode)}</code></div>` : ""}
```

In the same file, the technical-details `<details>` block is lines 53-60; its last fingerprint row is the `Submit fingerprint` line (line 59). Add the reveal/hide/container fingerprint rows immediately **after** that `Submit fingerprint` line (line 59), before the `</details>` (line 60):
```js
            ${g.reveal_fingerprint ? `<div class="row"><span class="label">Reveal fingerprint</span><code>${esc(g.reveal_fingerprint)}</code></div>` : ""}
            ${g.hide_fingerprint ? `<div class="row"><span class="label">Hide fingerprint</span><code>${esc(g.hide_fingerprint)}</code></div>` : ""}
            ${g.container_fingerprint ? `<div class="row"><span class="label">Container fingerprint</span><code>${esc(g.container_fingerprint)}</code></div>` : ""}
```

In the same file, the prominent auto-resume disclosure for `inject_submit` is line 62 (`${g.action === "inject_submit" ? \`<div class="row" style="color:#c33">…\` : ""}`). Replace that single line 62 with — extend the SAME pattern to `reveal_capture` by widening the guard (do NOT add a second near-duplicate `<div>`; reuse the established copy verbatim so the spec §6.4 "both render an explicit, prominent line" requirement is met with one source):
```js
          ${(g.action === "inject_submit" || g.action === "reveal_capture") ? `<div class="row" style="color:#c33"><b>Approving authorizes the daemon to auto-resume observation only if the secret is verified gone (success/capture and absence checks pass). If they do not, blind mode stays on.</b></div>` : ""}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/ui-reveal-capture.test.js dist/daemon/approvals/ui-grant-json-reveal-capture.test.js`
Expected: PASS — static (3) + JSON (2) tests pass. (If the static test cannot find `dist/daemon/approvals/ui.html`, the `package.json` `build` script copies `src/daemon/approvals/ui.html` → `dist/daemon/approvals/ui.html`; the test's `UI` path resolves relative to its own `dist` location so it reads the copied file. The JSON test does not depend on the file copy.)

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green. The existing Phase-2 `ui-inject-submit.test.ts`/`ui-grant-json.test.ts` still pass: the `inject_submit` disclosure copy moved into a shared `(inject_submit || reveal_capture)` guard but the asserted substring (`auto-resume observation only if the secret is verified gone`) is preserved verbatim, and no existing serialized field was removed or duplicated.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/approvals/ui-server.ts src/daemon/approvals/ui.html src/daemon/approvals/ui-reveal-capture.test.ts src/daemon/approvals/ui-grant-json-reveal-capture.test.ts
git commit -m "feat(reveal-capture): serialize reveal/hide/container fields in ui-server + approval UI copy/disclosure (spec §6.4)"
```

---

### Task 3: Audit vocabulary + extended `autoResumeBlind` signal

**Files:**
- Modify: `src/daemon/audit.ts:4-10` (`DaemonAuditAction`), `:12-29` (`DaemonAuditEvent`)
- Modify: `src/daemon/blind-auto-resume.ts:5-10` (`AutoResumeArgs`), `:21` (the precondition)
- Test: `src/daemon/blind-auto-resume-reveal.test.ts`

> `audit.ts` already has `inject_submit`/`blind_auto_resume`/`submitted`/`success_signal`/`absence_proof`/`blind_mode`/`op` from Phase 2; only `reveal_capture` + a `captured` field are new. `blind-auto-resume.ts`'s `AutoResumeArgs.op` already includes `"reveal_capture"`, but `success_signal` is hard-typed/asserted as `"text_matched"` only — reveal-capture has NO success-text observation (its precondition is captured-non-empty + hide/blank-succeeded + absence-passed), so the signal value must be widened. This is the one spec ambiguity resolved here (see Self-Review §3).

- [ ] **Step 1: Write the failing test**

Create `src/daemon/blind-auto-resume-reveal.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { autoResumeBlind } from "./blind-auto-resume.js";
import { getShuttlePaths } from "../shared/config.js";

test("autoResumeBlind ends blind for op:reveal_capture with success_signal:secret_captured and writes a distinct blind_auto_resume record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-arr-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("dashboard.stripe.com", "reveal_capture");
    assert.notEqual(services.blind.current(), null);

    await autoResumeBlind(services, {
      op: "reveal_capture", domain: "dashboard.stripe.com",
      success_signal: "secret_captured", absence_proof: "passed",
    });

    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rec = lines.find((l) => l.action === "blind_auto_resume");
    assert.ok(rec, "a blind_auto_resume record must exist");
    assert.equal(rec!.ok, true);
    assert.equal(rec!.domain, "dashboard.stripe.com");
    assert.equal(rec!.op, "reveal_capture");
    assert.equal(rec!.success_signal, "secret_captured");
    assert.equal(rec!.absence_proof, "passed");
    assert.equal(lines.some((l) => l.action === "blind_end"), false);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind still accepts the Phase-2 inject_submit/text_matched signal (backward compatible)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-arr2-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("vercel.com", "inject_submit");
    await autoResumeBlind(services, {
      op: "inject_submit", domain: "vercel.com",
      success_signal: "text_matched", absence_proof: "passed",
    });
    assert.equal(services.blind.current(), null);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind refuses (throws auto_resume_precondition) for reveal_capture if the proof is not passed; stays blind", async () => {
  const services = new DaemonServices();
  services.blind.start("dashboard.stripe.com", "reveal_capture");
  await assert.rejects(
    () => autoResumeBlind(services, {
      op: "reveal_capture", domain: "dashboard.stripe.com",
      success_signal: "secret_captured",
      // @ts-expect-error intentionally wrong to prove the guard
      absence_proof: "inconclusive",
    }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "auto_resume_precondition",
  );
  assert.notEqual(services.blind.current(), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Type '"secret_captured"' is not assignable to type '"text_matched"'` (`TS2322`) on the first test's `success_signal`. Expected first failure.

- [ ] **Step 3: Extend the audit vocabulary**

In `src/daemon/audit.ts`, the `DaemonAuditAction` type is lines 4-10; its line 7 is `| "generate" | "capture" | "inject" | "inject_submit" | "compare"`. Replace that single line 7 with (add `"reveal_capture"`):
```ts
  | "generate" | "capture" | "inject" | "inject_submit" | "reveal_capture" | "compare"
```
In the same file, the `DaemonAuditEvent` interface is lines 12-29. Add one field immediately **after** the existing `submitted?: boolean | "unknown";` line (line 24), before `success_signal?:` (line 25):
```ts
  captured?: boolean | "unknown";
```

- [ ] **Step 4: Widen the auto-resume signal**

In `src/daemon/blind-auto-resume.ts`, the `AutoResumeArgs` interface is lines 5-10. Replace its `success_signal: "text_matched";` line (line 8) with (the `op` union on line 6 already includes `"reveal_capture"` — leave it):
```ts
  success_signal: "text_matched" | "secret_captured";
```
In the same file, the precondition guard is line 21: `if (args.success_signal !== "text_matched" || args.absence_proof !== "passed") {`. Replace that single line 21 with (accept either signal; the proof gate is unchanged):
```ts
  if (
    (args.success_signal !== "text_matched" && args.success_signal !== "secret_captured") ||
    args.absence_proof !== "passed"
  ) {
```
> Rationale: `autoResumeBlind` still bypasses approval + `blankAllPages` and writes the distinct `blind_auto_resume` record (spec §7, unchanged). The proof precondition (`absence_proof === "passed"`) is unchanged — the only widening is which non-empty success signal counts. The inject-submit route still passes `"text_matched"` (unaffected); the reveal-capture route passes `"secret_captured"` and only after it has independently verified captured-non-empty AND hide/blank-succeeded (Task 8).

- [ ] **Step 5: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/blind-auto-resume-reveal.test.js`
Expected: PASS — 3 tests pass.

Run: `npm test`
Expected: PASS — all tests green. The Phase-2 `blind-auto-resume.test.ts` still passes (the `"text_matched"` branch is preserved; the union/guard widening is additive).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/audit.ts src/daemon/blind-auto-resume.ts src/daemon/blind-auto-resume-reveal.test.ts
git commit -m "feat(reveal-capture): audit vocabulary (reveal_capture + captured) + autoResumeBlind secret_captured signal (spec §7/§8)"
```

---

### Task 4: `BrowserOps` — `Baseline` type + `readBackendNodeValue` + `baselineCandidates` + `resolveWithinContainer` (daemon-only; hash/boolean egress; fail-closed)

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (the `Baseline` type after `AbsenceProofResult`; `BrowserOps` interface +3 members; the `BASELINE_SCAN_FN`/`RESOLVE_SCAN_FN` module constants; the 3 `CdpBrowserOps` methods)
- Modify: `src/daemon/api/routes.test.ts`, `src/e2e/stripe-to-vercel.test.ts`, `src/daemon/api/browser-handles-routes.test.ts`, `src/daemon/api/inject-submit-routes.test.ts` (stub fixups — ALL `BrowserOps` literals, same task to keep the tree green)
- Test: `src/daemon/chrome/baseline-resolve.test.ts`

> Egress discipline (Phase-2 lesson): the in-page scans return ONLY hashes, safety classes and booleans — NEVER the raw value/text — to the agent layer or the audit. `BASELINE_SCAN_FN` returns hashed/classified entries; `RESOLVE_SCAN_FN` returns the chosen **element-or-`null`** (a RemoteObject handle, no value egress). The raw secret value is read exactly **once**, by the single chosen-candidate one-shot read inside `resolveWithinContainer` (off the RemoteObject `objectId` `RESOLVE_SCAN_FN` returned, after the DOM-containment proof), and is returned only to the route which passes it straight to `vault.upsertSecret`. **ALL THREE capture modes (`field`/`container`/`focused-after-reveal`) go through `resolveWithinContainer`** so the §6.1 per-candidate safe→revealed gate is enforced once (DRY) and tested once — `field` mode is NOT a direct value read (a field already script-readable-unchanged pre-reveal MUST fail closed, spec §6.1). `readBackendNodeValue` remains the generic §12 daemon-only single-element reader (kept + tested independently) but is not the capture path. Every uncertainty (CDP error, cross-origin, detached, ambiguity, no transition, already-readable-unchanged, non-containment) throws a single fail-closed `ShuttleError` (the response is enum-only `captured:"unknown"`, so granular reason codes are not surfaced). Internal scans are BOUNDED via the existing `boundedSend`; the route additionally `withDeadline`-wraps the reveal→resolve→read→hide sequence (Task 5).

- [ ] **Step 1: Write the failing scripted-transport + DOM-shim test**

Create `src/daemon/chrome/baseline-resolve.test.ts`:
```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import {
  CdpBrowserOps,
  BASELINE_SCAN_FN,
  RESOLVE_SCAN_FN,
  type Baseline,
} from "./internal-ops.js";
import { ShuttleError } from "../../shared/errors.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

// ---- DOM-shim driving the REAL in-page fns (runScan precedent, absence-proof.test.ts) ----
// Minimal element shim: only the properties BASELINE_SCAN_FN / RESOLVE_SCAN_FN read.
// `__id` is a stable marker so the element-identity assertions can name the
// element RESOLVE_SCAN_FN returned (it now returns the chosen element itself —
// or null — exactly like NORMALIZE_TO_ACTIONABLE_FN returns the element/null).
interface El {
  __id?: string;
  nodeType?: number;
  tagName: string;
  type?: string;
  value?: string;
  innerText?: string;
  textContent?: string;
  isContentEditable?: boolean;
  role?: string | null;
  href?: boolean;
  children?: El[];
  shadowRoot?: { children: El[] } | null;
}
function el(tag: string, props: Partial<El> = {}): El {
  return {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    shadowRoot: null,
    getAttribute(name: string) {
      if (name === "role") return props.role ?? null;
      return null;
    },
    hasAttribute(name: string) {
      return name === "href" ? props.href === true : false;
    },
    ...props,
  } as unknown as El;
}
function makeBaseline(root: El): (r: El) => unknown {
  return new Function("root", `return (${BASELINE_SCAN_FN}).call(root);`) as (r: El) => unknown;
}
// RESOLVE_SCAN_FN returns the chosen ELEMENT itself, or null for every
// fail-closed selection outcome (zero / >1 transition-eligible /
// already-readable-unchanged / no-transition / predicate-fails /
// focused-non-candidate). No value, no {ok,...} envelope — mirrors the
// NORMALIZE_TO_ACTIONABLE_FN element-or-null contract.
function makeResolve(root: El): (r: El, baseline: unknown, focused: El | null) => El | null {
  return new Function("root", "baseline", "focused", `return (${RESOLVE_SCAN_FN}).call(root, baseline, focused);`) as
    (r: El, b: unknown, f: El | null) => El | null;
}

test("BASELINE_SCAN_FN classes an empty/absent input as safe and a non-empty text node as readable; returns hashes only (no raw text)", () => {
  const input = el("input", { type: "text", value: "" });
  const label = el("span", { textContent: "Webhook signing secret" });
  const root = el("div", { children: [input, label] });
  const b = makeBaseline(root)(root) as Baseline;
  assert.equal(Array.isArray(b.entries), true);
  // empty input → safe; label with text → readable; NEITHER carries raw text
  const dump = JSON.stringify(b);
  assert.equal(dump.includes("Webhook signing secret"), false);
  const safes = b.entries.filter((e) => e.safety === "safe").length;
  const readables = b.entries.filter((e) => e.safety === "readable").length;
  assert.equal(safes >= 1, true);
  assert.equal(readables >= 1, true);
});

test("RESOLVE_SCAN_FN: a container with readable label/help siblings PLUS one revealed field returns THAT element (siblings dropped before the exactly-one check)", () => {
  // baseline: input empty (safe), label has text (readable)
  const input0 = el("input", { __id: "f1", type: "text", value: "" });
  const label = el("span", { __id: "l1", textContent: "Signing secret" });
  const help = el("p", { __id: "h1", textContent: "Click reveal to view" });
  const root0 = el("div", { children: [input0, label, help] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: SAME structural positions; input now has the secret value
  const input1 = el("input", { __id: "f1", type: "text", value: "whsec_REVEALED" });
  const label1 = el("span", { __id: "l1", textContent: "Signing secret" });
  const help1 = el("p", { __id: "h1", textContent: "Click reveal to view" });
  const root1 = el("div", { children: [input1, label1, help1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "f1"); // the single safe→revealed element itself
});

test("RESOLVE_SCAN_FN: two simultaneously revealed fields → ambiguous → null", () => {
  const a0 = el("input", { __id: "a", type: "text", value: "" });
  const b0 = el("input", { __id: "b", type: "text", value: "" });
  const root0 = el("div", { children: [a0, b0] });
  const baseline = makeBaseline(root0)(root0);
  const a1 = el("input", { __id: "a", type: "text", value: "whsec_AAA" });
  const b1 = el("input", { __id: "b", type: "text", value: "whsec_BBB" });
  const root1 = el("div", { children: [a1, b1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN: a chosen candidate already readable-unchanged pre-reveal → fail closed → null", () => {
  const code0 = el("code", { __id: "c", textContent: "whsec_ALREADY_VISIBLE" });
  const root0 = el("div", { children: [code0] });
  const baseline = makeBaseline(root0)(root0);
  const code1 = el("code", { __id: "c", textContent: "whsec_ALREADY_VISIBLE" }); // unchanged
  const root1 = el("div", { children: [code1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN: no safe→revealed transition (stale/label text only) → fail closed → null", () => {
  const label0 = el("span", { __id: "l", textContent: "Signing secret" });
  const root0 = el("div", { children: [label0] });
  const baseline = makeBaseline(root0)(root0);
  const label1 = el("span", { __id: "l", textContent: "Signing secret" }); // unchanged readable, not a candidate transition
  const root1 = el("div", { children: [label1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN predicate rejects a button/link/label even if it has revealed text → null", () => {
  const btn0 = el("button", { __id: "btn", textContent: "" });
  const root0 = el("div", { children: [btn0] });
  const baseline = makeBaseline(root0)(root0);
  const btn1 = el("button", { __id: "btn", textContent: "whsec_LOOKS_LIKE_SECRET" }); // a button is never a candidate
  const root1 = el("div", { children: [btn1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN focused-after-reveal: focus left on a button → fail closed → null (focused arg is not a candidate)", () => {
  const btn0 = el("button", { __id: "btn", textContent: "Reveal" });
  const root0 = el("div", { children: [btn0] });
  const baseline = makeBaseline(root0)(root0);
  const btn1 = el("button", { __id: "btn", textContent: "Reveal" });
  const root1 = el("div", { children: [btn1] });
  // focused === the reveal button → not a secret-holder candidate
  const r = makeResolve(root1)(root1, baseline, btn1);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN field-mode gate: a field scanned as its OWN root that was safe pre-reveal and is now revealed returns that element", () => {
  // field mode binds the scan to the field element itself (its own subtree
  // root); the same per-candidate safe→revealed gate applies (spec §6.1).
  const field0 = el("input", { __id: "the-field", type: "password", value: "" }); // safe baseline
  const baseline = makeBaseline(field0)(field0);
  const field1 = el("input", { __id: "the-field", type: "password", value: "whsec_UNMASKED" });
  const r = makeResolve(field1)(field1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "the-field");
});

test("RESOLVE_SCAN_FN field-mode gate: a field already readable-unchanged pre-reveal → fail closed → null (secret was observable without blind protection)", () => {
  const field0 = el("input", { __id: "the-field", type: "text", value: "whsec_ALREADY_IN_DOM" }); // readable baseline
  const baseline = makeBaseline(field0)(field0);
  const field1 = el("input", { __id: "the-field", type: "text", value: "whsec_ALREADY_IN_DOM" }); // unchanged
  const r = makeResolve(field1)(field1, baseline, null);
  assert.equal(r, null);
});

// ---- ScriptedTransport for the CdpBrowserOps methods (absence-proof.test.ts precedent) ----
// Shapes the EXACT new CDP sequence (mirrors how mark-pick / click-backend-node
// scripted tests shape DOM.resolveNode / Runtime.callFunctionOn / DOM.describeNode):
//   resolveWithinContainer:
//     DOM.resolveNode {backendNodeId}            -> { object:{objectId} }   (the container/field root)
//     [focused-after-reveal only] Runtime.evaluate document.activeElement -> RemoteObject
//     Runtime.callFunctionOn RESOLVE_SCAN_FN  (NO returnByValue)           -> RemoteObject of the chosen element (or subtype:"null")
//     DOM.describeNode {objectId}                -> { node:{ backendNodeId } }   (chosen backend node)
//     isDescendantOf: DOM.resolveNode ×2 + Runtime.callFunctionOn `contains` -> { result:{ value:boolean } }
//     Runtime.callFunctionOn value-reader (returnByValue:true)             -> { result:{ value: "<secret>" } }   (read ONCE)
//   readBackendNodeValue: DOM.resolveNode + Runtime.callFunctionOn value-reader.
//   baselineCandidates:   DOM.resolveNode + Runtime.callFunctionOn BASELINE_SCAN_FN (returnByValue:true).
class RcTransport extends EventEmitter implements CdpTransport {
  // readBackendNodeValue / the one-shot value read in resolveWithinContainer.
  fieldValue = "whsec_FIELD_MODE_VALUE";
  // baselineCandidates drives BASELINE_SCAN_FN whose result we inject directly
  // (the scan logic itself is covered by the DOM-shim tests above).
  baselineResult: { ok: boolean; entries: Baseline["entries"] } = { ok: true, entries: [{ key: "k0", safety: "safe", fp: "h0" }] };
  // RESOLVE_SCAN_FN now returns the chosen ELEMENT (no returnByValue → a
  // RemoteObject). `resolveYieldsObject:false` simulates the fail-closed
  // null/no-objectId outcome (zero / >1 / already-readable / no-transition).
  resolveYieldsObject = true;
  chosenBackendNodeId = 42;
  containsResult = true;
  throwOnEvaluate = false;

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    const fail = (m: string): void => queueMicrotask(() => this.emit("message", { id: msg.id, error: { code: -1, message: m } }));
    switch (msg.method) {
      case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
      case "Target.detachFromTarget":
      case "Runtime.releaseObject": reply({}); return;
      case "DOM.resolveNode": reply({ object: { objectId: `obj-${Math.random()}` } }); return;
      case "Runtime.evaluate": reply({ result: { objectId: `ae-${Math.random()}` } }); return;
      case "DOM.describeNode": reply({ node: { backendNodeId: this.chosenBackendNodeId } }); return;
      case "Runtime.callFunctionOn": {
        if (this.throwOnEvaluate) { fail("callFunctionOn boom"); return; }
        const fn = String(msg.params?.["functionDeclaration"] ?? "");
        const byValue = msg.params?.["returnByValue"] === true;
        if (fn.includes("contains")) { reply({ result: { value: this.containsResult } }); return; }
        if (fn.includes("__BASELINE__")) { reply({ result: { value: this.baselineResult } }); return; }
        if (fn.includes("__RESOLVE__")) {
          // No returnByValue: RESOLVE_SCAN_FN yields the chosen element as a
          // RemoteObject (objectId present), or a null RemoteObject for every
          // fail-closed selection outcome.
          if (this.resolveYieldsObject) { reply({ result: { objectId: `chosen-${Math.random()}` } }); return; }
          reply({ result: { type: "object", subtype: "null", value: null } });
          return;
        }
        // The tiny value-reader (returnByValue:true) used by readBackendNodeValue
        // AND the single one-shot read in resolveWithinContainer.
        if (byValue) { reply({ result: { value: { ok: true, value: this.fieldValue } } }); return; }
        reply({ result: {} });
        return;
      }
      default: reply({}); return;
    }
  }
}

test("readBackendNodeValue returns the daemon-only field value (single-element reader, §12)", async () => {
  const t = new RcTransport();
  t.fieldValue = "whsec_FIELD_MODE_VALUE";
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(
    await ops.readBackendNodeValue({ target_id: "T-1", backend_node_id: 11 }),
    "whsec_FIELD_MODE_VALUE",
  );
});

test("readBackendNodeValue fails closed (ShuttleError) on any CDP error", async () => {
  const t = new RcTransport();
  t.throwOnEvaluate = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.readBackendNodeValue({ target_id: "T-1", backend_node_id: 11 }),
    (e: unknown) => e instanceof ShuttleError,
  );
});

test("baselineCandidates returns the hashed/classified Baseline (no raw text leaves)", async () => {
  const t = new RcTransport();
  t.baselineResult = { ok: true, entries: [{ key: "k0", safety: "safe", fp: "h0" }, { key: "k1", safety: "readable", fp: "h1" }] };
  const ops = new CdpBrowserOps(new CdpClient(t));
  const b = await ops.baselineCandidates({ target_id: "T-1", backend_node_id: 7 });
  assert.deepEqual(b, { entries: t.baselineResult.entries });
});

test("resolveWithinContainer (container): RemoteObject chosen → describeNode → isDescendantOf passes → ONE value read", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 42;
  t.containsResult = true;
  t.fieldValue = "whsec_RESOLVED";
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.resolveWithinContainer(
    { target_id: "T-1", backend_node_id: 7 },
    "container",
    { entries: [{ key: "k0", safety: "safe", fp: "h0" }] },
  );
  assert.deepEqual(r, { value: "whsec_RESOLVED" });
});

test("resolveWithinContainer (field mode): same per-candidate gate path — RemoteObject → describeNode → containment (chosen is the root) → value read", async () => {
  // field mode binds the scan to the field's own backend node; the chosen
  // element IS the root, so isDescendantOf (or the IS-the-root branch) holds.
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 7; // == ref.backend_node_id (the field is its own root)
  t.containsResult = false;  // contains(self) may be false; the IS-root branch must still pass
  t.fieldValue = "whsec_FIELD_GATED";
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "field", { entries: [] });
  assert.deepEqual(r, { value: "whsec_FIELD_GATED" });
});

test("resolveWithinContainer fails closed when RESOLVE_SCAN_FN yields a null RemoteObject (zero/>1/already-readable/no-transition)", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = false; // subtype:"null" / no objectId → no single safe→revealed candidate
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "reveal_no_transition",
  );
});

test("resolveWithinContainer fails closed when DOM containment proof is false (chosen node not inside the approved container)", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 999; // != ref.backend_node_id
  t.containsResult = false;    // container.contains(chosen) === false
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "reveal_not_contained",
  );
});

test("resolveWithinContainer fails closed on any CDP error", async () => {
  const t = new RcTransport();
  t.throwOnEvaluate = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [] }),
    (e: unknown) => e instanceof ShuttleError,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL to compile — `Module '"./internal-ops.js"' has no exported member 'BASELINE_SCAN_FN'` / `'RESOLVE_SCAN_FN'` / `'Baseline'`, and `Property 'readBackendNodeValue' does not exist on type 'CdpBrowserOps'` (`TS2305`/`TS2339`). Expected first failure.

- [ ] **Step 3: Add the `Baseline` type + interface members**

In `src/daemon/chrome/internal-ops.ts`, add immediately **after** the existing `export interface AbsenceProofResult { passed: boolean }` block (lines 126-128):
```ts
export type SafetyClass = "safe" | "readable";

export interface BaselineEntry {
  /** Stable structural key of the candidate within the approved subtree (path-based, not text). */
  key: string;
  /** safe = empty/absent/password-input-with-no-script-readable-value/recognized mask; readable = any non-empty script-readable value/text. */
  safety: SafetyClass;
  /** Hashed value/state fingerprint of this candidate (NEVER raw value/text). */
  fp: string;
}

export interface Baseline {
  entries: BaselineEntry[];
}
```

In the same file, the `BrowserOps` interface is lines 155-169; its last member is `clickBackendNode(ref: BackendNodeRef): Promise<void>;` (line 168). Add these three members immediately **after** that line (line 168), before the interface's closing `}` (line 169):
```ts
  /** Daemon-only single-element value reader (spec §12). Value never returned to the agent layer. Used internally; the per-candidate safe→revealed gate lives in `resolveWithinContainer` (all 3 modes go through it). */
  readBackendNodeValue(ref: BackendNodeRef): Promise<string>;
  /** Pre-blind, daemon-only: hashed value/state + safety class per candidate in the approved subtree. Readable siblings recorded, not rejected. */
  baselineCandidates(ref: BackendNodeRef): Promise<Baseline>;
  /** Post-reveal, daemon-only. Applies the SAME §6.1 per-candidate safe→revealed gate to ALL THREE modes: predicate → transition-eligible filter (drop unchanged-from-readable / still-safe) → exactly one safe→revealed → DOM containment proof → one-shot value read. For `field` the scan is bound to the field's own backend node (the field is its own subtree root / sole candidate) so a field already readable-unchanged pre-reveal fails closed too. Throws fail-closed on any uncertainty. */
  resolveWithinContainer(ref: BackendNodeRef, mode: "field" | "container" | "focused-after-reveal", baseline: Baseline): Promise<{ value: string }>;
```

- [ ] **Step 4: Add the in-page scan scripts**

In `src/daemon/chrome/internal-ops.ts`, add these two module-level constants immediately **after** the existing `const OBSERVE_TEXT_FN = \`…\`;` block (lines 340-345). They run via `Runtime.callFunctionOn` with `this` bound to the approved subtree root (`baselineCandidates`/`resolveWithinContainer` resolve the container/field backend node first). They MUST stay in lockstep with `elementKind()` (§3.3 single source of truth) — the embedded `kind()` mirrors `NORMALIZE_TO_ACTIONABLE_FN`'s copy. Egress is hash/class/boolean ONLY: `BASELINE_SCAN_FN` returns `{ok,entries:[{key,safety,fp}]}`; `RESOLVE_SCAN_FN` returns the chosen **element itself or `null`** (called WITHOUT `returnByValue`, so it yields only a RemoteObject handle — no value crosses out here; the single chosen value is read separately, exactly once, by `resolveWithinContainer` off that same `objectId`). This mirrors the merged `NORMALIZE_TO_ACTIONABLE_FN` element-or-null contract — there is **no** value-returning/locate twin and **no** `.replace`:
```ts
// Daemon-only. `this` = the approved field/container subtree root. Records, per
// candidate-eligible element, a HASHED value/state fingerprint (never raw) + a
// safety class (§6.1). Readable siblings are RECORDED, not rejected. Returns
// { entries:[{key,safety,fp}] } only. "__BASELINE__" routes the scripted test
// transport. Exported so the predicate/classification is unit-assertable.
export const BASELINE_SCAN_FN = `function(){ /* __BASELINE__ */
  var TEXT = ["","text","password","email","url","search","tel","number"];
  function h(s){ // small non-cryptographic digest; only used to detect change (never reversed/egressed as text)
    s = String(s == null ? "" : s); var x = 5381, i = 0;
    for (i = 0; i < s.length; i++) { x = ((x << 5) + x + s.charCodeAt(i)) | 0; }
    return ("00000000" + (x >>> 0).toString(16)).slice(-8);
  }
  function kind(el){
    var tag = el.tagName.toLowerCase();
    var type = (el.type || "").toLowerCase();
    var role = (el.getAttribute && (el.getAttribute("role") || "")).toLowerCase ? (el.getAttribute("role") || "").toLowerCase() : "";
    var editable = (typeof HTMLElement !== "undefined" && el instanceof HTMLElement) ? el.isContentEditable : el.isContentEditable === true;
    if (editable && tag !== "input" && tag !== "textarea") return "field";
    if (tag === "textarea") return "field";
    if (tag === "input" && TEXT.indexOf(type) !== -1) return "field";
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (tag === "input" && ["submit","button","image","reset"].indexOf(type) !== -1) return "button";
    if ((tag === "a" && el.hasAttribute && el.hasAttribute("href")) || role === "link") return "link";
    return "other";
  }
  // A candidate is: a field-kind element with non-empty value/text, OR a
  // non-interactive text-bearing element (code/span/pre/p/div text node) with
  // non-empty text. Buttons/links/labels are NEVER candidates.
  function isCandidate(el){
    var k = kind(el);
    if (k === "button" || k === "link") return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "label") return false;
    if (k === "field") return true;
    // non-interactive text element: only count its OWN text (no descendant elements
    // with their own candidacy) to avoid double-counting container wrappers.
    if (el.children && el.children.length > 0) return false;
    return true;
  }
  function readableValue(el){
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      // password input with no script-readable value is SAFE; .value is script-readable here only if the page exposes it
      return typeof el.value === "string" ? el.value : "";
    }
    if (el.isContentEditable) return typeof el.innerText === "string" ? el.innerText : "";
    return typeof el.textContent === "string" ? el.textContent : "";
  }
  function isSafeState(el){
    var tag = el.tagName.toLowerCase();
    var v = readableValue(el);
    if (v === "" || v == null) return true;
    if ((tag === "input" || tag === "textarea") && (el.type || "").toLowerCase() === "password" && el.value === "") return true;
    // recognized mask/placeholder: a run of bullet/asterisk chars only
    if (/^[\\u2022\\u25CF\\*\\u2024\\u00B7\\s]+$/.test(v)) return true;
    return false;
  }
  try {
    var root = this;
    if (!root || root.nodeType !== 1) return { ok:false, entries:[] };
    var entries = [], stack = [{ el: root, path: "0" }], n = 0;
    while (stack.length) {
      var cur = stack.pop(); var el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      if (++n > 200000) return { ok:false, entries:[] };
      if (isCandidate(el)) {
        var safe = isSafeState(el);
        entries.push({ key: cur.path, safety: safe ? "safe" : "readable", fp: h(readableValue(el)) });
      }
      if (el.shadowRoot) { var sc = el.shadowRoot.children; for (var i = 0; i < sc.length; i++) stack.push({ el: sc[i], path: cur.path + ".s" + i }); }
      if (el.children) { for (var j = 0; j < el.children.length; j++) stack.push({ el: el.children[j], path: cur.path + "." + j }); }
    }
    return { ok:true, entries: entries };
  } catch (e) { return { ok:false, entries:[] }; }
}`;

// Daemon-only. `this` = the approved subtree root: the container (modes
// `container`/`focused-after-reveal`) OR the field's own element (mode `field`,
// where the field is its own subtree root / sole candidate). `focused` is the
// document.activeElement passed in for `focused-after-reveal`, else null.
//
// Returns the CHOSEN ELEMENT ITSELF (`return chosen;`) — or `null` for EVERY
// fail-closed selection outcome (zero transition-eligible / >1
// transition-eligible / chosen-but-already-readable-unchanged / no
// safe→revealed transition / predicate-fails-or-control-label /
// focused-after-reveal with a non-candidate focused element / empty resolved
// value / any error). NO value, NO {ok,...} envelope — this exactly mirrors
// the merged NORMALIZE_TO_ACTIONABLE_FN element-or-null contract so the daemon
// (resolveWithinContainer) can take it via Runtime.callFunctionOn WITHOUT
// returnByValue (a RemoteObject), prove DOM containment with the EXISTING
// isDescendantOf, and then read the value EXACTLY ONCE off that same objectId.
// Returning the element does NOT egress text (no returnByValue → only a remote
// handle). "__RESOLVE__" routes the scripted test transport. The embedded
// kind()/predicate/transition logic is UNCHANGED (must stay in lockstep with
// elementKind()/NORMALIZE_TO_ACTIONABLE_FN, §3.3); only the returns are now
// element-or-null. The single chosen value is read separately, once, by the
// daemon (→ upsertSecret only).
export const RESOLVE_SCAN_FN = `function(baseline, focused){ /* __RESOLVE__ */
  var TEXT = ["","text","password","email","url","search","tel","number"];
  function h(s){ s = String(s == null ? "" : s); var x = 5381, i = 0; for (i=0;i<s.length;i++){ x = ((x<<5)+x+s.charCodeAt(i))|0; } return ("00000000"+(x>>>0).toString(16)).slice(-8); }
  function kind(el){
    var tag = el.tagName.toLowerCase();
    var type = (el.type || "").toLowerCase();
    var role = (el.getAttribute && (el.getAttribute("role") || "")).toLowerCase ? (el.getAttribute("role") || "").toLowerCase() : "";
    var editable = (typeof HTMLElement !== "undefined" && el instanceof HTMLElement) ? el.isContentEditable : el.isContentEditable === true;
    if (editable && tag !== "input" && tag !== "textarea") return "field";
    if (tag === "textarea") return "field";
    if (tag === "input" && TEXT.indexOf(type) !== -1) return "field";
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (tag === "input" && ["submit","button","image","reset"].indexOf(type) !== -1) return "button";
    if ((tag === "a" && el.hasAttribute && el.hasAttribute("href")) || role === "link") return "link";
    return "other";
  }
  function isCandidate(el){
    var k = kind(el);
    if (k === "button" || k === "link") return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "label") return false;
    if (k === "field") return true;
    if (el.children && el.children.length > 0) return false;
    return true;
  }
  function readableValue(el){
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return typeof el.value === "string" ? el.value : "";
    if (el.isContentEditable) return typeof el.innerText === "string" ? el.innerText : "";
    return typeof el.textContent === "string" ? el.textContent : "";
  }
  function isSafeState(el){
    var tag = el.tagName.toLowerCase();
    var v = readableValue(el);
    if (v === "" || v == null) return true;
    if ((tag === "input" || tag === "textarea") && (el.type || "").toLowerCase() === "password" && el.value === "") return true;
    if (/^[\\u2022\\u25CF\\*\\u2024\\u00B7\\s]+$/.test(v)) return true;
    return false;
  }
  try {
    var root = this;
    if (!root || root.nodeType !== 1) return null;
    var bmap = {}; var be = (baseline && baseline.entries) || [];
    for (var bi = 0; bi < be.length; bi++) bmap[be[bi].key] = be[bi];
    // Enumerate predicate-matching elements with the SAME structural keys as the
    // baseline. The root itself is included (mode `field`: the field is its own
    // root and sole candidate, so the same per-candidate gate applies to it).
    var cands = [], stack = [{ el: root, path: "0" }], n = 0;
    while (stack.length) {
      var cur = stack.pop(); var el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      if (++n > 200000) return null;
      if (isCandidate(el)) cands.push({ el: el, path: cur.path });
      if (el.shadowRoot) { var sc = el.shadowRoot.children; for (var i=0;i<sc.length;i++) stack.push({ el: sc[i], path: cur.path + ".s" + i }); }
      if (el.children) { for (var j=0;j<el.children.length;j++) stack.push({ el: el.children[j], path: cur.path + "." + j }); }
    }
    // focused-after-reveal: the only eligible element is the passed activeElement,
    // and ONLY if it itself passes the predicate.
    if (focused != null) {
      if (!isCandidate(focused)) return null;
      cands = cands.filter(function(c){ return c.el === focused; });
      if (cands.length === 0) return null;
    }
    // Filter to TRANSITION-ELIGIBLE: had a SAFE baseline AND now shows a
    // safe→revealed transition (now NOT safe, value present). Drop anything
    // unchanged from a readable baseline or still-safe. A chosen candidate that
    // was already READABLE-UNCHANGED pre-reveal is the manual-handling case
    // (secret was observable without blind protection → fail closed → null).
    var eligible = [];
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var b = bmap[c.path];
      var nowSafe = isSafeState(c.el);
      if (b && b.safety === "readable") {
        // preexisting readable (unchanged OR changed) is NEVER a safe→revealed
        // transition → ignored (not ambiguous, not eligible).
        continue;
      }
      // b is safe (or no baseline entry → treat as newly-appeared/safe)
      if (nowSafe) continue;                     // still safe → not revealed
      eligible.push(c);
    }
    // Exactly-one rule over the TRANSITION-ELIGIBLE set only (readable siblings
    // never cause a false ">1"). Zero / >1 / empty value → null. Same logic as
    // before; only the return is now the element (or null).
    if (eligible.length !== 1) return null;
    var chosen = eligible[0].el;
    var val = readableValue(chosen);
    if (typeof val !== "string" || val === "") return null;
    return chosen;
  } catch (e) { return null; }
}`;
```

- [ ] **Step 5: Implement the three `CdpBrowserOps` methods**

In `src/daemon/chrome/internal-ops.ts`, add these three methods to the `CdpBrowserOps` class immediately **after** the existing `async clickBackendNode(ref: BackendNodeRef): Promise<void> { … }` method (it ends at line 935), before the class's closing `}` (line 936). They reuse the existing `attach(...)` and `isDescendantOf(...)` helpers (the merged `isDescendantOf(sessionId, ancestorBackendNodeId, candidateBackendNodeId)` at line 852 and the `DOM.resolveNode`→`Runtime.callFunctionOn`-without-`returnByValue`→`DOM.describeNode {objectId}`→release-in-`finally` RemoteObject pattern of `normalizeToActionable` at line 533 and `describeBackendNode` at line 478). The only value that ever crosses out is the single chosen secret, read once → the route → `vault.upsertSecret`:
```ts
  // Daemon-only single-element value reader (spec §12). Resolves the marked
  // backend node and reads its value via Runtime.callFunctionOn. The value is
  // returned to the route ONLY (→ upsertSecret); never to the agent.
  // Fail-closed on any error. (The per-candidate safe→revealed gate lives in
  // resolveWithinContainer — ALL THREE modes go through that; this method is
  // the generic §12 reader primitive, kept and tested independently.)
  async readBackendNodeValue(ref: BackendNodeRef): Promise<string> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        const r = await this.cdp.send<{ result: { value: { ok: boolean; value?: string } } }>(
          "Runtime.callFunctionOn",
          {
            objectId: object.objectId,
            returnByValue: true,
            functionDeclaration: `function(){
              try {
                var tag = this.tagName.toLowerCase();
                if (tag === "input" || tag === "textarea") return { ok:true, value: typeof this.value === "string" ? this.value : "" };
                if (this.isContentEditable) return { ok:true, value: typeof this.innerText === "string" ? this.innerText : "" };
                return { ok:true, value: typeof this.textContent === "string" ? this.textContent : "" };
              } catch (e) { return { ok:false }; }
            }`,
          },
          sessionId,
        );
        const v = r.result.value;
        if (v === undefined || v.ok !== true || typeof v.value !== "string") {
          throw new ShuttleError("reveal_read_failed", "Could not read the marked field value.");
        }
        return v.value;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_read_failed", "Field read failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Pre-blind, daemon-only. Resolves the approved field/container backend node
  // and runs BASELINE_SCAN_FN bound to it. Returns hashed/classified entries
  // ONLY (no raw text). Readable siblings are RECORDED, not rejected (§6.1).
  async baselineCandidates(ref: BackendNodeRef): Promise<Baseline> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        const r = await this.cdp.send<{ result: { value: { ok: boolean; entries: { key: string; safety: "safe" | "readable"; fp: string }[] } } }>(
          "Runtime.callFunctionOn",
          { objectId: object.objectId, returnByValue: true, functionDeclaration: BASELINE_SCAN_FN },
          sessionId,
        );
        const v = r.result.value;
        if (v === undefined || v.ok !== true || !Array.isArray(v.entries)) {
          throw new ShuttleError("reveal_baseline_failed", "Could not baseline the approved subtree.");
        }
        return { entries: v.entries };
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_baseline_failed", "Baseline failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Post-reveal, daemon-only. Applies the SAME §6.1 per-candidate
  // safe→revealed gate to ALL THREE modes (`field`/`container`/
  // `focused-after-reveal`). Resolves the approved subtree root backend node
  // (the container, or — mode `field` — the field's OWN backend node so the
  // field is its own sole candidate and a field already readable-unchanged
  // pre-reveal fails closed too), runs RESOLVE_SCAN_FN bound to it (with
  // document.activeElement for focused-after-reveal). RESOLVE_SCAN_FN returns
  // the CHOSEN ELEMENT itself or null — so this mirrors the merged
  // normalizeToActionable RemoteObject pattern EXACTLY: callFunctionOn WITHOUT
  // returnByValue → a RemoteObject; null/subtype:"null"/no objectId → fail
  // closed. Then DOM.describeNode {objectId} → backendNodeId → DOM-containment
  // proof reusing the EXISTING isDescendantOf (the approved container's backend
  // node must contain — or equal — the chosen node) → read the value EXACTLY
  // ONCE via callFunctionOn on that SAME objectId with returnByValue:true.
  // Every resolved objectId is released in finally (mirrors describeBackendNode/
  // normalizeToActionable). Fail-closed (single ShuttleError; the response is
  // enum-only captured:"unknown" so granular reasons are not surfaced) on no
  // single safe→revealed candidate, containment failure, or any CDP error.
  async resolveWithinContainer(
    ref: BackendNodeRef,
    mode: "field" | "container" | "focused-after-reveal",
    baseline: Baseline,
  ): Promise<{ value: string }> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        // focused-after-reveal: resolve document.activeElement as a callable arg.
        let focusedArg: { objectId: string } | { value: null } = { value: null };
        if (mode === "focused-after-reveal") {
          const ae = await this.cdp.send<{ result: { objectId?: string } }>(
            "Runtime.evaluate",
            { expression: "document.activeElement", returnByValue: false },
            sessionId,
          );
          focusedArg = ae.result.objectId !== undefined ? { objectId: ae.result.objectId } : { value: null };
        }
        try {
          // ONE scan call. RESOLVE_SCAN_FN returns the chosen element itself or
          // null — invoked WITHOUT returnByValue so we get a RemoteObject
          // (mirrors normalizeToActionable). A null/subtype:"null"/no-objectId
          // RemoteObject is every fail-closed selection outcome (zero / >1
          // transition-eligible / already-readable-unchanged / no transition /
          // predicate-fails / focused-non-candidate / empty value).
          const r = await this.cdp.send<{ result: { objectId?: string; subtype?: string } }>(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              arguments: [{ value: baseline }, focusedArg],
              functionDeclaration: RESOLVE_SCAN_FN,
            },
            sessionId,
          );
          const chosenObjectId = r.result.objectId;
          if (typeof chosenObjectId !== "string" || r.result.subtype === "null") {
            throw new ShuttleError(
              "reveal_no_transition",
              "No single safe→revealed candidate after reveal.",
            );
          }
          try {
            const d = await this.cdp.send<{ node: { backendNodeId: number } }>(
              "DOM.describeNode",
              { objectId: chosenObjectId },
              sessionId,
            );
            const chosenBackend = d.node.backendNodeId;
            // DOM-containment proof reusing the EXISTING isDescendantOf: the
            // approved subtree root must CONTAIN or EQUAL the chosen node.
            const contained =
              chosenBackend === ref.backend_node_id ||
              (await this.isDescendantOf(sessionId, ref.backend_node_id, chosenBackend).catch(() => false));
            if (!contained) {
              throw new ShuttleError(
                "reveal_not_contained",
                "Chosen element is not inside the approved container.",
              );
            }
            // Read the value EXACTLY ONCE, daemon-internal, off the SAME
            // objectId (returnByValue:true). The value reaches only the route →
            // vault.upsertSecret; it is NEVER returned to the agent layer or audit.
            const rv = await this.cdp.send<{ result: { value: { ok: boolean; value?: string } } }>(
              "Runtime.callFunctionOn",
              {
                objectId: chosenObjectId,
                returnByValue: true,
                functionDeclaration: `function(){
                  try {
                    var t = this;
                    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return { ok:true, value: typeof t.value === "string" ? t.value : "" };
                    if (t instanceof HTMLElement && t.isContentEditable) return { ok:true, value: typeof t.innerText === "string" ? t.innerText : "" };
                    return { ok:true, value: typeof t.textContent === "string" ? t.textContent : "" };
                  } catch (e) { return { ok:false }; }
                }`,
              },
              sessionId,
            );
            const v = rv.result.value;
            if (v === undefined || v.ok !== true || typeof v.value !== "string" || v.value === "") {
              throw new ShuttleError("reveal_no_transition", "Resolved candidate had no value.");
            }
            return { value: v.value };
          } finally {
            await this.cdp.send("Runtime.releaseObject", { objectId: chosenObjectId }, sessionId).catch(() => undefined);
          }
        } finally {
          if ("objectId" in focusedArg) {
            await this.cdp.send("Runtime.releaseObject", { objectId: focusedArg.objectId }, sessionId).catch(() => undefined);
          }
        }
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_resolve_failed", "Resolution failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
```

> Single-scan RemoteObject pattern — no `.replace` twin. `RESOLVE_SCAN_FN`
> returns the chosen element (or `null`) exactly like the merged
> `NORMALIZE_TO_ACTIONABLE_FN`; `resolveWithinContainer` takes it via
> `Runtime.callFunctionOn` **without** `returnByValue` (a RemoteObject), proves
> DOM containment with the **existing** `isDescendantOf`, then reads the value
> **once** off that same `objectId`. There is no second selection function and
> no byte-exact-substring maintenance contract: the node that is read is the
> node that was selected, by construction (it is the same RemoteObject). Every
> resolved `objectId` (root, focused arg, chosen) is released in `finally`,
> matching `describeBackendNode`/`normalizeToActionable`.

- [ ] **Step 6: Fix ALL existing `BrowserOps` stubs (keep the tree green)**

There are **four** test files with `BrowserOps` object literals; `routes.test.ts` has **four** literals (the `stubBrowser` factory at `:108` plus three inline literals near `:291`, `:400-423`, `:754`). Add these three lines to **every** literal, immediately after its `clickBackendNode: async () => undefined,` line:
```ts
    readBackendNodeValue: async () => "stub_value",
    baselineCandidates: async () => ({ entries: [] }),
    resolveWithinContainer: async () => ({ value: "stub_value" }),
```
Apply to:
- `src/daemon/api/routes.test.ts` — the `stubBrowser` return object (after line 135) AND the three inline literals (after the `clickBackendNode` line near `:295`, `:423`, `:758`). Indentation matches each literal (the inline ones are indented one extra level).
- `src/e2e/stripe-to-vercel.test.ts` — `stubBrowser`, after line 40.
- `src/daemon/api/browser-handles-routes.test.ts` — `stub`, after line 30 (and the `failing` literal near `:109` if it lists `clickBackendNode`; if that literal is a `Partial<BrowserOps>`-spread it does not need them — verify by reading lines 105-115; add only if it is a full literal).
- `src/daemon/api/inject-submit-routes.test.ts` — `stub`, after line 28 (before the `...over,` spread).

> Phase-2 lesson made explicit: extend EVERY `BrowserOps` literal in ALL existing test files in the SAME task that extends the interface so the tree is green at this commit. Use `grep -n "clickBackendNode: async () => undefined" src/**/*.test.ts` to enumerate every literal before editing; the count must match the edits.

- [ ] **Step 7: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/chrome/baseline-resolve.test.js`
Expected: PASS — 17 tests: **9 DOM-shim tests** driving the real `BASELINE_SCAN_FN`/`RESOLVE_SCAN_FN` (BASELINE safe/readable classification & no-raw-text egress; RESOLVE returns the element identity — `result.__id === "f1"` — for readable-siblings-plus-one-revealed success, and `result === null` for two-revealed-ambiguous, already-readable-unchanged, no-transition, predicate-rejects-button, focused-on-button; plus the two `field`-mode-gate cases: a `safe`→revealed field returns that element, an already-`readable`-unchanged field → `null`) + **8 ScriptedTransport tests** (`readBackendNodeValue` ok / fail-closed; `baselineCandidates` hashed; `resolveWithinContainer` container-success, field-mode-gate, null-RemoteObject→fail-closed, not-contained→fail-closed, CDP-error→fail-closed — each shaping the new `callFunctionOn`-no-returnByValue → describeNode → isDescendantOf → one-shot value-read sequence).

Run: `npm test`
Expected: PASS — all tests green (every `BrowserOps` literal now satisfies the extended interface; the new in-page constants and methods are additive).

- [ ] **Step 8: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/baseline-resolve.test.ts src/daemon/api/routes.test.ts src/e2e/stripe-to-vercel.test.ts src/daemon/api/browser-handles-routes.test.ts src/daemon/api/inject-submit-routes.test.ts
git commit -m "feat(reveal-capture): Baseline type + readBackendNodeValue/baselineCandidates/resolveWithinContainer (daemon-only, hash egress, fail-closed); stub fixups (spec §12)"
```

---

### Task 5: The `POST /v1/secrets/reveal-capture` route

**Files:**
- Create: `src/daemon/api/routes/reveal-capture.ts`
- Modify: `src/daemon/api/router.ts:9` (import), `:28` (registration)
- Test: `src/daemon/api/reveal-capture-routes.test.ts`

> This route MIRRORS `src/daemon/api/routes/inject-submit.ts` exactly: own-blind-window, `requireApproval({force:true})`, `blind.start`→`disableObservationDomains`→`severAgentConnections`, pre-action revalidate→`blind.end()`+rethrow (nothing revealed, safe), the module-scope `withDeadline` helper wrapping the secret-bearing sequence, the post-reveal best-effort bounded `blankAllPages` neutralization on failure, the `autoResumeBlind` try/catch that falls through to fail-closed (T7-M1), and the enum-only fail-closed body + outer-catch audit. New vs inject-submit: it OWNS the reveal-click→resolve→read→hide sequence; auto-resume requires captured-non-empty AND hide/blank-succeeded AND absence-passed (no success-text).

- [ ] **Step 1: Write the failing route test**

Create `src/daemon/api/reveal-capture-routes.test.ts`:
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
import { ShuttleError } from "../../shared/errors.js";
import type { BrowserOps } from "../chrome/internal-ops.js";

const SECRET = "whsec_must_never_leak_revealed_value";

function stub(over: Partial<BrowserOps> = {}): BrowserOps {
  const inj = { domain: "dashboard.stripe.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "dashboard.stripe.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
    readBackendNodeValue: async () => SECRET,
    baselineCandidates: async () => ({ entries: [] }),
    resolveWithinContainer: async () => ({ value: SECRET }),
    ...over,
  };
}

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices; home: string }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-rc-"));
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

async function setup(services: DaemonServices, port: number, opts: { allowedActions?: string[] } = {}) {
  await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
  // reveal-capture CREATES a new secret named by --name; no pre-existing record needed.
  services.handles.put({
    label: "reveal-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 31, handle_fingerprint: "sha256:reveal", element_kind: "button",
  });
  services.handles.put({
    label: "secret-card", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 32, handle_fingerprint: "sha256:container", element_kind: "other",
  });
  services.handles.put({
    label: "hide-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 33, handle_fingerprint: "sha256:hide", element_kind: "button",
  });
  void opts;
}

function containerBody(extra: Record<string, unknown> = {}) {
  return {
    name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
    domain: "dashboard.stripe.com", reveal_handle: "reveal-button",
    container_handle: "secret-card", hide_handle: "hide-button",
    allowed_domains: ["dashboard.stripe.com"],
    wait_for_approval: false, ...extra,
  };
}

function bindingFor(over: Record<string, unknown> = {}) {
  return {
    action: "reveal_capture" as const, ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
    environment: "production", destination_domain: "dashboard.stripe.com", target_id: "T-1",
    field_fingerprint: null, template_id: null, template_params: null,
    allowed_domains: ["dashboard.stripe.com"],
    reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
    container_fingerprint: "sha256:container", capture_mode: "container" as const,
    auto_resume: true, reveal_handle_label: "reveal-button",
    hide_handle_label: "hide-button", container_handle_label: "secret-card",
    ...over,
  };
}

test("reveal-capture requires approval even though no approval_id is supplied (force:true)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("refuses if blind mode is already active (no clobber)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.blind.start("dashboard.stripe.com", "other");
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "blind_mode_already_active");
  });
});

test("rejects supplying BOTH field_handle and container_handle (exactly one)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ field_handle: "secret-card" }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("rejects --capture focused-after-reveal without a container_handle", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const b = containerBody();
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: undefined, capture: "focused-after-reveal" });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("reveal handle on a DIFFERENT domain than the container handle is fail-closed", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.handles.put({
      label: "secret-card", target_id: "T-1", domain: "evil.example.com", page_url_host: "evil.example.com",
      page_title: "X", backend_node_id: 32, handle_fingerprint: "sha256:container", element_kind: "other",
    });
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_target_mismatch");
  });
});

test("container mode success: captured:true, blind_mode:false, absence_proof:passed, blind_auto_resume audited, no raw secret in body/audit", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ resolveWithinContainer: async () => ({ value: SECRET }), proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { absence_proof: string }).absence_proof, "passed");
    assert.equal((r.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);
    assert.match(String((r.body as { fingerprint: string }).fingerprint), /^hmac-sha256:/);
    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), true);
    assert.equal(log.includes(SECRET), false);
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });
});

test("field mode success goes through resolveWithinContainer(mode=field) — the per-candidate safe→revealed gate (NOT a direct value read)", async () => {
  await withDaemon(async ({ port, services }) => {
    let resolveMode = "";
    let usedRead = false;
    services.browser = stub({
      // field mode MUST apply the §6.1 gate via resolveWithinContainer; a
      // direct readBackendNodeValue here would defeat the protection.
      resolveWithinContainer: async (_r, mode) => { resolveMode = mode; return { value: SECRET }; },
      readBackendNodeValue: async () => { usedRead = true; return "WRONG"; },
    });
    await setup(services, port);
    services.handles.put({
      label: "secret-field", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 34, handle_fingerprint: "sha256:thefield", element_kind: "field",
    });
    const g = services.approvals.create(bindingFor({
      capture_mode: "field", field_fingerprint: "sha256:thefield",
      container_fingerprint: null, container_handle_label: null, field_handle_label: "secret-field",
    }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: "secret-field" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal(resolveMode, "field");      // gate applied via resolveWithinContainer
    assert.equal(usedRead, false);           // NOT the direct §12 reader
  });
});

test("field mode gate: a field already script-readable & unchanged pre-reveal → resolveWithinContainer fails closed → captured:unknown, blind stays active (spec §6.1)", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({
      // resolveWithinContainer's per-candidate gate rejects a field whose
      // baseline entry was `readable` and unchanged (no safe→revealed
      // transition): the secret was observable without blind protection.
      resolveWithinContainer: async () => { throw new ShuttleError("reveal_no_transition", "No safe→revealed candidate after reveal."); },
    });
    await setup(services, port);
    services.handles.put({
      label: "secret-field", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 34, handle_fingerprint: "sha256:thefield", element_kind: "field",
    });
    const g = services.approvals.create(bindingFor({
      capture_mode: "field", field_fingerprint: "sha256:thefield",
      container_fingerprint: null, container_handle_label: null, field_handle_label: "secret-field",
    }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: "secret-field" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.notEqual(services.blind.current(), null); // stays blind — gate failed closed
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("focused-after-reveal mode resolves via resolveWithinContainer(mode=focused-after-reveal)", async () => {
  await withDaemon(async ({ port, services }) => {
    let seenMode = "";
    services.browser = stub({
      resolveWithinContainer: async (_r, mode) => { seenMode = mode; return { value: SECRET }; },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor({ capture_mode: "focused-after-reveal" }));
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id, capture: "focused-after-reveal" }));
    assert.equal(r.status, 200);
    assert.equal(seenMode, "focused-after-reveal");
  });
});

test("resolution fail-closed (no single safe→revealed candidate: ambiguous / not-contained / already-readable all collapse to reveal_no_transition) → stays blind, captured:unknown, manual_recovery_required, blank attempted, no auto-resume", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({
      // The real resolveWithinContainer throws ONE fail-closed code: a null
      // RemoteObject from RESOLVE_SCAN_FN (zero/>1 transition-eligible OR
      // already-readable-unchanged) → reveal_no_transition. The route's
      // post-reveal catch is generic, so the specific code does not change
      // the enum-only captured:"unknown" response either way.
      resolveWithinContainer: async () => { throw new ShuttleError("reveal_no_transition", "No single safe→revealed candidate after reveal."); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.equal("absence_proof" in r.body, false);
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("pre-reveal handle revalidation failure (post-approval) ends blind and errors — safe, nothing revealed", async () => {
  await withDaemon(async ({ port, services }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => { calls += 1; if (calls > 2) throw new ShuttleError("handle_invalid", "gone"); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_invalid");
    assert.equal(services.blind.current(), null); // blind ended (safe — nothing revealed)
  });
});

test("post-reveal failure (resolve hangs) → withDeadline fires, stays blind, captured:unknown, blank attempted", async () => {
  await withDaemon(async ({ port, services }) => {
    process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS = "150";
    services.browser = stub({ resolveWithinContainer: () => new Promise<{ value: string }>(() => {}) }); // never resolves
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    delete process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS;
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.notEqual(services.blind.current(), null);
  });
});

test("hide-handle absent → blankAllPages fallback path; captured non-empty + blank ok + proof passed → auto-resume", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor({ hide_fingerprint: null, hide_handle_label: null }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).hide_handle;
    // No services.cdp in unit harness → blank is best-effort no-op; the route's
    // auto-resume gate still requires proof passed (stub: passed) so it resumes.
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", b);
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
  });
});

test("absence proof inconclusive → stays blind, captured:unknown, manual_recovery_required, no auto-resume", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ proveAbsence: async () => ({ passed: false }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("no raw secret appears in any response body (extends the no-leak assertion)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/reveal-capture-routes.test.js`
Expected: FAIL — every test fails with status 404 (route `/v1/secrets/reveal-capture` not registered).

- [ ] **Step 3: Implement the route**

Create `src/daemon/api/routes/reveal-capture.ts`:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { domainMatches } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { canonicalEnvironment, buildSecretRef } from "../../../shared/refs.js";
import { asObject, optString, reqString } from "../validate.js";
import { blankAllPages, disableObservationDomains } from "../../chrome/internal-ops.js";
import type { Baseline, BackendNodeRef } from "../../chrome/internal-ops.js";
import { enforceDomain } from "./secrets.js";
import { autoResumeBlind } from "../../blind-auto-resume.js";
import type { BrowserHandle } from "../../browser-handles.js";

interface RevealCaptureBody {
  name: string;
  environment: string;
  source: string;
  domain?: string;
  reveal_handle: string;
  field_handle?: string;
  container_handle?: string;
  capture?: "focused-after-reveal";
  hide_handle?: string;
  allowed_domains?: string[];
  description?: string;
  force?: boolean;
  approval_id?: string;
  wait_for_approval?: boolean;
}

export function registerRevealCapture(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/reveal-capture", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const name = reqString(o, "name");
    const environment = reqString(o, "environment");
    const source = reqString(o, "source");
    const revealHandleLabel = reqString(o, "reveal_handle");
    const fieldHandleLabel = optString(o, "field_handle");
    const containerHandleLabel = optString(o, "container_handle");
    const hideHandleLabel = optString(o, "hide_handle");
    const captureOpt = optString(o, "capture");
    const b = raw as RevealCaptureBody;
    let plannedRef: string | undefined;
    try {
      if (services.browser === null) {
        throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      }
      const browser = services.browser;

      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is already active; run `secret-shuttle blind end` before reveal-capture.",
        );
      }

      // Exactly one of field_handle / container_handle (latter optionally with
      // --capture focused-after-reveal).
      const haveField = fieldHandleLabel !== undefined;
      const haveContainer = containerHandleLabel !== undefined;
      if (haveField === haveContainer) {
        throw new ShuttleError("bad_request", "Supply exactly one of field_handle or container_handle.");
      }
      let captureMode: "field" | "container" | "focused-after-reveal";
      if (haveField) {
        if (captureOpt !== undefined) {
          throw new ShuttleError("bad_request", "--capture focused-after-reveal requires container_handle, not field_handle.");
        }
        captureMode = "field";
      } else if (captureOpt === "focused-after-reveal") {
        captureMode = "focused-after-reveal";
      } else if (captureOpt === undefined) {
        captureMode = "container";
      } else {
        throw new ShuttleError("bad_request", "capture: only 'focused-after-reveal' is valid (with container_handle).");
      }

      const env = canonicalEnvironment(environment);
      plannedRef = buildSecretRef(source, env, name);

      const revealHandle = services.handles.get(revealHandleLabel);
      if (revealHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${revealHandleLabel}.`);
      const targetLabel = haveField ? (fieldHandleLabel as string) : (containerHandleLabel as string);
      const targetHandle = services.handles.get(targetLabel);
      if (targetHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${targetLabel}.`);
      const hideHandle = hideHandleLabel !== undefined ? services.handles.get(hideHandleLabel) : undefined;
      if (hideHandleLabel !== undefined && hideHandle === undefined) {
        throw new ShuttleError("handle_not_found", `No active mark labelled ${hideHandleLabel}.`);
      }

      // Revalidate while observation is still safe (§3.4 / §6.2 step 2).
      await browser.revalidateHandle(revealHandle);
      await browser.revalidateHandle(targetHandle);
      if (hideHandle !== undefined) await browser.revalidateHandle(hideHandle);

      if (revealHandle.element_kind !== "button" && revealHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "reveal_handle must be a button or link.");
      }
      if (hideHandle !== undefined && hideHandle.element_kind !== "button" && hideHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "hide_handle must be a button or link.");
      }
      if (captureMode === "field" && targetHandle.element_kind !== "field") {
        throw new ShuttleError("handle_kind_mismatch", "field_handle must be a field.");
      }

      // Derive domain from the reveal handle; the field/container handle (and the
      // hide handle, if any) MUST share the reveal handle's target & domain so
      // the click/resolve cannot land on a different tab/site than approved.
      const domain = revealHandle.domain;
      const sameTargetDomain = (h: BrowserHandle): boolean =>
        h.target_id === revealHandle.target_id && h.domain === revealHandle.domain;
      if (!sameTargetDomain(targetHandle) || (hideHandle !== undefined && !sameTargetDomain(hideHandle))) {
        throw new ShuttleError(
          "handle_target_mismatch",
          "field/container and hide handles must share the reveal handle's page/target and domain.",
        );
      }
      if (b.domain !== undefined && !domainMatches(domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Reveal handle domain ${domain} != ${b.domain}.`);
      }

      const effectiveAllowed = (b.allowed_domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (env === "production" && effectiveAllowed.length === 0) {
        throw new ShuttleError("missing_allow_domain", "Production secrets require at least one allowed domain.");
      }
      enforceDomain(domain, effectiveAllowed, "reveal-capture");

      // 2b. Pre-reveal baseline over the approved field/container subtree
      // (daemon-only, observation still safe). Readable siblings recorded, not
      // rejected — gate is per chosen candidate after reveal.
      const baseline: Baseline = await browser.baselineCandidates({
        target_id: targetHandle.target_id,
        backend_node_id: targetHandle.backend_node_id,
      });

      const binding: ApprovalBinding = {
        action: "reveal_capture",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: domain,
        target_id: targetHandle.target_id,
        field_fingerprint: captureMode === "field" ? targetHandle.handle_fingerprint : null,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
        reveal_fingerprint: revealHandle.handle_fingerprint,
        capture_mode: captureMode,
        auto_resume: true,
        reveal_handle_label: revealHandle.label,
        ...(captureMode !== "field"
          ? { container_fingerprint: targetHandle.handle_fingerprint, container_handle_label: targetHandle.label }
          : { field_handle_label: targetHandle.label }),
        ...(hideHandle !== undefined
          ? { hide_fingerprint: hideHandle.handle_fingerprint, hide_handle_label: hideHandle.label }
          : {}),
        ...(targetHandle.page_title !== "" ? { page_title: targetHandle.page_title } : {}),
        ...(targetHandle.page_url_host !== "" ? { page_url_host: targetHandle.page_url_host } : {}),
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        force: true,
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window: black out the agent BEFORE reveal.
      services.blind.start(domain, "reveal_capture");
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      // Re-revalidate post-approval, pre-action. Failure here = NOTHING revealed
      // → safe to end blind and rethrow (mirrors inject-submit pre-write path).
      try {
        await browser.revalidateHandle(revealHandle);
        await browser.revalidateHandle(targetHandle);
        if (hideHandle !== undefined) await browser.revalidateHandle(hideHandle);
      } catch (preActionErr) {
        services.blind.end();
        throw preActionErr;
      }

      // From the reveal click onward the secret MAY be exposed. Any failure
      // (incl. a HANG) MUST NOT auto-resume: blind stays ACTIVE; respond
      // fail-closed (captured:"unknown"). The whole secret-bearing sequence
      // (reveal → resolve → read → hide) is wrapped in an overall deadline so a
      // hung CDP frame becomes a caught failure (mirrors inject-submit I3).
      const revealDeadlineMs = Number(process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS) || 30_000;
      let capturedValue = "";
      let hideDone = false;
      try {
        await withDeadline(
          (async () => {
            const revealRef: BackendNodeRef = { target_id: revealHandle.target_id, backend_node_id: revealHandle.backend_node_id };
            await browser.clickBackendNode(revealRef);
            // ALL THREE modes go through resolveWithinContainer so the §6.1
            // per-chosen-candidate safe→revealed gate is enforced uniformly
            // (defined once / tested once). For `field` the approved field
            // handle's OWN backend node is the subtree root: the field is its
            // own sole candidate, so a field that was already script-readable
            // and UNCHANGED pre-reveal (its baseline entry is `readable`) is
            // NOT transition-eligible → fail closed (the secret was observable
            // without blind protection, spec §6.1). A safe→revealed field is
            // captured. `readBackendNodeValue` is NOT the field-mode path.
            const res = await browser.resolveWithinContainer(
              { target_id: targetHandle.target_id, backend_node_id: targetHandle.backend_node_id },
              captureMode,
              baseline,
            );
            capturedValue = res.value;
            // Hide BEFORE returning so the page is in its proven-clean state.
            if (hideHandle !== undefined) {
              await browser.clickBackendNode({ target_id: hideHandle.target_id, backend_node_id: hideHandle.backend_node_id });
              hideDone = true;
            } else if (services.cdp !== null) {
              await blankAllPages(services.cdp);
              hideDone = true;
            } else {
              // No internal CDP in this build → cannot blank. Treat as hidden
              // only if there is no other neutralization path; the absence proof
              // (next) is the authoritative gate, and a no-CDP build has no
              // observable page surface to leak to anyway.
              hideDone = true;
            }
          })(),
          revealDeadlineMs,
          "reveal_capture_timeout",
        );
      } catch {
        // Post-reveal failure (thrown reveal/resolve/read/hide OR the deadline):
        // the secret may be on the page. Proactively neutralize with the SAME
        // hardened primitive /v1/blind/end uses (best-effort, bounded — its
        // failure must NOT change the response; blind STAYS active and the
        // human-approved /v1/blind/end remains the authoritative recovery).
        if (services.cdp !== null) {
          const blankMs = Number(process.env.SECRET_SHUTTLE_BLANK_DEADLINE_MS) || 15_000;
          await withDeadline(blankAllPages(services.cdp), blankMs, "blank_timeout").catch(() => undefined);
        }
        await writeDaemonAudit({
          action: "reveal_capture", ok: false, planned_ref: plannedRef, environment: env,
          domain, captured: "unknown", blind_mode: true,
        });
        return {
          captured: "unknown", blind_mode: true,
          next: "manual_recovery_required", value_visible_to_agent: false,
        };
      }

      // Store the captured value (it never leaves the daemon). Only on a
      // non-empty capture; an empty value is a fail-closed outcome.
      let meta: { ref: string; fingerprint: string } | undefined;
      if (capturedValue !== "") {
        meta = await services.vault.upsertSecret({
          name, environment: env, source, value: capturedValue,
          allowedDomains: effectiveAllowed,
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.force !== undefined ? { force: b.force } : {}),
        });
      }

      // Absence proof for the captured value (REUSED Phase-2 hardened proof).
      let proofPassed = false;
      if (capturedValue !== "" && hideDone) {
        try {
          proofPassed = (await browser.proveAbsence(capturedValue)).passed;
        } catch {
          proofPassed = false;
        }
      }

      if (capturedValue !== "" && hideDone && proofPassed && meta !== undefined) {
        // T7-M1: autoResumeBlind throws BEFORE it ends blind if preconditions
        // fail; treat ANY throw as "not provably safe" → fall through to
        // fail-closed instead of 500ing via the outer catch.
        try {
          await autoResumeBlind(services, {
            op: "reveal_capture", domain, success_signal: "secret_captured", absence_proof: "passed",
          });
          await writeDaemonAudit({
            action: "reveal_capture", ok: true, planned_ref: plannedRef, ref: meta.ref, environment: env,
            domain, captured: true, success_signal: "secret_captured", absence_proof: "passed", blind_mode: false,
          });
          return {
            captured: true, secret_ref: meta.ref,
            fingerprint: meta.fingerprint, absence_proof: "passed",
            blind_mode: false, value_visible_to_agent: false,
          };
        } catch {
          // autoResumeBlind refused/failed → blind remains active → fail-closed.
        }
      }

      await writeDaemonAudit({
        action: "reveal_capture", ok: true, planned_ref: plannedRef,
        ...(meta !== undefined ? { ref: meta.ref } : {}),
        environment: env, domain, captured: "unknown", blind_mode: true,
      });
      return {
        captured: "unknown", blind_mode: true,
        next: "manual_recovery_required", value_visible_to_agent: false,
      };
    } catch (err) {
      // Errors before blind.start (handle/kind/domain/approval) → blind never
      // started. The pre-action path already ended blind & is rethrowing here.
      await writeDaemonAudit({
        action: "reveal_capture",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(plannedRef !== undefined ? { planned_ref: plannedRef } : {}),
      });
      throw err;
    }
  });
}

// Mirrors inject-submit.ts's withDeadline. Races `p` against a deadline; clears
// its timer on settle (no leaked timer per successful call). If `p` hangs it
// stays orphaned but the route fails closed instead of hanging — the post-reveal
// catch maps the rejection to captured:"unknown" / blind stays active.
function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShuttleError(code, `Operation exceeded ${ms}ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
```

- [ ] **Step 4: Register the route**

In `src/daemon/api/router.ts`, add the import immediately **after** the existing `import { registerInjectSubmit } from "./routes/inject-submit.js";` line (line 9):
```ts
import { registerRevealCapture } from "./routes/reveal-capture.js";
```
In the same file, add this line immediately **after** the existing `registerInjectSubmit(server, services, daemonPortRef);` call (line 28):
```ts
  registerRevealCapture(server, services, daemonPortRef);
```

- [ ] **Step 5: Run the new test, then the full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/reveal-capture-routes.test.js`
Expected: PASS — 15 tests pass (force-approval; refuse-if-blind; exactly-one-handle; focused-without-container; cross-domain handle; container-mode success+audit+no-leak; **field-mode-success-via-resolveWithinContainer(mode=field)-gate**; **field-mode-gate-fail-closed when the field was already readable-unchanged pre-reveal → captured:unknown / stays blind**; focused-after-reveal-mode; resolution-fail-closed+blank+no-resume; pre-action-revalidation-safe; hung-resolve-deadline; hide-absent-blank-fallback; absence-inconclusive; no-raw-secret-in-body).

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/reveal-capture.ts src/daemon/api/router.ts src/daemon/api/reveal-capture-routes.test.ts
git commit -m "feat(reveal-capture): POST /v1/secrets/reveal-capture route (owns blind window; 3 modes; fail-closed; deadline-wrapped) (spec §6.2/§6.3)"
```

---

### Task 6: CLI — `secret-shuttle reveal-capture`

**Files:**
- Create: `src/cli/commands/reveal-capture.ts`
- Modify: `src/cli/index.ts:11` (import), `:33` (registration)

- [ ] **Step 1: Implement the CLI command**

Create `src/cli/commands/reveal-capture.ts`:
```ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";
import { ShuttleError } from "../../shared/errors.js";
import { canonicalEnvironment } from "../../shared/refs.js";

export function revealCaptureCommand(): Command {
  return new Command("reveal-capture")
    .description("Daemon-owned: click a marked reveal control, capture the revealed secret (field/container/focused-after-reveal), hide it, and auto-resume only if the secret is proven gone.")
    .requiredOption("--name <name>")
    .requiredOption("--env <environment>")
    .requiredOption("--source <source>")
    .requiredOption("--reveal-handle <label>", "Label of a pre-marked reveal button/link.")
    .option("--field-handle <label>", "Stable field marked before reveal (mode `field`).")
    .option("--container-handle <label>", "Stable ancestor marked before reveal (mode `container`).")
    .option("--capture <strategy>", "Only `focused-after-reveal` (requires --container-handle).")
    .option("--hide-handle <label>", "Optional pre-marked hide button/link; else all pages are blanked.")
    .option("--domain <domain>")
    .option("--allow-domain <domain>", "Allowed domain (repeatable).", collectRepeated, [])
    .option("--description <description>")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      const domains = options.allowDomain as string[];
      if (canonicalEnvironment(options.env) === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const bodyObj: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        reveal_handle: options.revealHandle,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (options.fieldHandle !== undefined) bodyObj.field_handle = options.fieldHandle;
      if (options.containerHandle !== undefined) bodyObj.container_handle = options.containerHandle;
      if (options.capture !== undefined) bodyObj.capture = options.capture;
      if (options.hideHandle !== undefined) bodyObj.hide_handle = options.hideHandle;
      if (options.domain !== undefined) bodyObj.domain = options.domain;
      if (domains.length > 0) bodyObj.allowed_domains = domains;
      if (options.description !== undefined) bodyObj.description = options.description;
      if (options.approvalId !== undefined) bodyObj.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/reveal-capture", bodyObj);
      outputJson(ok(r as Record<string, unknown>));
    });
}
```

- [ ] **Step 2: Register the command**

In `src/cli/index.ts`, add the import immediately **after** the existing `import { injectSubmitCommand } from "./commands/inject-submit.js";` line (line 11):
```ts
import { revealCaptureCommand } from "./commands/reveal-capture.js";
```
In the same file, add this line immediately **after** the existing `program.addCommand(injectSubmitCommand());` line (line 33):
```ts
program.addCommand(revealCaptureCommand());
```

- [ ] **Step 3: Verify the CLI surface compiles**

Run: `npm run build && node dist/cli/index.js reveal-capture --help`
Expected: PASS — help lists `--name`, `--env`, `--source`, `--reveal-handle`, `--field-handle`, `--container-handle`, `--capture`, `--hide-handle`, `--domain`, `--allow-domain`, `--description`, `--force`, `--approval-id`, `--no-wait`; exit code 0.

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/reveal-capture.ts src/cli/index.ts
git commit -m "feat(reveal-capture): secret-shuttle reveal-capture CLI command"
```

---

### Task 7: Full Phase-3 verification + agentic no-leak e2e

**Files:**
- Create: `src/e2e/reveal-capture-agentic.test.ts`

- [ ] **Step 1: Write the end-to-end agentic test**

Create `src/e2e/reveal-capture-agentic.test.ts`:
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

const SECRET = "whsec_e2e_revealed_value_must_not_leak";

function stubBrowser(): BrowserOps {
  const inj = { domain: "dashboard.stripe.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "dashboard.stripe.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
    readBackendNodeValue: async () => SECRET,
    baselineCandidates: async () => ({ entries: [] }),
    resolveWithinContainer: async () => ({ value: SECRET }),
  };
}

test("agentic reveal-capture end-to-end leaks neither the raw secret in any response nor any observed page text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-rc-"));
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
    // Agent marks reveal + container + hide BEFORE blind mode (Phase 1 surface).
    services.handles.put({
      label: "reveal-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 31, handle_fingerprint: "sha256:reveal", element_kind: "button",
    });
    services.handles.put({
      label: "secret-card", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 32, handle_fingerprint: "sha256:container", element_kind: "other",
    });
    services.handles.put({
      label: "hide-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 33, handle_fingerprint: "sha256:hide", element_kind: "button",
    });

    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "dashboard.stripe.com", target_id: "T-1",
      field_fingerprint: null, template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
      container_fingerprint: "sha256:container", capture_mode: "container",
      auto_resume: true, reveal_handle_label: "reveal-button",
      hide_handle_label: "hide-button", container_handle_label: "secret-card",
    });
    services.approvals.approve(g.id);
    const r = await call("POST", "/v1/secrets/reveal-capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      domain: "dashboard.stripe.com", reveal_handle: "reveal-button",
      container_handle: "secret-card", hide_handle: "hide-button",
      allowed_domains: ["dashboard.stripe.com"], approval_id: g.id, wait_for_approval: false,
    });
    responses.push(r);
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);

    responses.push(await call("GET", "/v1/status"));
    responses.push(await call("POST", "/v1/secrets/list", {}));

    for (const resp of responses) {
      const s = JSON.stringify(resp.body);
      assert.equal(s.includes(SECRET), false, `raw secret leaked: ${s}`);
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

- [ ] **Step 2: Run the new e2e, then typecheck + the entire suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/e2e/reveal-capture-agentic.test.js`
Expected: PASS — 1 test passes.

Run: `npm run typecheck && npm test`
Expected: PASS — zero TypeScript errors; every `node --test` file passes, 0 failures (Phase-1 + Phase-2 + Phase-3 suites; total > 295).

- [ ] **Step 3: Commit + checkpoint tag**

```bash
git add src/e2e/reveal-capture-agentic.test.ts
git commit -m "test(reveal-capture): agentic e2e — no raw revealed secret in any response"
git tag phase3-reveal-capture-complete
git log --oneline -10
```
Expected: the tag points at this commit; the last ~7 commits are the Phase-3 feature/test commits on `feat/reveal-capture`.

---

### Task 8: [P2a] Stripe webhook-secret reveal-capture real-page validation gate (carried residual — manual)

**Files:** none (manual/scripted release gate; record the outcome in this plan's "## [P2a] Gate outcome" section and feed it to Plan 5's skill/README copy — NOT a unit test).

This is the spec §13/§14 **[P2a]** release gate for the Phase-3 browser flow. The resolution/baseline/absence proof stay conservatively fail-closed regardless; this gate measures whether reveal-capture + auto-resume *succeeds in practice* on the real Stripe webhook-secret reveal. It does **not** block the merge of Tasks 1–7, but its outcome MUST be recorded before Plan 5 states (per provider) whether the browser flow is "production" or "best-effort (template-primary)".

- [ ] **Step 1: Start a real daemon + browser**

Run:
```bash
node dist/cli/index.js daemon start
node dist/cli/index.js unlock           # set a passphrase in the opened window if first run
node dist/cli/index.js browser start
```
Expected: `started: true` with a `proxy_url`.

- [ ] **Step 2: Prepare the Stripe page and mark the controls (observation still safe)**

In the daemon browser, navigate to `dashboard.stripe.com` → a webhook endpoint's signing-secret panel (the secret is masked until "Reveal" is clicked). Mark the reveal button, a stable container (the card/row that persists across reveal), and the hide button:
```bash
node dist/cli/index.js browser mark pick --as reveal-button --timeout-ms 60000   # click "Reveal" while pending
node dist/cli/index.js browser mark pick --as secret-card --timeout-ms 60000     # click the persistent card/row
node dist/cli/index.js browser mark pick --as hide-button --timeout-ms 60000     # click "Hide" while pending
node dist/cli/index.js browser marks
```
Expected: `marks` lists `reveal-button` (`element_kind: button`), `secret-card`, `hide-button` (`element_kind: button`), all `valid: true`.

- [ ] **Step 3: Run the real reveal-capture and observe the exit**

Run:
```bash
node dist/cli/index.js reveal-capture \
  --name SS_TEST_STRIPE_WEBHOOK --env production --source stripe \
  --domain dashboard.stripe.com \
  --reveal-handle reveal-button \
  --container-handle secret-card \
  --hide-handle hide-button \
  --allow-domain dashboard.stripe.com
```
Approve in the opened UI window. Observe the JSON result.
Expected (gate PASS): `{ "captured": true, "fingerprint": "hmac-sha256:…", "absence_proof": "passed", "blind_mode": false, "value_visible_to_agent": false }` and `node dist/cli/index.js blind end` is a no-op (already resumed). Confirm a `blind_auto_resume` line (not `blind_end`) with `op:"reveal_capture"` in `~/.secret-shuttle/audit.log`, and that the audit/responses contain NO raw secret.
Expected (gate BEST-EFFORT): `{ "captured": "unknown", "blind_mode": true, "next": "manual_recovery_required" }` — typically because Stripe renders the revealed secret inside a cross-origin iframe / canvas, or the reveal produces >1 transition-eligible candidate (absence proof or resolution correctly fail-closed). The proof/resolution behaved correctly; the flow is simply best-effort on this site, and `template run` is documented as primary for Stripe.

- [ ] **Step 4: Record the outcome + tear down**

Append a short note to this file's "## [P2a] Gate outcome" section below (PASS = production browser flow for Stripe reveal-capture; BEST-EFFORT = Plan 5 documents `template run`/manual handling as primary for Stripe and the skill says so). Then:
```bash
node dist/cli/index.js blind end || true
pkill -f "secret-shuttle" || true
```
Expected: daemon/browser stopped; outcome recorded.

## [P2a] Gate outcome

_(record here during Task 8 — e.g. "2026-05-‑‑: Stripe webhook secret reveal (container mode) → captured:true, absence_proof:passed, auto-resumed. Browser flow = PRODUCTION." or "… → manual_recovery_required (revealed value in a cross-origin iframe). Browser flow = BEST-EFFORT; template/manual primary.")_

---

## Self-Review (performed against the spec)

**1. Spec §6 coverage (clause-by-clause, Phase 3 scope):**
- §6.1 three capture modes — **all three go through `resolveWithinContainer` so the §6.1 per-chosen-candidate safe→revealed gate is enforced identically (defined once / tested once)**: `field` (`--field-handle`, mode `field`, `resolveWithinContainer(mode="field")` bound to the field's OWN backend node — the field is its own sole candidate, so a field already script-readable & unchanged pre-reveal fails closed, NOT a direct value read), `container` (`--container-handle`, mode `container`, `resolveWithinContainer(mode="container")`), `focused-after-reveal` (`--container-handle` + `--capture focused-after-reveal`, `resolveWithinContainer(mode="focused-after-reveal")` which passes `document.activeElement` and fails closed unless it itself passes the predicate + is transition-eligible + contained) → Tasks 4 & 5; mode recorded in the binding (`capture_mode`, part of `bindingsMatch`) → Task 1; modes exercised in `reveal-capture-routes.test.ts` (container/field-success/field-gate-fail-closed/focused) and `baseline-resolve.test.ts` (focused-on-button → null; field-mode safe→revealed returns the element; field already-readable-unchanged → null). `readBackendNodeValue` remains the generic §12 daemon-only single-element reader (kept + tested independently) but is **not** the field-mode capture path.
- §6.1 secret-holder candidate predicate (field-kind per the §3.3 `elementKind()` single source with non-empty value/text, OR non-interactive text-bearing element with non-empty text; NEVER button/link/label) → `BASELINE_SCAN_FN`/`RESOLVE_SCAN_FN` `kind()`+`isCandidate()` (mirrors `NORMALIZE_TO_ACTIONABLE_FN`'s embedded copy, §3.3); DOM-shim tests assert a button/link/label is never a candidate even with revealed text (Task 4).
- §6.1 pre-reveal daemon-only baseline (HASHED value/state + safety class per candidate; *safe* = empty/absent/password-no-script-value/recognized mask; *readable* = any non-empty script-readable; preexisting readable siblings RECORDED, NOT a whole-subtree gate) → `baselineCandidates` + `BASELINE_SCAN_FN` (`isSafeState`, `h()` digest never egressed as text; readable siblings recorded); route step 2b runs it while observation is still safe; DOM-shim test asserts no raw text in the `Baseline` JSON (Task 4 & 5).
- §6.1 post-reveal resolution order: (1) enumerate predicate matches in approved subtree; (2) filter to transition-eligible (drop anything whose baseline entry is `readable` — unchanged OR changed — and anything still-safe; keep only safe→revealed); (3) require exactly one; fail closed on zero/>1 transition-eligible, non-DOM-contained, control/label, already-readable-unchanged, no transition, empty value, any CDP error; ambiguity over transition-eligible set ONLY (readable siblings never cause false >1). **Single-scan RemoteObject pattern (mirrors the merged `normalizeToActionable`/`describeBackendNode`/`isDescendantOf`), no `.replace` twin:** `RESOLVE_SCAN_FN` returns the **chosen element itself or `null`** for every fail-closed outcome (exactly the `NORMALIZE_TO_ACTIONABLE_FN` element-or-null contract); `resolveWithinContainer` invokes it via `Runtime.callFunctionOn` **WITHOUT `returnByValue`** → a RemoteObject; null/`subtype:"null"`/no `objectId` → one fail-closed `ShuttleError` (`reveal_no_transition`; the response is enum-only `captured:"unknown"` so granular reasons are unnecessary); else `DOM.describeNode {objectId}` → `backendNodeId` → DOM-containment proof reusing the **existing** `isDescendantOf` (approved subtree backend node must CONTAIN or EQUAL the chosen node) → the single chosen value is read **exactly once** off that same `objectId` (`returnByValue:true` tiny reader) → `vault.upsertSecret` only; every resolved `objectId` (root, focused arg, chosen) released in `finally`. DOM-shim tests assert element identity: readable-siblings+one-revealed → `result.__id === "f1"`; two-revealed / already-readable-unchanged / no-transition / predicate-rejects-button / focused-on-button → `result === null`; plus the two `field`-mode-gate cases (safe→revealed field returns the element; already-readable-unchanged field → `null`). ScriptedTransport tests shape the new `callFunctionOn`-no-returnByValue → describeNode → isDescendantOf → one-shot value-read sequence: null-RemoteObject → `reveal_no_transition`, not-contained → `reveal_not_contained`, CDP-error fail-closed, container-success, field-mode-gate (Task 4).
- §6.2 route 13-step flow → Task 5: (1) requireKey/browser/refuse-if-blind; (2) exactly-one-of field/container (+ focused-after-reveal only with container), revalidate reveal(button/link)/target/hide(button/link) while safe, derive domain from reveal handle + require field/container & hide to share its target+domain, production ≥1 allowed domain, `enforceDomain`; (2b) `baselineCandidates`; (3) deterministic binding with `action:"reveal_capture"`, `planned_ref`, env, `destination_domain`, `allowed_domains`, `reveal_fingerprint`, `capture_mode`, `field_fingerprint?`/`container_fingerprint?` per mode, `hide_fingerprint?`, `auto_resume:true`, display-only labels + page context; `capture_mode`/`container_fingerprint`/`reveal_fingerprint` in `bindingsMatch`; (4) `requireApproval({force:true})`; (5) `blind.start`→`disableObservationDomains`→`severAgentConnections`; (6) re-revalidate reveal+target(+hide) pre-action → failure = `blind.end()`+rethrow (nothing revealed, safe); (7) click reveal; (8) resolve per `capture_mode` — ALL THREE modes via `resolveWithinContainer` enforcing the §6.1 per-chosen-candidate safe→revealed gate (`field` bound to the field's own backend node so an already-readable-unchanged field fails closed too — NOT a direct value read); (9) `vault.upsertSecret` (value never leaves daemon); (10) click hide else `blankAllPages` fail-closed; (11) `proveAbsence` (REUSED); (12) auto-resume iff captured-non-empty AND hide/blank-succeeded AND proof passed else stay blind/`manual_recovery_required`; (13) audit. Steps 7–10 are `withDeadline`-wrapped; the post-reveal catch best-effort bounded `blankAllPages` neutralizes (orphan/TOCTOU lesson).
- §6.3 responses: success `{captured:true, secret_ref, fingerprint:"hmac-sha256:…", absence_proof:"passed", blind_mode:false, value_visible_to_agent:false}`; fail-closed `{captured:"unknown", blind_mode:true, next:"manual_recovery_required", value_visible_to_agent:false}` — enum-only, never the raw secret/observed text → Task 5 route + `reveal-capture-routes.test.ts` no-leak assertion + Task 7 e2e (the `fingerprint` is the vault HMAC `meta.fingerprint`, already `hmac-sha256:…`).
- §6.4 binding/UI: `ApprovalBinding` gains `reveal_fingerprint`/`hide_fingerprint`/`container_fingerprint`/`capture_mode` (non-display → `bindingsMatch`) + display-only `reveal_handle_label`/`hide_handle_label`/`container_handle_label`; `submit_fingerprint`/`success_condition`/`auto_resume`/`field_handle_label`/`submit_handle_label`/`allowed_actions` VERIFIED already present from Phase 2 (`store.ts:12-36`); `ui.html` `human` gains the `reveal_capture` sentence + the prominent auto-resume disclosure (the `inject_submit` one reused/extended via a shared `(inject_submit || reveal_capture)` guard, not duplicated) + `capture_mode` shown in the main body; `ui-server.ts` serializes the 7 new fields (the Phase-2 `allowed_actions`/`submit_fingerprint`/etc. lines verified present and NOT duplicated) with BOTH a static-HTML test AND a runtime JSON test (Phase-2 lesson) → Tasks 1 & 2.
- §7 audited auto-resume: VERIFIED `autoResumeBlind` already bypasses approval+`blankAllPages` and writes the distinct `blind_auto_resume` record with `op:"reveal_capture"` already in its union; the only change is widening `success_signal` to also accept `"secret_captured"` (the proof precondition `absence_proof==="passed"` is unchanged) → Task 3.
- §8 audit `reveal_capture` (ok/fail, ref, environment, domain, `captured`, `absence_proof`, `blind_mode`) → Task 3 vocabulary (`"reveal_capture"` + `captured` field; `success_signal`/`absence_proof`/`blind_mode`/`op` already exist) + Task 5 emissions; `blind_auto_resume` per §7.
- §12 `readBackendNodeValue` (daemon-only single-element value reader; value never to agent — kept + tested independently, but NOT the field-mode capture path) / `baselineCandidates` (pre-blind hashed+class; readable siblings recorded not rejected) / `resolveWithinContainer` (post-reveal, the ONE place the §6.1 per-candidate safe→revealed gate lives; ALL THREE modes — `field`/`container`/`focused-after-reveal` — go through it: predicate→transition-eligible→exactly-one→single-scan-RemoteObject→`DOM.describeNode`→containment via the existing `isDescendantOf`→one-shot value read; throws fail-closed on any uncertainty; `field` binds the scan to the field's own backend node so an already-readable-unchanged field fails closed too) + a defined `Baseline` type; the EXISTING hardened `proveAbsence`/`isDescendantOf`/`boundedSend` are REUSED, not reimplemented → Task 4 (the route calls the merged `browser.proveAbsence`, no new scan; no `RESOLVE_LOCATE_FN`/`.replace` twin).
- §13/§14 phase 3 tests: all 3 modes (incl. **`field`-mode-style: a pre-reveal `safe` field unmasked → captured; a pre-reveal already-`readable` unchanged field → fail closed** — both at the `RESOLVE_SCAN_FN` DOM-shim level AND the route level via `resolveWithinContainer(mode="field")`); predicate rejects button/link/label & focused-after-reveal-on-reveal-button → fail closed (→ `null`); resolution fail-closed on zero/>1 transition-eligible + non-contained; transition-eligibility filtering (readable label/help/static-metadata siblings + one revealed field SUCCEEDS — siblings dropped before exactly-one); two simultaneously revealed → fail closed; already-readable-unchanged → fail closed; no safe→revealed → fail closed; hide-handle vs blank fallback; captured value never in any response (no-leak assertion extended) → Tasks 4/5/7; the [P2a] Stripe gate is a final MANUAL task (Task 8), does NOT block code-task merge, feeds Plan 5.
- §15 acceptance ("capture a revealed Stripe secret without the human focusing/selecting after blind begins"; fail-closed when not provable; no raw secrets; UI plain language + disclosure; [P2a]) → Tasks 5/4/2/8. §16 decisions (always force-approval; pre-reveal baseline enforced per chosen candidate not whole-subtree; three modes; daemon-only resolution + DOM-containment proof + strict single-candidate; auto-resume bypasses blank, `/v1/blind/end` unchanged; raw-only proof) → Tasks 1/3/4/5.

**2. Hard-won Phase-2 review lessons pre-empted:**
1. Absence proof REUSED: the route calls the merged `browser.proveAbsence(capturedValue)` — no new scan added (Task 5; Self-Review §12).
2. New in-page scans (`BASELINE_SCAN_FN`/`RESOLVE_SCAN_FN`) are hash/class/boolean egress only: `BASELINE_SCAN_FN` → hashed/classified entries; `RESOLVE_SCAN_FN` → the chosen **element-or-`null`** (called WITHOUT `returnByValue` → a RemoteObject handle, no value egress, mirroring the merged `NORMALIZE_TO_ACTIONABLE_FN`). The single chosen value is read exactly once by `resolveWithinContainer` off that RemoteObject `objectId` (after the containment proof) → `upsertSecret` only. **No `RESOLVE_LOCATE_FN`/`.replace` twin** (the prior fragile byte-exact-substring maintenance contract is eliminated; the node read is the node selected, by construction — same RemoteObject). Fail-CLOSED on every uncertainty (a single `ShuttleError` → `captured:"unknown"`; granular reasons not surfaced since the response is enum-only), bounded internally (the `Runtime.callFunctionOn` calls go through the same session machinery; the route additionally `withDeadline`-wraps the whole reveal→resolve→read→hide sequence mirroring inject-submit I3) (Task 4 & 5).
3. Containment proof is a real DOM `a.contains(b)` via the EXISTING `isDescendantOf` (`Runtime.callFunctionOn`) against the approved container backend node, fail-closed on error, with the IS-the-container case allowed (Task 4).
4. Route fail-closed state machine mirrors inject-submit exactly: pre-blind failures → 4xx blind never started; pre-action revalidation failure → `blind.end()`+rethrow (nothing revealed, safe); from reveal-click onward failure MUST NOT auto-resume, stays blind, enum-only `captured:"unknown"`+`manual_recovery_required`, best-effort bounded `blankAllPages` neutralization on the post-reveal failure path; `autoResumeBlind` wrapped in try/catch falling through to fail-closed (T7-M1); auto-resume ONLY iff captured-non-empty AND hide/blank-succeeded AND proof passed (Task 5).
5. New `ApprovalBinding` non-display fields added to `bindingsMatch` with retry-determinism (the route rebuilds the identical binding deterministically); display-only labels excluded; binding unit test incl. the absent-vs-explicit-null `hide_fingerprint` edge and the `capture_mode` value edge (Task 1).
6. `ui-server.ts` serializes the new fields + `ui.html` `human`/disclosure/`capture_mode` body + BOTH a static-HTML test AND a runtime `/ui/approvals/:id` JSON test; the existing Phase-2 serialized lines are verified present and explicitly NOT duplicated; the disclosure copy is one shared `(inject_submit || reveal_capture)` line (Task 2).
7. Stub-fixup discipline: EVERY `BrowserOps` literal in ALL test files (the four files, incl. the four literals in `routes.test.ts`) extended with the 3 new methods in the SAME task that extends the interface, with an explicit enumeration step (`grep -n "clickBackendNode: async () => undefined"`) (Task 4).
8. Tests drive the REAL in-page functions via the `runScan`/`new Function` DOM-shim precedent (predicate/transition/containment), plus `ScriptedTransport` transport tests for the `CdpBrowserOps` methods, plus full route HTTP tests (`withDaemon`/`call`) incl. the no-leak assertion and a `reveal-capture` agentic e2e sibling (Tasks 4/5/7).
9. No `as`/`any`/`@ts-` in production beyond sanctioned patterns; production code uses typed CDP generics + `ShuttleError`; tests use the established `as Record<string,unknown>`/`@ts-expect-error`(in the guard-proving test only) patterns. Strict-TS clean (`npm run typecheck` in Task 7).
10. Ends with the manual [P2a] Stripe gate (Task 8, not a unit test, does not block merging code tasks) + this thorough self-review (spec §6 clause-by-clause incl. all 3 modes/baseline/transition-eligibility/containment/fail-closed matrix/§6.4/§12/§13; placeholder scan below; type consistency below).

**3. Spec ambiguities resolved (controller: verify):**
- *Auto-resume signal:* spec §7's merged `autoResumeBlind` hard-asserts `success_signal==="text_matched"`, but reveal-capture has NO success-text observation (its precondition per §6.2 step 12 is captured-non-empty AND hide/blank-succeeded AND absence-passed). Resolved by widening `AutoResumeArgs.success_signal` to `"text_matched" | "secret_captured"` and accepting either in the precondition; the `absence_proof==="passed"` gate is UNCHANGED (the only widening is which non-empty signal counts), `op:"reveal_capture"` was already in the union, and the inject-submit caller is unaffected (still `"text_matched"`). Reveal-capture passes `"secret_captured"` only after the route independently verifies captured-non-empty AND hide/blank-succeeded (Task 3 & 5).
- *`baselineCandidates`/`resolveWithinContainer` shape:* the spec defines behavior, not signatures. Resolved as: `BackendNodeRef`-keyed (the same `{target_id, backend_node_id}` type Phase 2 introduced — reused, not re-invented); `baselineCandidates(ref) → Baseline {entries:[{key,safety,fp}]}` (`key` = a stable structural path within the approved subtree, NOT text; `fp` = a small non-cryptographic digest used ONLY to detect change, never reversed/egressed as text); `resolveWithinContainer(ref, mode, baseline) → {value}` with `mode: "field" | "container" | "focused-after-reveal"`, throwing one fail-closed `ShuttleError` (`reveal_no_transition` for the null-RemoteObject / no-single-safe→revealed / empty-value outcomes, `reveal_not_contained` for the containment failure, `reveal_resolve_failed` for any CDP error — the response is enum-only `captured:"unknown"`, so granular reasons are not surfaced to the agent). **There is ONE in-page scan and NO `.replace` twin:** `RESOLVE_SCAN_FN` returns the **chosen element itself or `null`** (exactly the merged `NORMALIZE_TO_ACTIONABLE_FN` element-or-null contract); `resolveWithinContainer` mirrors `normalizeToActionable`/`describeBackendNode` — `callFunctionOn` WITHOUT `returnByValue` → RemoteObject → `DOM.describeNode {objectId}` → `backendNodeId` → containment proof via the EXISTING `isDescendantOf` → the single chosen value read EXACTLY ONCE off that same `objectId` (`returnByValue:true`) → `vault.upsertSecret` only; all resolved `objectId`s released in `finally`. The node read is the node selected **by construction** (same RemoteObject) — eliminating the prior fragile byte-exact-substring maintenance contract and its silent no-op failure mode.
- *Route deadline-wrapping:* the spec says reveal-capture "owns its blind window like inject-submit". Resolved by wrapping the ENTIRE reveal→resolve→read→hide sequence (not each step) in one `withDeadline` (module-scope, copied verbatim from inject-submit.ts) so a hang anywhere in the secret-bearing path becomes a single caught failure routed to the fail-closed body, with the post-reveal best-effort bounded `blankAllPages` neutralization exactly as inject-submit's I3/P2 hardening (env-tunable `SECRET_SHUTTLE_REVEAL_DEADLINE_MS`/`SECRET_SHUTTLE_BLANK_DEADLINE_MS`).
- *`field` mode safe→revealed gate (spec §6.1, RESOLVED — was flagged as a defect, now fixed):* spec §6.1 makes the per-chosen-candidate gate explicit precisely to catch "the secret's raw value was **already DOM-readable before blind mode**" — and `field` mode (unmask-in-place) IS exactly that scenario, so reading the post-reveal field value directly would be a spec-fidelity SECURITY defect (it would happily capture a field whose value was already script-readable pre-reveal, defeating the protection §6.1 mandates). Resolved DRY: ALL THREE modes (`field`/`container`/`focused-after-reveal`) go through `resolveWithinContainer`, which is the single place the §6.1 per-candidate safe→revealed decision lives (defined once, tested once). For `field` the scan is bound to the field handle's OWN backend node: the field is its own subtree root and sole candidate, so its pre-reveal baseline entry gates it — a field that was `safe` pre-reveal (absent/empty/password-no-script-value/recognized mask) and is now revealed (non-empty script-readable) is captured; a field already `readable` and unchanged pre-reveal, or showing no safe→revealed transition, **fails closed** (`captured:"unknown"`, stays blind). `readBackendNodeValue` remains the generic §12 daemon-only single-element reader (kept + independently tested) but is **not** the field-mode capture path (a route test asserts `field` mode goes through `resolveWithinContainer(mode="field")` and does NOT call `readBackendNodeValue`; a sibling route test asserts an already-readable-unchanged field → `captured:"unknown"`/blind stays active; DOM-shim tests assert both at the `RESOLVE_SCAN_FN` level). The spec invariant is now non-negotiably enforced in EVERY mode.

**4. Placeholder scan:** no TBD/TODO; every code step contains COMPLETE code; every command has an expected result. The only non-code step is Task 8 — explicitly a manual release gate (spec §13/§14 [P2a]) with concrete commands and PASS/BEST-EFFORT criteria. There is exactly ONE in-page resolution scan (`RESOLVE_SCAN_FN`, element-or-`null`) and NO `.replace`-derived twin — the prior fragile byte-exact-substring maintenance contract (silent no-op failure mode if the replaced lines ever changed) has been eliminated in favor of the merged `normalizeToActionable` RemoteObject pattern.

**5. Type consistency across tasks:** `Baseline` / `BaselineEntry` / `SafetyClass` (Task 4, `internal-ops.ts`) are the exact shapes `baselineCandidates`/`resolveWithinContainer` (Task 4) return/consume and the route (Task 5) passes through (the route imports `type { Baseline, BackendNodeRef }`). `BackendNodeRef {target_id; backend_node_id}` is the merged Phase-2 type — REUSED unchanged by all three new methods and every route call site. `capture_mode` value union `"field" | "container" | "focused-after-reveal"` is identical in `ApprovalBinding` (Task 1), the route's `captureMode` local, **`resolveWithinContainer`'s `mode` param (now `"field" | "container" | "focused-after-reveal"` — `field` added so ALL THREE modes go through the one §6.1 gate)** (Tasks 4/5), the binding test, the UI JSON test, and the route tests. The new `ApprovalBinding` fields `reveal_fingerprint`/`hide_fingerprint`/`container_fingerprint`/`capture_mode` (non-display) + `reveal_handle_label`/`hide_handle_label`/`container_handle_label` (display-only) are exactly the keys the route (Task 5) builds, `ui-server.ts` serializes (Task 2), `ui.html` reads (Task 2), and `binding-reveal-capture.test.ts` asserts (Task 1); `*_fingerprint`/`capture_mode` matched by strict `?? null` equality (consistent with the existing `submit_fingerprint`/`success_condition`/`auto_resume`). `AutoResumeArgs.success_signal` widened union (Task 3) matches the route's only auto-resume call (`"secret_captured"`, Task 5) and the inject-submit caller (`"text_matched"`, unchanged). `DaemonAuditAction` `"reveal_capture"` + `DaemonAuditEvent.captured` (Task 3) match every `writeDaemonAudit({action:"reveal_capture", …, captured})` call in the route (Task 5). `ShuttleError` codes are consistent across method throws and the ScriptedTransport/route tests — ONE fail-closed code per failure class (the response is enum-only `captured:"unknown"`, so granular reasons are deliberately NOT multiplied): `reveal_read_failed` (`readBackendNodeValue`), `reveal_baseline_failed` (`baselineCandidates`), and for `resolveWithinContainer` `reveal_no_transition` (null-RemoteObject / no single safe→revealed candidate / empty value — covers zero/>1 transition-eligible and already-readable-unchanged), `reveal_not_contained` (containment proof false), `reveal_resolve_failed` (any CDP error) (Task 4); plus `handle_kind_mismatch`/`handle_target_mismatch`/`domain_mismatch`/`bad_request`/`blind_mode_already_active`/`missing_allow_domain` (Task 5, reusing the inject-submit/secrets vocabulary). (`reveal_ambiguous`/`reveal_already_readable` from the prior draft are removed — those distinct codes were only meaningful with the old `{ok,reason}` envelope; the single-scan element-or-`null` design collapses them into `reveal_no_transition`, and the route's fail-closed branch is generic so the specific code does not change the enum-only response.) The three `BrowserOps` stubs across four files gain the 3 new methods in the SAME task that extends the interface (Task 4) so the tree is green at every commit. `enforceDomain` (exported in Phase 2 `secrets.ts:390`) is imported by the route (Task 5); `buildSecretRef`/`canonicalEnvironment` (`shared/refs.js`) and `blankAllPages`/`disableObservationDomains` (`internal-ops.js`) are reused as-is.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-agentic-blind-transactions-phase3-reveal-capture.md`. This document fully specifies **Phase 3 (`reveal-capture`)**; Plans 4–5 are generated from the same spec once Phase 3 merges. The [P2a] Stripe gate (Task 8) is a manual release gate that does not block merging Tasks 1–7; its outcome (PASS/BEST-EFFORT) is recorded in "## [P2a] Gate outcome" and feeds Plan 5's per-provider production-vs-best-effort statement (alongside the Phase-2 Vercel [P2a] outcome).
