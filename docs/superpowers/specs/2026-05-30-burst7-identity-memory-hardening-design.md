# Burst 7 — Identity & Memory Hardening

**Version target:** 0.4.0 (minor — new opt-in feature + internal hardening).
**Spec date:** 2026-05-30.
**Sits on top of:** v0.3.1 (Burst 6 "Vision Polish") — merged to main, not yet `npm publish`-ed (publish gated on the Burst 6 dogfood run).

---

## §0 — Cross-section context

### What this burst is for

Two security-infrastructure plans the earlier bursts forward-referenced:

- **Plan 5s — per-project agent IDs (opt-in):** today every project on a machine shares one `<runtime>-<machineId>` identity. Owner-enforced consumption (Burst 4) therefore cannot distinguish "agent in project A" from "agent in project B" — a session-affordance leak in one project is consumable by the same agent id in another. 5s adds an opt-in per-project dimension to the derived identity.
- **Plan 5q — plaintext-out-of-heap memory hygiene:** secret values currently live as JS `string`s (`SecretRecord.value: string`). JS strings are immutable and cannot be zeroed — they linger in the daemon heap until GC, so a core dump / heap snapshot of the daemon process can contain recently-handled secret values. 5q moves the per-secret *use path* to a scrubbable `Buffer`, wrapped in a redaction-safe `SecretValue` type.

**Plan 5a (native keychain) is NOT in this burst — it already shipped.** During scoping, the keychain adapters (`src/vault/keychain/{darwin,linux,windows}.ts`) were found to be complete `@napi-rs/keyring`-backed implementations (not stubs), with the enroll/disable routes, the `keychain_opt_out` envelope flag, opportunistic enrollment, and the unlock-first keychain read all wired (labeled "Plan 5b/5f" in `unlock-session.ts`). `@napi-rs/keyring@^1.3.0` is in `package.json` and installed; keychain tests pass. The only 5a residue is **stale doc comments** in `src/vault/keychain/index.ts` and `types.ts` that still describe the implementations as "stubs in Plan 1 / Plan 5a wires in the real implementations." Correcting those comments is folded into this burst's wrap (Wrap.1) — pure documentation lint, no functional change.

### What changes vs. what does not

**Unchanged (hard constraints):**
- The daemon trust boundary: the agent never sees plaintext. 5q is a heap-lifetime hardening, NOT a leak fix — verification confirmed no daemon JSON *response* serializes a secret value today; every `.value` read flows to a daemon-internal sink (Chrome injection, child stdin, 0600 env-file, HMAC fingerprint, absence-proof).
- **Wire formats:** 5q is an internal in-memory representation change. No HTTP request/response shape changes. No `error_code` registry changes beyond any additions §1/§2 explicitly introduce (none expected — see each section).
- **On-disk vault format:** `VaultPlaintext` stays JSON-serialized then AES-256-GCM-encrypted (`encryptVault`/`decryptVault` unchanged). 5q is Tier A (per-secret use path); the JSON vault format is explicitly left alone (see §2 "Boundary").
- Approval semantics, session affordance, audit log format, the `ss://` ref grammar, every Burst 4–6 surface.
- **Existing fingerprints stay valid.** `fingerprintSecret` is an HMAC over the value's bytes; HMAC(utf8-bytes-of-string) === HMAC(Buffer-of-same-bytes). Changing the parameter type from `string` to bytes does NOT change any computed fingerprint, so no stored fingerprint migration is required.

**Changed:**
- **5s (opt-in, additive):** `deriveAutoAgentId` gains an optional third `projectScope` parameter (back-compatible — 2-arg callers get byte-identical output). Opt-in via `identity.perProject` in `secret-shuttle.config.json` and a `secret-shuttle init --per-project-identity` flag. No existing user's identity changes unless they opt in.
- **5q (internal hardening):** new `SecretValue` wrapper class; `getSecret`/`resolveRefs` return a `ResolvedSecret` whose `value` is a `SecretValue`; the per-secret consumers read `.bytes()` and scrub after use; `fingerprintSecret`/`fingerprintMatches` take bytes. The on-disk `StoredSecretRecord.value` stays `string`.

### Sequencing

5s first (low risk, localized), then 5q (cross-cutting, ~55 `.value` call sites). Wrap last (5a doc fix + CHANGELOG + version bump). One codex gate per stage (spec, plan, impl).

### Items map

