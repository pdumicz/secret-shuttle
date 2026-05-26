# Burst 4 — Pre-Launch Security Hardening (5m + 5o-core + 5p)

**Date:** 2026-05-26 (revised after spec review)

**Goal:** Close three pre-launch gaps in one coherent spec — per-agent token isolation, in-flight memory hygiene, and capture-from-provider-URL in bootstrap — so Secret Shuttle's v1 launch claim ("AI agents provision your entire project's secrets across providers without ever seeing them, one click of approval per batch") holds up.

**Audience:** Vibe coders + dev teams. NOT enterprise-audit (Option C / 5q is the post-launch plan for that).

**Tech stack:** TypeScript strict ESM, Node 20+, AES-256-GCM for vault, Chrome CDP for browser, HMAC-SHA256 for token derivation, AsyncLocalStorage for request context propagation.

---

## §0 Cross-section context

This spec extends three independent subsystems. They share three integration points worth naming up front:

1. **The bootstrap-authority bypass** (Plan 5g, fortified by R10/R12/R13/R7/R11). When `executeBatch` runs inner cores under `bootstrapAuthority`, it skips the inner `requireApprovals` call. The outer bootstrap binding is the only human-approval gate for the entire batch. Per-agent tokens (§1) and capture flow (§3) both interact with this contract.

2. **The blind-mode discipline** (Plan 4-era inject + reveal-capture). CDP observation is severed while the daemon manipulates sensitive page state. Capture-from-URL (§3) inherits the discipline, extends it for multi-step batches, AND hardens `blind.start()` to fail-throw on already-active state.

3. **The audit pipeline** (Plan 4d's `next_action` infrastructure + R9's destination detail). Per-agent tokens (§1) thread agent_id through every audit record; memory hygiene (§2) does not produce new audit events but documents which paths are touched.

Plan 5g's bootstrap fixes (R1–R15) are assumed in place: idempotent retry, per-batch lock, three-gate production approval, ref canonicalization, yml validation.

---

## §1 — Per-agent token isolation (5m)

### Threat model — what this gives you, what it does not

Per-agent tokens are **attribution + hygiene** against same-user processes that do NOT have broad filesystem access. They are NOT hard isolation against a fully-privileged same-user attacker who can read `<SHUTTLE_HOME>/root-token` or arbitrary daemon process memory.

This boundary is OS-account-scoped. Hard isolation requires OS sandboxing (containers, AppArmor, Bubblewrap) — out of scope for v1. Documented prominently in SKILL.md so operators don't assume a stronger guarantee.

What per-agent tokens DO provide:
- **Audit attribution:** every daemon call records which agent did what (`actor_agent_id` stamped via AsyncLocalStorage)
- **Compromise hygiene:** a non-shell-capable agent process cannot read the socket file → cannot impersonate root or another agent
- **Owner-enforced approval / session / batch consumption:** an agent cannot spend another agent's approval grant, session, or bootstrap batch
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

### agent_id structure — global per (machine, runtime), NOT per-cwd

The runtime detector (`src/cli/agent-runtime-detect.ts:4`) returns runtimes as `AgentRuntime = "claude" | "codex" | "cursor" | "copilot"`. (Note: it is `claude`, not `claude-code` — the earlier draft of this spec was wrong.)

Auto-installed agent_id for global-config runtimes is derived as:

```
<runtime>-<16_hex_of_SHA256(machine_id ‖ runtime)>
```

Examples:
- `claude-7f2a1b8c2d4e3f5a`
- `cursor-9c4d8e2a1b6f3a5d`

**No cwd in the derivation.** This is intentional:

- Claude / Cursor settings.json files are **global** per machine (`~/.claude/settings.json`, etc.)
- If `agent_id` were per-cwd, every `init` from a new project would compute a different agent_id and overwrite the previous one in the global config — stranding the previous project's agent
- Deterministic per-machine derivation means re-running `init` from any project for the same runtime produces the same token, so the global config is stable

**Trade-off:** all of a user's projects share the same daemon-perspective identity per (machine, runtime). Audit shows "claude-7f2a... did this" regardless of which project. Per-project attribution is deferred to a future plan (see §5).

Users who want per-project granularity can manually set `SECRET_SHUTTLE_AGENT_TOKEN` in a project's shell rc with a custom `agent_id`. Init's manual-install bucket supports this path with copy-paste instructions.

The `agent_id` regex still permits dots for hierarchy in mint-time child IDs (e.g., `claude-7f2a.helper-3a1b`), so the namespace restriction in `/v1/tokens/mint` continues to work as designed.

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

Failure cases all return 401 with code `unauthorized` (uniform; no information leak about which part failed).

### Audit policy — per-emission-site, not blanket ALS

| Audit emission site | Source of `actor_agent_id` |
|---|---|
| Standard auth-gated routes (most of `/v1/*`) | `als.getStore().agent_id` |
| Raw UI route (approval click, hub broker, capture-step) | persisted owner of the entity being acted upon (`approvalGrant.owner_agent_id` / `pendingCapture.owner_agent_id`) |
| Lifecycle (daemon start, lock, shutdown) | Literal `"daemon"` — no request context exists |
| Bootstrap executor steps | inherit from the call that registered the work (the `/continue` ALS context) |

Central helper `getAuditActor(emissionSite, context)` resolves the right source.

### Owner enforcement — threaded through ALL of requireApprovals

