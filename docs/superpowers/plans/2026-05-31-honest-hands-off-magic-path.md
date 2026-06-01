# Honest Hands-Off Magic Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the daemon how to drive specific provider pages via per-provider "recipes" (declarative selectors + ordered nav steps) so the batch provisioning path (`provision --continue`) captures and injects secrets hands-off for providers that have a recipe — one human approval, daemon drives the page — while staying honest about the two physical limits (first-run login per provider; not every provider is revealable).

**Architecture:** Recipes are daemon-shipped constant data (`host -> Recipe`, per direction). A new daemon primitive `resolveSelectorToHandle` turns a recipe selector into a `BackendNodeRef` on the public page chrome before any secret is revealed. The two vetted secret-bearing sequences in `reveal-capture.ts` / `inject-submit.ts` are **factored** (behavior-preserving) into shared functions parameterized by `BrowserOps` + resolved refs, so the bootstrap recipe path reuses the *identical* blind/transition-gate/absence-proof machinery — only the element-locating source changes. Staged page-state detection (`page_ready_probe` / `logged_out_marker` / `logged_in_probe`) distinguishes load-failure vs. logged-out vs. wrong-scope so the daemon never emits misleading "log in and re-run" loops. A failed/stale recipe degrades to a clear, specific error (no human-fallback machinery is built); the agent relays it and the human takes over manually.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, relative imports with `.js` extension), Node ≥20. Tests: `node:test` + `node:assert/strict`, co-located `*.test.ts`, run against compiled `dist/`. CDP via the existing `CdpClient` / `CdpBrowserOps`. Errors via `ShuttleError` (asserted by `.code`). No lint, no pre-commit hooks.

**Source of truth:** `docs/superpowers/specs/2026-05-31-honest-hands-off-magic-path-design.md`. Section references below (§1–§10) point at that spec.

---

## How to run tests (every task uses this)

The repo compiles to `dist/` and runs the compiled tests:

```bash
# whole suite
npm test
# single file (faster inner loop) — build first, then run that one compiled file
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/<path-without-src>/<file>.test.js"
# single test by name
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test --test-name-pattern "<name>" "dist/<...>.test.js"
```

`src/daemon/recipes/registry.test.ts` compiles to `dist/daemon/recipes/registry.test.js`. `SECRET_SHUTTLE_NO_OPEN_URL=1` keeps the daemon from opening browser tabs during tests. **Every "run the test" step below means: `npm run build` then `node --test` the compiled file.** If `npm run build` fails to compile, that is a real failure — fix the types before running.

---

## File structure (what each new/changed file is responsible for)

**New:**
- `src/daemon/recipes/types.ts` — `RecipeStep`, `RecipeBase`, `CaptureRecipe`, `InjectRecipe`, `Recipe` (data shapes only; §1).
- `src/daemon/recipes/registry.ts` — `RecipeRegistry` (Map keyed by canonical host, per direction) + the module-singleton `recipeRegistry` with builtins registered. Mirrors `src/daemon/api/routes/templates.ts`'s `export const registry = new TemplateRegistry()`.
- `src/daemon/recipes/page-state.ts` — `detectPageState`, `recheckPageScope`, `runPreSteps` (§4 staged detection + the §1 pre-step safety contract). Pure orchestration over `BrowserOps`; importable by both bootstrap directions.
- `src/daemon/recipes/builtin/stripe-capture.ts` — the Stripe `CaptureRecipe` constant (selectors authored via browser-harness in Task 11).
- `src/daemon/recipes/builtin/vercel-inject.ts` — the Vercel `InjectRecipe` constant (Task 11).
- `src/daemon/chrome/secret-gates.ts` — `captureWithTransitionGate`, `injectWithSuccessGate`, and the single shared `withDeadline`. The factored secret-bearing cores (§3); home is `chrome/` because they depend on `BrowserOps` / `blankAllPages` / `CdpClient` from `internal-ops.ts`.
- `src/daemon/bootstrap/recipe-capture.ts` — `attemptRecipeCapture` (the capture-recipe state machine that wraps page-state + pre-steps + resolve + gate, and owns failure tab/blind lifecycle per §5).
- `src/daemon/bootstrap/recipe-inject.ts` — `runBrowserInject` (the `browser_inject` destination executor per §6).

**Changed:**
- `src/shared/error-codes.ts` — add the 7 new codes (§Error-codes).
- `src/daemon/chrome/internal-ops.ts` — add `resolveSelectorToHandle`, `selectorMatchCount`, `waitForSelector`, `documentHost` to `BrowserOps` + `CdpBrowserOps` (§2).
- `src/daemon/api/routes/reveal-capture.ts` — replace the inner secret-bearing block with a `captureWithTransitionGate` call; import shared `withDeadline` (Task 4).
- `src/daemon/api/routes/inject-submit.ts` — replace the inner secret-bearing block with an `injectWithSuccessGate` call; import shared `withDeadline` (Task 5).
- `src/daemon/bootstrap/executor.ts` — `runCaptureStep` recipe branch (Task 7); `runDestinationSteps` `kind` switch (Task 9); `ExecutorDeps` gains optional `recipes?` (test override).
- `src/daemon/bootstrap/store.ts` — `ResolvedDestination` becomes a discriminated union; back-compat default `kind ?? "template"` on load (Task 8).
- `src/cli/bootstrap/destination-shorthand.ts`, `src/daemon/bootstrap/plan.ts`, `src/daemon/bootstrap/destination-policy.ts`, `src/daemon/bootstrap/infer-session-pattern.ts` — narrow on `ResolvedDestination.kind` (Task 8).
- `src/daemon/bootstrap/plan.ts` (selection) + `src/daemon/api/routes/bootstrap.ts` (CLI-availability probe) — choose `browser_inject` vs `template` per destination (Task 14).
- `src/cli/provision/infer-rules.ts` (+ `infer-gate.ts`, `infer.ts`, `provision.ts`, `cli/bootstrap/yml.ts`, `destination-policy.ts`, `bootstrap.ts`) — add `human_paste` inferred/source kind; relabel OpenAI/Anthropic (Task 10).
- `README.md` — unified coverage matrix replaces `[P2a]` (Task 12); honesty copy (Task 13).
- `demo/index.html` — scene-0 honesty copy (Task 13).

---

## Refactoring design — read before Tasks 4, 5, 7, 9

The crux of this plan is reusing the secret-bearing cores **without forking them**. The boundary was chosen by reading the two routes line-by-line:

**Capture (`reveal-capture.ts`).** The route samples `baselinePre` *before* blind (lines 250–253, while the agent can still observe — closes the approval-window staleness hole), then wraps an inner block in `withDeadline(...)` (337–399) that: samples `baselinePost` (340–343), merges `readableFps` (349–353), clicks reveal (354–355), runs the transition gate `resolveWithinContainer` (365–369), applies the observable-before-blind check (376–381, throws `reveal_no_transition`), and hides (383–395). **We factor lines 340–395 into `captureWithTransitionGate`**, which takes `baselinePre` as an input, samples `baselinePost` itself, and returns `{ value, hideDone }`. The route keeps: the pre-blind `baselinePre` sample, the `withDeadline` envelope, the post-reveal `catch` (400–419), the proof-before-upsert + vault logic (432–461), and `autoResumeBlind` (463–484). **Bootstrap recipe path:** there is no pre-blind agent-observable window on the daemon-opened tab (blind starts *before* `openCaptureTarget`), so the recipe caller samples a single baseline immediately pre-reveal and passes it as `baselinePre`; the gate's internal `baselinePost` is then a near-identical second pre-reveal sample — the union is a no-op and the transition semantics are preserved exactly.

**Inject (`inject-submit.ts`).** The route wraps inject+click in `withDeadline(...)` (180–193), `catch`es to fail-closed (194–224), then runs `observeText` (227–231) and `proveAbsence` (232–239). **We factor the `withDeadline(inject+click)` + `observeText` + `proveAbsence` into `injectWithSuccessGate`**, which *throws* if inject/click fails/times out (the `withDeadline` rejection propagates) and otherwise returns `{ successObserved, proofPassed }`. The caller wraps the call in the existing fail-closed `try/catch` (the old 194–224 body) and keeps `markUsed` (240) + `autoResumeBlind` (249–262). Behavior is identical: an inject/click failure still reaches the caller's fail-closed return; `observeText`/`proveAbsence` errors are still swallowed inside.

**Behavior-preservation is the bar.** The existing route tests (`reveal-capture-routes.test.ts`, `inject-submit-routes.test.ts`) are the guard — they must stay green byte-for-byte in *outcome*. The refactor changes structure, not observable behavior.

**Registry access.** Recipes follow the templates pattern: a module-singleton `recipeRegistry` (builtins registered at module load). For testability of the executor wiring, `ExecutorDeps` gains an **optional** `recipes?: RecipeRegistry`; the executor reads `deps.recipes ?? recipeRegistry`. Real callers omit it (singleton); tests inject a registry holding a fake recipe. No change to `services.ts`.

---

## Task 1: Add the new error codes

**Files:**
- Modify: `src/shared/error-codes.ts` (the `REGISTRY`)
- Test: `src/shared/error-codes.test.ts` (create if absent, else add a case)

- [ ] **Step 1: Write the failing test**

Add (or create) a test asserting every new code is registered:

```ts
// src/shared/error-codes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES } from "./error-codes.js"; // mirror the existing export name in this file

test("recipe error codes are registered", () => {
  for (const code of [
    "recipe_selector_ambiguous",
    "recipe_capture_failed",
    "bootstrap_login_required",
    "recipe_page_timeout",
    "recipe_page_unexpected",
    "recipe_inject_failed",
    "recipe_not_found",
  ]) {
    assert.ok(code in ERROR_CODES, `missing ${code}`);
  }
});
```

