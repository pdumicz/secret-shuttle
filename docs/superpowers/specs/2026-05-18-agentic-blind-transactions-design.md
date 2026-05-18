# Agentic Blind Transactions — Design Spec

Date: 2026-05-18
Status: Approved for planning
Topic: Make the human responsible for policy approval only, not browser choreography.

## 1. Core Product Requirement

Secret Shuttle today makes the agent do browser choreography under blind mode: focus
fields, click save, end blind mode, and ask the human to babysit each step. The human
ends up doing mechanical work (focus this, click that, confirm the screen is clean)
instead of the one thing only a human should do: approve policy.

After this work the agent can:

1. Navigate and prepare a page while observation is still safe.
2. Ask the daemon to perform the entire secret-bearing transaction.
3. Receive only status, refs, and non-secret proof signals.

The human approves "use secret X on domain Y for action Z (including auto-resume if
proven safe)" and nothing else. The human does not focus fields, click save, hide
secrets, end blind mode, or read instructions.

### 1.1 Framing of the security change (signed off)

Auto-resume of observation is **not** the new default. It is a **proven-safe exit
path**. The existing human-approved `POST /v1/blind/end` remains the fallback and
keeps the hardened invariant intact (commits `fda77d9`, `c00d130`, `4e5c145`,
`9850232`, e2e `stripe-to-vercel`). The new atomic operations add an automated exit
that fires **only** when both a success condition and a conservative absence proof
pass. Any uncertainty keeps blind mode active and returns
`next: "manual_recovery_required"` — identical to today's post-inject behavior.

This design never weakens `/v1/blind/end`. Auto-resume is a **separate, separately
audited internal path** (§7).

## 2. How This Fits the Existing Architecture

Relevant existing pieces (confirmed by reading the code):

- `DaemonServices` ([src/daemon/services.ts](../../../src/daemon/services.ts)) holds
  `lock`, `vault`, `approvals`, `blind`, `browser`, `cdp`, `cdpProxy`,
  `browserSessionId`. New in-memory stores hang here.
- `DaemonBlindModeState` ([src/daemon/services-blind.ts](../../../src/daemon/services-blind.ts))
  is the operative blind flag the CDP proxy gates on (`start/end/current/assertForDomain`).
- The CDP proxy ([src/daemon/proxy/cdp-proxy.ts](../../../src/daemon/proxy/cdp-proxy.ts))
  drops **all** Chrome→agent traffic and blocks **all** agent→Chrome traffic while
  `blind.current() !== null`, and `severAgentConnections()` force-closes agent sockets
  and bumps an epoch. **The daemon's own `CdpClient` is a separate listener on the same
  transport and is unaffected by blind mode.** This is the core enabler: the daemon
  retains full CDP during blind; only the agent is blacked out.
- `CdpBrowserOps` ([src/daemon/chrome/internal-ops.ts](../../../src/daemon/chrome/internal-ops.ts))
  implements `BrowserOps`: `pickPage`, `attach`, `evaluate`, `getFocusedBackendNodeId`,
  `readFocusedFingerprintAndDomain`, `captureFocused`, `injectFocused`,
  `fieldFingerprint(domain,target,backendNodeId,field)`.
- Approval: `ApprovalBinding`/`ApprovalStore`/`bindingsMatch`
  ([src/daemon/approvals/store.ts](../../../src/daemon/approvals/store.ts)) with strict
  field-equality matching; `requireApproval`
  ([src/daemon/approvals/require-approval.ts](../../../src/daemon/approvals/require-approval.ts))
  (production OR `force` → human UI; else auto-grant). Plain-language approval UI
  ([src/daemon/approvals/ui.html](../../../src/daemon/approvals/ui.html)) keyed by
  `g.action`.
- Inject route ([src/daemon/api/routes/secrets.ts:215](../../../src/daemon/api/routes/secrets.ts))
  is the model to mirror: pre-read → enforce domain → refuse if blind already active →
  build binding → `requireApproval` → `blind.start` → `disableObservationDomains` →
  `severAgentConnections` → post re-read & compare → `injectFocused`; pre-write failure
  ends blind and rethrows (safe), post-write failure keeps blind active.
- Templates: `TemplateRegistry`, `TemplateDefinition`, `runTemplate` (stdin secret,
  scrubbed `buildChildEnv`, sha256, `destinationEnvironment`) under
  [src/daemon/templates/](../../../src/daemon/templates/).
- `doctor` ([src/cli/commands/doctor.ts](../../../src/cli/commands/doctor.ts)) reads
  `GET /v1/health` ([src/daemon/api/routes/health.ts](../../../src/daemon/api/routes/health.ts)).
- CLI is Commander; commands in [src/cli/commands/](../../../src/cli/commands/),
  registered in [src/cli/index.ts](../../../src/cli/index.ts); the client helper is
  `daemonRequest(method,path,body)`.
- Tests use `node:test` and the wire-the-daemon-with-`stubBrowser` pattern from
  [src/e2e/stripe-to-vercel.test.ts](../../../src/e2e/stripe-to-vercel.test.ts).