| Item | Section | Surface |
|---|---|---|
| 5s | §1 | Opt-in per-project agent IDs (`deriveAutoAgentId` + `init` + config) |
| 5q | §2 | `SecretValue` wrapper + Buffer use-path + scrub-after-use |
| 5a-doc | Wrap.1 | Correct stale keychain "stub" doc comments to match shipped reality |

---

## §1 — Plan 5s: per-project agent IDs (opt-in)

### Current state (verified)

`src/daemon/auth/agent-id.ts`:
```ts
export function deriveAutoAgentId(runtime: string, machineId: string): string {
  const digest = createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;   // e.g. "claude-7f2a9c1b3d4e5f60"
}
```
Called once, at `src/cli/commands/init.ts:238`, inside the per-runtime token-mint loop. `machineId` is read from `<SHUTTLE_HOME>/machine-id`. The derived id must satisfy `AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/` (asserted by `assertAgentIdValid`). `"root"` and `"daemon"` are reserved.

### Change

**Back-compatible signature extension:**
```ts
export function deriveAutoAgentId(runtime: string, machineId: string, projectScope?: string): string {
  const material = projectScope === undefined
    ? `${machineId}\x00${runtime}`                       // unchanged — 2-arg callers get identical output
    : `${machineId}\x00${runtime}\x00${projectScope}`;   // per-project variant
  const digest = createHash("sha256").update(material).digest("hex");
  return `${runtime}-${digest.slice(0, 16)}`;
}
```
The id format is unchanged (`${runtime}-${16 hex}`); only the digest material gains a scope component when opt-in is on. Length and `AGENT_ID_RE` validity are preserved.

**`projectScope` resolution** — new helper in `agent-id.ts`:
```ts
import { execFileSync } from "node:child_process";

/** Absolute git-repo-root path, or process.cwd() when not in a repo.
 *  Hashed into the agent id — the path itself never appears in the id. */
export function resolveProjectScope(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root.length > 0 ? root : cwd;
  } catch {
    return cwd;   // not a git repo, or git absent → cwd is the scope
  }
}
```

**Opt-in mechanism (two equivalent triggers, config is canonical):**
- **Config:** `identity: { perProject: true }` in the project's `secret-shuttle.config.json` (the same file Burst 6 introduced `infer.supabaseNames` into). Read via a small loader (mirror Burst 6's `loadInferConfig` defensive pattern: missing file / malformed JSON / non-object / non-boolean `perProject` → treat as `false`).
- **Flag:** `secret-shuttle init --per-project-identity` — when passed, `init` behaves as if `identity.perProject` were true for this run AND writes `identity: { perProject: true }` into `secret-shuttle.config.json` so subsequent runs are consistent (create the config file if absent; merge the key if present, preserving `infer.*`).