> Before writing, open `src/shared/error-codes.ts` and match the **actual** exported registry name and entry shape (the summary calls it `REGISTRY`). Adjust the import/assertion to the real shape (e.g. `assert.ok(REGISTRY[code] !== undefined)`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: FAIL (codes not present) — or a compile error if the registry rejects unknown keys, which is also a valid "red".

- [ ] **Step 3: Add the codes**

In `src/shared/error-codes.ts` `REGISTRY`, add entries following the existing entry format (copy a neighbor's shape — message/category fields):

```ts
recipe_selector_ambiguous: { /* …existing shape… */ message: "A recipe selector matched 0 or >1 elements; manual capture/inject needed." },
recipe_capture_failed:     { message: "Recipe ran but the transition gate yielded no value." },
bootstrap_login_required:  { message: "Log into the provider in the open Secret Shuttle browser tab, then re-run --continue." },
recipe_page_timeout:       { message: "The recipe page never finished loading (bad URL / changed DOM / network)." },
recipe_page_unexpected:    { message: "Page loaded but the logged-in scope probe was absent (wrong project/team, permission, or onboarding). Inspect the visible tab." },
recipe_inject_failed:      { message: "Recipe inject submitted but the success text was not observed; retryable." },
recipe_not_found:          { message: "No recipe is registered for this provider host/direction." },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(recipes): add error codes for recipe capture/inject + page-state detection"
```

---

## Task 2: Recipe types + registry

**Files:**
- Create: `src/daemon/recipes/types.ts`
- Create: `src/daemon/recipes/registry.ts`
- Test: `src/daemon/recipes/registry.test.ts`

- [ ] **Step 1: Write the types** (no test — pure types; the registry test covers them)

```ts
// src/daemon/recipes/types.ts
export type RecipeStep =
  // A pre-step click is *navigation only*. It MUST resolve to exactly one element
  // (same single-match rule as resolveSelectorToHandle) and SHOULD target a stable
  // nav affordance (data-*/aria-*/role on a link/tab), never a submit/delete/reveal
  // /destructive/scope-switch control. See §1 pre_steps safety contract.
  | { action: "click"; selector: string }
  | { action: "wait_for"; selector: string; timeout_ms?: number }
  | { action: "wait"; ms: number };

export interface RecipeBase {
  host: string;                 // canonical host (lowercase, trailing-dot stripped) — matched against expectedHost
  url: string;                  // page to open (static in increment 1; param interpolation deferred, §9)
  logged_in_probe: string;      // present iff authenticated AND on the expected page/scope (scope-specific)
  page_ready_probe?: string;    // present on any successful load; absent after timeout => recipe_page_timeout (§4)
  logged_out_marker?: string;   // present ONLY on the provider login/auth screen => bootstrap_login_required (§4)
  ready_timeout_ms?: number;    // bound for page_ready_probe wait
  pre_steps?: RecipeStep[];     // non-secret, non-destructive navigation (see §1 contract)
  verified_against_real_page?: string; // ISO date a human dogfooded it; surfaced in the README matrix
}

export interface CaptureRecipe extends RecipeBase {
  kind: "capture";
  reveal_selector: string;      // the "reveal"/"show" control
  field_selector?: string;      // EITHER: input/textarea holding the secret (field mode)
  container_selector?: string;  // OR: subtree whose revealed text is the secret (container mode)
  hide_selector?: string;       // optional control to restore the hidden state
}

export interface InjectRecipe extends RecipeBase {
  kind: "inject";
  field_selector: string;       // where the value goes
  submit_selector: string;      // the submit/save control
  success_text: string;         // text observed on a successful save
}

export type Recipe = CaptureRecipe | InjectRecipe;
```

- [ ] **Step 2: Write the failing registry test**

```ts
// src/daemon/recipes/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipeRegistry } from "./registry.js";
import type { CaptureRecipe, InjectRecipe } from "./types.js";

const cap: CaptureRecipe = {
  kind: "capture", host: "example.com", url: "https://example.com/keys",
  logged_in_probe: "[data-x]", reveal_selector: "#r", field_selector: "#f",
};
const inj: InjectRecipe = {
  kind: "inject", host: "example.com", url: "https://example.com/env",
  logged_in_probe: "[data-y]", field_selector: "#v", submit_selector: "#s", success_text: "Saved",
};

test("registry keys by canonical host per direction", () => {
  const r = new RecipeRegistry();
  r.registerCapture(cap);
  r.registerInject(inj);
  assert.equal(r.getCapture("example.com"), cap);
  assert.equal(r.getInject("example.com"), inj);
  assert.equal(r.getCapture("EXAMPLE.COM."), cap); // canonicalized lookup
  assert.equal(r.getInject("nope.com"), undefined);
  assert.equal(r.getCapture("example.com")?.kind, "capture"); // direction isolation
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/registry.test.js"`
Expected: FAIL with "Cannot find module './registry.js'".

- [ ] **Step 4: Implement the registry**

```ts
// src/daemon/recipes/registry.ts
import type { CaptureRecipe, InjectRecipe } from "./types.js";

function canon(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export class RecipeRegistry {
  private readonly capture = new Map<string, CaptureRecipe>();
  private readonly inject = new Map<string, InjectRecipe>();

  registerCapture(r: CaptureRecipe): void { this.capture.set(canon(r.host), r); }
  registerInject(r: InjectRecipe): void { this.inject.set(canon(r.host), r); }

  getCapture(host: string): CaptureRecipe | undefined { return this.capture.get(canon(host)); }
  getInject(host: string): InjectRecipe | undefined { return this.inject.get(canon(host)); }

  listCapture(): CaptureRecipe[] { return [...this.capture.values()]; }
  listInject(): InjectRecipe[] { return [...this.inject.values()]; }
}

// Module-singleton, builtins registered here (mirrors api/routes/templates.ts `registry`).
// Builtin recipes are added in Task 11 (Stripe capture, Vercel inject).
export const recipeRegistry = new RecipeRegistry();
// registerBuiltinRecipes(recipeRegistry);  // ← uncommented in Task 11
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/registry.test.js"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/recipes/types.ts src/daemon/recipes/registry.ts src/daemon/recipes/registry.test.ts
git commit -m "feat(recipes): recipe data types + host-keyed registry"
```

---

## Task 3: `resolveSelectorToHandle` + page-probe primitives on BrowserOps

Adds four read-only primitives that operate on the **public page chrome** (element identity / presence / host — never values). `resolveSelectorToHandle` is single-match-or-throw; the rest are for §4 page-state detection and §1 pre-steps.

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (the `BrowserOps` interface + `CdpBrowserOps` class)
- Test: `src/daemon/chrome/internal-ops-recipe.test.ts` (create)

- [ ] **Step 1: Write the failing test**

These methods talk to CDP, so test them by exercising the single-match contract through a thin fake of the two CDP calls they make, OR (preferred, matching the repo's route tests) assert the *contract* via a `CdpBrowserOps` built over a scripted `CdpClient`. Use the existing `ScriptedTransport`/scripted-CDP pattern from `executor-capture.test.ts` if present; otherwise stub at the `cdp.send` boundary.

```ts
// src/daemon/chrome/internal-ops-recipe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpBrowserOps } from "./internal-ops.js";
import { isShuttleError } from "../../shared/errors.js"; // match the real predicate/export

// Minimal scripted CdpClient: respond to the methods resolveSelectorToHandle uses.
// `matchCount` drives the querySelectorAll(...).length probe; for the exactly-one
// path the subsequent DOM round trips resolve to a single concrete node.
function fakeCdp(matchCount: number) {
  return {
    send: async (method: string, _params?: unknown, _sessionId?: string) => {
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Runtime.evaluate") {
        const p = _params as { expression?: string };
        // documentHost evaluates String(location.host)
        if (typeof p?.expression === "string" && p.expression.includes("location.host")) {
          return { result: { value: "stripe.test" } };
        }
        // querySelector(...) (returnByValue:false) → an objectId for the matched node
        if (typeof p?.expression === "string" && p.expression.includes("querySelector(") && !p.expression.includes("querySelectorAll(")) {
          return { result: { objectId: "obj-1" } };
        }
        // resolveSelectorToHandle evaluates document.querySelectorAll(sel).length
        return { result: { value: matchCount } };
      }
      if (method === "DOM.requestNode") return { nodeId: 7 };
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 42, nodeName: "INPUT", attributes: ["type", "password", "id", "sk", "value", "sk_live_LEAK"] } };
      }
      if (method === "Target.detachFromTarget") return {};
      throw new Error("unexpected " + method);
    },
  } as any;
}

test("resolveSelectorToHandle throws recipe_selector_ambiguous on 0 matches", async () => {
  const ops = new CdpBrowserOps(fakeCdp(0));
  await assert.rejects(() => ops.resolveSelectorToHandle("t1", "#x"),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous");
});

test("resolveSelectorToHandle throws recipe_selector_ambiguous on >1 matches", async () => {
  const ops = new CdpBrowserOps(fakeCdp(3));
  await assert.rejects(() => ops.resolveSelectorToHandle("t1", "#x"),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous");
});

test("resolveSelectorToHandle on exactly 1 match returns identity only (no values)", async () => {
  // §246 minimum bar: the exactly-one path must return identity, NOT the value.
  const ops = new CdpBrowserOps(fakeCdp(1));
  const ref = await ops.resolveSelectorToHandle("t1", "#sk");
  // identity shape: { target_id, backend_node_id, fingerprint }
  assert.equal(ref.target_id, "t1");
  assert.equal(ref.backend_node_id, 42);
  assert.equal(typeof ref.fingerprint, "string");
  assert.ok(ref.fingerprint.length > 0);
  // no value-like data is exposed: the resolved node's `value` attr ("sk_live_LEAK")
  // must NEVER appear anywhere in the returned ref (no `value` key, no leak in fingerprint).
  assert.ok(!("value" in ref));
  assert.ok(!JSON.stringify(ref).includes("sk_live_LEAK"));
});
```

> The exact `Runtime.evaluate` responses depend on how you implement the method (one round trip returning count, or count+describe). Write the implementation first as a sketch if it's easier, then pin the fake to the real call sequence. The **contract** under test is invariant: 0 or >1 → `recipe_selector_ambiguous`; exactly 1 → returns **identity only** (a `BackendNodeRef & { fingerprint }`) and never the element's value, even when the matched node carries one (per spec §246).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/chrome/internal-ops-recipe.test.js"`
Expected: FAIL ("resolveSelectorToHandle is not a function").

- [ ] **Step 3: Add the interface methods**

In `src/daemon/chrome/internal-ops.ts` `BrowserOps` (after `resolveWithinContainer`, ~line 193):

```ts
  /** Resolve a selector to element identity on the PUBLIC page chrome. Exactly one
   *  match required (0/>1 → recipe_selector_ambiguous). Returns identity + fingerprint,
   *  NEVER values. Same class of info the agent's `mark` exposes. (§2) */
  resolveSelectorToHandle(target_id: string, selector: string): Promise<BackendNodeRef & { fingerprint: string }>;
  /** Count of elements matching selector in target's document (for §4 probes / pre-step single-match checks). */
  selectorMatchCount(target_id: string, selector: string): Promise<number>;
  /** Poll selectorMatchCount(selector) >= 1 until present or timeoutMs elapses. (§4 page_ready_probe / pre-step wait_for) */
  waitForSelector(target_id: string, selector: string, timeoutMs: number): Promise<boolean>;
  /** Live document host of the target (lowercased; caller strips trailing dot). (§1 host revalidation) */
  documentHost(target_id: string): Promise<string>;
```

- [ ] **Step 4: Implement on `CdpBrowserOps`**

Mirror `getFocusedBackendNodeId` (lines 833–855) for the attach → evaluate → describe → detach pattern, and `fieldFingerprint` (770–773) for the hash. Add inside the class:

```ts
  async selectorMatchCount(targetId: string, selector: string): Promise<number> {
    const expr = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
    return await this.evaluate<number>(targetId, expr);
  }

  async waitForSelector(targetId: string, selector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // poll every 250ms; first check immediate
    for (;;) {
      if ((await this.selectorMatchCount(targetId, selector)) >= 1) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async documentHost(targetId: string): Promise<string> {
    return (await this.evaluate<string>(targetId, "String(location.host)")).toLowerCase();
  }

  async resolveSelectorToHandle(targetId: string, selector: string): Promise<BackendNodeRef & { fingerprint: string }> {
    const count = await this.selectorMatchCount(targetId, selector);
    if (count !== 1) {
      throw new ShuttleError("recipe_selector_ambiguous", `Selector ${selector} matched ${count} elements (need exactly 1).`);
    }
    const sessionId = await this.attach(targetId);
    try {
      // querySelector → DOM node → backendNodeId + a FieldDescriptor for the fingerprint.
      const ev = await this.cdp.send<{ result: { objectId?: string } }>(
        "Runtime.evaluate",
        { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false },
        sessionId,
      );
      const objectId = ev.result.objectId;
      if (objectId === undefined) {
        throw new ShuttleError("recipe_selector_ambiguous", `Selector ${selector} resolved to no node.`);
      }
      try {
        const node = await this.cdp.send<{ nodeId: number }>("DOM.requestNode", { objectId }, sessionId);
        const desc = await this.cdp.send<{ node: { backendNodeId: number; nodeName: string; attributes?: string[] } }>(
          "DOM.describeNode", { nodeId: node.nodeId }, sessionId,
        );
        const backendNodeId = desc.node.backendNodeId;
        const attrs = desc.node.attributes ?? [];
        const attr = (n: string): string | undefined => {
          const i = attrs.indexOf(n);
          return i >= 0 ? attrs[i + 1] : undefined;
        };
        const field: FieldDescriptor = {
          tag: desc.node.nodeName.toLowerCase(),
          ...(attr("type") !== undefined ? { type: attr("type") } : {}),
          ...(attr("name") !== undefined ? { name: attr("name") } : {}),
          ...(attr("id") !== undefined ? { id: attr("id") } : {}),
          editable: desc.node.nodeName.toLowerCase() === "input" || desc.node.nodeName.toLowerCase() === "textarea",
        };
        const host = await this.documentHost(targetId);
        const fingerprint = fieldFingerprint(host, targetId, backendNodeId, field);
        return { target_id: targetId, backend_node_id: backendNodeId, fingerprint };
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
      }
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
```

> `ShuttleError`, `FieldDescriptor`, `fieldFingerprint`, `BackendNodeRef` are already in this module's scope (FieldDescriptor at 149–155, fieldFingerprint at 770–773, BackendNodeRef at 121–124). Add `ShuttleError` to the imports if not already present.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/chrome/internal-ops-recipe.test.js"`
Expected: PASS

- [ ] **Step 6: Update any other `BrowserOps` implementers/fakes that must satisfy the interface**

`tsc` will flag any non-test `BrowserOps` implementation missing the 4 new methods. Test fakes built with `stub(over: Partial<BrowserOps>)` are unaffected (partial). Fix any real implementer the compiler flags. Run `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/internal-ops-recipe.test.ts
git commit -m "feat(recipes): resolveSelectorToHandle + page-probe primitives (single-match-or-throw)"
```

## Task 4: Factor `captureWithTransitionGate` out of `reveal-capture.ts` (behavior-preserving)

Extract the inner secret-bearing block (lines 340–395) into a shared function. **The existing route tests are the guard — they must stay green.** Read the "Refactoring design" section above first.

**Files:**
- Create: `src/daemon/chrome/secret-gates.ts`
- Modify: `src/daemon/api/routes/reveal-capture.ts`
- Test (guard, already exists): `src/daemon/api/routes/reveal-capture-routes.test.ts`

- [ ] **Step 1: Confirm the guard tests pass BEFORE refactoring**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/api/routes/reveal-capture-routes.test.js"`
Expected: PASS (this is the byte-identical-outcome baseline you must preserve).

- [ ] **Step 2: Create the shared gate module + the single shared `withDeadline`**

```ts
// src/daemon/chrome/secret-gates.ts
import { ShuttleError } from "../../shared/errors.js"; // match the real path/export
import { blankAllPages } from "./internal-ops.js";
import type { BrowserOps, BackendNodeRef, Baseline } from "./internal-ops.js";
import type { CdpClient } from "<mirror internal-ops.ts's CdpClient import>"; // same module internal-ops.ts imports CdpClient from

/** Races `p` against a deadline; clears its timer on settle. Single shared copy
 *  (was duplicated in reveal-capture.ts and inject-submit.ts). */
export function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShuttleError(code, `Operation exceeded ${ms}ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface CaptureGateArgs {
  revealRef: BackendNodeRef;
  targetRef: BackendNodeRef;
  captureMode: "field" | "container" | "focused-after-reveal";
  hideRef?: BackendNodeRef;
  /** Sampled by the caller before blind (route) or immediately pre-reveal (recipe). */
  baselinePre: Baseline;
}

/** Factored from reveal-capture.ts:340-395. Samples baselinePost, merges readableFps,
 *  clicks reveal, runs the transition gate, applies the observable-before-blind check
 *  (throws reveal_no_transition), and hides. Returns { value, hideDone }. Logic unchanged. */
export async function captureWithTransitionGate(
  browser: BrowserOps,
  cdp: CdpClient | null,
  args: CaptureGateArgs,
): Promise<{ value: string; hideDone: boolean }> {
  const { revealRef, targetRef, captureMode, hideRef, baselinePre } = args;
  const baselinePost = await browser.baselineCandidates(targetRef);
  const mergedBaseline: Baseline = {
    entries: baselinePost.entries,
    readableFps: Array.from(new Set([...baselinePre.readableFps, ...baselinePost.readableFps])),
    observable: "",
  };
  await browser.clickBackendNode(revealRef);
  const res = await browser.resolveWithinContainer(targetRef, captureMode, mergedBaseline);
  const value = res.value;
  if (value !== "" && (baselinePre.observable.includes(value) || baselinePost.observable.includes(value))) {
    throw new ShuttleError("reveal_no_transition", "Resolved value was observable before blind mode.");
  }
  let hideDone = false;
  if (hideRef !== undefined) {
    await browser.clickBackendNode(hideRef);
    hideDone = true;
  } else if (cdp !== null) {
    await blankAllPages(cdp);
    hideDone = true;
  } else {
    hideDone = true;
  }
  return { value, hideDone };
}
```

> Copy the `withDeadline` body **verbatim** from `reveal-capture.ts:518-524`. Copy lines 340–395's logic into `captureWithTransitionGate` exactly (only the variable plumbing changes: `targetHandle`→`targetRef`, `revealHandle`→`revealRef`, `hideHandle`→`hideRef`, `services.cdp`→`cdp`).

- [ ] **Step 3: Rewire `reveal-capture.ts` to call the gate**

Replace the inner block at lines 337–399 (the whole `withDeadline(...)` call) with:

```ts
      try {
        const gate = await withDeadline(
          captureWithTransitionGate(browser, services.cdp, {
            revealRef: { target_id: revealHandle.target_id, backend_node_id: revealHandle.backend_node_id },
            targetRef: { target_id: targetHandle.target_id, backend_node_id: targetHandle.backend_node_id },
            captureMode,
            ...(hideHandle !== undefined
              ? { hideRef: { target_id: hideHandle.target_id, backend_node_id: hideHandle.backend_node_id } }
              : {}),
            baselinePre,
          }),
          revealDeadlineMs,
          "reveal_capture_timeout",
        );
        capturedValue = gate.value;
        hideDone = gate.hideDone;
      } catch {
        // …UNCHANGED existing post-reveal catch body (lines 400-419)…
      }
```

Then:
- Delete the now-duplicate local `withDeadline` (reveal-capture.ts:518-524).
- Add `import { captureWithTransitionGate, withDeadline } from "../../chrome/secret-gates.js";` (the route still uses `withDeadline` for the `blank_timeout` race at line 408).
- Keep `baselinePre` (250-253), the shape guard (256-258), `revealDeadlineMs` (333), the `let capturedValue`/`let hideDone` (334-335), the catch (400-419), and everything from 420 onward **unchanged**.

- [ ] **Step 4: Run the guard tests + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/api/routes/reveal-capture-routes.test.js"`
Expected: PASS (identical outcomes to Step 1). If any assertion changed, the refactor altered behavior — revert and re-extract.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/chrome/secret-gates.ts src/daemon/api/routes/reveal-capture.ts
git commit -m "refactor(capture): extract captureWithTransitionGate (behavior-preserving)"
```

---

## Task 5: Factor `injectWithSuccessGate` out of `inject-submit.ts` (behavior-preserving)

**Files:**
- Modify: `src/daemon/chrome/secret-gates.ts` (add the inject gate)
- Modify: `src/daemon/api/routes/inject-submit.ts`
- Test (guard, exists): `src/daemon/api/routes/inject-submit-routes.test.ts`

- [ ] **Step 1: Confirm the guard tests pass first**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/api/routes/inject-submit-routes.test.js"`
Expected: PASS.

- [ ] **Step 2: Add `injectWithSuccessGate` to `secret-gates.ts`**

```ts
export interface InjectGateArgs {
  fieldRef: BackendNodeRef;
  submitRef: BackendNodeRef;
  value: string;          // plaintext; caller owns the SecretValue + disposes it
  domain: string;
  successText: string;
  successTimeoutMs: number;
}

/** Factored from inject-submit.ts:180-239. Wraps inject+click in withDeadline (THROWS on
 *  failure/timeout — caller fail-closes), then observeText + (if observed) proveAbsence.
 *  Returns { successObserved, proofPassed }. Logic unchanged. */
export async function injectWithSuccessGate(
  browser: BrowserOps,
  args: InjectGateArgs,
): Promise<{ successObserved: boolean; proofPassed: boolean }> {
  const { fieldRef, submitRef, value, domain, successText, successTimeoutMs } = args;
  const injectClickDeadlineMs = Number(process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS) || 30_000;
  await withDeadline(
    (async () => {
      await browser.injectIntoBackendNode(fieldRef, value);
      await browser.clickBackendNode(submitRef);
    })(),
    injectClickDeadlineMs,
    "inject_click_timeout",
  );
  let successObserved = false;
  try {
    successObserved = await browser.observeText(domain, successText, successTimeoutMs);
  } catch {
    successObserved = false;
  }
  let proofPassed = false;
  if (successObserved) {
    try {
      proofPassed = (await browser.proveAbsence(value)).passed;
    } catch {
      proofPassed = false;
    }
  }
  return { successObserved, proofPassed };
}
```

- [ ] **Step 3: Rewire `inject-submit.ts`**

Replace the block at lines 172–239 (the `try { withDeadline(inject+click) } catch {…}` plus `observeText` + `proveAbsence`) with:

```ts
      let successObserved = false;
      let proofPassed = false;
      try {
        const gate = await injectWithSuccessGate(browser, {
          fieldRef: { target_id: fieldHandle.target_id, backend_node_id: fieldHandle.backend_node_id },
          submitRef: { target_id: submitHandle.target_id, backend_node_id: submitHandle.backend_node_id },
          value: resolved.value.bytes().toString("utf8"),
          domain,
          successText,
          successTimeoutMs,
        });
        successObserved = gate.successObserved;
        proofPassed = gate.proofPassed;
      } catch {
        // …UNCHANGED existing post-write catch body (lines 194-224): blankAllPages,
        // markUsed, fail-closed audit, return submitted:"unknown"…
      }
      await services.vault.markUsed(meta.ref).catch(() => undefined); // was line 240, unchanged
```

Then:
- Delete the local `withDeadline` (inject-submit.ts:308-314).
- Add `import { injectWithSuccessGate, withDeadline } from "../../chrome/secret-gates.js";` (still needed for the `blank_timeout` race at line 212).
- Keep the outer `try/finally` that disposes `resolved` (293-299), the success branch (242-266), and the fail-closed tail (268-276) **unchanged**.

- [ ] **Step 4: Run the guard tests + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/api/routes/inject-submit-routes.test.js"`
Expected: PASS (identical outcomes to Step 1).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/chrome/secret-gates.ts src/daemon/api/routes/inject-submit.ts
git commit -m "refactor(inject): extract injectWithSuccessGate (behavior-preserving)"
```

---

## Task 6: Staged page-state detection + pre-step runner

Implements §4 (distinct `ready`/`logged_out`/`timeout`/`unexpected` outcomes) and the §1 pre-step safety contract (single-match nav-only clicks, host+scope revalidation after each step). Pure orchestration over `BrowserOps` — unit-testable with a fake browser.

**Files:**
- Create: `src/daemon/recipes/page-state.ts`
- Test: `src/daemon/recipes/page-state.test.ts`

- [ ] **Step 1: Write the failing tests** (assert the three failure classes are *distinct*, per the §4 test bar)

```ts
// src/daemon/recipes/page-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPageState, recheckPageScope, runPreSteps } from "./page-state.js";
import type { RecipeBase } from "./types.js";
import { isShuttleError } from "../../shared/errors.js";

const base: RecipeBase = {
  host: "example.com", url: "https://example.com/x", logged_in_probe: "[data-in]",
  page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]", ready_timeout_ms: 50,
};

// Fake BrowserOps recording selector presence; `present` is a set of selectors that "exist".
function fakeBrowser(present: Set<string>, host = "example.com") {
  return {
    waitForSelector: async (_t: string, sel: string) => present.has(sel),
    selectorMatchCount: async (_t: string, sel: string) => (present.has(sel) ? 1 : 0),
    documentHost: async () => host,
    resolveSelectorToHandle: async (_t: string, sel: string) => {
      if (!present.has(sel)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous" });
      return { target_id: _t, backend_node_id: 1, fingerprint: "fp" };
    },
    clickBackendNode: async () => undefined,
  } as any;
}

test("page_ready_probe never appears => timeout", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set()), "t", base), "timeout");
});
test("logged_out_marker present => logged_out", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]", "[data-login]"])), "t", base), "logged_out");
});
test("loaded, not logged-out, logged_in_probe absent => unexpected", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]"])), "t", base), "unexpected");
});
test("loaded + logged_in_probe present => ready", async () => {
  assert.equal(await detectPageState(fakeBrowser(new Set(["[data-shell]", "[data-in]"])), "t", base), "ready");
});

