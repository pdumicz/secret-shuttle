# Agent-Native CLI Redesign (Phase 1) — Design Spec

Date: 2026-05-21
Status: Approved for planning
Topic: Reshape the Secret Shuttle CLI to match category convention (1Password / Doppler / Infisical) and 2025–2026 agent-CLI best practices, while preserving Secret Shuttle's differentiated wedge (CDP browser flows, daemon-mediated templates, per-call consent).

## 1. Core Product Requirement

Secret Shuttle today is architecturally sound (daemon-owned vault, filtered CDP proxy, vetted templates, scrupulous approval grants) but its CLI surface invented its own shape instead of matching the conventions agents already know from `op`, `doppler`, and `infisical`. The result is a tool that works for power users but doesn't feel like the default choice when an AI coding agent discovers it.

This work delivers what we've been calling the "feels like magic" experience by **adopting the category-standard CLI shape** (`init`, `secrets <crud>`, `run -- <cmd>`, `inject`, `status`) plus the **agent-CLI conventions** that crystallized in 2025–2026 (structured errors with `hint`, `--json` default for agents, progressive `--help`, multi-level exit codes). It keeps and polishes Secret Shuttle's unique surface — CDP capture/inject, vetted templates, per-call approval — because that's where the differentiated value lives.

Crucially: there is no `bootstrap` mega-command. The research is unanimous (Anthropic's own Claude Code best-practices, multiple 2026 industry benchmarks) that **composable primitives beat magical do-everything commands** for agent consumption. The magic lives in the approval flow (pre-approved sessions, batched grants), not in a CLI verb.

### 1.1 Success criteria

After this work:

1. An AI agent that has never seen Secret Shuttle can install it (`npx secret-shuttle`), run `secret-shuttle help`, and from the one-line subcommand list alone derive a correct mental model of `secrets`/`run`/`inject` — because those verbs match what it learned from `op`/`doppler`/`infisical`.
2. The agent reads a ~40-line `SKILL.md` (down from 139) and has copy-pasteable worked examples for both the universal flow (`secrets set`, `template run`) and the differentiated flow (`reveal-capture`, `inject-submit`).
3. Every error returned by the CLI carries `{ error, message, hint, code }` where `hint` is the literal next command the agent should run.
4. The "set up Stripe + Vercel + GitHub Actions" composite flow that today requires 8 separate human approval clicks requires **one** human approval (pre-approved session) after this work.
5. Distribution is `npx secret-shuttle init` from a cold start — no `npm link`, no source build.

## 2. Research findings that shape this design

These are the load-bearing inputs. The full sourced research is in the brainstorming conversation; this section captures the conclusions the design depends on.

1. **Category convergence.** `op`, `doppler`, `infisical` all expose the same five verbs at top level: `login`/`init`/`setup`, `secrets <crud>`, `run -- <cmd>`, `inject` (op-only), `status`/`me`. Agents already know this shape from training data. Our CLI must match it for the universal surface.

2. **`run -- <command>`** is the killer pattern Secret Shuttle is missing. It resolves refs to env vars in a subshell, secrets vanish on child exit, stdout/stderr is masked. Every category leader has it. Without it, agents will fall back to `op run` even when Secret Shuttle is installed.

3. **Composability beats magic.** Anthropic's [Claude Code best-practices](https://code.claude.com/docs/en/best-practices): *"CLI tools are the most context-efficient way to interact with external services."* MindStudio benchmark: CLI is 4–32× cheaper in tokens than MCP, with +28% task completion. The Anthropic Agent Skills standard codifies progressive disclosure (frontmatter first, body on demand) — the CLI analog is `help` listing one-liners and `--help` deep-diving.

4. **Sol/Memori structured-error pattern is canonical.** `{ error: "AUTH_EXPIRED", message: "Token expired", hint: "Run: secret-shuttle unlock", code: 401 }`. Exit codes split: `0` success, `1` retry-safe, `2` usage, `3` not-found, `4` permission, `5` conflict.

5. **CLI > MCP for Phase 1.** Hybrid pattern: ship a clean CLI, optional MCP wrapper later (~50 lines if the CLI is well-shaped). MCP buys remote/streaming/push; CLI wins everywhere else. Defer MCP indefinitely.

6. **The Secret Shuttle wedge.** What `op`/`doppler`/`infisical` all miss and Secret Shuttle already has:
   - Browser/CDP capture from provider dashboards (no one else has this).
   - Daemon-mediated execution via templates — the secret never resolves into the calling process at all (op/doppler resolve to plaintext in child env; that's how a malicious child can exfiltrate).
   - Per-call consent (op/doppler treat unlock as session-wide).
   - Per-action audit attribution.

   These stay, polished. The convention adoption is for the universal 80% of the surface; the differentiated 20% is what makes us different.

## 3. How this fits the existing architecture

Read of the existing code (file:line refs throughout) confirms this design is mostly additive. Names change; the daemon's internal invariants do not.

### 3.1 What stays

- **Daemon-owned vault.** `~/.secret-shuttle/vault.json.enc`, scrypt envelope at [src/vault/envelope.ts](../../src/vault/envelope.ts), AES-256-GCM. Untouched.
- **CDP proxy + blind mode.** [src/daemon/proxy/cdp-proxy.ts](../../src/daemon/proxy/cdp-proxy.ts), [src/daemon/proxy/cdp-filter.ts](../../src/daemon/proxy/cdp-filter.ts), [src/daemon/services-blind.ts](../../src/daemon/services-blind.ts). Untouched.
- **Approval store.** [src/daemon/approvals/store.ts](../../src/daemon/approvals/store.ts), `ApprovalBinding`/`bindingsMatch` semantics. Extended (not changed) to support pre-approved sessions — additive new state `kind: "session" | "single_use"` with same binding match logic for grants minted under a session.
- **Template registry.** [src/daemon/templates/registry.ts](../../src/daemon/templates/registry.ts), built-in templates ([src/daemon/templates/builtin/](../../src/daemon/templates/builtin/)). Untouched except a new `--help`-snapshot check (deferred to Phase 1b; out of scope here).
- **HTTP API surface.** `/v1/secrets/*`, `/v1/templates/*`, `/v1/browser/*`, `/v1/blind/*`, `/v1/health`, `/v1/status`, `/v1/unlock`. All preserved. New endpoints added; no existing endpoint changes shape.
- **CDP-based commands.** `browser mark`, `inject-submit`, `reveal-capture` — Secret Shuttle's wedge. These stay at the top-level command surface (agents need them).
- **`template run` / `template list`** — also top-level, also the wedge.
- **`agent install <platform>`** — already category-aligned, stays as-is.

### 3.2 What gets renamed / restructured

Per the "aggressive cleanup" decision in brainstorming. Old commands keep working under deprecation warnings for one release, then move to `internal *` namespace. The agent-facing surface only sees the new names.

| Today | After Phase 1 | Notes |
|---|---|---|
| `secret-shuttle generate` | `secret-shuttle secrets set` | Aligns with `op item create` / `doppler secrets set` / `infisical secrets set`. |
| `secret-shuttle list` | `secret-shuttle secrets list` | Aligns with category. |
| `secret-shuttle inspect <ref>` | `secret-shuttle secrets get-ref <ref>` | Returns metadata + ref, **never raw value**. (Distinct from `op read` which returns raw — see §5.2.) |
| `secret-shuttle doctor` | `secret-shuttle status` | Aligns with `doppler me` / industry "status" convention; signal is the same JSON state machine. |
| `secret-shuttle init` (current — thin status wrapper) | `secret-shuttle init` (new — full interactive setup) | Same name, fundamentally different implementation. |
| `secret-shuttle unlock` | Internal — invoked from `init`, hidden from top-level `help`. | Agent never invokes directly; `init` and `status` both surface the unlock prompt automatically. |
| `secret-shuttle blind start/end` | `secret-shuttle internal blind start/end` | Low-level; the agent uses `inject-submit`/`reveal-capture`. |
| `secret-shuttle capture` (V0) | `secret-shuttle internal capture` | Deprecated in favor of `reveal-capture`. |
| `secret-shuttle inject` (V0) | `secret-shuttle internal inject` | Deprecated in favor of `inject-submit`. |
| `secret-shuttle use-as-stdin` | Removed (already gone in README; remove file). | |
| `secret-shuttle migrate` | `secret-shuttle internal migrate` | Power-user only. |
| `secret-shuttle daemon start/stop` | Stays at top level. | The lifecycle is fundamental enough to keep visible. |
| `secret-shuttle compare` | `secret-shuttle internal compare` | Power-user verification path; agents rarely need it. |

### 3.3 What's net-new

| New command | Purpose | Maps to |
|---|---|---|
| `secret-shuttle secrets get-ref <ref>` | Return metadata + fingerprint for a ref. Never raw value. | `op item get` (metadata-only variant) |
| `secret-shuttle secrets delete <ref>` | Soft-delete a vault entry, approval-gated for production. | `doppler secrets delete` |
| `secret-shuttle secrets rotate <ref> --kind <kind>` | Generate new value, mark old as `rotating`, list bindings from audit log, expose a 1-click re-push UI. | No direct category analog — Secret Shuttle differentiation. |
| `secret-shuttle run --env-file=<f> -- <cmd>` | Subshell injection of refs as env vars; resolved via daemon, masked in stdout. | `op run` / `doppler run` |
| `secret-shuttle inject -i tpl -o out` | Template substitution of `ss://` refs into config files. | `op inject` |
| `secret-shuttle help` | List subcommands with one-liners. Progressive disclosure entry point. | Standard. |
| `secret-shuttle internal *` | Namespace for power-user / deprecated commands. | New convention. |

Plus net-new daemon work:
- `POST /v1/run/resolve` — given a list of refs, return resolved env vars to the daemon-spawned child (the daemon spawns the child; the CLI is a thin client). Never returns plaintext to the CLI.
- `POST /v1/inject/render` — given a template string with `ss://` refs and an output path, daemon writes the rendered file with mode 0600. CLI never sees plaintext.
- `POST /v1/approvals/session` — mint a session-scoped approval (TTL, binding pattern), returns a session id consumable by subsequent operations.

### 3.4 Cross-cutting changes

- All commands gain a `--json` flag (default-on when `!process.stdout.isTTY` or env `SECRET_SHUTTLE_JSON=1`; human-readable when interactive TTY). Aligns with `gh` and Sol.
- `errorToJson` ([src/shared/errors.ts](../../src/shared/errors.ts)) extended to emit `{ error, message, hint, code }` shape. Backward-compatible: old consumers of `{ ok: false, error: { code, message } }` get the same fields plus the new `hint` and a top-level `code` mirror.
- Exit code policy formalized: `0`/`1`/`2`/`3`/`4`/`5` per Sol. Today there's only `1` and exit-code-from-`ShuttleError` ([src/cli/index.ts:57](../../src/cli/index.ts)); existing error codes get mapped to the new exit code policy.
- `--help` for every command rewritten with copy-pasteable examples in epilog (commander's `addHelpText('after', ...)`).
- `SKILL.md` rewritten as narrative + worked examples (~40 lines target, down from 139).
- README install section leads with `npx secret-shuttle init`.

## 4. The new CLI surface (full enumeration)

This is the agent-facing menu after Phase 1. Power-user / internal commands omitted from `--help` but still accessible via `secret-shuttle internal *`.

### 4.1 Setup & status

```
secret-shuttle init                          # interactive: keychain unlock, vault create, agent skill install
secret-shuttle status [--json]               # daemon + vault + browser + policy health, with `next_action`
secret-shuttle daemon start|stop|restart     # lifecycle (keep visible — fundamental)
```

### 4.2 Vault primitives

```
secret-shuttle secrets list [--env <e>] [--source <s>] [--json]
secret-shuttle secrets get-ref <ref> [--json]
secret-shuttle secrets set <name> --env <e> [--kind random_32_bytes|paste] [--source <s>] [--allow-domain <d>...]
secret-shuttle secrets delete <ref>          # soft-delete; production gated by approval
secret-shuttle secrets rotate <ref> --kind <kind>  # generate new, mark old rotating, surface re-push UI
```

### 4.3 Process integration (NEW)

```
secret-shuttle run --env-file=<file> -- <command> [args...]
                                             # resolve ss:// refs from env file, spawn child with env
                                             # mask resolved values in child stdout/stderr (best-effort)
secret-shuttle inject -i <template> -o <out> # render ss:// refs in template to output file (0600)
secret-shuttle inject -i <template>          # same, but to stdout (with warning)
```

### 4.4 Provider integration (Secret Shuttle's wedge)

```
secret-shuttle template list [--json]
secret-shuttle template run <id> --ref <ref> --param k=v ...
secret-shuttle browser mark focused --as <label>
secret-shuttle browser mark pick --as <label>
secret-shuttle browser marks [--json]
secret-shuttle reveal-capture --name <n> --env <e> --source <s> --reveal-handle <h> ...
secret-shuttle inject-submit --ref <ref> --field-handle <h> --submit-handle <h> ...
```

### 4.5 Agent ergonomics

```
secret-shuttle agent install claude|codex|cursor|copilot
secret-shuttle agent print-skill-url
secret-shuttle help                          # progressive disclosure entry
secret-shuttle help <command>                # equivalent to <command> --help
```

### 4.6 Internal / power-user (hidden from default --help)

```
secret-shuttle internal blind start|end
secret-shuttle internal capture              # V0 path
secret-shuttle internal inject               # V0 path
secret-shuttle internal compare
secret-shuttle internal migrate
secret-shuttle internal unlock               # promoted from top-level
secret-shuttle internal session create       # programmatic session creation (most users use approval-UI checkbox)
secret-shuttle internal session list
secret-shuttle internal session revoke <id>
```

Note on sessions: the natural path is the **approval-UI checkbox** that offers "approve this op and similar for 15 minutes" during the first qualifying approval (§5.7). The `internal session create` command exists for orchestration scripts and the walkthrough in §6.1 — it's not the typical agent path.

## 5. Component design

### 5.1 `init` — first-run setup

Replaces today's thin status wrapper. New behavior:

1. **Detect daemon state.** If not running, `daemon start`.
2. **Vault check.** If `~/.secret-shuttle/vault.json.enc` doesn't exist → create new vault.
3. **Master key storage.** OS keychain integration:
   - macOS: `security` CLI (deferred Touch ID native binding to Phase 2; for now, Keychain auto-unlock — daemon reads key at startup. Trade-off documented: no per-call biometric.)
   - Linux: `secret-tool` (libsecret).
   - Windows: `wincred` via PowerShell shim.
   - Fallback: passphrase prompt in the existing unlock UI window. User can opt out of keychain via `--no-keychain`.
4. **Agent skill install.** Detect `.claude/`, `.cursor/`, `AGENTS.md`, `.github/copilot-instructions.md` in CWD; install skill into each found. Skip if not in a project root.
5. **Output.** JSON shape with `next_action`. Human mode prints a 4-line summary.

Idempotency: re-running `init` is safe. If vault exists and is unlocked, `init` reports state and offers `--reset` (which prompts for confirmation).

New file: [src/cli/commands/init.ts](../../src/cli/commands/init.ts) — full rewrite.
New file: [src/vault/keychain-store.ts](../../src/vault/keychain-store.ts) — OS keyring abstraction with per-platform implementations.
New daemon endpoint: `POST /v1/keychain/unlock` — accepts no body, daemon reads key from keychain. Bound by an `init`-issued one-shot setup token, not the normal bearer (because the bearer doesn't exist yet at first init).

### 5.2 `secrets` group

Subcommands: `list`, `get-ref`, `set`, `delete`, `rotate`. All accept `--json`. All return structured errors.

**`secrets get-ref <ref>`** distinction from `op read <op-ref>`: `op read` returns the raw value. Secret Shuttle's `secrets get-ref` returns **only** metadata, fingerprint, allowed domains, allowed actions. The raw value is never available via this command. The promise of "agent never sees secrets" is enforced at the CLI surface, not by convention.

If an agent needs the raw value for `run`, it must go through `secret-shuttle run`, which resolves into a daemon-spawned child — the CLI process itself still never sees the bytes.

**`secrets set`** — two modes:
- `--kind random_32_bytes` / `random_24_chars` / etc. → daemon generates, never returns raw.
- `--kind paste` → daemon opens an input window (same approval UI infra) for the human to paste. The CLI never receives the bytes. The agent never sees them.

**`secrets delete <ref>`** — soft-delete (audit trail preserved). Production-gated by approval.

**`secrets rotate <ref>`** — atomic-feeling rotation:
1. Generate new value via `secrets set` semantics.
2. Mark old entry as `rotating`, store binding to new.
3. Daemon reads audit log for past destinations.
4. Returns a `rotation_plan` JSON with destinations + suggested `template run` commands.
5. Agent (or human) executes the re-push commands; pre-approved session covers them.
6. After all re-pushes succeed, agent calls `secrets delete <old-ref>` (production-gated).

New daemon endpoint: `POST /v1/secrets/rotate` — handles steps 1–3, returns plan for steps 4–6.

### 5.3 `run --env-file=<f> -- <cmd>`

Subshell injection. The killer category-standard feature.

**Env file format** (matches `op` for ergonomics):
```
STRIPE_KEY=ss://stripe/prod/STRIPE_KEY
DATABASE_URL=ss://local/prod/DATABASE_URL
SOME_OTHER=plain-value-passthrough  # non-ss:// values pass through unchanged
```

**Flow:**
1. CLI parses env file, identifies `ss://` refs.
2. CLI sends `POST /v1/run/resolve` with refs + the command + argv to daemon.
3. Daemon checks approval for each ref (single approval window listing all refs + the command + env vars).
4. Daemon spawns the child process directly (not the CLI) with resolved env vars in the env block. Child's stdin inherits from CLI's stdin; stdout/stderr are masked by the daemon and piped back through the CLI.
5. On child exit, daemon reports exit code; CLI exits with the same code.

**Why daemon spawns, not CLI:**
- Keeps the resolved plaintext out of the CLI process address space.
- Daemon can mask stdout/stderr before the bytes ever reach the CLI (which the agent might be capturing).
- Aligns with the existing template runner pattern ([src/daemon/templates/run.ts](../../src/daemon/templates/run.ts)) — proven safe-spawn infrastructure.

**Masking:** best-effort string replacement of resolved values in child stdout/stderr before relay. Matches `op run` masking. Documented as defense-in-depth, not a security guarantee — child can always exfiltrate via network.

**Approval:** one approval per `run` invocation, listing every ref and the command being run. Pre-approved session can cover repeated invocations of the same command + ref set.

New CLI file: [src/cli/commands/run.ts](../../src/cli/commands/run.ts).
New daemon route: [src/daemon/api/routes/run.ts](../../src/daemon/api/routes/run.ts).
New module: [src/daemon/run/spawner.ts](../../src/daemon/run/spawner.ts) — reuses `safeExecutable` + `buildChildEnv` patterns from templates.

### 5.4 `inject -i <template> -o <out>`

Template substitution. The `op inject` analog.

**Template format:**
```yaml
# config.yml.tpl
database:
  username: ss://local/prod/DATABASE_USER
  password: ss://local/prod/DATABASE_PASS
api:
  stripe: ss://stripe/prod/STRIPE_KEY
```

**Flow:**
1. CLI reads template file.
2. CLI sends `POST /v1/inject/render` with template content + output path.
3. Daemon resolves refs (approval-gated), writes rendered file to output path with mode 0600.
4. CLI never sees rendered content.
5. CLI prints summary of refs resolved + output path.

`-o -` writes to stdout (warning: bytes pass through CLI). Default `-o <path>` is daemon-direct write.

Output path security: daemon refuses to write outside the user's $HOME (path traversal check). Path is canonicalized.

New CLI file: [src/cli/commands/inject.ts](../../src/cli/commands/inject.ts) — replaces today's CDP-inject command at this name (which moves to `internal inject`).
New daemon route: [src/daemon/api/routes/inject.ts](../../src/daemon/api/routes/inject.ts).

### 5.5 `status` — rename of `doctor`

Same JSON shape as today's `doctor --json`, with these additions per the Sol/Memori convention:

```json
{
  "ready": false,
  "next_action": "secret-shuttle init",
  "daemon": { "running": true, "pid": 12345 },
  "vault": { "exists": true, "unlocked": false, "keychain_available": true },
  "browser": { "started": false, "proxy_active": false },
  "policy": { "warnings": [] }
}
```

`ready: true` only when daemon + vault + (browser if it was ever started) are all green. `next_action` is the literal command the agent should run to reach `ready: true`.

`doctor` aliased to `status` for one release with a deprecation warning, then `internal status` (the verbose text mode the human uses).

New: [src/cli/commands/status.ts](../../src/cli/commands/status.ts).
Updated: daemon `/v1/status` endpoint emits the new shape (additive — old fields preserved).

### 5.6 Structured errors

Single source-of-truth shape:

```typescript
type StructuredError = {
  ok: false;
  error: string;       // machine-readable code, e.g. "daemon_not_running"
  message: string;     // human-readable
  hint: string | null; // literal command to recover, or null if human-required
  code: number;        // exit code (0/1/2/3/4/5)
};
```

[src/shared/errors.ts](../../src/shared/errors.ts) extends `ShuttleError` and `errorToJson` to emit this shape. Backward compatibility: today's `{ ok: false, error: { code, message } }` keeps working — same fields plus the new `hint` and top-level `code`.

**Exit code mapping** (formalized):
- `0`: success
- `1`: transient/retryable (network blip, daemon temporarily unavailable)
- `2`: usage error (bad argv, missing required flag)
- `3`: not found (ref doesn't exist, template not found)
- `4`: permission (approval denied, domain not allowed, vault locked)
- `5`: conflict (ref already exists, secret rotating)

Every existing `ShuttleError` gets reviewed and assigned an exit code. List of codes maintained in [src/shared/error-codes.ts](../../src/shared/error-codes.ts) (new file).

Audit task in plan: walk every `throw new ShuttleError(...)` call site and verify the code + hint are correct.

### 5.7 Pre-approved sessions

This is where the multi-secret "feels like magic" actually lives.

**Concept:** human approves a *pattern* once; daemon mints single-use grants matching that pattern for up to N minutes.

**Pattern shape:**
```typescript
type SessionPattern = {
  actions: ("inject-submit" | "reveal-capture" | "template-run" | "secrets-set")[];
  ref_glob: string;          // e.g. "ss://stripe/prod/*"
  destination_domains: string[];  // exact-by-default; e.g. ["vercel.com", "github.com"]
  template_ids?: string[];   // optional restriction
  ttl_ms: number;            // max 15 min
  max_uses?: number;         // optional cap
};
```

**Flow:**
1. Agent calls `POST /v1/approvals/session` with a proposed pattern.
2. Daemon opens approval UI showing: "For the next 15 minutes, automatically approve operations matching this pattern: ..." with the full pattern in plain language.
3. Human approves (or declines) once.
4. Daemon mints a `session_id`.
5. Subsequent agent calls (e.g., 8 `template run` invocations) pass `--session <id>` or `Session: <id>` header.
6. For each call, daemon checks: (a) operation matches pattern, (b) session not expired, (c) max_uses not reached. If all pass → mint a single-use grant under the hood, consume it, execute.
7. Each underlying execution still gets its own audit entry (so audit trail shows 8 distinct operations, not "1 session").

**Why this is safer than it looks:** every individual operation still gets a single-use binding internally; the pattern is just the *creation* shortcut. If the pattern is wrong (e.g., agent tries an op outside the glob), it falls back to a fresh per-op approval window. The human is never bypassed for anything they didn't explicitly approve the *shape* of.

**UI:** approval window for session shows the full pattern, the expected operations, and an explicit "this approves up to N operations matching this shape for N minutes" banner. Session creation is its own approval — distinct from the per-op approval style today.

New module: [src/daemon/approvals/session.ts](../../src/daemon/approvals/session.ts).
Updated: [src/daemon/approvals/store.ts](../../src/daemon/approvals/store.ts) gains a `findOrMintFromSession()` method.
Updated: every approval-gated route checks for a `Session` header and delegates to `findOrMintFromSession` before the existing single-use flow.
Updated: [src/daemon/approvals/ui.html](../../src/daemon/approvals/ui.html) — new layout for session approvals.

**Threat model addition:** a hostile or buggy agent that mints a session pattern wider than intended is bounded by the human's approval; the human can read the full pattern before approving. If the human approves a too-wide pattern, the failure mode is "operations the human didn't anticipate get auto-approved" — but only within the pattern. No expansion of capabilities beyond what was visible at approval time.

### 5.8 Help text design

Two-level disclosure mirroring Anthropic's Agent Skills convention.

**Level 1: `secret-shuttle help`** — list every command with a one-line description. ~25 lines total.

```
secret-shuttle — Let AI agents use secrets without seeing them.

Setup:
  init                        Interactive first-run setup
  status                      Daemon, vault, and browser health
  daemon start|stop|restart   Lifecycle

Secrets:
  secrets list                List stored refs (metadata only)
  secrets get-ref <ref>       Show metadata for a ref
  secrets set <name>          Store a new secret (generated or pasted)
  secrets delete <ref>        Soft-delete a secret
  secrets rotate <ref>        Rotate a secret across its destinations

Process integration:
  run --env-file=<f> -- <cmd> Run command with secrets in env (subshell)
  inject -i <tpl> -o <out>    Render template with secret refs

Provider integration:
  template list / template run <id>           Vetted CLI integrations
  browser mark / reveal-capture / inject-submit  Browser-mediated flows

Agent:
  agent install claude|codex|cursor|copilot   Install operating manual
  agent print-skill-url                       Print remote skill URL
  help [command]                              This page or per-command details

For per-command help: secret-shuttle <command> --help
```

**Level 2: `secret-shuttle <command> --help`** — full flag reference + copy-pasteable example in epilog. Example for `secrets set`:

```
Usage: secret-shuttle secrets set <name> [options]

Store a new secret in the vault. Returns a ref (ss://source/env/name); the value
is never returned to the caller.

Options:
  --env <env>              Environment (e.g. production, preview, local). Required.
  --kind <kind>            Generation kind: random_32_bytes, random_24_chars, paste. Default: paste.
  --source <source>        Source label (e.g. stripe, supabase, local). Default: local.
  --allow-domain <domain>  Domain allow-list for inject. Repeatable. Required for production refs.
  --json                   JSON output (default when not TTY).

Examples:
  # Generate a random 32-byte secret for production:
  secret-shuttle secrets set INTERNAL_CRON_SECRET --env production --kind random_32_bytes --allow-domain vercel.com

  # Paste a secret from your clipboard (opens a paste window):
  secret-shuttle secrets set STRIPE_KEY --env production --kind paste --source stripe --allow-domain vercel.com

Exit codes:
  0  Success
  2  Usage error (missing flag, invalid kind)
  4  Permission (approval denied)
  5  Conflict (ref already exists; use `secrets rotate` instead)
```

Every command gets this shape. The plan will enumerate them.

### 5.9 `SKILL.md` rewrite

Target: ~40 lines, narrative + worked examples.

Structure:

1. **Why this exists** (2 sentences). "Your own browser/shell tools can leak secrets into transcripts and logs. Secret Shuttle is a local daemon that holds secrets and executes operations on your behalf so you never see the raw bytes."
2. **Three things you actually do** (one paragraph each):
   - Set/manage secrets: `secrets set/list/get-ref/delete/rotate`
   - Push secrets to providers: `template run` (vetted CLIs) or `inject-submit` / `reveal-capture` (browser).
   - Use secrets in your own process: `run --env-file=...`.
3. **Worked example** (one): "Set up Stripe webhook in Vercel production." Shows the 3 commands and the single pre-approved session.
4. **Forbidden during blind mode** (5 lines): no screenshots, no DOM reads, etc.
5. **Error recovery** (one paragraph): "Every error has a `hint` field. Run the hinted command and try again. If `hint` is null, the human has to intervene — surface the message to them."

[examples/stripe-to-vercel/walkthrough.md](../../examples/stripe-to-vercel/walkthrough.md) gets rewritten to match: uses `reveal-capture` + `template run` (new API), uses pre-approved session, ends with verification via non-secret signals.

## 6. Data flow walkthroughs

### 6.1 The "set up Stripe in Vercel prod + GitHub Actions" flow

Today: 4 commands, 4 approval clicks. After Phase 1: 4 commands, **1** approval click (session).

```bash
# Agent runs these in sequence:
secret-shuttle browser mark pick --as reveal-button
secret-shuttle browser mark pick --as secret-field
secret-shuttle browser mark pick --as hide-button

# Agent then opens a session (one approval window covering the whole batch):
secret-shuttle internal session create \
  --actions reveal-capture,template-run \
  --ref-glob 'ss://stripe/prod/*' \
  --destination-domains vercel.com,github.com \
  --ttl 15m
# → human approves the SHAPE in one click → session_id returned

# All subsequent ops auto-approved if they match:
secret-shuttle reveal-capture \
  --name STRIPE_WEBHOOK_SECRET --env production --source stripe \
  --reveal-handle reveal-button \
  --field-handle secret-field \
  --hide-handle hide-button \
  --allow-domain vercel.com,github.com \
  --session <id>

secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production \
  --session <id>

secret-shuttle template run github-actions-secret-set \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production \
  --session <id>
```

Note: `session create` is on the `internal` namespace — it's a power-user / agent-orchestration tool. Most agents won't manually create sessions; instead, the approval UI for the *first* qualifying op will offer "approve this and similar ops for 15 minutes" as a checkbox. Sessions are then transparently created from the UI.

### 6.2 The "run my app with secrets" flow

```bash
# .env.refs in the project (committable):
STRIPE_KEY=ss://stripe/prod/STRIPE_KEY
DATABASE_URL=ss://local/prod/DATABASE_URL
PORT=3000  # plain value, passes through

# Agent or developer runs:
secret-shuttle run --env-file=.env.refs -- npm start
# → daemon resolves STRIPE_KEY and DATABASE_URL, spawns `npm start` with them in env
# → child runs, masked stdout/stderr returns through CLI
# → child exits, secrets vanish
```

One approval per `run` invocation. Repeated runs (`npm start`, `npm test`, etc.) can be batched into a session pattern: `actions=run, ref-glob=ss://local/prod/*, command-prefix=npm`.

## 7. Error handling

Spec'd in §5.6. Implementation steps in plan:

1. Extend `ShuttleError` with `hint` and `exitCode`.
2. Audit every `throw new ShuttleError` call site (~50 occurrences); add hint where actionable, set exit code.
3. Create [src/shared/error-codes.ts](../../src/shared/error-codes.ts) — central registry.
4. Update CLI error printer ([src/cli/index.ts:55–58](../../src/cli/index.ts)) to emit the new shape, set exit code.
5. Add tests for representative error paths: daemon-not-running, vault-locked, ref-not-found, domain-not-allowed, approval-denied.

## 8. Migration / deprecation

### 8.1 0.1.1 → 0.2.0 migration

Existing users have a vault. After upgrade:
- Old commands (`generate`, `list`, `inspect`, `doctor`, `capture`, `inject`) keep working for one release. Each prints to stderr: `[deprecated] use 'secret-shuttle secrets set' instead`.
- `--json` output of old commands is unchanged (backward compatible).
- Vault format unchanged.
- Daemon socket file format unchanged.

After 0.2.0 release ships, 0.3.0 moves deprecated commands to `internal *`. Documented in CHANGELOG.

### 8.2 Internal namespace mechanics

`internal` is a subcommand group. `secret-shuttle internal --help` lists power-user commands. The top-level `--help` does not show `internal`. `secret-shuttle internal list-deprecated` lists every command that moved and what to use instead.

This means existing scripts (CI, makefiles, etc.) that call `secret-shuttle generate` will work for one release with a stderr warning, then fail (helpfully) in the next release. The error message includes a `hint: "secret-shuttle secrets set ..."`.

### 8.3 npm publish

Package name `secret-shuttle` is already in `package.json`. Verify availability on npm registry. If taken, fall back to scoped `@secret-shuttle/cli` (less ideal — agents don't know to look for scoped). README updated to lead with `npx secret-shuttle init`.

Publish gates: typecheck pass, tests pass, `npm run check-pack` pass. Version bump to 0.2.0. Tag pushed.

## 9. Testing strategy

### 9.1 Unit tests

- New: `init.test.ts` — keychain detection (mocked), agent install detection, idempotency.
- New: `secrets.test.ts` — each subcommand (`list`, `get-ref`, `set`, `delete`, `rotate`).
- New: `run.test.ts` — env-file parsing, ref resolution, child spawn, masking.
- New: `inject.test.ts` — template parsing, path canonicalization, output mode.
- New: `status.test.ts` — state machine, next_action correctness per state.
- New: `error-shape.test.ts` — every error code emits correct hint + exit code.
- Updated: every existing test that touches renamed commands (`generate.test.ts` → also test `secrets-set.test.ts`).

### 9.2 Integration tests

Per existing pattern ([src/e2e/stripe-to-vercel.test.ts](../../src/e2e/stripe-to-vercel.test.ts)):

- `e2e/run-injection.test.ts` — `run --env-file -- node -e ...` with stubbed daemon, verify child receives resolved env, CLI never sees plaintext.
- `e2e/inject-render.test.ts` — render a template, verify output file mode 0600, verify CLI never sees rendered content.
- `e2e/session-approval.test.ts` — create session, run 3 matching ops, verify only 1 approval window opened. Run 1 non-matching op, verify a new approval window opens.

### 9.3 Manual verification (gates)

Before releasing 0.2.0:
- Fresh macOS + Linux laptop: `npx secret-shuttle init` succeeds, vault created via keychain, agent skill installed.
- Stripe → Vercel walkthrough using new commands works end-to-end.
- `secret-shuttle help` output is ≤ 30 lines, scannable.
- `SKILL.md` is ≤ 50 lines.
- Every command's `--help` has at least one example.

## 10. What's explicitly NOT in this spec

- **MCP server.** Research is unanimous: CLI first, MCP optional later. Deferred indefinitely; tracked separately.
- **Touch ID native binding.** Phase 1 ships OS-keychain-stored master key with auto-unlock; biometric per-call is Phase 2 (requires native helper).
- **Browser extension for marking.** Phase 2+. `mark focused` / `mark pick` keep their current ergonomics.
- **Team vaults / cloud sync.** V6+ (commercial). Phase 1 stays single-operator.
- **CI mode (pre-signed approval blobs).** Phase 3, separate spec.
- **Template stability auto-check ([P2b] gate replacement).** Phase 1b — small enough to slip into the same release if time permits, but not required.
- **Absence-proof hooks for postMessage/sendBeacon/fetch.** Phase 4 hardening.
- **Per-agent identity tokens.** Phase 4.
- **`.secret-shuttle.json` project config.** Deferred — research showed the category convention is a tiny machine-managed file. We can add it later when there's a concrete need (multi-environment defaulting, etc.). Phase 1 doesn't need it.

## 11. Phase 1 deliverables checklist

This is the contract for the implementation plan.

**CLI commands (new or rewritten):**
- [ ] `secret-shuttle init` (rewrite — interactive setup, keychain, agent install)
- [ ] `secret-shuttle status` (rename + shape extension from `doctor`)
- [ ] `secret-shuttle secrets list` (rename from `list`)
- [ ] `secret-shuttle secrets get-ref` (rename from `inspect`)
- [ ] `secret-shuttle secrets set` (rename from `generate`)
- [ ] `secret-shuttle secrets delete` (new)
- [ ] `secret-shuttle secrets rotate` (new)
- [ ] `secret-shuttle run` (new)
- [ ] `secret-shuttle inject` (new — replaces old `inject` which moves to `internal inject`)
- [ ] `secret-shuttle help [command]` (new — progressive disclosure)
- [ ] `secret-shuttle internal *` namespace + commands moved into it

**Daemon endpoints (new):**
- [ ] `POST /v1/keychain/unlock`
- [ ] `POST /v1/run/resolve` + spawner
- [ ] `POST /v1/inject/render`
- [ ] `POST /v1/approvals/session`
- [ ] `POST /v1/secrets/delete`
- [ ] `POST /v1/secrets/rotate`

**Approval UI:**
- [ ] Session pattern approval view
- [ ] Per-op approval view shows "approve this + similar for 15 min" checkbox (mints session)

**Cross-cutting:**
- [ ] `ShuttleError` extended with `hint` + `exitCode`
- [ ] [src/shared/error-codes.ts](../../src/shared/error-codes.ts) created
- [ ] Every error site audited for hint + exit code
- [ ] CLI error printer emits new shape
- [ ] OS keychain abstraction ([src/vault/keychain-store.ts](../../src/vault/keychain-store.ts)) with mac/linux/win adapters

**Docs:**
- [ ] [skills/secret-shuttle/SKILL.md](../../skills/secret-shuttle/SKILL.md) rewritten
- [ ] [examples/stripe-to-vercel/walkthrough.md](../../examples/stripe-to-vercel/walkthrough.md) rewritten for V2 API + session
- [ ] [README.md](../../README.md) install section leads with `npx`
- [ ] [docs/cli-reference.md](../../docs/cli-reference.md) regenerated
- [ ] Every command's `--help` has example in epilog

**Distribution:**
- [ ] Verify `secret-shuttle` available on npm
- [ ] `npm publish` 0.2.0
- [ ] Tagged release on GitHub

**Tests:**
- [ ] Unit tests for every new command
- [ ] Integration test for `run --env-file -- ...`
- [ ] Integration test for `inject -i -o`
- [ ] Integration test for session approval (3 matching, 1 non-matching)
- [ ] E2E walkthrough using new API

**Verification gates (manual):**
- [ ] Fresh macOS install: `npx secret-shuttle init` works
- [ ] Fresh Linux install: same
- [ ] Stripe → Vercel walkthrough end-to-end with one approval click
- [ ] `help` output ≤ 30 lines
- [ ] `SKILL.md` ≤ 50 lines

## 12. Open questions deferred to plan-writing

These are implementation-level, not architecture-level. The plan will resolve them:

1. Exact env-file format for `run` (strict `KEY=ss://...` only, or allow shell-style expansion?).
2. `secrets set --kind paste` — does the paste window allow the human to confirm the value before submission? (Avoid mistypes — but echoing the value to the approval UI may be exactly what we're trying to prevent.)
3. Session creation: who initiates — the agent or the daemon (offered via approval UI checkbox)? Both probably; details in plan.
4. Internal namespace: is `internal` a separate Commander program or just a hidden command group? Implementation detail.
5. Deprecation warning format: stderr line, or JSON `warning` field in output? Probably both.

---

End of design spec. Plan-writing starts next.
