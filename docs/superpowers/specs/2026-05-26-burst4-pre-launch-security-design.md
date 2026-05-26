# Burst 4 — Pre-Launch Security Hardening (5m + 5o-core + 5p)

**Date:** 2026-05-26

**Goal:** Close three pre-launch gaps in one coherent spec — per-agent token isolation, in-flight memory hygiene, and capture-from-provider-URL in bootstrap — so Secret Shuttle's v1 launch claim ("AI agents provision your entire project's secrets across providers without ever seeing them, one click of approval per batch") holds up.

**Audience:** Vibe coders + dev teams. NOT enterprise-audit (Option C / 5q is the post-launch plan for that).

**Tech stack:** TypeScript strict ESM, Node 20+, AES-256-GCM for vault, Chrome CDP for browser, HMAC-SHA256 for token derivation, AsyncLocalStorage for request context propagation.

---

## §0 Cross-section context

This spec extends three independent subsystems. They share three integration points worth naming up front:

1. **The bootstrap-authority bypass** (Plan 5g, fortified by R10/R12/R13/R7/R11). When `executeBatch` runs inner cores under `bootstrapAuthority`, it skips the inner `requireApprovals` call. The outer bootstrap binding is the only human-approval gate for the entire batch. Per-agent tokens (§1) and capture flow (§3) both interact with this contract.

2. **The blind-mode discipline** (Plan 4-era inject + reveal-capture). CDP observation is severed while the daemon manipulates sensitive page state. Capture-from-URL (§3) inherits the discipline and extends it for multi-step batches.

3. **The audit pipeline** (Plan 4d's `next_action` infrastructure + R9's destination detail). Per-agent tokens (§1) thread agent_id through every audit record; memory hygiene (§2) does not produce new audit events but documents which paths are touched.

Plan 5g's bootstrap fixes (R1–R15) are assumed in place: idempotent retry, per-batch lock, three-gate production approval, ref canonicalization, yml validation.

---

## §1 — Per-agent token isolation (5m)

### Threat model — what this gives you, what it does not

Per-agent tokens are **attribution + hygiene** against same-user processes that do NOT have broad filesystem access. They are NOT hard isolation against a fully-privileged same-user attacker who can read `<SHUTTLE_HOME>/root-token` or arbitrary daemon process memory.

This boundary is OS-account-scoped. Hard isolation requires OS sandboxing (containers, AppArmor, Bubblewrap) — out of scope for v1. Documented prominently in SKILL.md so operators don't assume a stronger guarantee.

What per-agent tokens DO provide:
- **Audit attribution:** every daemon call records which agent did what (actor_agent_id stamped via AsyncLocalStorage)
- **Compromise hygiene:** a non-shell-capable agent process cannot read the socket file → cannot impersonate root or another agent
- **Owner-enforced approval/session consumption:** an agent cannot spend another agent's approval grant or session
- **Mint hierarchy:** parent→child token derivation is structurally bounded by name prefix (no impersonation of sibling agents)

### Persistent root token

Today (`main.ts:32`): `randomBytes(32).toString("base64url")` generated per daemon start. Burst 4 makes it persistent.

- File: `<SHUTTLE_HOME>/root-token` (mode 0600, owner-only)
- Generated on first daemon start if absent
- Read at every subsequent start
- Daemon refuses to start if the file exists but is not mode 0600 (fail-closed against permission tampering)
- Socket file (`<XDG_RUNTIME>/secret-shuttle.sock`) still carries the current root_token for shell-tool compatibility, but the daemon no longer regenerates it per start

### Token format

Bearer header: `Authorization: Bearer <agent_id>.<hmac>`

- `agent_id` regex: `^[a-z0-9][a-z0-9._-]{0,63}$` (dots allowed for hierarchy, max 64 chars)
- `hmac` = `base64url_no_pad(HMAC-SHA256(base64url_decode(root_token), agent_id))` → exactly 43 chars
- Split bearer on the **last** `.` (HMAC base64url-no-pad output contains no `.`)
- `agent_id = "root"` reserved → rejected at mint and at validation
- Root requests carry the bare root_token (no `.hmac` suffix)

### agent_id structure

Format: `<runtime>-<cwd_slug>-<16_hex>`

- `runtime` ∈ { `claude-code`, `cursor`, `codex`, `copilot` } from existing `detectAgentRuntimes`
- `cwd_slug` = up to 16 chars of `slugify(basename(cwd))` — operator-readable
- `16_hex` = first 16 hex chars of `SHA-256(machine_id ‖ runtime ‖ realpath(cwd))` — deterministic so re-running `init` is idempotent; 64-bit collision resistance

Example: `claude-code-myapp-7f2a1b8c2d4e3f5a`

### Centralized token resolver

New module `src/client/auth-token.ts`:

```ts
export interface ResolvedToken {
  bearer: string;             // value for Authorization: Bearer <X>
  scope: "agent" | "root";
  agentId?: string;           // present when scope === "agent"
}

export async function resolveDaemonToken(opts: { port: number }): Promise<ResolvedToken>
```

