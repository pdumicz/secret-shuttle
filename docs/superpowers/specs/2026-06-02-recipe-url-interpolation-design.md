# Recipe URL Interpolation — Design

**Date:** 2026-06-02
**Status:** Spec (post-brainstorm, pre-plan)
**Predecessor:** [`2026-05-31-honest-hands-off-magic-path-design.md`](./2026-05-31-honest-hands-off-magic-path-design.md) — Burst 8 shipped the recipe subsystem with `RecipeBase.url` as a *static* string per §9 ("param interpolation deferred").

## Summary

Make the `browser_inject` recipe URL templatable so the static-URL Vercel recipe (and any future inject recipe) can address arbitrary user projects instead of a baked-in dogfood placeholder. Mechanism: `{name}` placeholders in `recipe.url`, substituted at runtime from `dest.url_params`, supplied by the user in their yml. Fail-closed with a new `recipe_url_params_missing` error when any placeholder has no value.

Side-effect: with the URL now correctly addressing the user's actual project, the `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` env-var allowlist that was added in Burst 8's Task 14 (the §200 "scope-specific coverage" hazard guard) is no longer protecting against a real hazard. It becomes pure friction. Remove it.

## §1 Goal + non-goals

**Goal.** A user with a `browser_inject` destination types `url_params: { team: "acme", project: "my-app" }` once in their yml, and the recipe routes to `https://vercel.com/acme/my-app/settings/environment-variables` instead of `https://vercel.com/TEAM_PLACEHOLDER/PROJECT_PLACEHOLDER/...`.

**Non-goals (deferred until a 2nd inject recipe needs them).** No autodetect from `.vercel/project.json`. No per-provider autodetect framework. No Vercel API integration. No daemon-side outbound HTTPS. The yml is the single source of `url_params` in increment 1; revisit when a second inject recipe ships and its users actually feel the friction of "type these once".

**Out of scope.** Recipe selector dogfood (still a manual operator step). Capture-recipe URL interpolation (capture recipes already address the right page by virtue of being scoped to a single keys URL per host; if that assumption breaks for a future capture recipe, fold it in then).

## §2 Types (no shape change — already in place)

The Burst 8 ResolvedDestination union (`src/daemon/bootstrap/store.ts:10-12`) already carries the field:

```ts
export type ResolvedDestination =
  | { kind: "template"; template_id: string; template_params: Record<string, string>; shorthand: string; domain: string }
  | { kind: "browser_inject"; recipe_host: string; url_params?: Record<string, string>; shorthand: string; domain: string };
```

`url_params` was reserved-but-unused; this spec consumes it. `RecipeBase.url` stays a `string` — placeholder syntax is encoded in the value (`https://vercel.com/{team}/{project}/...`), not the type. No new fields.

## §3 yml schema (string OR object form)

Today destinations are parsed as a list of strings (`destinations: ["vercel:production"]`) in `src/cli/bootstrap/yml.ts`. Extend the schema so each list entry is EITHER a string (back-compat) OR an object:

```yaml
secrets:
  STRIPE_SECRET_KEY:
    source: { kind: capture, url: "https://dashboard.stripe.com/apikeys" }
    destinations:
      - vercel:production                                                       # string form (back-compat) — url_params absent
      - shorthand: vercel:preview                                                # object form
        url_params: { team: "acme", project: "my-app" }
```

(The top-level `secrets` mapping shape — keyed by secret name — is the existing yml schema; this spec only extends the per-entry `destinations` list grammar.)