test("recheck aborts recipe_page_unexpected when scope probe lost on same host", async () => {
  // page loaded ([data-shell]) but the scope-specific logged_in_probe is gone → unexpected.
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-shell]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});
test("recheck aborts bootstrap_login_required when logged_out_marker appears", async () => {
  // include [data-shell] so the staged check reaches the logged-out marker (page IS loaded).
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-shell]", "[data-login]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_login_required");
});
test("recheck aborts recipe_page_timeout when page_ready_probe is lost (full staged check, §142)", async () => {
  // host OK + logged_in_probe present, but page_ready_probe gone → the staged §4 check
  // must surface recipe_page_timeout, NOT a scope/login error (this is the §142 gap the
  // bare logged_in_probe check missed).
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-in]"])), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_timeout");
});
test("recheck aborts recipe_page_unexpected when off-host", async () => {
  await assert.rejects(() => recheckPageScope(fakeBrowser(new Set(["[data-in]"]), "evil.com"), "t", base),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});

test("pre-step click that lands wrong scope aborts before any reveal", async () => {
  const present = new Set(["nav-link", "[data-shell]"]); // logged_in_probe MISSING after the click
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "click", selector: "nav-link" }] };
  await assert.rejects(() => runPreSteps(fakeBrowser(present), "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_unexpected");
});

test("pre-step that drops page_ready_probe aborts recipe_page_timeout after the step (§142)", async () => {
  // After the click the page_ready_probe is gone (page reloaded/navigated to a non-loaded
  // state) → the full staged re-check surfaces recipe_page_timeout before any reveal.
  const present = new Set(["nav-link", "[data-in]"]); // [data-shell] MISSING after the click
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "click", selector: "nav-link" }] };
  await assert.rejects(() => runPreSteps(fakeBrowser(present), "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_page_timeout");
});

test("ambiguous (>1) wait_for selector errors recipe_selector_ambiguous; no reveal runs", async () => {
  // wait_for must enforce exactly-one (spec §103), same as click — a >1 match is rejected.
  const ambiguousBrowser = {
    ...fakeBrowser(new Set(["[data-shell]", "[data-in]"])),
    waitForSelector: async () => true,        // selector appears…
    selectorMatchCount: async (_t: string, sel: string) => (sel === "dupes" ? 2 : 1), // …but matches twice
  } as any;
  const recipe: RecipeBase = { ...base, pre_steps: [{ action: "wait_for", selector: "dupes" }] };
  await assert.rejects(() => runPreSteps(ambiguousBrowser, "t", recipe),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/page-state.test.js"`
Expected: FAIL ("Cannot find module './page-state.js'").

- [ ] **Step 3: Implement**

```ts
// src/daemon/recipes/page-state.ts
import { ShuttleError } from "../../shared/errors.js"; // match the real path/export
import type { BrowserOps } from "../chrome/internal-ops.js";
import type { RecipeBase } from "./types.js";

export type PageState = "ready" | "logged_out" | "timeout" | "unexpected";

function canon(host: string): string { return host.trim().toLowerCase().replace(/\.$/, ""); }

/** §4 staged detection, evaluated in order, BEFORE resolving any recipe selector. */
export async function detectPageState(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<PageState> {
  if (recipe.page_ready_probe !== undefined) {
    const ready = await browser.waitForSelector(targetId, recipe.page_ready_probe, recipe.ready_timeout_ms ?? 10_000);
    if (!ready) return "timeout";
  }
  if (recipe.logged_out_marker !== undefined) {
    if ((await browser.selectorMatchCount(targetId, recipe.logged_out_marker)) >= 1) return "logged_out";
  }
  if ((await browser.selectorMatchCount(targetId, recipe.logged_in_probe)) >= 1) return "ready";
  return "unexpected";
}

/** Map the initial detection enum to the §Error-codes ShuttleError (page-state class). */
export function pageStateError(state: Exclude<PageState, "ready">, recipe: RecipeBase): ShuttleError {
  if (state === "timeout") return new ShuttleError("recipe_page_timeout", `Page never loaded: ${recipe.host} ${recipe.url}.`);
  if (state === "logged_out") return new ShuttleError("bootstrap_login_required", `Log into ${recipe.host} in the open window, then re-run --continue.`);
  return new ShuttleError("recipe_page_unexpected", `Loaded ${recipe.host} but the expected scope was not found (wrong project/team, permission, or onboarding). Inspect the open tab.`);
}

/** §1/§4: full staged page-state revalidation. Runs after each pre-step and immediately
 *  before reveal/inject. This reruns the SAME staged §4 check `detectPageState` performs
 *  (page_ready_probe → logged_out_marker → logged_in_probe) plus a live host check, and
 *  maps any non-`ready` outcome to its distinct page-state-class ShuttleError via
 *  `pageStateError`. It does NOT collapse to a bare logged_in_probe presence test — spec
 *  §142 requires the full staged check (incl. page_ready_probe) after each pre-step so a
 *  page that drifted to a non-loaded/timeout state is surfaced as `recipe_page_timeout`,
 *  not a misleading scope/login error. */
export async function recheckPageScope(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<void> {
  const host = canon(await browser.documentHost(targetId));
  if (host !== canon(recipe.host)) {
    throw new ShuttleError("recipe_page_unexpected", `Recipe drifted off-host: now ${host}, expected ${canon(recipe.host)}.`);
  }
  // Rerun the full staged §4 detection (page_ready_probe → logged_out_marker →
  // logged_in_probe). Reuse detectPageState so the after-each-step check and the initial
  // gate stay identical (spec §142). Any non-ready state → its specific page-state error.
  const state = await detectPageState(browser, targetId, recipe);
  if (state !== "ready") throw pageStateError(state, recipe);
}

/** §1: run pre_steps (navigation only). Each click AND each wait_for is
 *  single-match-or-throw (recipe_selector_ambiguous) — a pre-step never guesses among
 *  matches (spec §103: every pre-step click/wait_for selector must resolve to exactly
 *  one element). After EACH step the full §4 staged scope re-check runs so a same-host
 *  scope drift (or a page-ready loss) aborts before any secret action. Idempotent/
 *  re-runnable by contract (authors' responsibility). */
export async function runPreSteps(browser: BrowserOps, targetId: string, recipe: RecipeBase): Promise<void> {
  for (const step of recipe.pre_steps ?? []) {
    if (step.action === "wait") {
      await new Promise((r) => setTimeout(r, Math.max(0, step.ms)));
    } else if (step.action === "wait_for") {
      // Presence-then-single-match: wait (bounded) for the selector to appear, then
      // require EXACTLY ONE match (spec §103). >1 matches → recipe_selector_ambiguous,
      // identical to the click path — wait_for must not accept an ambiguous selector.
      const ok = await browser.waitForSelector(targetId, step.selector, step.timeout_ms ?? 10_000);
      if (!ok) throw new ShuttleError("recipe_selector_ambiguous", `pre-step wait_for never matched: ${step.selector}`);
      const count = await browser.selectorMatchCount(targetId, step.selector);
      if (count !== 1) throw new ShuttleError("recipe_selector_ambiguous", `pre-step wait_for selector matched ${count} elements (need exactly 1): ${step.selector}`);
    } else {
      // click: single-match-or-throw, then click
      const ref = await browser.resolveSelectorToHandle(targetId, step.selector);
      await browser.clickBackendNode({ target_id: ref.target_id, backend_node_id: ref.backend_node_id });
    }
    await recheckPageScope(browser, targetId, recipe); // §4 staged re-check after each step
  }
}
```

> `recheckPageScope` now delegates the staged check to `detectPageState` (defined above), so the after-each-step revalidation is byte-identical to the initial gate. Keep the `documentHost` host check first — `detectPageState` does not verify host equality, only the probes.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/page-state.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/recipes/page-state.ts src/daemon/recipes/page-state.test.ts
git commit -m "feat(recipes): staged page-state detection + pre-step safety contract (§4/§1)"
```

## Task 7: Capture-recipe execution in `runCaptureStep`

Insert a recipe attempt after `openCaptureTarget` (executor.ts:608-609). On a recipe **value**, set `captured` and fall through to the **existing** cleanup + state machine (so success reuses the vetted upsert path unchanged). On **failure**, `attemptRecipeCapture` owns the §5 tab/blind lifecycle and returns a ready `CaptureStepOutcome`. No-recipe hosts and `human_paste` keep today's human-pending flow untouched.

**Files:**
- Create: `src/daemon/bootstrap/recipe-capture.ts`
- Modify: `src/daemon/bootstrap/executor.ts` (`runCaptureStep`; `ExecutorDeps`)
- Test: `src/daemon/bootstrap/recipe-capture.test.ts`

- [ ] **Step 1: Write `attemptRecipeCapture` + its failing test**

Test the gate + the §5 tab-lifecycle split with a fake browser + fake `cleanupCaptureTarget`. Reuse the `executor-capture.test.ts` fixtures (`setupFixture`, `makeDeps`, the `BrowserSession` fake) as a base.

```ts
// src/daemon/bootstrap/recipe-capture.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptRecipeCapture } from "./recipe-capture.js";
import type { CaptureRecipe } from "../recipes/types.js";
import { isShuttleError } from "../../shared/errors.js";

const recipe: CaptureRecipe = {
  kind: "capture", host: "stripe.test", url: "https://stripe.test/keys",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  reveal_selector: "#reveal", field_selector: "#sk", hide_selector: "#hide", ready_timeout_ms: 50,
};

// Build a ctx with a fake browser, fake cdp, spy blind, spy cleanup.
function makeCtx(over: { present: Set<string>; gateValue?: string; gateThrow?: string; cleanupVerified?: boolean; cleanupThrows?: boolean }) {
  const events: string[] = [];
  const browser = {
    waitForSelector: async (_t: string, s: string) => over.present.has(s),
    selectorMatchCount: async (_t: string, s: string) => (over.present.has(s) ? 1 : 0),
    documentHost: async () => "stripe.test",
    resolveSelectorToHandle: async (_t: string, s: string) => {
      if (!over.present.has(s)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous", name: "ShuttleError" });
      // Give #hide a distinct backend_node_id so clickBackendNode can label the hide attempt.
      return { target_id: "t", backend_node_id: s === "#hide" ? 99 : 1, fingerprint: "fp" };
    },
    clickBackendNode: async (ref: { backend_node_id: number }) => { events.push(ref.backend_node_id === 99 ? "hide" : "click"); },
    baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
    resolveWithinContainer: async () => {
      if (over.gateThrow) throw Object.assign(new Error(over.gateThrow), { code: over.gateThrow, name: "ShuttleError" });
      return { value: over.gateValue ?? "" };
    },
  } as any;
  const blind = { end: () => events.push("blind.end") };
  const services = {
    blind, vault: { upsertSecret: async () => ({ ref: "ss://x", fingerprint: "fp" }) },
    browserSession: { browser, cdp: {}, proxy: { severAgentConnections: () => undefined } },
  } as any;
  // Inject a fake cleanupCaptureTarget that records ordering and returns verified (or REJECTS).
  const cleanup = async () => {
    events.push("cleanup(close)");
    if (over.cleanupThrows) throw new Error("close failed"); // §170: rejection must be handled
    return { verified: over.cleanupVerified ?? true };
  };
  return { events, ctx: { browser, cdp: {}, target_id: "t", expectedHost: "stripe.test", services, entry: { secret: "STRIPE_SK", ref: "ss://stripe/prod/STRIPE_SK", destinations: [] }, cleanupCaptureTarget: cleanup } };
}

test("ready + value => kind:value, tab left open for shared cleanup (no blind.end here)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateValue: "sk_live_abc" });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal(r.kind, "value");
  assert.equal((r as any).value, "sk_live_abc");
  assert.ok(!events.includes("blind.end")); // success defers blind.end to the state machine
  assert.ok(!events.includes("cleanup(close)")); // success defers cleanup to the state machine
});

test("login wall => page-state class: blind.end + tab LEFT OPEN + stopWith", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-login]"]) });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal(r.kind, "outcome");
  assert.equal((r as any).outcome.stepResult.error_code, "bootstrap_login_required");
  assert.ok(events.includes("blind.end"));
  assert.ok(!events.includes("cleanup(close)")); // tab NOT closed (login/inspect surface)
});

test("no-transition => secret-bearing: hide → cleanup(close) BEFORE blind.end + recipe_capture_failed (reason carried)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateThrow: "reveal_no_transition" });
  const r = await attemptRecipeCapture(recipe, ctx as any);
  // raw gate code reveal_no_transition is WRAPPED as recipe_capture_failed (does not leak)…
  assert.equal((r as any).outcome.stepResult.error_code, "recipe_capture_failed");
  // …but the underlying reason is carried in the message.
  assert.ok((r as any).outcome.stepResult.message.includes("reveal_no_transition"));
  // §173: hide_selector is attempted BEFORE the tab is closed.
  assert.ok(events.indexOf("hide") < events.indexOf("cleanup(close)"));
  assert.ok(events.indexOf("cleanup(close)") < events.indexOf("blind.end")); // close BEFORE blind.end
});

