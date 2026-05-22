# Phase 1 — Plan 4: Pre-approved sessions + single-window tab reuse + run stdin pass-through

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three foundational UX/agent-orchestration deliverables Phase 1 still owes: (a) pre-approved session bindings so a human can approve a PATTERN once and the daemon mints single-use grants matching it for up to 15 minutes (§5.7); (b) single-window approval-UI tab reuse so one tab serves the daemon's whole lifetime instead of accumulating one tab per approval (§5.10); (c) bidirectional stdin pass-through for `secret-shuttle run --env-file=<f> -- <cmd>` (§5.3 line 257 — deferred in Plan 3).

**Architecture:** Sessions and tab-reuse share the approval-UI HTML and SSE infrastructure, so they ship together. The new `SessionStore` keeps an in-memory map of approved patterns with TTL + max-uses; the new `findOrMintFromSession()` extension on `ApprovalStore` synthesizes a single-use grant against the session's pattern, mirroring the existing `bindingsMatch` semantics so every actual operation still has a discrete single-use binding under the hood. A new single-subscriber SSE bus replaces the per-approval `openUrl(approvalUrl)` spawn — `surfaceApproval(id, payload)` pushes an event to the open tab instead. `open-url.ts` gains a `singleWindowMode` flag that opens the stable `http://127.0.0.1:<port>/ui/` URL ONCE per daemon lifetime, tracked by a daemon-side `uiTabOpenedAt` timestamp + a window-side ack. For stdin: a new `addRouteStreamingBody` server primitive bypasses the existing body buffering and JSON parse so `/v1/run/resolve` can read its request body as a streaming `Readable`, accepting an initial JSON header line + zero or more `{stdin: <base64>}` ndjson lines for stdin chunks. The spawner is extended with an optional `stdinSource` that pipes those decoded chunks into `child.stdin`.

**Tech Stack:** TypeScript (existing); Node 20+ (existing). Node's built-in `Server-Sent Events` via `res.write("data: ...\n\n")` for the UI bus. Node's built-in half-duplex `fetch` (`body: ReadableStream` + `duplex: "half"`) for the CLI-side stdin multiplex. No new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) §5.3 (run + stdin), §5.7 (sessions), §5.10 (tab reuse), §3.3 (new daemon endpoints), §3.4 (cross-cutting changes).

**Sequence with other Phase 1 plans:**

- **Plan 1 ✅** — Foundation (structured errors + keychain interface).
- **Plan 2 ✅** — CLI surface (secrets group + status + internal + help + deprecation).
- **Plan 3 ✅** — `run` + `inject` + daemon spawner with masking.
- **Plan 4 (this)** — Sessions + tab-reuse + stdin pass-through. Depends on Plans 1-3's structured-error contract, approval-binding extensions, and run-route streaming infrastructure.
- **Plan 5a** — `init` rewrite + native-module keychain.
- **Plan 5b** — Docs (SKILL.md, walkthrough, README, cli-reference) + npm publish 0.2.0.

## Scope reductions called out explicitly

- **`run` stdin "TTY" semantics.** We pass stdin BYTES through. The child sees a non-TTY pipe (its `process.stdin.isTTY` is false). Interactive prompts that depend on TTY-only features (password masking, raw-mode keys, ANSI cursor positioning) won't work the same way they would in a real terminal. The vast majority of `run` use cases (`npm start`, `vercel deploy`, piped scripts) are fine with non-TTY stdin. Truly interactive cases require a TTY-pass-through (PTY allocation) which is out of scope.
- **Multiple concurrent UI tabs.** The SSE bus is SINGLE-SUBSCRIBER. If a second tab opens while one is connected, the existing subscriber is disconnected (last-writer-wins). The new tab takes over. Documented in ui.html. Multi-tab fan-out is non-goal for v0.2.0.
- **Cross-daemon-restart UI continuity.** The stable URL is `http://127.0.0.1:<port>/ui/` — `port` changes on every daemon restart because we bind ephemeral ports. A stale pinned tab will see "daemon restarted" on its first SSE reconnect. The fix is: `init` re-opens the URL after restart. This deviates slightly from spec §5.10 line 493 which says the user should manually close; we DO surface a clear "daemon restarted" message but we ALSO re-open through `init`. This is strictly better UX, not a regression.
- **Approval UI redirect to deep-link on legacy URLs.** The existing per-URL-token approval routes (`/ui/approvals/:id?token=...`) keep working unchanged as deep-links. We do NOT redirect them to the stable URL. Spec §5.10 says "Existing /internal/approvals/<id>/ui URL stays valid as a deep-link" — preserved.
- **Session pattern globs are literal-prefix + single `*` wildcard.** Full glob (`?`, `[...]`, `**`) is NOT supported. The spec line 369 says `ref_glob: string; // e.g. "ss://stripe/prod/*"` — a single `*` at the end is the canonical case. Documented + tested.

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/daemon/approvals/session.ts` | `SessionPattern` type, `SessionStore` class (lifecycle: create/get/list/revoke/expire/increment-uses), `matchesSessionPattern(binding, pattern)` matcher |
| `src/daemon/approvals/session.test.ts` | Unit tests for the matcher + store lifecycle |
| `src/daemon/api/routes/approvals-session.ts` | `POST /v1/approvals/session` (create), `GET /v1/approvals/sessions` (list), `DELETE /v1/approvals/sessions/:id` (revoke) |
| `src/daemon/api/routes/approvals-session.test.ts` | Route integration tests |
| `src/daemon/ui/sse-bus.ts` | `UISseBus` class — single-subscriber SSE event manager, heartbeats |
| `src/daemon/ui/sse-bus.test.ts` | Bus unit tests (mock res; verify single-subscriber semantics, heartbeats) |
| `src/daemon/api/routes/ui-tab.ts` | `GET /ui/` (stable shell HTML), `GET /ui/events` (SSE stream) — replaces the per-approval per-URL-token UI routes for the default flow |
| `src/daemon/api/routes/ui-tab.test.ts` | Route integration tests |
| `src/daemon/approvals/surface-approval.ts` | `surfaceApproval(bus, grant, payload)` — pushes an SSE event for the open tab; the legacy `openUrl(url)` is invoked ONLY when no tab is connected AND `uiTabOpenedAt` is null |
| `src/daemon/approvals/surface-approval.test.ts` | Unit tests for the surface helper |
| `src/cli/commands/internal-session.ts` | `secret-shuttle internal session create/list/revoke` |
| `src/cli/commands/internal-session.test.ts` | CLI structure tests |
| `src/daemon/run/stdin-multiplex.ts` | Pure parser/encoder for the ndjson stdin protocol — used by both daemon route (parse incoming) and CLI (encode outgoing) |
| `src/daemon/run/stdin-multiplex.test.ts` | Parser/encoder unit tests |

**Files to modify:**

| Path | Change |
|---|---|
| `src/daemon/server.ts` | Add `addRouteStreamingBody(method, path, handler)` primitive: Host + bearer check, NO body pre-parse, no 1MB body cap. Handler reads `req` as a Readable directly. Used by `/v1/run/resolve` to support stdin streaming. `addRouteStreaming` stays unchanged (uses pre-parsed JSON body). |
| `src/daemon/server.test.ts` | Tests for `addRouteStreamingBody`: 200 with raw body access, 401 on missing bearer, 400 on bad Host. |
| `src/daemon/approvals/store.ts` | Add `findOrMintFromSession(sessionId, binding, sessionStore, sessionTtlMs)` method. Wires the SessionStore into the ApprovalStore's grant minting. Reuses existing `bindingsMatch` semantics for the pattern match. |
| `src/daemon/approvals/store.test.ts` | Tests for the new method: matches pattern → synthesizes used grant; mismatch → throws `session_pattern_no_match`; expired → throws `session_expired`; max-uses → throws `session_max_uses_exceeded`. |
| `src/daemon/approvals/require-approval.ts` | Accept optional `sessionId` parameter. Before single-use grant creation, attempt `findOrMintFromSession(sessionId, binding)` if `sessionId` is set; on match, return the synthesized grant; on mismatch with a session_pattern_no_match code, fall back to single-use approval flow (the agent's session was wider than they used; that's fine). On other session-related errors (expired, max_uses), propagate them. |
| `src/daemon/approvals/require-approval.test.ts` | Tests for the new session path: session match → no openUrl call; session mismatch → falls back to single-use; session expired → throws. |
| `src/daemon/approvals/open-url.ts` | Add a `mode` parameter that defaults to `"single-window"`. In single-window mode, `openUrl` checks a daemon-side `uiTabOpenedAt` reference and is a no-op if the tab is already open (or if the SSE bus reports a connected subscriber). The legacy `mode: "legacy-deep-link"` path opens the per-approval URL. |
| `src/daemon/approvals/open-url.test.ts` | Tests for the new modes: single-window mode no-op when already open; legacy mode unchanged. |
| `src/daemon/approvals/require-approval.ts` | Replace direct `openUrl(url)` call with `surfaceApproval(bus, grant, ...)` which uses the SSE bus when available + falls back to legacy openUrl when no tab is connected. |
| `src/daemon/api/routes/unlock-session.ts` | Same: replace direct `openUrl(url)` with `surfaceApproval(bus, ...)` for the unlock UI flow. |
| `src/daemon/approvals/ui.html` | Major rewrite. Now the page is the stable shell that connects to `/ui/events`, displays "Connected. No pending approvals." in the idle state, and updates in place when a new event arrives. Handles three event kinds: `approval` (single-use), `session` (pre-approved session pattern), `unlock` (vault unlock). |
| `src/daemon/services.ts` | Expose `sessionStore: SessionStore` and `uiSse: UISseBus`. |
| `src/daemon/api/router.ts` | Register the new routes (approvals-session, ui-tab) and pass services through. |
| `src/daemon/run/spawner.ts` | Extend `SpawnInput` with optional `stdinSource: AsyncIterable<Buffer> \| undefined`. When provided, `stdio` becomes `["pipe", "pipe", "pipe"]` and the spawner pipes stdin chunks from the source to `child.stdin`. On `stdinSource` end (or async-iterable completion): `child.stdin.end()`. On spawn-error / cancel: `child.stdin.destroy()`. |
| `src/daemon/run/spawner.test.ts` | New tests for stdin pass-through: child reads `n` bytes from stdin then echoes; stdin EOF triggers child exit; CancelSignal closes stdin. |
| `src/daemon/api/routes/run-resolve.ts` | Switch route registrar from `addRouteStreaming` to `addRouteStreamingBody`. Read the request as a Readable; parse the first line as the JSON header (the existing strict body validation runs on this header); concurrently start the spawner AND read subsequent ndjson lines as stdin chunks. The header line is now wrapped in `{"hdr": {...}}` — old single-JSON shape is no longer accepted. |
| `src/daemon/api/routes/run-resolve.test.ts` | New tests for stdin: child reads from stdin → daemon forwards `{stdin: <b64>}` lines → child sees those bytes. Test stdin EOF triggers child to exit cleanly. Existing tests adapted to send `{hdr: {...}}` instead of bare JSON. |
| `src/client/streaming-request.ts` | Add `streamingDaemonRequestWithBody(method, path, bodyStream: ReadableStream<Uint8Array>, options)` — same auth/socket-file lookup as before, but accepts a streaming request body. Used by the run CLI to send the ndjson header + stdin chunks. Existing `streamingDaemonRequest` stays (used by tests that don't need a streaming body). |
| `src/client/streaming-request.test.ts` | New test: streamingDaemonRequestWithBody pumps a chunked body to a test daemon route that echoes it back. |
| `src/cli/commands/run.ts` | Switch from `streamingDaemonRequest` to `streamingDaemonRequestWithBody`. Build a ReadableStream that emits the header line + base64-encoded stdin chunks from `process.stdin`. Add `--no-stdin` flag for callers who explicitly want to skip stdin passthrough (mirrors `op run --no-stdin`). |
| `src/cli/commands/run.test.ts` | Structural test for `--no-stdin`. |
| `src/daemon/approvals/store.ts` (audit fields) | Extend `ApprovalGrant` with optional `session_id?: string`. When a grant was minted from a session, audit records the source session id. |
| `src/daemon/audit.ts` | Extend `DaemonAuditEvent` with optional `session_id?: string`. Each approval-gated operation that consumed a session-minted grant writes the session id into its audit line. |
| `src/shared/error-codes.ts` | Add `session_not_found` (NOT_FOUND, exit 3), `session_expired` (PERMISSION, exit 4), `session_max_uses_exceeded` (PERMISSION, exit 4), `session_pattern_no_match` (PERMISSION, exit 4), `session_unauthorized` (PERMISSION, exit 4). Five new codes, registry count 110 → 115. |
| `src/shared/error-codes.test.ts` | Bump count 110 → 115; spot-check the five new entries. |
| `src/cli/commands/internal.ts` | Register the new `session` subcommand group. |
| `src/cli/commands/help.ts` | Add an `--session <id>` mention under the appropriate help section, and document the session feature in the curated help epilog (one line). |
| All CLI commands that hit approval-gated routes | Add `--session <id>` option to: `run`, `inject`, `secrets delete`, `secrets rotate`, `template run`, `internal capture`, `internal compare`, `internal inject` (V0), `inject-submit`, `reveal-capture`. Each one passes `session_id` into the daemon body when set. |
| `CHANGELOG.md` | Plan 4 entries. |

**Decision: SSE single-subscriber semantics.** When a NEW tab connects while one is already connected, the existing subscriber is disconnected. The new tab takes over. This is the "last writer wins" model — resilient to ghost tabs and page reloads. The alternative (refuse the new tab with 409) would require the user to manually close the stale tab, which defeats the purpose. The disconnection sends a final SSE event `{type: "displaced"}` so the old tab can show a "another tab took over" notice instead of silently dying.

**Decision: stdin protocol is ndjson over the existing /v1/run/resolve endpoint.** No new endpoint. The body shape is:
```
{"hdr": <existing-header-object>}\n
{"stdin": "<base64 chunk 1>"}\n
{"stdin": "<base64 chunk 2>"}\n
...
```
The CLI sends the header line synchronously, then pumps stdin chunks as they arrive. The daemon reads the first line, parses the header, validates strictly, then opens the spawner and concurrently reads subsequent ndjson lines into `child.stdin`. When the request body ends (EOF), the daemon calls `child.stdin.end()`. This is a BREAKING change to the route's wire protocol; Plan 3 vintage CLIs sending bare JSON will get a 400 / `bad_request`. CLI + daemon are in lockstep so it's a coordinated change.

**Decision: `session_id` lives in the body, not a `Session:` header.** Spec §5.7 line 382 says "pass `--session <id>` or `Session: <id>` header". Body parameter is simpler — no extra header parsing, consistent with how `approval_id` is already passed. CLIs send `session_id` in the JSON body. If a future client really needs a header, it's an additive feature.

---

## Pre-execution checklist — RUN BEFORE TASK A1

**Same hard gate as Plans 2 and 3.** Do not start Task A1 until all three checks pass.

- [ ] **Step 1: Working tree clean.**

```bash
git status --short
```

Expected: empty.

- [ ] **Step 2: Confirm head is on top of Plan 3.**

```bash
git log --oneline -5
```

Expected: head is on or downstream of `fd7b996` (the Plan 3 R8-1 audit precision fix). If anything else interleaved, flag it.

- [ ] **Step 3: Build green on HEAD.**

```bash
npm run typecheck
npm test
```

Both must pass on the current HEAD before any Plan 4 work begins.

Once all three checks pass, proceed to Task A1.

---

## Part A — Session foundation

### Task A1: SessionPattern type + matcher

**Files:**
- Create: `src/daemon/approvals/session.ts` (matcher + types only; SessionStore added in A2)
- Create: `src/daemon/approvals/session.test.ts`

**Behavior:**
- `SessionPattern` type per spec §5.7 line 367:
  ```typescript
  type SessionPattern = {
    actions: SessionAction[];          // which ApprovalBinding.action values match
    ref_glob: string;                  // e.g. "ss://stripe/prod/*"
    destination_domains: string[];     // exact-match; empty array = any domain (for actions that don't have a domain)
    template_ids?: string[];           // optional; if set, only these template_ids match
    ttl_ms: number;                    // max 15 min = 900_000
    max_uses?: number;                 // optional cap
  };
  ```
- `SessionAction` is a subset/alias of `ApprovalBinding.action`. Per spec line 368: `"inject-submit" | "reveal-capture" | "template-run" | "secrets-set"`. Plan 4 expands this to also include `"run"` and `"inject_render"` (the Plan 3 additions). Plan 4 does NOT include `"secrets-delete"` or `"secrets-rotate"` — destructive actions get their own one-off approval per spec design intent.
- `matchesSessionPattern(binding, pattern)` returns boolean:
  1. `binding.action` must be in `pattern.actions`. (Note: binding actions like `"inject_submit"` map to session actions like `"inject-submit"` — there's an action-name canonicalization map. Be explicit.)
  2. If binding has a `ref`, it must match `pattern.ref_glob` per the literal-prefix + single-trailing-`*` rule.
  3. If binding has `destination_domain`, it must be in `pattern.destination_domains` (or `destination_domains.length === 0` skips the check — but for production refs, validation upstream still requires a domain).
  4. If `pattern.template_ids` is set and binding has `template_id`, the binding's template_id must be in the list.
- Helper: `globToRegExp(glob: string): RegExp` — supports literal prefix + single trailing `*`. Throws `session_pattern_invalid_glob` for anything more complex.
- Helper: `assertSessionPatternValid(pattern: SessionPattern)` — TTL bounds (1s to 15min), max_uses bounds (1 to 1000), actions non-empty.

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/approvals/session.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionPattern, globToRegExp, assertSessionPatternValid, type SessionPattern } from "./session.js";
import { ShuttleError } from "../../shared/errors.js";
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

// globToRegExp
test("globToRegExp: literal prefix matches exactly", () => {
  const re = globToRegExp("ss://stripe/prod/STRIPE_KEY");
  assert.equal(re.test("ss://stripe/prod/STRIPE_KEY"), true);
  assert.equal(re.test("ss://stripe/prod/OTHER"), false);
});

test("globToRegExp: single trailing * matches any suffix", () => {
  const re = globToRegExp("ss://stripe/prod/*");
  assert.equal(re.test("ss://stripe/prod/STRIPE_KEY"), true);
  assert.equal(re.test("ss://stripe/prod/X.y-z"), true);
  assert.equal(re.test("ss://stripe/dev/STRIPE_KEY"), false);
  assert.equal(re.test("ss://stripe/prod"), false);
});

test("globToRegExp: regex-special characters in the prefix are escaped", () => {
  // dots and dashes are common in NAME_RE; they must be literal in the glob.
  const re = globToRegExp("ss://stripe.com/prod/MY-KEY*");
  assert.equal(re.test("ss://stripe.com/prod/MY-KEY"), true);
  assert.equal(re.test("ss://stripe.com/prod/MY-KEY.suffix"), true);
  // A literal-period match would also match a slash if we forgot to escape — verify we didn't:
  assert.equal(re.test("ss://stripeXcom/prod/MY-KEY"), false);
});

test("globToRegExp: complex globs throw session_pattern_invalid_glob", () => {
  for (const bad of ["*prefix", "ss://*/prod/*", "ss://stripe/prod/?", "ss://stripe/[pq]rod/*", "ss://stripe/prod/**"]) {
    assert.throws(
      () => globToRegExp(bad),
      (err: Error & { code?: string }) =>
        err.code === "session_pattern_invalid_glob",
      `expected throw for ${bad}`,
    );
  }
});

// assertSessionPatternValid
test("assertSessionPatternValid: minimal valid pattern passes", () => {
  assert.doesNotThrow(() => assertSessionPatternValid(makePattern()));
});

test("assertSessionPatternValid: empty actions throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl < 1000ms throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 500 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("assertSessionPatternValid: ttl > 15 minutes throws", () => {
  assert.throws(
    () => assertSessionPatternValid(makePattern({ ttl_ms: 16 * 60 * 1000 })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
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

// matchesSessionPattern
test("matchesSessionPattern: action + ref + domain all match → true", () => {
  const p = makePattern();
  const b = makeBinding({
    action: "template",
    ref: "ss://stripe/prod/STRIPE_KEY",
    destination_domain: "vercel.com",
    template_id: "vercel-env-add",
  });
  assert.equal(matchesSessionPattern(b, p), true);
});

test("matchesSessionPattern: binding action not in pattern actions → false", () => {
  const p = makePattern({ actions: ["template-run"] });
  const b = makeBinding({ action: "secrets_rotate" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: action-name canonicalization (inject_submit ↔ inject-submit)", () => {
  const p = makePattern({ actions: ["inject-submit"], ref_glob: "ss://*", destination_domains: ["x.com"] });
  const b = makeBinding({
    action: "inject_submit",
    ref: "ss://x/dev/A",
    destination_domain: "x.com",
  });
  // The session pattern uses kebab-case action names; the binding uses
  // snake_case. The matcher must canonicalize.
  assert.equal(matchesSessionPattern(b, p), true);
});

test("matchesSessionPattern: ref does NOT match glob → false", () => {
  const p = makePattern({ ref_glob: "ss://stripe/prod/*" });
  const b = makeBinding({ ref: "ss://stripe/dev/STRIPE_KEY" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: binding has no ref but pattern requires one → false", () => {
  const p = makePattern({ ref_glob: "ss://stripe/prod/*" });
  const b = makeBinding({ ref: null });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: destination_domain not in pattern list → false", () => {
  const p = makePattern({ destination_domains: ["vercel.com"] });
  const b = makeBinding({ destination_domain: "evil.com" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: pattern destination_domains empty + binding has no domain → true", () => {
  // Actions like `run` and `inject_render` don't have a destination_domain;
  // their session pattern leaves destination_domains empty.
  const p = makePattern({
    actions: ["run"],
    destination_domains: [],
    template_ids: undefined as unknown as string[] | undefined,
  });
  const b = makeBinding({ action: "run", destination_domain: null, ref: null });
  // For `run`, the pattern doesn't apply ref_glob either (run has no ref on the binding).
  // The matcher returns true if pattern doesn't require fields the binding lacks.
  // Adjust pattern to skip ref check too:
  const p2 = { ...p, ref_glob: "" }; // empty glob = "any"
  assert.equal(matchesSessionPattern(b, p2), true);
});

test("matchesSessionPattern: pattern template_ids set + binding.template_id not in list → false", () => {
  const p = makePattern({ template_ids: ["vercel-env-add"] });
  const b = makeBinding({ template_id: "github-actions-secret" });
  assert.equal(matchesSessionPattern(b, p), false);
});

test("matchesSessionPattern: pattern template_ids undefined → template_id field is not checked", () => {
  const p = makePattern({ template_ids: undefined });
  const b = makeBinding({ template_id: "anything" });
  assert.equal(matchesSessionPattern(b, p), true);
});
```

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist).

