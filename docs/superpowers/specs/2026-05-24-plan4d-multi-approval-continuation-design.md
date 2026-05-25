# Plan 4d — Multi-Approval Continuation Design

**Status:** Approved, ready for plan-writing.

**Goal:** Close the v0.2.0 Known-limitation documented after Plan 4c (`460e750`). The combined flow

```sh
secret-shuttle run --env-file=<file with production refs> --stdin=<production ref> --no-wait -- <cmd>
```

currently dead-ends because the CLI carries a single `approval_id` field while the route needs two separate approvals (`run` for env refs, `run_stdin` for the stdin ref). The fail-fast block at `run-resolve.ts:244-283` (`combined_no_wait_unsupported`) refuses the case outright. Plan 4d replaces that fail-fast with a real continuation contract: the daemon mints all required approvals atomically on the first `--no-wait` round-trip, the CLI carries them back via a repeatable `--approval-id` flag, and the daemon consumes all of them in one retry.

The same primitive subsumes the singular-approval path for every other approval-gated route — no separate code path for "1 binding" vs "N bindings."

---

## Architecture

**Core primitive:** rename `src/daemon/approvals/require-approval.ts` → `require-approvals.ts`. The new `requireApprovals(bindings: ApprovalBinding[], …)` is the only approval gate in the daemon. Single-approval callers pass `[binding]`.

**Two-phase invariant:** `requireApprovals` strictly separates planning from commit. Phase 1 is a pure read (no `store.consume`, no `incrementUses`, no `store.create`). Phase 2 is the only place with side effects. If Phase 1 finds any binding cannot be satisfied without minting, Phase 2 under `--no-wait` mints **only** those bindings and never touches the satisfiable ones. This removes the need for an operation-handle bookkeeping layer: an aborted Phase 2 under `--no-wait` leaves the supplied IDs and sessions exactly as they were.

**Wire format:** request body gains `approval_ids: string[]`; the existing `approval_id: string` singular is retained for one release as an alias. The `approval_required` error gains a top-level `details.approvals` field (array of `{approval_id, expires_at, action}`). `ShuttleError` is extended with a generic `details?: unknown` slot, propagated through `errorToJson` and `daemonErrorFromPayload`.

**CLI:** `--approval-id <id>` becomes repeatable via a shared option-factory used by every approval-gated command. The CLI continues to emit a single JSON document — `details.approvals` is rendered as part of the JSON payload, never as a prose prelude on stderr.

**Order of operations:** the fail-fast block (`combined_no_wait_unsupported`) is deleted **only after** the continuation path is wired in `run-resolve` and an integration test proves the combined env+stdin `--no-wait` reproducer converges. See §10 (Implementation Order Constraint).

---

## Components

### 1. `requireApprovals` primitive

**File:** `src/daemon/approvals/require-approvals.ts` (renamed from `require-approval.ts`).

```ts
export interface RequireApprovalsOptions {
  store: ApprovalStore;
  bindings: ApprovalBinding[];        // deterministic order, 0..N
  daemonPort: number;
  approvalIdsFromClient?: string[];   // 0..bindings.length
  waitMs?: number;                    // 0 = --no-wait; else waiting flow
  force?: boolean;
  openUrlImpl?: (url: string) => void;
  sessionId?: string;
  sessionStore?: SessionStore;
}

export async function requireApprovals(
  opts: RequireApprovalsOptions,
): Promise<ApprovalGrant[]>;
```

Returns one grant per binding, in input order. Empty `bindings` → empty array.

#### Phase 1 — plan (pure; no side effects)

**Step 0: resolve every supplied ID.** Walk `approvalIdsFromClient ?? []`:
- `store.get(id) === undefined` → throw `approval_not_found` immediately.

This step preserves the current `store.consume()` distinction at `store.ts:114`: unknown IDs are `approval_not_found`, existing-but-unmatched IDs become `approval_mismatch` at the end of the binding loop.

**Per-binding loop (in input order).** For each binding `b`, in this order:

1. **Synth path.** If `b.environment !== "production"` AND `!opts.force` → plan `{kind: "synth", binding: b}`. Skip remaining checks.

2. **Session peek.** If `opts.sessionId !== undefined && opts.sessionStore !== undefined`, call new pure method `store.canMatchSession(opts.sessionId, b, opts.sessionStore)`:
   - Returns `true` → plan `{kind: "session", binding: b}`. No use-counter bump in Phase 1.
   - Returns `false` (pattern doesn't match) → fall through to step 3.
   - Throws `session_not_found` / `session_expired` / `session_unauthorized` / `session_max_uses_exceeded` → bubble out of `requireApprovals`.

   **Precedence:** session check comes BEFORE supplied-ID match. This matches the current `require-approval.ts:29-40` precedence — session fast-path wins when set.

3. **Supplied-ID match.** Scan the unused remainder of `approvalIdsFromClient` for one whose stored binding equals `b`:
   - Equality: `approvalBindingsMatch(store.get(id)!, b)` (newly-public; see §2).
   - On match, check the grant's status:
     - `status === "granted"` → plan `{kind: "consume", binding: b, id}`. Reserve `id` (remove from unused-IDs pool).
     - `status === "pending"` → throw `approval_not_granted` immediately. (Prevents Phase 2 partial commit where an earlier consume burns its id and a later one fails.)
     - `status === "expired"` → throw `approval_expired`.
     - `status === "denied"` → throw `approval_denied`.
     - `status === "used"` → throw `approval_already_used`.

4. **Mint plan.** If none of (1) (2) (3) applied → plan `{kind: "mint", binding: b}`.

**After the loop.** Any leftover unused IDs in `approvalIdsFromClient` → throw `approval_mismatch` with a message naming the leftover id(s).

End of Phase 1. Result: a `Plan[]` aligned 1:1 with `bindings`, every plan in `{synth, session, consume, mint}`.

#### Phase 2 — commit

Inspect plans:

- `mintPlans = plans.filter(p => p.kind === "mint")`

**Case A — no mint plans needed.** All bindings satisfiable. Execute each plan in order:
- `synth` → `synthesizeGrant(binding)` (existing helper, unchanged).
- `consume` → `store.consume(id, binding)`.
- `session` → new `store.mintFromSession(sessionId, binding, sessionStore)` (extracted side-effect half of today's `findOrMintFromSession`; bumps `uses`, mints synthetic grant).

Return the resulting `ApprovalGrant[]`.

**Case B — mint plans needed, `waitMs === 0` (--no-wait).** Atomically:
1. For each `mintPlan`: `g = store.create(mintPlan.binding)`; `openUrlImpl(`http://127.0.0.1:${port}/ui/approve?id=${g.id}&token=${g.ui_token}`)`; push `{approval_id: g.id, expires_at: g.expires_at, action: mintPlan.binding.action}` onto `pending`.
2. Throw:
   ```ts
   new ShuttleError(
     "approval_required",
     JSON.stringify({ approval_id: pending[0].approval_id, expires_at: pending[0].expires_at }), // legacy message
     { details: { approvals: pending } },
   )
   ```
   **No `consume()` calls. No `mintFromSession()` calls.** Supplied IDs and session use-counters are untouched.

**Case C — mint plans needed, `waitMs > 0` (waiting flow).** Sequential per-binding, in input order:
1. Walk plans top-to-bottom. For each `mint` plan:
   - `g = store.create(plan.binding)`; `openUrlImpl(url)`; `waitForGrant(store, g.id, waitMs, plan.binding)` (existing helper, unchanged).
   - On grant → `store.consume(g.id, plan.binding)` → replace plan with `{kind: "waited", binding, grant}`.
   - On denial / expiry / timeout → throw immediately. Earlier non-mint plans remain unexecuted (no orphans). Later mint plans remain un-minted.
2. After all mints walked, execute non-mint plans in order (synth/consume/session) as in Case A.

Return the resulting `ApprovalGrant[]`.

#### Open question: race window between Phase 1 and Phase 2

The two phases are not transactional across the store. A concurrent request could grant/expire/consume an approval between Phase 1's check and Phase 2's commit. We accept this small race window for v0.2; Phase 2 surfaces the resulting error (`approval_expired`, `approval_not_granted`, etc.). The user retries. The contract is best-effort, not linearizable.

### 2. ApprovalStore additions

**File:** `src/daemon/approvals/store.ts`.

**Export `approvalBindingsMatch` publicly.** Today's private `bindingsMatch(a, b)` at `store.ts:181` is renamed and exported. `requireApprovals` uses it directly; `store.consume()` continues to call it internally. Unit-tested separately so the matcher logic cannot drift.

**New method `canMatchSession(sessionId, binding, sessionStore): boolean`.** Mirrors every precondition that `SessionStore.incrementUses()` enforces at `session-store.ts:99-117`:

```ts
canMatchSession(sessionId: string, binding: ApprovalBinding, sessionStore: SessionStore): boolean {
  const g = sessionStore.get(sessionId);
  if (g === undefined || g.status === "revoked") {
    throw new ShuttleError("session_not_found", "Unknown session id.");
  }
  if (g.status === "expired") {
    throw new ShuttleError("session_expired", "Session has expired.");
  }
  if (g.status === "denied") {
    throw new ShuttleError("session_unauthorized", "Session was denied.");
  }
  if (g.status !== "granted") {
    throw new ShuttleError(
      "session_unauthorized",
      `Session is not granted (status: ${g.status}).`,
    );
  }
  if (g.max_uses !== undefined && g.uses >= g.max_uses) {
    throw new ShuttleError(
      "session_max_uses_exceeded",
      `Session ${sessionId} reached its max_uses cap of ${g.max_uses}.`,
    );
  }
  return matchesSessionPattern(binding, g);
}
```

Phase 1 calls this; if it returns true, the binding is planned `session`. If false, the binding falls through to ID match / mint. If it throws, the throw propagates out of `requireApprovals` (hard-fail session state).

**New method `mintFromSession(sessionId, binding, sessionStore): ApprovalGrant`.** Extracts the side-effect half of today's `findOrMintFromSession`. Bumps `uses`, builds the synthetic grant. Assumes `canMatchSession` already returned true; only re-checks `incrementUses`-specific failures (the small race window).

**Remove `findOrMintFromSession`.** Its only caller was the old `requireApproval`. The two-method split (`canMatchSession` + `mintFromSession`) replaces it cleanly.

### 3. `optApprovalIds` body-parser helper

**File:** `src/daemon/api/validate.ts`.

```ts
/**
 * Read the approval-id payload from a request body. Accepts either:
 *   - approval_ids: string[]
 *   - approval_id: string  (legacy alias for approval_ids: [approval_id]; deprecated)
 * Rejects:
 *   - both fields supplied → bad_request "approval_id_and_approval_ids_supplied"
 *   - approval_ids contains duplicates → bad_request "duplicate_approval_id"
 *   - approval_ids is empty array → returns undefined (same as field omitted)
 * Returns: string[] | undefined.
 */
export function optApprovalIds(o: Record<string, unknown>): string[] | undefined;
```

Every approval-gated route uses this helper. Inventory (must all be migrated in Plan 4d):

- `src/daemon/api/routes/run-resolve.ts`
- `src/daemon/api/routes/inject-render.ts`
- `src/daemon/api/routes/inject-submit.ts`
- `src/daemon/api/routes/secrets/set.ts`
- `src/daemon/api/routes/secrets/delete.ts`
- `src/daemon/api/routes/secrets/rotate.ts`
- `src/daemon/api/routes/compare.ts`
- `src/daemon/api/routes/capture.ts`
- `src/daemon/api/routes/reveal-capture.ts`
- `src/daemon/api/routes/generate.ts`
- `src/daemon/api/routes/blind.ts`
- `src/daemon/api/routes/templates.ts`

(Inventory verified by `grep -rn approval_id src/daemon/api/routes/` at plan-write time; any new routes added before merge get the helper too.)

### 4. CLI repeatable `--approval-id`

**Shared option-factory:** `src/cli/commands/_approval-id-option.ts` (new file):

```ts
import type { Command } from "commander";

const accumulator = (val: string, prev: string[] | undefined): string[] =>
  prev ? [...prev, val] : [val];

export function addApprovalIdOption(cmd: Command): Command {
  return cmd.option(
    "--approval-id <id>",
    "Pre-issued approval id. Repeatable when an operation needs multiple approvals.",
    accumulator,
  );
}
```

Every approval-gated CLI command calls `addApprovalIdOption(...)` instead of declaring the option inline. `options.approvalId` is typed as `string[] | undefined` (no longer `string | undefined`). Body construction in each command becomes:

```ts
if (options.approvalId !== undefined) body.approval_ids = options.approvalId;
```

(`body.approval_ids` is sent as the canonical field; the singular `approval_id` is only on the wire as a server-side alias for one release.)

### 5. `ShuttleError.details` plumbing

**File:** `src/shared/errors.ts`.

```ts
export type ShuttleErrorOpts = {
  exitCode?: number;
  hint?: string | null;
  details?: unknown;     // NEW
};

export class ShuttleError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint: string | null;
  readonly details: unknown | undefined;   // NEW

  constructor(code: string, message: string, optsOrExitCode: ShuttleErrorOpts | number = {}) {
    super(message);
    // ...existing field-extraction logic...
    this.details = typeof optsOrExitCode === "number"
      ? undefined
      : optsOrExitCode.details;
  }
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof ShuttleError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message },
      error_code: error.code,
      message: error.message,
      hint: error.hint,
      exit_code: error.exitCode,
      ...(error.details !== undefined ? { details: error.details } : {}),  // NEW
    };
  }
  // ...rest unchanged
}
```

**File:** `src/client/daemon-client.ts`.

```ts
export function daemonErrorFromPayload(payload: unknown): ShuttleError {
  // ...existing code/message/hint/exit_code extraction...
  const opts: ShuttleErrorOpts = {};
  if (typeof p.exit_code === "number") opts.exitCode = p.exit_code;
  if (typeof p.hint === "string" || p.hint === null) opts.hint = p.hint;
  if ("details" in p) opts.details = p.details;   // NEW (preserves null/undefined/object)
  return new ShuttleError(code, message, opts);
}
```

**Round-trip test:** daemon throws `new ShuttleError("approval_required", "...", { details: { approvals: [{...}] } })` → `errorToJson` → JSON-stringify → HTTP wire → `JSON.parse` → `daemonErrorFromPayload` → reconstructed `ShuttleError`. Assert `.details` deep-equals the original.

### 6. Wire format — `approval_required` details

**Request body (every approval-gated route).** Both fields accepted; both must not be supplied simultaneously:

```ts
{
  ...,
  approval_id?: string;        // legacy alias; deprecated; kept for one release
  approval_ids?: string[];     // canonical
}
```

Server normalizes `approval_id` → `approval_ids: [approval_id]` via `optApprovalIds` (see §3).

**`approval_required` response payload.** New top-level `details` block:

```json
{
  "ok": false,
  "error": {
    "code": "approval_required",
    "message": "{\"approval_id\":\"abc-first-mint\",\"expires_at\":1716595200000}"
  },
  "error_code": "approval_required",
  "message": "{\"approval_id\":\"abc-first-mint\",\"expires_at\":1716595200000}",
  "hint": "Approve in the opened hub, then retry with --approval-id <id> (repeatable for each id listed under details.approvals).",
  "exit_code": 3,
  "details": {
    "approvals": [
      {"approval_id": "abc-first-mint", "expires_at": 1716595200000, "action": "run"},
      {"approval_id": "def-second-mint", "expires_at": 1716595200000, "action": "run_stdin"}
    ]
  }
}
```

The legacy `message` JSON string (`{approval_id, expires_at}`) is kept for one release: it points at the **first** approval. Any v0.2.x tooling parsing only the singular field still works for single-approval cases.

`details.approvals` is the canonical shape going forward. Each entry contains:
- `approval_id: string` — the id to pass back via `--approval-id`.
- `expires_at: number` — Unix ms.
- `action: string` — the binding's `action` discriminator (e.g., `"run"`, `"run_stdin"`, `"secrets-set"`, etc.).

No `summary` / `refs` / `retry_args` fields in v0.2.0. Agents have `action` and the operation context.

### 7. `run-resolve` route — multi-binding consumer

**File:** `src/daemon/api/routes/run-resolve.ts`.

End-state: replace the two sequential `requireApproval` blocks (lines 285-392) with one unified `requireApprovals` call. The `combined_no_wait_unsupported` fail-fast block (lines 244-283) is REMOVED in a separate step (see §10 step 9) — see "Order of deletions" below.

```ts
// Build the list of bindings that gate this operation.
const bindings: ApprovalBinding[] = [];
if (envProductionRefs.length > 0) bindings.push(envBinding);
if (body.stdin_ref !== undefined && resolved.get(body.stdin_ref)!.environment === "production") {
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
    // session_id propagation: prefer any grant with a session_id set.
    // ApprovalGrant.session_id is `string | undefined` (store.ts:56) — check !== undefined.
    grant = grants.find((g) => g.session_id !== undefined) ?? grants[0];
  } catch (e) {
    await auditPerRef(allRefs, body.stdin_ref, resolved, false, e instanceof ShuttleError ? e.code : "unexpected_error", grant?.session_id);
    writeJsonError(res, 400, e);
    return;
  }
}
```

**Order of deletions in this file:**

- **Step 7 of §10 (continuation-path migration):**
  - Lines 297-348: the env-approval block (replaced by the unified call above).
  - Lines 350-392: the stdin-approval block (also subsumed).
  - Lines 300-305: the `envApprovalRan` flag and its bookkeeping (atomicity now lives inside `requireApprovals`).
  - The `combined_no_wait_unsupported` fail-fast at lines 244-283 stays in place at this point as a belt-and-suspenders safety net.
- **Step 9 of §10 (after the integration test in step 8 has proven the continuation path):**
  - Lines 244-283: the `combined_no_wait_unsupported` fail-fast block is deleted (entire `if (hasProductionEnv && hasProductionStdin && body.wait_for_approval === false)` block plus surrounding comment).

### 8. Migration of single-binding callers

All approval-gated routes outside `run-resolve` keep using a single binding but go through `requireApprovals`. Per-route diff per call site:

**Body parse:**
- `optString(o, "approval_id")` → `optApprovalIds(o)` (returns `string[] | undefined`).
- `Body` interface field `approval_id?: string` → `approval_ids?: string[]`.

**Call:**
- `requireApproval({ binding, approvalIdFromClient, ... })`
- → `requireApprovals({ bindings: [binding], approvalIdsFromClient, ... })`
- `grants[0]` is the binding's grant.

Each route gets one task in Plan 4d. Verification per route: existing tests pass without behavior change.

### 9. Hub broker — no changes

The broker FIFO-queue at `src/daemon/hub/hub-broker.ts` already handles N approvals via `surface()` (lines 89-105). Under `--no-wait`, `requireApprovals` calls `openUrlImpl` (which routes through `makeHubOpenUrlImpl` → `surface`) once per mint; the broker enqueues them. Under waiting flow, each mint surfaces, the user approves it, the wait resolves, then the next mint surfaces. Either way the broker UX is identical.

No `hub-broker.ts` changes required.

---

## Implementation Order Constraint (§10)

The fail-fast block is the current safety net. It is deleted **only after** the continuation path is wired in `run-resolve` AND an integration test demonstrates the combined env+stdin `--no-wait` reproducer converges. The Plan 4d task ordering MUST be:

1. New `requireApprovals` primitive + `approvalBindingsMatch` export + `canMatchSession` / `mintFromSession` split + unit tests. (No route changes yet.)
2. `ShuttleError.details` plumbing (`errors.ts`, `daemon-client.ts`, round-trip test).
3. `optApprovalIds` helper in `validate.ts` + unit tests.
4. CLI shared option-factory `_approval-id-option.ts` (file added; no commands wired to it yet).
5. Migrate all 13 single-binding routes to `requireApprovals({bindings:[b]})` + `optApprovalIds`. Existing tests must pass unchanged. Pure mechanical refactor.
6. Migrate all CLI commands to `addApprovalIdOption`. Body construction switches to `approval_ids`. Existing tests must pass unchanged.
7. Migrate `run-resolve` to the multi-binding `requireApprovals` call (§7). The `combined_no_wait_unsupported` fail-fast still in place.
8. New integration test in `run-resolve.test.ts`: combined production-env + production-stdin + `--no-wait` (no IDs) → `approval_required` with `details.approvals` of length 2; retry with both `approval_ids` → command runs. **This test must pass before step 9.**
9. Delete the fail-fast block + `combined_no_wait_unsupported` error code + its tests + the CHANGELOG Known-limitations bullet for the combined case.
10. CHANGELOG Plan 4d section + docs updates (`docs/cli-reference.md`, `docs/roadmap.md`) + full-suite verification (`npm run typecheck && npm test && npm run check-pack`).

**Why this matters.** If steps 8 and 9 are reordered, a buggy continuation path could land without the safety net catching the regression. Step 8 is the gate. The plan document MUST enforce this with explicit task dependencies.

---

## Error registry deltas

**Added:** none new. All used error codes (`approval_not_found`, `approval_not_granted`, `approval_already_used`, `approval_expired`, `approval_denied`, `approval_mismatch`, `approval_required`, `session_not_found`, `session_expired`, `session_unauthorized`, `session_max_uses_exceeded`, `bad_request`) already exist.

**Modified:**
- `approval_required` hint string updated to:
  > `"Approve in the opened hub, then retry with --approval-id <id> (repeatable for each id listed under details.approvals)."`

**Removed:**
- `combined_no_wait_unsupported` (added in Plan 4c post-ship `460e750`). Replaced by the working continuation path. Count goes 120 → 119.
- `error-codes.test.ts:142` registration test for it.
- `error-codes.test.ts:181-189` lookup test for it.
- The two regression tests in `run-resolve.test.ts` that asserted on it.

---

## Test plan

### Unit tests for `requireApprovals` (`require-approvals.test.ts` — new file, supersedes `require-approval.test.ts`)

1. `bindings: []` → returns `[]`.
2. `bindings: [devBinding]` → synthesized grant (`environment !== "production"`).
3. `bindings: [prodBinding]`, no IDs, `--no-wait` → throws `approval_required` with `details.approvals` of length 1.
4. `bindings: [prodBinding]`, supplied correct ID (status `granted`) → consumes, returns grant.
5. `bindings: [envBinding, stdinBinding]`, no IDs, `--no-wait` → throws `approval_required` with `details.approvals` of length 2, in `bindings` order.
6. `bindings: [envBinding, stdinBinding]`, both IDs supplied in matching order → consumes both, returns 2 grants.
7. **Best-fit / reverse order.** `bindings: [envBinding, stdinBinding]`, `approval_ids: [stdinId, envId]` → both consumed (matcher pairs by binding equality, not position).
8. **Partial-no-wait does not consume supplied IDs.** `bindings: [envBinding, stdinBinding]`, only `envId` supplied, `--no-wait` → throws `approval_required` with `details.approvals` containing the stdin-binding mint. Asserts: env grant still `status === "granted"` (NOT `"used"`); only one new pending grant exists in the store (for `action: "run_stdin"`).
9. **Unknown ID.** `bindings: [envBinding]`, `approval_ids: ["does-not-exist"]` → throws `approval_not_found` (NOT `approval_mismatch`).
10. **Extra ID.** `bindings: [envBinding]`, `approval_ids: [envId, extraGrantedId]` where `extraGrantedId` exists but matches a different binding → throws `approval_mismatch` after binding loop completes.
11. **Status-not-granted blocks Phase 2.** `approval_ids: [envIdPending]` where `envIdPending` is `status: "pending"` (binding matches env) → throws `approval_not_granted` in Phase 1. Asserts: `envIdPending` still `status: "pending"` (NOT consumed).
12. **Session at max_uses.** Session covers env but `uses >= max_uses`. `bindings: [envBinding, stdinBinding]`, `sessionId` set, no IDs, `--no-wait` → throws `session_max_uses_exceeded` in Phase 1. Asserts: zero new pending grants minted in the store; `session.uses` unchanged.
13. **Session not burned on incomplete.** Session covers env but not stdin. `bindings: [envBinding, stdinBinding]`, `sessionId` set, no IDs, `--no-wait` → throws `approval_required` with `details.approvals` of length 1 (the stdin mint). Asserts: `session.uses` unchanged after the throw (session was peeked but not used because Phase 2 short-circuited via the mint case).
14. **Session-first precedence with both `session_id` and `approval_ids`.** Session covers binding A only. `approval_ids: [idForA, idForB]`. Both bindings present. → Binding A planned `session`; Binding B planned `consume(idForB)`. Phase 2 → `mintFromSession` for A, `store.consume` for B. Asserts: `session.uses` incremented by 1; `idForA` still `status: "granted"` (not consumed); `idForB` `status: "used"`.
15. **Waiting flow, sequential, denial mid-flow.** `bindings: [envBinding, stdinBinding]`, no IDs, `waitMs > 0`. Test wires a fake hub to deny env shortly after mint. → throws `approval_denied`. Asserts: zero pending grants for `action: "run_stdin"` exist in the store (stdin was never minted).
16. **Waiting flow, all granted.** `bindings: [envBinding, stdinBinding]`, no IDs, `waitMs > 0`. Fake hub approves env, then approves stdin. → returns 2 grants. Asserts: 2 used grants in the store, in `bindings` order.

### Unit tests for `approvalBindingsMatch` (`store.test.ts` extension)

Direct tests for the (now-public) matcher: identical bindings match; differing each of the strict-equality fields (`action`, `ref`, `environment`, `destination_domain`, `target_id`, `field_fingerprint`, `template_id`, `allowed_domains` set, etc.) → mismatch.

### Unit tests for `canMatchSession` (`store.test.ts` extension)

- Granted, pattern matches, under max_uses → `true`, no side effects.
- Granted, pattern doesn't match → `false`, no side effects.
- Revoked → throws `session_not_found`.
- Expired → throws `session_expired`.
- Denied / pending → throws `session_unauthorized`.
- At max_uses → throws `session_max_uses_exceeded`.

### Unit tests for `optApprovalIds` (`validate.test.ts` extension)

- `{}` → `undefined`.
- `{approval_id: "a"}` → `["a"]`.
- `{approval_ids: ["a", "b"]}` → `["a", "b"]`.
- `{approval_id: "a", approval_ids: ["b"]}` → throws `bad_request: approval_id_and_approval_ids_supplied`.
- `{approval_ids: ["a", "a"]}` → throws `bad_request: duplicate_approval_id`.
- `{approval_ids: []}` → `undefined`.
- `{approval_id: 42}` → throws `bad_request` (type mismatch; existing helper behavior).
- `{approval_ids: ["a", 42]}` → throws `bad_request` (type mismatch; existing helper behavior).

### Unit tests for `ShuttleError.details` round-trip

In `errors.test.ts` and `daemon-client.test.ts`:
- `new ShuttleError("x", "msg", { details: { foo: 1 } })` → `errorToJson(e).details` deep-equals `{ foo: 1 }`.
- `daemonErrorFromPayload({ok: false, error_code: "x", message: "msg", details: { foo: 1 }})` → `.details` deep-equals `{ foo: 1 }`.
- Daemon → CLI round trip via the HTTP test harness with a route that throws `approval_required` with details → CLI's reconstructed `ShuttleError.details` deep-equals the daemon's input.

### Integration tests for `run-resolve.ts`

Replace the two `combined_no_wait_unsupported` tests with:
- **Combined env+stdin --no-wait converges.** Production env file + production stdin ref + `--no-wait`, no IDs → response is `approval_required` with `details.approvals` of length 2 (one `run`, one `run_stdin`). Retry with both `approval_ids` → command runs (200 OK, exit code 0 from the streamed child).
- All existing single-approval tests (env-only, stdin-only, dev-only) continue to pass.
- The `combined_no_wait_unsupported` regression tests are **deleted**.

### E2E test in `hub-e2e.test.ts`

Extend the Plan 4c production-stdin e2e to cover the combined case end-to-end through the hub broker. The fake subscriber approves env first (FIFO), then stdin. Asserts both approvals burn correctly and the masked child output (`***`) is streamed back.

---

## CHANGELOG

Under v0.3.0 (or v0.2.1 — TBD at release time):

```
### Added
- Multi-approval continuation: operations that gate on multiple ApprovalBindings
  (currently only `run --env-file <prod> --stdin <prod>`) now work end-to-end
  under `--no-wait`. The daemon mints all required approvals atomically on the
  first round-trip and returns them via the new `details.approvals` array. The
  CLI carries them back via repeatable `--approval-id <id>` flags. Closes the
  v0.2.0 Known-limitation documented in [previous CHANGELOG entry].

- `ShuttleError` now carries an optional `details` field, propagated through
  `errorToJson` and reconstructed by `daemonErrorFromPayload`. Used by
  `approval_required` to surface the `approvals` array; available for any
  future error code that needs structured side-channel data.

- `--approval-id <id>` is now repeatable on every approval-gated command.

### Changed
- Internal: `require-approval.ts` → `require-approvals.ts`. Single primitive
  `requireApprovals(bindings, ...)` replaces the old `requireApproval(binding, ...)`.
  All 14 call sites updated. Single-binding callers pass `[binding]`. No
  behavioral change for single-approval operations.

- Internal: `ApprovalStore.findOrMintFromSession` is split into
  `canMatchSession` (pure peek) + `mintFromSession` (side-effect). The new
  primitive's Phase 1/Phase 2 invariant relies on this split — sessions are
  only used when the entire operation is guaranteed to commit.

- Wire format: `approval_id` (singular) in request bodies is now a deprecated
  alias for `approval_ids: [approval_id]`. Sending both → `bad_request`.
  Singular form is dropped in a future release.

### Removed
- Internal: `combined_no_wait_unsupported` error code. The continuation path
  replaces the fail-fast.

### Known limitations
- [REMOVE] The previous bullet stating "Combined `--env-file` (with production
  refs) + `--stdin` (with production ref) + `--no-wait` is not supported in
  v0.2.0…". No longer a limitation.
```

---

## Out of scope

- Truly interactive TTY stdin (separate Plan 4e candidate).
- Operation handles / persisted operation state. The two-phase invariant removes the need.
- Removing the legacy singular `approval_id` field from request bodies. Kept for one release; future cleanup.
- Removing the legacy singular `{approval_id, expires_at}` JSON string from `error.message`. Kept for one release; future cleanup.
- A human-rendering CLI mode for `approval_required` (e.g., `--render=human`). Future opt-in feature.
- `details.summary` / `details.refs` / `details.retry_args` enrichment fields. Speculative; defer until a concrete consumer asks.
- Multi-approval generalization beyond what `run-resolve` needs today. Design supports N approvals per operation; no current route mints >2.

---

## Migration notes

- Internal API rename (`requireApproval` → `requireApprovals`) is a one-shot mechanical refactor across ~14 call sites. No external consumers exist (daemon is local-only).
- Wire format alias (`approval_id` → `approval_ids`) is preserved for one release. Any v0.2.x clients keep working without code changes.
- Tests using `body.approval_id` directly continue to work because of the alias normalization. Tests asserting on the wire shape should be updated to use `approval_ids` as the canonical field.

---

**End of design.**
