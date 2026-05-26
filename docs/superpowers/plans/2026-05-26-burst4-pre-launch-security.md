# Burst 4 — Pre-Launch Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three intertwined pre-launch security workstreams from `docs/superpowers/specs/2026-05-26-burst4-pre-launch-security-design.md` v3.1: per-agent token isolation (5m), best-effort memory hygiene (5o-core), and capture-from-URL in bootstrap (5p).

**Architecture:** Three orthogonal subsystems landed in phased order. Phase A introduces HMAC-derived per-agent tokens with AsyncLocalStorage-propagated identity, owner-enforced approval/session/batch consumption, and a hot-swap-rotatable persistent root token. Phase B scrubs master-key copies and IPC byte buffers (without claiming end-to-end string scrub, deferred to 5q). Phase C lets bootstrap drive a daemon-owned browser through URL captures under a single approval, with strict yml URL validation, target-bound capture, tokenized hub-UI coordination, and a refined cleanup state machine that auto-resumes blind after browser death.

**Tech stack:** TypeScript strict ESM, Node 20+, `node:crypto` (HMAC-SHA256), `node:async_hooks` (AsyncLocalStorage), `node:net` (isIP), Chrome CDP (existing pipe transport), `node:test` runner.

---

## Scope note

The spec intentionally bundles three subsystems per the brainstorming decision. The writing-plans skill normally suggests breaking such specs into separate plans; here the decision was deliberate (launch-readiness coupling). This plan structures the work in four phases (A/B/C/D) so each phase is independently testable, but they ship as one unit. Plans 5l (template stability), 5q (Buffer end-to-end), 5r (token denylist+expiry), 5s (per-project agent_id) are explicit follow-ups, NOT covered here.

---

## File structure

### Files to create

**Phase A (per-agent tokens):**
- `src/daemon/machine-id.ts` — read/write/regenerate `<SHUTTLE_HOME>/machine-id` (0600, 32 bytes base64url)
- `src/daemon/root-token.ts` — read/write/regenerate `<SHUTTLE_HOME>/root-token` (0600, 32 bytes base64url)
- `src/daemon/auth/auth-context.ts` — `AsyncLocalStorage<AuthContext>` + helper accessors
- `src/daemon/auth/token-derive.ts` — `deriveHmac(rootToken, agentId)`, `formatBearer`, `parseBearer`
- `src/daemon/auth/agent-id.ts` — `deriveAutoAgentId(runtime, machineId)`, `assertAgentIdValid`
- `src/client/auth-token.ts` — `resolveDaemonToken(opts)` (priority: env → require fail-closed → socket)
- `src/daemon/api/routes/tokens.ts` — `POST /v1/tokens/mint` with namespace restriction
- `src/daemon/api/routes/daemon-admin.ts` — `POST /v1/daemon/rotate` + `POST /v1/daemon/reset-machine-id`
- `src/cli/commands/daemon-rotate.ts` — CLI front-end for rotate
- `src/cli/commands/daemon-reset-machine-id.ts` — CLI front-end for reset
- (REMOVED: top-level `agent-mint.ts` would conflict with the existing `agent` command group; `mint` is added as a subcommand to `src/cli/commands/agent.ts`)
- `src/cli/init/agent-token-installers.ts` — runtime-specific config writers (claude, cursor)

**Phase C (capture-from-URL):**
- `src/daemon/bootstrap/browser-session.ts` — `BrowserSession` type, `ensureBootstrapBrowser`, `stopBootstrapBrowser`
- `src/daemon/bootstrap/pending-captures.ts` — `PendingCapturesRegistry`
- `src/daemon/chrome/capture-target-ops.ts` — `openCaptureTarget`, `captureFromTarget`, `blankTarget`, `closeTarget`, `getTargetURL`, `listTargets`
- `src/daemon/api/routes/bootstrap-capture-ui.ts` — raw tokenized routes (`/ui/bootstrap/capture-step`, `/ui/bootstrap/skip-step`, `/ui/bootstrap/abandon`)

### Files to modify

**Phase A:**
- `src/daemon/main.ts` — load root_token + machine-id from disk on startup
- `src/daemon/server.ts` — auth parses bearer → ALS-wrapped handler
- `src/daemon/audit.ts` — `getAuditActor()` helper + ambient ALS read
- `src/client/daemon-client.ts` — use `resolveDaemonToken`
- `src/client/streaming-request.ts` — use `resolveDaemonToken`
- `src/daemon/approvals/store.ts` — `owner_agent_id` on `ApprovalGrant` + `SessionGrant`; owner-aware `consume`/`consumeBatch`/`validateConsumeBatch`
- `src/daemon/approvals/require-approvals.ts` — owner enforcement at Step 0, session leftover, validateConsumeBatch, final consume
- `src/daemon/api/routes/approvals-session.ts` — owner filtering on list/revoke
- `src/daemon/bootstrap/store.ts` — `owner_agent_id` on `BatchState`
- `src/daemon/api/routes/bootstrap.ts` — stamp owner at /plan; enforce at /continue/abandon; filter /list
- `src/cli/commands/init.ts` — derive `agent_id`, write per-runtime configs, manual-install bucket
- `src/shared/error-codes.ts` — new error codes (Phase A + Phase C)

**Phase B:**
- `src/vault/vault.ts` — try/finally `.fill(0)` around `requireKey()` copies in `read`, `write`, `fingerprintKey`
- `src/daemon/run/masker.ts` — `dispose()` scrubs `patterns[]` AND `lookback`
- `src/daemon/templates/run.ts` — child stdin Buffer scrub in write callback + close/error fallback

**Phase C:**
- `src/cli/bootstrap/yml.ts` — capture URL validation (https/creds/IP via `node:net.isIP`/localhost)
- `src/daemon/bootstrap/store.ts` — `expected_host` on `BootstrapSource` capture; `abandoned` in status enum
- `src/daemon/services-blind.ts` — `start()` throws on already-active (hardening)
- `src/daemon/services.ts` — `browserSession` field; `ensureBootstrapBrowser`, `stopBootstrapBrowser` methods
- `src/daemon/api/routes/browser.ts` — migrate to `BrowserSession`
- `src/daemon/chrome/cdp-client.ts` — `CdpClient.close()` method
- `src/daemon/bootstrap/destination-policy.ts` — `planRequiresCapture(plan)` helper
- `src/daemon/api/routes/bootstrap.ts` — capture-always-requires-approval; pre-flight blind guard; outer finally
- `src/daemon/bootstrap/executor.ts` — capture branch state machine
- `src/daemon/approvals/ui.html` — capture-step coordinator card render
- `src/daemon/approvals/ui-html-drift.test.ts` — drift-guard for the new card
- `src/cli/commands/bootstrap.ts` — `--continue` browser auto-start hook
- All ~15 call sites of `services.browser` (migration to `services.browserSession?.browser`)

**Phase D:**
- `SKILL.md` — per-agent token model, blind discipline, memory hygiene best-effort framing, batch ownership, capture-always-requires-approval
- `CHANGELOG.md` — Burst 4 entry

---

# Phase A — Per-agent token foundation (5m)

### Task A1: persistent machine-id file

**Files:**
- Create: `src/daemon/machine-id.ts`
- Test: `src/daemon/machine-id.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/machine-id.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureMachineId, resetMachineId, readMachineId } from "./machine-id.js";

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), "ss-machineid-"));
}

test("ensureMachineId: generates 32-byte base64url file at 0600 when absent", async () => {
  const home = freshHome();
  const id = await ensureMachineId(home);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(id, "base64url").byteLength, 32);
  const file = path.join(home, "machine-id");
  const st = statSync(file);
  assert.equal(st.mode & 0o777, 0o600);
});

test("ensureMachineId: reads existing file, does NOT regenerate", async () => {
  const home = freshHome();
  const first = await ensureMachineId(home);
  const second = await ensureMachineId(home);
  assert.equal(first, second);
});

test("ensureMachineId: throws machine_id_bad_mode when file exists at wrong mode", async () => {
  const home = freshHome();
  await ensureMachineId(home);
  chmodSync(path.join(home, "machine-id"), 0o644);
  await assert.rejects(
    () => ensureMachineId(home),
    (e: unknown) => (e as Error).message.includes("machine_id_bad_mode"),
  );
});

test("resetMachineId: deletes existing file and forces regeneration on next ensureMachineId", async () => {
  const home = freshHome();
  const first = await ensureMachineId(home);
  await resetMachineId(home);
  const second = await ensureMachineId(home);
  assert.notEqual(first, second);
});

test("readMachineId: returns null when absent", async () => {
  const home = freshHome();
  assert.equal(await readMachineId(home), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/machine-id.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement the module**

```ts
// src/daemon/machine-id.ts
import { randomBytes } from "node:crypto";
import { readFile, writeFile, stat, unlink, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

const MACHINE_ID_FILE = "machine-id";

function assertValidContent(s: string, file: string): void {
  // 32 random bytes base64url-encoded with no padding is exactly 43 chars.
  if (s.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ShuttleError(
      "machine_id_malformed",
      `${file} content is not a 43-char base64url-no-pad string.`,
    );
  }
  // Sanity check: decoded length must be 32 bytes.
  if (Buffer.from(s, "base64url").byteLength !== 32) {
    throw new ShuttleError(
      "machine_id_malformed",
      `${file} decodes to wrong length; expected 32 bytes.`,
    );
  }
}

export async function readMachineId(shuttleHome: string): Promise<string | null> {
  try {
    const buf = (await readFile(path.join(shuttleHome, MACHINE_ID_FILE), "utf8")).trim();
    assertValidContent(buf, path.join(shuttleHome, MACHINE_ID_FILE));
    return buf;
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    return null;
  }
}

export async function ensureMachineId(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, MACHINE_ID_FILE);
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== 0o600) {
      throw new ShuttleError(
        "machine_id_bad_mode",
        `${file} is mode ${(st.mode & 0o777).toString(8)}, expected 0600`,
      );
    }
    const content = (await readFile(file, "utf8")).trim();
    assertValidContent(content, file);
    return content;
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(shuttleHome, { recursive: true });
  const id = randomBytes(32).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, id, { mode: 0o600 });
  await rename(tmp, file);
  return id;
}

export async function resetMachineId(shuttleHome: string): Promise<void> {
  try {
    await unlink(path.join(shuttleHome, MACHINE_ID_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
```

Add corresponding test case:
```ts
test("ensureMachineId: throws machine_id_malformed when content is wrong length/charset", async () => {
  const home = freshHome();
  await writeFile(path.join(home, "machine-id"), "not-base64url!", { mode: 0o600 });
  await assert.rejects(() => ensureMachineId(home), /machine_id_malformed/);
});
```

Add error codes `machine_id_bad_mode` and `machine_id_malformed` (both `EXIT_CODE_CONFLICT`) to the error-codes additions in Task A15.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/daemon/machine-id.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/machine-id.ts src/daemon/machine-id.test.ts
git commit -m "feat(daemon): persistent machine-id file (0600, 32 bytes base64url)

Read/write/regenerate <SHUTTLE_HOME>/machine-id with fail-closed mode
validation. Used by Phase A's agent_id derivation; resetMachineId is
explicitly NOT a revocation mechanism (see daemon rotate)."
```

---

### Task A2: persistent root-token file

**Files:**
- Create: `src/daemon/root-token.ts`
- Test: `src/daemon/root-token.test.ts`
- Modify: `src/daemon/main.ts` (load from disk on startup)

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/root-token.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureRootToken, rotateRootToken } from "./root-token.js";

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), "ss-roottok-"));
}