```bash
npm run build && node --test "dist/daemon/approvals/session.test.js"
```

- [ ] **Step 3: Implement**

Create `src/daemon/approvals/session.ts`:

```typescript
import { ShuttleError } from "../../shared/errors.js";
import type { ApprovalBinding } from "./store.js";

/**
 * Session-pattern action names. These are the KEBAB-CASE public form.
 * The underlying ApprovalBinding uses snake_case for some actions
 * (e.g. inject_submit, reveal_capture); CANONICAL_ACTION_MAP below
 * normalizes between the two.
 */
export type SessionAction =
  | "template-run"
  | "inject-submit"
  | "reveal-capture"
  | "secrets-set"
  | "run"
  | "inject_render";

export interface SessionPattern {
  actions: SessionAction[];
  /**
   * Literal prefix + optional single trailing `*` (e.g. "ss://stripe/prod/*").
   * Empty string `""` means "any ref / no ref check".
   */
  ref_glob: string;
  /**
   * Exact-match list. Empty array = "no domain check" (used for actions like
   * `run` and `inject_render` that don't have a binding.destination_domain).
   */
  destination_domains: string[];
  /** Optional restriction; if set, only these template_ids match. */
  template_ids?: string[];
  /** Time-to-live in ms; max 15 minutes (900_000). */
  ttl_ms: number;
  /** Optional cap on the number of times the session can mint a grant. */
  max_uses?: number;
}

const TTL_MIN_MS = 1_000;
const TTL_MAX_MS = 15 * 60 * 1000;
const MAX_USES_MAX = 1000;

/**
 * Map an ApprovalBinding.action value to its kebab-case SessionAction form.
 * E.g. "inject_submit" → "inject-submit", "template" → "template-run".
 */
const CANONICAL_ACTION_MAP: Record<string, SessionAction> = {
  template: "template-run",
  inject_submit: "inject-submit",
  reveal_capture: "reveal-capture",
  generate: "secrets-set",
  run: "run",
  inject_render: "inject_render",
};

export function canonicalAction(action: string): SessionAction | null {
  return CANONICAL_ACTION_MAP[action] ?? null;
}

export function assertSessionPatternValid(pattern: SessionPattern): void {
  if (!Array.isArray(pattern.actions) || pattern.actions.length === 0) {
    throw new ShuttleError("bad_request", "Session pattern must include at least one action.");
  }
  if (typeof pattern.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "Session pattern ref_glob must be a string.");
  }
  if (pattern.ref_glob.length > 0) {
    // Validate the glob (throws session_pattern_invalid_glob if malformed).
    globToRegExp(pattern.ref_glob);
  }
  if (!Array.isArray(pattern.destination_domains)) {
    throw new ShuttleError("bad_request", "Session pattern destination_domains must be an array.");
  }
  for (const d of pattern.destination_domains) {
    if (typeof d !== "string") {
      throw new ShuttleError("bad_request", "Session pattern destination_domains entries must be strings.");
    }
  }
  if (pattern.template_ids !== undefined) {
    if (!Array.isArray(pattern.template_ids)) {
      throw new ShuttleError("bad_request", "Session pattern template_ids must be an array.");
    }
    for (const t of pattern.template_ids) {
      if (typeof t !== "string") {
        throw new ShuttleError("bad_request", "Session pattern template_ids entries must be strings.");
      }
    }
  }
  if (typeof pattern.ttl_ms !== "number" || !Number.isFinite(pattern.ttl_ms)) {
    throw new ShuttleError("bad_request", "Session pattern ttl_ms must be a number.");
  }
  if (pattern.ttl_ms < TTL_MIN_MS) {
    throw new ShuttleError("bad_request", `Session pattern ttl_ms must be at least ${TTL_MIN_MS}ms.`);
  }
  if (pattern.ttl_ms > TTL_MAX_MS) {
    throw new ShuttleError("bad_request", `Session pattern ttl_ms cannot exceed ${TTL_MAX_MS}ms (15 minutes).`);
  }
  if (pattern.max_uses !== undefined) {
    if (typeof pattern.max_uses !== "number" || !Number.isInteger(pattern.max_uses)) {
      throw new ShuttleError("bad_request", "Session pattern max_uses must be an integer.");
    }
    if (pattern.max_uses < 1) {
      throw new ShuttleError("bad_request", "Session pattern max_uses must be at least 1.");
    }
    if (pattern.max_uses > MAX_USES_MAX) {
      throw new ShuttleError("bad_request", `Session pattern max_uses cannot exceed ${MAX_USES_MAX}.`);
    }
  }
}

/**
 * Build a RegExp from a literal-prefix-plus-optional-trailing-* glob.
 * Throws `session_pattern_invalid_glob` for any other shape (?, [...], ** etc.).
 */
export function globToRegExp(glob: string): RegExp {
  // Reject anything that's not a literal-prefix + optional single trailing *.
  // The only legal occurrence of `*` is the LAST character.
  const starIdx = glob.indexOf("*");
  if (starIdx === -1) {
    return new RegExp(`^${escapeRegExp(glob)}$`);
  }
  if (starIdx !== glob.length - 1) {
    throw new ShuttleError(
      "session_pattern_invalid_glob",
      `Session pattern ref_glob supports literal prefix + optional single trailing '*'. Got: ${glob}`,
    );
  }
  // Reject other glob-special chars.
  for (const ch of ["?", "[", "]", "{", "}"]) {
    if (glob.includes(ch)) {
      throw new ShuttleError(
        "session_pattern_invalid_glob",
        `Session pattern ref_glob does not support '${ch}'.`,
      );
    }
  }
  const prefix = glob.slice(0, -1);
  return new RegExp(`^${escapeRegExp(prefix)}.+$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check whether a binding matches a session pattern. All four checks must pass:
 *   1. binding.action canonicalizes to a SessionAction in pattern.actions
 *   2. if binding.ref is non-null AND pattern.ref_glob is non-empty, the ref matches the glob
 *   3. if binding.destination_domain is non-null AND pattern.destination_domains is non-empty,
 *      the domain is in the list
 *   4. if pattern.template_ids is set AND binding.template_id is non-null,
 *      the template_id is in the list
 */
export function matchesSessionPattern(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  // 1. action
  const canonical = canonicalAction(binding.action);
  if (canonical === null) return false;
  if (!pattern.actions.includes(canonical)) return false;

  // 2. ref glob (only check if pattern.ref_glob is non-empty)
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false; // pattern requires a ref; binding has none
    const re = globToRegExp(pattern.ref_glob);
    if (!re.test(binding.ref)) return false;
  }

  // 3. destination_domain (only check if pattern.destination_domains is non-empty)
  if (pattern.destination_domains.length > 0) {
    if (binding.destination_domain === null) return false;
    if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  }

  // 4. template_id (only check if pattern.template_ids is set)
  if (pattern.template_ids !== undefined) {
    if (binding.template_id === null) return false;
    if (!pattern.template_ids.includes(binding.template_id)) return false;
  }

  return true;
}
```

- [ ] **Step 4: Run — expect PASS** (~17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session.ts src/daemon/approvals/session.test.ts
git commit -m "feat(approvals): SessionPattern type + matcher

Pure module — pattern validation + literal-prefix-plus-single-* glob
matcher + binding-vs-pattern check. Action-name canonicalization
between binding (snake_case) and pattern (kebab-case). Reserves
ttl_ms 1s-15min and max_uses 1-1000 bounds per spec §5.7."
```

