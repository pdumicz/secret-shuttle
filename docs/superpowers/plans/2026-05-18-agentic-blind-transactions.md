# Agentic Blind Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon perform whole secret-bearing browser transactions so the human only approves policy — never browser choreography.

**Architecture:** The daemon already owns Chrome over an internal CDP client while the agent is severed under blind mode (`src/daemon/proxy/cdp-proxy.ts`). This work adds an in-memory opaque-handle store, atomic `inject-submit` / `reveal-capture` daemon routes that operate marked elements under blind mode and auto-resume observation only on a proven-safe exit, three stdin/temp-file-safe provider templates, and a canonical agent `SKILL.md` with installers. Spec: [docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md](../specs/2026-05-18-agentic-blind-transactions-design.md) (signed off at commit `d1c89ed`).

**Tech Stack:** TypeScript (ESM, NodeNext), Commander CLI, Node built-in `http` daemon, raw CDP over a pipe transport, `node:test` + `node:assert/strict` (tests build to `dist/` then run via `node --test`).

---

## Scope: this plan covers Phase 1 only; Phases 2–5 are separate plans

The spec (§14) defines five independently shippable phases. Per the writing-plans scope rule, each subsystem gets its own plan that produces working, testable software on its own. **This document is the complete, executable plan for Phase 1 (Opaque Browser Handles)** — the foundation every other phase builds on.

Phases 2–5 are deliberately **not** expanded here: their tasks must cite exact `file:line` integration points and reference the concrete `BrowserHandle` / `BrowserHandleStore` / `HandleDescriptor` types that Phase 1 creates. Writing those steps before Phase 1 lands would mean inventing references — a plan failure. Each subsequent plan is generated (re-invoke `superpowers:writing-plans` against the same spec) once its predecessor merges:

- **Plan 2 — `inject-submit`** (spec §3.4, §4, §5, §7, §8): approval-binding + `ui.html` extension, `/v1/secrets/inject-submit` route, `injectIntoBackendNode`/`clickBackendNode`, the absence proof, the audited `blind_auto_resume` path. Carry residual: keep the **Vercel real-page auto-resume gate** (spec §13 [P2a]) as a release task.
- **Plan 3 — `reveal-capture`** (spec §6): route, pre-reveal baseline + `baselineCandidates`, `resolveWithinContainer` with transition-eligible filtering, hide/blank. Carry residual: keep the **Stripe real-page gate**.
- **Plan 4 — Templates** (spec §9): `github-actions-secret-set`, `cloudflare-secret-put`, `supabase-edge-secret-set`; `tmp_env_file_0600` delivery (`0700` dir, `0600` file, `finally` unlink, startup/periodic sweep); verify each CLI's `--help` for true stdin vs temp-file.
- **Plan 5 — Skill + installers + doctor/health** (spec §10, §11): canonical `skills/secret-shuttle/SKILL.md` (retire `skills/claude-code/SKILL.md`), `agent install`/`print-skill-url`, `agentic_browser` health block. Carry residual: **make the `mark pick` concurrent choreography explicit in the skill tests/docs**.

Residual flagged at sign-off and threaded above: **verify `Overlay.setInspectMode` behavior in the real bundled browser** — Task 9 of this plan is that manual integration check.

---

## Phase 1 File Structure

- **Create** `src/daemon/browser-handles.ts` — `ElementKind`, `BrowserHandle`, `BrowserHandleStore` (in-memory, per-session, 5-min TTL, last-write-wins per label, never persisted).
- **Create** `src/daemon/browser-handles.test.ts` — store unit tests.
- **Modify** `src/daemon/chrome/internal-ops.ts` — add `HandleDescriptor`, exported pure `elementKind()`, extend `BrowserOps` with `markFocused`/`markPick`/`revalidateHandle`, implement on `CdpBrowserOps`.
- **Create** `src/daemon/chrome/element-kind.test.ts` — pure-function tests for `elementKind()` (the single source of truth, spec §3.3).
- **Modify** `src/daemon/services.ts` — add `readonly handles = new BrowserHandleStore()`.
- **Modify** `src/daemon/api/routes/browser.ts` — add `POST /v1/browser/mark`, `POST /v1/browser/marks`; clear handles on `POST /v1/browser/start`.
- **Create** `src/daemon/api/browser-handles-routes.test.ts` — route tests with a stub `BrowserOps` (own `withDaemon`/`call` harness, matching the existing per-file pattern in `routes.test.ts` and `e2e/stripe-to-vercel.test.ts`).
- **Modify** `src/cli/commands/browser.ts` — add `browser mark focused|pick --as <label>` and `browser marks`.

**Branch:** do this work on a feature branch (`git switch -c feat/agentic-handles`) — brainstorming did not create a worktree; do not implement on `main`.

Commands:
- Build: `npm run build`
- Typecheck only: `npm run typecheck`
- Full test: `npm test` (builds, then `node --test "dist/**/*.test.js"`)
- One test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/browser-handles.test.js`

---

### Task 1: Branch + `ElementKind`/`BrowserHandle`/`BrowserHandleStore`

**Files:**
- Create: `src/daemon/browser-handles.ts`
- Test: `src/daemon/browser-handles.test.ts`

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git switch -c feat/agentic-handles
```
Expected: `Switched to a new branch 'feat/agentic-handles'`