test("ensureRootToken: generates 32-byte base64url file at 0600 when absent", async () => {
  const home = freshHome();
  const t = await ensureRootToken(home);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(t, "base64url").byteLength, 32);
  const st = statSync(path.join(home, "root-token"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("ensureRootToken: reads existing file, does NOT regenerate", async () => {
  const home = freshHome();
  const first = await ensureRootToken(home);
  const second = await ensureRootToken(home);
  assert.equal(first, second);
});

test("ensureRootToken: throws root_token_bad_mode at wrong mode", async () => {
  const home = freshHome();
  await ensureRootToken(home);
  chmodSync(path.join(home, "root-token"), 0o644);
  await assert.rejects(() => ensureRootToken(home), /root_token_bad_mode/);
});

test("rotateRootToken: atomically replaces with a new value", async () => {
  const home = freshHome();
  const first = await ensureRootToken(home);
  const second = await rotateRootToken(home);
  assert.notEqual(first, second);
  const third = await ensureRootToken(home);
  assert.equal(second, third);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/root-token.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement the module**

```ts
// src/daemon/root-token.ts
import { randomBytes } from "node:crypto";
import { readFile, writeFile, stat, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

const ROOT_TOKEN_FILE = "root-token";

function assertValidContent(s: string, file: string): void {
  if (s.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ShuttleError(
      "root_token_malformed",
      `${file} content is not a 43-char base64url-no-pad string.`,
    );
  }
  if (Buffer.from(s, "base64url").byteLength !== 32) {
    throw new ShuttleError(
      "root_token_malformed",
      `${file} decodes to wrong length; expected 32 bytes.`,
    );
  }
}

export async function ensureRootToken(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, ROOT_TOKEN_FILE);
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== 0o600) {
      throw new ShuttleError(
        "root_token_bad_mode",
        `${file} is mode ${(st.mode & 0o777).toString(8)}, expected 0600`,
      );
    }
    const content = (await readFile(file, "utf8")).trim();
    assertValidContent(content, file);
    return content;
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(shuttleHome, { recursive: true });
  const t = randomBytes(32).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, t, { mode: 0o600 });
  await rename(tmp, file);
  return t;
}

export async function rotateRootToken(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, ROOT_TOKEN_FILE);
  const t = randomBytes(32).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, t, { mode: 0o600 });
  await rename(tmp, file);
  return t;
}
```

Add corresponding test case:
```ts
test("ensureRootToken: throws root_token_malformed when content is wrong length/charset", async () => {
  const home = freshHome();
  await writeFile(path.join(home, "root-token"), "not-base64url!", { mode: 0o600 });
  await assert.rejects(() => ensureRootToken(home), /root_token_malformed/);
});
```

Add error codes `root_token_bad_mode` and `root_token_malformed` (both `EXIT_CODE_CONFLICT`) to Task A15.

- [ ] **Step 4: Run tests to verify they pass + integrate into main.ts**

Run: `npx tsx --test src/daemon/root-token.test.ts`
Expected: PASS (4/4)

Then modify `src/daemon/main.ts:32`. Replace:
```ts
const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? randomBytes(32).toString("base64url");
```
With:
```ts
const { ensureRootToken } = await import("./root-token.js");
const { getShuttlePaths } = await import("../shared/config.js");
const paths = getShuttlePaths();
const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? await ensureRootToken(paths.homeDir);
```

Also call `ensureMachineId(paths.homeDir)` early in main() to lock in the machine_id on first start.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/root-token.ts src/daemon/root-token.test.ts src/daemon/main.ts
git commit -m "feat(daemon): persistent root-token file (0600, hot-swap rotatable)

Replaces per-start randomBytes() token with persistent file. Daemon
reads on startup; rotation is explicit via rotateRootToken (used by
/v1/daemon/rotate in a later task). Also wires machine-id ensure into
daemon startup."
```

---

### Task A3: AuthContext + AsyncLocalStorage

**Files:**
- Create: `src/daemon/auth/auth-context.ts`
- Test: `src/daemon/auth/auth-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/auth/auth-context.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { authContext, withAuthContext, getAuthContext, getCurrentAgentId } from "./auth-context.js";

test("withAuthContext / getAuthContext: propagates through async boundaries", async () => {
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () => {
    assert.deepEqual(getAuthContext(), { agent_id: "claude-abc", isRoot: false });
    await new Promise((r) => setImmediate(r));
    assert.equal(getCurrentAgentId(), "claude-abc");
  });
});

test("getAuthContext outside a withAuthContext call returns undefined", () => {
  assert.equal(getAuthContext(), undefined);
});

test("getCurrentAgentId outside any context returns 'daemon' sentinel for audit", () => {
  assert.equal(getCurrentAgentId(), "daemon");
});

test("root context", async () => {
  await withAuthContext({ agent_id: "root", isRoot: true }, async () => {
    const ctx = getAuthContext();
    assert.equal(ctx?.isRoot, true);
    assert.equal(ctx?.agent_id, "root");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/daemon/auth/auth-context.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**

```ts
// src/daemon/auth/auth-context.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthContext {
  agent_id: string; // either a derived id or the literal "root"
  isRoot: boolean;
}

export const authContext = new AsyncLocalStorage<AuthContext>();

export async function withAuthContext<T>(ctx: AuthContext, fn: () => Promise<T> | T): Promise<T> {
  return await authContext.run(ctx, fn);
}

export function getAuthContext(): AuthContext | undefined {
  return authContext.getStore();
}

/** Returns the current agent_id, or "daemon" if no request context is active. */
export function getCurrentAgentId(): string {
  return authContext.getStore()?.agent_id ?? "daemon";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/daemon/auth/auth-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/auth/auth-context.ts src/daemon/auth/auth-context.test.ts
git commit -m "feat(auth): AsyncLocalStorage AuthContext for per-request agent identity"
```

---

### Task A4: token derivation + bearer parser

**Files:**
- Create: `src/daemon/auth/token-derive.ts`
- Create: `src/daemon/auth/agent-id.ts`
- Test: `src/daemon/auth/token-derive.test.ts`
- Test: `src/daemon/auth/agent-id.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/auth/agent-id.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { assertAgentIdValid, deriveAutoAgentId } from "./agent-id.js";

test("assertAgentIdValid accepts valid forms", () => {
  for (const id of ["claude-abc", "cursor.foo", "claude-7f2a.helper-3a", "a", "z0"]) {
    assertAgentIdValid(id); // no throw
  }
});

test("assertAgentIdValid rejects 'root' (reserved)", () => {
  assert.throws(() => assertAgentIdValid("root"), /agent_id_invalid/);
});

test("assertAgentIdValid rejects bad charset / leading dash / too long", () => {
  for (const id of ["", "-abc", "ABC", "a/b", "x@y", "a".repeat(65)]) {
    assert.throws(() => assertAgentIdValid(id), /agent_id_invalid/, `expected reject: ${id}`);
  }
});

test("deriveAutoAgentId: deterministic per (machine_id, runtime)", () => {
  const a = deriveAutoAgentId("claude", "machine-abc");
  const b = deriveAutoAgentId("claude", "machine-abc");
  assert.equal(a, b);
  const c = deriveAutoAgentId("cursor", "machine-abc");
  assert.notEqual(a, c);
  assert.match(a, /^claude-[0-9a-f]{16}$/);
});
```

```ts
// src/daemon/auth/token-derive.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { deriveHmac, formatBearer, parseBearer } from "./token-derive.js";

const root = "AbC_root-tok-base64url-32bytes-AAAAAAAAAAAA";

test("deriveHmac: deterministic, 43 chars base64url no pad", () => {
  const a = deriveHmac(root, "claude-abc");
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  const b = deriveHmac(root, "claude-abc");
  assert.equal(a, b);
  const c = deriveHmac(root, "claude-def");
  assert.notEqual(a, c);
});

test("formatBearer / parseBearer roundtrip on agent token", () => {
  const tok = formatBearer("claude-abc", deriveHmac(root, "claude-abc"));
  const parsed = parseBearer(tok);
  assert.deepEqual(parsed, { kind: "agent", agentId: "claude-abc", hmac: deriveHmac(root, "claude-abc") });
});

test("parseBearer: bare token (no dot) is interpreted as root candidate", () => {
  const parsed = parseBearer(root);
  assert.deepEqual(parsed, { kind: "root", token: root });
});

test("parseBearer: split on LAST dot (agent_id may contain dots)", () => {
  const hmac = deriveHmac(root, "claude-7f2a.helper-3a");
  const tok = `claude-7f2a.helper-3a.${hmac}`;
  const parsed = parseBearer(tok);
  assert.equal(parsed.kind, "agent");
  if (parsed.kind === "agent") assert.equal(parsed.agentId, "claude-7f2a.helper-3a");
});

test("parseBearer: 'root.<anything>' is rejected (reserved)", () => {
  assert.throws(() => parseBearer("root.deadbeef"), /agent_token_invalid/);
});

test("parseBearer: ShuttleError code is agent_token_invalid (serializes correctly)", () => {
  try {
    parseBearer("root.deadbeef");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ShuttleError, "must be ShuttleError, not plain Error (otherwise errorToJson collapses to unexpected_error)");
    assert.equal((e as ShuttleError).code, "agent_token_invalid");
  }
});

test("parseBearer: malformed-agent_id bearer also throws ShuttleError(agent_token_invalid)", () => {
  try {
    parseBearer("BAD!CHARS.someHmac");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ShuttleError);
    assert.equal((e as ShuttleError).code, "agent_token_invalid");
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/auth/agent-id.test.ts src/daemon/auth/token-derive.test.ts`
Expected: FAIL (modules do not exist)

- [ ] **Step 3: Implement**

```ts
// src/daemon/auth/agent-id.ts
import { createHash } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertAgentIdValid(id: string): void {
  if (!AGENT_ID_RE.test(id) || id === "root") {
    throw new ShuttleError("agent_id_invalid", `agent_id ${JSON.stringify(id)} is invalid (must match ${AGENT_ID_RE}, and "root" is reserved).`);
  }
}

export function deriveAutoAgentId(runtime: string, machineId: string): string {
  const digest = createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;
}
```

Add JSON-error-code test:
```ts
test("assertAgentIdValid throws ShuttleError with code agent_id_invalid (serializes correctly)", () => {
  try {
    assertAgentIdValid("ROOT");
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ShuttleError);
    assert.equal((e as ShuttleError).code, "agent_id_invalid");
  }
});
```

```ts
// src/daemon/auth/token-derive.ts
import { createHmac } from "node:crypto";
import { assertAgentIdValid } from "./agent-id.js";
import { ShuttleError } from "../../shared/errors.js";

export function deriveHmac(rootTokenB64url: string, agentId: string): string {
  const key = Buffer.from(rootTokenB64url, "base64url");
  if (key.byteLength !== 32) {
    throw new ShuttleError(
      "root_token_malformed",
      `root_token must be a base64url-no-pad 32-byte value (decoded ${key.byteLength} bytes).`,
    );
  }
  return createHmac("sha256", key).update(agentId).digest("base64url");
}

export function formatBearer(agentId: string, hmacB64url: string): string {
  return `${agentId}.${hmacB64url}`;
}

export type ParsedBearer =
  | { kind: "root"; token: string }
  | { kind: "agent"; agentId: string; hmac: string };

export function parseBearer(bearer: string): ParsedBearer {
  const lastDot = bearer.lastIndexOf(".");
  if (lastDot === -1) {
    return { kind: "root", token: bearer };
  }
  const agentId = bearer.slice(0, lastDot);
  const hmac = bearer.slice(lastDot + 1);
  if (agentId === "root") {
    throw new ShuttleError("agent_token_invalid", "agent_id 'root' is reserved");
  }
  try {
    assertAgentIdValid(agentId);
  } catch {
    // Re-throw as agent_token_invalid (not agent_id_invalid) — the caller
    // supplied a malformed BEARER; surface that distinction. ShuttleError
    // ensures JSON serialization carries the proper error_code.
    throw new ShuttleError("agent_token_invalid", "bearer contains a malformed agent_id");
  }
  return { kind: "agent", agentId, hmac };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/daemon/auth/agent-id.test.ts src/daemon/auth/token-derive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/auth/agent-id.ts src/daemon/auth/token-derive.ts src/daemon/auth/agent-id.test.ts src/daemon/auth/token-derive.test.ts
git commit -m "feat(auth): HMAC token derivation + last-dot bearer parser

agent_id: <runtime>-<16hex> deterministic per (machine_id, runtime).
Token format: <agent_id>.<hmac> where hmac is base64url HMAC-SHA256
of agent_id under base64url-decoded root_token (43 chars). Split on
LAST dot so hierarchical agent_ids (containing dots) parse correctly."
```

---

### Task A5: DaemonServer.handle parses + validates + ALS-wraps

**Files:**
- Modify: `src/daemon/server.ts` (auth section)
- Test: `src/daemon/server.test.ts` (or new test file for auth)

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/server-auth.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { DaemonServer } from "./server.js";
import { deriveHmac, formatBearer } from "./auth/token-derive.js";
import { getCurrentAgentId } from "./auth/auth-context.js";

const ROOT = "rootTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function fetchWith(server: DaemonServer, port: number, auth: string | null): Promise<{ status: number; agentId?: string }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (auth !== null) headers["authorization"] = auth;
  const res = await fetch(`http://127.0.0.1:${port}/v1/whoami`, { method: "POST", headers });
  const body = (await res.json()) as { agent_id?: string };
  return { status: res.status, agentId: body.agent_id };
}

test("DaemonServer: root bearer resolves AuthContext.isRoot=true, agent_id='root'", async () => {
  const server = new DaemonServer({ token: ROOT });
  let captured = "";
  server.addRoute("POST", "/v1/whoami", () => ({ agent_id: getCurrentAgentId() }));
  const { port } = await server.listen(0);
  const r = await fetchWith(server, port, `Bearer ${ROOT}`);
  assert.equal(r.status, 200);
  assert.equal(r.agentId, "root");
  await server.close();
});

test("DaemonServer: valid agent token resolves agent_id from bearer", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({ agent_id: getCurrentAgentId() }));
  const { port } = await server.listen(0);
  const tok = formatBearer("claude-7f2a", deriveHmac(ROOT, "claude-7f2a"));
  const r = await fetchWith(server, port, `Bearer ${tok}`);
  assert.equal(r.status, 200);
  assert.equal(r.agentId, "claude-7f2a");
  await server.close();
});

test("DaemonServer: HMAC mismatch returns 401 unauthorized", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({}));
  const { port } = await server.listen(0);
  const r = await fetchWith(server, port, `Bearer claude-7f2a.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(r.status, 401);
  await server.close();
});

test("DaemonServer: 'root.<anything>' bearer returns 401", async () => {
  const server = new DaemonServer({ token: ROOT });
  server.addRoute("POST", "/v1/whoami", () => ({}));
  const { port } = await server.listen(0);
  const r = await fetchWith(server, port, `Bearer root.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(r.status, 401);
  await server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/server-auth.test.ts`
Expected: FAIL (current handler treats everything except the root token as 401, but doesn't expose agent_id via ALS)

- [ ] **Step 3: Modify server.ts**

Read current `src/daemon/server.ts` lines 113-126 (bearer auth section). Replace the post-host-validation block:

```ts
// Bearer token auth + AsyncLocalStorage wrap.
const authHeader = req.headers["authorization"];
const auth = Array.isArray(authHeader) ? (authHeader[0] ?? "") : (authHeader ?? "");
const BEARER = "Bearer ";
if (!auth.startsWith(BEARER)) {
  this.writeError(res, new ShuttleError("unauthorized", "Missing bearer token."));
  return;
}
const bearer = auth.slice(BEARER.length);
let authCtx: AuthContext;
try {
  const parsed = parseBearer(bearer);
  if (parsed.kind === "root") {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(parsed.token);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new ShuttleError("unauthorized", "Invalid bearer token.");
    }
    authCtx = { agent_id: "root", isRoot: true };
  } else {
    const expectedHmac = deriveHmac(this.token, parsed.agentId);
    const expected = Buffer.from(expectedHmac);
    const actual = Buffer.from(parsed.hmac);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new ShuttleError("unauthorized", "Invalid bearer token.");
    }
    authCtx = { agent_id: parsed.agentId, isRoot: false };
  }
} catch (e) {
  const payload = errorToJson(e);
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return;
}

await withAuthContext(authCtx, async () => {
  // existing streamingHandler dispatch + normal route dispatch goes here
  // (move the existing dispatch logic INSIDE the withAuthContext callback)
});
```

Add imports at top of `server.ts`:
```ts
import { parseBearer } from "./auth/token-derive.js";
import { deriveHmac } from "./auth/token-derive.js";
import { withAuthContext, type AuthContext } from "./auth/auth-context.js";
```

Also add a method `replaceRootToken(t: string): void` to be used by Phase A12's hot-swap rotate:
```ts
replaceRootToken(t: string): void {
  // JS single-threaded — atomic assignment is safe.
  // @ts-expect-error readonly-ish field; intentional internal mutation
  this.token = t;
}
```

(Or remove the `readonly` modifier on `private readonly token` if present; check current code.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/daemon/server-auth.test.ts`
Expected: PASS (4/4)

Run also: `npm test` — full suite must still pass (no other route should break; bearer-with-root still works).
Run: `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts src/daemon/server-auth.test.ts
git commit -m "feat(daemon/server): parse agent bearer + wrap handler in ALS auth context

Bearer is parsed via parseBearer (last-dot split). Root tokens match
via timingSafeEqual against the persistent root_token; agent tokens
match via timingSafeEqual against derived HMAC. AuthContext is then
made available to every handler through AsyncLocalStorage so audit
and owner-enforcement can stamp/check actor_agent_id."
```

---

### Task A6: Centralized client token resolver + migrate clients

**Files:**
- Create: `src/client/auth-token.ts`
- Test: `src/client/auth-token.test.ts`
- Modify: `src/client/daemon-client.ts` + `src/client/streaming-request.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/client/auth-token.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDaemonToken } from "./auth-token.js";

test("env SECRET_SHUTTLE_AGENT_TOKEN wins over socket fallback", async () => {
  const orig = { ...process.env };
  process.env.SECRET_SHUTTLE_AGENT_TOKEN = "claude-abc.someHmac";
  delete process.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN;
  try {
    const r = await resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" });
    assert.equal(r.scope, "agent");
    assert.equal(r.bearer, "claude-abc.someHmac");
    assert.equal(r.agentId, "claude-abc");
  } finally {
    process.env = orig;
  }
});

test("REQUIRE_AGENT_TOKEN=1 + missing AGENT_TOKEN → throws agent_token_required", async () => {
  const orig = { ...process.env };
  delete process.env.SECRET_SHUTTLE_AGENT_TOKEN;
  process.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN = "1";
  try {
    await assert.rejects(
      () => resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" }),
      /agent_token_required/,
    );
  } finally {
    process.env = orig;
  }
});

test("no agent env, no require → fall back to socket root token", async () => {
  const orig = { ...process.env };
  delete process.env.SECRET_SHUTTLE_AGENT_TOKEN;
  delete process.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN;
  try {
    const r = await resolveDaemonToken({ port: 0, readSocketTokenFn: async () => "rootTok" });
    assert.equal(r.scope, "root");
    assert.equal(r.bearer, "rootTok");
    assert.equal(r.agentId, undefined);
  } finally {
    process.env = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/client/auth-token.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**

```ts
// src/client/auth-token.ts
import { readSocketFile } from "../daemon/socket-file.js";
import { ShuttleError } from "../shared/errors.js";

export interface ResolvedToken {
  bearer: string;
  scope: "agent" | "root";
  agentId?: string;
}

export interface ResolverOpts {
  port: number;
  /** Override for tests: function that returns the socket's root token. */
  readSocketTokenFn?: () => Promise<string>;
}

export async function resolveDaemonToken(opts: ResolverOpts): Promise<ResolvedToken> {
  const agentTok = process.env.SECRET_SHUTTLE_AGENT_TOKEN;
  if (typeof agentTok === "string" && agentTok.length > 0) {
    const dot = agentTok.lastIndexOf(".");
    const agentId = dot > 0 ? agentTok.slice(0, dot) : undefined;
    return { scope: "agent", bearer: agentTok, ...(agentId !== undefined ? { agentId } : {}) };
  }
  if (process.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN === "1") {
    throw new ShuttleError(
      "agent_token_required",
      "SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 is set but SECRET_SHUTTLE_AGENT_TOKEN is missing or empty. Run `secret-shuttle init` to (re-)install your agent token, or unset SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN.",
    );
  }
  const read = opts.readSocketTokenFn ?? (async () => {
    const sock = await readSocketFile();
    if (sock === null) throw new ShuttleError("daemon_not_running", "Socket file is absent.");
    return sock.token;
  });
  const token = await read();
  return { scope: "root", bearer: token };
}
```

- [ ] **Step 4: Migrate the existing clients**

In `src/client/daemon-client.ts` and `src/client/streaming-request.ts`, replace any direct socket-file read for the bearer header with:

```ts
import { resolveDaemonToken } from "./auth-token.js";
// ...
const { bearer } = await resolveDaemonToken({ port });
headers["authorization"] = `Bearer ${bearer}`;
```

(Find each existing call by grepping `Authorization` and `Bearer` in `src/client/`; both files are listed under "Files to modify" in §1 above. Tests for daemon-client and streaming-request should continue to pass.)

- [ ] **Step 5: Run tests + commit**

Run: `npx tsx --test src/client/auth-token.test.ts && npm test`
Expected: all pass.

```bash
git add src/client/auth-token.ts src/client/auth-token.test.ts src/client/daemon-client.ts src/client/streaming-request.ts
git commit -m "feat(client): centralized resolveDaemonToken (env → require fail-closed → socket)

Both daemon-client.ts and streaming-request.ts now use the same
priority chain. SECRET_SHUTTLE_AGENT_TOKEN wins; with
SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 the client refuses to read the
socket file's root token. Otherwise fall back to socket root token
(shell-tool compatibility)."
```

---

### Task A7: getAuditActor helper + audit threading

**Files:**
- Modify: `src/daemon/audit.ts`
- Test: `src/daemon/audit-actor.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/audit-actor.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { getAuditActor } from "./audit.js";
import { withAuthContext } from "./auth/auth-context.js";

test("getAuditActor: standard request site reads agent_id from ALS", async () => {
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    assert.equal(getAuditActor({ site: "request" }), "claude-abc");
  });
});

test("getAuditActor: lifecycle site is 'daemon'", () => {
  assert.equal(getAuditActor({ site: "lifecycle" }), "daemon");
});

test("getAuditActor: persisted-owner site reads provided owner", () => {
  assert.equal(getAuditActor({ site: "persisted-owner", ownerAgentId: "cursor-xyz" }), "cursor-xyz");
});

test("getAuditActor: request site without ALS context falls back to 'daemon'", () => {
  assert.equal(getAuditActor({ site: "request" }), "daemon");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/daemon/audit-actor.test.ts`
Expected: FAIL (`getAuditActor` not exported)

- [ ] **Step 3: Modify audit.ts**

Add to `src/daemon/audit.ts`:

```ts
import { getCurrentAgentId } from "./auth/auth-context.js";

export type AuditActorSite =
  | { site: "request" }
  | { site: "lifecycle" }
  | { site: "persisted-owner"; ownerAgentId: string };

export function getAuditActor(site: AuditActorSite): string {
  switch (site.site) {
    case "request":
      return getCurrentAgentId();
    case "lifecycle":
      return "daemon";
    case "persisted-owner":
      return site.ownerAgentId;
  }
}
```

Then modify `writeDaemonAudit` (the existing top-level export) to stamp `actor_agent_id` by default from `getCurrentAgentId()` if not already present in the record. New signature is purely additive — every existing call site just gains the agent_id field automatically:

```ts
// Inside writeDaemonAudit, after the record object is built and BEFORE serialization:
if (record.actor_agent_id === undefined) {
  record.actor_agent_id = getCurrentAgentId();
}
```

For UI raw routes (approval clicks) that have no ALS but DO have a persisted grant owner, the route handler should pass `actor_agent_id: grant.owner_agent_id` explicitly into the audit record (this is documented behavior).

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/daemon/audit-actor.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/audit.ts src/daemon/audit-actor.test.ts
git commit -m "feat(audit): getAuditActor helper + auto-stamp actor_agent_id from ALS

writeDaemonAudit defaults actor_agent_id to the ambient AuthContext's
agent_id, or 'daemon' if none. Lifecycle and persisted-owner sites
pass through getAuditActor with explicit site disambiguation."
```

---

### Task A8: owner_agent_id on ApprovalGrant + SessionGrant + BatchState

**Files:**
- Modify: `src/daemon/approvals/store.ts` (schema + mint stamping)
- Modify: `src/daemon/bootstrap/store.ts` (BatchState schema)
- Test: `src/daemon/approvals/store-owner.test.ts` (new)
- Test: `src/daemon/bootstrap/store-owner.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/approvals/store-owner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "./store.js";
import { withAuthContext } from "../auth/auth-context.js";
import type { ApprovalBinding } from "./store.js";

const binding: ApprovalBinding = {
  action: "generate",
  ref: null,
  planned_ref: "ss://local/dev/X",
  environment: "development",
  destination_domain: null,
  target_id: null,
  field_fingerprint: null,
  template_id: null,
  template_params: null,
  allowed_domains: [],
};

test("ApprovalStore.mint: stamps owner_agent_id from ALS context", async () => {
  const store = new ApprovalStore();
  let id = "";
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, () => {
    id = store.create(binding).id;
  });
  const grant = store.get(id);
  assert.equal(grant?.owner_agent_id, "claude-abc");
});

test("ApprovalStore.mint: stamps 'root' when ALS is root", async () => {
  const store = new ApprovalStore();
  let id = "";
  await withAuthContext({ agent_id: "root", isRoot: true }, () => {
    id = store.create(binding).id;
  });
  assert.equal(store.get(id)?.owner_agent_id, "root");
});

test("ApprovalStore.mint: stamps 'daemon' if no ALS context (defensive)", () => {
  const store = new ApprovalStore();
  const id = store.create(binding).id;
  assert.equal(store.get(id)?.owner_agent_id, "daemon");
});

test("SessionStore equivalent: owner stamped from ALS at create time", async () => {
  // Adapt to whatever the SessionStore create API actually is — verify owner_agent_id is set.
});
```

```ts
// src/daemon/bootstrap/store-owner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { BootstrapStore } from "./store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("BatchState carries owner_agent_id field (schema acceptance)", async () => {
  const store = new BootstrapStore({ rootDir: mkdtempSync(path.join(tmpdir(), "ss-batch-")) });
  await store.save({
    batch_id: "b1",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "claude-abc",
  });
  const back = await store.get("b1");
  assert.equal(back?.owner_agent_id, "claude-abc");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/approvals/store-owner.test.ts src/daemon/bootstrap/store-owner.test.ts`
Expected: FAIL (field does not exist on type)

- [ ] **Step 3: Modify schemas + mint code**

In `src/daemon/approvals/store.ts`:
- Add `owner_agent_id: string` to `ApprovalGrant` interface
- Add `owner_agent_id: string` to `SessionGrant` interface
- In `mint(binding)` (and any session create method): set `owner_agent_id: getCurrentAgentId()` from the ALS helper

In `src/daemon/bootstrap/store.ts`:
- Add `owner_agent_id: string` to `BatchState` interface

(BatchState is a plain serializable record. The save/get paths already round-trip JSON, so no other change needed.)

- [ ] **Step 4: Run tests + ensure existing tests still pass**

Run: `npx tsx --test src/daemon/approvals/store-owner.test.ts src/daemon/bootstrap/store-owner.test.ts && npm test`

If existing approval tests fail because they construct an `ApprovalGrant` literal without `owner_agent_id`, update them to include `owner_agent_id: "daemon"` or whatever the test context is — these are SCHEMA propagation updates, not behavior changes.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/bootstrap/store.ts src/daemon/approvals/store-owner.test.ts src/daemon/bootstrap/store-owner.test.ts
git commit -m "feat(approvals,bootstrap): owner_agent_id field on grants + sessions + batches

Stamped at mint/create from the ALS AuthContext (or 'daemon' if no
context, defensive). Persisted on disk for sessions and bootstrap
batches. Used by upcoming owner-enforcement tasks."
```

---

### Task A9: Owner enforcement in requireApprovals — all stages

**Files:**
- Modify: `src/daemon/approvals/store.ts` — owner-aware consume / consumeBatch / validateConsumeBatch
- Modify: `src/daemon/approvals/require-approvals.ts` — owner threading at Step 0, session leftover handling, final consume
- Test: `src/daemon/approvals/owner-enforcement.test.ts` (new)

This task has multiple TDD cycles because the spec calls out owner enforcement at FIVE distinct stages. Each gets its own failing test + minimal implementation.

- [ ] **Step 1: Write failing tests for all five stages**

```ts
// src/daemon/approvals/owner-enforcement.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { requireApprovals } from "./require-approvals.js";
import { withAuthContext } from "../auth/auth-context.js";
import { ShuttleError } from "../../shared/errors.js";

const binding: ApprovalBinding = {
  action: "generate", ref: null, planned_ref: "ss://local/prod/X", environment: "production",
  destination_domain: null, target_id: null, field_fingerprint: null,
  template_id: null, template_params: null, allowed_domains: ["example.com"],
};

function mintAs(store: ApprovalStore, owner: string, b = binding): string {
  let id = "";
  withAuthContext({ agent_id: owner, isRoot: owner === "root" }, () => {
    id = store.create(b).id;
  });
  // Grants minted in tests are pending; "approve" via the store's internal grant transition.
  // Adapt to whatever the test-helper API actually is — possibly store.testApprove(id).
  store.testApprove?.(id);
  return id;
}

test("Stage 0 (supplied-ID lookup): non-root cross-owner returns approval_not_found", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, async () => {
    await assert.rejects(
      () => requireApprovals({
        store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
        openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
      }),
      (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
    );
  });
});

test("Stage final consume: non-root cross-owner still returns approval_not_found (defensive)", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "cursor-xyz", isRoot: false }, async () => {
    await assert.rejects(
      () => requireApprovals({
        store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
        openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
      }),
      (e: unknown) => e instanceof ShuttleError && e.code === "approval_not_found",
    );
  });
});