Priority order:
1. `SECRET_SHUTTLE_AGENT_TOKEN` env var → parse `<id>.<hmac>` → `{ scope: "agent", agentId, bearer }`
2. `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN === "1"` AND no agent token found → throw `agent_token_required` (fail-closed; do NOT fall back to socket file)
3. Socket file's root_token → `{ scope: "root", bearer }`

Both `src/client/daemon-client.ts` and `src/client/streaming-request.ts` MUST call this helper. No bypass.

### Daemon-side validation flow + AsyncLocalStorage

```ts
interface AuthContext {
  agent_id: string | "root";
  isRoot: boolean;
}

const als = new AsyncLocalStorage<AuthContext>();
```

`DaemonServer.handle()` resolves auth, wraps the handler in `als.run(authContext, handler)`:

```
parse Authorization header → bearer
if bearer contains no '.':
    timingSafeEqual(bearer, root_token) → AuthContext { agent_id: "root", isRoot: true }
else:
    (agent_id, hmac_b64) = bearer.rsplit('.', 1)
    reject if !AGENT_ID_RE.test(agent_id) || agent_id === "root"
    expected = base64url_no_pad(HMAC-SHA256(decode(root_token), agent_id))
    timingSafeEqual(hmac_b64, expected) → AuthContext { agent_id, isRoot: false }
als.run(authContext, () => handler(req, res))
```

Failure cases:
- Bearer missing → 401 `unauthorized` (existing)
- agent_id charset invalid → 401 `unauthorized`
- agent_id is `"root"` → 401 `unauthorized`
- HMAC mismatch → 401 `unauthorized` (timing-safe; no information leak about which part of the token was wrong)

### Audit policy — per-emission-site, not blanket ALS