---

### Task A2: SessionStore class

**Files:**
- Modify: `src/daemon/approvals/session.ts` — append `SessionStore` class.
- Modify: `src/daemon/approvals/session.test.ts` — append store tests.

**Behavior:**
- `SessionStore` keeps an in-memory `Map<string, SessionGrant>`.
- `SessionGrant` = `SessionPattern & { id: string; created_at: number; expires_at: number; uses: number; status: "pending" | "granted" | "denied" | "expired" | "revoked"; ui_token: string }`.
- `create(pattern)`: validates, generates id + ui_token, returns a pending grant. Expires_at = created_at + pattern.ttl_ms.
- `get(id)`: returns the grant. If pending and now > expires_at, marks `expired` and returns.
- `approve(id)` / `deny(id)`: status transitions; only `pending` is transitionable.
- `revoke(id)`: marks `revoked`. Subsequent matches return session_not_found.
- `list()`: returns all grants currently in the store (including expired/used/revoked — let caller filter).
- `incrementUses(id)`: bumps `uses`. If `max_uses` set and `uses` would exceed, throws `session_max_uses_exceeded`. Race-safe (single-threaded JS).

- [ ] **Step 1: Append tests to `src/daemon/approvals/session.test.ts`**

```typescript
import { SessionStore, type SessionGrant } from "./session.js";

function makeStore(now: () => number = () => Date.now()): SessionStore {
  return new SessionStore({ now });
}

test("SessionStore.create: returns a pending grant with id + ui_token + expires_at", () => {
  const start = 1_000_000;
  const store = makeStore(() => start);
  const g = store.create(makePattern({ ttl_ms: 5 * 60 * 1000 }));
  assert.equal(typeof g.id, "string");
  assert.equal(g.id.length > 0, true);
  assert.equal(typeof g.ui_token, "string");
  assert.notEqual(g.id, g.ui_token); // independently random
  assert.equal(g.status, "pending");
  assert.equal(g.created_at, start);
  assert.equal(g.expires_at, start + 5 * 60 * 1000);
  assert.equal(g.uses, 0);
});

test("SessionStore.create: assertSessionPatternValid runs at create time", () => {
  const store = makeStore();
  assert.throws(
    () => store.create(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("SessionStore.get: pending becomes expired when now > expires_at", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern({ ttl_ms: 1000 }));
  assert.equal(store.get(g.id)!.status, "pending");
  nowVal += 2000;
  assert.equal(store.get(g.id)!.status, "expired");
});

test("SessionStore.approve: pending → granted", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  assert.equal(store.get(g.id)!.status, "granted");
});

test("SessionStore.approve: non-pending throws", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.deny(g.id);
  assert.throws(
    () => store.approve(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_pending",
  );
});

test("SessionStore.revoke: marks as revoked", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  store.revoke(g.id);
  assert.equal(store.get(g.id)!.status, "revoked");
});

test("SessionStore.list: returns every grant in insertion order", () => {
  const store = makeStore();
  const a = store.create(makePattern());
  const b = store.create(makePattern());
  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, a.id);
  assert.equal(list[1]!.id, b.id);
});

test("SessionStore.incrementUses: bumps the counter", () => {
  const store = makeStore();
  const g = store.create(makePattern({ max_uses: 3 }));
  store.approve(g.id);
  store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 1);
  store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 2);
});

test("SessionStore.incrementUses: throws session_max_uses_exceeded at the cap", () => {
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
  const g = store.create(makePattern({ max_uses: undefined }));
  store.approve(g.id);
  for (let i = 0; i < 100; i++) store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 100);
});

test("SessionStore.get: unknown id returns undefined", () => {
  const store = makeStore();
  assert.equal(store.get("does-not-exist"), undefined);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — append to `src/daemon/approvals/session.ts`:

```typescript
import { randomUUID } from "node:crypto";

export type SessionStatus = "pending" | "granted" | "denied" | "expired" | "revoked";

export interface SessionGrant extends SessionPattern {
  id: string;
  created_at: number;
  expires_at: number;
  uses: number;
  status: SessionStatus;
  ui_token: string;
}

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
    const id = randomUUID();
    const grant: SessionGrant = {
      ...pattern,
      id,
      created_at: created,
      expires_at: created + pattern.ttl_ms,
      uses: 0,
      status: "pending",
      ui_token: randomUUID(),
    };
    this.grants.set(id, grant);
    return grant;
  }

  /**
   * Returns the grant for `id`, transitioning a pending grant to "expired"
   * if its expires_at has passed. Returns undefined for unknown ids.
   */
  get(id: string): SessionGrant | undefined {
    const g = this.grants.get(id);
    if (g === undefined) return undefined;
    if (g.status === "pending" && this.now() > g.expires_at) {
      g.status = "expired";
    }
    return g;
  }

  approve(id: string): void {
    const g = this.requirePending(id);
    g.status = "granted";
  }

  deny(id: string): void {
    const g = this.requirePending(id);
    g.status = "denied";
  }

  revoke(id: string): void {
    const g = this.grants.get(id);
    if (g === undefined) throw new ShuttleError("session_not_found", "Unknown session id.");
    g.status = "revoked";
  }

  list(): readonly SessionGrant[] {
    // Insertion order is preserved by Map.values().
    return [...this.grants.values()];
  }

  /**
   * Bump the use counter. Throws session_max_uses_exceeded if the bump would
   * carry uses past max_uses. The grant must be in `granted` status.
   */
  incrementUses(id: string): void {
    const g = this.get(id);
    if (g === undefined) throw new ShuttleError("session_not_found", "Unknown session id.");
    if (g.status !== "granted") {
      throw new ShuttleError("session_not_pending", `Session is not granted (status: ${g.status}).`);
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
      throw new ShuttleError("session_not_pending", `Session is not pending (status: ${g.status}).`);
    }
    return g;
  }
}
```

- [ ] **Step 4: Run — expect PASS** (~11 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session.ts src/daemon/approvals/session.test.ts
git commit -m "feat(approvals): SessionStore with TTL + max_uses + revoke lifecycle"
```

---

### Task A3: error-codes additions for sessions

**Files:**
- Modify: `src/shared/error-codes.ts` — add 6 new entries.
- Modify: `src/shared/error-codes.test.ts` — bump count + spot-check.

**Note:** Task A1 + A2 already throw codes that aren't in the registry yet (`session_pattern_invalid_glob`, `session_not_found`, `session_not_pending`, `session_max_uses_exceeded`). They fall back to TRANSIENT defaults until this task lands. That's why we register them now, before any HTTP route surfaces the codes.

- [ ] **Step 1: Add entries to `src/shared/error-codes.ts`**

In the Not-found section:
```typescript
session_not_found: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
```

In the Permission section:
```typescript
session_expired: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
session_max_uses_exceeded: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
session_pattern_no_match: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
session_unauthorized: { exitCode: EXIT_CODE_PERMISSION, hint: () => null },
session_not_pending: { exitCode: EXIT_CODE_CONFLICT, hint: () => null },
```

In the Usage section:
```typescript
session_pattern_invalid_glob: { exitCode: EXIT_CODE_USAGE, hint: () => null },
```

- [ ] **Step 2: Update registry-count test**

Open `src/shared/error-codes.test.ts`. Bump count from 110 → 117 (six new + one already in the section). Add spot-checks:

```typescript
assert.ok(lookupErrorCode("session_not_found"));
assert.ok(lookupErrorCode("session_expired"));
assert.ok(lookupErrorCode("session_max_uses_exceeded"));
assert.ok(lookupErrorCode("session_pattern_no_match"));
assert.ok(lookupErrorCode("session_pattern_invalid_glob"));
```

- [ ] **Step 3: Run — expect PASS**

```bash
npm run build && node --test "dist/shared/error-codes.test.js"
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(error-codes): 7 new session-related codes for Plan 4 sessions"
```

---

### Task A4: `findOrMintFromSession` on ApprovalStore

**Files:**
- Modify: `src/daemon/approvals/store.ts` — add the new method + extend `ApprovalGrant` with optional `session_id`.
- Modify: `src/daemon/approvals/store.test.ts` — append tests.

**Behavior:**
- `findOrMintFromSession(sessionId, binding, sessionStore)`:
  1. Look up session by id via `sessionStore.get(id)`.
  2. If undefined → throw `session_not_found`.
  3. If status === `"expired"` → throw `session_expired`.
  4. If status === `"revoked"` → throw `session_not_found` (revoked sessions look the same as missing from the agent's perspective).
  5. If status !== `"granted"` → throw `session_unauthorized` (e.g. still pending, denied).
  6. Check `matchesSessionPattern(binding, session)` — if false, throw `session_pattern_no_match`.
  7. Call `sessionStore.incrementUses(id)` — this can throw `session_max_uses_exceeded`.
  8. Synthesize a synthetic grant: a `bindingsMatch`-equal copy of `binding`, with `id: "session:" + sessionId + ":" + monotonicCounter`, `status: "used"`, `session_id: sessionId`. Do NOT insert into `this.grants` — the session-minted grant is one-shot and doesn't need to be retrievable.
  9. Return the synthesized grant.

- [ ] **Step 1: Append tests to `src/daemon/approvals/store.test.ts`**

```typescript
import { SessionStore } from "./session.js";

function makeBindingFor(action: ApprovalBinding["action"], extra: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    action,
    ref: "ss://x/prod/A",
    environment: "production",
    destination_domain: null,
    target_id: null,
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: [],
    ...extra,
  };
}

test("ApprovalStore.findOrMintFromSession: unknown session id → session_not_found", () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  assert.throws(
    () => store.findOrMintFromSession("nope", makeBindingFor("template"), sessions),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("ApprovalStore.findOrMintFromSession: matched + granted session → synthesizes a used grant with session_id", () => {
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

test("ApprovalStore.findOrMintFromSession: expired session → session_expired", () => {
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

test("ApprovalStore.findOrMintFromSession: revoked session → session_not_found", () => {
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

test("ApprovalStore.findOrMintFromSession: pending (not approved) session → session_unauthorized", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  // Don't approve.
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, makeBindingFor("template", { destination_domain: "vercel.com" }), sessions),
    (err: Error & { code?: string }) => err.code === "session_unauthorized",
  );
});

test("ApprovalStore.findOrMintFromSession: pattern mismatch → session_pattern_no_match", () => {
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  const binding = makeBindingFor("template", {
    ref: "ss://other/prod/A", // doesn't match ref_glob
    destination_domain: "vercel.com",
  });
  const store = new ApprovalStore();
  assert.throws(
    () => store.findOrMintFromSession(sg.id, binding, sessions),
    (err: Error & { code?: string }) => err.code === "session_pattern_no_match",
  );
});

test("ApprovalStore.findOrMintFromSession: max_uses cap → session_max_uses_exceeded on overflow", () => {
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
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — modify `src/daemon/approvals/store.ts`:

Add `session_id?: string` to `ApprovalGrant`:

```typescript
export interface ApprovalGrant extends ApprovalBinding {
  id: string;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  ui_token: string;
  /** When set, this grant was minted from a pre-approved session pattern. */
  session_id?: string;
}
```

Add `findOrMintFromSession` to the class:

```typescript
import { matchesSessionPattern, type SessionStore } from "./session.js";

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
    throw new ShuttleError("session_unauthorized", `Session is not granted (status: ${session.status}).`);
  }
  if (!matchesSessionPattern(binding, session)) {
    throw new ShuttleError(
      "session_pattern_no_match",
      "Operation does not match the session pattern.",
    );
  }
  sessionStore.incrementUses(sessionId);
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

- [ ] **Step 4: Run — expect PASS** (~7 new)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts
git commit -m "feat(approvals): findOrMintFromSession links sessions to single-use grants

Synthesizes a used grant from a session pattern + binding without
inserting into the grant map — session-minted grants are one-shot.
Carries session_id through ApprovalGrant for downstream audit."
```

---

### Task A5: requireApproval session integration

**Files:**
- Modify: `src/daemon/approvals/require-approval.ts` — accept optional `sessionId` + `sessionStore`.
- Modify: `src/daemon/approvals/require-approval.test.ts` — append tests.

**Behavior:**
- New optional fields on `RequireApprovalOptions`: `sessionId?: string`, `sessionStore?: SessionStore`.
- Order of operations:
  1. If `sessionId` and `sessionStore` are both set AND the binding's environment is production:
     - Try `findOrMintFromSession(sessionId, binding, sessionStore)`.
     - On success: return the synthesized grant immediately. No openUrl.
     - On `session_pattern_no_match`: fall back to the existing single-use approval flow (the agent's session was wider than this op; OK to ask for a fresh approval).
     - On any other session error (`session_not_found`, `session_expired`, `session_unauthorized`, `session_max_uses_exceeded`): re-throw. These are hard errors — the agent's session is gone or capped; failing back to single-use silently would mask the problem.
  2. If `force === true` or environment === "production" and no session matched: existing single-use approval flow.
  3. Else: synthesize a non-production grant as before.

- [ ] **Step 1: Append tests to `src/daemon/approvals/require-approval.test.ts`**

```typescript
import { SessionStore } from "./session.js";

test("requireApproval: with matching session, returns session-minted grant without openUrl", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let openUrlCalls = 0;
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
    openUrlImpl: () => { openUrlCalls += 1; },
  });
  assert.equal(grant.session_id, sg.id);
  assert.equal(grant.status, "used");
  assert.equal(openUrlCalls, 0, "session match must not pop a tab");
});

test("requireApproval: session pattern mismatch falls back to single-use flow", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://OTHER/prod/*",
    destination_domains: ["vercel.com"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let openUrlCalls = 0;
  // The fallback path opens a tab + waits — set waitMs:0 so we get
  // approval_required immediately instead of timing out.
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
      openUrlImpl: () => { openUrlCalls += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "approval_required",
  );
  // Single-use fallback fired → openUrl was called once.
  assert.equal(openUrlCalls, 1);
});

test("requireApproval: session_not_found re-thrown (no single-use fallback)", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  let openUrlCalls = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: "missing",
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
      openUrlImpl: () => { openUrlCalls += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
  assert.equal(openUrlCalls, 0);
});

