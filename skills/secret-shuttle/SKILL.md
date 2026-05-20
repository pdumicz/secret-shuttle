# Secret Shuttle — Agent Operating Manual

You are an agent. This is your operating manual for using Secret Shuttle. The
human will not see these directives unless they read this file. Read top to
bottom; the order matters.

## Before any secret operation

1. Run `secret-shuttle doctor --json` first. If `daemon_reachable` is `false`,
   run `secret-shuttle daemon start`. If `unlocked` is `false`, run
   `secret-shuttle unlock` (the human enters the passphrase in the browser
   window; the CLI never reads it). If `agentic_browser.available` is `false`,
   run `secret-shuttle browser start`. Re-check `doctor --json` after each
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
     `secret-shuttle blind end` is the only recovery). Auto-resume bypassed
     because the daemon could not prove the secret is gone; the human owns
     the recovery decision.
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