**Where it lands:** `init.ts` (the one caller at line 238) reads the opt-in (config OR flag); when true it resolves `projectScope = resolveProjectScope(process.cwd())` and calls the 3-arg `deriveAutoAgentId`. When false it calls the 2-arg form (today's behavior). The token-mint + settings-write path is otherwise unchanged — it writes whatever id `init` derived.

### Known-unknown resolutions

- **Monorepo:** sub-projects under one git root share an agent id (one repo = one trust domain). Documented in the flag help + CHANGELOG. Finer (per-subdir) granularity is a future opt-in, not this burst.
- **Relocation:** moving the project directory changes the git-root path → changes the derived id → orphans that project's sessions/grants. With opt-in this is the user's informed choice; re-running `init` after a move re-derives and re-mints. Documented in the flag help + CHANGELOG.
- **Determinism:** same (machine, runtime, project path) always yields the same id (pure hash) — no state file needed beyond the existing machine-id.

### Error codes

None new. 5s is additive opt-in behavior over an existing derivation; failure modes (git absent, not a repo) fall back to cwd rather than erroring.

### Tests (TDD)

- `deriveAutoAgentId(runtime, machineId)` (2-arg) output is **byte-identical** to the pre-change function for a fixed input (regression pin — guarantees existing users unaffected).
- `deriveAutoAgentId(runtime, machineId, scope)` (3-arg) produces a distinct id from the 2-arg form, stable for a fixed scope, and `AGENT_ID_RE`-valid.
- Two different `projectScope` values → two different ids; same scope → same id.
- `resolveProjectScope`: returns the git-root in a temp git repo; returns cwd in a non-repo temp dir; returns cwd when `git` errors.
- Config loader: `perProject: true` honored; missing/malformed config / non-boolean → `false` (defensive).
- `init --per-project-identity` writes/merges `identity.perProject` into `secret-shuttle.config.json` without clobbering an existing `infer.*` block.

---

## §2 — Plan 5q: `SecretValue` + Buffer use-path (Tier A)

### Goal & boundary

Keep long-lived plaintext copies out of the daemon heap by making the per-secret **use path** a scrubbable `Buffer`, wrapped in a redaction-safe `SecretValue`. **Tier A:** the on-disk JSON vault format is untouched. The bulk `JSON.stringify(VaultPlaintext)`→encrypt / decrypt→`JSON.parse` path (`crypto.ts`) inherently holds a transient string of all values at the encrypt boundary; eliminating that requires a binary vault format + on-disk migration (Tier B), which is **explicitly out of scope** (see §3) and documented as an accepted, bounded limitation. The transient is short-lived (held only during a single synchronous read/write op, then dropped); the win 5q captures is the *long-lived* per-consumer copy that today persists as a `string` for the duration of async browser injection / child-process lifetime / absence-proof.

### `SecretValue` — the guard-by-construction

New file `src/vault/secret-value.ts`:
```ts
import { timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const REDACTED = "[secret]";

/**
 * A secret's plaintext bytes, wrapped so accidental stringification redacts
 * instead of leaking. The ONLY way to read the bytes is `.bytes()`, which is
 * greppable + auditable. toString/toJSON/inspect all return "[secret]", so
 * `${sv}`, JSON.stringify(sv), console.log(sv), and template/log interpolation
 * cannot leak the value. Call dispose() after use to zero the backing Buffer.
 */
export class SecretValue {
  #buf: Buffer;
  #disposed = false;

  private constructor(buf: Buffer) { this.#buf = buf; }

  static fromUtf8(s: string): SecretValue { return new SecretValue(Buffer.from(s, "utf8")); }
  static fromBuffer(b: Buffer): SecretValue { return new SecretValue(Buffer.from(b)); } // defensive copy

  /** The plaintext bytes. Throws if already disposed. The single audited door. */
  bytes(): Buffer {
    if (this.#disposed) throw new Error("SecretValue used after dispose()");
    return this.#buf;
  }

  /** Byte length (safe to expose — not the value). */
  get byteLength(): number { return this.#buf.length; }

  /** Constant-time compare against another secret's bytes. */
  equals(other: SecretValue): boolean {
    const a = this.bytes(), b = other.bytes();
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Zero the backing buffer. Idempotent. */
  dispose(): void { this.#buf.fill(0); this.#disposed = true; }

  toString(): string { return REDACTED; }
  toJSON(): string { return REDACTED; }
  [inspect.custom](): string { return REDACTED; }
}
```

### Type split

- **On-disk / in `VaultPlaintext` — unchanged:** `SecretRecord.value: string` (renamed conceptually as the *stored* record; the existing `SecretRecord` type keeps `value: string` so `encryptVault`/`decryptVault` and the upsert-write path serialize cleanly). The crypto layer and vault-internal rotation/fingerprint-recompute keep operating on the stored string.
- **Returned to consumers — new:** `getSecret(ref)` / `resolveRefs(refs)` return a `ResolvedSecret` — all the `SecretRecord` metadata fields EXCEPT `value` is a `SecretValue` (created via `SecretValue.fromUtf8(stored.value)` at the resolve boundary). Consumers never touch the stored string; they get the scrubbable, redaction-safe `SecretValue`.

```ts
export type ResolvedSecret = Omit<SecretRecord, "value"> & { value: SecretValue };
```

### Consumer changes (the ~7 use sites)

Each reads `.value.bytes()` (instead of `.value`) and scrubs (`.value.dispose()`) after the value is no longer needed:
- `inject-submit.ts` (`browser.injectField`, `proveAbsence`)
- `inject-render.ts` (`valuesMap`)
- `templates.ts` (child stdin)
- `secrets.ts` (`injectFocused`, `fingerprintMatches`)
- `reveal-capture.ts` (captured value)
- `run-resolve.ts` (env values)
- `compare` (HMAC compare)

The sinks already accept/scrub Buffers (spawner stdin, run-resolve dispose, keychain `.fill(0)`); 5q extends that discipline to the remaining consumers and threads `Buffer` instead of `string` into them.

### Fingerprint signature

```ts
export function fingerprintSecret(value: Buffer, key: Buffer): string;       // was (value: string, key)
export function fingerprintMatches(value: Buffer, fingerprint: string, key: Buffer): boolean;
```
Internally HMACs the bytes (identical output to the old string form for the same bytes — **no stored-fingerprint migration**). Vault-internal callers that currently pass `stored.value` (a string) pass `Buffer.from(stored.value, "utf8")`; consumer callers pass `resolved.value.bytes()`.

### Inbound (write) path

`UpsertSecretInput.value` becomes `SecretValue` (the value being stored). Producers:
- `generate` (random bytes → `SecretValue.fromBuffer`)
- `capture` / `reveal-capture` (bytes from browser → `SecretValue.fromBuffer`)
- `import` (provided value → `SecretValue.fromUtf8`)

The vault write serializes `input.value.bytes().toString("utf8")` into the stored `SecretRecord.value` string (Tier A — on-disk stays string), then `input.value.dispose()` scrubs the inbound `SecretValue`. The transient `toString("utf8")` here is the same bounded encrypt-boundary transient described above.

### Audit pass (Task 1 of §2)

Enumerate all ~55 `.value` reads (the plan will list them). Categorize each: (a) on-disk/stored-string (vault internals — stays string), (b) resolved-consumer (→ `.bytes()` + scrub), (c) unrelated `.value` (body params, template_params, entry.value — not secret values, untouched). The plan's first 5q task is this audit so the implementer works from a definitive site-by-site map.

### Guard test

A test (`src/vault/secret-value.test.ts` + a repo-scan test) asserting: `String(sv)`, `` `${sv}` ``, `JSON.stringify(sv)`, `util.inspect(sv)`, `console.log`-equivalent all yield `"[secret]"`; `.bytes()` after `dispose()` throws; `equals` is correct + constant-time-shaped; and a grep-guard that no daemon route file passes a raw resolved `.value` (as opposed to `.value.bytes()`) into a response serializer.

### Tests (TDD)

- `SecretValue`: redaction on all four stringify paths; `.bytes()` round-trips; `dispose()` zeros + subsequent `.bytes()` throws; `equals` true/false + length-mismatch short-circuit; `fromBuffer` defensively copies (mutating the source buffer doesn't change the SecretValue).
- `fingerprintSecret(Buffer)` produces the **same** digest as the old `fingerprintSecret(string)` for identical bytes (migration-free pin).
- `getSecret`/`resolveRefs` return `ResolvedSecret` with a `SecretValue`; the stored vault record still round-trips its string on disk.
- Each consumer: end-to-end test that the operation still works with the Buffer path (inject-submit success, template stdin delivery, compare match/mismatch, run env resolution) AND that the value is disposed after use (assert `.bytes()` throws post-op where observable, or assert the buffer is zeroed via a spy).
- No regression in the full suite (1588 baseline + new tests).

---

## §3 — Out of scope (deferred)

- **5q Tier B — binary vault format.** Replacing `JSON.stringify(VaultPlaintext)`→encrypt with a binary/length-prefixed format so the bulk persist/load path never materializes a plaintext string. Requires an on-disk format version bump + a back-compat reader for existing JSON vaults + migration. Diminishing returns over Tier A (the transient is already short-lived); its own plan if ever wanted.
- **CI/CD secret delivery story** (daemon-runs-local vs CI-runs-remote). Forward-referenced since Burst 6 §7.D; needs its own brainstorm; likely its own burst.
- **`--infer` detectors for Render / Netlify / Railway / Fly / Firebase** — each needs a new template first (Burst 6 §7.E).
- **Per-subdirectory (sub-monorepo) identity granularity** beyond git-root (5s monorepo note).

---

## §4 — Implementation order

| Order | Section | Notes |
|---|---|---|
| 1 | §1 / 5s | `deriveAutoAgentId` 3-arg + `resolveProjectScope` + config loader + `init` wiring + tests. Self-contained; low risk. Commit. |
| 2 | §2 / 5q — audit | Enumerate + categorize all ~55 `.value` sites into a site map (committed as a comment block in the plan / a short `docs/` note). No code change. |
| 3 | §2 / 5q — `SecretValue` | New class + tests (redaction, dispose, equals, fromBuffer copy). Commit. |
| 4 | §2 / 5q — fingerprint | `fingerprintSecret`/`Matches` → Buffer; migration-free pin test; update vault-internal callers. Commit. |
| 5 | §2 / 5q — resolve path | `ResolvedSecret` + `getSecret`/`resolveRefs` return `SecretValue`; consumer-by-consumer migration to `.bytes()` + scrub (one commit per consumer or small grouped commits). |
| 6 | §2 / 5q — write path | `UpsertSecretInput.value` → `SecretValue`; producers + vault write + scrub. Commit. |
| 7 | §2 / 5q — guard test | Repo-scan guard + final full-suite green. Commit. |
| 8 | Wrap | Wrap.1 (5a doc-comment fix), Wrap.2 (CHANGELOG), Wrap.3 (0.4.0 bump), Wrap.4 (codex impl gate + merge). |

Subagent-driven: §1 is one implementer; §2 is sequenced implementers (audit → SecretValue → fingerprint → resolve-path → write-path → guard), each with spec + code-quality review. The resolve-path step (5) is the largest and may split into per-consumer dispatches.

---

## §5 — Success criteria

1. **5s:** `secret-shuttle init --per-project-identity` in two different project dirs on the same machine produces two different agent ids; without the flag, the id is byte-identical to today's. Existing users (no opt-in) see zero identity change.
2. **5q:** no secret value is held as a long-lived JS `string` on the per-secret use path — consumers operate on `SecretValue.bytes()` and dispose after use. Accidental stringification (`${}`, `JSON.stringify`, log) of a `SecretValue` yields `"[secret]"`, proven by test. Existing stored fingerprints remain valid (no migration). The on-disk vault format is unchanged.
3. **No wire-format change:** every HTTP request/response shape is identical to v0.3.1 (5q is internal-only).
4. **5a doc accuracy:** keychain `index.ts`/`types.ts` comments describe the shipped `@napi-rs/keyring` reality, not "stubs."
5. **Full suite green** (1588 baseline + new tests, 0 fail), `tsc --noEmit` clean, `check-pack` OK. v0.4.0 in `package.json`.
6. **All three codex gates clean** (spec, plan, impl).

---

## §6 — Risks

| Risk | Mitigation |
|---|---|
| A missed `.value` consumer keeps passing a `string` into a sink that lingers — partial hygiene | The §2 audit pass (step 2) produces a definitive site map; the guard test scans for raw resolved-`.value` usage; code-quality review checks each consumer scrubs. |
| `SecretValue.toJSON → "[secret]"` accidentally corrupts a path that SHOULD serialize the real value (e.g. the on-disk write) | The type split keeps on-disk serialization on the *stored string* (`SecretRecord.value: string`), never on a `SecretValue`. The write path explicitly calls `.bytes().toString("utf8")` to produce the stored string. Test: a stored vault round-trips its real value on disk. |
| `dispose()` called too early (value scrubbed before an async sink finishes reading it) | Follow the existing spawner pattern (scrub in the write-callback / after the awaited sink resolves, not before). Per-consumer e2e tests assert the operation succeeds end-to-end. |
| 5s opt-in flag clobbers an existing `secret-shuttle.config.json` `infer.*` block | The flag MERGES `identity.perProject` into the existing config (preserving other keys); test covers a config that already has `infer.supabaseNames`. |
| `git rev-parse` behaves unexpectedly (submodule, worktree, detached) → wrong scope | `resolveProjectScope` only needs a stable absolute path; `--show-toplevel` returns the worktree root, which is stable per checkout. Non-repo / error → cwd fallback. Documented; finer cases are the deferred sub-monorepo item. |
| Fingerprint signature change breaks a caller that still passes a string | TypeScript catches every call site at compile time (string → Buffer is a type error); the migration-free pin test guarantees identical output for the same bytes. |

---

## §7 — Self-review notes (spec author)

Covers: 5s (§1, opt-in, back-compat, tests), 5q (§2, SecretValue + Tier A + type split + audit + guard), 5a-doc (Wrap.1), out-of-scope (§3, Tier B + CI/CD + detectors), impl order (§4), success criteria (§5), risks (§6). No placeholders. Tier A boundary is stated explicitly and consistently (§0, §2, §3). The "no wire change / no fingerprint migration / on-disk format unchanged" invariants are stated in §0 and re-verified in §2 + §6. Input to the next-stage writing-plans skill.