test("ambiguous reveal selector => secret-bearing: cleanup(close) before blind.end (no hide: never resolved)", async () => {
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#sk", "#hide"]) }); // #reveal missing
  const r = await attemptRecipeCapture(recipe, ctx as any);
  assert.equal((r as any).outcome.stepResult.error_code, "recipe_selector_ambiguous"); // passthrough, NOT wrapped
  assert.ok(!events.includes("hide")); // reveal_selector resolution threw before hideRef was resolved
  assert.ok(events.indexOf("cleanup(close)") < events.indexOf("blind.end"));
});

test("cleanup REJECTS on a secret-bearing failure => treated as unverified: blind ACTIVE, deterministic bootstrap_capture_cleanup_failed (no throw escapes) + cleanup reason preserved", async () => {
  // §170: a throwing cleanup must STILL reach a defined end-state. attemptRecipeCapture must
  // RESOLVE (not reject) with the cleanup-failed outcome; blind is left active (fail-closed)
  // and the value never entered the vault. Without catching the rejection, it would propagate
  // out of the function before blind.end/audit/return. The cleanup rejection text MUST be
  // preserved in the returned message — it is the operator-facing diagnostic for why the
  // tab couldn't be verified clean (without it, only the recipe code surfaces and the
  // sensitive cleanup failure has no actionable reason attached).
  const { events, ctx } = makeCtx({ present: new Set(["[data-shell]", "[data-in]", "#reveal", "#sk", "#hide"]), gateThrow: "reveal_no_transition", cleanupThrows: true });
  const r = await attemptRecipeCapture(recipe, ctx as any); // does not throw
  assert.equal(r.kind, "outcome");
  assert.ok(events.includes("cleanup(close)")); // close was attempted
  assert.ok(!events.includes("blind.end"));     // blind stays ACTIVE when cleanup throws
  assert.equal((r as any).outcome.stepResult.error_code, "bootstrap_capture_cleanup_failed");
  // The cleanup rejection text ("close failed", thrown by the fake cleanup above) is
  // preserved in the returned/audited message alongside the recipe failure code, so the
  // operator can see BOTH "what went wrong with the recipe" AND "why cleanup didn't verify".
  const msg = (r as any).outcome.stepResult.message as string;
  assert.ok(msg.includes("recipe_capture_failed"), `expected recipe code in message, got: ${msg}`);
  assert.ok(msg.includes("close failed"), `expected cleanup rejection text in message, got: ${msg}`);
  assert.ok(msg.includes("blind kept active"), `expected blind-state hint in message, got: ${msg}`);
});
```

> Inject `cleanupCaptureTarget` via the ctx (as above) so the test can assert close-vs-blind.end ordering. In the real wiring it's the module's `cleanupCaptureTarget`; expose it as an optional ctx field defaulting to the real import.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-capture.test.js"`
Expected: FAIL ("Cannot find module './recipe-capture.js'").

- [ ] **Step 3: Implement `attemptRecipeCapture`**

```ts
// src/daemon/bootstrap/recipe-capture.ts
import { ShuttleError } from "../../shared/errors.js";
import { writeDaemonAudit } from "<the module executor.ts imports writeDaemonAudit from>";
import { cleanupCaptureTarget as realCleanup } from "../chrome/capture-target-ops.js"; // match the real export site
import { captureWithTransitionGate, withDeadline } from "../chrome/secret-gates.js";
import { detectPageState, pageStateError, recheckPageScope, runPreSteps } from "../recipes/page-state.js";
import type { CaptureRecipe } from "../recipes/types.js";
import type { BrowserOps } from "../chrome/internal-ops.js";
import type { CaptureStepOutcome } from "./executor.js"; // or wherever the type lives

const PAGE_STATE_CODES = new Set(["bootstrap_login_required", "recipe_page_timeout", "recipe_page_unexpected"]);

export type RecipeCaptureResult =
  | { kind: "value"; value: string; field_fingerprint: string }
  | { kind: "outcome"; outcome: CaptureStepOutcome };

export interface RecipeCaptureCtx {
  browser: BrowserOps;
  cdp: unknown; // CdpClient | null (mirror executor's type)
  target_id: string;
  expectedHost: string;
  services: { blind: { end: () => void }; vault: unknown };
  entry: { secret: string; ref: string; destinations: { domain: string }[] };
  cleanupCaptureTarget?: (cdp: unknown, target_id: string) => Promise<{ verified: boolean }>;
}

// Selector-resolution failures stay as their own clear error; every other secret-bearing
// reveal-class failure (the gate's reveal_no_transition / capture timeout / empty value) is
// surfaced as recipe_capture_failed carrying the underlying reason, per §5 + the test bar.
const SECRET_BEARING_PASSTHROUGH = new Set(["recipe_selector_ambiguous"]);

export async function attemptRecipeCapture(recipe: CaptureRecipe, ctx: RecipeCaptureCtx): Promise<RecipeCaptureResult> {
  const { browser, cdp, target_id, expectedHost, services, entry } = ctx;
  const cleanup = ctx.cleanupCaptureTarget ?? realCleanup;
  const captureMode: "field" | "container" = recipe.field_selector !== undefined ? "field" : "container";
  const targetSelector = recipe.field_selector ?? recipe.container_selector!;
  // Stash the resolved hide ref so the catch can attempt hide_selector before closing the
  // tab on a reveal failure (spec §173: "attempting it when defined before closing").
  let hideRef: (BackendNodeRef & { fingerprint: string }) | undefined;
  try {
    const state = await detectPageState(browser, target_id, recipe);
    if (state !== "ready") throw pageStateError(state, recipe);

    await runPreSteps(browser, target_id, recipe);
    await recheckPageScope(browser, target_id, recipe); // immediately before reveal

    const revealRef = await browser.resolveSelectorToHandle(target_id, recipe.reveal_selector);
    const targetRef = await browser.resolveSelectorToHandle(target_id, targetSelector);
    hideRef = recipe.hide_selector !== undefined
      ? await browser.resolveSelectorToHandle(target_id, recipe.hide_selector) : undefined;

    const baselinePre = await browser.baselineCandidates({ target_id: targetRef.target_id, backend_node_id: targetRef.backend_node_id });
    const revealDeadlineMs = Number(process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS) || 30_000;
    const gate = await withDeadline(
      captureWithTransitionGate(browser, cdp as never, {
        revealRef: { target_id: revealRef.target_id, backend_node_id: revealRef.backend_node_id },
        targetRef: { target_id: targetRef.target_id, backend_node_id: targetRef.backend_node_id },
        captureMode,
        ...(hideRef !== undefined ? { hideRef: { target_id: hideRef.target_id, backend_node_id: hideRef.backend_node_id } } : {}),
        baselinePre,
      }),
      revealDeadlineMs,
      "recipe_capture_timeout",
    );
    if (gate.value === "") {
      throw new ShuttleError("recipe_capture_failed", `Recipe capture for ${recipe.host} produced no hidden→readable transition.`);
    }
    // SUCCESS — tab is hidden/clean; converge on the EXISTING cleanup + state machine.
    return { kind: "value", value: gate.value, field_fingerprint: targetRef.fingerprint };
  } catch (e) {
    const rawCode = e instanceof ShuttleError ? e.code : "recipe_capture_failed";
    const rawMessage = e instanceof Error ? e.message : String(e);
    if (PAGE_STATE_CODES.has(rawCode)) {
      // §5 page-state class: no reveal/type occurred → blind.end + LEAVE TAB OPEN (login/inspect surface).
      services.blind.end();
      await writeDaemonAudit({ action: "blind_auto_resume", ok: false, ref: entry.ref, domain: expectedHost, op: "recipe-capture", error_code: rawCode, message: rawMessage });
      return { kind: "outcome", outcome: { kind: "stopWith", stepResult: { ok: false, error_code: rawCode, message: rawMessage } } };
    }
    // §5 secret-bearing class. Selector-ambiguity keeps its own code; every other reveal-class
    // failure (gate reveal_no_transition / recipe_capture_timeout / empty value) is wrapped as
    // recipe_capture_failed carrying the underlying reason, so reveal_no_transition never leaks
    // as the step error (test "no-transition => recipe_capture_failed").
    const code = SECRET_BEARING_PASSTHROUGH.has(rawCode) ? rawCode : "recipe_capture_failed";
    const message = rawCode === code ? rawMessage : `${rawCode}: ${rawMessage}`;
    // Spec §173: attempt hide_selector (when resolved) BEFORE closing — best-effort, never
    // let a failed hide mask the real error or block cleanup.
    if (hideRef !== undefined) {
      await browser.clickBackendNode({ target_id: hideRef.target_id, backend_node_id: hideRef.backend_node_id }).catch(() => undefined);
    }
    // CLOSE the tab BEFORE blind.end (no re-observation of a possibly-revealed page).
    // A REJECTED cleanup is treated as unverified (fail-closed): catch → verified:false +
    // capture the cleanup reason. This guarantees (a) a throwing cleanup can never escape
    // attemptRecipeCapture without reaching a deterministic end-state (§170), AND (b) the
    // operator-facing message preserves the underlying close failure (e.g. "close failed"),
    // not just the recipe code — otherwise a sensitive cleanup-failed outcome would hide
    // *why* the tab couldn't be verified clean, which is the load-bearing diagnostic.
    const cleanupResult = await cleanup(cdp, target_id).then(
      (r) => ({ verified: r.verified, cleanupReason: null as string | null }),
      (err: unknown) => ({ verified: false, cleanupReason: err instanceof Error ? err.message : String(err) }),
    );
    if (cleanupResult.verified) {
      services.blind.end();
      await writeDaemonAudit({ action: "blind_auto_resume", ok: false, ref: entry.ref, domain: expectedHost, op: "recipe-capture", error_code: code, message });
      return { kind: "outcome", outcome: { kind: "stopWith", stepResult: { ok: false, error_code: code, message } } };
    }
    // cleanup not verified OR cleanup threw → blind stays ACTIVE (fail-closed), matching the
    // existing state machine; return the deterministic bootstrap_capture_cleanup_failed outcome.
    // Preserve BOTH the recipe failure code AND the cleanup reason in the message so the
    // operator can see *why* cleanup failed (the rejection text), not just the recipe error.
    const cleanupDetail = cleanupResult.cleanupReason !== null
      ? `cleanup rejected: ${cleanupResult.cleanupReason}`
      : "tab not verified clean";
    const cleanupFailedMessage = `${code}: ${cleanupDetail}; blind kept active.`;
    await writeDaemonAudit({ action: "blind_auto_resume", ok: false, ref: entry.ref, domain: expectedHost, op: "recipe-capture", error_code: "bootstrap_capture_cleanup_failed", message: cleanupFailedMessage });
    return { kind: "outcome", outcome: { kind: "stopWith", stepResult: { ok: false, error_code: "bootstrap_capture_cleanup_failed", message: cleanupFailedMessage } } };
  }
}
```

