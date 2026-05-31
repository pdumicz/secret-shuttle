# Honest Hands-Off Magic Path — Provider Recipes + Hybrid Fallback — Design

**Date:** 2026-05-31
**Status:** Design
**Related:**
- `docs/superpowers/specs/2026-05-26-plan5g-bootstrap-design.md` (the bootstrap capture executor this extends)
- `docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md` (reveal-capture / inject-submit cores reused here)
- `docs/superpowers/specs/2026-05-30-secret-shuttle-honesty-pass-design.md` (the honesty discipline this spec is held to)
- Memory: `project_secret-shuttle-demo-accuracy` (scene-0 capture over-promise this closes), `[P2a]` real-page gate

## Goal

Make the batch provisioning path (`provision --continue`, demo scene 0) capture and inject secrets **hands-off** for providers that have a recipe — daemon drives the page, one human approval, done — while staying **honest** about the two physical limits (first-run login per provider; not every provider is revealable).

One sentence: teach the daemon *how to drive specific provider pages* (per-provider "recipes"), reuse the existing blind/transition-gate/absence-proof machinery unchanged, and surface a single honest coverage matrix of what's automated vs. what falls back to the human.

## Background

### Two capture/inject mechanisms exist today

1. **Agent-driven, browser** (`/v1/secrets/reveal-capture`, `/v1/secrets/inject-submit`): the **agent marks** the reveal button + secret field (capture) or the value field + submit button (inject) while it can still see the page; the daemon then goes blind, severs the agent, clicks/reads or types/submits, and proves the secret is gone. Strong safety gates already live here:
   - **Capture transition gate** (`resolveWithinContainer` + `reveal_no_transition` + observable-before-blind check): a value is captured **only if it flips from not-readable to readable on the reveal click** *and* was not script-readable before blind started. A wrong click captures nothing.
   - **Inject success gate** (`observeText(success_text)` + `proveAbsence`): a push is only "submitted" if the success text appears and the value is then absent from the page.

2. **CLI-push destinations** (`vercel-env-add`, `github-actions-secret-set`, `cloudflare-secret-put`, `supabase-edge-secret-set`): the secret is piped to a vendor CLI on **stdin** (`shell:false`, no browser, no argv). Robust, but requires the vendor CLI installed + authed (a token).

3. **Batch capture** (`provision --continue` → `runCaptureStep`): opens a **user-visible tab** at the inferred URL and **waits for a human** to reveal + focus the field + click "Capture" in the hub UI; the daemon reads `document.activeElement` via `captureFromTarget`. This path uses **neither** the transition gate **nor** any per-provider knowledge — it trusts the human to reveal the right value. This is the per-secret human step that demo scene 0 glosses over as "one approval, done."

### The honest gaps this closes

- **Scene-0 over-promise.** Captured secrets are *not* "shipped on one approval click" — the batch path needs a human reveal per secret. (Memory: `project_secret-shuttle-demo-accuracy`, finding 1.)
- **`infer-rules.ts` mislabels create-once providers.** OpenAI / Anthropic keys are shown **once at creation** and cannot be revealed, yet the rule table labels them `capture` pointing at the keys page. The human path only "works" because a human manually creates + pastes. A reveal recipe for them is physically impossible.
- **`[P2a]` is a vague claim.** "Real-page Stripe/Vercel gates unverified (best-effort)" is untracked. A dated per-provider coverage matrix replaces it with something concrete.

### Two physical limits the design must respect (not hide)

- **The bootstrap browser is a dedicated, initially-logged-out Chrome profile** (`~/.secret-shuttle/browser-profiles/bootstrap`, launched by `launchChrome`). Cookies persist across runs, but the **first capture/inject from any provider requires a one-time human login** in that profile. A recipe cannot log in.
- **Not every provider is revealable.** Create-once providers (OpenAI/Anthropic) have no reveal affordance; they route to human-paste, not a recipe.

### Enabling fact (why the integration is clean)

The bootstrap `BrowserSession` already exposes `browser: BrowserOps` (a `CdpBrowserOps` bound to the bootstrap CDP) — the **same interface** reveal-capture/inject-submit cores use via `services.browser`. So the recipe path reuses the **identical** secret-bearing sequence; only the element-locating source changes (selector resolution instead of agent marks or human focus).

## Non-goals (explicitly out of scope)