The new work is additive routes, one new in-memory store, an extended `BrowserOps`
surface, an extended approval binding + UI, new audited internal auto-resume, new
templates, and the agent skill + installers.

## 3. Component 1 — Opaque Browser Handles

### 3.1 Purpose

Let the agent mark UI elements **while observation is still safe** so the daemon can
operate them later under blind mode without the agent ever holding a raw DOM reference.

### 3.2 Store

New `BrowserHandleStore` in `DaemonServices` (sibling to `approvals`/`blind`).

- **In-memory only. Never persisted.** Cleared whenever the browser (re)starts
  (keyed implicitly to the current `browserSessionId`).
- **Label namespace is per browser session.** A new `browser start` empties the store.
- **TTL:** each handle expires 5 minutes after creation. Expired handles are treated
  as absent (fail closed).
- **Last-write-wins per label:** marking an existing label replaces that label's
  handle.

Handle record (internal — never returned raw to the agent):

```ts
interface BrowserHandle {
  handle_id: string;          // opaque random id (not exposed; label is the agent-facing key)
  label: string;              // agent-chosen, non-secret, shown in approvals
  target_id: string;          // CDP page target
  domain: string;             // normalized hostname at mark time
  page_url_host: string;      // location.host at mark time (non-secret context)
  page_title: string;         // document.title at mark time (non-secret context)
  backend_node_id: number;    // CDP DOM backend node id
  handle_fingerprint: string; // sha256(JSON{domain,target,backendNodeId,tag,type,name,id,editable,role,ariaLabel,kind}).slice(16)
  element_kind: "field" | "button" | "link" | "other";
  created_at: number;
  expires_at: number;
}
```

`handle_fingerprint` extends the existing `fieldFingerprint` seed with `role` and
accessible-name (`ariaLabel`) and `kind` so revalidation is anchored on more than the
backend node id. Raw role/name/value is **never** stored or returned — only the hash.

### 3.3 CLI

```
secret-shuttle browser mark focused   --as <label>
secret-shuttle browser mark next-click --as <label> [--timeout-ms 30000]
secret-shuttle browser marks
```

Two marking primitives, both observation-safe (used pre-blind, on non-secret
controls), both producing the same opaque handle record with `element_kind` derived
from the captured element (`input`/`textarea`/contenteditable → `field`;
`button`/`[role=button]`/`input[type=submit|button]` → `button`; `a[href]` → `link`;
else `other`):

- **`mark focused`** — reads `document.activeElement` (the same observation-safe path
  `readFocusedFingerprintAndDomain` already uses). Best for focusable fields.
- **`mark next-click`** — solves the "many buttons are not focusable without
  activating them" problem. The daemon (via its **internal** CDP, not the agent)
  installs a one-shot capturing-phase pointer/click listener on the page. On the next
  user click it records the target element (backend node id, fingerprint, kind),
  then calls `preventDefault()` + `stopImmediatePropagation()` so the click **does
  not activate** the control (no navigation, no reveal, no submit), removes the
  listener, and disarms. Bounded by `--timeout-ms` (default 30000, hard cap 120000);
  on timeout it disarms and fails closed with no handle stored. The listener is
  guaranteed-removed in a `finally` even on error/detach. Only the hashed fingerprint
  and non-secret metadata are stored — never any value or raw DOM text.

Either primitive is valid **only before** blind mode for that page; marking is
rejected if a blind window is already active (no observation of a possibly
secret-bearing page).

`browser marks` returns, per label, **only**: `label`, `element_kind`, `domain`,
`page_url_host`, `created_at`, `expires_at`, `valid` (a fresh revalidation boolean).
It **does not** expose field values, `innerText`, `page_title`, the fingerprint, or
any DOM text. `value_visible_to_agent: false` is included for consistency.

### 3.4 Revalidation (enforced before every use)

Before any handle is operated on, the daemon re-resolves it and **fails closed** on
any mismatch:

1. Handle exists for the label and is not expired.
2. `backend_node_id` still resolves (`DOM.describeNode`) on `target_id`.
3. Recomputed `domain`, `target_id`, and `handle_fingerprint` exactly equal the
   stored values.
4. `element_kind` permits the requested operation (inject/read → `field`; click →
   `button`/`link`).

Validate-on-use is the enforcement mechanism. It inherently catches navigation,
target detach, domain change, and backend-node mismatch (the node will not resolve or
the fingerprint will differ). Proactive `Target.detached`/`Page.frameNavigated`
invalidation is **out of scope for v1** because validate-on-use is sufficient and
fail-closed.

No selector-based marking in v1.

## 4. Component 2 — `inject-submit`

### 4.1 CLI

```
secret-shuttle inject-submit \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --domain vercel.com \
  --field-handle value-field \
  --submit-handle submit-button \
  --success-text "Environment Variable Added" \
  [--success-timeout-ms 15000]
```

`--success-text` is a non-secret human-supplied marker. It is part of the approved
plan and shown in the approval UI. `--success-timeout-ms` has a default (15000) and a
hard cap (e.g. 60000).

### 4.2 Route — `POST /v1/secrets/inject-submit`

