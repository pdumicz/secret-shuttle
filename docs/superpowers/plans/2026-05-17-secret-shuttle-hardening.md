# Secret Shuttle Hardening + Seamless Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five high-risk security findings, make the "agents never see secrets" promise hold automatically (daemon-managed blind window for inject), and ship a clean, legible package.

**Architecture:** A local daemon owns the vault + Chrome (raw CDP over a pipe) and exposes a bearer-auth HTTP API plus a filtered CDP WebSocket proxy to the untrusted agent. Hardening keeps that trust boundary but (a) moves blind-window control into the daemon for inject, (b) makes domain scope fail-closed and human-visible, (c) replaces raw-SHA256 fingerprints with vault-keyed HMAC, (d) scrubs the daemon token from child envs, (e) cleans packaging.

**Tech Stack:** TypeScript (ESM, NodeNext, strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), Node ≥20 built-ins only, `commander`, `ws`, `node:test`. Build: `tsc` → `dist/`. Test: `npm test` (= build then `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/**/*.test.js"`).

**Conventions (read before starting):**
- Tests use `node:test` + `node:assert/strict`. API tests use the `withDaemon`/`call`/`stubBrowser` helpers already in `src/daemon/api/routes.test.ts`.
- Run one test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/<path>.test.js`
- Errors: `throw new ShuttleError(code, message)` (from `src/shared/errors.js`). API maps `ShuttleError`→HTTP 400 with `{ok:false,error:{code,message}}`.
- Strict optional types: add object props conditionally with `...(x !== undefined ? { x } : {})`; never assign `undefined` to a non-optional field.
- Commit after every task with the exact message given.

**Dependency order:** Task 1 (WS4) ∥ Task 2 (WS6) ∥ Tasks 3-4 (WS2) ∥ Tasks 5-7 (WS3) → Task 8 (WS5) → Tasks 9-11 (WS1) → Task 12 (test fixups) → Tasks 13-14 (WS7) → Task 15 (WS8) → Task 16 (final verification).

---

## Task 1: WS4 — Scrub daemon token from process env + child env builder

**Files:**
- Modify: `src/daemon/safe-env.ts` (add two exports)
- Modify: `src/daemon/main.ts:32` (scrub after token read)
- Modify: `src/daemon/chrome/pipe-transport.ts:47-53` (accept `env`)
- Modify: `src/daemon/chrome/launch.ts:60-65` (pass scrubbed env)
- Modify: `src/daemon/templates/run.ts:44-47` (pass scrubbed env)
- Test: `src/daemon/safe-env.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/daemon/safe-env.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv, scrubDaemonSecretsFromEnv } from "./safe-env.js";

test("buildChildEnv contains no SECRET_SHUTTLE_* variables", () => {
  process.env.SECRET_SHUTTLE_DAEMON_TOKEN = "tok";
  process.env.SECRET_SHUTTLE_MASTER_KEY = "mk";
  const env = buildChildEnv();
  for (const k of Object.keys(env)) {
    assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `${k} leaked into child env`);
  }
  assert.equal(typeof env.PATH, "string");
  assert.ok((env.PATH as string).length > 0);
  delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
  delete process.env.SECRET_SHUTTLE_MASTER_KEY;
});