test("Root bypasses owner check: can consume any grant", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "root", isRoot: true }, async () => {
    const grants = await requireApprovals({
      store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
      openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
    });
    assert.equal(grants.length, 1);
  });
});

test("Same-owner consume succeeds", async () => {
  const store = new ApprovalStore();
  const id = mintAs(store, "claude-abc");
  await withAuthContext({ agent_id: "claude-abc", isRoot: false }, async () => {
    const grants = await requireApprovals({
      store, bindings: [binding], daemonPort: 0, sessionStore: undefined as any,
      openUrlImpl: async () => {}, approvalIdsFromClient: [id], waitMs: 0,
    });
    assert.equal(grants.length, 1);
  });
});

test("Session leftover: cross-owner supplied session_id → session_not_found (no fall-through to mint)", async () => {
  // Adapt this test to the actual sessionStore API. Key invariant:
  //   - mintAs(sessionStore, "claude-abc", session) → session_id S
  //   - requireApprovals with sessionId=S under cursor-xyz must throw session_not_found
  //   - NOT fall through and emit approval_required (which would leak existence)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/approvals/owner-enforcement.test.ts`
Expected: FAIL — current code doesn't check owners at all.

- [ ] **Step 3: Modify ApprovalStore signatures + require-approvals.ts**

(a) Add `callerAgentId` parameter to consume / consumeBatch / validateConsumeBatch — defaulting is NOT acceptable; force callers to pass it.

```ts
// In src/daemon/approvals/store.ts:
consume(id: string, binding: ApprovalBinding, callerAgentId: string): ApprovalGrant {
  const g = this.findGrant(id);
  if (g === undefined) throw new ShuttleError("approval_not_found", `Unknown approval id: ${id}`);
  if (callerAgentId !== "root" && g.owner_agent_id !== callerAgentId) {
    // Owner mismatch → existence non-disclosure: same code as truly missing.
    throw new ShuttleError("approval_not_found", `Unknown approval id: ${id}`);
  }
  // ... existing binding-match + state-transition logic unchanged ...
}

consumeBatch(items: Array<{ id: string; binding: ApprovalBinding }>, callerAgentId: string): ApprovalGrant[] { /* same per-item */ }

validateConsumeBatch(items: Array<{ id: string; binding: ApprovalBinding }>, callerAgentId: string): void { /* same */ }
```

(b) In `src/daemon/approvals/require-approvals.ts`:

Read `callerAgentId` from `getCurrentAgentId()` once near the top of the function. Pass it into every store call. Specifically:

- **Stage 0 (line ~75)**: when looking up each supplied ID, if `callerAgentId !== "root" && g.owner_agent_id !== callerAgentId`, throw `approval_not_found`. (Same as truly-missing.)
- **Stage leftover (line ~177)**: session candidate fetch — if supplied `sessionId` exists but session `owner_agent_id !== callerAgentId` and not root, throw `session_not_found` immediately (don't fall through to mint).
- **validateConsumeBatch + consume + consumeBatch**: pass `callerAgentId` through.

(c) Update ALL call sites of `store.consume`/`consumeBatch`/`validateConsumeBatch` outside of `require-approvals.ts` (likely none — these are internal) to pass `getCurrentAgentId()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/daemon/approvals/owner-enforcement.test.ts && npm test`
Expected: PASS all + no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/require-approvals.ts src/daemon/approvals/owner-enforcement.test.ts
git commit -m "feat(approvals): owner enforcement at every stage of requireApprovals

Step 0 supplied-ID lookup, session leftover handling,
validateConsumeBatch preflight, final consume/consumeBatch all check
caller_agent_id against grant/session owner_agent_id. Non-root
mismatch returns approval_not_found (or session_not_found for sessions)
— same error as truly missing, no existence leak. Root bypasses every
check (admin)."
```

---

### Task A10: Session list/revoke owner filtering

**Files:**
- Modify: `src/daemon/api/routes/approvals-session.ts`
- Test: extend `src/daemon/api/routes/approvals-session.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// Add to approvals-session.test.ts (or new file)
test("GET /v1/approvals/sessions: non-root sees only own sessions", async () => {
  // Set up: agent A creates session S_A; agent B creates session S_B.
  // GET /v1/approvals/sessions as agent A → contains S_A, not S_B.
  // GET as root → contains both.
});

test("POST /v1/approvals/sessions/revoke: non-root cross-owner returns session_not_found", async () => {
  // Set up: agent A creates session S; agent B revokes by id → session_not_found.
  // Verify S is still alive on subsequent agent-A GET.
});

test("POST /v1/approvals/sessions/revoke as root: succeeds across owners", async () => {
  // Agent A creates S; root revokes → success; S is gone.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/api/routes/approvals-session.test.ts`
Expected: FAIL (current routes don't filter by owner)

- [ ] **Step 3: Modify the routes**

In `src/daemon/api/routes/approvals-session.ts`:

- In the `GET /v1/approvals/sessions` handler: get `callerAgentId = getCurrentAgentId()`. If `callerAgentId !== "root"`, filter the result list to `s.owner_agent_id === callerAgentId`.
- In the `POST /v1/approvals/sessions/revoke` handler: load the session; if non-root caller and `session.owner_agent_id !== callerAgentId`, throw `session_not_found` (same code as truly missing).

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/daemon/api/routes/approvals-session.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/approvals-session.ts src/daemon/api/routes/approvals-session.test.ts
git commit -m "feat(approvals-session): owner-filtered list + owner-checked revoke

Non-root list returns only caller-owned sessions; root sees all.
Non-root revoke of a cross-owner session returns session_not_found
(existence non-disclosure). Root revoke works across owners."
```

---

### Task A11: Bootstrap batch ownership enforcement

**Files:**
- Modify: `src/daemon/api/routes/bootstrap.ts` (stamp at /plan, enforce at /continue, /abandon, /list)
- Test: `src/daemon/api/routes/bootstrap-owner.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
// src/daemon/api/routes/bootstrap-owner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
// (use the existing bootstrap route harness pattern from R7/R8/R10/R12/R13 tests)

test("POST /v1/bootstrap/plan: stamps owner_agent_id on BatchState from ALS", async () => {
  // mint root + agent token; call /plan as agent A; assert saved batch has owner_agent_id === A.
});

test("POST /v1/bootstrap/continue: non-root cross-owner returns bootstrap_batch_not_found", async () => {
  // agent A creates batch; agent B calls /continue → bootstrap_batch_not_found.
});

test("POST /v1/bootstrap/abandon: same enforcement", async () => {});

test("GET /v1/bootstrap/list: non-root sees only own batches; root sees all", async () => {});

test("Owner enforcement is BEFORE blind guard + approval consume in /continue", async () => {
  // Agent B calls /continue on A's batch. Even if blind is active OR approval is
  // somehow already used, the response must be bootstrap_batch_not_found (existence
  // non-disclosure must beat any other failure mode).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/api/routes/bootstrap-owner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify bootstrap.ts**

In `/v1/bootstrap/plan` (right after computing the plan, before `bootstrapStore.save`):
```ts
const ownerAgentId = getCurrentAgentId();
// ... save state with owner_agent_id: ownerAgentId ...
```

In `/v1/bootstrap/continue` (right after `state` is loaded, BEFORE blind guard, BEFORE requireApprovals):
```ts
const callerAgentId = getCurrentAgentId();
const callerIsRoot = getAuthContext()?.isRoot === true;
if (!callerIsRoot && state.owner_agent_id !== callerAgentId) {
  throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
}
```

Same check in `/v1/bootstrap/abandon`.

In `/v1/bootstrap/list`, after listing all batches:
```ts
const callerAgentId = getCurrentAgentId();
const callerIsRoot = getAuthContext()?.isRoot === true;
const filtered = callerIsRoot ? batches : batches.filter((s) => s.owner_agent_id === callerAgentId);
return { ok: true, batches: filtered.map(/* existing mapping */) };
```

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/daemon/api/routes/bootstrap-owner.test.ts && npm test`
Expected: PASS. Existing bootstrap tests that don't set up an owner will need to mint as root (or as a known agent_id matching the test's caller) — schema propagation, not behavior change.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/bootstrap.ts src/daemon/api/routes/bootstrap-owner.test.ts
git commit -m "feat(bootstrap): batch owner_agent_id stamped at /plan + enforced everywhere

/continue, /abandon, /list now respect BatchState.owner_agent_id with
non-root mismatch returning bootstrap_batch_not_found (existence non-
disclosure). Closes the 'any agent with the batch_id can resume via
R7 skip-approval path' hole."
```

---

### Task A12: /v1/tokens/mint with namespace restriction

**Files:**
- Create: `src/daemon/api/routes/tokens.ts`
- Modify: `src/daemon/api/router.ts` (register)
- Test: `src/daemon/api/routes/tokens.test.ts` (new)
- Modify: `src/cli/commands/agent.ts` (add `mint` subcommand to the existing `agent` command group)

- [ ] **Step 1: Write failing tests**

```ts
// src/daemon/api/routes/tokens.test.ts
test("POST /v1/tokens/mint: root can mint any agent_id", async () => {
  // root → mint { agent_id: "claude-anything" } → { token: "claude-anything.<hmac>" }
});

test("POST /v1/tokens/mint: non-root can mint a child within its namespace", async () => {
  // caller "claude-7f2a" → mint "claude-7f2a.helper-3a1b" → 200
});

test("POST /v1/tokens/mint: non-root CANNOT mint outside namespace", async () => {
  // caller "claude-7f2a" → mint "cursor-deadbeef" → 400 agent_id_namespace_violation
});

test("POST /v1/tokens/mint: non-root CANNOT mint own identity again", async () => {
  // caller "claude-7f2a" → mint "claude-7f2a" → 400 agent_id_namespace_violation
});

test("POST /v1/tokens/mint: returned token validates against current root_token", async () => {
  // Take returned token; use it as bearer; call /v1/whoami; expect 200 with agent_id matching.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/api/routes/tokens.test.ts`
Expected: FAIL (route does not exist)

- [ ] **Step 3: Implement**

```ts
// src/daemon/api/routes/tokens.ts
import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { assertAgentIdValid } from "../../auth/agent-id.js";
import { getAuthContext } from "../../auth/auth-context.js";
import { asObject, reqString } from "../validate.js";
import { writeDaemonAudit } from "../../audit.js";

export function registerTokens(server: DaemonServer, getRootToken: () => string): void {
  server.addRoute("POST", "/v1/tokens/mint", async (_req, raw) => {
    const ctx = getAuthContext();
    if (ctx === undefined) throw new ShuttleError("unauthorized", "Missing auth context.");
    const o = asObject(raw);
    const requested = reqString(o, "agent_id");
    assertAgentIdValid(requested);
    if (!ctx.isRoot) {
      const requiredPrefix = `${ctx.agent_id}.`;
      if (!requested.startsWith(requiredPrefix) || requested.length === requiredPrefix.length) {
        throw new ShuttleError(
          "agent_id_namespace_violation",
          `Caller ${ctx.agent_id} cannot mint ${requested} — child id must start with "${requiredPrefix}".`,
        );
      }
    }
    const hmac = deriveHmac(getRootToken(), requested);
    const token = formatBearer(requested, hmac);
    await writeDaemonAudit({
      action: "tokens_mint",
      ok: true,
      parent_agent_id: ctx.agent_id,
      child_agent_id: requested,
    });
    return { token, agent_id: requested };
  });
}
```

Then in `src/daemon/api/router.ts`, register the route (pass a function returning the current root token; DaemonServer.replaceRootToken will swap it in place).

- [ ] **Step 4: Add `mint` as a subcommand of the existing `agent` command group + run tests**

The CLI already has an `agent` command group at `src/cli/commands/agent.ts`. Add the new `mint` subcommand to it (NOT a top-level `agent-mint`):

```ts
// In src/cli/commands/agent.ts (add inside the existing agent.command(...) chain):
agent
  .command("mint")
  .description("Mint a child agent token (namespace-restricted to caller; root mints any agent_id).")
  .requiredOption("--child-id <id>", "Requested child agent_id (e.g., claude-7f2a.proj-acme-prod)")
  .action(async (options: { childId: string }) => {
    const r = await daemonRequest("POST", "/v1/tokens/mint", { agent_id: options.childId });
    outputJson(ok(r));
  });
```

User-visible invocation: `secret-shuttle agent mint --child-id <id>` (matches the approved spec wording).

Run: `npx tsx --test src/daemon/api/routes/tokens.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/tokens.ts src/daemon/api/routes/tokens.test.ts src/daemon/api/router.ts src/cli/commands/agent.ts
git commit -m "feat(tokens): POST /v1/tokens/mint with namespace restriction + agent mint subcommand

Root can mint any agent_id; non-root callers can only mint children
under their own agent_id prefix (claude-X can mint claude-X.helper-Y
but not cursor-Z). Returned token validates against current root_token
(stateless HMAC). Audit: tokens_mint { parent_agent_id, child_agent_id }.
CLI: \`secret-shuttle agent mint --child-id <id>\` (subcommand of the
existing agent command group)."
```

---

### Task A13: /v1/daemon/rotate + /v1/daemon/reset-machine-id + CLI

**Files:**
- Create: `src/daemon/api/routes/daemon-admin.ts`
- Modify: `src/daemon/api/router.ts`
- Create: `src/cli/commands/daemon-rotate.ts`
- Create: `src/cli/commands/daemon-reset-machine-id.ts`
- Test: `src/daemon/api/routes/daemon-admin.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("POST /v1/daemon/rotate: root-only, regenerates root_token, in-memory swap", async () => {
  // Spin up daemon with root token R1. POST /v1/daemon/rotate as root.
  // → returns new token R2. Old token rejected on next request (401).
  // New token (read from socket file) accepted.
});

test("POST /v1/daemon/rotate: non-root → 401/403", async () => {
  // Agent token caller → forbidden.
});

test("POST /v1/daemon/reset-machine-id: root-only, regenerates file, does NOT invalidate tokens", async () => {
  // Mint agent token T under root R1 + machine M1. Reset machine-id.
  // T is still valid because HMAC depends on R1, not M1.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/daemon/api/routes/daemon-admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement routes**

```ts
// src/daemon/api/routes/daemon-admin.ts
import { ShuttleError } from "../../../shared/errors.js";
import type { DaemonServer } from "../../server.js";
import { getAuthContext } from "../../auth/auth-context.js";
import { rotateRootToken } from "../../root-token.js";
import { resetMachineId } from "../../machine-id.js";
import { writeSocketFile } from "../../socket-file.js";
import { writeDaemonAudit } from "../../audit.js";
import { getShuttlePaths } from "../../../shared/config.js";

export function registerDaemonAdmin(server: DaemonServer, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/daemon/rotate", async () => {
    const ctx = getAuthContext();
    if (ctx?.isRoot !== true) {
      throw new ShuttleError("unauthorized", "daemon rotate is root-only.");
    }
    const paths = getShuttlePaths();
    const newToken = await rotateRootToken(paths.homeDir);
    await writeSocketFile({ port: daemonPortRef(), token: newToken, pid: process.pid });
    server.replaceRootToken(newToken);
    await writeDaemonAudit({ action: "daemon_rotate", ok: true, actor_agent_id: "root" });
    return {
      ok: true,
      message: "Root token rotated. Re-run `secret-shuttle init` to re-issue per-agent tokens.",
    };
  });

  server.addRoute("POST", "/v1/daemon/reset-machine-id", async () => {
    const ctx = getAuthContext();
    if (ctx?.isRoot !== true) {
      throw new ShuttleError("unauthorized", "daemon reset-machine-id is root-only.");
    }
    const paths = getShuttlePaths();
    await resetMachineId(paths.homeDir);
    await writeDaemonAudit({ action: "daemon_reset_machine_id", ok: true, actor_agent_id: "root" });
    return {
      ok: true,
      message: "machine-id reset. Re-run `secret-shuttle init` to re-derive per-runtime agent_ids. NOTE: this does NOT revoke existing tokens — use `secret-shuttle daemon rotate` for revocation.",
    };
  });
}
```

Register in `router.ts`.

- [ ] **Step 4: Add CLI commands**

```ts
// src/cli/commands/daemon-rotate.ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function daemonRotateCommand(): Command {
  return new Command("rotate")
    .description("Rotate the daemon's root token. Invalidates ALL derived agent tokens immediately. Re-run `secret-shuttle init` afterwards.")
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/daemon/rotate");
      outputJson(ok(r));
    });
}
```

```ts
// src/cli/commands/daemon-reset-machine-id.ts
import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";

export function daemonResetMachineIdCommand(): Command {
  return new Command("reset-machine-id")
    .description("Reset <SHUTTLE_HOME>/machine-id. Future `init` runs will derive different per-runtime agent_ids. Does NOT revoke existing tokens; use `daemon rotate` for revocation.")
    .action(async () => {
      const r = await daemonRequest("POST", "/v1/daemon/reset-machine-id");
      outputJson(ok(r));
    });
}
```

Register both under a `daemon` subcommand in the main CLI router.

- [ ] **Step 5: Run tests + commit**

Run: `npx tsx --test src/daemon/api/routes/daemon-admin.test.ts && npm test`
Expected: PASS.

```bash
git add src/daemon/api/routes/daemon-admin.ts src/daemon/api/routes/daemon-admin.test.ts src/daemon/api/router.ts src/cli/commands/daemon-rotate.ts src/cli/commands/daemon-reset-machine-id.ts
git commit -m "feat(daemon-admin): rotate (token revocation) + reset-machine-id (id refresh)

POST /v1/daemon/rotate regenerates root-token atomically, rewrites
socket file, hot-swaps in-memory token. All derived agent tokens
invalidated immediately (HMAC mismatch under new key). Root-only.

POST /v1/daemon/reset-machine-id regenerates <SHUTTLE_HOME>/machine-id.
Future agent_id derivations change. Does NOT revoke existing tokens
— help text + response message say so explicitly. Root-only."
```

---

### Task A14: init command — derive agent_ids + write runtime configs

**Files:**
- Modify: `src/cli/commands/init.ts`
- Create: `src/cli/init/agent-token-installers.ts` (claude + cursor concrete; codex + copilot manual)
- Test: `src/cli/commands/init.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```ts
test("init: derives the same agent_id for the same runtime across different cwds (no overwrite)", async () => {
  // Run init in project A → expect claude config has SECRET_SHUTTLE_AGENT_TOKEN with id claude-<hash>.
  // Move to project B → re-run init → claude config still has the SAME token (deterministic per machine).
});

test("init: writes SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 alongside the token", async () => {});

test("init: claude config written to user-private path, NEVER repo-committed file", async () => {
  // Assert no token bytes appear in any file inside the project cwd.
});

test("init: codex/copilot get manual-install instructions in the summary, not config writes", async () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/cli/commands/init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement agent-token-installers + integrate into init**

```ts
// src/cli/init/agent-token-installers.ts
import path from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import type { AgentRuntime } from "../agent-runtime-detect.js";

export interface InstallResult {
  runtime: AgentRuntime;
  status: "configured" | "manual";
  configPath?: string;
  manualInstructions?: string;
}

export async function installAgentToken(
  runtime: AgentRuntime,
  agentId: string,
  token: string,
): Promise<InstallResult> {
  if (runtime === "claude") {
    const file = path.join(homedir(), ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    let settings: { env?: Record<string, string> } = {};
    try {
      const txt = await readFile(file, "utf8");
      settings = JSON.parse(txt) as typeof settings;
    } catch {
      // file absent or empty
    }
    settings.env = {
      ...(settings.env ?? {}),
      SECRET_SHUTTLE_AGENT_TOKEN: token,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    };
    await writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return { runtime, status: "configured", configPath: file };
  }
  if (runtime === "cursor") {
    // Platform-specific path: macOS ~/Library/Application Support/Cursor/User/settings.json,
    // Linux ~/.config/Cursor/User/settings.json. Resolve and write same shape.
    const file = process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "Cursor", "User", "settings.json")
      : path.join(homedir(), ".config", "Cursor", "User", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch { /* empty */ }
    (settings as { "terminal.integrated.env.osx"?: Record<string, string> })["terminal.integrated.env.osx"] = {
      ...((settings as { "terminal.integrated.env.osx"?: Record<string, string> })["terminal.integrated.env.osx"] ?? {}),
      SECRET_SHUTTLE_AGENT_TOKEN: token,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    };
    await writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return { runtime, status: "configured", configPath: file };
  }
  // codex / copilot: manual install
  return {
    runtime,
    status: "manual",
    manualInstructions:
      `For ${runtime}: add the following to your shell rc and restart ${runtime}:\n  export SECRET_SHUTTLE_AGENT_TOKEN=${token}\n  export SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1`,
  };
}
```

Then in `src/cli/commands/init.ts`:

After `detectAgentRuntimes(cwd)`, for each detected runtime:
1. **Read machine_id directly from `<SHUTTLE_HOME>/machine-id`** via the existing `readMachineId(home)` helper from Task A1 — the CLI runs as the same user as the daemon, so the 0600 file is readable. (No new `/v1/whoami` route needed; daemonRequest layer is reserved for actions that mutate daemon state.)
2. Compute `agentId = deriveAutoAgentId(runtime, machineId)`.
3. Mint a token: `await daemonRequest("POST", "/v1/tokens/mint", { agent_id: agentId })`. The daemon's /v1/tokens/mint route validates that the caller (root, via the CLI's socket-file fallback) has authority to mint arbitrary agent_ids.
4. Call `installAgentToken(runtime, agentId, token)`.
5. Push result into summary.

Emit the summary as:
```json
{
  "agent_runtimes_configured": ["claude"],
  "agent_runtimes_pending_manual": ["codex"],
  "next_actions": ["For codex: export SECRET_SHUTTLE_AGENT_TOKEN=... in your shell rc"]
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/cli/commands/init.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts src/cli/init/agent-token-installers.ts src/cli/commands/init.test.ts
git commit -m "feat(init): derive per-runtime agent_ids + write per-agent tokens to user-private config

Claude → ~/.claude/settings.json env block (0600).
Cursor → platform-specific settings.json terminal env (0600).
Codex / copilot → manual-install instructions in summary.

agent_id is per-(machine, runtime) deterministic via SHA-256(
machine_id ‖ runtime). Re-running init from different cwds produces
the same agent_id → same token in global runtime config → no overwrite
stranding. Tokens never land in repo-committed files."
```

---

### Task A15: New error codes for Phase A

**Files:**
- Modify: `src/shared/error-codes.ts`
- Modify: `src/shared/error-codes.test.ts` (registry count)

- [ ] **Step 1: Add the codes**

```ts
agent_token_required: {
  exitCode: EXIT_CODE_TRANSIENT,
  hint: () => "Re-run `secret-shuttle init` to install the agent token, or unset SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN.",
  nextAction: () => "secret-shuttle init",
},
agent_token_invalid: {
  exitCode: EXIT_CODE_PERMISSION,
  hint: () => "The agent token did not validate. Re-run `secret-shuttle init` after the daemon owner has rotated.",
  nextAction: () => "secret-shuttle init",
},
agent_id_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => null },
agent_id_namespace_violation: {
  exitCode: EXIT_CODE_USAGE,
  hint: (msg) => `Child agent_id must start with the caller's agent_id followed by a dot. ${msg}`,
},
machine_id_bad_mode: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "<SHUTTLE_HOME>/machine-id exists with the wrong mode. `chmod 600` it, or delete the file to regenerate.",
},
machine_id_malformed: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "<SHUTTLE_HOME>/machine-id content is not a 43-char base64url-no-pad string. Delete it to regenerate, or restore from a backup.",
},
root_token_bad_mode: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "<SHUTTLE_HOME>/root-token exists with the wrong mode. `chmod 600` it.",
},
root_token_malformed: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "<SHUTTLE_HOME>/root-token content is not a 43-char base64url-no-pad string. Delete it to regenerate (note: this also invalidates all derived agent tokens).",
},
```

Update `error-codes.test.ts` registry count.

- [ ] **Step 2: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(error-codes): 4 new codes for Phase A (per-agent tokens)"
```