New approval action `inject_submit`. Flow:

1. `services.lock.requireKey()`; require `services.browser !== null`.
2. Refuse if a blind window is already active (`blind.current() !== null`) — no
   clobber (mirrors current inject guard).
3. Load secret; `assertSecretActionAllowed(secret, "inject_into_field")`.
4. **Revalidate `--field-handle` and `--submit-handle` while observation is still
   safe** (§3.4). Field handle must be `element_kind: "field"`; submit handle must be
   `"button"` or `"link"`. Recompute the current page domain from the field handle;
   `enforceDomain(domain, secret.allowed_domains, "inject-submit")`; if `--domain`
   given, require `domainMatches`.
5. Build one deterministic `ApprovalBinding` (so initial + retry consume match):
   - `action: "inject_submit"`, `ref`, `environment`, `destination_domain`,
     `allowed_domains`
   - `field_fingerprint` = field handle fingerprint
   - `submit_fingerprint` = submit handle fingerprint (new binding field)
   - `success_condition` = the `--success-text` string (new binding field)
   - `auto_resume: true` (new binding field; constant for this action — encodes that
     the human is approving the auto-resume behavior, §6.4)
   - `field_handle_label`, `submit_handle_label` (new display-only fields)
   - `page_title`, `page_url_host` (display-only, from the field handle)
6. `requireApproval({ ..., force: true })` — **always** human-approved regardless of
   environment (this operation is powerful and includes auto-resume; consistent with
   `blind_end`'s `force:true`). Supports `approval_id`/`wait_for_approval:false`
   retry like other routes.
7. After approval: `blind.start(domain, "inject_submit")` →
   `disableObservationDomains(cdp)` → `cdpProxy.severAgentConnections()` (identical
   to current inject).
8. **Re-revalidate both handles** (post-approval, pre-write) — fail closed; if this
   fails *before any write*, `blind.end()` and rethrow (safe, mirrors current inject
   pre-write path).
9. Focus + inject the secret into the field handle's backend node.
10. Click the submit handle's backend node.
    From step 9 onward the secret is on the page: **failure must not auto-resume**;
    blind stays active, response is fail-closed (`submitted: "unknown"`, §4.3).
11. Wait (bounded by `--success-timeout-ms`, poll ~200ms) for the success condition:
    the daemon internally checks whether `--success-text` appears in the visible text
    (`innerText`) of the destination-domain page target(s) — the same surface set the
    absence proof scans (§5.1), restricted to the bound `destination_domain`. Observed
    text is **never** returned.
12. If success observed → run the **Absence Proof** (§5) for the exact injected secret.
13. **Auto-resume decision:** if success observed **and** absence proof `passed`,
    invoke the audited internal auto-resume (§7) → `blind_mode: false`. Otherwise keep
    blind active → `next: "manual_recovery_required"`.
14. `vault.markUsed`, audit (§8).

### 4.3 Response (enum-only; never raw text/DOM/snippets)

Success + proven safe:

```json
{
  "submitted": true,
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "domain": "vercel.com",
  "success_signal": "text_matched",
  "absence_proof": "passed",
  "blind_mode": false,
  "value_visible_to_agent": false
}
```

Not provably safe (any uncertainty — see §5.3):

```json
{
  "submitted": "unknown",
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "domain": "vercel.com",
  "blind_mode": true,
  "next": "manual_recovery_required",
  "value_visible_to_agent": false
}
```

The response never includes observed success text, DOM snippets, failure snippets,
matched substrings, or counts that could leak content. `success_signal` and
`absence_proof` are fixed enums. In the success response they are **always**
`"text_matched"` and `"passed"` — that response is emitted only when both hold. Every
other state (success text not observed, absence inconclusive, any fail-closed trigger
in §5.3) produces the second response shape, which **omits** `success_signal`/
`absence_proof` and returns `submitted: "unknown"` + `next: "manual_recovery_required"`.
There is no response variant that surfaces a negative signal value.

## 5. Component — The Absence Proof

The daemon proves the **exact raw secret value** is absent from every
daemon-enumerable, agent-observable surface before any auto-resume.

### 5.1 Surfaces scanned

For every page target the daemon can enumerate, attach and evaluate a scan over:

- the top document and **all same-origin frames**
- **open** shadow roots (recursively)
- `input`/`textarea` `.value`
- contenteditable text
- visible text (`innerText`)
- attributes: `value`, `placeholder`, `title`, `aria-label`, every `data-*`
- `location.href`, `location.search`, `location.hash` (the secret could have landed
  in the URL)

Match is **exact substring of the raw secret value**. The secret is held only in
daemon memory and is never logged, never returned, never put in audit records.

### 5.2 Pass condition

`passed` ⇔ the scan completed over all enumerable surfaces with **zero** occurrences
and **no inconclusive condition** (§5.3).

### 5.3 Fail-closed matrix (any one ⇒ not `passed` ⇒ stay blind)

- exact secret still present on any scanned surface
- a **cross-origin iframe** (frame access throws / opaque origin)
- an **inaccessible / detached frame**
- **navigation uncertainty** (page navigated or load state changed mid-scan)
- **target crash or detach** during the operation
- **timeout** (success wait or scan exceeds bound)
- **any CDP call or `Runtime.evaluate` error**
- **canvas/WebGL-only UI** that the daemon detects it cannot read as text and which
  the success condition did not positively clear

### 5.4 Documented limitation (verbatim, ships in threat-model.md)

> Transformed or derived forms of the secret (trimmed, base64-encoded, split,
> re-encoded) are out of scope for the automated absence proof. The proof is about
> raw-value exposure to the agent. Closed shadow roots and canvas/WebGL pixels are
> not enumerable by any page JavaScript (including the agent's own tools after
> resume); the proof's guarantee is "the raw secret is absent from all
> daemon-observable surfaces," and auto-resume additionally requires the approved
> success condition to have been observed. When the daemon cannot establish this, it
> keeps blind mode active and the human-attested `blind end` remains the recovery
> path.

## 6. Component 3 — `reveal-capture`

### 6.1 Capture model

Many real UIs **create, replace, or unmask the secret element only after the reveal
click**, so a pre-reveal `--field-handle` cannot be required in general. The secret
element often does not exist (or is a different node) until reveal happens. Capture
therefore supports three modes; exactly one is chosen per invocation and recorded in
the approval binding so the human approves *where the secret will be read from*:

- **`field`** — `--field-handle <label>`: a field marked before reveal that is stable
  across reveal (the original spec's model; still supported where it applies, e.g.
  reveal merely unmasks an existing input).
- **`container`** — `--container-handle <label>`: a **stable ancestor** marked before
  reveal (e.g. the modal/card/row that persists). After reveal, the daemon resolves
  the secret-bearing element **within that container's subtree**, daemon-only.
- **`focused-after-reveal`** — `--container-handle <label>` plus
  `--capture focused-after-reveal`: after reveal the daemon reads
  `document.activeElement`, but **only if** it is a descendant of the approved
  container (some UIs focus the revealed field).

```
# unmask-in-place
secret-shuttle reveal-capture --name STRIPE_WEBHOOK_SECRET --env production \
  --source stripe --domain dashboard.stripe.com \
  --reveal-handle reveal-button --field-handle secret-field \
  [--hide-handle hide-button] --allow-domain dashboard.stripe.com

# element appears after reveal, scoped to a stable container
secret-shuttle reveal-capture --name STRIPE_WEBHOOK_SECRET --env production \
  --source stripe --domain dashboard.stripe.com \
  --reveal-handle reveal-button --container-handle secret-card \
  [--capture focused-after-reveal] [--hide-handle hide-button] \
  --allow-domain dashboard.stripe.com
```

Post-reveal resolution within a container (daemon-only, observation already blind):
the daemon enumerates candidate secret holders inside the approved container subtree
— a single `input`/`textarea` with a non-empty `.value`, a single contenteditable
with non-empty text, or a single text-bearing element whose content is the freshly
revealed value. Resolution **fails closed** (stay blind,
`captured: "unknown"`) if there are **zero or more than one** candidates (ambiguous),
if the resolved element is **not contained** by the approved container's backend node
(DOM containment proof via `DOM.describeNode`/`Runtime.callFunctionOn`
`a.contains(b)`), or on any CDP/evaluation error. The human approves the container +
strategy; the daemon proves containment before reading. The agent never sees the
element or its value.

### 6.2 Route — `POST /v1/secrets/reveal-capture`

New approval action `reveal_capture`. Unlike today's `capture` (which requires a
pre-existing blind window), `reveal-capture` **owns** its blind window like inject
does.

