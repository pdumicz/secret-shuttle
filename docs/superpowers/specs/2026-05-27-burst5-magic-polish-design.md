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
- `requireApprovals`, `bootstrapAuthority`, owner-enforced consumption, and blind-mode discipline are unchanged.

**Changed (intentional 0.x breakers — no production users yet):**
- `bootstrap` verb is **hard-removed**, replaced by `provision`. Running `secret-shuttle bootstrap` exits with a `command_renamed` error pointing at `provision`.
- Deprecated shims (`list`, `inspect`, `generate`, `doctor`) are **hard-removed** per the v0.3.0 schedule already noted in CHANGELOG. Their replacements (`secrets list`, `secrets get-ref`, `secrets set`, `status`) are unchanged.
- Pre-approved session TTL hard cap raised from 15 min to 60 min, because the new affordance asks the user at the moment of consent rather than via a hidden CLI.
- **Plan 4a `template-run` session matcher contract is evolved (additive, narrows-only):** `SessionPattern` gains one optional field `required_params?: Record<string, string>`. The matcher enforces strict-equal on every key listed (no-op when empty/absent — Plan 4a behavior preserved for manually-created sessions). The change is additive and narrows-only — no existing match can become broader. New sessions minted via the approval-UI affordance fill in `required_params` from the per-template destination-defining-params config; destinations whose template has no registered config are **excluded** from the derived patterns (fail-closed, no over-broad session ever auto-minted). See §2 "Template-param constraint primitive" for the full rationale.

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

**Flag conflict resolution:** `--infer`, `--yml`, `--secret`, `--continue`, `--list`, `--abandon` are mutually exclusive (the input-shape selectors). Multiple selectors → `provision_mode_conflict` with the conflicting flags named in `message`. Single selector required; if no selector and `./secret-shuttle.yml` exists, default to `--yml ./secret-shuttle.yml`; if neither selector nor file → `provision_no_mode`.

**Return shape — non-`--dry-run` modes (`--yml`, `--secret`, `--infer` when fully executable):** mint a batch, return `approval_required` with `batch_id` + `details.approvals[*]`. `--continue` consumes and executes.

**Return shape — `--dry-run` (`--infer` only):** print the planned yml to stdout, do not write any file, do not mint any batch, exit 0 with `{ ok: true, mode: "dry_run", yml: "<rendered yml>" }`. `--dry-run` combined with any other mode → `provision_mode_conflict`.

**Return shape — `--infer` when generated yml is NOT fully executable** (see "Executability gate" below): write the yml, do not mint a batch, return a success payload with `needs_edit: true` (no error).

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

