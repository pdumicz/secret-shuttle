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

- **No new human-fallback machinery.** When a recipe is absent or fails, the daemon returns a **clear, specific error**; the agent (e.g. Claude Code) relays it and the human takes over manually. We build nothing for the takeover. The pre-existing human-reveal hub UI is neither extended nor removed by this work.
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
  | { action: "click"; selector: string }
  | { action: "wait_for"; selector: string; timeout_ms?: number }
  | { action: "wait"; ms: number };

interface RecipeBase {
  host: string;                 // canonical host (lowercase, trailing-dot stripped) — matched against expected_host
  url: string;                  // page to open (param interpolation deferred; see §9)
  logged_in_probe: string;      // selector present iff logged in; absent => login wall
  pre_steps?: RecipeStep[];     // non-secret navigation on the public page chrome to reach the secret/field
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

### 4. Login-wall detection (orthogonal, both directions)

Before resolving any recipe selector, check `logged_in_probe`:
- probe present → proceed.
- probe absent → stop this step with `bootstrap_login_required` (carrying the host and the visible tab). The tab is already user-visible (`openCaptureTarget` opens with `background:false`); the agent relays "log into `<host>` in the open window, then re-run `--continue`." Cookies persist in the bootstrap profile, so this is genuinely once-per-provider. **The daemon never handles credentials.**

### 5. Capture wiring (`runCaptureStep`)

Insert a recipe attempt into the existing state machine. The pre-flight (blind.start → `disableObservationDomains` → sever → `openCaptureTarget`) is unchanged; everything after runs daemon-side under blind.

```
open target (existing)
 ├─ recipe for host?
 │   ├─ no  → (out of scope) existing behavior  [see §5 note]
 │   └─ yes → logged_in_probe present?
 │             ├─ no  → stop: bootstrap_login_required (clear error)
 │             └─ yes → run pre_steps
 │                       → resolveSelectorToHandle(reveal_selector, field/container_selector, hide_selector?)
 │                          ├─ ambiguous → stop: recipe_selector_ambiguous (clear error)
 │                          └─ ok → captureWithTransitionGate(...)
 │                                   ├─ value     → existing success path: cleanup → auto-resume → vault.upsert → { kind:"ref" }
 │                                   └─ no value  → stop: recipe_capture_failed (clear error; reason carried)
```

The success path (cleanup verify → `blind.end` → `vault.upsertSecret`) and all five existing `CaptureStepOutcome` branches are unchanged. The recipe attempt only adds a new *source* of the captured value.

**§5 note (decision for review):** This spec assumes recipe failure/`login_required` returns a **clear error** (agent → human takes over out-of-band), per the "no human-fallback machinery" steer. For a host with **no** recipe at all, the pre-existing human-reveal hub UI behavior is left untouched (out of scope). If at review you prefer recipe-absent/failed to *fall through* to that existing hub UI rather than erroring, it's a one-line policy flip — flagged here rather than silently chosen.

### 6. Inject wiring — new `browser_inject` destination kind

Today `ResolvedDestination` is `template_id`-only. Add a discriminated kind:

```ts
export type ResolvedDestination =
  | { kind: "template"; template_id: string; template_params: Record<string,string>; shorthand: string; domain: string }
  | { kind: "browser_inject"; recipe_host: string; url_params?: Record<string,string>; shorthand: string; domain: string };
```

`runDestinationSteps` dispatches on `kind`:
- `template` → today's CLI push (unchanged).
- `browser_inject` → in the bootstrap session: `blind.start` → open tab at the inject recipe's `url` → `logged_in_probe` → `pre_steps` → resolve `field_selector` + `submit_selector` → `injectWithSuccessGate(...)` with the value resolved from the captured ref → cleanup + auto-resume. Same blind discipline as a discrete inject-submit, scoped to this push.

`infer`/plan selects `browser_inject` only when an inject recipe exists for the destination host **and** no CLI token/template is configured for it; otherwise it keeps the CLI template (which is more robust). The choice is recorded in the matrix.

### 7. README unified coverage matrix (honesty artifact, replaces `[P2a]`)

A single table covering **all** mechanisms — browser capture recipes, browser inject recipes, and CLI templates — so a reader sees exactly what is automated and how. The table below is the **target state after increment 1**: the four CLI rows reflect what ships **today**; the two browser-recipe rows (Stripe capture, Vercel inject) are this increment's deliverable; ⬜ rows are future.

| Provider | Direction | Mechanism | Status | Real-page verified | Notes |
|---|---|---|---|---|---|
| Stripe | capture (secret key) | browser recipe | 🆕 this increment | (set on dogfood) | revealable in dashboard |
| Supabase | capture (service_role) | browser recipe | ⬜ planned | — | revealable in settings/api |
| OpenAI / Anthropic | capture | human-paste | n/a | n/a | create-once; cannot be revealed |
| Vercel | inject (env) | browser recipe **and** CLI (`vercel-env-add`) | CLI shipped; recipe 🆕 this increment | (set on dogfood) | CLI push is the robust default; recipe serves browser-only users |
| GitHub Actions | inject (secret) | CLI (`github-actions-secret-set`) | ✅ shipped | n/a | repo-scoped only |
| Cloudflare | inject (secret) | CLI (`cloudflare-secret-put`) | ✅ shipped | n/a | |
| Supabase edge | inject (secret) | CLI (`supabase-edge-secret-set`) | ✅ shipped | n/a | |

`verified_against_real_page` in each recipe feeds the "Real-page verified" column (a human-attested dogfood date, since CI has no provider creds). Every new provider is a new row — this is the progress tracker requested at design review.

### 8. Honesty fixes folded in

- **`infer-rules.ts`:** stop labeling OpenAI/Anthropic as `capture` with a keys URL. Introduce a distinct inferred source that promises **no reveal** and routes to **human-paste** ("supply a key you created"), so the flow never pretends to reveal an unrevealable secret. (Chosen over an explicit "create-a-new-key" recipe, which would mint a new key on the user's account every run — riskier, louder consent; deferred.)
- **Demo scene 0 + README:** state the honest steady state — *"First time per provider, log in once in the Secret Shuttle browser. After that, one approval ships everything for providers with a recipe (see the coverage matrix)."* The demo drift-guard only checks command existence, not narrative truth, so this copy fix is the actual safeguard.

## Safety analysis

- **The secret-handling core is unchanged.** Recipes only change *who locates the elements* (registry vs. agent vs. human). The transition gate, observable-before-blind check, success-text gate, absence proof, blind/sever, and auto-resume are the same factored functions used by the vetted routes (guarded by their existing tests).
- **Recipe rot fails safe, never silent-wrong.** 0/>1 selector match → clear error; wrong control → `reveal_no_transition` / missing `success_text` → fail closed.
- **New attack surface is minimal.** `resolveSelectorToHandle` reads element identity, not values; recipe selectors are daemon-shipped constants (no agent/network injection vector); login walls surface a tab for the human (no credential handling).
- **Residual gap stated, not hidden.** The absence proof is still a DOM string-scan; this design does not improve exfil resistance. A hostile reveal page that exfiltrates the instant the secret renders still passes the proof — unchanged from today.

## First increment (what the implementation plan sequences)

1. Recipe types + registry + `resolveSelectorToHandle` (conservative single-match).
2. Factor `captureWithTransitionGate` / `injectWithSuccessGate` out of the two routes (behavior-preserving; existing tests are the guard).
3. Login-wall detection + `bootstrap_login_required` outcome.
4. Capture-recipe execution in `runCaptureStep` (recipe → magic, else clear error).
5. `browser_inject` destination kind + inject-recipe execution in `runDestinationSteps`.
6. **Stripe** capture recipe + **Vercel** inject recipe (authored per §10).
7. README unified coverage matrix.
8. `infer-rules.ts` relabel (OpenAI/Anthropic → human-paste) + scene-0/README honesty copy.

## Recipe authoring methodology (§10)

Recipes are authored from **vendor docs + live `browser-harness` exploration**:
- Vercel: explore against the user's **logged-in** Chrome via `browser-harness` to find stable selectors (prefer `data-*`/`aria-*`/role/semantic over CSS-module hashes) and the success text. Note: `browser-harness` drives the user's profile; the actual capture runs in the separate `bootstrap` profile, so selectors transfer but login state does not — hence the one-time login wall.
- Stripe: explore the dashboard secret-key reveal flow similarly.
- Each authored recipe gets a `verified_against_real_page` date and a matrix row.
- Durable findings (selectors, framework quirks, success text) are contributed back to `browser-harness` domain skills per its "always contribute back" rule.

## Error codes added

- `recipe_selector_ambiguous` — a recipe selector matched 0 or >1 elements; manual capture/inject needed.
- `recipe_capture_failed` — recipe ran but the transition gate yielded no value (carries the underlying reason, e.g. `reveal_no_transition`).
- `bootstrap_login_required` — `logged_in_probe` absent; the human must log into the provider in the open Secret Shuttle browser tab, then re-run `--continue`.
- (`recipe_inject_failed` reuses the existing inject `submitted:"unknown"` semantics; surfaced with the recipe host.)

## Open questions / future

- **Param interpolation in recipe URLs** (e.g. Supabase `project/_/settings/api`, Vercel project slug). Deferred: the first two recipes use static or single-project URLs; a templating scheme is a follow-on.
- **Recipe self-test command** (`secret-shuttle recipe verify <host>`) that, against a logged-in bootstrap profile, checks each selector resolves to exactly one element and updates the matrix date. Strong future honesty tool; out of scope for increment 1.
- **§5 fall-through policy** (clear error vs. existing hub UI for recipe-absent/failed) — confirm at review.