1. `requireKey`; require browser; refuse if blind already active.
2. Validate inputs: exactly one of `--field-handle` or `--container-handle` (the
   latter optionally with `--capture focused-after-reveal`). Revalidate
   `--reveal-handle` (button/link), the chosen field/container handle, and
   `--hide-handle` if supplied (button/link), while observation is safe. Derive
   domain from the reveal handle (and, when present, require the field/container
   handle to share it); production requires ≥1 allowed domain; `enforceDomain`.
3. Build deterministic binding: `action: "reveal_capture"`, `planned_ref`,
   `environment`, `destination_domain`, `allowed_domains`, `reveal_fingerprint`,
   `capture_mode` (`field` | `container` | `focused-after-reveal`),
   `field_fingerprint?` (mode `field`), `container_fingerprint?` (modes `container`/
   `focused-after-reveal`), `hide_fingerprint?`, `auto_resume: true`, handle labels +
   page context (display-only). `capture_mode`, `container_fingerprint`, and
   `reveal_fingerprint` are part of `bindingsMatch`.
4. `requireApproval({ force: true })`.
5. `blind.start(domain,"reveal_capture")` → `disableObservationDomains` →
   `severAgentConnections`.
6. Re-revalidate the reveal + field/container handles (pre-action; failure here =
   nothing revealed → `blind.end()` + rethrow, safe).
7. Click reveal handle.
8. Resolve the secret element per `capture_mode` with the containment/ambiguity
   fail-closed rules of §6.1, then read its value internally (daemon-only).