**Executability gate** — a generated yml is *fully executable* if and only if **all** of the following hold for every `secrets[*]` entry:
- `source.kind ∈ {capture, random_32_bytes, random_64_bytes, existing}` (i.e. not `unknown`)
- If `source.kind == capture`: `source.url` is a non-null https URL that passes the strict validator from Burst 4 §3
- If `source.kind == existing`: `source.ref` is a real `ss://source/env/NAME` string (not a placeholder; ref-prefix exists in the vault is NOT required — `provision --yml` already errors clearly at execution time if missing)
- `destinations` is a non-empty array
- No destination shorthand contains the literal placeholder substring `OWNER/REPO`
- (Note: an `existing` ref pointing at an empty vault slot is allowed at infer time and surfaces at execute time as `secret_not_found` — that's where the existing per-step error path takes over.)

The gate is enforced by a pure function `isInferYmlExecutable(plan) → { ok, issues[] }` in `src/cli/provision/infer-gate.ts`.

**Output behavior:**

| Flag combo | File written? | Batch minted? | Return shape |
|---|---|---|---|
| `--infer` (executable) | yes (refuse if exists, see below) | yes | `approval_required` (mint batch) |
| `--infer` (NOT executable) | yes (same refuse-if-exists rule) | **no** | `{ ok: true, needs_edit: true, yml_path, issues[], next_action: "edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml" }` |
| `--infer --dry-run` | **no** | no | `{ ok: true, mode: "dry_run", yml: "<rendered>", executable: bool, issues[] }` |
| `--infer --force` | yes (overwrite allowed) | same as above (gate still applies) | same as above |
| `--infer` when `./secret-shuttle.yml` exists and no `--force` | no | no | error `infer_yml_exists` (exit 5 CONFLICT, `next_action` suggests `--force` or `--dry-run`) |

The gate keeps the strict parser strict — only fully-runnable yml flows into the batch executor. Non-executable yml is treated as a *draft* the user (or agent) must edit, not as an error.

**Agent contract on `needs_edit`:** the agent shows the generated yml + `issues[]` to the user, explains what to fill in, asks the user to edit (or guides them through the edits), then runs `provision --yml ./secret-shuttle.yml` once happy. No approval has been minted yet, so no time pressure.

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
  --dry-run              Print planned yml to stdout, no file write, no batch (--infer only)
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
| `infer_yml_exists` | 5 (CONFLICT) | `./secret-shuttle.yml` already exists. `next_action`: `--force` or `--dry-run`. |
| `provision_mode_conflict` | 2 (USAGE) | Multiple mode-selector flags, or `--dry-run` with a non-`--infer` mode. `message` names the conflict. |
| `provision_no_mode` | 2 (USAGE) | No mode selector and no `secret-shuttle.yml` to default to. |
| `session_ttl_exceeds_cap` | 2 (USAGE) | (New, replacing today's `bad_request` for this case.) Session pattern `ttl_ms` exceeds the cap. `message` names the cap. |

All existing `bootstrap_*` error codes are kept verbatim (they describe internal batch operations that didn't change). `needs_edit` is a SUCCESS shape, not an error — no error code.

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

After this burst: when the user approves a provisioning batch, the approval card offers a checkbox to extend their consent to matching future operations. One click at consent time. The agent doesn't have to know sessions exist.

### Where the UI change lives (corrects v1 spec)

The approval card lives in `src/daemon/approvals/ui.html` + the routes in `src/daemon/approvals/ui-server.ts`. The hub (`src/daemon/hub/`) is the iframe-shell + SSE queue; it does NOT render approval content directly. All UI/UX changes in this section apply to `ui.html` (the per-approval page that the hub frames).

The hub's only role for this feature is unchanged: it queues navigations and frames the per-approval URL. No hub-ui.html changes are required.

### Approval card change

`src/daemon/approvals/ui.html` is rendered per approval at `/ui/approvals/:approval_id?token=<ui_token>`. For approvals whose `action == "bootstrap"` (i.e. every `provision` batch), the page gains a footer block above the [Approve]/[Deny] buttons:

```
─────────────────────────────────────────────
☐ Also approve any matching shape for the next
  [ 15 min ▾ ] (options: 5 / 15 / 30 / 60)

  This would let the same secret(s) be pushed again to the
  exact destinations below, within the time window:
    • vercel-env-add        ss://stripe/prod/STRIPE_KEY            name=STRIPE_KEY, environment=production
    • github-actions-...    ss://stripe/prod/STRIPE_KEY            name=STRIPE_KEY, repo=patryk/secret-shuttle
    • supabase-edge-...     ss://supabase/prod/SUPA_SVC_KEY        name=SUPA_SVC_KEY, project_ref=abc123

  Different env-var names, environments, repos, or projects are
  NOT covered.
  Revoke any time:  secret-shuttle internal session revoke <session-id>
─────────────────────────────────────────────
   [ Approve ]   [ Deny ]
```

The pattern lines are server-rendered from the derivation result — one line per derived `SessionPattern`, showing `template_ids[0]`, `ref_glob`, and the human-readable `required_params` key=value pairs. The user sees the **exact** scope they're consenting to, and the "Different environments, repos, or projects are NOT covered." line makes the param-strict semantics explicit.

The checkbox is default-unchecked. The dropdown defaults to 15 min when the user checks the box. The block does not render at all if the derived pattern set is empty (see "Empty-pattern guard" below).

When the user clicks [Approve] with the checkbox checked, the POST to `/ui/approvals/:id/approve` includes `{ session: { ttl_minutes: <selection> } }` in its body. The route reads this and, after recording the approval grant, mints session grants — see "Owner stamping" below.

**Body parsing in the raw route (corrects v1 spec gap):** `DaemonServer.addRouteRaw` (`src/daemon/server.ts:69`) does not parse JSON bodies — its handler receives an opaque body argument. The `/ui/approvals/:id/approve|deny` route currently does not read a body. After this burst, the approve POST DOES read a small JSON body when one is sent (the checkbox path); legacy clients that POST nothing must continue to work unchanged.

The relocated helper at `src/daemon/helpers/bounded-json.ts` (moved from `src/daemon/hub/hub-server.ts:141`) gains a third optional argument:
```ts
readBoundedJson(req, maxBytes, { allowEmpty?: boolean } = {}): Promise<unknown>
```
- `allowEmpty: false` (default) — preserves today's behavior at the hub `/ui/hub/done` site: empty body → `bad_request` ("Empty body."). Existing test pin retained.
- `allowEmpty: true` — empty body resolves to `{}`. Used by the approve route only.

The approve route calls `readBoundedJson(req, 1024, { allowEmpty: true })`.

Body shape (when present): `{ session?: { ttl_minutes: 5|15|30|60 } }`. Empty body or `{}` or missing `session` key → no session minted (today's behavior preserved). Malformed JSON → `bad_request`. Oversize → `request_too_large`. Unknown `ttl_minutes` value → `bad_request` listing the allowed set.

### Template-param constraint primitive (Plan 4a contract evolution)

The Plan 4a `template-run` session matcher (`src/daemon/approvals/session-matchers.ts`) matches by `ref_glob` + `template_id` only. It does NOT constrain `template_params`. For provision batches that approve "push to vercel:production via vercel-env-add" the matcher would silently authorize "push to vercel:preview via vercel-env-add with the same ref" — a real over-broadening of consent. We need a param-equality matcher before sessions can be derived safely from provision batches.

**SessionPattern extension (additive, single new optional field):**

The real shape (`src/daemon/approvals/session.ts:60`) is flat — one interface with `actions: SessionAction[]` and `ref_glob: string`. This burst adds exactly one optional field:

```ts
// src/daemon/approvals/session.ts — real shape, transcribed verbatim
// from the existing interface; the only diff is the NEW field at the bottom.
export interface SessionPattern {
  actions: SessionAction[];                   // existing
  ref_glob: string;                           // existing
  destination_domains: string[];              // existing — REQUIRED (non-empty
                                              //   for inject-submit, reveal-
                                              //   capture, secrets-set)
  template_ids?: string[];                    // existing — REQUIRED non-empty
                                              //   when actions includes
                                              //   template-run
  allowed_actions?: string[];                 // existing — REQUIRED non-empty
                                              //   when actions includes
                                              //   secrets-set
  ttl_ms: number;                             // existing
  max_uses?: number;                          // existing (1..1000, optional;
                                              //   NOT nullable — undefined or
                                              //   a positive integer)

  // NEW:
  required_params?: Record<string, string>;
  // Applies ONLY to the template-run matcher branch (other action
  // matchers ignore this field). When present and non-empty, the
  // template-run matcher requires the binding's template_params to
  // contain every key here with strict-equal value (extra keys in
  // the binding are allowed — the pattern constrains only what's
  // listed). When absent/empty, today's matcher behavior is
  // preserved.
  //
  // Patterns whose `actions` does NOT include "template-run" are
  // unaffected — the field is silently ignored by other matchers.
  // Patterns whose `actions` includes "template-run" alongside
  // other actions: required_params applies on the template-run
  // branch only.
}
```

No other field changes. No new discriminated-union shape. No schema refactor. The existing field-optionality conventions (required `destination_domains`, optional non-nullable `max_uses`) are preserved.

**Per-template "destination-defining params" config:**

```ts
// src/daemon/templates/destination-defining-params.ts (NEW)
//
// Lists which template_params are destination-defining for each shipped
// template — i.e. which params would change WHERE the secret is pushed.
// Session derivation copies the values of these params from each
// PlanEntry into the SessionPattern.required_params so the resulting
// session can ONLY match operations with the same destination shape.
//
// `name` is destination-defining for ALL shipped templates: it is the
// variable / secret name being set at the provider (vercel env var
// name, github actions secret name, etc.). A session approved for
// pushing STRIPE_KEY to vercel:production must NOT auto-authorize
// pushing OPENAI_KEY to the same scope — that is a different
// destination variable.
export const DESTINATION_DEFINING_PARAMS: Record<string, readonly string[]> = {
  "vercel-env-add":             ["name", "environment"],
  "github-actions-secret-set":  ["name", "repo"],         // repo is one combined "owner/repo" string param
  "cloudflare-secret-put":      ["name", "env"],
  "supabase-edge-secret-set":   ["name", "project_ref"],
};
```

**Implication of `name` being destination-defining**: most realistic batches push one ref to one (provider, env, variable-name) triple — each `PlanEntry`'s `name` is the env-var name from `.env.example`, typically unique per entry. So the derivation usually produces **one pattern per (ref, destination)** rather than one pattern per (source, env, template). That's exactly the granularity the user is consenting to: "the same secret pushed to the same place again" — not "anything in this provider scope."

For batches that genuinely push the same ref to multiple env-var names (rare, but possible — same source value under two different names in the destination), each name gets its own pattern. Each pattern is exact-ref + exact-params; `ref_glob: "ss://<source>/<env>/*"` form is only emitted when ≥2 ref-distinct entries share all destination-defining params (effectively never, given `name` is in the key — but the code handles it cleanly if a future template adds a many-to-many shape).

**Two distinct fallback contexts — derivation fails closed, manual paths unchanged:**

- **Provision-derived sessions (the new affordance):** if a `PlanEntry.destination`'s `template_id` is NOT in `DESTINATION_DEFINING_PARAMS`, that destination is **excluded from the derived patterns** — it cannot contribute a session. Rationale: deriving a no-constraint pattern from an unregistered template would silently re-introduce the consent-widening bug this primitive closes. Excluding it is fail-closed: future pushes to that destination will require fresh approval each time, which is correct.
  - The approval-card footer shows a notice when any destinations were excluded:
    ```
    Note: 2 destination(s) excluded from this session (template
    `railway-variable-set` has no destination-defining-params config).
    Pushes to those destinations will require fresh approval each time.
    ```
  - If ALL destinations are excluded (e.g., the batch only pushes to unregistered templates), the affordance does NOT render at all — exactly as the empty-pattern guard.
- **Manually-created sessions (`secret-shuttle internal session create` and any future direct API caller):** the existing Plan 4a contract is preserved. A pattern with empty/absent `required_params` is accepted by `SessionStore.create` / `createForOwner` and matches per Plan 4a's original semantics (ref + template_id only). The operator setting that pattern via the CLI is informed consent — they explicitly chose not to constrain params. The derivation path is the only one that gets the new fail-closed behavior; the matcher's `required_params` clause is identical in both paths (strict equality on listed keys; empty/absent means unconstrained).

The daemon also emits a startup-time warning log line listing registered template_ids without an entry in `DESTINATION_DEFINING_PARAMS`, and `destination-defining-params-config.test.ts` is a CI gate that fails when a shipped template lands without its entry. These two layers — runtime warning + CI gate — are belt-and-suspenders against the config drifting silently.

### Threading `required_params` through the existing whitelist surfaces

Three places already exist where session patterns are parsed in / rendered out. They are all whitelist-shaped — adding a field requires explicit work at each site, otherwise the field silently drops on the wire even though the matcher would honor it. The burst threads `required_params` through every site:

1. **Central validator `assertSessionPatternValid`** (`src/daemon/approvals/session.ts:145`) — the **mandatory** site for security-field validation. Today every other security-relevant pattern field (actions, ref_glob, destination_domains, template_ids, allowed_actions, ttl_ms, max_uses) is enforced here as a store-level invariant: `SessionStore.create` / `createForOwner` call this validator on every grant minted. `required_params` follows the same pattern — validation lives here, not in the route parser, so every code path that creates a session (HTTP route, approval-UI derivation, future direct API callers, tests that construct patterns directly) hits the same checks:
   - If `required_params` is absent → leave undefined. Valid (means "no param constraints"; matches pre-burst behavior).
   - If present, must be a non-array, non-null object (`typeof === "object" && !Array.isArray(x) && x !== null`) — else `bad_request` ("required_params must be an object.").
   - Every value must be a string (no number, boolean, null, nested object) — else `bad_request` with the offending key in `message`.
   - Every key must match `/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/` (the param-name regex template params already validate against) — else `bad_request` with the offending key.
   - `required_params` is permitted on patterns whose `actions` does not include `template-run` (the matcher ignores it for other actions) — but a startup-time test asserts derivation never emits such patterns (defense in depth).

2. **POST `/v1/approvals/session` body parser** (`src/daemon/api/routes/approvals-session.ts:103`, function `parseSessionPatternFromBody`):
   - Add `required_params` to the whitelist so the field survives the parse step (without whitelisting, the route would silently drop it before `assertSessionPatternValid` ever sees it).
   - No additional shape validation in the parser — the centralized invariant in `assertSessionPatternValid` is the single source of truth. The route relies on the call to `SessionStore.create` (which runs the validator) to enforce.
   - The CLI's `secret-shuttle internal session create` flag-parse code adds an analogous `--required-param k=v` repeatable flag for manual session creation. CLI-side: only basic `k=v` lex parsing (split on first `=`). Validation happens daemon-side via the central validator.

3. **`session-ui-server.ts:44` `safePattern` whitelist** (the JSON template fragment substituted into the session approval HTML at `/ui/session?id=`):
   - Add `required_params: grant.required_params` to the whitelisted object.
   - The HTML page (`src/daemon/approvals/session-ui.html`) renders the pattern shape as JSON for the operator to read before they click [Approve]. Without this thread, an operator manually creating a session pattern with `required_params` would see "destination_domains: …, template_ids: …, max_uses: …" but NOT see the param constraint they just supplied — surprising and unsafe.
   - The session approval HTML template also gains a human-readable rendering of `required_params` (e.g., a "Required params:" row showing `environment=production`) so operators don't have to JSON-parse to understand the scope.

4. **GET `/v1/approvals/sessions` list response** (`approvals-session.ts:57`): the list returns session-grant JSON. Add `required_params` to the response shape so:
   - `secret-shuttle internal session list` (which emits JSON only — `--json` is a no-op forward-compat flag per `src/cli/commands/internal-session.ts:52`) exposes the constraint per session.
   - `status --json`'s `active_sessions[].pattern_summary` derives correctly (it consumes the same data the list endpoint exposes).
   - Auto-match candidate inspection during debugging (developers reading the log + JSON list) can see exactly what each session matches.

5. **`SessionGrant` persisted shape** (in-memory + any future on-disk persistence): `SessionGrant extends SessionPattern` (`session.ts:77`) — so once `required_params` is on `SessionPattern`, the grant inherits it for free. No additional storage migration needed.

**Tests added for threading (mandatory + per-surface):**
- `session-pattern-required-params-validator.test.ts`: `assertSessionPatternValid` (the **mandatory** central validator) accepts well-formed `required_params`, rejects: array, null, non-string values, malformed keys, nested objects. Every other code path that creates a session inherits these rules without re-validating.
- `approvals-session-route-required-params.test.ts`: POST `/v1/approvals/session` with `required_params` parses cleanly via the whitelist and reaches `SessionStore.create` (which calls the validator); invalid shapes surface as `bad_request` (originated from the validator, not the parser); pattern with `required_params` matches a binding only when params strict-equal.
- `session-ui-server-required-params.test.ts`: GET `/ui/session?id=` returns HTML with the rendered `required_params` lines; the embedded JSON pattern includes the field; no field-drop.
- `session-list-required-params.test.ts`: GET `/v1/approvals/sessions` returns `required_params` per session in the JSON; missing field on legacy grants renders as absent without breaking parsers.
- `cli-internal-session-create-required-params.test.ts`: `internal session create --required-param environment=production` builds a body that includes `required_params: { environment: "production" }`; multiple flags merge into one object; malformed `k=v` → CLI usage error before any daemon call.
- `cli-internal-session-list-required-params.test.ts`: `internal session list` JSON output includes `required_params` per session entry (the CLI is JSON-only — no text-mode assertions).

**Matcher extension** (`src/daemon/approvals/session-matchers.ts`):

```ts
// Extends the existing template-run matcher branch.  The function
// signature matches the file's existing pattern — pattern: SessionPattern,
// binding: ApprovalBinding (with action === "template-run").
function templateRunMatches(pattern: SessionPattern, binding: ApprovalBinding): boolean {
  // Existing checks (unchanged from Plan 4a):
  if (!pattern.template_ids?.includes(binding.template_id)) return false;
  if (pattern.ref_glob.length > 0 && !refGlobMatches(pattern.ref_glob, binding.ref)) return false;
  // NEW: param equality (no-op when required_params is empty/absent)
  if (pattern.required_params && Object.keys(pattern.required_params).length > 0) {
    for (const [key, expected] of Object.entries(pattern.required_params)) {
      if (binding.template_params?.[key] !== expected) return false;
    }
  }
  return true;
}
```

Strict equality is the right semantics: the user approved consent for an exact destination, not for a class of destinations. Defense-in-depth: the matcher never widens, only narrows or equal-matches. The `required_params` check is the last clause — a pattern that already fails on ref/template still fails fast.

### Pattern derivation — from `BatchState.plan`, with destination-defining params (corrects v1 spec)

The provision batch is approved as a single `action: "bootstrap"` binding (the executor bypasses inner approvals via `bootstrapAuthority`). So we cannot "derive from the batch's bindings" as the v1 spec said — there is only one binding, and its shape is opaque to the session pattern surface.

Instead, the session pattern is derived **server-side from `BatchState.plan: PlanEntry[]`**:

```
inferSessionPatternFromPlan(plan: PlanEntry[]) → {
  patterns: SessionPattern[];          // possibly multiple — see narrowness below
  summary_lines: string[];             // what to display in the UI footer
}
```

**Grouping key (extended for param constraints):**

For each `PlanEntry`'s destinations, the resolved `template_params` are available (see `ResolvedDestination.template_params` in `src/daemon/bootstrap/store.ts:13`). Look up the template's destination-defining-param keys from `DESTINATION_DEFINING_PARAMS`. Extract their values.

The grouping key becomes:
```
(template_id, source, env, ...sorted destination-defining param key=value pairs)
```

Concrete examples (`name` is destination-defining for every shipped template, so it appears in every group key):

- **Single ref to one Vercel environment:** one PlanEntry pushing `ss://stripe/prod/STRIPE_KEY` to `vercel:production` (variable `name=STRIPE_KEY`) → **one pattern**, `ref_glob: "ss://stripe/prod/STRIPE_KEY"` (exact ref), `required_params: { name: "STRIPE_KEY", environment: "production" }`.
- **Same ref pushed to two Vercel environments (same variable name):** PlanEntry pushes `ss://stripe/prod/STRIPE_KEY` to both `vercel:production` AND `vercel:preview`, same env-var name `STRIPE_KEY` → **two patterns** (one per `environment` value), each exact-ref, each with `required_params.name = "STRIPE_KEY"` + the corresponding `environment`.
- **Two different refs, same Vercel environment, different variable names:** PlanEntry A pushes `ss://stripe/prod/STRIPE_KEY` to `vercel:production` (name=STRIPE_KEY); PlanEntry B pushes `ss://stripe/prod/STRIPE_WEBHOOK_SECRET` to `vercel:production` (name=STRIPE_WEBHOOK_SECRET). Different `name` values → **two patterns**, each exact-ref + its own `required_params.name`.
- **Two different refs, same destination variable name** (the rare aliasing case where two refs are both pushed under the same env-var name — e.g., overwrite intent): PlanEntry A pushes `ss://stripe/prod/X` to `vercel:production` (name=API_KEY); PlanEntry B pushes `ss://stripe/prod/Y` to `vercel:production` (name=API_KEY). Same `(template_id, source, env, name, environment)` group key → **one pattern**, `ref_glob: "ss://stripe/prod/*"` (a glob, because the group spans two distinct refs), `required_params: { name: "API_KEY", environment: "production" }`. This is the only case where the glob form is emitted in practice; the user's consent line shows the glob + the `name=API_KEY` constraint so the scope is unambiguous.
- **Same ref pushed to two distinct GitHub repos:** PlanEntry pushes `ss://stripe/prod/STRIPE_KEY` (name=STRIPE_KEY) to `repo=patryk/a` AND `repo=patryk/b` → **two patterns**, each exact-ref, each with `required_params.repo` set to the respective repo and `required_params.name = "STRIPE_KEY"`.

**Net effect:** derivation now yields **one pattern per (ref, destination-shape) pair** in the typical case. The `ref_glob` form (with trailing `*`) emerges only in the aliasing case above. Consent is consequently per-push, not per-scope-class — exactly what the user sees on the approval card.

**Pre-grouping filter:** before grouping, walk every `PlanEntry.destination` and check whether its `template_id` is a key in `DESTINATION_DEFINING_PARAMS`. Destinations whose template is NOT a key are **dropped from the derivation input** (fail-closed per the rule above). Track the dropped destinations so the UI footer can surface the "excluded" notice. Only registered destinations flow into the grouping step.

**Per-group output (rules) — applied only to destinations that survived the pre-grouping filter:**
- `actions: ["template-run"]`
- `template_ids: [<template_id>]`
- `ref_glob: "ss://<source>/<env>/*"` (if group has ≥2 entries with the same `(source, env)`) OR the single exact ref (if group has 1 entry)
- `required_params`: populated from the registered destination-defining-params for this `template_id`:
  - If `DESTINATION_DEFINING_PARAMS[template_id]` is a **non-empty** list of param keys: emit `required_params: { <key>: <value-from-PlanEntry.destination.template_params>, ... }` for every listed key. This is the strict-equal scope the user is consenting to.
  - If `DESTINATION_DEFINING_PARAMS[template_id]` is an **explicitly registered empty list** `[]` (the future case of a template whose maintainer deliberately reviewed it and confirmed no destination-defining params exist): emit `required_params: {}` (or omit the field). The matcher matches by ref + template_id only, as Plan 4a. The empty list is an **explicit registration of "no constraints needed"**, distinct from the unregistered case which is fail-closed.
  - There is **no third case**: derivation never sees an unregistered template, because the pre-grouping filter dropped it.
- `destination_domains: [<domain>]` — informational; emitted for audit/display consistency; not consulted by the template-run matcher.

**Capture-step exclusion:** capture is one-shot human-attended; future captures are not session-eligible (the user has to click Capture every time anyway). Plan entries with `source.kind == capture` contribute their template-run destination groups to the session pattern (the *push* is repeatable) but do NOT contribute any capture/reveal action to the session.

**Empty-pattern guard:** if the derivation produces zero patterns, the affordance is not rendered. There are two ways to hit zero:
1. The batch is entirely capture steps with no template-run destinations attached (capture without a downstream push).
2. Every destination in the batch was dropped by the pre-grouping filter (all template_ids unregistered). The approval card still shows the "excluded destinations" notice for diagnosis, but no session checkbox.

Any batch with at least one *registered* template-run destination produces at least one pattern — including single-entry ones (see "Single-entry patterns are allowed" below).

### Ref glob narrowness rule

- **Group by `(template_id, source, env, destination-defining-params)`.** Refs sharing all four become one pattern with `ss://<source>/<env>/*`; refs differing in any become separate patterns.
- **Never emit a pattern broader than `ss://<source>/<env>/*`.** A would-be pattern like `ss://*/prod/*` or `ss://stripe/*/*` is split into multiple `ss://<source>/<env>/*` patterns.
- **Single-ref groups use the exact ref**, not a glob.
- **`required_params` is never widened across a group** — the grouping ensures every entry in a group has the same destination-defining-param values.

For a mixed batch (e.g., Stripe→Vercel and Supabase→Vercel and Stripe→GitHub Actions), the derivation produces 3 distinct patterns. **Each pattern becomes its own independent `SessionGrant`** — the current `SessionGrant` data shape (`src/daemon/approvals/session.ts:77`) stores exactly one `SessionPattern`, and introducing a "session bundle id" is new product surface that isn't justified by this burst's magic-polish scope.

Consequences of one-grant-per-pattern:
- The single user [Approve] click mints N grants in one server-side transaction (looped `createForOwner` calls); the loop must be all-or-nothing — if any `createForOwner` throws, the previously-minted grants in this batch are rolled back (deleted) so the user's consent isn't half-applied.
- The hub UI footer displays the N patterns as N lines (one per derived pattern). The user reads "what they're consenting to" as the list — the UI does NOT need to convey grant ids since the user revokes by pattern-shape or by listing/revoking individually.
- `secret-shuttle status` shows all N as separate `active_sessions[]` entries (their `pattern_summary` makes it obvious they came from the same batch — same `approved_at` timestamp).
- Revocation: a user wanting to revoke "everything from that batch" runs `internal session list` and revokes each; group-revoke is deferred to a future burst if real usage shows the need.

### Single-entry patterns are allowed (corrects v1 spec ambiguity)

A `(template_id, source, env)` group containing one plan entry yields an **exact-ref** pattern (no `*`). This is allowed — and useful: it lets the agent push the same ref again within the consent window (e.g., to a second destination environment that was deferred, or to re-push after a value update). The "empty-pattern guard" suppresses the affordance only when derivation produces **zero** patterns (e.g., the batch is a single capture step with no template-run destinations). Single-entry batches with at least one template-run destination DO get a session offer.

### Owner stamping — UI route → store, explicit propagation (corrects v1 spec)

The approval UI routes (`/ui/approvals/:id/approve|deny`) are registered via `addRouteRaw`, which has no ALS auth context. Today `SessionStore.create()` reads `getCurrentAgentId()` inside `create()` — that would return `"daemon"` for these routes, breaking owner-enforcement consumption.

Fix: a new factory on SessionStore that takes the owner explicitly:

```ts
class SessionStore {
  // Existing — reads owner from ALS:
  create(pattern: SessionPattern): SessionGrant { /* owner = getCurrentAgentId() */ }

  // New — owner supplied explicitly. Used by UI routes that act on a
  // persisted grant outside any ALS context.  Mirrors the existing
  // AuditActorSite.persisted-owner pattern (src/daemon/audit.ts:84).
  createForOwner(pattern: SessionPattern, owner_agent_id: string): SessionGrant {
    return this.createInternal(pattern, owner_agent_id);
  }
}
```

The `/ui/approvals/:id/approve` route, when the session checkbox was checked, calls:
```ts
const grant = await approvalStore.getOrThrow(approvalId);   // grant carries owner_agent_id
const { patterns } = inferSessionPatternFromPlan(batchState.plan);
for (const pattern of patterns) {
  sessionStore.createForOwner(pattern, grant.owner_agent_id);
}
```

Owner is the **approval grant's** `owner_agent_id`, which equals the batch's `owner_agent_id` (both are stamped from ALS at plan time per Burst 4). The session is therefore owned by the same agent that owns the batch — matching the user's mental model ("approve this for the agent that asked for it").

Audit writes for the session creation use `AuditActorSite.persisted-owner` (see `src/daemon/audit.ts:84-99`) so the audit record correctly attributes to the agent, not to "daemon".

### Daemon-side auto-application

The CLI **does not** need to track `--session <id>` for the auto-match case. The daemon resolves automatically:

- `requireApprovals` (today) checks for an `approval_id` in the request, falls through to mint a new one.
- After this change: when no `approval_id` AND no `session_id` is supplied, `requireApprovals` *first* consults the SessionStore for owned-by-this-agent active session grants whose pattern matches the binding shape. If a match exists, a per-op grant is minted via the existing `canMatchSession` + `mintFromSession` primitives (Plan 4d) and the operation proceeds without a hub popup.
- If no session matches and the operation requires approval, behavior falls through to the existing per-op approval flow.

This means the agent calling `template run vercel-env-add --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET ...` ten seconds after the user approved a session pattern matching that ref will silently succeed — no hub UI appearance, no `--session` flag, no agent code change.

**Auto-match candidate filtering** — applied before pattern matching:
- Exclude sessions where `status != "granted"` (skip pending, denied, expired, revoked).
- Exclude sessions where `expires_at < now` (defensive — `SessionStore.get/list` already flip these to `expired`).
- Exclude sessions where `max_uses != null && uses_remaining <= 0`.
- Of the remainder, sort by `approved_at` DESC (tiebreaker `created_at` DESC), match patterns in order, return the first match.

**Race on `max_uses`:** if `canMatchSession` returns success but `mintFromSession` fails because `max_uses` was raced to zero by a sibling call, the daemon retries the auto-match lookup ONCE (which will skip the now-exhausted candidate). If still no match → fall through to per-op approval. Documented in test.

**Explicit `--session <id>` (separate from auto-match):** continues to behave as today (Plan 4a). When supplied, the daemon uses that specific session and does not consult auto-match. Explicit `--session <id>` for a session that exists but does not match still falls back to per-op approval (no behavioral change). Auto-match is ONLY consulted when `--session` is absent.

### TTL hard cap raise

Plan 4a caps session TTL at 15 min (`TTL_MAX_MS = 900_000`, source: `src/daemon/approvals/session.ts:66,252`). The current overflow error is `bad_request` ("ttl_ms cannot exceed 900000ms (15 minutes)."). This burst:

- Raises `TTL_MAX_MS` to 60 * 60 * 1000 (60 min).
- Adds new explicit error code `session_ttl_exceeds_cap` (registered in `src/shared/error-codes.ts`), replacing the `bad_request` throw for this specific case. Code is exit 2 (USAGE) with `message` interpolating the actual cap.

Reasoning for the raise:
- The previous cap was set when sessions were minted via a hidden CLI flag (low information — user might be zero-seconds-informed).
- The new affordance presents the dropdown at the moment of consent inside the approval card, with the matching pattern visible.
- 15 min is too short for realistic provisioning flows (capturing 3 secrets across 3 dashboards + verifying in destinations often exceeds 15 min).

### Status surface

`secret-shuttle status` (and `status --json`) gain a new field:
```json
{
  "active_sessions": [
    {
      "id": "sess_abc",
      "pattern_summary": "template-run on ss://stripe/prod/STRIPE_KEY via vercel-env-add (name=STRIPE_KEY, environment=production)",
      "expires_at": "2026-05-27T14:32:00Z",
      "minutes_remaining": 12
    }
  ]
}
```

The agent reads this to know whether subsequent ops in the same shape will be silent. If the agent observes `active_sessions: []`, it knows the next op will pop a hub approval — useful for "I'm about to ask you to approve" messaging in advance. Owner-scoped: agents see only their own sessions.

### Tests

- `approval-ui-session-affordance.test.ts`: drift-guard text patterns on the new HTML/JS in `ui.html` (checkbox + dropdown + POST body shape).
- `infer-session-pattern.test.ts`: pure-function test of pattern derivation from `BatchState.plan`. Coverage:
  - single-group, multi-group, mixed-provider, all-capture, single-existing cases
  - single-entry `(template_id, source, env, destination-defining-params)` groups produce one exact-ref pattern (not suppressed)
  - **multi-environment**: a single ref pushed to `vercel:production` AND `vercel:preview` (same env-var `name`) produces TWO patterns, each with the corresponding `required_params.environment`; both share the same `required_params.name`
  - **multi-repo**: same ref pushed to two distinct GitHub Actions repos (e.g., `repo=patryk/a` and `repo=patryk/b`, same secret `name`) produces TWO patterns, each with the corresponding `required_params.repo` value (the template takes one combined `owner/repo` string)
  - **same scope, different env-var names**: two refs pushed to `vercel:production` under different env-var names (e.g., `STRIPE_KEY` and `OPENAI_KEY`) produce TWO patterns — `name` is destination-defining, so each variable is consented to individually. No single broader pattern covers both.
  - **template without registered destination-defining-params**: derivation **excludes** that destination from the patterns (fail-closed). If at least one destination remains registered, the affordance still renders with a footer notice about the excluded destinations. If ALL destinations are unregistered, derivation returns empty patterns and the affordance does not render. (This is the derivation path. The `SessionStore.create` / `createForOwner` paths still accept empty `required_params` patterns for manual / CLI use — only derivation fails closed.)
- `session-matcher-required-params.test.ts`: pure-function test of the extended `templateRunMatches`. Coverage:
  - `required_params` empty/absent → today's behavior (ref + template_id only)
  - all `required_params` keys present and equal in binding → match
  - one `required_params` key missing in binding → no match
  - one `required_params` value differs → no match
  - binding has extra keys not in `required_params` → match (pattern constrains only what it lists)
  - strict equality on values: `"production"` ≠ `"Production"` ≠ `" production"` (no normalization, no case-fold)
- `destination-defining-params-config.test.ts`: assertions:
  - Every shipped template (every entry in the template registry) has a registered entry in `DESTINATION_DEFINING_PARAMS`. Missing → test fails.
  - For each `DESTINATION_DEFINING_PARAMS[t]` key `k`, the template `t` actually consumes `k` somewhere — but **not** by simple `⊆ TemplateDefinition.required_params`. Templates split params across multiple consumption sites: `args` (vercel-env-add uses `{{name}}` and `{{environment}}`), `additionalArgs` (cloudflare-secret-put consumes `env`, supabase-edge-secret-set consumes `project_ref`), `destinationEnvironment` (github-actions-secret-set consumes `repo`), and `validateParams`. The test therefore validates against the **union of param-references across all four sites** — concretely, it parses `{{...}}` placeholders from the `args` string array, calls `additionalArgs({})` with empty params and observes any thrown errors / consumed-key references via a recording stub, inspects `destinationEnvironment` source / via the same stub pattern, and reads explicit param accesses in `validateParams`. The exact implementation: a small helper `collectAllParamRefs(template)` that returns the set of param keys the template touches anywhere; the assertion is `DESTINATION_DEFINING_PARAMS[t] ⊆ collectAllParamRefs(t)`.
  - Alternative (acceptable simpler implementation): each template exports a `sessionDefiningParams: readonly string[]` field directly (collapsed into the template definition); the test asserts the central `DESTINATION_DEFINING_PARAMS` map matches every template's declared `sessionDefiningParams`. This pushes the source of truth into the template files themselves and removes the indirection — preferred long-term, see §8 risk #6.
  - Startup warning fires when a registered template lacks a destination-defining-params entry (verified by a separate test that registers a stub template without the config and asserts the warning is logged).
- `session-store-create-for-owner.test.ts`: `createForOwner` stamps the supplied owner; ALS context is not consulted.
- `approval-ui-creates-sessions.test.ts`: POST `/ui/approvals/:id/approve` with `session: { ttl_minutes: 15 }` creates **N independent SessionGrants** (one per derived pattern) all owned by the approval grant's `owner_agent_id`. If any grant creation throws, all previously-minted grants from this batch are rolled back; the approval grant itself still records (the rollback is session-creation-only).
- `approval-ui-bounded-json.test.ts`: the approve route parses its body via the relocated `readBoundedJson` helper; oversize body → `request_too_large`; malformed JSON → `bad_request`; missing `session` key → no session minted, approval succeeds normally.
- `require-approvals-auto-match.test.ts`: matching active session silently satisfies a matching operation; expired / revoked / exhausted candidates are skipped; max_uses race retries once then falls through.
- `session-ttl-cap-bump.test.ts`: TTL of exactly 60 min accepted; 60 min + 1 ms rejected with `session_ttl_exceeds_cap`; the explicit code replaces the prior `bad_request` for this case.
- `status-active-sessions.test.ts`: `status --json` includes the new field, owner-scoped; empty array when no sessions; for a mixed-batch approval with N derived patterns, the field shows N entries.

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

- Every code block is **runnable as written for its phase**: bootstrap-time commands (e.g., `npx secret-shuttle init`, `secret-shuttle provision --infer`) require zero substitution. Continuation commands that pass ids returned from a prior step use `<batch_id_from_prior_step>` / `<approval_id_from_prior_step>` placeholders — the prose surrounding the code block names them as "interpolate the ids the previous step returned." Avoid placeholders that require config-time substitution before any command works (e.g. `<URL>`, `<API_KEY>`).
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
# → If the inferred yml is fully executable: returns approval_required with details.batch_id + details.approvals[].
#   If not: returns { needs_edit: true, yml_path, issues[] } — show the user the issues and ask for edits.
# Once approved, continue with the ids the prior step returned:
secret-shuttle provision --continue \
  --batch <batch_id_from_prior_step> \
  --approval-id <approval_id_from_prior_step>

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
| `approval_required` | null (human required) | Approval popup opens. Wait, or pass `--approval-id` to retry. |
| `secret_not_found` | null | Use `secrets list` to see what's available. |
| `infer_no_env_example` | null (human required) | Create a `.env.example` listing your secret names. |
| `infer_yml_exists` | `secret-shuttle provision --infer --force` (or `--dry-run`) | Generated yml would overwrite an existing file. |
| `command_renamed` | (printed in error) | A verb was renamed; the error names the replacement. |

For a provision batch that ends `failed_partial`, the response carries a non-null `next_action` (typically `secret-shuttle provision --continue --batch <id>`) — run it to resume from the failed step. Same rule everywhere: **trust `next_action` over error_code recognition**.

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

**Two distinct read paths — corrects v1 spec ("no new audit fields needed" was wrong):**

| Mode | Source of truth | Completeness |
|---|---|---|
| `--batch <batch-id>` | `BootstrapStore.get(batch_id)` (live `BatchState`) | Full plan + step results + per-destination push outcomes. The richest view. Returns `audit_batch_not_found` if the batch has been pruned from the operational store. |
| `--since <window>` | Audit log file under `<SHUTTLE_HOME>` (durable history) | Grouped by `batch_id` audit field (see below). Per-step ref + source_kind + destination shorthand list come from the NEW durable fields added to `bootstrap_step` rows in this burst (`batch_id`, `source_kind`, `destination_shorthands[]`, `destinations_ok_count`, `destinations_failed_count`). The pre-burst audit shape did NOT carry enough to reconstruct destination shorthands or push outcomes — the v1 spec's "reconstructable from existing fields" claim was wrong. See "Required durable audit fields" below for the additions and rationale. |

The `audit` route tries `BootstrapStore` first when given `--batch`; on miss it falls back to audit-log reconstruction with a `details.reconstructed_from: "audit"` flag in the response (so the caller knows the view may be partial — destination push results are not always durably recorded today).

**Required durable audit fields (corrects v1 spec — destination reconstruction was overclaimed):**

`DaemonAuditEvent` (in `src/daemon/audit.ts`) gains:
```ts
batch_id?: string;
// Set on every bootstrap_plan and bootstrap_step row, AND on every inner
// template_run row written under bootstrapAuthority (the executor calls
// `runTemplateCore` with a context object that already carries batch_id;
// this burst surfaces it to the audit row).
// On audit consumption, batch_id is the join key between coarse-grained
// (bootstrap_step) and fine-grained (template_run) rows.

source_kind?: string;
// Set on bootstrap_step rows ("capture" | "random_32_bytes" | "random_64_bytes" | "existing").
// Sourced from BatchState.plan[i].source.kind at audit-write time.

destination_shorthands?: string[];
// Set on bootstrap_step rows. The human-readable destination list as it
// appeared in the yml ("vercel:production", "github-actions:patryk/repo").
// Sourced from BatchState.plan[i].destinations[*].shorthand at audit-write
// time — the shorthand is already persisted in ResolvedDestination.shorthand
// (src/daemon/bootstrap/store.ts:11), so no new reconstruction needed.
// Per-destination ok/error_code remains inside the operational BatchState;
// the audit row carries only the destination LIST as durable context.

destinations_ok_count?: number;
destinations_failed_count?: number;
// Set on bootstrap_step rows. Per-destination outcome counts, computed
// from the StepResult.destinations_pushed list (already tracked by the
// executor — see src/daemon/bootstrap/executor.ts:225). Enables the
// summary to display "✓ 2/2 destinations" without consulting BatchState.
```

All four fields are additive optional. Existing audit rows without them remain valid; the summary surfaces "—" or "(unknown)" where missing.

**Why both `bootstrap_step.destination_shorthands` AND `template_run.batch_id`:**
- `bootstrap_step` rows give a self-contained per-secret summary line (ref, source_kind, destinations attempted, push outcome counts). This is what `audit --since` lists.
- Inner `template_run` rows carrying `batch_id` enable a drilled-down view (`audit --batch <id>` reconstructed-from-audit fallback) — without it, a pruned batch shows no per-destination detail, only the bootstrap_step summary. With it, the drill-down can show "template_run vercel-env-add → vercel.com → production: ok" per push.
- Operationally cheap: `bootstrapAuthority` already carries the batch_id; one extra field per audit call.

This is the explicit answer to the reviewer's "either propagate batch_id to inner template_run rows OR add destinations[] to bootstrap_step" — we do both, because each supports a different summary mode.

`approved_at` for the batch summary is derived from the `approval_granted` audit row matching the batch's `approval_id`. Both `actor_agent_id` and `session_id` (already durable per Burst 4) flow through unchanged.

**Implementation:** `src/cli/commands/audit.ts` + daemon route `POST /v1/audit/summary` (CLI is a thin client; daemon owns the file read). Audit-log reading: stream the JSONL file from EOF backwards until the time window is satisfied, parse, group by `batch_id`. No new on-disk format.

**Owner scoping:** by default, the agent calling `audit` sees only its own actions (`actor_agent_id` filter, matching the owner-enforcement model from Burst 4). Root can pass `--all` to see every actor.

**Error codes:**
- `audit_window_invalid` (2, USAGE): malformed `--since`.
- `audit_batch_not_found` (3, NOT_FOUND): `--batch <id>` doesn't exist in operational store AND no audit rows match the id (with owner-scoped non-disclosure: cross-owner returns the same code).

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

- `audit.test.ts`: text + JSON format snapshots; window parsing (`5m`, `1h`, `1d`); cross-owner non-disclosure.
- `audit-route.test.ts`: daemon `POST /v1/audit/summary` route exists; owner-scoped; `--all` requires root.
- `audit-batch-live-vs-reconstructed.test.ts`: `--batch <id>` reads `BootstrapStore` first; on miss, falls back to audit-log reconstruction with `details.reconstructed_from: "audit"` set; cleanly missing both → `audit_batch_not_found`.
- `audit-fields-bootstrap-step.test.ts`: `bootstrap_step` audit rows written by the executor carry `batch_id`, `source_kind`, `destination_shorthands[]`, `destinations_ok_count`, `destinations_failed_count`. Per-destination ok/error stays in operational `BatchState`, NOT in the audit row.
- `audit-fields-template-run-batch-id.test.ts`: inner `template_run` rows written under `bootstrapAuthority` carry `batch_id` matching the parent `bootstrap_step` row. Standalone `template_run` calls (no bootstrap context) leave `batch_id` undefined.
- `audit-fields-backwards-compat.test.ts`: synthetic older-format rows without the new fields parse cleanly; summary output surfaces "—" or "(unknown)" for missing values; row count and grouping are unaffected.
- `provision-resume-hint.test.ts`: a `failed_partial` batch response carries `next_action: "secret-shuttle provision --continue --batch <id>"`; an abandoned batch does not; an expired-approval batch omits `next_action` and sets `details.requires_new_approval: true`.
- `cli-help-discoverability.test.ts`: `--help` no-args output includes the AGENT QUICKSTART line; `help` command output mentions SKILL.md.
- `readme-header.test.ts`: README starts with the agent callout block linking to SKILL.md.

---

## §5 — Implementation order & milestones

```
Days 1-3   §1   provision verb + --infer + bootstrap removal       (largest piece, foundation)
Days 4-6   §2a  Param-constraint primitive (Plan 4a contract       (security primitive — lands first
                evolution): SessionPattern.required_params,         in §2 so derivation can rely on it)
                destination-defining-params config, matcher
                extension, dedicated test pass
Days 7-9   §2b  Approval-UI session affordance + ui.html / body    (the visible UI surface)
                parsing / pattern derivation / owner stamping /
                auto-application
Day  10    §4   audit verb + resume hint                            (end-of-week-2 ship)
Days 11-13 §3   SKILL.md restructure + §4 discoverability tweaks    (reflects shipped verbs)
Days 14-15 —    Dogfood pass on a fresh project with a real agent
Days 16-17 —    CHANGELOG, version bump to v0.3.0, npm publish
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

6. **Destination-defining-params config drift.** Adding a new template (`railway-variable-set`, `clerk-env-set`, etc.) without a `DESTINATION_DEFINING_PARAMS` entry would mean that destinations using that template are **excluded** from any provision-derived session — pushes to those destinations always require fresh per-op approval. The user-visible symptom is "the session checkbox keeps appearing without that destination in the consent list" — annoying, not unsafe. The unsafe case (silent widening) is closed by the fail-closed derivation. Mitigations:
   - Startup-time daemon warning lists registered templates missing destination-defining-params entries. Operator sees it on first run.
   - `destination-defining-params-config.test.ts` asserts that **every shipped template has a registered entry**. CI fails when a template lands without its entry — catches the issue at PR time, before it ships.
   - Approval-card UI surfaces excluded destinations with an inline notice — the operator sees the drift the first time it bites.
   - Long-term: collapse template definitions and destination-defining-params into one file per template; rely on a structural test for "every template exports a `sessionDefiningParams` field."

---

## §9 — Success criteria

This burst is successful if all of the following are true:

- An agent reading the new SKILL.md (above the fold only) can execute a full provision → continue → audit cycle on a fresh test project without errors.
- `secret-shuttle provision --infer` on a representative project (Next.js + Stripe + Supabase) produces a yml the user only needs to edit destination targets for.
- A second matching operation within 15 min of approval succeeds silently (no hub popup) when the session affordance was checked.
- `secret-shuttle audit --since 5m` after a batch produces output the agent can include verbatim in its message to the user as proof.
- v0.3.0 is published to npm and the demo URL still works.

If any of these fail in the dogfood pass, the spec is amended and a v0.3.1 follow-up is scoped before public announcement.