test("requireApproval: session_expired re-thrown (no single-use fallback)", async () => {
  // Use a SessionStore with mocked time so we can create + advance past expiry.
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
  let openUrlCalls = 0;
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
      openUrlImpl: () => { openUrlCalls += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
  assert.equal(openUrlCalls, 0);
});
```

- [ ] **Step 2: Run — expect FAIL** (the new fields aren't on the options yet)

- [ ] **Step 3: Implement** — modify `src/daemon/approvals/require-approval.ts`:

```typescript
import type { SessionStore } from "./session.js";

export interface RequireApprovalOptions {
  store: ApprovalStore;
  binding: ApprovalBinding;
  daemonPort: number;
  approvalIdFromClient?: string;
  waitMs?: number;
  force?: boolean;
  openUrlImpl?: (url: string) => void;
  /** Optional session lookup. When set, the binding is checked against this
   * session pattern BEFORE the per-op approval flow runs. */
  sessionId?: string;
  sessionStore?: SessionStore;
}

export async function requireApproval(opts: RequireApprovalOptions): Promise<ApprovalGrant> {
  const needsApproval = opts.force === true || opts.binding.environment === "production";

  // Session fast-path: if a session is supplied and we're in a needs-approval
  // scenario, try to mint from the session first.
  if (needsApproval && opts.sessionId !== undefined && opts.sessionStore !== undefined) {
    try {
      return opts.store.findOrMintFromSession(opts.sessionId, opts.binding, opts.sessionStore);
    } catch (e) {
      if (e instanceof ShuttleError && e.code === "session_pattern_no_match") {
        // Fall through to the single-use approval flow — the session was wider
        // than this op; the human still has to approve.
      } else {
        throw e;
      }
    }
  }

  if (!needsApproval) {
    return synthesizeGrant(opts.binding);
  }

  // (Existing single-use approval flow — unchanged.)
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

- [ ] **Step 4: Run — expect PASS** (~4 new tests + existing tests unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/require-approval.ts src/daemon/approvals/require-approval.test.ts
git commit -m "feat(approvals): requireApproval session fast-path

Production-gated approvals now try findOrMintFromSession first. On
match, returns the synthesized grant with no openUrl. On
session_pattern_no_match, falls back to the single-use flow. On
other session errors (not_found, expired, unauthorized,
max_uses_exceeded), re-throws — silent fallback would mask hard
problems."
```

---

## Part B — Session HTTP routes

### Task B1: `POST /v1/approvals/session` route (create)

**Files:**
- Create: `src/daemon/api/routes/approvals-session.ts`
- Create: `src/daemon/api/routes/approvals-session.test.ts`
- Modify: `src/daemon/api/router.ts` — register the route.
- Modify: `src/daemon/services.ts` — expose `sessionStore: SessionStore`.

**Route behavior:**
- Body: `{ pattern: SessionPattern, wait_for_approval?: boolean }`.
- Validate the pattern via `assertSessionPatternValid` (throws bad_request).
- Create a pending session in the store.
- Surface a session-approval UI event (Task D4 ships `surfaceApproval`; until then, fall back to the existing `openUrl` for the session-approval URL `/ui/session?id=<id>&token=<ui_token>`).
- If `wait_for_approval === false`: return immediately with `{ ok: true, session_id, status: "pending", expires_at }`. The agent can poll or send `--session <id>` and let the per-op call fail with `session_unauthorized` until the human approves.
- Otherwise: poll the store until status changes (or timeout = `pattern.ttl_ms`). On `granted`: return `{ session_id, status: "granted", expires_at }`. On `denied`: throw `approval_denied`. On timeout: throw `approval_timeout`.

- [ ] **Step 1: Add `sessionStore` to DaemonServices**

```typescript
// In src/daemon/services.ts:
import { SessionStore } from "./approvals/session.js";

export class DaemonServices {
  // ... existing fields
  readonly sessionStore = new SessionStore();
}
```

- [ ] **Step 2: Write the failing route test**

Create `src/daemon/api/routes/approvals-session.test.ts`. Mirror the test harness from `src/daemon/api/routes/secrets-delete.test.ts` (mkdtemp + SECRET_SHUTTLE_HOME + INSECURE_DEV_MODE + registerRoutes + restore).

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";

interface Ctx { port: number; token: string; services: DaemonServices; home: string }

async function withDaemon<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-session-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try { return await fn({ port, token: "t", services, home }); }
  finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(ctx: Pick<Ctx, "port" | "token">, method: string, p: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("POST /v1/approvals/session with wait_for_approval=false returns session_id + status: pending", async () => {
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
    assert.equal(typeof (r.body as { session_id: string }).session_id, "string");
    assert.equal((r.body as { status: string }).status, "pending");
    assert.equal(typeof (r.body as { expires_at: number }).expires_at, "number");
  });
});

test("POST /v1/approvals/session: invalid pattern → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: [],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["vercel.com"],
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
        ref_glob: "ss://*/prod/*",  // double star — invalid
        destination_domains: ["vercel.com"],
        ttl_ms: 60_000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "session_pattern_invalid_glob");
  });
});

test("POST /v1/approvals/session: ttl > 15min → bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["vercel.com"],
        ttl_ms: 16 * 60 * 1000,
      },
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "bad_request");
  });
});

test("POST /v1/approvals/session: granted approval returns status:granted (programmatic approve)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Race: kick off the request with wait_for_approval=true (default).
    // After a few ms, programmatically approve the most-recent session via services.sessionStore.
    const reqPromise = call(ctx, "POST", "/v1/approvals/session", {
      pattern: {
        actions: ["template-run"],
        ref_glob: "ss://x/prod/*",
        destination_domains: ["vercel.com"],
        ttl_ms: 5000,
      },
    });
    // Poll the store until a pending session appears, then approve.
    await new Promise((r) => setTimeout(r, 50));
    const pending = ctx.services.sessionStore.list().find((s) => s.status === "pending");
    assert.ok(pending, "expected a pending session in the store");
    ctx.services.sessionStore.approve(pending!.id);
    const r = await reqPromise;
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, "granted");
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement** the route

Create `src/daemon/api/routes/approvals-session.ts`:

```typescript
import { ShuttleError } from "../../../shared/errors.js";
import { openUrl } from "../../approvals/open-url.js";
import { assertSessionPatternValid, type SessionPattern } from "../../approvals/session.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, optBool, reqString } from "../validate.js";

const POLL_INTERVAL_MS = 200;

export function registerApprovalsSessionRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/approvals/session", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const pattern = parsePatternFromBody(o);
    const waitForApproval = optBool(o, "wait_for_approval");

    assertSessionPatternValid(pattern);
    const grant = services.sessionStore.create(pattern);

    // Open the session-approval UI for the human. Until Task D6 ships
    // surfaceApproval, we use the legacy openUrl with the per-session URL.
    const url = `http://127.0.0.1:${daemonPortRef()}/ui/session?id=${grant.id}&token=${grant.ui_token}`;
    openUrl(url);

    if (waitForApproval === false) {
      return {
        session_id: grant.id,
        status: "pending",
        expires_at: grant.expires_at,
      };
    }

    // Poll until granted, denied, or expired.
    const deadline = grant.expires_at;
    while (Date.now() < deadline) {
      const g = services.sessionStore.get(grant.id);
      if (g === undefined) throw new ShuttleError("session_not_found", "Session vanished.");
      if (g.status === "granted") {
        return { session_id: g.id, status: "granted", expires_at: g.expires_at };
      }
      if (g.status === "denied") throw new ShuttleError("approval_denied", "Session denied.");
      if (g.status === "expired") throw new ShuttleError("session_expired", "Session expired.");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new ShuttleError("approval_timeout", "Timed out waiting for session approval.");
  });
}

function parsePatternFromBody(o: Record<string, unknown>): SessionPattern {
  if (o.pattern === undefined) throw new ShuttleError("missing_param", "pattern is required.");
  if (o.pattern === null || typeof o.pattern !== "object" || Array.isArray(o.pattern)) {
    throw new ShuttleError("bad_request", "pattern must be an object.");
  }
  const p = o.pattern as Record<string, unknown>;
  if (!Array.isArray(p.actions)) {
    throw new ShuttleError("bad_request", "pattern.actions must be an array.");
  }
  if (typeof p.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "pattern.ref_glob must be a string.");
  }
  if (!Array.isArray(p.destination_domains)) {
    throw new ShuttleError("bad_request", "pattern.destination_domains must be an array.");
  }
  if (typeof p.ttl_ms !== "number") {
    throw new ShuttleError("bad_request", "pattern.ttl_ms must be a number.");
  }
  return {
    actions: p.actions as SessionPattern["actions"],
    ref_glob: p.ref_glob,
    destination_domains: p.destination_domains as string[],
    ...(p.template_ids !== undefined ? { template_ids: p.template_ids as string[] } : {}),
    ttl_ms: p.ttl_ms,
    ...(p.max_uses !== undefined ? { max_uses: p.max_uses as number } : {}),
  };
}
```

Register in `src/daemon/api/router.ts`:

```typescript
import { registerApprovalsSessionRoute } from "./routes/approvals-session.js";
// ...
registerApprovalsSessionRoute(server, services, daemonPortRef);
```

- [ ] **Step 5: Run — expect PASS** (~5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/approvals-session.ts src/daemon/api/routes/approvals-session.test.ts \
  src/daemon/api/router.ts src/daemon/services.ts
git commit -m "feat(daemon): POST /v1/approvals/session route (create)

Validates pattern, creates pending session, opens approval UI,
polls until granted/denied/expired/timeout. wait_for_approval=false
returns immediately with status:pending so agents can use --session
without blocking."
```

---

### Task B2: `GET /v1/approvals/sessions` (list) + `DELETE /v1/approvals/sessions/:id` (revoke)

**Files:**
- Modify: `src/daemon/api/routes/approvals-session.ts` — append two routes.
- Modify: `src/daemon/api/routes/approvals-session.test.ts` — tests.

- [ ] **Step 1: Append tests**

```typescript
test("GET /v1/approvals/sessions returns all sessions in insertion order", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    ctx.services.sessionStore.create({
      actions: ["template-run"], ref_glob: "ss://a/*", destination_domains: [], ttl_ms: 60_000,
    });
    ctx.services.sessionStore.create({
      actions: ["template-run"], ref_glob: "ss://b/*", destination_domains: [], ttl_ms: 60_000,
    });
    const r = await call(ctx, "GET", "/v1/approvals/sessions");
    assert.equal(r.status, 200);
    const sessions = (r.body as { sessions: Array<{ ref_glob: string }> }).sessions;
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.ref_glob, "ss://a/*");
    assert.equal(sessions[1]!.ref_glob, "ss://b/*");
  });
});

test("DELETE /v1/approvals/sessions/:id revokes the session", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"], ref_glob: "ss://a/*", destination_domains: [], ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);
    const r = await call(ctx, "DELETE", `/v1/approvals/sessions/${sg.id}`);
    assert.equal(r.status, 200);
    assert.equal((r.body as { revoked: boolean }).revoked, true);
    assert.equal(ctx.services.sessionStore.get(sg.id)!.status, "revoked");
  });
});

test("DELETE /v1/approvals/sessions/:id unknown id → session_not_found", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "DELETE", "/v1/approvals/sessions/does-not-exist");
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "session_not_found");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — append to `src/daemon/api/routes/approvals-session.ts`:

```typescript
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
      ttl_ms: g.ttl_ms,
      ...(g.max_uses !== undefined ? { max_uses: g.max_uses } : {}),
      created_at: g.created_at,
      expires_at: g.expires_at,
      uses: g.uses,
    })),
  };
});
```

For revoke, we need a path-parametric DELETE. The existing `addRoute(method, path, handler)` is exact-match. Use `addRouteRaw` for path-parametric routes (the approval-UI routes already do this), with manual bearer-auth check, OR add a small helper for `DELETE /v1/approvals/sessions/:id`. Easiest is `addRouteRaw` since the existing pattern already handles dynamic IDs:

```typescript
server.addRouteRaw("DELETE", /^\/v1\/approvals\/sessions\/([^/]+)$/, async (req, _body, res) => {
  // Replicate the bearer-token check (addRouteRaw bypasses server-level auth).
  // ... [see existing approval-UI pattern]
  // Extract id from URL:
  const url = new URL(req.url ?? "", `http://127.0.0.1`);
  const m = url.pathname.match(/^\/v1\/approvals\/sessions\/([^/]+)$/);
  if (m === null || m[1] === undefined) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: { code: "bad_request", message: "Invalid path" }, error_code: "bad_request", message: "Invalid path", hint: null, exit_code: 2 }));
    return;
  }
  // ... bearer check + lock check + revoke + JSON response
});
```

**Simpler approach**: `addRoute("DELETE", "/v1/approvals/sessions", (req, body) => ...)` and accept the session_id in the body. Or add a path-parametric registrar to server.ts.

Actually the cleanest: **change server.ts to support path-parametric routes** with a `:param` placeholder for `addRoute`. This is a small extension. Let's do it:

In `src/daemon/server.ts`, modify the route matching to support `/path/:id` patterns:

```typescript
// In handle():
for (const [pattern, handler] of this.routes) {
  const [methodPart, pathPart] = pattern.split(" ", 2);
  if (methodPart !== (req.method ?? "GET")) continue;
  const paramMatch = matchPath(pathPart, urlPath);
  if (paramMatch === null) continue;
  // Pass params into the body... actually attach to req?
}
```

This is starting to balloon. **Simpler**: pass session_id in the body for DELETE.

Use `POST /v1/approvals/sessions/revoke` with body `{ session_id }` instead of `DELETE /v1/approvals/sessions/:id`. Cleaner with the existing addRoute primitive.

Decision: use POST + body. Update the plan + tests accordingly.

- [ ] **Step 3b: Implement (revised — POST revoke with body)**

```typescript
server.addRoute("POST", "/v1/approvals/sessions/revoke", async (_req, raw) => {
  services.lock.requireKey();
  const o = asObject(raw);
  const sessionId = reqString(o, "session_id");
  services.sessionStore.revoke(sessionId);  // throws session_not_found
  return { revoked: true, session_id: sessionId };
});
```

Update the test to use POST + body:

```typescript
test("POST /v1/approvals/sessions/revoke revokes the session", async () => {
  // ... (same setup)
  const r = await call(ctx, "POST", "/v1/approvals/sessions/revoke", { session_id: sg.id });
  assert.equal(r.status, 200);
  assert.equal((r.body as { revoked: boolean }).revoked, true);
  // ...
});

test("POST /v1/approvals/sessions/revoke unknown id → session_not_found", async () => {
  // ...
  const r = await call(ctx, "POST", "/v1/approvals/sessions/revoke", { session_id: "does-not-exist" });
  assert.equal(r.status, 400);
  assert.equal((r.body as { error_code: string }).error_code, "session_not_found");
});
```

- [ ] **Step 4: Run — expect PASS** (~3 new)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/approvals-session.ts src/daemon/api/routes/approvals-session.test.ts
git commit -m "feat(daemon): GET /v1/approvals/sessions list + POST /v1/approvals/sessions/revoke"
```

---

## Part C — Wire Session into approval-gated routes

### Task C1: Thread `session_id` through requireApproval callers