9. `vault.upsertSecret(...)` (value never leaves the daemon).
10. Click the hide handle if supplied; otherwise blank **all** pages via the existing
    `blankAllPages(cdp)` (fail-closed if any page does not reach `about:blank`),
    matching the current hardened `/v1/blind/end` behavior.
11. Absence proof (§5) for the captured value.
12. Auto-resume iff captured non-empty **and** hide/blank succeeded **and** absence
    proof `passed`; else stay blind / `manual_recovery_required`.
13. Audit (§8).

### 6.3 Response

```json
{ "captured": true, "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "fingerprint": "hmac-sha256:…", "absence_proof": "passed",
  "blind_mode": false, "value_visible_to_agent": false }
```

or fail-closed:

```json
{ "captured": "unknown", "blind_mode": true,
  "next": "manual_recovery_required", "value_visible_to_agent": false }
```

### 6.4 Approval binding & UI (applies to §4 and §6)

`ApprovalBinding` gains optional fields: `submit_fingerprint`, `reveal_fingerprint`,
`hide_fingerprint`, `container_fingerprint`, `capture_mode`, `success_condition`,
`auto_resume`, plus display-only `field_handle_label`, `submit_handle_label`,
`reveal_handle_label`, `hide_handle_label`, `container_handle_label`. All non-display
fields are added to `bindingsMatch` (strict equality, consistent with the existing
function). Display-only fields are excluded from matching, like
`page_title`/`page_url_host` today. (Whether a handle was created via `mark focused`
or `mark next-click` is **not** part of the binding — only the resulting element's
fingerprint is.)

`ui.html` `human` map gains:

- `inject_submit`: "Inject secret `<ref>` into **<field label>** on `<domain>`, click
  **<submit label>**, wait for success, and **automatically resume observation only
  if the secret is verified gone**."
- `reveal_capture`: "Click **<reveal label>** on `<domain>`, capture the revealed
  secret into `<planned_ref>` (from **<field/container label>**, mode
  `<capture_mode>`), hide it, and **automatically resume observation only if the
  secret is verified gone**."

Both render an explicit, prominent line (styled like the existing `blind_end`
warning): **"Approving authorizes the daemon to auto-resume observation only if the
success and absence checks pass. If they do not, blind mode stays on."** The
collapsible "Technical details" shows the field/submit/reveal/hide fingerprints and
target id, mirroring the existing pattern. The success condition string is shown in
the main body (non-secret, part of the approved plan).

## 7. Auto-Resume as a Separate Audited Internal Path

Auto-resume is **not** a call to `/v1/blind/end` and must not weaken it.

- New internal function `autoResumeBlind(reason, proof)` (e.g. in a new
  `src/daemon/blind-auto-resume.ts`): asserts the success+proof preconditions, then
  calls `services.blind.end()` directly **without** an approval and **without**
  `blankAllPages` (the proof already established the secret is absent; the page is the
  proven-clean post-transaction state, not a forced blank).
- It writes its **own** audit record with a distinct action
  `blind_auto_resume` containing `{ ok, domain, op: "inject_submit"|"reveal_capture",
  success_signal, absence_proof }` — never the secret, never observed text.
- `/v1/blind/end` is unchanged: still `force:true` human approval + `blankAllPages`
  fail-closed. The human path remains the guaranteed recovery for every
  `manual_recovery_required` outcome.

## 8. Audit Events

Add to the daemon audit vocabulary (same `writeDaemonAudit` shape as existing
actions, never carrying secret/text):

- `inject_submit` — ok/fail, ref, environment, domain, `submitted`, `success_signal`,
  `absence_proof`, `blind_mode`.
- `reveal_capture` — ok/fail, ref, environment, domain, `captured`, `absence_proof`,
  `blind_mode`.
- `blind_auto_resume` — as in §7.
- `browser_mark` — ok/fail, label, element_kind, domain (no DOM text).

## 9. Component 4 — Provider Templates (stdin-safe subset only)

Ship only templates whose first-party CLI accepts the secret via **stdin or an
env-file read from stdin**. A CLI that requires the secret as an argv parameter
exposes it in the process table and **must not** ship as a Secret Shuttle template.

**Ship now** (new `TemplateDefinition`s under
`src/daemon/templates/builtin/`, registered in `TemplateRegistry`):

- `github-actions-secret-set` — `gh secret set <name>` (reads value from stdin),
  params: `name`, `repo`, optional `env`/`org`; `destinationEnvironment` from `env`.
- `cloudflare-secret-put` — `wrangler secret put <NAME>` (reads value from stdin),
  params: `name`, optional `env`.
- `supabase-edge-secret-set` — `supabase secrets set` reading the secret from a
  file. **Portability note (P2b):** `--env-file /dev/stdin` is **not portable**
  (no `/dev/stdin` on Windows, fragile on some shells). The delivery contract for
  this template is therefore: **either** verified true-stdin support on the target
  platforms, **or** the new `tmp_env_file_0600` delivery mode (below). Plain
  `/dev/stdin` must not be relied on.

