# Secret Shuttle — Hardening + Seamless Core (Design)

Date: 2026-05-17
Status: Approved for implementation (autonomous track)
Driver: End-to-end security review (5 high-risk findings + UX/packaging gaps)

## Product thesis

The product promise is **"AI agents use secrets without ever seeing them."** Today that
promise holds only if the agent and human follow a brittle manual ritual perfectly.
The review's blocking issues are *correctness and safety-by-default*, not missing
breadth.

**Direction for this iteration: make the core promise hold automatically and safely
by default — before adding any breadth.** Concretely: close the inject observation
hole by making the daemon own the blind window, make domain scoping fail-closed,
remove the offline/online fingerprint oracles, stop leaking the daemon token to child
processes, ship a clean package, and make the human approval + health story legible.

**Explicitly deferred (out of scope here, tracked in roadmap):** OS-keychain key
storage, signed desktop binaries, MCP server, import/export/rotation, additional
templates beyond `vercel-env-add`. Each is its own spec. Adding breadth on top of an
unsound core is a net negative.

## Workstreams

### WS1 — Inject runs inside a daemon-managed blind window (HIGH)

**Problem.** `capture` requires blind mode (`services.blind.assertForDomain`,
`secrets.ts:132`); `inject` does not. With blind mode off the CDP proxy forwards
everything (`cdp-filter.ts:18`), so an agent that obtains an approved injection can
immediately screenshot/read the DOM and recover the value it just caused to be typed.
`docs/browser-harness.md:31` even instructs agents to inject without blind mode.

**Asymmetry that drives the design.** For *capture* the secret is already on screen
because the agent navigated there — the agent must consciously stop observing
*before* the reveal, so explicit `blind start` stays required. For *inject* the secret
does not exist on the page until the daemon writes it — therefore the daemon can and
must own the entire blind window itself.

**Design.** `POST /v1/secrets/inject` becomes, for every environment (the
no-observation promise is unconditional; approval gating stays production-only):

1. `requireKey()`, load secret, `pre = readFocusedFingerprintAndDomain()`.
2. Domain checks (WS2 — empty allowlist now denies) and
   `assertSecretActionAllowed(secret, "inject_into_field")` (WS5).
3. `requireApproval(...)` with the WS2-extended binding (human sees scope).
4. **Enter the blind window:** `services.blind.start(pre.domain, "inject")`, then
   best-effort `disableObservationDomains(cdp)`, then
   `cdpProxy.severAgentConnections()`. This happens *before* any value touches the
   page, mirroring `blind/start`.
5. `post = readFocusedFingerprintAndDomain()`; if `post !== pre` → end blind mode
   (no value was written, nothing is on screen, so auto-resume is safe) and throw
   `field_changed`.
6. `injectFocused(secret.value)` over the daemon-internal CDP (never the proxy).
7. `markUsed`, audit. **Blind mode stays active.**
8. Response includes `blind_mode: true` and a human-readable instruction: the agent's
   CDP is severed; to resume observation a human must run `secret-shuttle blind end`
   and approve.

`blind end` already requires human approval, blanks all pages, and fails closed
(`blind.ts:46`, `internal-ops.ts:39`). That is the single, uniform "sensitive op is
over" gate for both capture and inject. The only irreducible manual step is the
human attestation at `blind end` — only a human can certify the screen is safe.

**Net UX.** The agent workflow for inject collapses from an undocumented/unsafe path
to: focus field → `inject` → (do non-observational follow-up) → `blind end`. No
manual `blind start`. Same mental model as capture's tail.

**Failure handling.** Any failure *before* `injectFocused` succeeds must auto-end
blind mode (nothing was written). Only a successful write leaves blind active.

**Tests.** Update `routes.test.ts` inject cases and `e2e/stripe-to-vercel.test.ts`
(inject section) for the new post-state (blind active after success; auto-resume on
pre-write failure). Add: inject success leaves `blind_mode != null`; CDP proxy is
severed on inject; pre-write `field_changed` leaves `blind_mode == null`.

### WS2 — Domain policy fails closed; scope is bound + shown (HIGH)

**Problem.** `enforceDomain` treats an empty allowlist as "allow all"
(`secrets.ts:287`). CLI `--allow-domain` defaults to `[]` for `generate`/`capture`
(`capture.ts:13`, `generate.ts:13`), and because `[]` is not nullish the daemon's
intended `?? [domain]` defaults never fire. The approval binding/UI neither bind nor
display the future injection scope.

**Design.**
- `enforceDomain`: an empty allowed list now **denies** (`domain_not_allowed`) for
  `inject` and `compare`. Empty = "not injectable anywhere yet", never "anywhere".
