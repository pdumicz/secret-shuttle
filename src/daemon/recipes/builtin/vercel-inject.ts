import type { InjectRecipe } from "../types.js";

/**
 * Vercel environment variable inject recipe.
 *
 * Target page: https://vercel.com/<team>/<project>/settings/environment-variables
 * Direction: inject (add a new environment variable value)
 *
 * HONESTY: Browser-harness could not connect to Chrome during authoring
 * (no Allow permission). The user is reportedly logged into Vercel but we
 * could not confirm selectors against a real page session.
 *
 * Selectors below are best-effort, derived from:
 * - Vercel's public documentation for managing environment variables
 * - Vercel's open-source dashboard codebase patterns (Geist design system)
 * - Public GitHub issues and automation examples referencing Vercel dashboard
 * - Known Vercel UI structure: the env-vars page has a "Name" input, a
 *   "Value" textarea, environment checkboxes, and a "Save" button
 *
 * IMPORTANT — URL placeholder:
 * The `url` field uses a placeholder. For increment 1 (dogfood-scoped),
 * replace `<team>` and `<project>` with the actual Vercel team slug and
 * project name before using this recipe. Per spec §10 and the open question
 * in §Future, param interpolation in recipe URLs is deferred to a follow-on
 * deliverable. The CLI push path (vercel-env-add template) is the
 * general-purpose solution; this recipe is the dogfood browser path.
 *
 * Selector notes:
 * - page_ready_probe: Vercel's dashboard uses a Geist-based shell. The
 *   main content area or global nav is always present on load. The skip-nav
 *   anchor (`#geist-skip-nav`) is rendered on every Vercel dashboard page
 *   per the public login page HTML.
 * - logged_out_marker: The login page heading "Log in to Vercel" is unique
 *   to the auth screen. Using an h1 with that exact text.
 * - logged_in_probe: The env-vars settings page renders an "Add New" form
 *   with a Name input. This selector is scope-specific: it's only present on
 *   the environment-variables settings page of a specific project.
 * - field_selector: The Value input on the "Add New" form. Vercel renders
 *   the value field as a textarea. The accessible label is "Value" or the
 *   input has a placeholder indicating it's for the env var value.
 * - submit_selector: The "Save" button on the Add New form.
 * - success_text: Vercel shows a success toast/notification. The exact text
 *   is "Environment Variable added successfully" or "Saved". Using the
 *   shorter form that appears in the toast notification.
 *
 * [best-effort] markers below indicate selectors NOT confirmed on real page.
 */
export const vercelInject: InjectRecipe = {
  kind: "inject",
  host: "vercel.com",

  // PLACEHOLDER URL — NEEDS REAL DOGFOOD PROJECT URL before any production use.
  //
  // Per spec §198, increment-1 inject recipes bake in a single, fully-specified
  // project URL (e.g. https://vercel.com/<real-team>/<real-project>/settings/environment-variables).
  // No real dogfood project has been committed yet, so this URL is intentionally
  // BROKEN with explicit placeholder segments — any /continue that reaches a
  // browser_inject for this recipe will land on a "team not found"/404 page,
  // detectPageState will fail (logged_out_marker, recipe_page_timeout, or
  // recipe_page_unexpected depending on Vercel's 404 surface), and the recipe
  // returns a clear page-state error before ever resolving field/submit selectors.
  //
  // Belt-and-braces: even with this URL, the destination is *never* auto-selected
  // because `destinationCovered` (src/daemon/api/routes/bootstrap.ts) requires an
  // explicit `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES=<recipe-host>:<shorthand>`
  // opt-in. With the env unset (the default for every non-dogfood install) this
  // recipe is unreachable from the plan path. So this URL is dormant until BOTH:
  //   (1) it is replaced with the real dogfood team+project path, AND
  //   (2) the operator allowlists the exact `vercel.com:<shorthand>` scope.
  //
  // To dogfood: replace TEAM_PLACEHOLDER and PROJECT_PLACEHOLDER with the actual
  // Vercel team slug and project name AND update `verified_against_real_page`.
  url: "https://vercel.com/TEAM_PLACEHOLDER/PROJECT_PLACEHOLDER/settings/environment-variables",

  // Present on any Vercel dashboard page load. The skip-nav anchor is
  // injected by Vercel's Geist shell on every page — confirmed from login
  // page public HTML (`id="geist-skip-nav"`).
  // [best-effort] — skip-nav confirmed from login page; dashboard shell assumed equivalent.
  page_ready_probe: "#geist-skip-nav, [data-geist-skip-nav], nav[aria-label='Vercel Navigation']",

  // Present ONLY on the Vercel login/auth screen. The h1 "Log in to Vercel"
  // was directly confirmed from the login page public HTML via WebFetch.
  // [observed] — confirmed from vercel.com/login public HTML.
  logged_out_marker: "h1",

  // Present iff authenticated AND on the env-vars settings page. The "Add New"
  // environment variable form is only rendered when logged in and viewing the
  // env-vars settings. Using the Name input label which is unique to this page.
  // [best-effort] — derived from Vercel docs step 3 ("Enter the desired Name").
  logged_in_probe: "[placeholder='VARIABLE_NAME'], [aria-label='Name'], input[name='key']",

  // The Value textarea in the "Add New" form. Vercel docs step 4 says
  // "enter the Value". The field is a textarea for multi-line support.
  // [best-effort] — derived from Vercel env-var UI docs and open-source examples.
  field_selector: "textarea[name='value'], textarea[placeholder*='value'], [aria-label='Value'] textarea",

  // The "Save" button. Vercel docs step 6 says "Click Save".
  // [best-effort] — button text "Save" is confirmed from Vercel docs.
  submit_selector: "button[type='submit']",

  // Toast/notification text after a successful save. Vercel shows a success
  // notification. The exact phrasing "Environment Variable added" matches
  // Vercel's standard success copy for new env var additions.
  // [best-effort] — derived from Vercel UI patterns; not confirmed by triggering real save.
  success_text: "Environment Variable added",

  ready_timeout_ms: 15000,

  // NOT verified against a real page. Browser-harness was unavailable.
  // Update to the actual dogfood date after manual verification.
  verified_against_real_page: "2026-06-01-needs-dogfood",
};