**`TemplateDefinition.secret_delivery` gains a `"tmp_env_file_0600"` mode.** When a
CLI only accepts `--env-file <path>` (not true stdin), the daemon: creates a file in
a private daemon-owned dir with mode `0600`, writes `NAME=VALUE`, passes the path as
the env-file argument, and **unlinks it in a `finally`** (even on crash/throw),
scrubbing the buffer. Rationale that this still satisfies the no-argv-leak rule: the
secret never appears in argv or the process table; it lives only in a short-lived
`0600` file readable solely by the daemon user, deleted immediately after the child
exits. This mode is **opt-in per template**, used only where true stdin is
unavailable, and the temp-file lifetime + permissions are an explicit security
requirement (and a test).

**Defer with documented rationale** (do **not** ship; record in
`docs/roadmap.md` / template docs): `railway-variable-set` and `netlify-env-set`
(value forced onto argv by their CLIs), `clerk-env-set` (no first-party CLI for
setting secrets/env — configuration is dashboard/Backend-API only).

Exact argument vectors and stdin/env-file behavior for the three shipped templates
must be **verified against each CLI's current `--help` during implementation** (a
plan task), choosing `stdin` where supported and `tmp_env_file_0600` otherwise; the
delivery contract is fixed: stdin or `0600` temp env-file only, **never argv**. The
existing `runTemplate` already enforces stdin delivery, scrubbed `buildChildEnv`,
binary sha256 in the approval binding, and `destinationEnvironment` in the approval;
the `tmp_env_file_0600` path is a small additive extension to `runTemplate` (create/
chmod/write/pass-path/unlink-in-finally) plus new definitions + per-template
`validateParams`.

Template requirements (restated): secret delivered to the daemon-controlled child
**only** via stdin or a `0600` daemon-owned temp env-file (never argv); no
stdout/stderr secret echo (child stdio is `["pipe","ignore","ignore"]`); binary
sha256 shown in approval; destination environment in the approval binding. All but
the temp-env-file path are already satisfied by `runTemplate`.

## 10. Component 5 — Agent Skill + Installers

### 10.1 Canonical skill

Create `skills/secret-shuttle/SKILL.md` as the **canonical agent-facing operating
manual**. **Retire `skills/claude-code/SKILL.md`** (replace with the new path; update
`package.json` `files` and `README.md` references). The skill instructs the agent
(not a human) to:

- run `secret-shuttle doctor --json` first; start daemon/browser and unlock if needed
- prefer `template run` over generic browser ops
- `browser mark focused --as <label>` for focusable fields and
  `browser mark next-click --as <label>` for buttons/reveal/hide controls, **before**
  blind mode
- use `inject-submit` / `reveal-capture` for the secret-bearing transaction
- never screenshot / DOM-read / read page text / read network bodies / read clipboard
  while blind mode is active (even though the daemon does this internally — the agent
  must not)
- interpret enum responses; on `next: "manual_recovery_required"` do **not** attempt
  to resume observation itself — surface to the human (the human-approved `blind end`
  is the only recovery)
- only report non-secret signals (refs, fingerprints, domains, status enums)

The skill content is the single source of truth; installers derive platform files
from it.

### 10.2 Installers

```
secret-shuttle agent install claude     # → .claude/skills/secret-shuttle/SKILL.md
secret-shuttle agent install codex      # → AGENTS.md snippet
secret-shuttle agent install cursor     # → .cursor/rules/secret-shuttle.mdc
secret-shuttle agent install copilot    # → .github/copilot-instructions.md snippet
secret-shuttle agent print-skill-url
```

- Writes are **idempotent** and **non-clobbering**: snippet targets (`AGENTS.md`,
  `.github/copilot-instructions.md`) are written between
  `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->` markers; a second
  run replaces only the marked block. Full-file targets
  (`.claude/skills/secret-shuttle/SKILL.md`, `.cursor/rules/secret-shuttle.mdc`) are
  overwritten wholesale (they are owned by Secret Shuttle).
- Installers operate on the current working directory.
- `print-skill-url` prints a raw GitHub URL so the user can paste one line into an
  agent. Source of truth: add a `repository` field to `package.json`
  (`https://github.com/pdumicz/secret-shuttle`); derive
  `https://raw.githubusercontent.com/pdumicz/secret-shuttle/<branch>/skills/secret-shuttle/SKILL.md`,
  default branch `main`, overridable via `--branch`/`--ref` and a path constant.
- `README.md` gains: "For agents, paste this into your agent:
  `https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md`".

## 11. Component 6 — doctor / health

Extend `GET /v1/health` with an `agentic_browser` capability block:

```json
"agentic_browser": {
  "available": true,
  "browser_started": true,
  "proxy_active": true,
  "handles_supported": true,
  "marks_active": 2
}
```

`available` ⇔ daemon build supports `inject-submit`/`reveal-capture` **and** browser
+ proxy are up. `marks_active` is a count only (no labels, no DOM text — labels are
non-secret but the count is sufficient for a health check and avoids any temptation to
surface element context here).

`doctor` (text + `--json`) prints a line:
`agentic flows: available` / `unavailable (start browser)` derived from
`health.agentic_browser.available`.