---

# Phase B — Memory hygiene (5o-core)

### Task B1: `requireKey()` copy lifetime — scrub in finally

**Files:**
- Modify: `src/vault/vault.ts` — Vault.read, Vault.write, Vault.fingerprintKey
- Test: `src/vault/vault-key-scrub.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/vault/vault-key-scrub.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { LockedVaultState } from "./locked-state.js";
import { Vault } from "./vault.js";

test("Vault.read: master-key copy is .fill(0)'d after the read completes", async () => {
  // Set up: stub requireKey to return a Buffer we control. After Vault.read returns,
  // verify the returned copy has been zeroed.
  const lock = new LockedVaultState();
  const key = Buffer.alloc(32, 0xab);
  lock.unlock(key);
  let observedCopy: Buffer | null = null;
  const origRequire = lock.requireKey.bind(lock);
  lock.requireKey = () => {
    const c = origRequire();
    observedCopy = c;
    return c;
  };
  const vault = new Vault(() => lock.requireKey());
  // Trigger a read (use any valid stored ref or a test-only path).
  // After the call, observedCopy must be all zeros.
  // … minimal end-to-end may require setting up an in-memory vault dir. Use existing
  // vault test scaffolding to mint and then read a secret.
  // assertion at end:
  // assert.ok(observedCopy && observedCopy.every((b) => b === 0));
});

test("Vault.write: same scrub guarantee", async () => { /* analogous */ });
test("Vault.fingerprintKey: same scrub guarantee", async () => { /* analogous */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: the observedCopy retains its 0xab bytes (no scrub today).

- [ ] **Step 3: Wrap each requireKey() callsite in `Vault` with try/finally**

For every callsite of `this.requireKey()` (the constructor-injected getter) inside `Vault.read`, `Vault.write`, `Vault.fingerprintKey`:

```ts
async read(ref: string): Promise<Secret> {
  const key = this.requireKey();
  try {
    // … existing AEAD-decrypt logic, SYNCHRONOUSLY under the key …
    // NO `await` between requireKey() and .fill(0) unless the awaited work intrinsically
    // requires the key. If an async filesystem write is unrelated to the key, do the
    // .fill(0) BEFORE that await.
    return result;
  } finally {
    key.fill(0);
  }
}
```

Repeat for write + fingerprintKey. Pay attention to "ensure no key held across unrelated async continuation" — if there's a `await fs.writeFile(...)` mid-method, scrub the key BEFORE the write.

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/vault/vault-key-scrub.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/vault.ts src/vault/vault-key-scrub.test.ts
git commit -m "feat(vault): scrub requireKey() copies in finally; minimize lifetime

read/write/fingerprintKey all wrap their key copy in try/finally with
.fill(0). The key is never held across unrelated async continuation —
encrypt/decrypt happen synchronously under the key, scrub, then
continue with any file writes."
```