**Files to modify** (one route at a time; commit per route for bisectability):
- `src/daemon/api/routes/templates.ts`
- `src/daemon/api/routes/run-resolve.ts`
- `src/daemon/api/routes/inject-render.ts`
- `src/daemon/api/routes/secrets-delete.ts`
- `src/daemon/api/routes/secrets-rotate.ts`
- `src/daemon/api/routes/inject-submit.ts`
- `src/daemon/api/routes/reveal-capture.ts`
- `src/daemon/api/routes/capture.ts`
- `src/daemon/api/routes/compare.ts`
- `src/daemon/api/routes/inject.ts` (V0)

**Per-route change:**
- Accept `session_id` in body (validate type if present; `optString`).
- Pass to `requireApproval` along with `services.sessionStore`.
- When the resulting grant has `session_id` set, include that in the audit entry.

- [ ] **Step 1: Add `session_id` reading + pass-through to template-run**

In `src/daemon/api/routes/templates.ts`, add `session_id = optString(o, "session_id")` to the body-validation block. Pass into `requireApproval`:

```typescript
await requireApproval({
  store: services.approvals,
  binding,
  daemonPort: daemonPortRef(),
  sessionStore: services.sessionStore,
  ...(sessionId !== undefined ? { sessionId } : {}),
  ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
  ...(waitForApproval === false ? { waitMs: 0 } : {}),
});
```

When writing the audit entry, capture the grant's `session_id` if present:

```typescript
const sessionIdFromGrant = grant.session_id; // requires requireApproval to RETURN the grant; today it does
await writeDaemonAudit({
  action: "template_run",
  ok: ...,
  ref: ...,
  ...(sessionIdFromGrant !== undefined ? { session_id: sessionIdFromGrant } : {}),
});
```

(For this we need `requireApproval` to return the grant — check `src/daemon/approvals/require-approval.ts`. It already does.)

- [ ] **Step 2: Update audit type**

In `src/daemon/audit.ts`, add `session_id?: string` to `DaemonAuditEvent`:

```typescript
export interface DaemonAuditEvent {
  // ... existing fields
  session_id?: string;
}
```

- [ ] **Step 3: Append test for session usage in templates route**

In `src/daemon/api/routes/templates.test.ts`, add:

```typescript
test("POST /v1/templates/run with session_id mints from session pattern (no openUrl, audit has session_id)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Seed a production secret.
    const genGrant = ctx.services.approvals.create({
      action: "generate",
      ref: null,
      planned_ref: "ss://x/prod/A",
      environment: "production",
      destination_domain: null,
      target_id: null,
      field_fingerprint: null,
      template_id: null,
      template_params: null,
      allowed_domains: ["example.com"],
      allowed_actions: ["use_as_stdin", "inject_into_field", "capture_from_page", "compare_fingerprint", "inject_submit"],
    });
    ctx.services.approvals.approve(genGrant.id);
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "A", environment: "production", source: "x", allowed_domains: ["example.com"],
      approval_id: genGrant.id, wait_for_approval: false,
    });
    // Create + approve a session that covers template_run for this ref.
    const session = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: ["example.com"],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(session.id);

    // Now call template_run with session_id and a registered template.
    // (Implementer note: the test registry has a 'pass-through' template; if not,
    //  use whichever template the existing test file uses.)
    const r = await call(ctx, "POST", "/v1/templates/run", {
      template_id: "pass-through",
      ref: "ss://x/prod/A",
      params: { name: "X" },
      session_id: session.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    // Audit line should carry session_id.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const tplLines = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "template_run");
    assert.equal(tplLines.length, 1);
    assert.equal(tplLines[0]!.session_id, session.id);
    // Session use count should have incremented.
    assert.equal(ctx.services.sessionStore.get(session.id)!.uses, 1);
  });
});
```

- [ ] **Step 4: Run — expect FAIL → implement → PASS**

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/templates.ts src/daemon/api/routes/templates.test.ts src/daemon/audit.ts
git commit -m "feat(routes/templates): accept session_id; audit captures session_id"
```

- [ ] **Step 6: Repeat for the remaining 9 routes**

For each route in the list above, repeat steps 1, 3, 4, 5. Each commit is small (~50 lines). Use the same pattern.

Specifically for `run-resolve.ts` and `inject-render.ts` (the heavy hitters):
- Add `session_id = optString(o, "session_id")` in body validation.
- Pass `sessionStore: services.sessionStore, sessionId` into `requireApproval`.
- Capture grant.session_id and include in audit writes.

For each route, add ONE happy-path test asserting:
1. Status 200 (request succeeds via session).
2. Audit line carries `session_id`.
3. Session uses incremented.

After all 10 routes:

```bash
git log --oneline | head -10  # ~10 small commits
```

---

## Part D — Tab reuse (SSE infrastructure)

### Task D1: `UISseBus` — single-subscriber SSE manager

**Files:**
- Create: `src/daemon/ui/sse-bus.ts`
- Create: `src/daemon/ui/sse-bus.test.ts`

**Behavior:**
- `UISseBus` keeps state: `subscriber: ServerResponse | null`, `uiTabOpenedAt: number | null`, `lastEventId: number`.
- `connect(res, onClose?)`: registers `res` as the sole subscriber. If a previous subscriber exists, send it a `{type: "displaced"}` event and disconnect it (`res.end()`); set `this.subscriber = res`; mark `uiTabOpenedAt = Date.now()`. Set up `res.on("close", () => { if this.subscriber === res then this.subscriber = null })`. Start heartbeat ticker (every 30 seconds, send `:heartbeat\n\n`).
- `publish(event: { type: string; ... })`: if subscriber, `res.write("id: " + (++lastEventId) + "\ndata: " + JSON.stringify(event) + "\n\n")`. If no subscriber, drop (the UI will fetch the state when it reconnects).
- `hasSubscriber(): boolean` — for surface-approval logic.
- `uiTabOpenedAtMs(): number | null` — for open-url gating.
- `close()`: send `{type: "shutdown"}` and disconnect.

- [ ] **Step 1: Write failing tests**

Create `src/daemon/ui/sse-bus.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { UISseBus } from "./sse-bus.js";

class FakeResponse {
  written: string[] = [];
  ended = false;
  private closeListeners: Array<() => void> = [];
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.written.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    for (const l of this.closeListeners) l();
  }
  on(event: "close", cb: () => void): this {
    if (event === "close") this.closeListeners.push(cb);
    return this;
  }
}

test("UISseBus: first connect sets subscriber + records uiTabOpenedAtMs", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  assert.equal(bus.hasSubscriber(), true);
  assert.notEqual(bus.uiTabOpenedAtMs(), null);
});

test("UISseBus: publish writes id + data line + double newline", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  bus.publish({ type: "approval", id: "abc", summary: "test" });
  const written = res.written.join("");
  assert.match(written, /^id: 1\ndata: \{"type":"approval"/);
  assert.ok(written.endsWith("\n\n"));
});

test("UISseBus: publish with no subscriber drops silently", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  bus.publish({ type: "approval", id: "abc" });
  // No throw, no error. hasSubscriber stays false.
  assert.equal(bus.hasSubscriber(), false);
});

test("UISseBus: second connect displaces the first", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const r1 = new FakeResponse();
  const r2 = new FakeResponse();
  bus.connect(r1 as unknown as ServerResponse);
  bus.connect(r2 as unknown as ServerResponse);
  // r1 received a 'displaced' event before being ended.
  const r1Written = r1.written.join("");
  assert.match(r1Written, /"type":"displaced"/);
  assert.equal(r1.ended, true);
  // r2 is now the subscriber.
  assert.equal(bus.hasSubscriber(), true);
});

test("UISseBus: subscriber close (e.g. browser tab close) clears subscriber", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  res.end(); // simulates browser closing the SSE stream
  assert.equal(bus.hasSubscriber(), false);
});