## 12. `BrowserOps` Surface Extensions

Extend the `BrowserOps` interface (and `CdpBrowserOps`) — all daemon-internal, none
agent-reachable:

- `markFocused(): Promise<HandleDescriptor>` — activeElement → `{target_id, domain,
  page_url_host, page_title, backend_node_id, handle_fingerprint, element_kind}`
  (reuses `readFocusedFingerprintAndDomain` + `getFocusedBackendNodeId`, adds role/
  accessible-name into the fingerprint seed and `element_kind` derivation).
- `markNextClick(timeoutMs): Promise<HandleDescriptor>` — installs a one-shot
  capturing-phase listener via internal CDP; on the next click records the target
  element, calls `preventDefault()`/`stopImmediatePropagation()` (no activation),
  removes the listener (guaranteed in `finally`), and returns the same descriptor
  shape. Times out fail-closed with no handle.
- `revalidateHandle(h: BrowserHandle): Promise<void>` — §3.4; throws `ShuttleError`
  fail-closed on any mismatch.
- `injectIntoBackendNode(h, value): Promise<InjectResult>` — `DOM.focus`
  `{backendNodeId}`, assert `document.activeElement` resolves to the same backend
  node, then the existing `WRITE_SCRIPT` path.
- `clickBackendNode(h): Promise<void>` — resolve node → `Runtime.callFunctionOn`
  `function(){ this.click(); }` on the resolved object id; fail-closed on any error.
- `readBackendNodeValue(h): Promise<string>` — daemon-only field read for
  `reveal-capture` mode `field` (value never returned to the agent layer).
- `resolveWithinContainer(container: BrowserHandle, mode): Promise<{ value: string }>`
  — post-reveal, daemon-only. Enumerates candidate secret holders inside the
  container subtree (or, for `focused-after-reveal`, takes `document.activeElement`),
  proves DOM containment within the approved container backend node, requires exactly
  one unambiguous candidate, and returns its value. Throws fail-closed on zero/many
  candidates, containment failure, or any CDP/evaluation error (§6.1).
- `proveAbsence(secret: string): Promise<AbsenceProofResult>` — §5; returns
  `{ passed: boolean }` only (reasons are audited internally as enum, never returned
  to the agent).

The stub-browser test pattern from `stripe-to-vercel.test.ts` is extended to
implement these for unit/e2e tests.

## 13. Testing Strategy

`node:test`, build-then-`node --test`, `SECRET_SHUTTLE_NO_OPEN_URL=1`. Mirror the
existing daemon-wiring + `stubBrowser` approach.

- **Handle store unit tests:** TTL expiry, last-write-wins per label, session reset
  clears, `marks` exposes no DOM text/fingerprint, revalidation fail-closed cases
  (expired, node-gone, domain change, fingerprint mismatch, wrong `element_kind`).
- **`inject-submit` route tests:** approval required (`force:true`) even for
  development env; blind starts after approval; refuses if blind already active;
  pre-write handle change → blind ends + error (safe); post-write failure → blind
  stays active + `submitted:"unknown"`; success+proof → `blind_mode:false` and a
  `blind_auto_resume` audit record (distinct from `blind_end`); proof inconclusive →
  stays blind + `manual_recovery_required`.
- **`mark next-click` tests:** the intercepted click is prevented (no
  activation/navigation); listener removed after capture and on timeout; timeout
  stores no handle; produces the same handle record as `mark focused`.
- **`reveal-capture` route tests:** all three capture modes (`field`, `container`,
  `focused-after-reveal`); container resolution fail-closed on zero candidates, >1
  candidates, and non-contained element; hide-handle vs blank fallback; captured
  value never appears in any response (extend the existing "no raw secret in any
  response body" assertion).
- **Absence proof tests:** present-in-value, present-in-attribute,
  present-in-URL-hash, cross-origin-frame → inconclusive, evaluate-error →
  inconclusive, timeout → inconclusive. (Frame/shadow behaviors driven through the
  stub.)
- **Approval binding/UI:** new fields in `bindingsMatch` (mismatch → rejected);
  retry path uses identical deterministic binding; `ui.html` renders the
  auto-resume disclosure for both actions.
- **Templates:** registry lists the three shipped ids; `validateParams` rejects
  malformed params; deferred ids are absent from the registry.
- **Installers:** idempotent marker replacement (run twice, single block); full-file
  targets overwritten; `print-skill-url` output shape.
- **Negative/security e2e:** extend `stripe-to-vercel.test.ts` (or a sibling) to do
  the full agentic path; assert no raw secret, no observed success text, and no DOM
  snippet appears in any response body.
- **[P2a] Real-page auto-resume validation gate (manual/scripted, not unit):** on
  the first supported provider flows — Vercel env-var add (`inject-submit`) and
  Stripe webhook secret reveal (`reveal-capture`) on the **actual sites** — verify
  the absence proof reaches `passed` and the daemon auto-resumes. The proof stays
  fail-closed regardless; this gate measures whether auto-resume *succeeds in
  practice*. If a target site's structure (e.g. a cross-origin iframe around the
  field) forces `manual_recovery_required` in the common case, that provider's
  browser flow is recorded as **best-effort only** and the `template run` path is
  documented as the primary path for it (skill + README updated accordingly). This
  is a release gate for Phase 2/3, not a code unit test.

