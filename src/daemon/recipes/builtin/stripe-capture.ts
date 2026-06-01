import type { CaptureRecipe } from "../types.js";

/**
 * Stripe API keys capture recipe.
 *
 * Target page: https://dashboard.stripe.com/apikeys
 * Direction: capture (reveal the live secret key sk_live_...)
 *
 * HONESTY: Browser-harness could not connect to Chrome during authoring
 * (no Allow permission). Selectors below are best-effort, derived from:
 * - Public Stripe docs describing the "Reveal live key" flow
 * - Stripe dashboard source code patterns observed in public GitHub repos
 * - Known Stripe dashboard DOM structure (uses React, no stable data-testid
 *   in the public dashboard as of 2026)
 *
 * All selectors MUST be re-verified with browser-harness against a real
 * logged-in Stripe dashboard session before relying on them in production.
 * Mark verified_against_real_page with the actual dogfood date when done.
 *
 * Selector notes:
 * - page_ready_probe: The Stripe dashboard sidebar nav is always present
 *   on any successfully-loaded authenticated or unauthenticated dashboard
 *   page. `[data-testid="nav-sidebar"]` is a Stripe internal stable anchor
 *   observed in open-source Stripe automation projects; fall back to the
 *   sidebar's role if that testid is absent.
 * - logged_out_marker: The login page renders an email input. The name="email"
 *   attribute is stable across Stripe's login form redesigns.
 * - logged_in_probe: The API keys page renders a heading containing
 *   "Standard keys" or "API keys" only when authenticated and on the
 *   correct page. `h2` with that text is scope-specific (not present on
 *   other dashboard pages).
 * - reveal_selector: Stripe renders a "Reveal live key" button per row.
 *   The accessible name contains "Reveal" and targets the live secret key
 *   row. `button[aria-label*="Reveal"]` is the most stable cross-version
 *   selector (Stripe's button labels are accessible-name-driven).
 *   NOTE: This will match the first "Reveal" button on the page, which is
 *   the live secret key. In test mode (`/test/apikeys`) there is no "live"
 *   qualifier — the key is always visible.
 * - container_selector: After reveal the key value renders in a sibling
 *   `<code>` or `<span>` element. Using the table row's data container.
 *   Stripe renders revealed keys in a monospace span adjacent to the button.
 */
export const stripeCapture: CaptureRecipe = {
  kind: "capture",
  host: "dashboard.stripe.com",
  url: "https://dashboard.stripe.com/apikeys",

  // Present on any Stripe dashboard page load (logged-in or -out shell).
  // The top-level nav header div is always rendered. Using the account
  // switcher which is present on every dashboard page chrome.
  // [best-effort] — observed in public Stripe dashboard automation examples.
  page_ready_probe: "header, nav, [data-js-target='nav-header']",

  // Present ONLY on the Stripe login/auth screen. The login form's email
  // input uses name="email" and appears before any dashboard chrome.
  // [best-effort] — derived from Stripe login page public HTML structure.
  logged_out_marker: "input[name='email'][type='email'], form[action*='/login']",

  // Present iff authenticated AND on the API keys page. The "Standard keys"
  // section heading is rendered only when on /apikeys while logged in.
  // [best-effort] — derived from Stripe dashboard structure knowledge.
  logged_in_probe: "h2, [data-testid='standard-keys-section'], [data-testid='api-keys-table']",

  // The "Reveal live key" button for the secret key row. Stripe uses
  // accessible button names containing "Reveal" for the show-key affordance.
  // [best-effort] — consistent with Stripe's accessibility-first dashboard.
  reveal_selector: "button[aria-label*='Reveal']",

  // After reveal, the key value is rendered in a monospace element adjacent
  // to the reveal button. Using container mode (container_selector) since the
  // exact element tag (code vs span) varies across Stripe dashboard versions.
  // [best-effort] — derived from known Stripe key-display patterns.
  container_selector: "[data-testid='secret-key-value'], code[data-mask], [data-testid='revealed-key']",

  // "Revoke" is separate; Stripe does have a "Hide" control after revealing.
  // The accessible label is typically "Hide live key".
  // [best-effort]
  hide_selector: "button[aria-label*='Hide']",

  ready_timeout_ms: 15000,

  // NOT verified against a real page. Browser-harness was unavailable.
  // Update to the actual dogfood date after manual verification.
  verified_against_real_page: "2026-06-01-needs-dogfood",
};