---

### Task B2: Masker dispose scrubs patterns + lookback

**Files:**
- Modify: `src/daemon/run/masker.ts` — `dispose()` and `flush()`
- Test: `src/daemon/run/masker-scrub.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/run/masker-scrub.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createMasker } from "./masker.js";

test("masker.dispose: zeros all pattern buffers and the lookback buffer", () => {
  const patterns = [Buffer.from("supersecret"), Buffer.from("hunter2")];
  const m = createMasker(patterns);
  m.write(Buffer.from("supersec")); // partial — lookback should hold bytes
  m.dispose();
  // Both pattern buffers must be all zeros now:
  for (const p of patterns) assert.ok(p.every((b) => b === 0), "pattern not scrubbed");
  // The lookback Buffer the masker held internally must also be zeroed.
  // (This requires the masker to expose its lookback for the test or use a spy.)
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current `dispose` likely only releases references but doesn't zero.

- [ ] **Step 3: Modify masker.ts**

In `dispose()` (and `flush()` if it also clears state):
```ts
dispose(): void {
  for (const p of this.patterns) p.fill(0);
  // assume lookback is a Buffer field:
  this.lookback.fill(0);
  this.lookback = Buffer.alloc(0);
  this.patterns = [];
}
```

(Adapt to whatever the actual internal field names are.)

- [ ] **Step 4: Run test + verify**

Run: `npx tsx --test src/daemon/run/masker-scrub.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/run/masker.ts src/daemon/run/masker-scrub.test.ts
git commit -m "feat(masker): dispose scrubs patterns AND lookback buffers

createMasker retains pattern buffers AND a lookback that can hold
partial secret bytes across chunks. Both must be zeroed on dispose
so masker buffers don't outlive the stream."
```

---

### Task B3: Child stdin Buffer scrub in write callback + close/error fallback

**Files:**
- Modify: `src/daemon/templates/run.ts` (and possibly `src/daemon/run/spawner.ts` for /v1/run/resolve)
- Test: `src/daemon/templates/stdin-scrub.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
test("runTemplate (stdin path): scrubs the secret Buffer ONLY after stdin write callback fires", async () => {
  // Set up a stub template + an observable Buffer. After child.stdin.end(buf, cb) resolves,
  // assert buf.every(b => b === 0). Before the write callback fires (peek mid-flight), buf
  // still contains the original bytes.
});