- [ ] **Step 2: Write the failing store test**

Create `src/daemon/browser-handles.test.ts`:
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHandleStore } from "./browser-handles.js";

function baseInput(label = "submit-button") {
  return {
    label,
    target_id: "T-1",
    domain: "vercel.com",
    page_url_host: "vercel.com",
    page_title: "Project",
    backend_node_id: 42,
    handle_fingerprint: "sha256:abc123",
    element_kind: "button" as const,
  };
}

test("put returns an opaque handle with TTL and is retrievable by label", () => {
  let now = 1_000;
  const store = new BrowserHandleStore({ now: () => now });
  const h = store.put(baseInput());
  assert.equal(h.label, "submit-button");
  assert.equal(typeof h.handle_id, "string");
  assert.notEqual(h.handle_id, "");
  assert.equal(h.created_at, 1_000);
  assert.equal(h.expires_at, 1_000 + 5 * 60 * 1000);
  assert.equal(store.get("submit-button")?.handle_id, h.handle_id);
});

test("re-marking a label is last-write-wins", () => {
  const store = new BrowserHandleStore({ now: () => 0 });
  const a = store.put(baseInput());
  const b = store.put({ ...baseInput(), backend_node_id: 99 });
  assert.notEqual(a.handle_id, b.handle_id);
  assert.equal(store.get("submit-button")?.handle_id, b.handle_id);
  assert.equal(store.get("submit-button")?.backend_node_id, 99);
  assert.equal(store.list().length, 1);
});

test("expired handles are treated as absent (fail closed) and pruned", () => {
  let now = 0;
  const store = new BrowserHandleStore({ now: () => now });
  store.put(baseInput());
  now = 5 * 60 * 1000 + 1;
  assert.equal(store.get("submit-button"), undefined);
  assert.equal(store.list().length, 0);
});

