# Burst 7 — Identity & Memory Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two security-infrastructure plans forward-referenced since earlier bursts — opt-in per-project agent IDs (5s) and a scrubbable `SecretValue` Buffer use-path for plaintext-out-of-heap memory hygiene (5q) — plus the 5a keychain doc-comment correction, leaving the repo publish-ready as v0.4.0.

**Architecture:** All work lands on a `burst7/identity-memory-hardening` branch in a worktree at `.worktrees/burst7-identity-memory-hardening`. §1 (5s) extends `deriveAutoAgentId` with an optional `projectScope` parameter, adds a `resolveProjectScope` helper + an `identity.perProject` config loader, and wires an opt-in `init --per-project-identity` flag — back-compatible, no existing identity changes. §2 (5q) is a cross-cutting internal in-memory representation change: a new redaction-safe `SecretValue` class wraps secret plaintext as a scrubbable `Buffer`; a new `resolveSecret`/`resolveRefs` accessor returns a disposable `ResolvedSecret`; metadata/existence callers move to the value-free `Vault.inspect`→`AgentSecretMetadata`; `fingerprintSecret`/`fingerprintMatches` take `Buffer`; and every per-secret consumer adopts a two-phase late-resolve discipline (metadata-only preflight before the approval gate, plaintext resolve only after, dispose in `finally`). No HTTP wire-format change, no on-disk vault-format change (Tier A), no fingerprint migration. The Wrap corrects stale keychain doc comments, writes the CHANGELOG entry, and bumps the version. Each task commits independently — **except Tasks 2.4 → 2.5.7**, which are one logically-atomic, no-commit batch: the accessor split makes the whole tree tsc-red until every consumer is migrated, so the first commit lands only at the Step 2.5.7.4 green checkpoint (see the Sequencing note at Step 2.4.6).

**Tech Stack:** TypeScript strict ESM (ES2022/NodeNext), noUncheckedIndexedAccess + exactOptionalPropertyTypes, node:test, @napi-rs/keyring (already present).

---

## Code-Grounding Corrections (read first)

These are verified facts about the current codebase that the engineer needs before touching any task. Each was confirmed via direct `Read`/`grep` against the `main` branch at v0.3.1 (HEAD `6068aa9`). The names + signatures introduced in early tasks (`SecretValue`, `ResolvedSecret`, `resolveSecret`, `fingerprintSecret(Buffer)`) are used identically in later tasks — do not re-derive them.

1. **`deriveAutoAgentId` current shape** (`src/daemon/auth/agent-id.ts:30-33`):
   ```ts
   export function deriveAutoAgentId(runtime: string, machineId: string): string {
     const digest = createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex");
     return `${runtime}-${digest.slice(0, 16)}`;
   }
   ```
   `AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/` (`agent-id.ts:4`); `assertAgentIdValid` (`agent-id.ts:21`) also rejects `"root"`/`"daemon"`. The id format is `${runtime}-${16 hex}`.

2. **The one `deriveAutoAgentId` caller** is `src/cli/commands/init.ts:238`, inside the per-runtime mint loop `for (const runtime of runtimes)` (`init.ts:236`), after `const machineId = await readMachineId(getSecretShuttleHome())` (`init.ts:234`, `machineId` is `string | null` and the loop only runs when `machineId !== null`). The derived id flows into `daemonRequest(... "/v1/tokens/mint", { agent_id: agentId })` (`init.ts:239-243`) then `installAgentToken(runtime, agentId, token)` (`init.ts:244`).

3. **`loadInferConfig` is the defensive-config pattern to mirror** (`src/cli/provision/infer.ts:179-197`): reads `secret-shuttle.config.json` via `readFile(join(cwd, "secret-shuttle.config.json"), "utf8")`, `JSON.parse` in a `try`, guards `parsed === null || typeof parsed !== "object" || Array.isArray(parsed)` → `null`, reads a sub-key, guards it the same way, returns it; `catch { return null; }`. The 5s `identity.perProject` loader mirrors this exactly (missing file / malformed JSON / non-object / missing `identity` / non-boolean `perProject` → `false`).

4. **`SecretRecord.value: string`** (`src/vault/types.ts:38`) and **`UpsertSecretInput.value: string`** (`src/vault/types.ts:91`). The stored record keeps `value: string` (vault-internal / on-disk); only `UpsertSecretInput.value` changes to `SecretValue` in §2 write-path.

5. **`AgentSecretMetadata` has NO `value` field** (`src/vault/types.ts:45-63`) — it carries `id`/`ref`/`name`/`environment`/`source`/`created_at`/`updated_at`/`last_used_at`/`fingerprint`/`allowed_domains`/`allowed_actions`/`requires_approval`/`classification`/`value_visible_to_agent: false` (+ optional `description`/`deleted_at`). It is the no-value metadata accessor's return type.

6. **Vault accessor return types** (`src/vault/vault.ts`): `getSecret(ref): Promise<SecretRecord>` (`:132`, returns the string-valued stored record, throws `secret_not_found` for missing/soft-deleted); `inspect(ref): Promise<AgentSecretMetadata>` (`:123`, identical existence semantics — throws `secret_not_found` for missing/soft-deleted, no `value`); `resolveRefs(refs): Promise<Map<string, SecretRecord>>` (`:263`, dedupes, single-pass, fails fast); `upsertSecret(input): Promise<AgentSecretMetadata>` (`:60`); `generate(input): Promise<SecretRecord>` (`:181`, currently reads back via `return this.getSecret(ref)` at `:206`); `inspect`/`list`/`upsertSecret`/`generate` all already build their return via `toAgentMetadata(record)` (`:298`). `fingerprintKey(): Promise<Buffer>` (`:274`).

7. **`fingerprintSecret(value: string, key: Buffer): string`** (`src/vault/fingerprints.ts:3`) — `createHmac("sha256", key).update(value, "utf8").digest("hex")` prefixed `"hmac-sha256:"`. **`fingerprintMatches(value: string, fingerprint: string, key: Buffer): boolean`** (`:7`). Changing the `value` param from `string` to `Buffer` does NOT change the computed digest for identical bytes (HMAC over bytes), so **no stored-fingerprint migration**. `isLegacyFingerprint` (`:13`) is unchanged.

8. **`fingerprintSecret`/`fingerprintMatches` callers** (verified, the only non-test ones): vault-internal `fingerprintSecret(input.value, ...)` (`vault.ts:83`) + `fingerprintSecret(s.value, fpKey)` (`vault.ts:249`, the legacy-fingerprint migration loop) — both pass the stored string; the compare route `fingerprintMatches(capture.value, secret.fingerprint, fpKey)` (`secrets.ts:515`) — passes the browser-captured candidate string, NOT a stored/resolved secret.

9. **`generateSecretValue(kind: string): string` returns an ENCODED STRING** (`src/daemon/helpers/generate-value.ts:5`) — `randomBytes(32|64).toString("base64url" | "hex")`. The two generate producers wrap the encoded string via `SecretValue.fromUtf8(generateSecretValue(kind))` — **NOT** `SecretValue.fromBuffer(randomBytes(...))` (that would change the stored value + fingerprint from base64url/hex to raw binary).

10. **`crypto.ts` materializes the full plaintext as a JS string** — `encryptVault` runs `JSON.stringify(plaintext)` (`src/vault/crypto.ts:28`), `decryptVault` builds `Buffer.concat([...]).toString("utf8")` then `JSON.parse` (`crypto.ts:50-54`). **DO NOT change `crypto.ts`** — this Tier-A bulk-persist transient is explicitly out of scope (Tier B).

11. **`READ_SCRIPT` materializes `value`** (`src/daemon/chrome/internal-ops.ts:200-217`) — `window.getSelection()?.toString()` (`:209`), `a.value` (`:213`), `a.innerText` (`:214`) all land in the returned object. **`readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">>`** (`BrowserOps` interface `:179`; impl `:957-971`) **evaluates the same `READ_SCRIPT`** (`:959`) — the TS generic at `:959` omits `value`, but the CDP `Runtime.evaluate` result still surfaces the full object (incl. plaintext `value`) on the daemon heap. So this is NOT a value-free preflight today. §2 requires a genuine `READ_META_SCRIPT` that never reads selection/`.value`/`.innerText`. `captureSelection()` delegates to `captureFocused()` (`:990-992`).

12. **Browser/CDP value boundary is string** — `injectFocused`/`proveAbsence`/`injectIntoBackendNode` take `string` (`internal-ops.ts:178,185,186`); `captureFocused`/`captureSelection`/`readBackendNodeValue`/`resolveWithinContainer` return `string`; `WRITE_SCRIPT` builds via `JSON.stringify(value)` (`:245`). `CaptureResult.value: string`. Accepted protocol boundary — converting `.bytes().toString("utf8")` only at the sink.

13. **`assertSecretActionAllowed(secret: SecretRecord, action: SecretAction)`** (`src/policy/policy.ts:4`) reads only `secret.allowed_actions` (`:5`) and `secret.ref` (`:8`). Widen the param to `Pick<SecretRecord, "ref" | "allowed_actions">` so it type-checks against `AgentSecretMetadata` and `ResolvedSecret` both.

14. **Sink boundaries**: child stdin `Buffer.from(input.secret, "utf8")` (`templates/run.ts:110`, `TemplateRunInput.secret: string` `:13`); env-file `Buffer.from(\`${input.name}=${input.value}\n\`, "utf8")` (`templates/tmp-env-file.ts:49`, `WriteSecretEnvFileInput.value: string` `:9`); masker `createMasker(secrets: readonly string[])` → `Buffer.from(s, "utf8")` (`run/masker.ts:54,57`). These three are daemon-internal signatures → 5q makes them Buffer-native. `template.ts` `render(values: Map<string, string>): string` (`inject/template.ts:24,43`) is string-by-contract — accepted boundary.

15. **`spawnAndStream(input: SpawnInput)`** (`run/spawner.ts:65`) retains `input` (incl. `input.env`, `SpawnInput.env: NodeJS.ProcessEnv` `:21`) in the Promise closure: `spawn(input.cmd, input.args, { env: input.env, ... })` (`:70`), and handlers reference `input.outputWriter`/`input.signal`/`input.stdinBytes` (`:83,84,110-111,127-173,175-191`) for the child's lifetime. 5q destructures those fields into locals so `input` (and `input.env`) becomes unreachable right after `spawn` returns.

16. **`upsertSecret` can throw before writing** (`vault.ts:60-105`): the duplicate-ref `secret_exists` check (`:66-71`) throws before `record` is built; `this.read()`/`this.write()` can throw too. So `upsertSecret` must dispose `input.value` in a `finally`, not on the happy path only.

17. **`Vault.generate` callers** (verified): the **rotate** route `services.vault.generate({...})` (`secrets-rotate.ts:83`) reads only `newRecord.ref` (`:106`). The `/v1/secrets/generate` route does NOT use `Vault.generate` — it calls `generateSecretCore` (`secrets.ts:298`) which calls `upsertSecret` directly (`secrets.ts:205`, reading `meta.ref`/`meta.environment`).

18. **Strict-TS flags** `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on. Array indexing returns `T | undefined`. Optional fields use conditional spread (`...(x !== undefined ? { foo: x } : {})`), never `foo: x ?? undefined`.

19. **Conventional Commits** — recent main: `feat(...)`, `fix(...)`, `test(...)`, `refactor(...)`, `docs(...)`, `chore: ...`. Co-author trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

20. **Baseline**: full suite is **1588 pass** at v0.3.1 (spec §2 Tests + §5). `package.json` `"version": "0.3.1"` (`:3`). `CHANGELOG.md` `## Unreleased` already holds the Burst 6 content; the Burst 7 entry inserts **above** Burst 6.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/daemon/auth/agent-id.ts` | MODIFY | `deriveAutoAgentId` 3-arg extension + `resolveProjectScope` helper |
| `src/daemon/auth/agent-id.test.ts` | CREATE/MODIFY | 2-arg byte-identical pin + 3-arg distinctness + `resolveProjectScope` tests |
| `src/cli/commands/identity-config.ts` | CREATE | `loadIdentityPerProject(cwd)` loader (mirrors `loadInferConfig`) + `writePerProjectIdentity(cwd)` merge-writer |
| `src/cli/commands/identity-config.test.ts` | CREATE | config-loader + merge-writer tests (preserves `infer.*`) |
| `src/cli/commands/init.ts` | MODIFY | `--per-project-identity` flag parse + opt-in resolution + 3-arg `deriveAutoAgentId` call |
| `src/cli/commands/init.test.ts` (or e2e) | MODIFY | flag writes/merges `identity.perProject`; preserves `infer.*` |
| `docs/superpowers/plans/2026-05-30-burst7-5q-value-audit.md` | CREATE | committed `.value` site-map (audit pass, Task 2.1) |
| `src/vault/secret-value.ts` | CREATE | `SecretValue` redaction-safe scrubbable wrapper |
| `src/vault/secret-value.test.ts` | CREATE | redaction (4 paths) + dispose + equals + fromBuffer-copy tests |
| `src/vault/fingerprints.ts` | MODIFY | `fingerprintSecret`/`fingerprintMatches` → `Buffer` |
| `src/vault/fingerprints.test.ts` | MODIFY | migration-free pin (Buffer digest === old string digest) |
| `src/vault/types.ts` | MODIFY | `ResolvedSecret` type; `UpsertSecretInput.value: SecretValue` |
| `src/vault/vault.ts` | MODIFY | `resolveSecret`/`resolveRefs`→`ResolvedSecret`; `upsertSecret` Buffer write + dispose-in-finally; `generate`→`AgentSecretMetadata`; Buffer fingerprint callers |
| `src/policy/policy.ts` | MODIFY | widen `assertSecretActionAllowed` param to `Pick<SecretRecord,"ref"\|"allowed_actions">` |
| `src/daemon/chrome/internal-ops.ts` | MODIFY | add value-free `READ_META_SCRIPT` + make `readFocusedFingerprintAndDomain` use it |
| `src/daemon/api/routes/inject-submit.ts` | MODIFY | metadata preflight + late `resolveSecret` + single `SecretValue` across inject/observeText/proveAbsence + dispose in outer finally |
| `src/daemon/api/routes/secrets.ts` | MODIFY | generate (encoded `fromUtf8`), capture (`fromUtf8`), inject (late resolve), compare (late capture + `Buffer.from(capture.value)`), metadata preflights |
| `src/daemon/api/routes/templates.ts` | MODIFY | metadata preflight + late `resolveSecret` + `SecretValue`→`run.ts` |
| `src/daemon/api/routes/run-resolve.ts` | MODIFY | metadata preflight + late resolve + env drop-reference + Buffer masker/stdin + dispose |
| `src/daemon/api/routes/inject-render.ts` | MODIFY | metadata preflight + file-mode reorder (validate before render) + late resolve + dispose |
| `src/daemon/api/routes/secrets-import.ts` | MODIFY | early-wrap at parse loop + drop request strings + dispose unconsumed on skip/deny/error |
| `src/daemon/api/routes/secrets-delete.ts` | MODIFY | metadata-only accessor (`inspect`) |
| `src/daemon/api/routes/secrets-rotate.ts` | MODIFY | metadata-only accessor (`inspect`); reads `newRecord.ref` from `AgentSecretMetadata` |
| `src/daemon/api/routes/reveal-capture.ts` | MODIFY | proof-before-upsert reorder; single owned `SecretValue.fromUtf8(capturedValue)` |
| `src/daemon/bootstrap/executor.ts` | MODIFY | bootstrap capture → `SecretValue.fromUtf8(captured.value)` producer |
| `src/daemon/run/spawner.ts` | MODIFY | destructure `input` fields so `input.env` unreachable post-spawn; `stdinBytes` stays `Buffer` |
| `src/daemon/run/masker.ts` | MODIFY | `createMasker(secrets: readonly Buffer[])` |
| `src/daemon/templates/run.ts` | MODIFY | `TemplateRunInput.secret: SecretValue`/`Buffer` |
| `src/daemon/templates/tmp-env-file.ts` | MODIFY | `WriteSecretEnvFileInput.value: Buffer`; byte-built prefix/newline |
| `src/daemon/inject/template.ts` | UNCHANGED | `render(Map<string,string>)` stays string-by-contract (accepted boundary) |
| `src/vault/crypto.ts` | UNCHANGED | Tier B — do not touch |
| `src/e2e/no-raw-resolved-value-in-response.test.ts` | CREATE | two repo-scan guards: (1) no daemon route serializes a raw resolved `.value` (direct + `.get(...)!.value` shapes); (2) no route calls `getSecret` (vault-internal-only) |
| `src/vault/keychain/index.ts` | MODIFY (Wrap.1) | correct stale "stubs in Plan 1 / Plan 5a" comments (`:18,22`) |
| `src/vault/keychain/types.ts` | MODIFY (Wrap.1) | correct stale "Plan 1 ships stubs / Plan 5a wires" comments (`:5,10`) |
| `CHANGELOG.md` | MODIFY (Wrap.2) | Burst 7 entry under `## Unreleased`, above Burst 6 |
| `package.json` | MODIFY (Wrap.3) | version 0.3.1 → 0.4.0 |

---

## Pre-flight (run once before Task 1.1)

- [ ] **Step 0.1: Confirm starting state**

```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle
git status
git log --oneline -3
```
Expected: clean working tree on `main` at `6068aa9 Merge branch 'burst6/vision-polish' — Burst 6 Vision Polish`.

- [ ] **Step 0.2: Create the worktree + branch**

```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle
git worktree add .worktrees/burst7-identity-memory-hardening -b burst7/identity-memory-hardening
cd .worktrees/burst7-identity-memory-hardening
git status
```
Expected: new branch `burst7/identity-memory-hardening` on a fresh worktree. All subsequent task work happens inside `.worktrees/burst7-identity-memory-hardening/`.

- [ ] **Step 0.3: Verify baseline tests pass on the worktree**

```bash
npm test 2>&1 | tail -10
npx tsc --noEmit
```
Expected: 1588 pass / 0 fail (the v0.3.1 baseline); typecheck clean.

---

## §1 — Plan 5s: per-project agent IDs (opt-in)

### Task 1.1: `deriveAutoAgentId` 3-arg extension + 2-arg byte-identical regression pin

**Files:**
- Modify: `src/daemon/auth/agent-id.ts`
- Create/Modify: `src/daemon/auth/agent-id.test.ts`

- [ ] **Step 1.1.1: Check for an existing test file**

```bash
ls src/daemon/auth/agent-id.test.ts 2>&1 || echo "absent — create it"
```
If absent, create it with the imports below; if present, append the new tests.

- [ ] **Step 1.1.2: Write the failing tests (2-arg pin + 3-arg distinctness)**

Create or append to `src/daemon/auth/agent-id.test.ts`:
```ts
// src/daemon/auth/agent-id.test.ts
//
// Burst 7 §1 (Plan 5s). deriveAutoAgentId gains an optional third
// projectScope parameter. The 2-arg form MUST stay byte-identical to the
// pre-change function so existing users' identities never change unless
// they opt in (spec §1 + §5 criterion 1).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deriveAutoAgentId, resolveProjectScope } from "./agent-id.js";

const AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

test("deriveAutoAgentId(2-arg) is byte-identical to the pre-change derivation (regression pin)", () => {
  // Pin the EXACT pre-change formula so a future refactor can't silently
  // change every existing user's id: `${runtime}-${sha256(machineId\x00runtime)[0:16]}`.
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const expected = `${runtime}-${createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex").slice(0, 16)}`;
  assert.equal(deriveAutoAgentId(runtime, machineId), expected);
});

test("deriveAutoAgentId(3-arg) differs from 2-arg, is stable for a fixed scope, and is AGENT_ID_RE-valid", () => {
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const scope = "/Users/me/project-a";
  const twoArg = deriveAutoAgentId(runtime, machineId);
  const threeArg = deriveAutoAgentId(runtime, machineId, scope);
  assert.notEqual(threeArg, twoArg, "per-project id must differ from the machine-wide id");
  assert.equal(deriveAutoAgentId(runtime, machineId, scope), threeArg, "same scope → same id (pure hash)");
  assert.match(threeArg, AGENT_ID_RE, "per-project id must still satisfy AGENT_ID_RE");
});