> The exact `writeDaemonAudit` import path and `CaptureStepOutcome` location come from `executor.ts` — copy its imports; `BackendNodeRef` comes from `../chrome/internal-ops.js` (same as `BrowserOps`). Three §5/§170/§173 contracts are enforced here: (1) the gate's `reveal_no_transition` (and capture-timeout / empty-value) are **wrapped as `recipe_capture_failed`** carrying the underlying reason, so the raw gate code never leaks as the step error; `recipe_selector_ambiguous` alone passes through unchanged. (2) when the recipe defines `hide_selector`, the resolved `hideRef` is **clicked (best-effort) before closing the tab** on a reveal-class failure. Per §5, the captured value never entered the vault, so this is non-destructive. (3) a **rejected** `cleanup` is caught via `.then(ok, err)` and treated as **unverified** while **capturing the cleanup rejection text** (`err.message`), so a throwing close can never propagate out of `attemptRecipeCapture` before its deterministic end-state — §170 holds even when cleanup itself fails: blind stays active (fail-closed) and the function resolves with `bootstrap_capture_cleanup_failed` whose message preserves BOTH the recipe failure code AND the underlying cleanup reason (e.g. `recipe_capture_failed: cleanup rejected: close failed; blind kept active.`). The cleanup reason is the load-bearing diagnostic for this sensitive class — without it the operator only sees the recipe code and cannot tell *why* the tab couldn't be verified clean.

- [ ] **Step 4: Wire it into `runCaptureStep`**

In `src/daemon/bootstrap/executor.ts`, immediately after `openCaptureTarget` succeeds (after line 619), and **before** the existing register→emit→await block (621), move the `captured`/`failureCode`/`failureMessage` declarations up and add the recipe branch:

```ts
  // Declarations moved up from 656-658 so both the recipe and human paths set them.
  let captured: { value: string; field_fingerprint: string } | null = null;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;

  const captureRecipe = (deps.recipes ?? recipeRegistry).getCapture(expectedHost);
  if (entry.source.kind === "capture" && captureRecipe !== undefined) {
    const r = await attemptRecipeCapture(captureRecipe, {
      browser: browserSession.browser, cdp, target_id, expectedHost, services, entry,
    });
    if (r.kind === "outcome") return r.outcome; // failure: tab + blind already handled per §5
    captured = { value: r.value, field_fingerprint: r.field_fingerprint };
    // success: tab is clean & still open → falls through to the existing cleanup + state machine
  } else {
    // ── EXISTING register → emit → await human-pending block (was 621-683) ──
    // (unchanged; it assigns captured / failureCode / failureMessage)
  }

  // ── Step 6: cleanup (686) + Step 7: state machine (688+) — UNCHANGED, shared by both paths ──
```

- Add imports to `executor.ts`: `import { attemptRecipeCapture } from "./recipe-capture.js";` and `import { recipeRegistry } from "../recipes/registry.js";`.
- Add `recipes?: RecipeRegistry;` to the `ExecutorDeps` interface (optional; real callers omit it → singleton).
- `entry.source.kind === "capture"` gates the attempt so `human_paste` (Task 10) always uses the human-pending `else` branch even if a recipe somehow existed.

- [ ] **Step 5: Run the recipe-capture test + the existing executor tests (regression)**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-capture.test.js" "dist/daemon/bootstrap/executor-capture.test.js" "dist/daemon/bootstrap/executor.test.js"`
Expected: PASS (recipe tests pass; existing executor tests unaffected — no-recipe hosts still hit the human path).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/recipe-capture.ts src/daemon/bootstrap/recipe-capture.test.ts src/daemon/bootstrap/executor.ts
git commit -m "feat(recipes): hands-off capture in runCaptureStep with §5 failure tab/blind lifecycle"
```

---

## Task 8: `browser_inject` destination kind (discriminated union)

Make `ResolvedDestination` a discriminated union so a destination can be a CLI template (today) **or** a `browser_inject` recipe push. Back-compat: persisted `BatchState` JSON predates `kind`, so deserialization defaults `kind: "template"`.

**Files:**
- Modify: `src/daemon/bootstrap/store.ts` (`ResolvedDestination` + load-path default)
- Modify: `src/daemon/bootstrap/plan.ts`, `src/daemon/bootstrap/destination-policy.ts`, `src/daemon/bootstrap/infer-session-pattern.ts`, `src/cli/bootstrap/destination-shorthand.ts` (narrow on `kind`)
- Test: `src/daemon/bootstrap/store.test.ts` (add a back-compat case)

- [ ] **Step 1: Write the failing back-compat test**

```ts
// add to src/daemon/bootstrap/store.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
// …use the real load/parse function this module exposes for BatchState…

test("legacy persisted destination without kind defaults to template", () => {
  const legacy = { shorthand: "vercel", template_id: "vercel-env-add", template_params: { name: "X" }, domain: "vercel.com" };
  const loaded = parseResolvedDestination(legacy as any); // match the real loader/normalizer name
  assert.equal(loaded.kind, "template");
  assert.equal(loaded.template_id, "vercel-env-add");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/store.test.js"`
Expected: FAIL (no `kind` / no normalizer).

- [ ] **Step 3: Change the type + add the back-compat default**

In `src/daemon/bootstrap/store.ts`:

```ts
export type ResolvedDestination =
  | { kind: "template"; template_id: string; template_params: Record<string, string>; shorthand: string; domain: string }
  | { kind: "browser_inject"; recipe_host: string; url_params?: Record<string, string>; shorthand: string; domain: string };
  // url_params reserved for deferred URL interpolation (§9); UNUSED in increment 1 — recipes ship a complete static url.
```

Where `BatchState` destinations are read from persisted JSON, normalize each:

```ts
function normalizeDestination(d: any): ResolvedDestination {
  if (d.kind === "browser_inject") {
    return { kind: "browser_inject", recipe_host: d.recipe_host, ...(d.url_params ? { url_params: d.url_params } : {}), shorthand: d.shorthand, domain: d.domain };
  }
  // default (incl. legacy, missing kind) → template
  return { kind: "template", template_id: d.template_id, template_params: d.template_params ?? {}, shorthand: d.shorthand, domain: d.domain };
}
```

- [ ] **Step 4: Narrow every consumer the compiler flags**

`npm run typecheck` lists each site reading `.template_id`/`.template_params` without narrowing. For each (`plan.ts`, `destination-policy.ts`, `infer-session-pattern.ts`, `destination-shorthand.ts`, `executor.ts`), guard with `if (dest.kind === "template")` first. Construction sites (plan/infer) that build template destinations must now set `kind: "template"` explicitly.

- [ ] **Step 5: Run the test + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/store.test.js"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/store.ts src/daemon/bootstrap/plan.ts src/daemon/bootstrap/destination-policy.ts src/daemon/bootstrap/infer-session-pattern.ts src/cli/bootstrap/destination-shorthand.ts
git commit -m "feat(recipes): ResolvedDestination discriminated union + browser_inject kind (back-compat default template)"
```

---

## Task 9: Recipe inject execution (`runBrowserInject`) + `runDestinationSteps` dispatch

`runDestinationSteps` switches on `dest.kind`. `template` → today's CLI push (unchanged). `browser_inject` → `runBrowserInject`: fresh blind window in the bootstrap session, open the recipe URL, §4 detection, pre-steps + rechecks, resolve field/submit, `injectWithSuccessGate`, then the §6 tab/blind lifecycle (always `blind.end` before return; close tab except on page-state failures).

**Files:**
- Create: `src/daemon/bootstrap/recipe-inject.ts`
- Modify: `src/daemon/bootstrap/executor.ts` (`runDestinationSteps`)
- Test: `src/daemon/bootstrap/recipe-inject.test.ts`

- [ ] **Step 1: Write the failing test** (assert §6 outcomes + tab lifecycle)

```ts
// src/daemon/bootstrap/recipe-inject.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrowserInject } from "./recipe-inject.js";
import type { InjectRecipe } from "../recipes/types.js";

const recipe: InjectRecipe = {
  kind: "inject", host: "vercel.test", url: "https://vercel.test/env",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  field_selector: "#val", submit_selector: "#save", success_text: "Saved", ready_timeout_ms: 50,
};

function makeDeps(over: { present: Set<string>; successObserved?: boolean; proofPassed?: boolean; injectThrow?: boolean; openTargetId?: string }) {
  const events: string[] = [];
  const browser = {
    waitForSelector: async (_t: string, s: string) => over.present.has(s),
    selectorMatchCount: async (_t: string, s: string) => (over.present.has(s) ? 1 : 0),
    documentHost: async () => "vercel.test",
    resolveSelectorToHandle: async (_t: string, s: string) => {
      if (!over.present.has(s)) throw Object.assign(new Error("amb"), { code: "recipe_selector_ambiguous", name: "ShuttleError" });
      return { target_id: "t", backend_node_id: 1, fingerprint: "fp" };
    },
    injectIntoBackendNode: async () => { if (over.injectThrow) throw new Error("inject boom"); events.push("inject"); return {} as any; },
    clickBackendNode: async () => { events.push("submit"); },
    observeText: async () => over.successObserved ?? false,
    proveAbsence: async () => ({ passed: over.proofPassed ?? false }),
  } as any;
  const blind = { start: () => events.push("blind.start"), end: () => events.push("blind.end") };
  const services = {
    blind,
    vault: { resolveSecret: async () => ({ value: { bytes: () => Buffer.from("v_secret"), dispose: () => undefined } }), markUsed: async () => undefined },
    browserSession: { browser, cdp: {}, proxy: { severAgentConnections: () => undefined } },
  } as any;
  return { events, deps: { services, daemonPortRef: () => 1, openCaptureTarget: async () => ({ target_id: over.openTargetId ?? "t" }), cleanupCaptureTarget: async () => { events.push("cleanup(close)"); return { verified: true }; } } as any };
}

test("success => ok, tab closed, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: true, proofPassed: true });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, true);
  assert.ok(events.includes("cleanup(close)") && events.includes("blind.end"));
});

test("no success_text => recipe_inject_failed, proveAbsence run, blind ended, retryable", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]), successObserved: false });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_inject_failed");
  assert.ok(events.includes("blind.end")); // §6: blind ALWAYS ended before return
});

test("login wall => bootstrap_login_required, tab LEFT OPEN, blind ended", async () => {
  const { events, deps } = makeDeps({ present: new Set(["[data-shell]", "[data-login]"]) });
  const r = await runBrowserInject(recipe, "ss://stripe/prod/X", deps);
  assert.equal(r.error_code, "bootstrap_login_required");
  assert.ok(!events.includes("cleanup(close)")); // tab left open
  assert.ok(events.includes("blind.end"));
});
```

> Inject `openCaptureTarget` / `cleanupCaptureTarget` via `deps` (optional, defaulting to the real imports) so the test can fake the tab without CDP.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-inject.test.js"`
Expected: FAIL ("Cannot find module './recipe-inject.js'").

- [ ] **Step 3: Implement `runBrowserInject`**