| Audit emission site | Source of `actor_agent_id` |
|---|---|
| Standard auth-gated routes (most of `/v1/*`) | `als.getStore().agent_id` |
| Raw UI route (approval click handler — `/ui/approve`, `/ui/deny`, hub broker) | `approvalGrant.owner_agent_id` from the persisted grant being clicked |
| Lifecycle (daemon start, lock, shutdown) | Literal `"daemon"` — no request context exists |
| Bootstrap capture-step callbacks | `als` for the call that registered the pending capture (the executor's context, which inherits from the originating /continue) |

Central helper `getAuditActor(emissionSite, context)` resolves the right source. `audit.ts` is updated to use it instead of relying on ambient ALS.

### Owner-enforced approval/session consumption

`ApprovalGrant` schema gains `owner_agent_id: string` (set at mint from ALS, or `"root"`).
`SessionGrant` schema gains `owner_agent_id: string` (same).

Owner enforcement happens at the **earliest preflight point**, NOT just at final consume:

`ApprovalStore.validateConsumeBatch(supplied_ids, bindings, caller_agent_id)`:
- For each supplied approval_id: fetch grant; reject if `grant.owner_agent_id !== caller_agent_id` AND caller is not root
- For each session-derived candidate: reject if `session.owner_agent_id !== caller_agent_id` AND caller is not root
- ALL rejections happen here, BEFORE session uses are burned, BEFORE any state mutation

This is the single owner-enforcement chokepoint. `ApprovalStore.consume` and `consumeBatch` also re-check defensively (belt-and-suspenders).

### Error code for ownership violation — no existence leak

- **For non-root callers:** owner mismatch returns existing `approval_not_found` (indistinguishable from "really doesn't exist"). Prevents cross-agent grant enumeration.
- **For root callers:** owner mismatch returns NEW `approval_owner_mismatch` (explicit; root has enumeration privileges anyway).

Audit on failed consume emits both `actor_agent_id` (caller) and `subject_agent_id` (real owner) for admin forensics.

### Sub-agent mint with namespace restriction

`POST /v1/tokens/mint { agent_id: "<requested>" }`:

```
caller_id = als.getStore().agent_id
if caller is root: allow any well-formed agent_id (admin/initial mint)
else:
  requested_agent_id MUST start with `${caller_id}.` (literal prefix)
  → caller "claude-code-myapp-7f2a" can mint "claude-code-myapp-7f2a.helper-3a1b"
  → caller "claude-code-myapp-7f2a" CANNOT mint "cursor-host-..." (no prefix match)
  → caller "claude-code-myapp-7f2a" CANNOT mint "claude-code-myapp-7f2a" (no extension)

Returns: { token: "<id>.<hmac>", agent_id: "<id>" }
Audit: tokens_mint { actor_agent_id: caller_id, child_agent_id: requested_agent_id }
```

Stateless. No persistence. The hierarchy is structurally enforced by the prefix rule.

### Sessions per-agent

- `SessionGrant.owner_agent_id: string` — stamped at mint from ALS
- Session create: `POST /v1/approvals/session` records owner
- Session fast-path consume: matches only if `current_agent_id === session.owner_agent_id` OR caller is root
- List/revoke: non-root filters to caller's own sessions; root sees all (admin)
- Audit: `session_create` and `session_revoke` carry both `actor_agent_id` and `subject_agent_id` (the session's owner)

### `daemon rotate` — immediate invalidation

`POST /v1/daemon/rotate` (root-only):

```
1. Acquire lifecycle lock
2. new_root = randomBytes(32).base64url
3. Write to <SHUTTLE_HOME>/root-token atomically (write to .tmp, fsync, rename)
4. Rewrite socket file atomically with new token
5. server.replaceRootToken(new_root) — hot-swap in-memory
6. Audit: daemon_rotate { actor_agent_id: "root" }
7. Return { ok: true, message: "Root token rotated. Re-run `secret-shuttle init` to re-issue per-agent tokens." }
```

`DaemonServer.replaceRootToken(t)` swaps `this.token` (JS single-threaded → atomic). After rotation:
- Requests with OLD root_token → 401
- Requests with derived agent tokens from OLD root → 401 (HMAC mismatch)
- Shell CLI re-reads socket file on next call → picks up new root automatically
- Agent processes still hold OLD `SECRET_SHUTTLE_AGENT_TOKEN` → next call fails → user re-runs `init`

CLI: `secret-shuttle daemon rotate` (root-shell only).

### Init: honest scope for runtime token installation

`detectAgentRuntimes` returns runtimes in two buckets:

**Concrete-config bucket** (init writes per-agent env vars):
- `claude-code` → write to `~/.claude/settings.json` env block
- `cursor` → write to `~/.config/Cursor/User/settings.json` env block (platform-specific paths)

For these, init writes BOTH:
- `SECRET_SHUTTLE_AGENT_TOKEN=<derived-token>`
- `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1`

NEVER in: repo-committed files (AGENTS.md, .cursorrules, .claude/skills/*.md). User-private config only.

**Manual-install bucket** (init prints copy-paste instructions, does NOT claim "configured"):
- `codex` (OpenAI Codex CLI) — print: "To enable for codex: export SECRET_SHUTTLE_AGENT_TOKEN=<token> and SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 in your shell rc, then restart codex."
- `copilot` — similar (until their launch path is investigated, promotion to concrete bucket happens then)

`init` summary distinguishes:
```json
{
  "agent_runtimes_configured": ["claude-code"],
  "agent_runtimes_pending_manual": ["codex"],
  "next_actions": [
    "For codex: export SECRET_SHUTTLE_AGENT_TOKEN=... in your shell rc"
  ]
}
```

### Audit field naming

Distinct field names:
- `actor_agent_id` — who performed the action
- `subject_agent_id` — for sessions/grants: the owner being acted upon (revoke target)
- `parent_agent_id` / `child_agent_id` — for token mint chains

No bare `agent_id` at the top level of audit records.

### New error codes (5m)

- `agent_token_required` — `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1` set, no agent token found, client refused to fall back
- `agent_token_invalid` — bearer parse or HMAC validation failed (alias of `unauthorized` but more specific where useful)
- `approval_owner_mismatch` — root-only error variant (non-root gets `approval_not_found`)
- `agent_id_invalid` — mint requested a malformed agent_id
- `agent_id_namespace_violation` — non-root mint requested an agent_id outside caller's namespace

### What stays unchanged

- Socket file format and use. Shell CLI still reads root_token via socket file for direct calls.
- Approval / hub / bootstrap binding shapes (apart from new `owner_agent_id` field).
- All R10/R12/R13/R7/R11 bootstrap fixes.

---

## §2 — Memory hygiene (5o-core, Option B-prime)

### Scope

A best-effort pass: master-key copies and byte-buffer write boundaries are scrubbed. The `Secret.value: string` residue is documented but NOT eliminated — that's the named follow-up (5q).

### In-scope scrub sites

1. **`requireKey()` copies — minimize lifetime, scrub before async continuation:**
   - `Vault.read` (AEAD decrypt)
   - `Vault.write` (AEAD encrypt)
   - `Vault.fingerprintKey` (HMAC key derivation)
   - Any fingerprint caller using `requireKey()` directly
   - **Rule:** encrypt/decrypt synchronously under the key, `.fill(0)`, THEN continue with unrelated async work. NEVER hold the copied key across `await fs.writeFile(...)` or migration steps.

2. **Masker pattern + lookback buffers:**
   - `createMasker()` retains pattern Buffers AND can hold partial secret bytes in `lookback` across chunks
   - On `dispose()` and `flush()`: zero BOTH `patterns[]` AND `lookback`
   - Dispose hook fires from the route handler's finally block after child process exits

3. **Child stdin Buffer scrub — after write completion, not immediately:**
   - Node may retain the same Buffer reference until the write completes
   - Pattern: `stdin.end(buf, callback)` — zero in the callback
   - Add `close`/`error` event fallback that also scrubs (abnormal termination still zeroes)

4. **tmp env-file write buffer:** preserve existing `.fill(0)` (`tmp-env-file.ts:58, 75`) — already correct; ensure no regression.

### Out of scope (require 5q)

- CDP inject path (`WRITE_SCRIPT(value)` builds an interpolated JS string via Chrome's CDP wire format)
- Child process `env: Record<string, string>` (Node's spawn API takes strings)
- `Secret.value: string` returned by `vault.getSecret()` — lingers until GC

### Tests

- Wrapper/spy on Buffer verifies every `requireKey()` callsite reaches `.fill(0)` in its finally block
- Masker integration test: assert `patterns[]` AND `lookback` are zeroed after dispose
- Stdin scrub timing test: Buffer is non-zero before write callback, zero only after — never both states observed in wrong order

### Docs

New SKILL.md / threat-model section: "Memory hygiene (best-effort)":

> The master key is zeroed on lock and on every in-flight crypto operation; copies are scrubbed synchronously before any async continuation. Byte buffers built for child-process stdin and tmp env-file writes are scrubbed after the consumer reads them. Masker pattern and lookback buffers are scrubbed on stream dispose.
>
> Secret values returned by the vault (`vault.getSecret(ref).value`) are JS strings, which V8 does not let us proactively zero — they linger in heap until garbage collection. A post-launch hardening plan (5q) refactors `Secret.value` to `Buffer` for end-to-end scrub; required for security-audit deployments.

### Named follow-up plan

`5q — Vault value-Buffer end-to-end (enterprise-readiness)`: refactors `Secret.value: string → Buffer` across vault/routes/templates. Required for SOC-grade audits. Separate brainstorm + plan.

---

## §3 — Capture-from-URL in bootstrap (5p)

### Goal

Promote `source: { kind: capture, url: "https://..." }` from "rejected at /plan time" to a real, orchestrated flow. The agent declares URLs; the daemon drives the browser to each URL and captures the value the dev reveals — all under the single bootstrap approval, with blind-mode discipline matching existing reveal-capture semantics.

### Yml shape

```yaml
version: 1
secrets:
  STRIPE_WEBHOOK_SECRET:
    source:
      kind: capture
      url: "https://dashboard.stripe.com/webhooks/we_abc/signing_secret"
    destinations: [vercel:production]
  SUPABASE_SERVICE_ROLE_KEY:
    source:
      kind: capture
      url: "https://supabase.com/dashboard/project/abc/settings/api"
    destinations: [vercel:production]
```

### Yml validation (extends R14)

In `parseSource` for `kind: capture`:

```ts
const u = new URL(rawUrl); // throws on malformed → bootstrap_capture_url_invalid
if (u.protocol !== "https:") fail("capture url must be https");
if (u.username || u.password) fail("capture url must not embed credentials");
if (
  u.hostname === "localhost" ||
  u.hostname === "127.0.0.1" ||
  /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
  /^\[?::/.test(u.hostname)
) {
  fail("capture url must not target localhost / IP literal");
}
return {
  kind: "capture",
  url: rawUrl,
  expected_host: u.hostname,  // canonical, lowercased per WHATWG
};
```

NO trusted-domain allowlist. The approval card surfaces the full URL to the dev — that's the human-policy gate.

`BootstrapSource` for `kind: "capture"` gains `expected_host: string` (persisted in `BatchState.plan`).

### Approval card (extends R6 / Plan 5g hub UI)

`renderBootstrap()` in `ui.html` already renders `capture: <url>` per secret (Plan 5g R6). No drift changes needed — the single bootstrap approval covers every capture step + every destination push.

### Browser lifecycle — owned session object

Replace the loose `services.browser` reference with `BrowserSession`:

```ts
interface BrowserSession {
  owner: { kind: "user" } | { kind: "bootstrap"; batchId: string };
  child: ChildProcess;       // the Chrome process from launchChrome()
  cdp: CdpClient;
  proxy: CdpProxy | null;
  browserSessionId: string;  // for audit
  browser: BrowserOps;       // wrapper used by routes today
}

services.browserSession: BrowserSession | null;
```

Migrate `/v1/browser/start` to construct and retain the full `BrowserSession`. Existing call sites `services.browser` → `services.browserSession?.browser`.

`CdpClient.close()` is added (or close-via-existing-handles is defined; Option A — add the method — is the cleaner path).

### Browser auto-start with ownership tracking

```ts
async ensureBootstrapBrowser(batchId: string): Promise<BrowserSession> {
  if (services.browserSession !== null) {
    // Pre-existing user session — reuse, do NOT change ownership
    return services.browserSession;
  }
  const session = await launchBrowserSession();
  services.browserSession = { ...session, owner: { kind: "bootstrap", batchId } };
  return services.browserSession;
}

async stopBootstrapBrowser(batchId: string): Promise<void> {
  const s = services.browserSession;
  if (s?.owner.kind !== "bootstrap" || s.owner.batchId !== batchId) return; // not ours
  // 1. Stop accepting new agent CDP connections at the proxy layer
  await s.proxy?.close().catch(() => undefined);
  // 2. Close the daemon's own CDP client
  await s.cdp.close().catch(() => undefined);
  // 3. Kill Chrome
  s.child.kill("SIGTERM");
  await Promise.race([
    once(s.child, "exit"),
    new Promise<void>((r) => setTimeout(() => { s.child.kill("SIGKILL"); r(); }, 3000)),
  ]);
  // 4. Clear session
  services.browserSession = null;
}
```

### Bind capture to a specific target

New daemon-only `BrowserOps` methods (NOT exposed via `/v1/browser/*`):

```ts
openCaptureTarget(url: string): Promise<{ target_id: string; host: string }>
captureFromTarget(target_id: string, mode: "focused-field" | "selection"): Promise<CaptureResult>
blankTarget(target_id: string): Promise<void>     // navigate to about:blank
closeTarget(target_id: string): Promise<void>
getTargetURL(target_id: string): Promise<string>  // for post-load redirect check
listTargets(): Promise<Array<{ target_id: string; url: string }>>
```

`captureFromTarget` re-verifies host at capture time:
- Reads target's current top-level URL
- Compares `new URL(currentUrl).hostname` against `entry.source.expected_host`
- Rejects with `bootstrap_capture_redirect_blocked` on mismatch

### Pre-flight blind guard at both execution entry points

```ts
async function assertBlindInactiveForBootstrap(services: DaemonServices): Promise<void> {
  if (services.blind.current() !== null) {
    throw new ShuttleError(
      "blind_mode_already_active",
      "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
    );
  }
}
```

**Where it fires (capture-conditional):**

`/v1/bootstrap/plan`:
```ts
const parsed = parseBootstrapYml(planYml);
const existingRefs = new Set((await services.vault.list()).map(s => s.ref));
const plan = computeBootstrapPlan(parsed, { has: r => existingRefs.has(r) }, { force, source: "local", environment });

if (plan.length === 0) { /* empty-plan short-circuit */ }

// Capture guard — based on COMPUTED plan, not parsed yml.
// Entries that diffed out (already in vault, no --force) don't trigger.
if (plan.some(e => e.source.kind === "capture")) {
  await assertBlindInactiveForBootstrap(services);
}

// Continue: batchId allocation, state save, requireApprovals, etc.
```

`/v1/bootstrap/continue`:
```ts
const state = await services.bootstrapStore.get(batchId);
if (state === null) throw bootstrap_batch_not_found;
if (state.status === "completed") return summarizeFromState(state);

// Capture-conditional blind guard — BEFORE approval consume.
// Preserves the minted approval for retry after dev resolves blind.
if (state.plan.some(e => e.source.kind === "capture")) {
  await assertBlindInactiveForBootstrap(services);
}

// Approval consume (R7: pending only)
if (state.status === "pending") {
  await requireApprovals({ ... });
}

// Acquire lock + executeBatch
```

Guards fire only when capture steps will ACTUALLY execute (computed plan or persisted state.plan).

### Per-step interactive flow

Executor's `runSourceStep` for `kind: "capture"`:

```
Step start:
1. Assert services.blind.current() === null (defensive re-check; race protection)
2. services.blind.start(entry.source.expected_host, "bootstrap-capture")
3. await disableObservationDomains(services.browserSession.cdp).catch(()=>undefined)
4. services.browserSession.proxy?.severAgentConnections()
5. const target = await browser.openCaptureTarget(entry.source.url)
6. Verify post-load host:
     const final_url = await browser.getTargetURL(target.target_id)
     if (new URL(final_url).hostname !== entry.source.expected_host) {
       throw new ShuttleError("bootstrap_capture_redirect_blocked", ...)
     }
7. capture_token = randomBytes(32).base64url
   Register pendingCaptures.set(key, { resolve, reject, capture_token, target_id, host, started_at, timer })
8. Send hub SSE event:
   { type: "bootstrap_capture_step", batch_id, secret_name, url, step_idx, step_total, capture_token }
9. await new Promise((resolve, reject) => { /* timer set to 5min → reject(bootstrap_capture_timeout) */ })
10. On resolve (dev clicked Capture in hub):
      capture_result = await browser.captureFromTarget(target.target_id, mode)
      vault.upsertSecret({ name, environment, source, value: capture_result.value, allowedDomains: entry.destinations.map(d => d.domain) })
      // captured_from_host recorded in audit
      Proceed to cleanup
11. On reject (skip / timeout / abort / redirect): proceed to cleanup with error preserved
```

### Per-step tokenized raw UI routes

Hub UI POSTs to URL-tokenized routes (no bearer, matching existing approval/hub pattern):

- `POST /ui/bootstrap/capture-step?token=<capture_token>` — capture now
- `POST /ui/bootstrap/skip-step?token=<capture_token>` — skip this secret
- `POST /ui/bootstrap/abandon?token=<capture_token>` — abandon entire batch

Each route:
- Looks up pending entry by token
- Validates token matches active step's `(batch_id, secret_name)`
- Calls the appropriate resolve/reject on the pending Promise
- Single-use: token invalidated after step resolves

Abandon route: rejects the pending Promise with `bootstrap_capture_aborted`, sets an `aborted` flag the executor reads BEFORE next step, transitions batch to `abandoned` (terminal) — does NOT delete batch state mid-walk.

### Pending-capture registry

```ts
// Field on BootstrapStore (or sibling helper class):
private readonly pendingCaptures = new Map<string, {  // key: `${batchId}:${secretName}`
  resolve: (capture: CaptureResult) => void;
  reject: (err: ShuttleError) => void;
  capture_token: string;
  target_id: string;
  host: string;
  started_at: number;
  timer: NodeJS.Timeout;
}>();
```

Cleanup on resolve/reject: `clearTimeout(timer)`, `pendingCaptures.delete(key)`.

The executor's promise awaits this registry; routes (capture-step / skip / abandon) and the timeout call resolve/reject.

### Post-step cleanup state machine

```
On step terminal (success OR failure):
1. browser.blankTarget(target_id)     // page → about:blank
2. Verify blank: re-read URL via browser.getTargetURL(target_id)
   Cleanup verified iff: URL is "about:blank" OR target_id not in listTargets()
3. browser.closeTarget(target_id)     // close the tab
4. Verify close: re-read listTargets(). target_id absent → close verified

Branch on (step outcome, cleanup verified):

(SUCCESS, verified): {
  - services.blind.end() automatically (page is observable-clean)
  - audit: blind_auto_resume { reason: "bootstrap_capture_verified_clean", subject_secret, batch_id }
  - step_results[secret] = { ok: true, ref: capturedRef }
  - Continue to next plan entry
}

(SUCCESS, NOT verified): {
  - Leave blind ACTIVE (page may still display the value)
  - step_results[secret] = { ok: false, ref: capturedRef, error_code: "bootstrap_capture_cleanup_failed" }
    // ok: false + ref preserved → R5 retry skips re-capture, resumes destinations after manual blind end
  - audit: blind_remained_active { reason: "bootstrap_capture_cleanup_failed", subject_secret, batch_id, target_id }
  - Executor STOPS (next step can't start blind). Batch transitions to failed_partial.
  - next_action: "Verify the capture browser tab is closed, then run `secret-shuttle blind end`. Then `bootstrap --continue --batch <id>` to resume destinations."
}

(FAILURE skip/timeout/abort/redirect, verified): {
  - services.blind.end() automatically (no secret captured, no reason to hold)
  - step_results[secret] = { ok: false, error_code: <failure_reason> }
  - Continue to next plan entry (R5 retry handles re-attempt or skip)
}

(FAILURE, NOT verified): {
  - Leave blind ACTIVE (dev MAY have revealed before failure)
  - step_results[secret] = { ok: false, error_code: "bootstrap_capture_cleanup_failed" }
  - Executor STOPS. Same manual recovery as above.
}
```

### Allowed domains for captured secrets

When `vault.upsertSecret` is called for a captured bootstrap secret:
- `allowedDomains = entry.destinations.map(d => d.domain)` — destination provider hosts (matching generate-source semantics)
- `captured_from_host` (the capture URL's host) recorded in audit ONLY, NOT in allowedDomains

Rationale: the captured Stripe webhook secret will be pushed to vercel.com, github.com, etc. — those domains need to be in allowedDomains for the destination push to work. The capture URL host (dashboard.stripe.com) is not a destination, so adding it would be misleading.

### Browser auto-start integration

`bootstrap --continue` (or `/plan` dev-synth path) calls:

```ts
if (state.plan.some(e => e.source.kind === "capture")) {
  await services.ensureBootstrapBrowser(batchId);
}
try {
  await executeBatch(...);
} finally {
  if (state.plan.some(e => e.source.kind === "capture")) {
    await services.stopBootstrapBrowser(batchId);  // no-op if owner is "user"
  }
  bootstrapStore.releaseExecutionLock(batchId);
}
```

The auto-stop runs in the finally → fires on all paths including the cleanup-failed-stops case. If the user's session was pre-existing, stop is a no-op.

### Error codes (5p)

- `bootstrap_capture_url_invalid` — yml-parse-time rejection (https/creds/loopback/IP)
- `bootstrap_capture_skipped` — dev clicked skip in hub
- `bootstrap_capture_timeout` — 5min elapsed, no capture
- `bootstrap_capture_aborted` — dev abandoned OR browser tab closed before capture
- `bootstrap_capture_redirect_blocked` — final URL host ≠ yml expected_host
- `bootstrap_capture_cleanup_failed` — blank/close verification failed (manual blind end required)

Reuses existing `blind_mode_already_active`.

### Tests

- Yml URL validation: https rejection, creds rejection, loopback rejection, IPv4/IPv6 literal rejection, expected_host extraction
- Executor capture branch: mocked browser + pending registry; success path + skip + timeout + abort + redirect + cleanup-failed
- Per-step routes (tokenized raw routes): valid token + invalid token + expired token + cross-batch token-reuse rejection
- Hub UI render of capture-step card (drift-guard test in `ui-html-drift.test.ts` or equivalent)
- BrowserSession owner tracking: pre-existing user session preserved on bootstrap stop; bootstrap-owned session torn down
- Blind state machine: pre-flight guard fires in /continue and /plan capture-conditional; per-step defensive re-check fires under race; auto-resume only on verified blank+close
- R5 retry integration: cleanup-failed step ({ok:false, ref}) → next --continue after manual blind end skips re-capture, resumes destinations
- End-to-end: dev approves bootstrap with 2 capture sources → walks both captures → destinations push → done; with mocked dev clicks (Capture/Skip)

---

## §4 — Cross-section integration

### Bootstrap binding owner

Bootstrap approvals get `owner_agent_id` like all other approvals (§1). The R10/R12/R13 production-class gate is orthogonal — it controls WHETHER an approval is required, not WHO it's owned by.

A multi-agent setup: agent A mints a bootstrap binding. Only agent A (or root) can `/continue` it. Audit reflects both agents in `actor_agent_id` chains.

### Capture flow inherits per-agent owner enforcement

- `pendingCaptures` registry entries include the agent_id that registered them (via the ALS context at executor entry)
- Capture-step / skip / abandon routes verify the calling agent (token bearer) matches the pending entry's agent_id, OR the caller is root
- A different agent cannot resolve another agent's pending capture, even with the capture_token (unless they're root)

This is a defense-in-depth layer above the capture_token's own scope.

### Memory hygiene applies to capture path too

The captured value:
- Lives as a Buffer in `captureFromTarget`'s return (CDP gives bytes)
- Passed to `vault.upsertSecret({ ..., value })` — value Buffer is consumed, encrypted via AEAD, stored as ciphertext blob
- Master-key copy used during the encrypt is scrubbed per §2
- The captured-value Buffer SHOULD be scrubbed after upsertSecret returns

Add to §2 scope: capture-result Buffer scrub at the executor's runSourceStep.

### bootstrap_batch_busy semantics extend

R11's per-batch execution lock interacts with §3's pending captures: if a /continue is already mid-capture (lock held, dev hasn't clicked yet), a second /continue gets `bootstrap_batch_busy` (existing). The second call does NOT enter capture-step coordination — it just rejects fast.

---

## §5 — Scope cuts & follow-up plans

### Scope-cut from Burst 4

- **5l (template argv stability auto-check):** CI job that pins expected argv shapes against current provider CLI `--help`. Important hygiene but not magic-breaking. Separate post-launch plan.
- **5q (Vault value-Buffer end-to-end):** Refactor `Secret.value: string → Buffer` across vault/routes/templates. Required for enterprise audit; deferred to post-launch.
- **Per-agent token denylist + expiry:** Mentioned in alternate B option during brainstorm. v1 ships with rotate-only revocation; per-agent denylist deferred.

### Named follow-up plans (referenced in this spec)

- `5l — template argv stability auto-check`
- `5q — Vault value-Buffer end-to-end (enterprise-readiness)`
- `5r — Per-agent token denylist + expiry` (if/when revocation granularity becomes a real need)

---

## §6 — Implementation order

Suggested task ordering for the writing-plans phase. Each phase is independently testable.

### Phase A — Per-agent token foundation (5m)
1. Persistent root_token under `<SHUTTLE_HOME>/root-token`; daemon read/write at startup; 0600 enforcement.
2. Token validation: parse+verify HMAC in `DaemonServer.handle()`; AsyncLocalStorage `AuthContext`.
3. Centralized `resolveDaemonToken` helper; migrate `daemon-client.ts` and `streaming-request.ts`.
4. `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN` fail-closed.
5. Audit policy: `getAuditActor()` helper; thread `actor_agent_id` through audit emissions.
6. Owner enforcement: add `owner_agent_id` to ApprovalGrant + SessionGrant; gate at `validateConsumeBatch`; `approval_not_found` for non-root.
7. Mint endpoint: `/v1/tokens/mint` with namespace restriction.
8. `daemon rotate`: hot-swap + atomic file rewrite.
9. Init: `agent_id` derivation; per-runtime config writes (claude-code, cursor); manual instructions for codex/copilot.
10. Tests: token parse/validation, ALS propagation, owner enforcement at preflight, mint namespace, rotate invalidation.

### Phase B — Memory hygiene (5o-core)
1. Audit `requireKey()` callers; wrap each in try/finally with `.fill(0)`; ensure no key held across async continuation.
2. Masker: scrub `patterns[]` AND `lookback` on dispose/flush.
3. Child stdin: zero in write callback, with close/error fallback.
4. Capture-result Buffer scrub (after `vault.upsertSecret` returns).
5. Tests: Buffer-spy assertions; masker integration; stdin scrub timing.
6. SKILL.md docs: "Memory hygiene (best-effort)" section.

### Phase C — Capture-from-URL (5p)
1. Yml validation extension for `kind: capture` (https / creds / loopback / IP); `expected_host` field.
2. `BrowserSession` object refactor; `services.browserSession` migration; `CdpClient.close()`.
3. `BrowserOps`: `openCaptureTarget`, `captureFromTarget`, `blankTarget`, `closeTarget`, `getTargetURL`, `listTargets`.
4. `ensureBootstrapBrowser` / `stopBootstrapBrowser` with owner tracking.
5. Pending-capture registry on BootstrapStore.
6. Tokenized raw UI routes: capture-step / skip-step / abandon.
7. Hub SSE event type `bootstrap_capture_step`; hub-ui.html capture-step coordinator card render.
8. Executor's capture branch: full state machine (pre-flight blind, register, await, capture, cleanup, verify, auto-resume or stay-blind).
9. `/v1/bootstrap/plan` and `/v1/bootstrap/continue` blind guards (capture-conditional, computed-plan based).
10. CLI `bootstrap --continue` browser auto-start/stop hook.
11. New error codes wired into `error-codes.ts` with hint/nextAction.
12. Tests: end-to-end with mocked browser + mocked dev clicks; redirect-blocked; cleanup-failed → retry path; per-step token security; multi-step batches.

### Phase D — Cross-section integration + docs
1. Bootstrap binding stamps `owner_agent_id`.
2. Capture pending registry inherits `owner_agent_id`; resolve/skip/abandon routes verify caller match (or root).
3. SKILL.md updates: per-agent token model, blind-mode discipline for bootstrap captures, memory hygiene framing.
4. CHANGELOG entry: 5m + 5o-core + 5p covered, 5l/5q/5r named as follow-ups.
5. Final full-suite verification.

---

## §7 — Testing strategy

### Unit tests
- HMAC token derivation correctness (test vectors)
- `validateConsumeBatch` rejects cross-owner before any state mutation
- Yml URL validation matrix (https/http/file/javascript/creds/loopback/IPv4/IPv6/valid)
- Masker pattern + lookback scrub on dispose
- BrowserSession owner tracking (pre-existing user session preserved)

### Integration tests
- ALS audit propagation: agent token bearer → `actor_agent_id` in every audit record on a /v1/* roundtrip
- Sub-agent mint hierarchy: parent mints child, child cannot mint sibling
- `daemon rotate` invalidation: pre-rotate token rejected, post-rotate root token accepted, derived tokens invalid until re-init
- Capture flow happy path: yml → /plan → approval → /continue → capture step (mocked browser) → destination push → done
- Capture cleanup-failed path: ok:false+ref preserved → retry after blind end skips re-capture, runs destinations

### End-to-end tests
- Multi-agent: agent A mints bootstrap; agent B (different agent_id) attempts /continue → `approval_not_found` (existence-non-disclosure)
- Init: starts daemon, mints per-agent tokens for claude-code + cursor configs, prints manual instructions for codex
- Bootstrap with 2 capture sources + 1 destination per: mocked dev clicks → done; verify allowedDomains on each captured secret matches destination domains

### Drift-guards
- Hub UI capture-step coordinator card render (assert structure: secret name + URL + Capture/Skip/Abandon buttons)
- SKILL.md threat model section presence (memory hygiene best-effort, per-agent token attribution-not-isolation)

---

## §8 — Risk register

| Risk | Mitigation |
|---|---|
| Hot-swap rotate races with in-flight request | JS single-threaded; `this.token` assignment is atomic. In-flight requests use the value they read at handle-entry; ALS doesn't propagate token bytes after the auth check. |
| Per-agent token in runtime config gets committed to git | Init writes to user-private config paths only; documented allowlist. Detected in tests via grep against repo-tracked files. |
| Capture browser auto-stops while another flow uses it | Owner check: stop is a no-op when owner is "user"; only bootstrap-owned sessions get torn down. |
| Per-step capture_token leaks via hub SSE | SSE is loopback-only (127.0.0.1 bind); hub UI's SSE listener is same-origin; tokens are single-use, scoped, expire on step resolve. |
| Multi-step capture batch with intervening blind operation (e.g., user does inject between captures) | Per-step defensive blind guard fires → step fails with `blind_mode_already_active` → batch transitions to failed_partial; user resolves, retries via R5 idempotent re-run. |
| Daemon crash mid-capture (target_id orphaned) | On restart: no pending registry entries; status remains `in_progress` on disk. R7 + R11 allow `/continue` to re-enter; the orphaned target_id is cleaned up by re-running capture step (browser auto-start spawns a fresh browser since `services.browserSession === null` after crash). |

---

## §9 — Out of scope

- Capability-based per-agent tokens (operation allowlist) — too complex for v1
- SO_PEERCRED-based caller identification — Unix-only, brittle
- Cross-daemon coordination (multiple daemons on one machine) — not in product
- Approval delegation between agents — out of scope
- Time-bound token expiry — deferred to 5r
- Per-agent token denylist — deferred to 5r
- Vault value-Buffer end-to-end — deferred to 5q
- Template argv stability auto-check — deferred to 5l

---

## §10 — Success criteria

Burst 4 ships when:

1. A compromised agent process token does NOT grant access to another agent's secrets, approvals, or sessions (proven via integration test: agent A creates session/approval; agent B's token gets `approval_not_found`).
2. Master-key copies are scrubbed before any async continuation at the four named callsites; masker patterns/lookback scrubbed on stream dispose.
3. `bootstrap` with a yml containing `source: { kind: capture, url: "https://..." }` for a real provider (Stripe / Supabase / etc.) drives the dev through a clean capture flow, persists the captured value, runs destinations, and ends with all CDP observation safely resumed — under a single approval.
4. SKILL.md documents the per-agent token model (attribution + hygiene boundary), the memory-hygiene best-effort framing, and the capture-from-URL flow.
5. All existing R1-R15 invariants still hold; full test suite green.

---

*End of spec.*