test("deriveAutoAgentId(3-arg): different scopes → different ids", () => {
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const idA = deriveAutoAgentId(runtime, machineId, "/Users/me/project-a");
  const idB = deriveAutoAgentId(runtime, machineId, "/Users/me/project-b");
  assert.notEqual(idA, idB, "distinct project scopes must yield distinct ids");
});
```

- [ ] **Step 1.1.3: Run the tests, verify they FAIL**

```bash
npm test -- --test-name-pattern "deriveAutoAgentId" 2>&1 | tail -15
```
Expected: FAIL — `resolveProjectScope` is not exported yet (import error) and/or the 3-arg call is rejected. TypeScript compile failure is a valid red.

- [ ] **Step 1.1.4: Implement the 3-arg extension + `resolveProjectScope`**

Edit `src/daemon/auth/agent-id.ts`. Add `execFileSync` to the imports and replace the function:
```ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
```
Replace `deriveAutoAgentId` (lines 30-33) with:
```ts
export function deriveAutoAgentId(runtime: string, machineId: string, projectScope?: string): string {
  // 2-arg callers get byte-identical output (existing users unaffected). The
  // per-project variant appends a scope component to the digest material; the
  // id FORMAT (`${runtime}-${16 hex}`) and AGENT_ID_RE validity are preserved.
  const material =
    projectScope === undefined
      ? `${machineId}\x00${runtime}`
      : `${machineId}\x00${runtime}\x00${projectScope}`;
  const digest = createHash("sha256").update(material).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;
}

/**
 * Absolute git-repo-root path, or `cwd` when not in a repo / git absent.
 * Hashed into the per-project agent id (the path itself never appears in the
 * id). One git repo = one trust domain (sub-projects share an id, see plan §1
 * monorepo note). `--show-toplevel` returns the worktree root, stable per
 * checkout.
 */
export function resolveProjectScope(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root.length > 0 ? root : cwd;
  } catch {
    return cwd; // not a git repo, or git absent → cwd is the scope
  }
}
```
(Keep the existing `createHash` import if already present — do not duplicate it; the snippet shows the full import block for reference.)

- [ ] **Step 1.1.5: Re-run the tests, verify the 2-arg/3-arg tests PASS**

```bash
npm test -- --test-name-pattern "deriveAutoAgentId" 2>&1 | tail -15
```
Expected: the three `deriveAutoAgentId` tests PASS. (`resolveProjectScope` tests are added in 1.2.)

- [ ] **Step 1.1.6: Commit**

```bash
git add src/daemon/auth/agent-id.ts src/daemon/auth/agent-id.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): deriveAutoAgentId optional projectScope (Plan 5s, back-compat)

Burst 7 §1. deriveAutoAgentId gains an optional third `projectScope`
param. The 2-arg form is byte-identical to the pre-change derivation
(regression-pinned) so no existing user's agent id changes unless they
opt in. The per-project variant appends the scope to the digest
material; the id format and AGENT_ID_RE validity are preserved.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: `resolveProjectScope` tests (git-root / cwd / git-error fallback)

**Files:**
- Modify: `src/daemon/auth/agent-id.test.ts`

- [ ] **Step 1.2.1: Append the `resolveProjectScope` tests**

Append to `src/daemon/auth/agent-id.test.ts`:
```ts
test("resolveProjectScope: returns the git-root in a temp git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-scope-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    const scope = resolveProjectScope(dir);
    // realpath-normalize both sides: macOS /tmp is a symlink to /private/tmp,
    // and `git rev-parse --show-toplevel` returns the realpath'd root.
    const { realpathSync } = await import("node:fs");
    assert.equal(realpathSync(scope), realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectScope: returns cwd in a non-repo temp dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-scope-norepo-"));
  try {
    // No `git init` — a bare temp dir. (Guard: if the temp dir is itself
    // inside an enclosing repo, git would return that root; tmpdir() is not.)
    const scope = resolveProjectScope(dir);
    assert.equal(scope, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectScope: returns cwd when git errors (nonexistent cwd)", () => {
  // execFileSync throws (ENOENT on the cwd / git nonzero) → cwd fallback.
  const bogus = "/nonexistent-path-for-ss-scope-test-xyz";
  assert.equal(resolveProjectScope(bogus), bogus);
});
```

- [ ] **Step 1.2.2: Run, verify PASS**