- **No new human-fallback machinery.** When a recipe **exists but fails** (login wall, ambiguous selector, no transition/success), the daemon returns a **clear, specific error**; the agent (e.g. Claude Code) relays it and the human takes over manually. We build nothing for the takeover. The pre-existing human-reveal hub UI is neither extended nor removed by this work — and for a host with **no recipe at all**, that existing hub path is left exactly as it is today (this work does not route no-recipe hosts to an error). This is the single, settled absence/failure policy; it is not re-opened elsewhere in this spec.
- **No agent-locate fallback protocol** (the earlier "Tier 2"). Dropped per design review — confusing, not worth the build.
- **No change to the absence proof.** It remains the one-shot DOM/attribute/shadow/iframe string-scan it is today (the known residual exfil gap). Recipes make capture *hands-off*, not *more leak-proof*. Behavioral exfil hooks remain Phase-4 hardening, out of scope here.
- **No credential handling.** The daemon never types passwords. Login walls surface the visible tab and ask the human to log in.
- **No automated CI verification against real logged-in provider pages.** CI has no provider creds; real-page verification is a human-attested dogfood step recorded as a date in the matrix.
- **No mass provider rollout.** This spec ships **two** recipes (Stripe capture, Vercel inject) and the machinery + matrix to grow the rest incrementally.

## Design

### 1. Recipe registry — per-provider, per-direction browser knowledge (data, not code)

A recipe describes how to drive **one provider page** for **one direction**. Recipes are declarative data (selectors + ordered pre-steps), daemon-shipped constants — never agent- or network-supplied.

```ts
// src/daemon/recipes/types.ts
export type RecipeStep =
  // A pre-step click is *navigation only*. It MUST resolve to exactly one element (same
  // single-match rule as resolveSelectorToHandle) and SHOULD target a stable nav affordance
  // (data-*/aria-*/role on a link/tab), never a submit/delete/reveal/destructive control.
  | { action: "click"; selector: string }
  | { action: "wait_for"; selector: string; timeout_ms?: number }
  | { action: "wait"; ms: number };

interface RecipeBase {
  host: string;                 // canonical host (lowercase, trailing-dot stripped) — matched against expected_host
  url: string;                  // page to open (param interpolation deferred; see §9)
  logged_in_probe: string;      // selector present iff authenticated AND on the expected page/scope
  page_ready_probe?: string;    // selector present on any successful load (logged-in or -out); absent after timeout => recipe_page_timeout (§4)
  logged_out_marker?: string;   // selector present ONLY on the provider login/auth screen => positive bootstrap_login_required signal (§4)
  ready_timeout_ms?: number;    // bound for page_ready_probe wait
  pre_steps?: RecipeStep[];     // non-secret, non-destructive navigation on the public page chrome to reach the secret/field; see the pre_steps safety contract below
  verified_against_real_page?: string; // ISO date a human dogfooded it; surfaced in the matrix
}

export interface CaptureRecipe extends RecipeBase {
  kind: "capture";
  reveal_selector: string;      // the "reveal"/"show" control
  // exactly one of:
  field_selector?: string;      // input/textarea holding the secret (field mode)
  container_selector?: string;  // subtree whose revealed text is the secret (focused-after-reveal mode)
  hide_selector?: string;       // optional control to restore the clean (hidden) state
}

export interface InjectRecipe extends RecipeBase {
  kind: "inject";
  field_selector: string;       // where the value goes
  submit_selector: string;      // the submit/save control
  success_text: string;         // text observed on a successful save
}

export type Recipe = CaptureRecipe | InjectRecipe;
```

A registry (`src/daemon/recipes/registry.ts`) maps `host -> Recipe` per direction. Lookup is by the same canonical host the executor already computes (`expectedHost`).

**`pre_steps` safety contract (fail-safe for the severed/blind window).** `pre_steps` run after sever and (for inject) under blind, *before* the transition/success gates, so a stale selector clicking the wrong control is a real risk. Constraints:
- **Navigation only, never mutating.** A pre-step `click` may only target verifiably non-destructive navigation chrome (tab/link/disclosure). Recipe authors must not point a pre-step at a submit, save, delete, reveal, environment-switch, or project/team-switch control. There is no recipe verb for those by design — only the reveal/submit controls in §3 (gated) may act on the secret.
- **Single-match, same as resolution.** Each pre-step `click`/`wait_for` selector must resolve to **exactly one** element; 0/>1 → `recipe_selector_ambiguous` (clear error), stop. A pre-step never guesses among matches.
- **Host + scope revalidation after each step, and immediately before reveal/inject.** Host equality alone is *insufficient*: Vercel/GitHub/Stripe project, team, account, environment, and settings scopes can all change while staying on the same host, so a stale pre-step could land on the wrong project and still pass a host check (then field/submit selectors may resolve cleanly against the wrong target). After every pre-step — and again immediately before the reveal/inject action — the daemon therefore runs the **full staged page-state check (§4)**: live document host equals the recipe `host`, *and* the scope-specific `logged_in_probe` (a selector authored to be present iff on the expected page **and scope**) still resolves. Any drift (navigated off-host, opened auth, or changed project/team/env/settings scope so `logged_in_probe` no longer matches) → stop with the corresponding §4 error (`recipe_page_unexpected` for a wrong/changed scope, `bootstrap_login_required` for an auth wall); it never proceeds to reveal/inject on an unexpected page or scope.
- **Pre-steps must be idempotent / re-runnable** so a `--continue` retry after login does not compound side effects.