```ts
// src/daemon/bootstrap/recipe-inject.ts
import { ShuttleError } from "../../shared/errors.js";
import { disableObservationDomains } from "../chrome/internal-ops.js";
import { openCaptureTarget as realOpen } from "../chrome/capture-target-ops.js";
import { cleanupCaptureTarget as realCleanup } from "../chrome/capture-target-ops.js";
import { injectWithSuccessGate } from "../chrome/secret-gates.js";
import { detectPageState, pageStateError, recheckPageScope, runPreSteps } from "../recipes/page-state.js";
import type { InjectRecipe } from "../recipes/types.js";

const PAGE_STATE_CODES = new Set(["bootstrap_login_required", "recipe_page_timeout", "recipe_page_unexpected"]);
const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000; // mirror inject-submit.ts

export async function runBrowserInject(recipe: InjectRecipe, ref: string, deps: any): Promise<{ ok: boolean; error_code?: string; message?: string }> {
  const { services } = deps;
  const browserSession = services.browserSession;
  if (browserSession === null || browserSession === undefined) {
    return { ok: false, error_code: "bootstrap_plan_invalid", message: "browser_inject requires a browser session." };
  }
  const browser = browserSession.browser;
  const cdp = browserSession.cdp;
  const open = deps.openCaptureTarget ?? realOpen;
  const cleanup = deps.cleanupCaptureTarget ?? realCleanup;

  // Fresh blind window for this push (mirrors a discrete inject-submit).
  services.blind.start(recipe.host, "browser_inject");
  await disableObservationDomains(cdp).catch(() => undefined);
  browserSession.proxy?.severAgentConnections();

  let target_id: string;
  try {
    target_id = (await open(cdp, recipe.url)).target_id;
  } catch (e) {
    services.blind.end(); // pre-open fault, nothing typed
    return { ok: false, error_code: e instanceof ShuttleError ? e.code : "unexpected_error", message: e instanceof Error ? e.message : String(e) };
  }

  let resolved: { value: { bytes: () => Buffer; dispose: () => void } } | undefined;
  try {
    const state = await detectPageState(browser, target_id, recipe);
    if (state !== "ready") {
      services.blind.end(); // §6 page-state class: LEAVE TAB OPEN
      const err = pageStateError(state, recipe);
      return { ok: false, error_code: err.code, message: err.message };
    }
    await runPreSteps(browser, target_id, recipe);
    await recheckPageScope(browser, target_id, recipe);

    const fieldRef = await browser.resolveSelectorToHandle(target_id, recipe.field_selector);
    const submitRef = await browser.resolveSelectorToHandle(target_id, recipe.submit_selector);

    resolved = await services.vault.resolveSecret(ref);
    const value = resolved!.value.bytes().toString("utf8");

    let gate: { successObserved: boolean; proofPassed: boolean };
    try {
      gate = await injectWithSuccessGate(browser, {
        fieldRef: { target_id: fieldRef.target_id, backend_node_id: fieldRef.backend_node_id },
        submitRef: { target_id: submitRef.target_id, backend_node_id: submitRef.backend_node_id },
        value, domain: recipe.host, successText: recipe.success_text, successTimeoutMs: SUCCESS_TIMEOUT_DEFAULT_MS,
      });
    } catch {
      // inject/click failed or timed out → secret may be on page. §6: close tab + blind.end. Retryable.
      await services.vault.markUsed(ref).catch(() => undefined);
      await cleanup(cdp, target_id).catch(() => undefined);
      services.blind.end();
      return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host} failed before success confirmation; retryable.` };
    }

    await services.vault.markUsed(ref).catch(() => undefined);

    if (gate.successObserved && gate.proofPassed) {
      await cleanup(cdp, target_id).catch(() => undefined);
      services.blind.end();
      return { ok: true };
    }
    // §6: submit ran but no success_text — run the SAME proveAbsence teardown, then close + blind.end. Retryable.
    const proof = await browser.proveAbsence(value).catch(() => ({ passed: false }));
    await cleanup(cdp, target_id).catch(() => undefined);
    services.blind.end();
    return { ok: false, error_code: "recipe_inject_failed", message: `Inject to ${recipe.host}: success text not observed (absence_proof ${proof.passed ? "passed" : "failed"}). Retryable.` };
  } catch (e) {
    const code = e instanceof ShuttleError ? e.code : "recipe_inject_failed";
    if (PAGE_STATE_CODES.has(code)) {
      services.blind.end(); // §6 page-state class: LEAVE TAB OPEN
      return { ok: false, error_code: code, message: e instanceof Error ? e.message : String(e) };
    }
    // selector ambiguous (nothing typed; §6 treats inject tab as disposable) → close + blind.end.
    await cleanup(cdp, target_id).catch(() => undefined);
    services.blind.end();
    return { ok: false, error_code: code, message: e instanceof Error ? e.message : String(e) };
  } finally {
    resolved?.value.dispose();
  }
}
```

> Type `deps` precisely against the real `ExecutorDeps` during implementation (it's `any` above only to keep the plan terse). Reuse the real `ResolvedSecret` type for `resolved`.

- [ ] **Step 4: Dispatch in `runDestinationSteps`**

In `executor.ts` `runDestinationSteps` (808-847), branch on `dest.kind` at the top of the loop:

```ts
  for (const dest of destinations) {
    if (dest.kind === "browser_inject") {
      const recipe = (deps.recipes ?? recipeRegistry).getInject(dest.recipe_host);
      if (recipe === undefined) {
        results.push({ destination: dest.shorthand, ok: false, error_code: "recipe_not_found", message: `no inject recipe for ${dest.recipe_host}` });
        continue;
      }
      const r = await runBrowserInject(recipe, ref, deps);
      results.push({ destination: dest.shorthand, ok: r.ok, ...(r.error_code ? { error_code: r.error_code } : {}), ...(r.message ? { message: r.message } : {}) });
      continue;
    }
    // dest.kind === "template" — EXISTING CLI push (unchanged, now reading dest.template_id under the narrowed type)
    try {
      const result = await deps.runTemplate(/* …unchanged… */);
      // …unchanged…
    } catch (e) { /* …unchanged… */ }
  }
```

- Add `import { runBrowserInject } from "./recipe-inject.js";` to `executor.ts` (`recipeRegistry` already imported in Task 7).
- **Note:** nothing emits `kind: "browser_inject"` yet — destination *selection* (recipe-vs-CLI) is **Task 14**. Until then `runDestinationSteps` only ever sees `kind: "template"` (the safe default), so this dispatch branch is dormant in production but exercised by the injected fake in Step 1.

- [ ] **Step 5: Run the test + existing destination tests + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-inject.test.js" "dist/daemon/bootstrap/executor.test.js"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/recipe-inject.ts src/daemon/bootstrap/recipe-inject.test.ts src/daemon/bootstrap/executor.ts
git commit -m "feat(recipes): browser_inject destination + runBrowserInject with §6 tab/blind lifecycle"
```

## Task 10: `human_paste` source kind + OpenAI/Anthropic relabel (honesty fix §8)

With recipes landing, `kind: "capture"` now signals *"the daemon can drive a reveal."* OpenAI/Anthropic keys are create-once and **unrevealable**, so labeling them `capture` (with a keys URL) becomes a lie the moment recipe magic exists. `human_paste` honestly signals *"you supply a key you created; Secret Shuttle never reveals it."* **Mechanically `human_paste` reuses the identical human-pending capture tab** (open the URL, the human focuses the field holding their copied key, clicks Capture, the daemon reads it under blind) — it differs from `capture` only in (a) the label/messaging (no reveal promise) and (b) it is **never recipe-eligible** (Task 7 already gates the recipe attempt on `kind === "capture"`).

**Files:**
- Modify: `src/cli/provision/infer-rules.ts` (`InferredSource` union + the two rules)
- Modify: `src/cli/provision/infer-gate.ts` (`InferredPlanEntry.source` union + gate handling)
- Modify: `src/cli/provision/infer.ts` (`refFor` + `renderYml`)
- Modify: `src/cli/bootstrap/yml.ts` (`BootstrapSource` + `parseSource`)
- Modify: `src/daemon/bootstrap/store.ts` (`BootstrapSource.kind` union)
- Modify: `src/daemon/bootstrap/executor.ts` (capture entry-point at line 171)
- Modify: `src/daemon/bootstrap/destination-policy.ts` (`planRequiresCapture` at 69–72)
- Test: `src/cli/provision/infer-rules.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/provision/infer-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSourceForName } from "./infer-rules.js";

test("OpenAI/Anthropic keys infer human_paste (no reveal, not capture)", () => {
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const s = inferSourceForName(name);
    assert.equal(s.kind, "human_paste", `${name} should be human_paste, got ${s.kind}`);
  }
});

test("Stripe stays capture (revealable in dashboard)", () => {
  assert.equal(inferSourceForName("STRIPE_SECRET_KEY").kind, "capture");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/provision/infer-rules.test.js"`
Expected: FAIL (`OPENAI_API_KEY` is currently `capture`).

- [ ] **Step 3: Relabel the rules + add the union member (`infer-rules.ts`)**

Add the union member (after the `capture` member, ~line 12):

```ts
  | { kind: "capture"; url: string }
  | { kind: "human_paste"; url: string }   // create-once / unrevealable: human supplies a key they made; daemon never reveals
```

Change the OpenAI rule (46–48) and the Anthropic rule (49–52) to `human_paste` (keep the keys URL — it's where the human gets the key to copy):

```ts
  {
    test: (n) => n === "OPENAI_API_KEY",
    source: { kind: "human_paste", url: "https://platform.openai.com/api-keys" },
  },
  {
    test: (n) => n === "ANTHROPIC_API_KEY",
    source: { kind: "human_paste", url: "https://console.anthropic.com/settings/keys" },
  },
```

> The random-fallback regex (line 68) excludes `^(…|OPENAI|ANTHROPIC|…)_`, and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` end in `_KEY` (not `_SECRET`/`_TOKEN`) — so neither sweeps into `random_32_bytes`. No change needed there.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/provision/infer-rules.test.js"`
Expected: PASS

- [ ] **Step 5: Thread `human_paste` through the consumers (typecheck-driven)**

`npm run typecheck` will now flag each site that switches on `source.kind`. Apply these exact edits — at every gate/flow point, `human_paste` behaves **like `capture`** (it carries a `url` and uses the human-pending capture tab):

**(a) `infer-gate.ts`** — extend the union (22–27) and the URL gate. Add `| { kind: "human_paste"; url?: string }` to `InferredPlanEntry.source`, and broaden the capture branch (54–64):

```ts
    if (e.source.kind === "capture" || e.source.kind === "human_paste") {
      if (typeof e.source.url !== "string" || e.source.url.length === 0) {
        issues.push({ secret: e.secret, issue: `${e.source.kind} source missing required url` });
        continue;
      }
      const urlCheck = validateCaptureUrl(e.source.url);
      if (!urlCheck.ok) {
        issues.push({ secret: e.secret, issue: `${e.source.kind} url invalid: ${urlCheck.reason}` });
        continue;
      }
    }
```

Also update the `unknown` hint string (line 51) to list the kind: `"source: unknown — pick a kind (capture, human_paste, random_32_bytes, existing)"`.

**(b) `infer.ts`** — `refFor` (247) and `renderYml` (267–275). Broaden the namespace derivation:

```ts
  if ((source.kind === "capture" || source.kind === "human_paste") && typeof source.url === "string") {
    const host = new URL(source.url).host;
    const providerHint = host.split(".").slice(-2, -1)[0] ?? "local";
    return `ss://${providerHint}/prod/${name}`;
  }