Owner enforcement is NOT confined to `validateConsumeBatch`. It is threaded through every step of `requireApprovals` so the response is indistinguishable from "doesn't exist" to non-root callers at every observation point:

| `requireApprovals` step | Owner check applied |
|---|---|
| Step 0: parse + lookup supplied approval IDs | For each supplied ID, fetch grant; if `owner_agent_id !== caller_agent_id` AND caller is not root → return `approval_not_found` (DO NOT proceed to binding compare) |
| Step 1: match supplied IDs against bindings | Already filtered by Step 0 |
| Leftover handling: session-candidate evaluation | Session candidate's `owner_agent_id` must match caller (or caller is root); otherwise treat as no session match |
| `validateConsumeBatch` | Re-check owner on every grant + session about to be consumed; reject same as Step 0 if mismatch |
| Final `consume` / `consumeBatch` | Defensive re-check (belt-and-suspenders); reject if anything slipped through |

For non-root callers, every owner mismatch returns `approval_not_found`. No existence / status / match-result information leak.

For root callers, owner mismatch returns `approval_owner_mismatch` (root has enumeration privileges anyway, and explicit code aids admin debugging).

Audit on owner-mismatch failures records both `actor_agent_id` (the failing caller) and `subject_agent_id` (the grant's real owner).

### Schema additions

`ApprovalGrant.owner_agent_id: string` — stamped at mint from ALS, or `"root"`.
`SessionGrant.owner_agent_id: string` — same.
`BatchState.owner_agent_id: string` — stamped at `/v1/bootstrap/plan`, defaults to caller's agent_id (or `"root"`).

### Bootstrap batch ownership enforcement

`BatchState.owner_agent_id` is set at `/v1/bootstrap/plan` from the ALS context. It is enforced on every subsequent bootstrap route:

| Route | Enforcement |
|---|---|
| `POST /v1/bootstrap/plan` | Sets `owner_agent_id` from caller |
| `POST /v1/bootstrap/continue` | Reject with `bootstrap_batch_not_found` if `state.owner_agent_id !== caller_agent_id` AND caller is not root (BEFORE blind guard or approval consume; existence non-disclosure) |
| `POST /v1/bootstrap/abandon` | Same |
| `GET /v1/bootstrap/list` | Non-root callers see only batches where `owner_agent_id === caller_agent_id`; root sees all |
| Capture-step / skip / abandon raw UI routes | Pending capture entry carries `owner_agent_id` (inherited from BatchState at registration); raw routes are token-only (see §3 capture UI auth model) but `owner_agent_id` is stamped into audit |
| Crash recovery on daemon restart | BatchState's `owner_agent_id` is preserved on disk; same enforcement applies after restart |

Without batch ownership, R7's "skip approval consume for in_progress / failed_partial" would let any agent who knows a `batch_id` resume a batch owned by another agent — bypassing the approval owner enforcement entirely.

### Sub-agent mint with namespace restriction

`POST /v1/tokens/mint { agent_id: "<requested>" }`:

```
caller_id = als.getStore().agent_id
if caller is root: allow any well-formed agent_id (admin/initial mint)
else:
  requested_agent_id MUST start with `${caller_id}.` (literal prefix)
  → caller "claude-7f2a" can mint "claude-7f2a.helper-3a1b"
  → caller "claude-7f2a" CANNOT mint "cursor-..." (no prefix match)
  → caller "claude-7f2a" CANNOT mint "claude-7f2a" (no extension)

Returns: { token: "<id>.<hmac>", agent_id: "<id>" }
Audit: tokens_mint { actor_agent_id: caller_id, child_agent_id: requested_agent_id }
```

Stateless. No persistence. The hierarchy is structurally enforced by the prefix rule.

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

After rotation:
- Requests with OLD root_token → 401
- Requests with derived agent tokens from OLD root → 401 (HMAC mismatch)
- Shell CLI re-reads socket file on next call → picks up new root automatically
- Agent processes still hold OLD `SECRET_SHUTTLE_AGENT_TOKEN` → next call fails → user re-runs `init`

CLI: `secret-shuttle daemon rotate` (root-shell only).

### Init: honest scope for runtime token installation

`detectAgentRuntimes` returns runtimes ∈ `{ claude, codex, cursor, copilot }`. Bucketing:

**Concrete-config bucket** (init writes per-agent env vars):
- `claude` → write to `~/.claude/settings.json` env block
- `cursor` → write to `~/.config/Cursor/User/settings.json` env block (platform-specific paths)

For these, init writes BOTH:
- `SECRET_SHUTTLE_AGENT_TOKEN=<derived-token>` (where `agent_id` is global-per-(machine,runtime), see derivation above)
- `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1`

NEVER in: repo-committed files (AGENTS.md, .cursorrules, .claude/skills/*.md). User-private config only.

**Manual-install bucket** (init prints copy-paste instructions; does NOT claim "configured"):
- `codex` (OpenAI Codex CLI)
- `copilot`

For each, init emits:

```
For codex: add the following to your shell rc and restart codex:
  export SECRET_SHUTTLE_AGENT_TOKEN=<token>
  export SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1
```

The manual path also lets users opt-in to per-project agent_ids by editing the token with a project-specific suffix.

`init` summary distinguishes:
```json
{
  "agent_runtimes_configured": ["claude"],
  "agent_runtimes_pending_manual": ["codex"],
  "next_actions": [
    "For codex: export SECRET_SHUTTLE_AGENT_TOKEN=... in your shell rc"
  ]
}
```

### Audit field naming

Distinct field names:
- `actor_agent_id` — who performed the action
- `subject_agent_id` — for sessions / grants / batches: the owner being acted upon
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
- **Captured-value string returned by `CaptureResult.value`** — current CDP CaptureResult returns `string`, not Buffer. Promoting to Buffer requires the same wider refactor as `Secret.value`. Same residue class; deferred to 5q.

### Tests

- Wrapper/spy on Buffer verifies every `requireKey()` callsite reaches `.fill(0)` in its finally block
- Masker integration test: assert `patterns[]` AND `lookback` are zeroed after dispose
- Stdin scrub timing test: Buffer is non-zero before write callback, zero only after — never both states observed in wrong order

### Docs

New SKILL.md / threat-model section: "Memory hygiene (best-effort)":

> The master key is zeroed on lock and on every in-flight crypto operation; copies are scrubbed synchronously before any async continuation. Byte buffers built for child-process stdin and tmp env-file writes are scrubbed after the consumer reads them. Masker pattern and lookback buffers are scrubbed on stream dispose.
>
> Secret values returned by the vault (`vault.getSecret(ref).value`) AND captured values from the browser (`CaptureResult.value`) are JS strings, which V8 does not let us proactively zero — they linger in heap until garbage collection. A post-launch hardening plan (5q) refactors both to `Buffer` for end-to-end scrub; required for security-audit deployments.

### Named follow-up plan

`5q — Vault and capture value-Buffer end-to-end (enterprise-readiness)`: refactors BOTH `Secret.value` AND `CaptureResult.value` from `string → Buffer` across vault / routes / browser / templates. Required for SOC-grade audits. Separate brainstorm + plan.

---

## §3 — Capture-from-URL in bootstrap (5p)

### Goal

Promote `source: { kind: capture, url: "https://..." }` from "rejected at /plan time" to a real, orchestrated flow. The agent declares URLs; the daemon drives the browser to each URL and captures the value the dev reveals — all under a single bootstrap approval, with blind-mode discipline matching existing reveal-capture semantics.

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
import { isIP } from "node:net";

const u = new URL(rawUrl); // throws on malformed → bootstrap_capture_url_invalid
if (u.protocol !== "https:") fail("capture url must be https");
if (u.username || u.password) fail("capture url must not embed credentials");

// Hostname normalization + comprehensive IP/loopback rejection.
let host = u.hostname.toLowerCase();
// Strip trailing dot and bracket-stripped IPv6 form for net.isIP():
const hostStripped = host.endsWith(".") ? host.slice(0, -1) : host;
const hostForIpCheck = hostStripped.startsWith("[") && hostStripped.endsWith("]")
  ? hostStripped.slice(1, -1)
  : hostStripped;

if (isIP(hostForIpCheck) !== 0) fail("capture url must not target an IP literal");
if (hostStripped === "localhost" || hostStripped.endsWith(".localhost")) {
  fail("capture url must not target localhost");
}

return {
  kind: "capture",
  url: rawUrl,
  expected_host: hostStripped, // canonical, lowercased, dot-stripped
};
```

NO trusted-domain allowlist. The approval card surfaces the full URL to the dev — that's the human-policy gate.

`BootstrapSource` for `kind: "capture"` gains `expected_host: string` (persisted in `BatchState.plan`).

### Capture ALWAYS requires approval

Plan 5g's R10/R12/R13 gate is augmented with a fourth condition:

```
requiresProductionGate =
  canonicalEnvironment(environment) === "production" ||  // R12
  planHasProductionDestination(plan) ||                  // R10
  planHasProductionSource(plan) ||                       // R13
  plan.some(e => e.source.kind === "capture");           // 5p NEW
```

**Rationale:** capture requires the hub UI for the dev to click Capture / Skip / Abandon per step. The dev-synth path (where `/plan` executes inline without opening any approval UI) has no hub URL emitted → no coordinator can render → the executor would hang awaiting an action that has no surface to land on.

Forcing an approval for any capture plan guarantees the hub URL is emitted, the dev navigates to it, sees the approval card, clicks Approve → the hub UI is now loaded and ready to render the capture coordinator when `/continue` runs.

This is a behavior change for users who would have had pure-dev capture plans (dev environment + dev destinations + capture source). They now click one approval. The trade-off is the only sound flow: there's no way to coordinate human interaction without a UI surface.

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

`CdpClient.close()` is added (clean single-chokepoint shutdown).

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

async stopBootstrapBrowser(batchId: string): Promise<{ stopped: boolean }> {
  const s = services.browserSession;
  if (s?.owner.kind !== "bootstrap" || s.owner.batchId !== batchId) {
    return { stopped: false }; // not ours
  }
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
  return { stopped: true };
}
```

### Bind capture to a specific target

New daemon-only `BrowserOps` methods (NOT exposed via `/v1/browser/*`):

```ts
openCaptureTarget(url: string): Promise<{ target_id: string; current_host: string }>
captureFromTarget(
  target_id: string,
  mode: "focused-field" | "selection",
  expected_host: string,  // verified at capture-time, NOT at open-time
): Promise<CaptureResult>
blankTarget(target_id: string): Promise<void>     // navigate to about:blank
closeTarget(target_id: string): Promise<void>
getTargetURL(target_id: string): Promise<string>
listTargets(): Promise<Array<{ target_id: string; url: string }>>
```

**Host verification is at-capture-time only.** Provider login flows (SSO redirects to identity providers, Okta, Auth0, GitHub OAuth) commonly land on a non-target host before the user authenticates and reaches the final page. Blocking at open-time would break these flows.

`captureFromTarget` re-verifies host at the moment of capture:
- Reads target's CURRENT top-level URL via `getTargetURL`
- Compares `new URL(currentUrl).hostname` (normalized same way as `expected_host`) against the supplied `expected_host`
- Rejects with `bootstrap_capture_redirect_blocked` on mismatch

If the dev clicks Capture while still on an SSO page, they get a clear error and can navigate to the right page before clicking Capture again.

### Pre-flight blind guard — capture-conditional, both entry points

`DaemonBlindModeState.start()` is hardened to **throw** `blind_mode_already_active` if blind is already active, rather than silently overwriting (current behavior at `src/daemon/services-blind.ts:14`). All call sites must check first OR rely on the throw to surface the conflict.

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
if (plan.some(e => e.source.kind === "capture")) {
  await assertBlindInactiveForBootstrap(services);
}

// Build approval binding (capture-always-requires-approval gate handled in R10/R12/R13 augmentation)
// Save batch state with owner_agent_id = caller (from ALS)
// requireApprovals — for capture plans this ALWAYS throws approval_required
```

Because capture always requires approval, the dev-synth inline-execute branch is unreachable for any capture-containing plan. /plan always throws approval_required for capture batches.

`/v1/bootstrap/continue`:
```ts
const state = await services.bootstrapStore.get(batchId);
if (state === null) throw bootstrap_batch_not_found;

// Owner check FIRST — existence non-disclosure
if (state.owner_agent_id !== caller_agent_id && !caller_is_root) {
  throw bootstrap_batch_not_found;
}

if (state.status === "completed" || state.status === "abandoned") {
  return cached_or_throw_already_abandoned;
}

// Capture-conditional blind guard — BEFORE approval consume
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
1. Assert services.blind.current() === null (defensive; race protection — but blind.start() also throws now)
2. services.blind.start(entry.source.expected_host, "bootstrap-capture")   // throws if active
3. await disableObservationDomains(services.browserSession.cdp).catch(()=>undefined)
4. services.browserSession.proxy?.severAgentConnections()
5. const target = await browser.openCaptureTarget(entry.source.url)
   // NOTE: no post-load host check here — allow auth redirects
6. capture_token = randomBytes(32).base64url
   Register pendingCaptures.set(key, {
     resolve, reject,
     capture_token,
     target_id: target.target_id,
     expected_host: entry.source.expected_host,
     owner_agent_id: state.owner_agent_id,
     started_at,
     timer,
   })
7. Send hub SSE event:
   { type: "bootstrap_capture_step", batch_id, secret_name, url, step_idx, step_total, capture_token }
8. await new Promise((resolve, reject) => { /* timer set to 5min → reject(bootstrap_capture_timeout) */ })
9. On resolve (dev clicked Capture in hub):
      capture_result = await browser.captureFromTarget(target.target_id, mode, entry.source.expected_host)
      // captureFromTarget enforces host match at THIS moment
      vault.upsertSecret({ name, environment, source, value: capture_result.value, allowedDomains: entry.destinations.map(d => d.domain) })
      // captured_from_host recorded in audit (host AT capture time, which matches expected_host by precondition)
      Proceed to cleanup (success branch)