### 2. One new daemon primitive: `resolveSelectorToHandle`

Resolves a recipe selector to a `BackendNodeRef` (`{ target_id, backend_node_id }`) + a field fingerprint, **on the public page chrome, before any secret is revealed** (the reveal button and the *empty* field are not the secret).

```ts
// on CdpBrowserOps (or a helper bound to a BrowserSession's cdp)
resolveSelectorToHandle(target_id: string, selector: string): Promise<BackendNodeRef & { fingerprint: string }>
```

- Uses `document.querySelectorAll(selector)` and **requires exactly one match**. 0 or >1 matches → throw `recipe_selector_ambiguous` (→ clear-error outcome). It never guesses.
- Returns element **identity** (backendNodeId + tag/name/id for the fingerprint via the existing `fieldFingerprint`), **never values**. This is the same class of information the agent's `mark` already exposes.
- Runs against the **bootstrap session's** `browser`/`cdp`, so it produces refs interchangeable with agent-marked handles for the shared sequences in §3.

### 3. Reuse the vetted secret-bearing sequences (factor, don't fork)

The safety-critical sequences already exist in `reveal-capture.ts` and `inject-submit.ts` but are bound to `services.browser` and to agent-marked handles. Factor each into a shared function parameterized by a `BrowserOps` + resolved `BackendNodeRef`s, callable by **both** the existing user-session routes **and** the bootstrap recipe path:

- `captureWithTransitionGate(browser, { revealRef, targetRef, captureMode, hideRef? }) -> { value, fingerprint }` — baseline → click reveal → `resolveWithinContainer` (transition gate) → observable-before-blind check → optional hide. Unchanged logic; just takes refs + ops as params.
- `injectWithSuccessGate(browser, { fieldRef, submitRef, value, successText, timeoutMs }) -> { submitted, ... }` — inject → click submit → `observeText` → `proveAbsence`. Unchanged logic.

This is a refactor with **behavior preservation** as the bar: the existing routes must produce byte-identical outcomes (their tests are the guard). The bootstrap recipe path then calls the same functions with `services.browserSession.browser` and selector-resolved refs.

**Why this matters for honesty/safety:** the element-locating source (recipe selectors) is the *only* thing that changes. Every secret-handling gate — blind start/sever, transition gate, observable-before-blind, success-text, absence proof, auto-resume — is the same code. Therefore **a stale or wrong recipe degrades to a clear failure, never to a silently-captured wrong secret**:
- selector misses → `recipe_selector_ambiguous` (0/>1 match) → clear error;
- selector hits the wrong control → no hidden→readable transition → `reveal_no_transition` → fail closed;
- inject lands wrong → no `success_text` → `submitted: "unknown"`, blind stays active.

### 4. Page-state detection (orthogonal, both directions)

A single "is the logged-in selector present?" check conflates too many failure modes (logged out, slow load, wrong project/team, permission denied, onboarding interstitial, changed DOM, bad URL) and would emit misleading "log in and re-run" loops. So detection is staged into distinct outcomes, evaluated in order, *before* resolving any recipe selector:

1. **Page reachable & loaded.** Wait (bounded) for `page_ready_probe` — a selector present on *any* successful load of this page chrome (logged-in or logged-out), e.g. the app shell/nav root. If it never appears within the timeout → stop with `recipe_page_timeout` (page didn't load / DOM changed / bad URL — *not* a login claim). The agent relays "couldn't load `<host>` `<url>`; check the open window."
2. **Positive logged-out signal.** If `logged_out_marker` is present (a selector that appears *only* on the provider's login/auth screen) → stop with `bootstrap_login_required`.
3. **Logged-in confirmation.** Else require `logged_in_probe` (selector authored to be present iff authenticated *and* on the expected page **and scope** — i.e. it must be scope-specific, keyed to the recipe's exact project/team/account/environment/settings context, not merely "some authenticated page on this host"). Present → proceed. Absent while the page loaded and no logged-out marker showed → stop with `recipe_page_unexpected` (likely wrong project/team, permission/not-found, or an onboarding/interstitial state — a distinct, non-login error carrying host + url so the human can inspect the visible tab). This deliberately does **not** tell the user to "log in," since they may already be logged in but on the wrong/blocked page.

This staged check is re-run after each `pre_step` and immediately before reveal/inject (per the §1 pre_steps safety contract), so a pre-step that drifts to the wrong scope while staying on-host is caught by the scope-specific `logged_in_probe` failing — not silently acted upon.

`bootstrap_login_required` carries the host and the visible tab. The tab is already user-visible (`openCaptureTarget` opens with `background:false`); the agent relays "log into `<host>` in the open window, then re-run `--continue`." Cookies persist in the bootstrap profile, so this is genuinely once-per-provider. **The daemon never handles credentials.**

`page_ready_probe` and `logged_out_marker` are optional *in the type* (see §1) only so the type stays minimal and an old single-probe recipe still loads. But **every shipped browser recipe MUST define all three probes** — Stripe and Vercel are the whole point of increment 1, so a recipe missing `page_ready_probe` or `logged_out_marker` would regress to today's misleading "log in and re-run" behavior. This is enforced as a test bar, not just convention: a test asserts the two increment recipes (Stripe capture, Vercel inject) each define `page_ready_probe`, `logged_out_marker`, and `logged_in_probe` (see Test & verification bar). A recipe that omits them would degrade to the single `logged_in_probe` check and collapse the three failure classes (timeout, logged-out, wrong-page) back into one — which is exactly the regression this design exists to prevent.

### 5. Capture wiring (`runCaptureStep`)

Insert a recipe attempt into the existing state machine. The pre-flight (blind.start → `disableObservationDomains` → sever → `openCaptureTarget`) is unchanged; everything after runs daemon-side under blind.

```
open target (existing)
 ├─ recipe for host?
 │   ├─ no  → (out of scope) existing behavior  [see §5 note]
 │   └─ yes → page-state detection (§4): page_ready_probe / logged_out_marker / logged_in_probe
 │             ├─ not loaded     → stop: recipe_page_timeout (clear error)
 │             ├─ logged-out     → stop: bootstrap_login_required (clear error)
 │             ├─ wrong page/scope → stop: recipe_page_unexpected (clear error)
 │             └─ logged-in      → run pre_steps (each followed by §4 re-check)
 │                       → resolveSelectorToHandle(reveal_selector, field/container_selector, hide_selector?)
 │                          ├─ ambiguous → stop: recipe_selector_ambiguous (clear error)
 │                          └─ ok → captureWithTransitionGate(...)
 │                                   ├─ value     → existing success path: cleanup → auto-resume → vault.upsert → { kind:"ref" }
 │                                   └─ no value  → terminal cleanup (see below) → stop: recipe_capture_failed (clear error; reason carried)
```

The success path (cleanup verify → `blind.end` → `vault.upsertSecret`) and all five existing `CaptureStepOutcome` branches are unchanged. The recipe attempt only adds a new *source* of the captured value.

**Capture failure recovery (defined end-state, no new fallback machinery).** A capture attempt must never leave the agent observing a page that may hold a revealed secret, nor leave the session blind. On every failure mode after `openCaptureTarget`, the daemon reaches a clean, deterministic end-state before returning the error. Tab lifecycle splits by error class, because page-state failures occur *before* any reveal (no recipe-driven reveal/type occurred) and their recovery path is precisely "log into / inspect the open window" (§4):
- **Pre-reveal page-state failures** (`bootstrap_login_required`, `recipe_page_timeout`, `recipe_page_unexpected` per §4): no recipe reveal/type ran, and the recovery action is for the human to act on the *visible provider tab* (log in, or inspect the bad page). The daemon therefore `blind.end`s + auto-resumes the agent but **leaves the visible provider tab open** so "log into `<host>` in the open window" / "check the open window" are accurate. No recipe-driven reveal/type occurred on that tab — the daemon never clicked a reveal control or typed a value there (the *page-state* caveat below is a separate matter). **Residual tradeoff (stated, not hidden):** for `recipe_page_unexpected` specifically — a *changed* authenticated scope (wrong project/team/env that fails the scope-specific `logged_in_probe`) — that page *could* already render some sensitive provider value before any selector resolved, the same stale-page risk that makes `recipe_selector_ambiguous` secret-bearing. We accept this for the page-state class because (a) the recovery surface *is* human inspection of that visible tab, (b) the daemon resumes the agent only *after* `blind.end` onto a page it never drove a reveal on, and (c) the tab is already user-visible from `openCaptureTarget` and under the human's control. This is a deliberate **human-inspectability-over-strict-isolation** choice for the page-state class only; the secret-bearing reveal/selector classes below still close the tab before `blind.end`.
- **Pre-reveal selector failure** (`recipe_selector_ambiguous`): the page may already display the secret value (the recipe could be stale precisely because the page was redesigned and the value rendered differently), so this is treated as secret-bearing like the reveal-failure case below: **close the capture tab before `blind.end`**, then auto-resume; return the specific error.
- **Reveal ran but the transition gate yielded no value** (`recipe_capture_failed` / `reveal_no_transition`): the reveal click *may* have made plaintext visible even though no value was captured (e.g. a stale `reveal_selector` or wrong `targetRef`). The daemon therefore **closes the capture tab before `blind.end`** — so the agent never resumes observation on a page that could contain a revealed secret — attempting `hide_selector` first when the recipe defines one. It does **not** re-open or re-observe the page. Then `blind.end` + auto-resume; the error carries the recipe host and the underlying reason. Because no value entered the vault, `recipe_capture_failed` is non-destructive and the human captures manually out-of-band.
- **Tab handling:** on success, and on any failure where a reveal *may* have rendered a secret (`recipe_selector_ambiguous`, `recipe_capture_failed` / `reveal_no_transition`), the capture tab is **closed before `blind.end`** so a severed/blind tab is never left open holding a revealed value. On a pre-reveal page-state failure (login/timeout/unexpected-page) the tab is **left open** for the human to log in or inspect, since no secret was revealed and that visible tab *is* the documented recovery surface.

**§5 note (settled policy):** A recipe that **exists but fails** (`bootstrap_login_required` / `recipe_page_timeout` / `recipe_page_unexpected` / `recipe_selector_ambiguous` / `recipe_capture_failed`) reaches the deterministic terminal cleanup above and returns a **clear error**; the agent relays it and the human takes over out-of-band, per the "no human-fallback machinery" steer. Terminal cleanup is class-specific: secret-bearing failures (`recipe_selector_ambiguous`, `recipe_capture_failed`) close the tab before `blind.end` (optional `hide_selector`, no re-observation of a possibly-revealed page), while pre-reveal page-state failures end blind but leave the visible tab open as the login/inspect surface. A host with **no recipe at all** keeps the pre-existing human-reveal hub UI behavior untouched (out of scope) — it is *not* converted to an error. This matches the Non-goals statement above and the state-machine `no →` branch below; it is the spec's single absence/failure policy and is not deferred to review.

### 6. Inject wiring — new `browser_inject` destination kind

Today `ResolvedDestination` is `template_id`-only. Add a discriminated kind:

```ts
export type ResolvedDestination =
  | { kind: "template"; template_id: string; template_params: Record<string,string>; shorthand: string; domain: string }
  | { kind: "browser_inject"; recipe_host: string; url_params?: Record<string,string>; shorthand: string; domain: string }; // url_params reserved for deferred interpolation (§9); unused in increment 1 — recipes carry a complete static url
```

`runDestinationSteps` dispatches on `kind`:
- `template` → today's CLI push (unchanged).
- `browser_inject` → in the bootstrap session: `blind.start` → open tab at the inject recipe's `url` → page-state detection (§4) → `pre_steps` (each followed by the §4 re-check, incl. scope-specific `logged_in_probe`) → §4 re-check immediately before inject → resolve `field_selector` + `submit_selector` → `injectWithSuccessGate(...)` with the value resolved from the captured ref → cleanup + auto-resume. Same blind discipline as a discrete inject-submit, scoped to this push.

**Inject failure recovery (defined end-state, no new fallback machinery).** A `browser_inject` push must never leave the session in an ambiguous locked/blind state. On any failure mode the daemon always reaches a clean, deterministic end-state before returning the error, matching the discrete inject-submit teardown. Tab lifecycle splits by error class, mirroring capture (§5): an inject value is only *typed* at the `injectWithSuccessGate` step, so all pre-submit page-state failures leave the page secret-free and their recovery path is "log in / inspect the open window" (§4):
- **Pre-submit page-state failures** (`bootstrap_login_required`, `recipe_page_timeout`, `recipe_page_unexpected` per §4): no value was typed and nothing was mutated; `blind.end` + auto-resume, but **leave the visible provider tab open** so the §4 recovery copy ("log into `<host>` in the open window" / "check the open window") is accurate. Return the specific §4 error. The same **human-inspectability-over-strict-isolation** residual tradeoff stated in §5 applies to `recipe_page_unexpected` here (a changed authenticated scope could render some sensitive value before any selector resolves); it is accepted for the page-state class because the visible tab *is* the recovery surface and the agent only resumes after `blind.end` onto a page the daemon never typed into.
- **Pre-submit selector failure** (`recipe_selector_ambiguous`): no value was typed, but treat the tab as disposable — **close the inject tab**, `blind.end`, auto-resume, return the error. Nothing was mutated.
- **Submit ran but `success_text` never observed** (`submitted: "unknown"` → surfaced as `recipe_inject_failed`): run the **same `proveAbsence`** teardown the discrete route uses to confirm the value is no longer present on the page, then close the inject tab and `blind.end` + auto-resume regardless of the outcome (blind is *not* left active across the return). The error carries the recipe host and the absence-proof result so the human knows whether the value may have landed. Because the secret is already in the vault as a ref, **`recipe_inject_failed` is retryable**: re-running `--continue` re-attempts the push (Vercel env-add is an upsert, so a retry that lands twice is idempotent). The daemon does **not** build any auto-retry, manual-recovery parking, or human-takeover UI — it returns the clear error and the human decides whether to retry or push manually (e.g. via the CLI template).
- **Tab handling:** on success, and on any failure where a value *may* have been typed/rendered (`recipe_selector_ambiguous`, `recipe_inject_failed`), the inject tab is **closed before `blind.end`** so a severed/blind tab is never left open holding a rendered value. On a pre-submit page-state failure (login/timeout/unexpected-page) the tab is **left open** for the human to log in or inspect, since no value was typed and that visible tab *is* the documented recovery surface.

**Increment-1 URL scope (honesty bound):** because URL param interpolation is deferred (§9 / open questions), the increment-1 Vercel inject recipe targets a **single, fully-specified env-add URL** — the dogfood/demo project's environment-variables page baked into the recipe constant. It does **not** generalize to arbitrary user projects/teams/env scopes; that requires the deferred templating scheme. `url_params` is reserved in the type for that follow-on and is **unused in increment 1** (recipes ship a complete static `url`). The general, arbitrary-project Vercel path in increment 1 remains the CLI push (`vercel-env-add`), which already accepts project/scope flags.

`infer`/plan selects `browser_inject` only when an inject recipe exists for the destination host **and** no CLI token/template is configured for it **and** the destination resolves to a project the recipe's static URL covers; otherwise it keeps the CLI template (which is more robust and project-general). The choice is recorded in the matrix.

### 7. README unified coverage matrix (honesty artifact, replaces `[P2a]`)

A single table covering **all** mechanisms — browser capture recipes, browser inject recipes, and CLI templates — so a reader sees exactly what is automated and how. The table below is the **target state after increment 1**: the four CLI rows reflect what ships **today**; the two browser-recipe rows (Stripe capture, Vercel inject) are this increment's deliverable; ⬜ rows are future.

| Provider | Direction | Mechanism | Status | Real-page verified | Notes |
|---|---|---|---|---|---|
| Stripe | capture (secret key) | browser recipe | 🆕 this increment | (set on dogfood) | revealable in dashboard |
| Supabase | capture (service_role) | browser recipe | ⬜ planned | — | revealable in settings/api |
| OpenAI / Anthropic | capture | human-paste | n/a | n/a | create-once; cannot be revealed |
| Vercel | inject (env) | browser recipe **and** CLI (`vercel-env-add`) | CLI shipped; recipe 🆕 this increment | (set on dogfood) | CLI push is the robust, project-general default. Increment-1 recipe targets a **single static project URL** (browser-only users / dogfood project); arbitrary-project recipe support needs the deferred URL-param scheme (§9). |
| GitHub Actions | inject (secret) | CLI (`github-actions-secret-set`) | ✅ shipped | n/a | repo-scoped only |
| Cloudflare | inject (secret) | CLI (`cloudflare-secret-put`) | ✅ shipped | n/a | |
| Supabase edge | inject (secret) | CLI (`supabase-edge-secret-set`) | ✅ shipped | n/a | |

`verified_against_real_page` in each recipe feeds the "Real-page verified" column (a human-attested dogfood date, since CI has no provider creds). Every new provider is a new row — this is the progress tracker requested at design review.

### 8. Honesty fixes folded in

- **`infer-rules.ts`:** stop labeling OpenAI/Anthropic as `capture` with a keys URL. Introduce a distinct inferred source that promises **no reveal** and routes to **human-paste** ("supply a key you created"), so the flow never pretends to reveal an unrevealable secret. (Chosen over an explicit "create-a-new-key" recipe, which would mint a new key on the user's account every run — riskier, louder consent; deferred.)
- **Demo scene 0 + README:** state the honest steady state — *"First time per provider, log in once in the Secret Shuttle browser. After that, one approval ships everything for providers with a recipe (see the coverage matrix)."* The demo drift-guard only checks command existence, not narrative truth, so this copy fix is the actual safeguard.

## Safety analysis

- **The secret-handling core is unchanged.** Recipes only change *who locates the elements* (registry vs. agent vs. human). The transition gate, observable-before-blind check, success-text gate, absence proof, blind/sever, and auto-resume are the same factored functions used by the vetted routes (guarded by their existing tests).
- **Recipe rot fails safe, never silent-wrong — including `pre_steps` and scope drift.** For the gated reveal/inject controls: 0/>1 selector match → clear error; wrong control → `reveal_no_transition` / missing `success_text` → fail closed. For `pre_steps` (which run *before* those gates), the safety contract above is what keeps a stale pre-step from clicking a destructive/submit/scope-switch control: navigation-only authored selectors, single-match-or-error, and post-step **host + scope** revalidation (the full §4 staged check, incl. the scope-specific `logged_in_probe`) that aborts on any drift before reveal/inject. Because host equality alone can't catch a same-host project/team/env scope change, the scope-specific probe is what closes that gap. A pre-step that goes stale therefore errors out (ambiguous match, host drift, or scope drift) rather than acting on the wrong control or wrong scope while severed.
- **A failed capture never re-exposes a *recipe-revealed* secret.** If a reveal click made plaintext visible but the transition gate captured nothing (stale/wrong recipe), the capture tab is closed **before** `blind.end` and the agent is never resumed onto that page (§5). So a capture-failure can't leak the rendered value into the agent/user session — it degrades to a clear, non-destructive error. **Residual page-state tradeoff (stated, not hidden):** the pre-reveal page-state class (`recipe_page_unexpected` for a changed authenticated scope) intentionally leaves its tab open for human inspection (§5/§6), so a sensitive value the provider *already* rendered on that wrong/changed scope — before any recipe selector resolved — can remain visible in the user-controlled tab after auto-resume. This is the same stale-page risk that makes `recipe_selector_ambiguous` secret-bearing; we accept it only for the page-state class because that visible tab *is* the documented recovery surface and the daemon never drove a reveal/type on it. The secret-bearing reveal/selector/submit classes do not get this treatment (tab closed before `blind.end`).
- **New attack surface is minimal.** `resolveSelectorToHandle` reads element identity, not values; recipe selectors are daemon-shipped constants (no agent/network injection vector); login walls surface a tab for the human (no credential handling).
- **Residual gap stated, not hidden.** The absence proof is still a DOM string-scan; this design does not improve exfil resistance. A hostile reveal page that exfiltrates the instant the secret renders still passes the proof — unchanged from today.

## First increment (what the implementation plan sequences)

1. Recipe types + registry + `resolveSelectorToHandle` (conservative single-match).
2. Factor `captureWithTransitionGate` / `injectWithSuccessGate` out of the two routes (behavior-preserving; existing tests are the guard).
3. Staged page-state detection (§4) + `bootstrap_login_required` / `recipe_page_timeout` / `recipe_page_unexpected` outcomes.
4. Capture-recipe execution in `runCaptureStep` (recipe present → magic, or clear error if it fails; no-recipe host keeps today's hub behavior unchanged — per §5).
5. `browser_inject` destination kind + inject-recipe execution in `runDestinationSteps`.
6. **Stripe** capture recipe + **Vercel** inject recipe (authored per §10).
7. README unified coverage matrix.
8. `infer-rules.ts` relabel (OpenAI/Anthropic → human-paste) + scene-0/README honesty copy.

## Test & verification bar

"Existing tests are the guard" covers **only** the behavior-preserving refactor in step 2 (the factored `captureWithTransitionGate` / `injectWithSuccessGate` must keep the existing routes byte-identical — their current tests stay green). The new recipe-execution surface is the risk and needs its own focused tests. The implementation plan MUST add, at minimum:

- **Selector resolution:** `resolveSelectorToHandle` throws `recipe_selector_ambiguous` on 0 matches and on >1 matches; returns identity (not value) on exactly 1.
- **Page-state detection (§4):** logged-out marker → `bootstrap_login_required`; `page_ready_probe` never appears → `recipe_page_timeout`; page loaded + no logged-out marker + `logged_in_probe` absent → `recipe_page_unexpected` (asserting these are *distinct* outcomes, not all "log in").
- **Shipped recipes define all three probes:** the two increment recipes (Stripe capture, Vercel inject) each define `page_ready_probe`, `logged_out_marker`, and `logged_in_probe`, so neither regresses to the collapsed single-probe "log in and re-run" behavior (per §4).
- **Pre-step safety + scope revalidation:** an ambiguous (0/>1) pre-step selector errors out and no reveal/inject runs; a pre-step that lands off the recipe `host` triggers host-revalidation abort before any secret action; **a pre-step that stays on-host but lands in the wrong scope (scope-specific `logged_in_probe` no longer resolves) aborts with `recipe_page_unexpected` before any reveal/inject** (per §1 / §4).
- **Capture gate + failure cleanup:** a wrong `reveal_selector` (no hidden→readable transition) yields `recipe_capture_failed`/`reveal_no_transition`, captures no value, and reaches the terminal cleanup — the capture tab is **closed before `blind.end`** (no re-observation of a possibly-revealed page) and `hide_selector` is attempted when defined (per §5); a correct recipe captures and follows the existing success path.
- **Inject gate + recovery:** a missing `success_text` yields `recipe_inject_failed` with blind ended and tab closed, `proveAbsence` run, and the outcome marked retryable (per §6).
- **Tab-lifecycle contract (both directions):** assert the §5/§6 split explicitly — a **pre-reveal/pre-submit page-state failure** (`bootstrap_login_required`, `recipe_page_timeout`, `recipe_page_unexpected`) ends blind (`blind.end` + auto-resume) and **leaves the capture/inject tab open** (the documented login/inspect surface), while every **secret-bearing failure** (`recipe_selector_ambiguous`, `recipe_capture_failed`/`reveal_no_transition`, `recipe_inject_failed`) **closes the tab before `blind.end`** and never re-observes/resumes onto a possibly-revealed page. This contract is the implementation-risk area the tab-handling rules above introduce, so it is asserted directly, not inferred from the gate tests.
- **Recipe-vs-CLI selection:** `infer`/plan picks `browser_inject` only when an inject recipe exists, no CLI token/template is configured, and the destination is covered by the recipe's static URL; otherwise it keeps the CLI template.
- **Honesty inference:** `infer-rules.ts` routes OpenAI/Anthropic to **human-paste** (no reveal, no keys-page `capture` label).

Real-page verification (against logged-in provider pages) stays a human-attested dogfood step recorded as the `verified_against_real_page` date in the matrix — CI has no provider creds (per Non-goals).

## Recipe authoring methodology (§10)

Recipes are authored from **vendor docs + live `browser-harness` exploration**:
- Vercel: explore against the user's **logged-in** Chrome via `browser-harness` to find stable selectors (prefer `data-*`/`aria-*`/role/semantic over CSS-module hashes) and the success text. Note: `browser-harness` drives the user's profile; the actual capture runs in the separate `bootstrap` profile, so selectors transfer but login state does not — hence the one-time login wall.
- Stripe: explore the dashboard secret-key reveal flow similarly.
- Each authored recipe gets a `verified_against_real_page` date and a matrix row.
- Durable findings (selectors, framework quirks, success text) are contributed back to `browser-harness` domain skills per its "always contribute back" rule.

## Error codes added

- `recipe_selector_ambiguous` — a recipe selector matched 0 or >1 elements (including a pre-step selector); manual capture/inject needed.
- `recipe_capture_failed` — recipe ran but the transition gate yielded no value (carries the underlying reason, e.g. `reveal_no_transition`).
- `bootstrap_login_required` — a positive logged-out signal (`logged_out_marker`, or `logged_in_probe` absent on a recipe without the richer probes); the human must log into the provider in the open Secret Shuttle browser tab, then re-run `--continue`.
- `recipe_page_timeout` — `page_ready_probe` never appeared within the timeout; the page didn't load (bad URL / changed DOM / network) — explicitly **not** a login claim. Carries host + url.
- `recipe_page_unexpected` — page loaded and showed no logged-out marker, but `logged_in_probe` was absent (likely wrong project/team, permission/not-found, or onboarding/interstitial). A non-login error carrying host + url; the human inspects the visible tab. Distinct from `bootstrap_login_required` so users aren't sent into "log in and re-run" loops when already authenticated.
- `recipe_inject_failed` — reuses the existing inject `submitted:"unknown"` semantics; surfaced with the recipe host and the post-failure `proveAbsence` result. Blind is always ended and the tab closed before it returns (§6); it is **retryable** (the value is already a vault ref; Vercel env-add is an upsert).

## Open questions / future

- **Param interpolation in recipe URLs → arbitrary-project recipe support** (e.g. Supabase `project/<ref>/settings/api`, Vercel `<team>/<project>` env-add). **Deferred (settled for increment 1):** the increment-1 recipes commit to **static / single-project** URLs, so the Vercel inject recipe is browser-only-user / dogfood-project scoped and the general arbitrary-project path stays on the CLI push. Generalizing browser recipes to arbitrary projects/teams/env scopes requires this templating scheme and is the follow-on deliverable.
- **Recipe self-test command** (`secret-shuttle recipe verify <host>`) that, against a logged-in bootstrap profile, checks each selector resolves to exactly one element and updates the matrix date. Strong future honesty tool; out of scope for increment 1.