- CLI `capture`/`generate`: when no `--allow-domain` is given, **omit**
  `allowed_domains` from the request body (send `undefined`, not `[]`) so the daemon's
  sensible default applies: capture → `[capturedDomain]` (auto-scope to the page the
  secret came from); generate → `[]` (stays non-injectable until scoped).
- CLI `generate`/`capture` with `--env production` and no resulting domain scope →
  fail fast at the CLI with a clear message ("production secrets require at least one
  --allow-domain").
- `ApprovalBinding` gains `allowed_domains: string[] | null`. `capture`, `generate`,
  and `inject` populate it; `bindingsMatch` compares it (order-insensitive). The
  approval UI shows **"Injectable into: a, b"** so the human consents to the scope.

**Tests.** empty-allowlist inject → `domain_not_allowed`; capture with no
`--allow-domain` stores `[capturedDomain]`; production generate with no domain →
CLI error; approval binding mismatch when `allowed_domains` differ; UI renders scope.

### WS3 — Keyed fingerprints; gated + rate-limited compare (HIGH)

**Problem.** `fingerprintSecret` is `sha256:hex(value)` (`fingerprints.ts:4`),
returned to the agent in metadata → offline dictionary oracle for low-entropy
secrets. `compare` (`secrets.ts:252`) is an online equality oracle with no production
approval and no rate limit.

**Design.**
- Per-vault random 32-byte `fingerprint_key`, stored inside the encrypted
  `VaultPlaintext` (daemon-memory only, encrypted at rest). Fingerprint becomes
  `hmac-sha256:` + HMAC(fingerprint_key, value), truncated for display as today.
- Backward compatibility / migration: on `Vault.read()`, if `fingerprint_key` is
  absent generate it; for any secret whose fingerprint still has the legacy `sha256:`
  prefix, recompute as `hmac-sha256:` (the plaintext value is in the record) and
  persist. One-shot transparent upgrade on first unlock+write. `fingerprintMatches`
  accepts the keyed scheme; a legacy verifier path is unnecessary after migration
  but `fingerprintMatches` must take the key.
- `fingerprintSecret`/`fingerprintMatches` signatures change to take the key; all
  call sites (`vault.ts`, `secrets.ts` compare) updated. Tests that compare against
  bare `fingerprintSecret(value)` switch to asserting via the daemon
  (`inspect`/`compare`) or pull the key through a vault test seam.
- `compare`: production-classed secret → `requireApproval` (new binding action
  `"compare"` already exists in the union; bind ref+domain). Plus an in-memory
  per-ref rate limiter (default 5 / 60s, shared helper) applied to *all* compares to
  blunt the online oracle. Over limit → `compare_rate_limited`.
- Enforce `assertSecretActionAllowed(secret, "compare_fingerprint")` (WS5).

**Tests.** keyed fingerprint differs from raw sha256 and is stable per vault; legacy
`sha256:` secret is migrated on read; production compare without approval →
`approval_required`; 6th compare within 60s → `compare_rate_limited`.

### WS4 — Child processes never inherit the daemon token (HIGH)

**Problem.** `lifecycle.ts:31` injects `SECRET_SHUTTLE_DAEMON_TOKEN` into the daemon
env; `main.ts:32` reads but never deletes it; `templates/run.ts:44` and
`chrome/launch.ts` spawn with no explicit `env`, so children inherit the bearer
token and could call the daemon API directly, bypassing every gate.

**Design.**
- `main.ts`: immediately after reading the token,
  `delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN` (and
  `delete process.env.SECRET_SHUTTLE_MASTER_KEY` — V2 uses the scrypt envelope, not
  the env key; scrub it so children/Chrome can't read it).
- `safe-env.ts`: add `buildChildEnv()` — a minimal allowlist (HOME/locale/tmp/
  Windows basics) with the hardened `safeDaemonPath()` and a hard guarantee that no
  `SECRET_SHUTTLE_*` variable is present.
- `templates/run.ts` `spawn(...)` and `chrome/launch.ts` (`spawnChromePipe`) pass
  `env: buildChildEnv()` explicitly. Verify `pipe-transport.ts` `spawnChromePipe`
  forwards an `env` option.

**Tests.** `buildChildEnv()` contains no `SECRET_SHUTTLE_*`; template spawn receives
the scrubbed env (inject a spawn seam or assert via a probe binary in a unit test);
regression: token absent from `process.env` after `main` token read (extract the
scrub into a tiny tested helper).

### WS5 — Enforce `allowed_actions`; schema validation (Code quality)

- `assertSecretActionAllowed` (`policy.ts:4`) is dead. Wire it into `inject`
  (`inject_into_field`), `compare` (`compare_fingerprint`), and `template run`
  (`use_as_stdin`) against the loaded secret, before approval. Capture/generate
  create secrets and keep default actions.
- Add `src/daemon/api/validate.ts`: dependency-free guards (`expectObject`,
  `expectString`, `expectStringArray`, `expectOptionalString`, `expectBoolean`)
  throwing `ShuttleError("bad_request", "<field>: <reason>")`. Apply to
  `secrets.{generate,capture,inject,compare,list,inspect}`, `templates.run`,
  `blind.start`. Keep minimal; validate shape/required only.

**Tests.** inject with a secret whose `allowed_actions` excludes
`inject_into_field` → `action_not_allowed`; malformed bodies → `bad_request` with the
offending field named.

### WS6 — Clean, honest npm package (HIGH for release)

**Problem.** `dist/` is git-ignored and untracked but `package.json#files` ships
whatever stale `dist/` is on disk; `npm pack` also ships a 151 KB internal plan
(`docs/superpowers/plans/...`) and all `.js.map`. Review confirms stale
`--confirm-production` / `--remote-debugging-port` artifacts in `dist/`.

**Design.**
- Scripts: `"clean": "rm -rf dist"`, `"prepack": "npm run clean && npm run build"`,
  `"prepublishOnly": "npm run typecheck && npm test"`.
- `package.json#files`: add `"!dist/**/*.js.map"` and `"!dist/**/*.tsbuildinfo"`.
- Add `.npmignore` excluding `docs/superpowers/`, `**/*.map`, `**/*.tsbuildinfo`,
  `**/*.test.*`.
- Add `scripts/check-pack.mjs` (run in `prepublishOnly` and in verification): build
  fresh, `npm pack --dry-run --json`, assert the tarball (a) excludes
  `docs/superpowers/`, `*.map`; (b) contains no file whose source text includes
  `--confirm-production` or `--remote-debugging-port` (stale-artifact tripwire).

**Tests.** `check-pack.mjs` exits non-zero on a planted stale marker (self-test in
CI/verification step, not a unit test).

### WS7 — Legible approvals + `secret-shuttle doctor` (UX)

- **Approval UI** (`ui.html`, grant payload): render a plain-language sentence
  ("Inject ss://stripe/prod/STRIPE_SECRET_KEY into the <type> field on vercel.com"),
  show **Injectable into** (WS2 `allowed_domains`), page title + URL host, field
  label/name/type humanized, template description (not just id) + params + binary
  path/sha. Keep raw `target_id`/`field_fingerprint` under a collapsed "Technical
  details". Per-action warning line (refined copy for `blind_end` covering the inject
  resume case: "Approving navigates open pages to about:blank and resumes
  observation. Approve only if the secret has been saved/submitted and is no longer
  visible."). Capture page title/URL: extend the pre-snapshot to include
  `page_title` + `page_url_host` (read alongside domain in `internal-ops`), add to
  the binding as display-only (not part of `bindingsMatch`).
- **`secret-shuttle doctor`**: new CLI command + `GET /v1/health` returning a
  structured safety report — daemon running, vault unlocked, browser started,
  `blind_mode` state, proxy active, key-storage backend (envelope present, legacy
  `master-key.json` absent), build stamp present (WS6), policy warnings (production
  secrets with empty `allowed_domains`), socket-file mode `0600`. Human-readable by
  default, `--json` for agents. Additive, no security surface change.

### WS8 — Docs aligned with reality

- `docs/browser-harness.md`: inject section rewritten — no manual `blind start`;
  the daemon auto-blinds; you must `blind end` (human-approved) to resume.
- `docs/security-model.md` + `docs/threat-model.md`: inject is blind-enforced; keyed
  fingerprints; compare gated+rate-limited; child env scrub; `allowed_actions`
  enforced; fail-closed domain policy. Add the "agent screenshots its own approved
  injection" threat as mitigated.
- `README.md`: update "What Works / What's Missing"; document `doctor`.

## Cross-cutting constraints

- No new runtime dependencies (Node built-ins only; keep `commander`, `ws`).
- Preserve the existing test harness shape (`withDaemon`, `stubBrowser`,
  `node:test`, build-then-`node --test dist/**/*.test.js`).
- `npm run typecheck` and `npm test` must pass; `check-pack` must pass.
- Strict TS settings unchanged (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`). New optional binding fields must respect this.
- Fail-closed everywhere: a failure in a security gate must never widen access.

## Sequencing (dependencies)

WS4, WS6 are independent and parallelizable. WS2 and WS5 are mostly independent.
WS3 changes `fingerprint*` signatures (touches `vault.ts`, `secrets.ts`, tests).
WS1 depends on WS2's binding extension and WS5's action enforcement landing in the
inject route. WS7's approval-UI work depends on WS2 (`allowed_domains` in grant) and
the WS1 inject changes. WS8 is last (documents the rest). Recommended order:
WS4 ∥ WS6 ∥ WS2 ∥ WS3 → WS5 → WS1 → WS7 → WS8 → full verification.
