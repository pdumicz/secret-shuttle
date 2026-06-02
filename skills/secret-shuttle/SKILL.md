---
name: secret-shuttle
description: Use when an AI coding agent must provision, inject, run, or rotate secrets without ever seeing their plaintext — you work with ss:// refs (like ss://stripe/prod/STRIPE_WEBHOOK_SECRET) while a local daemon resolves the real value at the last possible moment.
---

# Secret Shuttle

Local-daemon CLI that lets AI coding agents provision and use secrets without ever seeing them.
You work with refs (`ss://stripe/prod/STRIPE_WEBHOOK_SECRET`); the daemon resolves them at the last possible moment.

> Skills evolve. Treat this on-disk file — and live `status --json` / a command's `next_action` — as the source of truth over anything you remember from an earlier read.

## 30-second quickstart

```bash
# One-time per project (beta release — published as secret-shuttle@beta on npm):
npx secret-shuttle@beta init

# Provision an entire project's secrets in one approval:
secret-shuttle provision --infer
# → If the inferred yml is fully executable: returns approval_required with details.batch_id + details.approvals[].
#   If not: returns { needs_edit: true, yml_path, issues[] } — show the user the issues and ask for edits.
# Once approved, continue with the ids the prior step returned:
secret-shuttle provision --continue \
  --batch <batch_id_from_prior_step> \
  --approval-id <approval_id_from_prior_step>

# Use a secret in a child process (value never enters your context):
secret-shuttle run --env-file .env -- npm start

# Push a single secret on demand:
secret-shuttle provision --secret STRIPE_WEBHOOK_SECRET --from capture \
  --url https://dashboard.stripe.com/apikeys --to vercel:production
```

## Core verbs

- `provision --infer|--yml|--secret|--continue` — make secrets exist in vault + destinations (one approval per batch)
- `run --env-file <f> -- <cmd>` — spawn a child with refs resolved into env / stdin
- `secrets list | get-ref <ref> | set <name> ... | delete <ref> | rotate <ref>` — discover and manage refs
- `status [--json]` — daemon + vault + browser + session state (carries `ready: bool` + `next_action`)
- `init` — one-shot setup (daemon, vault, agent skill install)
- `audit --since <duration> | --batch <id>` — what was just done (use this to deliver proof to the user)
- `template list | template run <id>` — vetted CLI integrations (Vercel, GitHub Actions, Cloudflare, Supabase)
- `inject -i <tpl> -o <out>` — render a template file with `ss://` refs into a real file
- `internal session create|list|revoke` — pre-approved batch sessions
- `daemon start|stop|status` — daemon lifecycle

## What you see vs never see

- **You see**: refs, fingerprints, metadata, batch ids, exit codes, error codes, audit summaries.
- **You never see**: raw secret values, vault keys, browser CDP URLs, OS credentials.
- **Every prod-touching op requires human approval.** One click per batch via a browser popup the daemon opens.

## Error recovery

Every error JSON includes `error_code` + `next_action`. When `next_action` is a non-null string, run it. **Trust `next_action` over error_code recognition.**

| error_code | next_action | Cause |
|---|---|---|
| `daemon_not_running` | `secret-shuttle daemon start` | Daemon isn't running. |
| `vault_not_initialized` | `secret-shuttle init` | No vault exists. |
| `vault_locked` | `secret-shuttle unlock` | Vault is locked. |
| `approval_required` | null (human required) | Approval popup opens. Wait, or pass `--approval-id` to retry. |
| `secret_not_found` | null | Use `secrets list` to see what's available. |
| `infer_no_env_example` | null (human required) | Create a `.env.example` listing your secret names. |
| `infer_yml_exists` | `secret-shuttle provision --infer --force` (or `--dry-run`) | Generated yml would overwrite an existing file. |
| `command_renamed` | (printed in error) | A verb was renamed; the error names the replacement. |

A `failed_partial` provision batch carries `next_action: secret-shuttle provision --continue --batch <id>` — run it to resume. For less common codes call `secret-shuttle status --json` or read the Reference section below.

---

## Reference (read when an error or edge case sends you here)

You are an agent. The sections above are the day-to-day operating surface. The sections below cover safety discipline, low-level mechanics, and edge cases the daily-flow agent rarely hits.

## Before any secret operation

1. Run `secret-shuttle status --json` first. If `daemon_reachable` is `false`,
   run `secret-shuttle daemon start`. If `unlocked` is `false`, run
   `secret-shuttle unlock` (the human enters the passphrase in the browser
   window; the CLI never reads it). If `agentic_browser.available` is `false`,
   run `secret-shuttle browser start`. Re-check `status --json` after each
   action — do not proceed until every prerequisite is `true`.

## Prefer `template run` over generic browser ops