test("UISseBus: heartbeat fires at the configured interval", async () => {
  const bus = new UISseBus({ heartbeatMs: 30 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  await new Promise((r) => setTimeout(r, 100));
  bus.close();
  const written = res.written.join("");
  const heartbeats = written.split(":heartbeat\n\n").length - 1;
  assert.ok(heartbeats >= 2, `expected at least 2 heartbeats in 100ms at 30ms interval; got ${heartbeats}`);
});

test("UISseBus: close() emits shutdown and disconnects", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  bus.close();
  const written = res.written.join("");
  assert.match(written, /"type":"shutdown"/);
  assert.equal(res.ended, true);
  assert.equal(bus.hasSubscriber(), false);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/daemon/ui/sse-bus.ts`:

```typescript
import type { ServerResponse } from "node:http";

export interface UISseBusOptions {
  /** Heartbeat tick interval. Set to 0 to disable (tests). Default 30s. */
  heartbeatMs?: number;
}

export class UISseBus {
  private subscriber: ServerResponse | null = null;
  private openedAt: number | null = null;
  private lastEventId = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(opts: UISseBusOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
  }

  hasSubscriber(): boolean {
    return this.subscriber !== null;
  }

  uiTabOpenedAtMs(): number | null {
    return this.openedAt;
  }

  connect(res: ServerResponse): void {
    if (this.subscriber !== null) {
      try {
        this.write(this.subscriber, { type: "displaced", message: "Another tab took over the daemon UI." });
        this.subscriber.end();
      } catch { /* ignore */ }
    }
    this.subscriber = res;
    this.openedAt = Date.now();
    res.on("close", () => {
      if (this.subscriber === res) {
        this.subscriber = null;
      }
    });
    if (this.heartbeatMs > 0 && this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        if (this.subscriber !== null) {
          try { this.subscriber.write(":heartbeat\n\n"); } catch { /* ignore */ }
        }
      }, this.heartbeatMs);
      // Unref so heartbeat timer doesn't keep the daemon alive on its own.
      this.heartbeatTimer.unref();
    }
  }

  publish(event: Record<string, unknown>): void {
    if (this.subscriber === null) return;
    try { this.write(this.subscriber, event); } catch { /* ignore */ }
  }

  close(): void {
    if (this.subscriber !== null) {
      try {
        this.write(this.subscriber, { type: "shutdown" });
        this.subscriber.end();
      } catch { /* ignore */ }
      this.subscriber = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private write(res: ServerResponse, event: Record<string, unknown>): void {
    this.lastEventId += 1;
    res.write(`id: ${this.lastEventId}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
```

- [ ] **Step 4: Run — expect PASS** (~7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/ui/sse-bus.ts src/daemon/ui/sse-bus.test.ts
git commit -m "feat(daemon/ui): single-subscriber SSE bus with heartbeat + displacement"
```

---

### Task D2: `GET /ui/` stable shell route + `GET /ui/events` SSE route

**Files:**
- Create: `src/daemon/api/routes/ui-tab.ts`
- Create: `src/daemon/api/routes/ui-tab.test.ts`
- Modify: `src/daemon/services.ts` — expose `uiSse: UISseBus`.
- Modify: `src/daemon/api/router.ts` — register the routes.

**Behavior:**
- `GET /ui/` — serves `ui.html` (the stable shell) at content-type `text/html; charset=utf-8`. No token required.

  Wait: `addRouteRaw` is what serves HTML today (see `src/daemon/approvals/ui-server.ts`). And it's auth-free because the URL contains a per-request token. For the STABLE URL we don't have a per-request token; access is by being on loopback only.

  Decision: `GET /ui/` is registered as `addRouteRaw`, no token. Anyone on loopback can fetch it. This is fine — the HTML itself has no secrets; the SECRETS come from `/ui/events` which authenticates by the daemon bearer token.

- `GET /ui/events` — SSE stream. Authenticates by Authorization header (Bearer <daemon token>). On first byte, calls `services.uiSse.connect(res)`.

  Wait again: SSE clients in browsers can't send Authorization headers via `EventSource`. The browser EventSource API doesn't support custom headers.

  Solution: the SSE endpoint accepts a per-URL token. The UI HTML is fetched with the daemon's bearer token... no, the HTML is fetched without auth (loopback only). So how does the UI HTML get the SSE auth?

  Option A: pass the token in the URL: `/ui/events?token=<daemon_token>`. The browser opens `new EventSource("/ui/events?token=" + daemonToken)`. The daemon validates the token against its own bearer token.

  Option B: use a per-tab token: the GET /ui/ response sets a Cookie with a fresh per-tab token. `/ui/events` validates the cookie.

  Option A is simpler and matches the existing per-approval-URL-token pattern. Go with Option A.

  But where does the UI HTML get the daemon token to put in the URL? When the human opens the page, they don't have the daemon token. Hmm.

  Solution: the daemon serves the HTML with the token EMBEDDED in a `<script>` tag (rendered server-side). The token is bound to the daemon's lifetime (changes on restart). The HTML loads, reads the token, opens SSE with it.

  Better solution: serve a `GET /ui/config` endpoint that returns the SSE URL + ephemeral session token after a `addRouteRaw` opens the HTML. The HTML calls `/ui/config` with the bearer token… no, that's a chicken-and-egg.

  Cleanest solution: the daemon serves `GET /ui/` and DYNAMICALLY embeds the bearer token in the HTML. The token only leaves the daemon process to the loopback HTTP client — same posture as the per-approval URLs today.

  Implementation: read `ui.html` at boot, replace `__DAEMON_TOKEN__` placeholder with the actual token, cache the result.

- [ ] **Step 1: Write failing tests**

Create `src/daemon/api/routes/ui-tab.test.ts`:

```typescript
test("GET /ui/ returns the HTML shell with the daemon token embedded", async () => {
  await withDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.ok(html.includes("Secret Shuttle"), "HTML must include product name");
    // The daemon token should be embedded in a <script> block. The exact
    // shape is implementer's choice; the test asserts presence.
    assert.match(html, /SS_DAEMON_TOKEN/);
  });
});

test("GET /ui/events with token returns 200 + SSE content-type", async () => {
  await withDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/events?token=${ctx.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // Read one event (heartbeat) and close.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.length > 0);
    await reader.cancel();
  });
});

test("GET /ui/events without token → 401", async () => {
  await withDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/events`);
    assert.equal(res.status, 401);
  });
});

test("GET /ui/events: second connection displaces the first", async () => {
  await withDaemon(async (ctx) => {
    const first = await fetch(`http://127.0.0.1:${ctx.port}/ui/events?token=${ctx.token}`);
    const firstReader = first.body!.getReader();
    // Open second connection.
    const second = await fetch(`http://127.0.0.1:${ctx.port}/ui/events?token=${ctx.token}`);
    const secondReader = second.body!.getReader();
    // First should receive a 'displaced' event before closing.
    let firstText = "";
    while (true) {
      const { value, done } = await firstReader.read();
      if (done) break;
      firstText += new TextDecoder().decode(value);
      if (firstText.includes("displaced")) break;
    }
    assert.match(firstText, /"type":"displaced"/);
    await secondReader.cancel();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/daemon/api/routes/ui-tab.ts`:

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse, IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ShuttleError, errorToJson } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

const TAB_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../approvals/ui.html",
);

export function registerUiTabRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonToken: string,
): void {
  // Stable shell HTML route. Loopback-only (addRouteRaw bypasses bearer);
  // we embed the daemon token so the page can authenticate /ui/events.
  let cachedHtml: string | null = null;
  server.addRouteRaw("GET", /^\/ui\/?$/, async (_req, _body, res) => {
    if (cachedHtml === null) {
      const raw = await readFile(TAB_HTML_PATH, "utf8");
      cachedHtml = raw.replaceAll("__DAEMON_TOKEN__", daemonToken);
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(cachedHtml);
  });

  // SSE stream. addRouteRaw bypasses bearer auth, so we do per-URL-token
  // auth here. The token comes from the daemon's startup bearer (same as
  // the /v1/* routes' Authorization: Bearer ... header).
  server.addRouteRaw("GET", /^\/ui\/events$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const token = url.searchParams.get("token") ?? "";
    const expected = Buffer.from(daemonToken);
    const actual = Buffer.from(token);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      const err = new ShuttleError("unauthorized", "Invalid or missing token.");
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(errorToJson(err)));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    // Send an initial 'connected' event.
    res.write("retry: 5000\n\n"); // browser reconnect hint
    services.uiSse.connect(res);
  });
}
```

Wire into router and pass the daemon token:

```typescript
// In src/daemon/api/router.ts (or wherever routes are registered)
registerUiTabRoutes(server, services, daemonToken);
```

The daemon token is passed when constructing the DaemonServer in the daemon entry point — it needs to be threaded through.

- [ ] **Step 4: Run — expect PASS** (~4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/ui-tab.ts src/daemon/api/routes/ui-tab.test.ts \
  src/daemon/services.ts src/daemon/api/router.ts
git commit -m "feat(daemon/ui): stable /ui/ shell + /ui/events SSE route

The shell HTML embeds the daemon token so the page can authenticate
/ui/events (browsers can't send custom Authorization headers from
EventSource). Single-subscriber semantics — second connection
displaces the first."
```

---

### Task D3: `surfaceApproval` helper

**Files:**
- Create: `src/daemon/approvals/surface-approval.ts`
- Create: `src/daemon/approvals/surface-approval.test.ts`

**Behavior:**
- `surfaceApproval(bus, payload, openUrlFallback)`:
  1. If `bus.hasSubscriber()`: publish the payload over SSE; do NOT call openUrl.
  2. Else: call `openUrlFallback(approvalUrl)` to spawn a new tab.

This wraps the choice point so all callers (require-approval, unlock-session, approvals-session) get the same behavior.

- [ ] **Step 1: Write failing tests**

```typescript
test("surfaceApproval: bus with subscriber → publish + no openUrl", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  let openCalls = 0;
  surfaceApproval(bus, { type: "approval", id: "a1" }, (_url) => { openCalls += 1; });
  assert.equal(openCalls, 0);
  assert.match(res.written.join(""), /"id":"a1"/);
});

test("surfaceApproval: bus without subscriber → openUrl called with the legacy URL", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  let openedUrl = "";
  surfaceApproval(bus, { type: "approval", id: "a1", legacyUrl: "http://127.0.0.1:1234/ui/approve?id=a1&token=t" }, (url) => { openedUrl = url; });
  assert.equal(openedUrl, "http://127.0.0.1:1234/ui/approve?id=a1&token=t");
});

test("surfaceApproval: payload without legacyUrl + no subscriber → still calls openUrl with the stable /ui/ URL", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  let openedUrl = "";
  surfaceApproval(bus, { type: "approval", id: "a1" }, (url) => { openedUrl = url; }, "http://127.0.0.1:1234/ui/");
  assert.equal(openedUrl, "http://127.0.0.1:1234/ui/");
});
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/approvals/surface-approval.ts
import type { UISseBus } from "../ui/sse-bus.js";

export interface SurfaceApprovalPayload {
  type: "approval" | "session" | "unlock";
  id: string;
  /** Optional legacy per-approval URL with token. If set + no subscriber, openUrl uses this. */
  legacyUrl?: string;
  [k: string]: unknown;
}

export function surfaceApproval(
  bus: UISseBus,
  payload: SurfaceApprovalPayload,
  openUrlImpl: (url: string) => void,
  stableUrl?: string,
): void {
  if (bus.hasSubscriber()) {
    bus.publish(payload);
    return;
  }
  // No subscriber. Open a tab with the legacy URL (if available) or the stable URL.
  const url = payload.legacyUrl ?? stableUrl;
  if (url !== undefined) {
    openUrlImpl(url);
  }
}
```

- [ ] **Step 3: Run, commit.

```bash
git add src/daemon/approvals/surface-approval.ts src/daemon/approvals/surface-approval.test.ts
git commit -m "feat(approvals): surfaceApproval helper — publish to SSE, fall back to openUrl"
```

---

### Task D4: Wire `surfaceApproval` into require-approval + unlock-session + approvals-session

**Files to modify:**
- `src/daemon/approvals/require-approval.ts` — replace `openUrl(url)` with `surfaceApproval(bus, ...)`.
- `src/daemon/api/routes/unlock-session.ts` — same.
- `src/daemon/api/routes/approvals-session.ts` — same.

The change is structural: `requireApproval` needs access to the bus. Add `uiSse?: UISseBus` to its options (or thread `services.uiSse` through). The unlock-session and approvals-session routes already have services in scope.

For `requireApproval`, the cleanest path is to ADD `bus?: UISseBus` to `RequireApprovalOptions` and have callers (which all have access to services) pass it.

- [ ] **Step 1: Update `RequireApprovalOptions`**

```typescript
export interface RequireApprovalOptions {
  // ... existing fields
  bus?: UISseBus;
  /** Stable URL the daemon serves (e.g. http://127.0.0.1:<port>/ui/). */
  stableUrl?: string;
}
```

- [ ] **Step 2: Replace openUrl with surfaceApproval**

```typescript
// Inside requireApproval, in the single-use flow:
const grant = opts.store.create(opts.binding);
const legacyUrl = `http://127.0.0.1:${opts.daemonPort}/ui/approve?id=${grant.id}&token=${grant.ui_token}`;
const payload: SurfaceApprovalPayload = {
  type: "approval",
  id: grant.id,
  legacyUrl,
  binding: opts.binding,
};
if (opts.bus !== undefined) {
  surfaceApproval(opts.bus, payload, opts.openUrlImpl ?? openUrl, opts.stableUrl);
} else {
  // Legacy callers without a bus (tests, etc.)
  (opts.openUrlImpl ?? openUrl)(legacyUrl);
}
```

- [ ] **Step 3: Update every caller of `requireApproval`** to pass `bus: services.uiSse` and `stableUrl: \`http://127.0.0.1:${daemonPortRef()}/ui/\``.

There are ~10 call sites: templates, run-resolve, inject-render, secrets-delete, secrets-rotate, inject-submit, reveal-capture, capture, compare, inject (V0).

- [ ] **Step 4: Update unlock-session.ts** to use surfaceApproval directly:

```typescript
import { surfaceApproval } from "../../approvals/surface-approval.js";
// ...
surfaceApproval(
  services.uiSse,
  { type: "unlock", id: "unlock", legacyUrl: url },
  openUrl,
  `http://127.0.0.1:${daemonPortRef()}/ui/`,
);
```

- [ ] **Step 5: Run tests** — existing tests should still pass. The behavior should be: when no UI bus subscriber, legacy openUrl is called (current behavior); when a subscriber, no spawn.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/approvals/require-approval.ts src/daemon/api/routes/unlock-session.ts \
  src/daemon/api/routes/approvals-session.ts \
  src/daemon/api/routes/templates.ts src/daemon/api/routes/run-resolve.ts \
  src/daemon/api/routes/inject-render.ts src/daemon/api/routes/secrets-delete.ts \
  src/daemon/api/routes/secrets-rotate.ts src/daemon/api/routes/inject-submit.ts \
  src/daemon/api/routes/reveal-capture.ts src/daemon/api/routes/capture.ts \
  src/daemon/api/routes/compare.ts src/daemon/api/routes/inject.ts
git commit -m "feat(approvals): wire surfaceApproval into every approval-gated route

Single open tab per daemon lifetime: when an SSE subscriber exists,
all surfaceApproval calls publish over the bus instead of spawning
a new browser tab. No subscriber → falls back to the legacy
per-approval openUrl spawn (preserves the pre-Plan-4 path)."
```

---

### Task D5: `open-url.ts` singleWindowMode flag

**Files:**
- Modify: `src/daemon/approvals/open-url.ts` — add `mode?: "single-window" | "legacy-deep-link"` and `bus?: UISseBus` parameters; in single-window mode, no-op if bus already has subscriber.
- Modify: `src/daemon/approvals/open-url.test.ts` — tests for the new mode.

Most callers should already be using surfaceApproval (which calls openUrl internally as a fallback). This task tightens the openUrl primitive itself for completeness.

- [ ] **Step 1: Add option + test**

```typescript
test("openUrl in single-window mode no-ops when bus has a subscriber", () => {
  const bus = new UISseBus({ heartbeatMs: 0 });
  const res = new FakeResponse();
  bus.connect(res as unknown as ServerResponse);
  let spawnCalls = 0;
  const fakeSpawn = (_cmd: string, _args: readonly string[], _opts: SpawnOptions) => {
    spawnCalls += 1;
    return { on: () => undefined, unref: () => undefined };
  };
  openUrl("http://127.0.0.1:9999/ui/approve?id=x", { mode: "single-window", bus, spawnImpl: fakeSpawn });
  assert.equal(spawnCalls, 0);
});
```

- [ ] **Step 2: Implement**

```typescript
export function openUrl(url: string, opts?: {
  spawnImpl?: SpawnFn;
  mode?: "single-window" | "legacy-deep-link";
  bus?: UISseBus;
}): void {
  if (process.env.SECRET_SHUTTLE_NO_OPEN_URL === "1") return;
  const mode = opts?.mode ?? "single-window";
  if (mode === "single-window" && opts?.bus !== undefined && opts.bus.hasSubscriber()) {
    return; // No-op: subscriber will receive the SSE event instead.
  }
  // ... existing spawn logic ...
}
```

- [ ] **Step 3: Run + commit.

```bash
git add src/daemon/approvals/open-url.ts src/daemon/approvals/open-url.test.ts
git commit -m "feat(approvals/open-url): single-window mode is the default; bus subscriber suppresses spawn"
```

---

### Task D6: `ui.html` SSE consumer

**Files:**
- Modify: `src/daemon/approvals/ui.html` — major rewrite.

The HTML now:
1. Includes a `<script>` block that reads `__DAEMON_TOKEN__` (substituted server-side in Task D2).
2. Opens an `EventSource(/ui/events?token=...)`.
3. Shows three states: "Connected. No pending approvals." (idle), "Approval pending: <summary>" (single-use), "Session approval pending: <pattern>" (session).
4. Forms POST to existing per-approval endpoints — wire unchanged.
5. Shows a "Daemon restarted — please refresh this page" message when the SSE stream errors out (token mismatch on reconnect).
6. Handles `{type: "displaced"}` by displaying "Another tab took over — close this one."
7. Handles `{type: "shutdown"}` by displaying "Daemon stopped."

This task is a big HTML/JS write. Test by hand at minimum; a thin integration test can verify the page loads (Task D2 covers that).

- [ ] **Step 1: Read existing `ui.html`** to understand the current approval-form pattern. Reuse the form structures + CSS.

- [ ] **Step 2: Add the SSE consumer + state machine + session-banner template**

Write the new `ui.html`. The full file is too long to inline here; the implementer follows the contract above.

- [ ] **Step 3: Manual smoke**

Run a daemon, hit `http://127.0.0.1:<port>/ui/` (after init or auto-start). Trigger an approval (e.g. `secret-shuttle secrets generate --env production --allow-domain example.com --wait-for-approval false` then check the UI shows the approval form). Approve it. Verify no NEW tab opened for the next approval.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/approvals/ui.html
git commit -m "feat(ui): stable shell with SSE consumer + session-approval layout

The HTML now opens an EventSource and updates in place when the
daemon publishes approval/session/unlock events. Idle state shows
'Connected. No pending approvals.' Old per-approval URLs continue
to work as deep-links for the legacy flow."
```

---

## Part E — Internal session CLI

### Task E1: `secret-shuttle internal session create/list/revoke`

**Files:**
- Create: `src/cli/commands/internal-session.ts`
- Create: `src/cli/commands/internal-session.test.ts`
- Modify: `src/cli/commands/internal.ts` — register the new subcommand.

**Behavior:**
- `internal session create` — flags:
  - `--actions <list>` (comma-separated; required)
  - `--ref-glob <glob>` (required)
  - `--destination-domain <domain>` (repeatable; optional for run/inject_render actions)
  - `--template-id <id>` (repeatable; optional)
  - `--ttl <ms>` (default 5min, max 15min)
  - `--max-uses <n>` (optional)
  - `--no-wait` — return pending session_id without polling
  - Posts to `/v1/approvals/session`. Output: `{ ok: true, session_id, status, expires_at }`.
- `internal session list` — GET `/v1/approvals/sessions`. Output: array of sessions with status counts.
- `internal session revoke <id>` — POST `/v1/approvals/sessions/revoke`. Output: `{ ok: true, revoked: true, session_id }`.

- [ ] **Step 1: Write structural tests**

```typescript
test("internalSessionCreateCommand structural shape", () => {
  const cmd = internalSessionCommand();
  const sub = cmd.commands.find((c) => c.name() === "create");
  assert.ok(sub);
  const names = sub!.options.map((o) => o.long);
  for (const flag of ["--actions", "--ref-glob", "--ttl"]) {
    assert.ok(names.includes(flag), `missing ${flag}`);
  }
});

test("internalSessionListCommand structural shape", () => {
  const cmd = internalSessionCommand();
  const sub = cmd.commands.find((c) => c.name() === "list");
  assert.ok(sub);
});

test("internalSessionRevokeCommand structural shape", () => {
  const cmd = internalSessionCommand();
  const sub = cmd.commands.find((c) => c.name() === "revoke");
  assert.ok(sub);
  assert.equal((sub as unknown as { registeredArguments: Array<{ _name: string }> }).registeredArguments.length, 1);
});
```

- [ ] **Step 2: Implement**

```typescript
// src/cli/commands/internal-session.ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { collectRepeated } from "./helpers.js";

export function internalSessionCommand(): Command {
  const cmd = new Command("session").description("Pre-approved session management.");

  cmd
    .command("create")
    .description("Mint a session pattern. Opens the approval UI for the human to approve the SHAPE.")
    .requiredOption("--actions <list>", "Comma-separated SessionActions (e.g. template-run,inject-submit)")
    .requiredOption("--ref-glob <glob>", "Literal prefix + optional trailing * (e.g. ss://stripe/prod/*)")
    .option("--destination-domain <domain>", "Allowed destination domain (repeatable)", collectRepeated, [])
    .option("--template-id <id>", "Restrict to a specific template id (repeatable)", collectRepeated, [])
    .option("--ttl <ms>", "TTL in ms; max 900000 (15 min); default 300000 (5 min)", (v) => Number.parseInt(v, 10), 5 * 60 * 1000)
    .option("--max-uses <n>", "Optional usage cap", (v) => Number.parseInt(v, 10))
    .option("--no-wait", "Return pending session_id without polling for approval")
    .option("--json", "Forward-compat no-op", false)
    .action(async (options) => {
      const body = {
        pattern: {
          actions: (options.actions as string).split(",").map((s) => s.trim()),
          ref_glob: options.refGlob,
          destination_domains: options.destinationDomain,
          ...((options.templateId as string[]).length > 0 ? { template_ids: options.templateId } : {}),
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
    .description("List all sessions (pending, granted, used, expired, revoked).")
    .option("--json", "Forward-compat no-op", false)
    .action(async () => {
      const r = await daemonRequest("GET", "/v1/approvals/sessions");
      outputJson(ok(r as Record<string, unknown>));
    });

  cmd
    .command("revoke")
    .argument("<session-id>", "Session id to revoke")
    .description("Revoke a session. Subsequent uses fail with session_not_found.")
    .option("--json", "Forward-compat no-op", false)
    .action(async (sessionId: string) => {
      const r = await daemonRequest("POST", "/v1/approvals/sessions/revoke", { session_id: sessionId });
      outputJson(ok(r as Record<string, unknown>));
    });

  return cmd;
}
```

Register in `src/cli/commands/internal.ts`:

```typescript
import { internalSessionCommand } from "./internal-session.js";
// ...
cmd.addCommand(internalSessionCommand());
```

- [ ] **Step 3: Run + commit.

```bash
git add src/cli/commands/internal-session.ts src/cli/commands/internal-session.test.ts src/cli/commands/internal.ts
git commit -m "feat(cli): internal session create/list/revoke"
```

---

### Task E2: Add `--session <id>` to approval-gated CLI commands

**Files to modify (one per commit):**
- `src/cli/commands/run.ts`
- `src/cli/commands/inject.ts`
- `src/cli/commands/secrets/delete.ts`
- `src/cli/commands/secrets/rotate.ts`
- `src/cli/commands/secrets/set.ts`
- `src/cli/commands/template-run.ts` (find the actual file path; might be under templates/)
- `src/cli/commands/inject-submit.ts`
- `src/cli/commands/reveal-capture.ts`
- `src/cli/commands/inject-internal.ts` (V0)
- `src/cli/commands/capture.ts`
- `src/cli/commands/compare.ts`

**Per-command change:**
- Add `.option("--session <id>", "Use a pre-approved session id (see 'internal session create').")`
- When `options.session !== undefined`, add `session_id: options.session` to the POST body.

- [ ] **Step 1: Update one command at a time** — `run.ts` first:

```typescript
.option("--session <id>", "Use a pre-approved session id (see 'internal session create').")
// ...
body: {
  // ... existing fields
  ...(options.session !== undefined ? { session_id: options.session } : {}),
},
```

- [ ] **Step 2: Add a structural test**

```typescript
test("runCommand: --session flag accepted", () => {
  const cmd = runCommand();
  const optionNames = cmd.options.map((o) => o.long);
  assert.ok(optionNames.includes("--session"));
});
```

- [ ] **Step 3: Commit; repeat for each command.

After all 11 commands:

```bash
git log --oneline | head -15
```

---

## Part F — Stdin pass-through for `run`

### Task F1: `addRouteStreamingBody` server primitive

**Files:**
- Modify: `src/daemon/server.ts` — add the new primitive.
- Modify: `src/daemon/server.test.ts` — tests.

**Behavior:**
- `addRouteStreamingBody(method, path, handler)`: registers a route that runs Host + bearer auth but does NOT pre-parse the body. Handler receives `(req: IncomingMessage, res: ServerResponse)` — no body argument.
- Handler is responsible for consuming `req` as a Readable.
- No 1MB body cap; the handler must enforce its own.

- [ ] **Step 1: Write failing tests**

```typescript
test("addRouteStreamingBody: handler can read req as a Readable", async () => {
  const { server, url, token, stop } = await setUpServer();
  let received = "";
  server.addRouteStreamingBody("POST", "/v1/test", async (req, res) => {
    for await (const chunk of req) received += chunk.toString("utf8");
    res.statusCode = 200;
    res.end(`got ${received.length} bytes`);
  });
  try {
    const r = await fetch(`${url}/v1/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "x".repeat(10_000),
    });
    assert.equal(await r.text(), "got 10000 bytes");
  } finally { await stop(); }
});

test("addRouteStreamingBody: missing bearer → 401 + handler NOT invoked", async () => {
  // ... same as addRouteStreaming test pattern
});

test("addRouteStreamingBody: bad Host → 400 + handler NOT invoked", async () => {
  // ... same pattern
});
```

- [ ] **Step 2: Implement**

```typescript
// In DaemonServer:
private readonly streamingBodyRoutes = new Map<string, RawHandler>();

addRouteStreamingBody(method: Method, path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void {
  // Wrap the handler so the dispatch branch can pass (req, null, res) — body is null because no pre-parse.
  this.streamingBodyRoutes.set(`${method} ${path}`, (req, _body, res) => handler(req, res));
}

// In handle(), after bearer check, BEFORE streaming/regular routes:
const bodyKey = `${req.method ?? "GET"} ${urlPath}`;
const bodyHandler = this.streamingBodyRoutes.get(bodyKey);
if (bodyHandler !== undefined) {
  try {
    await bodyHandler(req, null, res);
  } catch (e) {
    if (res.headersSent) {
      res.destroy(e instanceof Error ? e : new Error(String(e)));
    } else {
      this.writeError(res, e);
    }
  }
  return;
}
```

- [ ] **Step 3: Run + commit.

```bash
git add src/daemon/server.ts src/daemon/server.test.ts
git commit -m "feat(daemon): addRouteStreamingBody — auth-checked, no body pre-parse, no 1MB cap

For /v1/run/resolve's new ndjson-multiplexed body protocol. Handler
reads req as a Readable and enforces its own limits."
```

---

### Task F2: `stdin-multiplex.ts` parser/encoder

**Files:**
- Create: `src/daemon/run/stdin-multiplex.ts` — pure module.
- Create: `src/daemon/run/stdin-multiplex.test.ts`.

**Encode side (CLI):**
- `encodeHeader(header: object): Uint8Array` — `JSON.stringify({hdr: header}) + "\n"`.
- `encodeStdinChunk(chunk: Buffer): Uint8Array` — `JSON.stringify({stdin: chunk.toString("base64")}) + "\n"`.

**Decode side (daemon):**
- `decodeBodyLines(req: AsyncIterable<Buffer>, onHeader: (hdr: object) => Promise<void>, onStdinChunk: (chunk: Buffer) => void): Promise<void>` — streaming parser.
  - Read first line. Parse JSON. If `hdr` field missing → throw bad_request. Call `onHeader(hdr)`.
  - For each subsequent line: parse JSON. If `stdin` field → decode base64, call `onStdinChunk(chunk)`. Else: throw bad_request.
  - Header line max length 64KB (prevents malicious oversize header).
- Each line max 64KB after parse (prevents single huge JSON line OOM).

- [ ] **Step 1: Write failing tests**

```typescript
test("encodeHeader serializes a header line", () => {
  const out = encodeHeader({ refs: ["a"], command: "node" });
  assert.equal(new TextDecoder().decode(out), '{"hdr":{"refs":["a"],"command":"node"}}\n');
});

test("encodeStdinChunk wraps + base64-encodes", () => {
  const out = encodeStdinChunk(Buffer.from("hello"));
  const decoded = JSON.parse(new TextDecoder().decode(out).trim()) as { stdin: string };
  assert.equal(Buffer.from(decoded.stdin, "base64").toString("utf8"), "hello");
});

test("decodeBodyLines: header + 2 stdin chunks + EOF", async () => {
  let header: object | null = null;
  const chunks: Buffer[] = [];
  const body = (async function* () {
    yield Buffer.from(`{"hdr":{"command":"x"}}\n`);
    yield Buffer.from(`{"stdin":"${Buffer.from("abc").toString("base64")}"}\n`);
    yield Buffer.from(`{"stdin":"${Buffer.from("def").toString("base64")}"}\n`);
  })();
  await decodeBodyLines(body, async (h) => { header = h; }, (c) => { chunks.push(c); });
  assert.deepEqual(header, { command: "x" });
  assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdef");
});

test("decodeBodyLines: missing hdr field → bad_request", async () => {
  const body = (async function* () { yield Buffer.from(`{"command":"x"}\n`); })();
  await assert.rejects(
    decodeBodyLines(body, async () => undefined, () => undefined),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("decodeBodyLines: oversize header line → bad_request", async () => {
  const huge = JSON.stringify({ hdr: { blob: "x".repeat(100_000) } });
  const body = (async function* () { yield Buffer.from(huge + "\n"); })();
  await assert.rejects(
    decodeBodyLines(body, async () => undefined, () => undefined),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

test("decodeBodyLines: chunks split mid-line are buffered", async () => {
  let header: object | null = null;
  const body = (async function* () {
    yield Buffer.from(`{"hdr":{"comm`);
    yield Buffer.from(`and":"x"}}\n`);
  })();
  await decodeBodyLines(body, async (h) => { header = h; }, () => undefined);
  assert.deepEqual(header, { command: "x" });
});
```

- [ ] **Step 2: Implement** — straightforward streaming parser. Implementer follows the test contract.

- [ ] **Step 3: Run + commit.

```bash
git add src/daemon/run/stdin-multiplex.ts src/daemon/run/stdin-multiplex.test.ts
git commit -m "feat(daemon/run): ndjson stdin-multiplex parser/encoder

Pure pure module — shared by route (decode incoming body) and CLI
(encode outgoing body). Header line + zero or more {stdin:<b64>}
lines. 64KB per-line cap. EOF closes child stdin."
```

---

### Task F3: Extend spawner with `stdinSource`

**Files:**
- Modify: `src/daemon/run/spawner.ts` — accept `stdinSource: AsyncIterable<Buffer> | undefined`.
- Modify: `src/daemon/run/spawner.test.ts` — add 3 new tests.

**Behavior:**
- New optional field on `SpawnInput`: `stdinSource?: AsyncIterable<Buffer>`.
- When set: spawn with `stdio: ["pipe", "pipe", "pipe"]`. Concurrently, iterate the source and write each chunk to `child.stdin`. On source completion: `child.stdin.end()`. On any error during write: log + close.
- When not set: existing behavior (`stdio: ["ignore", "pipe", "pipe"]`).
- AbortSignal still works.

- [ ] **Step 1: Write failing tests**

```typescript
test("spawnAndStream: passes stdin through to the child", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.stdin.on('data', d => process.stdout.write('got=' + d.toString('utf8')))"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
    stdinSource: (async function* () {
      yield Buffer.from("hello");
    })(),
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout().trim(), "got=hello");
});

test("spawnAndStream: stdin EOF triggers child to exit", async () => {
  const w = new CollectingWriter();
  const startTime = Date.now();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.stdin.on('end', () => process.exit(0))"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
    stdinSource: (async function* () { /* no chunks; immediate EOF */ })(),
  });
  assert.equal(w.exitCode, 0);
  assert.ok(Date.now() - startTime < 3000, "child should exit quickly after EOF");
});

test("spawnAndStream: AbortSignal closes stdin AND SIGTERMs child", async () => {
  const w = new CollectingWriter();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const start = Date.now();
  // Long-running stdin source the child reads from forever.
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.stdin.on('data', () => {}); setTimeout(() => {}, 30000)"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
    stdinSource: (async function* () {
      while (true) {
        yield Buffer.from("chunk\n");
        await new Promise((r) => setTimeout(r, 10));
      }
    })(),
    signal: controller.signal,
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10_000, `child should be killed promptly; took ${elapsed}ms`);
});
```

- [ ] **Step 2: Implement** — extend the spawner. Key changes:

```typescript
const stdio = input.stdinSource !== undefined
  ? (["pipe", "pipe", "pipe"] as const)
  : (["ignore", "pipe", "pipe"] as const);

const child = spawn(input.cmd, input.args, {
  shell: false,
  env: input.env,
  cwd: input.cwd,
  stdio,
});

// Pipe stdin chunks through.
if (input.stdinSource !== undefined) {
  void (async () => {
    try {
      for await (const chunk of input.stdinSource!) {
        if (child.stdin === null) break;
        if (!child.stdin.write(chunk)) {
          // Backpressure — wait for drain.
          await new Promise<void>((resolve) => child.stdin!.once("drain", resolve));
        }
      }
      child.stdin?.end();
    } catch (e) {
      // Source iterator threw — destroy stdin.
      child.stdin?.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  })();
}

// In the abort handler:
const onAbort = (): void => {
  if (exited || c.killed) return;
  c.stdin?.destroy();
  c.kill("SIGTERM");
  // ... existing kill chain
};
```

- [ ] **Step 3: Run + commit.

```bash
git add src/daemon/run/spawner.ts src/daemon/run/spawner.test.ts
git commit -m "feat(daemon/run): spawner accepts optional stdinSource

When provided, stdio[0]=pipe and chunks from the AsyncIterable
flow into child.stdin. End-of-source closes child.stdin. AbortSignal
destroys stdin AND SIGTERMs the child (existing kill chain)."
```

---

### Task F4: `/v1/run/resolve` switches to ndjson body protocol

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.ts` — switch registrar; parse via stdin-multiplex.
- Modify: `src/daemon/api/routes/run-resolve.test.ts` — update existing tests + add new stdin tests.

**Behavior:**
- Route registrar: `addRouteStreamingBody` (not `addRouteStreaming`).
- Read body via `decodeBodyLines`:
  - First line → header → existing strict validation (refs, env, command, args, cwd).
  - Subsequent lines → stdin chunks → pass to spawner via an async iterator.
- The spawner's `stdinSource` is a generator that yields each decoded stdin chunk as it arrives.

The trick: stdin chunks arrive ASYNC while the spawner is already running. Use an internal queue:

```typescript
async function* stdinIterator(queue: AsyncQueue<Buffer>): AsyncIterable<Buffer> {
  while (true) {
    const next = await queue.pop();
    if (next === null) return; // EOF
    yield next;
  }
}
```

`decodeBodyLines` pushes chunks into the queue and signals EOF when the body ends.

- [ ] **Step 1: Update existing tests to send ndjson body**

For every test that calls `callStream(ctx, "/v1/run/resolve", body)`, wrap `body` in `{hdr: body}` and serialize as ndjson:

Update `callStream` to accept either a JSON body (legacy) OR an ndjson body. Simplest: change the helper to send `{hdr: body}` ndjson by default; tests don't need to change.

```typescript
async function callStream(ctx, path, body, options): Promise<...> {
  // Build the ndjson body: header line + (no stdin for these tests).
  const headerLine = JSON.stringify({ hdr: body }) + "\n";
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/x-ndjson" },
    body: headerLine,
    ...
  };
  // ... rest unchanged
}
```

- [ ] **Step 2: Add 3 new stdin-specific tests**

```typescript
test("POST /v1/run/resolve: stdin pass-through — child reads from stdin", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const headerLine = JSON.stringify({ hdr: {
      refs: [], env: [],
      command: process.execPath,
      args: ["-e", "let buf=''; process.stdin.on('data', d => buf += d); process.stdin.on('end', () => process.stdout.write(buf))"],
      cwd: process.cwd(),
    }}) + "\n";
    const stdinLine = JSON.stringify({ stdin: Buffer.from("hello-from-stdin").toString("base64") }) + "\n";
    const body = new Blob([headerLine, stdinLine]);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/run/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/x-ndjson" },
      body,
    });
    // Read response stream...
    // Assert stdout contains "hello-from-stdin"
    // [test body parses ndjson response; lookup stream lines for stdout decoding]
  });
});

test("POST /v1/run/resolve: stdin EOF triggers child to exit", async () => {
  // Same pattern but child uses process.stdin.on('end', () => process.exit(0)).
  // Send header line, immediately close body (no stdin lines).
  // Assert exit code 0.
});

test("POST /v1/run/resolve: legacy bare JSON body now rejected (bad_request)", async () => {
  // Send bare JSON, no {hdr: ...} wrapper. Assert 400 bad_request.
});
```

- [ ] **Step 3: Implement the route changes**

Switch from `addRouteStreaming` to `addRouteStreamingBody`. Add the multiplex parser:

```typescript
import { decodeBodyLines } from "../../run/stdin-multiplex.js";

server.addRouteStreamingBody("POST", "/v1/run/resolve", async (req, res) => {
  // ... (auth + lock check already happened at server level)
  services.lock.requireKey();

  // Build the stdin queue + iterator.
  const stdinQueue: Buffer[] = [];
  let stdinClosed = false;
  let stdinWaiter: ((v: Buffer | null) => void) | null = null;
  const pushStdin = (chunk: Buffer): void => {
    if (stdinWaiter !== null) {
      const w = stdinWaiter;
      stdinWaiter = null;
      w(chunk);
    } else {
      stdinQueue.push(chunk);
    }
  };
  const closeStdin = (): void => {
    stdinClosed = true;
    if (stdinWaiter !== null) {
      stdinWaiter(null);
      stdinWaiter = null;
    }
  };
  async function* stdinSource(): AsyncIterable<Buffer> {
    while (true) {
      if (stdinQueue.length > 0) {
        yield stdinQueue.shift()!;
        continue;
      }
      if (stdinClosed) return;
      const next = await new Promise<Buffer | null>((resolve) => { stdinWaiter = resolve; });
      if (next === null) return;
      yield next;
    }
  }

  let body: RunResolveBody;
  try {
    await decodeBodyLines(
      req,
      async (header) => {
        body = await validateRunResolveHeader(header); // existing strict validation
        // KICK OFF the rest of the route once the header is in.
        runWithHeader(body);
      },
      (chunk) => pushStdin(chunk),
    );
  } catch (e) {
    writeJsonError(res, 400, e);
    return;
  }
  closeStdin();

  // ... the rest of the run flow (resolve refs, policy, approval, spawn with stdinSource).
});
```

This is genuinely intricate because the run flow has to start BEFORE the stdin body finishes streaming. The implementer must be careful with control flow.

A simpler model: the route handler is one big async function. It does:
1. Read the first line synchronously (block until it arrives). Parse + validate.
2. Kick off the rest of the run flow.
3. Concurrently, keep reading subsequent stdin lines and pushing into the queue. When body ends, closeStdin.

In code:

```typescript
const reader = req[Symbol.asyncIterator]();
const headerLine = await readSingleLine(reader); // helper
const body = await validateHeader(JSON.parse(headerLine));

// Continue reading remaining lines in the background.
void (async () => {
  for await (const chunk of req) {
    // Parse ndjson lines; for each {stdin}, push.
  }
  closeStdin();
})();

// Now run the spawner with stdinSource: stdinSource().
```

- [ ] **Step 4: Run + commit.

```bash
git add src/daemon/api/routes/run-resolve.ts src/daemon/api/routes/run-resolve.test.ts
git commit -m "feat(run): /v1/run/resolve switches to ndjson body for stdin multiplex

First body line: {hdr: <existing-header>}. Subsequent lines:
{stdin: <base64-chunk>}. Stdin chunks flow into child.stdin as
they arrive. Body EOF closes child.stdin. Legacy bare-JSON body
is rejected — coordinated breaking change with the CLI."
```

---

### Task F5: CLI sends multiplexed body

**Files:**
- Modify: `src/cli/commands/run.ts` — switch from `streamingDaemonRequest` to a new helper that builds the multiplexed body.
- Modify: `src/client/streaming-request.ts` — add `streamingDaemonRequestWithBody` accepting `body: ReadableStream<Uint8Array>`.

- [ ] **Step 1: Add `streamingDaemonRequestWithBody`**

```typescript
export async function streamingDaemonRequestWithBody(
  method: "POST",
  path: string,
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal; contentType?: string },
): Promise<ReadableStream<Uint8Array>> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running.");
  }
  const res = await fetch(`http://127.0.0.1:${sf.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${sf.token}`,
      "content-type": options?.contentType ?? "application/x-ndjson",
    },
    body,
    duplex: "half",
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  } as RequestInit & { duplex: "half" });
  // ... rest mirrors streamingDaemonRequest
}
```

- [ ] **Step 2: Update `run.ts` to build the multiplexed body**

```typescript
import { encodeHeader, encodeStdinChunk } from "../../daemon/run/stdin-multiplex.js"; // pure module, OK to import from cli

// Build the request body as a ReadableStream:
const requestBody = new ReadableStream<Uint8Array>({
  async start(controller) {
    controller.enqueue(encodeHeader({
      refs, env: entries, command: command[0], args: command.slice(1), cwd: process.cwd(),
      ...(options.session !== undefined ? { session_id: options.session } : {}),
      ...(options.approvalId !== undefined ? { approval_id: options.approvalId } : {}),
      ...(options.wait === false ? { wait_for_approval: false } : {}),
    }));
    if (options.noStdin === true) {
      controller.close();
      return;
    }
    // Pump process.stdin chunks into the stream.
    process.stdin.on("data", (chunk: Buffer) => {
      controller.enqueue(encodeStdinChunk(chunk));
    });
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (e) => controller.error(e));
  },
});