test("clear() empties the store (browser-session reset)", () => {
  const store = new BrowserHandleStore({ now: () => 0 });
  store.put(baseInput("a"));
  store.put(baseInput("b"));
  assert.equal(store.list().length, 2);
  store.clear();
  assert.equal(store.list().length, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL — `Cannot find module './browser-handles.js'` (TypeScript error `TS2307`).

- [ ] **Step 4: Implement the store**

Create `src/daemon/browser-handles.ts`:
```ts
import { randomUUID } from "node:crypto";

export type ElementKind = "field" | "button" | "link" | "other";

export interface BrowserHandle {
  handle_id: string;
  label: string;
  target_id: string;
  domain: string;
  page_url_host: string;
  page_title: string;
  backend_node_id: number;
  handle_fingerprint: string;
  element_kind: ElementKind;
  created_at: number;
  expires_at: number;
}

export type HandleInput = Omit<BrowserHandle, "handle_id" | "created_at" | "expires_at">;

const TTL_MS = 5 * 60 * 1000;

/**
 * In-memory, per-browser-session opaque handle store. Never persisted.
 * Label namespace is per session; re-marking a label is last-write-wins;
 * handles expire 5 minutes after creation (then treated as absent — fail closed).
 */
export class BrowserHandleStore {
  private readonly byLabel = new Map<string, BrowserHandle>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  put(input: HandleInput): BrowserHandle {
    const created = this.now();
    const handle: BrowserHandle = {
      ...input,
      handle_id: randomUUID(),
      created_at: created,
      expires_at: created + TTL_MS,
    };
    this.byLabel.set(input.label, handle);
    return handle;
  }

  get(label: string): BrowserHandle | undefined {
    const h = this.byLabel.get(label);
    if (h === undefined) return undefined;
    if (this.now() > h.expires_at) {
      this.byLabel.delete(label);
      return undefined;
    }
    return h;
  }

  list(): BrowserHandle[] {
    const out: BrowserHandle[] = [];
    for (const [label, h] of this.byLabel) {
      if (this.now() > h.expires_at) {
        this.byLabel.delete(label);
        continue;
      }
      out.push(h);
    }
    return out;
  }

  clear(): void {
    this.byLabel.clear();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/browser-handles.test.js`
Expected: PASS — 4 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/browser-handles.ts src/daemon/browser-handles.test.ts
git commit -m "feat(handles): in-memory per-session BrowserHandleStore"
```

---

### Task 2: `elementKind()` — single source of truth (spec §3.3)

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (add exported `elementKind` + `HandleDescriptor`)
- Test: `src/daemon/chrome/element-kind.test.ts`

- [ ] **Step 1: Write the failing pure-function test**

Create `src/daemon/chrome/element-kind.test.ts`:
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { elementKind } from "./internal-ops.js";

test("text-entry inputs and editables are `field`", () => {
  for (const type of ["text", "password", "email", "url", "search", "tel", "number", ""]) {
    assert.equal(elementKind({ tag: "input", type, editable: true }), "field", `input[type=${type}]`);
  }
  assert.equal(elementKind({ tag: "textarea", editable: true }), "field");
  assert.equal(elementKind({ tag: "div", editable: true }), "field"); // contenteditable
});

test("non-text inputs are NOT field (spec §3.3 exclusions)", () => {
  for (const type of ["checkbox", "radio", "file", "range", "color", "date", "datetime-local", "month", "week", "time"]) {
    assert.equal(elementKind({ tag: "input", type, editable: false }), "other", `input[type=${type}]`);
  }
});

test("button-kind set", () => {
  assert.equal(elementKind({ tag: "button", editable: false }), "button");
  assert.equal(elementKind({ tag: "summary", editable: false }), "button");
  assert.equal(elementKind({ tag: "div", role: "button", editable: false }), "button");
  for (const type of ["submit", "button", "image", "reset"]) {
    assert.equal(elementKind({ tag: "input", type, editable: false }), "button", `input[type=${type}]`);
  }
});

test("link-kind set", () => {
  assert.equal(elementKind({ tag: "a", href: true, editable: false }), "link");
  assert.equal(elementKind({ tag: "a", href: false, editable: false }), "other"); // anchor without href
  assert.equal(elementKind({ tag: "span", role: "link", editable: false }), "link");
});

test("everything else is `other`", () => {
  assert.equal(elementKind({ tag: "span", editable: false }), "other");
  assert.equal(elementKind({ tag: "p", editable: false }), "other");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL — `Module '"./internal-ops.js"' has no exported member 'elementKind'` (`TS2305`).

- [ ] **Step 3: Add `elementKind` and `HandleDescriptor` to internal-ops**

In `src/daemon/chrome/internal-ops.ts`, add the import of `ElementKind` near the top imports (after the existing `import { ShuttleError } from "../../shared/errors.js";`):
```ts
import type { ElementKind } from "../browser-handles.js";
```

Then add this block immediately **above** the existing `export interface FieldDescriptor {` line:
```ts
export interface ElementKindMeta {
  tag: string;
  type?: string;
  role?: string;
  href?: boolean;
  editable: boolean;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "password", "email", "url", "search", "tel", "number"]);

/**
 * Single source of truth for element_kind (spec §3.3). Exactly the actionable set
 * `mark pick` normalizes to. `field` = text-entry/editable only.
 */
export function elementKind(meta: ElementKindMeta): ElementKind {
  const tag = meta.tag.toLowerCase();
  const type = (meta.type ?? "").toLowerCase();
  const role = (meta.role ?? "").toLowerCase();
  if (meta.editable && tag !== "input" && tag !== "textarea") return "field"; // contenteditable
  if (tag === "textarea") return "field";
  if (tag === "input" && TEXT_INPUT_TYPES.has(type)) return "field";
  if (tag === "button" || tag === "summary" || role === "button") return "button";
  if (tag === "input" && (type === "submit" || type === "button" || type === "image" || type === "reset")) return "button";
  if ((tag === "a" && meta.href === true) || role === "link") return "link";
  return "other";
}

export interface HandleDescriptor {
  target_id: string;
  domain: string;
  page_url_host: string;
  page_title: string;
  backend_node_id: number;
  handle_fingerprint: string;
  element_kind: ElementKind;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/chrome/element-kind.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/element-kind.test.ts
git commit -m "feat(handles): elementKind() single-source mapping (spec §3.3)"
```

---

### Task 3: Extend `BrowserOps` interface + handle fingerprint helper

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts`

- [ ] **Step 1: Add the handle fingerprint helper**

In `src/daemon/chrome/internal-ops.ts`, immediately **below** the existing `function fieldFingerprint(...)` definition, add:
```ts
/**
 * Handle fingerprint: extends the field fingerprint seed with role + accessible
 * name + element_kind so revalidation is anchored on more than the backend node.
 * Never stores/returns raw role/name/value — only this hash.
 */
function handleFingerprint(
  domain: string,
  target: string,
  backendNodeId: number | null,
  meta: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string },
  kind: ElementKind,
): string {
  const seed = JSON.stringify({ domain, target, backendNodeId, ...meta, kind });
  return `sha256:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}
```

- [ ] **Step 2: Extend the `BrowserOps` interface**

In `src/daemon/chrome/internal-ops.ts`, modify the existing `export interface BrowserOps {` block to add three methods (place them after the existing `currentDomainAndTarget(): Promise<{ domain: string; target_id: string }>;` line, before the closing brace):
```ts
  markFocused(): Promise<HandleDescriptor>;
  markPick(timeoutMs: number): Promise<HandleDescriptor>;
  revalidateHandle(h: { target_id: string; domain: string; backend_node_id: number; handle_fingerprint: string; element_kind: ElementKind }): Promise<void>;
```

- [ ] **Step 3: Verify it fails to compile (interface not yet implemented)**

Run: `npm run typecheck`
Expected: FAIL — `Class 'CdpBrowserOps' incorrectly implements interface 'BrowserOps'. Type 'CdpBrowserOps' is missing the following properties from type 'BrowserOps': markFocused, markPick, revalidateHandle` (`TS2420`).

- [ ] **Step 4: Commit the interface (implementation lands in Task 4)**

The build is intentionally red here; do not commit a broken tree. Proceed directly to Task 4 and commit interface + implementation together. (No commit in this task.)

---

### Task 4: Implement `markFocused`, `markPick`, `revalidateHandle` on `CdpBrowserOps`

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts`

- [ ] **Step 1: Add the handle read script**

In `src/daemon/chrome/internal-ops.ts`, add this constant immediately **below** the existing `const WRITE_SCRIPT = ...;` definition:
```ts
const HANDLE_READ_SCRIPT = `
(() => {
  const a = document.activeElement;
  if (!(a instanceof Element)) return { ok:false, reason:"no_active_element" };
  const i = a instanceof HTMLInputElement ? a : null;
  const ta = a instanceof HTMLTextAreaElement ? a : null;
  const editable = a instanceof HTMLElement && a.isContentEditable;
  return {
    ok: true,
    meta: {
      tag: a.tagName.toLowerCase(),
      type: i ? i.type : undefined,
      name: (i && i.name) || (ta && ta.name) || undefined,
      id: a.id || undefined,
      editable,
      role: a.getAttribute("role") || undefined,
      ariaLabel: a.getAttribute("aria-label") || undefined,
      href: a.tagName.toLowerCase() === "a" ? a.hasAttribute("href") : false,
    },
    domain: location.hostname,
    title: document.title,
    urlHost: location.host,
  };
})()
`;
```

- [ ] **Step 2: Add a one-shot CDP event waiter helper**

In `src/daemon/chrome/internal-ops.ts`, add this private helper **inside** the `CdpBrowserOps` class (after the existing `private async getFocusedBackendNodeId(...)` method):
```ts
  // CdpClient.on has no off(); guard with a one-shot flag and a timeout race.
  private waitForEvent<T>(event: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new ShuttleError("mark_pick_timeout", "No element picked before timeout."));
      }, timeoutMs);
      this.cdp.on(event, (params) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(params as T);
      });
    });
  }

  private async describeBackendNode(
    sessionId: string,
    backendNodeId: number,
  ): Promise<{ tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean }> {
    const { object } = await this.cdp.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      sessionId,
    );
    try {
      const r = await this.cdp.send<{ result: { value: {
        tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean;
      } } }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          returnByValue: true,
          functionDeclaration: `function(){
            const i = this instanceof HTMLInputElement ? this : null;
            const ta = this instanceof HTMLTextAreaElement ? this : null;
            return {
              tag: this.tagName.toLowerCase(),
              type: i ? i.type : undefined,
              name: (i && i.name) || (ta && ta.name) || undefined,
              id: this.id || undefined,
              editable: this instanceof HTMLElement && this.isContentEditable,
              role: this.getAttribute("role") || undefined,
              ariaLabel: this.getAttribute("aria-label") || undefined,
              href: this.tagName.toLowerCase() === "a" ? this.hasAttribute("href") : false,
            };
          }`,
        },
        sessionId,
      );
      return r.result.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
    }
  }

  // Walk self -> ancestors to the nearest element whose elementKind is field/button/link.
  private async normalizeToActionable(sessionId: string, backendNodeId: number): Promise<number> {
    const { object } = await this.cdp.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      sessionId,
    );
    try {
      const r = await this.cdp.send<{ result: { value: { found: boolean } }; objectId?: string }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: `function(){
            const TEXT = new Set(["","text","password","email","url","search","tel","number"]);
            function kind(el){
              const tag = el.tagName.toLowerCase();
              const type = (el.type || "").toLowerCase();
              const role = (el.getAttribute("role") || "").toLowerCase();
              const editable = el instanceof HTMLElement && el.isContentEditable;
              if (editable && tag !== "input" && tag !== "textarea") return "field";
              if (tag === "textarea") return "field";
              if (tag === "input" && TEXT.has(type)) return "field";
              if (tag === "button" || tag === "summary" || role === "button") return "button";
              if (tag === "input" && ["submit","button","image","reset"].includes(type)) return "button";
              if ((tag === "a" && el.hasAttribute("href")) || role === "link") return "link";
              return "other";
            }
            let el = this, depth = 0;
            while (el && el.nodeType === 1 && depth < 25) {
              if (kind(el) !== "other") return el;
              el = el.parentElement;
              depth++;
            }
            return null;
          }`,
        },
        sessionId,
      );
      const normalizedObjectId = (r as { objectId?: string }).objectId;
      if (typeof normalizedObjectId !== "string") {
        throw new ShuttleError("mark_pick_no_actionable", "Picked node has no actionable ancestor.");
      }
      try {
        const desc = await this.cdp.send<{ node: { backendNodeId: number } }>(
          "DOM.describeNode",
          { objectId: normalizedObjectId },
          sessionId,
        );
        return desc.node.backendNodeId;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: normalizedObjectId }, sessionId).catch(() => undefined);
      }
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
    }
  }
```

> Note: `Runtime.callFunctionOn` with no `returnByValue` and an object return yields `{ result: { objectId } }`. The code reads `r.objectId` defensively because the CDP wire shape places the remote object under `result`; if your CDP build returns `{ result: { objectId } }`, change `(r as {objectId?})` to `r.result.objectId`. This is verified live in Task 9.

- [ ] **Step 2b: Run the descriptor-shape check against the bundled browser is deferred to Task 9.** No code change in this sub-step.

- [ ] **Step 3: Implement the three `BrowserOps` methods**

In `src/daemon/chrome/internal-ops.ts`, add these three methods to `CdpBrowserOps` immediately **after** the existing `async injectFocused(...)` method (before the closing `}` of the class):
```ts
  async markFocused(): Promise<HandleDescriptor> {
    const page = await this.pickPage();
    const r = await this.evaluate<{
      ok: boolean;
      reason?: string;
      meta?: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean };
      domain?: string;
      title?: string;
      urlHost?: string;
    }>(page.id, HANDLE_READ_SCRIPT);
    if (!r.ok || r.meta === undefined || r.domain === undefined) {
      throw new ShuttleError("mark_focused_unavailable", r.reason ?? "No focused element to mark.");
    }
    const kind = elementKind(r.meta);
    if (kind === "other") {
      throw new ShuttleError("mark_kind_unsupported", "Focused element is not a field/button/link.");
    }
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    if (backendNodeId === null) {
      throw new ShuttleError("mark_focused_unavailable", "Could not resolve the focused element.");
    }
    const domain = r.domain.toLowerCase();
    return {
      target_id: page.id,
      domain,
      page_url_host: r.urlHost ?? domain,
      page_title: r.title ?? "",
      backend_node_id: backendNodeId,
      handle_fingerprint: handleFingerprint(domain, page.id, backendNodeId, r.meta, kind),
      element_kind: kind,
    };
  }

  async markPick(timeoutMs: number): Promise<HandleDescriptor> {
    const page = await this.pickPage();
    const sessionId = await this.attach(page.id);
    try {
      await this.cdp.send("DOM.enable", {}, sessionId);
      await this.cdp.send("Overlay.enable", {}, sessionId);
      const picked = this.waitForEvent<{ backendNodeId: number }>("Overlay.inspectNodeRequested", timeoutMs);
      await this.cdp.send(
        "Overlay.setInspectMode",
        { mode: "searchForNode", highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.4 } } },
        sessionId,
      );
      const ev = await picked;
      const actionableBackendNodeId = await this.normalizeToActionable(sessionId, ev.backendNodeId);
      const meta = await this.describeBackendNode(sessionId, actionableBackendNodeId);
      const kind = elementKind(meta);
      if (kind === "other") {
        throw new ShuttleError("mark_kind_unsupported", "Picked element is not a field/button/link.");
      }
      const loc = await this.evaluate<{ domain: string; title: string; urlHost: string }>(
        page.id,
        "({domain: location.hostname, title: document.title, urlHost: location.host})",
      );
      const domain = loc.domain.toLowerCase();
      return {
        target_id: page.id,
        domain,
        page_url_host: loc.urlHost,
        page_title: loc.title,
        backend_node_id: actionableBackendNodeId,
        handle_fingerprint: handleFingerprint(domain, page.id, actionableBackendNodeId, meta, kind),
        element_kind: kind,
      };
    } finally {
      await this.cdp.send("Overlay.setInspectMode", { mode: "none" }, sessionId).catch(() => undefined);
      await this.cdp.send("Overlay.disable", {}, sessionId).catch(() => undefined);
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  async revalidateHandle(h: {
    target_id: string;
    domain: string;
    backend_node_id: number;
    handle_fingerprint: string;
    element_kind: ElementKind;
  }): Promise<void> {
    const sessionId = await this.attach(h.target_id).catch(() => {
      throw new ShuttleError("handle_invalid", "Handle target is gone (navigation/detach).");
    });
    try {
      let meta: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean };
      try {
        meta = await this.describeBackendNode(sessionId, h.backend_node_id);
      } catch {
        throw new ShuttleError("handle_invalid", "Handle element no longer resolvable.");
      }
      const loc = await this.evaluate<{ domain: string }>(h.target_id, "({domain: location.hostname})");
      const domain = loc.domain.toLowerCase();
      const kind = elementKind(meta);
      const fp = handleFingerprint(domain, h.target_id, h.backend_node_id, meta, kind);
      if (domain !== h.domain || kind !== h.element_kind || fp !== h.handle_fingerprint) {
        throw new ShuttleError("handle_invalid", "Handle no longer matches the marked element.");
      }
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
```

- [ ] **Step 4: Verify the full project compiles**

Run: `npm run typecheck`
Expected: PASS — no `TS2420` (interface now fully implemented), exit code 0.

- [ ] **Step 5: Run the existing suite to confirm no regressions**

Run: `npm test`
Expected: PASS — all existing tests still green (the new `BrowserOps` methods are additive; stubs in `routes.test.ts`/`stripe-to-vercel.test.ts` don't yet implement them but those stubs are typed as `BrowserOps` — see Task 6 fixup if the build flags the stubs).

> If `npm run build` reports the existing stub objects in `routes.test.ts` / `e2e/stripe-to-vercel.test.ts` no longer satisfy `BrowserOps` (`TS2741`), that is expected and fixed in Task 6 Step 1 before any commit. Do not commit a red tree.

- [ ] **Step 6: Commit interface + implementation together**

```bash
git add src/daemon/chrome/internal-ops.ts
git commit -m "feat(handles): markFocused/markPick/revalidateHandle on CdpBrowserOps"
```

---

### Task 5: Wire `BrowserHandleStore` into `DaemonServices`

**Files:**
- Modify: `src/daemon/services.ts`

- [ ] **Step 1: Add the store field**

In `src/daemon/services.ts`, add the import after the existing `import { DaemonBlindModeState } from "./services-blind.js";` line:
```ts
import { BrowserHandleStore } from "./browser-handles.js";
```

In the `DaemonServices` class, add this line immediately **after** `readonly blind = new DaemonBlindModeState();`:
```ts
  readonly handles = new BrowserHandleStore();
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS — exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/services.ts
git commit -m "feat(handles): expose BrowserHandleStore on DaemonServices"
```

---

### Task 6: Daemon routes — `/v1/browser/mark`, `/v1/browser/marks`, clear-on-start

**Files:**
- Modify: `src/daemon/api/routes/browser.ts`
- Test: `src/daemon/api/browser-handles-routes.test.ts`

- [ ] **Step 1: Fix the existing test stubs to satisfy the extended `BrowserOps`**

In **both** `src/daemon/api/routes.test.ts` and `src/e2e/stripe-to-vercel.test.ts`, find the object returned by `stubBrowser(...)` (the object literal with `available: true`, `captureFocused`, …, `currentDomainAndTarget`). Add these three properties to each stub object (right after the `currentDomainAndTarget: ...,` line):
```ts
    markFocused: async () => ({
      target_id: state.target, domain: state.domain, page_url_host: state.domain,
      page_title: "stub", backend_node_id: 1, handle_fingerprint: "sha256:stub", element_kind: "field" as const,
    }),
    markPick: async () => ({
      target_id: state.target, domain: state.domain, page_url_host: state.domain,
      page_title: "stub", backend_node_id: 2, handle_fingerprint: "sha256:stubpick", element_kind: "button" as const,
    }),
    revalidateHandle: async () => undefined,
```

> `routes.test.ts` line ~11 and `stripe-to-vercel.test.ts` line ~11 define `stubBrowser`. The `state` variable (`{ domain, target, value }`) is already in scope inside `stubBrowser`. This keeps both files compiling against the extended interface.

- [ ] **Step 2: Write the failing route test**

Create `src/daemon/api/browser-handles-routes.test.ts`:
```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import type { BrowserOps, HandleDescriptor } from "../chrome/internal-ops.js";

function stub(desc: Partial<HandleDescriptor> = {}): BrowserOps {
  const base: HandleDescriptor = {
    target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 7, handle_fingerprint: "sha256:fp", element_kind: "button",
    ...desc,
  };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => { throw new Error("unused"); },
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: base.domain, target_id: base.target_id }),
    markFocused: async () => base,
    markPick: async () => ({ ...base, backend_node_id: 9, element_kind: "field" }),
    revalidateHandle: async () => undefined,
  };
}

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bh-"));
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

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("mark focused stores a handle; marks lists non-secret metadata only", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "submit" });
    assert.equal(m.status, 200);
    assert.equal((m.body as { marked: boolean }).marked, true);
    assert.equal((m.body as { label: string }).label, "submit");
    assert.equal((m.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);
    assert.equal("handle_fingerprint" in m.body, false); // never exposed
    assert.equal("backend_node_id" in m.body, false);

    const list = await call(port, "POST", "/v1/browser/marks");
    assert.equal(list.status, 200);
    const marks = (list.body as { marks: Record<string, unknown>[] }).marks;
    assert.equal(marks.length, 1);
    assert.deepEqual(Object.keys(marks[0]!).sort(),
      ["created_at", "domain", "element_kind", "expires_at", "label", "page_url_host", "valid"]);
  });
});

test("mark requires a started browser", async () => {
  await withDaemon(async ({ port }) => {
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "browser_not_started");
  });
});

test("mark is rejected while blind mode is active", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    services.blind.start("vercel.com", "test");
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "blind_mode_active");
  });
});

test("invalid `how` is a bad request", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    const m = await call(port, "POST", "/v1/browser/mark", { how: "selector", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "bad_request");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/browser-handles-routes.test.js`
Expected: FAIL — first test fails with status 404 (route `/v1/browser/mark` not registered).

- [ ] **Step 4: Implement the routes**

Replace the entire contents of `src/daemon/api/routes/browser.ts` with:
```ts
import { ShuttleError } from "../../../shared/errors.js";
import { launchChrome } from "../../chrome/launch.js";
import { CdpBrowserOps } from "../../chrome/internal-ops.js";
import { startCdpProxy } from "../../proxy/cdp-proxy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, reqString } from "../validate.js";

interface StartBody { profile?: string; }

const MARK_PICK_TIMEOUT_DEFAULT_MS = 30_000;
const MARK_PICK_TIMEOUT_CAP_MS = 120_000;

export function registerBrowser(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/browser/start", async (_req, raw) => {
    if (services.browser !== null) {
      throw new ShuttleError("browser_already_started", "Browser already started.");
    }
    const b = (raw ?? {}) as StartBody;
    const session = await launchChrome({ profile: b.profile ?? "prod-config" });
    services.browser = new CdpBrowserOps(session.cdp);
    services.cdp = session.cdp;
    const proxy = await startCdpProxy({
      transport: session.transport,
      cdp: session.cdp,
      blind: services.blind,
    });
    services.cdpProxy = proxy;
    services.browserSessionId = proxy.url;
    // New browser session ⇒ a fresh handle namespace. Handles never persist.
    services.handles.clear();
    return { started: true, proxy_url: proxy.url, raw_cdp_url: null, value_visible_to_agent: false };
  });

  server.addRoute("POST", "/v1/browser/mark", async (_req, raw) => {
    const o = asObject(raw);
    const how = reqString(o, "how");
    const label = reqString(o, "label");
    if (how !== "focused" && how !== "pick") {
      throw new ShuttleError("bad_request", "how: must be 'focused' or 'pick'");
    }
    if (services.browser === null) {
      throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
    }
    if (services.blind.current() !== null) {
      throw new ShuttleError("blind_mode_active", "Cannot mark while blind mode is active.");
    }
    let timeoutMs = MARK_PICK_TIMEOUT_DEFAULT_MS;
    const t = o["timeout_ms"];
    if (typeof t === "number" && Number.isFinite(t)) {
      timeoutMs = Math.min(Math.max(1_000, Math.floor(t)), MARK_PICK_TIMEOUT_CAP_MS);
    }
    const desc = how === "focused"
      ? await services.browser.markFocused()
      : await services.browser.markPick(timeoutMs);
    const handle = services.handles.put({ label, ...desc });
    return {
      marked: true,
      label: handle.label,
      element_kind: handle.element_kind,
      domain: handle.domain,
      expires_at: handle.expires_at,
      value_visible_to_agent: false,
    };
  });

  server.addRoute("POST", "/v1/browser/marks", async () => {
    const marks = services.handles.list().map((h) => ({
      label: h.label,
      element_kind: h.element_kind,
      domain: h.domain,
      page_url_host: h.page_url_host,
      created_at: h.created_at,
      expires_at: h.expires_at,
      valid: true,
    }));
    return { marks, value_visible_to_agent: false };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/browser-handles-routes.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all tests green (existing + new), including the Task 6 Step 1 stub fixups.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/api/routes/browser.ts src/daemon/api/browser-handles-routes.test.ts src/daemon/api/routes.test.ts src/e2e/stripe-to-vercel.test.ts
git commit -m "feat(handles): /v1/browser/mark + /v1/browser/marks; clear handles on browser start"
```

---

### Task 7: CLI — `browser mark focused|pick` and `browser marks`

**Files:**
- Modify: `src/cli/commands/browser.ts`

- [ ] **Step 1: Implement the CLI subcommands**

Replace the entire contents of `src/cli/commands/browser.ts` with:
```ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function browserCommand(): Command {
  const c = new Command("browser").description("Browser session controlled by the daemon.");

  c.command("start")
    .option("--profile <profile>", "Browser profile name.", "prod-config")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/browser/start", { profile: options.profile });
      outputJson(ok(r as Record<string, unknown>));
    });

  const mark = c.command("mark").description("Mark a UI element for the daemon to use under blind mode.");

  mark.command("focused")
    .description("Mark the currently focused element.")
    .requiredOption("--as <label>", "Opaque label to reference this element by.")
    .action(async (options) => {
      const r = await daemonRequest("POST", "/v1/browser/mark", { how: "focused", label: options.as });
      outputJson(ok(r as Record<string, unknown>));
    });

  mark.command("pick")
    .description("Pick an element via the browser's inspect overlay (no page event is dispatched).")
    .requiredOption("--as <label>", "Opaque label to reference this element by.")
    .option("--timeout-ms <ms>", "Max time to wait for the pick (default 30000, cap 120000).", (v) => parseInt(v, 10))
    .action(async (options) => {
      const body: Record<string, unknown> = { how: "pick", label: options.as };
      if (options.timeoutMs !== undefined) body.timeout_ms = options.timeoutMs;
      const r = await daemonRequest("POST", "/v1/browser/mark", body);
      outputJson(ok(r as Record<string, unknown>));
    });

  c.command("marks")
    .description("List active marks (non-secret metadata only).")
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/browser/marks");
      outputJson(ok(r as Record<string, unknown>));
    });

  return c;
}
```

- [ ] **Step 2: Verify it compiles and the CLI wires up**

Run: `npm run build && node dist/cli/index.js browser --help`
Expected: PASS — help text lists `start`, `mark`, and `marks` subcommands; exit code 0.

- [ ] **Step 3: Verify the mark subcommand surface**

Run: `node dist/cli/index.js browser mark --help`
Expected: lists `focused` and `pick`; `node dist/cli/index.js browser mark focused --help` shows the required `--as <label>` option.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/browser.ts
git commit -m "feat(handles): CLI browser mark focused|pick and browser marks"
```

---

### Task 8: Full Phase-1 verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, build, and run the entire suite**

Run: `npm run typecheck && npm test`
Expected: PASS — zero TypeScript errors; all `node --test` files pass, 0 failures.

- [ ] **Step 2: Confirm no raw element data leaks from the mark routes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/browser-handles-routes.test.js`
Expected: PASS — including the assertion that `handle_fingerprint`/`backend_node_id` are absent from `/v1/browser/mark` and `/v1/browser/marks` responses.

- [ ] **Step 3: Commit a checkpoint tag for Phase 1**

```bash
git tag phase1-handles-complete
git log --oneline -8
```
Expected: the tag points at the Task 7 commit; the last ~7 commits are the Phase-1 feature commits on `feat/agentic-handles`.

---

### Task 9: Manual integration check — `Overlay.setInspectMode` in the bundled browser (residual from sign-off)

**Files:** none (manual verification; record findings in the Plan-2 notes, not code)

This is the explicit residual carried from spec sign-off. `markPick` relies on `Overlay.setInspectMode {mode:"searchForNode"}` emitting `Overlay.inspectNodeRequested` with a `backendNodeId`, and on the descriptor-shape note in Task 4 Step 2. Stubbed tests cannot prove the real CDP wire shape.

- [ ] **Step 1: Start the daemon and a real browser**

Run:
```bash
node dist/cli/index.js daemon start
node dist/cli/index.js unlock          # set a passphrase in the opened window if first run
node dist/cli/index.js browser start
```
Expected: `started: true` with a `proxy_url`.

- [ ] **Step 2: Drive a real pick**

Navigate the daemon browser to any page with a button (e.g. `https://example.com`). In a second terminal run:
```bash
node dist/cli/index.js browser mark pick --as test-btn --timeout-ms 60000
```
While it is pending, click the page's link/button in the browser window.
Expected: the command returns `{ "marked": true, "label": "test-btn", "element_kind": "link"|"button", ... }` and the click did **not** navigate/activate the control (overlay consumed it).

- [ ] **Step 3: Confirm `marks` and record the wire-shape finding**

Run: `node dist/cli/index.js browser marks`
Expected: one entry for `test-btn` with `valid: true`, no DOM text.

Record in `docs/superpowers/plans/` notes for Plan 2: whether `Runtime.callFunctionOn` returned the normalized object under `result.objectId` or top-level `objectId` (resolve the Task 4 Step 2 note accordingly before Plan 2 uses `clickBackendNode`). If `Overlay.inspectNodeRequested` did not fire, capture the raw CDP error and fix `markPick` before proceeding to Plan 2.

- [ ] **Step 4: Tear down**

Run:
```bash
node dist/cli/index.js blind end || true
pkill -f "secret-shuttle" || true
```
Expected: daemon/browser stopped.

---

## Self-Review (performed against the spec)

- **Spec coverage (Phase 1 scope):** §3.1 store purpose → Task 1; §3.2 record shape/TTL/last-write-wins/never-persisted → Task 1; §3.3 single-source `element_kind` incl. exclusions → Task 2; handle fingerprint extension → Task 3; `markFocused`/`markPick` (Overlay, normalization) / `revalidateHandle` (§3.4) → Tasks 3–4; §12 `BrowserOps` surface (`markFocused`/`markPick`/`revalidateHandle`) → Tasks 3–4; per-session reset / clear-on-start → Task 6; `marks` exposes no DOM text/fingerprint → Task 6 test; CLI `mark focused`/`mark pick`/`marks` → Task 7; §13 handle-store tests (TTL, last-write-wins, session reset, no-DOM-text, revalidation fail-closed) → Tasks 1, 6 (revalidation fail-closed paths are unit-covered via `revalidateHandle` throwing `handle_invalid`; route-level use lands in Plan 2); residual Overlay check (sign-off) → Task 9. Phases 2–5 scope is explicitly deferred to their own plans (documented above) — not a gap.
- **Placeholder scan:** no TBD/TODO; every code step contains complete code; every command has an expected result. The Task 4 Step 2 CDP wire-shape ambiguity is explicitly resolved by the Task 9 live check (named, not hand-waved).
- **Type consistency:** `ElementKind`/`BrowserHandle`/`HandleInput` (Task 1) ↔ `HandleDescriptor`/`elementKind`/`handleFingerprint` (Tasks 2–4) ↔ `services.handles` (Task 5) ↔ `put({label, ...desc})` and the `marks` projection (Task 6) ↔ CLI body `{how,label,timeout_ms}` (Task 7) all use consistent names and shapes. `revalidateHandle`'s structural parameter matches the fields persisted by `BrowserHandleStore.put`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-agentic-blind-transactions.md`. This document fully specifies **Phase 1**; Plans 2–5 are generated from the same spec once their predecessor merges (rationale in the scope section).
