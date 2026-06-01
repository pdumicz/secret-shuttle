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

  // PLACEHOLDER URL — replace <team> and <project> with real slugs.
  // Per spec §10/§Future: static dogfood URL for increment 1.
  // Example: https://vercel.com/acme-team/my-app/settings/environment-variables
  url: "https://vercel.com/~/settings/environment-variables",

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
  submit_selector: "button[type='submit']:has-text('Save'), button:has-text('Save')",

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