10. On reject (skip / timeout / abort / redirect): proceed to cleanup (failure branch)
```

### Capture UI auth — capture_token only (no bearer)

Hub UI POSTs to URL-tokenized raw routes (matching existing approval-click and hub-broker pattern):

- `POST /ui/bootstrap/capture-step?token=<capture_token>` — capture now
- `POST /ui/bootstrap/skip-step?token=<capture_token>` — skip this secret
- `POST /ui/bootstrap/abandon?token=<capture_token>` — abandon entire batch

**Auth model: capture_token only.** Browser hub UI does NOT send a bearer / agent token. Reasoning:

- Exposing the agent token to browser JS is a foot-gun (XSS / extension exfiltration risk)
- The capture_token is single-use, scoped to a specific (batch_id, secret_name, target_id), expires when the step resolves
- Possession of the capture_token proves the holder loaded the hub UI (which was opened via the approval URL, gated on the agent's owner_agent_id match at approval mint)

**The owner_agent_id stamped on the pending entry is for AUDIT and `/list` filtering, NOT route auth.** The route trusts the capture_token entirely. Each route resolves/rejects the pending Promise; audit records `actor_agent_id = pendingCapture.owner_agent_id` (the agent that originated the bootstrap, not the browser).

Each route:
- Looks up pending entry by token
- Validates token matches active step's `(batch_id, secret_name)`
- Calls the appropriate resolve/reject on the pending Promise
- Single-use: token invalidated after step resolves
- Audit emits with the stamped `actor_agent_id` (NOT "browser" or "anonymous")

### Pending-capture registry

```ts
// Field on BootstrapStore (or sibling helper class):
private readonly pendingCaptures = new Map<string, {  // key: `${batchId}:${secretName}`
  resolve: (capture: CaptureResult) => void;
  reject: (err: ShuttleError) => void;
  capture_token: string;
  target_id: string;
  expected_host: string;
  owner_agent_id: string;
  started_at: number;
  timer: NodeJS.Timeout;
}>();
```

Cleanup on resolve/reject: `clearTimeout(timer)`, `pendingCaptures.delete(key)`.

### `BatchState.status` enum — adds `abandoned`

Pre-Burst-4 enum: `pending | in_progress | completed | failed_partial`.
Burst 4 enum: `pending | in_progress | completed | failed_partial | abandoned`.

`abandoned` is **terminal**. `/continue` on an abandoned batch returns `bootstrap_batch_abandoned` (new error code; non-recoverable from the batch_id alone — user must re-run `/plan` to create a fresh batch).

### Post-step cleanup state machine — refined

The failure branch separates `abort` from the other failure modes:

```
On step terminal (success OR failure):