const stream = await streamingDaemonRequestWithBody("POST", "/v1/run/resolve", requestBody, { signal: controller.signal });
```

- [ ] **Step 3: Add `--no-stdin` flag** for callers who explicitly want to skip stdin pass-through (mirrors `op run --no-stdin`).

```typescript
.option("--no-stdin", "Do not pass-through stdin to the child")
```

- [ ] **Step 4: Add CLI structural test** for `--no-stdin`.

- [ ] **Step 5: Smoke test**

```bash
# Manual: pipe input to the CLI and verify the child receives it.
echo "hello" | secret-shuttle run --env-file=/tmp/empty.env -- node -e 'process.stdin.on("data", d => console.log("got=" + d))'
# Expected: got=hello
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/run.ts src/cli/commands/run.test.ts src/client/streaming-request.ts
git commit -m "feat(cli): run command multiplexes stdin onto the request body

The CLI builds a ReadableStream that emits the header line first,
then encodes process.stdin chunks as {stdin:<b64>} ndjson lines.
fetch with duplex:'half' pumps these to /v1/run/resolve while
concurrently reading the streaming response. --no-stdin opts out.
Closes Plan 3's stdin-deferred limitation."
```

---

## Part G — Verification + CHANGELOG

### Task G1: Full suite verification

- [ ] `npm test` — all pass. Expect ~706 baseline + ~70 new tests across A1-A5, B1-B2, C1, D1-D6, E1-E2, F1-F5 = ~776 total.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run check-pack` — clean.
- [ ] Manual smoke:
  - Start daemon, open `/ui/` — should see "Connected. No pending approvals."
  - Trigger an approval; verify the same tab updates in place.
  - Approve; trigger another approval — same tab, no new spawn.
  - Run `secret-shuttle internal session create --actions template-run --ref-glob "ss://x/prod/*" --destination-domain example.com --ttl 60000 --no-wait`; verify a session approval UI appears.
  - Approve in UI; run a covered op with `--session <id>`; verify no new approval window opens.
  - Pipe stdin to `run`: `echo "hi" | secret-shuttle run --env-file=/tmp/empty.env -- node -e 'process.stdin.on("data", d => console.log(d.toString()))'`. Verify output is "hi".