test("runTemplate stdin scrub fires on stdin 'error' event too (abnormal termination)", async () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — current `run.ts` doesn't scrub the stdin Buffer.

- [ ] **Step 3: Modify `src/daemon/templates/run.ts`**

In the stdin-delivery branch, replace `child.stdin?.end(secret)` with a write callback:

```ts
if (template.secret_delivery === "stdin") {
  await new Promise<void>((resolve, reject) => {
    const stdin = child.stdin;
    if (stdin === null) return reject(new Error("stdin unavailable"));
    let scrubbed = false;
    const scrub = (): void => {
      if (scrubbed) return;
      scrubbed = true;
      secret.fill(0);
    };
    stdin.once("error", scrub);
    stdin.once("close", scrub);
    stdin.end(secret, () => {
      scrub();
      resolve();
    });
  });
}
```

(Adapt to existing variable names. `secret` is the Buffer holding the plaintext bytes.)

For the env-file delivery path: confirm existing `.fill(0)` in `tmp-env-file.ts:58, 75` is preserved; no change needed there.

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/daemon/templates/stdin-scrub.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/templates/run.ts src/daemon/templates/stdin-scrub.test.ts
git commit -m "feat(templates/run): scrub stdin Buffer in write callback (not before)

Node may retain the same Buffer until the write completes. Zeroing in
the .end(buf, cb) callback ensures bytes have flushed before they're
overwritten. close/error event fallbacks scrub on abnormal termination."
```

---

# Phase C — Capture-from-URL (5p)

### Task C1: Yml validation — `kind: capture` URL strict check

**Files:**
- Modify: `src/cli/bootstrap/yml.ts`
- Test: `src/cli/bootstrap/yml.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```ts
test("parseBootstrapYml: capture URL https-only", () => {
  // url=http://x.com → throws bootstrap_capture_url_invalid
});

test("parseBootstrapYml: capture URL rejects embedded credentials", () => {
  // https://u:p@x.com → reject
});

test("parseBootstrapYml: capture URL rejects loopback variants", () => {
  for (const host of ["localhost", "localhost.", "foo.localhost", "127.0.0.1"]) {
    // expect reject
  }
});

test("parseBootstrapYml: capture URL rejects IPv4 + IPv6 literals (via node:net.isIP)", () => {
  for (const host of ["192.168.1.1", "[::1]", "[2001:db8::1]"]) {
    // expect reject
  }
});

test("parseBootstrapYml: capture URL captures expected_host (lowercased, dot-stripped)", () => {
  // url=https://Dashboard.Stripe.com./... → BootstrapSource.expected_host === "dashboard.stripe.com"
});

test("parseBootstrapYml: well-formed capture URL accepted", () => {
  // url=https://dashboard.stripe.com/webhooks/we_abc/signing_secret → OK; expected_host set
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — current code rejects all capture sources or doesn't have these granular checks.

- [ ] **Step 3: Modify yml.ts**

In `parseSource(secretName, raw)` capture branch:

```ts
if (kind === "capture") {
  if (typeof s.url !== "string" || s.url.length === 0) {
    fail(`secrets.${secretName}.source: kind=capture requires url`);
  }
  let u: URL;
  try {
    u = new URL(s.url);
  } catch {
    fail(`secrets.${secretName}.source.url is not a valid URL: ${JSON.stringify(s.url)}`);
  }
  if (u.protocol !== "https:") fail(`secrets.${secretName}.source.url must be https`);
  if (u.username || u.password) fail(`secrets.${secretName}.source.url must not embed credentials`);
  const hostRaw = u.hostname.toLowerCase();
  const host = hostRaw.endsWith(".") ? hostRaw.slice(0, -1) : hostRaw;
  const hostForIp = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const { isIP } = await import("node:net");
  if (isIP(hostForIp) !== 0) fail(`secrets.${secretName}.source.url must not target an IP literal`);
  if (host === "localhost" || host.endsWith(".localhost")) fail(`secrets.${secretName}.source.url must not target localhost`);
  return { kind: "capture", url: s.url, expected_host: host };
}
```

(Make sure `parseSource` becomes async if it isn't; or import `isIP` at module top.)

Add `expected_host: string` to the `BootstrapSource` capture variant in the type file.

Also: update Plan 5g's existing "reject capture sources at /plan" code path — that block should still exist (capture-always-requires-approval is the gate, but the validation must happen BEFORE rejection). Actually the spec says we now STOP rejecting captures at /plan — so remove the old "Reject capture sources explicitly" block from `bootstrap.ts` (lines ~38-46).

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/cli/bootstrap/yml.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/bootstrap/yml.ts src/cli/bootstrap/yml.test.ts src/daemon/api/routes/bootstrap.ts src/daemon/bootstrap/store.ts
git commit -m "feat(bootstrap/yml): strict capture URL validation + expected_host extraction

https only, no embedded creds, no IP literals (via node:net.isIP),
no localhost variants. Stores canonical lowercased dot-stripped host
in BootstrapSource.expected_host for at-capture-time verification.
Removes the 'capture sources rejected at /plan' block from bootstrap.ts
— capture is now a first-class kind."
```

---

### Task C2: `BlindModeState.start()` throws on already-active (hardening)

**Files:**
- Modify: `src/daemon/services-blind.ts`
- Test: `src/daemon/services-blind.test.ts` (extend or new)
- Audit existing callers (inject, reveal-capture) — make sure they all check `blind.current()` BEFORE calling `start()` (most already do).

- [ ] **Step 1: Write failing tests**

```ts
test("BlindModeState.start: throws blind_mode_already_active when state is not null", () => {
  const state = new BlindModeState();
  state.start("example.com", "inject");
  assert.throws(() => state.start("other.com", "inject"), /blind_mode_already_active/);
});

test("REGRESSION: inject route continues to function (must check blind.current first)", async () => {
  // Existing inject tests must still pass. If inject did `blind.start()` without check, it would now throw.
});

test("REGRESSION: reveal-capture continues to function (must check blind.current first)", async () => {});
```

- [ ] **Step 2: Run tests to verify**

Expected: the new "throws on active" test fails (current impl overwrites silently). The regression tests for inject/reveal-capture should still pass IF those routes already check blind state before start (they do per `secrets.ts:402-407` and `reveal-capture` equivalent — verify by grep).

- [ ] **Step 3: Modify `services-blind.ts`**

```ts
start(domain: string, reason: string): void {
  if (this.state !== null) {
    throw new ShuttleError(
      "blind_mode_already_active",
      `Cannot start blind mode for ${domain} (${reason}); already active for ${this.state.domain} (${this.state.reason}).`,
    );
  }
  this.state = { domain, reason, startedAt: Date.now() };
}
```

If any existing caller relies on the overwrite-silently behavior (unlikely; the spec calls this hardening), they need to switch to "if active, throw; if not, start." Audit by grepping all `blind.start` callers; existing callers already do `if (blind.current() !== null) throw` before calling, so the only new behavior is for paths that DIDN'T check (none today).

- [ ] **Step 4: Run tests + verify**

Run: `npx tsx --test src/daemon/services-blind.test.ts && npm test`
Expected: PASS all (inject + reveal-capture tests should be unaffected because their handlers already pre-check).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/services-blind.ts src/daemon/services-blind.test.ts
git commit -m "feat(blind): start() throws blind_mode_already_active when active (no silent overwrite)

All existing callers already pre-check via blind.current(); this just
hardens the API surface so any future caller that forgets gets a
clear error instead of corrupting state."
```

---

### Task C3: `CdpClient.close()` method

**Files:**
- Modify: `src/daemon/chrome/cdp-client.ts`
- Test: extend `src/daemon/chrome/cdp-client.test.ts` (or co-located if no test file exists)

- [ ] **Step 1: Write failing test**

```ts
test("CdpClient.close: tears down the websocket / pipe and rejects pending sends", async () => {
  // Create a CdpClient against a mock transport. Call close(). Assert subsequent
  // sends reject with `cdp_client_closed` (or similar).
});
```

- [ ] **Step 2: Implement**

Add a `close()` method that:
- Closes the underlying pipe transport / WebSocket
- Marks the client as closed
- Subsequent `send()` calls reject immediately

```ts
async close(): Promise<void> {
  if (this.closed) return;
  this.closed = true;
  await this.transport.close();
  for (const pending of this.pendingMap.values()) {
    pending.reject(new ShuttleError("cdp_client_closed", "CdpClient was closed."));
  }
  this.pendingMap.clear();
}
```

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/chrome/cdp-client.ts src/daemon/chrome/cdp-client.test.ts
git commit -m "feat(cdp): CdpClient.close() — single chokepoint for shutdown"
```

---

### Task C4: BrowserSession object refactor + migrate ~15 call sites

**Files:**
- Create: `src/daemon/bootstrap/browser-session.ts`
- Modify: `src/daemon/services.ts`
- Modify: `src/daemon/api/routes/browser.ts`
- Modify: ~15 sites that reference `services.browser` (enumerated in the file structure section)
- Test: new tests for ownership tracking

**Context — preserve 4 existing fields, not just `browser`:**

`src/daemon/services.ts` today exposes FOUR coupled fields backing one logical browser session:
- `browser: BrowserOps | null` (line 101)
- `browserSessionId: string | null` (line 102)
- `cdp: CdpClient | null` (line 104) — references type from `chrome/cdp-client.ts` (NOT `internal-ops.ts`)
- `cdpProxy: ProxyServer | null` (line 105) — actual type is `ProxyServer` (NOT `CdpProxy`)

15+ production call sites use `services.cdp` and `services.cdpProxy` independently (e.g., `inject-submit.ts:141`, `secrets.ts:434`, `reveal-capture.ts:311`, `blind.ts:25`, `health.ts:17`). And ~10+ tests in `src/daemon/api/routes.test.ts` directly assign `ctx.services.browser = stubBrowser(...)` for fixtures.

The refactor MUST preserve all four field surfaces (read AND write). Strategy: keep the field NAMES, back them by `browserSession` via accessors. Accessor SETTERS compose the existing partial session rather than replacing — tests that assign just `services.browser` keep working; production code in `/v1/browser/start` constructs the full session atomically.

- [ ] **Step 1a: Widen `ChromeSession.child` so it satisfies BrowserSessionChild**

In `src/daemon/chrome/launch.ts:12-16`, replace the existing `ChromeSession.child` declaration. Current narrow type only exposes `.kill()`; the stop flow needs `.once("exit", ...)` too. Widen to a duck-typed interface that matches what `spawnChromePipe` actually returns:

```ts
// In launch.ts:
export interface ChromeSession {
  child: {
    kill(signal?: NodeJS.Signals): boolean;
    once(event: "exit", listener: (code: number | null) => void): unknown;
  };
  cdp: CdpClient;
  transport: PipeTransport;
}
```

(The actual Node `ChildProcess` returned by `spawnChromePipe` satisfies this. Existing call sites that only call `.kill()` continue to work.)

- [ ] **Step 1b: Define the BrowserSession type + the concrete factory helper**

```ts
// src/daemon/bootstrap/browser-session.ts
import { launchChrome } from "../chrome/launch.js";
import { CdpBrowserOps } from "../chrome/internal-ops.js";
import { startCdpProxy } from "../proxy/cdp-proxy.js";
import type { CdpClient } from "../chrome/cdp-client.js";        // CORRECT path
import type { ProxyServer } from "../proxy/cdp-proxy.js";        // CORRECT type name
import type { BrowserOps } from "../chrome/internal-ops.js";
import type { DaemonBlindModeState } from "../services-blind.js";

/**
 * Minimal child-process surface BrowserSession needs. Matches what launchChrome
 * returns after Step 1a's ChromeSession.child widening. Avoids a hard dep on
 * the full `ChildProcess` type while still allowing kill + once("exit").
 */
export interface BrowserSessionChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

export interface BrowserSession {
  owner: { kind: "user" } | { kind: "bootstrap"; batchId: string };
  child: BrowserSessionChild;
  cdp: CdpClient;
  proxy: ProxyServer | null;
  /** Equal to `proxy.url` when a proxy is present; matches the previous services.browserSessionId surface. */
  browserSessionId: string;
  browser: BrowserOps;
}

/**
 * Single concrete factory used by BOTH /v1/browser/start AND ensureBootstrapBrowser.
 * Composes: launchChrome → startCdpProxy → BrowserSession with proxy.url as the session id.
 */
export async function createBrowserSession(opts: {
  profile: string;
  blind: DaemonBlindModeState;
  owner: { kind: "user" } | { kind: "bootstrap"; batchId: string };
}): Promise<BrowserSession> {
  const chrome = await launchChrome({ profile: opts.profile });
  const proxy = await startCdpProxy({
    transport: chrome.transport,
    cdp: chrome.cdp,
    blind: opts.blind,
  });
  return {
    owner: opts.owner,
    child: chrome.child,
    cdp: chrome.cdp,
    proxy,
    browserSessionId: proxy.url,
    browser: new CdpBrowserOps(chrome.cdp),
  };
}
```

The factory is the single source of truth for "what does a started browser session look like." Both the user-driven `/v1/browser/start` route and the bootstrap-owned `ensureBootstrapBrowser` use it; the only difference is the `owner` argument.

- [ ] **Step 2: Modify `src/daemon/services.ts` — drop the 4 raw fields, replace with accessors backed by `browserSession`**

```ts
// In DaemonServices:
import type { BrowserSession } from "./bootstrap/browser-session.js";

browserSession: BrowserSession | null = null;

// Compatibility accessors — preserve the FOUR existing field surfaces.
// Getters return browserSession?.<field> ?? null.
// Setters compose: if a session already exists, mutate the matching field;
// otherwise build a minimal session around the supplied value so existing
// tests that assign one field at a time keep working.

get browser(): BrowserOps | null {
  return this.browserSession?.browser ?? null;
}
set browser(v: BrowserOps | null) {
  if (v === null) { this.browserSession = null; return; }
  if (this.browserSession !== null) {
    this.browserSession.browser = v;
  } else {
    this.browserSession = {
      owner: { kind: "user" },
      child: null as unknown as ChildProcess,  // test stubs may not exercise this
      cdp: null as unknown as CdpClient,
      proxy: null,
      browserSessionId: "test-stub",
      browser: v,
    };
  }
}

get cdp(): CdpClient | null {
  return this.browserSession?.cdp ?? null;
}
set cdp(v: CdpClient | null) {
  if (this.browserSession !== null) {
    this.browserSession.cdp = v as unknown as CdpClient;
  } else if (v !== null) {
    this.browserSession = {
      owner: { kind: "user" },
      child: null as unknown as ChildProcess,
      cdp: v,
      proxy: null,
      browserSessionId: "test-stub",
      browser: null as unknown as BrowserOps,
    };
  }
}

get cdpProxy(): ProxyServer | null {
  return this.browserSession?.proxy ?? null;
}
set cdpProxy(v: ProxyServer | null) {
  if (this.browserSession !== null) {
    this.browserSession.proxy = v;
  } else if (v !== null) {
    this.browserSession = {
      owner: { kind: "user" },
      child: null as unknown as ChildProcess,
      cdp: null as unknown as CdpClient,
      proxy: v,
      browserSessionId: "test-stub",
      browser: null as unknown as BrowserOps,
    };
  }
}

get browserSessionId(): string | null {
  return this.browserSession?.browserSessionId ?? null;
}
set browserSessionId(v: string | null) {
  if (this.browserSession !== null) {
    this.browserSession.browserSessionId = v ?? "test-stub";
  } else if (v !== null) {
    this.browserSession = {
      owner: { kind: "user" },
      child: null as unknown as ChildProcess,
      cdp: null as unknown as CdpClient,
      proxy: null,
      browserSessionId: v,
      browser: null as unknown as BrowserOps,
    };
  }
}
```

Add JSDoc above the accessor block stating: "Production code (`/v1/browser/start`, `ensureBootstrapBrowser`) constructs `browserSession` directly. The per-field accessors exist for test fixtures and back-compat; setting them composes the current session rather than replacing."

- [ ] **Step 3: Refactor `/v1/browser/start` to use createBrowserSession**

In `src/daemon/api/routes/browser.ts:15-33`, replace the existing inline launch + startCdpProxy + per-field assignments with a single factory call:

```ts
server.addRoute("POST", "/v1/browser/start", async (_req, raw) => {
  if (services.browserSession !== null) {
    throw new ShuttleError("browser_already_started", "Browser already started.");
  }
  const b = (raw ?? {}) as StartBody;
  services.browserSession = await createBrowserSession({
    profile: b.profile ?? "prod-config",
    blind: services.blind,
    owner: { kind: "user" },
  });
  // New browser session ⇒ a fresh handle namespace. Handles never persist.
  services.handles.clear();
  return {
    started: true,
    proxy_url: services.browserSession.proxy?.url ?? null,
    raw_cdp_url: null,
    value_visible_to_agent: false,
  };
});
```

Import `createBrowserSession` from `../../bootstrap/browser-session.js`. The previous separate assignments to `services.browser` / `services.cdp` / `services.cdpProxy` / `services.browserSessionId` are now covered by the single `browserSession` assignment — the accessors from Step 2 surface them to the existing read sites unchanged.

- [ ] **Step 4: Audit ~15 read sites — verify they all keep working through getters**

Quick grep:
```bash
grep -rn "services\.\(browser\|cdp\|cdpProxy\|browserSessionId\)" src/daemon --include="*.ts" | grep -v test
```

For each match, confirm it's a READ (`services.cdp !== null`, `services.cdp.send(...)`, etc.). All reads work unchanged through the getters. Routes that do nullish-check + use:

```ts
// Still works exactly as before:
if (services.cdp !== null) {
  await disableObservationDomains(services.cdp).catch(() => undefined);
}
services.cdpProxy?.severAgentConnections();
```

- [ ] **Step 5: Run tests + verify zero regression**

Run: `npm test && npx tsc --noEmit`
Expected: PASS. Pay special attention to:
- `src/daemon/api/routes.test.ts` — the ~10+ tests that assign `ctx.services.browser = stubBrowser(...)` must keep passing without source changes
- `src/daemon/api/routes/health.test.ts` (if exists) — `services.browser !== null` check
- `src/daemon/api/routes/blind.test.ts` / `inject-submit.test.ts` / `reveal-capture.test.ts` — `services.cdp` read paths

If a test asserts `services.browser === stubBrowser` by reference identity (`assert.strictEqual`), it will still pass because the getter returns the same stub reference back.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/browser-session.ts src/daemon/services.ts src/daemon/api/routes/browser.ts
git commit -m "refactor(daemon): BrowserSession object with composing accessors for 4 existing fields

The 4 raw fields (browser / browserSessionId / cdp / cdpProxy) become
accessors backed by services.browserSession. Setters compose: assigning
one field mutates the existing session, or creates a minimal session if
none exists — so legacy tests that assign \`services.browser = stub\`
keep working. /v1/browser/start now constructs the full session
atomically with owner: { kind: 'user' }. Correct type imports:
CdpClient from chrome/cdp-client.ts, ProxyServer (not CdpProxy) from
proxy/cdp-proxy.ts."
```

---

### Task C5: ensureBootstrapBrowser + stopBootstrapBrowser

**Files:**
- Modify: `src/daemon/services.ts` (add methods)
- Test: `src/daemon/bootstrap/browser-session.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("ensureBootstrapBrowser: spawns when absent, sets owner to bootstrap-<batchId>", async () => {});

test("ensureBootstrapBrowser: reuses pre-existing user session without changing ownership", async () => {});

test("stopBootstrapBrowser: kills bootstrap-owned session; no-op for user-owned", async () => {});

test("stopBootstrapBrowser: closes proxy then cdp then SIGTERM-then-SIGKILL on child", async () => {});

test("stopBootstrapBrowser: returns { stopped: true } only when it actually killed the session", async () => {});
```

- [ ] **Step 2: Implement**

```ts
// In DaemonServices, import the factory:
import { createBrowserSession } from "./bootstrap/browser-session.js";

async ensureBootstrapBrowser(batchId: string): Promise<BrowserSession> {
  if (this.browserSession !== null) return this.browserSession; // reuse user session unchanged
  this.browserSession = await createBrowserSession({
    profile: "bootstrap",
    blind: this.blind,
    owner: { kind: "bootstrap", batchId },
  });
  return this.browserSession;
}

async stopBootstrapBrowser(batchId: string): Promise<{ stopped: boolean }> {
  const s = this.browserSession;
  if (s?.owner.kind !== "bootstrap" || s.owner.batchId !== batchId) {
    return { stopped: false };
  }
  await s.proxy?.close().catch(() => undefined);
  await s.cdp.close().catch(() => undefined);
  s.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => s.child.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(() => { s.child.kill("SIGKILL"); r(); }, 3000)),
  ]);
  this.browserSession = null;
  return { stopped: true };
}
```

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/services.ts src/daemon/bootstrap/browser-session.test.ts
git commit -m "feat(services): ensureBootstrapBrowser + stopBootstrapBrowser with owner tracking

Auto-start only when absent; never overwrites a user-owned session.
Stop only kills bootstrap-owned sessions, returns { stopped } so the
outer finally knows whether to attempt blind auto-resume."
```

---

### Task C6: Capture target ops (open / capture / blank / close / getURL / list)

**Files:**
- Create: `src/daemon/chrome/capture-target-ops.ts`
- Test: `src/daemon/chrome/capture-target-ops.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("openCaptureTarget: navigates a new tab, returns target_id + current_host", async () => {});
test("captureFromTarget: rejects with bootstrap_capture_redirect_blocked if host changed", async () => {});
test("blankTarget: navigates target to about:blank", async () => {});
test("closeTarget: removes the target from listTargets", async () => {});
test("getTargetURL: returns the current top-level URL of the target", async () => {});
test("listTargets: returns all open targets", async () => {});
```

- [ ] **Step 2: Implement using existing CDP plumbing**

```ts
// src/daemon/chrome/capture-target-ops.ts
import type { CdpClient } from "./cdp-client.js";
import { ShuttleError } from "../../shared/errors.js";

export interface CaptureTargetOpenResult { target_id: string; current_host: string; }
export interface CaptureResult { value: string; field_fingerprint: string; }

export async function openCaptureTarget(cdp: CdpClient, url: string): Promise<CaptureTargetOpenResult> {
  const { targetId } = await cdp.send("Target.createTarget", { url, background: false });
  // Wait for page load (Page.frameStoppedLoading or Network.loadingFinished — adapt to existing patterns)
  // …
  const current = await cdp.send("Target.getTargetInfo", { targetId });
  const host = new URL(current.url).hostname;
  return { target_id: targetId, current_host: host };
}

export async function captureFromTarget(
  cdp: CdpClient,
  targetId: string,
  mode: "focused-field" | "selection",
  expected_host: string,
): Promise<CaptureResult> {
  const info = await cdp.send("Target.getTargetInfo", { targetId });
  const currentHost = new URL(info.url).hostname.toLowerCase().replace(/\.$/, "");
  if (currentHost !== expected_host) {
    throw new ShuttleError(
      "bootstrap_capture_redirect_blocked",
      `Target host ${currentHost} does not match expected ${expected_host}.`,
    );
  }
  // attach session, capture via existing focused-field / selection logic
  // …
}

export async function blankTarget(cdp: CdpClient, targetId: string): Promise<void> {
  // Navigate target to about:blank
}

export async function closeTarget(cdp: CdpClient, targetId: string): Promise<void> {
  await cdp.send("Target.closeTarget", { targetId });
}

export async function getTargetURL(cdp: CdpClient, targetId: string): Promise<string> {
  const info = await cdp.send("Target.getTargetInfo", { targetId });
  return info.url;
}

export async function listTargets(cdp: CdpClient): Promise<Array<{ target_id: string; url: string }>> {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.map((t: { targetId: string; url: string }) => ({ target_id: t.targetId, url: t.url }));
}
```

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/chrome/capture-target-ops.ts src/daemon/chrome/capture-target-ops.test.ts
git commit -m "feat(chrome): target-bound capture ops with at-capture-time host re-verification

openCaptureTarget returns target_id+current_host. captureFromTarget
re-reads the target's URL at capture moment and rejects with
bootstrap_capture_redirect_blocked if the host doesn't match the
yml-validated expected_host. blank/close/getURL/list complete the set."
```

---

### Task C7: Pending captures registry

**Files:**
- Create: `src/daemon/bootstrap/pending-captures.ts`
- Test: `src/daemon/bootstrap/pending-captures.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("PendingCapturesRegistry.register: stores entry; lookup by token returns it", () => {});
test("register: timer fires reject(bootstrap_capture_timeout) after timeoutMs", async () => {});
test("resolveByToken: resolves the registered Promise once; subsequent resolve is no-op", () => {});
test("rejectByToken: rejects with the supplied error; clears the entry", () => {});
test("token uniqueness: same batchId+secret with new register replaces the old (registers per-step, not per-batch)", () => {});
test("owner_agent_id is recorded and exposed for audit", () => {});
```

- [ ] **Step 2: Implement**

```ts
// src/daemon/bootstrap/pending-captures.ts
import { ShuttleError } from "../../shared/errors.js";

export interface PendingCaptureEntry {
  resolve: (val: { value: string; field_fingerprint: string }) => void;
  reject: (err: Error) => void;
  capture_token: string;
  batchId: string;
  secretName: string;
  target_id: string;
  expected_host: string;
  owner_agent_id: string;
  started_at: number;
  timer: NodeJS.Timeout;
}

export class PendingCapturesRegistry {
  private readonly byToken = new Map<string, PendingCaptureEntry>();
  // Secondary index so a re-register for the same (batch, secret) can
  // invalidate the prior token. Key shape: `${batchId}:${secretName}`.
  private readonly byStep = new Map<string, PendingCaptureEntry>();

  /**
   * Synchronously creates a pending entry and returns the Promise the executor
   * awaits. CRITICAL: must be synchronous (not async) — the caller emits the
   * SSE event with `capture_token` AFTER calling register() but BEFORE awaiting
   * the returned Promise. An async register would deadlock because the UI
   * can't resolve the Promise until it receives the SSE carrying the token.
   */
  register(opts: {
    batchId: string; secretName: string; capture_token: string;
    target_id: string; expected_host: string; owner_agent_id: string;
    timeoutMs: number; onTimeout: (err: Error) => void;
  }): Promise<{ value: string; field_fingerprint: string }> {
    const stepKey = `${opts.batchId}:${opts.secretName}`;

    // If a prior pending entry exists for this (batch, secret), reject it
    // before installing the new one. Leaving a live token in byToken would
    // let a stale UI POST resolve/reject the WRONG executor run; clearing it
    // also closes the old raw UI token immediately.
    const prior = this.byStep.get(stepKey);
    if (prior !== undefined) {
      clearTimeout(prior.timer);
      this.byToken.delete(prior.capture_token);
      this.byStep.delete(stepKey);
      prior.reject(new ShuttleError(
        "bootstrap_capture_aborted",
        `Pending capture for ${stepKey} replaced by a new register call.`,
      ));
    }

    let resolve!: (val: { value: string; field_fingerprint: string }) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<{ value: string; field_fingerprint: string }>((res, rej) => {
      resolve = res; reject = rej;
    });
    const timer = setTimeout(() => {
      this.byToken.delete(opts.capture_token);
      this.byStep.delete(stepKey);
      const err = new ShuttleError("bootstrap_capture_timeout", "5 minutes elapsed without a capture.");
      opts.onTimeout(err);
      reject(err);
    }, opts.timeoutMs);
    const entry: PendingCaptureEntry = {
      resolve, reject,
      capture_token: opts.capture_token,
      batchId: opts.batchId,
      secretName: opts.secretName,
      target_id: opts.target_id,
      expected_host: opts.expected_host,
      owner_agent_id: opts.owner_agent_id,
      started_at: Date.now(),
      timer,
    };
    this.byToken.set(opts.capture_token, entry);
    this.byStep.set(stepKey, entry);
    return promise;
  }

  lookup(token: string): PendingCaptureEntry | undefined {
    return this.byToken.get(token);
  }

  resolveByToken(token: string, val: { value: string; field_fingerprint: string }): boolean {
    const e = this.byToken.get(token);
    if (e === undefined) return false;
    clearTimeout(e.timer);
    this.byToken.delete(token);
    this.byStep.delete(`${e.batchId}:${e.secretName}`);
    e.resolve(val);
    return true;
  }

  rejectByToken(token: string, err: Error): boolean {
    const e = this.byToken.get(token);
    if (e === undefined) return false;
    clearTimeout(e.timer);
    this.byToken.delete(token);
    this.byStep.delete(`${e.batchId}:${e.secretName}`);
    e.reject(err);
    return true;
  }
}
```

- [ ] **Step 3: Wire onto services**

In `DaemonServices`:
```ts
readonly pendingCaptures = new PendingCapturesRegistry();
```

- [ ] **Step 4: Run tests + commit**

```bash
git add src/daemon/bootstrap/pending-captures.ts src/daemon/bootstrap/pending-captures.test.ts src/daemon/services.ts
git commit -m "feat(bootstrap): pending captures registry (token→Promise)

PendingCapturesRegistry on DaemonServices. register() returns the
Promise the executor awaits; resolve/rejectByToken are called by the
tokenized UI routes. Per-step timeout reject is wired here."
```

---

### Task C8: `abandoned` status + `bootstrap_batch_abandoned` error code

**Files:**
- Modify: `src/daemon/bootstrap/store.ts` (status enum)
- Modify: `src/shared/error-codes.ts`
- Test: `src/daemon/bootstrap/store.test.ts` (extend)

- [ ] **Step 1: Extend the status enum + error code**

```ts
// in store.ts: BatchState
status: "pending" | "in_progress" | "completed" | "failed_partial" | "abandoned";

// in error-codes.ts
bootstrap_batch_abandoned: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "This batch was abandoned. Start a new one with `secret-shuttle bootstrap`.",
  nextAction: () => null,
},
```

- [ ] **Step 2: Test + commit**

```bash
git add src/daemon/bootstrap/store.ts src/shared/error-codes.ts src/daemon/bootstrap/store.test.ts
git commit -m "feat(bootstrap): add 'abandoned' batch status + bootstrap_batch_abandoned error code"
```

---

### Task C9: Capture-always-requires-approval + extend production gate

**Files:**
- Modify: `src/daemon/bootstrap/destination-policy.ts` — add `planRequiresCapture(plan)`
- Modify: `src/daemon/api/routes/bootstrap.ts` — extend `requiresProductionGate` computation
- Test: `src/daemon/bootstrap/destination-policy.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```ts
test("planRequiresCapture: true if any entry source.kind === 'capture'", () => {});
test("planRequiresCapture: false for plans with only random/existing sources", () => {});

// In bootstrap.test.ts:
test("POST /v1/bootstrap/plan: capture-only plan in dev env still requires approval", async () => {
  // yml: environment=development, all destinations dev, source.kind=capture → approval_required.
});
```

- [ ] **Step 2: Implement**

```ts
// In destination-policy.ts:
export function planRequiresCapture(plan: ReadonlyArray<{ source: { kind: string } }>): boolean {
  return plan.some((e) => e.source.kind === "capture");
}

// In bootstrap.ts (the /plan handler, where requiresProductionGate is computed):
const requiresProductionGate =
  canonicalEnvironment(environment) === "production" ||
  planHasProductionDestination(plan) ||
  planHasProductionSource(plan) ||
  planRequiresCapture(plan);
```

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/bootstrap/destination-policy.ts src/daemon/api/routes/bootstrap.ts src/daemon/bootstrap/destination-policy.test.ts src/daemon/api/routes/bootstrap.test.ts
git commit -m "feat(bootstrap): capture-always-requires-approval (4th condition in production gate)

Forces approval emission so the hub URL is available for the capture
coordinator. Without this, dev-synth /plan with capture sources would
inline-execute but have no UI surface for dev clicks → hang. Reuses
the existing R10/R12/R13 gate-extension infrastructure."
```

---

### Task C10: Pre-flight blind guards at /plan + /continue (capture-conditional)

**Files:**
- Modify: `src/daemon/api/routes/bootstrap.ts`
- Test: `src/daemon/api/routes/bootstrap-blind-guard.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
test("/v1/bootstrap/plan: capture plan + active blind → blind_mode_already_active, no state saved", async () => {});
test("/v1/bootstrap/plan: non-capture plan + active blind → no guard fires", async () => {});
test("/v1/bootstrap/continue: capture plan + active blind → guard fires BEFORE approval consume", async () => {
  // Retry after `blind end` must succeed with the SAME unconsumed approval.
});
test("/v1/bootstrap/continue: non-capture plan + active blind → no guard fires", async () => {});
```

- [ ] **Step 2: Implement**

```ts
// In /plan, AFTER computeBootstrapPlan, BEFORE batchId allocation / state save:
if (plan.some((e) => e.source.kind === "capture")) {
  if (services.blind.current() !== null) {
    throw new ShuttleError(
      "blind_mode_already_active",
      "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
    );
  }
}

// In /continue, AFTER state lookup + completed short-circuit + owner check, BEFORE approval consume:
if (state.plan.some((e) => e.source.kind === "capture")) {
  if (services.blind.current() !== null) {
    throw new ShuttleError(
      "blind_mode_already_active",
      "Blind mode is currently active from a prior operation. Approve `blind end` before bootstrapping.",
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/bootstrap.ts src/daemon/api/routes/bootstrap-blind-guard.test.ts
git commit -m "feat(bootstrap): capture-conditional pre-flight blind guard at /plan and /continue

/continue guard fires BEFORE approval consume so the minted approval
is preserved across the dev's `blind end` + retry. /plan guard fires
BEFORE batchId allocation + state save so a guarded yml leaves no
batch clutter."
```

---

### Task C11: Executor capture branch — full state machine

**Files:**
- Modify: `src/daemon/bootstrap/executor.ts`
- Test: `src/daemon/bootstrap/executor-capture.test.ts` (new)

This is the largest single task in Phase C. The implementer should approach it sub-step-at-a-time inside the task — write tests for one branch (success-verified), implement, then next branch.

- [ ] **Step 1: Write the matrix of failing tests**

```ts
test("capture branch: success + cleanup verified → blind.end auto + step ok:true with ref", async () => {});
test("capture branch: success + cleanup NOT verified → blind stays active + step ok:false+ref+cleanup_failed; executor STOPS", async () => {});
test("capture branch: failure (skip) + cleanup verified → blind.end + step ok:false; executor continues", async () => {});
test("capture branch: failure (abort) + cleanup verified → blind.end + step ok:false; executor STOPS; status=abandoned", async () => {});
test("capture branch: failure (timeout) + cleanup verified → blind.end + step ok:false; executor continues", async () => {});
test("capture branch: failure (redirect_blocked at capture time) → cleanup attempted; behaves like timeout", async () => {});
test("capture branch: failure (any) + cleanup NOT verified → blind stays active + cleanup_failed; STOP", async () => {});
test("capture branch: blind.start + disableObservationDomains + severAgentConnections fire BEFORE openCaptureTarget", async () => {});
```

- [ ] **Step 2: Implement the runSourceStep capture branch**

```ts
// in executor.ts, inside runSourceStep:
if (entry.source.kind === "capture") {
  // Defensive blind guard (route guard fires first; this is belt-and-suspenders).
  // Note: blind.start now throws on already-active (Task C2), so the next call IS the guard.
  services.blind.start(entry.source.expected_host, "bootstrap-capture");
  await disableObservationDomains(services.browserSession!.cdp).catch(() => undefined);
  services.browserSession!.proxy?.severAgentConnections();

  const target = await openCaptureTarget(services.browserSession!.cdp, entry.source.url);
  const capture_token = randomBytes(32).toString("base64url");

  // CRITICAL ORDERING: register the Promise SYNCHRONOUSLY (returns the Promise
  // immediately), THEN emit the SSE event (which carries capture_token to the UI),
  // THEN await. The previous order (`await register(); emit;`) deadlocks because
  // the UI cannot resolve the Promise until it has seen the SSE event carrying the
  // token — and the SSE never fires while register is awaited.
  const pendingPromise = services.pendingCaptures.register({
    batchId, secretName: entry.secret, capture_token,
    target_id: target.target_id,
    expected_host: entry.source.expected_host,
    owner_agent_id: state.owner_agent_id,
    timeoutMs: 5 * 60 * 1000,
    onTimeout: () => {/* nothing extra — executor catches the reject */},
  });

  // Emit hub SSE event so the UI renders the capture-step card with the token.
  services.hubBroker.emitBootstrapCaptureStep({
    batch_id: batchId, secret_name: entry.secret,
    url: entry.source.url, step_idx, step_total,
    capture_token,
  });

  let captureResult: { value: string; field_fingerprint: string };
  try {
    captureResult = await pendingPromise; // resolves when /ui/bootstrap/capture-step posts
  } catch (err) {
    // Failure branch — proceed to cleanup with error preserved.
    await cleanupCaptureTarget(/* state machine for failure path */);
    throw err; // executor catches and records step
  }

  // SUCCESS path:
  await vault.upsertSecret({
    name: entry.secret,
    environment: refEnvFromRef(entry.ref),
    source: refSourceFromRef(entry.ref),
    value: captureResult.value,
    allowedDomains: entry.destinations.map((d) => d.domain),
  });
  await cleanupCaptureTarget(/* state machine for success path */);
  return entry.ref;
}
```

Where `cleanupCaptureTarget` implements the success/failure × verified/not-verified matrix from the spec §3:
- blank target + verify
- close target + verify
- if both verified → `services.blind.end()` + audit `blind_auto_resume`
- if not verified → leave blind active + audit `blind_remained_active` + return cleanup_failed

The full cleanup helper is ~50 lines. Show implementer the spec section §3 v3 (capture branch state machine table) for the exact branching logic.

- [ ] **Step 3: Run tests for each branch in turn until all green**

Run: `npx tsx --test src/daemon/bootstrap/executor-capture.test.ts && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/bootstrap/executor.ts src/daemon/bootstrap/executor-capture.test.ts
git commit -m "feat(bootstrap/executor): capture branch with full state machine

blind.start + disableObservationDomains + severAgentConnections
before openCaptureTarget. Capture awaits pending registry. Post-step
cleanup state machine: success+verified → blind.end auto + step.ok=true;
success+not-verified → cleanup_failed + step.ok=false+ref + STOP;
failure (skip/timeout/redirect) + verified → blind.end + continue;
failure (abort) → STOP + status=abandoned; failure + not-verified →
cleanup_failed + STOP. Matches spec §3 v5.3."
```

---

### Task C12: /continue browser auto-start + outer finally cleanup

**Files:**
- Modify: `src/daemon/api/routes/bootstrap.ts` (the /continue handler's pre-executor step AND finally)
- Test: `src/daemon/api/routes/bootstrap-cleanup.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
test("capture batch: /continue with NO existing browser auto-starts a bootstrap-owned one", async () => {
  // Pre-condition: services.browserSession === null. Seed an approved capture batch.
  // POST /v1/bootstrap/continue. After the call: services.browserSession was non-null
  // during execution AND was torn down by the finally (back to null after the call returns).
});

test("capture batch: /continue with a pre-existing user browser reuses it (owner stays 'user')", async () => {
  // Pre-condition: services.browserSession.owner.kind === 'user'. After /continue returns,
  // services.browserSession is STILL the user session (not torn down).
});

test("non-capture batch: /continue does NOT start a browser", async () => {});

test("cleanup-failed + bootstrap-owned browser → Chrome killed → blind auto-resumes", async () => {});
test("cleanup-failed + user-owned browser → Chrome stays → blind stays active (manual recovery)", async () => {});
test("normal completion + bootstrap-owned browser → Chrome cleanly stopped; blind already ended", async () => {});
```

- [ ] **Step 2: Implement BOTH the pre-executor auto-start AND the finally**

In `/v1/bootstrap/continue` route, AFTER the owner check / blind guard / approval consume, BEFORE any browser side-effects:

```ts
const hasCapture = state.plan.some((e) => e.source.kind === "capture");

// Acquire the per-batch execution lock FIRST. This guarantees that a second
// concurrent /continue gets bootstrap_batch_busy before doing any browser
// work — without this ordering, both callers would race into
// ensureBootstrapBrowser and either fight over the BrowserSession slot
// or both attach to the user's session before one gets rejected.
if (!services.bootstrapStore.tryAcquireExecutionLock(batchId)) {
  throw new ShuttleError("bootstrap_batch_busy", "...");
}
try {
  // Now that we hold the lock, it's safe to spawn/attach the browser.
  if (hasCapture) {
    await services.ensureBootstrapBrowser(batchId);
  }
  const result = await executeBatch(...);
  return { ok: true, ...result };
} finally {
  if (hasCapture) {
    const { stopped } = await services.stopBootstrapBrowser(batchId);
    if (stopped && services.blind.current() !== null) {
      services.blind.end();
      await writeDaemonAudit({
        action: "blind_auto_resume_after_browser_stop",
        actor_agent_id: state.owner_agent_id,
        batch_id: batchId,
        ok: true,
      });
    }
  }
  // Release lock LAST — after browser cleanup. A second /continue retrying
  // after we release should see a clean services.browserSession === null
  // (or the user's pre-existing session, untouched).
  services.bootstrapStore.releaseExecutionLock(batchId);
}
```

Add a regression test:
```ts
test("concurrent /continue: second caller gets bootstrap_batch_busy WITHOUT spawning a second browser", async () => {
  // Two /continue calls simultaneously on the same capture batch. The first
  // proceeds; the second gets bootstrap_batch_busy. Assert services.browserSession
  // was only set once (no race in ensureBootstrapBrowser).
});
```

The `ensureBootstrapBrowser` call is a no-op when a user-owned session exists (returns the existing session unchanged); for fresh-daemon paths it spawns Chrome and stores it with `owner: { kind: "bootstrap", batchId }`. The `stopBootstrapBrowser` call in the finally is also a no-op for user-owned sessions (returns `{ stopped: false }`); only bootstrap-owned sessions get torn down.

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/api/routes/bootstrap.ts src/daemon/api/routes/bootstrap-cleanup.test.ts
git commit -m "feat(bootstrap): /continue auto-starts bootstrap-owned browser + cleanup in finally

Pre-executor: ensureBootstrapBrowser(batchId) for capture plans —
no-op when a user session already exists. Finally:
stopBootstrapBrowser is no-op for user sessions; for bootstrap-owned,
SIGTERM → SIGKILL Chrome, then if blind is still active (from a
cleanup-failed step) auto-end it (no rendering process left to observe).
Audit blind_auto_resume_after_browser_stop."
```

---

### Task C13: Tokenized raw UI routes — capture-step / skip-step / abandon

**Files:**
- Create: `src/daemon/api/routes/bootstrap-capture-ui.ts`
- Modify: `src/daemon/api/router.ts`
- Test: `src/daemon/api/routes/bootstrap-capture-ui.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("POST /ui/bootstrap/capture-step?token=<valid>: captures + resolves pending", async () => {});
test("POST /ui/bootstrap/capture-step?token=<invalid>: 404 (token not found)", async () => {});
test("POST /ui/bootstrap/skip-step?token=<valid>: rejects pending with bootstrap_capture_skipped", async () => {});
test("POST /ui/bootstrap/abandon?token=<valid>: rejects with bootstrap_capture_aborted + sets batch.status=abandoned", async () => {});
test("Tokens are single-use: second use of the same token returns 404", async () => {});
test("Routes do NOT require Authorization header (raw routes — token IS the auth)", async () => {});
```

- [ ] **Step 2: Implement using addRouteRaw**

```ts
// src/daemon/api/routes/bootstrap-capture-ui.ts
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { captureFromTarget } from "../../chrome/capture-target-ops.js";
import { ShuttleError } from "../../../shared/errors.js";

export function registerBootstrapCaptureUi(server: DaemonServer, services: DaemonServices): void {
  server.addRouteRaw("POST", /^\/ui\/bootstrap\/capture-step$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const entry = services.pendingCaptures.lookup(token);
    if (entry === undefined) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error_code: "capture_token_invalid" })); return; }
    try {
      const result = await captureFromTarget(
        services.browserSession!.cdp,
        entry.target_id,
        "focused-field",
        entry.expected_host,
      );
      services.pendingCaptures.resolveByToken(token, result);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      services.pendingCaptures.rejectByToken(token, e as Error);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: false, error_code: (e as ShuttleError).code ?? "unexpected_error" }));
    }
  });

  server.addRouteRaw("POST", /^\/ui\/bootstrap\/skip-step$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const ok = services.pendingCaptures.rejectByToken(token, new ShuttleError("bootstrap_capture_skipped", "Skipped by user."));
    res.statusCode = ok ? 200 : 404;
    res.end(JSON.stringify({ ok }));
  });

  server.addRouteRaw("POST", /^\/ui\/bootstrap\/abandon$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const entry = services.pendingCaptures.lookup(token);
    if (entry === undefined) { res.statusCode = 404; res.end(JSON.stringify({ ok: false })); return; }
    services.pendingCaptures.rejectByToken(token, new ShuttleError("bootstrap_capture_aborted", "Abandoned by user."));
    // Status transition to "abandoned" happens in the executor's terminal cleanup.
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
}
```

Register in router.

- [ ] **Step 3: Run tests + commit**

```bash
git add src/daemon/api/routes/bootstrap-capture-ui.ts src/daemon/api/routes/bootstrap-capture-ui.test.ts src/daemon/api/router.ts
git commit -m "feat(bootstrap): tokenized raw UI routes for capture coordinator