2. Before reaching for the browser, check `secret-shuttle template list`. If a
   shipped template covers the destination (Vercel env vars, GitHub Actions
   secrets, Cloudflare Workers secrets, Supabase edge secrets), use
   `secret-shuttle template run <id> --ref <ref> --param <k>=<v>` instead of
   the browser flow. Templates are the safer path (the secret reaches the
   provider's CLI on stdin or via a `0600` env-file; never argv, never env).

## Marking elements before blind mode

3. For focusable fields (text inputs, contenteditable, password inputs):
   focus the element with your normal browser tool, then run
   `secret-shuttle browser mark focused --as <label>`. The daemon records an
   opaque handle keyed by `<label>`; the agent never sees a selector or a
   DOM path. Re-marking the same label is last-write-wins.

4. For non-focusable controls (buttons, reveal/hide icons, links): use
   `mark pick`. `mark pick` blocks until a pick happens, so **you** (not a
   human) drive the choreography:
   - Start `secret-shuttle browser mark pick --as <label>` in the background
     (your runtime's non-blocking shell, or a separate tool turn — do not
     await it yet).
   - Immediately use your browser tool to click the target element. Chrome's
     inspect overlay highlights it; the click is browser-consumed (no page
     event fires — an app's earlier-registered window-capture handler cannot
     reveal/submit during marking).
   - Now await the `mark pick` command. It returns the handle.
   - **Fallback** if your runtime cannot drive browser and terminal
     concurrently: prefer `mark focused` for any focusable control. If the
     control is not focusable and concurrent control is impossible for your
     runtime, the flow cannot be fully agentic for that element — stop and
     surface this to the human. Do NOT skip the mark.

## The secret-bearing transaction

5. Use `inject-submit` (write a secret into a field and click submit) or
   `reveal-capture` (click a reveal control, capture the revealed secret,
   click hide). These open a human-approval window in the browser. Approve
   the request there — there is no CLI flag that bypasses approval.

   - `inject-submit --ref ss://... --field-handle <label> --submit-handle <label> --success-text "<text>"`
   - `reveal-capture --name <NAME> --env <env> --source <source> --reveal-handle <label> [--field-handle <label>|--container-handle <label>|--capture focused-after-reveal] [--hide-handle <label>] --allow-domain <domain>`

## Observation during blind mode

6. **NEVER** during blind mode:
   - take a screenshot
   - inspect the DOM
   - read page text, accessibility tree, or console
   - read network response bodies
   - read the clipboard
   - call any browser tool that returns page content

   The daemon does these internally for the absence proof — you must not. The
   daemon's CDP proxy will block these calls, but the contract is that **you
   do not even attempt them**.

## Interpreting enum responses

7. Responses are enum-only. The raw secret value is never in any response
   body. The agent must:
   - report only the enum status, the ref, the fingerprint, the domain, and
     the success/failure signal — never any captured text, never any DOM
     snippet
   - on `next: "manual_recovery_required"`: **do not** attempt to resume
     observation yourself. Surface this to the human (the human-approved
     `secret-shuttle internal blind end` is the only recovery). Auto-resume
     bypassed because the daemon could not prove the secret is gone; the human
     owns the recovery decision.
   - on success: the daemon has already auto-resumed observation. You may
     continue normally — but still never report the raw value (you never had
     access to it).

## Safe output

It is safe to report:
- secret refs (`ss://stripe/prod/STRIPE_WEBHOOK_SECRET`)
- fingerprints (`fp:abcdef…`)
- domains (`dashboard.stripe.com`)
- secret names + environments
- status enums (`submitted:true`, `captured:true`, `next:"manual_recovery_required"`)

It is **never** safe to report raw secret values.

## Provider browser-flow status

The browser-driven flows (`inject-submit` for Vercel-style env-var writes,
`reveal-capture` for Stripe-style secret reveals) depend on the target
provider's page structure. The Phase-2 and Phase-3 [P2a] real-page gates and
the Phase-4 [P2b] template-CLI gates record per-provider production-or-best-
effort status in this repository's plan files:

- Vercel browser flow ([P2a], Phase-2 plan): **PENDING** — see
  `docs/superpowers/plans/2026-05-18-agentic-blind-transactions-phase2-inject-submit.md`
  "## [P2a] Gate outcome".
- Stripe browser flow ([P2a], Phase-3 plan): **PENDING** (user-deferred) —
  see `docs/superpowers/plans/2026-05-19-agentic-blind-transactions-phase3-reveal-capture.md`
  "## [P2a] Gate outcome".
- Provider templates ([P2b], Phase-4 plan): **PENDING** — see
  `docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase4-templates.md`
  "## [P2b] Gate outcome".

Until those gates are recorded as PASS, treat every browser flow as
**best-effort**. The absence proof stays conservatively fail-closed regardless
(the daemon refuses to auto-resume unless it can prove the secret is gone), so
"best-effort" means "auto-resume may not succeed on every page", not "the
secret may leak". When in doubt, use `template run` for the four shipped
templates (`vercel-env-add`, `github-actions-secret-set`,
`cloudflare-secret-put`, `supabase-edge-secret-set`).

## Recap of forbidden actions during blind mode

- screenshots
- DOM inspection
- page-text reads
- accessibility tree reads
- console reads
- network-body reads
- clipboard reads
- any browser tool that returns page content

The daemon does these internally for the absence proof. You do not.