## 14. Build Order (independently shippable phases)

1. **Handles** — store + `browser mark focused`/`mark next-click`/`marks` +
   `BrowserOps.markFocused`/`markNextClick`/`revalidateHandle` + tests.
2. **inject-submit** — binding/UI extension, route, `injectIntoBackendNode`/
   `clickBackendNode`, absence proof, audited auto-resume, tests; then the **[P2a]
   real-page validation gate** for Vercel before declaring the browser flow
   production (not best-effort).
3. **reveal-capture** — route + `readBackendNodeValue` + `resolveWithinContainer`
   (all three capture modes) + hide/blank, tests; then the **[P2a] real-page
   validation gate** for Stripe.
4. **Templates** — three stdin/`tmp_env_file_0600`-safe definitions + the
   `runTemplate` temp-env-file extension + validateParams + docs for deferred.
5. **Skill + installers + doctor/health** — canonical SKILL.md, retire claude-code
   skill, installers, `repository` in package.json, README, health/doctor block. The
   skill/README must state, per provider, whether the browser flow is production or
   best-effort (template-primary) based on the Phase 2/3 P2a gate outcome.

## 15. Acceptance Criteria → Where Satisfied

- Add a Vercel env var via UI without observing the secret and without the human
  clicking save → §4 (`inject-submit`).
- Capture a revealed Stripe secret without the human focusing/selecting after blind
  begins → §6 (`reveal-capture`).
- If success cannot be proven, blind mode remains active → §4.2/§5.3/§6.2 fail-closed.
- No endpoint returns raw secrets → enum-only responses (§4.3/§6.3), extended
  "no raw secret in any response" test (§13), `value_visible_to_agent:false`.
- Approval UI describes the whole planned operation in plain language → §6.4 incl.
  explicit auto-resume disclosure.
- `doctor` reports whether agentic browser flows are available → §11.
- Skill file is enough for Claude/Copilot/Codex to run the workflow without docs →
  §10.
- **[P2a] First supported provider browser flows actually auto-resume on the real
  sites**, or are explicitly recorded as best-effort with `template run` documented
  as primary → §13 validation gate, §14 phases 2–3, skill/README outcome statement.

## 16. Decisions & Assumptions

- `inject-submit` and `reveal-capture` **always** require human approval
  (`force:true`) regardless of secret environment — they are powerful and authorize
  auto-resume. (Departs from current inject auto-approving development secrets;
  intentional.)
- Handles are referenced by **label**; re-marking a label replaces it; label
  namespace is per browser session; no selector marking in v1. Two marking
  primitives: `mark focused` (focusable fields) and `mark next-click` (the next click
  is captured and **prevented**, for non-focusable buttons/reveal/hide controls).
- `reveal-capture` supports three capture modes (`field`, `container`,
  `focused-after-reveal`) because real UIs often create/replace the secret element
  only after reveal. Post-reveal element resolution is **daemon-only** and gated by a
  DOM-containment proof against the human-approved container plus a strict
  single-candidate (no ambiguity) rule; anything else fails closed.
- Auto-resume bypasses `blankAllPages` (the proof already established the page is
  clean and is the desired post-transaction state). `/v1/blind/end` is unchanged.
- Absence proof matches the **raw** secret only; transformed/derived forms are out of
  scope and documented in `threat-model.md` (§5.4).
- Closed shadow roots / canvas are undetectable to page JS (including the agent's);
  the proof's guarantee is scoped to daemon-observable surfaces plus a required
  success condition; uncertainty ⇒ stay blind.
- Templates: only stdin- or `tmp_env_file_0600`-safe CLIs ship;
  `railway`/`netlify`/`clerk` deferred with rationale. `/dev/stdin` is not assumed
  portable; a `0600` daemon-owned temp env-file (unlinked in `finally`) is the
  sanctioned non-stdin delivery and still satisfies no-argv-leak.
- **[P2a]** The absence proof stays conservatively fail-closed; whether auto-resume
  *succeeds in practice* on real provider pages is a release gate (§13/§14), and a
  provider whose pages force manual recovery is shipped as best-effort with templates
  documented as primary — not a reason to weaken the proof.
- `package.json` gains a `repository` field; raw skill URL derived from it,
  branch/path overridable.
- Spec lives under `docs/superpowers/` which `package.json` `files` already excludes
  from the published package — no packaging change needed for the spec itself.

## 17. Out of Scope (v1)

- Selector-based or coordinate-based marking (only `focused` / `next-click`).
- Proactive (event-driven) handle invalidation beyond validate-on-use + TTL.
- Templates whose CLI forces the secret onto argv.
- A generic "submit action" DSL — only "click the marked submit/reveal/hide handle".
- Multi-element / recursive container resolution heuristics beyond
  "exactly one unambiguous candidate inside the approved container".
- Detecting transformed/derived secret forms in the absence proof.
- Persisting handles across daemon or browser restarts.