**Parser rule:** string ⇒ `{ shorthand }` (no `url_params` key). Object ⇒ `{shorthand: required, url_params: optional}`. Object without `url_params` is identical to the string form for the same shorthand. Object with extra unknown keys → `bootstrap_plan_invalid` (the error code `yml.ts`'s `fail()` already throws for every other yml-structural error) — fail loud, don't silently drop unrecognized fields.

**Parser-side type change.** Today `BootstrapPlanSecret.destinations` is `string[]` (yml.ts:16). After this spec it becomes `{ shorthand: string; url_params?: Record<string, string> }[]` — yml strings are normalized to objects at parse time so downstream consumers (`computeBootstrapPlan` + everything below) see a uniform shape and never branch on input form. `url_params` is OMITTED (not normalized to `{}`) when absent so the persisted batch state stays minimal and "user supplied params" remains distinguishable from "user supplied none". Field name `shorthand` mirrors the existing `ResolvedDestination.shorthand` so renames stay consistent across the bootstrap pipeline.

**`url_params` value shape:** `Record<string, string>`. Keys and values are arbitrary strings the user controls. Validation is "is it a string?"; the recipe's URL placeholders dictate which keys actually matter at substitution time. Extra keys in `url_params` that the recipe doesn't reference are silently ignored (forward-compat at the substitution layer: a recipe gaining a new placeholder doesn't break users who pre-supplied an unused key). Note the asymmetry: extras INSIDE `url_params` are silent (substitution-time forward-compat), extras at the DESTINATION-OBJECT level are loud (`bootstrap_plan_invalid` — destination grammar is closed-vocabulary).

**Parser-side schema validation for `url_params`.** The yml parser MUST reject malformed `url_params` at parse time with `bootstrap_plan_invalid` — schema validation belongs in the parser, not deferred to the runtime helper. Reject: `url_params` that is not a plain mapping (e.g., a string, a number, a list); any member value whose `typeof` is not `"string"` (numbers, booleans, nulls, nested mappings, lists). The `interpolateUrl` helper's defensive hasOwn + typeof checks (§5) are a belt-and-suspenders runtime guard against unexpected shapes (e.g., programmatically constructed plans, future callers), NOT a substitute for upfront schema rejection. See §9 for the yml parser rejection tests.

## §4 Pipeline (data flow)

```
yml destination entry (string | object)
   │
   ▼ parseDestinations (yml.ts)
BootstrapPlanSecret.destinations[i] = { shorthand: string; url_params?: Record<string, string> }
   │
   ▼ resolveDestinationShorthand(entry.shorthand)  (destination-shorthand.ts — unchanged)
local ResolvedDestination { template_id, template_params, domain }
   │
   ▼ computeBootstrapPlan (plan.ts) — combines local-resolved + the entry's url_params
   │    if (recipe exists AND CLI absent)
   │       → { kind: "browser_inject", recipe_host, url_params?, shorthand, domain }
   │    else
   │       → { kind: "template", template_id, template_params, shorthand, domain }
store.ts ResolvedDestination (the union)
   │
   ▼ runDestinationSteps → runBrowserInject(recipe, dest, ref, deps) (recipe-inject.ts)
   │      (executor signature gains `dest` so it can read `dest.url_params`)
   │
   ▼ interpolateUrl(recipe.url, dest.url_params ?? {})  (NEW — recipes/url-template.ts)
   │    on missing placeholder → return { ok: false, error_code: "recipe_url_params_missing", message }
   │    (caller short-circuits BEFORE any side-effect; see "Failure-reporting boundary" below)
interpolatedUrl
   │
   ▼ open(cdp, interpolatedUrl)  (existing)
```

**Executor-boundary change.** `runBrowserInject`'s signature gains the `dest` (ResolvedDestination — `browser_inject` variant) parameter so it can read `dest.url_params`. The current signature `runBrowserInject(recipe, ref, deps)` becomes `runBrowserInject(recipe, dest, ref, deps)`. Call site in `runDestinationSteps` passes the already-resolved `dest` it's iterating; no new lookup needed.

**Failure-reporting boundary.** `interpolateUrl` itself throws `ShuttleError("recipe_url_params_missing", …)` (it's a pure helper — throwing is the simplest contract). `runBrowserInject` calls `interpolateUrl` BEFORE any side-effect (`blind.start`, `disableObservationDomains`, `severAgentConnections`, `open`) and converts that throw into a per-destination `{ ok: false, error_code: "recipe_url_params_missing", message }` result. This preserves the destination-loop pattern: a bad `url_params` on destination N reports as a destination-N failure and does NOT abort destinations N+1…M. The recipe-inject tests assert (a) the structured `{ ok: false, error_code }` return shape, (b) zero side-effect markers (no `blind.start` event, no `open` call, no CDP filtering applied) when the interpolation fails.

**Naming-overlap note.** `destination-shorthand.ts` exports a LOCAL `ResolvedDestination` interface (no `kind`, no `shorthand`) that is structurally different from `store.ts`'s `ResolvedDestination` discriminated union. The Task 8 (Burst 8) code-quality reviewer flagged this as a confusing-but-harmless pre-existing collision. This spec does not rename either — keeping the diff focused — but the plan can note it as a deferred cleanup.

**Key invariant:** interpolation runs BEFORE `open(cdp, ...)` and BEFORE any blind/CDP setup (`blind.start`, `disableObservationDomains`, `severAgentConnections`). A missing-param failure surfaces as a clean config error with these specific NO side-effects: no tab opens, no blind starts, no CDP filtering applied. The observable bootstrap browser (if one was pre-reserved by the outer bootstrap route) is untouched. Fail-closed by construction. The recipe-inject tests must assert this ordering and side-effect absence, not just the `{ ok: false }` return.

## §5 The `interpolateUrl` module (`src/daemon/recipes/url-template.ts`)

Smallest possible helper:

```ts
import { ShuttleError } from "../../shared/errors.js";

/**
 * Substitute `{name}` placeholders in `template` from `params`. Throws
 * `recipe_url_params_missing` if any placeholder has no own-property string
 * value in `params` (missing keys, inherited properties, non-strings, and
 * empty strings all count as "missing" — see below).
 *
 * Placeholder grammar: `\{([a-zA-Z_][a-zA-Z0-9_]*)\}` — alphanumeric +
 * underscore, must start with letter or underscore. Same identifier shape as a
 * JavaScript variable, so authors can pick names without worrying about regex
 * escapes or URL-encoding edge cases.
 *
 * Validation rule: a placeholder counts as supplied only if `params` has its
 * OWN property (`Object.prototype.hasOwnProperty`) and the value's `typeof`
 * is `"string"` AND the string is non-empty. This blocks accidental matches
 * against inherited members like `toString`/`constructor`, non-string values
 * the parser shouldn't have let through but we don't trust, and empty strings
 * (which would produce a malformed URL path segment like `https://vercel.com//my-app/...`).
 *
 * Extra keys in `params` that don't appear in `template` are silently ignored
 * (forward-compat: a recipe author can add a new placeholder later without
 * breaking users who pre-supplied an unused key).
 *
 * Repeated occurrences of the same placeholder all substitute. No nesting,
 * no defaults, no escapes — keep it dumb until a real need emerges.
 */
export function interpolateUrl(template: string, params: Record<string, string>): string {
  const placeholderRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const missing: string[] = [];
  const out = template.replace(placeholderRe, (_, name: string) => {
    const hasOwn = Object.prototype.hasOwnProperty.call(params, name);
    const v = hasOwn ? (params as Record<string, unknown>)[name] : undefined;
    if (!hasOwn || typeof v !== "string" || v === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(v);
  });
  if (missing.length > 0) {
    const uniq = Array.from(new Set(missing));
    throw new ShuttleError(
      "recipe_url_params_missing",
      `Recipe URL needs url_params: ${uniq.join(", ")}. Add \`url_params: { ${uniq.join(": ..., ")}: ... }\` to the destination in your yml.`,
    );
  }
  return out;
}
```

**`encodeURIComponent` rationale.** User-supplied params land in URL path segments. A value like `my project` would silently produce a malformed path; `my/project` would change the URL's structure. `encodeURIComponent` is the standard per-segment escape (encodes `/`, space, `?`, `#`, etc.). Recipe authors must avoid placing placeholders in URL segments where `/` is structurally meaningful (e.g., don't write `{path}` in `https://x.com/{path}/y` and expect slashes inside `path` to act as path separators — they'll be percent-encoded).

**Why not a real URI Template library (RFC 6570)?** YAGNI. We need single-variable substitution with one escape rule. RFC 6570 supports list expansion, query-string operators, prefix modifiers — none of which a recipe URL needs. Inline regex is ~5 lines of business logic.

## §6 Vercel recipe URL update

`src/daemon/recipes/builtin/vercel-inject.ts` `url` field changes:

```diff
- url: "https://vercel.com/TEAM_PLACEHOLDER/PROJECT_PLACEHOLDER/settings/environment-variables",
+ url: "https://vercel.com/{team}/{project}/settings/environment-variables",
```

Recipe shape unchanged. The doc-comment that explains the placeholder semantics is rewritten to reflect "users now supply `url_params: { team, project }` in their yml" instead of "this URL is intentionally broken until a dogfood URL lands."

`verified_against_real_page: "2026-06-01-needs-dogfood"` stays as-is — interpolation makes the URL addressable, but the selector contents are still pending real-page verification.

## §7 §200 cleanup (removed code)

The `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` env var was Burst 8's Task 14 safety gate: it required the operator to explicitly opt in a `host:shorthand` scope before `browser_inject` would route, preventing the static-URL recipe from silently pushing a user's secret into the dogfood project URL. With interpolation, the URL ADDRESSES the user's actual project (or fails closed with `recipe_url_params_missing`). The hazard is structurally closed; the gate becomes friction.

**Files modified:**
- `src/daemon/api/routes/bootstrap.ts` — remove the `coveredScopes` Set, the env-var read, the `coversDestination` predicate, and the `destinationCovered` export.
- `src/daemon/api/routes/bootstrap.test.ts` — remove the 3 `destinationCovered` unit tests.
- `src/daemon/bootstrap/plan.ts` — remove `PlanSelection.coversDestination` (the field), remove the default `() => false`, collapse the 3-condition gate to 2 conditions.
- `src/daemon/bootstrap/plan.test.ts` — remove the §200 "host-only-insufficient" test; remove the `coversDestination: () => true/false` parameter from the remaining selection tests.

**`PlanSelection` after the cleanup:**
```ts
export interface PlanSelection {
  recipes?: RecipeRegistry;
  /** True iff the vendor CLI for this template_id is usable. Default () => true
   *  preserves today's CLI-always behavior (never auto-picks browser_inject). */
  isCliConfigured?: (templateId: string) => boolean;
}
```

**`computeBootstrapPlan` gate after the cleanup:**
```ts
if (injectRecipe !== undefined && !isCliConfigured(r.template_id)) {
  return { kind: "browser_inject", recipe_host: injectRecipe.host, ...(url_params !== undefined ? { url_params } : {}), shorthand, domain: r.domain };
}
```

(`url_params` flows in from the parsed yml-destination object alongside the existing `shorthand`.)

## §8 Error code addition

Add to `src/shared/error-codes.ts`:

```ts
recipe_url_params_missing: { exitCode: EXIT_CODE_USAGE, hint: () => "Add the missing url_params to the destination in your yml." },
```

**Category:** USAGE (the user can fix it by editing their yml; not transient; not retryable without action). Matches the existing `bootstrap_plan_invalid` / `bootstrap_capture_url_invalid` pattern.

## §9 Tests

**New:**
- `src/daemon/recipes/url-template.test.ts` — happy path (one + multiple placeholders + repeated placeholder), missing-key error (one + multiple missing, asserts both names appear in the message), inherited-property name is treated as missing (e.g., placeholder `{toString}` does not match `Object.prototype.toString`), non-string value treated as missing, empty-string value treated as missing (asserts the malformed-URL hazard is blocked), `encodeURIComponent` is applied (input with `/` and space round-trips correctly), no-placeholder template returns input unchanged.
- `src/daemon/bootstrap/recipe-inject.test.ts` — add: (a) success case with `url_params` substitution (assert the `open` call sees the interpolated URL), (b) missing-param fail-closed case (assert `runBrowserInject` returns `{ ok: false, error_code: "recipe_url_params_missing", message }` BEFORE any `blind.start` / `disableObservationDomains` / `severAgentConnections` / `open` side-effect — inspect the recorded events array for the absence of those markers).
- `src/daemon/bootstrap/plan.test.ts` — destination object with `url_params` ⇒ ends up on the `browser_inject` variant with the same params; destination string ⇒ `url_params` field absent (NOT `{}`; see §3's OMITTED rule).
- `src/cli/bootstrap/yml.test.ts` — object form parses correctly with `url_params`; string form back-compat; object with unknown extra keys → `bootstrap_plan_invalid` (matches §3 — `yml.ts`'s `fail()` throws `bootstrap_plan_invalid` for every other yml-structural error); object missing `shorthand` field → `bootstrap_plan_invalid`; object `shorthand` as a non-string (number, boolean, null, list, mapping) → `bootstrap_plan_invalid`; object `shorthand` as an empty string → `bootstrap_plan_invalid` (matches string-form validation rigor); `url_params` as a non-mapping (string, number, list) → `bootstrap_plan_invalid`; `url_params` member with a non-string value (number, boolean, null, nested mapping, list) → `bootstrap_plan_invalid`. These parser rejection tests enforce the §3 schema and ensure the `interpolateUrl` defensive checks are not the only line of defense.

**Dropped:**
- `src/daemon/api/routes/bootstrap.test.ts` — the 3 `destinationCovered` tests.
- `src/daemon/bootstrap/plan.test.ts` — the host-only-insufficient §200 test.

**Existing tests stay green for the common case:** the back-compat string-form yml continues to parse, and for users with the CLI configured (the dominant path today) plans are unchanged.

**Documented behavior change (string-form + no CLI).** With the §7 gate reduced to `injectRecipe !== undefined && !isCliConfigured(...)`, an existing string-form destination for a host with an inject recipe (today: only `vercel`) now selects `browser_inject` whenever the CLI is absent. Before this spec, the §200 `coversDestination` allowlist kept those cases on the template path (which itself would fail later with a CLI-missing error). After this spec, the same destination selects `browser_inject` and fails-closed at `runBrowserInject` with `recipe_url_params_missing` because the string form supplies no `url_params`.

This is an intended consequence of removing §200 — the failure mode shifts from "CLI not configured" to "URL params not supplied" — but it IS a user-visible change. Recovery (either path resolves it):
1. Install + configure the vendor CLI (e.g., `vercel login`) so the template path activates again. OR
2. Convert the destination to object form and supply `url_params: { team, project }` so the inject recipe routes correctly.

The CHANGELOG entry (§10) must call this out as a behavior change with the two recovery paths spelled out. Any existing tests that asserted "string-form vercel destination on a no-CLI host stays on template" must be updated to assert the new selection + error code instead.

## §10 Docs

**`README.md` provider matrix (line ~146-147 — the Vercel row):**
- Status: `CLI shipped; browser recipe URL-configurable — set url_params: {team, project} in yml (selectors still best-effort, pending dogfood)`. The URL is now addressable for any team/project, but the inject selectors have not yet been verified against a real Vercel page (§6 keeps `verified_against_real_page: "2026-06-01-needs-dogfood"`), so phrase the status as "available / configurable" rather than "ready to use" until that verification lands.
- Notes column drops the `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` sentence. The dogfood-pending caveat stays (selectors are still best-effort).

**`README.md`:** anywhere `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` is mentioned — gone.

**`CHANGELOG.md`:** new entry under `## Unreleased` summarizing the change + the §200 removal as a clearly-marked cleanup (interpolation made the gate redundant).

**Spec/plan docs:** this file lives in `docs/superpowers/specs/`; the plan that follows lives in `docs/superpowers/plans/`.

## Safety analysis

**The hazard §200 was protecting against.** Burst 8 shipped with a static `vercel-inject` URL pointing at a hardcoded dogfood team+project. Without §200's allowlist, ANY user's `vercel:<env>` destination would have routed to that static URL — silently pushing their secret into the dogfood project.

**Why interpolation closes it.** The URL is no longer static; it composes from `url_params` the user controls (via their own yml). For a user who hasn't supplied `url_params`, the recipe doesn't silently route to the wrong project — it fails-closed with `recipe_url_params_missing` BEFORE any blind/open/secret-touching side-effect. The dogfood project URL no longer exists in the codebase (it's substituted from user-supplied values).

**Residual risks (unchanged from Burst 8).**
- User typos `team: "acme-typo"`: secret ships to the wrong real Vercel team if that team happens to exist and the user is authed there. Same risk as a CLI template with the wrong `--scope`. The browser's blind window + the inject success-text gate are the existing defenses; the new interpolation doesn't weaken them.
- User commits `url_params` to a shared yml in a multi-tenant setup: anyone running `provision --continue` with that yml ships to the same destination. Same as committing `team_id` in a shared `vercel.json`. Outside the daemon's threat model.
- Recipe author writes a URL with a placeholder in a security-sensitive position (e.g., `https://{api_host}/secrets`): a malicious recipe author could redirect the inject anywhere. This is a recipe-supply-chain concern, not an interpolation concern — recipes are daemon-shipped builtins today, and adding user-supplied recipes is a separate future spec with its own threat model.

**No change to.** The `coversDestination` gate REMOVAL does not weaken any existing safety property — it was added to compensate for the static-URL problem we're now solving structurally. The §5 / §170 / §173 lifecycle contracts (page-state vs secret-bearing tab cleanup; cleanup-rejection-as-unverified; hide-before-close) all stay exactly as Burst 8 shipped them.

## Verification bar

A `provision --continue` against a yml with a `browser_inject` destination AND `url_params: { team: "<real-team>", project: "<real-project>" }`:
- Opens `https://vercel.com/<real-team>/<real-project>/settings/environment-variables` in the bootstrap browser (verified by reading `open(cdp, ...)`'s URL arg in a test, AND by an actual dogfood run once selectors are verified).
- Without `url_params` (or with an empty-string value like `team: ""`): `runBrowserInject` returns `{ ok: false, error_code: "recipe_url_params_missing", message }` BEFORE `blind.start` / `open` / `severAgentConnections`. Verified by a test that asserts the structured result and inspects the events array for the absence of any side-effect markers; the destination loop reports the failure for THIS destination and continues with N+1.
- `npm test`: 1712+ pass / 0 fail / 18 skipped (baseline preserved + new tests).
- `git grep SECRET_SHUTTLE_INJECT_RECIPE_SCOPES`: empty (cleanup complete).
- README Vercel-row status updated.

## Future work (deferred — explicitly NOT this spec)

- **Per-provider autodetect framework + Vercel API integration.** When the 2nd inject recipe lands AND its users start complaining about "type these params every time", design a `recipes/autodetect/` subsystem with per-host detectors. Vercel detector reads `.vercel/project.json` + resolves IDs to slugs via `api.vercel.com` using `~/.vercel/auth.json`. Adds outbound daemon-side HTTPS; needs its own threat-model pass.
- **Capture-recipe URL interpolation.** Today's capture recipes target a single keys URL per host (e.g., `dashboard.stripe.com/apikeys`). If a future capture recipe needs per-account or per-account-mode URLs (e.g., `dashboard.stripe.com/{account_id}/apikeys`), fold it in then with the same `interpolateUrl` helper.
- **Default-value support in placeholders.** If we hit a case where `{foo:default}` syntax buys real ergonomics (probably never for URLs), revisit. Today's "either supplied or fail-closed" is fine.