```bash
npm test -- --test-name-pattern "resolveProjectScope" 2>&1 | tail -15
```
Expected: 3 PASS. (The non-repo test assumes `tmpdir()` is not nested inside a git checkout — true on standard CI/dev machines. If it ever fails because the runner's tmp is inside a repo, the assertion message will show the unexpected git-root; that is an environment quirk, not a code bug.)

- [ ] **Step 1.2.3: Commit**

```bash
git add src/daemon/auth/agent-id.test.ts
git commit -m "test(auth): resolveProjectScope git-root / cwd / git-error fallback"
```

---

### Task 1.3: `identity.perProject` config loader + merge-writer

**Files:**
- Create: `src/cli/commands/identity-config.ts`
- Create: `src/cli/commands/identity-config.test.ts`

- [ ] **Step 1.3.1: Write the failing loader + writer tests**

Create `src/cli/commands/identity-config.test.ts`:
```ts
// src/cli/commands/identity-config.test.ts
//
// Burst 7 §1 (Plan 5s). Opt-in via `identity.perProject` in
// secret-shuttle.config.json. The loader mirrors loadInferConfig's defensive
// pattern (missing file / malformed JSON / non-object / non-boolean → false).
// The writer MERGES identity.perProject into an existing config, preserving
// infer.* (spec §1 + §6 risk: "flag clobbers an existing infer.* block").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIdentityPerProject, writePerProjectIdentity } from "./identity-config.js";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-identity-config-"));
}

test("loadIdentityPerProject: perProject:true is honored", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: true } }));
    assert.equal(await loadIdentityPerProject(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadIdentityPerProject: missing file → false", async () => {
  const dir = await tmp();
  try {
    assert.equal(await loadIdentityPerProject(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadIdentityPerProject: malformed JSON / non-object identity / non-boolean → false", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "secret-shuttle.config.json"), "{ not valid json");
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: "nope" }));
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: "yes" } }));
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: 1 } }));
    assert.equal(await loadIdentityPerProject(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: creates the file when absent", async () => {
  const dir = await tmp();
  try {
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed, { identity: { perProject: true } });
    assert.equal(await loadIdentityPerProject(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: merges into an existing config WITHOUT clobbering infer.*", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_KEY"] } }, null, 2),
    );
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed.infer, { supabaseNames: ["DATABASE_SERVICE_KEY"] }, "infer.* preserved");
    assert.deepEqual(parsed.identity, { perProject: true }, "identity.perProject merged in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: preserves an existing identity sibling key", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ identity: { somethingElse: 42 } }),
    );
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.equal(parsed.identity.somethingElse, 42, "sibling identity keys preserved");
    assert.equal(parsed.identity.perProject, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 1.3.2: Run, verify FAIL**

```bash
npm test -- --test-name-pattern "IdentityPerProject|PerProjectIdentity" 2>&1 | tail -15
```
Expected: FAIL — `./identity-config.js` does not exist.

- [ ] **Step 1.3.3: Implement the loader + writer**

Create `src/cli/commands/identity-config.ts`:
```ts
/**
 * Burst 7 §1 (Plan 5s) — opt-in per-project agent identity config.
 *
 * `identity.perProject: true` in secret-shuttle.config.json (the same file
 * Burst 6 introduced `infer.supabaseNames` into) opts a project into the
 * per-project agent-id derivation. The loader mirrors loadInferConfig's
 * defensive pattern (infer.ts): missing file / malformed JSON / non-object /
 * missing `identity` / non-boolean `perProject` all → false. The writer MERGES
 * the key into an existing config, preserving every other key (notably
 * `infer.*`) so the `init --per-project-identity` flag never clobbers it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = "secret-shuttle.config.json";

export async function loadIdentityPerProject(cwd: string): Promise<boolean> {
  try {
    const raw = await readFile(join(cwd, CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const identity = (parsed as Record<string, unknown>)["identity"];
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
      return false;
    }
    const perProject = (identity as Record<string, unknown>)["perProject"];
    return perProject === true;
  } catch {
    return false;
  }
}

/**
 * Merge `identity.perProject = true` into secret-shuttle.config.json. Creates
 * the file when absent. Preserves all other top-level keys and all sibling
 * keys under `identity`. A malformed/non-object existing file is replaced with
 * a fresh minimal config (the loader already treats malformed as opt-out, so
 * overwriting it with the explicit opt-in the user just asked for is correct).
 */
export async function writePerProjectIdentity(cwd: string): Promise<void> {
  const path = join(cwd, CONFIG_FILE);
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed → start from {} (preserves nothing because there
    // was nothing valid to preserve).
  }
  const existingIdentity = root["identity"];
  const identity: Record<string, unknown> =
    existingIdentity !== null && typeof existingIdentity === "object" && !Array.isArray(existingIdentity)
      ? { ...(existingIdentity as Record<string, unknown>) }
      : {};
  identity["perProject"] = true;
  root["identity"] = identity;
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 1.3.4: Run, verify PASS**

```bash
npm test -- --test-name-pattern "IdentityPerProject|PerProjectIdentity" 2>&1 | tail -15
npx tsc --noEmit 2>&1 | head -5
```
Expected: all loader/writer tests PASS; typecheck clean.

- [ ] **Step 1.3.5: Commit**

```bash
git add src/cli/commands/identity-config.ts src/cli/commands/identity-config.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): identity.perProject config loader + merge-writer (Plan 5s)

Burst 7 §1. loadIdentityPerProject mirrors loadInferConfig's defensive
pattern (missing/malformed/non-boolean → false). writePerProjectIdentity
merges identity.perProject into secret-shuttle.config.json, preserving
infer.* and any sibling identity keys, so the init flag never clobbers
an existing config.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: Wire `init --per-project-identity` flag + 3-arg derivation at the caller

**Files:**
- Modify: `src/cli/commands/init.ts`
- Modify/Create: `src/cli/commands/init.test.ts` (or an e2e test under `src/e2e/`)

- [ ] **Step 1.4.1: Read `init.ts` around the flag-parse + the derive caller**

```bash
sed -n '1,60p' src/cli/commands/init.ts   # find the arg-parse / flags shape
sed -n '200,260p' src/cli/commands/init.ts # the mint loop + deriveAutoAgentId:238
```
Confirm: how `init` reads its flags (look for an `args`/`flags` object or a `parseArgs`-style block near the top), the `import { deriveAutoAgentId } from "../../daemon/auth/agent-id.js"` line, and the `for (const runtime of runtimes)` loop at `:236` with `deriveAutoAgentId(runtime, machineId)` at `:238`.

- [ ] **Step 1.4.2: Write the failing flag test**

The exact harness depends on how `init` is invoked in tests. Prefer extending the existing `init` test (`ls src/cli/commands/init.test.ts src/e2e/*init* 2>&1`). The test must assert: running `init` with `--per-project-identity` in a temp project (a) writes/merges `identity.perProject: true` into `secret-shuttle.config.json` and (b) preserves a pre-existing `infer.supabaseNames`. If `init`'s side effects (daemon mint, token install) are hard to stub in a unit test, split the opt-in decision into a tiny pure helper and test THAT plus the config write:

```ts
// Add to src/cli/commands/init.test.ts (or a new identity-focused test file).
// Asserts the flag's CONFIG side effect + the opt-in resolution, without
// requiring a live daemon. The agent-id derivation itself is covered by
// agent-id.test.ts; here we pin that the flag (1) persists the opt-in and
// (2) preserves infer.*.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePerProjectOptIn } from "./init.js"; // exported helper (Step 1.4.3)
import { loadIdentityPerProject } from "./identity-config.js";

test("init --per-project-identity: flag true OR config true ⇒ opt-in; writes config preserving infer.*", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-init-ppi-"));
  try {
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_KEY"] } }),
    );
    // Flag set ⇒ resolves true AND persists the opt-in.
    const optedIn = await resolvePerProjectOptIn({ cwd: dir, flag: true });
    assert.equal(optedIn, true);
    assert.equal(await loadIdentityPerProject(dir), true, "flag persisted into config");
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed.infer, { supabaseNames: ["DATABASE_SERVICE_KEY"] }, "infer.* preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init: no flag + no config ⇒ opt-out (2-arg derivation path)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-init-ppi-off-"));
  try {
    assert.equal(await resolvePerProjectOptIn({ cwd: dir, flag: false }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init: no flag + config perProject:true ⇒ opt-in (config is canonical, no re-write needed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-init-ppi-cfg-"));
  try {
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: true } }));
    assert.equal(await resolvePerProjectOptIn({ cwd: dir, flag: false }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 1.4.3: Run, verify FAIL**

```bash
npm test -- --test-name-pattern "per-project-identity|resolvePerProjectOptIn|opt-in|opt-out" 2>&1 | tail -15
```
Expected: FAIL — `resolvePerProjectOptIn` is not exported yet.

- [ ] **Step 1.4.4: Implement the opt-in helper + flag parse + 3-arg wiring**

In `src/cli/commands/init.ts`:

1. Add imports (near the existing `deriveAutoAgentId` import):
```ts
import { deriveAutoAgentId, resolveProjectScope } from "../../daemon/auth/agent-id.js";
import { loadIdentityPerProject, writePerProjectIdentity } from "./identity-config.js";
```

2. Add the exported opt-in resolver (config is canonical; flag forces true AND persists):
```ts
/**
 * Burst 7 §1 (Plan 5s). Resolve the per-project-identity opt-in. The flag
 * (`init --per-project-identity`) forces opt-in for this run AND persists
 * `identity.perProject: true` into secret-shuttle.config.json so subsequent
 * runs are consistent. Without the flag, the config is canonical. Exported for
 * unit tests.
 */
export async function resolvePerProjectOptIn(args: { cwd: string; flag: boolean }): Promise<boolean> {
  if (args.flag) {
    await writePerProjectIdentity(args.cwd);
    return true;
  }
  return await loadIdentityPerProject(args.cwd);
}
```

3. Parse the `--per-project-identity` flag wherever `init` parses its other flags (boolean, default false). Match the file's existing flag-parsing style (e.g. if it uses `process.argv.includes(...)` or a `parseArgs` options object, add `perProjectIdentity` accordingly). Name the resulting local `perProjectIdentityFlag: boolean`.

4. Resolve the opt-in once, before the mint loop, then compute the scope conditionally and pass it to the 3-arg derivation. Replace the loop body's derive call. Before the `if (runtimes.length > 0) {` block add:
```ts
    const perProjectIdentity = await resolvePerProjectOptIn({
      cwd: process.cwd(),
      flag: perProjectIdentityFlag,
    });
    const projectScope = perProjectIdentity ? resolveProjectScope(process.cwd()) : undefined;
```
Then at `init.ts:238`, change:
```ts
const agentId = deriveAutoAgentId(runtime, machineId);
```
to (conditional 3rd arg keeps the 2-arg byte-identical path when opted out):
```ts
const agentId =
  projectScope !== undefined
    ? deriveAutoAgentId(runtime, machineId, projectScope)
    : deriveAutoAgentId(runtime, machineId);
```

5. Add `--per-project-identity` to `init`'s `--help` text with the monorepo + relocation notes: "Derive a per-project agent id (hashes the git-repo-root path into the id). One git repo = one trust domain; sub-projects share an id. Moving the project dir re-derives the id on the next `init` and orphans prior sessions/grants for that project."

- [ ] **Step 1.4.5: Run, verify PASS + typecheck + full suite**

```bash
npm test -- --test-name-pattern "per-project-identity|resolvePerProjectOptIn|opt-in|opt-out" 2>&1 | tail -15
npx tsc --noEmit 2>&1 | head -10
npm test 2>&1 | tail -10
```
Expected: opt-in tests PASS; typecheck clean; full suite green (1588 + the §1 new tests).

- [ ] **Step 1.4.6: Commit**

```bash
git add src/cli/commands/init.ts src/cli/commands/init.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): init --per-project-identity opt-in flag (Plan 5s)

Burst 7 §1. `init --per-project-identity` resolves the opt-in (flag
forces it AND persists identity.perProject; otherwise config is
canonical), resolves the git-root scope, and calls the 3-arg
deriveAutoAgentId. Opted-out runs keep the byte-identical 2-arg path —
zero identity change for existing users. --help documents the monorepo
(one repo = one trust domain) and relocation (re-derive on move) notes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## §2 — Plan 5q: `SecretValue` + Buffer use-path (Tier A)

> **Boundary (read before any §2 task):** Tier A only. The on-disk JSON vault format is untouched — `src/vault/crypto.ts` stays exactly as-is (Code-Grounding #10). 5q removes the *extra, long-lived* per-consumer plaintext string that today persists after the resolve boundary across async browser injection / child-process lifetime / absence-proof. The accepted-string boundaries that keep a bounded transient are: (i) the vault read/write op (Tier B); (ii) browser/CDP inject+capture + the `inject-render` template render; (iii) the child `NodeJS.ProcessEnv` (`run-resolve`); (iv) the agent-requested `inject-render -o -` render that intentionally returns `content`. Every other internal sink (child stdin, tmp env-file, masker, fingerprint) goes Buffer-native.

### Task 2.1: Audit pass — enumerate + categorize every `.value` site (committed site-map, no code change)

**Files:**
- Create: `docs/superpowers/plans/2026-05-30-burst7-5q-value-audit.md`

This is the definitive site-by-site map the later tasks work from. No production code changes.

- [ ] **Step 2.1.1: Re-run the enumeration to confirm the map is current**

```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle/.worktrees/burst7-identity-memory-hardening
grep -rn "record\.value\|secret\.value\|capture\.value\|captured\.value\|oldRecord\.value\|entry\.value\|input\.secret\|input\.value\|\.value, \"utf8\"" src/daemon src/vault --include="*.ts" | grep -v "\.test\.ts"
grep -rn "\.getSecret(\|\.resolveRefs(" src --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/vault/vault.ts"
grep -rn "fingerprintSecret\|fingerprintMatches" src --include="*.ts" | grep -v "\.test\.ts"
```
Cross-check against the table below; if a NEW site appears that the table doesn't list, add it under the correct category before proceeding.

- [ ] **Step 2.1.2: Write the committed site-map**

Create `docs/superpowers/plans/2026-05-30-burst7-5q-value-audit.md` with this content (categories: **a** stored-string/vault-internal — stays string; **b** resolved-consumer → `.bytes()` + scrub, sub-tagged Buffer-native vs accepted-string-boundary; **c** metadata/existence-only → no-value accessor; **d** inbound-producer → early-wrap into `SecretValue`; **e** genuinely unrelated — untouched):

````markdown
# Burst 7 §2 (5q) — `.value` site map

Definitive categorization driving the SecretValue migration. Verified against
`main` at v0.3.1. Categories: (a) stored-string/vault-internal — stays string;
(b) resolved-consumer → `.bytes()` + dispose, each sub-tagged **Buffer-native**
or **accepted-string-boundary**; (c) metadata/existence-only → no-value
`Vault.inspect`→`AgentSecretMetadata`; (d) inbound-producer → early-wrap into a
`SecretValue`; (e) genuinely unrelated `.value` — untouched.

## (a) Vault-internal / on-disk stored-string — STAYS `string`
| Site | Note |
|---|---|
| `vault.ts:92` `value: input.value` | stored `SecretRecord.value`; after write-path becomes `input.value.bytes().toString("utf8")` |
| `vault.ts:83` `fingerprintSecret(input.value, ...)` | becomes `fingerprintSecret(input.value.bytes(), ...)` (write path) |
| `vault.ts:249` `fingerprintSecret(s.value, fpKey)` | legacy-fingerprint migration; becomes `fingerprintSecret(Buffer.from(s.value, "utf8"), fpKey)` |
| `crypto.ts` `JSON.stringify`/`toString("utf8")` | Tier B — UNCHANGED |

## (b) Resolved-consumer → `.value.bytes()` + dispose
| Site | Sink class | Migration |
|---|---|---|
| `inject-submit.ts:171` `injectIntoBackendNode(..., secret.value)` | accepted browser/CDP | late `resolveSecret` after approval; `.bytes().toString("utf8")` at sink; single SecretValue across both sinks |
| `inject-submit.ts:222` `proveAbsence(secret.value)` | accepted browser/CDP | same SecretValue as :171; dispose once in outer `finally` |
| `secrets.ts:445` `injectFocused(secret.value)` (/v1/secrets/inject) | accepted browser/CDP | late `resolveSecret` after approval; dispose in `finally` |
| `templates.ts:219` `runTemplate({ secret: secret.value })` | Buffer-native (stdin/env-file) | late `resolveSecret` after approval; pass `SecretValue`/`Buffer`; dispose in `finally` |
| `run-resolve.ts:337` `env[entry.key] = record.value` | accepted child env (string-only platform API) | late resolve; assign string only at `env[...]=`; drop-reference + dispose after spawn |
| `run-resolve.ts:348` `secretValues = ...map(r => r.value)` | Buffer-native (masker) | `.map(r => r.value.bytes())` → `createMasker(Buffer[])` |
| `run-resolve.ts:443` `Buffer.from(resolved.get(stdin_ref).value, "utf8")` | Buffer-native (child stdin) | `resolved.get(stdin_ref).value.bytes()` |
| `inject-render.ts:95` `valuesMap.set(ref, record.value)` | accepted template render (+ stdout-out) | late resolve after conditional gate; `.bytes().toString("utf8")` at `valuesMap.set`; file-mode reorder; dispose in `finally` |

## (c) Metadata/existence-only → no-value `Vault.inspect`→`AgentSecretMetadata`
| Site | Reads | Migration |
|---|---|---|
| `secrets.ts:154` `getSecret(plannedRef)` (generate overwrite-scope) | `allowed_actions` | `inspect`; catch `secret_not_found` → `existingActions = undefined` |
| `secrets.ts:484` `getSecret(b.ref)` (compare) | `ref`/`environment`/`allowed_domains`/`fingerprint` | `inspect`; compare HMACs the captured candidate, NOT a stored value |
| `secrets-import.ts:103` `getSecret(candidateRef)` (existence) | existence + `.ref` | `inspect` |
| `secrets-delete.ts:50` `getSecret(b.ref)` | `environment`/`allowed_domains` | `inspect` |
| `secrets-rotate.ts:50` `getSecret(b.ref)` | `environment`/`name`/`source`/`allowed_domains`/`allowed_actions` | `inspect` |
| `inject-submit.ts:53` `getSecret(ref)` (preflight) | `ref`/`allowed_actions`/`environment`/`allowed_domains` | `inspect` for the pre-approval preflight; `resolveSecret` after approval |
| `secrets.ts:394` `getSecret(b.ref)` (/v1/secrets/inject preflight) | `ref`/`allowed_actions`/`environment`/`allowed_domains` | `inspect` preflight; `resolveSecret` after approval |
| `templates.ts:130` `getSecret(ref)` (preflight) | `ref`/`allowed_actions`/`environment` | `inspect` preflight; `resolveSecret` after approval |
| `inject-render.ts:54` `resolveRefs(parsed.refs)` (preflight) | `allowed_actions`/`environment` per ref | metadata map for preflight; `SecretValue`-`resolveRefs` after gate |
| `run-resolve.ts:220` `resolveRefs(allRefs)` (preflight) | `allowed_actions`/`environment` per ref | metadata map for preflight; `SecretValue`-`resolveRefs` after gate |

## (d) Inbound-producer `.value` → early-wrap into `SecretValue`
| Site | Producer shape |
|---|---|
| `secrets.ts:205` `upsertSecret({ value })` (generate route, `generateSecretValue` `:204`) | `SecretValue.fromUtf8(generateSecretValue(kind))` — ENCODED string |
| `vault.ts:191-192` `Vault.generate` → `upsertSecret({ value })` (`generateSecretValue` `:191`) | `SecretValue.fromUtf8(generateSecretValue(input.kind))` — ENCODED string; return `AgentSecretMetadata` |
| `secrets.ts:360` `upsertSecret({ value: capture.value })` (capture route) | `SecretValue.fromUtf8(capture.value)` — accepted capture string boundary |
| `secrets-import.ts:135` `upsertSecret({ value: entry.value })` (import) | `SecretValue.fromUtf8(value)` AT THE PARSE LOOP `:41-48`; `ImportEntry.value: SecretValue` |
| `reveal-capture.ts:424` `upsertSecret({ value: capturedValue })` | `SecretValue.fromUtf8(capturedValue)`; proof-before-upsert reorder (single owned SecretValue) |
| `executor.ts:703` `upsertSecret({ value: captured.value })` (bootstrap capture) | `SecretValue.fromUtf8(captured.value)` |

## (e) Genuinely unrelated `.value` — UNTOUCHED
| Site | Why |
|---|---|
| `run-resolve.ts:330,334` `resolved.get(entry.value)` / `Ref ${entry.value}` | `entry.value` is the **ref string** (an env entry's ref), not a secret value |
| `secrets.ts:515` `secret.fingerprint` read | metadata field, not `.value` |
| HTTP body params, `template_params`, `value_visible_to_agent` flags | non-secret `.value`/`value*` reads |

## Two-phase late-resolve discipline (applies to every (b) consumer)
Before `requireApprovals`: metadata-only preflight (`inspect`/metadata `resolveRefs`) — no `SecretValue`, no plaintext string. After approval (or after the conditional gate block for `run-resolve`/`inject-render`), immediately before the sink: `resolveSecret`/`SecretValue`-`resolveRefs`, convert `.bytes()`→string only at the sink, dispose each `SecretValue` in a `finally`.
````

- [ ] **Step 2.1.3: Commit the site-map**

```bash
git add docs/superpowers/plans/2026-05-30-burst7-5q-value-audit.md
git commit -m "docs(5q): committed .value site-map (audit pass, Burst 7 §2.1)"
```

---

### Task 2.2: `SecretValue` class + unit tests

**Files:**
- Create: `src/vault/secret-value.ts`
- Create: `src/vault/secret-value.test.ts`

- [ ] **Step 2.2.1: Write the failing `SecretValue` tests**

Create `src/vault/secret-value.test.ts`:
```ts
// src/vault/secret-value.test.ts
//
// Burst 7 §2 (5q). SecretValue is the guard-by-construction wrapper: the ONLY
// way to read the bytes is .bytes() (greppable/auditable); every stringify
// path redacts to "[secret]"; dispose() zeros the backing Buffer and a
// subsequent .bytes() throws. (Spec §2 "SecretValue" + Tests.)
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { SecretValue } from "./secret-value.js";

test("redaction: String(), template, JSON.stringify, util.inspect all yield [secret]", () => {
  const sv = SecretValue.fromUtf8("super-secret-value");
  assert.equal(String(sv), "[secret]");
  assert.equal(`${sv}`, "[secret]");
  assert.equal(JSON.stringify(sv), '"[secret]"');
  assert.equal(JSON.stringify({ token: sv }), '{"token":"[secret]"}');
  assert.equal(inspect(sv), "[secret]");
});

test("bytes() round-trips the utf8 input", () => {
  const sv = SecretValue.fromUtf8("hello-world");
  assert.equal(sv.bytes().toString("utf8"), "hello-world");
  assert.equal(sv.byteLength, Buffer.byteLength("hello-world", "utf8"));
});

test("fromBuffer defensively copies (mutating the source does not change the SecretValue)", () => {
  const src = Buffer.from("original", "utf8");
  const sv = SecretValue.fromBuffer(src);
  src.fill(0); // mutate the source after construction
  assert.equal(sv.bytes().toString("utf8"), "original", "SecretValue holds an independent copy");
});

test("dispose() zeros the backing buffer and subsequent bytes() throws", () => {
  const sv = SecretValue.fromUtf8("scrub-me");
  const buf = sv.bytes();
  sv.dispose();
  assert.ok(buf.every((b) => b === 0), "backing buffer zeroed in place");
  assert.throws(() => sv.bytes(), /used after dispose/, "bytes() after dispose throws");
});

test("dispose() is idempotent", () => {
  const sv = SecretValue.fromUtf8("x");
  sv.dispose();
  assert.doesNotThrow(() => sv.dispose(), "second dispose is a no-op");
});

test("equals: true for identical bytes, false for differing, length-mismatch short-circuits", () => {
  const a = SecretValue.fromUtf8("same");
  const b = SecretValue.fromUtf8("same");
  const c = SecretValue.fromUtf8("different");
  const d = SecretValue.fromUtf8("sam"); // shorter — length mismatch path
  assert.equal(a.equals(b), true);
  assert.equal(a.equals(c), false);
  assert.equal(a.equals(d), false);
});
```

- [ ] **Step 2.2.2: Run, verify FAIL**

```bash
npm test -- --test-name-pattern "redaction|bytes\(\)|fromBuffer|dispose|equals" 2>&1 | tail -15
```
Expected: FAIL — `./secret-value.js` does not exist.

- [ ] **Step 2.2.3: Implement `SecretValue`**

Create `src/vault/secret-value.ts`:
```ts
import { timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const REDACTED = "[secret]";

/**
 * A secret's plaintext bytes, wrapped so accidental stringification redacts
 * instead of leaking. The ONLY way to read the bytes is `.bytes()`, which is
 * greppable + auditable. toString/toJSON/[inspect.custom] all return
 * "[secret]", so `${sv}`, JSON.stringify(sv), console.log(sv), and
 * template/log interpolation cannot leak the value. Call dispose() after use
 * to zero the backing Buffer. (Burst 7 §2 / Plan 5q.)
 */
export class SecretValue {
  #buf: Buffer;
  #disposed = false;

  private constructor(buf: Buffer) {
    this.#buf = buf;
  }

  static fromUtf8(s: string): SecretValue {
    return new SecretValue(Buffer.from(s, "utf8"));
  }

  static fromBuffer(b: Buffer): SecretValue {
    return new SecretValue(Buffer.from(b)); // defensive copy
  }

  /** The plaintext bytes. Throws if already disposed. The single audited door. */
  bytes(): Buffer {
    if (this.#disposed) throw new Error("SecretValue used after dispose()");
    return this.#buf;
  }

  /** Byte length (safe to expose — not the value). */
  get byteLength(): number {
    return this.#buf.length;
  }

  /** Constant-time compare against another secret's bytes. */
  equals(other: SecretValue): boolean {
    const a = this.bytes();
    const b = other.bytes();
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Zero the backing buffer. Idempotent. */
  dispose(): void {
    this.#buf.fill(0);
    this.#disposed = true;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
```

- [ ] **Step 2.2.4: Run, verify PASS + typecheck**

```bash
npm test -- --test-name-pattern "redaction|bytes\(\)|fromBuffer|dispose|equals" 2>&1 | tail -15
npx tsc --noEmit 2>&1 | head -5
```
Expected: all `SecretValue` tests PASS; typecheck clean.

- [ ] **Step 2.2.5: Commit**

```bash
git add src/vault/secret-value.ts src/vault/secret-value.test.ts
git commit -m "$(cat <<'EOF'
feat(vault): SecretValue — redaction-safe scrubbable plaintext wrapper (5q)

Burst 7 §2. SecretValue wraps secret bytes so accidental stringification
(String/template/JSON.stringify/util.inspect) redacts to "[secret]"; the
only byte accessor is the greppable .bytes(); dispose() zeros the backing
Buffer and a subsequent .bytes() throws. fromBuffer defensively copies.
equals() is constant-time. This is the guard-by-construction for the
Buffer use-path.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: `fingerprintSecret`/`fingerprintMatches` → `Buffer` (migration-free)

**Files:**
- Modify: `src/vault/fingerprints.ts`
- Modify: `src/vault/fingerprints.test.ts`
- Modify: `src/vault/vault.ts` (the two vault-internal callers)
- Modify: `src/daemon/api/routes/secrets.ts` (the compare-route byte-wrap, to keep `tsc` green)

- [ ] **Step 2.3.1: Write the failing migration-free pin test**

Append to `src/vault/fingerprints.test.ts`:
```ts
// Burst 7 §2 (5q). fingerprintSecret/Matches now take Buffer. HMAC over bytes
// is identical to HMAC over the utf8 bytes of the same string, so the digest
// for identical bytes is UNCHANGED — no stored-fingerprint migration. This
// pins that invariant against the new Buffer signature.
import { createHmac } from "node:crypto";

test("fingerprintSecret(Buffer) === the pre-change string-form digest for identical bytes", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const plaintext = "the-secret-value";
  // Reconstruct the EXACT pre-change output: "hmac-sha256:" + HMAC over the
  // utf8 bytes of the string.
  const expected = `hmac-sha256:${createHmac("sha256", key).update(plaintext, "utf8").digest("hex")}`;
  const actual = fingerprintSecret(Buffer.from(plaintext, "utf8"), key);
  assert.equal(actual, expected, "Buffer form must equal the legacy string-form digest");
});

test("fingerprintMatches(Buffer) verifies a digest produced from the same bytes", () => {
  const key = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");
  const bytes = Buffer.from("compare-me", "utf8");
  const fp = fingerprintSecret(bytes, key);
  assert.equal(fingerprintMatches(Buffer.from("compare-me", "utf8"), fp, key), true);
  assert.equal(fingerprintMatches(Buffer.from("different", "utf8"), fp, key), false);
});
```
(Ensure `fingerprintSecret`/`fingerprintMatches` + `assert`/`test` are imported in the test file; they almost certainly already are — if a duplicate `import { createHmac }` appears, consolidate.)

- [ ] **Step 2.3.2: Run, verify FAIL**

```bash
npm test -- --test-name-pattern "fingerprintSecret\(Buffer\)|fingerprintMatches\(Buffer\)" 2>&1 | tail -10
```
Expected: FAIL — passing a `Buffer` to the current `string` signature is a TypeScript error.

- [ ] **Step 2.3.3: Change the signatures to `Buffer`**

Edit `src/vault/fingerprints.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function fingerprintSecret(value: Buffer, key: Buffer): string {
  // HMAC over the raw bytes. Identical output to the prior string form for the
  // same bytes (HMAC(utf8-bytes-of-string) === HMAC(Buffer-of-same-bytes)), so
  // no stored-fingerprint migration is required.
  return `hmac-sha256:${createHmac("sha256", key).update(value).digest("hex")}`;
}

export function fingerprintMatches(value: Buffer, fingerprint: string, key: Buffer): boolean {
  const computed = Buffer.from(fingerprintSecret(value, key), "utf8");
  const given = Buffer.from(fingerprint, "utf8");
  return computed.byteLength === given.byteLength && timingSafeEqual(computed, given);
}

export function isLegacyFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith("sha256:");
}
```

- [ ] **Step 2.3.4: Update callers to pass `Buffer`**

1. `src/vault/vault.ts:83` — `input.value` is still a `string` until Task 2.6, so wrap it: change `fingerprintSecret(input.value, Buffer.from(plaintext.fingerprint_key as string, "base64"))` → `fingerprintSecret(Buffer.from(input.value, "utf8"), Buffer.from(plaintext.fingerprint_key as string, "base64"))`. (Task 2.6 replaces `Buffer.from(input.value, "utf8")` with `input.value.bytes()`.)
2. `src/vault/vault.ts:249` — the legacy-migration loop reads the stored string permanently: `fingerprintSecret(s.value, fpKey)` → `fingerprintSecret(Buffer.from(s.value, "utf8"), fpKey)`.
3. `src/daemon/api/routes/secrets.ts:515` (compare) — byte-wrap the captured candidate NOW so `tsc` stays green: `fingerprintMatches(capture.value, secret.fingerprint, fpKey)` → `fingerprintMatches(Buffer.from(capture.value, "utf8"), secret.fingerprint, fpKey)`. **The compare late-capture REORDER (capture only after approval) is done in Task 2.5 — only the byte-wrap moves here.** Critical: compare must keep HMACing the captured candidate, never a stored/resolved secret.

- [ ] **Step 2.3.5: Run the pin test + the existing fingerprint/vault tests, verify PASS + green typecheck**

```bash
npm test -- --test-name-pattern "fingerprint" 2>&1 | tail -15
npx tsc --noEmit 2>&1 | head -20
```
Expected: the migration-free pin PASSES; existing `fingerprints.test.ts` + `vault.test.ts` fingerprint cases still pass; `tsc` clean (the compare byte-wrap was applied in 2.3.4).

- [ ] **Step 2.3.6: Commit**

```bash
git add src/vault/fingerprints.ts src/vault/fingerprints.test.ts src/vault/vault.ts src/daemon/api/routes/secrets.ts
git commit -m "$(cat <<'EOF'
refactor(vault): fingerprintSecret/Matches take Buffer (5q, migration-free)

Burst 7 §2. HMAC over raw bytes — identical digest to the prior string
form for the same bytes, so no stored-fingerprint migration. Vault
internal callers wrap the stored string (Buffer.from(stored, "utf8"));
the compare route byte-wraps the captured candidate. Pinned by a test
asserting the Buffer-form digest equals the legacy string-form digest.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4: Resolve path — `ResolvedSecret` + three-way accessor split + policy widening

**Files:**
- Modify: `src/vault/types.ts` (add `ResolvedSecret`)
- Modify: `src/vault/vault.ts` (`resolveSecret`, `resolveRefs`→`ResolvedSecret`)
- Modify: `src/policy/policy.ts` (widen `assertSecretActionAllowed` param)
- Modify: `src/vault/vault.test.ts` (accessor tests)

This task introduces the accessor types/methods. Consumer migration happens in Tasks 2.5.* (per-consumer). The metadata/existence callers keep using the existing `Vault.inspect` (no new method needed) — this task only adds the *plaintext-resolving* accessor and the `ResolvedSecret` type, plus the policy widening that lets metadata + resolved shapes both satisfy the policy check.

- [ ] **Step 2.4.1: Write the failing accessor + policy-widening tests**

Append to `src/vault/vault.test.ts` (match its existing setup — it uses a `Vault` constructed with a key provider; reuse that harness):
```ts
// Burst 7 §2 (5q). The plaintext-resolving accessor returns a ResolvedSecret
// whose `value` is a disposable SecretValue; the no-value metadata accessor
// (inspect) returns AgentSecretMetadata with no `value`; the stored record
// still round-trips its string on disk. (Spec §2 type-split + Tests.)
import { SecretValue } from "./secret-value.js";
import { assertSecretActionAllowed } from "../policy/policy.js";

test("resolveSecret returns a ResolvedSecret with a SecretValue carrying the plaintext bytes", async () => {
  const { vault } = await freshVaultWithSecret({ name: "TOK", environment: "development", source: "local", value: "plaintext-bytes" });
  const resolved = await vault.resolveSecret("ss://local/dev/TOK");
  assert.ok(resolved.value instanceof SecretValue);
  assert.equal(resolved.value.bytes().toString("utf8"), "plaintext-bytes");
  assert.equal(resolved.ref, "ss://local/dev/TOK");
  // Metadata fields are present on the resolved shape.
  assert.equal(resolved.environment, "development");
  resolved.value.dispose();
});

test("resolveRefs returns a Map<ref, ResolvedSecret> with SecretValue values", async () => {
  const { vault } = await freshVaultWithSecret({ name: "TOK", environment: "development", source: "local", value: "abc" });
  const map = await vault.resolveRefs(["ss://local/dev/TOK"]);
  const r = map.get("ss://local/dev/TOK");
  assert.ok(r !== undefined);
  assert.ok(r.value instanceof SecretValue);
  assert.equal(r.value.bytes().toString("utf8"), "abc");
  r.value.dispose();
});

test("inspect returns AgentSecretMetadata with no value field (metadata-only accessor)", async () => {
  const { vault } = await freshVaultWithSecret({ name: "TOK", environment: "development", source: "local", value: "abc" });
  const meta = await vault.inspect("ss://local/dev/TOK");
  assert.equal((meta as Record<string, unknown>)["value"], undefined, "no plaintext on the metadata shape");
  assert.equal(meta.value_visible_to_agent, false);
});

test("assertSecretActionAllowed accepts both a ResolvedSecret and AgentSecretMetadata (widened param)", async () => {
  const { vault } = await freshVaultWithSecret({ name: "TOK", environment: "development", source: "local", value: "abc" });
  const meta = await vault.inspect("ss://local/dev/TOK");
  const resolved = await vault.resolveSecret("ss://local/dev/TOK");
  // Both satisfy Pick<SecretRecord, "ref" | "allowed_actions"> — compiles + runs.
  assert.doesNotThrow(() => assertSecretActionAllowed(meta, "inject_into_field"));
  assert.doesNotThrow(() => assertSecretActionAllowed(resolved, "inject_into_field"));
  resolved.value.dispose();
});
```
Add a small `freshVaultWithSecret` helper to the test file if one does not already exist (build a `Vault`, `upsertSecret` the record with the still-string `value` — this test runs BEFORE the write-path task 2.6, so `upsertSecret` still takes a `string` here; if 2.6 already landed, wrap with `SecretValue.fromUtf8`). Reuse the file's existing vault-construction utility rather than re-implementing key management.

- [ ] **Step 2.4.2: Run, verify FAIL (red = whole-project compile failure)**

```bash
npm test -- --test-name-pattern "resolveSecret|resolveRefs returns a Map|metadata-only accessor|widened param" 2>&1 | tail -15
```
Expected: FAIL — at this point the consumers still compile, so the red is the **test file** failing to build: `resolveSecret` does not exist; `resolveRefs` returns `SecretRecord` not `ResolvedSecret`; the widened policy param doesn't exist. Because `npm test` runs `npm run build` (whole-project `tsc`) first, this manifests as a **build/compile failure, not a per-test failure** — a valid TDD red (compile failure is red). Once Steps 2.4.3–2.4.5 land the type change, the *route consumers* also go red, and no `npm test` will run until the Task 2.5.* batch is green (see the sequencing note at Step 2.4.6). So the accessor tests written here are first *verified GREEN* at the Step 2.5.7.3 green checkpoint, alongside the consumer tests — not in isolation at 2.4.

- [ ] **Step 2.4.3: Add the `ResolvedSecret` type**

In `src/vault/types.ts`, add an import of `SecretValue` and the type (place near `SecretRecord`):
```ts
import type { SecretValue } from "./secret-value.js";

/**
 * Burst 7 §2 (5q). A resolved secret handed to a plaintext consumer: all the
 * stored SecretRecord metadata EXCEPT `value`, which is a disposable,
 * redaction-safe SecretValue (created at the resolve boundary). The
 * string-valued SecretRecord is reserved for vault internals only.
 */
export type ResolvedSecret = Omit<SecretRecord, "value"> & { value: SecretValue };
```
(`exactOptionalPropertyTypes`: `Omit` preserves the optional `description?`/`deleted_at?`/`rotating?` modifiers, so no extra handling is needed.)

- [ ] **Step 2.4.4: Add `resolveSecret` + change `resolveRefs` return type**

In `src/vault/vault.ts`:
1. Import `SecretValue` and `ResolvedSecret`:
```ts
import { SecretValue } from "./secret-value.js";
import type {
  AgentSecretMetadata,
  EncryptedVaultFile,
  ResolvedSecret,
  SecretAction,
  SecretRecord,
  UpsertSecretInput,
  VaultPlaintext,
} from "./types.js";
```
2. Add a private helper that wraps a stored record into a `ResolvedSecret` at the resolve boundary (omit `value`, attach a fresh `SecretValue.fromUtf8`):
```ts
  /** Wrap a stored record into a ResolvedSecret: strip the stored string and
   *  attach a disposable SecretValue created from it. Used by the plaintext-
   *  resolving accessors only. The caller OWNS and must dispose() resolved.value. */
  private toResolvedSecret(record: SecretRecord): ResolvedSecret {
    const { value, ...meta } = record;
    return { ...meta, value: SecretValue.fromUtf8(value) };
  }
```
3. Add the public `resolveSecret` (mirrors `getSecret`'s lookup + soft-delete throw, but returns `ResolvedSecret`):
```ts
  /**
   * Resolve a single ref to a ResolvedSecret (metadata + a disposable
   * SecretValue). Throws secret_not_found for missing or soft-deleted refs.
   * The caller OWNS the returned SecretValue and MUST dispose() it after the
   * sink resolves (Burst 7 §2 two-phase late-resolve discipline).
   */
  async resolveSecret(ref: string): Promise<ResolvedSecret> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined || secret.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    return this.toResolvedSecret(secret);
  }
```
4. Change `resolveRefs` (currently `:263`) to return `Map<string, ResolvedSecret>` by wrapping via the existing `getSecret` lookup:
```ts
  /**
   * Resolve a list of ss:// refs to a Map<ref, ResolvedSecret>. Uses the
   * deleted-aware lookup so soft-deleted refs throw secret_not_found.
   * Single-pass — fails fast on the first missing ref. Dedupes input. The
   * caller OWNS every returned SecretValue and MUST dispose() each.
   */
  async resolveRefs(refs: readonly string[]): Promise<Map<string, ResolvedSecret>> {
    const result = new Map<string, ResolvedSecret>();
    for (const ref of refs) {
      if (result.has(ref)) continue; // dedupe
      const record = await this.getSecret(ref);
      result.set(ref, this.toResolvedSecret(record));
    }
    return result;
  }
```
> **Note:** `getSecret(ref): Promise<SecretRecord>` (the string-valued accessor) STAYS — it is now vault-internal-only (used by `resolveRefs`/`resolveSecret`/`generate`/migration), no longer called by routes after Task 2.5. Do not delete it.

- [ ] **Step 2.4.5: Widen `assertSecretActionAllowed`**

In `src/policy/policy.ts`:
```ts
import { ShuttleError } from "../shared/errors.js";
import type { SecretAction, SecretRecord } from "../vault/types.js";

// Burst 7 §2 (5q): widened to the structural subset actually read (ref +
// allowed_actions) so it type-checks against SecretRecord, AgentSecretMetadata,
// AND ResolvedSecret without forcing any caller to carry the stored string.
export function assertSecretActionAllowed(
  secret: Pick<SecretRecord, "ref" | "allowed_actions">,
  action: SecretAction,
): void {
  if (!secret.allowed_actions.includes(action)) {
    throw new ShuttleError(
      "action_not_allowed",
      `Secret ${secret.ref} is not allowed to perform action ${action}.`,
    );
  }
}
```

- [ ] **Step 2.4.6: Enumerate the consumer-migration TODO list via `tsc` (do NOT run `npm test` yet)**

```bash
npx tsc --noEmit 2>&1 | head -40
```
Expected: `tsc` reports errors at every route that reads `.value` from a `resolveRefs`/`resolveSecret`-typed local (inject-render `:95`, run-resolve `:337,348,443`, etc.) because those locals are now `ResolvedSecret` (`.value` is `SecretValue`, not a string). **IMPORTANT — `tsc` only catches the `resolveRefs`/`resolveSecret` shape change.** `getSecret` still returns `SecretRecord` (string `.value`) and stays vault-internal but unchanged in signature, so its consumers (`inject-submit.ts:53→:171` reading `secret.value` as a string, and the other `getSecret` callers) **continue to type-check** and will NOT appear in `tsc` output. Do not rely on `tsc` to enumerate them — the `getSecret`-consumer migration list must be driven from the §2.1 audit map / the §2.5.7 static scan (raw resolved `.value`), not from this typecheck. **What `tsc` gives you is the `resolveRefs`/`resolveSecret` per-consumer migration TODO list for Task 2.5** — record the exact list from `tsc` output. Do NOT patch them here, and do NOT run `npm test` while the tree is red (see the sequencing note).

> **Sequencing note (REQUIRED — not optional):** `npm test` runs `npm run build` first, and `build` runs `tsc -p tsconfig.json` over the **whole** project (`package.json:31,33`). So a single red consumer anywhere fails the build and **no test runs at all** — the targeted `npm test -- --test-name-pattern …` commands in the 2.5.* sub-tasks below CANNOT execute against a tsc-red tree (they are not isolated; the build is whole-project). Therefore Tasks 2.4 → 2.5.7 are **one logically-atomic, no-commit implementation step that MUST reach a green typecheck before any `npm test` invocation OR any `git commit`.** Implement the 2.5.* sub-tasks back-to-back (in order — each builds on the prior route's pattern), and only after the **last consumer compiles** (end of Task 2.5.7, i.e. all `resolveRefs`/`getSecret` route consumers migrated and the metadata callers routed to `inspect`) run the suite. The per-sub-task `npm test … --test-name-pattern` blocks below are written as if isolated for review clarity, but in practice you run them as a single batch at the first green point; treat **every** sub-task "Run, verify FAIL" AND "Run, verify PASS" instruction in Tasks 2.5.0–2.5.7 as a checkpoint to satisfy **after** the tree is green at Step 2.5.7.3 — do NOT execute any such `npm test` against the red tree, since the whole-project build fails before any test runs and the command would report a build error, not a red/green behavioral signal. (Each sub-task's "verify FAIL" is therefore a *pre-implementation expectation* you record while writing the test, not a command to run mid-batch; to observe the genuine red signal per-consumer, take the temporary-compatibility-shim alternative below so each commit lands against a green tree.) The per-consumer `git add` steps below stage only — there is exactly ONE commit for this batch, at Step 2.5.7.4 (the first green tree); never `git commit` a tree that fails `tsc`, and never claim a sub-task's tests pass off a build that did not run. The repo-wide `npx tsc --noEmit` green checkpoint is at Step 2.5.7.3; the targeted-test checkpoints all happen at or after it. (Alternative if a continuously-green tree per commit is desired: land 2.4 with temporary compatibility shims so the old `record.value` consumers keep compiling, then remove the shims as each consumer migrates — but the atomic-batch approach above is simpler and is the plan's default.)

- [ ] **Step 2.4.7: Stage the accessor split — do NOT commit yet (tree is tsc-red)**

The accessor type change makes the `resolveRefs`/`resolveSecret` route consumers red until they are migrated in Task 2.5. Per the **Sequencing note** at Step 2.4.6 — *never `git commit` a tree that fails `tsc`* — Tasks 2.4 → 2.5.7 are **one no-commit implementation batch.** Stage the accessor split here so it is grouped, but do not create the commit until the green checkpoint (Step 2.5.7.3 — `tsc` clean + suite green), where Step 2.5.7.4 commits the whole accessor+consumer-migration batch.

```bash
# Stage only — the commit happens at the Step 2.5.7.4 green checkpoint, never against the red tree.
git add src/vault/types.ts src/vault/vault.ts src/policy/policy.ts src/vault/vault.test.ts
git status   # confirm staged; do NOT run `git commit` here
```

If you prefer review-granular commits, the only safe option is the **temporary-compatibility-shim** alternative from the Sequencing note (land 2.4 green with shims, then remove them per-consumer). The plan's default is the no-commit batch above. The commit message at Step 2.5.7.4 covers the accessor split + all consumer migrations together.

---

### Task 2.5: Per-consumer migration (two-phase late-resolve discipline)

Each sub-task applies the spec's REQUIRED two-phase discipline: **metadata-only preflight before `requireApprovals`** (no `SecretValue`, no plaintext string), then **`resolveSecret`/`SecretValue`-`resolveRefs` only after approval, immediately before the sink**, converting `.bytes()`→string only at the sink, and **dispose in a `finally`** on success/throw/timeout. Includes named ordering tests per the spec.

#### Task 2.5.0: Value-free `READ_META_SCRIPT` preflight for the browser metadata read

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts`
- Modify: `src/daemon/chrome/internal-ops.test.ts` (or the nearest existing internal-ops test)

This is a prerequisite for the compare + inject preflights: `readFocusedFingerprintAndDomain` currently evaluates the value-bearing `READ_SCRIPT` (Code-Grounding #11), so even though its TS return omits `value`, the candidate plaintext lands on the daemon heap before approval.

- [ ] **Step 2.5.0.1: Write the failing metadata-script test**

Append to the internal-ops test file:
```ts
// Burst 7 §2 (5q). The pre-approval preflight must read NO candidate value
// TEXT, while still mirroring READ_SCRIPT's acceptance set (selection-present
// OR editable active element). It may call getSelection() for a VALUE-FREE
// presence check (isCollapsed / rangeCount — booleans), but must never
// stringify the selection (.toString()) or read .value / .innerText.
// (Spec §2 compare reorder + "Regression test (named)".)
import { READ_META_SCRIPT } from "./internal-ops.js";

test("READ_META_SCRIPT reads no candidate value TEXT (no selection .toString()/.value/.innerText)", () => {
  // Value-free selection PRESENCE (getSelection().isCollapsed/rangeCount) is
  // ALLOWED — what's forbidden is reading the selected TEXT or field value.
  assert.doesNotMatch(READ_META_SCRIPT, /getSelection\(\)\s*[?.]*\s*\.\s*toString/, "must not stringify the selection");
  assert.doesNotMatch(READ_META_SCRIPT, /\.value\b/, "must not read input .value");
  assert.doesNotMatch(READ_META_SCRIPT, /innerText/, "must not read contentEditable text");
  // It SHOULD still expose the metadata fields the preflight needs.
  assert.match(READ_META_SCRIPT, /domain/);
  assert.match(READ_META_SCRIPT, /field/);
});

test("READ_META_SCRIPT mirrors READ_SCRIPT acceptance: selection presence is accepted without requiring an editable active element", () => {
  // Regression pin for the selection-mode compare path: READ_SCRIPT returns
  // ok:true / source:"selection" when a non-empty selection exists EVEN IF the
  // active element is not editable. READ_META_SCRIPT must keep that branch
  // (value-free) so compare-on-selection against non-editable page text is not
  // rejected at the preflight. Assert the script has a selection-present accept
  // branch (source:"selection") that does NOT gate on isField.
  assert.match(READ_META_SCRIPT, /isCollapsed/, "uses the value-free selection-presence predicate");
  assert.match(READ_META_SCRIPT, /source\s*:\s*["']selection["']/, "accepts the selection-present case");
  // The selection accept must come BEFORE the not_editable rejection (so a
  // selection on a non-editable element is accepted, not rejected).
  const selIdx = READ_META_SCRIPT.search(/source\s*:\s*["']selection["']/);
  const notEditableIdx = READ_META_SCRIPT.search(/not_editable/);
  assert.ok(selIdx > -1 && notEditableIdx > -1 && selIdx < notEditableIdx,
    "selection-present accept must precede the not_editable rejection");
});
```
(If the in-page scripts are not currently exported, export `READ_META_SCRIPT` from `internal-ops.ts`. `READ_SCRIPT` is already module-scoped; mirror its export style. The regex assertions are heuristics over the script source; if a future implementer prefers a jsdom-driven behavioral test that evaluates `READ_META_SCRIPT` against a fake DOM with a non-editable selection and asserts `ok:true`/`source:"selection"`, that is stronger and welcome.)

- [ ] **Step 2.5.0.2: FAIL checkpoint — DEFERRED to the Step 2.5.7.3 green tree (do NOT run `npm test` now)**

Per the **Sequencing note** (Step 2.4.6), `npm test` builds the whole project and the tree is `tsc`-red across the 2.5.* batch, so this command CANNOT run in isolation here. Do NOT run it now. Write the test (Step 2.5.0.1) and record this as a checkpoint to satisfy at Step 2.5.7.3 — by then `READ_META_SCRIPT` exists (Step 2.5.0.3), so the FAIL is observed only transiently by re-running the suite *without* this step's implementation if you want the red signal; in the default atomic batch you verify PASS at 2.5.7.3:
```bash
# Run ONLY at/after the Step 2.5.7.3 green checkpoint — not against the red tree:
npm test -- --test-name-pattern "READ_META_SCRIPT" 2>&1 | tail -10
```
(Pre-implementation expectation for this test, observed at the 2.5.7.3 checkpoint: it FAILS without Step 2.5.0.3's `READ_META_SCRIPT`. To see the genuine red signal under the atomic path, the simplest option is the temporary-compatibility-shim alternative from the Sequencing note. Default path: write now, verify PASS at 2.5.7.3.)

- [ ] **Step 2.5.0.3: Add `READ_META_SCRIPT` + route `readFocusedFingerprintAndDomain` through it**

In `src/daemon/chrome/internal-ops.ts`, add a value-free script next to `READ_SCRIPT` (`:200`). It returns the SAME metadata shape `READ_SCRIPT` does (so `field`/`domain`/`title`/`urlHost` are unchanged) but NEVER reads selection/`.value`/`.innerText`:
```ts
// Burst 7 §2 (5q): value-FREE metadata read for the pre-approval preflight.
// Returns the same { ok, field, domain, title, urlHost, source } metadata
// READ_SCRIPT does, but never materializes the candidate value (no
// getSelection().toString() / .value / .innerText) — so
// readFocusedFingerprintAndDomain holds no candidate plaintext on the daemon
// heap before approval.
//
// CRITICAL — must mirror READ_SCRIPT's ACCEPTANCE set, not just the
// focused-field subset (verified against internal-ops.ts:208-215). READ_SCRIPT
// returns ok:true in THREE cases: (1) a non-empty *selection* exists — and it
// does NOT require the active element to be editable in that case
// (source:"selection"); (2) a focused <input>/<textarea>; (3) a contentEditable
// element (both source:"focused-field"). A naive READ_META_SCRIPT that ALWAYS
// requires `isField` (editable active element) would reject the common
// "compare against selected page text on a non-editable element" case that
// READ_SCRIPT accepts today — regressing selection-mode compare (which routes
// its pre-approval preflight through readFocusedFingerprintAndDomain too, Task
// 2.5.6). So READ_META_SCRIPT detects selection PRESENCE *without reading the
// text* via the value-free `!getSelection().isCollapsed` predicate (a boolean —
// it never stringifies the selection), and accepts when EITHER a selection is
// present OR the active element is editable.
export const READ_META_SCRIPT = `
(() => {
  function meta(el){
    const i = el instanceof HTMLInputElement ? el : null;
    const ta = el instanceof HTMLTextAreaElement ? el : null;
    const editable = el instanceof HTMLElement && el.isContentEditable;
    return { tag: el.tagName.toLowerCase(), type: i?.type, name: i?.name ?? ta?.name, id: el.id, editable };
  }
  const a = document.activeElement;
  if (!(a instanceof Element)) return { ok:false, reason:"no_active_element" };
  const base = { field: meta(a), domain: location.hostname, title: document.title, urlHost: location.host };
  // Value-free selection PRESENCE check — booleans only, never reads the text.
  const s = window.getSelection();
  const hasSelection = !!s && s.rangeCount > 0 && !s.isCollapsed;
  if (hasSelection) return { ok:true, source:"selection", ...base };
  const isField = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a instanceof HTMLElement && a.isContentEditable);
  if (!isField) return { ok:false, reason:"not_editable" };
  return { ok:true, source:"focused-field", ...base };
})()
`;
```
This keeps the preflight's acceptance set byte-for-byte aligned with READ_SCRIPT's (selection-present OR editable-active-element) while still reading **no** candidate plaintext: `s.isCollapsed`/`s.rangeCount` are booleans/numbers, never the selected string. (Edge note: READ_SCRIPT keys "has selection" off `getSelection().toString() !== ""`, whereas `!isCollapsed` is the value-free equivalent. The only divergence is a pathological zero-width-but-non-collapsed range, which produces no real candidate value anyway and is irrelevant to a fingerprint compare; the post-approval `captureSelection()` still uses the exact `toString()` path, so the compared bytes are unchanged.)
Then change `readFocusedFingerprintAndDomain` (`:957-971`) to evaluate `READ_META_SCRIPT` instead of `READ_SCRIPT` at `:959`:
```ts
  async readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string; title?: string; urlHost?: string }>(page.id, READ_META_SCRIPT);
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error("focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return {
      domain: r.domain.toLowerCase(),
      target_id: page.id,
      field: r.field,
      field_fingerprint: fp,
      ...(r.title !== undefined ? { page_title: r.title } : {}),
      ...(r.urlHost !== undefined ? { page_url_host: r.urlHost } : {}),
    };
  }
```
(`captureFocused`/`captureSelection` keep using the value-bearing `READ_SCRIPT` — they are the post-approval value read. `fieldFingerprint` is computed from `field`/`domain` metadata, NOT the value, so the fingerprint is unchanged.)

- [ ] **Step 2.5.0.4: Run, verify PASS + the existing internal-ops/capture tests still pass**

```bash
npm test -- --test-name-pattern "READ_META_SCRIPT|readFocusedFingerprint|capture" 2>&1 | tail -20
```
Expected: the metadata-script test PASSES; existing capture/fingerprint behavior unchanged (fingerprint derives from metadata).

- [ ] **Step 2.5.0.5: Stage only — do NOT commit (tree is tsc-red since Step 2.4.7; first commit is Step 2.5.7.4)**

This script change compiles in isolation, but it runs against the accessor-split red tree (staged at Step 2.4.7), so the project as a whole still fails `tsc` until the whole 2.5.* batch is migrated. Per the Sequencing note (Step 2.4.6) — *never `git commit` a tree that fails `tsc`* — stage here; the single batch commit at Step 2.5.7.4 covers this change (its `git add -A src/daemon` sweep includes `internal-ops.ts`). The Step 2.5.0.4 "verify PASS" is satisfied at the Step 2.5.7.3 green checkpoint.

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/chrome/internal-ops.test.ts
git status   # confirm staged; do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.1: `inject-submit` — metadata preflight + single `SecretValue` across both sinks

**Files:**
- Modify: `src/daemon/api/routes/inject-submit.ts`
- Modify: the inject-submit test file (find via `ls src/**/*inject-submit*test* 2>/dev/null` or `src/vault/inject-submit-action.test.ts` + any route-level test)

Verified ordering today: `getSecret` `:53` → `assertSecretActionAllowed` `:54` → `requireApprovals` `:124` → `injectIntoBackendNode(..., secret.value)` `:171` → `observeText` `:215` (up to `successTimeoutMs`, default 15s / cap 60s, `:27-28`) → `proveAbsence(secret.value)` `:222`. This is a deliberate **multi-sink** retention case: ONE `SecretValue` feeds both sinks, disposed ONCE in the outer `finally`.

- [ ] **Step 2.5.1.1: Write the failing ordering + multi-sink test**

Add a test (in the route's test file) using a stubbed/deferred approval that records call order:
```ts
// Burst 7 §2 (5q). inject-submit: (1) resolve plaintext only AFTER approval
// (the pre-approval preflight uses inspect, no SecretValue); (2) the SAME
// SecretValue feeds injectIntoBackendNode AND proveAbsence; (3) dispose ONCE in
// the outer finally — .bytes() succeeds at proveAbsence but throws after the
// route returns (success, throw, and timeout paths). (Spec §2 Tests:
// "inject-submit retains one SecretValue across both sinks".)
```
Concretely, the test should: stub `services.vault.resolveSecret` to return a `ResolvedSecret` whose `SecretValue` records each `.bytes()` call and whose `dispose` is spied; stub `services.vault.inspect` to return the metadata; assert `resolveSecret` is called only after the approval resolves; assert the same `SecretValue` instance reaches both `injectIntoBackendNode` and `proveAbsence`; assert `dispose` fires exactly once after the route returns. Match the existing inject-submit test harness (it likely fakes `services.browser` + `services.approvals`).

- [ ] **Step 2.5.1.2: FAIL checkpoint — DEFERRED to the Step 2.5.7.3 green tree (do NOT run `npm test` now)**

Per the **Sequencing note** (Step 2.4.6), the tree is `tsc`-red across the 2.5.* batch and `npm test` builds the whole project, so this targeted command CANNOT run in isolation here. Do NOT run it now. Write the test (Step 2.5.1.1) and treat this as a checkpoint to satisfy at Step 2.5.7.3:
```bash
# Run ONLY at/after the Step 2.5.7.3 green checkpoint — not against the red tree:
npm test -- --test-name-pattern "inject-submit" 2>&1 | tail -15
```
(Pre-implementation expectation, observed at the 2.5.7.3 checkpoint or via the temporary-compatibility-shim alternative: FAIL — the route still resolves before approval / disposes wrong. Default atomic path: write now, verify PASS at 2.5.7.3.)

- [ ] **Step 2.5.1.3: Migrate the route**

Edit `src/daemon/api/routes/inject-submit.ts`:
1. `:53` change the pre-approval read to metadata-only and keep policy/domain/binding on metadata. Replace `const secret = await services.vault.getSecret(ref);` with `const meta = await services.vault.inspect(ref);` and update `:54`/`:92`/`:100-117` references (`assertSecretActionAllowed(meta, "inject_submit")`; `enforceDomain(domain, meta.allowed_domains, ...)`; the binding's `ref`/`environment`/`allowed_domains` from `meta`).
2. After `grant = grants[0]!` (`:135`) and after `services.blind.start` + the pre-write revalidate (`:148-154`), resolve plaintext once and hold it in a `finally`-scoped variable. Declare `let resolved: ResolvedSecret | undefined;` near the top of the try (so the outer `finally` sees it), then immediately before the `withDeadline(... injectIntoBackendNode ...)` block:
```ts
      resolved = await services.vault.resolveSecret(ref);
```
3. At `:171` change `secret.value` → `resolved.value.bytes().toString("utf8")`. At `:222` change `proveAbsence(secret.value)` → `proveAbsence(resolved.value.bytes().toString("utf8"))` (same `SecretValue`, not yet disposed). Update all other `secret.ref`/`secret.environment` reads to `meta.ref`/`meta.environment`.
4. Add disposal in the route's OUTER `finally` (the route currently has only `try/catch` at `:48/:264` — add a `finally` after the catch that disposes the resolved value if present):
```ts
    } catch (err) {
      // ... existing failure audit ...
      throw err;
    } finally {
      resolved?.value.dispose();
    }
```
(Idempotent dispose + `.bytes()`-after-dispose-throws means the success, throw, and `successTimeoutMs`-timeout paths all scrub exactly once.)

- [ ] **Step 2.5.1.4: Run the ordering test + existing inject-submit tests, verify PASS**

```bash
npm test -- --test-name-pattern "inject-submit" 2>&1 | tail -15
```
Expected: the new ordering/multi-sink test + all existing inject-submit tests PASS.

- [ ] **Step 2.5.1.5: Stage only — do NOT commit (tree is tsc-red; first commit is Step 2.5.7.4)**

This consumer compiles in isolation, but the *other* not-yet-migrated 2.5.* consumers are still tsc-red, so the tree as a whole fails `tsc`. Per the Sequencing note (Step 2.4.6) — *never `git commit` a tree that fails `tsc`* — stage here and let the single batch commit at Step 2.5.7.4 cover this consumer.

```bash
git add src/daemon/api/routes/inject-submit.ts src/vault/inject-submit-action.test.ts
git status   # confirm staged; do NOT run `git commit` here (see Step 2.5.7.4)
```
(The Step 2.5.1.4 "verify PASS" is satisfied at the Step 2.5.7.3 green checkpoint, after the whole batch compiles — not against this red tree.)

---

#### Task 2.5.2: `/v1/secrets/inject` — metadata preflight + late resolve

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts` (the inject route, `:385-474`)
- Modify: the secrets-route test file

Verified: `getSecret(b.ref)` `:394` → `assertSecretActionAllowed` `:395` → `readFocusedFingerprintAndDomain` `:396` (now value-free) → `enforceDomain` `:400` → `requireApprovals` `:422` → `injectFocused(secret.value)` `:445`.

- [ ] **Step 2.5.2.1: Write the failing ordering test** (stubbed deferred approval; assert `resolveSecret` is called after `requireApprovals`, the preflight used `inspect`, and the `SecretValue` is disposed in `finally`). Run, verify FAIL.

- [ ] **Step 2.5.2.2: Migrate**
1. `:394` `const secret = await services.vault.getSecret(b.ref);` → `const meta = await services.vault.inspect(b.ref);`; `:395` `assertSecretActionAllowed(meta, "inject_into_field")`; `:400` `enforceDomain(pre.domain, meta.allowed_domains, "inject")`; binding `ref`/`environment`/`allowed_domains` from `meta` (`:411,412,418`).
2. Declare `let resolved: ResolvedSecret | undefined;` in the try; after `requireApprovals` (`:429`) + `services.blind.start` + the post-approval field-changed recheck (`:441-444`), resolve immediately before `injectFocused`:
```ts
        resolved = await services.vault.resolveSecret(b.ref);
        result = await services.browser.injectFocused(resolved.value.bytes().toString("utf8"));
```
3. Replace remaining `secret.ref`/`secret.environment` with `meta.ref`/`meta.environment`.
4. Add a `finally` to the route's `try/catch` (`:391/:465`) disposing `resolved?.value`.

- [ ] **Step 2.5.2.3: Stage only — do NOT commit (tree is tsc-red; first commit is Step 2.5.7.4).** Per the Sequencing note (Step 2.4.6), the tree still fails `tsc` until the whole 2.5.* batch is migrated, so the "verify PASS" checkpoint runs at Step 2.5.7.3 (after green), not here:
```bash
git add src/daemon/api/routes/secrets.ts <secrets-test-file>
git status   # do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.3: `templates` (child stdin) — metadata preflight + late resolve + Buffer to `run.ts`

**Files:**
- Modify: `src/daemon/api/routes/templates.ts` (`runTemplateCore`, `:110-266`)
- Modify: `src/daemon/templates/run.ts` (`TemplateRunInput.secret`)
- Modify: `src/daemon/templates/tmp-env-file.ts` (`WriteSecretEnvFileInput.value`)
- Modify: their test files

Verified: `getSecret(ref)` `:130` → `assertSecretActionAllowed` `:131` → `requireApprovals` `:198` → `runTemplate({ secret: secret.value })` `:216-219`.

- [ ] **Step 2.5.3.1: Change the Buffer-native sink signatures first (so the route can pass bytes).**
- `run.ts`: `TemplateRunInput.secret: SecretValue` (`:13`); inside `runTemplate`, the stdin branch builds `const secretBuf = input.secret.bytes()` (`:110` — note: do NOT defensively re-copy; `input.secret` is owned by the route which disposes it; but the existing scrub `.fill(0)` would zero the route's buffer — instead, pass `Buffer.from(input.secret.bytes())` so `run.ts` owns its own zeroable copy and the route's `SecretValue.dispose()` is independent). The env-file branch passes `value: Buffer.from(input.secret.bytes())` to `writeSecretEnvFile`.

  > **Decision (judgment call):** `run.ts` makes its OWN `Buffer.from(input.secret.bytes())` copy for the stdin/env-file write+scrub, leaving the route-owned `SecretValue` to be disposed by the route's `finally`. This keeps `run.ts`'s existing scrub-the-written-buffer logic intact (it `.fill(0)`s after the write) without prematurely zeroing the route's `SecretValue`. Alternative — passing `input.secret.bytes()` directly and letting `run.ts` scrub it — would dispose-by-side-effect and is more fragile; the copy is the spec's "convert to bytes only at the sink" with clear ownership.
- `tmp-env-file.ts`: `WriteSecretEnvFileInput.value: Buffer` (`:9`); `writeSecretEnvFileAt` builds the line as bytes so the value never becomes a JS string: `const buf = Buffer.concat([Buffer.from(`${input.name}=`, "utf8"), input.value, Buffer.from("\n", "utf8")]);` (`:49`); update the `writeSecretEnvFileAt` param type + the `writeSecretEnvFile` call (`:41`) to `Buffer`. The NAME stays a string (it's not secret).
- Update `run.test.ts` / `tmp-env-file.test.ts` to construct `SecretValue`/`Buffer` inputs.

- [ ] **Step 2.5.3.2: Write the failing route ordering test** (assert `resolveSecret` after `requireApprovals`; preflight via `inspect`; dispose in `finally`). Run, verify FAIL.

- [ ] **Step 2.5.3.3: Migrate the route**
1. `:130` `const secret = await services.vault.getSecret(ref);` → `const meta = await services.vault.inspect(ref);`; `:131` `assertSecretActionAllowed(meta, "use_as_stdin")`; `:149-152` `effectiveEnv` from `meta.environment`; binding `ref` from `meta.ref` (`:175`).
2. Declare `let resolved: ResolvedSecret | undefined;`; after `requireApprovals` (`:208`) and the `if (resolveErr !== null) throw resolveErr;` (`:214`), resolve immediately before `runTemplate`:
```ts
    resolved = await services.vault.resolveSecret(ref);
    const result = await runTemplate({
      template: { ...tpl, binary: absolute as string },
      params,
      secret: resolved.value,
      expectedSha256: sha256 as string,
      tmpDir: services.tmpDir,
    });
```
3. Replace remaining `secret.ref` with `meta.ref` (`:223,241`).
4. Add a `finally` to the `try/catch` (`:128/:247`) disposing `resolved?.value`.

- [ ] **Step 2.5.3.4: Stage only — do NOT commit (tree is tsc-red; first commit is Step 2.5.7.4).** Per the Sequencing note (Step 2.4.6), the tree still fails `tsc` until the whole 2.5.* batch is migrated, so the "verify PASS" checkpoint runs at Step 2.5.7.3 (after green), not here:
```bash
git add src/daemon/api/routes/templates.ts src/daemon/templates/run.ts src/daemon/templates/tmp-env-file.ts <test-files>
git status   # do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.4: `run-resolve` (env) — metadata preflight + env drop-reference + Buffer masker/stdin

**Files:**
- Modify: `src/daemon/api/routes/run-resolve.ts`
- Modify: `src/daemon/run/spawner.ts` (destructure `input` so `input.env` is unreachable post-spawn)
- Modify: `src/daemon/run/masker.ts` (`createMasker(Buffer[])`)
- Modify: their test files

Verified: `resolveRefs(allRefs)` `:220` → `assertSecretActionAllowed` per ref `:233-235` → `requireApprovals` (conditional, `:300-324`) → `env[entry.key] = record.value` `:337` → `createMasker(secretValues)` `:348-350` → `spawnAndStream` `:445` (env retained for child lifetime in the closure).

- [ ] **Step 2.5.4.1: Change `createMasker` to `Buffer[]` first.**
- `masker.ts:54` `createMasker(secrets: readonly Buffer[])`; `:55-59` dedupe on bytes — replace the string-dedupe with a byte-aware one that **never stringifies the secret** (spec §2 "the secret never enters the masker as a string", spec line 225 — so a `.toString("base64")` / hex dedupe key is forbidden, it is a reversible string copy of the secret). Build `patterns` by iterating the input buffers, defensive-copying each accepted one (`Buffer.from(b)`), filtering `b.length > 0`, and dropping content-duplicates via **byte comparison** against the already-accepted patterns (`if (!patterns.some((p) => p.equals(b))) patterns.push(Buffer.from(b))`), then sort by length DESC. Remove the `Buffer.from(s, "utf8")` at `:58` (input is already bytes). Concretely:
```ts
export function createMasker(secrets: readonly Buffer[]): Masker {
  const patterns: Buffer[] = [];
  for (const b of secrets) {
    if (b.length === 0) continue;
    if (patterns.some((p) => p.equals(b))) continue; // byte-compare dedupe, no string key
    patterns.push(Buffer.from(b)); // defensive copy of the accepted bytes
  }
  patterns.sort((a, b) => b.length - a.length);
  // ... maxLen / lookback / replaceAll unchanged
}
```
The rest (`process`/`flush`/`dispose`) is unchanged.
- Update `masker.test.ts` / `masker-scrub.test.ts` to pass `Buffer[]`.

- [ ] **Step 2.5.4.2: Make `spawnAndStream` drop `input.env` after spawn.**
In `spawner.ts`, destructure the fields the long-lived handlers use into locals at the top of the Promise executor, and reference ONLY those locals in the `c.stdout`/`c.stderr`/`c.on(...)`/abort/stdin callbacks — so the `input` object (and `input.env`) becomes unreachable once `spawn` has copied the env synchronously. Concretely, after `const c = child;` (`:94`), add:
```ts
    const { outputWriter, signal, stdinBytes } = input;
```
and replace `input.outputWriter` → `outputWriter`, `input.signal` → `signal`, `input.stdinBytes` → `stdinBytes` throughout the handler bodies (`:98-191`). (`spawn(input.cmd, input.args, { env: input.env, ... })` at `:70` reads `options.env` synchronously, so dropping the daemon-side reference right after does not affect the child.) Keep the sync-spawn-failure path's `input.stdinBytes?.fill(0)` (`:83`) — it runs before the destructure; change it to use the local if you move the destructure above the `try`, otherwise leave as `input.stdinBytes?.fill(0)`.

- [ ] **Step 2.5.4.3: Write the failing tests** (three named tests):
```ts
// (a) run-resolve clears env entries + disposes SecretValues immediately after
//     spawnAndStream is INITIATED and BEFORE awaiting child exit — NOT in the
//     outer finally. Assert dispose fires while the child Promise is still
//     pending (deferred spawn stub: dispose called before the spawn Promise
//     settles), and clearing the route's env right after the call does not
//     affect the running child.
// (b) spawnAndStream does not retain a reachable reference to input.env after
//     spawn (handlers reference destructured locals): a spy/clear confirms it.
// (c) a pre-spawn failure (e.g. secret_not_found during env build, or an
//     approval denial) still disposes every resolved SecretValue.
```
Run, verify FAIL.

- [ ] **Step 2.5.4.4: Migrate the route**
1. Preflight: `resolveRefs` `:220` now returns `Map<string, ResolvedSecret>`. The pre-approval policy loop `:233-235` reads `assertSecretActionAllowed(record, "use_as_stdin")` — `ResolvedSecret` satisfies the widened param, so it compiles. BUT to keep NO `SecretValue` alive across the conditional approval gate, the preflight should resolve metadata only. Since `resolveRefs` now allocates `SecretValue`s, split: add a metadata resolve for the preflight. Simplest correct approach — resolve metadata via `inspect` per ref for the preflight + production classification, and call the `SecretValue`-`resolveRefs` only AFTER the `bindings.length > 0` gate block (`:324`). Replace the `:220` `resolved = await services.vault.resolveRefs(allRefs)` with a metadata map:
```ts
    let metaByRef: Map<string, AgentSecretMetadata>;
    try {
      metaByRef = new Map();
      for (const ref of allRefs) {
        if (metaByRef.has(ref)) continue;
        metaByRef.set(ref, await services.vault.inspect(ref));
      }
    } catch (e) { /* existing per-ref audit + 400 */ }
```
   Use `metaByRef` for the `assertSecretActionAllowed` loop (`:233-235`), the `envProductionRefs` filter (`:251-253`, read `.environment`), the stdin production check (`:280`), and `auditPerRef` (which reads `.environment`). (Keep `auditPerRef`'s signature working with metadata — it reads only `record.environment`.)
2. After the `if (bindings.length > 0) { ... }` block (`:324`), resolve the plaintext:
```ts
    const resolved = await services.vault.resolveRefs(allRefs);
```
3. `:337` `env[entry.key] = record.value;` → `env[entry.key] = resolved.get(entry.value)!.value.bytes().toString("utf8");` (the string is materialized only at this assignment).
4. `:348` `const secretValues = Array.from(resolved.values()).map((r) => r.value);` → `.map((r) => r.value.bytes());` (Buffer-native masker input).
5. `:443` `Buffer.from(resolved.get(body.stdin_ref)!.value, "utf8")` → `Buffer.from(resolved.get(body.stdin_ref)!.value.bytes())` (own copy for the spawner's stdin scrub).
6. **Drop-reference + dispose immediately after spawn INITIATION (NOT after child exit).** The spec is explicit (§2 Sink-reality, design line 229): the env entries must be cleared and the `SecretValue`s disposed *"immediately after `spawnAndStream` is initiated (synchronously after the call returns / the spawn is kicked off — **not** after awaiting child exit)."* `spawnAndStream` `await`s child EXIT (`run-resolve.ts:445`, the Promise resolves on exit), so putting the drop after the `await` — or in the outer `finally` (`:477`) — would leave the secret env **strings** reachable through the route's `env` object for the child's entire lifetime (arbitrarily long), violating the spec. **`spawn()` reads `options.env` synchronously inside `spawnAndStream`'s Promise executor** (`spawner.ts:66,70` — the executor body runs synchronously when the Promise is constructed, before the call even returns), so by the time `spawnAndStream(...)` returns its Promise the child already holds its env copy; clearing the daemon-side `env` and disposing the `SecretValue`s right then cannot affect the running child. Therefore **do not `await` the spawn before dropping** — capture the pending Promise, drop synchronously, then `await`:
```ts
      const childRun = spawnAndStream({
        cmd: body.command,
        args: body.args,
        env,
        cwd: body.cwd,
        outputWriter: { ...writer, writeExit(code) { childExitCode = code; writer.writeExit(code); } },
        signal: abortController.signal,
        ...(stdinBytes !== undefined ? { stdinBytes } : {}),
      });
      // Spawn has already copied env into the child synchronously (spawner.ts:70)
      // and spawnAndStream no longer retains input.env (it destructures the fields
      // its long-lived handlers use — Step 2.5.4.2). So clear the secret env
      // strings out of the route's env object and scrub every resolved SecretValue
      // NOW — before awaiting child exit — so neither survives the child lifetime
      // on the daemon heap. The masker bytes stay alive (the maskers stream for the
      // child's lifetime) and are scrubbed in the existing outer finally.
      for (const entry of body.env) {
        if (entry.isRef) delete env[entry.key];
      }
      for (const r of resolved.values()) r.value.dispose();
      await childRun;
```
   The post-exit `markUsed` (`:466`, iterates `resolved.keys()`) and `auditPerRef` (`:469`, reads `record.environment`) still work after disposal — `dispose()` scrubs only the `SecretValue` **bytes**, leaving the `ResolvedSecret` metadata (`ref`/`environment`) and the Map structure intact; neither calls `.value.bytes()`. (If 2.5.4.4 item 1 routed the preflight through a `metaByRef` metadata map, feed that map to the post-exit `auditPerRef` instead for clarity — but reading the disposed `resolved` map's `.environment` is equally safe since only the bytes are gone.)

  > **Decision (spec-mandated, not a judgment call):** the env-clear + `SecretValue` dispose go **immediately after `spawnAndStream` is initiated and BEFORE `await childRun`** (not in the outer `finally`). Rationale: the outer `finally` runs only after the awaited child exits, so it would not satisfy the spec's "not after awaiting child exit" requirement for the env **strings**. The masker dispose stays in the outer `finally` (`:477`) because the maskers must live for the child's streaming lifetime — that is correct and unchanged. The throw/early-return paths before spawn never reach this drop, so they must also dispose the `SecretValue`s: add `for (const r of resolved.values()) r.value.dispose();` to the existing pre-spawn error branches (the `secret_not_found` env-build catch at `:333`, the approval-denied/unexpected catch at `:320`) and to any path that returns before `childRun` is created — OR, simplest, wrap the resolve-onward block in a `try { … spawn + drop + await … } catch { for (const r of resolved.values()) r.value.dispose(); throw; }` so every pre-spawn failure scrubs too (dispose is idempotent, so the in-band drop after spawn is harmless if the catch also fires). The named test asserts (a) clearing the route's `env` right after `spawnAndStream` is invoked does not affect the child, (b) `spawnAndStream` references destructured locals (does not retain `input.env`), and (c) every resolved `SecretValue` is disposed after `spawnAndStream` is invoked and **before** the child-exit await resolves (e.g. spy `dispose` and assert it fired before the awaited spawn Promise settles).

- [ ] **Step 2.5.4.5: Stage only — do NOT commit (tree is tsc-red; first commit is Step 2.5.7.4).** Per the Sequencing note (Step 2.4.6), the tree still fails `tsc` until the whole 2.5.* batch is migrated, so the "verify PASS" checkpoint runs at Step 2.5.7.3 (after green), not here:
```bash
git add src/daemon/api/routes/run-resolve.ts src/daemon/run/spawner.ts src/daemon/run/masker.ts <test-files>
git status   # do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.5: `inject-render` — file-mode reorder (validate before render) + late resolve

**Files:**
- Modify: `src/daemon/api/routes/inject-render.ts`
- Modify: its test file

Verified: `resolveRefs(parsed.refs)` `:54` → `assertSecretActionAllowed` per ref `:57-59` → conditional `requireApprovals` (`:65-91`, only when `isProduction`) → `valuesMap.set(ref, record.value)` `:93-96` → `render` `:97` → stdout return `:99-109` OR file-mode path walk `:111-252` → `writeFile` `:240`. The render currently happens BEFORE the file-mode path walk, holding `rendered` across async FS work.

- [ ] **Step 2.5.5.1: Write the failing tests** (three named):
```ts
// (a) file mode validates path BEFORE render: a path-unsafe target throws
//     inject_output_path_unsafe WITHOUT render being called / secrets rendered.
// (b) render/write failure still disposes each resolved SecretValue + drops the
//     rendered string.
// (c) stdout mode (-o -) still renders-then-returns content unchanged; resolve
//     happens after the conditional gate, dispose in finally.
```
Run, verify FAIL.

- [ ] **Step 2.5.5.2: Migrate**
1. Preflight metadata-only: change `:54` `resolved = await services.vault.resolveRefs(parsed.refs)` to a metadata map for the preflight (`assertSecretActionAllowed` `:57-59` + `isProduction` `:61-63` read only `allowed_actions`/`environment`). Use `inspect` per ref into a `Map<string, AgentSecretMetadata>` named `metaByRef` (mirror the run-resolve pattern). The `finally` per-ref audit (`:266-282`) reads `record.environment` — feed it from `metaByRef`.
2. Hold a `let resolved: Map<string, ResolvedSecret> | undefined;` for disposal. Resolve plaintext only AFTER the conditional `if (isProduction) { ... requireApprovals ... }` block (`:91`).
3. **stdout mode:** keep the early-return reachable (`:99-109`). Resolve + build `valuesMap` + render right before the return:
```ts
      if (outputPath === "-") {
        resolved = await services.vault.resolveRefs(parsed.refs);
        const valuesMap = new Map<string, string>();
        for (const [ref, r] of resolved) valuesMap.set(ref, r.value.bytes().toString("utf8"));
        const rendered = parsed.render(valuesMap);
        auditOk = true;
        valueVisibleToAgent = true;
        for (const ref of parsed.refs) await services.vault.markUsed(ref).catch(() => undefined);
        return { rendered: true, refs_count: parsed.refs.length, content: rendered };
      }
```
4. **file mode:** move ALL the path-safety walk **AND the temp-file `open`** (the `path.isAbsolute` check `:112`, ancestor-symlink walk `:137-181`, step-wise `mkdir` `:190-200`, leaf-symlink check `:203-215`, final TOCTOU realpath `:222-230`, **and the `open(tempPath, "wx", 0o600)` at `:239`**) to run BEFORE `valuesMap` construction + render. The spec is explicit (§2 Template-render, design line 234): the temp-file `open` is part of the file-mode setup that must complete **before** rendering — so `render` is the **last async step before `writeFile`** with **no `await` (filesystem or otherwise) between render and write**. A code block that renders first and then `await open(...)` (as an earlier draft did) re-introduces exactly the bug being fixed: the rendered plaintext string held across the async `open()`. Correct order — open the fh, THEN resolve + build `valuesMap` + render + `writeFile` back-to-back:
```ts
      // ... all path validation/setup above (now before render) ...
      fh = await open(tempPath, "wx", 0o600);   // open BEFORE render (spec line 234)
      // No further awaits between here and writeFile: resolve, render, write.
      resolved = await services.vault.resolveRefs(parsed.refs);
      const valuesMap = new Map<string, string>();
      for (const [ref, r] of resolved) valuesMap.set(ref, r.value.bytes().toString("utf8"));
      const rendered = parsed.render(valuesMap);
      await fh.writeFile(rendered, "utf8");
      // ... existing close + atomic rename ...
```
   (The `resolveRefs` `await` between `open` and render is the resolve boundary itself — it produces the bytes; it does not hold a *rendered* string. The rendered plaintext exists only from `parsed.render(...)` to the immediately-following `writeFile`, with no I/O in between, satisfying "materialized only at the sink call and dropped right after." Keep the existing try/catch around the open→write→rename so a write/rename failure still unlinks the temp file and the `finally` disposes the `SecretValue`s.)
5. Add disposal: change the existing `finally` (`:262-283`) — it already runs on every path — to also dispose: at the top of the `finally`, `for (const r of resolved?.values() ?? []) r.value.dispose();` (idempotent; covers the throw-before-render path where `resolved` is undefined → no-op).

- [ ] **Step 2.5.5.3: Stage only — do NOT commit (tree is tsc-red; first commit is Step 2.5.7.4).** Per the Sequencing note (Step 2.4.6), the tree still fails `tsc` until the whole 2.5.* batch is migrated, so the "verify PASS" checkpoint runs at Step 2.5.7.3 (after green), not here:
```bash
git add src/daemon/api/routes/inject-render.ts <test-file>
git status   # do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.6: `compare` late-capture reorder + metadata-only

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts` (the compare route, `:476-533`)
- Modify: the secrets-route test file

Verified: `getSecret(b.ref)` `:484` → `assertSecretActionAllowed` `:485` → capture `captureFocused()/captureSelection()` `:486-488` (BEFORE approval!) → `enforceDomain` `:492` → `requireApprovals` `:505` → `fingerprintMatches(Buffer.from(capture.value,"utf8"), secret.fingerprint, fpKey)` `:515` (byte-wrap already applied in 2.3). Compare reads only the stored `fingerprint` (metadata) — it is NOT a resolved-plaintext consumer; it just must not capture the candidate before approval.

- [ ] **Step 2.5.6.1: Write the failing reorder test** (stubbed deferred approval; assert `captureFocused`/`captureSelection` is invoked AFTER `requireApprovals` resolves; the only pre-approval browser read is the value-free `readFocusedFingerprintAndDomain`; match/mismatch correctness against the page value still holds). Run, verify FAIL.

- [ ] **Step 2.5.6.2: Migrate**
1. `:484` `const secret = await services.vault.getSecret(b.ref);` → `const meta = await services.vault.inspect(b.ref);`; `:485` `assertSecretActionAllowed(meta, "compare_fingerprint")`.
2. Gather the pre-approval non-secret preflight from the value-free metadata read instead of capturing the candidate: replace the pre-approval capture (`:486-488`) with `const pre = await services.browser.readFocusedFingerprintAndDomain();` and use `pre.domain` for the `domainMatches` check (`:489-491`) + `enforceDomain` (`:492`) + the binding's `destination_domain` (`:498`).
3. AFTER `requireApprovals` (`:512`), capture the candidate value and HMAC it:
```ts
      const capture = b.with === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();
      // The captured candidate may have moved fields after approval — re-check
      // domain against the approved pre.domain (fail closed if changed).
      if (capture.domain !== pre.domain) {
        throw new ShuttleError("field_changed", "Focused field changed after approval.");
      }
      const fpKey = await services.vault.fingerprintKey();
      const matches = fingerprintMatches(Buffer.from(capture.value, "utf8"), meta.fingerprint, fpKey);
```
4. Replace remaining `secret.ref`/`secret.environment`/`secret.fingerprint`/`secret.allowed_domains` with `meta.*`. Audit (`:516,529`) uses `meta.ref`/`meta.environment`. No `SecretValue`, no dispose (compare resolves no stored secret).

  > **Note:** the captured candidate `capture.value` is a transient page-side string at the accepted CDP boundary, materialized only at the HMAC sink and dropped right after — consistent with the spec. The candidate is NOT held across approval anymore (it's captured after).

- [ ] **Step 2.5.6.3: Stage only — do NOT commit (tree is still tsc-red until Task 2.5.7 metadata callers migrate; first commit is Step 2.5.7.4).** Per the Sequencing note (Step 2.4.6), the "verify PASS" checkpoint runs at Step 2.5.7.3 (after green), not here:
```bash
git add src/daemon/api/routes/secrets.ts <secrets-test-file>
git status   # do NOT run `git commit` here — the single batch commit is Step 2.5.7.4
```

---

#### Task 2.5.7: Metadata-only callers (delete / rotate / generate-scope / import-existence) + green checkpoint

**Files:**
- Modify: `src/daemon/api/routes/secrets-delete.ts` (`:50`)
- Modify: `src/daemon/api/routes/secrets-rotate.ts` (`:50`)
- Modify: `src/daemon/api/routes/secrets.ts` (generate overwrite-scope `:154`)
- Modify: `src/daemon/api/routes/secrets-import.ts` (existence check `:103` — the producer side is Task 2.6)

These callers read metadata only and currently hold a stored plaintext string across approval latency for no reason (spec calls out delete/rotate specifically). Route them to the no-value `inspect`.

- [ ] **Step 2.5.7.1: Migrate each metadata caller**
- `secrets-delete.ts:50` `const record = await services.vault.getSecret(b.ref);` → `const record = await services.vault.inspect(b.ref);` (reads `record.environment` `:53` + `record.allowed_domains` `:63` — both on `AgentSecretMetadata`).
- `secrets-rotate.ts:50` `const oldRecord = await services.vault.getSecret(b.ref);` → `await services.vault.inspect(b.ref);` (reads `environment`/`name`/`source`/`allowed_domains`/`allowed_actions` — all on `AgentSecretMetadata`). Note `Vault.generate`'s return type changes to `AgentSecretMetadata` in Task 2.6; this route reads only `newRecord.ref` (`:106`), which is present on both — so the rotate route is forward-compatible.
- `secrets.ts:154` (generate overwrite-scope) `existingActions = [...(await services.vault.getSecret(plannedRef)).allowed_actions];` → `existingActions = [...(await services.vault.inspect(plannedRef)).allowed_actions];` (the `catch → undefined` stays; `inspect` throws `secret_not_found` identically).
- `secrets-import.ts:103` `const existing = await services.vault.getSecret(candidateRef);` → `const existing = await services.vault.inspect(candidateRef);` (reads `existing.ref` `:104` only).

- [ ] **Step 2.5.7.2: Scan for lingering route `getSecret` calls (tsc CANNOT catch these)**

After this task, `services.vault.getSecret` MUST be **vault-internal-only** (called via `this.getSecret(` inside `vault.ts` by `resolveSecret`/`resolveRefs`/`generate`/the fingerprint-migration loop — Step 2.4.4 Note at the `getSecret`-stays line). **`tsc` cannot enforce this**: `getSecret` still returns a valid string-valued `SecretRecord`, so a leftover route call like `services.vault.getSecret(ref)` type-checks fine and silently keeps a stored plaintext string on the heap (the exact regression this burst removes). A static scan is the only mechanism that catches it. Confirm ZERO `services.vault.getSecret(` calls remain anywhere outside `vault.ts` (verified baseline: 8 such route calls at v0.3.1 — inject-submit `:53`, secrets-rotate `:50`, secrets `:154`/`:394`/`:484`, templates `:130`, secrets-delete `:50`, secrets-import `:103` — all must be gone, routed to `inspect` or `resolveSecret`/`resolveRefs`):
```bash
# Must print NOTHING. Vault internals use `this.getSecret(`; routes used
# `services.vault.getSecret(` — so this pattern is the precise route-leak check.
grep -rn "services\.vault\.getSecret(" src --include="*.ts" | grep -v "\.test\.ts"
# Belt-and-braces: any `.getSecret(` outside vault.ts (tests excluded) is also a leak.
grep -rn "\.getSecret(" src --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/vault/vault.ts"
```
Expected: both commands print nothing. If either prints a line, that route still resolves a stored plaintext string before its approval gate (or reads metadata off the wrong accessor) — migrate it (`inspect` for metadata-only, `resolveSecret`/`resolveRefs` after approval for true plaintext) before the green checkpoint. **Make this durable:** fold the assertion into the Task 2.7 guard test (add a second `test(...)` to `src/e2e/no-raw-resolved-value-in-response.test.ts` that scans `src/daemon` for `services.vault.getSecret(` / non-`vault.ts` `.getSecret(` and asserts zero offenders), so a future route re-introducing `getSecret` fails CI rather than silently leaking. (A grep at this step proves the migration; the committed guard prevents regression.)

- [ ] **Step 2.5.7.3: Green checkpoint — full typecheck + suite must be clean**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test 2>&1 | tail -12
```
Expected: **`tsc` clean** (every route consumer migrated; no remaining route reads `.value` as a string off a resolved/stored record except the legitimate vault internals + the `inspect`-routed metadata callers). Full suite green (1588 baseline + all §1/§2 tests added so far). If `tsc` still reports a `.value` error, it points at a consumer the migration missed — fix it before committing.

- [ ] **Step 2.5.7.4: Commit the whole accessor + consumer-migration batch (FIRST green tree since Task 2.4)**

This is the first `tsc`-clean point since the accessor split, so it is where the entire no-commit batch lands — the Task 2.4 accessor files staged at Step 2.4.7 **plus** every Task 2.5.* consumer migrated since (whatever you staged per-consumer with `git add -p`). Stage any not-yet-staged migrated files, then commit. (If you took the temporary-shim alternative and have been committing per-consumer against a green tree, this step is just the final metadata-caller commit.)

```bash
# The accessor split (staged at 2.4.7) + all 2.5.* consumers + the metadata callers — one green batch.
git add -A src/vault src/policy src/daemon
git status   # confirm the full accessor+consumer set is staged and the tree is tsc-clean (Step 2.5.7.3)
git commit -m "$(cat <<'EOF'
feat(vault): disposable ResolvedSecret accessor + migrate every consumer (5q)

Burst 7 §2 — one atomic refactor (committed at the first green tree).
resolveSecret/resolveRefs return ResolvedSecret = Omit<SecretRecord,
"value"> & { value: SecretValue }, wrapping the stored string into a
disposable at the resolve boundary; callers own + dispose it. getSecret
stays string-valued but vault-internal-only. assertSecretActionAllowed
widened to Pick<SecretRecord,"ref"|"allowed_actions"> so metadata +
resolved shapes both satisfy it. All resolve-path consumers migrated to
late-resolve-after-approval + dispose-in-finally; delete/rotate/generate-
overwrite-scope/import-existence routed to Vault.inspect → metadata-only
(no stored plaintext held across approval latency). Green checkpoint: tsc
clean, full suite passes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
> If review-granular commits are wanted, do them per-consumer ONLY under the temporary-shim alternative (each commit against a green tree); otherwise this single batch commit is the plan's default. Never commit before the Step 2.5.7.3 green checkpoint.

---

### Task 2.6: Write path — `UpsertSecretInput.value: SecretValue` + producers + vault disposal

**Files:**
- Modify: `src/vault/types.ts` (`UpsertSecretInput.value: SecretValue`)
- Modify: `src/vault/vault.ts` (`upsertSecret` Buffer write + dispose-in-finally; `generate` → `AgentSecretMetadata`)
- Modify: `src/daemon/api/routes/secrets.ts` (generate + capture producers)
- Modify: `src/daemon/api/routes/secrets-import.ts` (early-wrap + drop strings + dispose unconsumed)
- Modify: `src/daemon/api/routes/reveal-capture.ts` (proof-before-upsert reorder)
- Modify: `src/daemon/bootstrap/executor.ts` (bootstrap capture producer)
- Modify: relevant test files

- [ ] **Step 2.6.1: Write the failing vault-disposal + generate-return tests**

Append to `src/vault/vault.test.ts`:
```ts
// Burst 7 §2 (5q). upsertSecret OWNS and disposes UpsertSecretInput.value on
// EVERY exit path — success AND the pre-write secret_exists throw — so the
// inbound SecretValue is scrubbed even when the write never happens. And the
// stored record still round-trips its real value on disk. (Spec §2 Tests +
// §6 risk: toJSON must not corrupt the on-disk write.)
test("upsertSecret disposes the inbound SecretValue on success", async () => {
  const { vault } = await freshVault();
  const sv = SecretValue.fromUtf8("inbound-secret");
  await vault.upsertSecret({ name: "TOK", environment: "development", source: "local", value: sv, allowedDomains: [] });
  assert.throws(() => sv.bytes(), /used after dispose/, "disposed after a successful write");
});

test("upsertSecret disposes the inbound SecretValue on the secret_exists pre-write throw", async () => {
  const { vault } = await freshVault();
  await vault.upsertSecret({ name: "TOK", environment: "development", source: "local", value: SecretValue.fromUtf8("first"), allowedDomains: [] });
  const dup = SecretValue.fromUtf8("dup");
  await assert.rejects(
    () => vault.upsertSecret({ name: "TOK", environment: "development", source: "local", value: dup, allowedDomains: [] }),
    /already exists/,
  );
  assert.throws(() => dup.bytes(), /used after dispose/, "disposed even though the write threw before record build");
});

test("stored record round-trips its real plaintext on disk (SecretValue did not corrupt serialization)", async () => {
  const { vault } = await freshVault();
  await vault.upsertSecret({ name: "TOK", environment: "development", source: "local", value: SecretValue.fromUtf8("real-bytes-on-disk"), allowedDomains: [] });
  const resolved = await vault.resolveSecret("ss://local/dev/TOK");
  assert.equal(resolved.value.bytes().toString("utf8"), "real-bytes-on-disk");
  resolved.value.dispose();
});

test("Vault.generate returns AgentSecretMetadata (no value) and a valid ref", async () => {
  const { vault } = await freshVault();
  const meta = await vault.generate({ name: "GEN", environment: "development", source: "local", kind: "random_32_bytes", allowed_domains: [] });
  assert.equal((meta as Record<string, unknown>)["value"], undefined, "no plaintext in the generate return");
  assert.match(meta.ref, /^ss:\/\/local\/dev\/GEN$/);
  assert.equal(meta.value_visible_to_agent, false);
});
```
(Reuse/define `freshVault()` from the existing test harness. These tests run AFTER this task lands the write-path change, so `value` is a `SecretValue`.)

- [ ] **Step 2.6.2: Run, verify FAIL**

```bash
npm test -- --test-name-pattern "upsertSecret disposes|round-trips its real plaintext|Vault.generate returns" 2>&1 | tail -15
```
Expected: FAIL — `UpsertSecretInput.value` is still `string`; `generate` returns `SecretRecord`.

- [ ] **Step 2.6.3: Change `UpsertSecretInput.value` to `SecretValue`**

In `src/vault/types.ts`, change `:91` `value: string;` → `value: SecretValue;` (the `SecretValue` import was added in Task 2.4). The stored `SecretRecord.value: string` (`:38`) is UNCHANGED.

- [ ] **Step 2.6.4: Make `upsertSecret` Buffer-native + dispose in `finally`; change `generate` return**

In `src/vault/vault.ts`:
1. `upsertSecret` (`:60-105`): wrap the whole body in `try { ... } finally { input.value.dispose(); }` so the inbound `SecretValue` is scrubbed on the success path, the `secret_exists` throw (`:66`), and any read/write error. Inside, change `:83` `fingerprintSecret(Buffer.from(input.value, "utf8"), ...)` → `fingerprintSecret(input.value.bytes(), ...)`; change `:92` `value: input.value,` → `value: input.value.bytes().toString("utf8"),` (the stored string — the bounded encrypt-boundary transient). Structure:
```ts
  async upsertSecret(input: UpsertSecretInput): Promise<AgentSecretMetadata> {
    try {
      const plaintext = await this.read();
      // ... existing body, with:
      //   fingerprint: fingerprintSecret(input.value.bytes(), Buffer.from(plaintext.fingerprint_key as string, "base64")),
      //   value: input.value.bytes().toString("utf8"),
      // ... existing push/replace + await this.write(plaintext);
      return toAgentMetadata(record);
    } finally {
      // Vault OWNS the handed-off value — scrub on success, secret_exists throw,
      // and read/write error alike (the throw can fire before `record` is built).
      input.value.dispose();
    }
  }
```
2. `generate` (`:181-207`): change the return type to `Promise<AgentSecretMetadata>` and return the `upsertSecret` result directly (drop the `getSecret` read-back at `:202-206`). Wrap the generated encoded string via `SecretValue.fromUtf8` (`generateSecretValue` returns an encoded string — Code-Grounding #9):
```ts
  async generate(input: { /* unchanged */ }): Promise<AgentSecretMetadata> {
    return await this.upsertSecret({
      name: input.name,
      environment: input.environment,
      source: input.source,
      value: SecretValue.fromUtf8(generateSecretValue(input.kind)),
      allowedDomains: input.allowed_domains,
      ...(input.allowed_actions !== undefined ? { allowedActions: input.allowed_actions } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
    });
  }
```
(`upsertSecret` disposes the `SecretValue` in its `finally` — `generate` doesn't separately dispose.)

- [ ] **Step 2.6.5: Migrate the producers to `SecretValue`**

- **generate route** (`secrets.ts:204-205`): `const value = generateSecretValue(input.kind ?? "random_32_bytes");` then `upsertSecret({ ..., value, ... })` → wrap: `upsertSecret({ ..., value: SecretValue.fromUtf8(generateSecretValue(input.kind ?? "random_32_bytes")), ... })`. (`upsertSecret` disposes it.)
- **capture route** (`secrets.ts:360`): `value: capture.value,` → `value: SecretValue.fromUtf8(capture.value),` (accepted capture string boundary; `upsertSecret` disposes).
- **bootstrap capture** (`executor.ts:703`): `value: captured.value,` → `value: SecretValue.fromUtf8(captured.value),`.
- **reveal-capture** (`reveal-capture.ts`): **proof-before-upsert reorder** (verified: upsert `:424` currently runs BEFORE `proveAbsence` `:436`). Hold ONE owned `SecretValue.fromUtf8(capturedValue)`, run `proveAbsence` with `.bytes().toString("utf8")` FIRST, then hand the SAME `SecretValue` to `upsertSecret` LAST (which disposes it). Concretely, restructure `:420-440`:
```ts
      let meta: { ref: string; fingerprint: string } | undefined;
      let proofPassed = false;
      if (capturedValue !== "" && hideDone) {
        const sv = SecretValue.fromUtf8(capturedValue);
        try {
          // Prove absence FIRST (browser/CDP string-boundary transient).
          proofPassed = (await browser.proveAbsence(sv.bytes().toString("utf8"))).passed;
        } catch {
          proofPassed = false;
        }
        // Hand the SAME SecretValue to the vault LAST — it takes ownership and
        // disposes in its finally. No use-after-dispose: .bytes() above ran
        // before the upsert.
        meta = await services.vault.upsertSecret({
          name, environment: env, source, value: sv,
          allowedDomains: effectiveAllowed,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
        });
      }
```
  (This reorders the `hideDone` happy path so the proof runs BEFORE the upsert. **It does NOT collapse the unconditional store** — see the two-branch requirement below. The downstream `if (capturedValue !== "" && hideDone && proofPassed && meta !== undefined)` success branch `:442` is unchanged.)

  > **Important — preserve the existing store semantics exactly (verified against source).** Today the upsert is gated ONLY on `capturedValue !== ""` and is **unconditional on `hideDone`** (`reveal-capture.ts:423-430`): a non-empty capture is stored even when `!hideDone` (fail-closed-but-persisted). The `proveAbsence` proof is the part gated on `hideDone` (`:434-440`). The snippet above only handles the `hideDone` branch; do NOT let it drop the `!hideDone` store. Implement explicit two-branch logic:
> - **`capturedValue !== "" && hideDone`** → reorder as above: `SecretValue.fromUtf8` → `proveAbsence` (proof FIRST) → `upsertSecret` (vault takes ownership + disposes). The proof gates the success *return*, not the store.
> - **`capturedValue !== "" && !hideDone`** → keep a store path: wrap a separate `SecretValue.fromUtf8(capturedValue)` and hand it to `upsertSecret` (vault disposes it), with NO proof — preserving today's fail-closed-but-persisted behavior so `meta` is populated and the fail-closed audit still records the stored ref.
>
> Re-read `:420-463` during implementation. The spec's reorder targets only the happy path (capture+proof+store all succeed); the `!hideDone` persistence path must be carried forward unchanged (named test: a `!hideDone` capture still upserts — Task 2.6.5 caution).
- **import** (`secrets-import.ts`): see Steps 2.6.6–2.6.7 (early-wrap discipline is involved enough to warrant its own step; the failing dispose tests are written FIRST at 2.6.6, then the migration at 2.6.7).

- [ ] **Step 2.6.6: Write the FAILING import denial/skip/error dispose tests (BEFORE the migration)**

These are written first (TDD red) so the denial/skip/error disposal paths — the ones most likely to leak — are pinned by a test authored before the Step 2.6.7 migration that satisfies them. Add (to the import route test file):
```ts
// Burst 7 §2 (5q). import disposes every not-yet-stored entry SecretValue on
// the approval-DENIED path, the SKIP-existing path, and the secret_exists/error
// path; and drops the originally-parsed entries[].value strings after the wrap
// loop. (Spec §2 Tests: "import denial/skip/error paths dispose + clear".)
```
Stub `SecretValue.fromUtf8` (or spy on the produced `SecretValue.dispose`) to assert disposal on: (a) production + `wait_for_approval:false` no-approval → denied; (b) `skip_existing` with a pre-existing ref; (c) duplicate ref without `force` → `secret_exists`; (d) **mid-parse-loop throw**: a first entry that is valid (and so wraps a live `SecretValue`) followed by a malformed entry (e.g. missing `value`) — assert the first entry's `SecretValue` is disposed even though the throw fires inside the parse/wrap loop, BEFORE the route-level `try` (`:61`). (This is the case the Step 2.6.7 guard `try/catch` around the parse loop satisfies; the route-level `catch` alone does not cover it.)

> **Do NOT run `npm test` here.** Task 2.6 is itself an atomic batch: Step 2.6.3 changes `UpsertSecretInput.value` to `SecretValue`, which makes every producer — incl. `secrets-import.ts` (still passes a string `entry.value` at `:135`) — tsc-red until migrated. So at this point `npm test` reports a whole-project build error, not the behavioral FAIL. The "verify FAIL" is a **pre-implementation expectation** you record while writing the test (the route does not yet wrap entries as `SecretValue`/dispose on these paths); it is first *observed green* at the Step 2.6.8 full-suite checkpoint (`npm test`), alongside the rest of the Task 2.6 producer batch. (To see a genuine per-route red instead, the only safe option is the temporary-compatibility-shim alternative from the Step 2.4.6 Sequencing note, which also applies to this 2.6 producer batch.)

- [ ] **Step 2.6.7: Migrate import — early-wrap at the parse loop + drop strings + dispose unconsumed**

In `src/daemon/api/routes/secrets-import.ts`:
1. Change `ImportEntry` (`:11-14`): `{ key: string; value: SecretValue }`.
2. At the parse loop (`:41-48`), wrap each value INTO a `SecretValue` immediately and drop the raw parsed string reference. The `optString`-extracted `value` local is consumed straight into `fromUtf8` and not stored elsewhere; after the loop, null the parsed-body refs so the originals are GC-eligible before the approval gate. **Wrap the parse/wrap loop ITSELF in a `try/catch` that disposes already-wrapped entries on a mid-loop throw** — the existing route's `try` starts AFTER this loop (`:61`), so a later entry that fails validation (`:45-46` missing-key/value) or `asObject`/`optString` would otherwise leak every `SecretValue` wrapped from a prior valid entry. Declare `entries` before this guard `try` so the migrated `catch` and the downstream store loop both see it:
```ts
    const entries: ImportEntry[] = [];
    try {
      for (const e of entriesRaw) {
        const eo = asObject(e);
        const key = optString(eo, "key");
        const value = optString(eo, "value");
        if (key === undefined) throw new ShuttleError("missing_param", "entries[].key required");
        if (value === undefined) throw new ShuttleError("missing_param", "entries[].value required");
        entries.push({ key, value: SecretValue.fromUtf8(value) });
        // Drop the raw parsed value string from the request-body object graph so
        // it is GC-eligible before the (possibly long) production approval gate.
        // (JS strings can't be zeroed; the win is prompt unreachability — same
        // Tier-A bound as the vault read transient.)
        if (e !== null && typeof e === "object") delete (e as Record<string, unknown>)["value"];
      }
    } catch (err) {
      // A later entry threw during parse/validation AFTER earlier entries were
      // already wrapped into live SecretValues — the route-level catch (:153)
      // does not cover this pre-try region, so dispose here. (dispose() is
      // idempotent; this only ever holds not-yet-stored values.)
      for (const entry of entries) entry.value.dispose();
      throw err;
    }
```
   (This guard `try` is distinct from — and precedes — the existing route-level `try` at `:61`; do NOT merge them, since the route-level `catch` writes a failure audit that should not fire for these pre-approval parse errors.)
3. The `entries.map((e) => e.key).join(",")` in the binding (`:75`) is unchanged (keys are not secret).
4. At the upsert (`:131-140`), pass the `SecretValue`: `value: entry.value,` (it's already a `SecretValue`). `upsertSecret` OWNS + disposes it — the route does NOT separately dispose a handed-off value.
5. **Dispose unconsumed `SecretValue`s on skip / deny / error.** On the **skip-existing** branch (`:110-113`, entry skipped, not stored) dispose `entry.value` before `continue`. On **every error/throw path** (the `catch` at `:153`, including `secret_exists` `:123` and approval-denied from `requireApprovals` `:79`), iterate the not-yet-consumed entries and dispose each. Track consumption with an index or a `Set` of consumed entries. Concretely:
```ts
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        // ... existing existence check ...
        if (existingRef !== undefined) {
          if (skipExisting) {
            entry.value.dispose(); // skipped — not handed to the vault
            skipped_existing.push(entry.key);
            continue;
          }
          if (!force) {
            // ... existing secret_exists audit ...
            // Dispose THIS entry + all remaining unconsumed entries before throw.
            for (let j = i; j < entries.length; j++) entries[j]!.value.dispose();
            throw new ShuttleError("secret_exists", `...`);
          }
        }
        await services.vault.upsertSecret({ ..., value: entry.value, ... }); // vault disposes
        // ... existing imported++ + audit ...
      }
```
   And in the route-level `catch` (`:153`), defensively dispose any entry whose value hasn't been disposed yet (e.g. the production approval-denied path throws from `requireApprovals` at `:79` BEFORE the entry loop — so ALL entries are unconsumed there): wrap the body so the `catch` iterates `entries` and disposes each (`dispose()` is idempotent, so double-dispose on already-consumed/skipped entries is safe). Simplest: in the `catch`, `for (const entry of entries) entry.value.dispose();` (idempotent — vault-consumed + skipped entries are already disposed; this scrubs the approval-denied-before-loop case).

- [ ] **Step 2.6.7b: PASS checkpoint for the Step 2.6.6 import dispose tests — DEFERRED to the Step 2.6.8 green tree**

The denial/skip/error dispose tests written at Step 2.6.6 now pass against the migrated route — but do NOT run them in isolation yet: the Task 2.6 producer batch leaves the test files tsc-red (callers still pass `value: "string"` to `upsertSecret`) until Step 2.6.8 updates them, so `npm test` build-fails before this point. This is the green half of the 2.6.6 red→green pair; it is **verified at the Step 2.6.8 full-suite checkpoint** below (which runs the whole suite green, including these import tests). If you want to re-confirm just these after 2.6.8 is green:
```bash
# Run ONLY at/after the Step 2.6.8 green checkpoint — not against the red producer-batch tree:
npm test -- --test-name-pattern "import disposes|import.*dispose" 2>&1 | tail -15
```
Expected (at/after 2.6.8): PASS.

- [ ] **Step 2.6.8: Update all producer/upsert call-site tests + full suite green**

```bash
npx tsc --noEmit 2>&1 | head -30
npm test 2>&1 | tail -12
```
Expected: every `upsertSecret`/`generate` test caller now constructs a `SecretValue` (update any test that passed a `value: "string"` to `value: SecretValue.fromUtf8("...")`); `tsc` clean; full suite green. The bootstrap/capture/reveal-capture/import behavioral tests pass with the producer changes.

- [ ] **Step 2.6.9: Commit**

```bash
git add src/vault/types.ts src/vault/vault.ts src/daemon/api/routes/secrets.ts src/daemon/api/routes/secrets-import.ts src/daemon/api/routes/reveal-capture.ts src/daemon/bootstrap/executor.ts <test-files>
git commit -m "$(cat <<'EOF'
refactor(vault): UpsertSecretInput.value is SecretValue; vault owns disposal (5q)

Burst 7 §2 write path. UpsertSecretInput.value → SecretValue; upsertSecret
serializes input.value.bytes().toString("utf8") into the stored string and
disposes the inbound SecretValue in a finally (success, secret_exists
pre-write throw, and read/write error). Vault.generate returns
AgentSecretMetadata (drops the getSecret read-back) so no stored string
crosses the vault boundary. Producers: generate/Vault.generate wrap the
ENCODED generateSecretValue string via fromUtf8; capture/bootstrap wrap
the captured string; reveal-capture proves absence BEFORE upsert on one
owned SecretValue; import early-wraps at the parse loop, drops the parsed
request-body strings before the approval gate, and disposes unconsumed
entries on skip/deny/error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.7: Guard test — repo-scan for raw resolved `.value` in response serializers

**Files:**
- Create: `src/e2e/no-raw-resolved-value-in-response.test.ts`

- [ ] **Step 2.7.1: Write the guard test**

Create `src/e2e/no-raw-resolved-value-in-response.test.ts` with **two** guard tests: (1) it scans daemon route files for a raw resolved `.value` (as opposed to `.value.bytes()`) flowing into a response/serializer — allowing the one intentional plaintext-out path (`inject-render`'s stdout mode returns the *rendered template string* `content: rendered`, a render output, NOT a `SecretValue.value`); and (2) it scans `src/daemon` for any `getSecret` call (the string-valued accessor must be vault-internal-only post-migration — `tsc` cannot catch a re-introduced route call, per the P2 finding):
```ts
// src/e2e/no-raw-resolved-value-in-response.test.ts
//
// Burst 7 §2 (5q) guard. After the SecretValue migration, no daemon route may
// pass a RAW resolved `.value` (a SecretValue) into a response/serializer — the
// only byte door is `.value.bytes()`. This scans the route files for the
// dangerous patterns. It deliberately does NOT forbid all plaintext in
// responses: inject-render's stdout mode returns the rendered TEMPLATE STRING
// (`content: rendered`), which is a render output, not a SecretValue.value —
// that is the one intentional, agent-requested plaintext-out wire surface (§0).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(process.cwd(), "src/daemon/api/routes");

// A resolved SecretValue's value must only ever be read via `.value.bytes()`.
// Flag any resolved-record `.value` access that is NOT immediately followed by
// `.bytes(` / `.dispose(` / `.byteLength` / `.equals(` — i.e. a raw SecretValue
// escaping. TWO access shapes must be caught (verified against the migrated
// run-resolve sink shape `resolved.get(ref)!.value.bytes()`):
//   (1) direct:  `resolved.value` / `secret.value` / `record.value`
//   (2) indexed: `resolved.get(<ref>)!.value` / `.get(...)?.value` / `.get(...).value`
//       — here the token immediately before `.value` is `)`/`!)`/`?)`, NOT the
//         word `resolved`, so a word-boundary `\bresolved\.value` regex would
//         MISS it. The indexed alternative below anchors on `.get(...)`.
const SUSPICIOUS_DIRECT = /\b(resolved|secret|record)\.value\b(?!\s*\.(bytes|dispose|byteLength|equals)\b)/;
const SUSPICIOUS_INDEXED = /\bresolved\.get\([^)]*\)[!?]?\.value\b(?!\s*\.(bytes|dispose|byteLength|equals)\b)/;

test("no daemon route reads a raw resolved SecretValue (.value without .bytes()/.dispose())", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(ROUTES_DIR, f), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip producer boundaries where `.value` is a page-side capture string
      // being WRAPPED into a SecretValue (SecretValue.fromUtf8(capture.value)).
      if (/SecretValue\.fromUtf8\(/.test(line)) continue;
      // NOTE: do NOT blanket-skip every `resolved.get(` line. run-resolve's
      // env-entry ref is `resolved.get(entry.value)` — the `.value` there is an
      // ARGUMENT inside the parens (the ref `entry.value`), which neither
      // SUSPICIOUS regex matches (the direct one requires `resolved|secret|
      // record` immediately before `.value`; `entry` is none of those, and the
      // indexed one only fires on a TRAILING `.value` after `.get(...)`). So a
      // blanket `resolved.get(` skip is both unnecessary and dangerous — it
      // would hide a real raw `resolved.get(ref)!.value` regression. The
      // SUSPICIOUS_INDEXED pattern catches that regression; the legitimate
      // `resolved.get(ref)!.value.bytes()` sink is excluded by the negative
      // lookahead. (If `entry.value`-as-ref ever DID false-match after a
      // refactor, add a narrow skip for the exact ref-argument shape — never a
      // blanket `.get(` skip.)
      if (SUSPICIOUS_DIRECT.test(line) || SUSPICIOUS_INDEXED.test(line)) {
        offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Raw resolved SecretValue read(s) found — use .value.bytes() and dispose:\n${offenders.join("\n")}`,
  );
});

// Burst 7 §2 (5q) guard #2 — `getSecret` is vault-internal-only. After the
// migration, the string-valued Vault.getSecret accessor must NOT be called from
// any route: metadata callers use Vault.inspect, true-plaintext consumers use
// resolveSecret/resolveRefs. `tsc` cannot enforce this (getSecret still returns
// a valid SecretRecord, so a leftover route call type-checks while silently
// keeping a stored plaintext string on the heap before the approval gate). This
// scan is the only mechanism that catches a re-introduced route getSecret.
// Vault internals call it via `this.getSecret(` inside vault.ts; routes called
// `services.vault.getSecret(`. So both: zero `services.vault.getSecret(`
// anywhere, and zero `.getSecret(` outside vault.ts.
test("Vault.getSecret is vault-internal-only — no daemon route/module calls getSecret", () => {
  const DAEMON_DIR = join(process.cwd(), "src/daemon");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/services\.vault\.getSecret\(/.test(line) || /\.getSecret\(/.test(line)) {
          offenders.push(`${p.replace(process.cwd() + "/", "")}:${i + 1}  ${line.trim()}`);
        }
      }
    }
  };
  walk(DAEMON_DIR);
  assert.deepEqual(
    offenders,
    [],
    `getSecret called outside vault internals — route metadata callers to Vault.inspect, plaintext consumers to resolveSecret/resolveRefs:\n${offenders.join("\n")}`,
  );
});
```
(`src/daemon` excludes `src/vault/vault.ts`, where the legitimate `this.getSecret(` internal callers live — so the recursive `.getSecret(` scan is safe here. If a future refactor moves a legitimate internal caller into `src/daemon`, narrow the second predicate to `services\.vault\.getSecret\(` only.)

> **Implementer note (judgment call):** the regexes are heuristics. Before relying on the guard, run it against the migrated tree and confirm (a) it produces ZERO offenders, AND (b) temporarily reverting the run-resolve sink `resolved.get(entry.value)!.value.bytes().toString("utf8")` back to a raw `resolved.get(entry.value)!.value` makes it FIRE (proves `SUSPICIOUS_INDEXED` catches the indexed-access regression that a `\bresolved\.value` regex would miss), AND (c) reverting a direct `secret.value.bytes()` to `secret.value` also fires. If `SecretValue.fromUtf8(...)` proves too coarse a skip, tighten to explicit allow-list lines. The contract the test enforces is the spec's: no daemon route serializes a raw resolved `.value`; the `inject-render -o -` `content: rendered` path is a render-string, which neither regex matches (it is `rendered`, not `*.value`).

- [ ] **Step 2.7.2: Run the guard + the full suite, verify PASS**

```bash
npm test -- --test-name-pattern "no daemon route reads a raw resolved|getSecret is vault-internal-only" 2>&1 | tail -12
npm test 2>&1 | tail -12
npx tsc --noEmit 2>&1 | head -5
```
Expected: BOTH guards PASS (zero offenders each — no raw resolved `.value`, no route `getSecret`); full suite green (1588 baseline + all §1/§2 tests); typecheck clean.

- [ ] **Step 2.7.3: Prove the guard catches BOTH access shapes (sanity check, do NOT commit the regression)**

Prove the guard is load-bearing for both the direct and the indexed-access shapes (the indexed one is the run-resolve sink that a naive `\bresolved\.value` regex misses):
1. Temporarily revert a **direct** consumer (e.g. `secret.value.bytes()` → `secret.value` in inject-submit/secrets), run the guard, confirm it FAILS (caught by `SUSPICIOUS_DIRECT`), then revert.
2. Temporarily revert the **indexed** run-resolve sink (`resolved.get(entry.value)!.value.bytes().toString("utf8")` → `resolved.get(entry.value)!.value`), run the guard, confirm it FAILS (caught by `SUSPICIOUS_INDEXED`), then revert.
Both must fire — if the indexed revert does NOT fire, the `SUSPICIOUS_INDEXED` pattern is wrong (it is the whole point of the P2 guard-tightening) and must be fixed before this task is complete.

- [ ] **Step 2.7.4: Commit**

```bash
git add src/e2e/no-raw-resolved-value-in-response.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): guards — no raw resolved SecretValue; getSecret vault-internal (5q)

Burst 7 §2. Two repo-scan guards tsc cannot provide. (1) Route files must
read a resolved value only via .value.bytes() (the single audited door),
never raw — catches both the direct (secret.value) and indexed
(resolved.get(ref)!.value) access shapes; allows the one intentional
plaintext-out surface (inject-render -o - returns the rendered template
string `content`, not a SecretValue.value) and the producer-side
SecretValue.fromUtf8(capture.value) wrap. (2) Vault.getSecret (string
accessor) is vault-internal-only: zero `services.vault.getSecret(` /
non-vault.ts `.getSecret(` calls — a re-introduced route getSecret would
type-check but leak a stored plaintext string before the approval gate.
Both proven load-bearing by revert-and-fail sanity checks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Wrap

### Task W.1: Correct stale keychain "stub" doc comments (5a-doc, pure lint)

**Files:**
- Modify: `src/vault/keychain/index.ts`
- Modify: `src/vault/keychain/types.ts`

5a (native keychain) already shipped — the adapters are complete `@napi-rs/keyring`-backed implementations, NOT stubs. Only the doc comments are stale (spec §0 + Wrap.1). No functional change.

- [ ] **Step W.1.1: Fix `index.ts` (`:14-23`)**

Use Edit on `src/vault/keychain/index.ts` to replace the `getKeychainAdapter` doc block. Replace:
```ts
/**
 * Return the platform-appropriate keychain adapter.
 *
 * On supported platforms (darwin, linux, win32), returns the per-platform
 * class — note **all three are stubs in Plan 1**; Plan 5a replaces their
 * internals with native-module-backed implementations.
 *
 * On unsupported platforms, returns an UnsupportedKeychain that mirrors the
 * stub behavior (isAvailable → false; ops throw keychain_not_implemented).
 */
```
with:
```ts
/**
 * Return the platform-appropriate keychain adapter.
 *
 * On supported platforms (darwin, linux, win32), returns the per-platform
 * class — each backed by @napi-rs/keyring, which talks to the OS keyring
 * through memory APIs (never argv).
 *
 * On unsupported platforms, returns an UnsupportedKeychain (isAvailable →
 * false; ops throw keychain_not_implemented).
 */
```

- [ ] **Step W.1.2: Fix `types.ts` (`:1-15`)**

Use Edit on `src/vault/keychain/types.ts` to replace the interface doc block. Replace:
```ts
/**
 * Adapter interface for OS-level secret storage.
 *
 * Each platform's adapter is backed by a native module (likely
 * @napi-rs/keyring, evaluated in Plan 5a) that talks to the OS keyring
 * through memory APIs — never argv. This avoids the `ps`-recoverable
 * password leak inherent in shell-CLI wrappers around `security`,
 * `secret-tool`, or PowerShell credential cmdlets.
 *
 * Plan 1 ships stubs only; Plan 5a wires in the real implementations.
 *
 * Keys are namespaced by (service, account). For Secret Shuttle's master key,
 * we use service = "secret-shuttle" and account = the daemon's unique vault id
 * (so multiple Secret Shuttle vaults don't collide on one machine).
 */
```
with:
```ts
/**
 * Adapter interface for OS-level secret storage.
 *
 * Each platform's adapter is backed by @napi-rs/keyring, which talks to the OS
 * keyring through memory APIs — never argv. This avoids the `ps`-recoverable
 * password leak inherent in shell-CLI wrappers around `security`,
 * `secret-tool`, or PowerShell credential cmdlets.
 *
 * Keys are namespaced by (service, account). For Secret Shuttle's master key,
 * we use service = "secret-shuttle" and account = the daemon's unique vault id
 * (so multiple Secret Shuttle vaults don't collide on one machine).
 */
```

- [ ] **Step W.1.3: Verify no remaining stale references + tests pass**

```bash
grep -rn "stub\|Plan 1\|Plan 5a" src/vault/keychain/index.ts src/vault/keychain/types.ts
npm test -- --test-name-pattern "keychain" 2>&1 | tail -10
```
Expected: no matches (no "stub"/"Plan 1"/"Plan 5a" left in those two files); keychain tests still pass (pure comment change).

- [ ] **Step W.1.4: Commit**

```bash
git add src/vault/keychain/index.ts src/vault/keychain/types.ts
git commit -m "docs(keychain): correct stale 'stub / Plan 5a' comments to shipped @napi-rs/keyring reality"
```

---

### Task W.2: CHANGELOG Burst 7 entry (under `## Unreleased`, above Burst 6)

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step W.2.1: Locate the insertion point**

```bash
grep -n "^## Unreleased\|^### Added (Burst 6\|^### Added (Burst 5" CHANGELOG.md | head -5
```
Expected: `## Unreleased` near the top, with `### Added (Burst 6 — Vision Polish)` as the first subsection. The Burst 7 block inserts as sibling subsections ABOVE Burst 6 (both under `## Unreleased`).

- [ ] **Step W.2.2: Insert the Burst 7 subsections**

Use Edit to insert, immediately above the `### Added (Burst 6 — Vision Polish)` line:
```markdown
### Added (Burst 7 — Identity & Memory Hardening)

- **Opt-in per-project agent IDs (§1, Plan 5s):** `deriveAutoAgentId` gains an optional `projectScope` parameter (2-arg callers get byte-identical output — zero identity change for existing users). Opt in via `identity.perProject: true` in `secret-shuttle.config.json` OR `secret-shuttle init --per-project-identity` (the flag also persists the opt-in into the config). When on, `init` hashes the git-repo-root path (`git rev-parse --show-toplevel`, else cwd) into the derived id. One git repo = one trust domain (sub-projects share an id); moving the project dir re-derives the id on the next `init` and orphans that project's prior sessions/grants. The id format and `AGENT_ID_RE` validity are unchanged.
- **`SecretValue` redaction-safe scrubbable wrapper (§2, Plan 5q):** new `src/vault/secret-value.ts`. Secret plaintext on the per-secret *use path* now lives as bytes in a `SecretValue` whose only byte accessor is the greppable `.bytes()`; `String()`/template/`JSON.stringify`/`util.inspect` all redact to `"[secret]"`, and `dispose()` zeros the backing Buffer (a subsequent `.bytes()` throws). This keeps long-lived plaintext copies out of the daemon heap between vault resolution and the sink.

### Changed (Burst 7 — Identity & Memory Hardening)

- **Buffer use-path (§2, Plan 5q — internal-only, no wire change):** `fingerprintSecret`/`fingerprintMatches` take `Buffer` (migration-free — identical digest for identical bytes, so all existing stored fingerprints stay valid). A new `resolveSecret`/`resolveRefs` accessor returns a disposable `ResolvedSecret` (`Omit<SecretRecord,"value"> & { value: SecretValue }`); metadata/existence-only routes (delete, rotate, generate-overwrite-scope, import-existence, and every consumer's pre-approval preflight) move to the value-free `Vault.inspect`→`AgentSecretMetadata`, so they hold no plaintext at all. `assertSecretActionAllowed` is widened to `Pick<SecretRecord,"ref"|"allowed_actions">`. `UpsertSecretInput.value` becomes `SecretValue`, and `upsertSecret` owns + disposes it in a `finally` on every exit (incl. the pre-write `secret_exists` throw). `Vault.generate` now returns `AgentSecretMetadata` (no stored-string read-back). Every per-secret consumer adopts a two-phase late-resolve discipline — metadata-only preflight before the approval gate, plaintext `SecretValue` resolved only after, disposed in `finally` — so no candidate or resolved secret value is held across human-approval latency on any route (`inject-submit` holds one `SecretValue` across inject→observeText→proveAbsence and disposes once; `compare` captures the page candidate only after approval; `reveal-capture` proves absence before upsert; `inject-render` validates the output path before render in file mode; `run-resolve` drops the secret env strings and disposes after spawn; `import` early-wraps at the parse loop and disposes unconsumed entries on skip/deny/error). Child stdin, the tmp env-file writer, and the run masker go Buffer-native. The on-disk JSON vault format and all HTTP request/response shapes are unchanged.
- **5a keychain doc-comment fix (Wrap):** `src/vault/keychain/index.ts` + `types.ts` comments now describe the shipped `@napi-rs/keyring`-backed implementations instead of the obsolete "stubs in Plan 1 / Plan 5a wires in the real implementations" language. Pure documentation lint — no functional change.

### Known limitations — Burst 7

- **5q is Tier A only.** The bulk vault persist/load path (`crypto.ts`'s `JSON.stringify(VaultPlaintext)`→encrypt / decrypt→`JSON.parse`) still materializes every stored value as a JS string for the duration of the vault read/write op — eliminating that needs a binary on-disk format + migration (Tier B), explicitly deferred. The other remaining bounded plaintext strings are the accepted platform/protocol boundaries: browser/CDP inject+capture, the `inject-render` template render, the child `NodeJS.ProcessEnv` (string-only platform API; survives in the *child* for its lifetime), and the agent-requested `inject-render -o -` render output.
- Per-subdirectory (sub-monorepo) identity granularity beyond git-root, and the CI/CD secret-delivery story, remain deferred (spec §3).
```

- [ ] **Step W.2.3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(CHANGELOG): Burst 7 — Identity & Memory Hardening (per-project IDs + SecretValue Buffer use-path + keychain doc fix)"
```

---

### Task W.3: Version bump 0.3.1 → 0.4.0

**Files:**
- Modify: `package.json`

5q is a minor bump (new opt-in feature + internal hardening, no breaking wire change) — spec version target 0.4.0.

- [ ] **Step W.3.1: Bump the version**

In `package.json` (`:3`), change `"version": "0.3.1",` → `"version": "0.4.0",`.

- [ ] **Step W.3.2: Verify check-pack + full suite + typecheck**

```bash
npm run check-pack 2>&1 | tail -5
npm test 2>&1 | tail -12
npx tsc --noEmit 2>&1 | head -5
grep -n '"version": "0.4.0"' package.json
```
Expected: `check-pack` OK; full suite green (1588 baseline + all §1/§2 tests, 0 fail); typecheck clean; version reads 0.4.0.

- [ ] **Step W.3.3: Commit**

```bash
git add package.json
git commit -m "chore: bump to 0.4.0 (Burst 7 — Identity & Memory Hardening)"
```

---

### Task W.4: Codex impl-stage gate + merge (orchestrator-handled)

> **NOTE:** The codex impl-stage review gate AND the merge-to-main are handled by the orchestrator, NOT by this plan's executor. After all §1/§2/Wrap tasks land and the branch is green (full suite + `tsc --noEmit` + `check-pack`), the orchestrator invokes the codex-review-gate skill (`--stage impl`), resolves findings to `STATUS: CLEAN`, then merges `burst7/identity-memory-hardening` to `main` with `--no-ff`, re-runs tests on the merged tree, cleans up the worktree/branch, and decides on publish. The executor's job ends at a green branch.

- [ ] **Step W.4.1: Confirm the branch is green + summarize for the orchestrator**

```bash
git branch --show-current        # burst7/identity-memory-hardening
git log --oneline main..HEAD | wc -l   # roughly one commit per task/atomic-batch (the 2.4→2.5.7 and 2.6.* batches each land as a single commit, so the count is lower than the raw step count — used only as a sanity check, not an exact gate)
npm test 2>&1 | tail -5
npx tsc --noEmit && npm run check-pack 2>&1 | tail -3
```
Expected: on the burst7 branch; full suite green; typecheck + check-pack clean. Hand off to the orchestrator for the codex impl gate + merge.

---

## Self-Review

**Spec coverage (every spec section → a task):**

| Spec section | Task(s) |
|---|---|
| §0 5a-doc (stale keychain comments) | Wrap W.1 ✓ |
| §1 5s — `deriveAutoAgentId` 3-arg + 2-arg byte-identical pin | Task 1.1 ✓ |
| §1 5s — `resolveProjectScope(cwd)` (git-root \|\| cwd) + tests | Task 1.1 (impl) + 1.2 (tests) ✓ |
| §1 5s — `identity.perProject` config loader (mirror `loadInferConfig`) | Task 1.3 ✓ |
| §1 5s — `init --per-project-identity` flag (writes/merges, preserves `infer.*`) + caller wiring | Task 1.4 ✓ |
| §1 5s — error codes (none new), monorepo/relocation/determinism notes | Task 1.4 (--help text) + CHANGELOG W.2 ✓ |
| §2 5q — audit pass (categorized site-map, no code change) | Task 2.1 ✓ |
| §2 5q — `SecretValue` class + full unit tests (redaction/dispose/equals/fromBuffer) | Task 2.2 ✓ |
| §2 5q — `fingerprintSecret`/`Matches` → Buffer + migration-free pin + vault-internal callers | Task 2.3 ✓ |
| §2 5q — `ResolvedSecret` + `resolveSecret`/`resolveRefs` + metadata-accessor routing + `assertSecretActionAllowed` widening | Task 2.4 (types/accessor/policy) + 2.5.7 (metadata callers) ✓ |
| §2 5q — value-free `READ_META_SCRIPT` preflight + named regression test | Task 2.5.0 ✓ |
| §2 5q — per-consumer two-phase discipline: inject-submit (multi-sink, single dispose) | Task 2.5.1 ✓ |
| §2 5q — `/v1/secrets/inject` late-resolve | Task 2.5.2 ✓ |
| §2 5q — templates stdin (Buffer-native run.ts/tmp-env-file) | Task 2.5.3 ✓ |
| §2 5q — run-resolve env string-boundary + drop-reference after spawn + Buffer masker/stdin + spawner closure fix | Task 2.5.4 ✓ |
| §2 5q — inject-render file-mode validate-before-render + stdout plaintext-out preserved | Task 2.5.5 ✓ |
| §2 5q — compare late-capture reorder + metadata-only | Task 2.5.6 ✓ |
| §2 5q — write path: `UpsertSecretInput.value: SecretValue`; generate/capture/bootstrap producers (encoded `fromUtf8`); reveal-capture proof-before-upsert; import early-wrap + drop strings + dispose unconsumed; `Vault.generate`→`AgentSecretMetadata`; vault disposal-in-finally | Task 2.6 ✓ |
| §2 5q — guard test (SecretValue redaction covered in 2.2; repo-scan for raw resolved `.value`) | Task 2.2 + Task 2.7 ✓ |
| §2 Tests — named ordering/lifetime guarantees (compare-after-approval, import deny/skip/error, inject-render file-mode, run-resolve env clear, all-consumers-after-approval, inject-submit multi-sink, reveal-capture proof-before-upsert, upsert dispose-on-throw) | Tasks 2.5.1/2.5.2/2.5.3/2.5.4/2.5.5/2.5.6 + 2.6 ✓ |
| §3 Out-of-scope (Tier B, CI/CD, more detectors, sub-monorepo) | NOT implemented (documented in CHANGELOG Known-limitations) ✓ |
| §4 Implementation order | Tasks ordered §1 → §2 audit → SecretValue → fingerprint → resolve-path → write-path → guard → Wrap ✓ |
| §5 Success criteria (1 per-project ids; 2 no long-lived plaintext + redaction + no-cross-approval-hold; 3 no wire change; 4 keychain doc; 5 suite green/0.4.0; 6 codex gates) | Covered across §1/§2/Wrap; §5.6 = W.4 (orchestrator) ✓ |
| §6 Risks (missed consumer → guard+audit; toJSON corrupts on-disk → round-trip test; early dispose → e2e + finally pattern; flag clobbers infer.* → merge test; git rev-parse quirks → cwd fallback; fingerprint signature → tsc + pin) | Mitigations embedded in the corresponding tasks ✓ |

**No placeholders:** every code step shows the actual code; every test step shows either the actual test code OR a concrete named-test outline with explicit per-assertion guidance (the `2.5.4.3`/`2.5.5.1` env-clear/file-mode-reorder lifetime tests are given as named `// (a)/(b)/(c)` outlines plus the exact stub/spy/assert recipe to write them — not bare prose, but not full literal source either; the executor writes the body from the outline + the migration code in the same step). File paths + real line numbers + exact commands + expected output are given throughout. The literal `supabase:TODO_...` strings referenced are not in this plan (that was Burst 6); no `TBD`/`TODO`-as-placeholder remains.

**Type consistency:** `SecretValue` (Task 2.2) → used identically in 2.3 (fingerprint inputs via `.bytes()`), 2.4 (`ResolvedSecret = Omit<SecretRecord,"value"> & { value: SecretValue }`), 2.5.* (consumer `.bytes()`/`dispose()`), 2.6 (`UpsertSecretInput.value: SecretValue`, producers `SecretValue.fromUtf8`). `ResolvedSecret` (2.4) → `resolveSecret`/`resolveRefs` return type, used in every 2.5.* consumer. `fingerprintSecret(value: Buffer, key: Buffer)` (2.3) → vault callers + compare. `assertSecretActionAllowed(secret: Pick<SecretRecord,"ref"|"allowed_actions">, ...)` (2.4) → satisfied by both `AgentSecretMetadata` and `ResolvedSecret` in 2.5.*. `READ_META_SCRIPT` (2.5.0) → consumed by `readFocusedFingerprintAndDomain`, used by inject + compare preflights.

**Source vs. spec — contradictions found:** none material. The spec's line numbers and signatures matched the source on every point verified (10 gate rounds paid off). Two minor notes for the executor: (a) the spec lists `getSecret` callers and capture sites by line number that I re-confirmed exact (`secrets.ts:154/394/484`, `inject-submit.ts:53`, `templates.ts:130`, `run-resolve.ts:220`, `inject-render.ts:54`, `secrets-import.ts:103`, `secrets-delete.ts:50`, `secrets-rotate.ts:50`); (b) `generate-value.ts` is at `src/daemon/helpers/generate-value.ts` (the parent-task brief said `src/vault/generate-value.ts`, which does not exist — the spec itself already cites the correct `src/daemon/helpers/` path, so no contradiction with the spec).

**Judgment calls (carry forward to the executor):**
- **Tasks 2.4 → 2.5.7 are ONE no-commit batch — never commit a `tsc`-red tree.** The accessor split (2.4) makes the `resolveRefs`/`resolveSecret` consumers red until migrated, and `npm test` builds the whole project, so nothing compiles or tests until the batch is complete. Stage at 2.4.7 (Step 2.4.7 — `git add`, no commit), implement 2.5.* back-to-back, and commit the whole accessor+consumer batch at the first green tree (Step 2.5.7.3 checkpoint → Step 2.5.7.4 commit). Review-granular per-consumer commits are allowed ONLY via the temporary-compatibility-shim alternative (each commit against a green tree); the no-commit batch is the default.
- **`run.ts` makes its own `Buffer.from(input.secret.bytes())` copy** for the stdin/env-file write+scrub, leaving the route to dispose the `SecretValue` — clear ownership, preserves `run.ts`'s existing scrub-the-written-buffer logic (Task 2.5.3 decision box).
- **`run-resolve` env-clear + `SecretValue` dispose happen immediately after `spawnAndStream` is INITIATED (synchronously after the call returns), NOT in the outer `finally`** — the child already has its env copy and `spawnAndStream` no longer retains `input.env` (destructured locals, Step 2.5.4.2), so the route clears its own `env[entry.key]` strings + disposes each `SecretValue` right away rather than holding them across the awaited child lifetime (spec §2.5.4 drop-reference requirement). Only the **masker bytes** are scrubbed in the existing outer `finally`. A pre-spawn failure path still disposes every resolved `SecretValue` (Step 2.5.4.3 test (c)).
- **The compare byte-wrap (`Buffer.from(capture.value,"utf8")`) lands in Task 2.3** (to keep `tsc` green at the fingerprint-signature change); the compare *late-capture reorder* stays in Task 2.5.6.
- **`reveal-capture` `!hideDone` persistence** — the reorder targets the happy path; the executor must re-read `reveal-capture.ts:420-463` and preserve the existing fail-closed-persist behavior for the `!hideDone` branch exactly (Task 2.6.5 caution).
- **The guard regex (Task 2.7) is a heuristic** — the executor must prove it produces zero offenders on the migrated tree AND fires on a deliberately-reverted consumer before relying on it.
- **`init` flag-parse wiring (Task 1.4)** depends on `init.ts`'s existing arg-parsing style, which the executor reads at 1.4.1 — the plan specifies the `--per-project-identity` boolean + the opt-in resolver + the conditional 3-arg call, but the exact parse insertion matches the file's convention.