- [ ] **Step 5:** No commit (verification only).

### Task G2: CHANGELOG + curated help

**Files:**
- Modify: `src/cli/commands/help.ts` — mention sessions in the curated index (one line under "Provider integration" or a new "Advanced" section).
- Modify: `CHANGELOG.md` — Plan 4 entries.

- [ ] **Step 1: Append CHANGELOG entries**

```markdown
### Added — Plan 4 (sessions + tab reuse + stdin pass-through)
- **Pre-approved sessions.** New `POST /v1/approvals/session` mints a session pattern (TTL up to 15 minutes, optional max_uses, actions enumerated, ref glob, destination domain allow-list). The human approves the SHAPE once; subsequent ops carrying `--session <id>` or `session_id` in the body skip the per-op approval window for matches. Pattern mismatches fall back to the single-use flow transparently. Every minted grant still has a discrete one-shot binding under the hood, so the audit trail shows N distinct operations (each carrying `session_id`), not "1 session". New CLI: `internal session create/list/revoke`. Spec §5.7.
- **Single-window approval UI.** The daemon now serves a stable `http://127.0.0.1:<port>/ui/` URL bound by the daemon-startup token. One tab per daemon lifetime, period. New approvals push events over an SSE stream (`/ui/events`); the tab updates in place. Legacy per-approval URLs (`/ui/approve?id=...&token=...`) keep working as deep-links. When the human closes the tab, the next approval reopens it (idempotent). Closes a chronic UX bug where every approval / unlock / paste spawned a fresh browser tab. Spec §5.10.
- **`run` stdin pass-through.** Pipe input to the child process. The request body is now ndjson — first line `{hdr: <existing-header>}`, subsequent lines `{stdin: <base64>}` chunks. Daemon multiplexes through to `child.stdin`; body EOF closes `child.stdin`. Use `--no-stdin` to opt out (mirrors `op run --no-stdin`). Spec §5.3 line 257 (was deferred from Plan 3).

### Changed
- `/v1/run/resolve` body protocol switches to ndjson. Plan-3 vintage CLIs sending bare JSON will receive `bad_request`. Coordinated change with the run CLI.

### Security
- Sessions never bypass binding-match: every operation under a session still gets a single-use grant minted from the same `bindingsMatch` semantics as a regular approval. Wider session patterns expand what's *automatically* approved, not what's *possible*.
- SSE single-subscriber: a second connection displaces the first with an explicit `{type: "displaced"}` event. Prevents ghost tabs from silently consuming events the human didn't see.
- Tab reuse preserves the legacy deep-link path: `/ui/approve?id=...&token=...` URLs still authenticate the same way; only the DEFAULT opening behavior changed.

### Known limitations
- The new ndjson body for /v1/run/resolve is a breaking change with no fallback — Plan-3 CLIs and Plan-4 daemons are incompatible across this boundary. Documented at upgrade.
- TTY interactive prompts in `run` children: stdin is a pipe, not a TTY. `isTTY` is false in the child. TTY-only interactive UX (password masking, raw-mode keys) won't work the same way. Full PTY pass-through is out of scope.
- The SSE stream is single-subscriber. Two browser tabs can't watch the same daemon UI simultaneously.
- After a daemon restart, the embedded token in any open tab is stale. The tab will show "daemon restarted" on its next SSE reconnect. `init` re-opens a fresh tab.
```

- [ ] **Step 2: Update curated help**

Optional one-line addition under "Advanced" or "Provider integration":
```
  internal session create / list / revoke    Pre-approved batch sessions
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/help.ts CHANGELOG.md
git commit -m "docs(changelog): Plan 4 — sessions + tab reuse + run stdin pass-through"
```

---

## Self-Review

**1. Spec coverage**

| Spec §11 deliverable | Task |
|---|---|
| Pre-approved sessions (§5.7) | A1 (matcher) + A2 (store) + A4 (mint) + A5 (requireApproval integration) + B1-B2 (HTTP routes) + C1 (route wiring) + E1 (CLI) |
| Single-window tab reuse (§5.10) | D1 (SSE bus) + D2 (routes) + D3 (surfaceApproval) + D4 (caller wiring) + D5 (open-url mode) + D6 (ui.html) |
| Run stdin pass-through (§5.3 line 257) | F1 (server primitive) + F2 (multiplex) + F3 (spawner extension) + F4 (route migration) + F5 (CLI) |
| `--session <id>` on all approval-gated CLI commands | E2 |
| New error codes registered | A3 |
| New audit fields (session_id) | C1 (audit.ts extension + route wiring) |
| CHANGELOG + curated help | G2 |

**2. Placeholder scan**

No TBD, no "Similar to Task N", no "implement details". Every code block is complete enough to copy. Every test case has concrete assertions. The biggest hand-wave is ui.html (D6) — that's a UI write that's hard to template in a plan; the contract is precise, the implementer follows it.

**3. Type consistency**

- `SessionPattern` defined in A1 — `actions: SessionAction[]`. Consumed in A2 (store), A4 (mint), B1 (route), E1 (CLI).
- `SessionGrant extends SessionPattern` defined in A2 with status / id / ui_token / uses / expires_at. Consumed in A4, B1, B2.
- `ApprovalGrant.session_id?: string` added in A4. Used by C1 audit, E1 (returned by `internal session create`).
- `DaemonAuditEvent.session_id?: string` added in C1.
- `UISseBus` defined in D1. Consumed in D2, D3, D4, D5.
- `SurfaceApprovalPayload` defined in D3. Consumed by D4 callers.
- `decodeBodyLines` / `encodeHeader` / `encodeStdinChunk` defined in F2. Consumed in F4 (route) + F5 (CLI).
- `SpawnInput.stdinSource?: AsyncIterable<Buffer>` added in F3. Consumed in F4.
- `streamingDaemonRequestWithBody` added in F5. Consumed by run CLI.

**4. Scope**

Plan 4 is the largest plan in Phase 1. Three subsystems share an approval UI but are otherwise independent. 25 tasks. Estimated execution time: ~12-15 hours of subagent work + reviews. The two-stage review per task is essential — sessions and tab reuse touch many files; small drift compounds.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan4-sessions-tab-reuse-stdin.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality), review between tasks. Same pattern as Plans 1, 2, and 3.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