1. browser.blankTarget(target_id)     // page → about:blank
2. Verify blank: re-read URL via browser.getTargetURL(target_id)
   Cleanup verified iff: URL is "about:blank" OR target_id not in listTargets()
3. browser.closeTarget(target_id)     // close the tab
4. Verify close: re-read listTargets(). target_id absent → close verified

Branch on (step outcome, cleanup verified):

(SUCCESS, verified): {
  - services.blind.end() automatically
  - audit: blind_auto_resume { reason: "bootstrap_capture_verified_clean", subject_secret, batch_id }
  - step_results[secret] = { ok: true, ref: capturedRef }
  - Continue to next plan entry
}

(SUCCESS, NOT verified): {
  - Leave blind ACTIVE (page may still display the value)
  - step_results[secret] = { ok: false, ref: capturedRef, error_code: "bootstrap_capture_cleanup_failed" }
    // ok: false + ref preserved → R5 retry skips re-capture, resumes destinations after manual blind end
  - audit: blind_remained_active { reason: "bootstrap_capture_cleanup_failed", subject_secret, batch_id, target_id }
  - Executor STOPS. Batch transitions to failed_partial.
  - Goes to outer finally → stopBootstrapBrowser → if Chrome dies, blind auto-ends (see below)
}

(FAILURE skip/timeout/redirect, verified): {
  - services.blind.end() automatically (no secret captured)
  - step_results[secret] = { ok: false, error_code: <failure_reason> }
  - Continue to next plan entry (R5 retry handles re-attempt or skip)
}