```

Add a `renderYml` emit branch (before the `capture` branch):

```ts
    } else if (e.source.kind === "human_paste") {
      const url = (e.source as { url?: string }).url ?? "";
      lines.push(`    source: { kind: human_paste, url: "${url}" }  # you supply this key; Secret Shuttle never reveals it`);
    } else if (e.source.kind === "capture") {
      // …unchanged…
```

**(c) `cli/bootstrap/yml.ts`** — extend `BootstrapSource` (6–10) with `| { kind: "human_paste"; url: string; expected_host: string }`, and merge the `parseSource` capture branch (69–85) so it accepts both kinds:

```ts
  if (kind === "capture" || kind === "human_paste") {
    if (typeof s.url !== "string" || s.url.length === 0) {
      fail(`secrets.${secretName}.source: kind=${kind} requires url`);
    }
    const result = validateCaptureUrl(s.url);
    if (!result.ok) {
      throw new ShuttleError(
        "bootstrap_capture_url_invalid",
        `secrets.${secretName}.source.url ${result.reason}`,
      );
    }
    return { kind, url: s.url, expected_host: result.host }; // kind narrowed to "capture" | "human_paste"
  }
```

**(d) `store.ts`** — add `"human_paste"` to the flat `BootstrapSource.kind` union (line 5); `url` is already optional and shared, so nothing else changes:

```ts
  kind: "capture" | "human_paste" | "random_32_bytes" | "random_64_bytes" | "existing";
```

**(e) `executor.ts`** — the capture entry-point (line 171) routes `human_paste` into `runCaptureStep` (the human-pending flow):

```ts
    if (
      (entry.source.kind === "capture" || entry.source.kind === "human_paste") &&
      prior?.ref === undefined
    ) {
```

`runCaptureStep` reads `entry.source.url` to open the tab (`BootstrapSource.url` is optional on the flat type, so `.url` stays accessible). Task 7's recipe gate (`entry.source.kind === "capture"`) ensures `human_paste` always takes the human-pending `else` branch — never a recipe. The `runSourceStep` capture-bypass guard (426–433) is unreached for `human_paste` (handled in the outer loop); the defensive `unknown source.kind` throw (439) need not change.

**(f) `destination-policy.ts`** — `planRequiresCapture` (69–72) must treat `human_paste` as interactive too (it needs the same browser tab + approval gate, else a `human_paste`-only dev plan would inline-execute and hang):

```ts
  return plan.some(
    (entry) => entry.source.kind === "capture" || entry.source.kind === "human_paste",
  );
```

- [ ] **Step 6: Run the full affected surface + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/provision/infer-rules.test.js" "dist/cli/provision/infer-gate.test.js" "dist/cli/bootstrap/yml.test.js" "dist/daemon/bootstrap/destination-policy.test.js"`
Expected: PASS (run whichever of those test files exist; `npm run typecheck` must be clean — it proves every `source.kind` consumer was narrowed).

- [ ] **Step 7: Commit**

```bash
git add src/cli/provision/infer-rules.ts src/cli/provision/infer-rules.test.ts src/cli/provision/infer-gate.ts src/cli/provision/infer.ts src/cli/bootstrap/yml.ts src/daemon/bootstrap/store.ts src/daemon/bootstrap/executor.ts src/daemon/bootstrap/destination-policy.ts
git commit -m "feat(recipes): honest human_paste source kind; relabel OpenAI/Anthropic (no fake reveal)"
```

---

## Task 11: Author the Stripe capture + Vercel inject recipes (via `browser-harness`)

Selectors are **discovered against real logged-in pages**, not invented. This task runs `browser-harness` to find stable selectors, fills the two builtin recipe constants, wires `registerBuiltinRecipes`, and records the dogfood date. The unit test asserts the **structural §4 bar** (all three probes defined) — the selector *values* are the dogfood deliverable.

**Files:**
- Create: `src/daemon/recipes/builtin/stripe-capture.ts`
- Create: `src/daemon/recipes/builtin/vercel-inject.ts`
- Create: `src/daemon/recipes/builtin/index.ts` (`registerBuiltinRecipes`)
- Modify: `src/daemon/recipes/registry.ts` (call `registerBuiltinRecipes` on the singleton)
- Test: `src/daemon/recipes/builtin/builtin.test.ts`

- [ ] **Step 1: Explore the real pages with `browser-harness`** (no code yet — this produces the selectors)

`browser-harness` is on `$PATH` and drives the user's logged-in Chrome (the user is logged into Vercel; for Stripe, confirm the dashboard session or ask the user to log in). For **each** recipe, capture: the secret/field control, the reveal or submit control, a `page_ready_probe` (any always-present shell element), a `logged_out_marker` (an element unique to the provider's login screen), a `logged_in_probe` (an element that proves the authenticated *scope* you expect), and (inject) the `success_text`.

Vercel inject (env-add form) — explore the logged-in env settings page:

```bash
browser-harness -c '
new_tab("https://vercel.com/dashboard")
wait_for_load()
print(page_info())
capture_screenshot()
'
```

Then navigate to the project's Environment Variables page and inspect the add-value input, the Save control, and the post-save confirmation text. Prefer `data-*`/`aria-*`/`role`/semantic selectors; **never** ship CSS-module hash classes (e.g. `.styles_input__a1B2c`). Record the success text verbatim.

Stripe capture (secret key reveal) — explore the dashboard API-keys page:

```bash
browser-harness -c '
new_tab("https://dashboard.stripe.com/apikeys")
wait_for_load()
print(page_info())
capture_screenshot()
'
```

Find the "Reveal"/"Reveal test key" control, the element that then holds the revealed key (input vs. text node → decides `field_selector` vs. `container_selector`), and an optional hide control.

> If a provider page is behind login in the bootstrap context, that's expected — the recipe's `logged_out_marker` is exactly the selector that detects it. Capture that selector during exploration too.

- [ ] **Step 2: Write the structural test (the objective gate) — and watch it fail**

```ts
// src/daemon/recipes/builtin/builtin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripeCapture } from "./stripe-capture.js";
import { vercelInject } from "./vercel-inject.js";
import { RecipeRegistry } from "../registry.js";
import { registerBuiltinRecipes } from "./index.js";

// §4 bar: every shipped recipe defines all THREE probes (no regression to the
// collapsed single-probe "log in and re-run" behavior).
for (const r of [stripeCapture, vercelInject]) {
  test(`${r.host} (${r.kind}) defines all three probes + dogfood date`, () => {
    assert.ok(r.page_ready_probe, "page_ready_probe required");
    assert.ok(r.logged_out_marker, "logged_out_marker required");
    assert.ok(r.logged_in_probe, "logged_in_probe required");
    assert.ok(r.verified_against_real_page, "verified_against_real_page (dogfood date) required");
  });
}

test("registerBuiltinRecipes wires both directions by host", () => {
  const reg = new RecipeRegistry();
  registerBuiltinRecipes(reg);
  assert.equal(reg.getCapture(stripeCapture.host)?.kind, "capture");
  assert.equal(reg.getInject(vercelInject.host)?.kind, "inject");
});
```

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/builtin/builtin.test.js"`
Expected: FAIL ("Cannot find module './stripe-capture.js'").

- [ ] **Step 3: Write the two recipe constants** (fill selectors from Step 1; the shape is fixed)

```ts
// src/daemon/recipes/builtin/stripe-capture.ts
import type { CaptureRecipe } from "../types.js";

// Selectors below are PLACEHOLDERS to replace with the values discovered in
// Step 1 against the real dashboard. Prefer data-*/aria-*/role/semantic; do
// NOT ship CSS-module hash classes. Use field_selector XOR container_selector.
export const stripeCapture: CaptureRecipe = {
  kind: "capture",
  host: "dashboard.stripe.com",
  url: "https://dashboard.stripe.com/apikeys",
  page_ready_probe: "<discovered: always-present shell element>",
  logged_out_marker: "<discovered: element unique to the Stripe login screen>",
  logged_in_probe: "<discovered: element proving the API-keys scope is loaded>",
  reveal_selector: "<discovered: the Reveal/Show control>",
  field_selector: "<discovered: input holding the revealed key>", // OR container_selector
  hide_selector: "<discovered: optional Hide control, omit if none>",
  ready_timeout_ms: 15000,
  verified_against_real_page: "<set to today's ISO date when you dogfood it>",
};
```

```ts
// src/daemon/recipes/builtin/vercel-inject.ts
import type { InjectRecipe } from "../types.js";

// Increment-1 recipe targets a SINGLE STATIC project URL (browser-only users /
// the dogfood project). Arbitrary-project support needs the deferred URL-param
// scheme (spec §9) — keep the CLI `vercel-env-add` template as the general path.
export const vercelInject: InjectRecipe = {
  kind: "inject",
  host: "vercel.com",
  url: "<discovered: the static project Environment Variables add-value URL>",
  page_ready_probe: "<discovered: always-present shell element>",
  logged_out_marker: "<discovered: element unique to the Vercel login screen>",
  logged_in_probe: "<discovered: element proving the project env page is loaded>",
  field_selector: "<discovered: the value input>",
  submit_selector: "<discovered: the Save control>",
  success_text: "<discovered: verbatim post-save confirmation text>",
  ready_timeout_ms: 15000,
  verified_against_real_page: "<set to today's ISO date when you dogfood it>",
};
```

> These `<discovered: …>` strings are not optional placeholders to leave in — the recipe is the deliverable. Each MUST be replaced with a real selector/URL/text from Step 1, and `verified_against_real_page` set to the date you confirmed the recipe drove the real page end-to-end. The structural test only checks the fields are *present*; correctness is the human dogfood step (it feeds the README "Real-page verified" column in Task 12).

- [ ] **Step 4: Wire `registerBuiltinRecipes` + the singleton**

```ts
// src/daemon/recipes/builtin/index.ts
import type { RecipeRegistry } from "../registry.js";
import { stripeCapture } from "./stripe-capture.js";
import { vercelInject } from "./vercel-inject.js";

export function registerBuiltinRecipes(registry: RecipeRegistry): void {
  registry.registerCapture(stripeCapture);
  registry.registerInject(vercelInject);
}
```

In `src/daemon/recipes/registry.ts`, replace the commented line left in Task 2 with the real call (type-only import of `RecipeRegistry` inside `builtin/index.ts` means no runtime import cycle):

```ts
import { registerBuiltinRecipes } from "./builtin/index.js";
export const recipeRegistry = new RecipeRegistry();
registerBuiltinRecipes(recipeRegistry);
```

- [ ] **Step 5: Run the structural test + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/builtin/builtin.test.js" "dist/daemon/recipes/registry.test.js"`
Expected: PASS

- [ ] **Step 6: Contribute findings back to `browser-harness`**

Per the spec §10 + the `browser-harness` "always contribute back" rule, open a PR (or add files) to `agent-workspace/domain-skills/stripe/` and `agent-workspace/domain-skills/vercel/` capturing the durable selectors, the env-add success text, and any framework quirks you hit. Do **not** write secrets, cookies, or raw pixel coordinates.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/recipes/builtin/ src/daemon/recipes/registry.ts
git commit -m "feat(recipes): ship Stripe capture + Vercel inject recipes (real-page verified)"
```

---

## Task 12: README unified coverage matrix (replaces `[P2a]`, §7)

Replace the single `[P2a] PENDING` bullet at `README.md:138` with the spec §7 table covering **all** mechanisms (browser recipes + CLI templates) so a reader sees exactly what's automated and how. This is the progress tracker requested at design review.

**Files:**
- Modify: `README.md` (replace the line-138 bullet)

- [ ] **Step 1: Replace the bullet with the matrix**

Delete the `- Real-page browser gates ([P2a] PENDING): …` bullet (line 138) and insert:

```markdown
### Provider coverage

What's automated, by provider and direction. Browser recipes drive the page hands-off (one approval); CLI templates push via the vendor CLI. "Real-page verified" is a human-attested dogfood date (CI has no provider creds).

| Provider | Direction | Mechanism | Status | Real-page verified | Notes |
|---|---|---|---|---|---|
| Stripe | capture (secret key) | browser recipe | 🆕 this increment | (set on dogfood) | revealable in dashboard |
| Supabase | capture (service_role) | browser recipe | ⬜ planned | — | revealable in settings/api |
| OpenAI / Anthropic | capture | human-paste | n/a | n/a | create-once; cannot be revealed |
| Vercel | inject (env) | browser recipe **and** CLI (`vercel-env-add`) | CLI shipped; recipe 🆕 this increment | (set on dogfood) | CLI push is the robust, project-general default. The increment-1 recipe targets a **single static project URL** (browser-only users / dogfood project); arbitrary-project support needs the deferred URL-param scheme. |
| GitHub Actions | inject (secret) | CLI (`github-actions-secret-set`) | ✅ shipped | n/a | repo-scoped only |
| Cloudflare | inject (secret) | CLI (`cloudflare-secret-put`) | ✅ shipped | n/a | |
| Supabase edge | inject (secret) | CLI (`supabase-edge-secret-set`) | ✅ shipped | n/a | |

The absence proof stays conservatively fail-closed for every mechanism — "best-effort" means "auto-resume may not succeed on every page", never "the secret may leak". Every new provider is a new row.
```

> Set the two "(set on dogfood)" cells to the actual `verified_against_real_page` dates from Task 11 once the recipes are dogfooded. Confirm the four CLI template-id strings against `src/daemon/api/routes/templates.ts` before committing (they must match the shipped template registry exactly — the matrix is an honesty artifact, so a wrong id is a real bug).

- [ ] **Step 2: Verify the doc-scan/tests still pass**

Run: `npm test` (the demo/README drift guards run here). If a README link-check or the demo command-scan flags anything, fix it.
Expected: PASS (the matrix adds no command references the scanner doesn't already know).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: unified provider coverage matrix (recipes + CLI), replaces P2a"
```

---

## Task 13: Demo scene-0 + README honesty copy (§8)

State the honest steady state in the demo's first scene and the README: the one-time login per provider, then one approval for recipe-covered providers. The demo drift-guard only checks command existence, **not** narrative truth, so this copy is the actual safeguard against over-promising.

**Files:**
- Modify: `demo/index.html` (scene-0 copy, ~1217–1218)
- Modify: `README.md` (near the coverage matrix / intro)

- [ ] **Step 1: Update demo scene 0**

In `demo/index.html`, in the `data-scene="0"` block, append the honesty line to the `<p class="copy">` (1217) or the `<div class="watch">` (1218). Add this sentence verbatim (spec §8 copy):

```html
<p class="copy"><b>First time per provider, log in once in the Secret Shuttle browser.</b> After that, one approval ships everything for providers with a recipe (see the coverage matrix). Providers that can't be revealed (e.g. OpenAI/Anthropic keys) are human-paste — you supply a key you created.</p>
```

> Place it as a new `<p class="copy">` immediately after the existing one so the magic-path claim is qualified in the same viewport. Do not remove the existing "agent never sees a value" watch line.

- [ ] **Step 2: Mirror the line in the README**

Add the same steady-state sentence to the README intro (just above the coverage matrix from Task 12), so the README and demo tell the identical story:

```markdown
> **The honest steady state:** the first time you use a provider, you log in once in the Secret Shuttle browser. After that, one approval ships everything for providers with a recipe (see the coverage matrix above). Providers whose secrets can't be revealed (OpenAI/Anthropic) are human-paste — you supply a key you created; the daemon never reveals it.
```

- [ ] **Step 3: Run the demo/README drift guards**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/demo-command-scan.test.js"` (or `npm test` for the whole guard set).
Expected: PASS — the copy introduces no new command/flag tokens, so the command-scan is unaffected; this step confirms no accidental command-shaped text was added.

- [ ] **Step 4: Commit**

```bash
git add demo/index.html README.md
git commit -m "docs: honest steady-state copy (one-time login, then one approval) in demo + README"
```

---

## Task 14: `browser_inject` selection in `computeBootstrapPlan` (recipe-vs-CLI, §6/§253)

Tasks 8–9 made `browser_inject` *representable* and *executable*; this task decides **when** a destination becomes `browser_inject` instead of `template`. Per spec §6 (line 200) + the §Test bar item: pick `browser_inject` **only** when (a) an inject recipe exists for the destination host, **and** (b) no CLI is configured for it, **and** (c) the destination is covered by the recipe's static URL. Otherwise keep the CLI template (the robust, project-general default).

**§Test-bar narrowing for increment 1 — what "no CLI configured" *operationally* means here.** The spec frames CLI push as needing the CLI installed *and* authed with a token (spec §25), and the §Test bar item names "no CLI token/template configured" as the browser-inject trigger. Increment 1 deliberately implements only **the first half** of that condition: it checks **"vendor CLI binary present on `PATH`"** as the proxy for "CLI configured". Per-vendor token/login probing (`vercel whoami`, `stripe config --list`, etc.) is **deferred to a follow-on increment** — see the §Limitations footer of this task.

This is an *explicit, conservative narrowing*, NOT a bug: it errs toward the existing CLI-template path. An installed-but-logged-out vendor CLI still counts as "configured" → routes to the CLI template → the user sees the vendor's **own** auth error message (e.g. `Error! No existing credentials found. Please run \`vercel login\``). That is a clear, actionable, vendor-canonical message; no secret leaks; no silent browser-inject substitution. The cost is that an installed-but-unauthed CLI does not auto-fall-through to the browser recipe; the user must either auth the CLI (the official path) or uninstall it (the browser-recipe path). The benefit is a tiny, testable signal with no false positives — `resolveBinary(...)` is the same primitive the existing CLI templates already use, so we ship one shared check rather than four divergent per-vendor probes.

**Increment-1 signals (honest + detectable):**
- **(a)** `recipes.getInject(canonHost)` returns a recipe.
- **(b)** the vendor CLI binary is **not resolvable on `PATH`** (`resolveBinary(t.binary)` throws) — i.e. a browser-only user who never installed the vendor CLI. **This is increment 1's deliberate narrowing of spec §25 / §253's "no CLI token/template configured"**: per-vendor auth probing is follow-on; an installed-but-unauthed CLI keeps the CLI template (and surfaces the vendor's own auth error, no leak). See §Limitations.
- **(c)** **the destination must be proven covered by the recipe's static URL** — it is **NOT** assumed. Because increment-1 inject recipes bake in a single, fully-specified project URL (§198) and URL-param interpolation is deferred (§9), an *arbitrary* user's `vercel:<env>` destination is **not** covered by the dogfood/demo project URL. Routing it to `browser_inject` would silently push the user's secret into the baked-in project — the exact hazard §200 guards against. So `browser_inject` is gated on an **explicit, opt-in coverage match** that is **scope-specific, not host-only**: the caller affirmatively confirms this *exact* `host:shorthand` destination IS the recipe's covered project (a `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` allowlist of `<recipe-host>:<shorthand>` keys, or a dogfood/config flag naming the covered host+scope). Opting in a bare host is deliberately **insufficient** — otherwise allowlisting `vercel.com` would route every Vercel shorthand to the single static URL. With no scope-specific confirmation, the destination is treated as **not covered** → CLI template. This makes the static-URL recipe usable for the dogfood/browser-only project it was authored for, without ever routing an unverified project to it.

**Safe default:** with no selection info, the plan **never** auto-picks `browser_inject` (today's CLI-always behavior is preserved exactly). `browser_inject` is chosen **only** when the caller affirmatively reports BOTH the CLI absent **and** coverage proven; missing *either* signal → CLI template. (Per §200, coverage is the load-bearing guard: it is the difference between "the user's single dogfood project the recipe was authored for" and "an arbitrary user project the static URL does not address.")

**Files:**
- Modify: `src/daemon/bootstrap/plan.ts` (`computeBootstrapPlan`: optional selection deps + per-destination kind choice — supersedes the template-only mapping Task 8 added here)
- Modify: `src/daemon/api/routes/bootstrap.ts` (probe each template's binary once → `isCliConfigured`; export `destinationCovered` + build the explicit **scope-specific** `coversDestination` allowlist predicate)
- Test: `src/daemon/bootstrap/plan.test.ts`
- Test: `src/daemon/api/routes/bootstrap.test.ts` (new — covers `destinationCovered`, incl. the host-only-insufficient §200 case)

- [ ] **Step 1: Write the failing test**

```ts
// add to src/daemon/bootstrap/plan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBootstrapPlan } from "./plan.js";
import { RecipeRegistry } from "../recipes/registry.js";
import type { InjectRecipe } from "../recipes/types.js";

const vercelInjectRecipe: InjectRecipe = {
  kind: "inject", host: "vercel.com",
  url: "https://vercel.com/acme/app/settings/environment-variables",
  logged_in_probe: "[data-in]", page_ready_probe: "[data-shell]", logged_out_marker: "[data-login]",
  field_selector: "#v", submit_selector: "#s", success_text: "Added",
};
function reg(): RecipeRegistry { const r = new RecipeRegistry(); r.registerInject(vercelInjectRecipe); return r; }

const parsed = {
  version: 1 as const,
  secrets: [{ name: "APP_SECRET", source: { kind: "random_32_bytes" as const }, destinations: ["vercel:production"] }],
};
const vault = { has: () => false };
const ctx = { source: "local", environment: "production", force: false };

test("browser_inject chosen when recipe exists AND CLI absent AND destination covered", () => {
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => false, coversDestination: () => true });
  assert.equal(plan[0].destinations[0].kind, "browser_inject");
  assert.equal((plan[0].destinations[0] as { recipe_host?: string }).recipe_host, "vercel.com");
});
test("template kept when destination NOT covered by the recipe URL (recipe exists, CLI absent) — §200 guard", () => {
  // The load-bearing honesty test: an arbitrary/un-proven destination must NOT be routed
  // to the recipe's baked-in static URL just because a recipe exists and the CLI is gone.
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => false, coversDestination: () => false });
  assert.equal(plan[0].destinations[0].kind, "template");
  assert.equal((plan[0].destinations[0] as { template_id?: string }).template_id, "vercel-env-add");
});
test("template kept when the CLI IS configured (even though a recipe exists + covered)", () => {
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => true, coversDestination: () => true });
  assert.equal(plan[0].destinations[0].kind, "template");
  assert.equal((plan[0].destinations[0] as { template_id?: string }).template_id, "vercel-env-add");
});
test("template kept when no inject recipe exists (CLI absent + would-be covered)", () => {
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: new RecipeRegistry(), isCliConfigured: () => false, coversDestination: () => true });
  assert.equal(plan[0].destinations[0].kind, "template");
});
test("default (no selection deps) keeps template — safe back-compat (coverage never assumed)", () => {
  const plan = computeBootstrapPlan(parsed, vault, ctx);
  assert.equal(plan[0].destinations[0].kind, "template");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/plan.test.js"`
Expected: FAIL (no `kind` field, no 4th `selection` param, and/or no `coversDestination` gate).

- [ ] **Step 3: Add selection to `computeBootstrapPlan` (`plan.ts`)**

Add imports + the selection deps, and rewrite the destination `.map(...)` (36–44) to choose the kind:

```ts
import { recipeRegistry, type RecipeRegistry } from "../recipes/registry.js";

function canon(host: string): string { return host.trim().toLowerCase().replace(/\.$/, ""); }

export interface PlanSelection {
  recipes?: RecipeRegistry;
  /** True iff the vendor CLI for this template_id is usable. Default () => true
   *  preserves today's CLI-always behavior (never auto-picks browser_inject). */
  isCliConfigured?: (templateId: string) => boolean;
  /** §6/§200 coverage gate (c): true iff this specific destination is PROVEN to be the
   *  project the inject recipe's static URL addresses. Default () => false — coverage is
   *  NEVER assumed, so an arbitrary user destination is never routed to the baked-in
   *  dogfood/demo project URL. The route supplies the real predicate (e.g. an explicit
   *  host+scope allowlist); absent that, every destination is "not covered" → CLI. */
  coversDestination?: (recipeHost: string, domain: string, shorthand: string) => boolean;
}

export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
  selection: PlanSelection = {},
): PlanEntry[] {
  const recipes = selection.recipes ?? recipeRegistry;
  const isCliConfigured = selection.isCliConfigured ?? (() => true);
  const coversDestination = selection.coversDestination ?? (() => false); // coverage never assumed (§200)
  // …unchanged loop preamble (ref / vault.has skip) …

    const destinations: ResolvedDestination[] = s.destinations.map((shorthand) => {
      const r = resolveDestinationShorthand(shorthand, s.name);
      const injectRecipe = recipes.getInject(canon(r.domain));
      // §6: pick browser_inject ONLY when (a) a recipe exists, (b) no CLI is configured,
      // AND (c) the destination is proven covered by the recipe's static URL (§200).
      // Missing ANY of the three → CLI template (the robust, project-general default).
      if (
        injectRecipe !== undefined &&
        !isCliConfigured(r.template_id) &&
        coversDestination(injectRecipe.host, r.domain, shorthand)
      ) {
        return { kind: "browser_inject", recipe_host: injectRecipe.host, shorthand, domain: r.domain };
      }
      return { kind: "template", template_id: r.template_id, template_params: r.template_params, shorthand, domain: r.domain };
    });
  // …unchanged out.push(...) …
}
```

> This replaces the template-only mapping Task 8 added at this site. `import type { RecipeRegistry }` + the value `recipeRegistry` come from the same module (`recipes/registry.js`); no import cycle (`registry.js` → `builtin/index.js` → recipe constants → `types.js`; `plan.js` → `registry.js`). The third gate `coversDestination` is the §200 honesty guard: without an affirmative coverage match the destination stays on the CLI template, so an arbitrary user project is never silently pushed into the recipe's baked-in static URL.

- [ ] **Step 4: Supply real CLI availability in the route (`bootstrap.ts`)**

In `registerBootstrapRoutes`, inside the `POST /v1/bootstrap/plan` handler, **before** the existing `computeBootstrapPlan(...)` call (≈line 45), probe each known template's binary once and pass the predicate:

```ts
import { registry as templateRegistry } from "./templates.js"; // module singleton (templates.ts:26)
import { resolveBinary } from "../../templates/resolve-binary.js";

// Probe each shipped template's vendor CLI once (4 builtins). Increment-1 narrowing of
// spec §25 / §253: "configured" = "binary on PATH" — per-vendor token/auth probing
// (`vercel whoami` etc.) is deferred (see §Limitations at the bottom of this task).
// resolveBinary throws when the binary isn't on PATH → that template's CLI is
// "not configured" for this increment. An installed-but-unauthed CLI keeps the CLI
// template and surfaces the vendor's own auth error (no leak, no silent substitution).
const cliAvail = new Map<string, boolean>();
for (const t of templateRegistry.list()) {
  let ok = true;
  try { await resolveBinary(t.binary); } catch { ok = false; }
  cliAvail.set(t.id, ok);
}
const isCliConfigured = (templateId: string): boolean => cliAvail.get(templateId) ?? true;

// §6/§200 coverage gate (c). Increment-1 inject recipes carry a single static project URL,
// so a destination is "covered" only when the operator has explicitly opted in this exact
// host **and** destination scope (e.g. the dogfood/demo project's `vercel:production`).
// The allowlist is therefore **scope-specific**, NOT host-only: each entry is a
// `host:shorthand` pair (canonical lowercase host, exact shorthand), so opting in
// `vercel.com` alone is insufficient — only the named scope routes to the baked-in URL.
// This closes the hazard where a bare host opt-in would push EVERY Vercel shorthand to the
// single dogfood/demo project URL. Default = empty → NOTHING is covered → every destination
// stays on the CLI template, until URL-param interpolation (§9) lets the recipe address
// arbitrary projects generally.
const coveredScopes = new Set(
  (process.env.SECRET_SHUTTLE_INJECT_RECIPE_SCOPES ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
); // each entry: "<recipe-host>:<shorthand>", e.g. "vercel.com:vercel:production"
// The signature is the full §200 (recipeHost, domain, shorthand) — domain/shorthand are NOT
// ignored; the scope key is built from host + the exact shorthand the user requested.
const coversDestination = (recipeHost: string, _domain: string, shorthand: string): boolean =>
  coveredScopes.has(`${recipeHost.toLowerCase()}:${shorthand.trim().toLowerCase()}`);

const plan = computeBootstrapPlan(parsed, /* vault arg unchanged */, /* ctx unchanged */, { isCliConfigured, coversDestination });
```

Keep the existing `parsed` / vault / ctx arguments exactly as they are today; only append the 4th `{ isCliConfigured, coversDestination }` argument. With `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` unset (the default for every non-dogfood user), `coversDestination` returns `false`, so the route's behavior is **identical to today** — CLI templates everywhere — and `browser_inject` is reachable only when the operator explicitly opts in an exact `host:shorthand` scope (matching the §198 single-static-URL bound). A bare host opt-in is **not** enough — the predicate keys on host **and** the requested shorthand, so an unnamed scope like `vercel:preview` stays on the CLI template even when `vercel:production` is allowlisted.

> **Why scope-specific, not host-only (codex r2):** a host-only allowlist (`coveredHosts.has(recipeHost)`) would let opting in `vercel.com` route **every** Vercel shorthand — including arbitrary user projects/teams/env scopes — to the single baked-in dogfood/demo URL, the exact §200 hazard. The predicate therefore matches the full `(recipeHost, domain, shorthand)` and builds a `host:shorthand` key, so the operator must name the precise covered scope.

- [ ] **Step 4b: Extract the scope predicate as a testable pure helper + prove host-only opt-in is insufficient**

So the scope-specificity is unit-tested (not buried in route wiring), factor the allowlist match into a tiny exported pure function in `bootstrap.ts` (or a small `inject-coverage.ts` sibling if you prefer to keep the route lean) and build `coversDestination` from it:

```ts
/** §200 coverage predicate. `coveredScopes` holds `<recipe-host>:<shorthand>` keys.
 *  Host-only entries (no `:shorthand`) NEVER match — coverage is scope-specific. */
export function destinationCovered(
  coveredScopes: ReadonlySet<string>,
  recipeHost: string,
  shorthand: string,
): boolean {
  return coveredScopes.has(`${recipeHost.toLowerCase()}:${shorthand.trim().toLowerCase()}`);
}
```

Then the route's predicate is just: `const coversDestination = (recipeHost: string, _domain: string, shorthand: string) => destinationCovered(coveredScopes, recipeHost, shorthand);`

Add to `src/daemon/api/routes/bootstrap.test.ts` (or `inject-coverage.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { destinationCovered } from "./bootstrap.js"; // or "./inject-coverage.js"

test("scope-specific opt-in covers exactly the named scope", () => {
  const scopes = new Set(["vercel.com:vercel:production"]);
  assert.equal(destinationCovered(scopes, "vercel.com", "vercel:production"), true);
});
test("host-only opt-in is INSUFFICIENT — bare host never covers any scope (§200 guard)", () => {
  const scopes = new Set(["vercel.com"]); // host-only entry
  assert.equal(destinationCovered(scopes, "vercel.com", "vercel:production"), false);
  assert.equal(destinationCovered(scopes, "vercel.com", "vercel:preview"), false);
});
test("a named scope does NOT leak to a sibling scope on the same host", () => {
  const scopes = new Set(["vercel.com:vercel:production"]);
  assert.equal(destinationCovered(scopes, "vercel.com", "vercel:preview"), false); // not allowlisted
});
```

- [ ] **Step 5: Run the test + typecheck + existing plan/route regression**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/plan.test.js"`
Expected: PASS. Then run the route/coverage test file (`dist/daemon/api/routes/bootstrap*.test.js` or `dist/daemon/api/routes/inject-coverage.test.js`) to confirm the host-only-insufficient cases pass and the route still plans correctly with the CLI present (default → template).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/plan.ts src/daemon/api/routes/bootstrap.ts src/daemon/bootstrap/plan.test.ts src/daemon/api/routes/bootstrap.test.ts
git commit -m "feat(recipes): select browser_inject only when a recipe exists, the vendor CLI is absent, and the destination is proven covered by a scope-specific allowlist (§6/§200)"
```

### §Limitations (increment 1 — deliberate, stated)

Codex r3: spec §25 / §253 describes "no CLI token/template configured" as the browser-inject trigger; this task narrows that, for increment 1, to **"CLI binary absent from `PATH`"** only.

- **What's covered now:** users who never installed the vendor CLI (the browser-only target). With the binary missing and a scope-specific allowlist match, `browser_inject` runs.
- **What's NOT covered (deferred):** an installed-but-logged-out CLI (no token, no `vercel login`, no `stripe config`, etc.). For these users `browser_inject` does NOT auto-trigger; the CLI template runs and the vendor's own auth error surfaces unchanged. No secret leaks, no silent substitution — just an extra explicit step (auth the CLI, or uninstall it).
- **Why narrow on purpose:** richer per-vendor auth probing (`vercel whoami`, `stripe config --list`, parsing `~/.vercel/auth.json`, etc.) is **four different code paths across four vendors**, each with its own credential-store quirks; shipping it now would add surface area without unblocking the dogfood/demo (which only needs the browser-only path). The `resolveBinary(...)` probe is already the primitive the existing CLI templates use, so we reuse one signal everywhere and ship a tiny, testable surface.
- **Follow-on increment (post-magic-path):** add a `CliAuthProbe` per-template-id (e.g. `vercel-env-add` → `vercel whoami`, exit 0 ⇒ authed) and OR it into `isCliConfigured`. Same `coversDestination` gate still applies. The selection API (`PlanSelection.isCliConfigured`) is already abstract over the signal, so the follow-on is a pure substitution.

---

## Final verification (run after Task 14, before the impl gate)

- [ ] **Full suite green:**

Run: `npm test`
Expected: PASS (build + typecheck + every `*.test.js`). This proves the behavior-preserving refactors (Tasks 4–5) kept the route tests byte-identical and every new surface is covered.

- [ ] **Manual dogfood (the real-page bar §Test):** with the bootstrap browser logged into Stripe and Vercel, run a `provision --infer` → `--continue` against the dogfood project and confirm: Stripe secret-key capture succeeds hands-off, Vercel env inject succeeds hands-off, and a deliberately-broken selector degrades to the correct specific error (not a leak, not a misleading "log in" loop). Record the dates in the recipes + matrix.