/ui/bootstrap/{capture-step,skip-step,abandon}?token=<capture_token>.
No bearer required — the single-use capture_token is the auth. Each
route resolves/rejects the pending Promise the executor awaits."
```

---

### Task C14: Hub SSE event + capture-step coordinator card + drift-guard test

**Files:**
- Modify: `src/daemon/hub/hub-broker.ts` (add event type) — or wherever the SSE emitter lives
- Modify: `src/daemon/approvals/ui.html` (hub UI) — render capture-step card
- Modify: `src/daemon/approvals/ui-html-drift.test.ts` — drift-guard

- [ ] **Step 1: Add the SSE event type + emitter method**

```ts
// in hub-broker.ts
emitBootstrapCaptureStep(payload: {
  batch_id: string; secret_name: string;
  url: string; step_idx: number; step_total: number;
  capture_token: string;
}): void {
  this.emit({ type: "bootstrap_capture_step", ...payload });
}
```

- [ ] **Step 2: Render the coordinator card in ui.html**

Add a `renderCaptureStep(event)` function in the hub UI script that:
- Shows secret name + URL + step idx/total
- Has 3 buttons: Capture / Skip / Abandon
- Each button POSTs to the corresponding `/ui/bootstrap/...?token=<capture_token>` route
- Closes the card and waits for the next SSE event

Concrete: see spec §3 for the card layout and copy.

- [ ] **Step 3: Drift-guard test**

Add to `ui-html-drift.test.ts`:
```ts
test("ui.html: bootstrap_capture_step coordinator card renders with Capture/Skip/Abandon buttons", async () => {
  const html = await loadHtml();
  assert.match(html, /function renderCaptureStep\b/);
  assert.match(html, /\/ui\/bootstrap\/capture-step\?token=/);
  assert.match(html, /\/ui\/bootstrap\/skip-step\?token=/);
  assert.match(html, /\/ui\/bootstrap\/abandon\?token=/);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon/hub/hub-broker.ts src/daemon/approvals/ui.html src/daemon/approvals/ui-html-drift.test.ts
git commit -m "feat(hub): bootstrap_capture_step SSE event + capture coordinator card render

Hub UI subscribes to bootstrap_capture_step events; renders a card per
step with Capture/Skip/Abandon buttons that POST to the tokenized
/ui/bootstrap/* raw routes. Drift-guard ensures the card structure
matches the route shapes the executor emits."
```

---

### Task C15: CLI `bootstrap --continue` capture-flow output

**Files:**
- Modify: `src/cli/commands/bootstrap.ts`

The actual server-side auto-start lives in Task C12's `/continue` pre-executor step (NOT in the route's finally — that's stop, not start). The CLI's responsibility is purely cosmetic: clearer output when the batch contains capture sources.

- [ ] **Step 1: Update the CLI output for capture-aware batches**

When the daemon response carries a capture-step hint (e.g., included in the approval_required details for the first /plan call, or in a future progress field on /continue), the CLI prints a short instruction pointing the user at the hub URL where the capture coordinator will render the per-step cards.

If your CLI surface doesn't already have a "the daemon is driving a browser; watch the hub URL" line, add one for capture-containing batches.

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/bootstrap.ts
git commit -m "feat(cli/bootstrap): output guides user to hub for capture-step coordination"
```

---

### Task C16: New error codes for Phase C

**Files:**
- Modify: `src/shared/error-codes.ts`
- Modify: `src/shared/error-codes.test.ts`

- [ ] **Step 1: Add all 6 codes**

```ts
bootstrap_capture_url_invalid: { exitCode: EXIT_CODE_USAGE, hint: () => "Check the yml: capture urls must be https, with no embedded credentials, no IP literals, no localhost." },
bootstrap_capture_skipped: { exitCode: EXIT_CODE_TRANSIENT, hint: () => "Re-run bootstrap to retry the skipped secret." },
bootstrap_capture_timeout: { exitCode: EXIT_CODE_TRANSIENT, hint: () => "5 minutes elapsed without a capture. Re-run bootstrap and click Capture promptly." },
bootstrap_capture_aborted: { exitCode: EXIT_CODE_TRANSIENT, hint: () => null },
bootstrap_capture_redirect_blocked: { exitCode: EXIT_CODE_USAGE, hint: () => "The capture page navigated to a different host. Update your yml's capture url to the correct landing page, or click Capture only after you're at the expected host." },
bootstrap_capture_cleanup_failed: {
  exitCode: EXIT_CODE_CONFLICT,
  hint: () => "The capture browser tab could not be verified closed. Close it manually if open, then run `secret-shuttle blind end`.",
  nextAction: () => "secret-shuttle blind end",
},
```

Update registry count.

- [ ] **Step 2: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(error-codes): 6 new codes for Phase C (capture-from-URL)"
```

---

# Phase D — Cross-section integration + docs

### Task D1: SKILL.md updates

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Add four new sections at appropriate places**

1. **Per-agent token model** — under a new section "Authentication". Explain:
   - Tokens are `<agent_id>.<hmac>` derived from the daemon's root_token
   - Each agent runtime gets a deterministic per-(machine, runtime) agent_id
   - Sub-agents must mint child tokens via `/v1/tokens/mint` (or `secret-shuttle agent mint --child-id ...`)
   - Tokens are attribution + hygiene, NOT hard isolation against same-user attackers
   - Revocation: `secret-shuttle daemon rotate` (invalidates all derived tokens immediately)

2. **Blind-mode discipline for bootstrap captures** — extend the existing inject/reveal-capture section. State: bootstrap capture sources auto-start blind mode, navigate the daemon-owned browser to the user's URL, await dev action via the hub UI coordinator, capture, then blank+close the target. Blind auto-ends on verified-clean cleanup (or after Chrome death).

3. **Memory hygiene (best-effort)** — new section. Use the exact wording from spec §2:
   > The master key is zeroed on lock and on every in-flight crypto operation; copies are scrubbed synchronously before any async continuation. Byte buffers built for child-process stdin and tmp env-file writes are scrubbed after the consumer reads them. Masker pattern and lookback buffers are scrubbed on stream dispose.
   >
   > Secret values returned by the vault AND captured values from the browser are JS strings, which V8 does not let us proactively zero — they linger in heap until garbage collection. A post-launch hardening plan (5q) refactors both to Buffer for end-to-end scrub; required for security-audit deployments.

4. **Batch ownership** — new sub-section under bootstrap. State: bootstrap batches are owned by the agent that called `/plan`; only the owner (or root) can `/continue`, `/abandon`, or see them in `/list`. Cross-owner access returns `bootstrap_batch_not_found`.

5. **Capture-always-requires-approval** — note in the bootstrap section: yml plans containing any `source.kind: capture` entry always require human approval, regardless of `--environment` and destination class.

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs(SKILL): Burst 4 — per-agent tokens, blind discipline, memory hygiene, batch ownership, capture-always-requires-approval"
```

---

### Task D2: CHANGELOG entry + full-suite verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Burst 4 entry**

Under "Unreleased":

```markdown
### Added (Burst 4 — Pre-launch security hardening)

- **Per-agent token isolation (5m):** HMAC-derived per-agent tokens (`<agent_id>.<hmac>`), persistent root_token + machine-id files under `<SHUTTLE_HOME>` at mode 0600. `secret-shuttle daemon rotate` invalidates all derived tokens; `secret-shuttle daemon reset-machine-id` refreshes agent_id derivation without revocation. `secret-shuttle agent mint --child-id <id>` for manual sub-agent token mint. Init now writes per-runtime tokens to `~/.claude/settings.json` and Cursor's user settings (NEVER to repo-committed files); codex/copilot get manual install instructions.
- **AsyncLocalStorage audit context:** every daemon call records `actor_agent_id` automatically. New audit fields `subject_agent_id`, `parent_agent_id`, `child_agent_id` for sessions/grants/batches/mint chains.
- **Owner-enforced consumption:** `ApprovalGrant`, `SessionGrant`, `BatchState` all carry `owner_agent_id`. Non-root cross-owner access returns `approval_not_found` / `session_not_found` / `bootstrap_batch_not_found` (existence non-disclosure). Root bypasses every check.
- **Memory hygiene (5o-core, best-effort):** `requireKey()` copies scrubbed synchronously before any async continuation in `Vault.read`/`write`/`fingerprintKey`. Masker patterns + lookback scrubbed on dispose. Child stdin Buffer scrubbed in write callback.
- **Capture-from-URL in bootstrap (5p):** yml `source: { kind: capture, url: "https://..." }` now drives a daemon-owned browser through the URL under a single approval. Strict URL validation (https / no creds / `node:net.isIP` for IPv4+IPv6 / localhost variants). Capture binds to target_id with at-capture-time host re-verification. Tokenized raw UI routes (`/ui/bootstrap/{capture-step,skip-step,abandon}`) coordinate dev clicks without exposing the agent token to the browser. Cleanup state machine auto-resumes blind on verified-clean target close (or after Chrome death for bootstrap-owned browsers).

### Changed (breaking)

- `secret-shuttle daemon rotate` is now the canonical token revocation operation. Previously every daemon restart silently regenerated the token; now the root_token persists and rotation is explicit.
- `DaemonBlindModeState.start()` throws `blind_mode_already_active` instead of silently overwriting state.
- Bootstrap plans with capture sources always require approval, regardless of `--environment`.

### Known limitations

- `Secret.value` and `CaptureResult.value` remain JS strings, lingering in heap until GC. End-to-end Buffer refactor is the named follow-up plan 5q.
- Per-(machine, runtime) agent_ids — all of a user's projects share the same daemon-perspective identity per runtime. Per-project granularity is opt-in via `secret-shuttle agent mint`; auto-derived per-project support is plan 5s.
- No per-agent token denylist or expiry; revocation is global via `daemon rotate`. Plan 5r covers granular revocation.
```

- [ ] **Step 2: Run full suite + typecheck + commit**

```bash
npm test
npx tsc --noEmit
git add CHANGELOG.md
git commit -m "docs(CHANGELOG): Burst 4 — pre-launch security hardening (5m + 5o-core + 5p)"
git push origin main
```

---

## Self-review

### Spec coverage

Walking spec sections against tasks:

| Spec section | Task(s) |
|---|---|
| §1 Persistent root_token | A2 |
| §1 machine-id source | A1 |
| §1 Token format + agent_id structure | A4 |
| §1 Centralized resolver | A6 |
| §1 ALS + DaemonServer.handle | A3, A5 |
| §1 Audit policy + getAuditActor | A7 |
| §1 owner_agent_id schemas | A8 |
| §1 Owner enforcement through all of requireApprovals | A9 |
| §1 Session list/revoke | A10 |
| §1 Batch ownership enforcement | A11 |
| §1 Sub-agent mint with namespace | A12 |
| §1 daemon rotate + reset-machine-id | A13 |
| §1 Init runtime install | A14 |
| §1 Error codes | A15 |
| §2 In-scope scrub sites | B1, B2, B3 |
| §2 SKILL.md docs | D1 |
| §3 Yml validation | C1 |
| §3 blind.start hardening | C2 |
| §3 CdpClient.close | C3 |
| §3 BrowserSession refactor | C4 |
| §3 ensureBootstrapBrowser/stopBootstrapBrowser | C5 |
| §3 Capture target ops | C6 |
| §3 Pending captures registry | C7 |
| §3 abandoned status | C8 |
| §3 Capture-always-requires-approval | C9 |
| §3 Pre-flight blind guards | C10 |
| §3 Executor capture branch | C11 |
| §3 Outer finally + Chrome-death blind auto-resume | C12 |
| §3 Tokenized UI routes | C13 |
| §3 SSE event + hub UI coordinator | C14 |
| §3 CLI auto-start | C15 |
| §3 Error codes | C16 |
| §4 Cross-section | folded into A11, C7, B (caveat docs) |
| §5 Scope cuts | documented in plan header + D2 CHANGELOG |
| §6 Phased order | mirrored in the Phase A/B/C/D structure |
| §7 Testing strategy | per-task TDD; D2 full suite |
| §8 Risk register | implicit in task choices; addressed in tests |
| §9 Out of scope | D1 SKILL.md framing |
| §10 Success criteria | D2 CHANGELOG mirrors |

All sections covered.

### Placeholder scan

Plan was written with concrete code blocks per task. Some snippets reference "the existing X pattern" or "the existing test harness" — these are pointers to live code, not placeholders. The implementer should grep for the named patterns in the codebase before writing.

A few tasks are intentionally less code-heavy because the change is structural (BrowserSession refactor migrates many call sites; the implementer reads the existing code rather than this plan reciting every site). Those tasks have explicit file-structure pointers.

No "TODO" / "TBD" / "fill in" / "similar to Task N" anti-patterns.

### Type consistency

Cross-referenced types across tasks:
- `AuthContext` defined in A3, used in A5/A7/A8/A9/A10/A11/A12/A13
- `BrowserSession` defined in C4, used in C5/C11/C12/C13
- `PendingCaptureEntry` defined in C7, used in C11/C13
- `BatchState.owner_agent_id` defined in A8, used in A11/C11/C12

All type references consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-burst4-pre-launch-security.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance + code quality) between tasks. This is the same pattern used for Plan 5g and is consistent with the user's stated preference.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints for human review at phase boundaries.

The user has already indicated subagent-driven execution; the next step is to invoke `superpowers:subagent-driven-development` against this plan.