(FAILURE abort, verified): {
  - services.blind.end() automatically
  - step_results[secret] = { ok: false, error_code: "bootstrap_capture_aborted" }
  - Set state.status = "abandoned"
  - Executor STOPS (user explicitly chose to abandon)
  - Goes to outer finally → stopBootstrapBrowser
}

(FAILURE any, NOT verified): {
  - Leave blind ACTIVE (dev may have revealed before failure)
  - step_results[secret] = { ok: false, error_code: "bootstrap_capture_cleanup_failed" }
  - If failure was abort: state.status = "abandoned"
  - Executor STOPS
  - Goes to outer finally → stopBootstrapBrowser → if Chrome dies, blind auto-ends
}
```

### Outer finally — Chrome stop + blind auto-resume after browser death

After the executor loop exits (success, failed_partial, abandoned, or any uncaught throw), the route's finally runs:

```ts
finally {
  services.bootstrapStore.releaseExecutionLock(batchId);

  if (state.plan.some(e => e.source.kind === "capture")) {
    const { stopped } = await services.stopBootstrapBrowser(batchId);

    // If we killed bootstrap-owned Chrome AND blind is still active from a
    // cleanup-failed step, the rendering process is now dead — no CDP
    // observation is possible. Safe to auto-end blind.
    if (stopped && services.blind.current() !== null) {
      services.blind.end();
      await writeDaemonAudit({
        action: "blind_auto_resume_after_browser_stop",
        actor_agent_id: state.owner_agent_id,
        batch_id: batchId,
      });
    }
  }
  // If browser was pre-existing user session (owner: "user"), stop is no-op.
  // Blind state (if any) requires manual blind.end via existing /v1/blind/end approval flow.
}
```

This eliminates the "manual blind end required" path for the common case where bootstrap owned the browser. Manual recovery is required only when:
- The user's pre-existing browser session was reused (we don't kill it)
- AND blind was left active by cleanup-failure
- → in that case the next_action surfaces "approve blind end" via the existing flow

### Allowed domains for captured secrets

When `vault.upsertSecret` is called for a captured bootstrap secret:
- `allowedDomains = entry.destinations.map(d => d.domain)` — destination provider hosts (matching generate-source semantics)
- `captured_from_host = entry.source.expected_host` recorded in audit ONLY, NOT in allowedDomains

Rationale: the captured Stripe webhook secret will be pushed to vercel.com, github.com, etc. — those domains need to be in allowedDomains for the destination push to work. The capture URL host is not a destination.

### Browser auto-start integration

`bootstrap --continue` (only path that runs capture steps now, since dev-synth /plan always throws approval_required for capture) calls:

```ts
if (state.plan.some(e => e.source.kind === "capture")) {
  await services.ensureBootstrapBrowser(batchId);
}
try {
  await executeBatch(...);
} finally {
  // Outer finally handles stopBootstrapBrowser + blind auto-resume (above)
}
```

### Error codes (5p)

- `bootstrap_capture_url_invalid` — yml-parse-time rejection (https/creds/loopback/IP literal/localhost)
- `bootstrap_capture_skipped` — dev clicked skip in hub
- `bootstrap_capture_timeout` — 5min elapsed, no capture
- `bootstrap_capture_aborted` — dev abandoned OR browser tab closed before capture (terminal: status → abandoned)
- `bootstrap_capture_redirect_blocked` — final URL host ≠ yml expected_host AT CAPTURE TIME
- `bootstrap_capture_cleanup_failed` — blank/close verification failed (manual blind end may be required if Chrome stop also failed)
- `bootstrap_batch_abandoned` — `/continue` called on a batch in terminal `abandoned` state

Reuses existing `blind_mode_already_active`.

### Tests

- Yml URL validation matrix: https/http, creds, loopback (`localhost`, `localhost.`, `*.localhost`), IPv4 literal, IPv6 literal (bracketed and unbracketed), expected_host extraction
- `node:net.isIP()` integration: rejects `2001:db8::1`, `[::1]`, `127.0.0.1`, accepts `dashboard.stripe.com`
- Executor capture branch: mocked browser + pending registry; success path + skip + timeout + abort + redirect + cleanup-failed
- Auth-redirect-tolerance: open target on SSO host → DO NOT block; capture-time host check rejects only at capture moment
- Per-step routes (tokenized raw routes): valid token + invalid token + expired token + cross-batch token-reuse rejection; auth: routes do NOT require bearer
- Hub UI render of capture-step card (drift-guard test in `ui-html-drift.test.ts` or equivalent)
- BrowserSession owner tracking: pre-existing user session preserved on bootstrap stop; bootstrap-owned session torn down
- Blind state: `blind.start()` throws when already active; pre-flight guard fires in /continue and /plan capture-conditional; per-step defensive re-check fires under race
- Blind auto-resume after browser stop: cleanup-failed step + bootstrap-owned browser killed → blind auto-ends with audit
- R5 retry integration: cleanup-failed step ({ok:false, ref}) → next --continue after manual blind end (if needed) skips re-capture, resumes destinations
- Capture always requires approval: dev-env + dev destinations + capture source → approval_required (not dev-synth inline execute)
- Batch ownership: agent A's batch is not visible to agent B via /list, /continue, /abandon; root sees all
- End-to-end: dev approves bootstrap with 2 capture sources → walks both captures via hub coordinator → destinations push → done; with mocked dev clicks (Capture/Skip)

---

## §4 — Cross-section integration

### Bootstrap binding + batch owner

Bootstrap approvals get `owner_agent_id` like all other approvals (§1). `BatchState` ALSO gets `owner_agent_id`. The R10/R12/R13/5p production-class gate is orthogonal — it controls WHETHER an approval is required, not WHO it's owned by.

A multi-agent setup: agent A mints a bootstrap binding + batch. Only agent A (or root) can `/continue`, `/abandon`, or see in `/list`. Audit reflects both agents in `actor_agent_id` chains.

### Capture flow owner audit

- `pendingCaptures` registry entries store `owner_agent_id` (inherited from `BatchState`)
- Capture-step / skip / abandon raw UI routes do NOT verify caller identity (no bearer; capture_token only) — see §3 capture UI auth
- Audit records `actor_agent_id = pendingCapture.owner_agent_id` (the originating agent), NOT "browser" or "anonymous"

### Memory hygiene scope acknowledgement

§2 explicitly defers `CaptureResult.value` to 5q (alongside `Secret.value`). The capture flow in §3 does NOT promise scrubbed Buffer for captured values. The temporary write boundaries (stdin to AEAD encrypt, tmp env-file) are scrubbed per §2; the captured-value string lingering in heap is documented residue.

### bootstrap_batch_busy semantics extend

R11's per-batch execution lock interacts with §3's pending captures: if a `/continue` is already mid-capture (lock held, dev hasn't clicked yet), a second `/continue` gets `bootstrap_batch_busy` (existing). The second call does NOT enter capture-step coordination — it just rejects fast.

---

## §5 — Scope cuts & follow-up plans

### Scope-cut from Burst 4

- **5l (template argv stability auto-check):** CI job that pins expected argv shapes against current provider CLI `--help`. Important hygiene but not magic-breaking. Separate post-launch plan.
- **5q (Vault + capture value-Buffer end-to-end):** Refactor `Secret.value` AND `CaptureResult.value` from `string → Buffer` across vault / routes / browser / templates. Required for enterprise audit; deferred to post-launch.
- **Per-agent token denylist + expiry (5r):** Mentioned as alternate option B during brainstorm. v1 ships with rotate-only revocation; per-agent denylist deferred.
- **Per-project agent_id granularity:** Auto-installed tokens are per-(machine,runtime). Per-project attribution requires either project-private config paths or manual `SECRET_SHUTTLE_AGENT_TOKEN` opt-in. Could promote to first-class support in a future plan (5s).

### Named follow-up plans (referenced in this spec)

- `5l — template argv stability auto-check`
- `5q — Vault + capture value-Buffer end-to-end (enterprise-readiness)`
- `5r — Per-agent token denylist + expiry`
- `5s — Per-project agent_id granularity` (optional; only if real demand emerges)

---

## §6 — Implementation order

Suggested task ordering for the writing-plans phase. Each phase is independently testable.

### Phase A — Per-agent token foundation (5m)
1. Persistent root_token under `<SHUTTLE_HOME>/root-token`; daemon read/write at startup; 0600 enforcement.
2. Token validation: parse+verify HMAC in `DaemonServer.handle()`; AsyncLocalStorage `AuthContext`.
3. Centralized `resolveDaemonToken` helper; migrate `daemon-client.ts` and `streaming-request.ts`.
4. `SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN` fail-closed.
5. Audit policy: `getAuditActor()` helper; thread `actor_agent_id` through audit emissions.
6. Owner enforcement at ALL stages of `requireApprovals` (Step 0 lookup, supplied-ID matching, leftover/session handling, validateConsumeBatch, final consume). Non-root → `approval_not_found`.
7. Add `owner_agent_id` to `BatchState`. Stamp at `/plan`. Enforce at `/continue`, `/abandon`, `/list` (filter), capture pending registry. Crash recovery preserves.
8. Mint endpoint: `/v1/tokens/mint` with namespace restriction.
9. `daemon rotate`: hot-swap + atomic file rewrite.
10. Init: `agent_id` derivation (per-machine-per-runtime, NO cwd); per-runtime config writes (claude, cursor); manual instructions for codex/copilot. Runtime name spelling: `claude` NOT `claude-code`.
11. Tests: token parse/validation, ALS propagation, owner enforcement at every requireApprovals step, BatchState owner across all bootstrap routes, mint namespace, rotate invalidation, init idempotency under re-runs from different cwds.

### Phase B — Memory hygiene (5o-core)
1. Audit `requireKey()` callers; wrap each in try/finally with `.fill(0)`; ensure no key held across async continuation.
2. Masker: scrub `patterns[]` AND `lookback` on dispose/flush.
3. Child stdin: zero in write callback, with close/error fallback.
4. Tests: Buffer-spy assertions; masker integration; stdin scrub timing.
5. SKILL.md docs: "Memory hygiene (best-effort)" section. Document Secret.value AND CaptureResult.value as same residue class, both deferred to 5q.

### Phase C — Capture-from-URL (5p)
1. Yml validation extension for `kind: capture` (https / creds / `node:net.isIP` for IPv4+IPv6 / localhost variants); `expected_host` field on `BootstrapSource`.
2. Capture-always-requires-approval: extend the production-gate computation in `/v1/bootstrap/plan` to include `plan.some(capture)`.
3. `BlindModeState.start()`: throw `blind_mode_already_active` if already active (hardening).
4. `BrowserSession` object refactor; `services.browserSession` migration; `CdpClient.close()`.
5. `BrowserOps`: `openCaptureTarget`, `captureFromTarget` (host check at-capture only), `blankTarget`, `closeTarget`, `getTargetURL`, `listTargets`.
6. `ensureBootstrapBrowser` / `stopBootstrapBrowser` with owner tracking (returns `{ stopped: boolean }`).
7. Add `abandoned` to `BatchState.status` enum; `bootstrap_batch_abandoned` error code.
8. Pending-capture registry on BootstrapStore with `owner_agent_id`, `expected_host`, `target_id`, `capture_token`.
9. Tokenized raw UI routes: capture-step / skip-step / abandon (no bearer auth; capture_token only).
10. Hub SSE event type `bootstrap_capture_step`; hub-ui.html capture-step coordinator card render.
11. Executor's capture branch: full state machine (pre-flight blind, register, await, capture, cleanup, verify, success/abort/skip/timeout/redirect/cleanup-failed branches).
12. `/v1/bootstrap/plan` and `/v1/bootstrap/continue` blind guards (capture-conditional, computed-plan or persisted-plan based).
13. Outer finally: `stopBootstrapBrowser` + post-Chrome-death blind auto-resume (when stopped and blind still active).
14. CLI `bootstrap --continue` browser auto-start hook.
15. New error codes wired into `error-codes.ts` with hint/nextAction.
16. Tests: end-to-end with mocked browser + mocked dev clicks; auth-redirect-tolerance; redirect-blocked at capture time; cleanup-failed → retry path; per-step token security; capture-always-requires-approval; batch ownership filtering; blind auto-resume after browser stop.

### Phase D — Cross-section integration + docs
1. Bootstrap binding stamps `owner_agent_id`.
2. Capture pending registry inherits `owner_agent_id`; audit uses it for `actor_agent_id`.
3. SKILL.md updates: per-agent token model, blind-mode discipline for bootstrap captures, memory hygiene framing (Secret.value + CaptureResult.value both deferred to 5q), batch ownership.
4. CHANGELOG entry: 5m + 5o-core + 5p covered, 5l/5q/5r/5s named as follow-ups.
5. Final full-suite verification.

---

## §7 — Testing strategy

### Unit tests
- HMAC token derivation correctness (test vectors)
- Owner enforcement rejects cross-owner at EVERY step of `requireApprovals` (Step 0, matching, leftover, final consume) — same `approval_not_found` response
- Yml URL validation matrix: https/http/file/javascript/creds/loopback variants/IPv4/IPv6 (bracketed and bare)/valid via `node:net.isIP`
- Masker pattern + lookback scrub on dispose
- BrowserSession owner tracking (pre-existing user session preserved)
- `BlindModeState.start()` throws when already active

### Integration tests
- ALS audit propagation: agent token bearer → `actor_agent_id` in every audit record on a /v1/* roundtrip
- Sub-agent mint hierarchy: parent mints child, child cannot mint sibling
- `daemon rotate` invalidation: pre-rotate token rejected, post-rotate root token accepted, derived tokens invalid until re-init
- Capture flow happy path: yml → /plan → approval → /continue → capture step (mocked browser) → destination push → done
- Capture cleanup-failed path with bootstrap-owned browser: blind active during walk → Chrome killed in finally → blind auto-resumed
- Capture cleanup-failed path with user-owned browser: blind active → user session stays → manual blind end via existing flow
- Batch ownership: agent A creates batch; agent B (different agent_id) attempts /continue/abandon/list → `bootstrap_batch_not_found` (existence non-disclosure)
- Auth-redirect-tolerance: open target lands on SSO host; capture-time host check fires only if dev clicks Capture while still on SSO

### End-to-end tests
- Multi-agent: agent A mints bootstrap; agent B attempts /continue → `bootstrap_batch_not_found`
- Init idempotency: run init from project A, then project B for the same machine → same agent_id, same token in global config, no overwrite
- Init: starts daemon, mints per-(machine,runtime) tokens for claude + cursor configs, prints manual instructions for codex
- Bootstrap with 2 capture sources + 1 destination per: dev approves (always, even for dev env) → walks captures via hub → destinations push → blind auto-resumes after browser stop

### Drift-guards
- Hub UI capture-step coordinator card render (assert structure: secret name + URL + Capture/Skip/Abandon buttons)
- SKILL.md threat model section presence (memory hygiene best-effort, per-agent token attribution-not-isolation, batch ownership, capture-always-requires-approval)

---

## §8 — Risk register

| Risk | Mitigation |
|---|---|
| Hot-swap rotate races with in-flight request | JS single-threaded; `this.token` assignment is atomic. In-flight requests use the value they read at handle-entry; ALS doesn't propagate token bytes after the auth check. |
| Per-agent token in runtime config gets committed to git | Init writes to user-private config paths only; documented allowlist. Detected in tests via grep against repo-tracked files. |
| Init from different cwds overwrites global runtime config token | Agent_id derivation is per-(machine,runtime) — deterministic, no cwd. Same agent_id across all of a user's projects. Per-project granularity is opt-in via manual install (and a future 5s plan). |
| Capture browser auto-stops while another flow uses it | Owner check: stop is a no-op when owner is "user"; only bootstrap-owned sessions get torn down. |
| Per-step capture_token leaks via hub SSE | SSE is loopback-only (127.0.0.1 bind); hub UI's SSE listener is same-origin; tokens are single-use, scoped, expire on step resolve. Tokens never leave the SSE-loopback envelope. |
| Multi-step capture batch with intervening blind operation | Per-step defensive blind guard fires → step fails with `blind_mode_already_active` → batch transitions to failed_partial; user resolves, retries via R5 idempotent re-run. `blind.start()` throwing ensures no silent overwrite. |
| Provider login flow redirects to SSO host before target | At-capture-time host verification (not at-open) tolerates the redirect; dev navigates through auth, lands on expected_host, clicks Capture. |
| Daemon crash mid-capture (target_id orphaned, pending registry lost) | On restart: no pending registry entries; status remains `in_progress` on disk + owner_agent_id preserved. R7 + R11 allow agent's `/continue` to re-enter; orphaned target_id is cleaned up by re-running capture step (browser auto-start spawns a fresh browser since `services.browserSession === null` after crash). |
| Cross-agent batch retry via known batch_id | `BatchState.owner_agent_id` enforcement at `/continue` rejects non-owner with `bootstrap_batch_not_found`. R7's approval-skip-for-retry is gated by this owner check. |

---

## §9 — Out of scope

- Capability-based per-agent tokens (operation allowlist) — too complex for v1
- SO_PEERCRED-based caller identification — Unix-only, brittle
- Cross-daemon coordination (multiple daemons on one machine) — not in product
- Approval / batch delegation between agents — out of scope
- Time-bound token expiry — deferred to 5r
- Per-agent token denylist — deferred to 5r
- Vault `Secret.value` + browser `CaptureResult.value` `Buffer` refactor — deferred to 5q
- Template argv stability auto-check — deferred to 5l
- Per-project agent_id auto-derivation — deferred to 5s (manual opt-in supported)
- Trusted-domain allowlist for capture URLs — relying on human approval card to gate

---

## §10 — Success criteria

Burst 4 ships when:

1. **Token isolation:** A compromised agent process token does NOT grant access to another agent's secrets, approvals, sessions, OR bootstrap batches (proven via integration test: agent A creates session/approval/batch; agent B's token gets `approval_not_found` / `bootstrap_batch_not_found`).
2. **Memory hygiene:** Master-key copies are scrubbed before any async continuation at the four named callsites; masker patterns/lookback scrubbed on stream dispose. `Secret.value` and `CaptureResult.value` string residue documented as 5q scope.
3. **Capture flow:** `bootstrap` with a yml containing `source: { kind: capture, url: "https://..." }` for a real provider (Stripe / Supabase / etc.) drives the dev through a clean capture flow, persists the captured value, runs destinations, ends with all CDP observation safely resumed — under a single approval (which is now ALWAYS required when capture is involved). Auth-redirect SSO flows work end-to-end.
4. **Cleanup recovery:** Cleanup-failed steps with bootstrap-owned browser auto-recover blind state after Chrome stops; user-owned browser cleanup-failed → manual `blind end` via existing flow.
5. **Init UX:** Re-running `init` from different projects produces the same agent token in the global runtime config (no overwrite stranding). Runtime name is `claude` per the detector.
6. **Documentation:** SKILL.md documents the per-agent token model (attribution + hygiene boundary), the memory-hygiene best-effort framing, capture-always-requires-approval, and batch ownership.
7. **Regression safety:** All existing R1-R15 invariants still hold; full test suite green.

---

*End of spec.*
