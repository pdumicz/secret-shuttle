# Burst 5 — Magic Polish

**Date:** 2026-05-27

**Goal:** Close the seven UX gaps that separate Secret Shuttle's current state from "agents reach for this tool without being told" — without touching the security boundary. Ship as one coherent ~2-week burst that ends with v0.3.0 published to npm.

**Audience:** Vibe coders and AI coding agents. NOT enterprise-audit (Burst 4's 5q follow-up covers that).

**Tech stack:** TypeScript strict ESM, Node 20+, Commander for CLI, existing daemon HTTP API on 127.0.0.1, existing batch executor (Plan 5g) + hub SSE infra (Plan 4b) + pre-approved session store (Plan 4a).

---

## §0 — Cross-section context

### What changes vs. what does not

**Unchanged (hard constraints):**
- Trust boundary: daemon owns secrets, agent never sees plaintext, hub UI is the only human surface.
- Approval semantics: every production-touching operation requires explicit human approval (batched or single).
- Audit trail completeness: every action remains attributable via `actor_agent_id` (Burst 4 §1).
- Wire format `error_code` registry: additions only, no renames or removals.
- All existing security-critical primitives (`requireApprovals`, `bootstrapAuthority`, owner-enforced consumption, blind-mode discipline) are unchanged.

**Changed (intentional 0.x breakers — no production users yet):**
- `bootstrap` verb is **hard-removed**, replaced by `provision`. Running `secret-shuttle bootstrap` exits with a `command_renamed` error pointing at `provision`.
- Deprecated shims (`list`, `inspect`, `generate`, `doctor`) are **hard-removed** per the v0.3.0 schedule already noted in CHANGELOG. Their replacements (`secrets list`, `secrets get-ref`, `secrets set`, `status`) are unchanged.
- Pre-approved session TTL hard cap raised from 15 min to 60 min, because the new affordance asks the user at the moment of consent rather than via a hidden CLI.

### Unifying theme

The agent should be able to do a complete provisioning loop using only what is above the fold of a ~60-line SKILL.md, without writing a yml by hand. Every gap closed in this burst (Items A–G below) is measured against that commitment.

### Threat model — unchanged from Burst 4

Per-agent tokens still provide attribution + hygiene, not hard isolation. OS-account boundary remains the real trust boundary. `provision --infer` reads project files but never reads or writes secret values; the inference layer is purely a CLI convenience. The hub session UI affordance creates a session under the same `SessionGrant` primitive as Plan 4a — no new approval pathway, no new authority, just a different consent surface.

### Items map

| Item | Section | Surface |
|---|---|---|
| A | §1 | `provision --infer` reads `.env.example` + framework signals → generated yml |
| B | §1 | `provision --secret X --from Y --to Z` single-intent shortcut |
| C | §2 | Hub batch-approval UI gains "approve this shape for N minutes" affordance |
| D | §3 | SKILL.md restructured into layered (quickstart + reference) format |
| E | §4 | `secret-shuttle audit --since` agent-facing summary verb |
| F | §4 | README + `--help` no-args discoverability tweaks |
| G | §4 | `next_action` on bootstrap-step-failed errors offers the resume command |

---

## §1 — `provision` (Items A + B)

### Verb shape

`provision` is the single verb for "make these secrets exist in the vault and at the named destinations." It replaces today's `bootstrap` and absorbs the un-built `provision`-shortcut idea from the original 4-phase plan. The internal pipeline (batch executor, approval flow, capture coordinator, audit emission) is unchanged — `provision` is a thin front-end that decides input shape from flags.

```
# Modes
secret-shuttle provision --infer [--dry-run] [--force]
secret-shuttle provision --yml secret-shuttle.yml
secret-shuttle provision --secret <NAME> --from <kind> [--url <u>] --to <dest>[,<dest>...]
secret-shuttle provision --continue --batch <id> --approval-id <id> [--approval-id <id>...]
secret-shuttle provision --list
secret-shuttle provision --abandon --batch <id>
```

**Flag conflict resolution:** `--infer`, `--yml`, `--secret`, `--continue`, `--list`, `--abandon` are mutually exclusive (the input-shape selectors). Multiple selectors → `bad_request` with the conflicting flags named in `message`. Single selector required (or default to `--yml secret-shuttle.yml` if file exists; otherwise error).

**Return shape:** unchanged from today's `bootstrap`. Every mode produces a batch (single-secret modes produce a 1-step batch), every batch returns `approval_required` with `batch_id` + `details.approvals[*]`. `--continue` consumes and executes.

### Single-secret mode (Item B)

```
secret-shuttle provision \
  --secret STRIPE_WEBHOOK_SECRET \
  --from capture --url https://dashboard.stripe.com/webhooks \
  --to vercel:production,github-actions:owner/repo
```

Equivalent to writing a 1-secret yml and running today's bootstrap. Internally: yml is synthesized in-memory, fed to the same plan/diff/approval/execute pipeline. No new approval primitive, no new audit shape. The diff is CLI surface only.

**Source kinds accepted:** `random_32_bytes`, `random_64_bytes`, `existing` (must supply `--ref ss://...`), `capture` (must supply `--url`). Same validation rules as yml-mode (strict URL validation per Burst 4 §3).

### Inference mode (Item A)

```
secret-shuttle provision --infer
```

**Reads:**
1. `.env.example` (required input — secret names; values ignored if present).
2. Framework signals for destination defaults:
   - `vercel.json` exists → default destinations include `vercel:production`
   - `wrangler.toml` exists → default destinations include `cloudflare:production`
   - `.github/workflows/` directory exists → default destinations include `github-actions:<owner/repo>` where `<owner/repo>` is parsed from `git config --get remote.origin.url` if available, else left as `github-actions:OWNER/REPO` placeholder with TODO comment

**If `.env.example` is missing:** error `infer_no_env_example` with `next_action: null` and message guiding the user to create one listing their secret names. Future v0.3.x may fall back to `.env` filenames (names only, never values) — out of scope for this burst.

**Inference rules (literal, no LLM):**

| Pattern (case-insensitive match on the secret name) | Source kind | Capture URL (if applicable) |
|---|---|---|
| `STRIPE_*WEBHOOK*` | capture | `https://dashboard.stripe.com/webhooks` |
| `STRIPE_*` (other) | capture | `https://dashboard.stripe.com/apikeys` |
| `SUPABASE_*` | capture | `https://supabase.com/dashboard/project/_/settings/api` |
| `OPENAI_API_KEY` | capture | `https://platform.openai.com/api-keys` |
| `ANTHROPIC_API_KEY` | capture | `https://console.anthropic.com/settings/keys` |
| `CLERK_*` | capture | `https://dashboard.clerk.com` |
| `*_SECRET` or `*_TOKEN` (no provider prefix) | `random_32_bytes` | — |
| `DATABASE_URL` / `POSTGRES_URL` / `MYSQL_URL` | `existing` (placeholder ref) | — |
| Any other name | `unknown` | — (yml comment asks user to fill in) |

Rule table lives in `src/cli/provision/infer-rules.ts` as a flat data structure. Adding a row in future is a one-line change.

**Output behavior:**
- Default: write generated yml to `./secret-shuttle.yml`. If file already exists → error `infer_yml_exists` with `next_action` suggesting `--force` to overwrite or `--dry-run` to stdout-only.
- `--dry-run`: print generated yml to stdout. Do not write file. Do not mint a batch.
- `--force`: overwrite existing `./secret-shuttle.yml`.
- After write (default or `--force`): treat the result as if the user had run `provision --yml secret-shuttle.yml` — mint a batch, return `approval_required`. Agent must show the generated plan to the user before `--continue` (mandated in SKILL.md).

**Generated yml format example:**

```yaml
# Generated by `secret-shuttle provision --infer` on 2026-05-27.
# Review every line. Destinations marked TODO must be filled in before --continue.
version: 1
secrets:
  STRIPE_WEBHOOK_SECRET:
    source: { kind: capture, url: "https://dashboard.stripe.com/webhooks" }
    destinations:
      - vercel:production
      - github-actions:patryk/myproject
  INTERNAL_CRON_SECRET:
    source: { kind: random_32_bytes }
    destinations:
      - vercel:production
  DATABASE_URL:
    source: { kind: existing, ref: "ss://local/prod/DATABASE_URL" }  # TODO: fill in or change source
    destinations:
      - vercel:production
  CUSTOM_FEATURE_FLAG_KEY:
    source: { kind: unknown }  # TODO: change to capture/random_32_bytes/existing
    destinations: []           # TODO: add at least one destination
```

The yml is editable. The generated comment header tells the user (and the agent) what to do.

### Bootstrap removal

- `src/cli/commands/bootstrap.ts` is **deleted**.
- `src/cli/commands/provision.ts` is **new** — owns the verb registration, flag parsing, dispatch to the appropriate mode handler.
- Internal references (`bootstrap_plan`, `bootstrap_step`, `bootstrap_capture_step` audit actions; `bootstrap_*` error codes; `bootstrap-batches/` directory; `bootstrapAuthority` context name) are NOT renamed — they're internal identifiers, not user-facing. Renaming would create churn without benefit, and the audit log naming continues to make sense ("bootstrap" still describes the internal operation accurately).
- New error code: `command_renamed` (exit 2, USAGE). Surfaced by a stub at `src/cli/commands/bootstrap-removed.ts` that registers the `bootstrap` verb just to fail loudly with this code + a `next_action: "secret-shuttle provision <same-flags>"` hint.

### `provision` command surface (CLI help excerpt)

```
$ secret-shuttle provision --help
Provision a project's secrets in one approval.

Modes:
  --infer                Generate a yml from .env.example + framework signals
  --yml <file>           Read an existing secret-shuttle.yml
  --secret <NAME>        Single-secret inline (requires --from, --to)
  --continue --batch ID  Resume an approved batch
  --list                 List in-flight batches
  --abandon --batch ID   Abandon a batch (no longer consumable)

Flags:
  --from <kind>          Source kind (capture, random_32_bytes, random_64_bytes, existing)
  --url <url>            Capture URL (required when --from=capture)
  --ref <ss://...>       Existing ref (required when --from=existing)
  --to <dest[,dest...]>  Destinations (vercel:env, github-actions:owner/repo, ...)
  --approval-id <id>     Approval id (repeatable for multi-approval batches)
  --dry-run              Print plan only (default in --infer; allowed in other modes)
  --force                Overwrite existing yml (--infer only)
  --json                 Machine-readable output (default for non-tty)

Examples:
  secret-shuttle provision --infer
  secret-shuttle provision --secret CRON --from random_32_bytes --to vercel:production
  secret-shuttle provision --yml ./secret-shuttle.yml
  secret-shuttle provision --continue --batch b_abc --approval-id ap_xyz
```

### New / changed error codes

| Code | Exit | Description |
|---|---|---|
| `command_renamed` | 2 (USAGE) | Stub for removed `bootstrap` verb; `next_action` points at `provision`. |
| `infer_no_env_example` | 3 (NOT_FOUND) | `--infer` couldn't find `.env.example`. Hint: create one. |
| `infer_yml_exists` | 5 (CONFLICT) | `./secret-shuttle.yml` already exists. `next_action: "--force"` or `--dry-run`. |
| `provision_mode_conflict` | 2 (USAGE) | Multiple mode-selector flags. `message` names the conflicting flags. |
| `provision_no_mode` | 2 (USAGE) | No mode selector and no `secret-shuttle.yml` to default to. |

All existing `bootstrap_*` error codes are kept verbatim (they describe internal batch operations that didn't change).

### Tests

- `provision.test.ts`: flag parsing matrix (mode conflicts, missing required flags per mode, `--continue` shape).
- `provision-infer.test.ts`: fixture-based `.env.example` files in test dirs, snapshot the generated yml.
- `provision-infer-rules.test.ts`: each rule row exercised in isolation.
- `bootstrap-removed.test.ts`: running `bootstrap` exits 2 with `command_renamed`.
- Existing `bootstrap*.test.ts` files: renamed to `provision-yml.test.ts` etc; assertion targets updated to use `provision`. **No new approval / executor / capture tests** — those primitives are unchanged.

---

## §2 — Pre-approved session UI affordance (Item C)

### Why this is the highest-leverage Phase 2 item

Today: pre-approved sessions exist (Plan 4a) but the only way to create one is `secret-shuttle internal session create` — hidden from agents, requires the agent to compose the pattern correctly. Result: real-world agent flows hit a fresh popup on every operation, even when the human just approved an identical-shape one 30 seconds earlier.

After this burst: when the hub renders any batch approval, the user sees a checkbox offering to extend their consent to matching future operations. One click at consent time. The agent doesn't have to know sessions exist.

### Hub UI change

The batch-approval card in `src/daemon/hub/hub-ui.html` (rendered for any multi-binding approval, including every `provision` batch) gains a footer block:

```
─────────────────────────────────────────────
☐ Also approve any matching shape for the next
  [ 15 min ▾ ] (options: 5 / 15 / 30 / 60)
  Matching shape: same actions on the same refs + destinations.
  You can revoke at any time via:
    secret-shuttle internal session revoke --id <id>
─────────────────────────────────────────────
   [ Approve ]   [ Deny ]
```

If the checkbox is checked at approve-time:
1. The daemon mints the per-op grant(s) as usual (the in-flight batch proceeds).
2. The daemon *additionally* mints a `SessionGrant` via the existing Plan 4a primitive. Pattern is derived from the batch bindings (see "Pattern derivation" below). TTL is the dropdown selection. Owner: same agent that owns the batch.
3. The daemon stores the session as "auto-active for this agent" — see "Daemon-side auto-application" below.

If the checkbox is unchecked: behavior is unchanged from today.

### Pattern derivation

The session pattern is derived from the batch's bindings, restricted to session-eligible actions:

- For each binding in the batch with action ∈ `{template-run, inject-submit, reveal-capture, secrets-set}`:
  - `template-run` → contribute `template_ids: [binding.template_id]` + `ref_pattern: binding.ref`
  - `inject-submit` → contribute `destination_domains: [binding.destination_domain]` + `ref_pattern: binding.ref`
  - `reveal-capture` → contribute `destination_domains: [binding.destination_domain]` + `ref_pattern: binding.planned_ref`
  - `secrets-set` → contribute `destination_domains: ⊆ binding.allowed_domains` + `allowed_actions: ⊆ binding.allowed_actions` + `ref_pattern: binding.planned_ref`
- Bindings with non-session-eligible actions (`bootstrap`, `run`, `run_stdin`, `inject_render`, `secrets-delete`, `secrets-rotate`, `compare`) **do not** contribute. They remain per-op-approval forever.
- If the resulting pattern would be empty (e.g., batch consists entirely of one capture step), the session checkbox **does not render** in the hub UI for that batch. The user simply approves or denies the batch as today.

`ref_pattern` is `prefix*` form per Plan 4a (literal prefix + optional single trailing `*`). For a batch covering `ss://stripe/prod/STRIPE_WEBHOOK_SECRET` and `ss://stripe/prod/STRIPE_PUBLISHABLE`, the inferred pattern is `ss://stripe/prod/*`. For a batch covering one ref, the pattern is that exact ref.

### Daemon-side auto-application

The CLI **does not** need to track `--session <id>`. The daemon resolves automatically:

- `requireApprovals` (today) checks for an `approval_id` in the request, falls through to mint a new one.
- After this change: when no `approval_id` is supplied, `requireApprovals` *first* consults the SessionStore for active session grants owned by the requesting agent that match the binding shape. If a match exists, a per-op grant is minted from the session (existing `mintFromSession` primitive, unchanged) and the operation proceeds without a hub popup.
- If no session matches and the operation requires approval, behavior falls through to the existing per-op approval flow.

This means the agent calling `template run vercel-env-add --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET ...` ten seconds after the user approved a session pattern matching that ref will silently succeed — no hub UI appearance, no `--session` flag, no agent code change.

**Multi-match resolution:** if multiple owned-by-this-agent active sessions match the binding, the daemon picks the most recently approved (`approved_at` DESC, tiebreaker `created_at` DESC). The selected session's `max_uses` is decremented per existing Plan 4a semantics. The audit record includes the session_id consumed.

**Existing `--session <id>` flag:** continues to work as today (Plan 4a). When supplied explicitly, the daemon uses that specific session and does not consult others. When omitted, the daemon performs the auto-match lookup. Explicit `--session <id>` for a session that exists but does not match still falls back to per-op approval (no behavioral change).

### TTL hard cap raise

Plan 4a caps session TTL at 15 min. This burst raises the cap to 60 min, because:
- The previous cap was set when sessions were minted via a hidden CLI flag (low information asymmetry — user might be 0 seconds informed).
- The new affordance presents the dropdown at the moment of consent inside the hub UI, with the matching pattern visible. Information asymmetry is much smaller.
- 15 min is too short for realistic provisioning flows (capturing 3 secrets across 3 dashboards + verifying in destinations often exceeds 15 min).

`SessionStore.create()` validation: TTL_MS_MAX = 60 * 60 * 1000. Any pattern with `ttl_ms` above the cap → `session_ttl_exceeds_cap` (existing error code, threshold updated).

### Status surface

`secret-shuttle status` (and `status --json`) gain a new field:
```
active_sessions: [
  {
    id: "sess_abc",
    pattern_summary: "template-run on ss://stripe/prod/* via vercel-env-add",
    expires_at: "2026-05-27T14:32:00Z",
    minutes_remaining: 12
  }
]
```

The agent reads this to know whether subsequent ops in the same shape will be silent. If the agent observes `active_sessions: []`, it knows the next op will pop a hub approval — useful for "I'm about to ask you to approve" messaging.

### Tests

- `hub-ui-session-affordance.test.ts`: drift-guard text patterns on the new HTML/JS (checkbox + dropdown + submission shape).
- `session-pattern-derivation.test.ts`: pure-function test of pattern derivation from batch bindings, exercising mixed-eligibility batches and the "empty pattern → no affordance" path.
- `require-approvals-session-auto.test.ts`: an active session grant silently satisfies a matching operation; mismatched ops fall through to per-op approval.
- `session-ttl-cap-bump.test.ts`: TTL of exactly 60 min accepted; 60 min + 1 ms rejected with `session_ttl_exceeds_cap`.
- `status-active-sessions.test.ts`: `status --json` includes the new field; empty array when no sessions.

---

## §3 — SKILL.md restructure (Item D)

### Layered structure

Replace the current 163-line single-flow SKILL.md with a layered structure:

```
# secret-shuttle

[2-line tagline: what it is, why it exists.]

## 30-second quickstart
[~15 lines: install, single provision example, what to tell the user before approval, where to read more]

## Core verbs
[~15 lines: provision (with --infer), run, secrets list/get-ref/set, status, init]

## What you see vs never see
[~5 lines: refs in, refs out; approval is the human's job]

## Error recovery
[Table: error_code → next_action. ~15 lines.]

---

## Reference (read on demand)
[Below-the-fold: auth model, owner-enforced consumption, blind-mode discipline, capture flow, pre-approved sessions, low-level surface, recovery edge cases.]
```

**Target:** ≤ 60 lines above the `---`. Below the fold can keep all current detail (~80–100 lines).

### Above-the-fold structure rules

- Every code block is **copy-paste runnable** (no `<placeholder>` that requires substitution before the example works in a test project).
- Every section ends with one **clear directive** (what the agent should do next).
- The error table includes only the top ~8 codes by frequency (the agent jumps below the fold for rarer ones).

### Above-the-fold draft (illustrative — final lives in SKILL.md after the burst)

```markdown
# secret-shuttle

Local-daemon CLI that lets AI coding agents provision and use secrets without ever seeing them.
You work with refs (`ss://stripe/prod/STRIPE_KEY`); the daemon resolves them at the last possible moment.

## 30-second quickstart

```bash
# One-time per project:
npx secret-shuttle init

# Provision an entire project's secrets in one approval:
secret-shuttle provision --infer
# → reviews .env.example, generates a plan, returns approval_required.
# Tell the user: "I'm about to provision <count> secrets to <destinations>. Approve in the popup."
secret-shuttle provision --continue --batch <batch_id> --approval-id <approval_id>

# Use a secret in a child process (value never enters your context):
secret-shuttle run --env-file .env -- npm start

# Push a single secret on demand:
secret-shuttle provision --secret STRIPE_KEY --from capture --url https://dashboard.stripe.com/apikeys --to vercel:production
```

## Core verbs

- `provision` — make secrets exist (inferred from project, from yml, or single inline)
- `run` — spawn a child with refs resolved into env / stdin
- `secrets list | get-ref | set` — discover and manage refs in the vault
- `status` — daemon + vault + browser + session state (`ready: bool` + `next_action`)
- `init` — one-shot setup (daemon, vault, agent skill install)
- `audit --since <duration>` — what was just done (use this to deliver proof to the user)

## What you see vs never see

- **You see**: refs, fingerprints, metadata, batch ids, error codes, audit summaries.
- **You never see**: raw secret values, vault keys, browser CDP URLs, OS credentials.
- **Every prod-touching op requires human approval.** One click per batch via a browser popup the daemon opens.

## Error recovery

Every error JSON includes `error_code` + `next_action`. When `next_action` is a non-null string, run it.

| error_code | next_action | Cause |
|---|---|---|
| `daemon_not_running` | `secret-shuttle daemon start` | Daemon isn't running. |
| `vault_not_initialized` | `secret-shuttle init` | No vault exists. |
| `vault_locked` | `secret-shuttle unlock` | Vault is locked. |
| `approval_required` | null (human required) | Hub popup opens. Wait, or pass `--approval-id` to retry. |
| `bootstrap_step_failed` | `secret-shuttle provision --continue --batch <id>` | Resume from the failed step. |
| `secret_not_found` | null | Use `secrets list` to see what's available. |
| `infer_no_env_example` | null (human required) | Create a `.env.example` listing your secret names. |
| `command_renamed` | (printed in error) | A verb was renamed; the error names the replacement. |

Less common codes are in the daemon's full error table — call `secret-shuttle status --json` to surface the current state machine, or read [docs/cli-reference.md](docs/cli-reference.md) below the fold.

---

## Reference (read when an error or edge case sends you here)

[the rest of the current SKILL.md content lives here — auth model, ownership, blind discipline, etc.]
```

### Removal from below the fold

The following sections of the current SKILL.md are **removed entirely** (covered elsewhere or no longer accurate):
- Mentions of `bootstrap` verb (replaced by `provision`).
- Mentions of `list` / `inspect` / `generate` / `doctor` shims (removed in this burst).

The following sections **move below the fold but are kept**:
- Authentication / per-agent tokens (Burst 4 §1) — kept verbatim, just below the line.
- Owner-enforced consumption (Burst 4) — kept verbatim.
- Blind-mode discipline for captures (Burst 4 §3) — kept verbatim.
- Memory hygiene best-effort note (Burst 4 §2) — kept verbatim.
- Full low-level command list (existing) — kept verbatim.

### Tests

- `skill-md-shape.test.ts`: a drift-guard that asserts (a) above-the-fold is ≤ 60 lines (counting `---` boundary), (b) the quickstart code block uses `provision` not `bootstrap`, (c) the error table includes the top-N codes named in §0 here.
- README is updated to reference the new SKILL.md sections; no separate test.

---

## §4 — Items E + F + G

### Item E — `audit --since` agent-facing summary verb

**Surface:**
```
secret-shuttle audit --since <duration>
secret-shuttle audit --since <duration> --json
secret-shuttle audit --batch <batch-id>
secret-shuttle audit --batch <batch-id> --json
```

`<duration>` accepts `5m`, `30m`, `1h`, `1d`, `7d` (simple `Ns/Nm/Nh/Nd` format, parsed strict).

**Output (text format):**
```
Audit summary — last 5 minutes
─────────────────────────────────────────
batch b_abc (provision_plan, approved 2 min ago by Patryk)
  ✓ STRIPE_WEBHOOK_SECRET  capture → vercel:production, github-actions:patryk/secret-shuttle
  ✓ INTERNAL_CRON_SECRET   random_32_bytes → vercel:production
  ✗ DATABASE_URL           existing (ss://local/prod/DATABASE_URL) → vercel:production
    error: secret_not_found

3 secrets attempted, 2 succeeded, 1 failed.
Recovery: secret-shuttle provision --continue --batch b_abc
```

**Output (JSON format):**
```json
{
  "ok": true,
  "since": "5m",
  "now": "2026-05-27T14:32:00Z",
  "summary": {
    "batches": [
      {
        "id": "b_abc",
        "action": "provision_plan",
        "actor_agent_id": "claude-7f2a1b8c2d4e3f5a",
        "approved_at": "2026-05-27T14:30:01Z",
        "steps": [
          { "ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET", "source_kind": "capture", "destinations": ["vercel:production", "github-actions:patryk/secret-shuttle"], "ok": true },
          { "ref": "ss://local/prod/INTERNAL_CRON_SECRET",   "source_kind": "random_32_bytes", "destinations": ["vercel:production"], "ok": true },
          { "ref": "ss://local/prod/DATABASE_URL",           "source_kind": "existing", "destinations": ["vercel:production"], "ok": false, "error_code": "secret_not_found" }
        ],
        "summary": { "attempted": 3, "succeeded": 2, "failed": 1 },
        "recovery": "secret-shuttle provision --continue --batch b_abc"
      }
    ],
    "individual_ops": []
  }
}
```

`individual_ops` carries any non-batched relevant operations (e.g., a `run` invocation with prod refs). Excludes infrastructure noise (`token mint`, `status check`, `keychain status`).

**Implementation:** read the existing audit log file under `<SHUTTLE_HOME>`. No new audit fields needed. Curate the summary by grouping records on `batch_id` and synthesizing the digest shape. Implementation in `src/cli/commands/audit.ts` + daemon route `POST /v1/audit/summary` (CLI is a thin client; daemon owns the file read).

**Owner scoping:** by default, the agent calling `audit` sees only its own actions (matching the owner-enforcement model from Burst 4). Root can pass `--all` to see every actor.

**Error codes:**
- `audit_window_invalid` (2, USAGE): malformed `--since`.
- `audit_batch_not_found` (3, NOT_FOUND): `--batch <id>` doesn't exist (with owner-scoped non-disclosure: cross-owner returns the same code).

### Item F — Discoverability tweaks

Two cheap docs-only changes:

1. **README header.** Add a callout above the first heading:
   ```markdown
   > **Reading this as an AI coding agent?** Your starting point is [skills/secret-shuttle/SKILL.md](skills/secret-shuttle/SKILL.md) (or the raw URL: `https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md`). The SKILL is your operational manual; this README is for humans.
   ```

2. **`secret-shuttle --help` no-args output.** Today commander prints the verb list. Wrap with a header:
   ```
   secret-shuttle — local-daemon CLI for AI coding agents
   AGENT QUICKSTART: read skills/secret-shuttle/SKILL.md or run `secret-shuttle help`
   
   Commands:
     provision         Make secrets exist in vault + destinations
     run               Spawn child with refs resolved into env/stdin
     secrets           Vault discovery and management
     status            Daemon + vault + browser + session state
     init              First-run setup
     audit             Recent action summary
     ...
   ```

   The `help` command (already exists in v0.2.0 as the progressive-disclosure entry) is updated to mention SKILL.md prominently.

No MCP server, no `npm install` hook, no browser extension — those are out of scope for this burst.

### Item G — Resumable batch hint

The existing batch executor (Plan 5g) lets batches end in `status: "failed_partial"` when one or more steps fail but the batch is still resumable via `--continue`. Today the response includes per-step results but no top-level `next_action` field — the agent has to know that `failed_partial` means "you can retry."

Change: whenever the executor returns a batch state with `status: "failed_partial"` (and the batch has not been abandoned, and at least one step remains incomplete), the wire-level response gains:
```json
{ "next_action": "secret-shuttle provision --continue --batch <batch_id>" }
```

For batches needing a fresh approval (e.g., the original approval expired), `next_action` is omitted and `details.requires_new_approval: true` is set instead (the agent re-runs without `--approval-id`, daemon mints a fresh approval, falls back to the existing `approval_expired` flow).

Implementation: change in `src/daemon/bootstrap/executor.ts` where the final response is built (around the `state.status = "failed_partial"` branch). New test in `provision-resume-hint.test.ts`.

### Tests

- `audit.test.ts`: text format + JSON format snapshot; window parsing; cross-owner non-disclosure.
- `audit-route.test.ts`: daemon route exists, returns owner-scoped subset.
- `bootstrap-resume-hint.test.ts`: a failed step emits `next_action` pointing at `provision --continue`; an abandoned batch does not.
- `cli-help-discoverability.test.ts`: `--help` no-args output includes the AGENT QUICKSTART line.
- `readme-header.test.ts`: README starts with the agent callout block.

---

## §5 — Implementation order & milestones

```
Days 1-3   §1   provision verb + --infer + bootstrap removal     (largest piece, foundation)
Days 4-6   §2   Hub session UI affordance + auto-application
Day  7     §4   audit verb + resume hint                          (end-of-week-1 ship)
Days 8-10  §3   SKILL.md restructure + §4 discoverability tweaks  (done last; reflects shipped verbs)
Days 11-12 —    Dogfood pass on a fresh project with a real agent
Days 13-14 —    CHANGELOG, version bump to v0.3.0, npm publish
```

Each section is a discrete commit set. Sections do not depend on each other for compile, so they can land in any order if priorities shift mid-burst.

**Definition of "ship" for each section:**
- Code merged to `main` with green tests.
- CHANGELOG entry written.
- If the section exposes a new agent-facing verb or flag (§1, §2, §4-E), the SKILL.md update for it lands in §3 — until then, the verb works but isn't documented in SKILL.md (acceptable for an internal milestone, not for v0.3.0 publish).

**Definition of "burst complete":**
- All sections shipped.
- Dogfood pass produces friction notes (saved to `docs/dogfood/2026-05-XX-burst5-notes.md` — not blocking publish; informs the next burst).
- `npm publish` succeeds.
- Demo updated (or explicitly noted as deferred to v0.3.1).

---

## §6 — Test posture (cross-section)

- Every new code path gets unit + route-level tests where applicable (matching existing patterns).
- `--infer` gets fixture-based tests: drop test `.env.example` files in a `__fixtures__/` dir, snapshot generated yml.
- Hub UI changes get text-pattern drift-guard tests (Plan 4b precedent).
- No new e2e tests required — the existing e2e suite covers the underlying primitives. Add one e2e for `provision --infer --dry-run` to catch CLI integration breakage.
- The dogfood pass (days 11-12) is exploratory and not codified as a test.

---

## §7 — Out of scope (deferred to future bursts)

- **MCP server** for direct agent integration (deferred to v0.4+).
- **Browser extension** for inline reveal-capture without dashboard navigation (deferred).
- **`--infer` for `vercel.json` content** (env-var detection beyond just file existence) — deferred. v1 only reads file existence as a destination signal.
- **`--infer` fallback to `.env`** when `.env.example` is missing — deferred to v0.3.1 (filename-only read).
- **`provision --rotate <ref>`** — out of scope. `secrets rotate` remains a separate verb (Phase 3 backlog already names the destination re-push improvement).
- **`provision --import <env-file>`** — out of scope. `secret-shuttle import` remains a separate verb.
- **`provision --export`** / encrypted-blob handoff — out of scope (Phase 3 item).
- **`ci-token issue`** — out of scope (Phase 3 item).
- **Absence-proof CDP hooks for reveal-capture** — out of scope (Phase 4 item).
- **Signed daemon binary** — out of scope (Phase 4 item).
- **Buffer-end-to-end refactor** — out of scope (named Plan 5q).

---

## §8 — Risks

1. **`--infer` rule maintenance.** The 8 rules in §1 will need updates as provider URLs change (e.g., Stripe dashboard reorganizing). Mitigated by keeping rules in a single flat data structure with one-line addability. Long-term: pull from a daemon-side template registry that ships with each release.

2. **Session UI affordance changing security perception.** A user who unchecks the box once and then forgets the box exists next time might feel "the popups got more annoying" — actually they're the same as today. The hub UI should make the checkbox subtle but discoverable; a default-checked state would be wrong (would silently widen consent without explicit user action). Decision: default-unchecked, dropdown defaults to 15 min if user checks the box.

3. **SKILL.md drift.** Above-the-fold and below-the-fold can drift out of sync (e.g., a new error code documented above but not below). Mitigated by the drift-guard test in §3 + a CHANGELOG discipline that every burst updates both halves.

4. **Bootstrap removal hard-break.** Any user (most likely the dev's own scripts) still typing `bootstrap` gets a clear error pointing at `provision`. Migration is a single sed pass.

5. **Dogfood may surface a magic gap I missed.** Accepted. The 2-day buffer at the end is exactly for this; if the gap is small enough, it ships in the same burst. Larger gaps inform v0.3.1.

---

## §9 — Success criteria

This burst is successful if all of the following are true:

- An agent reading the new SKILL.md (above the fold only) can execute a full provision → continue → audit cycle on a fresh test project without errors.
- `secret-shuttle provision --infer` on a representative project (Next.js + Stripe + Supabase) produces a yml the user only needs to edit destination targets for.
- A second matching operation within 15 min of approval succeeds silently (no hub popup) when the session affordance was checked.
- `secret-shuttle audit --since 5m` after a batch produces output the agent can include verbatim in its message to the user as proof.
- v0.3.0 is published to npm and the demo URL still works.

If any of these fail in the dogfood pass, the spec is amended and a v0.3.1 follow-up is scoped before public announcement.