test("scrubDaemonSecretsFromEnv deletes token and master key from process.env", () => {
  process.env.SECRET_SHUTTLE_DAEMON_TOKEN = "tok";
  process.env.SECRET_SHUTTLE_MASTER_KEY = "mk";
  scrubDaemonSecretsFromEnv();
  assert.equal(process.env.SECRET_SHUTTLE_DAEMON_TOKEN, undefined);
  assert.equal(process.env.SECRET_SHUTTLE_MASTER_KEY, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL — `buildChildEnv`/`scrubDaemonSecretsFromEnv` not exported.

- [ ] **Step 3: Implement in `src/daemon/safe-env.ts`**

Append to the end of the file (keep `buildDaemonEnv`/`safeDaemonPath` unchanged):

```ts
/**
 * Env for daemon-spawned children (templates, Chrome). Minimal allowlist, hardened
 * PATH, and a hard guarantee that NO SECRET_SHUTTLE_* (esp. the bearer token /
 * master key) is ever forwarded — a child must never be able to call the daemon API.
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "ComSpec",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (key.startsWith("SECRET_SHUTTLE_")) continue;
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = safeDaemonPath();
  return env;
}

/** Remove daemon-only secrets from process.env so children cannot inherit them. */
export function scrubDaemonSecretsFromEnv(): void {
  delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
  delete process.env.SECRET_SHUTTLE_MASTER_KEY;
}
```

- [ ] **Step 4: Wire into `src/daemon/main.ts`**

Add import near the top (with the other imports):

```ts
import { safeDaemonPath, scrubDaemonSecretsFromEnv } from "./safe-env.js";
```

(Replace the existing `import { safeDaemonPath } from "./safe-env.js";` line.)

Change line 32 area from:

```ts
  const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? randomBytes(32).toString("base64url");
```

to:

```ts
  const token = process.env.SECRET_SHUTTLE_DAEMON_TOKEN ?? randomBytes(32).toString("base64url");
  // The token must never reach daemon-spawned children (templates, Chrome).
  scrubDaemonSecretsFromEnv();
```

- [ ] **Step 5: Let `spawnChromePipe` accept an env, in `src/daemon/chrome/pipe-transport.ts`**

Replace the `spawnChromePipe` function (lines 47-59) with:

```ts
export function spawnChromePipe(
  chromePath: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): {
  child: ChildProcessWithoutNullStreams;
  transport: PipeTransport;
} {
  const child = spawn(chromePath, [...args, "--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }) as ChildProcessWithoutNullStreams;

  const writeStream = (child.stdio as unknown[])[3] as Writable;
  const readStream = (child.stdio as unknown[])[4] as Readable;
  const transport = new PipeTransport(readStream, writeStream);
  return { child, transport };
}
```

- [ ] **Step 6: Pass scrubbed env from `src/daemon/chrome/launch.ts`**

Add import (with the other imports near top):

```ts
import { buildChildEnv } from "../safe-env.js";
```

Change the `spawnChromePipe(chromePath, [...])` call (lines 60-65) to pass env:

```ts
  const { child, transport } = spawnChromePipe(chromePath, [
    `--user-data-dir=${resolvedProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { env: buildChildEnv() });
```

- [ ] **Step 7: Pass scrubbed env from `src/daemon/templates/run.ts`**

Add import (with the other imports near top):

```ts
import { buildChildEnv } from "../safe-env.js";
```

Change the `spawn` call (lines 44-47) to:

```ts
    const child = spawn(resolvedBinary, expandedArgs, {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: buildChildEnv(),
    });
```

- [ ] **Step 8: Run tests**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/safe-env.test.js`
Expected: PASS (2 tests).

Run: `npm test`
Expected: all tests PASS (no regressions).

- [ ] **Step 9: Commit**

```bash
git add src/daemon/safe-env.ts src/daemon/safe-env.test.ts src/daemon/main.ts src/daemon/chrome/pipe-transport.ts src/daemon/chrome/launch.ts src/daemon/templates/run.ts
git commit -m "fix(security): scrub daemon token from process + child envs (Chrome, templates)"
```

---

## Task 2: WS6 — Clean npm package (prepack, .npmignore, pack tripwire)

**Files:**
- Modify: `package.json` (scripts + files)
- Create: `.npmignore`
- Create: `scripts/check-pack.mjs`

- [ ] **Step 1: Write the failing check (the tripwire script)**

Create `scripts/check-pack.mjs`:

```js
#!/usr/bin/env node
// Fails if the npm tarball would ship internal plans, source maps, or STALE
// build artifacts (detected via forbidden source markers from removed code).
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_PATHS = [/^docs\/superpowers\//, /\.map$/, /\.tsbuildinfo$/, /\.test\.(js|d\.ts)$/];
const FORBIDDEN_MARKERS = ["--confirm-production", "remote-debugging-port"];

const raw = execSync("npm pack --dry-run --json", { encoding: "utf8" });
const files = JSON.parse(raw)[0].files.map((f) => f.path.replace(/^package\//, ""));

const badPaths = files.filter((f) => FORBIDDEN_PATHS.some((re) => re.test(f)));
if (badPaths.length > 0) {
  console.error("check-pack: forbidden files in tarball:\n" + badPaths.join("\n"));
  process.exit(1);
}

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      const txt = readFileSync(p, "utf8");
      for (const m of FORBIDDEN_MARKERS) {
        if (txt.includes(m)) {
          console.error(`check-pack: stale artifact marker "${m}" found in ${p}`);
          process.exit(1);
        }
      }
    }
  }
}
walk("dist");
console.log(`check-pack: OK (${files.length} files, no forbidden paths/markers)`);
```

- [ ] **Step 2: Run it to verify it currently fails**

Run: `npm run build && node scripts/check-pack.mjs`
Expected: FAIL — reports `docs/superpowers/` files and/or `.map` files (and possibly stale markers in a dirty `dist/`).

- [ ] **Step 3: Add `.npmignore`**

Create `.npmignore`:

```
docs/superpowers/
**/*.map
**/*.tsbuildinfo
**/*.test.js
**/*.test.d.ts
src/
```

- [ ] **Step 4: Update `package.json` scripts and files**

In `package.json`, replace the `"scripts"` block with:

```json
  "scripts": {
    "clean": "rm -rf dist",
    "build": "tsc -p tsconfig.json && node -e \"import('node:fs').then(({copyFileSync})=>{copyFileSync('src/daemon/approvals/ui.html','dist/daemon/approvals/ui.html');copyFileSync('src/daemon/approvals/unlock-ui.html','dist/daemon/approvals/unlock-ui.html');})\"",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test \"dist/**/*.test.js\"",
    "check-pack": "npm run clean && npm run build && node scripts/check-pack.mjs",
    "prepack": "npm run clean && npm run build",
    "prepublishOnly": "npm run typecheck && npm test && node scripts/check-pack.mjs"
  },
```

Replace the `"files"` array with:

```json
  "files": [
    "dist",
    "!dist/**/*.test.js",
    "!dist/**/*.test.js.map",
    "!dist/**/*.test.d.ts",
    "!dist/**/*.js.map",
    "!dist/**/*.tsbuildinfo",
    "skills",
    "agents",
    "docs",
    "!docs/superpowers/**",
    "examples",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 5: Run the tripwire again**

Run: `npm run check-pack`
Expected: PASS — `check-pack: OK (... files, no forbidden paths/markers)`.

- [ ] **Step 6: Commit**

```bash
git add package.json .npmignore scripts/check-pack.mjs
git commit -m "build(release): clean prepack, .npmignore, and stale-artifact pack tripwire"
```

---

## Task 3: WS2 — `enforceDomain` fails closed on empty allowlist

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts:286-294` (`enforceDomain`)
- Test: `src/daemon/api/routes.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/api/routes.test.ts` (before the final EOF, after the last test):

```ts
test("inject is refused when the secret has an empty allowed-domains list", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    // Dev secret generated with NO allowed domains → stored [] → not injectable.
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "NOSCOPE", environment: "development", source: "local",
    });
    ctx.services.browser = stubBrowser({ domain: "anything.example.com", target: "T1", value: "" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/NOSCOPE", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "domain_not_allowed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: FAIL — currently empty list = allow-all, so inject returns 200 (or `field_changed`), not `domain_not_allowed`.

- [ ] **Step 3: Implement fail-closed `enforceDomain`**

In `src/daemon/api/routes/secrets.ts`, replace the `enforceDomain` function (lines 286-294) with:

```ts
function enforceDomain(current: string, allowed: string[], action: string): void {
  if (allowed.length === 0) {
    throw new ShuttleError(
      "domain_not_allowed",
      `Refused to ${action} on ${normalizeDomain(current)}: this secret has no allowed domains. Re-create it with --allow-domain.`,
    );
  }
  if (!allowed.some((a) => domainMatches(current, a))) {
    throw new ShuttleError(
      "domain_not_allowed",
      `Refused to ${action} on ${normalizeDomain(current)}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}
```

- [ ] **Step 4: Run the new test + full suite**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: the new test PASSES. Other tests in this file still pass (capture always passes a non-empty list via `?? [pre.domain]`; the existing inject test seeds `allowed_domains:["dashboard.example.com"]`).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/secrets.ts src/daemon/api/routes.test.ts
git commit -m "fix(security): empty allowed-domains now denies inject/compare (fail closed)"
```

---

## Task 4: WS2 — Bind + display allowed_domains; CLI omits empty + production guard

**Files:**
- Modify: `src/daemon/approvals/store.ts` (binding field + match)
- Modify: `src/daemon/api/routes/secrets.ts` (populate `allowed_domains` in capture/generate/inject bindings; compute effective list once)
- Modify: `src/cli/commands/capture.ts`, `src/cli/commands/generate.ts` (omit empty; production guard)
- Test: `src/daemon/approvals/store.test.ts` (add binding-match test)

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/approvals/store.test.ts`:

```ts
test("bindings mismatch when allowed_domains differ; order-insensitive when equal", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const base = { ...sample, allowed_domains: ["vercel.com", "stripe.com"] };
  const g = s.create(base);
  s.approve(g.id);
  assert.throws(
    () => s.consume(g.id, { ...sample, allowed_domains: ["evil.com"] }),
    (err) => err instanceof ShuttleError && err.code === "approval_mismatch",
  );
  const g2 = s.create({ ...sample, allowed_domains: ["a.com", "b.com"] });
  s.approve(g2.id);
  assert.doesNotThrow(() => s.consume(g2.id, { ...sample, allowed_domains: ["b.com", "a.com"] }));
});

test("absent, null, and empty allowed_domains are treated as the same (empty) set", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, allowed_domains: null });
  s.approve(g.id);
  assert.doesNotThrow(() => s.consume(g.id, { ...sample })); // sample has no allowed_domains
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/store.test.js`
Expected: FAIL — `allowed_domains` not on `ApprovalBinding`, not compared.

- [ ] **Step 3: Add the binding field + matcher in `src/daemon/approvals/store.ts`**

In `interface ApprovalBinding` add (after `template_binary_sha256?`):

```ts
  allowed_domains?: string[] | null;
```

In `bindingsMatch`, add this comparison to the returned `&&` chain (before the closing `)`):

```ts
    && domainSet(a.allowed_domains) === domainSet(b.allowed_domains)
```

Add this helper at the bottom of the file (next to `stableStringify`):

```ts
function domainSet(v: string[] | null | undefined): string {
  return JSON.stringify([...(v ?? [])].sort());
}
```

- [ ] **Step 4: Populate `allowed_domains` in secrets bindings**

In `src/daemon/api/routes/secrets.ts`:

**generate** — replace the binding + upsert region (lines ~71-101) so the effective list is computed once and bound:

```ts
      const env = canonicalEnvironment(b.environment);
      const plannedRef = buildSecretRef(b.source ?? "local", env, b.name);
      const effectiveAllowed = b.allowed_domains ?? [];

      const binding: ApprovalBinding = {
        action: "generate",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const value = generateSecretValue(b.kind ?? "random_32_bytes");
      const meta = await services.vault.upsertSecret({
        name: b.name,
        environment: env,
        source: b.source ?? "local",
        value,
        ...(b.description !== undefined ? { description: b.description } : {}),
        allowedDomains: effectiveAllowed,
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
```

**capture** — replace the region computing the list/binding/upsert (lines ~128-174). Compute `effectiveAllowed` once and use it for `enforceDomain`, the binding, and the upsert:

```ts
      const env = canonicalEnvironment(b.environment);
      const plannedRef = buildSecretRef(b.source, env, b.name);
      const pre = await services.browser.readFocusedFingerprintAndDomain();
      const effectiveAllowed = b.allowed_domains ?? [pre.domain];

      services.blind.assertForDomain(pre.domain);
      enforceDomain(pre.domain, effectiveAllowed, "capture");

      const binding: ApprovalBinding = {
        action: "capture",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: pre.domain,
        target_id: pre.target_id,
        field_fingerprint: pre.field_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const capture = b.from === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();

      if (
        capture.target_id !== pre.target_id ||
        capture.domain !== pre.domain ||
        capture.field_fingerprint !== pre.field_fingerprint
      ) {
        throw new ShuttleError("field_changed", "Focused field changed after approval.");
      }

      const meta = await services.vault.upsertSecret({
        name: b.name,
        environment: env,
        source: b.source,
        value: capture.value,
        ...(b.description !== undefined ? { description: b.description } : {}),
        allowedDomains: effectiveAllowed,
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
```

**inject** — in the inject binding object (lines ~208-217) add `allowed_domains`:

```ts
      const binding: ApprovalBinding = {
        action: "inject",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: pre.domain,
        target_id: pre.target_id,
        field_fingerprint: pre.field_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
      };
```

- [ ] **Step 5: CLI — omit empty `allowed_domains`, guard production**

Replace `src/cli/commands/capture.ts` `.action(...)` body with:

```ts
    .action(async (options) => {
      assertCaptureSource(options.from);
      const domains = options.allowDomain as string[];
      if (options.env === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        from: options.from,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/capture", body);
      outputJson(ok(r as Record<string, unknown>));
    });
```

Add this import at the top of `src/cli/commands/capture.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";
```

Replace `src/cli/commands/generate.ts` `.action(...)` body with:

```ts
    .action(async (options) => {
      const domains = options.allowDomain as string[];
      if (options.env === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        kind: options.kind,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/generate", body);
      outputJson(ok(r as Record<string, unknown>));
    });
```

Add this import at the top of `src/cli/commands/generate.ts`:

```ts
import { ShuttleError } from "../../shared/errors.js";
```

- [ ] **Step 6: Run store tests + typecheck**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/store.test.js`
Expected: new tests PASS.

(Existing API tests that create capture/inject grants without `allowed_domains` will be fixed in **Task 12**. Do not run the full suite green-gate here; proceed.)

- [ ] **Step 7: Commit**

```bash
git add src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts src/daemon/api/routes/secrets.ts src/cli/commands/capture.ts src/cli/commands/generate.ts
git commit -m "feat(security): bind+display allowed_domains in approvals; CLI omits empty, guards production"
```

---

## Task 5: WS3 — Keyed (HMAC) fingerprints with transparent migration

**Files:**
- Modify: `src/vault/fingerprints.ts` (HMAC + key param + legacy detector)
- Modify: `src/vault/types.ts` (`VaultPlaintext.fingerprint_key`)
- Modify: `src/vault/vault.ts` (generate/migrate key on read; key accessor; keyed upsert)
- Test: `src/vault/fingerprints.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

Create `src/vault/fingerprints.test.ts`:

```ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { fingerprintSecret, fingerprintMatches, isLegacyFingerprint } from "./fingerprints.js";

test("fingerprint is keyed HMAC, stable per key, different across keys", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const a = fingerprintSecret("hunter2", k1);
  assert.ok(a.startsWith("hmac-sha256:"));
  assert.equal(a, fingerprintSecret("hunter2", k1));
  assert.notEqual(a, fingerprintSecret("hunter2", k2));
  assert.equal(fingerprintMatches("hunter2", a, k1), true);
  assert.equal(fingerprintMatches("wrong", a, k1), false);
});

test("legacy raw-sha256 fingerprints are detectable", () => {
  assert.equal(isLegacyFingerprint("sha256:abc"), true);
  assert.equal(isLegacyFingerprint("hmac-sha256:abc"), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build`
Expected: FAIL — `fingerprintSecret` takes 1 arg, no `isLegacyFingerprint`.

- [ ] **Step 3: Rewrite `src/vault/fingerprints.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function fingerprintSecret(value: string, key: Buffer): string {
  return `hmac-sha256:${createHmac("sha256", key).update(value, "utf8").digest("hex")}`;
}

export function fingerprintMatches(value: string, fingerprint: string, key: Buffer): boolean {
  const computed = Buffer.from(fingerprintSecret(value, key), "utf8");
  const given = Buffer.from(fingerprint, "utf8");
  return computed.byteLength === given.byteLength && timingSafeEqual(computed, given);
}

export function isLegacyFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith("sha256:");
}
```

- [ ] **Step 4: Add `fingerprint_key` to `src/vault/types.ts`**

Change the `VaultPlaintext` interface to:

```ts
export interface VaultPlaintext {
  version: 1;
  secrets: SecretRecord[];
  fingerprint_key?: string;
}
```

- [ ] **Step 5: Generate/migrate the key on read in `src/vault/vault.ts`**

Add imports at the top:

```ts
import { randomBytes } from "node:crypto";
import { fingerprintSecret, isLegacyFingerprint } from "./fingerprints.js";
```

(There is already `import { randomUUID } from "node:crypto";` — make it `import { randomBytes, randomUUID } from "node:crypto";` and remove the old single-symbol `fingerprints` import line `import { fingerprintSecret } from "./fingerprints.js";`.)

Replace the `private async read()` method with:

```ts
  private async read(): Promise<VaultPlaintext> {
    const paths = getShuttlePaths();
    if (!(await fileExists(paths.vaultPath))) {
      throw new ShuttleError("vault_not_initialized", "Secret Shuttle is not initialized. Run `secret-shuttle init`.");
    }
    const key = this.keyProvider();
    const file = await readJsonFile<EncryptedVaultFile>(paths.vaultPath);
    const plaintext = decryptVault(file, key);
    if (plaintext.version !== 1 || !Array.isArray(plaintext.secrets)) {
      throw new ShuttleError("invalid_vault", "Secret Shuttle vault contents are invalid.");
    }
    if (this.migrateFingerprints(plaintext)) {
      await this.write(plaintext);
    }
    return plaintext;
  }

  /** One-shot transparent upgrade: ensure a per-vault HMAC key and re-key any
   *  legacy raw-sha256 fingerprints. Returns true if the vault must be persisted. */
  private migrateFingerprints(pt: VaultPlaintext): boolean {
    let dirty = false;
    if (typeof pt.fingerprint_key !== "string" || pt.fingerprint_key === "") {
      pt.fingerprint_key = randomBytes(32).toString("base64");
      dirty = true;
    }
    const fpKey = Buffer.from(pt.fingerprint_key, "base64");
    for (const s of pt.secrets) {
      if (isLegacyFingerprint(s.fingerprint)) {
        s.fingerprint = fingerprintSecret(s.value, fpKey);
        dirty = true;
      }
    }
    return dirty;
  }

  /** Daemon-internal: the per-vault fingerprint HMAC key (never exposed to agents). */
  async fingerprintKey(): Promise<Buffer> {
    const pt = await this.read();
    return Buffer.from(pt.fingerprint_key as string, "base64");
  }
```

In `upsertSecret`, the line `const plaintext = await this.read();` already runs first (which now guarantees `fingerprint_key`). Change the fingerprint line in the `record` literal from:

```ts
      fingerprint: fingerprintSecret(input.value),
```

to:

```ts
      fingerprint: fingerprintSecret(input.value, Buffer.from(plaintext.fingerprint_key as string, "base64")),
```

- [ ] **Step 6: Run tests**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/vault/fingerprints.test.js`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/vault/fingerprints.ts src/vault/fingerprints.test.ts src/vault/types.ts src/vault/vault.ts
git commit -m "fix(security): vault-keyed HMAC fingerprints with transparent legacy migration"
```

---

## Task 6: WS3 — Compare uses keyed fingerprint; gated for production

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts` (compare: keyed match + approval binding)
- Modify: `src/cli/commands/compare.ts` (pass approval-id / no-wait)
- Test: `src/daemon/api/routes.test.ts` (add production-compare test)

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/api/routes.test.ts`:

```ts
test("compare on a production secret requires approval", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/blind/start", { domain: "stripe.com", reason: "r" });
    ctx.services.browser = stubBrowser({ domain: "stripe.com", target: "T1", value: "alpha" });
    const cap = ctx.services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/prod/PK",
      environment: "production", destination_domain: "stripe.com",
      target_id: "T1", field_fingerprint: "sha256:T1-stripe.com",
      template_id: null, template_params: null, allowed_domains: ["stripe.com"],
    });
    ctx.services.approvals.approve(cap.id);
    await call(ctx, "POST", "/v1/secrets/capture", {
      name: "PK", environment: "production", source: "stripe",
      allowed_domains: ["stripe.com"], approval_id: cap.id, wait_for_approval: false,
    });
    const r = await call(ctx, "POST", "/v1/secrets/compare", {
      ref: "ss://stripe/prod/PK", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: FAIL — compare has no approval gate; returns 200.

- [ ] **Step 3: Implement compare gating + keyed match in `src/daemon/api/routes/secrets.ts`**

Extend `interface CompareBody` to:

```ts
interface CompareBody {
  ref: string;
  with?: "focused-field" | "selection";
  domain?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}
```

Replace the `compare` route handler body (the `try { ... }` block, lines ~255-282) with:

```ts
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      const secret = await services.vault.getSecret(b.ref);
      const capture = b.with === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();
      if (b.domain !== undefined && !domainMatches(capture.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${capture.domain} != ${b.domain}.`);
      }
      enforceDomain(capture.domain, secret.allowed_domains, "compare");

      const binding: ApprovalBinding = {
        action: "compare",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: capture.domain,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const fpKey = await services.vault.fingerprintKey();
      const matches = fingerprintMatches(capture.value, secret.fingerprint, fpKey);
      await writeDaemonAudit({ action: "compare", ok: true, ref: secret.ref, environment: secret.environment, domain: capture.domain });
      return {
        matches,
        secret_ref: secret.ref,
        browser_domain: capture.domain,
        compared_with: b.with ?? "focused-field",
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "compare",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
      });
      throw err;
    }
```

(`requireApproval` already no-ops for non-production environments via `synthesizeGrant`, so dev compares stay frictionless and the existing `compare returns matches=true` dev test keeps passing.)

- [ ] **Step 4: CLI passthrough in `src/cli/commands/compare.ts`**

Add the two options and body fields. Replace the command body with:

```ts
  return new Command("compare")
    .description("Compare selected text or focused field against a stored secret via the daemon.")
    .requiredOption("--ref <ref>")
    .option("--with <source>", "focused-field or selection.", "focused-field")
    .option("--domain <domain>")
    .option("--approval-id <id>")
    .option("--no-wait")
    .action(async (options) => {
      assertCaptureSource(options.with);
      const body: Record<string, unknown> = {
        ref: normalizeRef(options.ref),
        with: options.with,
        wait_for_approval: options.wait !== false,
      };
      if (options.domain !== undefined) body.domain = options.domain;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/compare", body);
      outputJson(ok(r as Record<string, unknown>));
    });
```

- [ ] **Step 5: Run the new test + typecheck**

Run: `npm run typecheck` → PASS.
Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: the new production-compare test PASSES; the existing dev `compare returns matches=true` test still PASSES.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api/routes/secrets.ts src/cli/commands/compare.ts src/daemon/api/routes.test.ts
git commit -m "fix(security): keyed compare; production compare requires approval"
```

---

## Task 7: WS3 — Per-ref compare rate limit

**Files:**
- Create: `src/daemon/rate-limit.ts`
- Modify: `src/daemon/services.ts` (add `compareLimiter`)
- Modify: `src/daemon/api/routes/secrets.ts` (call limiter at top of compare)
- Test: `src/daemon/rate-limit.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/daemon/rate-limit.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { RateLimiter } from "./rate-limit.js";

test("RateLimiter allows up to limit then throws compare_rate_limited", () => {
  let now = 0;
  const rl = new RateLimiter(3, 1000, () => now);
  rl.check("k"); rl.check("k"); rl.check("k");
  assert.throws(
    () => rl.check("k"),
    (e) => e instanceof ShuttleError && e.code === "compare_rate_limited",
  );
  now = 1001; // window elapsed
  assert.doesNotThrow(() => rl.check("k"));
});

test("RateLimiter is per-key", () => {
  const rl = new RateLimiter(1, 1000, () => 0);
  rl.check("a");
  assert.doesNotThrow(() => rl.check("b"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build`
Expected: FAIL — `./rate-limit.js` missing.

- [ ] **Step 3: Implement `src/daemon/rate-limit.ts`**

```ts
import { ShuttleError } from "../shared/errors.js";

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      throw new ShuttleError("compare_rate_limited", `Too many compares for ${key}; slow down.`);
    }
    recent.push(t);
    this.hits.set(key, recent);
  }
}
```

- [ ] **Step 4: Register on `DaemonServices` (`src/daemon/services.ts`)**

Add the import:

```ts
import { RateLimiter } from "./rate-limit.js";
```

Add this field to the `DaemonServices` class (next to `readonly blind = ...`):

```ts
  readonly compareLimiter = new RateLimiter(5, 60_000);
```

- [ ] **Step 5: Enforce in compare (`src/daemon/api/routes/secrets.ts`)**

In the `compare` route handler, immediately after `const b = raw as CompareBody;` and before the `try {`, add:

```ts
    if (typeof b?.ref === "string") services.compareLimiter.check(b.ref);
```

- [ ] **Step 6: Run tests**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/rate-limit.test.js`
Expected: PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/rate-limit.ts src/daemon/rate-limit.test.ts src/daemon/services.ts src/daemon/api/routes/secrets.ts
git commit -m "fix(security): per-ref rate limit on compare (online-oracle mitigation)"
```

---

## Task 8: WS5 — Enforce `allowed_actions`; runtime body validation

**Files:**
- Create: `src/daemon/api/validate.ts`
- Modify: `src/daemon/api/routes/secrets.ts` (validate inject/compare bodies; enforce actions)
- Modify: `src/daemon/api/routes/templates.ts` (enforce `use_as_stdin`)
- Test: `src/daemon/api/validate.test.ts` (create); add inject `action_not_allowed` test to `routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/api/validate.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { asObject, reqString, optStringArray } from "./validate.js";

test("asObject rejects non-objects with bad_request", () => {
  assert.throws(() => asObject(null), (e) => e instanceof ShuttleError && e.code === "bad_request");
  assert.throws(() => asObject([]), (e) => e instanceof ShuttleError && e.code === "bad_request");
});

test("reqString names the offending field", () => {
  assert.throws(
    () => reqString({}, "ref"),
    (e) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("ref"),
  );
  assert.equal(reqString({ ref: "x" }, "ref"), "x");
});

test("optStringArray validates element types", () => {
  assert.equal(optStringArray({}, "d"), undefined);
  assert.throws(() => optStringArray({ d: [1] }, "d"), (e) => e instanceof ShuttleError);
  assert.deepEqual(optStringArray({ d: ["a"] }, "d"), ["a"]);
});
```

Append to `src/daemon/api/routes.test.ts`:

```ts
test("inject is refused when the secret disallows inject_into_field", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "RO", environment: "development", source: "local",
      allowed_domains: ["x.example.com"],
    });
    // Restrict actions directly in the vault (simulates a locked-down secret).
    const rec = await ctx.services.vault.getSecret("ss://local/dev/RO");
    rec.allowed_actions = ["compare_fingerprint"];
    ctx.services.browser = stubBrowser({ domain: "x.example.com", target: "T1", value: "" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/RO", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "action_not_allowed");
  });
});

test("inject with a non-string ref returns bad_request", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await call(ctx, "POST", "/v1/secrets/inject", { ref: 123 });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});
```

(Note: `getSecret` returns the live in-memory record object only within this process; mutating `rec.allowed_actions` then calling inject in the same daemon exercises the enforcement path. This is a white-box test and acceptable here.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build`
Expected: FAIL — `./validate.js` missing; inject does not enforce actions or validate ref type.

- [ ] **Step 3: Implement `src/daemon/api/validate.ts`**

```ts
import { ShuttleError } from "../../shared/errors.js";

function bad(field: string, reason: string): never {
  throw new ShuttleError("bad_request", `${field}: ${reason}`);
}

export function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShuttleError("bad_request", "body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, f: string): string {
  const v = o[f];
  if (typeof v !== "string" || v === "") bad(f, "required non-empty string");
  return v as string;
}

export function optString(o: Record<string, unknown>, f: string): string | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (typeof v !== "string") bad(f, "must be a string");
  return v;
}

export function optStringArray(o: Record<string, unknown>, f: string): string[] | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(f, "must be a string array");
  return v as string[];
}

export function optBool(o: Record<string, unknown>, f: string): boolean | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") bad(f, "must be a boolean");
  return v;
}
```

- [ ] **Step 4: Enforce `allowed_actions` + validate ref in secrets.ts**

In `src/daemon/api/routes/secrets.ts` add the import:

```ts
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { asObject, reqString } from "../validate.js";
```

In the **inject** handler, replace `const b = raw as InjectBody;` and the first lines of `try {` so it validates and enforces. The handler start becomes:

```ts
  server.addRoute("POST", "/v1/secrets/inject", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const b = raw as InjectBody;
    reqString(o, "ref");
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");

      const secret = await services.vault.getSecret(b.ref);
      assertSecretActionAllowed(secret, "inject_into_field");
      const pre = await services.browser.readFocusedFingerprintAndDomain();
```

In the **compare** handler, after `const secret = await services.vault.getSecret(b.ref);` add:

```ts
      assertSecretActionAllowed(secret, "compare_fingerprint");
```

- [ ] **Step 5: Enforce `use_as_stdin` in templates.ts**

In `src/daemon/api/routes/templates.ts`, add the import:

```ts
import { assertSecretActionAllowed } from "../../../policy/policy.js";
```

After `const secret = await services.vault.getSecret(b.ref);` (line ~41) add:

```ts
      assertSecretActionAllowed(secret, "use_as_stdin");
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/validate.test.js`
Expected: PASS.
Run: `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: the two new tests PASS (others in this file may still need Task 12 fixups — that is expected).
Run: `npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/api/validate.ts src/daemon/api/validate.test.ts src/daemon/api/routes/secrets.ts src/daemon/api/routes/templates.ts src/daemon/api/routes.test.ts
git commit -m "feat(security): enforce allowed_actions; runtime body validation"
```

---

## Task 9: WS1 — Inject runs inside a daemon-managed blind window

**Files:**
- Modify: `src/daemon/api/routes/secrets.ts` (inject route: auto-blind, sever, fail-safe resume)
- Test: `src/daemon/api/routes.test.ts` (add inject-blind behavior tests)

**Context:** `services.blind.start(domain, reason)` activates blind state; `disableObservationDomains(cdp)` is best-effort and needs `services.cdp !== null`; `services.cdpProxy?.severAgentConnections()` severs agent sockets. `blind/start` (`src/daemon/api/routes/blind.ts:19-28`) is the reference sequence. The existing `/v1/blind/end` route already requires human approval, blanks pages, and fails closed — it remains the resume path.

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/api/routes.test.ts`:

```ts
test("successful inject leaves daemon-managed blind mode ACTIVE and severs the proxy", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    let severed = false;
    ctx.services.cdpProxy = {
      url: "ws://127.0.0.1:0/cdp/fake",
      severAgentConnections: () => { severed = true; },
      close: async () => undefined,
    };
    ctx.services.browser = stubBrowser({ domain: "app.example.com", target: "T1", value: "" });
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { injected: boolean }).injected, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal(severed, true, "inject must sever agent CDP connections");
    const status = await call(ctx, "GET", "/v1/status");
    assert.notEqual((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});

test("inject that fails before writing the value auto-resumes (blind mode left OFF)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await call(ctx, "POST", "/v1/secrets/generate", {
      name: "INJ2", environment: "development", source: "local",
      allowed_domains: ["app.example.com"],
    });
    const field = { tag: "input", editable: true };
    let reads = 0;
    ctx.services.browser = {
      available: true,
      captureFocused: async () => ({ value: "", domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      captureSelection: async () => ({ value: "", domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      injectFocused: async () => ({ domain: "app.example.com", target_id: "T1", field, field_fingerprint: "f" }),
      readFocusedFingerprintAndDomain: async () => {
        reads += 1;
        return { domain: "app.example.com", target_id: reads === 1 ? "T1" : "T-DIFF", field, field_fingerprint: "f" };
      },
      currentDomainAndTarget: async () => ({ domain: "app.example.com", target_id: "T1" }),
    };
    const r = await call(ctx, "POST", "/v1/secrets/inject", {
      ref: "ss://local/dev/INJ2", domain: "app.example.com", wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "field_changed");
    const status = await call(ctx, "GET", "/v1/status");
    assert.equal((status.body as { blind_mode: unknown }).blind_mode, null);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: FAIL — inject does not enter/leave blind mode; no `blind_mode` field in the response.

- [ ] **Step 3: Implement the daemon-managed blind window for inject**

In `src/daemon/api/routes/secrets.ts` add the import:

```ts
import { disableObservationDomains } from "../../chrome/internal-ops.js";
```

Replace the **inject** route handler entirely with (this supersedes the partial edit from Task 8 Step 4 — keep the `asObject`/`reqString` validation and `assertSecretActionAllowed`):

```ts
  server.addRoute("POST", "/v1/secrets/inject", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const b = raw as InjectBody;
    reqString(o, "ref");
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");

      const secret = await services.vault.getSecret(b.ref);
      assertSecretActionAllowed(secret, "inject_into_field");
      const pre = await services.browser.readFocusedFingerprintAndDomain();
      if (b.domain !== undefined && !domainMatches(pre.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${pre.domain} != ${b.domain}.`);
      }
      enforceDomain(pre.domain, secret.allowed_domains, "inject");

      const binding: ApprovalBinding = {
        action: "inject",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: pre.domain,
        target_id: pre.target_id,
        field_fingerprint: pre.field_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window for inject: black out the agent BEFORE the
      // value can ever reach the page. Mirrors /v1/blind/start.
      services.blind.start(pre.domain, "inject");
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      try {
        const post = await services.browser.readFocusedFingerprintAndDomain();
        if (post.target_id !== pre.target_id || post.field_fingerprint !== pre.field_fingerprint || post.domain !== pre.domain) {
          throw new ShuttleError("field_changed", "Focused field changed after approval.");
        }
        const result = await services.browser.injectFocused(secret.value);
        await services.vault.markUsed(secret.ref);
        await writeDaemonAudit({ action: "inject", ok: true, ref: secret.ref, environment: secret.environment, domain: result.domain });
        return {
          injected: true,
          secret_ref: secret.ref,
          browser_domain: result.domain,
          field: result.field,
          blind_mode: true,
          next: "Secret written with the agent blacked out. Run `secret-shuttle blind end` and approve once the secret is no longer visible to resume observation.",
          value_visible_to_agent: false,
        };
      } catch (innerErr) {
        // Nothing was written to the page (failure happened before/at injectFocused
        // resolved with no value on screen) → safe to auto-resume so the user is not
        // stranded in blind mode for a no-op.
        services.blind.end();
        throw innerErr;
      }
    } catch (err) {
      await writeDaemonAudit({
        action: "inject",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
      });
      throw err;
    }
  });
```

- [ ] **Step 4: Run the new tests**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: the two new inject-blind tests PASS. (The pre-existing `inject refuses when target changes after approval` test still passes — it now also exercises auto-resume; `domain_not_allowed` empty test from Task 3 still passes.) Other capture/inject grant tests get fixed in Task 12.
Run: `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/secrets.ts src/daemon/api/routes.test.ts
git commit -m "fix(security): inject runs inside a daemon-managed blind window (closes observation hole)"
```

---

## Task 10: WS1 — `inject` CLI surfaces the blind-mode follow-up

**Files:**
- Modify: `src/cli/commands/inject.ts` (already prints daemon JSON; ensure `--no-wait`/`--approval-id` pass through — verify only)
- Modify: `docs/browser-harness.md` (inject section — superseded by Task 15; here only verify CLI)

- [ ] **Step 1: Verify inject CLI passes the new response through unchanged**

Read `src/cli/commands/inject.ts`. It already does `outputJson(ok(r))`, so the new `blind_mode`/`next` fields are surfaced verbatim. No code change required. Confirm `--no-wait` and `--approval-id` are present (they are).

- [ ] **Step 2: Sanity build**

Run: `npm run typecheck` → PASS. No commit (no change). If a change was needed, commit with:

```bash
git commit -m "chore(cli): inject surfaces daemon blind-mode follow-up"
```

(Skip this task's commit if no edit was necessary.)

---

## Task 11: WS1 — e2e workflow reflects daemon-managed inject

**Files:**
- Modify: `src/e2e/stripe-to-vercel.test.ts`

- [ ] **Step 1: Update the e2e expectations**

In `src/e2e/stripe-to-vercel.test.ts`:

1. `captureGrant` (line ~74-79): add `allowed_domains: ["dashboard.stripe.com", "vercel.com"],` to the binding object (it must match the request's `allowed_domains`).
2. `injectGrant` (line ~102-107): add `allowed_domains: ["dashboard.stripe.com", "vercel.com"],` (inject binds `secret.allowed_domains`, which was stored from the capture request).
3. After the successful inject assertions (after line ~117), add:

```ts
    // Daemon-managed blind window: inject left blind mode ACTIVE.
    const blindAfterInject = await call("GET", "/v1/status");
    responses.push(blindAfterInject);
    assert.notEqual((blindAfterInject.body as { blind_mode: unknown }).blind_mode, null);
```

   Note: `call` in this file is `(method, p, body?)`. Use `await call("GET", "/v1/status")`.
4. `wrongGrant` (line ~126-131): leave as-is (it intentionally mismatches; it now mismatches on more fields and still yields `approval_mismatch`).

- [ ] **Step 2: Run the e2e test**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/e2e/stripe-to-vercel.test.js`
Expected: PASS, including the no-raw-secret-leak assertion.

- [ ] **Step 3: Commit**

```bash
git add src/e2e/stripe-to-vercel.test.ts
git commit -m "test(e2e): reflect bound allowed_domains and daemon-managed inject blind window"
```

---

## Task 12: Fix existing tests for the extended approval binding

**Files:**
- Modify: `src/daemon/api/routes.test.ts` (capture grants need `allowed_domains`)

**Context:** Adding `allowed_domains` to `bindingsMatch` (Task 4) breaks any pre-existing test that manually creates a **capture** grant while its request carries `allowed_domains`. `domainSet` treats absent/null/empty identically, so **generate** grants with no domains and **blind_end**/**template** grants need no change. Only these capture grants must gain a matching `allowed_domains`.

- [ ] **Step 1: Patch the three capture grants in `routes.test.ts`**

1. `capture round-trips with pre-issued approval` — grant at line ~197: add `allowed_domains: ["dashboard.stripe.com", "vercel.com"],` (request sends those).
2. `compare returns matches=true` — capture grant at line ~255: add `allowed_domains: ["stripe.com"],` (request sends `["stripe.com"]`).
3. `capture rejects when the focused field changes` — grant at line ~357: add `allowed_domains: ["dashboard.stripe.com"],` (request sends `["dashboard.stripe.com"]`).

(Do NOT modify the blind_end grant at line ~148/~478, the inject-poll grant at ~275, or the generate grant at ~543 — `domainSet` makes those still match.)

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: **all tests PASS** (this is the green-gate for Tasks 3-9). If any capture/inject/compare grant test still fails with `approval_mismatch`, grep that test for `approvals.create({` and add the `allowed_domains` that matches its request body, then re-run.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes.test.ts
git commit -m "test: bind allowed_domains in pre-issued capture approvals"
```

---

## Task 13: WS7 — Legible approval UI

**Files:**
- Modify: `src/daemon/chrome/internal-ops.ts` (capture page title/url host in the focused-field read)
- Modify: `src/daemon/approvals/store.ts` (display-only binding fields, excluded from match)
- Modify: `src/daemon/api/routes/secrets.ts` (populate display fields in capture/inject bindings)
- Modify: `src/daemon/approvals/ui-server.ts` (expose new fields)
- Modify: `src/daemon/approvals/ui.html` (plain-language + scope + collapsible technical)
- Test: `src/daemon/approvals/store.test.ts` (display fields are NOT part of match)

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/approvals/store.test.ts`:

```ts
test("display-only fields (page_title/page_url_host) do not affect binding match", () => {
  const s = new ApprovalStore({ ttlMs: 60_000 });
  const g = s.create({ ...sample, page_title: "Stripe", page_url_host: "dashboard.stripe.com" });
  s.approve(g.id);
  assert.doesNotThrow(() =>
    s.consume(g.id, { ...sample, page_title: "DIFFERENT", page_url_host: "other" }),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build`
Expected: FAIL — `page_title`/`page_url_host` not on `ApprovalBinding`.

- [ ] **Step 3: Add display-only binding fields (`src/daemon/approvals/store.ts`)**

In `interface ApprovalBinding`, add (after `allowed_domains?`):

```ts
  /** Display-only context for the human approver. NOT part of bindingsMatch. */
  page_title?: string | null;
  page_url_host?: string | null;
```

Do **not** add them to `bindingsMatch` (they are advisory display only).

- [ ] **Step 4: Capture page title + url host in `src/daemon/chrome/internal-ops.ts`**

Add to the `CaptureResult` interface:

```ts
  page_title?: string;
  page_url_host?: string;
```

In `READ_SCRIPT`, change the three `return { ok:true, ... }` lines to also include
`title: document.title, urlHost: location.host`. Concretely, replace the body of the
IIFE's success branches so each returned object includes
`title: document.title, urlHost: location.host`. The simplest correct replacement is
to add these to the final composed object; replace lines 126-128 with:

```js
  const base = { field: meta(a), domain: location.hostname, title: document.title, urlHost: location.host };
  if (sel !== "") return { ok:true, value: sel, source:"selection", ...base };
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return { ok:true, value:a.value, source:"focused-field", ...base };
  if (a instanceof HTMLElement && a.isContentEditable) return { ok:true, value: a.innerText, source:"focused-field", ...base };
```

In `readFocusedFingerprintAndDomain()` change the typed evaluate + return so it carries the new fields:

```ts
  async readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string; title?: string; urlHost?: string }>(page.id, READ_SCRIPT);
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

(Do the analogous addition in `captureFocused()` — add the same two `...(r.title…)` / `...(r.urlHost…)` spreads to its returned object, and widen its evaluate generic with `title?: string; urlHost?: string`.)

- [ ] **Step 5: Populate display fields in capture + inject bindings (`secrets.ts`)**

In the **capture** binding object add:

```ts
        ...(pre.page_title !== undefined ? { page_title: pre.page_title } : {}),
        ...(pre.page_url_host !== undefined ? { page_url_host: pre.page_url_host } : {}),
```

In the **inject** binding object add the same two spreads (using `pre.page_title`/`pre.page_url_host`).

- [ ] **Step 6: Expose new fields in `src/daemon/approvals/ui-server.ts`**

In the `/ui/approvals/:id` JSON response object, add:

```ts
      allowed_domains: grant.allowed_domains ?? null,
      page_title: grant.page_title ?? null,
      page_url_host: grant.page_url_host ?? null,
```

- [ ] **Step 7: Rewrite the grant card in `src/daemon/approvals/ui.html`**

Replace the `document.getElementById("grant").innerHTML = \`...\`;` assignment (lines ~30-44) with:

```js
        const human = {
          inject: `Inject secret ${esc(g.ref ?? "")} into the focused field on ${esc(g.destination_domain ?? "?")}`,
          capture: `Capture a new secret (${esc(g.planned_ref ?? "")}) from ${esc(g.destination_domain ?? "?")}`,
          generate: `Generate and store a new secret ${esc(g.planned_ref ?? "")} (${esc(g.environment)})`,
          compare: `Compare the focused field on ${esc(g.destination_domain ?? "?")} against ${esc(g.ref ?? "")}`,
          template: `Run template ${esc(g.template_id ?? "")} with secret ${esc(g.ref ?? "")}`,
          blind_end: `Resume browser observation for ${esc(g.destination_domain ?? "?")}`,
        }[g.action] || `${esc(g.action)}`;
        const scope = Array.isArray(g.allowed_domains) && g.allowed_domains.length
          ? g.allowed_domains.map(esc).join(", ") : "(none yet — not injectable)";
        document.getElementById("grant").innerHTML = `
          <p style="font-size:1.1rem"><b>${human}</b></p>
          <div class="row"><span class="label">Environment</span><b>${esc(g.environment)}</b></div>
          ${g.page_title ? `<div class="row"><span class="label">Page</span><b>${esc(g.page_title)}</b></div>` : ""}
          ${g.page_url_host ? `<div class="row"><span class="label">URL host</span><code>${esc(g.page_url_host)}</code></div>` : ""}
          <div class="row"><span class="label">Injectable into</span><b>${scope}</b></div>
          ${g.template_id ? `<div class="row"><span class="label">Template</span><b>${esc(g.template_id)}</b></div>` : ""}
          ${g.template_params ? Object.keys(g.template_params).sort().map((k) =>
            `<div class="row"><span class="label">param: ${esc(k)}</span><code>${esc(g.template_params[k])}</code></div>`).join("") : ""}
          <details style="margin-top:.5rem">
            <summary class="label">Technical details</summary>
            ${g.template_binary_path ? `<div class="row"><span class="label">Binary</span><code>${esc(g.template_binary_path)}</code></div>` : ""}
            ${g.template_binary_sha256 ? `<div class="row"><span class="label">Binary sha256</span><code>${esc(g.template_binary_sha256)}</code></div>` : ""}
            ${g.target_id ? `<div class="row"><span class="label">Browser target</span><code>${esc(g.target_id)}</code></div>` : ""}
            ${g.field_fingerprint ? `<div class="row"><span class="label">Field fingerprint</span><code>${esc(g.field_fingerprint)}</code></div>` : ""}
          </details>
          ${g.action === "blind_end" ? `<div class="row" style="color:#c33"><b>Approving navigates open pages to about:blank and resumes observation. Approve only if the secret has been saved/submitted and is no longer visible.</b></div>` : ""}
        `;
```

- [ ] **Step 8: Run tests**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/approvals/store.test.js`
Expected: PASS (incl. the new display-only test).
Run: `npm test` → all PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/chrome/internal-ops.ts src/daemon/approvals/store.ts src/daemon/approvals/store.test.ts src/daemon/api/routes/secrets.ts src/daemon/approvals/ui-server.ts src/daemon/approvals/ui.html
git commit -m "feat(ux): plain-language approvals with scope, page context, collapsible internals"
```

---

## Task 14: WS7 — `secret-shuttle doctor` health-check

**Files:**
- Create: `src/daemon/api/routes/health.ts`
- Modify: `src/daemon/api/router.ts` (register health)
- Create: `src/cli/commands/doctor.ts`
- Modify: `src/cli/index.ts` (register doctor)
- Test: `src/daemon/api/routes.test.ts` (health route shape)

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/api/routes.test.ts`:

```ts
test("GET /v1/health reports a structured safety snapshot", async () => {
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "GET", "/v1/health");
    assert.equal(r.status, 200);
    const h = r.body as Record<string, unknown>;
    assert.equal(h.unlocked, false);
    assert.equal(h.browser_started, false);
    assert.equal(h.proxy_active, false);
    assert.equal(h.blind_mode, null);
    assert.equal(typeof h.vault, "object");
    assert.equal(h.policy_warnings, null); // locked → cannot enumerate
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: FAIL — `/v1/health` returns 404.

- [ ] **Step 3: Implement `src/daemon/api/routes/health.ts`**

```ts
import { fileExists, getShuttlePaths } from "../../../shared/config.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerHealth(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("GET", "/v1/health", async () => {
    const paths = getShuttlePaths();
    const unlocked = services.lock.isUnlocked();
    let policyWarnings: string[] | null = null;
    if (unlocked) {
      const secrets = await services.vault.list();
      policyWarnings = secrets
        .filter((s) => s.environment === "production" && s.allowed_domains.length === 0)
        .map((s) => `${s.ref} is production but has no allowed domains (not injectable; re-create with --allow-domain)`);
    }
    return {
      daemon: true,
      unlocked,
      blind_mode: services.blind.current(),
      browser_started: services.browser !== null,
      proxy_active: services.cdpProxy !== null,
      vault: {
        envelope_present: await fileExists(paths.envelopePath),
        legacy_key_present: await fileExists(paths.keyPath),
      },
      policy_warnings: policyWarnings,
      version: 2,
    };
  });
}
```

- [ ] **Step 4: Register it (`src/daemon/api/router.ts`)**

Add import:

```ts
import { registerHealth } from "./routes/health.js";
```

Add call inside `registerRoutes` (after `registerStatus(server, services);`):

```ts
  registerHealth(server, services);
```

- [ ] **Step 5: Implement `src/cli/commands/doctor.ts`**

```ts
import { Command } from "commander";
import { stat } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ok, outputJson } from "../../shared/result.js";

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Report whether the daemon, vault, browser, policy, and local files are in a safe state.")
    .option("--json", "Emit machine-readable JSON.", false)
    .action(async (options) => {
      const paths = getShuttlePaths();
      let socketMode: string | null = null;
      try {
        const st = await stat(paths.daemonSocketPath);
        socketMode = "0" + (st.mode & 0o777).toString(8);
      } catch { socketMode = null; }

      let health: Record<string, unknown> | null = null;
      let daemonError: string | null = null;
      try {
        health = (await daemonRequest("GET", "/v1/health")) as Record<string, unknown>;
      } catch (e) {
        daemonError = e instanceof Error ? e.message : String(e);
      }

      const report = {
        daemon_reachable: health !== null,
        daemon_error: daemonError,
        socket_file_mode: socketMode,
        socket_file_mode_ok: socketMode === null || socketMode === "0600",
        health,
      };

      if (options.json === true) {
        outputJson(ok(report));
        return;
      }
      const lines: string[] = [];
      lines.push(`daemon:        ${report.daemon_reachable ? "reachable" : "NOT reachable"}`);
      if (socketMode !== null) lines.push(`socket mode:   ${socketMode}${report.socket_file_mode_ok ? " (ok)" : " (EXPECTED 0600)"}`);
      if (health !== null) {
        lines.push(`unlocked:      ${health.unlocked}`);
        lines.push(`browser:       ${health.browser_started ? "started" : "not started"}`);
        lines.push(`proxy:         ${health.proxy_active ? "active" : "inactive"}`);
        lines.push(`blind mode:    ${health.blind_mode === null ? "off" : "ON"}`);
        const v = health.vault as { envelope_present: boolean; legacy_key_present: boolean };
        lines.push(`vault:         envelope=${v.envelope_present} legacy_key=${v.legacy_key_present}${v.legacy_key_present ? " (RUN: secret-shuttle migrate secure-vault)" : ""}`);
        const warns = health.policy_warnings as string[] | null;
        if (warns === null) lines.push(`policy:        (vault locked — unlock to audit)`);
        else if (warns.length === 0) lines.push(`policy:        ok`);
        else { lines.push(`policy:        ${warns.length} warning(s):`); for (const w of warns) lines.push(`  - ${w}`); }
      }
      process.stdout.write(lines.join("\n") + "\n");
    });
}
```

- [ ] **Step 6: Register doctor in `src/cli/index.ts`**

Add import (with the other command imports):

```ts
import { doctorCommand } from "./commands/doctor.js";
```

Add registration (after `program.addCommand(migrateCommand());`):

```ts
program.addCommand(doctorCommand());
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js`
Expected: the health test PASSES.
Run: `npm test` → all PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/api/routes/health.ts src/daemon/api/router.ts src/cli/commands/doctor.ts src/cli/index.ts src/daemon/api/routes.test.ts
git commit -m "feat(ux): /v1/health + `secret-shuttle doctor` safety health-check"
```

---

## Task 15: WS8 — Documentation aligned with the new behavior

**Files:**
- Modify: `docs/browser-harness.md`
- Modify: `docs/security-model.md`
- Modify: `docs/threat-model.md`
- Modify: `README.md`

- [ ] **Step 1: Rewrite the inject section of `docs/browser-harness.md`**

Replace the "When a secret must be entered:" block (lines ~31-38) with:

```markdown
When a secret must be entered:

1. Navigate normally and fill non-secret metadata fields.
2. Focus the secret value field.
3. Run `secret-shuttle inject --ref ... --domain ...` and approve in the daemon
   window. The daemon enters blind mode itself, severs your CDP connection, and
   writes the value while you are blacked out — you never need `blind start` for
   inject.
4. Your CDP proxy connection is now closed and blind mode is ACTIVE. Complete any
   non-observational follow-up.
5. Run `secret-shuttle blind end` and approve once the secret is saved/submitted and
   no longer visible. This blanks open pages and resumes observation.
```

- [ ] **Step 2: Update `docs/security-model.md`**

In the "Browser Control" section, after the "Blind mode is daemon state." sentence add:

```markdown
- `secrets.inject` is itself a daemon-managed blind window: the daemon enters blind
  mode, disables observation domains, and severs agent CDP sockets *before* the value
  reaches the page, then leaves blind mode active until a human-approved
  `blind end`. Inject never requires the agent to manage blind mode.
```

In "Approval Grants", change the bound-fields sentence to also list **allowed
domains**:

```markdown
- Bound to action, ref or planned ref, environment, allowed domains, destination
  domain, browser target id, focused-field fingerprint, template id, and template
  params.
```

Replace the "Domain Matching" paragraph's first sentence with:

```markdown
Exact by default. Wildcards require `*.example.com`. An empty allowed-domains list
means the secret is injectable **nowhere** (fail closed), never everywhere.
```

Add a new bullet under "Secure Mode protects against:":

```markdown
- Agents screenshotting or DOM-reading the value of their own approved injection
  (inject runs inside a daemon-managed blind window).
- Agents brute-forcing low-entropy secrets from fingerprints (fingerprints are
  vault-keyed HMAC, not raw SHA-256) or using `compare` as an unlimited oracle
  (production `compare` is approval-gated and all `compare` is rate-limited).
- Daemon-spawned binaries/Chrome reading the daemon bearer token (scrubbed from the
  daemon process env and never placed in child envs).
```

- [ ] **Step 3: Update `docs/threat-model.md`**

Replace the "### Agent takes a screenshot while a secret is visible" section body with:

```markdown
Blind mode is daemon state. For capture, the agent must `blind start` before the
secret is revealed. For inject, the daemon itself enters blind mode and severs agent
CDP sockets before the value reaches the page, so the agent cannot screenshot or
DOM-read the value it caused to be entered. Resuming requires a human-approved
`blind end` that blanks open pages.
```

Add two new threat subsections before "## Non-Goals":

```markdown
### Agent brute-forces a secret from its fingerprint

Fingerprints are HMAC-SHA256 under a per-vault random key held only in daemon memory.
The agent cannot precompute a dictionary. `compare` is an online oracle only:
production `compare` requires human approval and every `compare` is per-ref
rate-limited.

### Daemon-spawned process reads the bearer token

The daemon deletes `SECRET_SHUTTLE_DAEMON_TOKEN`/`SECRET_SHUTTLE_MASTER_KEY` from its
own environment after reading them, and spawns Chrome and command templates with an
explicit minimal env that contains no `SECRET_SHUTTLE_*` variable.
```

- [ ] **Step 4: Update `README.md`**

In "What Works Today (0.1.1)" replace the inject/blind line and add new lines:

```markdown
- Generate, capture (focused field / selection), inject, compare — all routed through the daemon
- Inject runs inside a daemon-managed blind window (no manual `blind start`)
- Vault-keyed HMAC fingerprints; production `compare` is approval-gated + rate-limited
- Fail-closed domain policy (empty allow-list = injectable nowhere); approvals show the scope
- `secret-shuttle doctor` health-check (daemon, vault, browser, policy, local files)
- Daemon bearer token is scrubbed from the daemon and all child process envs
```

In "What Does Not Work Yet" leave the deferred items (OS keychain, signed binaries,
MCP, team vaults) and add:

```markdown
- Secret rotation / import / export workflows
- Templates beyond `vercel-env-add`
```

- [ ] **Step 5: Verify docs build into the package cleanly**

Run: `npm run check-pack`
Expected: PASS (docs ship, `docs/superpowers/` excluded).

- [ ] **Step 6: Commit**

```bash
git add docs/browser-harness.md docs/security-model.md docs/threat-model.md README.md
git commit -m "docs: align browser-harness/security/threat/README with hardened behavior"
```

---

## Task 16: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ALL tests PASS. Record the test count (should be ≥ 163 + the new tests added across Tasks 1-14).

- [ ] **Step 3: Package hygiene**

Run: `npm run check-pack`
Expected: `check-pack: OK (...)` — no `docs/superpowers/`, no `*.map`, no stale `--confirm-production`/`remote-debugging-port` markers.

- [ ] **Step 4: Dependency audit**

Run: `npm audit`
Expected: 0 vulnerabilities (no runtime deps added).

- [ ] **Step 5: Git status clean**

Run: `git status --porcelain`
Expected: empty (everything committed). `git log --oneline` shows the task commits.

- [ ] **Step 6: Targeted security spot-checks**

Run: `grep -rn "isMethodAllowed" src/daemon/proxy/cdp-filter.ts` — confirm blind-off still total-allow only when blind is off (unchanged), and that inject now forces blind on.
Run: `grep -rn "SECRET_SHUTTLE_DAEMON_TOKEN" src/` — confirm it is only set in `lifecycle.ts` (parent→daemon handoff) and deleted in `main.ts`/`safe-env.ts`; never read by templates or Chrome.
Run: `grep -rn "allowed.length === 0" src/daemon/api/routes/secrets.ts` — confirm empty list throws (fail closed).

Expected: all three confirm the intended state.

---

## Self-Review (completed by plan author)

**Spec coverage:** WS1→Tasks 9-11; WS2→Tasks 3-4; WS3→Tasks 5-7; WS4→Task 1; WS5→Task 8; WS6→Task 2; WS7→Tasks 13-14; WS8→Task 15; cross-cutting verification→Tasks 12, 16. Every spec workstream maps to at least one task.

**Placeholder scan:** No TBD/TODO; every code step contains complete code; test code is concrete.

**Type consistency:** `fingerprintSecret(value, key)` / `fingerprintMatches(value, fp, key)` / `isLegacyFingerprint(fp)` used consistently (Tasks 5-6). `ApprovalBinding.allowed_domains?: string[] | null` + `domainSet()` consistent (Tasks 4, 11, 12, 13). `buildChildEnv()`/`scrubDaemonSecretsFromEnv()` consistent (Task 1). `RateLimiter(limit, windowMs, now?)` consistent (Task 7). `readFocusedFingerprintAndDomain()` return type extended with optional `page_title`/`page_url_host` and consumed as optional in bindings (Task 13). Inject route final form in Task 9 supersedes the Task 8 partial and keeps the Task 8 validation/action-enforcement — explicitly noted.
